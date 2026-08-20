const process = require('node:process');
const desktopSessions = require('./desktop-session-registry');

const DEFAULT_REFRESH_INTERVAL_MS = 3 * 60 * 1000;
const DEFAULT_POLL_MS = 10 * 1000;
const DEFAULT_RETRY_MS = 30 * 1000;
const DEFAULT_WORKER_STOP_TIMEOUT_MS = 2500;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeUin(value) {
    const text = String(value || '').trim();
    return /^\d{5,12}$/.test(text) ? text : '';
}

function maskUin(uin) {
    const text = String(uin || '').trim();
    if (!text) return '';
    if (text.length <= 4) return '****';
    return `${text.slice(0, 2)}****${text.slice(-2)}`;
}

function envFlagEnabled(value, defaultValue = true) {
    const text = String(value == null ? '' : value).trim().toLowerCase();
    if (!text) return defaultValue;
    if (['0', 'false', 'off', 'no'].includes(text)) return false;
    if (['1', 'true', 'on', 'yes'].includes(text)) return true;
    return defaultValue;
}

function getSessionIdentity(account, binding) {
    const expectedUin = normalizeUin(account && (account.uin || account.qq));
    const boundUin = normalizeUin(binding && binding.qqUin);

    if (!expectedUin) {
        return {
            ok: false,
            reason: 'account_uin_missing',
            expectedUin: '',
            boundUin,
        };
    }
    if (!boundUin) {
        return {
            ok: false,
            reason: 'session_identity_unverified',
            expectedUin,
            boundUin: '',
        };
    }
    if (expectedUin !== boundUin) {
        return {
            ok: false,
            reason: 'session_identity_mismatch',
            expectedUin,
            boundUin,
        };
    }

    return {
        ok: true,
        reason: 'ok',
        expectedUin,
        boundUin,
    };
}

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
        desktopSessionRegistry = desktopSessions,
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
    const workerStopTimeoutMs = Math.max(
        500,
        Number(processRef.env.FARM_CODE_WORKER_STOP_TIMEOUT_MS) || DEFAULT_WORKER_STOP_TIMEOUT_MS,
    );
    const scheduledRefreshEnabled = envFlagEnabled(
        processRef.env.FARM_CODE_SCHEDULED_REFRESH,
        true,
    );

    let timer = null;
    let started = false;
    let warnedProvider = false;
    let lastDesktopSnapshot = { bindings: [], runtimeSessions: [] };
    let lastDesktopSnapshotAt = 0;
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

    function normalizeDesktopSnapshot(snapshot) {
        const raw = snapshot && typeof snapshot === 'object' ? snapshot : {};
        return {
            bindings: Array.isArray(raw.bindings) ? raw.bindings : [],
            runtimeSessions: Array.isArray(raw.runtimeSessions) ? raw.runtimeSessions : [],
        };
    }

    function getDesktopSnapshot() {
        try {
            lastDesktopSnapshot = normalizeDesktopSnapshot(desktopSessionRegistry.getStatus());
            lastDesktopSnapshotAt = Date.now();
        } catch {
            // Keep the last known snapshot. Recovery remains fail-closed if it is empty/stale.
        }
        return lastDesktopSnapshot;
    }

    function getCachedDesktopSnapshot() {
        return lastDesktopSnapshot;
    }

    function getBindingForAccount(accountId, snapshot = getCachedDesktopSnapshot()) {
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

    function getConfiguredAccountList() {
        return getAccountsList().filter(isAccountConfigured);
    }

    function getConfiguredAccounts(snapshot = getCachedDesktopSnapshot()) {
        return getConfiguredAccountList().map(account => ({
            account,
            binding: getBindingForAccount(account.id, snapshot),
        }));
    }

    function getManagedAccounts(snapshot = getCachedDesktopSnapshot()) {
        if (!isGlobalEnabled()) return [];
        return getConfiguredAccounts(snapshot);
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

        const identity = getSessionIdentity(account, binding);
        if (!identity.ok) {
            return {
                available: false,
                reason: identity.reason,
                expectedUin: maskUin(identity.expectedUin),
                boundUin: maskUin(identity.boundUin),
            };
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

    async function waitWorkerStopped(accountId, timeoutMs = workerStopTimeoutMs) {
        const id = String(accountId || '').trim();
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (!workers[id]) return true;
            await sleep(100);
        }
        return !workers[id];
    }

    async function refreshAccount(accountId, reason = 'scheduled', snapshotOverride = null) {
        const id = String(accountId || '').trim();
        if (!id) return { ok: false, reason: 'missing_account_id' };
        if (!isGlobalEnabled()) return { ok: false, reason: 'auto_refresh_disabled' };
        if (inFlight.has(id)) return inFlight.get(id);

        const task = (async () => {
            const account = getAccountById(id);
            if (!account) return { ok: false, reason: 'account_not_found' };
            if (!isAccountConfigured(account)) return { ok: false, reason: 'account_not_configured' };

            const snapshot = snapshotOverride || getDesktopSnapshot();
            if (snapshotOverride) {
                lastDesktopSnapshot = normalizeDesktopSnapshot(snapshotOverride);
                lastDesktopSnapshotAt = Date.now();
            }
            const binding = getBindingForAccount(id, snapshot);
            const availability = await providerAvailability(account, binding);
            const displayName = account.name || id;

            if (!availability.available) {
                let state = 'waiting_provider';
                if (availability.reason === 'desktop_session_offline' || availability.reason === 'desktop_session_not_bound') {
                    state = 'waiting_session';
                } else if (
                    availability.reason === 'session_identity_mismatch'
                    || availability.reason === 'session_identity_unverified'
                    || availability.reason === 'account_uin_missing'
                ) {
                    state = 'session_mismatch';
                }

                setState(id, state, {
                    reason: availability.reason,
                    trigger: reason,
                    qqUin: binding ? maskUin(binding.qqUin) : '',
                    expectedUin: availability.expectedUin || maskUin(account.uin || account.qq),
                    boundUin: availability.boundUin || (binding ? maskUin(binding.qqUin) : ''),
                });
                scheduleRetry(id, reason);

                if (state === 'waiting_provider' && !warnedProvider) {
                    warnedProvider = true;
                    log('系统', 'CodeManager 已进入多账号 Session 调度模式，但当前没有可用的定向 Code Provider；不会回退到全局 QQ 选择器', {
                        accountId: id,
                        accountName: displayName,
                    });
                }

                if (state === 'session_mismatch') {
                    const expected = availability.expectedUin || maskUin(account.uin || account.qq);
                    const bound = availability.boundUin || (binding ? maskUin(binding.qqUin) : '');
                    log('错误', `CodeManager 拒绝刷新账号 ${displayName}: Session 身份校验失败 (${availability.reason})`, {
                        accountId: id,
                        accountName: displayName,
                        expectedUin: expected,
                        boundUin: bound,
                    });
                    addAccountLog(
                        'code_refresh_session_mismatch',
                        `拒绝刷新：账号与 Windows QQ Session 身份不一致 (${availability.reason})`,
                        id,
                        displayName,
                        { reason, expectedUin: expected, boundUin: bound },
                    );
                } else {
                    addAccountLog(
                        state === 'waiting_session' ? 'code_refresh_waiting_session' : 'code_refresh_waiting_provider',
                        state === 'waiting_session'
                            ? `等待对应 Windows QQ Session 上线 (${availability.reason})`
                            : `等待定向 Code Provider (${availability.reason})`,
                        id,
                        displayName,
                        { reason, provider: provider.name || 'unknown' },
                    );
                }
                return { ok: false, reason: availability.reason, state };
            }

            const wasRunning = !!workers[id];
            setState(id, 'refreshing', {
                reason,
                provider: provider.name || 'unknown',
                qqUin: binding ? maskUin(binding.qqUin) : '',
            });
            addAccountLog('code_refresh_start', `开始刷新 Farm Code (${reason})`, id, displayName, {
                reason,
                provider: provider.name || 'unknown',
            });

            let workerStoppedForRefresh = false;
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
                    workerStoppedForRefresh = true;
                    const stopped = await waitWorkerStopped(id);
                    if (!stopped) {
                        const err = new Error('旧 worker 停止超时，拒绝启动新会话');
                        err.code = 'worker_stop_timeout';
                        throw err;
                    }
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
                if (scheduledRefreshEnabled) {
                    nextRefreshAt.set(id, refreshedAt + refreshIntervalMs);
                } else {
                    nextRefreshAt.delete(id);
                }
                setState(id, 'ready', {
                    reason: 'refresh_ok',
                    provider: provider.name || 'unknown',
                    refreshedAt,
                    nextRefreshAt: scheduledRefreshEnabled ? refreshedAt + refreshIntervalMs : 0,
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

                if (wasRunning && workerStoppedForRefresh && !workers[id]) {
                    try {
                        startWorker(getAccountById(id) || account);
                    } catch {
                        // keep the provider error as the primary failure
                    }
                }

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
        if (!isGlobalEnabled()) return;

        const accounts = getConfiguredAccountList();
        const now = Date.now();
        const dueAccounts = [];

        for (const account of accounts) {
            const id = String(account.id || '');
            if (!id || inFlight.has(id)) continue;

            const pending = pendingReason.has(id);
            let due = Number(nextRefreshAt.get(id) || 0);

            if (!due) {
                if (scheduledRefreshEnabled) {
                    due = now + refreshIntervalMs;
                    nextRefreshAt.set(id, due);
                    if (!lastState.has(id)) {
                        setState(id, 'scheduled', { nextRefreshAt: due });
                    }
                } else if (!lastState.has(id)) {
                    setState(id, 'ready', {
                        reason: 'event_only',
                        nextRefreshAt: 0,
                    });
                }
                continue;
            }

            if (now >= due && (pending || scheduledRefreshEnabled)) {
                dueAccounts.push(account);
            }
        }

        if (!dueAccounts.length) return;

        const snapshot = getDesktopSnapshot();
        for (const account of dueAccounts) {
            const id = String(account.id || '');
            if (!id || inFlight.has(id)) continue;

            const reason = pendingReason.get(id) || 'scheduled';
            const binding = getBindingForAccount(id, snapshot);

            if (!binding || binding.status !== 'online' || binding.needsRebind) {
                setState(id, 'waiting_session', {
                    reason: binding ? 'desktop_session_offline' : 'desktop_session_not_bound',
                });
                scheduleRetry(id, reason);
                continue;
            }

            const identity = getSessionIdentity(account, binding);
            if (!identity.ok) {
                setState(id, 'session_mismatch', {
                    reason: identity.reason,
                    expectedUin: maskUin(identity.expectedUin),
                    boundUin: maskUin(identity.boundUin),
                });
                scheduleRetry(id, reason);
                continue;
            }

            refreshAccount(id, reason, snapshot).catch(() => null);
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
            const nextAt = scheduledRefreshEnabled ? now + refreshIntervalMs : 0;
            if (scheduledRefreshEnabled) {
                nextRefreshAt.set(id, nextAt);
            } else {
                nextRefreshAt.delete(id);
            }

            if (!binding || binding.status !== 'online' || binding.needsRebind) {
                setState(id, 'waiting_session', {
                    reason: binding ? 'desktop_session_offline' : 'desktop_session_not_bound',
                    nextRefreshAt: nextAt,
                });
                continue;
            }

            const identity = getSessionIdentity(account, binding);
            if (!identity.ok) {
                setState(id, 'session_mismatch', {
                    reason: identity.reason,
                    expectedUin: maskUin(identity.expectedUin),
                    boundUin: maskUin(identity.boundUin),
                    nextRefreshAt: nextAt,
                });
                continue;
            }

            if (scheduledRefreshEnabled) {
                setState(id, 'scheduled', { nextRefreshAt: nextAt });
            } else {
                setState(id, 'ready', {
                    reason: 'event_only',
                    nextRefreshAt: 0,
                });
            }
        }

        if (managed.length) {
            const mode = scheduledRefreshEnabled ? 'scheduled+event' : 'event-only';
            log('系统', `CodeManager 多账号 Session 调度已启用：${managed.length} 个账号，Provider=${provider.name || 'unknown'}，mode=${mode}`);
        }

        timer = setInterval(tick, pollMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
        started = false;
    }

    function buildAccountStatus(account, binding) {
        const id = String(account.id || '');
        const identity = binding ? getSessionIdentity(account, binding) : {
            ok: false,
            reason: 'desktop_session_not_bound',
            expectedUin: normalizeUin(account.uin || account.qq),
            boundUin: '',
        };
        let state = lastState.get(id) || null;
        if (!state) {
            if (!binding || binding.status !== 'online' || binding.needsRebind) {
                state = { state: 'waiting_session', updatedAt: 0 };
            } else if (!identity.ok) {
                state = {
                    state: 'session_mismatch',
                    updatedAt: 0,
                    reason: identity.reason,
                    expectedUin: maskUin(identity.expectedUin),
                    boundUin: maskUin(identity.boundUin),
                };
            } else if (!isGlobalEnabled()) {
                state = { state: 'configured', updatedAt: 0 };
            } else if (!scheduledRefreshEnabled) {
                state = { state: 'ready', updatedAt: 0, reason: 'event_only' };
            } else {
                state = { state: 'scheduled', updatedAt: 0 };
            }
        }

        return {
            accountId: id,
            accountName: account.name || id,
            expectedQqUin: maskUin(identity.expectedUin),
            qqUin: binding ? maskUin(binding.qqUin) : '',
            sessionIdentityOk: !!identity.ok,
            sessionIdentityReason: identity.reason,
            sessionStatus: binding ? binding.status : 'unbound',
            needsRebind: binding ? !!binding.needsRebind : true,
            nextRefreshAt: Number(nextRefreshAt.get(id) || 0),
            refreshing: inFlight.has(id),
            pendingReason: pendingReason.get(id) || '',
            state,
        };
    }

    function getStatus() {
        const snapshot = getCachedDesktopSnapshot();
        const configured = getConfiguredAccounts(snapshot);
        return {
            enabled: started && isGlobalEnabled(),
            started,
            globalEnabled: isGlobalEnabled(),
            provider: provider.name || 'unknown',
            refreshIntervalMs,
            scheduledRefreshEnabled,
            pollMs,
            retryMs,
            desktopSnapshotUpdatedAt: lastDesktopSnapshotAt,
            configuredCount: configured.length,
            accounts: configured.map(({ account, binding }) => buildAccountStatus(account, binding)),
        };
    }

    function getAccountStatus(accountId) {
        const id = String(accountId || '').trim();
        if (!id) return null;
        return getStatus().accounts.find(item => item.accountId === id) || null;
    }

    return {
        start,
        stop,
        tick,
        refreshAccount,
        triggerRefresh,
        handleAccountLog,
        getStatus,
        getAccountStatus,
    };
}

module.exports = {
    createCodeManager,
    createUnavailableProvider,
};
