/**
 * 自己的农场操作 - 收获/浇水/除草/除虫/铲除/种植/商店/巡田
 */

const { CONFIG, PlantPhase, PHASE_NAMES } = require('../config/config');
const { getPlantNameBySeedId, getPlantName, getPlantExp, getPlantGrowTime, getAllSeeds, getPlantById, getSeedImageBySeedId, getMutantEffectsByIds } = require('../config/gameConfig');
const { isAutomationOn, getAutomation, getPlantingStrategy, getPrioritize2x2Crops, getBagSeedPriority, getBagSeedFallbackStrategy, getFertilizerBuyOrganicCount, getFertilizerBuyOrganicThresholdHours, getFertilizerBuyNormalCount, getFertilizerBuyNormalThresholdHours, getFertilizerBuyCheckIntervalMinutes } = require('../models/store');
const { getUserState, networkEvents, getWsErrorState } = require('../utils/network');
const { toLong, toNum, getServerTimeSec, toTimeSec, log, logWarn, sleep, randomDelay } = require('../utils/utils');
const { createScheduler } = require('./scheduler');
const { recordOperation } = require('./stats');
const { getBagSeeds, getBag, getBagItems, getContainerHoursFromBagItems } = require('./warehouse');
const { autoBuyFertilizer, checkAndBuyFertilizerBoth } = require('./mall');
const { runPrioritized2x2Prepass } = require('./farm-2x2-priority');
const { buildMutationDetail } = require('./farm-mutation');
const {
    getDisplayLandContext,
    isOccupiedSlaveLand,
    buildSlaveToMasterMap,
    summarizeLandDetails,
    getLandTypeByLevel,
    getCurrentPhase,
    buildLandMap,
    classifyHarvestedLandsByMap,
} = require('./farm-land-analyzer');
const {
    getAllLandsRaw,
    harvest,
    waterLand,
    weedOut,
    insecticide,
    removePlant,
    upgradeLand,
    unlockLand,
    getShopInfo,
} = require('./farm-api');
const { createFarmFertilizerService } = require('./farm-fertilizer');
const { createPlantingService, getPlantingStrategyLabel } = require('./planting-service');

// ============ 内部状态 ============
let isCheckingFarm = false;
let isFirstFarmCheck = true;
let farmLoopRunning = false;
let externalSchedulerMode = false;
let fertilizerBuyCheckTimer = null;
let lastFertilizerBuyCheckAt = 0;
const farmScheduler = createScheduler('farm');

// ============ 农场 API ============

// 操作限制更新回调 (由 friend.js 设置)
let onOperationLimitsUpdate = null;
function setOperationLimitsCallback(callback) {
    onOperationLimitsUpdate = callback;
}

async function getAllLands() {
    const reply = await getAllLandsRaw();
    // 保持原有副作用边界：transport 只负责 RPC，operation-limit 回调仍由 farm facade 触发。
    if (reply.operation_limits && onOperationLimitsUpdate) {
        onOperationLimitsUpdate(reply.operation_limits);
    }
    return reply;
}


const { runFertilizerByConfig } = createFarmFertilizerService({
    // 必须注入 facade wrapper，不能直接使用 getAllLandsRaw；这样 operation-limit callback 语义保持不变。
    getAllLands,
});

const {
    plant2x2Seed,
    plantFromBagSeeds,
    plantFromShop,
} = createPlantingService({
    // 背包 2x2 探测必须继续经过 facade wrapper，保持 operation-limit callback 语义。
    getAllLands,
});

// ============ 种植执行：由 planting-service.js 提供 ============

