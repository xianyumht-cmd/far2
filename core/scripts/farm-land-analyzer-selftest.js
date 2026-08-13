const assert = require('node:assert/strict');
const { PlantPhase } = require('../src/config/config');
const {
    getSlaveLandIds,
    getDisplayLandContext,
    isOccupiedSlaveLand,
    buildSlaveToMasterMap,
    summarizeLandDetails,
    getLandTypeByLevel,
    getCurrentPhase,
    buildLandMap,
    getLandLifecycleState,
    classifyHarvestedLandsByMap,
} = require('../src/services/farm-land-analyzer');

function main() {
    console.log('FAR2 Farm Land Analyzer Contract Self-Test');
    console.log('安全: 只测试纯土地 DTO/阶段/主副地分析，不连接 QQ、不调用 Farm RPC。\n');

    assert.equal(getLandTypeByLevel(5), 'purple');
    assert.equal(getLandTypeByLevel(4), 'gold');
    assert.equal(getLandTypeByLevel(3), 'black');
    assert.equal(getLandTypeByLevel(2), 'red');
    assert.equal(getLandTypeByLevel(1), 'normal');
    assert.equal(getLandTypeByLevel(0), 'normal');

    const master = {
        id: 5,
        unlocked: true,
        slave_land_ids: [6, 1, 2, 6],
        plant: { phases: [{ phase: PlantPhase.SEED, begin_time: 1 }] },
    };
    const slave = { id: 6, unlocked: true, master_land_id: 5 };
    const unrelated = { id: 7, unlocked: true, master_land_id: 5 };
    const landsMap = buildLandMap([master, slave, unrelated, { id: 0 }, null]);

    assert.deepEqual(getSlaveLandIds(master), [6, 1, 2]);
    assert.equal(landsMap.size, 3);
    const slaveContext = getDisplayLandContext(slave, landsMap);
    assert.equal(slaveContext.occupiedByMaster, true);
    assert.equal(slaveContext.masterLandId, 5);
    assert.deepEqual(slaveContext.occupiedLandIds, [5, 6, 1, 2]);
    assert.equal(slaveContext.sourceLand, master);
    assert.equal(isOccupiedSlaveLand(slave, landsMap), true);

    const unrelatedContext = getDisplayLandContext(unrelated, landsMap);
    assert.equal(unrelatedContext.occupiedByMaster, false, 'master must list the slave when slave list exists');
    assert.equal(unrelatedContext.masterLandId, 7);

    const slaveMap = buildSlaveToMasterMap([master]);
    assert.equal(slaveMap.get(6), 5);
    assert.equal(slaveMap.get(1), 5);
    assert.equal(slaveMap.get(2), 5);

    const summary = summarizeLandDetails([
        { unlocked: true, status: 'harvestable', needWater: true },
        { unlocked: true, status: 'growing', needWeed: true },
        { unlocked: true, status: 'stealable', needBug: true },
        { unlocked: true, status: 'empty' },
        { unlocked: true, status: 'dead' },
        { unlocked: false, status: 'harvestable', needWater: true },
    ]);
    assert.deepEqual(summary, {
        harvestable: 1,
        growing: 2,
        empty: 1,
        dead: 1,
        needWater: 1,
        needWeed: 1,
        needBug: 1,
    });

    const now = Math.floor(Date.now() / 1000);
    const phases = [
        { phase: PlantPhase.SEED, begin_time: now - 100 },
        { phase: PlantPhase.GERMINATION, begin_time: now - 50 },
        { phase: PlantPhase.MATURE, begin_time: now + 100 },
    ];
    assert.equal(getCurrentPhase(phases, false, '').phase, PlantPhase.GERMINATION);
    assert.equal(getCurrentPhase([{ phase: PlantPhase.SEED, begin_time: now + 100 }], false, '').phase, PlantPhase.SEED);
    assert.equal(getCurrentPhase([], false, ''), null);

    assert.equal(getLandLifecycleState(null), 'unknown');
    assert.equal(getLandLifecycleState({ plant: null }), 'empty');
    assert.equal(getLandLifecycleState({ plant: { phases: [{ phase: PlantPhase.DEAD, begin_time: 1 }] } }), 'dead');
    assert.equal(getLandLifecycleState({ plant: { phases: [{ phase: PlantPhase.SEED, begin_time: 1 }] } }), 'growing');

    const harvestedMap = buildLandMap([
        { id: 1, plant: null },
        { id: 2, plant: { phases: [{ phase: PlantPhase.DEAD, begin_time: 1 }] } },
        { id: 3, plant: { phases: [{ phase: PlantPhase.SEED, begin_time: 1 }] } },
    ]);
    assert.deepEqual(classifyHarvestedLandsByMap([1, 2, 3, 4], harvestedMap), {
        removable: [1, 2],
        growing: [3],
        unknown: [4],
    });

    console.log('✅ Lv5→purple and legacy land-level mapping PASS');
    console.log('✅ 2x2 master/slave display context contract PASS');
    console.log('✅ land summary contract PASS');
    console.log('✅ current phase / lifecycle classification PASS');
    console.log('✅ harvested-land classification PASS');
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        module: 'farm-land-analyzer',
        realQqTouched: false,
        farmRpcTouched: false,
        writeOperationTouched: false,
    }, null, 2));
}

try {
    main();
} catch (error) {
    console.error('\n❌ Farm Land Analyzer Contract Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
}
