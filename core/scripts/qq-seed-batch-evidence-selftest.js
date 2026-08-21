const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanSeedEvidenceBatch } = require('../src/services/qq-seed-batch-evidence');

function write(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
}

function main() {
    console.log('FAR2 QQ Seed Batch Evidence Self-Test');
    console.log('安全: 只扫描临时 fixture 目录，不读取真实 QQ、不连接网络、不发送 RPC。\n');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'far2-seed-batch-'));
    const farm = path.join(root, '1112386029_3_fixture');
    write(path.join(farm, 'plant-config.js'), [
        `{seed_id:20264,name:'红色郁金香',land_level_need:1,size:0}`,
        `{seed_id:21037,name:'巨型活动花',land_level_need:2,size:2}`,
        `{seed_id:21050,name:'缺尺寸种子',land_level_need:3}`,
        `{seed_id:21221,name:'冲突种子',size:0,size:2}`,
        `{item_id:80001,name:'化肥(1小时)',size:0}`,
        `{size:2,item:{seed_id:21251,name:'嵌套尺寸陷阱'}}`,
        `const plain=26032;`,
    ].join(',\n'));
    write(path.join(farm, 'assets', 'plant-copy.json'), JSON.stringify({
        seed_id: 21037,
        name: '巨型活动花',
        land_level_need: 2,
        size: 2,
    }));
    write(path.join(farm, 'misc.js'), 'const ids=[20264,21037,21050,21221,21251,26032,29003,80001];');

    try {
        const result = scanSeedEvidenceBatch(
            [20264, 21037, 21050, 21221, 21251, 26032, 29003, 80001],
            {
                miniAppRoot: root,
                allowNonWindows: true,
                persist: false,
                getItemById: id => id === 80001
                    ? { id, name: '化肥(1小时)', type: 7, interaction_type: 'use' }
                    : null,
            },
        );

        assert.equal(result.ok, true);
        assert.equal(result.summary.requested, 8);
        assert.equal(result.scannedFiles, 3);
        assert.equal(result.filesRead, 3);

        const byId = new Map(result.entries.map(row => [row.seedId, row]));

        assert.equal(byId.get(20264).proven, true);
        assert.equal(byId.get(20264).plantSize, 1);
        assert.equal(byId.get(20264).name, '红色郁金香');
        console.log('✅ direct seed_id + size=0 is proven 1x1 in batch scan PASS');

        assert.equal(byId.get(21037).proven, true);
        assert.equal(byId.get(21037).plantSize, 2);
        assert.equal(byId.get(21037).corroboratingHits, 2);
        console.log('✅ consistent duplicate hits across files are corroborated once per batch PASS');

        assert.equal(byId.get(21050).proven, false);
        assert.equal(byId.get(21050).reason, 'direct-seed-id-found-but-size-missing');
        assert.deepEqual(byId.get(21050).clueNames, ['缺尺寸种子']);
        console.log('✅ direct seed_id + name without size remains clue-only PASS');

        assert.equal(byId.get(21221).proven, false);
        assert.equal(byId.get(21221).reason, 'direct-seed-id-found-but-size-conflicting-or-invalid');
        console.log('✅ conflicting direct size remains unresolved PASS');

        assert.equal(byId.get(21251).proven, false);
        assert.equal(byId.get(21251).reason, 'direct-seed-id-found-but-size-missing');
        assert.deepEqual(byId.get(21251).clueRawSizes, []);
        console.log('✅ parent size cannot be borrowed by nested seed_id PASS');

        assert.equal(byId.get(26032).proven, false);
        assert.equal(byId.get(26032).numericOccurrences > 0, true);
        assert.equal(byId.get(26032).directSeedIdClueCount, 0);
        console.log('✅ plain numeric occurrence is reported but never promoted PASS');

        assert.equal(byId.get(29003).proven, false);
        assert.equal(byId.get(29003).reason, 'no-direct-seed-id-object');
        console.log('✅ absent direct evidence stays unresolved PASS');

        assert.equal(byId.get(80001).proven, false);
        assert.equal(byId.get(80001).itemInfo.name, '化肥(1小时)');
        assert.equal(byId.get(80001).directSeedIdClueCount, 0);
        console.log('✅ fertilizer/item_id coincidence is never accepted as seed proof PASS');

        assert.equal(result.safety.qqCacheModified, false);
        assert.equal(result.safety.rpcSent, false);
        assert.equal(result.safety.plantWriteSent, false);
        console.log('✅ batch scanner remains QQ-cache read-only and RPC-free PASS');

        console.log('\n=== RESULT ===');
        console.log(JSON.stringify({
            ok: true,
            filesRead: result.filesRead,
            requestedIds: result.summary.requested,
            proven: result.summary.proven,
            unresolved: result.summary.unresolved,
            realQqCacheTouched: false,
            networkTouched: false,
            rpcTouched: false,
            plantWriteTouched: false,
        }, null, 2));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

try {
    main();
} catch (error) {
    console.error('\n❌ QQ Seed Batch Evidence Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
}