async function getAvailableSeeds() {
    const SEED_SHOP_ID = 2;
    const state = getUserState();
    let list = [];
    
    try {
        const shopReply = await getShopInfo(SEED_SHOP_ID);
        if (shopReply.goods_list) {
            for (const goods of shopReply.goods_list) {
                let requiredLevel = 0;
                for (const cond of goods.conds || []) {
                    if (toNum(cond.type) === 1) requiredLevel = toNum(cond.param);
                }
                
                const limitCount = toNum(goods.limit_count);
                const boughtNum = toNum(goods.bought_num);
                const isSoldOut = limitCount > 0 && boughtNum >= limitCount;
    
                list.push({
                    seedId: toNum(goods.item_id),
                    goodsId: toNum(goods.id),
                    name: getPlantNameBySeedId(toNum(goods.item_id)),
                    price: toNum(goods.price),
                    requiredLevel,
                    locked: !goods.unlocked || state.level < requiredLevel,
                    soldOut: isSoldOut,
                });
            }
        }
    } catch (e) {
        const wsErr = getWsErrorState();
        if (!wsErr || Number(wsErr.code) !== 400) {
            logWarn('商店', `获取商店失败: ${e.message}，使用本地备选列表`);
        }
    }

    if (list.length === 0) {
        const allSeeds = getAllSeeds();
        list = allSeeds.map(s => ({
            ...s,
            goodsId: 0,
            price: null,
            requiredLevel: null,
            unknownMeta: true,
            locked: false,
            soldOut: false,
        }));
    }
    return list.sort((a, b) => {
        const av = (a.requiredLevel === null || a.requiredLevel === undefined) ? 9999 : a.requiredLevel;
        const bv = (b.requiredLevel === null || b.requiredLevel === undefined) ? 9999 : b.requiredLevel;
        return av - bv;
    });
}

async function getLandsDetail() {
    try {
        const landsReply = await getAllLands();
        if (!landsReply.lands) return { lands: [], summary: {} };
        const nowSec = getServerTimeSec();
        const lands = [];
        const landsMap = buildLandMap(landsReply.lands);

        for (const land of landsReply.lands) {
            const id = toNum(land.id);
            const level = toNum(land.level);
            const maxLevel = toNum(land.max_level);
            const landsLevel = toNum(land.lands_level);
            const landSize = toNum(land.land_size);
            const couldUnlock = !!land.could_unlock;
            const couldUpgrade = !!land.could_upgrade;
            const {
                sourceLand,
                occupiedByMaster,
                masterLandId,
                occupiedLandIds,
            } = getDisplayLandContext(land, landsMap);
            if (!land.unlocked) {
                lands.push({
                    id,
                    unlocked: false,
                    status: 'locked',
                    plantName: '',
                    phaseName: '',
                    level,
                    maxLevel,
                    landsLevel,
                    landSize,
                    couldUnlock,
                    couldUpgrade,
                    currentSeason: 0,
                    totalSeason: 0,
                    occupiedByMaster: false,
                    masterLandId: 0,
                    occupiedLandIds: [],
                    plantSize: 1,
                });
                continue;
            }
            const plant = sourceLand && sourceLand.plant;
            if (!plant || !plant.phases || plant.phases.length === 0) {
                lands.push({
                    id,
                    unlocked: true,
                    status: 'empty',
                    plantName: '',
                    phaseName: '空地',
                    level,
                    maxLevel,
                    landsLevel,
                    landSize,
                    couldUnlock,
                    couldUpgrade,
                    currentSeason: 0,
                    totalSeason: 0,
                    occupiedByMaster,
                    masterLandId,
                    occupiedLandIds,
                    plantSize: 1,
                });
                continue;
            }
            const currentPhase = getCurrentPhase(plant.phases, false, '');
            if (!currentPhase) {
                lands.push({
                    id,
                    unlocked: true,
                    status: 'empty',
                    plantName: '',
                    phaseName: '',
                    level,
                    maxLevel,
                    landsLevel,
                    landSize,
                    couldUnlock,
                    couldUpgrade,
                    currentSeason: 0,
                    totalSeason: 0,
                    occupiedByMaster,
                    masterLandId,
                    occupiedLandIds,
                    plantSize: 1,
                });
                continue;
            }
            const phaseVal = currentPhase.phase;
            const plantId = toNum(plant.id);
            const plantName = getPlantName(plantId) || plant.name || '未知';
            const plantCfg = getPlantById(plantId);
            const seedId = toNum(plantCfg && plantCfg.seed_id);
            const seedImage = seedId > 0 ? getSeedImageBySeedId(seedId) : '';
            const plantSize = Math.max(1, toNum(plantCfg && plantCfg.size) || 1);
            const totalSeason = Math.max(1, toNum(plantCfg && plantCfg.seasons) || 1);
            const currentSeasonRaw = toNum(plant.season);
            const currentSeason = currentSeasonRaw > 0 ? Math.min(currentSeasonRaw, totalSeason) : 1;
            const phaseName = PHASE_NAMES[phaseVal] || '';
            const maturePhase = Array.isArray(plant.phases)
                ? plant.phases.find((p) => p && toNum(p.phase) === PlantPhase.MATURE)
                : null;
            const matureBegin = maturePhase ? toTimeSec(maturePhase.begin_time) : 0;
            const matureInSec = matureBegin > nowSec ? (matureBegin - nowSec) : 0;
            const totalGrowTime = getPlantGrowTime(plantId);

            let landStatus = 'growing';
            if (phaseVal === PlantPhase.MATURE) landStatus = 'harvestable';
            else if (phaseVal === PlantPhase.DEAD) landStatus = 'dead';
            else if (phaseVal === PlantPhase.UNKNOWN || !plant.phases.length) landStatus = 'empty';

            const needWater = (toNum(plant.dry_num) > 0) || (toTimeSec(currentPhase.dry_time) > 0 && toTimeSec(currentPhase.dry_time) <= nowSec);
            const needWeed = (plant.weed_owners && plant.weed_owners.length > 0) || (toTimeSec(currentPhase.weeds_time) > 0 && toTimeSec(currentPhase.weeds_time) <= nowSec);
            const needBug = (plant.insect_owners && plant.insect_owners.length > 0) || (toTimeSec(currentPhase.insect_time) > 0 && toTimeSec(currentPhase.insect_time) <= nowSec);
            const mutation = occupiedByMaster
                ? { active: false, configIds: [], effects: [], unknownConfigIds: [], events: [] }
                : buildMutationDetail(plant, currentPhase, getMutantEffectsByIds);

            lands.push({
                id,
                unlocked: true,
                status: landStatus,
                plantName,
                seedId,
                seedImage,
                phaseName,
                currentSeason,
                totalSeason,
                matureInSec,
                totalGrowTime,
                needWater,
                needWeed,
                needBug,
                stealable: !!plant.stealable,
                level,
                maxLevel,
                landsLevel,
                landSize,
                couldUnlock,
                couldUpgrade,
                occupiedByMaster,
                masterLandId,
                occupiedLandIds,
                plantSize,
                mutation,
                mutantConfigIds: mutation.configIds,
                mutantEffects: mutation.effects,
                mutantEvents: mutation.events,
            });
        }

        return {
            lands,
            summary: summarizeLandDetails(lands),
        };
    } catch {
        return { lands: [], summary: {} };
    }
}

