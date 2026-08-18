'use strict';

const process = require('node:process');

const DEFAULT_REFRESH_INTERVAL_MS = 3 * 60 * 1000;
const DEFAULT_POLL_MS = 10 * 1000;
const DEFAULT_RETRY_MS = 30 * 1000;
const DEFAULT_WORKER_STOP_TIMEOUT_MS = 2500;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function envEnabled(value, fallback = true) {
    const text = String(value == null ? '' : value).trim().toLowerCase();
    if (!text) return fallback;
    if (['0', 'false', 'off', 'no'].includes(text)) return false;
    if (['1', 'true', 'on', 'yes'].includes(text)) return true;
    return fallback;
}

function createWechatRecoveryManager(options = {}) {
    const {
        store,
        workers,
        startWorker,
        stopWorker,
        log,
        addAccountLog,
        provider,
        processRef = process,
    } = options;

    if (!store || !workers || typeof startWorker !== 'function' || typeof stopWorker !== 'function') {
        throw new Error('WechatRecoveryManager runtime dependencies are incomplete');
    }
    if (!provider || typeof provider.refresh !== 'function') {
        throw new Error('WechatRecoveryManager requires a WeChat Code provider');
    }

    const refreshIntervalMs = Math.max(
        30 * 1000,
        Number(processRef.env.FARM_WECHAT_CODE_REFRESH_INTERVAL_MS) || DEFAULT_REFRESH_INTERVAL_MS,
    );
    const pollMs = Math.max(
        1000,
        Number(processRef.env.FARM_WECHAT_CODE_REFRESH_POLL_MS) || DEFAULT_POLL_MS,
    );
    const retryMs = Math.max(
        5000,
        Number(processRef.env.FARM_WECHAT_CODE_REFRESH_RETRY_MS) || DEFAULT_RETRY_MS,
    );
    const workerStopTimeoutMs = Math.max(
        500,
        Number(processRef.env.FARM_WECHAT_CODE_WORKER_STOP_TIMEOUT_MS) || DEFAULT_WORKER_STOP_TIMEOUT_MS,
    );

    const nextRefreshAt = new Map();
    const pendingReason = new Map();
    const inFlight = new Map();
    const lastState = new Map();
    let timer = null;
    let started = false;

    function enabled() {
        return processRef.platform === 'win32'
            && envEnabled(processRef.env.FARM_WECHAT_CODE_AUTO_REFRESH, true);
    }

    function getAccounts() {
        const data = store.getAccounts();
        return Array.isArray(data && data.accounts) ? data.accounts : [];
    }

    function getAccount(accountId) {
        const id = String(accountId || '').trim();
        return getAccounts().find(account => String(account.id || '') === id) || null;
    }

    function isConfigured(account) {
        if (!account) return false;
        if (String(account.platform || '').toLowerCase() !== 'wx') return false;
        if (account.codeRefreshEnabled !== true) return false;
        const mode = String(account.codeRefreshMode || 'windows_wechat').toLowerCase();
        return mode === 'windows_wechat' || mode === 'windows_session';
    }

    function configuredAccounts() {
        return getAccounts().filter(isConfigured);
    }

    function setState(accountId, state, extra = {}) {
        const id = String(accountId || '').trim();
        if (!id) return;
        lastState.set(id, {
            state,
            updatedAt: Date.now(),
            ...extra,
        });
    }

    function scheduleRetry(accountId, reason) {
        const id = String(accountId || '').trim();
        pendingReason.set(id, String(reason || 'retry'));
        nextRefreshAt.set(id, Date.now() + retryMs);
    }

    async function waitWorkerStopped(accountId) {
        const id = String(accountId || '').trim();
        const deadline = Date.now() + workerStopTimeoutMs;
        while (Date.now() < deadline) {
            if (!workers[id]) return true;
            await sleep(100);
        }
        return !workers[id];
    }

    async function refreshAccount(accountId, reason = 'scheduled') {
        const id = String(accountId || '').trim();
        if (!id) return { ok: false, reason: 'missing_account_id' };
        if (!enabled()) return { ok: false, reason: 'wechat_auto_refresh_disabled' };
        if (inFlight.has(id)) return inFlight.get(id);

        const task = (async () => {
            const account = getAccount(id);
            if (!isConfigured(account)) return { ok: false, reason: 'wechat_account_not_configured' };
            const displayName = account.name || id;

            if (typeof provider.getAvailability === 'function') {
                const availability = await provider.getAvailability(account);
                if (!availability || availability.available !== true) {
                    const why = availability && availability.reason ? availability.reason : 'wechat_provider_not_ready';
                    setState(id, 'waiting_provider', { reason: why, trigger: reason });
                    scheduleRetry(id, reason);
                    addAccountLog(
                        'wechat_code_refresh_waiting_provider',
                        `等待 Windows 微信 Code Provider (${why})`,
                        id,
                        displayName,
                        { reason, provider: provider.name || 'windows_wechat_runtime' },
                    );
                    return { ok: false, reason: why, state: 'waiting_provider' };
                }
            }

            const wasRunning = !!workers[id];
            setState(id, 'refreshing', { reason, provider: provider.name || 'windows_wechat_runtime' });
            addAccountLog(
                'wechat_code_refresh_start',
                `开始刷新微信 Farm Code (${reason})`,
                id,
                displayName,
                { reason, provider: provider.name || 'windows_wechat_runtime' },
            );

            try {
                // Always acquire the fresh Code before touching the currently running worker.
                const result = await provider.refresh({ account, reason });
                const freshCode = String(result && result.code || '').trim();
                if (!freshCode) {
                    const err = new Error('WeChat Provider 未返回 fresh Code');
                    err.code = 'wechat_provider_empty_code';
                    throw err;
                }

                if (wasRunning) {
                    stopWorker(id);
                    const stopped = await waitWorkerStopped(id);
                    if (!stopped) {
                        const err = new Error('旧微信 worker 停止超时，拒绝替换会话');
                        err.code = 'wechat_worker_stop_timeout';
                        throw err;
                    }
                }

                const refreshedAt = Date.now();
                const update = {
                    id,
                    code: freshCode,
                    platform: 'wx',
                    codeRefreshEnabled: true,
                    codeRefreshMode: 'windows_wechat',
                    lastCodeRefreshAt: refreshedAt,
                    lastCodeRefreshOk: true,
                    lastCodeRefreshError: '',
                    lastCodeRefreshReason: reason,
                    lastCodeSource: result.source || provider.name || 'windows_wechat_runtime',
                };
                if (result.clientVersion) update.clientVersion = String(result.clientVersion);
                if (result.gatewayVersion) update.gatewayVersion = String(result.gatewayVersion);
                if (Number(result.wmpfVersion) > 0) update.wmpfVersion = Number(result.wmpfVersion);
                if (Number.isFinite(Number(result.windowsSessionId)) && Number(result.windowsSessionId) >= 0) {
                    update.windowsSessionId = Number(result.windowsSessionId);
                }
                if (result.profileId) update.wechatProfileId = String(result.profileId);
                if (result.appId) update.wechatAppId = String(result.appId);

                store.addOrUpdateAccount(update);
                const updated = getAccount(id) || { ...account, ...update };
                const startedNow = startWorker(updated);

                pendingReason.delete(id);
                nextRefreshAt.set(id, refreshedAt + refreshIntervalMs);
                setState(id, 'ready', {
                    reason: 'refresh_ok',
                    provider: provider.name || 'windows_wechat_runtime',
                    refreshedAt,
                });
                addAccountLog(
                    'wechat_code_refresh_ok',
                    '微信 Farm Code 刷新成功',
                    id,
                    displayName,
                    { reason, restarted: !!startedNow, provider: provider.name || 'windows_wechat_runtime' },
                );
                return { ok: true, restarted: !!startedNow, reason };
            } catch (err) {
                const message = err && err.message ? err.message : String(err || 'unknown');
                const errorCode = err && err.code ? String(err.code) : 'wechat_provider_failed';
                store.addOrUpdateAccount({
                    id,
                    lastCodeRefreshAt: Date.now(),
                    lastCodeRefreshOk: false,
                    lastCodeRefreshError: message,
                    lastCodeRefreshReason: reason,
                });
                scheduleRetry(id, reason);
                setState(id, 'provider_error', { reason: errorCode, message });
                log('错误', `微信账号 ${displayName} Code 刷新失败: ${message}`, {
                    accountId: id,
                    accountName: displayName,
                    platform: 'wx',
                });
                addAccountLog(
                    'wechat_code_refresh_failed',
                    `微信 Farm Code 刷新失败: ${message}`,
                    id,
                    displayName,
                    { reason, errorCode, provider: provider.name || 'windows_wechat_runtime' },
                );
                return { ok: false, reason: errorCode, message };
            }
        })().finally(() => inFlight.delete(id));

        inFlight.set(id, task);
        return task;
    }

    function triggerRefresh(accountId, reason = 'manual') {
        const account = getAccount(accountId);
        if (!enabled() || !isConfigured(account)) return false;
        const id = String(account.id || '');
        pendingReason.set(id, String(reason || 'manual'));
        nextRefreshAt.set(id, Date.now());
        refreshAccount(id, reason).catch(() => null);
        return true;
    }

    function handleAccountLog(entry) {
        if (!entry || !entry.accountId) return;
        const account = getAccount(entry.accountId);
        if (!isConfigured(account) || !enabled()) return;
        const action = String(entry.action || '');
        if (action === 'ws_400') {
            triggerRefresh(account.id, 'ws_400');
            return;
        }
        if (action === 'kickout_stop') {
            const kickReason = String(entry.reason || '未知');
            if (/版本过低|客户端版本/i.test(kickReason)) return;
            triggerRefresh(account.id, `kickout:${kickReason}`);
        }
    }

    function tick() {
        if (!enabled()) return;
        const now = Date.now();
        for (const account of configuredAccounts()) {
            const id = String(account.id || '');
            if (!id || inFlight.has(id)) continue;
            let due = Number(nextRefreshAt.get(id) || 0);
            if (!due) {
                due = now + refreshIntervalMs;
                nextRefreshAt.set(id, due);
                setState(id, 'scheduled', { nextRefreshAt: due });
                continue;
            }
            if (now >= due) {
                refreshAccount(id, pendingReason.get(id) || 'scheduled').catch(() => null);
            }
        }
    }

    function start() {
        if (started) return;
        started = true;
        const now = Date.now();
        const accounts = configuredAccounts();
        for (const account of accounts) {
            const id = String(account.id || '');
            nextRefreshAt.set(id, now + refreshIntervalMs);
            setState(id, enabled() ? 'scheduled' : 'configured', { nextRefreshAt: now + refreshIntervalMs });
        }
        if (accounts.length) {
            log('系统', `Windows 微信恢复管理已启用：${accounts.length} 个账号，Provider=${provider.name || 'windows_wechat_runtime'}`);
        }
        timer = setInterval(tick, pollMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
        started = false;
    }

    function getStatus() {
        const accounts = configuredAccounts();
        return {
            started,
            enabled: started && enabled(),
            provider: provider.name || 'windows_wechat_runtime',
            refreshIntervalMs,
            pollMs,
            retryMs,
            configuredCount: accounts.length,
            accounts: accounts.map(account => {
                const id = String(account.id || '');
                return {
                    accountId: id,
                    accountName: account.name || id,
                    platform: 'wx',
                    nextRefreshAt: Number(nextRefreshAt.get(id) || 0),
                    refreshing: inFlight.has(id),
                    pendingReason: pendingReason.get(id) || '',
                    state: lastState.get(id) || null,
                };
            }),
        };
    }

    return {
        start,
        stop,
        tick,
        refreshAccount,
        triggerRefresh,
        handleAccountLog,
        getStatus,
    };
}

module.exports = {
    createWechatRecoveryManager,
};
