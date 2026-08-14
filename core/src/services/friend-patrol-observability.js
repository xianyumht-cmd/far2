const DEFAULT_IDLE_LOG_INTERVAL_MS = 5 * 60 * 1000;

function buildStealPatrolIdleStatus(options = {}) {
    const enabled = options.enabled === true;
    const targetCount = Math.max(0, Number.parseInt(options.targetCount, 10) || 0);
    const stolenCount = Math.max(0, Number.parseInt(options.stolenCount, 10) || 0);
    const limitReached = options.limitReached === true;

    if (!enabled || stolenCount > 0) return null;
    if (limitReached) {
        return {
            key: 'limit_reached',
            result: 'limit_reached',
            message: '偷菜巡查：今日偷菜次数已达上限',
        };
    }
    if (targetCount <= 0) {
        return {
            key: 'no_targets',
            result: 'idle',
            message: '偷菜巡查：当前没有可偷好友',
        };
    }
    return {
        key: 'targets_no_success',
        result: 'no_success',
        message: `偷菜巡查：发现 ${targetCount} 个可偷好友，但本轮未偷到`,
    };
}

function shouldEmitStealPatrolStatus(options = {}) {
    const previousKey = String(options.previousKey || '');
    const nextKey = String(options.nextKey || '');
    if (!nextKey) return false;
    if (nextKey !== previousKey) return true;

    const nowMs = Math.max(0, Number(options.nowMs) || 0);
    const previousAt = Math.max(0, Number(options.previousAt) || 0);
    const intervalMs = Math.max(
        1000,
        Number.parseInt(options.intervalMs, 10) || DEFAULT_IDLE_LOG_INTERVAL_MS,
    );
    return previousAt <= 0 || nowMs - previousAt >= intervalMs;
}

module.exports = {
    DEFAULT_IDLE_LOG_INTERVAL_MS,
    buildStealPatrolIdleStatus,
    shouldEmitStealPatrolStatus,
};
