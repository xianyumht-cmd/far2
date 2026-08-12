const fs = require('node:fs');
const path = require('node:path');
const protobuf = require('protobufjs');
const { getResourcePath } = require('../config/runtime-paths');
const cryptoWasm = require('../utils/crypto-wasm');
const windowsRuntimeCode = require('./windows-runtime-code');

const APP_ID = '1112386029';
const MARKER = '/*__FAR2_FRIEND_CAPTURE__*/';
const ARTIFACT_NAME = '_far2_friend_frames.jsonl';
let captureInFlight = null;
let parser = null;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
    const captureWindowMs = Math.max(8000, Math.min(60000, Number(options.captureWindowMs) || 20000));
    return `${MARKER}\n;(function(){\n  var tries=0;\n  var hooked=false;\n  var seenTasks=[];\n  function ascii(bytes,needle){\n    if(!bytes||!bytes.length)return false;\n    for(var i=0;i<=bytes.length-needle.length;i++){var ok=true;for(var j=0;j<needle.length;j++){if(bytes[i+j]!==needle.charCodeAt(j)){ok=false;break;}}if(ok)return true;}\n    return false;\n  }\n  function bytesOf(data){\n    try{\n      if(data instanceof ArrayBuffer)return new Uint8Array(data);\n      if(typeof ArrayBuffer!=='undefined'&&ArrayBuffer.isView&&ArrayBuffer.isView(data))return new Uint8Array(data.buffer,data.byteOffset||0,data.byteLength||0);\n      if(typeof data==='string'){var out=new Uint8Array(data.length);for(var i=0;i<data.length;i++)out[i]=data.charCodeAt(i)&255;return out;}\n    }catch(e){}\n    return null;\n  }\n  function base64(bytes,api){\n    try{if(api&&typeof api.arrayBufferToBase64==='function'){var slice=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);return api.arrayBufferToBase64(slice);}}catch(e){}\n    var chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';var out='';\n    for(var i=0;i<bytes.length;i+=3){var a=bytes[i],b=i+1<bytes.length?bytes[i+1]:0,c=i+2<bytes.length?bytes[i+2]:0;var n=(a<<16)|(b<<8)|c;out+=chars[(n>>18)&63]+chars[(n>>12)&63]+(i+1<bytes.length?chars[(n>>6)&63]:'=')+(i+2<bytes.length?chars[n&63]:'=');}\n    return out;\n  }\n  function install(api){\n    if(hooked||!api)return;\n    hooked=true;\n    var f=null,b='';\n    try{f=api.getFileSystemManager&&api.getFileSystemManager();b=api.env&&api.env.USER_DATA_PATH?api.env.USER_DATA_PATH:'';}catch(e){}\n    var out=b?b+'/${ARTIFACT_NAME}':'';\n    try{if(f&&out)f.unlinkSync(out);}catch(e){}\n    function record(data){\n      try{var bytes=bytesOf(data);if(!bytes||!bytes.length)return;if(!ascii(bytes,'FriendService')&&!ascii(bytes,'friendpb'))return;if(f&&out)f.appendFileSync(out,base64(bytes,api)+'\\n','utf8');}catch(e){}\n    }\n    function hookTask(task){\n      try{if(!task||seenTasks.indexOf(task)>=0)return task;seenTasks.push(task);if(typeof task.onMessage==='function'){var om=task.onMessage;task.onMessage=function(cb){return om.call(task,function(res){try{record(res&&res.data);}catch(e){}return cb&&cb(res);});};}}catch(e){}return task;\n    }\n    try{if(typeof api.connectSocket==='function'){var oc=api.connectSocket;api.connectSocket=function(){return hookTask(oc.apply(api,arguments));};}}catch(e){}\n    try{if(typeof api.onSocketMessage==='function'){var oo=api.onSocketMessage;api.onSocketMessage=function(cb){return oo.call(api,function(res){try{record(res&&res.data);}catch(e){}return cb&&cb(res);});};}}catch(e){}\n    try{\n      if(typeof WebSocket!=='undefined'){var NW=WebSocket;var FW=function(){var ws=new (Function.prototype.bind.apply(NW,[null].concat(Array.prototype.slice.call(arguments))))();try{if(typeof ws.addEventListener==='function')ws.addEventListener('message',function(ev){record(ev&&ev.data);});}catch(e){}return ws;};FW.prototype=NW.prototype;try{Object.setPrototypeOf(FW,NW);}catch(e){}WebSocket=FW;}\n    }catch(e){}\n    setTimeout(function(){try{if(typeof api.exitMiniProgram==='function')return api.exitMiniProgram();}catch(e){}try{if(typeof api.exitMiniApp==='function')return api.exitMiniApp();}catch(e){}},${captureWindowMs});\n  }\n  function run(){tries++;var api=null;try{if(typeof qq!=='undefined'&&qq)api=qq;}catch(e){}if(!api){try{if(typeof wx!=='undefined'&&wx)api=wx;}catch(e){}}if(api){install(api);return;}if(tries<120)setTimeout(run,50);}\n  run();\n})();\n`;
}