async function autoPlantEmptyLands(deadLandIds, emptyLandIds) {
    let landsToPlant = [...emptyLandIds];
    const state = getUserState();

    if (deadLandIds.length > 0) {
        try {
            await removePlant(deadLandIds);
            log('铲除', `已铲除 ${deadLandIds.length} 块 (${deadLandIds.join(',')})`, {
                module: 'farm', event: '铲除植物', result: 'ok', count: deadLandIds.length
            });
            landsToPlant.push(...deadLandIds);
        } catch (e) {
            logWarn('铲除', `批量铲除失败: ${e.message}`, {
                module: 'farm', event: '铲除植物', result: 'error'
            });
            landsToPlant.push(...deadLandIds);
        }
    }

    if (landsToPlant.length === 0) return;

    landsToPlant = [...new Set(landsToPlant.map(id => toNum(id)).filter(Boolean))];
    if (landsToPlant.length === 0) return;

    try {
        const twoByTwo = await runPrioritized2x2Prepass({
            enabled: getPrioritize2x2Crops(),
            landIds: landsToPlant,
            getBagSeeds,
            bagSeedPriority: getBagSeedPriority(),
            userLevel: Number(state.level || 0),
            getAllLands,
            plant2x2Seed,
            log,
            logWarn,
            sleep,
        });
        landsToPlant = twoByTwo.remainingLandIds || landsToPlant;
        if (twoByTwo.plantedLandIds && twoByTwo.plantedLandIds.length > 0) {
            await runFertilizerByConfig(twoByTwo.plantedLandIds);
        }
    } catch (e) {
        logWarn('种植', `2x2 优先链异常，继续原种植策略: ${e.message}`, {
            module: 'farm', event: '种植2x2作物', result: 'prepass_error',
        });
    }

    if (landsToPlant.length === 0) return;

    const accountStrategy = String(getPlantingStrategy() || '').trim();

    if (accountStrategy === 'bag_priority') {
        let bagResult;
        try {
            bagResult = await plantFromBagSeeds(landsToPlant);
        } catch (e) {
            logWarn('种植', `读取背包种子失败，本轮跳过第二优先策略以避免误购: ${e.message}`, {
                module: 'farm',
                event: '种植种子',
                result: 'bag_load_error',
            });
            return { plantedLands: [] };
        }

        const plantedLands = bagResult.plantedLandIds || [];
        
        if (bagResult.fallbackAllowed && bagResult.remainingLandIds.length > 0) {
            const fallbackStrategy = getBagSeedFallbackStrategy() || 'level';
            log('种植', `开始按第二优先策略"${getPlantingStrategyLabel(fallbackStrategy)}"补种剩余空地`, {
                module: 'farm',
                event: '种植种子',
                result: 'fallback_start',
                strategy: fallbackStrategy,
                remainingCount: bagResult.remainingLandIds.length,
            });
            const shopResult = await plantFromShop(bagResult.remainingLandIds, state, fallbackStrategy);
            plantedLands.push(...(shopResult.plantedLands || []));
        }

        if (plantedLands.length > 0) {
            await runFertilizerByConfig(plantedLands);
        }
        return;
    }

    const shopResult = await plantFromShop(landsToPlant, state);
    if (shopResult.plantedLands && shopResult.plantedLands.length > 0) {
        await runFertilizerByConfig(shopResult.plantedLands);
    }
}

