const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { execSync } = require('node:child_process');

let cryptoWasm = null;
function getCryptoWasm() {
    if (!cryptoWasm) cryptoWasm = require('../src/utils/crypto-wasm');
    return cryptoWasm;
}

const APP_ID = '1112386029';
const SERVICE = 'gamepb.activitypb.ActivityService';
const READ_METHODS = new Set(['List', 'GetGroup']);
const MARKER = '/*__FAR2_ACTIVITY_WIRE_CAPTURE__*/';
const CAPTURE_FILE = '_far2_activity_wire.jsonl';
const MINIAPP_URI = 'tencent://ntqq-open/?&subCmd=miniapp&action=openQQMiniApp&actionParams=%7B%22sourceType%22%3A%22open%22%2C%22appId%22%3A%221112386029%22%2C%22hostScene%22%3A%221246700100%22%7D';
const MAX_PATCH_FOLDERS = 3;

function waitEnter(prompt) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(prompt, () => {
            rl.close();
            resolve();
        });
    });
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
        .map(entry => {
            const full = path.join(root, entry.name);
            let mtimeMs = 0;
            try { mtimeMs = fs.statSync(full).mtimeMs; } catch {}
            return { full, mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, MAX_PATCH_FOLDERS)
        .map(row => row.full);
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

function buildPayload() {
    const lines = [
        MARKER,
        ';(function(){',
        'if(globalThis.__far2ActivityWireInstalled)return;',
        'globalThis.__far2ActivityWireInstalled=true;',
        `var FILE=${JSON.stringify(`/${CAPTURE_FILE}`)};`,
        `var SERVICE=${JSON.stringify(SERVICE)};`,
        'var READ={List:1,GetGroup:1};',
        'function bytesOf(d){try{if(d instanceof ArrayBuffer)return new Uint8Array(d);if(ArrayBuffer.isView&&ArrayBuffer.isView(d))return new Uint8Array(d.buffer,d.byteOffset,d.byteLength);}catch(e){}return null;}',
        'function vi(b,p){var v=0,m=1,i=p;while(i<b.length&&i<p+10){var x=b[i++];v+=(x&127)*m;if((x&128)===0)return{v:v,n:i};m*=128;}return null;}',
        'function fields(b){var o=[],p=0;while(p<b.length){var k=vi(b,p);if(!k)break;p=k.n;var f=Math.floor(k.v/8),w=k.v&7;if(w===0){var q=vi(b,p);if(!q)break;o.push({f:f,w:w,v:q.v});p=q.n;}else if(w===1){if(p+8>b.length)break;o.push({f:f,w:w,s:p,e:p+8});p+=8;}else if(w===2){var l=vi(b,p);if(!l)break;var s=l.n,e=s+l.v;if(e>b.length)break;o.push({f:f,w:w,s:s,e:e});p=e;}else if(w===5){if(p+4>b.length)break;o.push({f:f,w:w,s:p,e:p+4});p+=4;}else break;}return o;}',
        "function text(b,s,e){try{return new TextDecoder('utf-8').decode(b.subarray(s,e));}catch(e1){return'';}}",
        "function hex(b,s,e){var o='';for(var i=s;i<e;i++)o+=(b[i]<16?'0':'')+b[i].toString(16);return o;}",
        "function gate(data){var b=bytesOf(data);if(!b||!b.length)return null;var t=fields(b),mf=null,bf=null;for(var i=0;i<t.length;i++){if(t[i].f===1&&t[i].w===2&&!mf)mf=t[i];else if(t[i].f===2&&t[i].w===2&&!bf)bf=t[i];}if(!mf)return null;var mb=b.subarray(mf.s,mf.e),m=fields(mb),svc='',method='',type=0;for(var j=0;j<m.length;j++){var r=m[j];if(r.f===1&&r.w===2)svc=text(mb,r.s,r.e);else if(r.f===2&&r.w===2)method=text(mb,r.s,r.e);else if(r.f===3&&r.w===0)type=r.v;}return{service:svc,method:method,messageType:type,bodyHex:bf?hex(b,bf.s,bf.e):'',bodyLength:bf?(bf.e-bf.s):0};}",
        "function api(){try{if(typeof qq!=='undefined'&&qq)return qq;}catch(e){}try{if(typeof wx!=='undefined'&&wx)return wx;}catch(e){}return null;}",
        "function append(row){try{var a=api();if(!a||!a.getFileSystemManager||!a.env||!a.env.USER_DATA_PATH)return;var f=a.getFileSystemManager(),file=a.env.USER_DATA_PATH+FILE,line=JSON.stringify(row)+'\\n';try{f.appendFileSync(file,line,'utf8');}catch(e){try{f.writeFileSync(file,line,'utf8');}catch(e2){}}}catch(e){}}",
        "function record(data,transport){var x=gate(data);if(!x||x.messageType!==1||x.service!==SERVICE||READ[x.method])return;append({t:(new Date()).toISOString(),transport:transport,service:x.service,method:x.method,bodyLength:x.bodyLength,bodyHex:x.bodyHex});}",
        "function wrapTask(task,label){try{if(!task||task.__far2ActivityWrapped)return task;task.__far2ActivityWrapped=true;var send=task.send;if(typeof send==='function'){task.send=function(opt){try{record(opt&&Object.prototype.hasOwnProperty.call(opt,'data')?opt.data:opt,label);}catch(e){}return send.apply(this,arguments);};}}catch(e){}return task;}",
        "function hookApi(a,name){try{if(!a||a.__far2ActivityConnectHooked)return false;var orig=a.connectSocket;if(typeof orig!=='function')return false;a.connectSocket=function(){return wrapTask(orig.apply(this,arguments),name+'.connectSocket');};a.__far2ActivityConnectHooked=true;return true;}catch(e){return false;}}",
        "function hookNative(){try{if(typeof WebSocket==='undefined'||!WebSocket.prototype||WebSocket.prototype.__far2ActivityHooked)return false;var send=WebSocket.prototype.send;WebSocket.prototype.send=function(data){try{record(data,'WebSocket.send');}catch(e){}return send.apply(this,arguments);};WebSocket.prototype.__far2ActivityHooked=true;return true;}catch(e){return false;}}",
        "var tries=0;function install(){tries++;try{hookNative();}catch(e){}try{if(typeof qq!=='undefined')hookApi(qq,'qq');}catch(e){}try{if(typeof wx!=='undefined')hookApi(wx,'wx');}catch(e){}if(tries<600)setTimeout(install,100);}install();",
        '})();',
        '',
    ];
    return lines.join('\n');
}

function patchGameFiles() {
    const patched = [];
    const folders = findFarmFolders();
    if (!folders.length) throw new Error('未找到 QQ经典农场缓存，请先正常打开一次农场。');

    try {
        for (const folder of folders) {
            const gameJs = findGameJs(folder);
            if (!gameJs) continue;

            const current = fs.readFileSync(gameJs, 'utf8');
            const backup = `${gameJs}.far2-activity-wire.bak`;
            let original = current;
            if (current.includes(MARKER) && fs.existsSync(backup)) {
                original = fs.readFileSync(backup, 'utf8');
            }

            if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, 'utf8');
            fs.writeFileSync(gameJs, buildPayload() + original, 'utf8');
            patched.push({ gameJs, original, backup });
        }
    } catch (error) {
        restoreGameFiles(patched);
        throw error;
    }

    if (!patched.length) throw new Error('找到农场缓存，但未找到 game.js。');
    return patched;
}

function restoreGameFiles(patched) {
    const failures = [];
    for (const item of patched || []) {
        try {
            fs.writeFileSync(item.gameJs, item.original, 'utf8');
            if (fs.existsSync(item.backup)) fs.unlinkSync(item.backup);
        } catch (error) {
            failures.push({ file: item.gameJs, error: error.message });
        }
    }
    return failures;
}

function listCaptureFiles(root = getQqexRoot()) {
    if (!fs.existsSync(root)) return [];
    const out = [];
    const stack = [root];
    while (stack.length) {
        const dir = stack.pop();
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) stack.push(full);
            else if (entry.isFile() && entry.name === CAPTURE_FILE) out.push(full);
        }
    }
    return out;
}

