const process = require('node:process');
const desktopSessions = require('./desktop-session-registry');

const DEFAULT_REFRESH_INTERVAL_MS = 3 * 60 * 1000;
const DEFAULT_POLL_MS = 10 * 1000;
const DEFAULT_RETRY_MS = 30 * 1000;

function createUnavailableProvider() {
    return {
        name: 'targeted_provider_pending',
        async getAvailability(_account, binding) {
            if (!binding) return { available: false, reason: 'desktop_session_not_bound' };
            if (binding.status !== 'online' || binding.needsRebind) {
                return { available: false, reason: 'desktop_session_offline' };
            }
            return { available: false, reason: 'targeted_provider_unavailable' };
        },
        async refresh() {
            const err = new Error('当前没有可用的多 QQ 定向 Code Provider');
            err.code = 'targeted_provider_unavailable';
            throw err;
        },
    };
}

function createCodeManager(options = {}) {
    const {
        store,
        workers,
        startWorker,
        stopWorker,
        log,
        addAccountLog,
        processRef = process,
        codeRefreshProvider = null,
    } = options;

    const provider = codeRefreshProvider || createUnavailableProvider();
    const refreshIntervalMs = Math.max(
        30 * 1000,
        Number(processRef.env.FARM_CODE_REFRESH_INTERVAL_MS) || DEFAULT_REFRESH_INTERVAL_MS,
    );
    const pollMs = Math.max(
        1000,
        Number(processRef.env.FARM_CODE_REFRESH_POLL_MS) || DEFAULT_POLL_MS,
    );
    const retryMs = Math.max(
        5000,
        Number(processRef.env.FARM_CODE_REFRESH_RETRY_MS) || DEFAULT_RETRY_MS,
    );

    let timer = null;
    let started = false;
    let warnedProvider = false;
    const nextRefreshAt = new Map();
    const inFlight = new Map();
    const lastTriggerAt = new Map();
    const pendingReason = new Map();
    const lastState = new Map();

    function getAccountsList() {
        const data = store.getAccounts();
        return Array.isArray(data && data.accounts) ? data.accounts : [];
    }

    function getAccountById(accountId) {
        const id = String(accountId || '').trim();
        if (!id) return null;
        return getAccountsList().find(acc => String(acc.id || '') === id) || null;
    }

    function getDesktopSnapshot() {
        try {
            return desktopSessions.getStatus();
        } catch {
            return { bindings: [], runtimeSessions: [] };
        }
    }

    function getBindingForAccount(accountId, snapshot = getDesktopSnapshot()) {
        const id = String(accountId || '').trim();
        return (snapshot.bindings || []).find(item => String(item.accountId || '') === id) || null;
    }

    function isGlobalEnabled() {
        return processRef.platform === 'win32'
            && String(processRef.env.FARM_CODE_AUTO_REFRESH || '0') === '1';
    }

    function isAccountConfigured(account) {
        if (!account) return false;
        return String(account.platform || 'qq').toLowerCase() === 'qq'
            && account.codeRefreshEnabled === true
            && String(account.codeRefreshMode || 'windows_session').toLowerCase() === 'windows_session';
    }

    function getManagedAccounts(snapshot = getDesktopSnapshot()) {
        if (!isGlobalEnabled()) return [];
        return getAccountsList()
            .filter(isAccountConfigured)
            .map(account => ({
                account,
                binding: getBindingForAccount(account.id, snapshot),
            }));
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

    async function providerAvailability(account, binding) {
        if (!binding) return { available: false, reason: 'desktop_session_not_bound' };
        if (binding.status !== 'online' || binding.needsRebind) {
            return { available: false, reason: 'desktop_session_offline' };
        }
        if (!provider || typeof provider.refresh !== 'function') {
            return { available: false, reason: 'targeted_provider_unavailable' };
        }
        if (typeof provider.getAvailability === 'function') {
            try {
                const result = await provider.getAvailability(account, binding);
                if (result && typeof result === 'object') return result;
            } catch (err) {
                return {
                    available: false,
                    reason: err && err.code ? err.code : (err && err.message ? err.message : 'provider_availability_failed'),
                };
            }
        }
        return { available: true, reason: 'ok' };
    }

    function scheduleRetry(accountId, reason) {
        const id = String(accountId || '').trim();
        if (!id) return;
        pendingReason.set(id, String(reason || 'retry'));
        nextRefreshAt.set(id, Date.now() + retryMs);
    }

    async function refreshAccount(accountId, reason = 'scheduled') {
        const id = String(accountId || '').trim();
        if (!id) return { ok: false, reason: 'missing_account_id' };
        if (!isGlobalEnabled()) return { ok: false, reason: 'auto_refresh_disabled' };
        if (inFlight.has(id)) return inFlight.get(id);

        const task = (async () => {
            const account = getAccountById(id);
            if (!account) return { ok: false, reason: 'account_not_found' };
            if (!isAccountConfigured(account)) return { ok: false, reason: 'account_not_configured' };

            const snapshot = getDesktopSnapshot();
            const binding = getBindingForAccount(id, snapshot);
            const availability = await providerAvailability(account, binding);
            const displayName = account.name || id;

            if (!availability.available) {
                const state = availability.reason === 'desktop_session_offline' || availability.reason === 'desktop_session_not_bound'
                    ? 'waiting_session'
                    : 'waiting_provider';
                setState(id, state, {
                    reason: availability.reason,
                    trigger: reason,
                    qqUin: binding ? String(binding.qqUin || '') : '',
                });
                scheduleRetry(id, reason);

                if (state === 'waiting_provider' && !warnedProvider) {
                    warnedProvider = true;
                    log('系统', `CodeManager 已进入多账号 Session 调度模式，但当前没有可用的定向 Code Provider；不会回退到全局 QQ 选择器`, {
                        accountId: id,
                        accountName: displayName,
                    });
                }

                addAccountLog(
                    state === 'waiting_session' ? 'code_refresh_waiting_session' : 'code_refresh_waiting_provider',
                    state === 'waiting_session'
                        ? `等待对应 Windows QQ Session 上线 (${availability.reason})`
                        : `等待定向 Code Provider (${availability.reason})`,
                    id,
                    displayName,
                    { reason, provider: provider.name || 'unknown' },
                );
                return { ok: false, reason: availability.reason, state };
            }

            const wasRunning = !!workers[id];
            setState(id, 'refreshing', {
                reason,
                provider: provider.name || 'unknown',
                qqUin: binding ? String(binding.qqUin || '') : '',
            });
            addAccountLog('code_refresh_start', `开始刷新 Farm Code (${reason})`, id, displayName, {
                reason,
                provider: provider.name || 'unknown',
            });

            try {
                const result = await provider.refresh({
                    account,
                    binding,
                    reason,
                });
                const freshCode = String(result && result.code || '').trim();
                if (!freshCode) {
                    const err = new Error('Provider 未返回 fresh Code');
                    err.code = 'provider_empty_code';
                    throw err;
                }

                if (wasRunning) {
                    stopWorker(id);
                }

                const refreshedAt = Date.now();
                store.addOrUpdateAccount({
                    id,
                    code: freshCode,
                    lastCodeRefreshAt: refreshedAt,
                    lastCodeRefreshOk: true,
                    lastCodeRefreshError: '',
                    lastCodeRefreshReason: reason,
                    lastCodeSource: result.source || provider.name || 'session_provider',
                });

                const updated = getAccountById(id);
                const startedNow = startWorker(updated || { ...account, code: freshCode });
                pendingReason.delete(id);
                nextRefreshAt.set(id, refreshedAt + refreshIntervalMs);
                setState(id, 'ready', {
                    reason: 'refresh_ok',
                    provider: provider.name || 'unknown',
                    refreshedAt,
                });

                addAccountLog('code_refresh_ok', 'Farm Code 刷新成功', id, displayName, {
                    reason,
                    provider: provider.name || 'unknown',
                    restarted: !!startedNow,
                });
                return { ok: true, restarted: !!startedNow, reason };
            } catch (err) {
                const message = err && err.message ? err.message : String(err || 'unknown');
                const errorCode = err && err.code ? String(err.code) : 'provider_failed';
                store.addOrUpdateAccount({
                    id,
                    lastCodeRefreshAt: Date.now(),
                    lastCodeRefreshOk: false,
                    lastCodeRefreshError: message,
                    lastCodeRefreshReason: reason,
                });
                scheduleRetry(id, reason);
                setState(id, 'provider_error', {
                    reason: errorCode,
                    message,
                    provider: provider.name || 'unknown',
                });
                log('错误', `CodeManager 刷新账号 ${displayName} 失败: ${message}`, {
                    accountId: id,
                    accountName: displayName,
                });
                addAccountLog('code_refresh_failed', `Farm Code 刷新失败: ${message}`, id, displayName, {
                    reason,
                    provider: provider.name || 'unknown',
                    errorCode,
                });
                return { ok: false, reason: errorCode, message };
            }
        })().finally(() => {
            inFlight.delete(id);
        });

        inFlight.set(id, task);
        return task;
    }

    function triggerRefresh(accountId, reason) {
        const id = String(accountId || '').trim();
        const account = getAccountById(id);
        if (!id || !isGlobalEnabled() || !isAccountConfigured(account)) return false;

        const now = Date.now();
        const last = Number(lastTriggerAt.get(id) || 0);
        if (now - last < 5000 && inFlight.has(id)) return true;
        lastTriggerAt.set(id, now);
        pendingReason.set(id, String(reason || 'manual'));
        nextRefreshAt.set(id, now);
        refreshAccount(id, reason).catch(() => null);
        return true;
    }

    function handleAccountLog(entry) {
        if (!entry || !entry.accountId) return;
        const id = String(entry.accountId || '');
        const account = getAccountById(id);
        if (!isGlobalEnabled() || !isAccountConfigured(account)) return;

        const action = String(entry.action || '');
        if (action === 'ws_400') {
            triggerRefresh(id, 'ws_400');
            return;
        }
        if (action === 'kickout_stop') {
            const kickReason = String(entry.reason || '未知');
            if (/版本过低|客户端版本/i.test(kickReason)) return;
            triggerRefresh(id, `kickout:${kickReason}`);
        }
    }

    function tick() {
        const snapshot = getDesktopSnapshot();
        const managed = getManagedAccounts(snapshot);
        const now = Date.now();

        for (const { account, binding } of managed) {
            const id = String(account.id || '');
            if (!id || inFlight.has(id)) continue;

            if (!binding || binding.status !== 'online' || binding.needsRebind) {
                setState(id, 'waiting_session', {
                    reason: binding ? 'desktop_session_offline' : 'desktop_session_not_bound',
                });
                continue;
            }

            let due = Number(nextRefreshAt.get(id) || 0);
            if (!due) {
                due = now + refreshIntervalMs;
                nextRefreshAt.set(id, due);
                setState(id, 'scheduled', { nextRefreshAt: due });
                continue;
            }

            if (now >= due) {
                const reason = pendingReason.get(id) || 'scheduled';
                refreshAccount(id, reason).catch(() => null);
            }
        }
    }

    function start() {
        if (started) return;
        started = true;

        const snapshot = getDesktopSnapshot();
        const managed = getManagedAccounts(snapshot);
        const now = Date.now();
        for (const { account, binding } of managed) {
            const id = String(account.id || '');
            nextRefreshAt.set(id, now + refreshIntervalMs);
            setState(id, binding && binding.status === 'online' && !binding.needsRebind ? 'scheduled' : 'waiting_session', {
                nextRefreshAt: now + refreshIntervalMs,
            });
        }

        if (managed.length) {
            log('系统', `CodeManager 多账号 Session 调度已启用：${managed.length} 个账号，Provider=${provider.name || 'unknown'}`);
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
        const snapshot = getDesktopSnapshot();
        const managed = getManagedAccounts(snapshot);
        return {
            enabled: started && isGlobalEnabled(),
            provider: provider.name || 'unknown',
            refreshIntervalMs,
            pollMs,
            retryMs,
            accounts: managed.map(({ account, binding }) => {
                const id = String(account.id || '');
                return {
                    accountId: id,
                    accountName: account.name || id,
                    qqUin: binding ? String(binding.qqUin || '') : '',
                    sessionStatus: binding ? binding.status : 'unbound',
                    needsRebind: binding ? !!binding.needsRebind : true,
                    nextRefreshAt: Number(nextRefreshAt.get(id) || 0),
                    refreshing: inFlight.has(id),
                    pendingReason: pendingReason.get(id) || '',
                    state: lastState.get(id) || { state: 'idle', updatedAt: 0 },
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
    createCodeManager,
};
