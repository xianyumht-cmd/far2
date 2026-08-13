const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { execSync } = require('node:child_process');

const APP_ID = '1112386029';
const MARKER = '/*__FAR2_P7E_DOG_RPC_CAPTURE__*/';
const CAPTURE_FILE = '_far2_p7e_dog_rpc.jsonl';
const MINIAPP_URI = 'tencent://ntqq-open/?&subCmd=miniapp&action=openQQMiniApp&actionParams=%7B%22sourceType%22%3A%22open%22%2C%22appId%22%3A%221112386029%22%2C%22hostScene%22%3A%221246700100%22%7D';

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
`  if(globalThis.__far2P7eDogRpcInstalled)return;\n` +
`  globalThis.__far2P7eDogRpcInstalled=true;\n` +
`  var FILE='/${CAPTURE_FILE}';\n` +
`  var seq=0;\n` +
`  function now(){try{return new Date().toISOString();}catch(e){return String(Date.now());}}\n` +
`  function bytesOf(data){\n` +
`    try{\n` +
`      if(data instanceof ArrayBuffer)return new Uint8Array(data);\n` +
`      if(ArrayBuffer.isView&&ArrayBuffer.isView(data))return new Uint8Array(data.buffer,data.byteOffset,data.byteLength);\n` +
`    }catch(e){}\n` +
`    return null;\n` +
`  }\n` +
`  function varint(b,p){var v=0,m=1,i=p;while(i<b.length&&i<p+10){var x=b[i++];v+=(x&127)*m;if((x&128)===0)return {v:v,n:i};m*=128;}return null;}\n` +
`  function scan(b){var out=[],p=0;while(p<b.length){var k=varint(b,p);if(!k)break;p=k.n;var f=Math.floor(k.v/8),w=k.v&7;if(w===0){var q=varint(b,p);if(!q)break;out.push({f:f,w:w,v:q.v});p=q.n;}else if(w===1){if(p+8>b.length)break;out.push({f:f,w:w,s:p,e:p+8});p+=8;}else if(w===2){var l=varint(b,p);if(!l)break;var s=l.n,e=s+l.v;if(e>b.length)break;out.push({f:f,w:w,s:s,e:e});p=e;}else if(w===5){if(p+4>b.length)break;out.push({f:f,w:w,s:p,e:p+4});p+=4;}else break;}return out;}\n` +
`  function text(b,s,e){try{return new TextDecoder('utf-8').decode(b.subarray(s,e));}catch(e1){try{var x='';for(var i=s;i<e;i++)x+=String.fromCharCode(b[i]);return x;}catch(e2){return '';}}}\n` +
`  function parseGate(data){\n` +
`    var b=bytesOf(data);if(!b||!b.length)return null;\n` +
`    var top=scan(b),mf=null,bodyLen=0;\n` +
`    for(var i=0;i<top.length;i++){if(top[i].f===1&&top[i].w===2&&!mf)mf=top[i];if(top[i].f===2&&top[i].w===2)bodyLen=top[i].e-top[i].s;}\n` +
`    if(!mf)return null;var mb=b.subarray(mf.s,mf.e),m=scan(mb),service='',method='',type=0;\n` +
`    for(var j=0;j<m.length;j++){var r=m[j];if(r.f===1&&r.w===2)service=text(mb,r.s,r.e);else if(r.f===2&&r.w===2)method=text(mb,r.s,r.e);else if(r.f===3&&r.w===0)type=r.v;}\n` +
`    if(!service||!method)return null;return {service:service,method:method,messageType:type,frameLength:b.length,bodyLength:bodyLen};\n` +
`  }\n` +
`  function interesting(x){if(!x)return false;var s=String(x.service||'').toLowerCase();return s.indexOf('.dogpb.')>=0||s.indexOf('.itempb.')>=0||s.indexOf('.shoppb.')>=0;}\n` +
`  function getApi(){try{if(typeof qq!=='undefined'&&qq)return qq;}catch(e){}try{if(typeof wx!=='undefined'&&wx)return wx;}catch(e){}return null;}\n` +
`  function append(row){\n` +
`    try{var api=getApi();if(!api||!api.getFileSystemManager||!api.env||!api.env.USER_DATA_PATH)return;var f=api.getFileSystemManager();var file=api.env.USER_DATA_PATH+FILE;var line=JSON.stringify(row)+'\\n';try{f.appendFileSync(file,line,'utf8');}catch(e){try{f.writeFileSync(file,line,'utf8');}catch(e2){}}}catch(e){}\n` +
`  }\n` +
`  function record(data,transport){var x=parseGate(data);if(!interesting(x))return;append({t:now(),seq:++seq,direction:'out',transport:transport,service:x.service,method:x.method,messageType:x.messageType,frameLength:x.frameLength,bodyLength:x.bodyLength});}\n` +
`  function wrapTask(task,label){\n` +
`    try{if(!task||task.__far2P7eWrapped)return task;task.__far2P7eWrapped=true;var send=task.send;if(typeof send==='function'){task.send=function(opt){try{record(opt&&Object.prototype.hasOwnProperty.call(opt,'data')?opt.data:opt,label);}catch(e){}return send.apply(this,arguments);};}}catch(e){}return task;\n` +
`  }\n` +
`  function hookApi(api,name){\n` +
`    try{if(!api||api.__far2P7eConnectSocketHooked)return false;var orig=api.connectSocket;if(typeof orig!=='function')return false;api.connectSocket=function(){var task=orig.apply(this,arguments);return wrapTask(task,name+'.connectSocket');};api.__far2P7eConnectSocketHooked=true;return true;}catch(e){return false;}\n` +
`  }\n` +
`  function hookNative(){\n` +
`    try{if(typeof WebSocket==='undefined'||!WebSocket.prototype||WebSocket.prototype.__far2P7eSendHooked)return false;var send=WebSocket.prototype.send;WebSocket.prototype.send=function(data){try{record(data,'WebSocket.send');}catch(e){}return send.apply(this,arguments);};WebSocket.prototype.__far2P7eSendHooked=true;return true;}catch(e){return false;}\n` +
`  }\n` +
`  var tries=0;function install(){tries++;var ok=false;try{ok=hookNative()||ok;}catch(e){}try{if(typeof qq!=='undefined')ok=hookApi(qq,'qq')||ok;}catch(e){}try{if(typeof wx!=='undefined')ok=hookApi(wx,'wx')||ok;}catch(e){}if(tries<600)setTimeout(install,100);}\n` +
`  install();\n` +
`})();\n`;
}

