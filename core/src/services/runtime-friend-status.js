const fs = require('node:fs');
const { getDataFile } = require('../config/runtime-paths');
const store = require('../models/store');

function safeReadJson(file) {
    try {
        if (!file || !fs.existsSync(file)) return null;
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

function normalizeUin(value) {
    const text = String(value || '').trim();
    return /^\d{5,12}$/.test(text) ? text : '';
}

function countUniqueStrings(values) {
    const seen = new Set();
    for (const raw of (Array.isArray(values) ? values : [])) {
        const value = String(raw || '').trim();
        if (!value) continue;
        seen.add(value);
    }
    return seen.size;
}

function countUniquePositiveNumbers(values) {
    const seen = new Set();
    for (const raw of (Array.isArray(values) ? values : [])) {
        const value = Number(raw);
        if (!Number.isSafeInteger(value) || value <= 0) continue;
        seen.add(value);
    }
    return seen.size;
}

function getAccountOpenIdsArtifact(accountId) {
    const safeId = String(accountId || '').replace(/[^\w-]/g, '_');
    if (!safeId) return null;
    return safeReadJson(getDataFile(`runtime-friend-openids-${safeId}.json`));
}

function getRawCaptureArtifact(uin) {
    const qqUin = normalizeUin(uin);
    if (!qqUin) return null;
    const artifact = safeReadJson(getDataFile(`runtime-friend-gids-${qqUin}.json`));
    if (!artifact) return null;
    if (normalizeUin(artifact.qqUin) && normalizeUin(artifact.qqUin) !== qqUin) return null;
    return artifact;
}

function getRuntimeFriendStatus(account = {}) {
    const accountId = String(account.id || '').trim();
    if (!accountId) {
        return {
            imported: false,
            gidCount: 0,
            openIdCount: 0,
            source: '',
            capturedAt: 0,
            methods: [],
        };
    }

    const uin = normalizeUin(account.uin || account.qq);
    const knownGids = typeof store.getKnownFriendGids === 'function'
        ? store.getKnownFriendGids(accountId)
        : [];
    const accountArtifact = getAccountOpenIdsArtifact(accountId);
    const rawArtifact = getRawCaptureArtifact(uin);

    const persistedGidCount = countUniquePositiveNumbers(knownGids);
    const rawGidCount = countUniquePositiveNumbers(rawArtifact && rawArtifact.gids);
    const accountOpenIdCount = countUniqueStrings(accountArtifact && accountArtifact.openIds);
    const rawOpenIdCount = countUniqueStrings(rawArtifact && rawArtifact.openIds);

    const gidCount = persistedGidCount || rawGidCount;
    const openIdCount = accountOpenIdCount || rawOpenIdCount;
    const capturedAt = Math.max(
        Number(accountArtifact && accountArtifact.capturedAt) || 0,
        Number(rawArtifact && rawArtifact.capturedAt) || 0,
    );
    const source = String(
        (accountArtifact && accountArtifact.source)
        || (rawArtifact && rawArtifact.source)
        || '',
    );
    const methods = Array.isArray(rawArtifact && rawArtifact.methods)
        ? rawArtifact.methods.map(String).slice(0, 8)
        : [];

    return {
        imported: gidCount > 0 || openIdCount > 0,
        gidCount,
        openIdCount,
        source,
        capturedAt,
        methods,
    };
}

module.exports = {
    getRuntimeFriendStatus,
    getAccountOpenIdsArtifact,
    getRawCaptureArtifact,
};
