const { PlantPhase, PHASE_NAMES } = require('../config/config');
const {
    getPlantNameBySeedId,
    getPlantName,
    getPlantGrowTime,
    getAllSeeds,
    getPlantById,
    getSeedImageBySeedId,
    getMutantEffectsByIds,
} = require('../config/gameConfig');
const { getUserState, getWsErrorState } = require('../utils/network');
const { toNum, getServerTimeSec, toTimeSec, logWarn } = require('../utils/utils');
const { buildMutationDetail } = require('./farm-mutation');
const {
    getDisplayLandContext,
    summarizeLandDetails,
    getCurrentPhase,
    buildLandMap,
} = require('./farm-land-analyzer');
const { getAllLandsRaw, getShopInfo } = require('./farm-api');

function createFarmQueryService(options = {}) {
    const getAllLands = typeof options.getAllLands === 'function' ? options.getAllLands : getAllLandsRaw;
    const readShopInfo = typeof options.getShopInfo === 'function' ? options.getShopInfo : getShopInfo;
    const getState = typeof options.getUserState === 'function' ? options.getUserState : getUserState;
    const getWsError = typeof options.getWsErrorState === 'function' ? options.getWsErrorState : getWsErrorState;
    const warn = typeof options.logWarn === 'function' ? options.logWarn : logWarn;
    const readAllSeeds = typeof options.getAllSeeds === 'function' ? options.getAllSeeds : getAllSeeds;
    const readPlantNameBySeedId = typeof options.getPlantNameBySeedId === 'function' ? options.getPlantNameBySeedId : getPlantNameBySeedId;
    const readPlantName = typeof options.getPlantName === 'function' ? options.getPlantName : getPlantName;
    const readPlantGrowTime = typeof options.getPlantGrowTime === 'function' ? options.getPlantGrowTime : getPlantGrowTime;
    const readPlantById = typeof options.getPlantById === 'function' ? options.getPlantById : getPlantById;
    const readSeedImage = typeof options.getSeedImageBySeedId === 'function' ? options.getSeedImageBySeedId : getSeedImageBySeedId;
    const readMutantEffects = typeof options.getMutantEffectsByIds === 'function' ? options.getMutantEffectsByIds : getMutantEffectsByIds;
    const nowSec = typeof options.getServerTimeSec === 'function' ? options.getServerTimeSec : getServerTimeSec;

    async function getAvailableSeeds() {
        const SEED_SHOP_ID = 2;
        const state = getState();
        let list = [];

        try {
            const shopReply = await readShopInfo(SEED_SHOP_ID);
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
                        name: readPlantNameBySeedId(toNum(goods.item_id)),
                        price: toNum(goods.price),
                        requiredLevel,
                        locked: !goods.unlocked || state.level < requiredLevel,
                        soldOut: isSoldOut,
                    });
                }
            }
        } catch (error) {
            const wsErr = getWsError();
            if (!wsErr || Number(wsErr.code) !== 400) {
                warn('商店', `获取商店失败: ${error.message}，使用本地备选列表`);
            }
        }

        if (list.length === 0) {
            const allSeeds = readAllSeeds();
            list = allSeeds.map(seed => ({
                ...seed,
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
            const now = nowSec();
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
                const plantName = readPlantName(plantId) || plant.name || '未知';
                const plantCfg = readPlantById(plantId);
                const seedId = toNum(plantCfg && plantCfg.seed_id);
                const seedImage = seedId > 0 ? readSeedImage(seedId) : '';
                const plantSize = Math.max(1, toNum(plantCfg && plantCfg.size) || 1);
                const totalSeason = Math.max(1, toNum(plantCfg && plantCfg.seasons) || 1);
                const currentSeasonRaw = toNum(plant.season);
                const currentSeason = currentSeasonRaw > 0 ? Math.min(currentSeasonRaw, totalSeason) : 1;
                const phaseName = PHASE_NAMES[phaseVal] || '';
                const maturePhase = Array.isArray(plant.phases)
                    ? plant.phases.find((phase) => phase && toNum(phase.phase) === PlantPhase.MATURE)
                    : null;
                const matureBegin = maturePhase ? toTimeSec(maturePhase.begin_time) : 0;
                const matureInSec = matureBegin > now ? (matureBegin - now) : 0;
                const totalGrowTime = readPlantGrowTime(plantId);

                let landStatus = 'growing';
                if (phaseVal === PlantPhase.MATURE) landStatus = 'harvestable';
                else if (phaseVal === PlantPhase.DEAD) landStatus = 'dead';
                else if (phaseVal === PlantPhase.UNKNOWN || !plant.phases.length) landStatus = 'empty';

                const needWater = (toNum(plant.dry_num) > 0) || (toTimeSec(currentPhase.dry_time) > 0 && toTimeSec(currentPhase.dry_time) <= now);
                const needWeed = (plant.weed_owners && plant.weed_owners.length > 0) || (toTimeSec(currentPhase.weeds_time) > 0 && toTimeSec(currentPhase.weeds_time) <= now);
                const needBug = (plant.insect_owners && plant.insect_owners.length > 0) || (toTimeSec(currentPhase.insect_time) > 0 && toTimeSec(currentPhase.insect_time) <= now);
                const mutation = occupiedByMaster
                    ? { active: false, configIds: [], effects: [], unknownConfigIds: [], events: [] }
                    : buildMutationDetail(plant, currentPhase, readMutantEffects);

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

    return {
        getAvailableSeeds,
        getLandsDetail,
    };
}

module.exports = {
    createFarmQueryService,
};
