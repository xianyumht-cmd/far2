const { PlantPhase } = require('../config/config');
const { getPlantName, getPlantExp } = require('../config/gameConfig');
const {
    isAutomationOn,
    getAutomation,
    getPlantingStrategy,
    getPrioritize2x2Crops,
    getBagSeedPriority,
    getBagSeedFallbackStrategy,
} = require('../models/store');
const { getUserState, networkEvents } = require('../utils/network');
const { toNum, getServerTimeSec, toTimeSec, log, logWarn, sleep, randomDelay } = require('../utils/utils');
const { recordOperation } = require('./stats');
const { getBagSeeds } = require('./warehouse');
const { runPrioritized2x2Prepass } = require('./farm-2x2-priority');
const {
    isOccupiedSlaveLand,
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
} = require('./farm-api');
const { createFarmFertilizerService } = require('./farm-fertilizer');
const {
    createPlantingService,
    getPlantingStrategyLabel,
} = require('./planting-service');

function createFarmOrchestrator(options = {}) {
    const getAllLands = typeof options.getAllLands === 'function' ? options.getAllLands : getAllLandsRaw;
    const getState = typeof options.getUserState === 'function' ? options.getUserState : getUserState;
    const automationOn = typeof options.isAutomationOn === 'function' ? options.isAutomationOn : isAutomationOn;
    const getAutomationConfig = typeof options.getAutomation === 'function' ? options.getAutomation : getAutomation;
    const getStrategy = typeof options.getPlantingStrategy === 'function' ? options.getPlantingStrategy : getPlantingStrategy;
    const prioritize2x2 = typeof options.getPrioritize2x2Crops === 'function' ? options.getPrioritize2x2Crops : getPrioritize2x2Crops;
    const getBagPriority = typeof options.getBagSeedPriority === 'function' ? options.getBagSeedPriority : getBagSeedPriority;
    const getBagFallback = typeof options.getBagSeedFallbackStrategy === 'function' ? options.getBagSeedFallbackStrategy : getBagSeedFallbackStrategy;
    const readBagSeeds = typeof options.getBagSeeds === 'function' ? options.getBagSeeds : getBagSeeds;
    const prepass2x2 = typeof options.runPrioritized2x2Prepass === 'function' ? options.runPrioritized2x2Prepass : runPrioritized2x2Prepass;
    const plant2x2 = typeof options.plant2x2Seed === 'function' ? options.plant2x2Seed : createPlantingService({ getAllLands }).plant2x2Seed;
    const plantFromBag = typeof options.plantFromBagSeeds === 'function' ? options.plantFromBagSeeds : createPlantingService({ getAllLands }).plantFromBagSeeds;
    const plantFromShop = typeof options.plantFromShop === 'function' ? options.plantFromShop : createPlantingService({ getAllLands }).plantFromShop;
    const strategyLabel = typeof options.getPlantingStrategyLabel === 'function' ? options.getPlantingStrategyLabel : getPlantingStrategyLabel;
    const runFertilizer = typeof options.runFertilizerByConfig === 'function'
        ? options.runFertilizerByConfig
        : createFarmFertilizerService({ getAllLands }).runFertilizerByConfig;
    const doHarvest = typeof options.harvest === 'function' ? options.harvest : harvest;
    const doWater = typeof options.waterLand === 'function' ? options.waterLand : waterLand;
    const doWeed = typeof options.weedOut === 'function' ? options.weedOut : weedOut;
    const doBug = typeof options.insecticide === 'function' ? options.insecticide : insecticide;
    const doRemove = typeof options.removePlant === 'function' ? options.removePlant : removePlant;
    const doUpgrade = typeof options.upgradeLand === 'function' ? options.upgradeLand : upgradeLand;
    const doUnlock = typeof options.unlockLand === 'function' ? options.unlockLand : unlockLand;
    const record = typeof options.recordOperation === 'function' ? options.recordOperation : recordOperation;
    const events = options.networkEvents || networkEvents;
    const logInfo = typeof options.log === 'function' ? options.log : log;
    const logWarning = typeof options.logWarn === 'function' ? options.logWarn : logWarn;
    const wait = typeof options.sleep === 'function' ? options.sleep : sleep;
    const waitRandom = typeof options.randomDelay === 'function' ? options.randomDelay : randomDelay;
    const plantName = typeof options.getPlantName === 'function' ? options.getPlantName : getPlantName;
    const plantExp = typeof options.getPlantExp === 'function' ? options.getPlantExp : getPlantExp;
    const nowSec = typeof options.getServerTimeSec === 'function' ? options.getServerTimeSec : getServerTimeSec;

    let isCheckingFarm = false;
    let isFirstFarmCheck = true;

    function isChecking() {
        return isCheckingFarm;
    }

    function analyzeLands(lands) {
        const result = {
            harvestable: [], needWater: [], needWeed: [], needBug: [],
            growing: [], empty: [], dead: [], unlockable: [], upgradable: [],
            harvestableInfo: [],
        };

        const now = nowSec();
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

            const rawPlantName = plant.name || '未知作物';
            const landLabel = `土地#${id}(${rawPlantName})`;
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
                const plantNameFromConfig = plantName(plantId);
                const exp = plantExp(plantId);
                result.harvestableInfo.push({
                    landId: id,
                    plantId,
                    name: plantNameFromConfig || rawPlantName,
                    exp,
                });
                continue;
            }

            const dryNum = toNum(plant.dry_num);
            const dryTime = toTimeSec(currentPhase.dry_time);
            if (dryNum > 0 || (dryTime > 0 && dryTime <= now)) {
                result.needWater.push(id);
            }

            const weedsTime = toTimeSec(currentPhase.weeds_time);
            const hasWeeds = (plant.weed_owners && plant.weed_owners.length > 0) || (weedsTime > 0 && weedsTime <= now);
            if (hasWeeds) {
                result.needWeed.push(id);
            }

            const insectTime = toTimeSec(currentPhase.insect_time);
            const hasBugs = (plant.insect_owners && plant.insect_owners.length > 0) || (insectTime > 0 && insectTime <= now);
            if (hasBugs) {
                result.needBug.push(id);
            }

            result.growing.push(id);
        }

        return result;
    }

    async function autoPlantEmptyLands(deadLandIds, emptyLandIds) {
        let landsToPlant = [...emptyLandIds];
        const state = getState();

        if (deadLandIds.length > 0) {
            try {
                await doRemove(deadLandIds);
                logInfo('铲除', `已铲除 ${deadLandIds.length} 块 (${deadLandIds.join(',')})`, {
                    module: 'farm', event: '铲除植物', result: 'ok', count: deadLandIds.length,
                });
                landsToPlant.push(...deadLandIds);
            } catch (error) {
                logWarning('铲除', `批量铲除失败: ${error.message}`, {
                    module: 'farm', event: '铲除植物', result: 'error',
                });
                landsToPlant.push(...deadLandIds);
            }
        }

        if (landsToPlant.length === 0) return;

        landsToPlant = [...new Set(landsToPlant.map(id => toNum(id)).filter(Boolean))];
        if (landsToPlant.length === 0) return;

        try {
            const twoByTwo = await prepass2x2({
                enabled: prioritize2x2(),
                landIds: landsToPlant,
                getBagSeeds: readBagSeeds,
                bagSeedPriority: getBagPriority(),
                userLevel: Number(state.level || 0),
                getAllLands,
                plant2x2Seed: plant2x2,
                log: logInfo,
                logWarn: logWarning,
                sleep: wait,
            });
            landsToPlant = twoByTwo.remainingLandIds || landsToPlant;
            if (twoByTwo.plantedLandIds && twoByTwo.plantedLandIds.length > 0) {
                await runFertilizer(twoByTwo.plantedLandIds);
            }
        } catch (error) {
            logWarning('种植', `2x2 优先链异常，继续原种植策略: ${error.message}`, {
                module: 'farm', event: '种植2x2作物', result: 'prepass_error',
            });
        }

        if (landsToPlant.length === 0) return;

        const accountStrategy = String(getStrategy() || '').trim();

        if (accountStrategy === 'bag_priority') {
            let bagResult;
            try {
                bagResult = await plantFromBag(landsToPlant);
            } catch (error) {
                logWarning('种植', `读取背包种子失败，本轮跳过第二优先策略以避免误购: ${error.message}`, {
                    module: 'farm', event: '种植种子', result: 'bag_load_error',
                });
                return { plantedLands: [] };
            }

            const plantedLands = bagResult.plantedLandIds || [];
            if (bagResult.fallbackAllowed && bagResult.remainingLandIds.length > 0) {
                const fallbackStrategy = getBagFallback() || 'level';
                logInfo('种植', `开始按第二优先策略"${strategyLabel(fallbackStrategy)}"补种剩余空地`, {
                    module: 'farm', event: '种植种子', result: 'fallback_start', strategy: fallbackStrategy,
                    remainingCount: bagResult.remainingLandIds.length,
                });
                const shopResult = await plantFromShop(bagResult.remainingLandIds, state, fallbackStrategy);
                plantedLands.push(...(shopResult.plantedLands || []));
            }

            if (plantedLands.length > 0) {
                await runFertilizer(plantedLands);
            }
            return;
        }

        const shopResult = await plantFromShop(landsToPlant, state);
        if (shopResult.plantedLands && shopResult.plantedLands.length > 0) {
            await runFertilizer(shopResult.plantedLands);
        }
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
            } catch (error) {
                logWarning('农场', `收后状态补拉失败: ${error.message}`, {
                    module: 'farm', event: '收获后状态补拉', result: 'error',
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

    async function runFarmOperation(opType) {
        const landsReply = await getAllLands();
        if (!landsReply.lands || landsReply.lands.length === 0) {
            if (opType !== 'all') {
                logInfo('农场', '没有土地数据');
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
            const skipOwnWeedBug = opType === 'all' && automationOn('skip_own_weed_bug');
            if (status.needWeed.length > 0 && !skipOwnWeedBug) {
                try {
                    await doWeed(status.needWeed);
                    actions.push(`除草${status.needWeed.length}`);
                    record('weed', status.needWeed.length);
                } catch (error) {
                    logWarning('除草', error.message);
                }
            }
            if (status.needBug.length > 0 && !skipOwnWeedBug) {
                try {
                    await doBug(status.needBug);
                    actions.push(`除虫${status.needBug.length}`);
                    record('bug', status.needBug.length);
                } catch (error) {
                    logWarning('除虫', error.message);
                }
            }
            if (status.needWater.length > 0) {
                try {
                    await doWater(status.needWater);
                    actions.push(`浇水${status.needWater.length}`);
                    record('water', status.needWater.length);
                } catch (error) {
                    logWarning('浇水', error.message);
                }
            }
        }

        let harvestedLandIds = [];
        let harvestReply = null;
        let postHarvest = null;
        if (opType === 'all' || opType === 'harvest') {
            if (status.harvestable.length > 0) {
                try {
                    harvestReply = await doHarvest(status.harvestable);
                    logInfo('收获', `收获完成 ${status.harvestable.length} 块土地`, {
                        module: 'farm', event: '收获作物', result: 'ok', count: status.harvestable.length,
                        landIds: [...status.harvestable],
                    });
                    actions.push(`收获${status.harvestable.length}`);
                    record('harvest', status.harvestable.length);
                    harvestedLandIds = [...status.harvestable];
                    events.emit('farmHarvested', {
                        count: status.harvestable.length,
                        landIds: [...status.harvestable],
                        opType,
                    });
                } catch (error) {
                    logWarning('收获', error.message, {
                        module: 'farm', event: '收获作物', result: 'error',
                    });
                }
            }
        }

        if (opType === 'all' || opType === 'plant') {
            const allEmptyLands = [...new Set(status.empty)];
            let allDeadLands = [...new Set(status.dead)];

            if (opType === 'all' && harvestedLandIds.length > 0) {
                await waitRandom(1000, 1500);
                postHarvest = await resolveRemovableHarvestedLands(harvestedLandIds, harvestReply);
                allDeadLands = [...new Set([...allDeadLands, ...postHarvest.removable])];
            }
            if (allDeadLands.length > 0 || allEmptyLands.length > 0) {
                try {
                    const plantCount = allDeadLands.length + allEmptyLands.length;
                    await autoPlantEmptyLands(allDeadLands, allEmptyLands);
                    actions.push(`种植${plantCount}`);
                    record('plant', plantCount);
                } catch (error) {
                    logWarning('种植', error.message);
                }
            }
        }

        if (opType === 'all' && postHarvest && Array.isArray(postHarvest.growing) && postHarvest.growing.length > 0 && automationOn('fertilizer_multi_season')) {
            const multiSeasonTargets = [...new Set(postHarvest.growing.map(value => toNum(value)).filter(Boolean))];
            if (multiSeasonTargets.length > 0) {
                logInfo('施肥', `检测到多季作物进入后续季，准备执行多季补肥，目标地块 ${multiSeasonTargets.length} 块`, {
                    module: 'farm', event: '多季节施肥', result: 'trigger', count: multiSeasonTargets.length,
                    landIds: multiSeasonTargets,
                });
                try {
                    await runFertilizer(multiSeasonTargets, { reason: 'multi_season' });
                } catch (error) {
                    logWarning('施肥', `多季补肥执行失败: ${error.message}`, {
                        module: 'farm', event: '多季节施肥', result: 'error',
                    });
                }
            }
        }

        const shouldAutoUpgrade = opType === 'all' && automationOn('land_upgrade');
        if (shouldAutoUpgrade || opType === 'upgrade') {
            if (status.unlockable.length > 0) {
                let unlocked = 0;
                for (const landId of status.unlockable) {
                    try {
                        await doUnlock(landId, false);
                        logInfo('解锁', `土地#${landId} 解锁成功`, {
                            module: 'farm', event: '解锁土地', result: 'ok', landId,
                        });
                        unlocked++;
                    } catch (error) {
                        logWarning('解锁', `土地#${landId} 解锁失败: ${error.message}`, {
                            module: 'farm', event: '解锁土地', result: 'error', landId,
                        });
                    }
                    await waitRandom(1000, 1500);
                }
                if (unlocked > 0) {
                    actions.push(`解锁${unlocked}`);
                }
            }

            if (status.upgradable.length > 0) {
                let upgraded = 0;
                for (const landId of status.upgradable) {
                    try {
                        const reply = await doUpgrade(landId);
                        const newLevel = reply.land ? toNum(reply.land.level) : '?';
                        logInfo('升级', `土地#${landId} 升级成功 → 等级${newLevel}`, {
                            module: 'farm', event: '升级土地', result: 'ok', landId, level: newLevel,
                        });
                        upgraded++;
                    } catch (error) {
                        logInfo('升级', `土地#${landId} 升级失败: ${error.message}`, {
                            module: 'farm', event: '升级土地', result: 'error', landId,
                        });
                    }
                    await waitRandom(1000, 1500);
                }
                if (upgraded > 0) {
                    actions.push(`升级${upgraded}`);
                    record('upgrade', upgraded);
                }
            }
        }

        if (opType === 'all') {
            const fertilizerConfig = getAutomationConfig().fertilizer || 'none';
            if (fertilizerConfig === 'smart') {
                try {
                    const result = await runFertilizer([], { skipNormal: true });
                    if (result.organic > 0) {
                        actions.push(`有机肥${result.organic}`);
                    }
                } catch (error) {
                    logWarning('施肥', `巡田时施肥失败: ${error.message}`);
                }
            }
        }

        const actionStr = actions.length > 0 ? ` → ${actions.join('/')}` : '';
        if (actions.length > 0) {
            logInfo('农场', `[${statusParts.join(' ')}]${actionStr}`, {
                module: 'farm', event: '农场循环', opType, actions,
            });
        }
        return { hadWork: actions.length > 0, actions };
    }

    async function checkFarm() {
        const state = getState();
        if (isCheckingFarm || !state.gid || !automationOn('farm')) return false;
        isCheckingFarm = true;

        try {
            const result = await runFarmOperation('all');
            isFirstFarmCheck = false;
            return !!(result && result.hadWork);
        } catch (error) {
            logWarning('巡田', `检查失败: ${error.message}`);
            return false;
        } finally {
            isCheckingFarm = false;
        }
    }

    return {
        isChecking,
        analyzeLands,
        autoPlantEmptyLands,
        resolveRemovableHarvestedLands,
        runFarmOperation,
        checkFarm,
    };
}

module.exports = {
    createFarmOrchestrator,
};