function patchGameFiles(options = {}) {
    const folders = windowsRuntimeCode.findFarmFolders();
    if (!folders.length) {
        const err = new Error('未找到 QQ 农场缓存');
        err.code = 'missing_miniapp_cache';
        throw err;
    }

    const patched = [];
    for (const folder of folders) {
        const gameJs = findGameJs(folder);
        if (!gameJs) continue;
        const backup = `${gameJs}.far2-friend-capture.bak`;
        let original = fs.readFileSync(gameJs, 'utf8');
        if (original.includes(MARKER) && fs.existsSync(backup)) {
            original = fs.readFileSync(backup, 'utf8');
            fs.writeFileSync(gameJs, original, 'utf8');
        }
        if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, 'utf8');
        fs.writeFileSync(gameJs, buildPayload(options) + original, 'utf8');
        patched.push({ gameJs, backup, original });
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

function listArtifactFiles(root = windowsRuntimeCode.getQqexRoot()) {
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
            else if (entry.isFile() && entry.name === ARTIFACT_NAME) files.push(full);
        }
    }
    return files;
}

function clearArtifacts() {
    for (const file of listArtifactFiles()) {
        try { fs.unlinkSync(file); } catch {}
    }
}

function ensureParser() {
    if (parser) return parser;
    const root = new protobuf.Root();
    root.loadSync([
        getResourcePath('proto', 'game.proto'),
        getResourcePath('proto', 'friendpb.proto'),
    ], { keepCase: true });
    parser = {
        GateMessage: root.lookupType('gatepb.Message'),
        GetAllReply: root.lookupType('gamepb.friendpb.GetAllReply'),
        SyncAllReply: root.lookupType('gamepb.friendpb.SyncAllReply'),
    };
    return parser;
}

function normalizeGid(value) {
    let text = '';
    try { text = value && typeof value.toString === 'function' ? value.toString() : String(value || ''); } catch {}
    if (!/^\d+$/.test(text)) return 0;
    const num = Number(text);
    return Number.isSafeInteger(num) && num > 0 ? num : 0;
}

function decodeFriendBody(body, candidates) {
    for (const type of candidates) {
        try {
            const reply = type.decode(body);
            const friends = Array.isArray(reply && reply.game_friends) ? reply.game_friends : [];
            const gids = [];
            for (const friend of friends) {
                const gid = normalizeGid(friend && friend.gid);
                if (gid > 0 && !gids.includes(gid)) gids.push(gid);
            }
            if (gids.length > 0) return gids;
        } catch {}
    }
    return [];
}