function recoverIfNeeded(gameJs) {
    const backup = `${gameJs}.far2-p7e-dog-rpc.bak`;
    let current = fs.readFileSync(gameJs, 'utf8');
    if (current.includes(MARKER) && fs.existsSync(backup)) {
        current = fs.readFileSync(backup, 'utf8');
        fs.writeFileSync(gameJs, current, 'utf8');
    }
    return { original: current, backup };
}

function patchGameFiles() {
    const folders = findFarmFolders();
    if (!folders.length) {
        throw new Error(`未找到 QQ 农场缓存。请先在 Windows QQ 手动打开一次 QQ经典农场。\n期望目录: ${getMiniAppRoot()}`);
    }

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

function parseCaptureLine(line) {
    try {
        const row = JSON.parse(String(line || '').trim());
        if (!row || typeof row !== 'object') return null;
        const service = String(row.service || '');
        const method = String(row.method || '');
        if (!service || !method) return null;
        if (!/(\.dogpb\.|\.itempb\.|\.shoppb\.)/i.test(service)) return null;
        return {
            t: String(row.t || ''),
            direction: 'out',
            transport: String(row.transport || ''),
            service,
            method,
            messageType: Number(row.messageType) || 0,
            frameLength: Math.max(0, Number(row.frameLength) || 0),
            bodyLength: Math.max(0, Number(row.bodyLength) || 0),
        };
    } catch {
        return null;
    }
}

function readCapturedRows(startedAt) {
    const rows = [];
    for (const file of listCaptureFiles()) {
        let stat;
        try { stat = fs.statSync(file); } catch { continue; }
        if (stat.mtimeMs < startedAt - 1000) continue;
        let text = '';
        try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
        for (const line of text.split(/\r?\n/)) {
            const row = parseCaptureLine(line);
            if (row) rows.push(row);
        }
    }
    return rows;
}

function uniqueKey(row) {
    return `${row.t}|${row.service}|${row.method}|${row.frameLength}|${row.bodyLength}`;
}

function printDelta(rows, seen) {
    const fresh = [];
    for (const row of rows) {
        const key = uniqueKey(row);
        if (seen.has(key)) continue;
        seen.add(key);
        fresh.push(row);
    }
    if (!fresh.length) {
        console.log('(本阶段没有新的 Dog/Item/Shop RPC)');
        return [];
    }
    for (const row of fresh) {
        console.log(`${row.t || '(time)'}  ${row.service}.${row.method}  body=${row.bodyLength}B frame=${row.frameLength}B via=${row.transport}`);
    }
    return fresh;
}

function summarize(rows) {
    const methods = new Map();
    for (const row of rows) {
        const key = `${row.service}.${row.method}`;
        const current = methods.get(key) || { service: row.service, method: row.method, count: 0, bodyLengths: new Set() };
        current.count += 1;
        current.bodyLengths.add(row.bodyLength);
        methods.set(key, current);
    }
    return Array.from(methods.values()).map(item => ({
        service: item.service,
        method: item.method,
        count: item.count,
        bodyLengths: Array.from(item.bodyLengths).sort((a, b) => a - b),
    }));
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
    return path.resolve(process.cwd(), `p7e-dog-rpc-capture-${stamp}.json`);
}

async function waitForAnyCapture(startedAt, timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const rows = readCapturedRows(startedAt);
        if (rows.length) return rows;
        process.stdout.write('.');
        await sleep(500);
    }
    return [];
}

