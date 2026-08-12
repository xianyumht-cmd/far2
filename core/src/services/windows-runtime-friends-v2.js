const fs = require('node:fs');
const path = require('node:path');
const protobuf = require('protobufjs');
const { getResourcePath } = require('../config/runtime-paths');
const cryptoWasm = require('../utils/crypto-wasm');
const windowsRuntimeCode = require('./windows-runtime-code');

const MARKER = '/*__FAR2_FRIEND_CAPTURE_V2__*/';
const ARTIFACT_NAME = '_far2_friend_frames_v2.jsonl';
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
    const captureWindowMs = Math.max(15000, Math.min(90000, Number(options.captureWindowMs) || 45000));
    return `${MARKER}\n;(function(){\n  var tries=0;\n  var installedApis=[];\n  var seenTasks=[];\n  var sinks=[];\n  var webSocketHooked=false;\n  var maxFrames=1500;\n  var frameCount=0;\n  var byteCount=0;\n  var maxBytes=10*1024*1024;\n  function bytesOf(data){\n    try{\n      if(data instanceof ArrayBuffer)return new Uint8Array(data);\n      if(typeof ArrayBuffer!=='undefined'&&ArrayBuffer.isView&&ArrayBuffer.isView(data))return new Uint8Array(data.buffer,data.byteOffset||0,data.byteLength||0);\n      if(typeof data==='string'){var out=new Uint8Array(data.length);for(var i=0;i<data.length;i++)out[i]=data.charCodeAt(i)&255;return out;}\n    }catch(e){}\n    return null;\n  }\n  function b64(bytes,api){\n    try{if(api&&typeof api.arrayBufferToBase64==='function'){var slice=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);return api.arrayBufferToBase64(slice);}}catch(e){}\n    var chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';var out='';\n    for(var i=0;i<bytes.length;i+=3){var a=bytes[i],b=i+1<bytes.length?bytes[i+1]:0,c=i+2<bytes.length?bytes[i+2]:0;var n=(a<<16)|(b<<8)|c;out+=chars[(n>>18)&63]+chars[(n>>12)&63]+(i+1<bytes.length?chars[(n>>6)&63]:'=')+(i+2<bytes.length?chars[n&63]:'=');}\n    return out;\n  }\n  function addSink(api){\n    try{\n      var f=api&&api.getFileSystemManager&&api.getFileSystemManager();\n      var b=api&&api.env&&api.env.USER_DATA_PATH?api.env.USER_DATA_PATH:'';\n      if(!f||!b)return null;\n      var out=b+'/${ARTIFACT_NAME}';\n      for(var i=0;i<sinks.length;i++)if(sinks[i].out===out)return sinks[i];\n      var sink={f:f,out:out,api:api};sinks.push(sink);return sink;\n    }catch(e){return null;}\n  }\n  function writeLine(kind,payload){\n    try{if(!sinks.length)return;sinks[0].f.appendFileSync(sinks[0].out,String(kind)+'\\t'+String(payload||'').replace(/[\\r\\n]+/g,'')+'\\n','utf8');}catch(e){}\n  }\n  function meta(text){writeLine('m',String(text||'').replace(/[\\t]+/g,' '));}\n  function record(direction,data,api){\n    try{\n      var bytes=bytesOf(data);if(!bytes||!bytes.length||!sinks.length)return;\n      if(frameCount>=maxFrames||byteCount+bytes.length>maxBytes)return;\n      frameCount++;byteCount+=bytes.length;writeLine(direction,b64(bytes,api||sinks[0].api));\n    }catch(e){}\n  }\n  function collectIds(value,outOpen,outGid,depth){\n    if(depth>6||value===null||value===undefined)return;\n    if(Array.isArray(value)){for(var i=0;i<value.length&&i<500;i++)collectIds(value[i],outOpen,outGid,depth+1);return;}\n    if(typeof value!=='object')return;\n    var keys=[];try{keys=Object.keys(value);}catch(e){return;}\n    for(var j=0;j<keys.length&&j<80;j++){\n      var k=keys[j],v=value[k],lower=String(k).toLowerCase().replace(/[_-]/g,'');\n      if((lower==='openid'||lower==='friendopenid')&&typeof v==='string'&&v.length>=4&&v.length<=256){if(outOpen.indexOf(v)<0&&outOpen.length<500)outOpen.push(v);continue;}\n      if((lower==='gid'||lower==='friendgid')&&(typeof v==='number'||typeof v==='string')){var n=Number(v);if(isFinite(n)&&n>0&&Math.floor(n)===n&&outGid.indexOf(n)<0&&outGid.length<500)outGid.push(n);continue;}\n      collectIds(v,outOpen,outGid,depth+1);\n    }\n  }\n  function summarize(name,res){\n    try{\n      var openIds=[],gids=[];collectIds(res,openIds,gids,0);\n      var keys=res&&typeof res==='object'?Object.keys(res).slice(0,12):[];var maxArray=0;\n      for(var i=0;i<keys.length;i++){var v=res[keys[i]];if(Array.isArray(v)&&v.length>maxArray)maxArray=v.length;}\n      meta('api='+name+' maxArray='+maxArray+' openIds='+openIds.length+' gids='+gids.length+' keys='+keys.join(','));\n      if(openIds.length)writeLine('p',JSON.stringify(openIds));\n      if(gids.length)writeLine('g',JSON.stringify(gids));\n    }catch(e){}\n  }\n  function hookStructuredApi(api,name){\n    try{\n      if(!api||typeof api[name]!=='function'||api[name].__far2FriendHook)return;\n      var orig=api[name];\n      var wrapped=function(options){\n        var opts=options;\n        try{if(opts&&typeof opts==='object'){var next={};for(var k in opts)next[k]=opts[k];var success=opts.success;next.success=function(res){summarize(name,res);return success&&success(res);};opts=next;}}catch(e){}\n        var result=orig.call(api,opts);\n        try{if(result&&typeof result.then==='function')result.then(function(res){summarize(name,res);return res;});}catch(e){}\n        return result;\n      };wrapped.__far2FriendHook=true;api[name]=wrapped;\n    }catch(e){}\n  }\n  function hookRequest(api){\n    try{\n      if(!api||typeof api.request!=='function'||api.request.__far2FriendHook)return;\n      var orig=api.request;\n      var wrapped=function(options){\n        var opts=options;\n        try{if(opts&&typeof opts==='object'){var next={};for(var k in opts)next[k]=opts[k];var success=opts.success;next.success=function(res){summarize('request',res&&res.data!==undefined?res.data:res);return success&&success(res);};opts=next;}}catch(e){}\n        return orig.call(api,opts);\n      };wrapped.__far2FriendHook=true;api.request=wrapped;\n    }catch(e){}\n  }\n  function hookTask(task,api){\n    try{\n      if(!task||seenTasks.indexOf(task)>=0)return task;seenTasks.push(task);\n      if(typeof task.onMessage==='function'){var om=task.onMessage;task.onMessage=function(cb){return om.call(task,function(res){try{record('i',res&&res.data!==undefined?res.data:res,api);}catch(e){}return cb&&cb(res);});};}\n      if(typeof task.send==='function'){var os=task.send;task.send=function(options){try{record('o',options&&options.data!==undefined?options.data:options,api);}catch(e){}return os.apply(task,arguments);};}\n    }catch(e){}return task;\n  }\n  function installApi(api,label){\n    if(!api||installedApis.indexOf(api)>=0)return;installedApis.push(api);addSink(api);\n    try{if(typeof api.connectSocket==='function'&&!api.connectSocket.__far2FriendHook){var oc=api.connectSocket;var wc=function(){return hookTask(oc.apply(api,arguments),api);};wc.__far2FriendHook=true;api.connectSocket=wc;}}catch(e){}\n    try{if(typeof api.onSocketMessage==='function'&&!api.onSocketMessage.__far2FriendHook){var oo=api.onSocketMessage;var wo=function(cb){return oo.call(api,function(res){try{record('i',res&&res.data!==undefined?res.data:res,api);}catch(e){}return cb&&cb(res);});};wo.__far2FriendHook=true;api.onSocketMessage=wo;}}catch(e){}\n    hookStructuredApi(api,'getFriendCloudStorage');hookStructuredApi(api,'getPotentialFriendList');hookStructuredApi(api,'getGroupCloudStorage');hookStructuredApi(api,'getUserCloudStorage');hookRequest(api);\n    meta('installed='+label+' t='+tries);\n  }\n  function installWebSocket(api){\n    if(webSocketHooked)return;var g=null,NW=null;\n    try{g=typeof globalThis!=='undefined'?globalThis:null;NW=g&&g.WebSocket?g.WebSocket:(typeof WebSocket!=='undefined'?WebSocket:null);}catch(e){}if(!NW)return;\n    try{\n      var FW=function(){var args=Array.prototype.slice.call(arguments);var ws=typeof Reflect!=='undefined'&&Reflect.construct?Reflect.construct(NW,args):new (Function.prototype.bind.apply(NW,[null].concat(args)))();try{if(typeof ws.addEventListener==='function')ws.addEventListener('message',function(ev){record('i',ev&&ev.data,api);});}catch(e){}try{if(typeof ws.send==='function'){var os=ws.send;ws.send=function(data){record('o',data,api);return os.apply(ws,arguments);};}}catch(e){}return ws;};\n      FW.prototype=NW.prototype;try{Object.setPrototypeOf(FW,NW);}catch(e){}if(g)g.WebSocket=FW;else WebSocket=FW;webSocketHooked=true;meta('installed=WebSocket t='+tries);\n    }catch(e){}\n  }\n  function closeFarm(){var q=null,w=null;try{if(typeof qq!=='undefined'&&qq)q=qq;}catch(e){}try{if(typeof wx!=='undefined'&&wx)w=wx;}catch(e){}var list=[q,w];for(var i=0;i<list.length;i++){var api=list[i];if(!api)continue;try{if(typeof api.exitMiniProgram==='function')return api.exitMiniProgram();}catch(e){}try{if(typeof api.exitMiniApp==='function')return api.exitMiniApp();}catch(e){}}}\n  function run(){tries++;var q=null,w=null;try{if(typeof qq!=='undefined'&&qq)q=qq;}catch(e){}try{if(typeof wx!=='undefined'&&wx)w=wx;}catch(e){}if(q)installApi(q,'qq');if(w)installApi(w,'wx');installWebSocket(q||w);if(tries<120)setTimeout(run,250);}\n  run();setTimeout(closeFarm,${captureWindowMs});\n})();\n`;
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
        const backup = `${gameJs}.far2-friend-capture-v2.bak`;
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
    root.loadSync([
        getResourcePath('proto', 'game.proto'),
        getResourcePath('proto', 'friendpb.proto'),
    ], { keepCase: true });
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