function analyzeLands(lands) {
    const result = {
        harvestable: [], needWater: [], needWeed: [], needBug: [],
        growing: [], empty: [], dead: [], unlockable: [], upgradable: [],
        harvestableInfo: [],
    };

    const nowSec = getServerTimeSec();
    const debug = isFirstFarmCheck;
    const landsMap = buildLandMap(lands);

    for (const land of lands) {
        const id = toNum(land.id);
        if (!land.unlocked) {
            if (land.could_unlock) {
                result.unlockable.push(id);
            }
            continue;
        }
        if (land.could_upgrade) {
            result.upgradable.push(id);
        }

        if (isOccupiedSlaveLand(land, landsMap)) {
            continue;
        }

        const plant = land.plant;
        if (!plant || !plant.phases || plant.phases.length === 0) {
            result.empty.push(id);
            continue;
        }

        const plantName = plant.name || '未知作物';
        const landLabel = `土地#${id}(${plantName})`;

        const currentPhase = getCurrentPhase(plant.phases, debug, landLabel);
        if (!currentPhase) {
            result.empty.push(id);
            continue;
        }
        const phaseVal = currentPhase.phase;

        if (phaseVal === PlantPhase.DEAD) {
            result.dead.push(id);
            continue;
        }

        if (phaseVal === PlantPhase.MATURE) {
            result.harvestable.push(id);
            const plantId = toNum(plant.id);
            const plantNameFromConfig = getPlantName(plantId);
            const plantExp = getPlantExp(plantId);
            result.harvestableInfo.push({
                landId: id,
                plantId,
                name: plantNameFromConfig || plantName,
                exp: plantExp,
            });
            continue;
        }

        const dryNum = toNum(plant.dry_num);
        const dryTime = toTimeSec(currentPhase.dry_time);
        if (dryNum > 0 || (dryTime > 0 && dryTime <= nowSec)) {
            result.needWater.push(id);
        }

        const weedsTime = toTimeSec(currentPhase.weeds_time);
        const hasWeeds = (plant.weed_owners && plant.weed_owners.length > 0) || (weedsTime > 0 && weedsTime <= nowSec);
        if (hasWeeds) {
            result.needWeed.push(id);
        }

        const insectTime = toTimeSec(currentPhase.insect_time);
        const hasBugs = (plant.insect_owners && plant.insect_owners.length > 0) || (insectTime > 0 && insectTime <= nowSec);
        if (hasBugs) {
            result.needBug.push(id);
        }

        result.growing.push(id);
    }

    return result;
}

async function resolveRemovableHarvestedLands(harvestedLandIds, harvestReply) {
    const ids = Array.isArray(harvestedLandIds) ? harvestedLandIds.filter(Boolean) : [];
    if (ids.length === 0) {
        return { removable: [], growing: [], fallbackRemoved: 0 };
    }

    const replyMap = buildLandMap(harvestReply && harvestReply.land);
    const firstPass = classifyHarvestedLandsByMap(ids, replyMap);
    const removable = [...firstPass.removable];
    const growing = [...firstPass.growing];
    let unknown = [...firstPass.unknown];
    let fallbackRemoved = 0;

    if (unknown.length > 0) {
        try {
            const latestLandsReply = await getAllLands();
            const latestMap = buildLandMap(latestLandsReply && latestLandsReply.lands);
            const secondPass = classifyHarvestedLandsByMap(unknown, latestMap);
            removable.push(...secondPass.removable);
            growing.push(...secondPass.growing);
            unknown = secondPass.unknown;
        } catch (e) {
            logWarn('农场', `收后状态补拉失败: ${e.message}`, {
                module: 'farm',
                event: '收获后状态补拉',
                result: 'error',
            });
        }
    }

    if (unknown.length > 0) {
        removable.push(...unknown);
        fallbackRemoved = unknown.length;
    }

    return {
        removable: [...new Set(removable)],
        growing: [...new Set(growing)],
        fallbackRemoved,
    };
}

