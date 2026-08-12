function registerCodeManagerApi(app, options = {}) {
    const {
        provider,
        getAccId,
        checkAccountAccess,
        getAccessibleAccountIds,
        handleApiError,
    } = options;

    if (!app) throw new Error('CodeManager API requires express app');

    function requireAccount(req, res) {
        const accountId = typeof getAccId === 'function' ? getAccId(req) : '';
        if (!accountId) {
            res.status(400).json({ ok: false, error: 'Missing x-account-id' });
            return '';
        }
        if (typeof checkAccountAccess === 'function' && !checkAccountAccess(req, accountId)) {
            res.status(403).json({ ok: false, error: '无权访问此账号' });
            return '';
        }
        return accountId;
    }

    function fail(res, err) {
        if (typeof handleApiError === 'function') return handleApiError(res, err);
        return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err || 'unknown') });
    }

    function filterStatusForRequest(req, status) {
        const raw = status && typeof status === 'object' ? status : { accounts: [] };
        const allowed = typeof getAccessibleAccountIds === 'function'
            ? new Set((getAccessibleAccountIds(req) || []).map(String))
            : null;
        const accounts = Array.isArray(raw.accounts) ? raw.accounts : [];
        return {
            ...raw,
            accounts: allowed ? accounts.filter(item => allowed.has(String(item.accountId || ''))) : accounts,
        };
    }

    function getAllowedAccountIds(req) {
        if (typeof getAccessibleAccountIds !== 'function') return null;
        return new Set((getAccessibleAccountIds(req) || []).map(String));
    }

    function normalizeWsError(raw) {
        if (!raw || typeof raw !== 'object') return null;
        return {
            code: Number(raw.code) || 0,
            message: String(raw.message || raw.error || ''),
            at: Number(raw.at) || 0,
        };
    }

    function getCodeStateLabel(state) {
        const map = {
            ready: '可用',
            scheduled: '待命',
            configured: '已配置',
            refreshing: '刷新中',
            waiting_session: '等待 QQ Session',
            waiting_provider: '等待 Provider',
            session_mismatch: 'Session 身份异常',
            provider_error: 'Provider 异常',
        };
        return map[state] || (state ? String(state) : '未启用');
    }

    function buildRuntimeHealth(req) {
        if (!provider || typeof provider.getAccounts !== 'function' || typeof provider.getStatus !== 'function') {
            throw new Error('Runtime health unavailable');
        }

        const allowed = getAllowedAccountIds(req);
        const accountData = provider.getAccounts() || { accounts: [] };
        const allAccounts = Array.isArray(accountData.accounts) ? accountData.accounts : [];
        const accounts = allowed
            ? allAccounts.filter(account => allowed.has(String(account.id || '')))
            : allAccounts;

        const rawCodeStatus = typeof provider.getCodeManagerStatus === 'function'
            ? (provider.getCodeManagerStatus('') || {})
            : {};
        const allCodeAccounts = Array.isArray(rawCodeStatus.accounts) ? rawCodeStatus.accounts : [];
        const accessibleCodeAccounts = allowed
            ? allCodeAccounts.filter(item => allowed.has(String(item.accountId || '')))
            : allCodeAccounts;
        const codeAccounts = new Map(accessibleCodeAccounts
            .map(item => [String(item.accountId || ''), item]));
        const accountEvents = typeof provider.getAccountLogs === 'function'
            ? (provider.getAccountLogs(300) || [])
            : [];

        const rows = accounts.map((account) => {
            const accountId = String(account.id || '');
            const runtime = provider.getStatus(accountId) || {};
            const running = !!account.running;
            const connected = !!(runtime.connection && runtime.connection.connected);
            const codeStatus = codeAccounts.get(accountId) || null;
            const codeState = String(codeStatus && codeStatus.state && codeStatus.state.state || '');
            const logs = typeof provider.getLogs === 'function'
                ? (provider.getLogs(accountId, { limit: 250 }) || [])
                : [];
            const friendLog = [...logs].reverse().find(entry =>
                entry
                && (Number(entry.capturedGidCount) >= 0 || Number(entry.capturedOpenIdCount) >= 0)
                && String(entry.event || '') === 'QQ小程序启动好友导入');

            const friendGidCount = friendLog ? Math.max(0, Number(friendLog.totalKnownGids ?? friendLog.capturedGidCount) || 0) : null;
            const friendOpenIdCount = friendLog ? Math.max(0, Number(friendLog.capturedOpenIdCount) || 0) : null;
            const friendImported = !!friendLog && ((friendGidCount || 0) > 0 || (friendOpenIdCount || 0) > 0);
            const friendCapturedAt = friendLog
                ? (Number(friendLog.capturedAt) || Number(friendLog.ts) || Date.parse(String(friendLog.time || '').replace(' ', 'T')) || 0)
                : 0;
            const recentEvents = accountEvents
                .filter(entry => String(entry.accountId || '') === accountId)
                .filter(entry => /^(code_refresh_|ws_400|kickout)/.test(String(entry.action || '')))
                .slice(0, 6)
                .map(entry => ({
                    time: String(entry.time || ''),
                    action: String(entry.action || ''),
                    msg: String(entry.msg || ''),
                    reason: String(entry.reason || ''),
                }));

            let state = 'ok';
            let label = '正常';
            let message = 'Worker、Farm 与恢复链路正常';

            if (!running) {
                state = 'idle';
                label = '未运行';
                message = '账号当前没有 Worker，不作为故障处理';
            } else if (codeState === 'session_mismatch' || codeState === 'provider_error') {
                state = 'error';
                label = '需要处理';
                message = codeState === 'session_mismatch' ? 'QQ Session 身份校验异常' : 'Code Provider 最近一次刷新异常';
            } else if (!connected) {
                state = 'warning';
                label = '恢复中';
                message = codeState === 'refreshing'
                    ? 'Farm 离线，CodeManager 正在刷新 Code'
                    : 'Worker 已运行，但 Farm 当前未连接';
            } else if (codeState === 'waiting_session' || codeState === 'waiting_provider') {
                state = 'warning';
                label = '降级运行';
                message = 'Farm 在线，但 Code 自动恢复链路当前不可用';
            } else if (String(account.platform || 'qq').toLowerCase() === 'qq'
                && account.codeRefreshEnabled === true
                && !friendLog) {
                state = 'warning';
                label = '待确认';
                message = '本次启动暂未看到完整好友池导入记录';
            }

            return {
                accountId,
                accountName: String(account.name || runtime.accountName || accountId),
                gameName: String(runtime.status && runtime.status.name || account.nick || ''),
                platform: String(account.platform || 'qq').toLowerCase(),
                running,
                health: { state, label, message },
                farm: {
                    connected,
                    level: Number(runtime.status && runtime.status.level) || 0,
                    uptime: Number(runtime.uptime) || 0,
                    wsError: normalizeWsError(runtime.wsError),
                },
                code: {
                    enabled: account.codeRefreshEnabled === true,
                    mode: String(account.codeRefreshMode || ''),
                    state: codeState,
                    stateLabel: getCodeStateLabel(codeState),
                    stateReason: String(codeStatus && codeStatus.state && codeStatus.state.reason || ''),
                    refreshing: !!(codeStatus && codeStatus.refreshing),
                    sessionStatus: String(codeStatus && codeStatus.sessionStatus || ''),
                    sessionIdentityOk: codeStatus ? !!codeStatus.sessionIdentityOk : null,
                    needsRebind: codeStatus ? !!codeStatus.needsRebind : false,
                    lastRefreshAt: Number(account.lastCodeRefreshAt) || 0,
                    lastRefreshOk: typeof account.lastCodeRefreshOk === 'boolean' ? account.lastCodeRefreshOk : null,
                    lastRefreshReason: String(account.lastCodeRefreshReason || ''),
                    lastRefreshError: String(account.lastCodeRefreshError || ''),
                    lastCodeSource: String(account.lastCodeSource || ''),
                },
                friends: {
                    imported: friendImported,
                    gidCount: friendGidCount,
                    openIdCount: friendOpenIdCount,
                    addedGidCount: friendLog ? Math.max(0, Number(friendLog.addedCount) || 0) : null,
                    source: friendLog ? String(friendLog.source || '') : '',
                    capturedAt: friendCapturedAt,
                },
                recentEvents,
            };
        });

        const runningCount = rows.filter(item => item.running).length;
        const connectedCount = rows.filter(item => item.farm.connected).length;
        const issueCount = rows.filter(item => item.health.state === 'warning' || item.health.state === 'error').length;
        const errorCount = rows.filter(item => item.health.state === 'error').length;
        const codeReadyCount = rows.filter(item => item.code.enabled
            && !['session_mismatch', 'provider_error', 'waiting_session', 'waiting_provider'].includes(item.code.state)).length;
        const friendReadyCount = rows.filter(item => item.friends.imported).length;

        let overall = { state: 'ok', label: '运行正常', detail: '当前没有发现需要处理的运行问题' };
        if (errorCount > 0) {
            overall = { state: 'error', label: '需要处理', detail: `${errorCount} 个账号存在明确故障` };
        } else if (issueCount > 0) {
            overall = { state: 'warning', label: '需要关注', detail: `${issueCount} 个账号存在降级或待确认状态` };
        } else if (runningCount === 0) {
            overall = { state: 'idle', label: '当前空闲', detail: '没有正在运行的账号 Worker' };
        }

        return {
            generatedAt: Date.now(),
            overall,
            summary: {
                accounts: rows.length,
                running: runningCount,
                connected: connectedCount,
                codeReady: codeReadyCount,
                friendReady: friendReadyCount,
                issues: issueCount,
            },
            codeManager: {
                enabled: !!rawCodeStatus.enabled,
                started: !!rawCodeStatus.started,
                globalEnabled: !!rawCodeStatus.globalEnabled,
                provider: String(rawCodeStatus.provider || ''),
                configuredCount: accessibleCodeAccounts.length,
            },
            accounts: rows,
        };
    }

    app.get('/api/runtime-health', (req, res) => {
        try {
            return res.json({ ok: true, data: buildRuntimeHealth(req) });
        } catch (err) {
            return fail(res, err);
        }
    });

    app.get('/api/code-manager/status', (req, res) => {
        try {
            if (!provider || typeof provider.getCodeManagerStatus !== 'function') {
                return res.status(503).json({ ok: false, error: 'CodeManager unavailable' });
            }

            const accountId = typeof getAccId === 'function' ? getAccId(req) : '';
            if (accountId) {
                if (typeof checkAccountAccess === 'function' && !checkAccountAccess(req, accountId)) {
                    return res.status(403).json({ ok: false, error: '无权访问此账号' });
                }
                return res.json({ ok: true, data: provider.getCodeManagerStatus(accountId) });
            }

            return res.json({ ok: true, data: filterStatusForRequest(req, provider.getCodeManagerStatus('')) });
        } catch (err) {
            return fail(res, err);
        }
    });

    app.get('/api/code-manager/config', (req, res) => {
        try {
            if (!provider || typeof provider.getCodeRefreshConfig !== 'function') {
                return res.status(503).json({ ok: false, error: 'CodeManager config unavailable' });
            }
            const accountId = typeof getAccId === 'function' ? getAccId(req) : '';
            if (accountId) {
                if (typeof checkAccountAccess === 'function' && !checkAccountAccess(req, accountId)) {
                    return res.status(403).json({ ok: false, error: '无权访问此账号' });
                }
                const data = provider.getCodeRefreshConfig(accountId);
                if (!data) return res.status(404).json({ ok: false, error: 'Account not found' });
                return res.json({ ok: true, data });
            }

            const data = provider.getCodeRefreshConfig('') || { accounts: [] };
            const allowed = typeof getAccessibleAccountIds === 'function'
                ? new Set((getAccessibleAccountIds(req) || []).map(String))
                : null;
            if (allowed && Array.isArray(data.accounts)) {
                data.accounts = data.accounts.filter(item => allowed.has(String(item.accountId || '')));
            }
            return res.json({ ok: true, data });
        } catch (err) {
            return fail(res, err);
        }
    });

    app.post('/api/code-manager/config', (req, res) => {
        try {
            if (!provider || typeof provider.setCodeRefreshConfig !== 'function') {
                return res.status(503).json({ ok: false, error: 'CodeManager config unavailable' });
            }
            const accountId = requireAccount(req, res);
            if (!accountId) return;

            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const data = provider.setCodeRefreshConfig(accountId, {
                enabled: body.enabled === true,
                mode: body.mode,
            });
            return res.json({ ok: true, data });
        } catch (err) {
            return fail(res, err);
        }
    });

    app.post('/api/code-manager/refresh', (req, res) => {
        try {
            if (!provider || typeof provider.triggerCodeRefresh !== 'function') {
                return res.status(503).json({ ok: false, error: 'CodeManager unavailable' });
            }
            const accountId = requireAccount(req, res);
            if (!accountId) return;

            const reason = String((req.body && req.body.reason) || 'manual_api').trim() || 'manual_api';
            const data = provider.triggerCodeRefresh(accountId, reason);
            return res.json({ ok: true, data });
        } catch (err) {
            return fail(res, err);
        }
    });
}

module.exports = {
    registerCodeManagerApi,
};