function normalizeOpenId(value) {
    const text = String(value || '').trim();
    return text.length >= 4 && text.length <= 256 ? text : '';
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
            if (gids.length) return gids;
        } catch {}
    }
    return [];
}

function decodeSyncOpenIds(body, type) {
    try {
        const req = type.decode(body);
        const source = Array.isArray(req && req.open_ids) ? req.open_ids : [];
        const result = [];
        for (const raw of source) {
            const value = normalizeOpenId(raw);
            if (value && !result.includes(value)) result.push(value);
        }
        return result;
    } catch {
        return [];
    }
}

async function decodeCapturedFrame(entry) {
    const p = ensureParser();
    let msg;
    try { msg = p.GateMessage.decode(entry.frame); } catch { return null; }
    const meta = msg && msg.meta;
    if (!meta) return null;
    const serviceName = String(meta.service_name || '');
    const methodName = String(meta.method_name || '');
    const messageType = Number(meta.message_type) || 0;
    if (!serviceName && !methodName) return null;

    const decoded = {
        direction: String(entry.direction || '?'),
        serviceName,
        methodName,
        messageType,
        gids: [],
        openIds: [],
    };
    const isFriend = /FriendService/i.test(serviceName);
    if (!isFriend || !msg.body || !msg.body.length) return decoded;

    const rawBody = Buffer.from(msg.body);
    if (messageType === 1 && methodName === 'SyncAll') {
        decoded.openIds = decodeSyncOpenIds(rawBody, p.SyncAllRequest);
        if (!decoded.openIds.length) {
            try {
                const plain = await cryptoWasm.decryptBuffer(rawBody);
                decoded.openIds = decodeSyncOpenIds(plain, p.SyncAllRequest);
            } catch {}
        }
        return decoded;
    }

    if (messageType === 2) {
        const candidates = methodName === 'SyncAll'
            ? [p.SyncAllReply, p.GetAllReply]
            : [p.GetAllReply, p.SyncAllReply];
        decoded.gids = decodeFriendBody(rawBody, candidates);
        if (!decoded.gids.length) {
            try {
                const plain = await cryptoWasm.decryptBuffer(rawBody);
                decoded.gids = decodeFriendBody(plain, candidates);
            } catch {}
        }
    }
    return decoded;
}

