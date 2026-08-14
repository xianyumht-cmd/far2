const assert = require('node:assert/strict');
const { shouldBlockShopFallback } = require('../src/services/event-seed-shop-guard');

function main() {
    console.log('FAR2 Event Seed Shop Guard Self-Test');
    console.log('安全: 只测试纯函数，不连接 QQ、不调用背包/商店/种植 RPC。\n');

    assert.equal(shouldBlockShopFallback({ blockShopFallback: false }), false);

    assert.equal(shouldBlockShopFallback({
        blockShopFallback: true,
        unresolvedSeedIds: [],
        prioritySeedIds: [20902],
        inspection: { inventory: { unresolvedCandidates: [] } },
    }), true);
    console.log('✅ known-seed failure keeps fail-closed shop block PASS');

    assert.equal(shouldBlockShopFallback({
        blockShopFallback: true,
        unresolvedSeedIds: [20999],
        prioritySeedIds: [],
        inspection: {
            inventory: {
                unresolvedCandidates: [{
                    seedId: 20999,
                    confidence: 'high',
                    activityReferenced: false,
                }],
            },
        },
    }), true);

    assert.equal(shouldBlockShopFallback({
        blockShopFallback: true,
        unresolvedSeedIds: [20998],
        prioritySeedIds: [],
        inspection: {
            inventory: {
                unresolvedCandidates: [{
                    seedId: 20998,
                    confidence: 'medium',
                    activityReferenced: false,
                }],
            },
        },
    }), false);
    console.log('✅ high-confidence unknown blocks shop; namespace-only medium candidate does not permanently block PASS');

    assert.equal(shouldBlockShopFallback({
        blockShopFallback: true,
        unresolvedSeedIds: [20997],
        prioritySeedIds: [],
        inspection: {
            inventory: {
                unresolvedCandidates: [{
                    seedId: 20997,
                    confidence: 'medium',
                    activityReferenced: true,
                }],
            },
        },
    }), false);
    console.log('✅ generic activity reference does not upgrade a medium unresolved item into a shop-blocking seed PASS');

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        networkTouched: false,
        rpcTouched: false,
        writeOperationTouched: false,
    }, null, 2));
}

try {
    main();
} catch (error) {
    console.error('\n❌ Event Seed Shop Guard Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
}
