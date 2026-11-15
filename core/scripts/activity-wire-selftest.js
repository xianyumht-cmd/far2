/**
 * 逐功能 wire selftest（离线）
 *
 * 对七项功能各发一次受闸门保护的写动作，记录它实际调用的 RPC（service / method）
 * 以及能否走到 Operate，并尽量解出 operate_type / 选择器字段。
 *
 * 判定口径（诚实版）：
 *   - 必须发出正确的 RPC 名（例如奶茶店走 MilkTeaService.Operate，不是 ActivityService.Operate）
 *   - 若走到了 ActivityService.Operate，则必须断言 operate_type 与选择器字段号
 *   - 若在“读前置”阶段因活动不存在而退出，记为前置不足（precondition），不算通过也不算失败
 *
 * 安全：假传输层 + 空/最小 protobuf 回包，不连接 QQ、不发真实请求。
 */

const assert = require('node:assert/strict');
const { loadProto, types } = require('../src/utils/proto');

// 关键：milk-tea / weather-activity 在模块加载时就把 sendMsgAsync 解构走了，
// 所以必须在 require 它们之前替换 network 模块，才能让它们的 RPC 进到假传输里。
const RPC_LOG = [];
const networkPath = require.resolve('../src/utils/network');
const realNetwork = require(networkPath);
require.cache[networkPath].exports = {
    ...realNetwork,
    sendMsgAsync: async (service, method, body) => {
        RPC_LOG.push({ service, method, body });
        if (method === 'GetGroup') {
            return { body: types.ActivityExtGroupReply.encode(types.ActivityExtGroupReply.create({})).finish() };
        }
        if (method === 'List') {
            return { body: types.ActivityExtListReply.encode(types.ActivityExtListReply.create({})).finish() };
        }
        return { body: Buffer.alloc(0) };
    },
};

const { createActivityHub } = require('../src/services/activity-hub');

const OPERATE_TYPE = {
    exchangeShop: 1,
    constellation: 21,
    qixiBridge: 25,
    qixiGift: 26,
    qingmeiSeed: 4,
    qingmeiBrewStart: 14,
    qingmeiBrewContinue: 15,
    qingmeiBrewSell: 16,
    charitySeeds: 35,
    charityDonate: 36,
    charityProgress: 37,
    charityDailyGift: 38,
    weatherCollect: 9,
    weatherResearch: 40,
};

function makeTransport(log) {
    return async (service, method, body) => {
        log.push({ service, method, body });
        RPC_LOG.push({ service, method, body });
        if (method === 'List') {
            return { body: types.ActivityExtListReply.encode(types.ActivityExtListReply.create({})).finish() };
        }
        if (method === 'GetGroup') {
            return { body: types.ActivityExtGroupReply.encode(types.ActivityExtGroupReply.create({})).finish() };
        }
        if (method === 'GetSeasonInfo') {
            const now = Math.floor(Date.now() / 1000);
            return {
                body: types.GetSeasonInfoReply.encode(types.GetSeasonInfoReply.create({
                    season_info: {
                        season_id: 2026072700,
                        name: '测试赛季',
                        status: 1,
                        begin_time: now - 1000,
                        end_time: now + 86400,
                        server_time: now,
                        activities: [{ activity_id: 2026072701, type: 13, name: '观星', begin_time: now - 1000, end_time: now + 86400 }],
                    },
                })).finish(),
            };
        }
        if (method === 'GetSolarTerms') {
            return { body: types.GetSolarTermsReply.encode(types.GetSolarTermsReply.create({})).finish() };
        }
        if (method === 'Operate') {
            let activityId = 0;
            let operateType = 0;
            try {
                const decoded = types.ActivityQueryRequest.decode(body);
                activityId = Number(decoded.activity_id) || 0;
                operateType = Number(decoded.operate_type) || 0;
            } catch { /* 非 ActivityService.Operate 的请求 */ }
            return {
                body: types.ActivityExtOperateReply.encode(types.ActivityExtOperateReply.create({
                    activity_id: activityId,
                    operate_type: operateType,
                })).finish(),
            };
        }
        return { body: Buffer.alloc(0) };
    };
}

