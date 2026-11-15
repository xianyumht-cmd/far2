/**
 * 活动日常编排 selftest（离线）
 *
 * 验证：
 *   - FAR2_ACTIVITY_AUTO 未开启 → 直接跳过，不调用任何动作
 *   - 开启后按顺序调用 6 个动作，逐个记录（失败不影响后续）
 *   - 当天重复调用 → 幂等跳过（force 可绕过）
 *   - dry-run 结果被如实标记
 *
 * 安全：hub 是假的，不连接 QQ、不发真实请求。
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// 把数据目录指到临时目录，避免污染真实 core/data
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'far2-activity-daily-'));
process.env.FAR2_DATA_DIR = tmp;
process.env.FARM_ACCOUNT_ID = 'selftest';

const daily = require('../src/services/activity-daily');

function createFakeHub(overrides = {}) {
    const calls = [];
    const ok = name => async (payload) => {
        calls.push({ name, payload });
        if (overrides[name]) return overrides[name](payload);
        return { dryRun: true };
    };
    return {
        calls,
        claimCharitySeeds: ok('claimCharitySeeds'),
        claimCharityProgressReward: ok('claimCharityProgressReward'),
        claimConstellation: ok('claimConstellation'),
        claimQixiBridge: ok('claimQixiBridge'),
        claimQingMeiSeed: ok('claimQingMeiSeed'),
        petDiaryOperate: async (action, payload) => {
            calls.push({ name: `petDiaryOperate:${action}`, payload });
            if (overrides.petDiaryOperate) return overrides.petDiaryOperate(payload);
            return { dryRun: true };
        },
    };
}

// 内存状态：不碰真实 core/data，也不受上一次运行残留影响
function memoryState() {
    let value = { doneDate: '', lastRunAt: 0, results: [] };
    return {
        loadState: () => value,
        saveState: next => { value = next; },
        peek: () => value,
    };
}

async function main() {
    console.log('FAR2 Activity Daily Routines Self-Test');
    console.log(`临时数据目录: ${tmp}\n`);

    // 1) 未开启 → 跳过
    delete process.env.FAR2_ACTIVITY_AUTO;
    let hub = createFakeHub();
    let store = memoryState();
    let result = await daily.runDailyActivityRoutines(hub, {
        now: () => new Date('2026-11-14T10:00:00+08:00'),
        loadState: store.loadState,
        saveState: store.saveState,
    });
    assert.equal(result.skipped, true);
    assert.equal(hub.calls.length, 0, '未开启时不得调用任何动作');
    console.log('✅ 默认关闭: FAR2_ACTIVITY_AUTO 未开启时零调用 PASS');

    // 2) 开启 → 按顺序跑 6 步
    process.env.FAR2_ACTIVITY_AUTO = '1';
    hub = createFakeHub();
    store = memoryState();
    result = await daily.runDailyActivityRoutines(hub, {
        now: () => new Date('2026-11-14T10:00:00+08:00'),
        loadState: store.loadState,
        saveState: store.saveState,
    });
    assert.equal(result.skipped, false);
    assert.equal(result.results.length, 6, '应执行 6 个动作');
    assert.deepEqual(
        hub.calls.map(call => call.name),
        ['claimCharitySeeds', 'claimCharityProgressReward', 'claimConstellation', 'claimQixiBridge', 'claimQingMeiSeed', 'petDiaryOperate:solar']
    );
    assert.ok(result.results.every(entry => entry.ok && entry.dryRun === true), '全部应为 dry-run 成功');
    console.log('✅ 顺序执行: 公益→星座→七夕→青梅→宠日记 共 6 步，dry-run 标记正确 PASS');

    // 3) 当天重复 → 幂等跳过
    result = await daily.runDailyActivityRoutines(createFakeHub(), {
        now: () => new Date('2026-11-14T20:00:00+08:00'),
        loadState: store.loadState,
        saveState: store.saveState,
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, '今日已执行');
    console.log('✅ 幂等: 同一天第二次调用跳过 PASS');

    // 4) 单步失败不影响后续
    hub = createFakeHub({
        claimConstellation: () => { throw Object.assign(new Error('服务端未发现星座活动'), { code: 'NO_ACTIVITY' }); },
    });
    store = memoryState();
    result = await daily.runDailyActivityRoutines(hub, {
        force: true,
        now: () => new Date('2026-11-14T21:00:00+08:00'),
        loadState: store.loadState,
        saveState: store.saveState,
    });
    const failed = result.results.filter(entry => !entry.ok);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].label, '星座·点亮');
    assert.equal(result.results.filter(entry => entry.ok).length, 5, '其余 5 步应照常执行');
    console.log('✅ 容错: 单步业务失败不阻断后续动作 PASS');

    // 5) 闸门/预算类错误标记为 skipped
    hub = createFakeHub({
        claimCharitySeeds: () => { throw Object.assign(new Error('未开启'), { code: 'ACTIVITY_OPERATE_DISABLED' }); },
    });
    store = memoryState();
    result = await daily.runDailyActivityRoutines(hub, {
        force: true,
        now: () => new Date('2026-11-14T22:00:00+08:00'),
        loadState: store.loadState,
        saveState: store.saveState,
    });
    const gate = result.results.find(entry => entry.label === '公益红花·领种子');
    assert.equal(gate.skipped, true);
    console.log('✅ 闸门: disabled/rate-limited 记为 skipped 而不是 error PASS');

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({ ok: true, realQqTouched: false, steps: 6 }, null, 2));
}

main().catch((error) => {
    console.error('\n❌ Activity Daily Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
