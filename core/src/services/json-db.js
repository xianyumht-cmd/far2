const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');

const CRITICAL_JSON_BASENAMES = new Set([
    'accounts.json',
]);

function ensureParentDir(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function readTextFile(filePath, fallback = '') {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return fs.readFileSync(filePath, 'utf8');
    } catch {
        return fallback;
    }
}

function isCriticalJsonFile(filePath) {
    return CRITICAL_JSON_BASENAMES.has(path.basename(String(filePath || '')).toLowerCase());
}

function preserveCorruptJson(filePath) {
    try {
        const stat = fs.statSync(filePath);
        const stamp = Math.max(0, Math.trunc(Number(stat.mtimeMs) || 0));
        const size = Math.max(0, Number(stat.size) || 0);
        const backupPath = `${filePath}.corrupt-${stamp}-${size}.bak`;
        if (!fs.existsSync(backupPath)) {
            fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
        }
        return backupPath;
    } catch {
        return '';
    }
}

function createCriticalJsonError(filePath, reason, cause = null) {
    const backupPath = fs.existsSync(filePath) ? preserveCorruptJson(filePath) : '';
    const err = new Error(`Critical JSON state is unreadable: ${filePath} (${reason})`);
    err.code = 'critical_json_corrupt';
    err.filePath = filePath;
    err.reason = reason;
    err.backupPath = backupPath;
    if (cause) err.cause = cause;
    return err;
}

function readJsonFile(filePath, fallbackFactory = () => ({})) {
    const fallback = typeof fallbackFactory === 'function' ? fallbackFactory() : (fallbackFactory || {});
    if (!fs.existsSync(filePath)) return fallback;

    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        if (isCriticalJsonFile(filePath)) {
            throw createCriticalJsonError(filePath, 'read_failed', error);
        }
        return fallback;
    }

    if (!raw || !raw.trim()) {
        if (isCriticalJsonFile(filePath)) {
            throw createCriticalJsonError(filePath, 'empty_file');
        }
        return fallback;
    }

    try {
        return JSON.parse(raw);
    } catch (error) {
        if (isCriticalJsonFile(filePath)) {
            throw createCriticalJsonError(filePath, 'invalid_json', error);
        }
        return fallback;
    }
}

function writeJsonFileAtomic(filePath, data, space = 2) {
    const json = JSON.stringify(data, null, space);
    writeTextFileAtomic(filePath, json);
}

function writeTextFileAtomic(filePath, text = '') {
    ensureParentDir(filePath);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

    try {
        fs.writeFileSync(tmpPath, String(text), 'utf8');
        fs.renameSync(tmpPath, filePath);
    } finally {
        try {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {
            // ignore cleanup errors
        }
    }
}

module.exports = {
    readTextFile,
    readJsonFile,
    writeTextFileAtomic,
    writeJsonFileAtomic,
    isCriticalJsonFile,
};
