const process = require('node:process');
const path = require('node:path');
const fs = require('node:fs');
const { getDataDir } = require('../config/runtime-paths');

function getStatsFilePath(accountId) {
    const dataDir = getDataDir();
    return path.join(dataDir, 'stats', `${accountId}.json`);
}

function getTodayKey() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function loadPersistedStats(accountId) {
    try {
        const filePath = getStatsFilePath(accountId);
        if (!fs.existsSync(filePath)) return null;
        const raw = fs.readFileSync(filePath, 'utf8');
        if (!raw || !raw.trim()) return null;
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function savePersistedStats(accountId, data) {
    try {
        const filePath = getStatsFilePath(accountId);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tmpPath, filePath);
    } catch {
        // ignore
    }
}

const operations = {
    harvest: 0,
    water: 0,
    weed: 0,
    bug: 0,
    fertilize: 0,
    plant: 0,
    steal: 0,
    helpWater: 0,
    helpWeed: 0,
    helpBug: 0,
    taskClaim: 0,
    sell: 0,
    upgrade: 0,
    levelUp: 0,
};

// FAR2-MYSTERY-SHOP-STATS-v1
// 每账号持久化在既有 data/stats/<accountId>.json 中；不新建第二套状态库。
const mysteryShopStats = {
    todayBuyCount: 0,
    lastSuccessAt: 0,
    status: 'waiting',
    statusAt: 0,
    lastError: '',
};

function resetMysteryShopDailyState() {
    mysteryShopStats.todayBuyCount = 0;
    mysteryShopStats.status = 'waiting';
    mysteryShopStats.statusAt = Date.now();
    mysteryShopStats.lastError = '';
}

function restoreMysteryShopStats(saved, todayKey) {
    const source = (saved && saved.mysteryShop && typeof saved.mysteryShop === 'object')
        ? saved.mysteryShop
        : {};

    mysteryShopStats.todayBuyCount = (saved && saved.date === todayKey)
        ? Math.max(0, Number(source.todayBuyCount) || 0)
        : 0;
    mysteryShopStats.lastSuccessAt = Math.max(0, Number(source.lastSuccessAt) || 0);

    // Worker 重启后“当前状态”重新从等待开始，避免残留旧的失败/成功提示。
    mysteryShopStats.status = 'waiting';
    mysteryShopStats.statusAt = Date.now();
    mysteryShopStats.lastError = '';
}

function getMysteryShopStats() {
    checkAndResetDailyStats();
    return { ...mysteryShopStats };
}

function recordMysteryShopStatus(status, meta = {}) {
    checkAndResetDailyStats();

    const normalized = ['waiting', 'success', 'failed'].includes(String(status || ''))
        ? String(status)
        : 'waiting';
    const now = Date.now();
    const error = String(meta && meta.error || '').slice(0, 200);

    if (normalized === 'success') {
        mysteryShopStats.todayBuyCount += 1;
        mysteryShopStats.lastSuccessAt = Math.max(0, Number(meta && meta.successAt) || now);
        mysteryShopStats.status = 'success';
        mysteryShopStats.statusAt = now;
        mysteryShopStats.lastError = '';
        scheduleSave();
        return { ...mysteryShopStats };
    }

    // 正常轮询期间“等待”不会每 15~25 秒反复落盘。
    if (
        mysteryShopStats.status === normalized
        && (normalized !== 'failed' || mysteryShopStats.lastError === error)
    ) {
        return { ...mysteryShopStats };
    }

    mysteryShopStats.status = normalized;
    mysteryShopStats.statusAt = now;
    mysteryShopStats.lastError = normalized === 'failed' ? error : '';
    scheduleSave();
    return { ...mysteryShopStats };
}

let currentDateKey = null;

const lastState = {
    gold: -1,
    exp: -1,
    coupon: -1,
};

const initialState = {
    gold: null,
    exp: null,
    coupon: null,
};

const session = {
    goldGained: 0,
    expGained: 0,
    couponGained: 0,
    lastExpGain: 0,
    lastGoldGain: 0,
};

let currentAccountId = null;
let saveTimer = null;

function recordOperation(type, count = 1) {
    checkAndResetDailyStats();
    if (operations[type] !== undefined) {
        operations[type] += count;
        scheduleSave();
    }
}

function checkAndResetDailyStats() {
    if (!currentAccountId) return;
    const todayKey = getTodayKey();
    if (currentDateKey && currentDateKey !== todayKey) {
        console.warn(`[统计] 检测到跨天，重置每日统计 (${currentDateKey} -> ${todayKey})`);
        Object.keys(operations).forEach((key) => {
            operations[key] = 0;
        });
        resetMysteryShopDailyState();
        scheduleSave();
    }
    currentDateKey = todayKey;
}

function scheduleSave() {
    if (!currentAccountId) return;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        doSave();
    }, 2000);
}

function doSave() {
    if (!currentAccountId) return;
    const todayKey = getTodayKey();
    const data = {
        date: todayKey,
        operations: { ...operations },
        mysteryShop: { ...mysteryShopStats },
        initialState: { ...initialState },
        savedAt: Date.now(),
    };
    savePersistedStats(currentAccountId, data);
}

function initStats(gold, exp, coupon = 0) {
    const g = Number.isFinite(Number(gold)) ? Number(gold) : 0;
    const e = Number.isFinite(Number(exp)) ? Number(exp) : 0;
    const c = Number.isFinite(Number(coupon)) ? Number(coupon) : 0;
    lastState.gold = g;
    lastState.exp = e;
    lastState.coupon = c;
    initialState.gold = g;
    initialState.exp = e;
    initialState.coupon = c;
}

