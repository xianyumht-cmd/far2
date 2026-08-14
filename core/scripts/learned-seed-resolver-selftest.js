const assert = require('node:assert/strict');
const {
    createLearnedSeedResolver,
    shouldTryRuntimeLearning,
} = require('../src/services/learned-seed-resolver');
const { createEventSeedPriorityService } = require('../src/services/event-seed-priority');

async function main() {
    console.log('FAR2 Learned Seed Resolver Self-Test');
    console.log('安全: 只使用 fixture，不读取真实 QQ 缓存、不连接网络、不发送 Plant/Shop RPC。\n');

    assert.equal(shouldTryRuntimeLearning(80001, { type: 2, name: '化肥' }), false);
    assert.equal(shouldTryRuntimeLearning(20999, null), true);
    assert.equal(shouldTryRuntimeLearning(50001, { type: 5, name: '活动种子' }), true);
    console.log('✅ runtime learning is restricted to seed-like candidates PASS');

    let learnerCalls = 0;
    const staticPlant = { seed_id: 20002, name: '白萝卜', size: 0, land_level_need: 1 };
    const resolver = createLearnedSeedResolver({
        getPlantBySeedId: id => Number(id) === 20002 ? staticPlant : null,
        getItemById: id => Number(id) === 20999
            ? { id: 20999, type: 5, name: '缓存活动花种子', interaction_type: 'plant', level: 1 }
            : null,
        learnSeedConfigFromQqCache: id => {
            learnerCalls++;
            if (Number(id) !== 20999) return null;
            return {
                seedId: 20999,
                plantSize: 1,
                rawSize: 0,
                name: '缓存活动花',
                requiredLevel: 1,
                evidence: 'qq-cache:same-object-seed_id+size',
                sourceFile: 'config.js',
            };
        },
    });

    assert.equal(resolver(20002), staticPlant);
    assert.equal(learnerCalls, 0, 'known static seed must not scan QQ cache');
    assert.equal(resolver(80001), null);
    assert.equal(learnerCalls, 0, 'non-seed item must not scan QQ cache');

    const learned = resolver(20999);
    assert.ok(learned);
    assert.equal(learned.seed_id, 20999);
    assert.equal(learned.name, '缓存活动花');
    assert.equal(learned.size, 1);
    assert.equal(learned.runtime_learned, true);
    assert.equal(learnerCalls, 1);
    console.log('✅ unknown seed can be promoted only after deterministic cache evidence PASS');

    const plantWrites = [];
    const eventService = createEventSeedPriorityService({
        getBag: async () => ({ item_bag: { items: [{ id: 20999, count: 1 }] } }),
        getBagItems: reply => reply.item_bag.items,
        getItemById: id => Number(id) === 20999
            ? { id: 20999, type: 5, name: '缓存活动花种子', interaction_type: 'plant', level: 1 }
            : null,
        getPlantBySeedId: resolver,
        getShopInfo: async () => ({ goods_list: [{ item_id: 20002 }] }),
        listActivityOverview: async () => ({ activities: [] }),
        getBagSeedPriority: () => [],
        getAllLands: async () => ({ lands: [{ id: 1, unlocked: true, plant: null }] }),
        plantSeeds: async (seedId, landIds, runOptions) => {
            plantWrites.push([seedId, [...landIds], runOptions.maxPlantCount]);
            return {
                planted: 1,
                plantedLandIds: [landIds[0]],
                occupiedLandIds: [landIds[0]],
            };
        },
        plant2x2Seed: async () => {
            throw new Error('2x2 should not run');
        },
        discoveryStateStore: { record: () => {} },
        log: () => {},
        logWarn: () => {},
        sleep: async () => {},
    });

    const result = await eventService.runBeforeShop({
        landIds: [1],
        state: { level: 113 },
        accountId: 'fixture',
    });
    assert.deepEqual(plantWrites, [[20999, [1], 1]]);
    assert.deepEqual(result.unresolvedSeedIds, []);
    assert.deepEqual(result.prioritySeedIds, [20999]);
    assert.equal(result.blockShopFallback, false);
    console.log('✅ learned 1x1 mapping flows into event-seed pre-shop priority path PASS');

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        realQqCacheTouched: false,
        networkTouched: false,
        shopWriteTouched: false,
        plantWriteTouched: false,
        fixturePlantCalls: plantWrites.length,
    }, null, 2));
}

main().catch(error => {
    console.error('\n❌ Learned Seed Resolver Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
