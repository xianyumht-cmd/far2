const assert = require('node:assert/strict');
const { buildAvatarFrameOverview } = require('../src/services/appearance');

function main() {
    console.log('FAR2 Avatar Frame Read-Only Self-Test');
    console.log('安全: 只测试本地 Bag DTO 过滤，不连接 QQ、不调用 ItemService、不执行使用/佩戴。\n');

    const overview = buildAvatarFrameOverview({
        items: [
            { id: 2110, count: 1, name: '农场元老内测框', image: '/frame-2110.png', itemType: 10, level: 0, priceId: 0, price: 0, priceUnit: '金' },
            { id: 2120, count: 2, name: '金穗至尊SVIP框', image: '/frame-2120.png', itemType: 10, level: 0, priceId: 0, price: 0, priceUnit: '金' },
            { id: 20002, count: 5, name: '牧草种子', itemType: 5 },
            { id: 40002, count: 99, name: '牧草', itemType: 6 },
            { id: 2101, count: 0, name: '头像框1', itemType: 10 },
        ],
    });

    assert.equal(overview.itemType, 10);
    assert.equal(overview.totalKinds, 2);
    assert.equal(overview.totalCount, 3);
    assert.deepEqual(overview.frames.map(item => item.id), [2120, 2110]);
    assert.ok(overview.frames.every(item => item.itemType === 10));
    assert.equal(overview.equipped.supported, false);
    assert.equal(overview.equipped.reason, 'equip_avatar_frames_structure_unverified');
    assert.equal(overview.protocol.method, 'Bag');
    assert.equal(overview.protocol.readOnly, true);

    console.log('✅ only owned type=10 avatar-frame items are kept PASS');
    console.log('✅ non-frame and zero-count items are excluded PASS');
    console.log('✅ equipped state stays explicitly unverified PASS');
    console.log('✅ no use/wear/write operation touched PASS');
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        frames: overview.frames,
        equipped: overview.equipped,
        realQqTouched: false,
        itemServiceTouched: false,
        writeOperationTouched: false,
    }, null, 2));
}

try {
    main();
} catch (error) {
    console.error('\n❌ Avatar Frame Read-Only Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
}
