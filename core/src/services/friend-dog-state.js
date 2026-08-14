const fs = require('node:fs');
const path = require('node:path');
const { getDataFile } = require('../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('./json-db');

const GUARD_DOG_ID = 90021;
const DOG_CACHE_DIR = getDataFile('friend_dog_info');
const EXPIRY_SLOP_SEC = 5;
const memoryCaches = new Map();

function normalizeAccountId(accountId) {
    return String(accountId || '').trim();
}

function cacheFileForAccount(accountId) {
    const safeId = normalizeAccountId(accountId).replace(/[^\w-]/g, '_');
    return path.join(DOG_CACHE_DIR, `${safeId || 'default'}.json`);
}

function normalizeNowSec(nowSec) {
    const value = Number(nowSec);
    if (Number.isFinite(value) && value > 0) return Math.floor(value);
    return Math.floor(Date.now() / 1000);
}

function normalizeEntry(raw, nowSec) {
    if (!raw || typeof raw !== 'object') return null;
    const gid = Number.parseInt(raw.gid, 10);
    const dogId = Number.parseInt(raw.dogId, 10);
    const expiresAtSec = Number.parseInt(raw.expiresAtSec, 10);
    if (!Number.isFinite(gid) || gid <= 0) return null;
    if (!Number.isFinite(dogId) || dogId <= 0) return null;
    if (!Number.isFinite(expiresAtSec) || expiresAtSec <= nowSec) return null;
    return { gid, dogId, expiresAtSec };
}

function normalizeCacheObject(raw, nowSec = normalizeNowSec()) {
    const source = raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object'
        ? raw.entries
        : (raw && typeof raw === 'object' ? raw : {});
    const result = {};
    for (const [key, value] of Object.entries(source)) {
        const entry = normalizeEntry({ ...(value || {}), gid: Number.parseInt(key, 10) || value?.gid }, nowSec);
        if (!entry) continue;
        result[String(entry.gid)] = entry;
    }
    return result;
}

function loadCache(accountId, nowSec = normalizeNowSec()) {
    const key = normalizeAccountId(accountId);
    const cached = memoryCaches.get(key);
    if (cached) {
        const pruned = normalizeCacheObject(cached, nowSec);
        memoryCaches.set(key, pruned);
        return pruned;
    }

    const file = cacheFileForAccount(key);
    const raw = fs.existsSync(file) ? readJsonFile(file, () => ({})) : {};
    const normalized = normalizeCacheObject(raw, nowSec);
    memoryCaches.set(key, normalized);
    return normalized;
}

function persistCache(accountId, entries) {
    const key = normalizeAccountId(accountId);
    if (!key) return false;
    try {
        writeJsonFileAtomic(cacheFileForAccount(key), {
            version: 1,
            updatedAt: Date.now(),
            entries,
        });
        return true;
    } catch {
        return false;
    }
}

function readFriendDogInfoCache(accountId, nowSec = normalizeNowSec()) {
    const normalizedNow = normalizeNowSec(nowSec);
    const entries = loadCache(accountId, normalizedNow);
    const snapshot = {};
    let changed = false;

    for (const [gid, raw] of Object.entries(entries)) {
        const entry = normalizeEntry(raw, normalizedNow);
        if (!entry) {
            changed = true;
            continue;
        }
        snapshot[gid] = {
            ...entry,
            remainingSeconds: Math.max(0, entry.expiresAtSec - normalizedNow),
            hasGuardDog: entry.dogId === GUARD_DOG_ID,
        };
    }

    if (changed) {
        memoryCaches.set(normalizeAccountId(accountId), normalizeCacheObject(snapshot, normalizedNow));
        persistCache(accountId, normalizeCacheObject(snapshot, normalizedNow));
    }
    return snapshot;
}

function rememberFriendDogProbe(accountId, friendGid, probe, nowSec = normalizeNowSec()) {
    const key = normalizeAccountId(accountId);
    const gid = Number.parseInt(friendGid, 10);
    if (!key || !Number.isFinite(gid) || gid <= 0) return null;

    const normalizedNow = normalizeNowSec(nowSec);
    const dogId = Number.parseInt(probe && probe.dogId, 10) || 0;
    const remainingSeconds = Number.parseInt(probe && probe.remainingSeconds, 10) || 0;
    const entries = loadCache(key, normalizedNow);
    const cacheKey = String(gid);
    const previous = entries[cacheKey] || null;

    if (dogId <= 0 || remainingSeconds <= 0) {
        if (previous) {
            delete entries[cacheKey];
            memoryCaches.set(key, entries);
            persistCache(key, entries);
        }
        return null;
    }

    const next = {
        gid,
        dogId,
        expiresAtSec: normalizedNow + remainingSeconds,
    };
    const sameDog = previous && previous.dogId === next.dogId;
    const closeExpiry = previous && Math.abs(previous.expiresAtSec - next.expiresAtSec) <= EXPIRY_SLOP_SEC;
    if (sameDog && closeExpiry) {
        return {
            ...previous,
            remainingSeconds: Math.max(0, previous.expiresAtSec - normalizedNow),
            hasGuardDog: previous.dogId === GUARD_DOG_ID,
        };
    }

    entries[cacheKey] = next;
    memoryCaches.set(key, entries);
    persistCache(key, entries);
    return {
        ...next,
        remainingSeconds,
        hasGuardDog: dogId === GUARD_DOG_ID,
    };
}

function getFriendDogInfo(accountId, friendGid, nowSec = normalizeNowSec()) {
    const gid = Number.parseInt(friendGid, 10);
    if (!Number.isFinite(gid) || gid <= 0) return null;
    const snapshot = readFriendDogInfoCache(accountId, nowSec);
    return snapshot[String(gid)] || null;
}

function getGuardDogGidSet(accountId, nowSec = normalizeNowSec()) {
    const snapshot = readFriendDogInfoCache(accountId, nowSec);
    return new Set(
        Object.values(snapshot)
            .filter(entry => entry && entry.hasGuardDog && entry.remainingSeconds > 0)
            .map(entry => entry.gid),
    );
}

function compareHelpTargets(a, b) {
    const guardA = !!(a && a.hasGuardDog);
    const guardB = !!(b && b.hasGuardDog);
    if (guardA !== guardB) return guardA ? -1 : 1;
    const helpA = Number(a?.dryNum || 0) + Number(a?.weedNum || 0) + Number(a?.insectNum || 0);
    const helpB = Number(b?.dryNum || 0) + Number(b?.weedNum || 0) + Number(b?.insectNum || 0);
    return helpB - helpA;
}

function canContinueHelpAfterExpLimit(friend) {
    return !!(friend && friend.hasGuardDog);
}

function shouldRunHelpTickAfterExpLimit(options = {}) {
    const stopWhenExpLimit = options.stopWhenExpLimit === true;
    const expLimitReached = options.expLimitReached === true;
    if (!stopWhenExpLimit || !expLimitReached) return true;
    const activeGuardDogCount = Math.max(0, Number.parseInt(options.activeGuardDogCount, 10) || 0);
    return activeGuardDogCount > 0;
}

function selectHelpTargetsAfterExpLimit(targets, options = {}) {
    const list = Array.isArray(targets) ? targets : [];
    const stopWhenExpLimit = options.stopWhenExpLimit === true;
    const expLimitReached = options.expLimitReached === true;
    const guardTargets = list.filter(canContinueHelpAfterExpLimit);

    if (!stopWhenExpLimit || !expLimitReached) {
        return {
            targets: list,
            guardDogOnly: false,
            eligibleGuardDogCount: guardTargets.length,
            skippedNonGuardDogCount: 0,
        };
    }

    return {
        targets: guardTargets,
        guardDogOnly: true,
        eligibleGuardDogCount: guardTargets.length,
        skippedNonGuardDogCount: Math.max(0, list.length - guardTargets.length),
    };
}

function getHelpTickDelayMs(options = {}) {
    const baseDelayMs = Math.max(1000, Number.parseInt(options.baseDelayMs, 10) || 1000);
    const stopWhenExpLimit = options.stopWhenExpLimit === true;
    const expLimitReached = options.expLimitReached === true;
    const eligibleGuardDogCount = Math.max(
        0,
        Number.parseInt(options.eligibleGuardDogCount, 10) || 0,
    );
    const noEligibleBackoffMs = Math.max(
        baseDelayMs,
        Number.parseInt(options.noEligibleBackoffMs, 10) || 60_000,
    );

    if (stopWhenExpLimit && expLimitReached && eligibleGuardDogCount <= 0) {
        return noEligibleBackoffMs;
    }
    return baseDelayMs;
}

function clearFriendDogStateMemoryForTest() {
    memoryCaches.clear();
}

module.exports = {
    GUARD_DOG_ID,
    normalizeCacheObject,
    readFriendDogInfoCache,
    rememberFriendDogProbe,
    getFriendDogInfo,
    getGuardDogGidSet,
    compareHelpTargets,
    canContinueHelpAfterExpLimit,
    shouldRunHelpTickAfterExpLimit,
    selectHelpTargetsAfterExpLimit,
    getHelpTickDelayMs,
    clearFriendDogStateMemoryForTest,
};