async function checkFarm() {
    const state = getUserState();
    if (isCheckingFarm || !state.gid || !isAutomationOn('farm')) return false;
    isCheckingFarm = true;

    try {
        const result = await runFarmOperation('all');
        isFirstFarmCheck = false;
        return !!(result && result.hadWork);
    } catch (err) {
        logWarn('巡田', `检查失败: ${err.message}`);
        return false;
    } finally {
        isCheckingFarm = false;
    }
}

/**
 * 手动/自动执行农场操作
 * @param {string} opType - 'all', 'harvest', 'clear', 'plant', 'upgrade'
 */
async function runFarmOperation(opType) {
    const landsReply = await getAllLands();
    if (!landsReply.lands || landsReply.lands.length === 0) {
        if (opType !== 'all') {
            log('农场', '没有土地数据');
        }
        return { hadWork: false, actions: [] };
    }

    const lands = landsReply.lands;
    const status = analyzeLands(lands);

    const statusParts = [];
    if (status.harvestable.length) statusParts.push(`收:${status.harvestable.length}`);
    if (status.needWeed.length) statusParts.push(`草:${status.needWeed.length}`);
    if (status.needBug.length) statusParts.push(`虫:${status.needBug.length}`);
    if (status.needWater.length) statusParts.push(`水:${status.needWater.length}`);
    if (status.dead.length) statusParts.push(`枯:${status.dead.length}`);
    if (status.empty.length) statusParts.push(`空:${status.empty.length}`);
    if (status.unlockable.length) statusParts.push(`解:${status.unlockable.length}`);
    if (status.upgradable.length) statusParts.push(`升:${status.upgradable.length}`);
    statusParts.push(`长:${status.growing.length}`);

    const actions = [];

    if (opType === 'all' || opType === 'clear') {
        const skipOwnWeedBug = opType === 'all' && isAutomationOn('skip_own_weed_bug');
        if (status.needWeed.length > 0 && !skipOwnWeedBug) {
            try {
                await weedOut(status.needWeed);
                actions.push(`除草${status.needWeed.length}`);
                recordOperation('weed', status.needWeed.length);
            } catch (e) {
                logWarn('除草', e.message);
            }
        }
        if (status.needBug.length > 0 && !skipOwnWeedBug) {
            try {
                await insecticide(status.needBug);
                actions.push(`除虫${status.needBug.length}`);
                recordOperation('bug', status.needBug.length);
            } catch (e) {
                logWarn('除虫', e.message);
            }
        }
        if (status.needWater.length > 0) {
            try {
                await waterLand(status.needWater);
                actions.push(`浇水${status.needWater.length}`);
                recordOperation('water', status.needWater.length);
            } catch (e) {
                logWarn('浇水', e.message);
            }
        }
    }

    let harvestedLandIds = [];
    let harvestReply = null;
    let postHarvest = null;
    if (opType === 'all' || opType === 'harvest') {
        if (status.harvestable.length > 0) {
            try {
                harvestReply = await harvest(status.harvestable);
                log('收获', `收获完成 ${status.harvestable.length} 块土地`, {
                    module: 'farm',
                    event: '收获作物',
                    result: 'ok',
                    count: status.harvestable.length,
                    landIds: [...status.harvestable],
                });
                actions.push(`收获${status.harvestable.length}`);
                recordOperation('harvest', status.harvestable.length);
                harvestedLandIds = [...status.harvestable];
                networkEvents.emit('farmHarvested', {
                    count: status.harvestable.length,
                    landIds: [...status.harvestable],
                    opType,
                });
            } catch (e) {
                logWarn('收获', e.message, {
                    module: 'farm',
                    event: '收获作物',
                    result: 'error',
                });
            }
        }
    }

    if (opType === 'all' || opType === 'plant') {
        const allEmptyLands = [...new Set(status.empty)];
        let allDeadLands = [...new Set(status.dead)];

        if (opType === 'all' && harvestedLandIds.length > 0) {
            await randomDelay(1000, 1500);
            postHarvest = await resolveRemovableHarvestedLands(harvestedLandIds, harvestReply);
            allDeadLands = [...new Set([...allDeadLands, ...postHarvest.removable])];
        }
        if (allDeadLands.length > 0 || allEmptyLands.length > 0) {
            try {
                const plantCount = allDeadLands.length + allEmptyLands.length;
                await autoPlantEmptyLands(allDeadLands, allEmptyLands);
                actions.push(`种植${plantCount}`);
                recordOperation('plant', plantCount);
            } catch (e) { logWarn('种植', e.message); }
        }
    }
    if (opType === 'all' && postHarvest && Array.isArray(postHarvest.growing) && postHarvest.growing.length > 0 && isAutomationOn('fertilizer_multi_season')) {
        const multiSeasonTargets = [...new Set(postHarvest.growing.map(v => toNum(v)).filter(Boolean))];
        if (multiSeasonTargets.length > 0) {
            log('施肥', `检测到多季作物进入后续季，准备执行多季补肥，目标地块 ${multiSeasonTargets.length} 块`, {
                module: 'farm',
                event: '多季节施肥',
                result: 'trigger',
                count: multiSeasonTargets.length,
                landIds: multiSeasonTargets,
            });
            try {
                await runFertilizerByConfig(multiSeasonTargets, { reason: 'multi_season' });
            } catch (e) {
                logWarn('施肥', `多季补肥执行失败: ${e.message}`, {
                    module: 'farm',
                    event: '多季节施肥',
                    result: 'error',
                });
            }
        }
    }

    const shouldAutoUpgrade = opType === 'all' && isAutomationOn('land_upgrade');
    if (shouldAutoUpgrade || opType === 'upgrade') {
        if (status.unlockable.length > 0) {
            let unlocked = 0;
            for (const landId of status.unlockable) {
                try {
                    await unlockLand(landId, false);
                    log('解锁', `土地#${landId} 解锁成功`, {
                        module: 'farm', event: '解锁土地', result: 'ok', landId
                    });
                    unlocked++;
                } catch (e) {
                    logWarn('解锁', `土地#${landId} 解锁失败: ${e.message}`, {
                        module: 'farm', event: '解锁土地', result: 'error', landId
                    });
                }
                await randomDelay(1000, 1500);
            }
            if (unlocked > 0) {
                actions.push(`解锁${unlocked}`);
            }
        }

        if (status.upgradable.length > 0) {
            let upgraded = 0;
            for (const landId of status.upgradable) {
                try {
                    const reply = await upgradeLand(landId);
                    const newLevel = reply.land ? toNum(reply.land.level) : '?';
                    log('升级', `土地#${landId} 升级成功 → 等级${newLevel}`, {
                        module: 'farm', event: '升级土地', result: 'ok', landId, level: newLevel
                    });
                    upgraded++;
                } catch (e) {
                    log('升级', `土地#${landId} 升级失败: ${e.message}`, {
                        module: 'farm', event: '升级土地', result: 'error', landId
                    });
                }
                await randomDelay(1000, 1500);
            }
            if (upgraded > 0) {
                actions.push(`升级${upgraded}`);
                recordOperation('upgrade', upgraded);
            }
        }
    }

    if (opType === 'all') {
        const fertilizerConfig = getAutomation().fertilizer || 'none';
        if (fertilizerConfig === 'smart') {
            try {
                const result = await runFertilizerByConfig([], { skipNormal: true });
                if (result.organic > 0) {
                    actions.push(`有机肥${result.organic}`);
                }
            } catch (e) {
                logWarn('施肥', `巡田时施肥失败: ${e.message}`);
            }
        }
    }
    const actionStr = actions.length > 0 ? ` → ${actions.join('/')}` : '';
    if (actions.length > 0) {
         log('农场', `[${statusParts.join(' ')}]${actionStr}`, {
             module: 'farm', event: '农场循环', opType, actions
         });
    }
    return { hadWork: actions.length > 0, actions };
}

