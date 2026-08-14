const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { getItemById, getItemImageById, getPlantBySeedId, getPlantByFruitId } = require('../config/gameConfig');

const ACTIVITY_SERVICE = 'gamepb.activitypb.ActivityService';

function toSafeNumber(value) {
    if (value === undefined || value === null) return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'bigint') {
        const numeric = Number(value);
        return Number.isSafeInteger(numeric) ? numeric : 0;
    }
    if (typeof value.toNumber === 'function') {
        const numeric = value.toNumber();
        return Number.isSafeInteger(numeric) ? numeric : 0;
    }
    if (typeof value.toString === 'function') {
        const numeric = Number(value.toString());
        return Number.isSafeInteger(numeric) ? numeric : 0;
    }
    return 0;
}

function resolveItemName(itemId) {
    const id = Number(itemId) || 0;
    if (id <= 0) return '';
    const info = getItemById(id);
    if (info && info.name) return String(info.name);
    const seed = getPlantBySeedId(id);
    if (seed && seed.name) return `${seed.name}种子`;
    const fruit = getPlantByFruitId(id);
    if (fruit && fruit.name) return String(fruit.name);
    return `物品#${id}`;
}

function normalizeCoreItem(raw) {
    const id = toSafeNumber(raw && raw.id);
    const count = toSafeNumber(raw && raw.count);
    return {
        id,
        count,
        name: resolveItemName(id),
        image: id > 0 ? String(getItemImageById(id) || '') : '',
    };
}

function parsePayload(payload) {
    const raw = String(payload || '').trim();
    if (!raw) return { raw: '', json: null, keys: [] };
    try {
        const json = JSON.parse(raw);
        const keys = json && typeof json === 'object' && !Array.isArray(json)
            ? Object.keys(json).slice(0, 50)
            : [];
        return { raw, json, keys };
    } catch {
        return { raw, json: null, keys: [] };
    }
}

function normalizeRandomShop(raw) {
    if (!raw) return null;
    const items = (Array.isArray(raw.items) ? raw.items : []).map(entry => ({
        id: Number(entry && entry.id) || 0,
        name: String((entry && entry.name) || '').trim(),
        item: normalizeCoreItem(entry && entry.item),
        cost: normalizeCoreItem(entry && entry.cost),
        stockCount: Number(entry && entry.stock_count) || 0,
        boughtCount: Number(entry && entry.bought_count) || 0,
        special: !!(entry && entry.special),
    }));
    return {
        items,
        nextRefreshTime: toSafeNumber(raw.next_refresh_time),
        manualRefreshCost: Number(raw.manual_refresh_cost) || 0,
        manualRefreshCurrencyId: Number(raw.manual_refresh_currency_id) || 0,
        maxManualRefreshCount: Number(raw.max_manual_refresh_count) || 0,
        manualRefreshUsedCount: Number(raw.manual_refresh_used_count) || 0,
    };
}

function normalizeExchangeShop(raw) {
    if (!raw) return null;
    return {
        items: (Array.isArray(raw.items) ? raw.items : []).map(entry => ({
            id: Number(entry && entry.id) || 0,
            name: String((entry && entry.name) || '').trim(),
            item: normalizeCoreItem(entry && entry.item),
            cost: normalizeCoreItem(entry && entry.cost),
            status: Number(entry && entry.status) || 0,
            owned: !!(entry && entry.owned),
            sort: Number(entry && entry.sort) || 0,
            extra: String((entry && entry.extra) || '').trim(),
        })),
    };
}

function normalizeDrawInfo(raw) {
    if (!raw) return null;
    return {
        freeRemainingCount: Number(raw.free_remaining_count) || 0,
        maxFreeCount: Number(raw.max_free_count) || 0,
        paidRemainingCount: Number(raw.paid_remaining_count) || 0,
        maxPaidCount: Number(raw.max_paid_count) || 0,
        paidCurrencyId: Number(raw.paid_currency_id) || 0,
        paidPrice: Number(raw.paid_price) || 0,
        fallbackPrice: Number(raw.fallback_price) || 0,
        rewards: (Array.isArray(raw.rewards) ? raw.rewards : []).map(entry => ({
            id: Number(entry && entry.id) || 0,
            rarity: Number(entry && entry.rarity) || 0,
            item: normalizeCoreItem(entry && entry.item),
            flag: Number(entry && entry.flag) || 0,
            probability: String((entry && entry.probability) || '').trim(),
        })),
    };
}

