const assert = require('node:assert/strict');
const {
    getMutantEffectById,
    getMutantEffectsByIds,
} = require('../src/config/gameConfig');

function main() {
    console.log('FAR2 Mutation Read-Only Self-Test');
    console.log('安全: 只读取本地 MutantEffect 配置，不连接 QQ、不调用农场 RPC。\n');

    const frozen = getMutantEffectById(1);
    assert.ok(frozen, 'mutant effect #1 should exist');
    assert.equal(frozen.name, '冰冻');
    assert.match(frozen.description, /售价/);

    const golden = getMutantEffectById(5);
    assert.ok(golden, 'mutant effect #5 should exist');
    assert.equal(golden.name, '黄金');
    assert.equal(golden.fruit_name, '黄金果实');

    const effects = getMutantEffectsByIds([1, 5, 9999, 1]);
    assert.deepEqual(effects.map(item => item.id), [1, 5], 'known effects should be unique; unknown ids are preserved separately by land DTO');

    console.log('✅ MutantEffect metadata loads PASS');
    console.log('✅ known mutation ID mapping PASS');
    console.log('✅ duplicate/unknown lookup is fail-safe PASS');
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        knownEffects: effects.map(item => ({ id: item.id, name: item.name })),
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
