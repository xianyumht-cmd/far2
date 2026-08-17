const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { ensureDataDir, getDataFile } = require('../config/runtime-paths');

const CONTROL_FILE_NAME = 'farm-window-control.json';
const CONTROLLER_STATUS_PREFIX = 'farm-window-cloak-status-';
const CONTROLLER_ONLINE_MS = 5000;

function getControlFile() {
    const override = String(process.env.FAR2_FARM_WINDOW_CONTROL_FILE || '').trim();
    if (override) {
        const file = path.resolve(override);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        return file;
    }

    ensureDataDir();
    return getDataFile(CONTROL_FILE_NAME);
}

function normalizeState(input = {}) {
    return {
        version: 1,
        hidden: input.hidden !== false,
        updatedAt: Number(input.updatedAt) || 0,
        updatedBy: String(input.updatedBy || ''),
    };
}

function parseJsonFile(file) {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
}

function readFarmWindowControl() {
    const file = getControlFile();
    if (!fs.existsSync(file)) return normalizeState({ hidden: true });

    try {
        const parsed = parseJsonFile(file);
        return normalizeState(parsed && typeof parsed === 'object' ? parsed : {});
    } catch {
        // Preserve the historical behavior if the control file is missing/corrupt:
        // farm windows stay hidden instead of suddenly appearing on the desktop.
        return normalizeState({ hidden: true });
    }
}

function writeFarmWindowControl(hidden, options = {}) {
    const file = getControlFile();
    const state = normalizeState({
        hidden: hidden === true,
        updatedAt: Date.now(),
        updatedBy: options.updatedBy || 'webui',
    });

    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return state;
}

function readFarmWindowControllerStatus() {
    const dir = path.dirname(getControlFile());
    const now = Date.now();
    const controllers = [];

    let names = [];
    try {
        names = fs.readdirSync(dir);
    } catch {}

    for (const name of names) {
        if (!name.startsWith(CONTROLLER_STATUS_PREFIX) || !name.endsWith('.json')) continue;
        try {
            const parsed = parseJsonFile(path.join(dir, name));
            const sessionId = Number(parsed && parsed.sessionId);
            const updatedAt = Number(parsed && parsed.updatedAt) || 0;
            const online = updatedAt > 0 && now - updatedAt >= 0 && now - updatedAt <= CONTROLLER_ONLINE_MS;
            controllers.push({
                version: Number(parsed && parsed.version) || 1,
                sessionId: Number.isFinite(sessionId) ? sessionId : -1,
                hidden: parsed && parsed.hidden !== false,
                updatedAt,
                online,
            });
        } catch {}
    }

    controllers.sort((a, b) => a.sessionId - b.sessionId);
    const onlineControllers = controllers.filter(item => item.online);
    return {
        online: onlineControllers.length > 0,
        onlineCount: onlineControllers.length,
        totalCount: controllers.length,
        allApplied: onlineControllers.length > 0
            && onlineControllers.every(item => item.hidden === readFarmWindowControl().hidden),
        controllers,
    };
}

function restartFarmWindowControllers() {
    if (process.platform !== 'win32') {
        return {
            supported: false,
            found: 0,
            restarted: 0,
            failed: 0,
            reason: 'windows_only',
        };
    }

    const script = [
        "$ErrorActionPreference = 'Stop'",
        "$tasks = @(Get-ScheduledTask -TaskName 'FAR2CodeAgent-*' -ErrorAction SilentlyContinue)",
        '$restarted = 0',
        '$failed = 0',
        'foreach ($task in $tasks) {',
        '  try {',
        '    Stop-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction SilentlyContinue',
        '    Start-Sleep -Milliseconds 300',
        '    Start-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction Stop',
        '    $restarted++',
        '  } catch { $failed++ }',
        '}',
        '[pscustomobject]@{ found = $tasks.Count; restarted = $restarted; failed = $failed } | ConvertTo-Json -Compress',
    ].join('\r\n');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');

    const output = childProcess.execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', encoded,
    ], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20000,
    });

    const parsed = JSON.parse(String(output || '').replace(/^\uFEFF/, '').trim() || '{}');
    return {
        supported: true,
        found: Number(parsed.found) || 0,
        restarted: Number(parsed.restarted) || 0,
        failed: Number(parsed.failed) || 0,
        reason: '',
    };
}

module.exports = {
    CONTROL_FILE_NAME,
    CONTROLLER_ONLINE_MS,
    getControlFile,
    readFarmWindowControl,
    writeFarmWindowControl,
    readFarmWindowControllerStatus,
    restartFarmWindowControllers,
};
