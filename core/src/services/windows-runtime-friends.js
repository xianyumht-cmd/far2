const fs = require('node:fs');
const path = require('node:path');
const protobuf = require('protobufjs');
const { getResourcePath } = require('../config/runtime-paths');
const cryptoWasm = require('../utils/crypto-wasm');
const windowsRuntimeCode = require('./windows-runtime-code');

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
    return `${MARKER}\n;(function(){\n  var tries=0;\n  var installedApis=[];\n  var seenTasks=[];\n  var sinks=[];\n  var webSocketHooked=false;\n  var capturedFrames=0;\n  var capturedBytes=0;\n  var maxFrames=1200;\n  var maxBytes=8*1024*1024;\n  function bytesOf(data){\n    try{\n      if(data instanceof ArrayBuffer)return new Uint8Array(data);\n      if(typeof ArrayBuffer!=='undefined'&&ArrayBuffer.isView&&ArrayBuffer.isView(data))return new Uint8Array(data.buffer,data.byteOffset||0,data.byteLength||0);\n      if(typeof data==='string'){var out=new Uint8Array(data.length);for(var i=0;i<data.length;i++)out[i]=data.charCodeAt(i)&255;return out;}\n    }catch(e){}\n    return null;\n  }\n  function base64(bytes,api){\n    try{if(api&&typeof api.arrayBufferToBase64==='function'){var slice=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);return api.arrayBufferToBase64(slice);}}catch(e){}\n    var chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';var out='';\n    for(var i=0;i<bytes.length;i+=3){var a=bytes[i],b=i+1<bytes.length?bytes[i+1]:0,c=i+2<bytes.length?bytes[i+2]:0;var n=(a<<16)|(b<<8)|c;out+=chars[(n>>18)&63]+chars[(n>>12)&63]+(i+1<bytes.length?chars[(n>>6)&63]:'=')+(i+2<bytes.length?chars[n&63]:'=');}\n    return out;\n  }\n  function addSink(api){\n    try{\n      var f=api&&api.getFileSystemManager&&api.getFileSystemManager();\n      var b=api&&api.env&&api.env.USER_DATA_PATH?api.env.USER_DATA_PATH:'';\n      if(!f||!b)return;\n      var out=b+'/${ARTIFACT_NAME}';\n      for(var i=0;i<sinks.length;i++){if(sinks[i].out===out)return;}\n      sinks.push({f:f,out:out,api:api});\n    }catch(e){}\n  }\n  function writeMeta(text){\n    try{if(!sinks.length)return;sinks[0].f.appendFileSync(sinks[0].out,'m\\t'+String(text||'').replace(/[\\r\\n\\t]+/g,' ')+'\\n','utf8');}catch(e){}\n  }\n  function record(direction,data,api){\n    try{\n      var bytes=bytesOf(data);\n      if(!bytes||!bytes.length||!sinks.length)return;\n      if(capturedFrames>=maxFrames||capturedBytes+bytes.length>maxBytes)return;\n      capturedFrames++;capturedBytes+=bytes.length;\n      var sink=sinks[0];\n      sink.f.appendFileSync(sink.out,String(direction||'i')+'\\t'+base64(bytes,api||sink.api)+'\\n','utf8');\n    }catch(e){}\n  }\n  function summarizeApiResult(name,res){\n    try{\n      var keys=[];var maxArray=0;\n      if(res&&typeof res==='object'){keys=Object.keys(res).slice(0,12);for(var i=0;i<keys.length;i++){var v=res[keys[i]];if(Array.isArray(v)&&v.length>maxArray)maxArray=v.length;}}\n      writeMeta('api='+name+' maxArray='+maxArray+' keys='+keys.join(','));\n    }catch(e){}\n  }\n  function hookSocialApi(api,name){\n    try{\n      if(!api||typeof api[name]!=='function'||api[name].__far2FriendHook)return;\n      var orig=api[name];\n      var wrapped=function(options){\n        var opts=options;\n        try{\n          if(opts&&typeof opts==='object'){\n            var next={};for(var k in opts)next[k]=opts[k];\n            var success=opts.success;\n            next.success=function(res){summarizeApiResult(name,res);return success&&success(res);};\n            opts=next;\n          }\n        }catch(e){}\n        var result=orig.call(api,opts);\n        try{if(result&&typeof result.then==='function')result.then(function(res){summarizeApiResult(name,res);return res;});}catch(e){}\n        return result;\n      };\n      wrapped.__far2FriendHook=true;\n      api[name]=wrapped;\n    }catch(e){}\n  }\n  function hookTask(task,api){\n    try{\n      if(!task||seenTasks.indexOf(task)>=0)return task;\n      seenTasks.push(task);\n      if(typeof task.onMessage==='function'){var om=task.onMessage;task.onMessage=function(cb){return om.call(task,function(res){try{record('i',res&&res.data!==undefined?res.data:res,api);}catch(e){}return cb&&cb(res);});};}\n      if(typeof task.send==='function'){var os=task.send;task.send=function(options){try{record('o',options&&options.data!==undefined?options.data:options,api);}catch(e){}return os.apply(task,arguments);};}\n    }catch(e){}\n    return task;\n  }\n  function installApi(api,label){\n    if(!api||installedApis.indexOf(api)>=0)return;\n    installedApis.push(api);\n    addSink(api);\n    try{if(typeof api.connectSocket==='function'&&!api.connectSocket.__far2FriendHook){var oc=api.connectSocket;var wc=function(){return hookTask(oc.apply(api,arguments),api);};wc.__far2FriendHook=true;api.connectSocket=wc;}}catch(e){}\n    try{if(typeof api.onSocketMessage==='function'&&!api.onSocketMessage.__far2FriendHook){var oo=api.onSocketMessage;var wo=function(cb){return oo.call(api,function(res){try{record('i',res&&res.data!==undefined?res.data:res,api);}catch(e){}return cb&&cb(res);});};wo.__far2FriendHook=true;api.onSocketMessage=wo;}}catch(e){}\n    hookSocialApi(api,'getFriendCloudStorage');\n    hookSocialApi(api,'getPotentialFriendList');\n    hookSocialApi(api,'getGroupCloudStorage');\n    hookSocialApi(api,'getUserCloudStorage');\n    writeMeta('installed='+label);\n  }\n  function installWebSocket(api){\n    if(webSocketHooked)return;\n    var g=null,NW=null;\n    try{g=typeof globalThis!=='undefined'?globalThis:null;NW=g&&g.WebSocket?g.WebSocket:(typeof WebSocket!=='undefined'?WebSocket:null);}catch(e){}\n    if(!NW)return;\n    try{\n      var FW=function(){\n        var args=Array.prototype.slice.call(arguments);\n        var ws=null;\n        try{ws=typeof Reflect!=='undefined'&&Reflect.construct?Reflect.construct(NW,args):new (Function.prototype.bind.apply(NW,[null].concat(args)))();}catch(e){return new (Function.prototype.bind.apply(NW,[null].concat(args)))();}\n        try{if(typeof ws.addEventListener==='function')ws.addEventListener('message',function(ev){record('i',ev&&ev.data,api);});}catch(e){}\n        try{if(typeof ws.send==='function'){var os=ws.send;ws.send=function(data){try{record('o',data,api);}catch(e){}return os.apply(ws,arguments);};}}catch(e){}\n        return ws;\n      };\n      FW.prototype=NW.prototype;try{Object.setPrototypeOf(FW,NW);}catch(e){}\n      if(g)g.WebSocket=FW;else WebSocket=FW;\n      webSocketHooked=true;writeMeta('installed=WebSocket');\n    }catch(e){}\n  }\n  function closeFarm(){\n    var q=null,w=null;try{if(typeof qq!=='undefined'&&qq)q=qq;}catch(e){}try{if(typeof wx!=='undefined'&&wx)w=wx;}catch(e){}\n    var list=[q,w];for(var i=0;i<list.length;i++){var api=list[i];if(!api)continue;try{if(typeof api.exitMiniProgram==='function')return api.exitMiniProgram();}catch(e){}try{if(typeof api.exitMiniApp==='function')return api.exitMiniApp();}catch(e){}}\n  }\n  function run(){\n    tries++;var q=null,w=null;\n    try{if(typeof qq!=='undefined'&&qq)q=qq;}catch(e){}\n    try{if(typeof wx!=='undefined'&&wx)w=wx;}catch(e){}\n    if(q)installApi(q,'qq');if(w)installApi(w,'wx');installWebSocket(q||w);\n    if(tries<120)setTimeout(run,50);\n  }\n  run();\n  setTimeout(closeFarm,${captureWindowMs});\n})();\n`;
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

