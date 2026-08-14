const process = require('node:process');
const {
    getItemById,
    getPlantBySeedId,
    getItemImageById,
    getSeedImageBySeedId,
} = require('../config/gameConfig');
const { getBag, getBagItems } = require('./warehouse');
const { getShopInfo } = require('./farm-api');
const { listActivityOverview } = require('./activity-readonly');
const { selectReady2x2Groups } = require('./farm-2x2');
const { getBagSeedPriority } = require('../models/store');
const { getDataFile } = require('../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('./json-db');
const { log, logWarn, sleep } = require('../utils/utils');

const SEED_SHOP_ID = 2;
const ACTIVITY_CACHE_TTL_MS = 5 * 60 * 1000;
const DISCOVERY_LOG_INTERVAL_MS = 5 * 60 * 1000;
const SEED_NAMESPACE_MIN = 20000;
const SEED_NAMESPACE_MAX = 29999;

function normalizePositiveInt(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    const result = Math.trunc(num);
    return result > 0 ? result : 0;
}

function isSeedNamespaceId(itemId) {
    const id = normalizePositiveInt(itemId);
    return id >= SEED_NAMESPACE_MIN && id <= SEED_NAMESPACE_MAX;
}

function stripSeedSuffix(name, fallback) {
    const text = String(name || '').trim();
    if (!text) return fallback;
    return text.replace(/种子$/u, '').trim() || fallback;
}

function inspectSeedEvidence(itemId, itemInfo, plant, activityItemIds = new Set()) {
    const id = normalizePositiveInt(itemId);
    const info = itemInfo && typeof itemInfo === 'object' ? itemInfo : null;
    const knownPlant = !!plant;
    const itemTypeSeed = Number(info && info.type) === 5;
    const interactionPlant = String((info && info.interaction_type) || '').trim().toLowerCase() === 'plant';
    const nameLooksSeed = /种子/u.test(String((info && info.name) || ''));
    const assetLooksCrop = /crop[_-]?\d+/i.test(String((info && info.asset_name) || ''))
        || /crop[_/-]?\d+/i.test(String((info && info.icon_res) || ''));
    const namespaceCandidate = isSeedNamespaceId(id);
    const activityReferenced = activityItemIds instanceof Set && activityItemIds.has(id);
    const strongItemEvidence = itemTypeSeed || interactionPlant || nameLooksSeed;
    // Activity nodes can reference fertilizers, currencies, fruits and other rewards.
    // An activity reference may enrich a seed-like candidate, but cannot create
    // seed identity by itself.
    const candidate = knownPlant || strongItemEvidence || namespaceCandidate;

    let confidence = 'none';
    if (knownPlant) confidence = 'proven-config';
    else if (strongItemEvidence) confidence = 'high';
    else if (namespaceCandidate) confidence = 'medium';

    const evidence = [];
    if (knownPlant) evidence.push('plant-config');
    if (itemTypeSeed) evidence.push('item-type-5');
    if (interactionPlant) evidence.push('interaction-plant');
    if (nameLooksSeed) evidence.push('name-seed');
    if (assetLooksCrop) evidence.push('crop-asset');
    if (activityReferenced) evidence.push('activity-reference');
    if (namespaceCandidate) evidence.push('seed-id-namespace');

    return {
        itemId: id,
        candidate,
        knownPlant,
        itemTypeSeed,
        interactionPlant,
        nameLooksSeed,
        assetLooksCrop,
        namespaceCandidate,
        activityReferenced,
        strongItemEvidence,
        confidence,
        evidence,
    };
}

function buildBagSeedInventory(rawItems, options = {}) {
    const readItemById = typeof options.getItemById === 'function' ? options.getItemById : getItemById;
    const readPlantBySeedId = typeof options.getPlantBySeedId === 'function' ? options.getPlantBySeedId : getPlantBySeedId;
    const activityItemIds = options.activityItemIds instanceof Set ? options.activityItemIds : new Set();
    const merged = new Map();

    for (const raw of (Array.isArray(rawItems) ? rawItems : [])) {
        const seedId = normalizePositiveInt(raw && raw.id);
        const count = Math.max(0, normalizePositiveInt(raw && raw.count));
        if (seedId <= 0 || count <= 0) continue;

        const itemInfo = readItemById(seedId) || null;
        const plant = readPlantBySeedId(seedId) || null;
        const evidence = inspectSeedEvidence(seedId, itemInfo, plant, activityItemIds);
        if (!evidence.candidate) continue;

        const fallbackName = `疑似种子#${seedId}`;
        const plantName = plant && plant.name ? String(plant.name) : '';
        const itemName = itemInfo && itemInfo.name ? String(itemInfo.name) : '';
        const name = plantName
            ? stripSeedSuffix(plantName, fallbackName)
            : stripSeedSuffix(itemName, fallbackName);
        const plantSize = plant ? Math.max(1, Number(plant.size) || 1) : 0;
        const requiredLevel = plant
            ? Math.max(0, Number(plant.land_level_need) || 0)
            : Math.max(0, Number(itemInfo && itemInfo.level) || 0);

        const current = merged.get(seedId) || {
            seedId,
            name,
            count: 0,
            requiredLevel,
            plantSize,
            resolved: !!plant,
            safeToPlant: !!plant && (plantSize === 1 || plantSize === 2),
            image: getSeedImageBySeedId(seedId) || getItemImageById(seedId) || '',
            itemType: itemInfo ? (Number(itemInfo.type) || 0) : 0,
            interactionType: String((itemInfo && itemInfo.interaction_type) || ''),
            itemName,
            assetName: String((itemInfo && itemInfo.asset_name) || ''),
            confidence: evidence.confidence,
            evidence: [...evidence.evidence],
            activityReferenced: evidence.activityReferenced,
            namespaceCandidate: evidence.namespaceCandidate,
            configFallback: !!(plant && plant.config_fallback),
        };
        current.count += count;
        merged.set(seedId, current);
    }

    const all = Array.from(merged.values()).sort((a, b) => a.seedId - b.seedId);
    return {
        all,
        knownSeeds: all.filter(item => item.resolved),
        unresolvedCandidates: all.filter(item => !item.resolved),
    };
}

function buildShopSeedIdSet(shopReply) {
    const ids = new Set();
    for (const goods of (Array.isArray(shopReply && shopReply.goods_list) ? shopReply.goods_list : [])) {
        const id = normalizePositiveInt(goods && goods.item_id);
        if (id > 0) ids.add(id);
    }
    return ids;
}

function collectPayloadCandidateIds(value, result = new Set()) {
    if (value === null || value === undefined) return result;
    if (Array.isArray(value)) {
        for (const item of value) collectPayloadCandidateIds(item, result);
        return result;
    }
    if (typeof value !== 'object') return result;

    for (const [key, child] of Object.entries(value)) {
        const normalizedKey = String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
        const isCandidateKey = normalizedKey === 'seedid'
            || normalizedKey === 'itemid'
            || normalizedKey === 'rewarditemid'
            || normalizedKey === 'rewardid';
        if (isCandidateKey) {
            const id = normalizePositiveInt(child);
            if (id > 0) result.add(id);
        }
        collectPayloadCandidateIds(child, result);
    }
    return result;
}

function collectActivityItemIds(overview) {
    const ids = new Set();
    for (const activity of (Array.isArray(overview && overview.activities) ? overview.activities : [])) {
        for (const row of (activity?.randomShop?.items || [])) {
            const id = normalizePositiveInt(row?.item?.id);
            if (id > 0) ids.add(id);
        }
        for (const row of (activity?.exchangeShop?.items || [])) {
            const id = normalizePositiveInt(row?.item?.id);
            if (id > 0) ids.add(id);
        }
        for (const row of (activity?.drawInfo?.rewards || [])) {
            const id = normalizePositiveInt(row?.item?.id);
            if (id > 0) ids.add(id);
        }
        if (activity?.payload?.json) collectPayloadCandidateIds(activity.payload.json, ids);
    }
    return ids;
}

function sortPrioritySeeds(seeds, priorityList = []) {
    const priority = new Map();
    for (const [index, rawId] of (Array.isArray(priorityList) ? priorityList : []).entries()) {
        const id = normalizePositiveInt(rawId);
        if (id > 0 && !priority.has(id)) priority.set(id, index);
    }

    return [...(Array.isArray(seeds) ? seeds : [])].sort((a, b) => {
        if (!!a.activityReferenced !== !!b.activityReferenced) return a.activityReferenced ? -1 : 1;
        const ai = priority.has(a.seedId) ? priority.get(a.seedId) : Number.MAX_SAFE_INTEGER;
        const bi = priority.has(b.seedId) ? priority.get(b.seedId) : Number.MAX_SAFE_INTEGER;
        if (ai !== bi) return ai - bi;
        if (Number(a.plantSize) !== Number(b.plantSize)) return Number(b.plantSize) - Number(a.plantSize);
        if (Number(a.requiredLevel) !== Number(b.requiredLevel)) return Number(b.requiredLevel) - Number(a.requiredLevel);
        return Number(a.seedId) - Number(b.seedId);
    });
}

function buildDiscoverySignature(rows) {
    return (Array.isArray(rows) ? rows : [])
        .map(row => [
            row.seedId,
            row.count,
            row.resolved ? 1 : 0,
            row.plantSize || 0,
            row.shopListed === true ? 1 : row.shopListed === false ? 0 : -1,
            row.activityReferenced ? 1 : 0,
            row.specialCandidate ? 1 : 0,
            row.confidence || '',
        ].join(':'))
        .sort()
        .join('|');
}

function createDiscoveryStateStore(options = {}) {
    const getFile = typeof options.getDataFile === 'function' ? options.getDataFile : getDataFile;
    const readJson = typeof options.readJsonFile === 'function' ? options.readJsonFile : readJsonFile;
    const writeJson = typeof options.writeJsonFileAtomic === 'function' ? options.writeJsonFileAtomic : writeJsonFileAtomic;
    const signatureByAccount = new Map();

    function normalizeAccountId(value) {
        return String(value || '').trim().replace(/[^\w-]/g, '_') || 'default';
    }

    function record(accountId, rows, nowMs = Date.now()) {
        const key = normalizeAccountId(accountId);
        const list = Array.isArray(rows) ? rows : [];
        const signature = buildDiscoverySignature(list);
        if (signatureByAccount.get(key) === signature) return false;

        const file = getFile(`seed_discovery/${key}.json`);
        const previous = readJson(file, () => ({ version: 1, entries: {} })) || {};
        const previousEntries = previous.entries && typeof previous.entries === 'object' ? previous.entries : {};
        const nextEntries = { ...previousEntries };

        for (const row of list) {
            const id = normalizePositiveInt(row?.seedId);
            if (id <= 0) continue;
            const old = previousEntries[String(id)] || {};
            nextEntries[String(id)] = {
                seedId: id,
                name: String(row.name || `疑似种子#${id}`),
                firstSeenAt: Number(old.firstSeenAt) > 0 ? Number(old.firstSeenAt) : nowMs,
                lastSeenAt: nowMs,
                lastCount: Math.max(0, Number(row.count) || 0),
                resolved: row.resolved === true,
                safeToPlant: row.safeToPlant === true,
                plantSize: Math.max(0, Number(row.plantSize) || 0),
                requiredLevel: Math.max(0, Number(row.requiredLevel) || 0),
                shopListed: row.shopListed === true ? true : row.shopListed === false ? false : null,
                activityReferenced: row.activityReferenced === true,
                specialCandidate: row.specialCandidate === true,
                confidence: String(row.confidence || ''),
                evidence: Array.isArray(row.evidence) ? [...row.evidence] : [],
                itemType: Math.max(0, Number(row.itemType) || 0),
                interactionType: String(row.interactionType || ''),
                itemName: String(row.itemName || ''),
                assetName: String(row.assetName || ''),
                configFallback: row.configFallback === true,
            };
        }

        writeJson(file, {
            version: 1,
            accountId: String(accountId || ''),
            updatedAt: nowMs,
            entries: nextEntries,
        });
        signatureByAccount.set(key, signature);
        return true;
    }

    return { record };
}

function createEventSeedPriorityService(options = {}) {
    const readBag = typeof options.getBag === 'function' ? options.getBag : getBag;
    const extractBagItems = typeof options.getBagItems === 'function' ? options.getBagItems : getBagItems;
    const readItemById = typeof options.getItemById === 'function' ? options.getItemById : getItemById;
    const readPlantBySeedId = typeof options.getPlantBySeedId === 'function' ? options.getPlantBySeedId : getPlantBySeedId;
    const readShop = typeof options.getShopInfo === 'function' ? options.getShopInfo : getShopInfo;
    const readActivities = typeof options.listActivityOverview === 'function' ? options.listActivityOverview : listActivityOverview;
    const readAllLands = typeof options.getAllLands === 'function' ? options.getAllLands : null;
    const plantOneByOne = typeof options.plantSeeds === 'function' ? options.plantSeeds : null;
    const plant2x2 = typeof options.plant2x2Seed === 'function' ? options.plant2x2Seed : null;
    const choose2x2 = typeof options.selectReady2x2Groups === 'function' ? options.selectReady2x2Groups : selectReady2x2Groups;
    const readPriority = typeof options.getBagSeedPriority === 'function' ? options.getBagSeedPriority : getBagSeedPriority;
    const logInfo = typeof options.log === 'function' ? options.log : log;
    const logWarning = typeof options.logWarn === 'function' ? options.logWarn : logWarn;
    const wait = typeof options.sleep === 'function' ? options.sleep : sleep;
    const stateStore = options.discoveryStateStore || createDiscoveryStateStore(options);
    const activityTtlMs = Math.max(30_000, Number(options.activityCacheTtlMs) || ACTIVITY_CACHE_TTL_MS);
    const logIntervalMs = Math.max(30_000, Number(options.discoveryLogIntervalMs) || DISCOVERY_LOG_INTERVAL_MS);

    let activityCache = { at: 0, ids: new Set(), loaded: false };
    const logStateByAccount = new Map();

    function accountKey(accountId) {
        return String(accountId || process.env.FARM_ACCOUNT_ID || '').trim() || 'default';
    }

    function maybeLog(accountId, key, message, meta = {}, warn = false) {
        const now = Date.now();
        const account = accountKey(accountId);
        const previous = logStateByAccount.get(account) || { key: '', at: 0 };
        if (previous.key === key && now - previous.at < logIntervalMs) return false;
        logStateByAccount.set(account, { key, at: now });
        (warn ? logWarning : logInfo)('种植', message, {
            module: 'farm',
            event: '活动种子发现',
            ...meta,
        });
        return true;
    }

    async function getActivityReferences() {
        const now = Date.now();
        if (activityCache.at > 0 && now - activityCache.at < activityTtlMs) return activityCache;
        try {
            const overview = await readActivities();
            activityCache = { at: now, ids: collectActivityItemIds(overview), loaded: true };
        } catch {
            activityCache = { at: now, ids: new Set(), loaded: false };
        }
        return activityCache;
    }

    async function inspectContext() {
        const activity = await getActivityReferences();
        let bagReply;
        try {
            bagReply = await readBag();
        } catch (error) {
            return {
                ok: false,
                reason: 'bag_read_failed',
                error,
                activityLoaded: activity.loaded,
                activityItemIds: activity.ids,
            };
        }

        const inventory = buildBagSeedInventory(extractBagItems(bagReply), {
            getItemById: readItemById,
            getPlantBySeedId: readPlantBySeedId,
            activityItemIds: activity.ids,
        });

        let shopLoaded = false;
        let shopSeedIds = new Set();
        try {
            shopSeedIds = buildShopSeedIdSet(await readShop(SEED_SHOP_ID));
            shopLoaded = true;
        } catch {}

        const decorate = row => {
            const shopListed = shopLoaded ? shopSeedIds.has(row.seedId) : null;
            return {
                ...row,
                shopListed,
                specialCandidate: row.activityReferenced === true || (shopLoaded && shopListed === false),
            };
        };

        return {
            ok: true,
            activityLoaded: activity.loaded,
            shopLoaded,
            shopSeedIds,
            inventory: {
                all: inventory.all.map(decorate),
                knownSeeds: inventory.knownSeeds.map(decorate),
                unresolvedCandidates: inventory.unresolvedCandidates.map(decorate),
            },
        };
    }

    async function runBeforeShop(run = {}) {
        const targetLandIds = [...new Set((Array.isArray(run.landIds) ? run.landIds : [])
            .map(normalizePositiveInt)
            .filter(Boolean))];
        const state = run.state && typeof run.state === 'object' ? run.state : {};
        const userLevel = Math.max(0, Number(state.level) || 0);
        const accountId = accountKey(run.accountId);
        const emptyResult = {
            remainingLandIds: targetLandIds,
            plantedLandIds: [],
            totalPlanted: 0,
            occupiedCount: 0,
            blockShopFallback: false,
            knownSeedBlock: false,
            knownSeedBlockReasons: [],
            unresolvedSeedIds: [],
            prioritySeedIds: [],
            inspection: null,
        };
        if (targetLandIds.length === 0) return emptyResult;

        const inspected = await inspectContext();
        if (!inspected.ok) {
            maybeLog(
                accountId,
                'bag_read_failed',
                `活动种子优先检查无法读取背包，已暂停本轮商店补种: ${inspected.error?.message || 'unknown error'}`,
                { result: 'block_shop_bag_read_failed' },
                true,
            );
            return { ...emptyResult, blockShopFallback: true, inspection: inspected };
        }

        const inventory = inspected.inventory;
        try {
            stateStore.record(accountId, inventory.all);
        } catch {}

        const unresolved = inventory.unresolvedCandidates.filter(row => row.count > 0);
        const prioritySeeds = sortPrioritySeeds(
            inventory.knownSeeds.filter(row => row.count > 0 && row.specialCandidate),
            readPriority(),
        );
        const usablePrioritySeeds = prioritySeeds.filter(row => row.requiredLevel <= userLevel);
        const lockedPrioritySeeds = prioritySeeds.filter(row => row.requiredLevel > userLevel);

        let remainingLandIds = [...targetLandIds];
        const plantedLandIds = [];
        let totalPlanted = 0;
        let occupiedCount = 0;
        let blockShopFallback = unresolved.length > 0;
        let knownSeedBlock = false;
        const knownSeedBlockReasons = [];
        const markKnownSeedBlock = (reason) => {
            knownSeedBlock = true;
            if (reason && !knownSeedBlockReasons.includes(reason)) {
                knownSeedBlockReasons.push(reason);
            }
        };

        if (lockedPrioritySeeds.length > 0) {
            maybeLog(
                accountId,
                `locked:${lockedPrioritySeeds.map(row => row.seedId).join(',')}`,
                `检测到活动/特殊背包种子但当前等级未解锁：${lockedPrioritySeeds.map(row => `${row.name}#${row.seedId}`).join('、')}，本轮继续原策略`,
                { result: 'special_seed_locked', seedIds: lockedPrioritySeeds.map(row => row.seedId), userLevel },
            );
        }

        const twoByTwoSeeds = usablePrioritySeeds
            .filter(row => row.safeToPlant && row.plantSize === 2)
            .map(row => ({ ...row, remainingCount: row.count }));
        const oneByOneSeeds = usablePrioritySeeds.filter(row => row.safeToPlant && row.plantSize === 1);
        const unsupportedKnown = usablePrioritySeeds.filter(row => !row.safeToPlant || ![1, 2].includes(row.plantSize));
        if (unsupportedKnown.length > 0) {
            blockShopFallback = true;
            markKnownSeedBlock('unsupported-known');
        }

        if (twoByTwoSeeds.length > 0 && remainingLandIds.length > 0) {
            if (typeof readAllLands !== 'function' || typeof plant2x2 !== 'function') {
                blockShopFallback = true;
                markKnownSeedBlock('2x2-unavailable');
            } else {
                try {
                    const latest = await readAllLands();
                    const latestLands = Array.isArray(latest?.lands) ? latest.lands : [];
                    const desiredCount = twoByTwoSeeds.reduce((sum, row) => sum + Math.max(0, row.remainingCount), 0);
                    const groups = choose2x2(latestLands, remainingLandIds, desiredCount);
                    let groupIndex = 0;

                    for (const seed of twoByTwoSeeds) {
                        while (seed.remainingCount > 0 && groupIndex < groups.length) {
                            const group = groups[groupIndex++];
                            try {
                                const planted = await plant2x2(seed.seedId, group);
                                const occupied = (Array.isArray(planted?.occupiedLandIds)
                                    ? planted.occupiedLandIds
                                    : group.landIds).map(normalizePositiveInt).filter(Boolean);
                                plantedLandIds.push(normalizePositiveInt(planted?.masterLandId) || normalizePositiveInt(group.masterLandId));
                                remainingLandIds = remainingLandIds.filter(id => !occupied.includes(id));
                                totalPlanted += 1;
                                occupiedCount += occupied.length;
                                seed.remainingCount -= 1;
                            } catch (error) {
                                blockShopFallback = true;
                                markKnownSeedBlock('2x2-failed');
                                maybeLog(
                                    accountId,
                                    `2x2-failed:${seed.seedId}`,
                                    `活动/特殊 2x2 种子 ${seed.name}(${seed.seedId}) 种植失败，已暂停本轮商店补种: ${error.message}`,
                                    { result: 'special_2x2_failed', seedId: seed.seedId, landIds: group.landIds },
                                    true,
                                );
                                seed.remainingCount = 0;
                            }
                            await wait(100);
                        }
                    }

                    const unplanted2x2 = twoByTwoSeeds.filter(seed => seed.remainingCount > 0);
                    if (unplanted2x2.length > 0) {
                        blockShopFallback = true;
                        markKnownSeedBlock('2x2-waiting');
                        maybeLog(
                            accountId,
                            `2x2-wait:${unplanted2x2.map(row => row.seedId).join(',')}`,
                            `背包有活动/特殊 2x2 种子等待空地：${unplanted2x2.map(row => `${row.name}x${row.remainingCount}`).join('、')}，已暂停商店占用剩余空地`,
                            { result: 'special_2x2_waiting', seedIds: unplanted2x2.map(row => row.seedId) },
                        );
                    }
                } catch (error) {
                    blockShopFallback = true;
                    markKnownSeedBlock('2x2-probe-failed');
                    maybeLog(
                        accountId,
                        '2x2-probe-failed',
                        `活动/特殊 2x2 种子检查土地失败，已暂停本轮商店补种: ${error.message}`,
                        { result: 'special_2x2_probe_failed' },
                        true,
                    );
                }
            }
        }

        if (oneByOneSeeds.length > 0 && remainingLandIds.length > 0) {
            if (typeof plantOneByOne !== 'function') {
                blockShopFallback = true;
                markKnownSeedBlock('1x1-unavailable');
            } else {
                for (const seed of oneByOneSeeds) {
                    if (remainingLandIds.length === 0) break;
                    const maxPlantCount = Math.min(Math.max(0, Number(seed.count) || 0), remainingLandIds.length);
                    if (maxPlantCount <= 0) continue;

                    const result = await plantOneByOne(seed.seedId, remainingLandIds, { maxPlantCount });
                    const occupied = (Array.isArray(result?.occupiedLandIds)
                        ? result.occupiedLandIds
                        : []).map(normalizePositiveInt).filter(Boolean);
                    const masters = (Array.isArray(result?.plantedLandIds)
                        ? result.plantedLandIds
                        : []).map(normalizePositiveInt).filter(Boolean);
                    const plantedCount = Math.max(0, Number(result?.planted) || 0);

                    if (plantedCount > 0) {
                        plantedLandIds.push(...masters);
                        totalPlanted += plantedCount;
                        occupiedCount += occupied.length > 0 ? occupied.length : plantedCount;
                        remainingLandIds = occupied.length > 0
                            ? remainingLandIds.filter(id => !occupied.includes(id))
                            : remainingLandIds.slice(plantedCount);
                    }

                    if (plantedCount < maxPlantCount && remainingLandIds.length > 0) {
                        blockShopFallback = true;
                        markKnownSeedBlock('1x1-partial');
                        maybeLog(
                            accountId,
                            `1x1-partial:${seed.seedId}`,
                            `活动/特殊背包种子 ${seed.name}(${seed.seedId}) 实际种植 ${plantedCount}/${maxPlantCount}，已暂停本轮商店补种`,
                            {
                                result: 'special_1x1_partial',
                                seedId: seed.seedId,
                                requested: maxPlantCount,
                                planted: plantedCount,
                            },
                            true,
                        );
                        break;
                    }
                }
            }
        }

        if (totalPlanted > 0) {
            logInfo('种植', `已优先消耗活动/特殊背包种子，共种植 ${totalPlanted} 组，占用 ${occupiedCount} 块地`, {
                module: 'farm',
                event: '活动种子优先种植',
                result: 'ok',
                seedIds: usablePrioritySeeds.map(row => row.seedId),
                count: totalPlanted,
                occupiedCount,
            });
        }

        if (unresolved.length > 0) {
            const ids = unresolved.map(row => row.seedId);
            maybeLog(
                accountId,
                `unresolved:${ids.join(',')}`,
                `发现尚未识别的疑似活动种子 ${unresolved.map(row => `${row.name}(${row.seedId})x${row.count}`).join('、')}；为避免误买普通种子，本轮暂停商店补种并记录学习证据`,
                {
                    result: 'unresolved_seed_block_shop',
                    seedIds: ids,
                    confidence: unresolved.map(row => ({ seedId: row.seedId, confidence: row.confidence })),
                },
                true,
            );
        }

        return {
            remainingLandIds,
            plantedLandIds: [...new Set(plantedLandIds.filter(Boolean))],
            totalPlanted,
            occupiedCount,
            blockShopFallback,
            knownSeedBlock,
            knownSeedBlockReasons,
            unresolvedSeedIds: unresolved.map(row => row.seedId),
            prioritySeedIds: prioritySeeds.map(row => row.seedId),
            inspection: inspected,
        };
    }

    return { inspectContext, runBeforeShop };
}

module.exports = {
    SEED_SHOP_ID,
    ACTIVITY_CACHE_TTL_MS,
    DISCOVERY_LOG_INTERVAL_MS,
    isSeedNamespaceId,
    inspectSeedEvidence,
    buildBagSeedInventory,
    buildShopSeedIdSet,
    collectPayloadCandidateIds,
    collectActivityItemIds,
    sortPrioritySeeds,
    buildDiscoverySignature,
    createDiscoveryStateStore,
    createEventSeedPriorityService,
};
