const process = require('node:process');

const FALSE_VALUES = new Set(['', 'false', '0', 'off', 'no']);
const UNSAFE_TRUST_ALL_VALUES = new Set(['true', '1', 'on', 'yes', '*']);

function createUnsafeTrustProxyError(value) {
    const error = new Error(`Unsafe TRUST_PROXY value: ${value}. Configure explicit trusted proxy IPs, CIDRs, or Express named subnets instead.`);
    error.code = 'unsafe_trust_proxy';
    return error;
}

function getTrustProxySetting(value = process.env.TRUST_PROXY) {
    const raw = String(value ?? '').trim();
    const normalized = raw.toLowerCase();

    if (FALSE_VALUES.has(normalized)) return false;
    if (UNSAFE_TRUST_ALL_VALUES.has(normalized) || /^\d+$/.test(normalized)) {
        throw createUnsafeTrustProxyError(raw);
    }

    const entries = raw.split(',').map(entry => entry.trim()).filter(Boolean);
    if (entries.length === 0) return false;

    for (const entry of entries) {
        const lowered = entry.toLowerCase();
        if (UNSAFE_TRUST_ALL_VALUES.has(lowered) || /^\d+$/.test(lowered)) {
            throw createUnsafeTrustProxyError(entry);
        }
    }

    return entries.length === 1 ? entries[0] : entries;
}

function normalizeClientIp(value) {
    const raw = String(value || '').trim();
    if (!raw) return 'unknown';
    if (raw.startsWith('::ffff:')) return raw.slice(7);
    return raw;
}

module.exports = {
    getTrustProxySetting,
    normalizeClientIp,
};
