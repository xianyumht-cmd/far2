const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { execSync } = require('node:child_process');
const cryptoWasm = require('../src/utils/crypto-wasm');

const APP_ID = '1112386029';
const MARKER = '/*__FAR2_P7E_ADDFOOD_WIRE_CAPTURE__*/';
const CAPTURE_FILE = '_far2_p7e_addfood_wire.jsonl';
const MINIAPP_URI = 'tencent://ntqq-open/?&subCmd=miniapp&action=openQQMiniApp&actionParams=%7B%22sourceType%22%3A%22open%22%2C%22appId%22%3A%221112386029%22%2C%22hostScene%22%3A%221246700100%22%7D';
const KNOWN_FOOD_IDS = new Map([
    [90004, '1天狗粮'],
    [90005, '3天狗粮'],
    [90006, '5天狗粮'],
]);
const KNOWN_DURATIONS = new Map([
    [86400, '1天'],
    [259200, '3天'],
    [432000, '5天'],
]);

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

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
        .map(entry => path.join(root, entry.name));
}

function findGameJs(folder) {
    const direct = [
        path.join(folder, 'game.js'),
        path.join(folder, 'cocos-js', 'assets', 'game.js'),
    ];
    for (const file of direct) {
        if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
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
    return `${MARKER}\n;(function(){\n` +
`  if(globalThis.__far2P7eAddFoodWireInstalled)return;\n` +
`  globalThis.__far2P7eAddFoodWireInstalled=true;\n` +
`  var FILE='/${CAPTURE_FILE}';\n` +
`  function bytesOf(data){try{if(data instanceof ArrayBuffer)return new Uint8Array(data);if(ArrayBuffer.isView&&ArrayBuffer.isView(data))return new Uint8Array(data.buffer,data.byteOffset,data.byteLength);}catch(e){}return null;}\n` +
`  function varint(b,p){var v=0,m=1,i=p;while(i<b.length&&i<p+10){var x=b[i++];v+=(x&127)*m;if((x&128)===0)return {v:v,n:i};m*=128;}return null;}\n` +
`  function fields(b){var out=[],p=0;while(p<b.length){var k=varint(b,p);if(!k)break;p=k.n;var f=Math.floor(k.v/8),w=k.v&7;if(w===0){var q=varint(b,p);if(!q)break;out.push({f:f,w:w,v:q.v});p=q.n;}else if(w===1){if(p+8>b.length)break;out.push({f:f,w:w,s:p,e:p+8});p+=8;}else if(w===2){var l=varint(b,p);if(!l)break;var s=l.n,e=s+l.v;if(e>b.length)break;out.push({f:f,w:w,s:s,e:e});p=e;}else if(w===5){if(p+4>b.length)break;out.push({f:f,w:w,s:p,e:p+4});p+=4;}else break;}return out;}\n` +
`  function text(b,s,e){try{return new TextDecoder('utf-8').decode(b.subarray(s,e));}catch(e1){var x='';try{for(var i=s;i<e;i++)x+=String.fromCharCode(b[i]);}catch(e2){}return x;}}\n` +
`  function hex(b,s,e){var out='';for(var i=s;i<e;i++)out+=(b[i]<16?'0':'')+b[i].toString(16);return out;}\n` +
`  function parseGate(data){var b=bytesOf(data);if(!b||!b.length)return null;var top=fields(b),mf=null,bf=null;for(var i=0;i<top.length;i++){if(top[i].f===1&&top[i].w===2&&!mf)mf=top[i];else if(top[i].f===2&&top[i].w===2&&!bf)bf=top[i];}if(!mf)return null;var mb=b.subarray(mf.s,mf.e),m=fields(mb),service='',method='',type=0;for(var j=0;j<m.length;j++){var r=m[j];if(r.f===1&&r.w===2)service=text(mb,r.s,r.e);else if(r.f===2&&r.w===2)method=text(mb,r.s,r.e);else if(r.f===3&&r.w===0)type=r.v;}return {service:service,method:method,messageType:type,bodyHex:bf?hex(b,bf.s,bf.e):'',bodyLength:bf?(bf.e-bf.s):0};}\n` +
`  function api(){try{if(typeof qq!=='undefined'&&qq)return qq;}catch(e){}try{if(typeof wx!=='undefined'&&wx)return wx;}catch(e){}return null;}\n` +
`  function append(row){try{var a=api();if(!a||!a.getFileSystemManager||!a.env||!a.env.USER_DATA_PATH)return;var f=a.getFileSystemManager(),file=a.env.USER_DATA_PATH+FILE,line=JSON.stringify(row)+'\\n';try{f.appendFileSync(file,line,'utf8');}catch(e){try{f.writeFileSync(file,line,'utf8');}catch(e2){}}}catch(e){}}\n` +
`  function record(data,transport){var x=parseGate(data);if(!x)return;if(x.service!=='gamepb.dogpb.DogService'||x.method!=='AddFood'||x.messageType!==1)return;append({t:(new Date()).toISOString(),transport:transport,service:x.service,method:x.method,bodyLength:x.bodyLength,bodyHex:x.bodyHex});}\n` +
`  function wrapTask(task,label){try{if(!task||task.__far2P7eAddFoodWrapped)return task;task.__far2P7eAddFoodWrapped=true;var send=task.send;if(typeof send==='function'){task.send=function(opt){try{record(opt&&Object.prototype.hasOwnProperty.call(opt,'data')?opt.data:opt,label);}catch(e){}return send.apply(this,arguments);};}}catch(e){}return task;}\n` +
`  function hookApi(a,name){try{if(!a||a.__far2P7eAddFoodConnectHooked)return false;var orig=a.connectSocket;if(typeof orig!=='function')return false;a.connectSocket=function(){return wrapTask(orig.apply(this,arguments),name+'.connectSocket');};a.__far2P7eAddFoodConnectHooked=true;return true;}catch(e){return false;}}\n` +
`  function hookNative(){try{if(typeof WebSocket==='undefined'||!WebSocket.prototype||WebSocket.prototype.__far2P7eAddFoodHooked)return false;var send=WebSocket.prototype.send;WebSocket.prototype.send=function(data){try{record(data,'WebSocket.send');}catch(e){}return send.apply(this,arguments);};WebSocket.prototype.__far2P7eAddFoodHooked=true;return true;}catch(e){return false;}}\n` +
`  var tries=0;function install(){tries++;try{hookNative();}catch(e){}try{if(typeof qq!=='undefined')hookApi(qq,'qq');}catch(e){}try{if(typeof wx!=='undefined')hookApi(wx,'wx');}catch(e){}if(tries<600)setTimeout(install,100);}\n` +
`  install();\n` +
`})();\n`;
}

function recoverIfNeeded(gameJs) {
    const backup = `${gameJs}.far2-p7e-addfood-wire.bak`;
    let current = fs.readFileSync(gameJs, 'utf8');
    if (current.includes(MARKER) && fs.existsSync(backup)) {
        current = fs.readFileSync(backup, 'utf8');
        fs.writeFileSync(gameJs, current, 'utf8');
    }
    return { original: current, backup };
}

function patchGameFiles() {
    const folders = findFarmFolders();
    if (!folders.length) throw new Error('未找到 QQ 农场缓存，请先手动打开一次 QQ经典农场。');
    const patched = [];
    for (const folder of folders) {
        const gameJs = findGameJs(folder);
        if (!gameJs) continue;
        const { original, backup } = recoverIfNeeded(gameJs);
        if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, 'utf8');
        fs.writeFileSync(gameJs, buildPayload() + original, 'utf8');
        patched.push({ gameJs, original, backup });
    }
    if (!patched.length) throw new Error('找到农场缓存，但没有找到 game.js。');
    return patched;
}