function normalizeActivityInfo(raw, nowSec = Math.floor(Date.now() / 1000)) {
    const id = toSafeNumber(raw && raw.id);
    const parentId = toSafeNumber(raw && raw.parent_id);
    const startTime = toSafeNumber(raw && raw.start_time);
    const endTime = toSafeNumber(raw && raw.end_time);
    const payload = parsePayload(raw && raw.payload);
    const randomShop = normalizeRandomShop(raw && raw.random_shop);
    const exchangeShop = normalizeExchangeShop(raw && raw.exchange_shop);
    const drawInfo = normalizeDrawInfo(raw && raw.draw_info);
    const activeByTime = (startTime <= 0 || startTime <= nowSec) && (endTime <= 0 || nowSec <= endTime);

    return {
        id,
        parentId,
        type: Number(raw && raw.type) || 0,
        title: String((raw && raw.title) || `活动#${id}`).trim(),
        payload,
        startTime,
        endTime,
        sort: Number(raw && raw.sort) || 0,
        visible: !!(raw && raw.visible),
        status: Number(raw && raw.status) || 0,
        enabled: !!(raw && raw.enabled),
        activeByTime,
        capabilities: {
            randomShop: !!randomShop,
            exchangeShop: !!exchangeShop,
            draw: !!drawInfo,
        },
        randomShop,
        exchangeShop,
        drawInfo,
        adapter: null,
    };
}

function buildActivityTree(activities) {
    const nodes = new Map();
    for (const activity of (Array.isArray(activities) ? activities : [])) {
        nodes.set(activity.id, { ...activity, children: [] });
    }
    const roots = [];
    for (const node of nodes.values()) {
        if (node.parentId > 0 && nodes.has(node.parentId) && node.parentId !== node.id) {
            nodes.get(node.parentId).children.push(node);
        } else {
            roots.push(node);
        }
    }
    const sortNodes = (list) => {
        list.sort((a, b) => a.sort - b.sort || b.startTime - a.startTime || a.id - b.id);
        for (const node of list) sortNodes(node.children);
    };
    sortNodes(roots);
    return roots;
}

function buildActivityOverview(reply, nowSec = Math.floor(Date.now() / 1000)) {
    const activities = (Array.isArray(reply && reply.activities) ? reply.activities : [])
        .map(item => normalizeActivityInfo(item, nowSec))
        .filter(item => item.id > 0);
    const visible = activities.filter(item => item.visible);
    const active = visible.filter(item => item.enabled && item.activeByTime);
    return {
        activities,
        tree: buildActivityTree(activities),
        summary: {
            total: activities.length,
            visible: visible.length,
            active: active.length,
            withRandomShop: activities.filter(item => item.capabilities.randomShop).length,
            withExchangeShop: activities.filter(item => item.capabilities.exchangeShop).length,
            withDraw: activities.filter(item => item.capabilities.draw).length,
        },
        framework: {
            transport: 'ActivityService.List',
            adapters: [],
            operateEnabled: false,
            readOnly: true,
        },
    };
}

async function listActivityOverview() {
    if (!types.ActivityListRequest || !types.ActivityListReply) {
        throw new Error('Activity read-only protobuf not loaded');
    }
    const request = types.ActivityListRequest.encode(types.ActivityListRequest.create({})).finish();
    const { body } = await sendMsgAsync(ACTIVITY_SERVICE, 'List', request, 10000);
    const decoded = types.ActivityListReply.decode(body);
    return buildActivityOverview(decoded);
}

module.exports = {
    ACTIVITY_SERVICE,
    toSafeNumber,
    normalizeCoreItem,
    parsePayload,
    normalizeRandomShop,
    normalizeExchangeShop,
    normalizeDrawInfo,
    normalizeActivityInfo,
    buildActivityTree,
    buildActivityOverview,
    listActivityOverview,
};
