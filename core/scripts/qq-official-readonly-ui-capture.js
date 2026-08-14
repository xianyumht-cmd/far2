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
const MARKER = '/*__FAR2_OFFICIAL_READONLY_CAPTURE__*/';
const CAPTURE_FILE = '_far2_official_readonly.jsonl';
const MINIAPP_URI = 'tencent://ntqq-open/?&subCmd=miniapp&action=openQQMiniApp&actionParams=%7B%22sourceType%22%3A%22open%22%2C%22appId%22%3A%221112386029%22%2C%22hostScene%22%3A%221246700100%22%7D';
const MAX_PATCH_FOLDERS = 3;

const SENSITIVE_RE = /(userpb\.UserService|Login|Auth|Account|Payment|PayService|Report|Telemetry|Track|Analytics)/i;
const READ_METHOD_RE = /^(Get|List|Query|Fetch|Load|Preview|Search|Describe|Info|Detail|Profile|Overview|Config|Configs)/i;
const KNOWN_READ_METHODS = new Set([
    'gamepb.illustratedpb.IllustratedService.GetIllustratedListV2',
    'gamepb.activitypb.ActivityService.List',
    'gamepb.activitypb.ActivityService.GetGroup',
    'gamepb.shoppb.ShopService.ShopProfiles',
    'gamepb.shoppb.ShopService.ShopInfo',
    'gamepb.itempb.ItemService.Bag',
]);

