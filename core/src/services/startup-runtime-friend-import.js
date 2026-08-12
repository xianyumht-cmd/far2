const os = require('node:os');
const fs = require('node:fs');
const { getDataFile } = require('../config/runtime-paths');

const DEFAULT_POLL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function normalizeUin(value) {
    const text = String(value || '').trim();
    return /^\d{5,12}$/.test(text) ? text : '';
}

function normalizeGids(values) {
    const result = [];
    const seen = new Set();
    for (const raw of (Array.isArray(values) ? values : [])) {
        const value = Number(raw);
        if (!Number.isSafeInteger(value) || value <= 0 || seen.has(value)) continue;
        seen.add(value);
        result.push(value);
    }
    return result;
}

function normalizeOpenIds(values) {
    const result = [];
    const seen = new Set();
    for (const raw of (Array.isArray(values) ? values : [])) {
        const value = String(raw || '').trim();
        if (value.length < 4 || value.length > 256 || seen.has(value)) continue;
        seen.add(value);
        result.push(value);
    }
    return result;
}

function getBootStartedAt() {
    return Math.max(0, Date.now() - Math.round(os.uptime() * 1000));
}

function getArtifactPath(uin) {
    return getDataFile(`runtime-friend-gids-${uin}.json`);
}

function getAccountOpenIdsPath(accountId) {
    const safe = String(accountId || '').replace(/[^\w-]/g, '_');
    return getDataFile(`runtime-friend-openids-${safe}.json`);
}

function writeAccountOpenIds(accountId, artifact) {
    const openIds = normalizeOpenIds(artifact && artifact.openIds);
    if (!openIds.length) return false;
    const file = getAccountOpenIdsPath(accountId);
    const temp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify({
        version: 1,
        accountId: String(accountId),
        capturedAt: Number(artifact.capturedAt) || Date.now(),
        source: String(artifact.source || 'windows_qq_runtime_friend_capture_v2'),
        openIds,
    }, null, 2), 'utf8');
    fs.renameSync(temp, file);
    return true;
}

function readArtifact(uin, bootStartedAt) {
    const file = getArtifactPath(uin);
    if (!fs.existsSync(file)) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (normalizeUin(parsed && parsed.qqUin) !== uin) return null;
        const artifactBoot = Number(parsed && parsed.bootStartedAt) || 0;
        if (!artifactBoot || Math.abs(artifactBoot - bootStartedAt) >= 60 * 1000) return null;
        const gids = normalizeGids(parsed && parsed.gids);
        const openIds = normalizeOpenIds(parsed && parsed.openIds);
        if (!gids.length && !openIds.length) return null;
        return {
            gids,
            openIds,
            capturedAt: Number(parsed.capturedAt) || 0,
            source: String(parsed.source || 'windows_qq_runtime_friend_capture_v2'),
            methods: Array.isArray(parsed.methods) ? parsed.methods.map(String).slice(0, 8) : [],
        };
    } catch {
        return null;
    }
}

function createStartupRuntimeFriendImport(options = {}) {
    const store = options.store;
    const processRef = options.processRef || process;
    const workers = options.workers || {};
    const log = typeof options.log === 'function' ? options.log : (() => {});
    const broadcastConfigToWorkers = typeof options.broadcastConfigToWorkers === 'function'
        ? options.broadcastConfigToWorkers
        : (() => {});
    const pollMs = Math.max(500, Number(options.pollMs) || DEFAULT_POLL_MS);
    const timeoutMs = Math.max(10 * 1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);

    let timer = null;
    let started = false;
    let startedAt = 0;
    let bootStartedAt = 0;
    const importedAccounts = new Set();

    function configuredAccounts() {
        if (!store || typeof store.getAccounts !== 'function') return [];
        const data = store.getAccounts();
        const accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
        return accounts.filter(account => {
            const platform = String(account && account.platform || 'qq').toLowerCase();
            const uin = normalizeUin(account && (account.uin || account.qq));
            return platform === 'qq' && uin && account.codeRefreshEnabled === true;
        });
    }

    function importOne(account) {
        const accountId = String(account && account.id || '').trim();
        const uin = normalizeUin(account && (account.uin || account.qq));
        if (!accountId || !uin || importedAccounts.has(accountId)) return false;

        const artifact = readArtifact(uin, bootStartedAt);
        if (!artifact) return false;

        const before = normalizeGids(store.getKnownFriendGids ? store.getKnownFriendGids(accountId) : []);
        const merged = normalizeGids([...before, ...artifact.gids]);
        const beforeSet = new Set(before);
        const addedCount = merged.filter(gid => !beforeSet.has(gid)).length;
        const savedOpenIds = writeAccountOpenIds(accountId, artifact);

        if (typeof store.setKnownFriendGids === 'function' && addedCount > 0) {
            store.setKnownFriendGids(accountId, merged);
        }
        importedAccounts.add(accountId);
        if (addedCount > 0) broadcastConfigToWorkers(accountId);

        log('好友', `QQ 小程序启动好友导入：直接 GID ${artifact.gids.length} 个，openId ${artifact.openIds.length} 个，新增 GID ${addedCount} 个，当前 GID 共 ${merged.length} 个`, {
            accountId,
            accountName: account.name || accountId,
            module: 'friend',
            event: 'QQ小程序启动好友导入',
            result: 'ok',
            capturedGidCount: artifact.gids.length,
            capturedOpenIdCount: artifact.openIds.length,
            openIdsSaved: savedOpenIds,
            addedCount,
            totalKnownGids: merged.length,
            source: artifact.source,
            methods: artifact.methods,
            workerRunning: !!workers[accountId],
        });
        return true;
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
        started = false;
    }

    function tick() {
        const accounts = configuredAccounts();
        for (const account of accounts) importOne(account);

        if (accounts.length > 0 && accounts.every(account => importedAccounts.has(String(account.id || '')))) {
            stop();
            return;
        }

        if (Date.now() - startedAt >= timeoutMs) {
            const pending = accounts.filter(account => !importedAccounts.has(String(account.id || '')));
            if (pending.length > 0) {
                log('好友', `本次启动未采集到 ${pending.length} 个 QQ 账号的小程序好友数据，继续使用现有 GID；下次 Windows 登录会再次尝试`, {
                    module: 'friend',
                    event: 'QQ小程序启动好友导入',
                    result: 'timeout',
                    pendingCount: pending.length,
                });
            }
            stop();
        }
    }

    function start() {
        if (started) return;
        if (processRef.platform !== 'win32') return;
        if (String(processRef.env.FAR2_STARTUP_FRIEND_IMPORT || '1') === '0') return;
        started = true;
        startedAt = Date.now();
        bootStartedAt = getBootStartedAt();
        tick();
        if (!started) return;
        timer = setInterval(tick, pollMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
    }

    return {
        start,
        stop,
        tick,
        getStatus() {
            return {
                started,
                importedAccountIds: [...importedAccounts],
                bootStartedAt,
            };
        },
    };
}

module.exports = {
    createStartupRuntimeFriendImport,
    normalizeGids,
    normalizeOpenIds,
    readArtifact,
};
