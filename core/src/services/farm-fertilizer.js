const { PlantPhase } = require('../config/config');
const { getAutomation } = require('../models/store');
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum, getServerTimeSec, toTimeSec, log, logWarn, sleep, randomDelay } = require('../utils/utils');
const { getLandTypeByLevel, getCurrentPhase } = require('./farm-land-analyzer');
const { getAllLandsRaw } = require('./farm-api');
const { recordOperation } = require('./stats');

const NORMAL_FERTILIZER_ID = 1011;
const ORGANIC_FERTILIZER_ID = 1012;
const LEGACY_ALL_FERTILIZER_LAND_TYPES = ['gold', 'black', 'red', 'normal'];
const ALL_FERTILIZER_LAND_TYPES = ['purple', ...LEGACY_ALL_FERTILIZER_LAND_TYPES];
const FERTILIZER_LAND_TYPE_LABELS = {
    purple: '紫土地',
    gold: '金土地',
    black: '黑土地',
    red: '红土地',
    normal: '普通土地',
};

function normalizeFertilizerLandTypes(input) {
    const source = Array.isArray(input) ? input : ALL_FERTILIZER_LAND_TYPES;
    const result = [];
    for (const item of source) {
        const value = String(item || '').trim().toLowerCase();
        if (!ALL_FERTILIZER_LAND_TYPES.includes(value)) continue;
        if (result.includes(value)) continue;
        result.push(value);
    }

    const isLegacyAllSelected = LEGACY_ALL_FERTILIZER_LAND_TYPES.every(type => result.includes(type))
        && result.length === LEGACY_ALL_FERTILIZER_LAND_TYPES.length;
    if (isLegacyAllSelected) result.unshift('purple');

    return result;
}

function filterLandIdsByTypes(landIds, landTypeById, selectedTypes) {
    const ids = Array.isArray(landIds) ? landIds : [];
    const selected = new Set(normalizeFertilizerLandTypes(selectedTypes));
    if (selected.size === 0) return [];
    if (selected.size === ALL_FERTILIZER_LAND_TYPES.length) return [...ids];

    const filtered = [];
    for (const id of ids) {
        const type = String(landTypeById.get(id) || '');
        if (!type) continue;
        if (selected.has(type)) filtered.push(id);
    }
    return filtered;
}

function formatFertilizerLandTypes(input) {
    return normalizeFertilizerLandTypes(input).map(type => FERTILIZER_LAND_TYPE_LABELS[type] || type);
}

function getOrganicFertilizerTargetsFromLands(lands) {
    const list = Array.isArray(lands) ? lands : [];
    const targets = [];
    for (const land of list) {
        if (!land || !land.unlocked) continue;
        const landId = toNum(land.id);
        if (!landId) continue;

        const plant = land.plant;
        if (!plant || !plant.phases || plant.phases.length === 0) continue;
        const currentPhase = getCurrentPhase(plant.phases);
        if (!currentPhase) continue;
        if (currentPhase.phase === PlantPhase.DEAD) continue;

        if (Object.prototype.hasOwnProperty.call(plant, 'left_inorc_fert_times')) {
            const leftTimes = toNum(plant.left_inorc_fert_times);
            if (leftTimes <= 0) continue;
        }

        targets.push(landId);
    }
    return targets;
}

function getFastMatureLands(lands, thresholdSec = 300, nowSec = getServerTimeSec()) {
    const list = Array.isArray(lands) ? lands : [];
    const targets = [];
    const threshold = Math.max(0, toNum(thresholdSec) || 300);

    for (const land of list) {
        if (!land || !land.unlocked) continue;
        const landId = toNum(land.id);
        if (!landId) continue;

        const plant = land.plant;
        if (!plant || !plant.phases || plant.phases.length === 0) continue;
        const currentPhase = getCurrentPhase(plant.phases);
        if (!currentPhase) continue;
        if (currentPhase.phase === PlantPhase.DEAD) continue;
        if (currentPhase.phase === PlantPhase.MATURE) continue;

        const maturePhase = plant.phases.find(p => toNum(p.phase) === PlantPhase.MATURE);
        if (!maturePhase) continue;

        const matureBeginTime = toTimeSec(maturePhase.begin_time);
        if (matureBeginTime <= 0) continue;

        const timeToMature = matureBeginTime - nowSec;
        if (timeToMature <= threshold && timeToMature >= 0) {
            if (Object.prototype.hasOwnProperty.call(plant, 'left_inorc_fert_times')) {
                const leftTimes = toNum(plant.left_inorc_fert_times);
                if (leftTimes <= 0) continue;
            }
            targets.push(landId);
        }
    }
    return targets;
}

