const { getRuntimeFriendStatus } = require('./runtime-friend-status');

function getAllowedAccountIds(req, getAccessibleAccountIds) {
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

function readFriendStatus(provider, account) {
    if (provider && typeof provider.getRuntimeFriendStatus === 'function') {
        try {
            const result = provider.getRuntimeFriendStatus(account);
            if (result && typeof result === 'object') return result;
        } catch {
            // Fall back to the persisted runtime artifacts below.
        }
    }
    return getRuntimeFriendStatus(account);
}

function buildRuntimeHealth(options = {}) {
    const {
        provider,
        req,
        getAccessibleAccountIds,
    } = options;

    if (!provider || typeof provider.getAccounts !== 'function' || typeof provider.getStatus !== 'function') {
        throw new Error('Runtime health unavailable');
    }

    const allowed = getAllowedAccountIds(req, getAccessibleAccountIds);
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
        const friend = readFriendStatus(provider, account) || {};
        const friendGidCount = Number.isFinite(Number(friend.gidCount)) ? Math.max(0, Number(friend.gidCount)) : null;
        const friendOpenIdCount = Number.isFinite(Number(friend.openIdCount)) ? Math.max(0, Number(friend.openIdCount)) : null;
        const friendImported = friend.imported === true || (friendGidCount || 0) > 0 || (friendOpenIdCount || 0) > 0;
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
            && !friendImported) {
            state = 'warning';
            label = '待确认';
            message = '没有读取到已持久化的 QQ 好友池数据';
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
                source: String(friend.source || ''),
                capturedAt: Number(friend.capturedAt) || 0,
                methods: Array.isArray(friend.methods) ? friend.methods.map(String).slice(0, 8) : [],
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

module.exports = {
    buildRuntimeHealth,
    getCodeStateLabel,
};
