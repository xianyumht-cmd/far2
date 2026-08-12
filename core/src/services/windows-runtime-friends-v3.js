const fs = require('node:fs');
const path = require('node:path');
const protobuf = require('protobufjs');
const { getResourcePath } = require('../config/runtime-paths');
const cryptoWasm = require('../utils/crypto-wasm');
const windowsRuntimeCode = require('./windows-runtime-code');

const MARKER = '/*__FAR2_FRIEND_CAPTURE_V3__*/';
const ARTIFACT_NAME = '_far2_friend_frames_v3.jsonl';
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
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isFile() && entry.name === 'game.js') return full;
            if (entry.isDirectory()) queue.push({ dir: full, depth: depth + 1 });
        }
    }
    return '';
}

function buildPayload(options = {}) {
    const captureWindowMs = Math.max(20000, Math.min(90000, Number(options.captureWindowMs) || 50000));
    return `${MARKER}\n;(function(){\n  var tries=0, installed=false, socketHooked=false, wsHooked=false, frameCount=0, byteCount=0;\n  var maxFrames=1800, maxBytes=12*1024*1024, sink=null, apiRef=null;\n  function bytesOf(data){try{if(data instanceof ArrayBuffer)return new Uint8Array(data);if(typeof ArrayBuffer!=='undefined'&&ArrayBuffer.isView&&ArrayBuffer.isView(data))return new Uint8Array(data.buffer,data.byteOffset||0,data.byteLength||0);if(typeof data==='string'){var out=new Uint8Array(data.length);for(var i=0;i<data.length;i++)out[i]=data.charCodeAt(i)&255;return out;}}catch(e){}return null;}\n  function b64(bytes,api){try{if(api&&typeof api.arrayBufferToBase64==='function'){var slice=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);return api.arrayBufferToBase64(slice);}}catch(e){}var chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';var out='';for(var i=0;i<bytes.length;i+=3){var a=bytes[i],b=i+1<bytes.length?bytes[i+1]:0,c=i+2<bytes.length?bytes[i+2]:0,n=(a<<16)|(b<<8)|c;out+=chars[(n>>18)&63]+chars[(n>>12)&63]+(i+1<bytes.length?chars[(n>>6)&63]:'=')+(i+2<bytes.length?chars[n&63]:'=');}return out;}\n  function line(kind,payload){try{if(!sink)return;sink.f.appendFileSync(sink.out,String(kind)+'\\t'+String(payload||'').replace(/[\\r\\n]+/g,'')+'\\n','utf8');}catch(e){}}\n  function meta(text){line('m',String(text||'').replace(/[\\t]+/g,' '));}\n  function record(direction,data){try{var bytes=bytesOf(data);if(!bytes||!bytes.length||!sink)return;if(frameCount>=maxFrames||byteCount+bytes.length>maxBytes)return;frameCount++;byteCount+=bytes.length;line(direction,b64(bytes,apiRef));}catch(e){}}\n  function collect(value,openIds,gids,depth){if(depth>7||value===null||value===undefined)return;if(Array.isArray(value)){for(var i=0;i<value.length&&i<800;i++)collect(value[i],openIds,gids,depth+1);return;}if(typeof value!=='object')return;var keys=[];try{keys=Object.keys(value);}catch(e){return;}for(var j=0;j<keys.length&&j<120;j++){var k=keys[j],v=value[k],lower=String(k).toLowerCase().replace(/[_-]/g,'');if((lower==='openid'||lower==='friendopenid')&&typeof v==='string'&&v.length>=4&&v.length<=256){if(openIds.indexOf(v)<0&&openIds.length<800)openIds.push(v);continue;}if((lower==='gid'||lower==='friendgid')&&(typeof v==='number'||typeof v==='string')){var n=Number(v);if(isFinite(n)&&n>0&&Math.floor(n)===n&&gids.indexOf(n)<0&&gids.length<800)gids.push(n);continue;}collect(v,openIds,gids,depth+1);}}\n  function structured(name,res){try{var openIds=[],gids=[];collect(res,openIds,gids,0);var keys=res&&typeof res==='object'?Object.keys(res).slice(0,16):[];var maxArray=0;for(var i=0;i<keys.length;i++){var v=res[keys[i]];if(Array.isArray(v)&&v.length>maxArray)maxArray=v.length;}meta('api='+name+' maxArray='+maxArray+' openIds='+openIds.length+' gids='+gids.length+' keys='+keys.join(','));if(openIds.length)line('p',JSON.stringify(openIds));if(gids.length)line('g',JSON.stringify(gids));}catch(e){}}\n  function hookStructured(api,name){try{if(!api||typeof api[name]!=='function'||api[name].__far2v3)return;var orig=api[name];var wrapped=function(options){var opts=options;try{if(opts&&typeof opts==='object'){var next={};for(var k in opts)next[k]=opts[k];var success=opts.success;next.success=function(res){structured(name,res);return success&&success(res);};opts=next;}}catch(e){}var result=orig.call(api,opts);try{if(result&&typeof result.then==='function')result.then(function(res){structured(name,res);return res;});}catch(e){}return result;};wrapped.__far2v3=true;api[name]=wrapped;}catch(e){}}\n  function hookRequest(api){try{if(!api||typeof api.request!=='function'||api.request.__far2v3)return;var orig=api.request;var wrapped=function(options){var opts=options;try{if(opts&&typeof opts==='object'){var next={};for(var k in opts)next[k]=opts[k];var success=opts.success;next.success=function(res){structured('request',res&&res.data!==undefined?res.data:res);return success&&success(res);};opts=next;}}catch(e){}return orig.call(api,opts);};wrapped.__far2v3=true;api.request=wrapped;}catch(e){}}\n  function hookTask(task){try{if(!task||task.__far2v3)return task;task.__far2v3=true;if(typeof task.onMessage==='function'){var om=task.onMessage;task.onMessage=function(cb){return om.call(task,function(res){record('i',res&&res.data!==undefined?res.data:res);return cb&&cb(res);});};}if(typeof task.send==='function'){var os=task.send;task.send=function(options){record('o',options&&options.data!==undefined?options.data:options);return os.apply(task,arguments);};}}catch(e){}return task;}\n  function hookSocket(api){if(socketHooked)return;try{if(typeof api.connectSocket==='function'){var oc=api.connectSocket;api.connectSocket=function(){return hookTask(oc.apply(api,arguments));};socketHooked=true;meta('hook=connectSocket');}}catch(e){}try{if(typeof api.onSocketMessage==='function'){var oo=api.onSocketMessage;api.onSocketMessage=function(cb){return oo.call(api,function(res){record('i',res&&res.data!==undefined?res.data:res);return cb&&cb(res);});};meta('hook=onSocketMessage');}}catch(e){}}\n  function hookWebSocket(){if(wsHooked)return;var g=null,NW=null;try{g=typeof globalThis!=='undefined'?globalThis:null;NW=g&&g.WebSocket?g.WebSocket:(typeof WebSocket!=='undefined'?WebSocket:null);}catch(e){}if(!NW)return;try{var FW=function(){var args=Array.prototype.slice.call(arguments);var ws=typeof Reflect!=='undefined'&&Reflect.construct?Reflect.construct(NW,args):new (Function.prototype.bind.apply(NW,[null].concat(args)))();try{if(typeof ws.addEventListener==='function')ws.addEventListener('message',function(ev){record('i',ev&&ev.data);});}catch(e){}try{if(typeof ws.send==='function'){var os=ws.send;ws.send=function(data){record('o',data);return os.apply(ws,arguments);};}}catch(e){}return ws;};FW.prototype=NW.prototype;try{Object.setPrototypeOf(FW,NW);}catch(e){}if(g)g.WebSocket=FW;else WebSocket=FW;wsHooked=true;meta('hook=WebSocket');}catch(e){}}\n  function tryPrepare(api,label){try{if(!api)return false;var f=api.getFileSystemManager&&api.getFileSystemManager();var b=api.env&&api.env.USER_DATA_PATH?api.env.USER_DATA_PATH:'';if(!f||!b)return false;var out=b+'/${ARTIFACT_NAME}';try{f.appendFileSync(out,'m\\tready='+label+' try='+tries+'\\n','utf8');}catch(e){return false;}sink={f:f,out:out};apiRef=api;installed=true;hookSocket(api);hookWebSocket();hookStructured(api,'getPotentialFriendList');hookStructured(api,'getFriendCloudStorage');hookStructured(api,'getGroupCloudStorage');hookStructured(api,'getUserCloudStorage');hookRequest(api);meta('installed='+label+' try='+tries);try{if(typeof api.getPotentialFriendList==='function')api.getPotentialFriendList({success:function(res){structured('getPotentialFriendList.probe',res);},fail:function(){meta('probe=getPotentialFriendList failed');}});}catch(e){}return true;}catch(e){return false;}}\n  function run(){if(installed)return;tries++;var q=null,w=null;try{if(typeof qq!=='undefined'&&qq&&typeof qq.login==='function')q=qq;}catch(e){}try{if(typeof wx!=='undefined'&&wx&&typeof wx.login==='function')w=wx;}catch(e){}if(q&&tryPrepare(q,'qq'))return;if(w&&tryPrepare(w,'wx'))return;if(tries<160)setTimeout(run,250);}\n  function closeFarm(){var api=apiRef;if(!api)return;try{if(typeof api.exitMiniProgram==='function')return api.exitMiniProgram();}catch(e){}try{if(typeof api.exitMiniApp==='function')return api.exitMiniApp();}catch(e){}}\n  run();setTimeout(closeFarm,${captureWindowMs});\n})();\n`;
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
        const backup = `${gameJs}.far2-friend-capture-v3.bak`;
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
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
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
    root.loadSync([getResourcePath('proto', 'game.proto'), getResourcePath('proto', 'friendpb.proto')], { keepCase: true });
    parser = {
        GateMessage: root.lookupType('gatepb.Message'),
        GetAllReply: root.lookupType('gamepb.friendpb.GetAllReply'),
        SyncAllReply: root.lookupType('gamepb.friendpb.SyncAllReply'),
        SyncAllRequest: root.lookupType('gamepb.friendpb.SyncAllRequest'),
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

function extractFriendGids(reply) {
    const friends = Array.isArray(reply && reply.game_friends) ? reply.game_friends : [];
    const gids = [];
    for (const friend of friends) {
        const gid = normalizeGid(friend && friend.gid);
        if (gid > 0 && !gids.includes(gid)) gids.push(gid);
    }
    return gids;
}

async function decodeGateEntry(entry) {
    const p = ensureParser();
    let msg;
    try { msg = p.GateMessage.decode(entry.frame); } catch { return null; }
    const meta = msg && msg.meta;
    if (!meta) return null;
    const serviceName = String(meta.service_name || '');
    const methodName = String(meta.method_name || '');
    const messageType = Number(meta.message_type) || 0;
    if (!serviceName && !methodName) return null;
    const result = { direction: entry.direction, serviceName, methodName, messageType, gids: [], openIds: [] };
    if (!/FriendService/i.test(serviceName) || !msg.body || !msg.body.length) return result;
    const raw = Buffer.from(msg.body);
    if (entry.direction === 'i' && messageType === 2) {
        const candidates = methodName === 'SyncAll' ? [p.SyncAllReply, p.GetAllReply] : [p.GetAllReply, p.SyncAllReply];
        for (const type of candidates) {
            try {
                result.gids = extractFriendGids(type.decode(raw));
                if (result.gids.length) break;
            } catch {}
        }
        if (!result.gids.length) {
            try {
                const plain = await cryptoWasm.decryptBuffer(raw);
                for (const type of candidates) {
                    try {
                        result.gids = extractFriendGids(type.decode(plain));
                        if (result.gids.length) break;
                    } catch {}
                }
            } catch {}
        }
    }
    if (entry.direction === 'o' && /SyncAll/i.test(methodName)) {
        let plain = raw;
        let decoded = null;
        try { decoded = p.SyncAllRequest.decode(plain); } catch {}
        if (!decoded) {
            try { plain = await cryptoWasm.decryptBuffer(raw); decoded = p.SyncAllRequest.decode(plain); } catch {}
        }
        if (decoded) result.openIds = normalizeOpenIds(decoded.open_ids);
    }
    return result;
}

async function readArtifacts(seen, meta, openIds, gids) {
    const entries = [];
    for (const file of listArtifactFiles()) {
        let text = '';
        try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
        for (const rawLine of text.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || seen.has(line)) continue;
            seen.add(line);
            const tab = line.indexOf('\t');
            const kind = tab >= 0 ? line.slice(0, tab) : '';
            const payload = tab >= 0 ? line.slice(tab + 1) : '';
            if (kind === 'm') {
                if (payload && !meta.includes(payload)) meta.push(payload);
                continue;
            }
            if (kind === 'p' || kind === 'g') {
                try {
                    const list = JSON.parse(payload);
                    if (kind === 'p') normalizeOpenIds(list).forEach(v => openIds.add(v));
                    else (Array.isArray(list) ? list : []).map(normalizeGid).filter(Boolean).forEach(v => gids.add(v));
                } catch {}
                continue;
            }
            if (kind !== 'i' && kind !== 'o') continue;
            try {
                const frame = Buffer.from(payload, 'base64');
                if (frame.length) entries.push({ direction: kind, frame });
            } catch {}
        }
    }
    return entries;
}

function summarizeObserved(counts, limit = 20) {
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([key, count]) => `${key}x${count}`);
}