async function main() {
    if (process.platform !== 'win32') throw new Error('P7E RPC 取证器仅支持 Windows QQ。');

    console.log('FAR2 P7E - QQ经典农场官方客户端 Dog RPC 取证器');
    console.log('安全边界: 临时注入本地 game.js，只记录 Dog/Item/Shop 的 service + method + 长度；不记录 body、Cookie、Code、Token。');
    console.log('结束或报错时会恢复 game.js。');
    console.log('重要: 本脚本不会主动调用任何游戏写接口。后续若执行喂食，也是你在官方小程序里正常点击一次。\n');

    await waitEnter('请先关闭已经打开的 QQ经典农场窗口（QQ 主程序不用退出）。关闭后按 Enter 开始。');

    clearOldCaptureFiles();
    let patched = [];
    let restored = false;
    const cleanup = () => {
        if (restored) return;
        restored = true;
        restoreGameFiles(patched);
    };
    process.once('SIGINT', () => {
        cleanup();
        process.exit(130);
    });
    process.once('SIGTERM', () => {
        cleanup();
        process.exit(143);
    });

    try {
        patched = patchGameFiles();
        console.log(`\n已临时注入 ${patched.length} 个农场 game.js。`);
        const startedAt = Date.now();
        const opened = openFarmMiniApp();
        console.log(opened ? '已请求打开 QQ经典农场。' : '自动打开失败，请手动打开 QQ经典农场。');
        console.log('等待首次 Dog/Item/Shop RPC...');

        const initial = await waitForAnyCapture(startedAt);
        console.log('');
        if (!initial.length) {
            throw new Error('45 秒内没有抓到 Dog/Item/Shop RPC。请确认农场已真正重新打开，而不是旧窗口未关闭。');
        }

        const seen = new Set();
        console.log('\n=== 阶段 0：启动期相关 RPC ===');
        printDelta(initial, seen);

        await waitEnter('\n现在只打开官方小程序里的“狗/宠物/狗粮”相关页面，不要喂食、不购买。页面稳定后回到这里按 Enter。');
        const afterRead = readCapturedRows(startedAt);
        console.log('\n=== 阶段 1：只读打开宠物页面 ===');
        const readDelta = printDelta(afterRead, seen);

        await waitEnter('\n如果官方页面当前确实有“正常可用的狗粮/喂食”按钮，并且你愿意正常消耗 1 次，请只喂 1 次（优先 1天狗粮）。如果没有合法可操作条件，不要硬操作，直接回这里按 Enter。');
        await sleep(800);
        const afterAction = readCapturedRows(startedAt);
        console.log('\n=== 阶段 2：官方客户端单次喂食动作 ===');
        const actionDelta = printDelta(afterAction, seen);

        const allRows = readCapturedRows(startedAt);
        const report = {
            generatedAt: new Date().toISOString(),
            appId: APP_ID,
            safeCapture: true,
            rawBodyCaptured: false,
            credentialsCaptured: false,
            stages: {
                startupCount: initial.length,
                readPageNewCount: readDelta.length,
                actionNewCount: actionDelta.length,
            },
            methods: summarize(allRows),
            timeline: allRows,
        };
        const output = makeOutputPath();
        fs.writeFileSync(output, JSON.stringify(report, null, 2), 'utf8');

        console.log('\n=== RESULT ===');
        console.log(JSON.stringify({
            ok: true,
            output,
            totalRows: allRows.length,
            methods: report.methods,
            actionNewCount: actionDelta.length,
        }, null, 2));
        console.log(`\n取证文件已生成: ${output}`);
        console.log('把这个 JSON 文件发给我即可；它不包含请求 body、Cookie、Code 或 Token。');
    } finally {
        cleanup();
        if (patched.length) console.log('\n已恢复 QQ 农场 game.js 原文件。');
    }
}

main().catch((err) => {
    console.error('\n取证失败:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
});
