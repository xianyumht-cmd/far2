const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_ID = '1112386029';
const TARGET = 'AddFood';
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const CONTEXT_CHARS = 1800;

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

function listCandidateFiles(folder) {
    const out = [];
    const stack = [folder];
    while (stack.length) {
        const dir = stack.pop();
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
                continue;
            }
            if (!entry.isFile()) continue;
            if (!/\.(?:js|mjs|cjs)$/i.test(entry.name)) continue;
            let stat;
            try { stat = fs.statSync(full); } catch { continue; }
            if (stat.size <= 0 || stat.size > MAX_FILE_BYTES) continue;
            out.push(full);
        }
    }
    return out;
}

function sanitizeSnippet(text) {
    return String(text || '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function collectNearbyIdentifiers(snippet) {
    const names = new Set();
    const patterns = [
        /\b(?:food[_-]?id|foodId|item[_-]?id|itemId|count|num|number|amount|quantity|arg\d*|value\d*)\b/gi,
        /\bAddFoodRequest\b/g,
        /\bDogService\b/g,
    ];
    for (const pattern of patterns) {
        for (const match of snippet.matchAll(pattern)) names.add(match[0]);
    }
    return [...names];
}

function scanFile(file, farmFolder) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
    const hits = [];
    let from = 0;
    while (from < text.length) {
        const index = text.indexOf(TARGET, from);
        if (index < 0) break;
        const start = Math.max(0, index - CONTEXT_CHARS);
        const end = Math.min(text.length, index + TARGET.length + CONTEXT_CHARS);
        const rawSnippet = text.slice(start, end);
        const snippet = sanitizeSnippet(rawSnippet);
        hits.push({
            file: path.relative(farmFolder, file),
            absoluteFile: file,
            index,
            snippet,
            nearbyIdentifiers: collectNearbyIdentifiers(snippet),
        });
        from = index + TARGET.length;
        if (hits.length >= 50) break;
    }
    return hits;
}

function makeOutputPath() {
    const outDir = path.join(os.tmpdir(), 'FAR2-P7E');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(outDir, `p7e-addfood-source-scan-${stamp}.json`);
}

function main() {
    if (process.platform !== 'win32') {
        throw new Error('该扫描器仅支持 Windows QQ。');
    }

    const farmFolders = findFarmFolders();
    if (!farmFolders.length) {
        throw new Error(`未找到 QQ经典农场缓存。请先正常打开一次农场。期望目录: ${getMiniAppRoot()}`);
    }

    const results = [];
    let scannedFiles = 0;
    for (const folder of farmFolders) {
        const files = listCandidateFiles(folder);
        scannedFiles += files.length;
        const hits = [];
        for (const file of files) hits.push(...scanFile(file, folder));
        results.push({ folder, filesScanned: files.length, hits });
    }

    const totalHits = results.reduce((sum, item) => sum + item.hits.length, 0);
    const report = {
        generatedAt: new Date().toISOString(),
        appId: APP_ID,
        target: TARGET,
        readOnly: true,
        filesModified: false,
        rpcSent: false,
        credentialsCaptured: false,
        scannedFiles,
        totalHits,
        results,
    };

    const output = makeOutputPath();
    fs.writeFileSync(output, JSON.stringify(report, null, 2), 'utf8');

    console.log('FAR2 P7E - AddFood 官方缓存源码只读扫描');
    console.log(`扫描 JS 文件: ${scannedFiles}`);
    console.log(`AddFood 命中: ${totalHits}`);
    for (const group of results) {
        for (const hit of group.hits.slice(0, 10)) {
            console.log(`- ${hit.file} @ ${hit.index} identifiers=${hit.nearbyIdentifiers.join(',') || '-'}`);
        }
    }
    console.log(`\n结果文件: ${output}`);
    console.log('把 p7e-addfood-source-scan-*.json 发给 ChatGPT。');
}

try {
    main();
} catch (error) {
    console.error('扫描失败:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
}
