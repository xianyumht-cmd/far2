/**
 * 活动中心（超集）编排层
 *
 * 把同源 liyangpengs/qq-farm-bot 的四个活动子服务接到 far2 上：
 *   星座 / 观星礼录、公益红花、七夕（鹊桥+香囊）、青梅酒酿
 *
 * 子服务本身是机械移植过来的（core/src/services/activity-center/*.js，由 tsc 转译，
 * 逻辑与上游逐行一致），这里只负责它们需要的依赖：
 *   - far2 已有：sendMsgAsync / types / getBag / getBagItems / getItemById / getItemImageById /
 *     getServerTimeSec / getActivityWindows / json-db 持久化
 *   - far2 没有：文本解码、int64 比较、快照、结算等小工具，本文件补齐
 *
 * 安全纪律与 activity-operate.js 一致：
 *   总开关 FAR2_ACTIVITY_OPERATE=1、dryRun 默认开、串行、每小时预算、不猜选择器。
 */

const process = require('node:process');

const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { getServerTimeSec, log } = require('../utils/utils');
const { getItemById, getItemImageById, getMutantEffectsByIds } = require('../config/gameConfig');
const { getBag, getBagItems } = require('./warehouse');
const activityWindows = require('./activity-windows');
const stateStore = require('./activity-center-state');
const { createStellarActivityService } = require('./activity-center/stellar');
const { createCharityActivityService } = require('./activity-center/charity');
const { createQixiActivityService } = require('./activity-center/qixi');
const { createQingMeiActivityService } = require('./activity-center/qingmei');
const { createPetDiaryService } = require('./activity-center/pet-diary');
const milkTea = require('./milk-tea');
const weatherActivity = require('./weather-activity');

const MAX_SIGNED_INT64 = 9223372036854775807n;
const DEFAULT_MAX_PER_HOUR = 30;

function readPolicy() {
    return {
        enabled: String(process.env.FAR2_ACTIVITY_OPERATE || '') === '1',
        dryRun: String(process.env.FAR2_ACTIVITY_DRY_RUN ?? '1') !== '0',
        maxPerHour: (() => {
            const n = Number(process.env.FAR2_ACTIVITY_OPERATE_MAX_PER_HOUR);
            return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 200) : DEFAULT_MAX_PER_HOUR;
        })(),
    };
}

// ---------- 小工具（从同源 activity-center.ts 抽出来的等价实现）----------

function int64String(value) {
    if (value == null) return '0';
    if (typeof value === 'string') return /^-?\d+$/.test(value) ? value : '0';
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'object' && typeof value.toString === 'function') {
        const text = value.toString();
        return /^-?\d+$/.test(text) ? text : '0';
    }
    return Number.isSafeInteger(value) ? String(value) : '0';
}

function int64Number(value) {
    const parsed = Number(int64String(value));
    return Number.isSafeInteger(parsed) ? parsed : 0;
}

function compareInt64(left, right) {
    const a = BigInt(int64String(left));
    const b = BigInt(int64String(right));
    return a < b ? -1 : a > b ? 1 : 0;
}

function bytesToText(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    try {
        return Buffer.from(value).toString('utf8');
    } catch {
        return '';
    }
}

