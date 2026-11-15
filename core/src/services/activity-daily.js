/**
 * 活动日常编排（七项超集的每日自动执行）
 *
 * 分工：
 *   - 协议与选择器在各自子服务里（activity-center/*、milk-tea、weather-activity）
 *   - 闸门/预算在 activity-hub.js
 *   - 本文件只负责「什么时候跑、跑哪些、当天别重复跑」
 *
 * 默认关闭：需要 FAR2_ACTIVITY_AUTO=1 才启用；即使启用，hub 的总开关
 * （FAR2_ACTIVITY_OPERATE）与 dryRun（默认开）仍然生效，所以默认行为永远是「只出计划」。
 *
 * 顺序按「便宜且幂等 → 依赖前置 → 有消耗」排列：
 *   公益红花领种子 → 公益红花进度奖励 → 星座点亮 → 七夕鹊桥 → 青梅领种子 → 宠日记节令好礼
 */

const process = require('node:process');
const { getDataFile } = require('../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('./json-db');
const { log } = require('../utils/utils');

function isAutoEnabled() {
    return String(process.env.FAR2_ACTIVITY_AUTO || '') === '1';
}

function dateKey(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function stateFile() {
    const account = String(process.env.FARM_ACCOUNT_ID || 'default').replace(/[^\w-]/g, '_');
    return getDataFile(`activity-daily-${account}.json`);
}

function loadState() {
    try {
        const data = readJsonFile(stateFile(), { doneDate: '', lastRunAt: 0, results: [] });
        return data && typeof data === 'object' ? data : { doneDate: '', lastRunAt: 0, results: [] };
    } catch {
        return { doneDate: '', lastRunAt: 0, results: [] };
    }
}

function saveState(state) {
    try {
        writeJsonFileAtomic(stateFile(), state);
    } catch {
        /* 状态落盘失败不影响当天执行 */
    }
}

/**
 * @param {object} hub createActivityHub() 的实例
 * @param {{force?: boolean, now?: () => Date}} options
 */
async function runDailyActivityRoutines(hub, options = {}) {
    const now = options.now || (() => new Date());
    const force = !!options.force;
    const today = dateKey(now());
    // 允许注入状态存取（selftest 用内存实现，避免依赖真实 core/data）
    const readState = typeof options.loadState === 'function' ? options.loadState : loadState;
    const writeState = typeof options.saveState === 'function' ? options.saveState : saveState;
    const state = readState();

    if (!isAutoEnabled() && !force) {
        return { skipped: true, reason: 'FAR2_ACTIVITY_AUTO 未开启' };
    }
    if (!force && state.doneDate === today) {
        return { skipped: true, reason: '今日已执行', doneDate: state.doneDate };
    }

    const steps = [
        ['公益红花·领种子', () => hub.claimCharitySeeds({})],
        ['公益红花·进度奖励', () => hub.claimCharityProgressReward({})],
        ['星座·点亮', () => hub.claimConstellation({})],
        ['七夕·鹊桥奖励', () => hub.claimQixiBridge({})],
        ['青梅·每日种子', () => hub.claimQingMeiSeed({})],
        ['宠日记·节令好礼', () => hub.petDiaryOperate('solar', {})],
    ];

    const results = [];
    for (const [label, action] of steps) {
        try {
            const value = await action();
            const dryRun = !!(value && value.dryRun);
            results.push({ label, ok: true, dryRun, detail: dryRun ? 'dry-run' : 'executed' });
            log('活动', `${label} ${dryRun ? '（dry-run 计划）' : '完成'}`, {
                module: 'task',
                event: 'activity_daily',
                result: 'ok',
            });
        } catch (error) {
            const message = String((error && error.message) || error);
            const code = String((error && error.code) || '');
            const skipped = code === 'ACTIVITY_OPERATE_DISABLED' || code === 'ACTIVITY_RATE_LIMITED';
            results.push({ label, ok: false, code, message: message.slice(0, 160), skipped });
            log('活动', `${label} 失败: ${message.slice(0, 80)}`, {
                module: 'task',
                event: 'activity_daily',
                result: skipped ? 'skipped' : 'error',
            });
        }
    }

    const nextState = {
        doneDate: today,
        lastRunAt: Date.now(),
        results,
    };
    writeState(nextState);
    return { skipped: false, doneDate: today, results };
}

module.exports = {
    isAutoEnabled,
    dateKey,
    loadState,
    runDailyActivityRoutines,
};
