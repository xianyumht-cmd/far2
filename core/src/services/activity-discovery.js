const SEED_ID_MIN = 20000;
const SEED_ID_MAX = 29999;

function toPositiveInt(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    const i = Math.trunc(n);
    return i > 0 ? i : 0;
}

function stableUnique(values) {
    return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function nodeCapabilities(node) {
    const caps = [];
    if (node?.randomShop) caps.push('random-shop');
    if (node?.exchangeShop) caps.push('exchange-shop');
    if (node?.drawInfo) caps.push('draw');
    if (node?.payload?.json) caps.push('json-payload');
    else if (node?.payload?.raw) caps.push('raw-payload');
    return caps;
}

function collectItemIdsFromNode(node) {
    const ids = [];
    for (const row of (node?.randomShop?.items || [])) {
        const id = toPositiveInt(row?.item?.id);
        if (id) ids.push(id);
        const costId = toPositiveInt(row?.cost?.id);
        if (costId) ids.push(costId);
    }
    for (const row of (node?.exchangeShop?.items || [])) {
        const id = toPositiveInt(row?.item?.id);
        if (id) ids.push(id);
        const costId = toPositiveInt(row?.cost?.id);
        if (costId) ids.push(costId);
    }
    for (const row of (node?.drawInfo?.rewards || [])) {
        const id = toPositiveInt(row?.item?.id);
        if (id) ids.push(id);
    }
    return stableUnique(ids);
}

function collectPayloadIds(value, out = []) {
    if (value === null || value === undefined) return out;
    if (Array.isArray(value)) {
        for (const item of value) collectPayloadIds(item, out);
        return out;
    }
    if (typeof value !== 'object') return out;
    for (const [key, child] of Object.entries(value)) {
        const normalized = String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
        if (['seedid', 'itemid', 'rewardid', 'rewarditemid'].includes(normalized)) {
            const id = toPositiveInt(child);
            if (id) out.push(id);
        }
        collectPayloadIds(child, out);
    }
    return out;
}

function flattenActivityNodes(nodes) {
    const out = [];
    const stack = [...(Array.isArray(nodes) ? nodes : [])].reverse();
    const seen = new Set();
    while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== 'object') continue;
        const id = toPositiveInt(node.id);
        const key = id > 0 ? `id:${id}` : `anon:${out.length}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(node);
        const children = Array.isArray(node.children) ? node.children : [];
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
    return out;
}

function buildStructureFingerprint(node) {
    const caps = nodeCapabilities(node).sort();
    const payloadKeys = Array.isArray(node?.payload?.keys)
        ? [...node.payload.keys].map(String).sort()
        : [];
    const childTypes = (Array.isArray(node?.children) ? node.children : [])
        .map(child => Number(child?.type) || 0)
        .sort((a, b) => a - b);
    return [
        `type=${Number(node?.type) || 0}`,
        `caps=${caps.join(',')}`,
        `payload=${payloadKeys.join(',')}`,
        `children=${childTypes.join(',')}`,
    ].join('|');
}

function classifyActivityNode(node) {
    const capabilities = nodeCapabilities(node);
    const directItemIds = collectItemIdsFromNode(node);
    const payloadItemIds = stableUnique(collectPayloadIds(node?.payload?.json, []));
    const itemIds = stableUnique([...directItemIds, ...payloadItemIds]);
    const seedLikeItemIds = itemIds.filter(id => id >= SEED_ID_MIN && id <= SEED_ID_MAX);

    const freeDrawRemaining = Math.max(0, Number(node?.drawInfo?.freeRemainingCount) || 0);
    const randomShopCandidates = (node?.randomShop?.items || []).filter(row => {
        const stock = Math.max(0, Number(row?.stockCount) || 0);
        const bought = Math.max(0, Number(row?.boughtCount) || 0);
        return stock <= 0 || bought < stock;
    }).length;
    const exchangeCandidates = (node?.exchangeShop?.items || []).filter(row => !row?.owned).length;

    const potentialActions = [];
    if (freeDrawRemaining > 0) {
        potentialActions.push({
            kind: 'free-draw',
            count: freeDrawRemaining,
            autoOperate: false,
            reason: 'activity-write-schema-unproven',
        });
    }
    if (randomShopCandidates > 0) {
        potentialActions.push({
            kind: 'random-shop',
            count: randomShopCandidates,
            autoOperate: false,
            reason: 'activity-write-schema-unproven',
        });
    }
    if (exchangeCandidates > 0) {
        potentialActions.push({
            kind: 'exchange-shop',
            count: exchangeCandidates,
            autoOperate: false,
            reason: 'activity-write-schema-unproven',
        });
    }

    return {
        id: toPositiveInt(node?.id),
        parentId: toPositiveInt(node?.parentId),
        type: Number(node?.type) || 0,
        title: String(node?.title || '').trim(),
        visible: node?.visible === true,
        enabled: node?.enabled === true,
        activeByTime: node?.activeByTime === true,
        capabilities,
        structureFingerprint: buildStructureFingerprint(node),
        itemIds,
        seedLikeItemIds,
        signals: {
            freeDrawRemaining,
            randomShopCandidates,
            exchangeCandidates,
        },
        potentialActions,
        writePolicy: {
            autoOperate: false,
            reason: 'write-schema-unproven',
            requiredEvidence: [
                'official-service-method',
                'request-wire',
                'server-precondition',
                'post-write-read-verification',
            ],
        },
    };
}

function buildActivityDiscoverySnapshot(input = {}) {
    const listOverview = input.listOverview && typeof input.listOverview === 'object'
        ? input.listOverview
        : { activities: [], tree: [], summary: {} };
    const groups = Array.isArray(input.groups) ? input.groups : [];
    const groupNodes = groups.flatMap(group => flattenActivityNodes(group?.tree ? [group.tree] : []));
    const fallbackNodes = flattenActivityNodes(listOverview.tree || []);
    const sourceNodes = groupNodes.length > 0 ? groupNodes : fallbackNodes;
    const classified = sourceNodes.map(classifyActivityNode);
    const seedLikeItemIds = stableUnique(classified.flatMap(row => row.seedLikeItemIds));
    const fingerprints = stableUnique(classified.map(row => row.structureFingerprint));
    const potentialActionCount = classified.reduce((sum, row) => sum + row.potentialActions.length, 0);

    return {
        generatedAt: new Date().toISOString(),
        source: groupNodes.length > 0 ? 'list+get-group' : 'list-only',
        listSummary: listOverview.summary || {},
        groupSummary: {
            requested: Number(input.groupRequested) || groups.length,
            loaded: groups.filter(group => group?.ok !== false).length,
            failed: groups.filter(group => group?.ok === false).length,
        },
        nodes: classified,
        summary: {
            nodeCount: classified.length,
            activeNodeCount: classified.filter(row => row.enabled && row.activeByTime).length,
            withRandomShop: classified.filter(row => row.capabilities.includes('random-shop')).length,
            withExchangeShop: classified.filter(row => row.capabilities.includes('exchange-shop')).length,
            withDraw: classified.filter(row => row.capabilities.includes('draw')).length,
            potentialActionCount,
            seedLikeItemIds,
            structureFingerprints: fingerprints,
        },
        operationFramework: {
            discoveryReadOnly: true,
            autoOperateEnabled: false,
            unknownStructuresFailClosed: true,
        },
    };
}

module.exports = {
    SEED_ID_MIN,
    SEED_ID_MAX,
    toPositiveInt,
    nodeCapabilities,
    collectItemIdsFromNode,
    collectPayloadIds,
    flattenActivityNodes,
    buildStructureFingerprint,
    classifyActivityNode,
    buildActivityDiscoverySnapshot,
};