function plainText(value) {
    return String(value || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .trim();
}

function findStrings(value, output) {
    if (typeof value === 'string') {
        const text = plainText(value);
        if (text) output.push(text);
        return;
    }
    if (Array.isArray(value)) {
        value.forEach(entry => findStrings(entry, output));
        return;
    }
    if (value && typeof value === 'object') {
        Object.values(value).forEach(entry => findStrings(entry, output));
    }
}

function parseJsonText(value) {
    const text = bytesToText(value).trim();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function textContent(value) {
    const text = bytesToText(value).trim();
    if (!text) return { title: '', paragraphs: [] };
    try {
        const parsed = JSON.parse(text);
        const tips = parsed && typeof parsed === 'object' ? parsed.tips : null;
        const rawParagraphs = tips && Array.isArray(tips.txt) ? tips.txt : [];
        const paragraphs = rawParagraphs
            .filter(entry => typeof entry === 'string')
            .map(plainText)
            .filter(Boolean);
        if (paragraphs.length) {
            return { title: typeof tips?.title === 'string' ? plainText(tips.title) : '', paragraphs };
        }
        const allText = [];
        findStrings(parsed, allText);
        return { title: '', paragraphs: Array.from(new Set(allText)) };
    } catch {
        return { title: '', paragraphs: [plainText(text)].filter(Boolean) };
    }
}

function itemDto(item) {
    const rawId = item?.item_id ?? item?.itemId ?? item?.id;
    const id = int64String(rawId);
    const numericId = int64Number(rawId);
    const metadata = numericId > 0 ? getItemById(numericId) : undefined;
    return {
        id,
        count: int64String(item?.count),
        name: metadata?.name || bytesToText(item?.name),
        image: numericId > 0 ? getItemImageById(numericId) : '',
        rarity: Number(metadata?.rarity) || 0,
    };
}

function activityDto(activity) {
    return {
        id: int64String(activity?.activity_id),
        typeCode: int64String(activity?.type),
        name: bytesToText(activity?.name),
        startTime: int64String(activity?.begin_time),
        endTime: int64String(activity?.end_time),
        extra: parseJsonText(activity?.extra),
    };
}

function businessError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

function positiveDecimal(value, code, fieldName) {
    let normalized = '';
    if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) normalized = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) normalized = String(value);
    if (!normalized || normalized.length > 19 || BigInt(normalized) > MAX_SIGNED_INT64) {
        throw businessError(code, `${fieldName} 必须是 int64 范围内的正十进制整数`);
    }
    return normalized;
}

function getSystemDateKey(timestamp = Date.now()) {
    const date = new Date(timestamp + 0);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function activityWindowIsActive(activity, serverTime = getServerTimeSec()) {
    const beginTime = int64Number(activity?.begin_time ?? activity?.beginTime);
    const endTime = int64Number(activity?.end_time ?? activity?.endTime);
    return (beginTime <= 0 || serverTime >= beginTime) && (endTime <= 0 || serverTime <= endTime);
}

function readBagBalances(bagReply, currencyIds) {
    const requested = new Set((currencyIds || []).map(String));
    const balances = new Map((currencyIds || []).map(id => [String(id), 0n]));
    for (const item of getBagItems(bagReply) || []) {
        const id = int64String(item?.id ?? item?.item_id);
        if (!requested.has(id)) continue;
        const count = BigInt(int64String(item?.count));
        balances.set(id, (balances.get(id) || 0n) + (count > 0n ? count : 0n));
    }
    return new Map(Array.from(balances, ([id, count]) => [id, count.toString()]));
}

function settledValue(entry) {
    return entry.status === 'fulfilled' ? entry.value : null;
}

function settledError(entry) {
    if (entry.status === 'fulfilled') return null;
    return String(entry.reason?.message || entry.reason || '未知错误');
}

async function settleRequest(operation) {
    try {
        return { status: 'fulfilled', value: await operation() };
    } catch (reason) {
        return { status: 'rejected', reason };
    }
}

// 同源 network.js 的 GatewayError：far2 侧用一个等价类承载，便于移植代码按 code 判定
class GatewayError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'GatewayError';
        this.code = code;
    }
}

// far2 的 sendMsgAsync 第四参是 timeout(毫秒)；同源代码会传 { expectedErrorCodes }，这里吞掉。
function send(service, method, body, options) {
    const timeout = typeof options === 'number' ? options : 20000;
    return sendMsgAsync(service, method, body, timeout);
}