function capturePolicy(service, method) {
    const svc = String(service || '');
    const m = String(method || '');
    if (!svc.startsWith('gamepb.')) return { capture: false, body: false, reason: 'not-gamepb' };
    if (SENSITIVE_RE.test(`${svc}.${m}`)) return { capture: false, body: false, reason: 'sensitive-excluded' };
    const key = `${svc}.${m}`;
    if (KNOWN_READ_METHODS.has(key)) return { capture: true, body: true, reason: 'known-read' };
    if (READ_METHOD_RE.test(m)) return { capture: true, body: true, reason: 'read-looking-method' };
    return { capture: true, body: false, reason: 'metadata-only-unknown-method' };
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
    const knownReads = [...KNOWN_READ_METHODS];
    return [
        MARKER,
        ';(function(){',
        'if(globalThis.__far2OfficialReadonlyInstalled)return;',
        'globalThis.__far2OfficialReadonlyInstalled=true;',
        `var FILE=${JSON.stringify(`/${CAPTURE_FILE}`)};`,
        `var KNOWN=${JSON.stringify(knownReads.reduce((acc, key) => { acc[key] = 1; return acc; }, {}))};`,
        "var SENSITIVE=/(userpb\\.UserService|Login|Auth|Account|Payment|PayService|Report|Telemetry|Track|Analytics)/i;",
        "var READ=/^(Get|List|Query|Fetch|Load|Preview|Search|Describe|Info|Detail|Profile|Overview|Config|Configs)/i;",
        'function bytesOf(d){try{if(d instanceof ArrayBuffer)return new Uint8Array(d);if(ArrayBuffer.isView&&ArrayBuffer.isView(d))return new Uint8Array(d.buffer,d.byteOffset,d.byteLength);if(d&&d.data!==undefined)return bytesOf(d.data);}catch(e){}return null;}',
        'function vi(b,p){var v=0,m=1,i=p;while(i<b.length&&i<p+10){var x=b[i++];v+=(x&127)*m;if((x&128)===0)return{v:v,n:i};m*=128;}return null;}',
        'function fields(b){var o=[],p=0;while(p<b.length){var k=vi(b,p);if(!k)break;p=k.n;var f=Math.floor(k.v/8),w=k.v&7;if(w===0){var q=vi(b,p);if(!q)break;o.push({f:f,w:w,v:q.v});p=q.n;}else if(w===1){if(p+8>b.length)break;o.push({f:f,w:w,s:p,e:p+8});p+=8;}else if(w===2){var l=vi(b,p);if(!l)break;var s=l.n,e=s+l.v;if(e>b.length)break;o.push({f:f,w:w,s:s,e:e});p=e;}else if(w===5){if(p+4>b.length)break;o.push({f:f,w:w,s:p,e:p+4});p+=4;}else break;}return o;}',
        "function text(b,s,e){try{return new TextDecoder('utf-8').decode(b.subarray(s,e));}catch(e1){return'';}}",
        "function hex(b,s,e){var o='';for(var i=s;i<e;i++)o+=(b[i]<16?'0':'')+b[i].toString(16);return o;}",
        "function gate(data){var b=bytesOf(data);if(!b||!b.length)return null;var t=fields(b),mf=null,bf=null;for(var i=0;i<t.length;i++){if(t[i].f===1&&t[i].w===2&&!mf)mf=t[i];else if(t[i].f===2&&t[i].w===2&&!bf)bf=t[i];}if(!mf)return null;var mb=b.subarray(mf.s,mf.e),m=fields(mb),svc='',method='',type=0,clientSeq=0,serverSeq=0,errorCode=0,errorMessage='';for(var j=0;j<m.length;j++){var r=m[j];if(r.f===1&&r.w===2)svc=text(mb,r.s,r.e);else if(r.f===2&&r.w===2)method=text(mb,r.s,r.e);else if(r.f===3&&r.w===0)type=r.v;else if(r.f===4&&r.w===0)clientSeq=r.v;else if(r.f===5&&r.w===0)serverSeq=r.v;else if(r.f===6&&r.w===0)errorCode=r.v;else if(r.f===7&&r.w===2)errorMessage=text(mb,r.s,r.e);}return{service:svc,method:method,messageType:type,clientSeq:clientSeq,serverSeq:serverSeq,errorCode:errorCode,errorMessage:errorMessage,bodyHex:bf?hex(b,bf.s,bf.e):'',bodyLength:bf?(bf.e-bf.s):0};}",
        "function policy(s,m){if(!s||s.indexOf('gamepb.')!==0)return null;var key=s+'.'+m;if(SENSITIVE.test(key))return null;if(KNOWN[key])return{body:true,reason:'known-read'};if(READ.test(m))return{body:true,reason:'read-looking-method'};return{body:false,reason:'metadata-only-unknown-method'};}",
        "function api(){try{if(typeof qq!=='undefined'&&qq)return qq;}catch(e){}try{if(typeof wx!=='undefined'&&wx)return wx;}catch(e){}return null;}",
        "function append(row){try{var a=api();if(!a||!a.getFileSystemManager||!a.env||!a.env.USER_DATA_PATH)return;var f=a.getFileSystemManager(),file=a.env.USER_DATA_PATH+FILE,line=JSON.stringify(row)+'\\n';try{f.appendFileSync(file,line,'utf8');}catch(e){try{f.writeFileSync(file,line,'utf8');}catch(e2){}}}catch(e){}}",
        "function record(data,direction,transport){try{var x=gate(data);if(!x)return;var p=policy(x.service,x.method);if(!p)return;append({t:(new Date()).toISOString(),direction:direction,transport:transport,service:x.service,method:x.method,messageType:x.messageType,clientSeq:x.clientSeq,serverSeq:x.serverSeq,errorCode:x.errorCode,errorMessage:x.errorMessage,bodyCaptured:p.body,captureReason:p.reason,bodyLength:x.bodyLength,bodyHex:p.body?x.bodyHex:''});}catch(e){}}",
        "function wrapTask(task,label){try{if(!task||task.__far2OfficialReadonlyWrapped)return task;task.__far2OfficialReadonlyWrapped=true;var send=task.send;if(typeof send==='function'){task.send=function(opt){try{record(opt&&Object.prototype.hasOwnProperty.call(opt,'data')?opt.data:opt,'out',label+'.send');}catch(e){}return send.apply(this,arguments);};}var onMessage=task.onMessage;if(typeof onMessage==='function'){task.onMessage=function(cb){if(typeof cb!=='function')return onMessage.apply(this,arguments);var wrapped=function(ev){try{record(ev&&Object.prototype.hasOwnProperty.call(ev,'data')?ev.data:ev,'in',label+'.onMessage');}catch(e){}return cb.apply(this,arguments);};return onMessage.call(this,wrapped);};}}catch(e){}return task;}",
        "function hookApi(a,name){try{if(!a||a.__far2OfficialReadonlyConnectHooked)return false;var orig=a.connectSocket;if(typeof orig!=='function')return false;a.connectSocket=function(){return wrapTask(orig.apply(this,arguments),name+'.connectSocket');};a.__far2OfficialReadonlyConnectHooked=true;return true;}catch(e){return false;}}",
        "function hookNative(){try{if(typeof WebSocket==='undefined'||!WebSocket.prototype)return false;var p=WebSocket.prototype;if(!p.__far2OfficialReadonlySendHooked&&typeof p.send==='function'){var send=p.send;p.send=function(data){try{record(data,'out','WebSocket.send');}catch(e){}return send.apply(this,arguments);};p.__far2OfficialReadonlySendHooked=true;}if(!p.__far2OfficialReadonlyAddHooked&&typeof p.addEventListener==='function'){var add=p.addEventListener;p.addEventListener=function(type,listener){if(type!=='message'||!listener)return add.apply(this,arguments);var wrapped;if(typeof listener==='function'){wrapped=function(ev){try{record(ev&&ev.data!==undefined?ev.data:ev,'in','WebSocket.message');}catch(e){}return listener.apply(this,arguments);};}else if(listener&&typeof listener.handleEvent==='function'){wrapped={handleEvent:function(ev){try{record(ev&&ev.data!==undefined?ev.data:ev,'in','WebSocket.message');}catch(e){}return listener.handleEvent(ev);}};}else{return add.apply(this,arguments);}return add.call(this,type,wrapped,arguments[2]);};p.__far2OfficialReadonlyAddHooked=true;}return true;}catch(e){return false;}}",
        "var tries=0;function install(){tries++;try{hookNative();}catch(e){}try{if(typeof qq!=='undefined')hookApi(qq,'qq');}catch(e){}try{if(typeof wx!=='undefined')hookApi(wx,'wx');}catch(e){}if(tries<600)setTimeout(install,100);}install();",
        '})();',
        '',
    ].join('\n');
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

function patchGameFiles() {
    const patched = [];
    const folders = findFarmFolders();
    if (!folders.length) throw new Error('未找到 QQ经典农场缓存，请先正常打开一次农场。');
    try {
        for (const folder of folders) {
            const gameJs = findGameJs(folder);
            if (!gameJs) continue;
            const current = fs.readFileSync(gameJs, 'utf8');
            const backup = `${gameJs}.far2-official-readonly.bak`;
            let original = current;
            if (current.includes(MARKER) && fs.existsSync(backup)) original = fs.readFileSync(backup, 'utf8');
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

function clearCaptureFiles() {
    for (const file of listCaptureFiles()) {
        try { fs.unlinkSync(file); } catch {}
    }
}

function readCaptureRows(startedAt) {
    const rows = [];
    const seen = new Set();
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
                const policy = capturePolicy(row && row.service, row && row.method);
                if (!policy.capture) continue;
                const key = [row.t, row.direction, row.service, row.method, row.clientSeq, row.bodyHex].join('|');
                if (seen.has(key)) continue;
                seen.add(key);
                rows.push(row);
            } catch {}
        }
    }
    return rows.sort((a, b) => String(a.t).localeCompare(String(b.t)));
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

function printableText(bytes) {
    if (!bytes || !bytes.length || bytes.length > 512) return '';
    try {
        const text = bytes.toString('utf8');
        if (!text || text.includes('\uFFFD')) return '';
        if (/^[\x20-\x7e\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\r\n\t]+$/u.test(text)) return text;
    } catch {}
    return '';
}

function parseWire(buf, depth = 0) {
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
            fields.push({ field, wire, hex: buf.subarray(pos, pos + 8).toString('hex') });
            pos += 8;
        } else if (wire === 2) {
            const len = readVarint(buf, pos);
            pos = len.next;
            if (!Number.isSafeInteger(len.value) || len.value < 0 || pos + len.value > buf.length) throw new Error('truncated bytes');
            const bytes = buf.subarray(pos, pos + len.value);
            const row = { field, wire, length: len.value };
            const text = printableText(bytes);
            if (text) row.text = text;
            else if (depth < 2 && bytes.length > 0) {
                try {
                    const nested = parseWire(bytes, depth + 1);
                    if (nested.length) row.message = nested;
                    else row.hexPrefix = bytes.subarray(0, 96).toString('hex');
                } catch {
                    row.hexPrefix = bytes.subarray(0, 96).toString('hex');
                }
            } else {
                row.hexPrefix = bytes.subarray(0, 96).toString('hex');
            }
            fields.push(row);
            pos += len.value;
        } else if (wire === 5) {
            if (pos + 4 > buf.length) throw new Error('truncated fixed32');
            fields.push({ field, wire, hex: buf.subarray(pos, pos + 4).toString('hex') });
            pos += 4;
        } else {
            throw new Error(`unsupported wire ${wire}`);
        }
    }
    return fields;
}

