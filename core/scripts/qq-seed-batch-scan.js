const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanSeedEvidenceBatch } = require('../src/services/qq-seed-batch-evidence');

const DEFAULT_IDS = [20264, 21037, 21050, 21221, 21251, 26032, 29003];

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
    return path.join(dir, `qq-seed-batch-scan-${stamp}.json`);
}

function printEntry(row) {
    const name = String(row.name || row.itemInfo?.name || '').trim();
    if (row.proven) {
        console.log(`✅ ${row.seedId}${name ? ` ${name}` : ''}: ${row.plantSize}x${row.plantSize}，直接证据 ${row.corroboratingHits} 条`);
        if (row.sourceFiles?.length) console.log(`   来源: ${row.sourceFiles.join(' | ')}`);
        return;
    }
    console.log(`⚠️ ${row.seedId}${name ? ` ${name}` : ''}: 未证明 footprint (${row.reason})`);
    console.log(`   数字出现 ${row.numericOccurrences || 0} 次；direct seed_id 线索 ${row.directSeedIdClueCount || 0} 条；有效 size 命中 ${row.validDirectHitCount || 0} 条`);
    if (row.clueNames?.length) console.log(`   名称线索: ${row.clueNames.join(' | ')}`);
    if (row.clueRawSizes?.length) console.log(`   size 线索: ${row.clueRawSizes.join(' | ')}`);
    if (row.sourceFiles?.length) console.log(`   来源: ${row.sourceFiles.join(' | ')}`);
}

function main() {
    const ids = parseIds(process.argv.slice(2));
    console.log('FAR2 QQ 背包未知种子批量证据扫描');
    console.log(`目标 ID: ${ids.join(', ')}`);
    console.log('安全: 只读 QQ 小程序缓存；不连接 QQ 网络、不发送 RPC、不试种未知 seedId。');
    console.log('只有同一对象直接 seed_id/seedId + 唯一 size 才会写入 FAR2 learned cache。\n');

    const result = scanSeedEvidenceBatch(ids, { persist: true });
    if (!result.ok) throw new Error(result.error || 'batch scan failed');

    for (const row of result.entries) printEntry(row);

    const output = reportPath();
    fs.writeFileSync(output, JSON.stringify(result, null, 2), 'utf8');

    console.log('\n=== SUMMARY ===');
    console.log(`请求: ${result.summary.requested}`);
    console.log(`已证明: ${result.summary.proven}`);
    console.log(`未证明: ${result.summary.unresolved}`);
    console.log(`direct seed_id 线索: ${result.summary.withDirectSeedIdClue}`);
    console.log(`扫描文件: ${result.scannedFiles}（实际读取 ${result.filesRead}）`);
    console.log(`写入 learned cache: ${result.persisted}`);
    console.log(`报告: ${output}`);
    console.log('\n把 qq-seed-batch-scan-*.json 发给 ChatGPT。');
}

try {
    main();
} catch (error) {
    console.error('批量扫描失败:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
}

module.exports = {
    DEFAULT_IDS,
    parseIds,
};