async function decodeFriendFrame(frame) {
    const p = ensureParser();
    let msg;
    try {
        msg = p.GateMessage.decode(frame);
    } catch {
        return null;
    }
    const meta = msg && msg.meta;
    if (!meta || Number(meta.message_type) !== 2) return null;
    const serviceName = String(meta.service_name || '');
    const methodName = String(meta.method_name || '');
    if (!/friendpb\.FriendService/i.test(serviceName) && !/FriendService/i.test(serviceName)) return null;
    if (!msg.body || !msg.body.length) return { methodName, gids: [] };

    const candidates = methodName === 'SyncAll'
        ? [p.SyncAllReply, p.GetAllReply]
        : [p.GetAllReply, p.SyncAllReply];
    const rawBody = Buffer.from(msg.body);

    // Current FAR2 protocol receives response bodies as plaintext protobuf. Keep a
    // decrypt fallback only for a future server/client variant that wraps replies too.
    let gids = decodeFriendBody(rawBody, candidates);
    if (gids.length > 0) return { methodName, gids };

    try {
        const decrypted = await cryptoWasm.decryptBuffer(rawBody);
        gids = decodeFriendBody(decrypted, candidates);
    } catch {}
    return { methodName, gids };
}

async function readCapturedFrames(seen) {
    const frames = [];
    for (const file of listArtifactFiles()) {
        let text = '';
        try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
        for (const rawLine of text.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || seen.has(line)) continue;
            seen.add(line);
            try {
                const frame = Buffer.from(line, 'base64');
                if (frame.length > 0) frames.push(frame);
            } catch {}
        }
    }
    return frames;
}

async function waitForFriendGids(startedAt, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const seen = new Set();
    const gids = new Set();
    const methods = new Set();
    let lastNewAt = 0;

    while (Date.now() < deadline) {
        const frames = await readCapturedFrames(seen);
        for (const frame of frames) {
            const decoded = await decodeFriendFrame(frame);
            if (!decoded) continue;
            if (decoded.methodName) methods.add(decoded.methodName);
            const before = gids.size;
            decoded.gids.forEach(gid => gids.add(gid));
            if (gids.size > before) lastNewAt = Date.now();
        }

        if (gids.size > 0 && lastNewAt > 0 && Date.now() - lastNewAt >= 1800) {
            return { gids: [...gids], methods: [...methods], frameCount: seen.size, startedAt };
        }
        await sleep(200);
    }

    if (gids.size > 0) return { gids: [...gids], methods: [...methods], frameCount: seen.size, startedAt };
    return null;
}

async function doCapture(options = {}) {
    if (process.platform !== 'win32') {
        const err = new Error('QQ 农场好友运行时采集仅支持 Windows');
        err.code = 'unsupported_platform';
        throw err;
    }

    const timeoutMs = Math.max(8000, Number(options.timeoutMs) || 30000);
    const captureWindowMs = Math.max(8000, Math.min(60000, Number(options.captureWindowMs) || 20000));
    const log = typeof options.log === 'function' ? options.log : null;
    clearArtifacts();

    let patched = [];
    try {
        patched = patchGameFiles({ captureWindowMs });
        if (log) log(`已临时注入 ${patched.length} 个 QQ 农场缓存用于好友采集`);
        const startedAt = Date.now();
        const opened = windowsRuntimeCode.openFarmMiniApp();
        if (!opened) {
            const err = new Error('自动拉起 QQ经典农场失败');
            err.code = 'friend_capture_open_failed';
            throw err;
        }

        const captured = await waitForFriendGids(startedAt, timeoutMs);
        if (!captured || !captured.gids.length) {
            const err = new Error('等待 QQ 农场 FriendService 返回好友列表超时');
            err.code = 'friend_capture_timeout';
            throw err;
        }
        if (log) log(`好友采集完成 count=${captured.gids.length} methods=${captured.methods.join(',') || '-'}`);
        return {
            gids: captured.gids,
            source: 'windows_qq_runtime_friend_service',
            methods: captured.methods,
            frameCount: captured.frameCount,
        };
    } finally {
        restoreGameFiles(patched);
        clearArtifacts();
    }
}

function captureFarmFriendGids(options = {}) {
    if (captureInFlight) return captureInFlight;
    captureInFlight = doCapture(options).finally(() => {
        captureInFlight = null;
    });
    return captureInFlight;
}

module.exports = {
    captureFarmFriendGids,
    decodeFriendFrame,
    normalizeGid,
};
