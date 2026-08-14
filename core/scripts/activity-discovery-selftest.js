const assert = require('node:assert/strict');
const { loadProto, types } = require('../src/utils/proto');
const { buildActivityOverview } = require('../src/services/activity-readonly');
const {
    classifyActivityNode,
    buildActivityDiscoverySnapshot,
} = require('../src/services/activity-discovery');
const {
    normalizeActivityNode,
    buildActivityGroupOverview,
    selectGroupCandidates,
    createActivityDiscoveryService,
} = require('../src/services/activity-discovery-service');

async function main() {
    console.log('FAR2 Activity Auto-Discovery Self-Test');
    console.log('安全: 只使用本地 protobuf fixture + fake GetGroup，不连接 QQ、不发送 Activity RPC、不执行任何活动写操作。\n');

    await loadProto();
    const now = 2_000_000_000;

    const listReply = types.ActivityListReply.create({
        activities: [
            {
                id: 100,
                parent_id: 0,
                type: 11,
                title: '活动主组',
                payload: '{"seed_id":20901,"theme":"spring"}',
                start_time: now - 100,
                end_time: now + 100,
                sort: 1,
                visible: true,
                enabled: true,
                status: 1,
                draw_info: {
                    free_remaining_count: 1,
                    max_free_count: 1,
                    rewards: [
                        { id: 1, item: { id: 20902, count: 1 }, rarity: 4 },
                    ],
                },
            },
            {
                id: 200,
                parent_id: 0,
                type: 22,
                title: '隐藏活动主组',
                start_time: now - 100,
                end_time: now + 100,
                sort: 2,
                visible: false,
                enabled: true,
                status: 1,
            },
            {
                id: 300,
                parent_id: 0,
                type: 33,
                title: '未开始活动',
                start_time: now + 1000,
                end_time: now + 2000,
                visible: true,
                enabled: true,
            },
        ],
    });
    const listOverview = buildActivityOverview(listReply, now);
    const candidates = selectGroupCandidates(listOverview, 12);
    assert.deepEqual(candidates.map(row => row.id), [100, 200]);
    console.log('✅ active root selection prefers visible roots but still keeps active hidden groups PASS');

    const groupReply = types.ActivityGetGroupReply.create({
        group: {
            activity: {
                id: 100,
                parent_id: 0,
                type: 11,
                title: '活动主组',
                payload: '{"seed_id":20901,"theme":"spring"}',
                start_time: now - 100,
                end_time: now + 100,
                visible: true,
                enabled: true,
                status: 1,
            },
            draw_info: {
                free_remaining_count: 1,
                max_free_count: 1,
                rewards: [{ id: 1, item: { id: 20902, count: 1 }, rarity: 4 }],
            },
            children: [
                {
                    activity: {
                        id: 101,
                        parent_id: 100,
                        type: 12,
                        title: '兑换子活动',
                        start_time: now - 100,
                        end_time: now + 100,
                        visible: true,
                        enabled: true,
                        status: 1,
                    },
                    exchange_shop: {
                        items: [
                            { id: 7, item: { id: 20903, count: 1 }, cost: { id: 1015, count: 3 }, status: 1, owned: false },
                        ],
                    },
                },
            ],
        },
    });
    const groupOverview = buildActivityGroupOverview(groupReply, 100, now);
    assert.equal(groupOverview.ok, true);
    assert.equal(groupOverview.tree.capabilities.draw, true);
    assert.equal(groupOverview.tree.children[0].capabilities.exchangeShop, true);
    console.log('✅ GetGroup tree normalization preserves node-level random/exchange/draw capabilities PASS');

    const rootClass = classifyActivityNode(groupOverview.tree);
    assert.equal(rootClass.signals.freeDrawRemaining, 1);
    assert.deepEqual(rootClass.seedLikeItemIds.sort((a, b) => a - b), [20901, 20902]);
    assert.equal(rootClass.potentialActions[0].kind, 'free-draw');
    assert.equal(rootClass.potentialActions[0].autoOperate, false);
    assert.equal(rootClass.writePolicy.autoOperate, false);
    console.log('✅ free draw / seed reward signals are discovered but remain autoOperate=false PASS');

    const snapshot = buildActivityDiscoverySnapshot({
        listOverview,
        groups: [groupOverview],
        groupRequested: 2,
    });
    assert.equal(snapshot.source, 'list+get-group');
    assert.equal(snapshot.summary.nodeCount, 2);
    assert.equal(snapshot.summary.withDraw, 1);
    assert.equal(snapshot.summary.withExchangeShop, 1);
    assert.deepEqual(snapshot.summary.seedLikeItemIds.sort((a, b) => a - b), [20901, 20902, 20903]);
    assert.equal(snapshot.operationFramework.autoOperateEnabled, false);
    console.log('✅ discovery snapshot builds structural fingerprints and seed-like reward references PASS');

    const requested = [];
    const service = createActivityDiscoveryService({
        listActivityOverview: async () => listOverview,
        getActivityGroupOverview: async (id) => {
            requested.push(id);
            if (id === 200) throw new Error('fixture group unavailable');
            return groupOverview;
        },
        groupLimit: 12,
    });
    const discovered = await service.discover();
    assert.deepEqual(requested, [100, 200]);
    assert.equal(discovered.groupSummary.requested, 2);
    assert.equal(discovered.groupSummary.loaded, 1);
    assert.equal(discovered.groupSummary.failed, 1);
    assert.equal(discovered.framework.readOnly, true);
    assert.equal(discovered.framework.autoOperateEnabled, false);
    console.log('✅ one GetGroup failure does not abort other activity discovery PASS');

    const normalized = normalizeActivityNode(groupReply.group, now);
    assert.equal(normalized.children[0].parentId, 100);
    assert.ok(normalized.payload.json);
    console.log('✅ group normalization keeps payload JSON and hierarchy PASS');

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        requestedGroupIds: requested,
        seedLikeItemIds: discovered.summary.seedLikeItemIds,
        realQqTouched: false,
        activityRpcTouched: false,
        activityWriteTouched: false,
        autoOperateEnabled: false,
    }, null, 2));
}

main().catch(error => {
    console.error('\n❌ Activity Auto-Discovery Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
