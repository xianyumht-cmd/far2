const process = require('node:process');
const { parentPort } = require('node:worker_threads');
const { getFruitName, getPlantByFruitId, getPlantById, getPlantName } = require('../config/gameConfig');
const {
    getKnownFriendGids,
    getKnownFriendGidSyncCooldownSec,
    applyConfigSnapshot,
} = require('../models/store');
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { log, logWarn, toNum, toTimeSec } = require('../utils/utils');

const RPC_CANDIDATES = [
    ['gamepb.interactpb.InteractService', 'InteractRecords'],
    ['gamepb.interactpb.InteractService', 'GetInteractRecords'],
    ['gamepb.interactpb.VisitorService', 'InteractRecords'],
    ['gamepb.interactpb.VisitorService', 'GetInteractRecords'],
];

const ACTION_LABELS = {
    1: '偷取作物',
    2: '帮忙',
    3: '捣乱',
};

const DEFAULT_FRIEND_DISCOVERY_INTERVAL_MS = 5 * 60 * 1000;
const MIN_FRIEND_DISCOVERY_INTERVAL_MS = 30 * 1000;
let lastFriendDiscoveryAt = 0;
let friendDiscoveryPromise = null;
let friendDiscoveryLogged = false;

function getActionLabel(actionType) {
    return ACTION_LABELS[actionType] || '互动';
}

function buildActionDetail(record) {
    const count = Number(record.cropCount) || 0;
    const times = Number(record.times) || 0;
    const landId = Number(record.landId) || 0;
    const parts = [];

    if (record.actionType === 1) {
        if (record.cropName && count > 0) parts.push(`偷取 ${record.cropName} × ${count}`);
        else if (record.cropName) parts.push(`偷取 ${record.cropName}`);
        else if (count > 0) parts.push(`偷取作物 × ${count}`);
        else parts.push('偷取作物');
    } else if (record.actionType === 2) {
        parts.push(times > 1 ? `帮忙 ${times} 次` : '帮忙');
    } else if (record.actionType === 3) {
        parts.push(times > 1 ? `捣乱 ${times} 次` : '捣乱');
    } else {
        parts.push(times > 1 ? `互动 ${times} 次` : '互动');
    }

    if (landId > 0) parts.push(`地块 ${landId}`);
    return parts.join(' · ');
}

function postToMaster(payload) {
    try {
        if (process.send) {
            process.send(payload);
            return true;
        }
        if (parentPort && typeof parentPort.postMessage === 'function') {
            parentPort.postMessage(payload);
            return true;
        }
    } catch {
        // ignore IPC failure; caller will persist locally as fallback
    }
    return false;
}

function normalizeGids(values) {
    const result = [];
    const seen = new Set();
    for (const value of (Array.isArray(values) ? values : [])) {
        const gid = toNum(value);
        if (gid <= 0 || seen.has(gid)) continue;
        seen.add(gid);
        result.push(gid);
    }
    return result;
}

function extractFriendList(reply) {
    if (Array.isArray(reply && reply.game_friends)) return reply.game_friends;
    if (Array.isArray(reply && reply.gameFriends)) return reply.gameFriends;
    return [];
}

function getFriendDiscoveryIntervalMs() {
    const sec = Number(getKnownFriendGidSyncCooldownSec ? getKnownFriendGidSyncCooldownSec() : 0);
    if (!Number.isFinite(sec) || sec <= 0) return DEFAULT_FRIEND_DISCOVERY_INTERVAL_MS;
    return Math.max(MIN_FRIEND_DISCOVERY_INTERVAL_MS, sec * 1000);
}

async function fetchFullFriendDiscoveryGids() {
    const gids = [];
    const errors = [];
    const sourceCounts = { syncAll: 0, getAll: 0 };
    let succeeded = 0;

    try {
        const syncReq = types.SyncAllRequest || types.SyncAllFriendsRequest;
        const syncRep = types.SyncAllReply || types.SyncAllFriendsReply;
        if (!syncReq || !syncRep) throw new Error('SyncAll 接口类型未加载');
        const body = syncReq.encode(syncReq.create({ open_ids: [] })).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'SyncAll', body, 4000);
        const friends = extractFriendList(syncRep.decode(replyBody));
        sourceCounts.syncAll = friends.length;
        gids.push(...friends.map(friend => friend && friend.gid));
        succeeded++;
    } catch (error) {
        errors.push(`SyncAll: ${error && error.message ? error.message : String(error || 'unknown')}`);
    }

    try {
        if (!types.GetAllFriendsRequest || !types.GetAllFriendsReply) {
            throw new Error('GetAll 接口类型未加载');
        }
        const body = types.GetAllFriendsRequest.encode(types.GetAllFriendsRequest.create({})).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'GetAll', body, 4000);
        const friends = extractFriendList(types.GetAllFriendsReply.decode(replyBody));
        sourceCounts.getAll = friends.length;
        gids.push(...friends.map(friend => friend && friend.gid));
        succeeded++;
    } catch (error) {
        errors.push(`GetAll: ${error && error.message ? error.message : String(error || 'unknown')}`);
    }

    return {
        gids: normalizeGids(gids),
        sourceCounts,
        succeeded,
        errors,
    };
}

