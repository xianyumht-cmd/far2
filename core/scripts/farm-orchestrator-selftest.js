const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PlantPhase } = require('../src/config/config');
const { createFarmOrchestrator } = require('../src/services/farm-orchestrator');

async function main() {
    console.log('FAR2 Farm Orchestrator Contract Self-Test');
    console.log('安全: 使用纯本地土地 fixture + 假操作函数，不连接 QQ、不发送 Farm/Shop RPC。\n');

    const calls = [];
    const records = [];
    const harvestedEvents = [];
    const events = new EventEmitter();
    events.on('farmHarvested', (payload) => harvestedEvents.push(payload));

    const lands = [
        {
            id: 1,
            unlocked: true,
            plant: {
                id: 1020001,
                name: '成熟作物',
                phases: [{ phase: PlantPhase.MATURE, begin_time: 1 }],
            },
        },
        {
            id: 2,
            unlocked: true,
            plant: {
                id: 1020002,
                name: '生长作物',
                dry_num: 1,
                weed_owners: [1],
                insect_owners: [1],
                phases: [{ phase: PlantPhase.SEED, begin_time: 1 }],
            },
        },
        { id: 3, unlocked: true, plant: null },
    ];

    const orchestrator = createFarmOrchestrator({
        getAllLands: async () => ({ lands }),
        getUserState: () => ({ gid: 123, level: 50, gold: 99999 }),
        isAutomationOn: (key) => key === 'farm',
        getAutomation: () => ({ fertilizer: 'none' }),
        getPlantingStrategy: () => 'level',
        getPrioritize2x2Crops: () => true,
        getBagSeedPriority: () => [],
        getBagSeedFallbackStrategy: () => 'level',
        getBagSeeds: async () => [],
        runPrioritized2x2Prepass: async ({ landIds }) => {
            calls.push(['2x2-prepass', [...landIds]]);
            return { remainingLandIds: [...landIds], plantedLandIds: [] };
        },
        plant2x2Seed: async () => ({ ok: true }),
        plantFromBagSeeds: async () => {
            throw new Error('bag path should not run for level strategy');
        },
        plantFromShop: async (landIds, state, strategy) => {
            calls.push(['shop-plant', [...landIds], state.level, strategy || '']);
            return { plantedLands: [...landIds] };
        },
        runFertilizerByConfig: async (landIds, options) => {
            calls.push(['fertilizer', [...landIds], options || null]);
            return { normal: landIds.length, organic: 0 };
        },
        harvest: async (landIds) => {
            calls.push(['harvest', [...landIds]]);
            return { land: landIds.map((id) => ({ id, plant: null })) };
        },
        waterLand: async (landIds) => calls.push(['water', [...landIds]]),
        weedOut: async (landIds) => calls.push(['weed', [...landIds]]),
        insecticide: async (landIds) => calls.push(['bug', [...landIds]]),
        removePlant: async (landIds) => calls.push(['remove', [...landIds]]),
        upgradeLand: async () => ({ land: { level: 2 } }),
        unlockLand: async () => ({}),
        recordOperation: (name, count) => records.push([name, count]),
        networkEvents: events,
        log: () => {},
        logWarn: () => {},
        sleep: async () => {},
        randomDelay: async () => {},
        getPlantName: (id) => `作物${id}`,
        getPlantExp: () => 10,
        getServerTimeSec: () => 1000,
    });

    const analyzed = orchestrator.analyzeLands(lands);
    assert.deepEqual(analyzed.harvestable, [1]);
    assert.deepEqual(analyzed.needWater, [2]);
    assert.deepEqual(analyzed.needWeed, [2]);
    assert.deepEqual(analyzed.needBug, [2]);
    assert.deepEqual(analyzed.growing, [2]);
    assert.deepEqual(analyzed.empty, [3]);

    const result = await orchestrator.runFarmOperation('all');
    assert.equal(result.hadWork, true);
    assert.deepEqual(result.actions, ['除草1', '除虫1', '浇水1', '收获1', '种植2']);
    assert.deepEqual(calls, [
        ['weed', [2]],
        ['bug', [2]],
        ['water', [2]],
        ['harvest', [1]],
        ['remove', [1]],
        ['2x2-prepass', [3, 1]],
        ['shop-plant', [3, 1], 50, ''],
        ['fertilizer', [3, 1], null],
    ]);
    assert.deepEqual(records, [
        ['weed', 1],
        ['bug', 1],
        ['water', 1],
        ['harvest', 1],
        ['plant', 2],
    ]);
    assert.deepEqual(harvestedEvents, [{ count: 1, landIds: [1], opType: 'all' }]);

    let releaseCheck;
    const gate = new Promise((resolve) => { releaseCheck = resolve; });
    let entered = false;
    const busyOrchestrator = createFarmOrchestrator({
        getAllLands: async () => {
            entered = true;
            await gate;
            return { lands: [] };
        },
        getUserState: () => ({ gid: 456 }),
        isAutomationOn: (key) => key === 'farm',
        getAutomation: () => ({ fertilizer: 'none' }),
        log: () => {},
        logWarn: () => {},
    });

    const firstCheck = busyOrchestrator.checkFarm();
    while (!entered) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(busyOrchestrator.isChecking(), true);
    assert.equal(await busyOrchestrator.checkFarm(), false, 'concurrent check must remain fail-fast');
    releaseCheck();
    assert.equal(await firstCheck, false);
    assert.equal(busyOrchestrator.isChecking(), false);

    console.log('✅ land analysis contract PASS');
    console.log('✅ clear -> harvest -> post-harvest -> plant -> fertilizer order PASS');
    console.log('✅ recordOperation / farmHarvested event contract PASS');
    console.log('✅ checkFarm busy guard contract PASS');
    console.log('✅ no real network/RPC touched PASS');
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        realQqTouched: false,
        farmRpcTouched: false,
        shopRpcTouched: false,
        writeOperationTouched: false,
    }, null, 2));
}

main().catch((error) => {
    console.error('\n❌ Farm Orchestrator Contract Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
