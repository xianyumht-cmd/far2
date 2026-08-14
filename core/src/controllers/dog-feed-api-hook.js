const express = require('express');

// P7E manual-only API hook.
// It mounts only after the existing /api auth middleware has been installed.
// The request accepts foodId only; quantity/arg2 are never client-controlled.
function installDogFeedApiHook(provider) {
    const proto = express.application;
    const originalUse = proto.use;
    let mounted = false;

    function getAccounts() {
        try {
            const data = provider && typeof provider.getAccounts === 'function'
                ? provider.getAccounts()
                : { accounts: [] };
            return Array.isArray(data && data.accounts) ? data.accounts : [];
        } catch {
            return [];
        }
    }

    function resolveAccountId(raw) {
        const input = String(raw || '').trim();
        if (!input) return '';
        try {
            if (provider && typeof provider.resolveAccountId === 'function') {
                return String(provider.resolveAccountId(input) || input).trim();
            }
        } catch {}
        return input;
    }

    function getAccId(req) {
        return resolveAccountId(req && req.headers ? req.headers['x-account-id'] : '');
    }

    function checkAccountAccess(req, accountId) {
        const user = req && req.currentUser;
        if (!user) return false;
        if (user.role === 'admin') return true;
        const id = String(accountId || '').trim();
        const account = getAccounts().find(item => String(item.id || '') === id);
        return !!(account && String(account.username || '') === String(user.username || ''));
    }

    function registerRoute(app) {
        app.post('/api/dog/feed', async (req, res) => {
            const accountId = getAccId(req);
            if (!accountId) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
            if (!checkAccountAccess(req, accountId)) {
                return res.status(403).json({ ok: false, error: '无权访问此账号' });
            }

            const foodId = Number(req.body && req.body.foodId);
            if (!Number.isSafeInteger(foodId) || foodId <= 0) {
                return res.status(400).json({ ok: false, error: 'Invalid foodId' });
            }
            if (!provider || typeof provider.getShopInfo !== 'function') {
                return res.status(503).json({ ok: false, error: '护主犬喂食接口不可用' });
            }

            try {
                const data = await provider.getShopInfo(accountId, {
                    action: 'feedDogFoodOnce',
                    foodId,
                });
                if (data && data.ok === false) {
                    const status = Number(data.statusCode) || 409;
                    return res.status(status).json({ ok: false, error: data.error || '喂食被安全校验拒绝', data });
                }
                return res.json({ ok: true, data });
            } catch (error) {
                const message = error && error.message ? error.message : String(error || 'unknown');
                return res.status(message === 'Account not found' ? 404 : 500).json({ ok: false, error: message });
            }
        });
    }

    const patchedUse = function patchedUse(...args) {
        const result = originalUse.apply(this, args);
        const mountPath = typeof args[0] === 'string' ? args[0] : '';
        if (!mounted && mountPath === '/api') {
            mounted = true;
            registerRoute(this);
        }
        return result;
    };

    proto.use = patchedUse;

    return function uninstall() {
        if (proto.use === patchedUse) proto.use = originalUse;
    };
}

module.exports = {
    installDogFeedApiHook,
};
