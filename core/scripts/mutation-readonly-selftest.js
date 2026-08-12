const assert = require('node:assert/strict');
const {
    getMutantEffectById,
    getMutantEffectsByIds,
} = require('../src/config/gameConfig');
const { buildMutationDetail } = require('../src/services/farm-mutation');

function main() {
    console.log('FAR2 Mutation Read-Only Self-Test');
    console.log('安全: 只读取本地变异配置并测试纯 DTO 映射，不连接 QQ、不调用农场 RPC。\n');

    const frozen = getMutantEffectById(1);
    assert.ok(frozen, 'mutant effect #1 should exist');
    assert.equal(frozen.name, '冰冻');
    assert.match(frozen.description, /售价/);

    const golden = getMutantEffectById(5);
    assert.ok(golden, 'mutant effect #5 should exist');
    assert.equal(golden.name, '黄金');
    assert.equal(golden.fruit_name, '黄金果实');

    const effects = getMutantEffectsByIds([1, 5, 9999, 1]);
    assert.deepEqual(effects.map(item => item.id), [1, 5], 'known effects should be unique');

    const mutation = buildMutationDetail({
        mutant_config_ids: [1, 9999, 1],
    }, {
        mutants: [
            { mutant_time: 123456, mutant_config_id: 5, weather_id: 7 },
        ],
    }, getMutantEffectsByIds);

    assert.equal(mutation.active, true);
    assert.deepEqual(mutation.configIds, [1, 9999, 5]);
    assert.deepEqual(mutation.effects.map(item => item.id), [1, 5]);
    assert.deepEqual(mutation.unknownConfigIds, [9999]);
    assert.deepEqual(mutation.events, [{ mutantTime: 123456, configId: 5, weatherId: 7 }]);

    const empty = buildMutationDetail({}, {}, getMutantEffectsByIds);
    assert.equal(empty.active, false);
    assert.deepEqual(empty.configIds, []);

    console.log('✅ MutantEffect metadata loads PASS');
    console.log('✅ known/unknown mutation IDs stay distinguishable PASS');
    console.log('✅ current-phase mutation events normalize PASS');
    console.log('✅ empty plant mutation state remains inactive PASS');
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        mutation,
        realQqTouched: false,
        realFarmRpcTouched: false,
        writeOperationTouched: false,
    }, null, 2));
}

try {
    main();
} catch (error) {
    console.error('\n❌ Mutation Read-Only Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
}
