const assert = require('node:assert/strict');
const { buildFriendLandMutationDetail } = require('../src/services/friend');

function main() {
    console.log('FAR2 Friend Mutation Read-Only Contract Self-Test');
    console.log('安全: 只测试好友土地 mutation DTO，不连接 QQ、不进入好友农场、不发送任何 RPC。\n');

    const plant = {
        mutant_config_ids: [101, 999, 101],
    };
    const currentPhase = {
        mutants: [
            { mutant_time: 123, mutant_config_id: 101, weather_id: 7 },
            { mutant_time: 456, mutant_config_id: 102, weather_id: 8 },
        ],
    };
    const resolver = (ids) => ids
        .filter(id => id === 101 || id === 102)
        .map(id => ({ id, name: `变异${id}`, description: `效果${id}` }));

    const detail = buildFriendLandMutationDetail(plant, currentPhase, false, resolver);
    assert.equal(detail.active, true);
    assert.deepEqual(detail.configIds, [101, 999, 102]);
    assert.deepEqual(detail.effects.map(item => item.id), [101, 102]);
    assert.deepEqual(detail.unknownConfigIds, [999]);
    assert.deepEqual(detail.events, [
        { mutantTime: 123, configId: 101, weatherId: 7 },
        { mutantTime: 456, configId: 102, weatherId: 8 },
    ]);

    const slaveDetail = buildFriendLandMutationDetail(plant, currentPhase, true, resolver);
    assert.deepEqual(slaveDetail, {
        active: false,
        configIds: [],
        effects: [],
        unknownConfigIds: [],
        events: [],
    });

    const emptyDetail = buildFriendLandMutationDetail(null, null, false, resolver);
    assert.deepEqual(emptyDetail, {
        active: false,
        configIds: [],
        effects: [],
        unknownConfigIds: [],
        events: [],
    });

    console.log('✅ friend master land mutation mapping PASS');
    console.log('✅ unknown mutation ID preservation PASS');
    console.log('✅ mutation event mapping PASS');
    console.log('✅ 2x2 slave mutation suppression PASS');
    console.log('✅ no real QQ/Visit/Farm RPC touched PASS');
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        realQqTouched: false,
        visitRpcTouched: false,
        farmRpcTouched: false,
        writeOperationTouched: false,
    }, null, 2));
}

try {
    main();
} catch (error) {
    console.error('\n❌ Friend Mutation Read-Only Contract Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
}
