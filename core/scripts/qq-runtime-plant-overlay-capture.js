const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { execFile } = require('node:child_process');

const APP_ID = '1112386029';
const MARKER = '/*__FAR2_RUNTIME_PLANT_OVERLAY__*/';
const CAPTURE_FILE = '_far2_runtime_plant_overlay.jsonl';
const MINIAPP_URI = 'tencent://ntqq-open/?&subCmd=miniapp&action=openQQMiniApp&actionParams=%7B%22sourceType%22%3A%22open%22%2C%22appId%22%3A%221112386029%22%2C%22hostScene%22%3A%221246700100%22%7D';
const MAX_PATCH_FOLDERS = 3;
const MAX_CAPTURE_ROWS = 1400;
const SENSITIVE_KEY_RE = /(token|ticket|session|openid|authorization|cookie|password|passwd|secret|credential|login|payment|pay|report|telemetry)/i;

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
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

function findFarmFolders(root = getMiniAppRoot()) {
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && new RegExp(`^${APP_ID}_3_.+$`).test(entry.name))
        .map(entry => {
            const full = path.join(root, entry.name);
            let mtimeMs = 0;
            try { mtimeMs = fs.statSync(full).mtimeMs; } catch {}
            return { name: entry.name, full, mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, MAX_PATCH_FOLDERS);
}

function findGameJs(folder) {
    const direct = [path.join(folder, 'game.js'), path.join(folder, 'cocos-js', 'assets', 'game.js')];
    for (const file of direct) {
        try {
            if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
        } catch {}
    }

    const queue = [{ dir: folder, depth: 0 }];
    while (queue.length) {
        const { dir, depth } = queue.shift();
        if (depth > 3) continue;
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

function getRegistryDir() {
    return path.join(__dirname, '..', 'data', 'crop_registry');
}

function latestRegistryFile(dir = getRegistryDir()) {
    if (!fs.existsSync(dir)) return '';
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
        .map(entry => {
            const full = path.join(dir, entry.name);
            let mtimeMs = 0;
            try { mtimeMs = fs.statSync(full).mtimeMs; } catch {}
            return { full, mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.full || '';
}

function loadUnknownTargets(registryPath = latestRegistryFile()) {
    if (!registryPath) throw new Error('未找到 core/data/crop_registry/*.json，请先完成 Startup Crop Registry 实机同步。');
    const data = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const crops = Array.isArray(data.crops) ? data.crops : [];
    const rows = crops
        .filter(row => Number(row.seedId) > 0 && Number(row.size) === 0 && /^proven/.test(String(row.identityConfidence || '')))
        .map(row => ({
            seedId: Number(row.seedId),
            fruitId: Number(row.fruitId) || Number(row.seedId) + 20000,
            illustratedTier: Number(row.illustratedTier) || 0,
            kind: 'target',
        }));
    const unique = [...new Map(rows.map(row => [row.seedId, row])).values()];
    if (!unique.length) throw new Error('最新 Crop Registry 中没有 identity-proven / footprint-unknown 作物。');
    return { registryPath, targets: unique };
}

function loadPlantConfig(file = path.join(__dirname, '..', 'src', 'gameConfig', 'Plant.json')) {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(rows) ? rows : [];
}

function chooseReferences(plants = loadPlantConfig(), perClass = 16) {
    const normalize = row => ({
        seedId: Number(row.seed_id) || 0,
        fruitId: Number(row.fruit && row.fruit.id) || 0,
        name: String(row.name || ''),
        expectedRawSize: Number(row.size) === 2 ? 2 : 0,
        kind: 'reference',
    });
    const one = plants.filter(row => Number(row.seed_id) > 0 && Number(row.size || 0) === 0).slice(0, perClass).map(normalize);
    const two = plants.filter(row => Number(row.seed_id) > 0 && Number(row.size) === 2).slice(0, perClass).map(normalize);
    if (one.length < 6 || two.length < 2) throw new Error(`静态 Plant 标尺不足: 1x1=${one.length}, 2x2=${two.length}`);
    return [...one, ...two];
}

function buildMarkerTable(targets, references) {
    const table = {};
    for (const row of [...references, ...targets]) {
        if (Number(row.seedId) > 0) table[String(row.seedId)] = { ...row, markerKind: 'seed' };
        if (Number(row.fruitId) > 0) table[String(row.fruitId)] = { ...row, markerKind: 'fruit' };
    }
    return table;
}

function buildPayload(markerTable) {
    const markerJson = JSON.stringify(markerTable);
    const sensitiveSource = SENSITIVE_KEY_RE.source;
    return [
        MARKER,
        ';(function(){',
        'if(globalThis.__far2RuntimePlantOverlayInstalled)return;',
        'globalThis.__far2RuntimePlantOverlayInstalled=true;',
        `var FILE=${JSON.stringify(`/${CAPTURE_FILE}`)};`,
        `var MARKERS=${markerJson};`,
        `var MAX_ROWS=${MAX_CAPTURE_ROWS};`,
        `var SENSITIVE=new RegExp(${JSON.stringify(sensitiveSource)},'i');`,
        'var seen=Object.create(null),rows=0,active=0;',
        "function api(){try{if(typeof qq!=='undefined'&&qq)return qq;}catch(e){}try{if(typeof wx!=='undefined'&&wx)return wx;}catch(e){}return null;}",
        "function append(row){try{if(rows>=MAX_ROWS)return;var a=api();if(!a||!a.getFileSystemManager||!a.env||!a.env.USER_DATA_PATH)return;var f=a.getFileSystemManager(),file=a.env.USER_DATA_PATH+FILE,line=JSON.stringify(row)+'\\n';try{f.appendFileSync(file,line,'utf8');}catch(e){try{f.writeFileSync(file,line,'utf8');}catch(e2){return;}}rows++;}catch(e){}}",
        "function safePrimitive(k,v){if(SENSITIVE.test(String(k||'')))return '[MASKED]';if(v===null||v===undefined||typeof v==='boolean'||typeof v==='number')return v;if(typeof v==='string'){if(v.length>240)return v.slice(0,240)+'…';return v;}return undefined;}",
        "function snapshot(o){var out={},keys=[];try{keys=Object.keys(o).slice(0,120);}catch(e){return out;}for(var i=0;i<keys.length;i++){var k=keys[i],v;try{v=o[k];}catch(e){continue;}var p=safePrimitive(k,v);if(p!==undefined){out[k]=p;continue;}if(v&&typeof v==='object'&&!Array.isArray(v)){var child={},ck=[];try{ck=Object.keys(v).slice(0,40);}catch(e){}for(var j=0;j<ck.length;j++){var q=ck[j],cv;try{cv=v[q];}catch(e){continue;}var cp=safePrimitive(q,cv);if(cp!==undefined)child[q]=cp;}if(Object.keys(child).length)out[k]=child;}else if(Array.isArray(v)&&v.length<=12){var arr=[];for(var n=0;n<v.length;n++){var ap=safePrimitive(k,v[n]);if(ap!==undefined)arr.push(ap);}if(arr.length)out[k]=arr;}}return out;}",
        "function markerOf(v){if(typeof v==='number'&&Number.isFinite(v))return MARKERS[String(Math.trunc(v))]||null;if(typeof v==='string'&&/^\\d{5,6}$/.test(v))return MARKERS[v]||null;return null;}",
        "function directMatches(o){var hits=[],keys=[];try{keys=Object.keys(o).slice(0,160);}catch(e){return hits;}for(var i=0;i<keys.length;i++){var k=keys[i],v;try{v=o[k];}catch(e){continue;}var m=markerOf(v);if(m)hits.push({path:k,marker:m});if(v&&typeof v==='object'&&!Array.isArray(v)){var ck=[];try{ck=Object.keys(v).slice(0,30);}catch(e){}for(var j=0;j<ck.length;j++){var q=ck[j],cv;try{cv=v[q];}catch(e){continue;}var cm=markerOf(cv);if(cm)hits.push({path:k+'.'+q,marker:cm});}}}return hits;}",
        "function inspect(root,source){if(!root||typeof root!=='object'||active>2)return;active++;try{var queue=[{v:root,d:0}],visited=typeof WeakSet!=='undefined'?new WeakSet():null,count=0;while(queue.length&&count<7000){var node=queue.shift(),o=node.v;if(!o||typeof o!=='object')continue;if(visited){if(visited.has(o))continue;visited.add(o);}count++;var hits=directMatches(o);if(hits.length){var snap=snapshot(o),sigKeys=Object.keys(snap).sort().join(',');for(var h=0;h<hits.length;h++){var hit=hits[h],m=hit.marker,key=[m.seedId,m.markerKind,hit.path,sigKeys,source].join('|');if(seen[key])continue;seen[key]=1;append({t:(new Date()).toISOString(),source:source,seedId:m.seedId,fruitId:m.fruitId||0,kind:m.kind,markerKind:m.markerKind,expectedRawSize:m.expectedRawSize,referenceName:m.name||'',matchPath:hit.path,snapshot:snap});}}if(node.d>=7)continue;var keys=[];try{keys=Object.keys(o).slice(0,220);}catch(e){continue;}for(var i=0;i<keys.length;i++){var v;try{v=o[keys[i]];}catch(e){continue;}if(v&&typeof v==='object')queue.push({v:v,d:node.d+1});}}}catch(e){}finally{active--;}}",
        "function wrapJson(){try{if(JSON.__far2RuntimePlantWrapped)return;var orig=JSON.parse;JSON.parse=function(){var out=orig.apply(this,arguments);try{inspect(out,'JSON.parse');}catch(e){}return out;};JSON.__far2RuntimePlantWrapped=true;}catch(e){}}",
        "function wrapCallback(args,source){for(var i=args.length-1;i>=0;i--){if(typeof args[i]==='function'){var cb=args[i];args[i]=function(){try{for(var j=0;j<arguments.length;j++)inspect(arguments[j],source+'.callback');}catch(e){}return cb.apply(this,arguments);};return args;}}return args;}",
        "function wrapMethod(obj,name,source){try{if(!obj||typeof obj[name]!=='function')return;var fn=obj[name];if(fn.__far2RuntimePlantWrapped)return;var w=function(){var args=Array.prototype.slice.call(arguments);wrapCallback(args,source);var out=fn.apply(this,args);try{if(out&&typeof out==='object')inspect(out,source+'.return');}catch(e){}return out;};w.__far2RuntimePlantWrapped=true;obj[name]=w;}catch(e){}}",
        "function hookCocos(){try{var c=globalThis.cc;if(!c)return;if(c.assetManager){wrapMethod(c.assetManager,'loadAny','cc.assetManager.loadAny');wrapMethod(c.assetManager,'loadRemote','cc.assetManager.loadRemote');wrapMethod(c.assetManager,'loadBundle','cc.assetManager.loadBundle');}if(c.resources){wrapMethod(c.resources,'load','cc.resources.load');wrapMethod(c.resources,'loadDir','cc.resources.loadDir');}if(c.loader){wrapMethod(c.loader,'loadRes','cc.loader.loadRes');wrapMethod(c.loader,'loadResArray','cc.loader.loadResArray');wrapMethod(c.loader,'loadResDir','cc.loader.loadResDir');}}catch(e){}}",
        "wrapJson();var tries=0;function install(){tries++;try{hookCocos();}catch(e){}if(tries<1800)setTimeout(install,100);}install();",
        '})();',
        '',
    ].join('\n');
}

function restorePatchedFiles(patched) {
    const failures = [];
    for (const item of patched || []) {
        try {
            fs.writeFileSync(item.gameJs, item.original);
            if (fs.existsSync(item.backup)) fs.unlinkSync(item.backup);
            const restored = fs.readFileSync(item.gameJs);
            if (sha256(restored) !== item.originalSha256) throw new Error('restore hash mismatch');
        } catch (error) {
            failures.push({ file: item.gameJs, error: error.message });
        }
    }
    return failures;
}

function patchGameFiles(markerTable) {
    const payload = Buffer.from(buildPayload(markerTable), 'utf8');
    const patched = [];
    const folders = findFarmFolders();
    if (!folders.length) throw new Error('未找到 QQ经典农场缓存，请先正常打开一次农场。');
    try {
        for (const folder of folders) {
            const gameJs = findGameJs(folder.full);
            if (!gameJs) continue;
            const original = fs.readFileSync(gameJs);
            const backup = `${gameJs}.far2-runtime-plant-overlay.bak`;
            if (original.includes(Buffer.from(MARKER))) throw new Error(`game.js 已包含运行时 overlay 标记，请先恢复: ${gameJs}`);
            fs.writeFileSync(backup, original);
            fs.writeFileSync(gameJs, Buffer.concat([payload, original]));
            patched.push({ gameJs, backup, original, originalSha256: sha256(original), folder: folder.name });
        }
    } catch (error) {
        restorePatchedFiles(patched);
        throw error;
    }
    if (!patched.length) throw new Error('找到农场缓存，但未找到可补丁的 game.js。');
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
        if (stat.mtimeMs < startedAt - 1500) continue;
        let text = '';
        try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
        for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
                const row = JSON.parse(line);
                const key = [row.seedId, row.markerKind, row.matchPath, row.source, JSON.stringify(row.snapshot)].join('|');
                if (seen.has(key)) continue;
                seen.add(key);
                rows.push(row);
            } catch {}
        }
    }
    return rows;
}

function primitiveAt(snapshot, key) {
    if (!snapshot || !Object.prototype.hasOwnProperty.call(snapshot, key)) return undefined;
    const value = snapshot[key];
    return value !== null && ['number', 'string', 'boolean'].includes(typeof value) ? value : undefined;
}

function inferSeedField(rows) {
    const stats = new Map();
    for (const row of rows.filter(r => r.kind === 'reference' && r.markerKind === 'seed')) {
        const key = String(row.matchPath || '');
        if (!key || key.includes('.')) continue;
        const stat = stats.get(key) || { key, refs: new Set(), hits: 0 };
        stat.refs.add(Number(row.seedId));
        stat.hits++;
        stats.set(key, stat);
    }
    const ranked = [...stats.values()].map(s => ({ key: s.key, references: s.refs.size, hits: s.hits })).sort((a, b) => b.references - a.references || b.hits - a.hits);
    const top = ranked[0] || null;
    const second = ranked[1] || null;
    return {
        proven: !!top && top.references >= 6 && (!second || top.references >= second.references + 2),
        key: top ? top.key : '',
        ranked: ranked.slice(0, 8),
    };
}

function inferSizeField(rows, seedField) {
    const perRef = new Map();
    for (const row of rows) {
        if (row.kind !== 'reference' || row.markerKind !== 'seed' || row.matchPath !== seedField) continue;
        const id = Number(row.seedId);
        if (!perRef.has(id)) perRef.set(id, row);
    }

    const stats = new Map();
    for (const row of perRef.values()) {
        const expected = Number(row.expectedRawSize) === 2 ? 2 : 0;
        for (const [key, value] of Object.entries(row.snapshot || {})) {
            if (key === seedField || typeof value !== 'number' || !Number.isFinite(value)) continue;
            const stat = stats.get(key) || { key, matches: 0, mismatches: 0, zeroRefs: new Set(), twoRefs: new Set(), observed: 0 };
            stat.observed++;
            if (Number(value) === expected) {
                stat.matches++;
                (expected === 2 ? stat.twoRefs : stat.zeroRefs).add(Number(row.seedId));
            } else {
                stat.mismatches++;
            }
            stats.set(key, stat);
        }
    }

    const ranked = [...stats.values()].map(s => ({
        key: s.key,
        matches: s.matches,
        mismatches: s.mismatches,
        observed: s.observed,
        zeroReferences: s.zeroRefs.size,
        twoReferences: s.twoRefs.size,
        score: s.matches * 5 - s.mismatches * 8 + Math.min(6, s.twoRefs.size) * 4,
    })).filter(s => s.zeroReferences >= 3 && s.twoReferences >= 2)
        .sort((a, b) => b.score - a.score || b.matches - a.matches || a.mismatches - b.mismatches);

    const top = ranked[0] || null;
    const second = ranked[1] || null;
    const strong = !!top && top.matches >= 6 && top.mismatches === 0 && top.zeroReferences >= 3 && top.twoReferences >= 2;
    const separated = !second || top.score >= second.score + 8 || (second.mismatches > 0 && top.mismatches === 0);
    return { proven: strong && separated, key: top ? top.key : '', ranked: ranked.slice(0, 10) };
}

function inferNameField(rows, seedField) {
    const stats = new Map();
    const perRef = new Map();
    for (const row of rows) {
        if (row.kind !== 'reference' || row.markerKind !== 'seed' || row.matchPath !== seedField || !row.referenceName) continue;
        const id = Number(row.seedId);
        if (!perRef.has(id)) perRef.set(id, row);
    }
    for (const row of perRef.values()) {
        for (const [key, value] of Object.entries(row.snapshot || {})) {
            if (typeof value !== 'string') continue;
            const stat = stats.get(key) || { key, matches: 0, mismatches: 0 };
            if (value === row.referenceName) stat.matches++;
            else stat.mismatches++;
            stats.set(key, stat);
        }
    }
    const ranked = [...stats.values()].sort((a, b) => (b.matches * 4 - b.mismatches) - (a.matches * 4 - a.mismatches));
    const top = ranked[0] || null;
    return { proven: !!top && top.matches >= 4 && top.mismatches === 0, key: top ? top.key : '', ranked: ranked.slice(0, 8) };
}

function resolveTargets(rows, fieldMap, targets) {
    const bySeed = new Map(targets.map(row => [Number(row.seedId), row]));
    const resolved = [];
    for (const [seedId, target] of bySeed.entries()) {
        const candidates = rows.filter(row => row.kind === 'target' && row.markerKind === 'seed' && Number(row.seedId) === seedId && row.matchPath === fieldMap.seedField.key);
        const sizes = new Set();
        const names = new Set();
        const evidence = [];
        for (const row of candidates) {
            const rawSize = fieldMap.sizeField.proven ? primitiveAt(row.snapshot, fieldMap.sizeField.key) : undefined;
            if (Number(rawSize) === 0 || Number(rawSize) === 2) sizes.add(Number(rawSize));
            const name = fieldMap.nameField.proven ? primitiveAt(row.snapshot, fieldMap.nameField.key) : undefined;
            if (typeof name === 'string' && name.trim()) names.add(name.trim());
            evidence.push({ source: row.source, matchPath: row.matchPath, rawSize: rawSize ?? null, name: typeof name === 'string' ? name : '', keys: Object.keys(row.snapshot || {}).slice(0, 80) });
        }
        const uniqueSize = sizes.size === 1 ? [...sizes][0] : null;
        const footprintProven = fieldMap.seedField.proven && fieldMap.sizeField.proven && uniqueSize !== null;
        resolved.push({
            seedId,
            fruitId: Number(target.fruitId) || seedId + 20000,
            illustratedTier: Number(target.illustratedTier) || 0,
            runtimeObjectHits: candidates.length,
            footprintProven,
            rawSize: footprintProven ? uniqueSize : null,
            plantSize: footprintProven ? (uniqueSize === 2 ? 2 : 1) : 0,
            gridCount: footprintProven ? (uniqueSize === 2 ? 4 : 1) : 0,
            name: names.size === 1 ? [...names][0] : '',
            conflict: sizes.size > 1,
            evidence: evidence.slice(0, 8),
        });
    }
    return resolved;
}

function analyzeRows(rows, targets) {
    const seedField = inferSeedField(rows);
    const sizeField = seedField.proven ? inferSizeField(rows, seedField.key) : { proven: false, key: '', ranked: [] };
    const nameField = seedField.proven ? inferNameField(rows, seedField.key) : { proven: false, key: '', ranked: [] };
    const fieldMap = { seedField, sizeField, nameField };
    const resolved = resolveTargets(rows, fieldMap, targets);
    return {
        fieldMap,
        resolved,
        summary: {
            capturedRows: rows.length,
            referenceRows: rows.filter(row => row.kind === 'reference').length,
            targetRows: rows.filter(row => row.kind === 'target').length,
            targetObjectHits: resolved.reduce((sum, row) => sum + row.runtimeObjectHits, 0),
            footprintProven: resolved.filter(row => row.footprintProven).length,
            unresolved: resolved.filter(row => !row.footprintProven).length,
        },
    };
}

function openMiniApp() {
    if (process.platform !== 'win32') return;
    try {
        execFile('cmd.exe', ['/d', '/s', '/c', 'start', '', MINIAPP_URI], { windowsHide: true }, () => {});
    } catch {}
}

async function main() {
    console.log('FAR2 Official Runtime Plant Overlay Capture');
    console.log('目标：让官方小程序自己解码静态配置，再只读观察含 seed/fruit 标记的运行时对象。');
    console.log('安全：不发送 RPC、不领取/购买/种植；敏感字段名自动 MASK；QQ game.js 退出前按 SHA256 精确恢复。\n');

    const targetInfo = loadUnknownTargets();
    const references = chooseReferences();
    const markerTable = buildMarkerTable(targetInfo.targets, references);
    console.log(`Registry: ${targetInfo.registryPath}`);
    console.log(`未知 footprint 目标: ${targetInfo.targets.length}`);
    console.log(`标尺: 1x1=${references.filter(r => r.expectedRawSize === 0).length}, 2x2=${references.filter(r => r.expectedRawSize === 2).length}`);

    clearCaptureFiles();
    const startedAt = Date.now();
    const patched = patchGameFiles(markerTable);
    console.log(`已临时补丁 ${patched.length} 个最近 QQ 农场 game.js。`);

    let restoreFailures = [];
    let rows = [];
    try {
        openMiniApp();
        console.log('\n官方农场已请求打开。请只浏览图鉴/作物详情，尤其 Tier2/3/4；不要领取、购买、抽奖或种植。');
        console.log('建议停留 20~30 秒，让资源加载完成。');
        await waitEnter('浏览完成后回这里按 Enter 结束运行时采集...');
        rows = readCaptureRows(startedAt);
    } finally {
        restoreFailures = restorePatchedFiles(patched);
    }

    const analysis = analyzeRows(rows, targetInfo.targets);
    const cacheRestored = restoreFailures.length === 0;
    const report = {
        generatedAt: new Date().toISOString(),
        registryPath: targetInfo.registryPath,
        targets: targetInfo.targets,
        references,
        patchedFiles: patched.map(row => ({ folder: row.folder, gameJs: row.gameJs, originalSha256: row.originalSha256 })),
        ...analysis,
        rawEvidence: rows.slice(0, 1200),
        safety: {
            readOnlyCapture: true,
            far2RpcSent: false,
            purchaseCalled: false,
            claimCalled: false,
            plantCalled: false,
            sensitiveKeysMasked: true,
            fullObjectsExported: false,
            qqCacheRestored: cacheRestored,
            restoreFailures,
        },
    };

    const dir = path.join(os.tmpdir(), 'FAR2-RUNTIME-PLANT-OVERLAY');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const output = path.join(dir, `runtime-plant-overlay-${stamp}.json`);
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    clearCaptureFiles();

    console.log('\n=== RESULT ===');
    console.log(`运行时对象证据: ${analysis.summary.capturedRows}`);
    console.log(`目标对象命中: ${analysis.summary.targetObjectHits}`);
    console.log(`seed 字段: ${analysis.fieldMap.seedField.proven ? analysis.fieldMap.seedField.key : 'UNRESOLVED'}`);
    console.log(`size 字段: ${analysis.fieldMap.sizeField.proven ? analysis.fieldMap.sizeField.key : 'UNRESOLVED'}`);
    console.log(`name 字段: ${analysis.fieldMap.nameField.proven ? analysis.fieldMap.nameField.key : 'UNRESOLVED'}`);
    console.log(`footprint 已证明: ${analysis.summary.footprintProven}/${targetInfo.targets.length}`);
    console.log(`QQ 缓存恢复: ${cacheRestored ? 'YES' : 'NO'}`);
    console.log(`报告: ${output}`);

    if (!cacheRestored) {
        process.exitCode = 2;
        console.error('QQ game.js 恢复存在失败，请立即把报告发给 ChatGPT。');
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`Runtime Plant Overlay Capture FAIL: ${error && error.stack ? error.stack : error}`);
        process.exitCode = 1;
    });
}

module.exports = {
    SENSITIVE_KEY_RE,
    loadUnknownTargets,
    chooseReferences,
    buildMarkerTable,
    buildPayload,
    inferSeedField,
    inferSizeField,
    inferNameField,
    resolveTargets,
    analyzeRows,
    restorePatchedFiles,
};