async function decodeBody(row) {
    if (!row || !row.bodyCaptured || !row.bodyHex) return { captured: false };
    const raw = Buffer.from(String(row.bodyHex), 'hex');
    if (Number(row.messageType) === 1 || row.direction === 'out') {
        try {
            const plain = await getCryptoWasm().decryptBuffer(raw);
            let wire = [];
            let wireError = '';
            try { wire = parseWire(plain); } catch (error) { wireError = error.message; }
            return { captured: true, encoding: 'request-decrypted', rawLength: raw.length, plainLength: plain.length, plainHex: plain.toString('hex'), wire, wireError };
        } catch (error) {
            return { captured: true, encoding: 'request-decrypt-failed', rawLength: raw.length, decryptError: error.message };
        }
    }

    try {
        return { captured: true, encoding: 'response-plain', rawLength: raw.length, plainLength: raw.length, plainHex: raw.toString('hex'), wire: parseWire(raw), wireError: '' };
    } catch (plainError) {
        try {
            const plain = await getCryptoWasm().decryptBuffer(raw);
            let wire = [];
            let wireError = '';
            try { wire = parseWire(plain); } catch (error) { wireError = error.message; }
            return { captured: true, encoding: 'response-decrypted', rawLength: raw.length, plainLength: plain.length, plainHex: plain.toString('hex'), wire, wireError };
        } catch (decryptError) {
            return { captured: true, encoding: 'response-decode-failed', rawLength: raw.length, wireError: plainError.message, decryptError: decryptError.message };
        }
    }
}