async function waitForData(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const seen = new Set();
    const meta = [];
    const openIds = new Set();
    const gids = new Set();
    const methods = new Set();
    const observedCounts = new Map();
    let lastNewAt = 0;

    while (Date.now() < deadline) {
        const beforeCount = openIds.size + gids.size;
        const entries = await readArtifacts(seen, meta, openIds, gids);
        for (const entry of entries) {
            const decoded = await decodeGateEntry(entry);
            if (!decoded) continue;
            const key = `${decoded.direction}:${decoded.serviceName}.${decoded.methodName}[${decoded.messageType}]`;
            observedCounts.set(key, (observedCounts.get(key) || 0) + 1);
            if (/FriendService/i.test(decoded.serviceName) && decoded.methodName) methods.add(decoded.methodName);
            decoded.gids.forEach(v => gids.add(v));
            decoded.openIds.forEach(v => openIds.add(v));
        }
        if (openIds.size + gids.size > beforeCount) lastNewAt = Date.now();
        if ((openIds.size > 0 || gids.size > 0) && lastNewAt && Date.now() - lastNewAt >= 2200) break;
        await sleep(200);
    }

    return {
        gids: [...gids],
        openIds: [...openIds],
        methods: [...methods],
        frameCount: [...seen].filter(line => line.startsWith('i\t') || line.startsWith('o\t')).length,
        observed: summarizeObserved(observedCounts),
        metaLines: meta.slice(0, 30),
    };
}

