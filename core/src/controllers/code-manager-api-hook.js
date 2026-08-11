const express = require('express');
const { registerCodeManagerApi } = require('./code-manager-api');

function installCodeManagerApiHook(provider) {
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

    function getAccessibleAccountIds(req) {
        const user = req && req.currentUser;
        if (!user) return [];
        const accounts = getAccounts();
        if (user.role === 'admin') return accounts.map(item => String(item.id || '')).filter(Boolean);
        return accounts
            .filter(item => String(item.username || '') === String(user.username || ''))
            .map(item => String(item.id || ''))
            .filter(Boolean);
    }

    function handleApiError(res, err) {
        const message = err && err.message ? err.message : String(err || 'unknown');
        const status = message === 'Account not found' ? 404 : 500;
        return res.status(status).json({ ok: false, error: message });
    }

    proto.use = function patchedUse(...args) {
        const result = originalUse.apply(this, args);
        const mountPath = typeof args[0] === 'string' ? args[0] : '';

        if (!mounted && mountPath === '/api') {
            mounted = true;
            registerCodeManagerApi(this, {
                provider,
                getAccId,
                checkAccountAccess,
                getAccessibleAccountIds,
                handleApiError,
            });
        }
        return result;
    };

    return function uninstall() {
        if (proto.use === patchedUse) proto.use = originalUse;
    };

    function patchedUse(...args) {
        return proto.use.apply(this, args);
    }
}

module.exports = {
    installCodeManagerApiHook,
};
