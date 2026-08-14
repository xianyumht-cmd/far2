const assert = require('node:assert/strict');
const {
    DEFAULT_IDLE_LOG_INTERVAL_MS,
    buildStealPatrolIdleStatus,
    shouldEmitStealPatrolStatus,
} = require('../src/services/friend-patrol-observability');

function main() {
    console.log('FAR2 Friend Patrol Observability Self-Test');
    console.log('安全: 只测试纯日志状态函数，不连接 QQ、不调用好友 RPC、不执行偷菜或帮助。\n');

    assert.equal(buildStealPatrolIdleStatus({
        enabled: false,
        targetCount: 0,
        stolenCount: 0,
        limitReached: false,
    }), null);

    assert.equal(buildStealPatrolIdleStatus({
        enabled: true,
        targetCount: 3,
        stolenCount: 1,
        limitReached: false,
    }), null);

    assert.deepEqual(buildStealPatrolIdleStatus({
        enabled: true,
        targetCount: 0,
        stolenCount: 0,
        limitReached: false,
    }), {
        key: 'no_targets',
        result: 'idle',
        message: '偷菜巡查：当前没有可偷好友',
    });

    assert.deepEqual(buildStealPatrolIdleStatus({
        enabled: true,
        targetCount: 3,
        stolenCount: 0,
        limitReached: false,
    }), {
        key: 'targets_no_success',
        result: 'no_success',
        message: '偷菜巡查：发现 3 个可偷好友，但本轮未偷到',
    });

    assert.deepEqual(buildStealPatrolIdleStatus({
        enabled: true,
        targetCount: 0,
        stolenCount: 0,
        limitReached: true,
    }), {
        key: 'limit_reached',
        result: 'limit_reached',
        message: '偷菜巡查：今日偷菜次数已达上限',
    });

    const now = 1_700_000_000_000;
    assert.equal(shouldEmitStealPatrolStatus({
        previousKey: 'no_targets',
        nextKey: 'limit_reached',
        previousAt: now - 1000,
        nowMs: now,
        intervalMs: DEFAULT_IDLE_LOG_INTERVAL_MS,
    }), true);
    assert.equal(shouldEmitStealPatrolStatus({
        previousKey: 'no_targets',
        nextKey: 'no_targets',
        previousAt: now - 60_000,
        nowMs: now,
        intervalMs: DEFAULT_IDLE_LOG_INTERVAL_MS,
    }), false);
    assert.equal(shouldEmitStealPatrolStatus({
        previousKey: 'no_targets',
        nextKey: 'no_targets',
        previousAt: now - DEFAULT_IDLE_LOG_INTERVAL_MS,
        nowMs: now,
        intervalMs: DEFAULT_IDLE_LOG_INTERVAL_MS,
    }), true);

    console.log('✅ steal idle state classification PASS');
    console.log('✅ successful steals suppress idle status PASS');
    console.log('✅ state changes log immediately PASS');
    console.log('✅ unchanged idle state is rate-limited to 5 minutes PASS');
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        realQqTouched: false,
        friendRpcTouched: false,
        stealOperationTouched: false,
        helpOperationTouched: false,
    }, null, 2));
}

try {
    main();
} catch (error) {
    console.error('\n❌ Friend Patrol Observability Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
}