function restoreGameFiles(patched) {
    for (const item of patched || []) {
        try {
            fs.writeFileSync(item.gameJs, item.original, 'utf8');
            if (fs.existsSync(item.backup)) fs.unlinkSync(item.backup);
        } catch (err) {
            console.warn(`恢复失败: ${item.gameJs} -> ${err.message}`);
        }
    }
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
                if (row && row.service === 'gamepb.dogpb.DogService' && row.method === 'AddFood' && /^[0-9a-f]+$/i.test(String(row.bodyHex || ''))) rows.push(row);
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
            const hints = [];
            if (KNOWN_FOOD_IDS.has(v.value)) hints.push(`foodId:${KNOWN_FOOD_IDS.get(v.value)}`);
            if (KNOWN_DURATIONS.has(v.value)) hints.push(`duration:${KNOWN_DURATIONS.get(v.value)}`);
            if (v.value > 0 && v.value <= 100) hints.push('smallCountOrFlag');
            fields.push({ field, wire, value: v.value, hints });
        } else if (wire === 1) {
            if (pos + 8 > buf.length) throw new Error('truncated fixed64');
            fields.push({ field, wire, bytes: buf.subarray(pos, pos + 8).toString('hex') });
            pos += 8;
        } else if (wire === 2) {
            const len = readVarint(buf, pos);
            pos = len.next;
            if (pos + len.value > buf.length) throw new Error('truncated bytes');
            fields.push({ field, wire, length: len.value, bytes: buf.subarray(pos, pos + len.value).toString('hex') });
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

async function decodeCapturedBodies(rows) {
    const unique = [...new Set(rows.map(row => String(row.bodyHex || '').toLowerCase()).filter(Boolean))];
    const decoded = [];
    for (const cipherHex of unique) {
        const cipher = Buffer.from(cipherHex, 'hex');
        try {
            const plain = await cryptoWasm.decryptBuffer(cipher);
            let wire = null;
            let wireError = '';
            try { wire = parseWire(plain); } catch (err) { wireError = err.message; }
            decoded.push({
                cipherLength: cipher.length,
                cipherHex,
                plainLength: plain.length,
                plainHex: plain.toString('hex'),
                wire,
                wireError,
            });
        } catch (err) {
            decoded.push({ cipherLength: cipher.length, cipherHex, decryptError: err.message });
        }
    }
    return decoded;
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

function makeOutputPath() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.resolve(process.cwd(), `p7e-addfood-wire-${stamp}.json`);
}

async function main() {
    if (process.platform !== 'win32') throw new Error('该取证器仅支持 Windows QQ。');

    console.log('FAR2 P7E - DogService.AddFood 请求结构取证');
    console.log('范围: 只捕获官方客户端发出的 AddFood 业务 body（已知约 6B），随后用 FAR2 自带 tsdk.wasm 本地解密。');
    console.log('不会捕获 Login/Cookie/Farm Code/Token；不会由 FAR2 主动发送任何游戏写 RPC。');
    console.log('结束或报错时会恢复 QQ 农场 game.js。\n');

    await waitEnter('先关闭已经打开的 QQ经典农场窗口（QQ 主程序不用退出），然后按 Enter。');

    clearOldCaptureFiles();
    let patched = [];
    let restored = false;
    const cleanup = () => {
        if (restored) return;
        restored = true;
        restoreGameFiles(patched);
    };
    process.once('SIGINT', () => { cleanup(); process.exit(130); });
    process.once('SIGTERM', () => { cleanup(); process.exit(143); });

    try {
        patched = patchGameFiles();
        const startedAt = Date.now();
        const opened = openFarmMiniApp();
        console.log(opened ? '已请求重新打开 QQ经典农场。' : '自动打开失败，请现在手动打开 QQ经典农场。');

        await waitEnter('\n进入官方狗/宠物页面。如果当前有合法可用狗粮，请只正常喂 1 次（优先 1天狗粮）；完成后回这里按 Enter。没有可用条件就不要硬操作。');
        await sleep(800);

        const rows = readCaptureRows(startedAt);
        if (!rows.length) throw new Error('没有捕获到 DogService.AddFood。请确认本次确实在脚本运行期间正常喂食了一次。');
        const decoded = await decodeCapturedBodies(rows);
        const report = {
            generatedAt: new Date().toISOString(),
            appId: APP_ID,
            service: 'gamepb.dogpb.DogService',
            method: 'AddFood',
            captureCount: rows.length,
            uniqueBodyCount: decoded.length,
            credentialsCaptured: false,
            loginTrafficCaptured: false,
            addFoodBodyOnly: true,
            decoded,
        };
        const output = makeOutputPath();
        fs.writeFileSync(output, JSON.stringify(report, null, 2), 'utf8');

        console.log('\n=== AddFood 解密结果 ===');
        console.log(JSON.stringify(report, null, 2));
        console.log(`\n取证文件: ${output}`);
        console.log('把这个 p7e-addfood-wire-*.json 发给 ChatGPT。');
    } finally {
        cleanup();
        if (patched.length) console.log('\n已恢复 QQ 农场 game.js 原文件。');
    }
}

main().catch(err => {
    console.error('\n取证失败:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
});
