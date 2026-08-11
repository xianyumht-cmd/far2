const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, execSync } = require('node:child_process');

const APP_ID = '1112386029';
const MARKER = '/*__FAR2_CODE_MANAGER__*/';
const MINIAPP_URI = 'tencent://ntqq-open/?&subCmd=miniapp&action=openQQMiniApp&actionParams=%7B%22sourceType%22%3A%22open%22%2C%22appId%22%3A%221112386029%22%2C%22hostScene%22%3A%221246700100%22%7D';
let captureInFlight = null;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getQqexRoot() {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'QQEX');
}

function getMiniAppRoot() {
    return path.join(getQqexRoot(), 'miniapp', 'temps', 'miniapp_src');
}

function findFarmFolders() {
    const root = getMiniAppRoot();
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && new RegExp(`^${APP_ID}_3_.+$`).test(entry.name))
        .map(entry => path.join(root, entry.name));
}

function findGameJs(folder) {
    const direct = [
        path.join(folder, 'game.js'),
        path.join(folder, 'cocos-js', 'assets', 'game.js'),
    ];
    for (const file of direct) {
        try {
            if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
        } catch {}
    }

    const queue = [{ dir: folder, depth: 0 }];
    while (queue.length) {
        const { dir, depth } = queue.shift();
        if (depth > 2) continue;
        let entries = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isFile() && entry.name === 'game.js') return full;
            if (entry.isDirectory()) queue.push({ dir: full, depth: depth + 1 });
        }
    }
    return '';
}

function buildPayload(options = {}) {
    const closeDelayMs = Math.max(180, Math.min(10000, Number(options.closeDelayMs) || 180));
    return `${MARKER}\n;(function(){\n  var tries=0;\n  function closeSoon(api){\n    setTimeout(function(){\n      try{if(api&&typeof api.exitMiniProgram==='function') return api.exitMiniProgram();}catch(e){}\n      try{if(api&&typeof api.exitMiniApp==='function') return api.exitMiniApp();}catch(e){}\n    },${closeDelayMs});\n  }\n  function run(){\n    tries++;\n    var api=null;\n    try{if(typeof qq!=='undefined'&&qq&&typeof qq.login==='function') api=qq;}catch(e){}\n    if(!api){try{if(typeof wx!=='undefined'&&wx&&typeof wx.login==='function') api=wx;}catch(e){}}\n    if(!api){if(tries<120)setTimeout(run,250);return;}\n    try{api.login({success:function(res){\n      var code=res&&res.code?String(res.code):'';\n      if(!code)return;\n      try{if(typeof api.setClipboardData==='function')api.setClipboardData({data:code});}catch(e){}\n      try{var f=api.getFileSystemManager&&api.getFileSystemManager();var b=api.env&&api.env.USER_DATA_PATH?api.env.USER_DATA_PATH:'';if(f&&b)f.writeFileSync(b+'/_code.txt',code,'utf8');}catch(e){}\n      closeSoon(api);\n    },fail:function(){}});}catch(e){}\n  }\n  run();\n})();\n`;
}

function recoverIfNeeded(gameJs) {
    const backup = `${gameJs}.far2-code-manager.bak`;
    let original = fs.readFileSync(gameJs, 'utf8');
    if (original.includes(MARKER) && fs.existsSync(backup)) {
        original = fs.readFileSync(backup, 'utf8');
        fs.writeFileSync(gameJs, original, 'utf8');
    }
    return { original, backup };
}

function patchGameFiles(options = {}) {
    const folders = findFarmFolders();
    if (!folders.length) {
        const err = new Error(`未找到 QQ 农场缓存，请先在 Windows QQ 手动打开一次 QQ经典农场。期望目录: ${getMiniAppRoot()}`);
        err.code = 'missing_miniapp_cache';
        throw err;
    }

    const patched = [];
    for (const folder of folders) {
        const gameJs = findGameJs(folder);
        if (!gameJs) continue;
        const { original, backup } = recoverIfNeeded(gameJs);
        if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, 'utf8');
        fs.writeFileSync(gameJs, buildPayload(options) + original, 'utf8');
        patched.push({ gameJs, original, backup });
    }
    if (!patched.length) {
        const err = new Error('找到 QQ 农场缓存，但未找到 game.js');
        err.code = 'missing_game_js';
        throw err;
    }
    return patched;
}

