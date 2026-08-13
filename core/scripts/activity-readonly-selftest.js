const assert = require('node:assert/strict');
const { loadProto, types } = require('../src/utils/proto');
const { buildActivityOverview, parsePayload } = require('../src/services/activity-readonly');

async function main() {
    console.log('FAR2 Activity Read-Only Framework Self-Test');
    console.log('安全: 只编码/解析本地 Activity.List fixture，不连接 QQ、不调用 ActivityService、不包含 Operate。\n');

    await loadProto();
    assert.ok(types.ActivityListRequest, 'ActivityListRequest should load');
    assert.ok(types.ActivityListReply, 'ActivityListReply should load');
    assert.equal(types.ActivityOperateRequest, undefined, 'P5C read-only proto must not expose OperateRequest');

    const now = 2_000_000_000;
    const raw = types.ActivityListReply.encode(types.ActivityListReply.create({
        activities: [
            {
                id: 100,
                parent_id: 0,
                type: 1,
                title: '测试活动',
                payload: '{"theme":"test","version":1}',
                start_time: now - 100,
                end_time: now + 100,
                sort: 1,
                visible: true,
                status: 1,
                enabled: true,
                random_shop: {
                    items: [
                        { id: 1, name: '测试商品', item: { id: 40002, count: 1 }, cost: { id: 1001, count: 10 }, stock_count: 5, bought_count: 1 },
                    ],
                },
            },
            {
                id: 101,
                parent_id: 100,
                type: 2,
                title: '兑换子活动',
                start_time: now - 100,
                end_time: now + 100,
                sort: 2,
                visible: true,
                status: 1,
                enabled: true,
                exchange_shop: {
                    items: [
                        { id: 2, name: '兑换项', item: { id: 40003, count: 2 }, cost: { id: 1023, count: 3 }, status: 1, owned: false },
                    ],
                },
            },
            {
                id: 102,
                parent_id: 0,
                type: 3,
                title: '抽奖活动',
                payload: 'not-json',
                start_time: now - 100,
                end_time: now + 100,
                sort: 3,
                visible: false,
                status: 0,
                enabled: false,
                draw_info: {
                    free_remaining_count: 1,
                    max_free_count: 1,
                    paid_remaining_count: 8,
                    max_paid_count: 10,
                    paid_currency_id: 1002,
                    paid_price: 20,
                    rewards: [
                        { id: 1, rarity: 4, item: { id: 40004, count: 1 }, probability: '1%' },
                    ],
                },
            },
        ],
    })).finish();

    const decoded = types.ActivityListReply.decode(raw);
    const overview = buildActivityOverview(decoded, now);

    assert.equal(overview.summary.total, 3);
    assert.equal(overview.summary.visible, 2);
    assert.equal(overview.summary.active, 2);
    assert.equal(overview.summary.withRandomShop, 1);
    assert.equal(overview.summary.withExchangeShop, 1);
    assert.equal(overview.summary.withDraw, 1);
    assert.equal(overview.framework.operateEnabled, false);
    assert.equal(overview.framework.readOnly, true);
    assert.deepEqual(overview.framework.adapters, []);

    const root = overview.tree.find(item => item.id === 100);
    assert.ok(root, 'parent activity should be a tree root');
    assert.deepEqual(root.children.map(item => item.id), [101]);
    assert.equal(root.payload.json.theme, 'test');
    assert.deepEqual(root.payload.keys, ['theme', 'version']);
    assert.equal(root.randomShop.items[0].id, 1);
    assert.equal(root.children[0].exchangeShop.items[0].id, 2);

    const draw = overview.activities.find(item => item.id === 102);
    assert.ok(draw && draw.drawInfo);
    assert.equal(draw.drawInfo.freeRemainingCount, 1);
    assert.equal(draw.payload.json, null);
    assert.equal(parsePayload('not-json').raw, 'not-json');

    console.log('✅ activitypb read-only List/GetGroup schema loads PASS');
    console.log('✅ ListReply generic ActivityInfo normalization PASS');
    console.log('✅ parent/child tree building PASS');
    console.log('✅ random/exchange/draw generic read summaries PASS');
    console.log('✅ payload JSON stays generic and non-JSON stays raw PASS');
    console.log('✅ Operate remains absent from FAR2 P5C read-only proto PASS');
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        summary: overview.summary,
        framework: overview.framework,
        realQqTouched: false,
        activityServiceTouched: false,
        operateTouched: false,
        writeOperationTouched: false,
    }, null, 2));
}

main().catch((error) => {
    console.error('\n❌ Activity Read-Only Framework Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