function phaseForTimestamp(timestamp, phases) {
    const ms = Date.parse(timestamp || '');
    if (!Number.isFinite(ms)) return 'unknown';
    for (const phase of phases) {
        if (ms >= phase.startMs && ms <= phase.endMs + 1000) return phase.name;
    }
    return 'outside-phase';
}

async function buildReport(rows, phases, restoreFailures, patchedCount) {
    const decodedRows = [];
    for (const row of rows) {
        decodedRows.push({
            ...row,
            phase: phaseForTimestamp(row.t, phases),
            decodedBody: await decodeBody(row),
        });
    }

    const methods = new Map();
    for (const row of decodedRows) {
        const key = `${row.phase}|${row.service}.${row.method}`;
        if (!methods.has(key)) methods.set(key, { phase: row.phase, service: row.service, method: row.method, outgoing: 0, incoming: 0, bodyCaptured: 0, metadataOnly: 0 });
        const stat = methods.get(key);
        if (row.direction === 'out') stat.outgoing += 1;
        else if (row.direction === 'in') stat.incoming += 1;
        if (row.bodyCaptured) stat.bodyCaptured += 1;
        else stat.metadataOnly += 1;
    }

    const transactions = new Map();
    for (const row of decodedRows) {
        const key = `${row.service}.${row.method}#${Number(row.clientSeq) || 0}`;
        if (!transactions.has(key)) transactions.set(key, { service: row.service, method: row.method, clientSeq: Number(row.clientSeq) || 0, phases: [], request: null, response: null });
        const tx = transactions.get(key);
        if (!tx.phases.includes(row.phase)) tx.phases.push(row.phase);
        if (row.direction === 'out' && Number(row.messageType) === 1) tx.request = row;
        if (row.direction === 'in' && Number(row.messageType) === 2) tx.response = row;
    }

    return {
        generatedAt: new Date().toISOString(),
        purpose: 'official-miniapp-readonly-crop-and-activity-discovery',
        phases: phases.map(p => ({ name: p.name, start: new Date(p.startMs).toISOString(), end: new Date(p.endMs).toISOString() })),
        summary: {
            capturedRows: decodedRows.length,
            serviceMethods: methods.size,
            transactions: transactions.size,
            responsePairs: [...transactions.values()].filter(tx => tx.request && tx.response).length,
            patchedCacheFiles: patchedCount,
        },
        methods: [...methods.values()].sort((a, b) => `${a.phase}|${a.service}.${a.method}`.localeCompare(`${b.phase}|${b.service}.${b.method}`)),
        transactions: [...transactions.values()],
        rows: decodedRows,
        safety: {
            officialClientTrafficOnly: true,
            far2RpcSent: false,
            loginTrafficExcluded: true,
            sensitiveServiceFilter: String(SENSITIVE_RE),
            unknownMutationBodiesCaptured: false,
            qqCacheRestored: restoreFailures.length === 0,
            restoreFailures,
        },
    };
}

