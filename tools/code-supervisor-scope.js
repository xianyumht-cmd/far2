'use strict';

// Unset scope preserves historical behavior; invalid scope fails closed.
function parseScope(value) {
    if (value === undefined || value === null) return null;
    const parts = String(value).trim().split(/[,;\s]+/).filter(Boolean);
    if (!parts.length || parts.some(uin => !/^\d{5,20}$/.test(uin))) return new Set();
    return new Set(parts);
}

function shouldMonitorAccount(account, scope = null) {
    if (!account || String(account.platform || 'qq').toLowerCase() !== 'qq') return false;
    if (scope === null) return true;
    return scope.has(String(account.uin || '').trim());
}

module.exports = { parseScope, shouldMonitorAccount };
