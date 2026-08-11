const { execFileSync } = require('node:child_process');
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('./json-db');

const FARM_APP_ID = '1112386029';
const REGISTRY_FILE = getDataFile('desktop-sessions.json');

function now() {
    return Date.now();
}

function normalizePid(value) {
    const n = Number(value || 0);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function normalizeUin(value) {
    const text = String(value || '').trim();
    return /^\d{5,12}$/.test(text) ? text : '';
}

function normalizeBinding(input = {}) {
    const accountId = String(input.accountId || '').trim();
    return {
        accountId,
        qqUin: normalizeUin(input.qqUin),
        mainQqPid: normalizePid(input.mainQqPid),
        farmRootPid: normalizePid(input.farmRootPid),
        platformChannel: String(input.platformChannel || '').trim(),
        status: String(input.status || 'unknown'),
        needsRebind: input.needsRebind === true,
        boundAt: Number(input.boundAt || 0),
        updatedAt: Number(input.updatedAt || 0),
        lastSeenAt: Number(input.lastSeenAt || 0),
        note: String(input.note || '').trim(),
    };
}

function normalizeRegistry(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const bindings = Array.isArray(src.bindings)
        ? src.bindings.map(normalizeBinding).filter(item => item.accountId)
        : [];
    return {
        version: 1,
        bindings,
        updatedAt: Number(src.updatedAt || 0),
    };
}

function loadRegistry() {
    ensureDataDir();
    return normalizeRegistry(readJsonFile(REGISTRY_FILE, () => ({ version: 1, bindings: [], updatedAt: 0 })));
}

function saveRegistry(registry) {
    ensureDataDir();
    const data = normalizeRegistry(registry);
    data.updatedAt = now();
    writeJsonFileAtomic(REGISTRY_FILE, data);
    return data;
}

function getProcessSnapshot() {
    if (process.platform !== 'win32') return [];
    const ps = [
        '$ErrorActionPreference="SilentlyContinue";',
        'Get-CimInstance Win32_Process |',
        'Select-Object Name,ProcessId,ParentProcessId,ExecutablePath,CommandLine,CreationDate |',
        'ConvertTo-Json -Compress -Depth 3',
    ].join(' ');
    try {
        const out = execFileSync('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps,
        ], { windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
        const text = out.toString('utf8').trim();
        if (!text) return [];
        const parsed = JSON.parse(text);
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        return rows.map(row => ({
            name: String(row.Name || ''),
            pid: normalizePid(row.ProcessId),
            ppid: normalizePid(row.ParentProcessId),
            exe: String(row.ExecutablePath || ''),
            cmd: String(row.CommandLine || ''),
            created: String(row.CreationDate || ''),
        }));
    } catch {
        return [];
    }
}

function isMainQQ(row) {
    const name = String(row && row.name || '').toLowerCase();
    const cmd = String(row && row.cmd || '');
    return name === 'qq.exe'
        && !/--type=/i.test(cmd)
        && !/--loadapp=/i.test(cmd);
}

function isFarmRoot(row) {
    const name = String(row && row.name || '').toLowerCase();
    const cmd = String(row && row.cmd || '');
    return name === 'qq.exe'
        && /--loadapp=mini-app/i.test(cmd)
        && /--exApp=QQEXMiniProgram/i.test(cmd);
}

function parsePlatformChannel(cmd) {
    const m = String(cmd || '').match(/--pcqq-platform-channel-handle=(\d+)/i);
    return m ? m[1] : '';
}

function getDescendants(rows, rootPid) {
    const result = [];
    const queue = [normalizePid(rootPid)].filter(Boolean);
    const seen = new Set(queue);
    while (queue.length) {
        const parentPid = queue.shift();
        for (const row of rows) {
            const pid = normalizePid(row.pid);
            if (!pid || normalizePid(row.ppid) !== parentPid || seen.has(pid)) continue;
            seen.add(pid);
            result.push(row);
            queue.push(pid);
        }
    }
    return result;
}

function parseFarmUin(rows) {
    for (const row of rows || []) {
        const cmd = String(row && row.cmd || '');
        if (!cmd.includes(`appIdOrLink=${FARM_APP_ID}`)) continue;
        const match = cmd.match(/--annotation=uin=(\d{5,12})/i);
        if (match) return normalizeUin(match[1]);
    }
    return '';
}

function scanRuntimeSessions() {
    const rows = getProcessSnapshot();
    if (!rows.length) return [];
    const byPid = new Map(rows.map(row => [normalizePid(row.pid), row]));
    const roots = rows.filter(isFarmRoot);
    const sessions = [];

    for (const root of roots) {
        const directParent = byPid.get(normalizePid(root.ppid)) || null;
        const descendants = getDescendants(rows, root.pid);
        const qqUin = parseFarmUin(descendants);
        const mainQqPid = directParent && isMainQQ(directParent)
            ? normalizePid(directParent.pid)
            : 0;
        sessions.push({
            qqUin,
            mainQqPid,
            farmRootPid: normalizePid(root.pid),
            farmRootParentPid: normalizePid(root.ppid),
            platformChannel: parsePlatformChannel(root.cmd),
            directParentIsMainQQ: !!mainQqPid,
            detectedAt: now(),
        });
    }

    return sessions.sort((a, b) => a.mainQqPid - b.mainQqPid || a.farmRootPid - b.farmRootPid);
}

function findRuntimeSessionByFarmRootPid(farmRootPid, sessions = scanRuntimeSessions()) {
    const target = normalizePid(farmRootPid);
    return sessions.find(item => normalizePid(item.farmRootPid) === target) || null;
}

function getBindings() {
    return loadRegistry().bindings;
}

function getBinding(accountId) {
    const id = String(accountId || '').trim();
    if (!id) return null;
    return getBindings().find(item => item.accountId === id) || null;
}

function bindAccount(options = {}) {
    const accountId = String(options.accountId || '').trim();
    if (!accountId) throw new Error('missing accountId');

    const sessions = scanRuntimeSessions();
    const runtime = findRuntimeSessionByFarmRootPid(options.farmRootPid, sessions);
    if (!runtime) throw new Error('farm session not found');

    const suppliedUin = normalizeUin(options.qqUin);
    const qqUin = suppliedUin || normalizeUin(runtime.qqUin);
    const registry = loadRegistry();
    const previous = registry.bindings.find(item => item.accountId === accountId) || null;
    const stamp = now();
    const next = normalizeBinding({
        ...previous,
        accountId,
        qqUin,
        mainQqPid: runtime.mainQqPid,
        farmRootPid: runtime.farmRootPid,
        platformChannel: runtime.platformChannel,
        status: 'online',
        needsRebind: false,
        boundAt: previous && previous.boundAt ? previous.boundAt : stamp,
        updatedAt: stamp,
        lastSeenAt: stamp,
        note: options.note || (previous && previous.note) || '',
    });

    registry.bindings = registry.bindings.filter(item => item.accountId !== accountId);
    registry.bindings.push(next);
    saveRegistry(registry);
    return next;
}

function unbindAccount(accountId) {
    const id = String(accountId || '').trim();
    const registry = loadRegistry();
    const before = registry.bindings.length;
    registry.bindings = registry.bindings.filter(item => item.accountId !== id);
    saveRegistry(registry);
    return before !== registry.bindings.length;
}

function refreshBindings() {
    const registry = loadRegistry();
    const sessions = scanRuntimeSessions();
    const stamp = now();

    registry.bindings = registry.bindings.map(binding => {
        let runtime = null;
        if (binding.qqUin) {
            runtime = sessions.find(item => item.qqUin && item.qqUin === binding.qqUin) || null;
        }
        if (!runtime && binding.farmRootPid) {
            runtime = sessions.find(item => item.farmRootPid === binding.farmRootPid) || null;
        }
        if (!runtime && binding.mainQqPid) {
            runtime = sessions.find(item => item.mainQqPid === binding.mainQqPid) || null;
        }

        if (!runtime) {
            return normalizeBinding({
                ...binding,
                status: 'offline',
                needsRebind: true,
                updatedAt: stamp,
            });
        }

        return normalizeBinding({
            ...binding,
            qqUin: binding.qqUin || runtime.qqUin,
            mainQqPid: runtime.mainQqPid,
            farmRootPid: runtime.farmRootPid,
            platformChannel: runtime.platformChannel,
            status: 'online',
            needsRebind: false,
            lastSeenAt: stamp,
            updatedAt: stamp,
        });
    });

    const saved = saveRegistry(registry);
    return { bindings: saved.bindings, sessions };
}

function getStatus() {
    const synced = refreshBindings();
    return {
        registryFile: REGISTRY_FILE,
        bindings: synced.bindings,
        runtimeSessions: synced.sessions,
    };
}

module.exports = {
    REGISTRY_FILE,
    scanRuntimeSessions,
    getBindings,
    getBinding,
    bindAccount,
    unbindAccount,
    refreshBindings,
    getStatus,
};