function clearOldCaptureFiles() {
    for (const file of listCaptureFiles()) {
        try { fs.unlinkSync(file); } catch {}
    }
}

function readCaptureRows(startedAt) {
    const rows = [];
    for (const file of listCaptureFiles()) {
        let stat;
        try { stat = fs.statSync(file); } catch { continue; }
        if (stat.mtimeMs < startedAt - 1000) continue;

        let text = '';
        try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
        for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
                const row = JSON.parse(line);
                if (!row || row.service !== SERVICE || READ_METHODS.has(row.method)) continue;
                if (row.bodyHex && !/^[0-9a-f]+$/i.test(String(row.bodyHex))) continue;
                rows.push(row);
            } catch {}
        }
    }
    return rows;
}

function readVarint(buf, start) {
    let value = 0;
    let mul = 1;
    let pos = start;
    while (pos < buf.length && pos < start + 10) {
        const byte = buf[pos++];
        value += (byte & 0x7f) * mul;
        if ((byte & 0x80) === 0) return { value, next: pos };
        mul *= 128;
    }
    throw new Error(`invalid varint at ${start}`);
}

function parseWire(buf) {
    const fields = [];
    let pos = 0;
    while (pos < buf.length) {
        const key = readVarint(buf, pos);
        pos = key.next;
        const field = Math.floor(key.value / 8);
        const wire = key.value & 7;
        if (field <= 0) throw new Error(`invalid field ${field}`);

        if (wire === 0) {
            const v = readVarint(buf, pos);
            pos = v.next;
            fields.push({ field, wire, value: v.value });
        } else if (wire === 1) {
            if (pos + 8 > buf.length) throw new Error('truncated fixed64');
            fields.push({ field, wire, bytes: buf.subarray(pos, pos + 8).toString('hex') });
            pos += 8;
        } else if (wire === 2) {
            const len = readVarint(buf, pos);
            pos = len.next;
            if (pos + len.value > buf.length) throw new Error('truncated bytes');
            const bytes = buf.subarray(pos, pos + len.value);
            let text = '';
            try {
                const candidate = bytes.toString('utf8');
                if (/^[\x20-\x7e\u4e00-\u9fff]+$/u.test(candidate)) text = candidate;
            } catch {}
            fields.push({ field, wire, length: len.value, bytes: bytes.toString('hex'), text });
            pos += len.value;
        } else if (wire === 5) {
            if (pos + 4 > buf.length) throw new Error('truncated fixed32');
            fields.push({ field, wire, bytes: buf.subarray(pos, pos + 4).toString('hex') });
            pos += 4;
        } else {
            throw new Error(`unsupported wire ${wire}`);
        }
    }
    return fields;
}