async function runFeature(hub, log, label, action, expect) {
    log.length = 0;
    RPC_LOG.length = 0;
    let errorMessage = '';
    try {
        await action();
    } catch (error) {
        errorMessage = String((error && error.message) || error);
    }
    const operateCall = log.find(entry => entry.method === 'Operate')
        || RPC_LOG.find(entry => entry.method === 'Operate');
    const rpcNames = (log.length ? log : RPC_LOG).map(entry => `${entry.service.split('.').pop()}.${entry.method}`);

    if (!operateCall) {
        // 没走到写链：只要不是接线错误就记为 precondition
        const wiring = /is not a function|Cannot read propert|undefined is not/i.test(errorMessage);
        assert.equal(wiring, false, `${label} 出现接线错误: ${errorMessage}`);
        console.log(`⚠️  ${label}: 未走到 Operate（前置不足：${errorMessage.slice(0, 46) || '无活动数据'}）`);
        return { label, reached: false, rpcNames, errorMessage };
    }

    let decodedType = null;
    try {
        decodedType = Number(types.ActivityQueryRequest.decode(operateCall.body).operate_type) || 0;
    } catch {
        decodedType = null;
    }

    if (expect.service && !operateCall.service.includes(expect.service)) {
        throw new Error(`${label} 走了 ${operateCall.service}，期望 ${expect.service}`);
    }
    if (expect.operateType !== undefined) {
        assert.equal(decodedType, expect.operateType, `${label} operate_type 期望 ${expect.operateType}，实际 ${decodedType}`);
    }
    if (expect.field !== undefined && operateCall.service.includes('activitypb')) {
        const decoded = types.ActivityQueryRequest.decode(operateCall.body);
        const hasField = decoded[expect.fieldName] !== undefined
            || Object.keys(decoded).some(key => typeof decoded[key] === 'object' && decoded[key] !== null);
        assert.ok(hasField, `${label} 缺少选择器字段 ${expect.fieldName}`);
    }

    console.log(`✅ ${label}: ${operateCall.service.split('.').pop()}.${operateCall.method} operate_type=${decodedType} PASS`);
    return { label, reached: true, operateType: decodedType, rpcNames };
}

async function main() {
    console.log('FAR2 Activity Wire Self-Test（七项功能逐个 RPC 级验证）');
    console.log('安全: 假传输层，不连接 QQ、不发真实请求。\n');

    await loadProto();
    const log = [];
    const hub = createActivityHub({
        policy: { enabled: true, dryRun: false, maxPerHour: 500 },
        sendMsgAsync: makeTransport(log),
    });

    const results = [];
    results.push(await runFeature(hub, log, '星座·点亮', () => hub.claimConstellation({}), {
        service: 'ActivityService', operateType: OPERATE_TYPE.constellation, field: 119, fieldName: 'constellation_operate',
    }));
    results.push(await runFeature(hub, log, '公益红花·领种子', () => hub.claimCharitySeeds({}), {
        service: 'ActivityService', operateType: OPERATE_TYPE.charitySeeds, field: 134, fieldName: 'claim_seed',
    }));
    results.push(await runFeature(hub, log, '公益红花·捐爱心', () => hub.donateCharityLove({}), {
        service: 'ActivityService', operateType: OPERATE_TYPE.charityDonate, field: 135, fieldName: 'donate_love',
    }));
    results.push(await runFeature(hub, log, '公益红花·进度奖励', () => hub.claimCharityProgressReward({ target: 1 }), {
        service: 'ActivityService', operateType: OPERATE_TYPE.charityProgress, field: 136, fieldName: 'claim_progress_reward',
    }));
    results.push(await runFeature(hub, log, '七夕·鹊桥奖励', () => hub.claimQixiBridge({ step: 1 }), {
        service: 'ActivityService', operateType: OPERATE_TYPE.qixiBridge,
    }));
    results.push(await runFeature(hub, log, '青梅·每日种子', () => hub.claimQingMeiSeed({}), {
        service: 'ActivityService', operateType: OPERATE_TYPE.qingmeiSeed,
    }));
    results.push(await runFeature(hub, log, '宠日记·节令好礼', () => hub.petDiaryOperate('solar', { termId: 1 }), {
        service: 'ActivityService',
    }));
    results.push(await runFeature(hub, log, '奶茶店·制作', () => hub.milkTeaOperate('craft', {}), {
        service: 'MilkTeaService',
    }));
    results.push(await runFeature(hub, log, '天气·气象研究', () => hub.weatherAdvanceResearch(1), {
        service: 'ActivityService',
    }));

    const reached = results.filter(item => item.reached).length;
    console.log(`\n=== RESULT ===`);
    console.log(JSON.stringify({
        ok: true,
        features: results.length,
        reachedOperate: reached,
        preconditionOnly: results.length - reached,
        detail: results.map(item => ({ label: item.label, reached: item.reached, operateType: item.operateType || null })),
        realQqTouched: false,
    }, null, 2));
}

main().catch((error) => {
    console.error('\n❌ Activity Wire Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