function createFarmFertilizerService(options = {}) {
    const send = typeof options.send === 'function' ? options.send : sendMsgAsync;
    const protoTypes = options.types || types;
    const getAllLands = typeof options.getAllLands === 'function' ? options.getAllLands : getAllLandsRaw;
    const getAutomationConfig = typeof options.getAutomation === 'function' ? options.getAutomation : getAutomation;
    const record = typeof options.recordOperation === 'function' ? options.recordOperation : recordOperation;
    const logInfo = typeof options.log === 'function' ? options.log : log;
    const logWarning = typeof options.logWarn === 'function' ? options.logWarn : logWarn;
    const wait = typeof options.sleep === 'function' ? options.sleep : sleep;
    const waitRandom = typeof options.randomDelay === 'function' ? options.randomDelay : randomDelay;
    const toLongValue = typeof options.toLong === 'function' ? options.toLong : toLong;

    async function fertilize(landIds, fertilizerId = NORMAL_FERTILIZER_ID) {
        let successCount = 0;
        for (const landId of landIds) {
            try {
                const body = protoTypes.FertilizeRequest.encode(protoTypes.FertilizeRequest.create({
                    land_ids: [toLongValue(landId)],
                    fertilizer_id: toLongValue(fertilizerId),
                })).finish();
                await send('gamepb.plantpb.PlantService', 'Fertilize', body);
                successCount++;
            } catch {
                break;
            }
            if (landIds.length > 1) await wait(50);
        }
        return successCount;
    }

    async function fertilizeOrganicLoop(landIds) {
        const ids = (Array.isArray(landIds) ? landIds : []).filter(Boolean);
        if (ids.length === 0) return 0;

        let successCount = 0;
        let idx = 0;
        while (true) {
            const landId = ids[idx];
            try {
                const body = protoTypes.FertilizeRequest.encode(protoTypes.FertilizeRequest.create({
                    land_ids: [toLongValue(landId)],
                    fertilizer_id: toLongValue(ORGANIC_FERTILIZER_ID),
                })).finish();
                await send('gamepb.plantpb.PlantService', 'Fertilize', body);
                successCount++;
            } catch {
                break;
            }

            idx = (idx + 1) % ids.length;
            await waitRandom(1000, 1500);
        }
        return successCount;
    }

    async function runFertilizerByConfig(plantedLands = [], runOptions = {}) {
        const automation = getAutomationConfig() || {};
        const fertilizerConfig = automation.fertilizer || 'none';
        const reason = String(runOptions.reason || '').trim().toLowerCase() === 'multi_season' ? 'multi_season' : 'normal';
        const reasonLabel = reason === 'multi_season' ? '多季补肥' : '常规施肥';
        const eventName = reason === 'multi_season' ? '多季节施肥' : '常规施肥';
        const selectedLandTypes = normalizeFertilizerLandTypes(automation.fertilizer_land_types);
        const selectedLandTypeNames = formatFertilizerLandTypes(selectedLandTypes);
        const planted = [...new Set((Array.isArray(plantedLands) ? plantedLands : []).map(v => toNum(v)).filter(Boolean))];

        if (selectedLandTypes.length === 0) {
            logInfo('施肥', `${reasonLabel}：未勾选施肥范围，跳过本轮施肥`, {
                module: 'farm', event: eventName, result: 'skip', reason, scope: 'none',
            });
            return { normal: 0, organic: 0 };
        }

        const { skipNormal = false } = runOptions;
        if (planted.length === 0 && fertilizerConfig !== 'organic' && fertilizerConfig !== 'both' && fertilizerConfig !== 'smart') {
            return { normal: 0, organic: 0 };
        }

        let latestLands = [];
        const landTypeById = new Map();
        try {
            const latest = await getAllLands();
            latestLands = Array.isArray(latest && latest.lands) ? latest.lands : [];
            for (const land of latestLands) {
                if (!land) continue;
                const landId = toNum(land.id);
                if (!landId) continue;
                landTypeById.set(landId, getLandTypeByLevel(land.level));
            }
        } catch (e) {
            logWarning('施肥', `${reasonLabel}：获取土地信息失败，按已知地块继续: ${e.message}`, {
                module: 'farm', event: eventName, result: 'error', reason,
            });
        }

        const isAllLandTypesSelected = selectedLandTypes.length === ALL_FERTILIZER_LAND_TYPES.length;
        if (landTypeById.size === 0 && !isAllLandTypesSelected) {
            logWarning('施肥', `${reasonLabel}：无法确认土地类型，已跳过本轮施肥`, {
                module: 'farm', event: eventName, result: 'skip', reason, landTypes: selectedLandTypes,
            });
            return { normal: 0, organic: 0 };
        }

        let normalTargets = planted;
        if (landTypeById.size > 0) {
            normalTargets = filterLandIdsByTypes(planted, landTypeById, selectedLandTypes);
        }

        let fertilizedNormal = 0;
        let fertilizedOrganic = 0;

        if (!skipNormal && (fertilizerConfig === 'normal' || fertilizerConfig === 'both' || fertilizerConfig === 'smart') && normalTargets.length > 0) {
            fertilizedNormal = await fertilize(normalTargets, NORMAL_FERTILIZER_ID);
            if (fertilizedNormal > 0) {
                logInfo('施肥', `${reasonLabel}：已为 ${fertilizedNormal}/${normalTargets.length} 块地施普通化肥（范围: ${selectedLandTypeNames.join('、')}）`, {
                    module: 'farm', event: eventName, result: 'ok', reason, type: 'normal',
                    count: fertilizedNormal, landTypes: selectedLandTypes,
                });
                record('fertilize', fertilizedNormal);
            }
        }

        if (fertilizerConfig === 'organic' || fertilizerConfig === 'both') {
            let organicTargets = planted;
            if (latestLands.length > 0) {
                organicTargets = getOrganicFertilizerTargetsFromLands(latestLands);
            }
            if (landTypeById.size > 0) {
                organicTargets = filterLandIdsByTypes(organicTargets, landTypeById, selectedLandTypes);
            }

            fertilizedOrganic = await fertilizeOrganicLoop(organicTargets);
            if (fertilizedOrganic > 0) {
                logInfo('施肥', `${reasonLabel}：有机化肥循环施肥完成，共施 ${fertilizedOrganic} 次（范围: ${selectedLandTypeNames.join('、')}）`, {
                    module: 'farm', event: eventName, result: 'ok', reason, type: 'organic',
                    count: fertilizedOrganic, landTypes: selectedLandTypes,
                });
                record('fertilize', fertilizedOrganic);
            }
        }
        else if (fertilizerConfig === 'smart') {
            let organicTargets = [];
            const smartSeconds = toNum(automation.fertilizer_smart_seconds) || 300;
            try {
                const latest = await getAllLands();
                organicTargets = getFastMatureLands(latest && latest.lands, smartSeconds);
            } catch (e) {
                logWarning('施肥', `获取全农场地块失败: ${e.message}`);
            }

            // 保留当前生产语义：smart 分支此处暂不追加 selectedLandTypes 二次过滤。
            if (organicTargets.length > 0) {
                fertilizedOrganic = await fertilizeOrganicLoop(organicTargets);
                if (fertilizedOrganic > 0) {
                    logInfo('施肥', `有机化肥循环施肥完成，共施 ${fertilizedOrganic} 次`, {
                        module: 'farm', event: '施肥', result: 'ok', type: 'organic', count: fertilizedOrganic,
                    });
                    record('fertilize', fertilizedOrganic);
                }
            }
        }

        return { normal: fertilizedNormal, organic: fertilizedOrganic };
    }

    return {
        fertilize,
        fertilizeOrganicLoop,
        runFertilizerByConfig,
    };
}

module.exports = {
    NORMAL_FERTILIZER_ID,
    ORGANIC_FERTILIZER_ID,
    LEGACY_ALL_FERTILIZER_LAND_TYPES,
    ALL_FERTILIZER_LAND_TYPES,
    FERTILIZER_LAND_TYPE_LABELS,
    normalizeFertilizerLandTypes,
    filterLandIdsByTypes,
    formatFertilizerLandTypes,
    getOrganicFertilizerTargetsFromLands,
    getFastMatureLands,
    createFarmFertilizerService,
};