async function decodeRows(rows) {
    const byMethod = new Map();
    for (const row of rows || []) {
        const method = String(row && row.method || '');
        if (!method || READ_METHODS.has(method)) continue;
        if (!byMethod.has(method)) byMethod.set(method, new Set());
        byMethod.get(method).add(String(row.bodyHex || '').toLowerCase());
    }

    const result = [];
    for (const [method, bodies] of byMethod.entries()) {
        const decodedBodies = [];
        for (const cipherHex of bodies) {
            if (!cipherHex) {
                decodedBodies.push({
                    cipherLength: 0,
                    cipherHex: '',
                    plainLength: 0,
                    plainHex: '',
                    wire: [],
                    wireError: '',
                });
                continue;
            }

            const cipher = Buffer.from(cipherHex, 'hex');
            try {
                const plain = await getCryptoWasm().decryptBuffer(cipher);
                let wire = [];
                let wireError = '';
                try { wire = parseWire(plain); } catch (error) { wireError = error.message; }
                decodedBodies.push({
                    cipherLength: cipher.length,
                    cipherHex,
                    plainLength: plain.length,
                    plainHex: plain.toString('hex'),
                    wire,
                    wireError,
                });
            } catch (error) {
                decodedBodies.push({
                    cipherLength: cipher.length,
                    cipherHex,
                    decryptError: error.message,
                });
            }
        }
        result.push({ method, uniqueBodyCount: decodedBodies.length, bodies: decodedBodies });
    }
    return result.sort((a, b) => a.method.localeCompare(b.method));
}

