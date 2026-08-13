const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createFarmSchedulerService } = require('../src/services/farm-scheduler');

function createFakeScheduler() {
    const tasks = new Map();
    const calls = [];
    return {
        tasks,
        calls,
        setTimeoutTask(name, delay, fn) {
            calls.push(['set', name, delay]);
            tasks.set(name, { delay, fn });
        },
        clearAll() {
            calls.push(['clearAll']);
            tasks.clear();
        },
    };
}

async function main() {
    console.log('FAR2 Farm Scheduler Contract Self-Test');
    console.log('安全: 使用 fake scheduler/timer/EventEmitter，不连接 QQ、不等待真实时间。\n');

    const scheduler = createFakeScheduler();
    const events = new EventEmitter();
    const checkCalls = [];
    const buyCalls = [];
    const intervalCalls = [];
    const clearedIntervals = [];
    const intervals = new Map();
    let intervalId = 0;
    let nowMs = 1000;
    let busy = false;
    const enabled = new Set(['farm_push', 'fertilizer_buy_organic']);

    const service = createFarmSchedulerService({
        checkFarm: async () => {
            checkCalls.push('check');
            return true;
        },
        isChecking: () => busy,
        isAutomationOn: (key) => enabled.has(key),
        networkEvents: events,
        scheduler,
        farmCheckInterval: 12345,
        getFertilizerBuyOrganicCount: () => 8,
        getFertilizerBuyOrganicThresholdHours: () => 2,
        getFertilizerBuyNormalCount: () => 99,
        getFertilizerBuyNormalThresholdHours: () => 6,
        getFertilizerBuyCheckIntervalMinutes: () => 7,
        checkAndBuyFertilizerBoth: async (options) => buyCalls.push(options),
        log: () => {},
        logWarn: () => {},
        now: () => nowMs,
        setInterval: (fn, delay) => {
            const id = ++intervalId;
            intervalCalls.push([id, delay]);
            intervals.set(id, fn);
            return id;
        },
        clearInterval: (id) => {
            clearedIntervals.push(id);
            intervals.delete(id);
        },
    });

    service.startFarmCheckLoop();
    assert.equal(service.isRunning(), true);
    assert.equal(service.isExternalSchedulerMode(), false);
    assert.equal(events.listenerCount('landsChanged'), 1);
    assert.deepEqual(scheduler.calls[0], ['set', 'farm_check_loop', 2000]);
    assert.deepEqual(intervalCalls, [[1, 7 * 60 * 1000]]);

    await scheduler.tasks.get('farm_check_loop').fn();
    assert.equal(checkCalls.length, 1);
    assert.deepEqual(scheduler.calls[1], ['set', 'farm_check_loop', 12345]);

    service.refreshFarmCheckLoop();
    assert.deepEqual(scheduler.calls[2], ['set', 'farm_check_loop', 200]);

    events.emit('landsChanged', [1, 2, 3]);
    assert.deepEqual(scheduler.calls[3], ['set', 'farm_push_check', 100]);
    nowMs = 1200;
    events.emit('landsChanged', [4]);
    assert.equal(scheduler.calls.length, 4, 'pushes inside 500ms must remain debounced');

    await scheduler.tasks.get('farm_push_check').fn();
    assert.equal(checkCalls.length, 2);

    busy = true;
    nowMs = 2000;
    events.emit('landsChanged', [5]);
    assert.equal(scheduler.calls.length, 4, 'busy orchestrator must suppress push scheduling');
    busy = false;

    await service.checkFertilizerBuyOnce();
    assert.deepEqual(buyCalls, [{
        buyOrganic: true,
        buyNormal: false,
        organicCount: 8,
        organicThresholdHours: 2,
        normalCount: 99,
        normalThresholdHours: 6,
    }]);

    service.stopFarmCheckLoop();
    assert.equal(service.isRunning(), false);
    assert.equal(events.listenerCount('landsChanged'), 0);
    assert.deepEqual(scheduler.calls[4], ['clearAll']);
    assert.deepEqual(clearedIntervals, [1]);

    const externalScheduler = createFakeScheduler();
    const externalEvents = new EventEmitter();
    const externalIntervals = [];
    const externalService = createFarmSchedulerService({
        checkFarm: async () => true,
        isChecking: () => false,
        isAutomationOn: (key) => key === 'farm_push',
        networkEvents: externalEvents,
        scheduler: externalScheduler,
        farmCheckInterval: 8888,
        log: () => {},
        logWarn: () => {},
        now: () => 5000,
        setInterval: (fn, delay) => {
            externalIntervals.push(delay);
            return 1;
        },
        clearInterval: () => {},
    });

    externalService.startFarmCheckLoop({ externalScheduler: true });
    assert.equal(externalService.isExternalSchedulerMode(), true);
    assert.equal(externalScheduler.calls.length, 0, 'external scheduler mode must not schedule internal farm loop');
    externalService.refreshFarmCheckLoop(50);
    assert.equal(externalScheduler.calls.length, 0, 'refresh must remain no-op in external scheduler mode');
    assert.equal(externalEvents.listenerCount('landsChanged'), 1, 'push listener remains active in external mode');
    externalService.stopFarmCheckLoop();

    console.log('✅ initial 2000ms + recurring CONFIG interval contract PASS');
    console.log('✅ refresh 200ms contract PASS');
    console.log('✅ push 500ms debounce + 100ms delayed check contract PASS');
    console.log('✅ fertilizer-buy interval/options contract PASS');
    console.log('✅ external scheduler mode contract PASS');
    console.log('✅ no real timers/network touched PASS');
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        realTimerWaited: false,
        realQqTouched: false,
        farmRpcTouched: false,
        writeOperationTouched: false,
    }, null, 2));
}

main().catch((error) => {
    console.error('\n❌ Farm Scheduler Contract Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
