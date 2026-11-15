/**
 * 活动中心超集 selftest（离线）
 *
 * 覆盖：星座 / 公益红花 / 七夕 / 青梅 四个移植子服务
 *   - 构造：依赖是否齐（缺一个都会在 createXxxService 里读到 undefined）
 *   - 闸门：总开关关闭时零请求
 *   - dryRun：只返回计划不发包
 *   - 写链：注入假传输层，验证真正发出的 Operate 请求字节里的 activity_id / operate_type
 *   - 预算：每小时上限
 *
 * 安全：全部本地 fixture + 假 sendMsgAsync，不连接 QQ、不发真实请求。
 */

const assert = require('node:assert/strict');
const { loadProto, types } = require('../src/utils/proto');
const { createActivityHub } = require('../src/services/activity-hub');

const calls = [];

function fakeTransport(handlers = {}) {
    return async (service, method, body) => {
        calls.push({ service, method, body });
        if (handlers.error) throw new Error(handlers.error);
        // 默认返回一个结构上「合法但空」的 GetGroup / List / Operate 回包
        if (method === 'List') {
            return { body: types.ActivityExtListReply.encode(types.ActivityExtListReply.create({})).finish() };
        }
        if (method === 'GetGroup') {
            return { body: types.ActivityExtGroupReply.encode(types.ActivityExtGroupReply.create({})).finish() };
        }
        if (method === 'Operate') {
            // 把请求里的 activity_id(1) / operate_type(2) 原样回显，模拟服务端 ack
            let activityId = 0;
            let operateType = 0;
            try {
                const decoded = types.ActivityQueryRequest.decode(body);
                activityId = Number(decoded.activity_id) || 0;
                operateType = Number(decoded.operate_type) || 0;
            } catch { /* 非标准请求按 0 处理 */ }
            return {
                body: types.ActivityExtOperateReply.encode(types.ActivityExtOperateReply.create({
                    activity_id: activityId,
                    operate_type: operateType,
                })).finish(),
            };
        }
        if (method === 'GetSeasonInfo') {
            const seasonInfo = types.GetSeasonInfoReply.encode(types.GetSeasonInfoReply.create({
                season_info: {
                    season_id: 2026072700,
                    name: '测试赛季',
                    status: 1,
                    begin_time: Math.floor(Date.now() / 1000) - 1000,
                    end_time: Math.floor(Date.now() / 1000) + 86400,
                    server_time: Math.floor(Date.now() / 1000),
                    activities: [
                        { activity_id: 2026072701, type: 13, name: '观星礼录', begin_time: Math.floor(Date.now() / 1000) - 1000, end_time: Math.floor(Date.now() / 1000) + 86400 },
                    ],
                },
            })).finish();
            return { body: seasonInfo };
        }
        if (method === 'GetSolarTerms') {
            return { body: types.GetSolarTermsReply.encode(types.GetSolarTermsReply.create({})).finish() };
        }
        return { body: Buffer.alloc(0) };
    };
}