function restoreGameFiles(patched) {
    for (const item of patched || []) {
        try {
            fs.writeFileSync(item.gameJs, item.original, 'utf8');
            if (fs.existsSync(item.backup)) fs.unlinkSync(item.backup);
        } catch {}
    }
}

function listCodeFiles(root = getQqexRoot()) {
    if (!root || !fs.existsSync(root)) return [];
    const stack = [root];
    const files = [];
    while (stack.length) {
        const dir = stack.pop();
        let entries = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) stack.push(full);
            else if (entry.isFile() && entry.name === '_code.txt') files.push(full);
        }
    }
    return files;
}

function clearOldCaptureArtifacts() {
    for (const file of listCodeFiles()) {
        try { fs.unlinkSync(file); } catch {}
    }
    try {
        execFileSync('cmd.exe', ['/c', 'echo.|clip'], { windowsHide: true, timeout: 2000 });
    } catch {}
}

function readClipboard() {
    try {
        const out = execFileSync('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-Command', 'Get-Clipboard -Raw',
        ], { windowsHide: true, timeout: 3000, maxBuffer: 1024 * 1024 });
        return out.toString('utf8').trim();
    } catch {
        return '';
    }
}

function isLikelyCode(value) {
    const code = String(value || '').trim();
    return code.length >= 6
        && code.length <= 256
        && /^[A-Za-z0-9_-]+$/.test(code)
        && !/^-\d+$/.test(code);
}

async function waitForRuntimeCode(startedAt, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        for (const file of listCodeFiles()) {
            try {
                const stat = fs.statSync(file);
                if (stat.mtimeMs < startedAt - 1000) continue;
                const code = fs.readFileSync(file, 'utf8').trim();
                if (isLikelyCode(code)) {
                    return { code, source: '_code.txt', capturedAt: stat.mtimeMs };
                }
            } catch {}
        }

        const clipboard = readClipboard();
        if (isLikelyCode(clipboard)) {
            return { code: clipboard, source: 'clipboard', capturedAt: Date.now() };
        }
        await sleep(250);
    }
    return null;
}

function openFarmMiniApp() {
    try {
        execSync(`rundll32 url.dll,FileProtocolHandler "${MINIAPP_URI}"`, { windowsHide: true, timeout: 10000 });
        return true;
    } catch {
        try {
            execSync(`cmd.exe /c start "" "${MINIAPP_URI}"`, { windowsHide: true, timeout: 10000, shell: true });
            return true;
        } catch {
            return false;
        }
    }
}

async function doCapture(options = {}) {
    if (process.platform !== 'win32') {
        const err = new Error('Windows QQ 运行时 Code 抓取仅支持 Windows');
        err.code = 'unsupported_platform';
        throw err;
    }

    const timeoutMs = Math.max(5000, Number(options.timeoutMs) || 90000);
    const closeDelayMs = Math.max(180, Math.min(10000, Number(options.closeDelayMs) || 180));
    const log = typeof options.log === 'function' ? options.log : null;
    clearOldCaptureArtifacts();

    let patched = [];
    try {
        patched = patchGameFiles({ closeDelayMs });
        if (log) log(`已临时注入 ${patched.length} 个 QQ 农场缓存`);
        const startedAt = Date.now();
        const opened = openFarmMiniApp();
        if (!opened && log) log('自动拉起 QQ经典农场失败，请手动打开小程序');

        const captured = await waitForRuntimeCode(startedAt, timeoutMs);
        if (!captured || !captured.code) {
            const err = new Error('等待 qq.login() 返回 fresh Code 超时');
            err.code = 'capture_timeout';
            throw err;
        }
        return captured;
    } finally {
        restoreGameFiles(patched);
    }
}

function captureFreshFarmCode(options = {}) {
    if (captureInFlight) return captureInFlight;
    captureInFlight = doCapture(options).finally(() => {
        captureInFlight = null;
    });
    return captureInFlight;
}

module.exports = {
    captureFreshFarmCode,
    getQqexRoot,
    getMiniAppRoot,
    findFarmFolders,
    isLikelyCode,
};
