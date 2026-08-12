const { buildRuntimeHealth } = require('../services/runtime-health');

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

    app.get('/api/runtime-health', (req, res) => {
        try {
            return res.json({
                ok: true,
                data: buildRuntimeHealth({
                    provider,
                    req,
                    getAccessibleAccountIds,
                }),
            });
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
