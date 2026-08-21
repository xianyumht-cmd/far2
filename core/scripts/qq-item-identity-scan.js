const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanItemIdentityBatch } = require('../src/services/qq-item-identity-evidence');

const DEFAULT_IDS = [20264, 21037, 21050, 21221, 21251, 26032, 29003, 80001];

function parseIds(argv) {
    const ids = [...new Set((Array.isArray(argv) ? argv : [])
        .flatMap(value => String(value || '').split(/[\s,，]+/))
        .map(Number)
        .filter(value => Number.isInteger(value) && value > 0))];
    return ids.length > 0 ? ids : DEFAULT_IDS;
}

function reportPath() {
    const dir = path.join(os.tmpdir(), 'FAR2-SEED');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(dir, `qq-item-identity-scan-${stamp}.json`);
}

function label(row) {
    if (row.classification === 'known-seed') return 'SEED';
    if (row.classification === 'seed-candidate') return 'CANDIDATE';
    if (row.classification === 'non-seed') return 'NON-SEED';
    return 'UNKNOWN';
}

function main() {
    const ids = parseIds(process.argv.slice(2));
    console.log('FAR2 QQ 背包未知物品身份扫描');
    console.log(`目标 ID: ${ids.join(', ')}`);
    console.log('安全: 只读 QQ 小程序缓存 + FAR2 静态 ItemInfo；不发送 RPC、不试种、不修改任何缓存。');
    console.log('这一轮只判断“是不是种子/叫什么”，不猜 1x1/2x2。\n');

    const result = scanItemIdentityBatch(ids);
    if (!result.ok) throw new Error(result.error || 'identity scan failed');

    for (const row of result.entries) {
        const name = String(row.name || row.itemInfo?.name || '').trim();
        console.log(`${label(row).padEnd(9)} ${row.itemId}${name ? ` ${name}` : ''} confidence=${row.confidence} reason=${row.reason}`);
        console.log(`           directItem=${row.directItemClueCount} occurrences=${row.numericOccurrences}`);
        if (row.sourceFiles?.length) console.log(`           source=${row.sourceFiles.join(' | ')}`);
    }

    const output = reportPath();
    fs.writeFileSync(output, JSON.stringify(result, null, 2), 'utf8');

    console.log('\n=== SUMMARY ===');
    console.log(`请求: ${result.summary.requested}`);
    console.log(`明确种子: ${result.summary.knownSeed}`);
    console.log(`种子候选: ${result.summary.seedCandidate}`);
    console.log(`明确非种子: ${result.summary.nonSeed}`);
    console.log(`仍未知: ${result.summary.unknown}`);
    console.log(`扫描文件: ${result.scannedFiles}（实际读取 ${result.filesRead}）`);
    console.log(`报告: ${output}`);
    console.log('\n把 qq-item-identity-scan-*.json 发给 ChatGPT。');
}

try {
    main();
} catch (error) {
    console.error('身份扫描失败:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
}

module.exports = { DEFAULT_IDS, parseIds };