async function decodeCapturedFrame(entry) {
    const p = ensureParser();
    const frame = entry && entry.frame ? entry.frame : entry;
    let msg;
    try {
        msg = p.GateMessage.decode(frame);
    } catch {
        return null;
    }
    const meta = msg && msg.meta;
    if (!meta) return null;

    const serviceName = String(meta.service_name || '');
    const methodName = String(meta.method_name || '');
    const messageType = Number(meta.message_type) || 0;
    if (!serviceName && !methodName) return null;

    const decoded = {
        direction: String(entry && entry.direction || '?'),
        serviceName,
        methodName,
        messageType,
        gids: [],
    };

    if (messageType !== 2) return decoded;
    if (!/friendpb\.FriendService/i.test(serviceName) && !/FriendService/i.test(serviceName)) return decoded;
    if (!msg.body || !msg.body.length) return decoded;

    const candidates = methodName === 'SyncAll'
        ? [p.SyncAllReply, p.GetAllReply]
        : [p.GetAllReply, p.SyncAllReply];
    const rawBody = Buffer.from(msg.body);

    decoded.gids = decodeFriendBody(rawBody, candidates);
    if (decoded.gids.length > 0) return decoded;

    try {
        const decrypted = await cryptoWasm.decryptBuffer(rawBody);
        decoded.gids = decodeFriendBody(decrypted, candidates);
    } catch {}
    return decoded;
}