function openFarmMiniApp() {
    try {
        execSync(`rundll32 url.dll,FileProtocolHandler "${MINIAPP_URI}"`, {
            windowsHide: true,
            timeout: 10000,
        });
        return true;
    } catch {
        try {
            execSync(`cmd.exe /c start "" "${MINIAPP_URI}"`, {
                windowsHide: true,
                timeout: 10000,
                shell: true,
            });
            return true;
        } catch {
            return false;
        }
    }
}

function outputPath() {
    const dir = path.join(os.tmpdir(), 'FAR2-ACTIVITY');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(dir, `activity-wire-capture-${stamp}.json`);
}

async function main() {
    if (process.platform !== 'win32') {
        throw new Error('该捕获器仅支持 Windows QQ。');
    }

    const startedAt = Date.now();
    clearOldCaptureFiles();
    const patched = patchGameFiles();
    let restoreFailures = [];

    try {
        console.log('FAR2 ActivityService 官方客户端写请求证据捕获');
        console.log('仅捕获 ActivityService，自动排除 List/GetGroup；FAR2 不发送任何活动写请求。');
        console.log(`已临时补丁 ${patched.length} 个最近 QQ 农场缓存，退出前会恢复。`);
        openFarmMiniApp();

        await waitEnter(
            '\n请在官方农场中只完成一个你要取证的免费/可领取活动动作，完成后回到这里按 Enter...',
        );
    } finally {
        restoreFailures = restoreGameFiles(patched);
    }

    if (restoreFailures.length > 0) {
        throw new Error(
            `QQ 缓存恢复不完整: ${restoreFailures.map(row => row.file).join(', ')}`,
        );
    }

    const rows = readCaptureRows(startedAt);
    const methods = await decodeRows(rows);
    const report = {
        generatedAt: new Date().toISOString(),
        appId: APP_ID,
        service: SERVICE,
        excludedReadMethods: [...READ_METHODS],
        captureCount: rows.length,
        methods,
        credentialsCaptured: false,
        loginTrafficCaptured: false,
        far2WriteSent: false,
        officialClientActionRequired: true,
        cacheFilesRestored: true,
    };

    const output = outputPath();
    fs.writeFileSync(output, JSON.stringify(report, null, 2), 'utf8');

    console.log(`\n捕获请求: ${rows.length}`);
    for (const row of methods) {
        console.log(`- ${row.method}: ${row.uniqueBodyCount} 个唯一 body`);
    }
    console.log(`结果文件: ${output}`);
    console.log('把 activity-wire-capture-*.json 发给 ChatGPT。');
}

if (require.main === module) {
    main().catch(error => {
        console.error('捕获失败:', error && error.stack ? error.stack : error);
        process.exitCode = 1;
    });
}

module.exports = {
    APP_ID,
    SERVICE,
    READ_METHODS,
    MARKER,
    CAPTURE_FILE,
    buildPayload,
    restoreGameFiles,
    readVarint,
    parseWire,
    decodeRows,
};