async function main() {
    console.log('FAR2 Activity Hub (星座/公益/七夕/青梅) Self-Test');
    console.log('安全: 本地 fixture + 假传输层，不连接 QQ、不发真实请求。\n');

    await loadProto();

    // 1) 构造 + 依赖齐备
    const hub = createActivityHub({ policy: { enabled: false, dryRun: true } });
    assert.equal(typeof hub.getCharity, 'function');
    assert.equal(typeof hub.getQixi, 'function');
    assert.equal(typeof hub.getQingMei, 'function');
    assert.equal(typeof hub.getStellar, 'function');
    assert.equal(typeof hub.claimConstellation, 'function');
    // 宠日记 / 奶茶店 / 天气
    assert.equal(typeof hub.getPetDiary, 'function');
    assert.equal(typeof hub.petDiaryOperate, 'function');
    assert.equal(typeof hub.getMilkTeaActivity, 'function');
    assert.equal(typeof hub.milkTeaOperate, 'function');
    assert.equal(typeof hub.getWeatherActivity, 'function');
    assert.equal(typeof hub.weatherCollectBottle, 'function');
    assert.equal(typeof hub.weatherAdvanceResearch, 'function');
    console.log('✅ 七个子服务（星座/公益/七夕/青梅/宠日记/奶茶店/天气）全部挂载 PASS');

    // 2) 总开关关闭 → 零请求
    calls.length = 0;
    await assert.rejects(
        () => hub.claimConstellation({}),
        (error) => error.code === 'ACTIVITY_OPERATE_DISABLED'
    );
    assert.equal(calls.length, 0, '闸门关闭时不应有任何请求');
    console.log('✅ 闸门: FAR2_ACTIVITY_OPERATE 未开启 → 零请求 PASS');

    // 3) dryRun → 只回计划
    const dryHub = createActivityHub({
        policy: { enabled: true, dryRun: true, maxPerHour: 99 },
        sendMsgAsync: fakeTransport(),
    });
    calls.length = 0;
    const dry = await dryHub.claimCharitySeeds({});
    assert.equal(dry.dryRun, true);
    assert.equal(calls.length, 0, 'dryRun 不得发包');
    const dryPet = await dryHub.petDiaryOperate('feed', {});
    assert.equal(dryPet.dryRun, true);
    const dryMilk = await dryHub.milkTeaOperate('craft', {});
    assert.equal(dryMilk.dryRun, true);
    const dryWeather = await dryHub.weatherAdvanceResearch(1);
    assert.equal(dryWeather.dryRun, true);
    assert.equal(calls.length, 0, 'dryRun 不得发包');
    console.log('✅ dryRun: 公益/宠日记/奶茶店/天气动作都只返回计划 PASS');

    // 4) 真写链：注入假传输，验证 Operate 请求里的 operate_type
    const liveHub = createActivityHub({
        policy: { enabled: true, dryRun: false, maxPerHour: 99 },
        sendMsgAsync: fakeTransport(),
    });

    calls.length = 0;
    try {
        await liveHub.claimConstellation({});
    } catch {
        // 回包是本地 fixture，后续状态校验失败属预期；本用例只断言「发出去的那个包」
    }
    const constellationCall = calls.find(call => call.method === 'Operate');
    assert.ok(constellationCall, '星座领取应发出 Operate');
    // 请求体按 OperateConstellationRequest 解（activity_id=1 / operate_type=2 / field 119）
    const decodedConstellation = types.OperateConstellationRequest.decode(constellationCall.body);
    assert.equal(Number(decodedConstellation.activity_id), 2026072701, '星座请求 activity_id 应为赛季内星座活动');
    assert.equal(Number(decodedConstellation.operate_type), 21, '星座点亮 operate_type 必须是 21');
    console.log('✅ 星座: operate_type=21 请求已发出 PASS');

    calls.length = 0;
    try {
        await liveHub.claimCharitySeeds({});
    } catch {
        // 同上
    }
    const charityCall = calls.find(call => call.method === 'Operate');
    assert.ok(charityCall, '公益红花领种子应发出 Operate');
    const decodedCharity = types.ActivityCharityRequest.decode(charityCall.body);
    assert.equal(Number(decodedCharity.operate_type), 35, '公益红花领种子 operate_type 必须是 35');
    assert.ok(decodedCharity.claim_seed !== undefined, '必须带 134 claim_seed 选择器');
    console.log('✅ 公益红花: operate_type=35 + field 134 请求已发出 PASS');

    // 5) 预算
    const limitedHub = createActivityHub({
        policy: { enabled: true, dryRun: false, maxPerHour: 1 },
        sendMsgAsync: fakeTransport(),
    });
    try {
        await limitedHub.claimConstellation({});
    } catch { /* 忽略回包校验失败，只关心预算 */ }
    await assert.rejects(
        () => limitedHub.claimConstellation({}),
        (error) => error.code === 'ACTIVITY_RATE_LIMITED'
    );
    console.log('✅ 预算: 每小时上限生效 PASS');

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        services: ['stellar', 'charity', 'qixi', 'qingmei'],
        realQqTouched: false,
        websocketOpened: false,
    }, null, 2));
}

main().catch((error) => {
    console.error('\n❌ Activity Hub Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