async function readCapturedEntries(seen, metaLines, structuredOpenIds, structuredGids) {
    const entries = [];
    for (const file of listArtifactFiles()) {
        let text = '';
        try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
        for (const rawLine of text.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || seen.has(line)) continue;
            seen.add(line);
            const tab = line.indexOf('\t');
            const kind = tab >= 0 ? line.slice(0, tab) : 'i';
            const payload = tab >= 0 ? line.slice(tab + 1) : line;
            if (kind === 'm') {
                if (payload && !metaLines.includes(payload)) metaLines.push(payload);
                continue;
            }
            if (kind === 'p' || kind === 'g') {
                try {
                    const values = JSON.parse(payload);
                    if (kind === 'p' && Array.isArray(values)) {
                        for (const raw of values) {
                            const value = normalizeOpenId(raw);
                            if (value) structuredOpenIds.add(value);
                        }
                    }
                    if (kind === 'g' && Array.isArray(values)) {
                        for (const raw of values) {
                            const value = normalizeGid(raw);
                            if (value) structuredGids.add(value);
                        }
                    }
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

function summarizeObserved(observedCounts, limit = 18) {
    return [...observedCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([key, count]) => `${key}x${count}`);
}

async function waitForFriendData(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const seen = new Set();
    const gids = new Set();
    const openIds = new Set();
    const methods = new Set();
    const observedCounts = new Map();
    const metaLines = [];
    let lastNewAt = 0;

    while (Date.now() < deadline) {
        const beforeTotal = gids.size + openIds.size;
        const entries = await readCapturedEntries(seen, metaLines, openIds, gids);
        for (const entry of entries) {
            const decoded = await decodeCapturedFrame(entry);
            if (!decoded) continue;
            const key = `${decoded.direction}:${decoded.serviceName}.${decoded.methodName}[${decoded.messageType}]`;
            observedCounts.set(key, (observedCounts.get(key) || 0) + 1);
            if (/FriendService/i.test(decoded.serviceName) && decoded.methodName) methods.add(decoded.methodName);
            decoded.gids.forEach(gid => gids.add(gid));
            decoded.openIds.forEach(openId => openIds.add(openId));
        }
        if (gids.size + openIds.size > beforeTotal) lastNewAt = Date.now();
        if ((gids.size || openIds.size) && lastNewAt && Date.now() - lastNewAt >= 2200) break;
        await sleep(200);
    }

    return {
        gids: [...gids],
        openIds: [...openIds],
        methods: [...methods],
        frameCount: [...seen].filter(line => line.startsWith('i\t') || line.startsWith('o\t')).length,
        observed: summarizeObserved(observedCounts),
        metaLines: metaLines.slice(0, 24),
    };
}

async function doCapture(options = {}) {
    if (process.platform !== 'win32') {
        const err = new Error('QQ 农场好友运行时采集仅支持 Windows');
        err.code = 'unsupported_platform';
        throw err;
    }

    const timeoutMs = Math.max(15000, Number(options.timeoutMs) || 55000);
    const captureWindowMs = Math.max(15000, Math.min(90000, Number(options.captureWindowMs) || 45000));
    const log = typeof options.log === 'function' ? options.log : null;
    clearArtifacts();
    let patched = [];

    try {
        patched = patchGameFiles({ captureWindowMs });
        if (log) log(`已临时注入 ${patched.length} 个 QQ 农场缓存用于好友采集 V2`);
        if (!windowsRuntimeCode.openFarmMiniApp()) {
            const err = new Error('自动拉起 QQ经典农场失败');
            err.code = 'friend_capture_open_failed';
            throw err;
        }

        const captured = await waitForFriendData(timeoutMs);
        if (!captured.gids.length && !captured.openIds.length) {
            if (log) log(`好友采集未命中：frames=${captured.frameCount} observed=${captured.observed.join(' | ') || '-'} hooks=${captured.metaLines.join(' | ') || '-'}`);
            const err = new Error('等待 QQ 农场好友数据超时');
            err.code = 'friend_capture_timeout';
            err.captureDiagnostics = captured;
            throw err;
        }

        if (log) log(`好友采集完成 gids=${captured.gids.length} openIds=${captured.openIds.length} methods=${captured.methods.join(',') || '-'} observed=${captured.observed.join(' | ') || '-'}`);
        return {
            gids: captured.gids,
            openIds: captured.openIds,
            source: 'windows_qq_runtime_friend_capture_v2',
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
    normalizeGid,
    normalizeOpenId,
};
