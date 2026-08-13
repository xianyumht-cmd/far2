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