function openMiniApp() {
    if (process.platform !== 'win32') return;
    try {
        execSync(`start "" "${MINIAPP_URI}"`, { shell: 'cmd.exe', stdio: 'ignore' });
    } catch {}
}

async function main() {
    console.log('FAR2 官方小程序完整只读取证');
    console.log('目标：识别完整图鉴分类/Tier、作物详情、限时活动数据源。');
    console.log('安全：FAR2 不发送任何 RPC；User/Login/Auth/Pay/Report 流量直接排除；未知写方法只记元数据不记 body。');
    console.log('请不要领取、兑换、购买、刷新商店、抽奖或种植。\n');

    clearCaptureFiles();
    const startedAt = Date.now();
    let patched = [];
    let restoreFailures = [];
    const phases = [];

    try {
        patched = patchGameFiles();
        console.log(`已临时补丁 ${patched.length} 个最近 QQ 农场缓存；退出前会精确恢复。`);
        openMiniApp();

        let phaseStart = Date.now();
        await waitEnter('\n[1/4 图鉴全量] 打开图鉴首页，依次点普通/珍稀/其它所有分类、Tier/分页并滚动加载；只查看。完成后按 Enter...');
        phases.push({ name: 'illustrated-all', startMs: phaseStart, endMs: Date.now() });

        phaseStart = Date.now();
        await waitEnter('\n[2/4 已知1×1详情] 在图鉴里打开一个你明确知道是普通 1×1 的作物详情，只查看。完成后按 Enter...');
        phases.push({ name: 'known-1x1-detail', startMs: phaseStart, endMs: Date.now() });

        phaseStart = Date.now();
        await waitEnter('\n[3/4 已知多格详情] 打开一个你明确知道是珍稀/特殊多格作物的详情；如果当前没有可确认样本，直接按 Enter 跳过。完成后按 Enter...');
        phases.push({ name: 'known-multigrid-detail', startMs: phaseStart, endMs: Date.now() });

        phaseStart = Date.now();
        await waitEnter('\n[4/4 当前活动] 依次打开当前每个限时活动、奖励预览、兑换列表/活动商店/抽奖预览，只查看不操作。完成后按 Enter...');
        phases.push({ name: 'current-activities', startMs: phaseStart, endMs: Date.now() });
    } finally {
        restoreFailures = restoreGameFiles(patched);
    }

    const rows = readCaptureRows(startedAt);
    const report = await buildReport(rows, phases, restoreFailures, patched.length);
    const outDir = path.join(os.tmpdir(), 'FAR2-OFFICIAL-READONLY');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `official-readonly-capture-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
    clearCaptureFiles();

    console.log('\n=== RESULT ===');
    console.log(`捕获帧: ${report.summary.capturedRows}`);
    console.log(`service/method: ${report.summary.serviceMethods}`);
    console.log(`请求/响应配对: ${report.summary.responsePairs}/${report.summary.transactions}`);
    for (const row of report.methods) {
        console.log(`${row.phase.padEnd(24)} ${row.service}.${row.method} out=${row.outgoing} in=${row.incoming} body=${row.bodyCaptured} meta=${row.metadataOnly}`);
    }
    console.log(`QQ 缓存恢复: ${report.safety.qqCacheRestored ? 'YES' : 'NO'}`);
    console.log(`报告: ${outFile}`);
    console.log('\n把 official-readonly-capture-*.json 发给 ChatGPT。');

    if (restoreFailures.length) {
        throw new Error(`QQ 缓存恢复失败 ${restoreFailures.length} 个，请不要继续打开农场，先处理恢复。`);
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`\n❌ 官方只读取证失败: ${error && error.stack ? error.stack : error}`);
        process.exitCode = 1;
    });
}

module.exports = {
    APP_ID,
    MARKER,
    CAPTURE_FILE,
    SENSITIVE_RE,
    READ_METHOD_RE,
    KNOWN_READ_METHODS,
    capturePolicy,
    buildPayload,
    readVarint,
    parseWire,
    phaseForTimestamp,
};
