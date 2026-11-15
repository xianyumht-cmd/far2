/**
 * 活动写链 selftest（离线）
 *
 * 安全边界：全部使用本地构造的 protobuf fixture + 注入的假 sendMsgAsync：
 *   - 不连接 QQ、不建立 WebSocket、不发任何真实请求；
 *   - 只验证「请求字节是否正确」「闸门是否真的挡得住」「失败路径是否不重试」。
 *
 * 运行: node scripts/activity-operate-selftest.js
 */

const assert = require('node:assert/strict');
const { loadProto, types } = require('../src/utils/proto');
const { createActivityOperateService, OPERATE_TYPE, NO_REWARD_CODE } = require('../src/services/activity-operate');

const ACTIVITY_ID = 2026072701;
const GOODS_ID = 7;

function buildGroupReply({ owned = false, status = 1 } = {}) {
    return types.ActivityGetGroupReply.encode(types.ActivityGetGroupReply.create({
        group: {
            activity: { id: ACTIVITY_ID, type: 13, title: '观星礼录', start_time: 1, end_time: 2, visible: true, status: 1, enabled: true },
            exchange_shop: {
                items: [
                    { id: GOODS_ID, name: '星砂礼盒', item: { id: 40001, count: 1 }, cost: { id: 1023, count: 30 }, status, owned },
                ],
            },
        },
    })).finish();
}

function buildOperateReply({ activityId = ACTIVITY_ID, operateType = OPERATE_TYPE.EXCHANGE_SHOP, rewards = [{ id: 40001, count: 1 }] } = {}) {
    return types.ActivityOperateReply.encode(types.ActivityOperateReply.create({
        activity_id: activityId,
        operate_type: operateType,
        rewards,
    })).finish();
}

function createFakeTransport(handlers) {
    const calls = [];
    async function sendMsgAsync(service, method, body, timeout) {
        calls.push({ service, method, body, timeout });
        if (method === 'GetGroup') {
            return { body: handlers.getGroup ? handlers.getGroup(calls.length) : buildGroupReply() };
        }
        if (method === 'Operate') {
            if (handlers.operateError) throw new Error(handlers.operateError);
            return { body: handlers.operate ? handlers.operate(body) : buildOperateReply() };
        }
        throw new Error(`unexpected method ${method}`);
    }
    return { sendMsgAsync, calls };
}

const silentLog = () => {};

async function testProtoSurface() {
    assert.ok(types.ActivityOperateRequest, 'ActivityOperateRequest 应已加载');
    assert.ok(types.ActivityOperateReply, 'ActivityOperateReply 应已加载');
    console.log('✅ proto: OperateRequest/OperateReply 已注册 PASS');
}

async function testRequestBytes() {
    const { sendMsgAsync, calls } = createFakeTransport({});
    const service = createActivityOperateService({
        sendMsgAsync, types, log: silentLog,
        policy: { enabled: true, dryRun: false, maxPerHour: 100 },
    });

    const result = await service.exchangeGoods({ activityId: ACTIVITY_ID, goodsId: GOODS_ID, count: 2 });
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, false);

    const operateCalls = calls.filter(call => call.method === 'Operate');
    assert.equal(operateCalls.length, 1, '兑换只应发一次 Operate');
    const decoded = types.ActivityOperateRequest.decode(operateCalls[0].body);
    assert.equal(Number(decoded.activity_id), ACTIVITY_ID);
    assert.equal(Number(decoded.operate_type), OPERATE_TYPE.EXCHANGE_SHOP);
    assert.ok(decoded.exchange_shop_operate, '必须带 101 exchange_shop_operate 选择器');
    assert.equal(Number(decoded.exchange_shop_operate.goods_id), GOODS_ID);
    assert.equal(Number(decoded.exchange_shop_operate.count), 2);
    assert.equal(operateCalls[0].service, 'gamepb.activitypb.ActivityService');

    const getGroupCalls = calls.filter(call => call.method === 'GetGroup');
    assert.equal(getGroupCalls.length, 2, '写前 + 写后各读一次 GetGroup');
    console.log('✅ wire: activity_id / operate_type=1 / field 101 goods_id+count 编码正确 PASS');
    console.log('✅ 写链: 写前读 → 单次写 → 写后复核，共 3 次调用 PASS');
}

async function testDryRunSendsNothing() {
    const { sendMsgAsync, calls } = createFakeTransport({});
    const service = createActivityOperateService({
        sendMsgAsync, types, log: silentLog,
        policy: { enabled: true, dryRun: true, maxPerHour: 100 },
    });

    const result = await service.exchangeGoods({ activityId: ACTIVITY_ID, goodsId: GOODS_ID, count: 1 });
    assert.equal(result.dryRun, true);
    assert.equal(calls.filter(call => call.method === 'Operate').length, 0, 'dryRun 不得发 Operate');
    assert.equal(calls.filter(call => call.method === 'GetGroup').length, 1, 'dryRun 只做写前读取');
    console.log('✅ dryRun: 只读不写 PASS');
}

