const assert = require('node:assert/strict');
const {
    classifyIdentity,
    staticItemEvidence,
    isExplicitNonSeedEvidence,
} = require('../src/services/qq-item-identity-evidence');

function main() {
    console.log('FAR2 QQ Static Non-Seed Classification Self-Test');
    console.log('安全: 纯函数 fixture，不读 QQ、不联网、不发送 RPC。\n');

    const fertilizer = { id: 80001, name: '化肥(1小时)', type: 7, interaction_type: 'fertilizer' };
    const evidence = staticItemEvidence(fertilizer);
    assert.ok(evidence);
    assert.equal(evidence.signals.score, 0);
    assert.equal(isExplicitNonSeedEvidence(evidence), true);

    const classified = classifyIdentity(fertilizer, []);
    assert.equal(classified.classification, 'non-seed');
    assert.equal(classified.confidence, 'high');
    assert.equal(classified.reason, 'static-item-explicit-non-seed-signals');
    assert.equal(classified.name, '化肥(1小时)');
    console.log('✅ type=7 + interaction=fertilizer static item is explicit non-seed PASS');

    const incomplete = classifyIdentity({ id: 81234, name: '普通奖励', type: 6 }, []);
    assert.equal(incomplete.classification, 'unknown');
    console.log('✅ incomplete static metadata is not over-classified as non-seed PASS');

    const seed = classifyIdentity({ id: 20264, name: '红色郁金香种子', type: 5, interaction_type: 'plant' }, []);
    assert.equal(seed.classification, 'known-seed');
    console.log('✅ known static seed classification remains unchanged PASS');

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        qqCacheTouched: false,
        networkTouched: false,
        rpcTouched: false,
        plantWriteTouched: false,
    }, null, 2));
}

try {
    main();
} catch (error) {
    console.error('\n❌ Static Non-Seed Classification Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
}
