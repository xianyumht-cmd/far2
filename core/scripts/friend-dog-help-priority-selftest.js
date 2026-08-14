const assert = require('node:assert/strict');
const {
    GUARD_DOG_ID,
    normalizeCacheObject,
    compareHelpTargets,
    canContinueHelpAfterExpLimit,
    shouldRunHelpTickAfterExpLimit,
    selectHelpTargetsAfterExpLimit,
    getHelpTickDelayMs,
} = require('../src/services/friend-dog-state');

function main() {
    console.log('FAR2 Guard Dog Help Priority Self-Test');
    console.log('安全: 只测试缓存过期和帮助排序，不连接 QQ、不调用好友 RPC。\n');

    const now = 1_700_000_000;
    const cache = normalizeCacheObject({
        entries: {
            101: { gid: 101, dogId: GUARD_DOG_ID, expiresAtSec: now + 3600 },
            102: { gid: 102, dogId: 90011, expiresAtSec: now + 1800 },
            103: { gid: 103, dogId: GUARD_DOG_ID, expiresAtSec: now - 1 },
        },
    }, now);

    assert.deepEqual(Object.keys(cache).sort(), ['101', '102']);
    assert.equal(cache['101'].dogId, GUARD_DOG_ID);
    console.log('✅ expired dog cache entries are pruned PASS');

    const targets = [
        { gid: 1, dryNum: 9, weedNum: 0, insectNum: 0, hasGuardDog: false },
        { gid: 2, dryNum: 1, weedNum: 0, insectNum: 0, hasGuardDog: true },
        { gid: 3, dryNum: 4, weedNum: 1, insectNum: 0, hasGuardDog: true },
    ].sort(compareHelpTargets);

    assert.deepEqual(targets.map(item => item.gid), [3, 2, 1]);
    console.log('✅ guard dog friends sort before non-dog friends PASS');

    assert.equal(canContinueHelpAfterExpLimit(targets[0]), true);
    assert.equal(canContinueHelpAfterExpLimit(targets[2]), false);
    console.log('✅ exp-limit continuation is guard-dog only PASS');

    assert.equal(shouldRunHelpTickAfterExpLimit({ stopWhenExpLimit: false, expLimitReached: true, activeGuardDogCount: 0 }), true);
    assert.equal(shouldRunHelpTickAfterExpLimit({ stopWhenExpLimit: true, expLimitReached: false, activeGuardDogCount: 0 }), true);
    assert.equal(shouldRunHelpTickAfterExpLimit({ stopWhenExpLimit: true, expLimitReached: true, activeGuardDogCount: 0 }), false);
    assert.equal(shouldRunHelpTickAfterExpLimit({ stopWhenExpLimit: true, expLimitReached: true, activeGuardDogCount: 1 }), true);
    console.log('✅ worker exp-limit gate re-enters help only for known active guard dogs PASS');

    const selectedAfterLimit = selectHelpTargetsAfterExpLimit(targets, {
        stopWhenExpLimit: true,
        expLimitReached: true,
    });
    assert.deepEqual(selectedAfterLimit.targets.map(item => item.gid), [3, 2]);
    assert.equal(selectedAfterLimit.eligibleGuardDogCount, 2);
    assert.equal(selectedAfterLimit.skippedNonGuardDogCount, 1);

    const selectedBeforeLimit = selectHelpTargetsAfterExpLimit(targets, {
        stopWhenExpLimit: true,
        expLimitReached: false,
    });
    assert.deepEqual(selectedBeforeLimit.targets.map(item => item.gid), [3, 2, 1]);
    console.log('✅ current help targets are narrowed to guard-dog friends only after EXP cap PASS');

    assert.equal(getHelpTickDelayMs({
        baseDelayMs: 10_000,
        stopWhenExpLimit: true,
        expLimitReached: true,
        eligibleGuardDogCount: 0,
        noEligibleBackoffMs: 60_000,
    }), 60_000);
    assert.equal(getHelpTickDelayMs({
        baseDelayMs: 10_000,
        stopWhenExpLimit: true,
        expLimitReached: true,
        eligibleGuardDogCount: 1,
        noEligibleBackoffMs: 60_000,
    }), 10_000);
    assert.equal(getHelpTickDelayMs({
        baseDelayMs: 10_000,
        stopWhenExpLimit: false,
        expLimitReached: true,
        eligibleGuardDogCount: 0,
        noEligibleBackoffMs: 60_000,
    }), 10_000);
    console.log('✅ post-EXP no-target help scan backs off to 60s without changing normal cadence PASS');

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        guardDogId: GUARD_DOG_ID,
        realQqTouched: false,
        friendRpcTouched: false,
        writeOperationTouched: false,
    }, null, 2));
}

try {
    main();
} catch (error) {
    console.error('\n❌ Guard Dog Help Priority Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
}
