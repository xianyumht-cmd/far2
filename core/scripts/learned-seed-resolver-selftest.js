const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    createLearnedSeedResolver,
    shouldTryRuntimeLearning,
} = require('../src/services/learned-seed-resolver');
const {
    createRuntimeCropRegistryReader,
    buildRegistryPlantIndex,
} = require('../src/services/runtime-crop-registry-resolver');
const { buildBagSeedsFromItems } = require('../src/services/registry-aware-bag-seeds');
const { createEventSeedPriorityService } = require('../src/services/event-seed-priority');

function makeRegistryCrop(seedId, fruitId, name, size, overrides = {}) {
    return {
        seedId,
        fruitId,
        plantId: 0,
        name,
        seedName: `${name}种子`,
        size,
        gridCount: size * size,
        levelNeed: 1,
        seasons: 1,
        growPhases: '',
        exp: size === 2 ? 7680 : 1680,
        autoPlantReady: true,
        identityConfidence: 'proven-runtime-plant-map',
        footprintConfidence: 'proven-config',
        footprintSource: 'runtime-plant-overlay',
        ...overrides,
    };
}

async function main() {
    console.log('FAR2 Learned / Registry Seed Resolver Self-Test');
    console.log('安全: 只使用临时 Registry/fixture，不读取真实 QQ 缓存、不连接网络、不发送真实 Plant/Shop RPC。\n');

    assert.equal(shouldTryRuntimeLearning(80001, { type: 2, name: '化肥' }), false);
    assert.equal(shouldTryRuntimeLearning(20999, null), true);
    assert.equal(shouldTryRuntimeLearning(50001, { type: 5, name: '活动种子' }), true);
    console.log('✅ runtime learning is restricted to seed-like candidates PASS');

    let learnerCalls = 0;
    const staticPlant = { seed_id: 20002, name: '白萝卜', size: 0, land_level_need: 1 };
    const resolver = createLearnedSeedResolver({
        getPlantBySeedId: id => Number(id) === 20002 ? staticPlant : null,
        getRegistryPlantBySeedId: () => null,
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

    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'far2-registry-seed-'));
    try {
        const registryDir = path.join(tempData, 'crop_registry');
        fs.mkdirSync(registryDir, { recursive: true });
        const snapshot = {
            version: 2,
            accountId: 'fixture',
            readiness: { fullReadComplete: true },
            crops: [
                makeRegistryCrop(21037, 41037, '银星海棠', 1),
                makeRegistryCrop(29003, 49003, '星语铃花', 2),
                makeRegistryCrop(21221, 41221, '青梅', 1, {
                    autoPlantReady: false,
                    footprintConfidence: 'unknown',
                    footprintSource: 'unknown',
                }),
                makeRegistryCrop(29002, 49002, '错误候选', 2, {
                    identityConfidence: 'unknown',
                }),
            ],
        };
        fs.writeFileSync(path.join(registryDir, 'fixture.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

        const pureIndex = buildRegistryPlantIndex(snapshot);
        assert.equal(pureIndex.size, 2);
        assert.equal(pureIndex.get(21037).size, 1);
        assert.equal(pureIndex.get(29003).size, 2);
        assert.equal(pureIndex.has(21221), false);
        assert.equal(pureIndex.has(29002), false);
        console.log('✅ Registry exposes only exact proven autoPlantReady crops PASS');

        const registryReader = createRuntimeCropRegistryReader({
            getDataDir: () => tempData,
            getAccountId: () => 'fixture',
        });
        const silver = registryReader(21037);
        const star = registryReader(29003);
        assert.ok(silver && star);
        assert.equal(silver.name, '银星海棠');
        assert.equal(silver.size, 1);
        assert.equal(silver.runtime_registry, true);
        assert.equal(star.name, '星语铃花');
        assert.equal(star.size, 2);
        assert.equal(registryReader(21221), null);
        assert.equal(registryReader(29002), null);
        console.log('✅ account-scoped persisted Registry resolves proven 1x1/2x2 Plant records PASS');

        let registryLearnerCalls = 0;
        const registryResolver = createLearnedSeedResolver({
            getPlantBySeedId: () => null,
            getRegistryPlantBySeedId: registryReader,
            getItemById: () => null,
            learnSeedConfigFromQqCache: () => {
                registryLearnerCalls++;
                throw new Error('Registry-proven seed must not fall through to QQ cache learning');
            },
        });
        assert.equal(registryResolver(21037).name, '银星海棠');
        assert.equal(registryResolver(29003).size, 2);
        assert.equal(registryLearnerCalls, 0);
        console.log('✅ proven Registry Plant wins before QQ cache learning PASS');

        const registryBagSeeds = buildBagSeedsFromItems([
            { id: 21037, count: 2 },
            { id: 29003, count: 1 },
            { id: 80001, count: 99 },
        ], {
            getPlantBySeedId: registryResolver,
            getSeedImageBySeedId: () => '',
            getItemImageById: () => '',
        });
        assert.deepEqual(registryBagSeeds.map(row => [row.seedId, row.count, row.plantSize, row.runtimeRegistry]), [
            [21037, 2, 1, true],
            [29003, 1, 2, true],
        ]);
        console.log('✅ bag-priority reader includes Registry activity seeds and excludes non-seeds PASS');

        const oneByOneWrites = [];
        const oneByOneService = createEventSeedPriorityService({
            getBag: async () => ({ item_bag: { items: [{ id: 21037, count: 1 }] } }),
            getBagItems: reply => reply.item_bag.items,
            getItemById: () => null,
            getPlantBySeedId: registryResolver,
            getShopInfo: async () => ({ goods_list: [{ item_id: 20002 }] }),
            listActivityOverview: async () => ({ activities: [] }),
            getBagSeedPriority: () => [],
            getAllLands: async () => ({ lands: [{ id: 1, unlocked: true, plant: null }] }),
            plantSeeds: async (seedId, landIds, runOptions) => {
                oneByOneWrites.push([seedId, [...landIds], runOptions.maxPlantCount]);
                return {
                    planted: 1,
                    plantedLandIds: [landIds[0]],
                    occupiedLandIds: [landIds[0]],
                };
            },
            plant2x2Seed: async () => {
                throw new Error('1x1 Registry seed must not use 2x2 path');
            },
            discoveryStateStore: { record: () => {} },
            log: () => {},
            logWarn: () => {},
            sleep: async () => {},
        });

        const oneByOneResult = await oneByOneService.runBeforeShop({
            landIds: [1],
            state: { level: 113 },
            accountId: 'fixture',
        });
        assert.deepEqual(oneByOneWrites, [[21037, [1], 1]]);
        assert.deepEqual(oneByOneResult.unresolvedSeedIds, []);
        assert.deepEqual(oneByOneResult.prioritySeedIds, [21037]);
        assert.equal(oneByOneResult.blockShopFallback, false);
        console.log('✅ Registry-proven 1x1 activity seed flows into existing Plant path PASS');

        const twoByTwoWrites = [];
        const twoByTwoService = createEventSeedPriorityService({
            getBag: async () => ({ item_bag: { items: [{ id: 29003, count: 1 }] } }),
            getBagItems: reply => reply.item_bag.items,
            getItemById: () => null,
            getPlantBySeedId: registryResolver,
            getShopInfo: async () => ({ goods_list: [{ item_id: 20002 }] }),
            listActivityOverview: async () => ({ activities: [] }),
            getBagSeedPriority: () => [],
            getAllLands: async () => ({ lands: [
                { id: 1, unlocked: true, plant: null },
                { id: 2, unlocked: true, plant: null },
                { id: 7, unlocked: true, plant: null },
                { id: 8, unlocked: true, plant: null },
            ] }),
            selectReady2x2Groups: () => [{ masterLandId: 1, landIds: [1, 2, 7, 8] }],
            plantSeeds: async () => {
                throw new Error('2x2 Registry seed must not use 1x1 path');
            },
            plant2x2Seed: async (seedId, group) => {
                twoByTwoWrites.push([seedId, [...group.landIds]]);
                return {
                    masterLandId: group.masterLandId,
                    occupiedLandIds: [...group.landIds],
                };
            },
            discoveryStateStore: { record: () => {} },
            log: () => {},
            logWarn: () => {},
            sleep: async () => {},
        });

        const twoByTwoResult = await twoByTwoService.runBeforeShop({
            landIds: [1, 2, 7, 8],
            state: { level: 113 },
            accountId: 'fixture',
        });
        assert.deepEqual(twoByTwoWrites, [[29003, [1, 2, 7, 8]]]);
        assert.deepEqual(twoByTwoResult.unresolvedSeedIds, []);
        assert.deepEqual(twoByTwoResult.prioritySeedIds, [29003]);
        assert.equal(twoByTwoResult.totalPlanted, 1);
        assert.equal(twoByTwoResult.occupiedCount, 4);
        assert.equal(twoByTwoResult.blockShopFallback, false);
        console.log('✅ Registry-proven 2x2 activity seed flows into existing safe 2x2 Plant path PASS');
    } finally {
        fs.rmSync(tempData, { recursive: true, force: true });
    }

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        realQqCacheTouched: false,
        realRegistryTouched: false,
        networkTouched: false,
        shopWriteTouched: false,
        plantWriteTouched: false,
        fixturePlantCalls: 2,
    }, null, 2));
}

main().catch(error => {
    console.error('\n❌ Learned / Registry Seed Resolver Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