async function doCapture(options = {}) {
    if (process.platform !== 'win32') {
        const err = new Error('QQ 农场好友运行时采集仅支持 Windows');
        err.code = 'unsupported_platform';
        throw err;
    }
    const timeoutMs = Math.max(20000, Number(options.timeoutMs) || 65000);
    const captureWindowMs = Math.max(20000, Math.min(90000, Number(options.captureWindowMs) || 50000));
    const log = typeof options.log === 'function' ? options.log : null;
    clearArtifacts();
    let patched = [];
    try {
        patched = patchGameFiles({ captureWindowMs });
        if (log) log(`已临时注入 ${patched.length} 个 QQ 农场缓存用于好友采集 V3`);
        const opened = windowsRuntimeCode.openFarmMiniApp();
        if (!opened) {
            const err = new Error('自动拉起 QQ经典农场失败');
            err.code = 'friend_capture_open_failed';
            throw err;
        }
        const captured = await waitForData(timeoutMs);
        if (!captured.gids.length && !captured.openIds.length) {
            if (log) log(`好友采集未命中：frames=${captured.frameCount} observed=${captured.observed.join(' | ') || '-'} hooks=${captured.metaLines.join(' | ') || '-'}`);
            const err = new Error('等待 QQ 农场好友数据超时');
            err.code = 'friend_capture_timeout';
            err.captureDiagnostics = captured;
            throw err;
        }
        if (log) log(`好友采集完成 gids=${captured.gids.length} openIds=${captured.openIds.length} methods=${captured.methods.join(',') || '-'} observed=${captured.observed.join(' | ') || '-'}`);
        return { ...captured, source: 'windows_qq_runtime_friend_capture_v3' };
    } finally {
        restoreGameFiles(patched);
        clearArtifacts();
    }
}

function captureFarmFriendGids(options = {}) {
    if (captureInFlight) return captureInFlight;
    captureInFlight = doCapture(options).finally(() => { captureInFlight = null; });
    return captureInFlight;
}

module.exports = { captureFarmFriendGids, normalizeGid, normalizeOpenIds };
