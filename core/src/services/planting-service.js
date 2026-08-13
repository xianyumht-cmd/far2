const protobuf = require('protobufjs');
const {
    getPlantNameBySeedId,
    formatGrowTime,
    getPlantGrowTime,
    getPlantBySeedId,
} = require('../config/gameConfig');
const {
    getPreferredSeed,
    getPlantingStrategy,
    getBagSeedPriority,
} = require('../models/store');
const { sendMsgAsync, getUserState } = require('../utils/network');
const { types } = require('../utils/proto');
const { toNum, log, logWarn, sleep } = require('../utils/utils');
const { getPlantRankings } = require('./analytics');
const { getBagSeeds } = require('./warehouse');
const { selectReady2x2Groups, validate2x2PlantReply } = require('./farm-2x2');
const { buildLandMap, getDisplayLandContext } = require('./farm-land-analyzer');
const { getAllLandsRaw, getShopInfo, buyGoods } = require('./farm-api');

const PLANT_SERVICE = 'gamepb.plantpb.PlantService';

function encodePlantRequest(seedId, landIds) {
    const writer = protobuf.Writer.create();
    const itemWriter = writer.uint32(18).fork();
    itemWriter.uint32(8).int64(seedId);
    const idsWriter = itemWriter.uint32(18).fork();
    for (const id of landIds) {
        idsWriter.int64(id);
    }
    idsWriter.ldelim();
    itemWriter.ldelim();
    return writer.finish();
}

const PLANTING_STRATEGY_LABELS = {
    preferred: '优先种植种子',
    level: '最高等级作物',
    max_exp: '最大经验/时',
    max_fert_exp: '最大普通肥经验/时',
    max_profit: '最大净利润/时',
    max_fert_profit: '最大普通肥净利润/时',
    bag_priority: '背包种子优先',
};

function getPlantingStrategyLabel(strategy) {
    return PLANTING_STRATEGY_LABELS[strategy] || strategy;
}

function sortBagSeedsForPlanting(bagSeeds, priorityList) {
    const indexMap = new Map();
    const priority = Array.isArray(priorityList) ? priorityList : [];
    priority.forEach((seedId, index) => {
        const id = Number(seedId);
        if (id > 0) indexMap.set(id, index);
    });

    return [...(Array.isArray(bagSeeds) ? bagSeeds : [])].sort((a, b) => {
        const aIndex = indexMap.has(a.seedId) ? indexMap.get(a.seedId) : Number.MAX_SAFE_INTEGER;
        const bIndex = indexMap.has(b.seedId) ? indexMap.get(b.seedId) : Number.MAX_SAFE_INTEGER;
        if (aIndex !== bIndex) return aIndex - bIndex;

        const aLevel = Number(a.requiredLevel || 0);
        const bLevel = Number(b.requiredLevel || 0);
        if (aLevel !== bLevel) return bLevel - aLevel;

        return Number(a.seedId || 0) - Number(b.seedId || 0);
    });
}

