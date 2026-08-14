const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const {
    listActivityOverview,
    normalizeActivityInfo,
    normalizeRandomShop,
    normalizeExchangeShop,
    normalizeDrawInfo,
} = require('./activity-readonly');
const { buildActivityDiscoverySnapshot } = require('./activity-discovery');

const ACTIVITY_SERVICE = 'gamepb.activitypb.ActivityService';
const DEFAULT_GROUP_LIMIT = 12;

function toPositiveInt(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    const i = Math.trunc(n);
    return i > 0 ? i : 0;
}

function normalizeActivityNode(raw, nowSec = Math.floor(Date.now() / 1000)) {
    if (!raw || typeof raw !== 'object') return null;
    const activity = normalizeActivityInfo(raw.activity || {}, nowSec);
    const randomShop = normalizeRandomShop(raw.random_shop) || activity.randomShop;
    const exchangeShop = normalizeExchangeShop(raw.exchange_shop) || activity.exchangeShop;
    const drawInfo = normalizeDrawInfo(raw.draw_info) || activity.drawInfo;
    const children = (Array.isArray(raw.children) ? raw.children : [])
        .map(child => normalizeActivityNode(child, nowSec))
        .filter(Boolean);
    return {
        ...activity,
        randomShop,
        exchangeShop,
        drawInfo,
        capabilities: {
            randomShop: !!randomShop,
            exchangeShop: !!exchangeShop,
            draw: !!drawInfo,
        },
        children,
    };
}

function buildActivityGroupOverview(reply, groupId, nowSec = Math.floor(Date.now() / 1000)) {
    const tree = normalizeActivityNode(reply && reply.group, nowSec);
    return {
        ok: !!tree,
        groupId: toPositiveInt(groupId),
        tree,
        readOnly: true,
        transport: 'ActivityService.GetGroup',
    };
}

async function getActivityGroupOverview(groupId, uid = '', options = {}) {
    const id = toPositiveInt(groupId);
    if (id <= 0) throw new Error('activity group id must be positive');
    if (!types.ActivityGetGroupRequest || !types.ActivityGetGroupReply) {
        throw new Error('Activity GetGroup protobuf not loaded');
    }
    const send = typeof options.send === 'function' ? options.send : sendMsgAsync;
    const request = types.ActivityGetGroupRequest.encode(types.ActivityGetGroupRequest.create({
        id,
        uid: String(uid || ''),
    })).finish();
    const { body } = await send(ACTIVITY_SERVICE, 'GetGroup', request, 10000);
    const decoded = types.ActivityGetGroupReply.decode(body);
    return buildActivityGroupOverview(decoded, id, options.nowSec || Math.floor(Date.now() / 1000));
}

function selectGroupCandidates(listOverview, limit = DEFAULT_GROUP_LIMIT) {
    const max = Math.max(1, Math.min(32, Number.parseInt(limit, 10) || DEFAULT_GROUP_LIMIT));
    const roots = Array.isArray(listOverview && listOverview.tree) ? listOverview.tree : [];
    const activeRoots = roots.filter(node => node && node.id > 0 && node.enabled && node.activeByTime);
    const visibleActiveRoots = activeRoots.filter(node => node.visible);
    const ordered = [...visibleActiveRoots, ...activeRoots.filter(node => !node.visible)];
    const seen = new Set();
    const result = [];
    for (const node of ordered) {
        const id = toPositiveInt(node.id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        result.push({ id, title: String(node.title || `活动#${id}`) });
        if (result.length >= max) break;
    }
    return result;
}

function createActivityDiscoveryService(options = {}) {
    const readList = typeof options.listActivityOverview === 'function'
        ? options.listActivityOverview
        : listActivityOverview;
    const readGroup = typeof options.getActivityGroupOverview === 'function'
        ? options.getActivityGroupOverview
        : getActivityGroupOverview;
    const groupLimit = Math.max(1, Math.min(32, Number.parseInt(options.groupLimit, 10) || DEFAULT_GROUP_LIMIT));

    async function discover(run = {}) {
        const listOverview = await readList();
        const candidates = selectGroupCandidates(listOverview, run.groupLimit || groupLimit);
        const groups = [];
        for (const candidate of candidates) {
            try {
                groups.push(await readGroup(candidate.id, '', run.groupOptions || {}));
            } catch (error) {
                groups.push({
                    ok: false,
                    groupId: candidate.id,
                    title: candidate.title,
                    error: String(error && error.message ? error.message : error),
                    readOnly: true,
                    transport: 'ActivityService.GetGroup',
                });
            }
        }
        const snapshot = buildActivityDiscoverySnapshot({
            listOverview,
            groups,
            groupRequested: candidates.length,
        });
        return {
            ...snapshot,
            groups,
            framework: {
                listTransport: 'ActivityService.List',
                groupTransport: 'ActivityService.GetGroup',
                maxGroupsPerScan: groupLimit,
                readOnly: true,
                autoOperateEnabled: false,
            },
        };
    }

    return { discover };
}

const defaultService = createActivityDiscoveryService();

module.exports = {
    ACTIVITY_SERVICE,
    DEFAULT_GROUP_LIMIT,
    normalizeActivityNode,
    buildActivityGroupOverview,
    getActivityGroupOverview,
    selectGroupCandidates,
    createActivityDiscoveryService,
    discoverActivityOverview: defaultService.discover,
};