async function decodeFriendFrame(frame) {
    const decoded = await decodeCapturedFrame({ direction: '?', frame });
    if (!decoded) return null;
    if (decoded.messageType !== 2) return null;
    if (!/friendpb\.FriendService/i.test(decoded.serviceName) && !/FriendService/i.test(decoded.serviceName)) return null;
    return { methodName: decoded.methodName, gids: decoded.gids };
}

async function readCapturedEntries(seen, metaLines) {
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
                if (metaLines && payload && !metaLines.includes(payload)) metaLines.push(payload);
                continue;
            }
            if (kind !== 'i' && kind !== 'o') continue;
            try {
                const frame = Buffer.from(payload, 'base64');
                if (frame.length > 0) entries.push({ direction: kind, frame });
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

async function waitForFriendGids(startedAt, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const seen = new Set();
    const gids = new Set();
    const methods = new Set();
    const observedCounts = new Map();
    const metaLines = [];
    let lastNewAt = 0;

    while (Date.now() < deadline) {
        const entries = await readCapturedEntries(seen, metaLines);
        for (const entry of entries) {
            const decoded = await decodeCapturedFrame(entry);
            if (!decoded) continue;

            const key = `${decoded.direction}:${decoded.serviceName}.${decoded.methodName}[${decoded.messageType}]`;
            observedCounts.set(key, (observedCounts.get(key) || 0) + 1);

            if (/FriendService/i.test(decoded.serviceName) && decoded.methodName) {
                methods.add(decoded.methodName);
            }
            const before = gids.size;
            decoded.gids.forEach(gid => gids.add(gid));
            if (gids.size > before) lastNewAt = Date.now();
        }

        if (gids.size > 0 && lastNewAt > 0 && Date.now() - lastNewAt >= 1800) {
            return {
                gids: [...gids],
                methods: [...methods],
                frameCount: seen.size,
                observed: summarizeObserved(observedCounts),
                metaLines: metaLines.slice(0, 20),
                startedAt,
            };
        }
        await sleep(200);
    }

    return {
        gids: [...gids],
        methods: [...methods],
        frameCount: seen.size,
        observed: summarizeObserved(observedCounts),
        metaLines: metaLines.slice(0, 20),
        startedAt,
    };
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
        if (!captured.gids.length) {
            if (log) {
                log(`好友采集未命中：frames=${captured.frameCount} observed=${captured.observed.join(' | ') || '-'} hooks=${captured.metaLines.join(' | ') || '-'}`);
            }
            const err = new Error('等待 QQ 农场好友数据超时');
            err.code = 'friend_capture_timeout';
            err.captureDiagnostics = captured;
            throw err;
        }
        if (log) {
            log(`好友采集完成 count=${captured.gids.length} methods=${captured.methods.join(',') || '-'} observed=${captured.observed.join(' | ') || '-'}`);
        }
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
