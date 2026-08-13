/**
 * 自己的农场操作 - 收获/浇水/除草/除虫/铲除/种植/商店/巡田
 */

const { PlantPhase, PHASE_NAMES } = require('../config/config');
const { getPlantNameBySeedId, getPlantName, getPlantGrowTime, getAllSeeds, getPlantById, getSeedImageBySeedId, getMutantEffectsByIds } = require('../config/gameConfig');
const { getUserState, getWsErrorState } = require('../utils/network');
const { toNum, getServerTimeSec, toTimeSec, logWarn } = require('../utils/utils');
const { getBag, getBagItems, getContainerHoursFromBagItems } = require('./warehouse');
const { buildMutationDetail } = require('./farm-mutation');
const {
    getDisplayLandContext,
    isOccupiedSlaveLand,
    buildSlaveToMasterMap,
    summarizeLandDetails,
    getCurrentPhase,
    buildLandMap,
} = require('./farm-land-analyzer');
const {
    getAllLandsRaw,
    getShopInfo,
} = require('./farm-api');
const { createFarmFertilizerService } = require('./farm-fertilizer');
const { createPlantingService } = require('./planting-service');
const { createFarmOrchestrator } = require('./farm-orchestrator');
const { createFarmSchedulerService } = require('./farm-scheduler');

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

const {
    checkFarm,
    runFarmOperation,
    isChecking: isFarmCheckInProgress,
} = createFarmOrchestrator({
    // 所有补拉继续通过 facade wrapper，保持 operation-limit callback 语义。
    getAllLands,
    runFertilizerByConfig,
    plant2x2Seed,
    plantFromBagSeeds,
    plantFromShop,
});

const {
    startFarmCheckLoop,
    stopFarmCheckLoop,
    refreshFarmCheckLoop,
} = createFarmSchedulerService({
    checkFarm,
    isChecking: isFarmCheckInProgress,
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

// ============ 巡田业务编排：由 farm-orchestrator.js 提供 ============

// ============ 巡田调度：由 farm-scheduler.js 提供 ============

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
