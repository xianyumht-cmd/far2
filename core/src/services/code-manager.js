const process = require('node:process');
const { captureFreshFarmCode } = require('./windows-runtime-code');

const DEFAULT_REFRESH_INTERVAL_MS = 3 * 60 * 1000;
const DEFAULT_POLL_MS = 10 * 1000;
const DEFAULT_CAPTURE_TIMEOUT_MS = 90 * 1000;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function maskCode(code) {
    const text = String(code || '').trim();
    if (!text) return '(empty)';
    if (text.length <= 8) return text;
    return `${text.slice(0, 4)}...${text.slice(-4)}`;
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
    } = options;

    const refreshIntervalMs = Math.max(
        30 * 1000,
        Number(processRef.env.FARM_CODE_REFRESH_INTERVAL_MS) || DEFAULT_REFRESH_INTERVAL_MS,
    );
    const pollMs = Math.max(
        1000,
        Number(processRef.env.FARM_CODE_REFRESH_POLL_MS) || DEFAULT_POLL_MS,
    );
    const captureTimeoutMs = Math.max(
        5000,
        Number(processRef.env.FARM_CODE_CAPTURE_TIMEOUT_MS) || DEFAULT_CAPTURE_TIMEOUT_MS,
    );

    let timer = null;
    let started = false;
    let warnedBinding = false;
    const nextRefreshAt = new Map();
    const inFlight = new Map();
    const lastTriggerAt = new Map();

    function getAccountsList() {
        const data = store.getAccounts();
        return Array.isArray(data && data.accounts) ? data.accounts : [];
    }

    function getAccountById(accountId) {
        const id = String(accountId || '').trim();
        if (!id) return null;
        return getAccountsList().find(acc => String(acc.id || '') === id) || null;
    }

    function getManagedAccount() {
        if (processRef.platform !== 'win32') return null;
        if (String(processRef.env.FARM_CODE_AUTO_REFRESH || '0') !== '1') return null;

        const qqAccounts = getAccountsList().filter(acc => String(acc.platform || 'qq').toLowerCase() === 'qq');
        const explicitlyEnabled = qqAccounts.filter(acc =>
            acc.codeRefreshEnabled === true
            && acc.codeRefreshMode === 'windows_runtime'
            && String(acc.desktopSessionUin || '').trim(),
        );

        if (explicitlyEnabled.length === 1) return explicitlyEnabled[0];
        if (!warnedBinding) {
            warnedBinding = true;
            log('系统', 'CodeManager 未启用自动刷新：必须先建立“农场账号 ↔ 指定 Windows QQ Session”绑定，避免多 QQ 环境弹账号选择框或刷新错账号');
        }
        return null;
    }

    function isManagedAccount(accountId) {
        const managed = getManagedAccount();
        return !!(managed && String(managed.id || '') === String(accountId || ''));
    }

    async function waitWorkerStopped(accountId, timeoutMs = 2500) {
        const id = String(accountId || '');
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (!workers[id]) return true;
            await sleep(100);
        }
        return !workers[id];
    }

    async function refreshAccount(accountId, reason = 'scheduled') {
        const id = String(accountId || '').trim();
        if (!id) return { ok: false, reason: 'missing_account_id' };
        if (!isManagedAccount(id)) return { ok: false, reason: 'account_not_managed' };
        if (inFlight.has(id)) return inFlight.get(id);

        const task = (async () => {
            const before = getAccountById(id);
            if (!before) return { ok: false, reason: 'account_not_found' };

            const wasRunning = !!workers[id];
            const displayName = before.name || id;
            log('系统', `CodeManager 开始刷新账号 ${displayName} 的 Farm Code，原因: ${reason}`, {
                accountId: id,
                accountName: displayName,
            });
            addAccountLog('code_refresh_start', `开始刷新 Farm Code (${reason})`, id, displayName, { reason });

            if (wasRunning) {
                stopWorker(id);
                await waitWorkerStopped(id);
            }

            try {
                const captured = await captureFreshFarmCode({
                    timeoutMs: captureTimeoutMs,
                    log: (msg) => log('系统', `CodeManager: ${msg}`, { accountId: id, accountName: displayName }),
                });
                const freshCode = String(captured && captured.code || '').trim();
                if (!freshCode) throw new Error('未获得 fresh Code');

                const refreshedAt = Date.now();
                store.addOrUpdateAccount({
                    id,
                    code: freshCode,
                    lastCodeRefreshAt: refreshedAt,
                    lastCodeRefreshOk: true,
                    lastCodeRefreshError: '',
                    lastCodeRefreshReason: reason,
                    lastCodeSource: captured.source || 'qq.login',
                });

                const updated = getAccountById(id);
                const startedNow = startWorker(updated || { ...before, code: freshCode });
                nextRefreshAt.set(id, refreshedAt + refreshIntervalMs);

                log('系统', `CodeManager 已获取 fresh Code ${maskCode(freshCode)}，账号 ${displayName} 已重新登录`, {
                    accountId: id,
                    accountName: displayName,
                });
                addAccountLog('code_refresh_ok', `Farm Code 刷新成功 ${maskCode(freshCode)}`, id, displayName, {
                    reason,
                    source: captured.source || 'qq.login',
                    restarted: !!startedNow,
                });
                return { ok: true, code: freshCode, restarted: !!startedNow, reason };
            } catch (err) {
                const message = err && err.message ? err.message : String(err || 'unknown');
                store.addOrUpdateAccount({
                    id,
                    lastCodeRefreshAt: Date.now(),
                    lastCodeRefreshOk: false,
                    lastCodeRefreshError: message,
                    lastCodeRefreshReason: reason,
                });
                nextRefreshAt.set(id, Date.now() + Math.min(refreshIntervalMs, 30 * 1000));
                log('错误', `CodeManager 刷新账号 ${displayName} 失败: ${message}`, {
                    accountId: id,
                    accountName: displayName,
                });
                addAccountLog('code_refresh_failed', `Farm Code 刷新失败: ${message}`, id, displayName, { reason });

                if (wasRunning && !workers[id]) {
                    try {
                        startWorker(before);
                        log('系统', `CodeManager 已尝试用旧 Code 恢复账号 ${displayName}`, {
                            accountId: id,
                            accountName: displayName,
                        });
                    } catch {}
                }
                return { ok: false, reason: message };
            }
        })().finally(() => {
            inFlight.delete(id);
        });

        inFlight.set(id, task);
        return task;
    }

    function triggerRefresh(accountId, reason) {
        const id = String(accountId || '').trim();
        if (!id || !isManagedAccount(id)) return false;
        const now = Date.now();
        const last = Number(lastTriggerAt.get(id) || 0);
        if (now - last < 5000 && inFlight.has(id)) return true;
        lastTriggerAt.set(id, now);
        refreshAccount(id, reason).catch(() => null);
        return true;
    }

    function handleAccountLog(entry) {
        if (!entry || !entry.accountId) return;
        const action = String(entry.action || '');
        const id = String(entry.accountId || '');
        if (!isManagedAccount(id)) return;

        if (action === 'ws_400') {
            triggerRefresh(id, 'ws_400');
            return;
        }
        if (action === 'kickout_stop') {
            const reason = String(entry.reason || '未知');
            if (/版本过低|客户端版本/i.test(reason)) return;
            triggerRefresh(id, `kickout:${reason}`);
        }
    }

    function tick() {
        const account = getManagedAccount();
        if (!account) return;
        const id = String(account.id || '');
        if (!id || !workers[id] || inFlight.has(id)) return;

        let due = Number(nextRefreshAt.get(id) || 0);
        if (!due) {
            due = Date.now() + refreshIntervalMs;
            nextRefreshAt.set(id, due);
            return;
        }
        if (Date.now() >= due) {
            triggerRefresh(id, 'scheduled');
        }
    }

    function start() {
        if (started) return;
        started = true;
        const account = getManagedAccount();
        if (account) {
            const id = String(account.id || '');
            nextRefreshAt.set(id, Date.now() + refreshIntervalMs);
            log('系统', `CodeManager 已启用：账号 ${account.name || id} 将每 ${Math.round(refreshIntervalMs / 1000)} 秒刷新一次 Farm Code；HTTP 400/Kickout 会立即刷新`, {
                accountId: id,
                accountName: account.name || id,
            });
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
        const account = getManagedAccount();
        const id = account ? String(account.id || '') : '';
        return {
            enabled: started && !!account,
            accountId: id,
            accountName: account ? (account.name || id) : '',
            refreshIntervalMs,
            nextRefreshAt: id ? Number(nextRefreshAt.get(id) || 0) : 0,
            refreshing: id ? inFlight.has(id) : false,
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