function createPlantingService(options = {}) {
    const send = typeof options.send === 'function' ? options.send : sendMsgAsync;
    const protoTypes = options.types || types;
    const getState = typeof options.getState === 'function' ? options.getState : getUserState;
    const readBagSeeds = typeof options.getBagSeeds === 'function' ? options.getBagSeeds : getBagSeeds;
    const readBagPriority = typeof options.getBagSeedPriority === 'function' ? options.getBagSeedPriority : getBagSeedPriority;
    const readPlantingStrategy = typeof options.getPlantingStrategy === 'function' ? options.getPlantingStrategy : getPlantingStrategy;
    const readPreferredSeed = typeof options.getPreferredSeed === 'function' ? options.getPreferredSeed : getPreferredSeed;
    const readAllLands = typeof options.getAllLands === 'function' ? options.getAllLands : getAllLandsRaw;
    const readShopInfo = typeof options.getShopInfo === 'function' ? options.getShopInfo : getShopInfo;
    const purchaseGoods = typeof options.buyGoods === 'function' ? options.buyGoods : buyGoods;
    const readRankings = typeof options.getPlantRankings === 'function' ? options.getPlantRankings : getPlantRankings;
    const readPlantBySeedId = typeof options.getPlantBySeedId === 'function' ? options.getPlantBySeedId : getPlantBySeedId;
    const readPlantNameBySeedId = typeof options.getPlantNameBySeedId === 'function' ? options.getPlantNameBySeedId : getPlantNameBySeedId;
    const readPlantGrowTime = typeof options.getPlantGrowTime === 'function' ? options.getPlantGrowTime : getPlantGrowTime;
    const formatGrow = typeof options.formatGrowTime === 'function' ? options.formatGrowTime : formatGrowTime;
    const choose2x2Groups = typeof options.selectReady2x2Groups === 'function' ? options.selectReady2x2Groups : selectReady2x2Groups;
    const validate2x2 = typeof options.validate2x2PlantReply === 'function' ? options.validate2x2PlantReply : validate2x2PlantReply;
    const buildMap = typeof options.buildLandMap === 'function' ? options.buildLandMap : buildLandMap;
    const getDisplayContext = typeof options.getDisplayLandContext === 'function' ? options.getDisplayLandContext : getDisplayLandContext;
    const logInfo = typeof options.log === 'function' ? options.log : log;
    const logWarning = typeof options.logWarn === 'function' ? options.logWarn : logWarn;
    const wait = typeof options.sleep === 'function' ? options.sleep : sleep;

    function getPlantSizeBySeedId(seedId) {
        const plantCfg = readPlantBySeedId(toNum(seedId));
        return Math.max(1, toNum(plantCfg && plantCfg.size) || 1);
    }

    async function plantSeeds(seedId, landIds, runOptions = {}) {
        let successCount = 0;
        const plantedLandIds = [];
        const occupiedLandIds = new Set();
        const maxPlantCount = Math.max(0, toNum(runOptions.maxPlantCount) || 0) || Number.POSITIVE_INFINITY;
        const sourceLandIds = Array.isArray(landIds) ? landIds : [];
        const pendingLandIds = new Set(sourceLandIds.map(id => toNum(id)).filter(Boolean));

        for (const rawLandId of sourceLandIds) {
            const landId = toNum(rawLandId);
            if (!landId || !pendingLandIds.has(landId)) continue;
            if (successCount >= maxPlantCount) break;
            try {
                const body = encodePlantRequest(seedId, [landId]);
                const { body: replyBody } = await send(PLANT_SERVICE, 'Plant', body);
                const reply = protoTypes.PlantReply.decode(replyBody);
                const changedLands = Array.isArray(reply && reply.land) ? reply.land : [];
                const changedMap = buildMap(changedLands);
                const selfLand = changedMap.get(landId);
                const displayContext = getDisplayContext(selfLand || { id: landId }, changedMap);
                const occupiedIds = displayContext.occupiedLandIds.length > 0
                    ? displayContext.occupiedLandIds
                    : [landId];
                successCount++;
                plantedLandIds.push(displayContext.masterLandId || landId);
                for (const occupiedId of occupiedIds) {
                    occupiedLandIds.add(occupiedId);
                    pendingLandIds.delete(occupiedId);
                }
            } catch (error) {
                logWarning('种植', `土地#${landId} 失败: ${error.message}`);
            }
            if (sourceLandIds.length > 1) await wait(50);
        }
        return {
            planted: successCount,
            plantedLandIds,
            occupiedLandIds: [...occupiedLandIds],
        };
    }

    async function plant2x2Seed(seedId, group) {
        const landIds = Array.isArray(group && group.landIds) ? group.landIds.map(toNum).filter(Boolean) : [];
        if (landIds.length !== 4) throw new Error('2x2 土地组合无效');

        const body = encodePlantRequest(seedId, landIds);
        const { body: replyBody } = await send(PLANT_SERVICE, 'Plant', body);
        const reply = protoTypes.PlantReply.decode(replyBody);
        const validation = validate2x2(reply, group);
        if (!validation.ok) {
            throw new Error(`2x2 种植回包校验失败: ${validation.reason}`);
        }
        return validation;
    }

    async function plantFromBagSeeds(landsToPlant) {
        const targetLandIds = (Array.isArray(landsToPlant) ? landsToPlant : []).map(id => Number(id)).filter(id => id > 0);
        if (targetLandIds.length === 0) {
            return { remainingLandIds: [], fallbackAllowed: false, plantedLandIds: [], totalPlanted: 0, occupiedCount: 0 };
        }

        const bagSeeds = await readBagSeeds();
        const allBagSeeds = Array.isArray(bagSeeds) ? bagSeeds : [];
        const priority = readBagPriority();
        const sortedSeeds = sortBagSeedsForPlanting(
            allBagSeeds.filter(seed => Number(seed && seed.count) > 0),
            priority,
        );
        const twoByTwoSeeds = sortedSeeds.filter(seed => Number(seed && seed.plantSize) === 2);
        const usableSeeds = sortedSeeds.filter(seed => Number(seed && seed.plantSize) === 1);

        let remainingLandIds = [...targetLandIds];
        let fallbackAllowed = true;
        let totalPlanted = 0;
        let occupiedCount = 0;
        const plantedLandIds = [];
        const usedSeedLogs = [];

        if (twoByTwoSeeds.length > 0 && remainingLandIds.length >= 4) {
            try {
                const latest = await readAllLands();
                const latestLands = Array.isArray(latest && latest.lands) ? latest.lands : [];
                const desiredGroups = twoByTwoSeeds.reduce((sum, seed) => sum + Math.max(0, Number(seed.count) || 0), 0);
                const readyGroups = choose2x2Groups(latestLands, remainingLandIds, desiredGroups);
                let groupIndex = 0;
                let stop2x2 = false;

                for (const seed of twoByTwoSeeds) {
                    if (stop2x2 || groupIndex >= readyGroups.length) break;
                    const count = Math.max(0, Number(seed.count) || 0);
                    for (let i = 0; i < count && groupIndex < readyGroups.length; i++) {
                        const group = readyGroups[groupIndex];
                        try {
                            const planted = await plant2x2Seed(seed.seedId, group);
                            const occupied = planted.occupiedLandIds || group.landIds;
                            plantedLandIds.push(planted.masterLandId || group.masterLandId);
                            remainingLandIds = remainingLandIds.filter(id => !occupied.includes(id));
                            totalPlanted++;
                            occupiedCount += occupied.length;
                            usedSeedLogs.push(`${seed.name} 2x2x1`);
                            groupIndex++;
                            await wait(100);
                        } catch (error) {
                            logWarning('种植', `背包 2x2 种子 ${seed.name}(${seed.seedId}) 种植失败，已停止本轮 2x2 尝试: ${error.message}`, {
                                module: 'farm',
                                event: '种植种子',
                                result: 'bag_2x2_failed',
                                seedId: seed.seedId,
                                landIds: group.landIds,
                            });
                            stop2x2 = true;
                            break;
                        }
                    }
                }

                if (readyGroups.length === 0) {
                    logInfo('种植', `背包检测到 ${twoByTwoSeeds.length} 种 2x2 种子，但当前没有完整 2x2 空地，本轮不强行铲地`, {
                        module: 'farm',
                        event: '种植种子',
                        result: 'bag_2x2_waiting',
                        seedIds: twoByTwoSeeds.map(seed => seed.seedId),
                    });
                }
            } catch (error) {
                logWarning('种植', `检查 2x2 空地失败，本轮只继续 1x1 背包种子: ${error.message}`, {
                    module: 'farm',
                    event: '种植种子',
                    result: 'bag_2x2_probe_failed',
                });
            }
        }

        if (usableSeeds.length === 0 && totalPlanted === 0) {
            const hasAnyBagSeed = allBagSeeds.some(seed => Number(seed && seed.count) > 0);
            logInfo('种植', hasAnyBagSeed
                ? '背包暂无可立即种下的 1x1/2x2 种子，准备按第二优先策略补种'
                : '背包种子已用完，准备按第二优先策略补种', {
                module: 'farm',
                event: '种植种子',
                result: 'fallback_ready',
                strategy: 'bag_priority',
            });
            return { remainingLandIds, fallbackAllowed: true, plantedLandIds, totalPlanted, occupiedCount };
        }

        for (const seed of usableSeeds) {
            if (remainingLandIds.length === 0) break;

            const maxPlantCount = Math.min(Number(seed.count || 0), remainingLandIds.length);
            if (maxPlantCount <= 0) continue;

            const result = await plantSeeds(seed.seedId, remainingLandIds, { maxPlantCount });
            const currentOccupied = (Array.isArray(result.occupiedLandIds) ? result.occupiedLandIds : []).map(Number).filter(id => id > 0);
            const currentPlantedLandIds = (Array.isArray(result.plantedLandIds) ? result.plantedLandIds : []).map(Number).filter(id => id > 0);
            if (result.planted > 0) {
                totalPlanted += result.planted;
                occupiedCount += currentOccupied.length > 0 ? currentOccupied.length : result.planted;
                plantedLandIds.push(...currentPlantedLandIds);
                remainingLandIds = remainingLandIds.filter(id => !currentOccupied.includes(id));
                usedSeedLogs.push(`${seed.name}x${result.planted}`);
            }

            if (result.planted < maxPlantCount && remainingLandIds.length > 0) {
                fallbackAllowed = false;
                logWarning('种植', `背包种子 ${seed.name} 实际种植 ${result.planted}/${maxPlantCount}，为避免误购商店种子，本轮不执行第二优先策略`, {
                    module: 'farm',
                    event: '种植种子',
                    result: 'partial_bag_failure',
                    seedId: seed.seedId,
                    requested: maxPlantCount,
                    planted: result.planted,
                });
            }
        }

        if (usedSeedLogs.length > 0) {
            logInfo('种植', `已按背包优先策略种植: ${usedSeedLogs.join('，')}`, {
                module: 'farm',
                event: '种植种子',
                result: 'ok',
                strategy: 'bag_priority',
                count: totalPlanted,
                occupiedCount,
            });
        }

        return {
            remainingLandIds,
            fallbackAllowed,
            plantedLandIds: [...new Set(plantedLandIds)],
            totalPlanted,
            occupiedCount,
        };
    }

    async function findBestSeed(overrideStrategy) {
        const SEED_SHOP_ID = 2;
        const shopReply = await readShopInfo(SEED_SHOP_ID);
        if (!shopReply.goods_list || shopReply.goods_list.length === 0) {
            logWarning('商店', '种子商店无商品');
            return null;
        }

        const state = getState();
        const available = [];
        for (const goods of shopReply.goods_list) {
            if (!goods.unlocked) continue;

            let meetsConditions = true;
            let requiredLevel = 0;
            const conds = goods.conds || [];
            for (const cond of conds) {
                if (toNum(cond.type) === 1) {
                    requiredLevel = toNum(cond.param);
                    if (state.level < requiredLevel) {
                        meetsConditions = false;
                        break;
                    }
                }
            }
            if (!meetsConditions) continue;

            const limitCount = toNum(goods.limit_count);
            const boughtNum = toNum(goods.bought_num);
            if (limitCount > 0 && boughtNum >= limitCount) continue;

            const seedId = toNum(goods.item_id);
            // P2C 生产边界：商店自动购买仍只允许 1x1，2x2 只使用背包已有种子。
            if (getPlantSizeBySeedId(seedId) > 1) continue;

            available.push({
                goods,
                goodsId: toNum(goods.id),
                seedId,
                price: toNum(goods.price),
                requiredLevel,
            });
        }

        if (available.length === 0) {
            logWarning('商店', '没有可购买的 1x1 种子');
            return null;
        }

        const strategy = overrideStrategy || readPlantingStrategy();
        const analyticsSortByMap = {
            max_exp: 'exp',
            max_fert_exp: 'fert',
            max_profit: 'profit',
            max_fert_profit: 'fert_profit',
        };
        const analyticsSortBy = analyticsSortByMap[strategy];
        if (analyticsSortBy) {
            try {
                const rankings = readRankings(analyticsSortBy);
                const availableBySeedId = new Map(available.map(item => [item.seedId, item]));
                for (const row of rankings) {
                    const seedId = Number(row && row.seedId) || 0;
                    if (seedId <= 0) continue;
                    const lv = Number(row && row.level);
                    if (Number.isFinite(lv) && lv > state.level) continue;
                    const found = availableBySeedId.get(seedId);
                    if (found) return found;
                }
                logWarning('商店', `策略 ${strategy} 未找到可购买作物，回退最高等级`);
            } catch (error) {
                logWarning('商店', `策略 ${strategy} 计算失败: ${error.message}，回退最高等级`);
            }
            available.sort((a, b) => b.requiredLevel - a.requiredLevel);
            return available[0];
        }

        if (strategy === 'preferred') {
            const preferred = readPreferredSeed();
            if (preferred > 0) {
                const found = available.find(item => item.seedId === preferred);
                if (found) return found;
                logWarning('商店', `优先种子 ${preferred} 当前不可购买，回退自动选择`);
            }
            available.sort((a, b) => b.requiredLevel - a.requiredLevel);
        }
        else if (strategy === 'level') {
            available.sort((a, b) => b.requiredLevel - a.requiredLevel);
        }
        else {
            available.sort((a, b) => b.requiredLevel - a.requiredLevel);
        }

        return available[0];
    }

    async function plantFromShop(landsToPlant, state, overrideStrategy) {
        let bestSeed;
        try {
            bestSeed = await findBestSeed(overrideStrategy);
        } catch (error) {
            logWarning('商店', `查询失败: ${error.message}`);
            return { plantedLands: [] };
        }
        if (!bestSeed) return { plantedLands: [] };

        const seedName = readPlantNameBySeedId(bestSeed.seedId);
        const growTime = readPlantGrowTime(1020000 + (bestSeed.seedId - 20000));
        const growTimeStr = growTime > 0 ? ` 生长${formatGrow(growTime)}` : '';
        const plantSize = getPlantSizeBySeedId(bestSeed.seedId);
        const landFootprint = plantSize * plantSize;
        logInfo('商店', `最佳种子: ${seedName} (${bestSeed.seedId}) 价格=${bestSeed.price}金币${growTimeStr}`, {
            module: 'warehouse', event: '选择种子', seedId: bestSeed.seedId, price: bestSeed.price,
        });

        let needCount = landsToPlant.length;
        if (landFootprint > 1) {
            needCount = Math.floor(landsToPlant.length / landFootprint);
            if (needCount <= 0) {
                logInfo('种植', `${seedName} 需要至少 ${landFootprint} 块空地才能合并种植，当前仅 ${landsToPlant.length} 块可用，已跳过`, {
                    module: 'farm', event: '种植种子', result: 'skip', seedId: bestSeed.seedId,
                    landFootprint, emptyCount: landsToPlant.length,
                });
                return;
            }
        }
        const totalCost = bestSeed.price * needCount;
        if (totalCost > state.gold) {
            logWarning('商店', `金币不足! 需要 ${totalCost} 金币, 当前 ${state.gold} 金币`, {
                module: 'farm', event: '购买种子跳过', result: 'insufficient_gold', need: totalCost, current: state.gold,
            });
            const canBuy = Math.floor(state.gold / bestSeed.price);
            if (canBuy <= 0) return { plantedLands: [] };
            needCount = canBuy;
            logInfo('商店', plantSize > 1 ? `金币有限，只尝试种植 ${canBuy} 组 ${plantSize}x${plantSize} 作物` : `金币有限，只种 ${canBuy} 块地`);
        }

        let actualSeedId = bestSeed.seedId;
        try {
            const buyReply = await purchaseGoods(bestSeed.goodsId, needCount, bestSeed.price);
            if (buyReply.get_items && buyReply.get_items.length > 0) {
                const gotItem = buyReply.get_items[0];
                const gotId = toNum(gotItem.id);
                if (gotId > 0) actualSeedId = gotId;
            }
            if (buyReply.cost_items) {
                for (const item of buyReply.cost_items) {
                    state.gold -= toNum(item.count);
                }
            }
            const boughtName = readPlantNameBySeedId(actualSeedId);
            logInfo('购买', `已购买 ${boughtName}种子 x${needCount}, 花费 ${bestSeed.price * needCount} 金币`, {
                module: 'warehouse', event: '购买种子', result: 'ok', seedId: actualSeedId,
                count: needCount, cost: bestSeed.price * needCount,
            });
        } catch (error) {
            logWarning('购买', error.message);
            return { plantedLands: [] };
        }

        let plantedLands = [];
        try {
            const { planted, plantedLandIds, occupiedLandIds } = await plantSeeds(actualSeedId, landsToPlant, { maxPlantCount: needCount });
            const occupiedCount = occupiedLandIds.length > 0 ? occupiedLandIds.length : planted;
            logInfo('种植', plantSize > 1
                ? `已种植 ${planted} 组 ${plantSize}x${plantSize} 作物，占用 ${occupiedCount} 块地 (${occupiedLandIds.join(',')})`
                : `已在 ${planted} 块地种植 (${landsToPlant.slice(0, planted).join(',')})`, {
                module: 'farm', event: '种植种子', result: 'ok', seedId: actualSeedId,
                count: planted, occupiedCount,
            });
            if (planted > 0) {
                plantedLands = plantedLandIds;
            }
        } catch (error) {
            logWarning('种植', error.message);
        }

        return { plantedLands };
    }

    return {
        getPlantSizeBySeedId,
        plantSeeds,
        plant2x2Seed,
        plantFromBagSeeds,
        findBestSeed,
        plantFromShop,
    };
}

const defaultService = createPlantingService();

module.exports = {
    PLANT_SERVICE,
    PLANTING_STRATEGY_LABELS,
    encodePlantRequest,
    getPlantingStrategyLabel,
    sortBagSeedsForPlanting,
    createPlantingService,
    ...defaultService,
};
