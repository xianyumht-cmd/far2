const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanUnknownItemContexts } = require('../src/services/qq-unknown-item-context-evidence-v2');

const DEFAULT_IDS = [21037, 21050, 21221, 21251, 26032, 29003];

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
    return path.join(dir, `qq-unknown-item-context-${stamp}.json`);
}

function main() {
    const ids = parseIds(process.argv.slice(2));
    console.log('FAR2 QQ 未知背包物品上下文取证扫描');
    console.log(`目标 ID: ${ids.join(', ')}`);
    console.log('安全: 只读最近 QQ 农场缓存，不发送 RPC、不试种、不修改 QQ/FAR2 数据。');
    console.log('注意: 上下文中的 seed/plant/reward 等关键词只作为线索，绝不会直接晋升物品身份。\n');

    const result = scanUnknownItemContexts(ids);
    if (!result.ok) throw new Error(result.error || 'context scan failed');

    for (const row of result.entries) {
        console.log(`ID ${row.itemId}: occurrences=${row.occurrenceCount}, uniqueContexts=${row.uniqueContextCount}`);
        console.log(`   keywords: ${row.aggregateKeywords.length ? row.aggregateKeywords.join(', ') : '(none)'}`);
        console.log(`   keys: ${row.aggregateKeys.length ? row.aggregateKeys.slice(0, 16).join(', ') : '(none)'}`);
        console.log(`   strings: ${row.aggregateStrings.length ? row.aggregateStrings.slice(0, 10).join(' | ') : '(none)'}`);
        for (const ctx of row.contexts.slice(0, 3)) {
            console.log(`   - ${ctx.contextHash} [${ctx.sourceFiles.length} files] ${ctx.context.slice(0, 220)}`);
        }
    }

    const output = reportPath();
    fs.writeFileSync(output, JSON.stringify(result, null, 2), 'utf8');

    console.log('\n=== SUMMARY ===');
    console.log(`请求: ${result.summary.requested}`);
    console.log(`有数字出现: ${result.summary.withOccurrences}`);
    console.log(`总出现次数: ${result.summary.totalOccurrences}`);
    console.log(`唯一上下文: ${result.summary.uniqueContexts}`);
    console.log(`扫描文件: ${result.scannedFiles}（实际读取 ${result.filesRead}）`);
    console.log(`报告: ${output}`);
    console.log('\n把 qq-unknown-item-context-*.json 发给 ChatGPT。');
}

try {
    main();
} catch (error) {
    console.error('上下文扫描失败:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
}

module.exports = {
    DEFAULT_IDS,
    parseIds,
};