async function syncFullFriendGids(force = false) {
    const now = Date.now();
    const intervalMs = getFriendDiscoveryIntervalMs();
    if (!force && lastFriendDiscoveryAt > 0 && now - lastFriendDiscoveryAt < intervalMs) {
        return normalizeGids(getKnownFriendGids());
    }
    if (friendDiscoveryPromise) return friendDiscoveryPromise;

    friendDiscoveryPromise = (async () => {
        lastFriendDiscoveryAt = Date.now();
        const accountId = String(process.env.FARM_ACCOUNT_ID || '').trim();
        const current = normalizeGids(getKnownFriendGids(accountId));
        const discovered = await fetchFullFriendDiscoveryGids();

        if (discovered.succeeded <= 0) {
            logWarn('好友', `QQ 好友 GID 自动发现失败: ${discovered.errors.join(' | ')}`, {
                module: 'friend',
                event: '好友GID自动发现',
                result: 'error',
            });
            return current;
        }

        const merged = normalizeGids([...current, ...discovered.gids]);
        const addedCount = merged.filter(gid => !current.includes(gid)).length;
        if (addedCount > 0) {
            applyConfigSnapshot({ knownFriendGids: merged }, { persist: false, accountId });
            const sent = postToMaster({
                type: 'known_friend_gids_sync',
                gids: merged,
            });
            if (!sent) {
                applyConfigSnapshot({ knownFriendGids: merged }, { persist: true, accountId });
            }
        }

        if (addedCount > 0 || !friendDiscoveryLogged) {
            friendDiscoveryLogged = true;
            log('好友', `QQ 好友 GID 自动发现：新增 ${addedCount} 个，当前 ${merged.length} 个 (SyncAll=${discovered.sourceCounts.syncAll}, GetAll=${discovered.sourceCounts.getAll})`, {
                module: 'friend',
                event: '好友GID自动发现',
                result: 'ok',
                addedCount,
                totalKnownGids: merged.length,
                syncAllCount: discovered.sourceCounts.syncAll,
                getAllCount: discovered.sourceCounts.getAll,
            });
        }
        return merged;
    })().finally(() => {
        friendDiscoveryPromise = null;
    });

    return friendDiscoveryPromise;
}

async function fetchInteractReply() {
    if (!types.InteractRecordsRequest || !types.InteractRecordsReply) {
        throw new Error('访客记录 proto 未加载');
    }

    const body = types.InteractRecordsRequest.encode(types.InteractRecordsRequest.create({})).finish();
    const errors = [];

    for (const [serviceName, methodName] of RPC_CANDIDATES) {
        try {
            const { body: replyBody } = await sendMsgAsync(serviceName, methodName, body, 2500);
            return types.InteractRecordsReply.decode(replyBody);
        } catch (error) {
            const message = error && error.message ? error.message : String(error || 'unknown');
            errors.push(`${serviceName}.${methodName}: ${message}`);
        }
    }

    logWarn('好友', `访客记录接口调用失败: ${errors.join(' | ')}`, {
        module: 'friend',
        event: 'interact_records',
        result: 'error',
    });
    throw new Error('访客记录接口调用失败，请确认服务名和方法名是否与当前版本一致');
}

function resolveCropName(cropId) {
    const id = Number(cropId) || 0;
    if (id <= 0) return '';
    if (getPlantById(id)) return getPlantName(id);
    if (getPlantByFruitId(id)) return getFruitName(id);
    return '';
}

function normalizeInteractRecord(record, index) {
    const actionType = toNum(record && record.action_type);
    const visitorGid = toNum(record && record.visitor_gid);
    const cropId = toNum(record && record.crop_id);
    const cropCount = toNum(record && record.crop_count);
    const times = toNum(record && record.times);
    const level = toNum(record && record.level);
    const fromType = toNum(record && record.from_type);
    const serverTimeSec = toTimeSec(record && record.server_time);
    const extra = (record && record.extra) || {};
    const landId = toNum(extra.land_id);
    const flag1 = toNum(extra.flag1);
    const flag2 = toNum(extra.flag2);
    const cropName = resolveCropName(cropId);
    const nick = String((record && record.nick) || '').trim() || `GID:${visitorGid}`;
    const avatarUrl = String((record && record.avatar_url) || '').trim();

    const normalized = {
        key: `${serverTimeSec || 0}-${visitorGid || 0}-${actionType || 0}-${index}`,
        serverTimeSec,
        serverTimeMs: serverTimeSec > 0 ? serverTimeSec * 1000 : 0,
        actionType,
        actionLabel: getActionLabel(actionType),
        visitorGid,
        nick,
        avatarUrl,
        cropId,
        cropName,
        cropCount,
        times,
        fromType,
        level,
        landId,
        flag1,
        flag2,
    };

    normalized.actionDetail = buildActionDetail(normalized);
    return normalized;
}

async function getInteractRecords() {
    // 好友巡查本来就会周期调用访客记录。这里顺便低频做一次完整好友 GID 发现，
    // 不改变访客记录返回结构，避免影响 WebUI 的“最近互动”页面。
    await syncFullFriendGids(false).catch(() => null);

    const reply = await fetchInteractReply();
    const records = Array.isArray(reply && reply.records) ? reply.records : [];
    return records
        .map((record, index) => normalizeInteractRecord(record, index))
        .sort((a, b) => (b.serverTimeSec - a.serverTimeSec) || (b.visitorGid - a.visitorGid) || (b.actionType - a.actionType));
}

module.exports = {
    getInteractRecords,
    syncFullFriendGids,
};