function initStatsWithPersistence(accountId, gold, exp, coupon = 0) {
    currentAccountId = accountId;
    const todayKey = getTodayKey();
    currentDateKey = todayKey;
    const saved = loadPersistedStats(accountId);

    if (saved && saved.date === todayKey) {
        Object.keys(saved.operations || {}).forEach((key) => {
            if (operations[key] !== undefined) {
                operations[key] = Number(saved.operations[key]) || 0;
            }
        });
        console.warn(`[统计] 已恢复今日统计数据: ${JSON.stringify(saved.operations)}`);
    } else {
        Object.keys(operations).forEach((key) => {
            operations[key] = 0;
        });
        if (saved) {
            console.warn(`[统计] 日期已变更，重置统计 (${saved.date} -> ${todayKey})`);
        }
    }

    restoreMysteryShopStats(saved, todayKey);
    initStats(gold, exp, coupon);
}

function updateStats(currentGold, currentExp) {
    if (lastState.gold === -1) lastState.gold = currentGold;
    if (lastState.exp === -1) lastState.exp = currentExp;

    if (currentGold > lastState.gold) {
        const delta = currentGold - lastState.gold;
        session.lastGoldGain = delta;
    } else if (currentGold < lastState.gold) {
        session.lastGoldGain = 0;
    }
    lastState.gold = currentGold;

    if (currentExp > lastState.exp) {
        const delta = currentExp - lastState.exp;
        const now = Date.now();
        if (delta === session.lastExpGain && (now - (session.lastExpTime || 0) < 1000)) {
            // console.warn(`[系统] 忽略重复经验增量 +${delta}`);
        } else {
            session.lastExpGain = delta;
            session.lastExpTime = now;
            // console.warn(`[系统] 经验 +${delta} (总计: ${currentExp})`);
        }
    } else {
        session.lastExpGain = 0;
    }
    lastState.exp = currentExp;
}

function recordGoldExp(gold, exp) {
    updateStats(gold, exp);
}

function setInitialValues(gold, exp, coupon = 0) {
    initStats(gold, exp, coupon);
}

function resetSessionGains() {
    session.goldGained = 0;
    session.expGained = 0;
    session.couponGained = 0;
    session.lastGoldGain = 0;
    session.lastExpGain = 0;
    session.lastExpTime = 0;
}

function recomputeSessionTotals(currentGold, currentExp, currentCoupon) {
    if (initialState.gold === null || initialState.exp === null || initialState.coupon === null) {
        initialState.gold = currentGold;
        initialState.exp = currentExp;
        initialState.coupon = currentCoupon;
    }
    session.goldGained = currentGold - initialState.gold;
    session.expGained = currentExp - initialState.exp;
    session.couponGained = currentCoupon - initialState.coupon;
}

function getStats(statusData, userState, connected, limits) {
    checkAndResetDailyStats();
    const statusObj = (statusData && typeof statusData === 'object') ? statusData : {};
    const userObj = (userState && typeof userState === 'object') ? userState : {};

    const rawGold = (userObj.gold !== null && userObj.gold !== undefined) ? userObj.gold : statusObj.gold;
    const rawExp = (userObj.exp !== null && userObj.exp !== undefined) ? userObj.exp : statusObj.exp;
    const rawCoupon = (userObj.coupon !== null && userObj.coupon !== undefined) ? userObj.coupon : statusObj.coupon;
    const rawGoldBean = (userObj.goldBean !== null && userObj.goldBean !== undefined) ? userObj.goldBean : statusObj.goldBean;
    const currentGold = Number.isFinite(Number(rawGold)) ? Number(rawGold) : 0;
    const currentExp = Number.isFinite(Number(rawExp)) ? Number(rawExp) : 0;
    const currentCoupon = Number.isFinite(Number(rawCoupon)) ? Number(rawCoupon) : 0;
    const currentGoldBean = Number.isFinite(Number(rawGoldBean)) ? Number(rawGoldBean) : 0;

    if (connected) {
        updateStats(currentGold, currentExp);
        recomputeSessionTotals(currentGold, currentExp, currentCoupon);
    }

    const operationsSnapshot = { ...operations };
    return {
        connection: { connected },
        status: {
            name: userObj.name || statusObj.name,
            level: statusObj.level || userObj.level || 0,
            gold: currentGold,
            coupon: Number.isFinite(Number(userObj.coupon)) ? Number(userObj.coupon) : 0,
            goldBean: currentGoldBean,
            exp: currentExp,
            platform: statusObj.platform || userObj.platform || 'qq',
        },
        uptime: process.uptime(),
        operations: operationsSnapshot,
        mysteryShop: getMysteryShopStats(),
        sessionExpGained: session.expGained,
        sessionGoldGained: session.goldGained,
        sessionCouponGained: session.couponGained,
        lastExpGain: session.lastExpGain,
        lastGoldGain: session.lastGoldGain,
        limits,
    };
}

function saveStats() {
    doSave();
}

module.exports = {
    recordOperation,
    recordMysteryShopStatus,
    getMysteryShopStats,
    initStats,
    initStatsWithPersistence,
    updateStats,
    setInitialValues,
    recordGoldExp,
    resetSessionGains,
    getStats,
    saveStats,
    getTodayKey,
    loadPersistedStats,
    checkAndResetDailyStats,
};