function scheduleNextFarmCheck(delayMs = CONFIG.farmCheckInterval) {
    if (externalSchedulerMode) return;
    if (!farmLoopRunning) return;
    farmScheduler.setTimeoutTask('farm_check_loop', Math.max(0, delayMs), async () => {
        if (!farmLoopRunning) return;
        await checkFarm();
        if (!farmLoopRunning) return;
        scheduleNextFarmCheck(CONFIG.farmCheckInterval);
    });
}

function startFarmCheckLoop(options = {}) {
    if (farmLoopRunning) return;
    externalSchedulerMode = !!options.externalScheduler;
    farmLoopRunning = true;
    networkEvents.on('landsChanged', onLandsChangedPush);
    if (!externalSchedulerMode) {
        scheduleNextFarmCheck(2000);
    }
    startFertilizerBuyCheckTimer();
}

let lastPushTime = 0;
function onLandsChangedPush(lands) {
    if (!isAutomationOn('farm_push')) {
        return;
    }
    if (isCheckingFarm) return;
    const now = Date.now();
    if (now - lastPushTime < 500) return;
    lastPushTime = now;
    log('农场', `收到推送: ${lands.length}块土地变化，检查中...`, {
        module: 'farm', event: '土地推送通知', result: 'trigger_check', count: lands.length
    });
    farmScheduler.setTimeoutTask('farm_push_check', 100, async () => {
        if (!isCheckingFarm) await checkFarm();
    });
}

