/**
 * 功能超集「接线」selftest（离线）
 *
 * 目的不是验证业务逻辑（那要真账号），而是验证移植过来的三个模块在 far2 里
 * 依赖是否真的接上了：任何 ReferenceError / TypeError（undefined is not a function）
 * 都说明适配层缺东西，必须失败。
 *
 * 做法：把 utils/network 的 sendMsgAsync 换成假实现（返回空 protobuf），
 * 然后逐个调用只读入口；允许业务错误（活动未开启/数据为空），不允许接线错误。
 *
 * 运行: node scripts/activity-features-selftest.js
 */

const assert = require('node:assert/strict');
const path = require('node:path');

// 先把 network 模块换成假的，再 require 移植模块
const networkPath = require.resolve('../src/utils/network');
const realNetwork = require(networkPath);
const fakeSend = async () => ({ body: Buffer.alloc(0) });
require.cache[networkPath].exports = {
    ...realNetwork,
    sendMsgAsync: fakeSend,
};

const { loadProto } = require('../src/utils/proto');

const WIRING_ERRORS = ['ReferenceError', 'TypeError'];

async function expectNoWiringError(label, fn) {
    try {
        await fn();
        console.log(`✅ ${label}: 调用成功或返回业务结果 PASS`);
        return { label, outcome: 'ok' };
    } catch (error) {
        const name = String((error && error.name) || '');
        const message = String((error && error.message) || '');
        const wiring = WIRING_ERRORS.includes(name)
            || /is not a function|Cannot read propert|undefined is not/.test(message);
        if (wiring) {
            console.log(`❌ ${label}: 接线错误 ${name}: ${message}`);
            throw error;
        }
        console.log(`✅ ${label}: 业务层失败但接线正常（${message.slice(0, 40)}） PASS`);
        return { label, outcome: 'business-error', message };
    }
}

async function main() {
    console.log('FAR2 Activity Features Wiring Self-Test (宠日记 / 奶茶店 / 天气)');
    console.log('安全: 假传输层 + 空 protobuf，不连接 QQ、不发真实请求。\n');

    await loadProto();

    const milkTea = require('../src/services/milk-tea');
    const weather = require('../src/services/weather-activity');
    const { createPetDiaryService } = require('../src/services/activity-center/pet-diary');
    const { types } = require('../src/utils/proto');
    const { getItemById, getItemImageById } = require('../src/config/gameConfig');
    const { getBag, getBagItems } = require('../src/services/warehouse');
    const { getServerTimeSec } = require('../src/utils/utils');

    const results = [];

    // 1) 奶茶店：读页面
    results.push(await expectNoWiringError('奶茶店 getMilkTeaActivity(shop)', () => milkTea.getMilkTeaActivity('shop', {})));
    results.push(await expectNoWiringError('奶茶店 未知页面拒绝', () => milkTea.getMilkTeaActivity('not-a-page', {})));

    // 2) 天气活动：只读
    results.push(await expectNoWiringError('天气 getWeatherStatus', () => weather.getWeatherStatus()));
    results.push(await expectNoWiringError('天气 getCurrentWeatherActivity', () => weather.getCurrentWeatherActivity()));

    // 3) 宠日记：工厂构造 + 读
    const petDiary = createPetDiaryService({
        types,
        sendMsgAsync: fakeSend,
        getBag,
        getBagItems,
        getServerTimeSec,
        itemDto: item => ({ id: String(item?.id ?? 0), count: String(item?.count ?? 0) }),
        int64String: value => String(value ?? 0),
        int64Number: value => Number(value ?? 0) || 0,
        textContent: () => ({ title: '', paragraphs: [] }),
        businessError: (code, message) => Object.assign(new Error(message), { code }),
        positiveDecimal: value => String(value),
        serializeMutation: operation => operation(),
        getCurrentSolarTerms: async () => null,
    });
    assert.equal(typeof petDiary.getPetDiary, 'function');
    results.push(await expectNoWiringError('宠日记 构造 + 读取', () => petDiary.getPetDiary()));

    // 4) 图鉴/物品依赖的真实性（移植代码大量用 itemDto → getItemById）
    assert.ok(typeof getItemById === 'function', 'getItemById 必须可用');
    assert.ok(typeof getItemImageById === 'function', 'getItemImageById 必须可用');
    console.log('✅ 依赖: getItemById / getItemImageById / getBag / getBagItems 可用 PASS');

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        checks: results.length + 1,
        realQqTouched: false,
        websocketOpened: false,
    }, null, 2));
}

main().catch((error) => {
    console.error('\n❌ Activity Features Wiring Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
