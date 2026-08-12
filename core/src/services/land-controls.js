const { getAllLands } = require('./farm');
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum, log } = require('../utils/utils');

const NORMAL_FERTILIZER_ID = 1011;
const ORGANIC_FERTILIZER_ID = 1012;

let landControlRunning = false;

function hasPlant(land) {
    const plant = land && land.plant;
    return !!(plant && Array.isArray(plant.phases) && plant.phases.length > 0);
}

function normalizeLandMap(lands) {
    const map = new Map();
    for (const land of Array.isArray(lands) ? lands : []) {
        const id = toNum(land && land.id);
        if (id > 0) map.set(id, land);
    }
    return map;
}

function resolvePlantTargetLand(land, landMap) {
    const requestedId = toNum(land && land.id);
    const masterId = toNum(land && land.master_land_id);
    if (masterId > 0 && masterId !== requestedId && landMap.has(masterId)) {
        return landMap.get(masterId);
    }
    return land;
}

function parseCommand(input) {
    const value = String(input || '').trim().toLowerCase();
    if (value === 'remove-all') return { action: 'remove-all', landId: 0 };

    const match = /^land:(remove|fertilize-normal|fertilize-organic|upgrade):(\d+)$/.exec(value);
    if (!match) return null;

    const landId = Number.parseInt(match[2], 10);
    if (!Number.isSafeInteger(landId) || landId <= 0) return null;
    return { action: match[1], landId };
}

async function removePlants(landIds) {
    const ids = [...new Set((Array.isArray(landIds) ? landIds : []).map(toNum).filter(id => id > 0))];
    if (ids.length === 0) return null;
    const body = types.RemovePlantRequest.encode(types.RemovePlantRequest.create({
        land_ids: ids.map(id => toLong(id)),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'RemovePlant', body);
    return types.RemovePlantReply.decode(replyBody);
}

async function fertilizeOnce(landId, fertilizerId) {
    const body = types.FertilizeRequest.encode(types.FertilizeRequest.create({
        land_ids: [toLong(landId)],
        fertilizer_id: toLong(fertilizerId),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Fertilize', body);
    return types.FertilizeReply.decode(replyBody);
}

async function upgradeOneLand(landId) {
    const body = types.UpgradeLandRequest.encode(types.UpgradeLandRequest.create({
        land_id: toLong(landId),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'UpgradeLand', body);
    return types.UpgradeLandReply.decode(replyBody);
}

async function executeLandControl(command) {
    const landsReply = await getAllLands();
    const lands = Array.isArray(landsReply && landsReply.lands) ? landsReply.lands : [];
    const landMap = normalizeLandMap(lands);

    if (command.action === 'remove-all') {
        const targetIds = [];
        for (const land of lands) {
            if (!land || !land.unlocked || !hasPlant(land)) continue;
            const target = resolvePlantTargetLand(land, landMap);
            const targetId = toNum(target && target.id);
            if (targetId > 0 && hasPlant(target) && !targetIds.includes(targetId)) targetIds.push(targetId);
        }

        if (targetIds.length === 0) {
            return { action: 'remove-all', affectedCount: 0, targetLandIds: [], message: '当前没有可铲除的作物' };
        }

        await removePlants(targetIds);
        log('农场', `手动一键铲除完成：${targetIds.length} 块`, {
            module: 'farm', event: '手动土地操作', action: 'remove-all', result: 'ok', count: targetIds.length,
        });
        return {
            action: 'remove-all',
            affectedCount: targetIds.length,
            targetLandIds: targetIds,
            message: `已铲除 ${targetIds.length} 块土地上的作物`,
        };
    }

    const requestedLand = landMap.get(command.landId);
    if (!requestedLand) throw new Error(`土地 #${command.landId} 不存在`);
    if (!requestedLand.unlocked) throw new Error(`土地 #${command.landId} 尚未解锁`);

    if (command.action === 'upgrade') {
        if (!requestedLand.could_upgrade) {
            throw new Error(`土地 #${command.landId} 当前不满足升级条件`);
        }
        const beforeLevel = toNum(requestedLand.level);
        const reply = await upgradeOneLand(command.landId);
        const afterLevel = toNum(reply && reply.land && reply.land.level) || beforeLevel + 1;
        log('农场', `手动升级土地 #${command.landId}：Lv${beforeLevel} → Lv${afterLevel}`, {
            module: 'farm', event: '手动土地操作', action: 'upgrade', result: 'ok', landId: command.landId,
        });
        return {
            action: 'upgrade',
            requestedLandId: command.landId,
            targetLandId: command.landId,
            beforeLevel,
            afterLevel,
            message: `土地 #${command.landId} 已升级：Lv${beforeLevel} → Lv${afterLevel}`,
        };
    }

    const targetLand = resolvePlantTargetLand(requestedLand, landMap);
    const targetLandId = toNum(targetLand && targetLand.id);
    if (!targetLandId || !hasPlant(targetLand)) {
        throw new Error(`土地 #${command.landId} 当前没有可操作的作物`);
    }

    if (command.action === 'remove') {
        await removePlants([targetLandId]);
        log('农场', `手动铲除土地 #${targetLandId}`, {
            module: 'farm', event: '手动土地操作', action: 'remove', result: 'ok', landId: targetLandId,
        });
        return {
            action: 'remove',
            requestedLandId: command.landId,
            targetLandId,
            affectedCount: 1,
            message: `已铲除土地 #${targetLandId} 的作物`,
        };
    }

    const plant = targetLand.plant || {};
    if (command.action === 'fertilize-organic'
        && Object.prototype.hasOwnProperty.call(plant, 'left_inorc_fert_times')
        && toNum(plant.left_inorc_fert_times) <= 0) {
        throw new Error(`土地 #${targetLandId} 当前不能再使用有机肥`);
    }

    const fertilizerId = command.action === 'fertilize-organic' ? ORGANIC_FERTILIZER_ID : NORMAL_FERTILIZER_ID;
    const fertilizerLabel = command.action === 'fertilize-organic' ? '有机肥' : '普通肥';
    const reply = await fertilizeOnce(targetLandId, fertilizerId);
    log('农场', `手动对土地 #${targetLandId} 使用一次${fertilizerLabel}`, {
        module: 'farm', event: '手动土地操作', action: command.action, result: 'ok', landId: targetLandId,
    });
    return {
        action: command.action,
        requestedLandId: command.landId,
        targetLandId,
        fertilizerId,
        fertilizerRemaining: toNum(reply && reply.fertilizer),
        message: `已对土地 #${targetLandId} 使用一次${fertilizerLabel}`,
    };
}

async function runLandControl(input) {
    const command = parseCommand(input);
    if (!command) throw new Error('不支持的土地操作');
    if (landControlRunning) throw new Error('已有土地手动操作正在执行，请稍后再试');

    landControlRunning = true;
    try {
        return await executeLandControl(command);
    }
    finally {
        landControlRunning = false;
    }
}

module.exports = {
    runLandControl,
    parseCommand,
    NORMAL_FERTILIZER_ID,
    ORGANIC_FERTILIZER_ID,
};