function stopFarmCheckLoop() {
    farmLoopRunning = false;
    externalSchedulerMode = false;
    farmScheduler.clearAll();
    networkEvents.removeListener('landsChanged', onLandsChangedPush);
    stopFertilizerBuyCheckTimer();
}

function refreshFarmCheckLoop(delayMs = 200) {
    if (!farmLoopRunning) return;
    scheduleNextFarmCheck(delayMs);
}

// ============ 化肥自动购买定时检测 ============
function startFertilizerBuyCheckTimer() {
    if (fertilizerBuyCheckTimer) {
        clearInterval(fertilizerBuyCheckTimer);
    }
    
    if (!isAutomationOn('fertilizer_buy_organic') && !isAutomationOn('fertilizer_buy_normal')) {
        return;
    }
    
    const intervalMinutes = getFertilizerBuyCheckIntervalMinutes();
    const intervalMs = intervalMinutes * 60 * 1000;
    
    fertilizerBuyCheckTimer = setInterval(() => {
        checkFertilizerBuyOnce();
    }, intervalMs);
    
    log('农场', `化肥自动购买检测定时器已启动，间隔 ${intervalMinutes} 分钟`, {
        module: 'farm',
        event: '购买化肥计时器',
        result: 'start',
        intervalMinutes,
    });
}

function stopFertilizerBuyCheckTimer() {
    if (fertilizerBuyCheckTimer) {
        clearInterval(fertilizerBuyCheckTimer);
        fertilizerBuyCheckTimer = null;
    }
    log('农场', '化肥自动购买检测定时器已停止', {
        module: 'farm',
        event: '购买化肥计时器',
        result: 'stop',
    });
}

async function checkFertilizerBuyOnce() {
    if (!isAutomationOn('fertilizer_buy_organic') && !isAutomationOn('fertilizer_buy_normal')) {
        return;
    }
    
    try {
        const options = {
            buyOrganic: isAutomationOn('fertilizer_buy_organic'),
            buyNormal: isAutomationOn('fertilizer_buy_normal'),
            organicCount: getFertilizerBuyOrganicCount(),
            organicThresholdHours: getFertilizerBuyOrganicThresholdHours(),
            normalCount: getFertilizerBuyNormalCount(),
            normalThresholdHours: getFertilizerBuyNormalThresholdHours(),
        };

        await checkAndBuyFertilizerBoth(options);
    } catch (e) {
        logWarn('农场', `化肥自动购买检测失败: ${e.message}`, {
            module: 'farm',
            event: 'fertilizer_auto_buy',
            result: 'error',
            error: e.message,
        });
    }
}

module.exports = {
    checkFarm, startFarmCheckLoop, stopFarmCheckLoop,
    refreshFarmCheckLoop,
    getCurrentPhase,
    setOperationLimitsCallback,
    getAllLands,
    getLandsDetail,
    getAvailableSeeds,
    runFarmOperation,
    runFertilizerByConfig,
    buildLandMap,
    buildSlaveToMasterMap,
    getDisplayLandContext,
    isOccupiedSlaveLand,
};
