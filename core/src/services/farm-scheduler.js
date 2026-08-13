const { CONFIG } = require('../config/config');
const {
    isAutomationOn,
    getFertilizerBuyOrganicCount,
    getFertilizerBuyOrganicThresholdHours,
    getFertilizerBuyNormalCount,
    getFertilizerBuyNormalThresholdHours,
    getFertilizerBuyCheckIntervalMinutes,
} = require('../models/store');
const { networkEvents } = require('../utils/network');
const { log, logWarn } = require('../utils/utils');
const { createScheduler } = require('./scheduler');
const { checkAndBuyFertilizerBoth } = require('./mall');

function createFarmSchedulerService(options = {}) {
    const checkFarm = typeof options.checkFarm === 'function' ? options.checkFarm : async () => false;
    const isChecking = typeof options.isChecking === 'function' ? options.isChecking : () => false;
    const automationOn = typeof options.isAutomationOn === 'function' ? options.isAutomationOn : isAutomationOn;
    const events = options.networkEvents || networkEvents;
    const scheduler = options.scheduler || createScheduler('farm');
    const farmCheckInterval = Number.isFinite(Number(options.farmCheckInterval))
        ? Number(options.farmCheckInterval)
        : CONFIG.farmCheckInterval;
    const getOrganicCount = typeof options.getFertilizerBuyOrganicCount === 'function'
        ? options.getFertilizerBuyOrganicCount
        : getFertilizerBuyOrganicCount;
    const getOrganicThreshold = typeof options.getFertilizerBuyOrganicThresholdHours === 'function'
        ? options.getFertilizerBuyOrganicThresholdHours
        : getFertilizerBuyOrganicThresholdHours;
    const getNormalCount = typeof options.getFertilizerBuyNormalCount === 'function'
        ? options.getFertilizerBuyNormalCount
        : getFertilizerBuyNormalCount;
    const getNormalThreshold = typeof options.getFertilizerBuyNormalThresholdHours === 'function'
        ? options.getFertilizerBuyNormalThresholdHours
        : getFertilizerBuyNormalThresholdHours;
    const getBuyIntervalMinutes = typeof options.getFertilizerBuyCheckIntervalMinutes === 'function'
        ? options.getFertilizerBuyCheckIntervalMinutes
        : getFertilizerBuyCheckIntervalMinutes;
    const buyFertilizer = typeof options.checkAndBuyFertilizerBoth === 'function'
        ? options.checkAndBuyFertilizerBoth
        : checkAndBuyFertilizerBoth;
    const logInfo = typeof options.log === 'function' ? options.log : log;
    const logWarning = typeof options.logWarn === 'function' ? options.logWarn : logWarn;
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const setIntervalFn = typeof options.setInterval === 'function' ? options.setInterval : setInterval;
    const clearIntervalFn = typeof options.clearInterval === 'function' ? options.clearInterval : clearInterval;

    let farmLoopRunning = false;
    let externalSchedulerMode = false;
    let fertilizerBuyCheckTimer = null;
    let lastPushTime = 0;

    function scheduleNextFarmCheck(delayMs = farmCheckInterval) {
        if (externalSchedulerMode) return;
        if (!farmLoopRunning) return;
        scheduler.setTimeoutTask('farm_check_loop', Math.max(0, delayMs), async () => {
            if (!farmLoopRunning) return;
            await checkFarm();
            if (!farmLoopRunning) return;
            scheduleNextFarmCheck(farmCheckInterval);
        });
    }

    async function checkFertilizerBuyOnce() {
        if (!automationOn('fertilizer_buy_organic') && !automationOn('fertilizer_buy_normal')) {
            return;
        }

        try {
            const buyOptions = {
                buyOrganic: automationOn('fertilizer_buy_organic'),
                buyNormal: automationOn('fertilizer_buy_normal'),
                organicCount: getOrganicCount(),
                organicThresholdHours: getOrganicThreshold(),
                normalCount: getNormalCount(),
                normalThresholdHours: getNormalThreshold(),
            };

            await buyFertilizer(buyOptions);
        } catch (error) {
            logWarning('农场', `化肥自动购买检测失败: ${error.message}`, {
                module: 'farm',
                event: 'fertilizer_auto_buy',
                result: 'error',
                error: error.message,
            });
        }
    }

    function startFertilizerBuyCheckTimer() {
        if (fertilizerBuyCheckTimer) {
            clearIntervalFn(fertilizerBuyCheckTimer);
        }

        if (!automationOn('fertilizer_buy_organic') && !automationOn('fertilizer_buy_normal')) {
            return;
        }

        const intervalMinutes = getBuyIntervalMinutes();
        const intervalMs = intervalMinutes * 60 * 1000;

        fertilizerBuyCheckTimer = setIntervalFn(() => {
            checkFertilizerBuyOnce();
        }, intervalMs);

        logInfo('农场', `化肥自动购买检测定时器已启动，间隔 ${intervalMinutes} 分钟`, {
            module: 'farm',
            event: '购买化肥计时器',
            result: 'start',
            intervalMinutes,
        });
    }

    function stopFertilizerBuyCheckTimer() {
        if (fertilizerBuyCheckTimer) {
            clearIntervalFn(fertilizerBuyCheckTimer);
            fertilizerBuyCheckTimer = null;
        }
        logInfo('农场', '化肥自动购买检测定时器已停止', {
            module: 'farm',
            event: '购买化肥计时器',
            result: 'stop',
        });
    }

    function onLandsChangedPush(lands) {
        if (!automationOn('farm_push')) {
            return;
        }
        if (isChecking()) return;
        const currentTime = now();
        if (currentTime - lastPushTime < 500) return;
        lastPushTime = currentTime;
        logInfo('农场', `收到推送: ${lands.length}块土地变化，检查中...`, {
            module: 'farm', event: '土地推送通知', result: 'trigger_check', count: lands.length,
        });
        scheduler.setTimeoutTask('farm_push_check', 100, async () => {
            if (!isChecking()) await checkFarm();
        });
    }

    function startFarmCheckLoop(runOptions = {}) {
        if (farmLoopRunning) return;
        externalSchedulerMode = !!runOptions.externalScheduler;
        farmLoopRunning = true;
        events.on('landsChanged', onLandsChangedPush);
        if (!externalSchedulerMode) {
            scheduleNextFarmCheck(2000);
        }
        startFertilizerBuyCheckTimer();
    }

    function stopFarmCheckLoop() {
        farmLoopRunning = false;
        externalSchedulerMode = false;
        scheduler.clearAll();
        events.removeListener('landsChanged', onLandsChangedPush);
        stopFertilizerBuyCheckTimer();
    }

    function refreshFarmCheckLoop(delayMs = 200) {
        if (!farmLoopRunning) return;
        scheduleNextFarmCheck(delayMs);
    }

    return {
        startFarmCheckLoop,
        stopFarmCheckLoop,
        refreshFarmCheckLoop,
        scheduleNextFarmCheck,
        onLandsChangedPush,
        startFertilizerBuyCheckTimer,
        stopFertilizerBuyCheckTimer,
        checkFertilizerBuyOnce,
        isRunning: () => farmLoopRunning,
        isExternalSchedulerMode: () => externalSchedulerMode,
    };
}

module.exports = {
    createFarmSchedulerService,
};
