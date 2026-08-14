const assert = require('node:assert/strict');
const {
    inspectSeedEvidence,
    buildBagSeedInventory,
    buildShopSeedIdSet,
    collectActivityItemIds,
    createDiscoveryStateStore,
    createEventSeedPriorityService,
} = require('../src/services/event-seed-priority');

async function main() {
    console.log('FAR2 Event Seed Priority / Auto-Discovery Self-Test');
    console.log('安全: 全部使用本地 fixture + fake plant/shop，不连接 QQ、不购买、不真实种植。\n');

    const plants = new Map([
        [20002, { seed_id: 20002, name: '白萝卜', size: 0, land_level_need: 1 }],
        [20046, { seed_id: 20046, name: '爱心果', size: 2, land_level_need: 1, config_fallback: true }],
        [20901, { seed_id: 20901, name: '活动花', size: 0, land_level_need: 1 }],
        [20902, { seed_id: 20902, name: '活动大花', size: 2, land_level_need: 1 }],
        [20903, { seed_id: 20903, name: '高级活动花', size: 0, land_level_need: 120 }],
    ]);
    const items = new Map([
        [20002, { id: 20002, type: 5, name: '白萝卜种子', interaction_type: 'plant', price: 1 }],
        [20046, { id: 20046, type: 5, name: '爱心果种子', interaction_type: 'plant', price: 0 }],
        [20901, { id: 20901, type: 5, name: '活动花种子', interaction_type: 'plant', price: 0 }],
        [20902, { id: 20902, type: 5, name: '活动大花种子', interaction_type: 'plant', price: 0 }],
        [20903, { id: 20903, type: 5, name: '高级活动花种子', interaction_type: 'plant', price: 0 }],
    ]);
    const getPlantBySeedId = id => plants.get(Number(id)) || null;
    const getItemById = id => items.get(Number(id)) || null;

    const unknownEvidence = inspectSeedEvidence(20999, null, null, new Set());
    assert.equal(unknownEvidence.candidate, true);
    assert.equal(unknownEvidence.knownPlant, false);
    assert.equal(unknownEvidence.confidence, 'medium');
    console.log('✅ unknown 20xxx bag item is retained as seed candidate instead of being discarded PASS');

    const inventory = buildBagSeedInventory([
        { id: 20002, count: 10 },
        { id: 20901, count: 2 },
        { id: 20999, count: 1 },
        { id: 80001, count: 5 },
    ], {
        getItemById,
        getPlantBySeedId,
        activityItemIds: new Set([20901]),
    });
    assert.deepEqual(inventory.knownSeeds.map(row => row.seedId), [20002, 20901]);
    assert.deepEqual(inventory.unresolvedCandidates.map(row => row.seedId), [20999]);
    assert.equal(inventory.knownSeeds.find(row => row.seedId === 20901).activityReferenced, true);
    console.log('✅ known + unresolved bag seeds are separated without guessing unknown plant size PASS');

    const shopIds = buildShopSeedIdSet({
        goods_list: [{ item_id: 20002 }, { item_id: 20003 }],
    });
    assert.equal(shopIds.has(20002), true);
    assert.equal(shopIds.has(20901), false);
    console.log('✅ normal seed-shop membership can distinguish special bag seeds PASS');

    const activityIds = collectActivityItemIds({
        activities: [{
            randomShop: { items: [{ item: { id: 20901 } }] },
            exchangeShop: { items: [{ item: { id: 20902 } }] },
            drawInfo: { rewards: [{ item: { id: 20903 } }] },
            payload: { json: { seed_id: 20904, nested: { rewardItemId: 20905 } } },
        }],
    });
    assert.deepEqual([...activityIds].sort((a, b) => a - b), [20901, 20902, 20903, 20904, 20905]);
    console.log('✅ activity readonly structures enrich seed discovery evidence PASS');

    const memoryFiles = new Map();
    const stateStore = createDiscoveryStateStore({
        getDataFile: name => name,
        readJsonFile: (name, fallbackFactory) => memoryFiles.has(name)
            ? memoryFiles.get(name)
            : (typeof fallbackFactory === 'function' ? fallbackFactory() : {}),
        writeJsonFileAtomic: (name, value) => memoryFiles.set(name, JSON.parse(JSON.stringify(value))),
    });
    const firstRecorded = stateStore.record('232', [{
        seedId: 20999,
        name: '疑似种子#20999',
        count: 1,
        resolved: false,
        safeToPlant: false,
        plantSize: 0,
        requiredLevel: 0,
        shopListed: false,
        activityReferenced: true,
        specialCandidate: true,
        confidence: 'high',
        evidence: ['activity-reference', 'seed-id-namespace'],
    }], 1000);
    const duplicateRecorded = stateStore.record('232', [{
        seedId: 20999,
        name: '疑似种子#20999',
        count: 1,
        resolved: false,
        safeToPlant: false,
        plantSize: 0,
        requiredLevel: 0,
        shopListed: false,
        activityReferenced: true,
        specialCandidate: true,
        confidence: 'high',
        evidence: ['activity-reference', 'seed-id-namespace'],
    }], 2000);
    assert.equal(firstRecorded, true);
    assert.equal(duplicateRecorded, false);
    assert.equal(memoryFiles.get('seed_discovery/232.json').entries['20999'].firstSeenAt, 1000);
    console.log('✅ discovery evidence persists once per changed signature for future learning PASS');

    const noWrites = [];
    const discoveryWrites = [];
    const unresolvedService = createEventSeedPriorityService({
        getBag: async () => ({ item_bag: { items: [{ id: 20999, count: 1 }] } }),
        getBagItems: reply => reply.item_bag.items,
        getItemById,
        getPlantBySeedId,
        getShopInfo: async () => ({ goods_list: [{ item_id: 20002 }] }),
        listActivityOverview: async () => ({ activities: [] }),
        getBagSeedPriority: () => [],
        getAllLands: async () => ({ lands: [] }),
        plantSeeds: async (...args) => {
            noWrites.push(['1x1', ...args]);
            return { planted: 0 };
        },
        plant2x2Seed: async (...args) => {
            noWrites.push(['2x2', ...args]);
            return {};
        },
        discoveryStateStore: { record: (...args) => discoveryWrites.push(args) },
        log: () => {},
        logWarn: () => {},
        sleep: async () => {},
    });
    const unresolvedResult = await unresolvedService.runBeforeShop({
        landIds: [1, 2],
        state: { level: 113 },
        accountId: 'fixture',
    });
    assert.equal(unresolvedResult.blockShopFallback, true);
    assert.deepEqual(unresolvedResult.unresolvedSeedIds, [20999]);
    assert.equal(noWrites.length, 0);
    assert.equal(discoveryWrites.length, 1);
    console.log('✅ unresolved seed blocks ordinary shop fallback and causes zero plant writes PASS');

    const planted1x1 = [];
    const service1x1 = createEventSeedPriorityService({
        getBag: async () => ({ item_bag: { items: [{ id: 20002, count: 10 }, { id: 20901, count: 2 }] } }),
        getBagItems: reply => reply.item_bag.items,
        getItemById,
        getPlantBySeedId,
        getShopInfo: async () => ({ goods_list: [{ item_id: 20002 }] }),
        listActivityOverview: async () => ({ activities: [] }),
        getBagSeedPriority: () => [],
        plantSeeds: async (seedId, landIds, runOptions) => {
            planted1x1.push([seedId, [...landIds], runOptions.maxPlantCount]);
            return {
                planted: runOptions.maxPlantCount,
                plantedLandIds: landIds.slice(0, runOptions.maxPlantCount),
                occupiedLandIds: landIds.slice(0, runOptions.maxPlantCount),
            };
        },
        plant2x2Seed: async () => {
            throw new Error('2x2 should not run');
        },
        getAllLands: async () => ({ lands: [] }),
        discoveryStateStore: { record: () => {} },
        log: () => {},
        logWarn: () => {},
        sleep: async () => {},
    });
    const oneResult = await service1x1.runBeforeShop({
        landIds: [1, 2, 3],
        state: { level: 113 },
        accountId: 'fixture',
    });
    assert.deepEqual(planted1x1, [[20901, [1, 2, 3], 2]]);
    assert.deepEqual(oneResult.remainingLandIds, [3]);
    assert.deepEqual(oneResult.plantedLandIds, [1, 2]);
    assert.equal(oneResult.blockShopFallback, false);
    console.log('✅ known non-shop 1x1 event seed is consumed before ordinary shop strategy PASS');

    const planted2x2 = [];
    const service2x2 = createEventSeedPriorityService({
        getBag: async () => ({ item_bag: { items: [{ id: 20902, count: 1 }] } }),
        getBagItems: reply => reply.item_bag.items,
        getItemById,
        getPlantBySeedId,
        getShopInfo: async () => ({ goods_list: [{ item_id: 20002 }] }),
        listActivityOverview: async () => ({ activities: [] }),
        getBagSeedPriority: () => [],
        getAllLands: async () => ({ lands: [1, 2, 3, 4, 5].map(id => ({ id, unlocked: true, plant: null })) }),
        selectReady2x2Groups: () => [{ masterLandId: 1, landIds: [1, 2, 3, 4] }],
        plantSeeds: async () => {
            throw new Error('1x1 should not run');
        },
        plant2x2Seed: async (seedId, group) => {
            planted2x2.push([seedId, [...group.landIds]]);
            return { masterLandId: 1, occupiedLandIds: [1, 2, 3, 4] };
        },
        discoveryStateStore: { record: () => {} },
        log: () => {},
        logWarn: () => {},
        sleep: async () => {},
    });
    const twoResult = await service2x2.runBeforeShop({
        landIds: [1, 2, 3, 4, 5],
        state: { level: 113 },
        accountId: 'fixture',
    });
    assert.deepEqual(planted2x2, [[20902, [1, 2, 3, 4]]]);
    assert.deepEqual(twoResult.remainingLandIds, [5]);
    assert.equal(twoResult.totalPlanted, 1);
    assert.equal(twoResult.occupiedCount, 4);
    console.log('✅ known non-shop 2x2 event seed uses four-land planting path before shop PASS');

    const lockedWrites = [];
    const lockedService = createEventSeedPriorityService({
        getBag: async () => ({ item_bag: { items: [{ id: 20903, count: 1 }] } }),
        getBagItems: reply => reply.item_bag.items,
        getItemById,
        getPlantBySeedId,
        getShopInfo: async () => ({ goods_list: [] }),
        listActivityOverview: async () => ({ activities: [] }),
        getBagSeedPriority: () => [],
        plantSeeds: async (...args) => lockedWrites.push(args),
        plant2x2Seed: async (...args) => lockedWrites.push(args),
        getAllLands: async () => ({ lands: [] }),
        discoveryStateStore: { record: () => {} },
        log: () => {},
        logWarn: () => {},
    });
    const lockedResult = await lockedService.runBeforeShop({
        landIds: [1],
        state: { level: 113 },
        accountId: 'fixture',
    });
    assert.equal(lockedWrites.length, 0);
    assert.equal(lockedResult.blockShopFallback, false);
    assert.deepEqual(lockedResult.remainingLandIds, [1]);
    console.log('✅ level-locked special seed does not consume or unnecessarily block normal planting PASS');

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        realQqTouched: false,
        realBagRpcTouched: false,
        realShopRpcTouched: false,
        realPlantRpcTouched: false,
        unresolvedWriteCount: noWrites.length,
    }, null, 2));
}

main().catch(error => {
    console.error('\n❌ Event Seed Priority / Auto-Discovery Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