function createActivityHub(options = {}) {
    const policy = { ...readPolicy(), ...(options.policy || {}) };
    // 允许注入假传输层（selftest 用），生产路径走真实 sendMsgAsync
    const transport = typeof options.sendMsgAsync === 'function' ? options.sendMsgAsync : send;
    let mutationTail = Promise.resolve();
    let callTimestamps = [];
    let pendingSnapshot = null;

    function serializeMutation(operation) {
        const run = mutationTail.then(operation, operation);
        mutationTail = run.then(() => undefined, () => undefined);
        return run;
    }

    function takeBudget() {
        const cutoff = Date.now() - 3600 * 1000;
        callTimestamps = callTimestamps.filter(ts => ts > cutoff);
        if (callTimestamps.length >= policy.maxPerHour) {
            throw businessError('ACTIVITY_RATE_LIMITED', `活动写操作超出每小时预算（${policy.maxPerHour} 次）`);
        }
        callTimestamps.push(Date.now());
    }

    function gate(action) {
        if (!policy.enabled) {
            throw businessError('ACTIVITY_OPERATE_DISABLED', `${action} 未开启（FAR2_ACTIVITY_OPERATE=1 才允许活动写操作）`);
        }
        takeBudget();
    }

    const deps = {
        types,
        sendMsgAsync: transport,
        GatewayError,
        getBag,
        getBagItems,
        getItemById,
        getItemImageById,
        getMutantEffectsByIds,
        getEffectiveSellInfo: () => null,
        getServerTimeSec,
        getSystemDateKey,
        getActivityWindows: activityWindows.getActivityWindows,
        getSellConditionContext: activityWindows.getSellConditionContext,
        reportActivityShare: async () => {
            throw businessError('ACTIVITY_SHARE_UNSUPPORTED', '本仓库未移植分享上报链路，跳过翻倍结算');
        },
        // 状态持久化
        createEmptyConstellationState: stateStore.createEmptyConstellationState,
        createEmptyCharityRedFlowerState: stateStore.createEmptyCharityRedFlowerState,
        loadConstellationState: stateStore.loadConstellationState,
        persistConstellationState: stateStore.persistConstellationState,
        loadCharityRedFlowerState: stateStore.loadCharityRedFlowerState,
        persistCharityRedFlowerState: stateStore.persistCharityRedFlowerState,
        mergeConstellationStates: stateStore.mergeConstellationStates,
        mergeCharityRedFlowerStates: stateStore.mergeCharityRedFlowerStates,
        stateRecordKey: stateStore.stateRecordKey,
        stateFromDynamicNodes: stateStore.stateFromDynamicNodes,
        stateWithNoClaimableDay: stateStore.stateWithNoClaimableDay,
        // 工具
        int64String,
        int64Number,
        compareInt64,
        bytesToText,
        textContent,
        parseJsonText,
        activityDto,
        itemDto,
        businessError,
        positiveDecimal,
        activityWindowIsActive,
        readBagBalances,
        settleRequest,
        settledValue,
        settledError,
        serializeMutation,
        getActivityCenterSnapshot,
    };

    const stellar = createStellarActivityService(deps);
    const charity = createCharityActivityService(deps);
    const qixi = createQixiActivityService(deps);
    const qingmei = createQingMeiActivityService(deps);
    // 宠日记依赖星座服务提供的节气数据
    const petDiary = createPetDiaryService({ ...deps, getCurrentSolarTerms: stellar.getCurrentSolarTerms });

    async function buildSnapshot() {
        // 注意：必须串行。活动网关对并发 RPC 很敏感（并发 List 会撞 10s 超时），
        // 上游 activity-center.ts 里也是刻意串行的。
        const out = { serverTime: getServerTimeSec(), errors: {} };
        const steps = [
            ['season', () => stellar.getCurrentSeasonEvent()],
            ['solarTerms', () => stellar.getCurrentSolarTerms()],
            ['charity', () => charity.getCurrentCharityRedFlowerActivity()],
            ['qixi', () => qixi.getCurrentQixiActivity()],
            ['qingMei', () => qingmei.getCurrentQingMeiActivity()],
        ];
        for (const [key, run] of steps) {
            const settled = await settleRequest(run);
            out[key] = settledValue(settled) ?? null;
            out.errors[key] = settledError(settled);
        }
        return out;
    }

    function getActivityCenterSnapshot() {
        if (pendingSnapshot) return pendingSnapshot;
        const request = buildSnapshot();
        pendingSnapshot = request;
        request.then(() => {
            if (pendingSnapshot === request) pendingSnapshot = null;
        }, () => {
            if (pendingSnapshot === request) pendingSnapshot = null;
        });
        return request;
    }

    // ---------- 对外动作（统一闸门）----------
    // 说明：子服务内部已经用自己的 serializeMutation 串行化，这里**不能**再套一层，
    // 否则两个队列互相等待会死锁（父队列等子队列，子队列排在父队列后面）。

    async function claimCharitySeeds(payload = {}) {
        gate('公益红花领种子');
        if (policy.dryRun) return { dryRun: true, action: 'charity.claimSeeds', payload };
        return charity.claimCharityRedFlowerSeeds(payload);
    }

    async function donateCharityLove(payload = {}) {
        gate('公益红花捐爱心');
        if (policy.dryRun) return { dryRun: true, action: 'charity.donateLove', payload };
        return charity.donateCharityRedFlowerLove(payload);
    }

    async function claimCharityProgressReward(payload = {}) {
        gate('公益红花进度奖励');
        if (policy.dryRun) return { dryRun: true, action: 'charity.claimProgressReward', payload };
        return charity.claimCharityRedFlowerProgressReward(payload);
    }

    async function claimConstellation(payload = {}) {
        gate('星座点亮');
        if (policy.dryRun) return { dryRun: true, action: 'stellar.lightConstellation', payload };
        return stellar.lightConstellation(payload);
    }

    async function claimQixiBridge(payload = {}) {
        gate('七夕鹊桥');
        if (policy.dryRun) return { dryRun: true, action: 'qixi.claimBridge', payload };
        return qixi.claimQixiBridgeRewards(payload);
    }

    async function claimQingMeiSeed(payload = {}) {
        gate('青梅领种子');
        if (policy.dryRun) return { dryRun: true, action: 'qingmei.claimSeed', payload };
        return qingmei.claimQingMeiDailySeed(payload);
    }

    async function settleQingMei(payload = {}) {
        gate('青梅西');
        if (policy.dryRun) return { dryRun: true, action: 'qingmei.settle', payload };
        return qingmei.settleQingMeiBrew(payload);
    }

    // ---------- 宠日记 / 奶茶店 / 天气活动 ----------

    async function petDiaryOperate(actionName, payload = {}) {
        gate(`宠日记:${actionName}`);
        if (policy.dryRun) return { dryRun: true, action: `petDiary.${actionName}`, payload };
        return petDiary.operatePetDiary(actionName, payload);
    }

    async function milkTeaOperate(actionName, payload = {}) {
        gate(`奶茶店:${actionName}`);
        if (policy.dryRun) return { dryRun: true, action: `milkTea.${actionName}`, payload };
        return milkTea.operateMilkTeaActivity(actionName, payload);
    }

    async function weatherCollectBottle(gid) {
        gate('天气活动:采集瓶');
        if (policy.dryRun) return { dryRun: true, action: 'weather.collectBottle', gid };
        return weatherActivity.useWeatherCollectorBottle(gid);
    }

    async function weatherAdvanceResearch(nodeId) {
        gate('天气活动:气象研究');
        if (policy.dryRun) return { dryRun: true, action: 'weather.advanceResearch', nodeId };
        return weatherActivity.advanceWeatherResearch(nodeId);
    }

    return {
        policy: () => ({ ...policy }),
        setPolicy(next = {}) {
            if (next.enabled !== undefined) policy.enabled = !!next.enabled;
            if (next.dryRun !== undefined) policy.dryRun = !!next.dryRun;
            if (next.maxPerHour !== undefined) {
                const value = Number(next.maxPerHour);
                if (Number.isSafeInteger(value) && value > 0) policy.maxPerHour = Math.min(value, 200);
            }
            return { ...policy };
        },
        getActivityCenterSnapshot,
        // 只读快照
        getCharity: charity.getCurrentCharityRedFlowerActivity,
        getQixi: qixi.getCurrentQixiActivity,
        getQingMei: qingmei.getCurrentQingMeiActivity,
        getStellar: stellar.getCurrentStellarActivity,
        getSeason: stellar.getCurrentSeasonEvent,
        getSolarTerms: stellar.getCurrentSolarTerms,
        getStarSandShop: stellar.getCurrentStarSandShop,
        // 写动作
        claimCharitySeeds,
        donateCharityLove,
        claimCharityProgressReward,
        claimConstellation,
        claimQixiBridge,
        claimQingMeiSeed,
        settleQingMei,
        // 宠日记 / 奶茶店 / 天气
        getPetDiary: petDiary.getPetDiary,
        getPetDiaryRecords: petDiary.getPetDiaryRecords,
        petDiaryOperate,
        getMilkTeaActivity: milkTea.getMilkTeaActivity,
        milkTeaOperate,
        getWeatherStatus: weatherActivity.getWeatherStatus,
        getWeatherActivity: weatherActivity.getCurrentWeatherActivity,
        getWeatherFriends: weatherActivity.getWeatherFriends,
        weatherCollectBottle,
        weatherAdvanceResearch,
        log,
    };
}

module.exports = { createActivityHub, int64String, int64Number, compareInt64, bytesToText, textContent, itemDto };
