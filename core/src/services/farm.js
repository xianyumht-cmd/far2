/**
 * 自己的农场操作 - 收获/浇水/除草/除虫/铲除/种植/商店/巡田
 */

const {
    getDisplayLandContext,
    isOccupiedSlaveLand,
    buildSlaveToMasterMap,
    getCurrentPhase,
    buildLandMap,
} = require('./farm-land-analyzer');
const { getAllLandsRaw } = require('./farm-api');
const { createFarmFertilizerService } = require('./farm-fertilizer');
const { createPlantingService } = require('./planting-service');
const { createEventSeedPriorityService } = require('./event-seed-priority');
const { getPlantBySeedIdWithLearning } = require('./learned-seed-resolver');
const { getRegistryAwareBagSeeds } = require('./registry-aware-bag-seeds');
const {
    createEventSeedLogWarn,
    createEventSeedShopWrapper,
} = require('./event-seed-shop-wrapper');
const { createFarmOrchestrator } = require('./farm-orchestrator');
const { createFarmSchedulerService } = require('./farm-scheduler');
const { createFarmQueryService } = require('./farm-query-service');

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
    plantSeeds,
    plant2x2Seed,
    plantFromBagSeeds,
    plantFromShop: plantFromShopBase,
} = createPlantingService({
    // 背包 2x2 探测必须继续经过 facade wrapper，保持 operation-limit callback 语义。
    getAllLands,
    // 背包种植也消费 Startup Crop Registry 的 exact proven Plant，避免只认静态 Plant.json。
    getBagSeeds: getRegistryAwareBagSeeds,
    getPlantBySeedId: getPlantBySeedIdWithLearning,
});

const { runBeforeShop: runEventSeedPriorityBeforeShop } = createEventSeedPriorityService({
    // 活动/特殊种子仍复用已验收的 PlantService 写链，不新增或猜测 RPC。
    getAllLands,
    plantSeeds,
    plant2x2Seed,
    // Startup Registry exact proven Plant 优先，其次才允许旧 QQ cache learning。
    getPlantBySeedId: getPlantBySeedIdWithLearning,
    // unresolved 的真实拦截结果由 wrapper 的置信度安全门决定，避免中间层先打印误导性“已暂停”。
    logWarn: createEventSeedLogWarn(),
});

const plantFromShopWithEventSeedPriority = createEventSeedShopWrapper({
    runEventSeedPriorityBeforeShop,
    plantFromShopBase,
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
    plantFromShop: plantFromShopWithEventSeedPriority,
    // 无论当前选择商店策略还是“背包种子优先”，2x2 prepass 都能看到 Registry 新种子。
    getBagSeeds: getRegistryAwareBagSeeds,
});

const {
    startFarmCheckLoop,
    stopFarmCheckLoop,
    refreshFarmCheckLoop,
} = createFarmSchedulerService({
    checkFarm,
    isChecking: isFarmCheckInProgress,
});

const {
    getAvailableSeeds,
    getLandsDetail,
} = createFarmQueryService({
    // 土地详情必须继续经过 facade wrapper，以保持 operation-limit callback 语义。
    getAllLands,
});

// ============ 只读查询：由 farm-query-service.js 提供 ============

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