async function testDisabledGate() {
    const { sendMsgAsync, calls } = createFakeTransport({});
    const service = createActivityOperateService({
        sendMsgAsync, types, log: silentLog,
        policy: { enabled: false, dryRun: false, maxPerHour: 100 },
    });

    await assert.rejects(
        () => service.exchangeGoods({ activityId: ACTIVITY_ID, goodsId: GOODS_ID, count: 1 }),
        (error) => error.code === 'ACTIVITY_OPERATE_DISABLED'
    );
    assert.equal(calls.length, 0, '总闸门关闭时一次请求都不该发');
    console.log('✅ 闸门: FAR2_ACTIVITY_OPERATE 未开启时零请求 PASS');
}

async function testReplyMismatchFailsClosed() {
    const { sendMsgAsync, calls } = createFakeTransport({
        operate: () => buildOperateReply({ activityId: 999, operateType: OPERATE_TYPE.EXCHANGE_SHOP }),
    });
    const service = createActivityOperateService({
        sendMsgAsync, types, log: silentLog,
        policy: { enabled: true, dryRun: false, maxPerHour: 100 },
    });

    await assert.rejects(
        () => service.exchangeGoods({ activityId: ACTIVITY_ID, goodsId: GOODS_ID, count: 1 }),
        (error) => error.code === 'ACTIVITY_REPLY_MISMATCH'
    );
    assert.equal(calls.filter(call => call.method === 'Operate').length, 1, '回包不匹配时不得重试');
    console.log('✅ fail-closed: 回包 activity_id 不匹配 → 抛错且不重试 PASS');
}

async function testGoodsNotInShop() {
    const { sendMsgAsync, calls } = createFakeTransport({});
    const service = createActivityOperateService({
        sendMsgAsync, types, log: silentLog,
        policy: { enabled: true, dryRun: false, maxPerHour: 100 },
    });

    await assert.rejects(
        () => service.exchangeGoods({ activityId: ACTIVITY_ID, goodsId: 123456, count: 1 }),
        (error) => error.code === 'ACTIVITY_GOODS_NOT_FOUND'
    );
    assert.equal(calls.filter(call => call.method === 'Operate').length, 0, '商品不存在时不得发写请求');
    console.log('✅ 写前校验: 商店里没有该商品 → 不发包 PASS');
}

async function testOwnedGoodsSkipped() {
    const { sendMsgAsync, calls } = createFakeTransport({ getGroup: () => buildGroupReply({ owned: true, status: 2 }) });
    const service = createActivityOperateService({
        sendMsgAsync, types, log: silentLog,
        policy: { enabled: true, dryRun: false, maxPerHour: 100 },
    });

    await assert.rejects(
        () => service.exchangeGoods({ activityId: ACTIVITY_ID, goodsId: GOODS_ID, count: 1 }),
        (error) => error.code === 'ACTIVITY_GOODS_ALREADY_OWNED'
    );
    assert.equal(calls.filter(call => call.method === 'Operate').length, 0);
    console.log('✅ 幂等: 已兑换商品不重复购买 PASS');
}

async function testConstellationNoRewardIsIdempotent() {
    const transport = createFakeTransport({ operateError: `code=${NO_REWARD_CODE} 当前无可领取的奖励节点` });
    const service = createActivityOperateService({
        sendMsgAsync: transport.sendMsgAsync, types, log: silentLog,
        policy: { enabled: true, dryRun: false, maxPerHour: 100 },
    });

    const result = await service.claimConstellation({ activityId: ACTIVITY_ID });
    assert.equal(result.ok, true);
    assert.equal(result.idempotent, true);

    const operateCall = transport.calls.find(call => call.method === 'Operate');
    const decoded = types.ActivityOperateRequest.decode(operateCall.body);
    assert.equal(Number(decoded.operate_type), OPERATE_TYPE.CONSTELLATION_CLAIM);
    assert.ok(decoded.constellation_operate, '星座领取必须带 119 空选择器');
    console.log('✅ 星座: operate_type=21 + field 119 编码正确；无可领取节点按幂等成功 PASS');
}

async function testRateLimit() {
    const { sendMsgAsync, calls } = createFakeTransport({});
    const service = createActivityOperateService({
        sendMsgAsync, types, log: silentLog,
        policy: { enabled: true, dryRun: false, maxPerHour: 1 },
    });

    await service.exchangeGoods({ activityId: ACTIVITY_ID, goodsId: GOODS_ID, count: 1 });
    await assert.rejects(
        () => service.exchangeGoods({ activityId: ACTIVITY_ID, goodsId: GOODS_ID, count: 1 }),
        (error) => error.code === 'ACTIVITY_RATE_LIMITED'
    );
    assert.equal(calls.filter(call => call.method === 'Operate').length, 1);
    console.log('✅ 预算: 每小时上限生效，超限不发包 PASS');
}

async function main() {
    console.log('FAR2 Activity Operate (写链) Self-Test');
    console.log('安全: 全部本地 fixture，不连接 QQ、不发真实请求、不读取账号凭据。\n');

    await loadProto();
    await testProtoSurface();
    await testRequestBytes();
    await testDryRunSendsNothing();
    await testDisabledGate();
    await testReplyMismatchFailsClosed();
    await testGoodsNotInShop();
    await testOwnedGoodsSkipped();
    await testConstellationNoRewardIsIdempotent();
    await testRateLimit();

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        realQqTouched: false,
        websocketOpened: false,
        writeOperationTouched: false,
    }, null, 2));
}

main().catch((error) => {
    console.error('\n❌ Activity Operate Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
