const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanItemIdentityBatch } = require('../src/services/qq-item-identity-evidence');

function write(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
}

function main() {
    console.log('FAR2 QQ Item Identity Evidence Self-Test');
    console.log('安全: 只扫描临时 fixture；不读真实 QQ、不连接网络、不发送 RPC。\n');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'far2-item-identity-'));
    const farm = path.join(root, '1112386029_3_fixture');
    write(path.join(farm, 'item-config.js'), [
        `{id:21037,name:'星光花种子',type:5,interaction_type:'plant'}`,
        `{id:21050,name:'神秘活动种子',type:5}`,
        `{id:21221,name:'活动纪念币',type:6,interaction_type:'use'}`,
        `{id:21251,name:'普通奖励',type:6}`,
        `{id:80001,name:'化肥(1小时)',type:7,interaction_type:'use'}`,
        `{size:2,item:{id:26032,name:'嵌套陷阱种子',type:5,interaction_type:'plant'}}`,
        `const plain=29003;`,
    ].join(',\n'));

    try {
        const result = scanItemIdentityBatch(
            [20264, 21037, 21050, 21221, 21251, 26032, 29003, 80001],
            {
                miniAppRoot: root,
                allowNonWindows: true,
                getItemById: id => id === 20264
                    ? { id, name: '红色郁金香种子', type: 5, interaction_type: 'plant' }
                    : null,
            },
        );

        assert.equal(result.ok, true);
        const byId = new Map(result.entries.map(row => [row.itemId, row]));

        assert.equal(byId.get(20264).classification, 'known-seed');
        assert.equal(byId.get(20264).reason, 'static-item-seed-signals');
        console.log('✅ static ItemInfo already identifies 20264 as a seed PASS');

        assert.equal(byId.get(21037).classification, 'known-seed');
        assert.equal(byId.get(21037).name, '星光花种子');
        console.log('✅ direct id + name/type/interaction identifies an unknown backpack seed PASS');

        assert.equal(byId.get(21050).classification, 'known-seed');
        assert.equal(byId.get(21050).confidence, 'high');
        console.log('✅ two independent direct seed signals are enough for identity proof PASS');

        assert.equal(byId.get(21221).classification, 'non-seed');
        assert.equal(byId.get(21221).name, '活动纪念币');
        console.log('✅ explicit typed non-plant item is classified non-seed PASS');

        assert.equal(byId.get(21251).classification, 'unknown');
        console.log('✅ incomplete ordinary item metadata stays unknown PASS');

        assert.equal(byId.get(26032).classification, 'known-seed');
        assert.equal(byId.get(26032).directItemClueCount, 1);
        console.log('✅ containing nested item object is evaluated on its own direct fields PASS');

        assert.equal(byId.get(29003).classification, 'unknown');
        assert.equal(byId.get(29003).directItemClueCount, 0);
        console.log('✅ plain numeric occurrence never becomes item identity PASS');

        assert.equal(byId.get(80001).classification, 'non-seed');
        assert.equal(byId.get(80001).name, '化肥(1小时)');
        console.log('✅ fertilizer stays explicit non-seed PASS');

        assert.equal(result.safety.qqCacheModified, false);
        assert.equal(result.safety.far2DataModified, false);
        assert.equal(result.safety.rpcSent, false);
        assert.equal(result.safety.plantWriteSent, false);
        console.log('✅ identity scanner is fully read-only PASS');

        console.log('\n=== RESULT ===');
        console.log(JSON.stringify({
            ok: true,
            summary: result.summary,
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
    console.error('\n❌ QQ Item Identity Evidence Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
}
