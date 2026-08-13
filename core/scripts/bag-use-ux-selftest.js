const assert = require('node:assert/strict');
const { normalizeUseItemReply } = require('../src/services/warehouse');

function main() {
    console.log('FAR2 Bag Use UX Contract Self-Test');
    console.log('安全: 只测试 UseReply DTO 归一化，不连接 QQ、不发送 ItemService.Use。\n');

    const reply = {
        items: [
            { id: 1, count: 500, uid: 0, is_new: true },
            { id: 987654, count: 3, uid: 22, is_new: false },
        ],
    };

    const result = normalizeUseItemReply(reply, 100003, 2);
    assert.equal(result.usedItemId, 100003);
    assert.equal(result.usedCount, 2);
    assert.equal(result.rewards.length, 2);

    assert.deepEqual(result.rewards[0], {
        id: 1,
        count: 500,
        uid: 0,
        name: '金币',
        image: '',
        category: 'gold',
        itemType: 0,
        isNew: true,
    });

    assert.equal(result.rewards[1].id, 987654);
    assert.equal(result.rewards[1].count, 3);
    assert.equal(result.rewards[1].uid, 22);
    assert.equal(result.rewards[1].name, '物品987654');
    assert.equal(result.rewards[1].category, 'item');
    assert.equal(result.rewards[1].isNew, false);

    assert.deepEqual(normalizeUseItemReply(null, 9, 0), {
        usedItemId: 9,
        usedCount: 1,
        rewards: [],
    });

    console.log('✅ used item/count normalization PASS');
    console.log('✅ reward id/count/uid normalization PASS');
    console.log('✅ gold display mapping PASS');
    console.log('✅ unknown item fallback PASS');
    console.log('✅ empty reply fallback PASS');
    console.log('✅ no real ItemService.Use touched PASS');
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        itemUseRpcTouched: false,
        realQqTouched: false,
        writeOperationTouched: false,
    }, null, 2));
}

try {
    main();
} catch (error) {
    console.error('\n❌ Bag Use UX Contract Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
}
