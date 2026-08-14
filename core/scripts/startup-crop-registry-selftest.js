const assert = require('node:assert/strict');
const {
    normalizeStaticPlant,
    buildCropRegistrySnapshotV2,
} = require('../src/services/startup-crop-registry-v2');

function makePlant(seedId, options = {}) {
    return {
        id: 1000000 + seedId,
        name: options.name || `作物${seedId}`,
        seed_id: seedId,
        fruit: { id: seedId + 20000, count: 5 },
        size: Object.prototype.hasOwnProperty.call(options, 'size') ? options.size : 0,
        seasons: 1,
        land_level_need: 1,
        grow_phases: '种子:30;成熟:0;',
        exp: 1,
    };
}

function makeIllustrated(fruitId, tier = 1) {
    return {
        illustratedId: fruitId,
        fruitId,
        seedId: 0,
        illustratedTier: tier,
        unlocked: true,
    };
}

function main() {
    console.log('FAR2 Startup Crop Registry V2 Self-Test');
    console.log('安全: 纯本地 fixture；不联网、不读取 QQ、不发送 RPC、不种植。\n');

    assert.equal(normalizeStaticPlant({ size: 0 }).size, 1, 'raw Plant.size=0 must normalize to 1x1');
    assert.equal(normalizeStaticPlant({ size: 2 }).size, 2, 'raw Plant.size=2 must stay 2x2');
    assert.equal(normalizeStaticPlant(null), null, 'missing plant must stay missing');
    console.log('✅ static Plant.size normalization PASS');

    // Twenty exact static fruit/seed pairs are enough to prove +20000 without
    // relying on namespace guesses. This mirrors the live evidence rule.
    const plants = [];
    const illustratedItems = [];
    for (let i = 1; i <= 20; i += 1) {
        const seedId = 20000 + i;
        plants.push(makePlant(seedId, { size: i === 20 ? 2 : 0 }));
        illustratedItems.push(makeIllustrated(seedId + 20000, 1));
    }

    const liveTargets = [
        [21037, 41037, 3],
        [21050, 41050, 3],
        [21221, 41221, 2],
        [21251, 41251, 2],
        [26032, 46032, 2],
        [29003, 49003, 4],
    ];
    for (const [, fruitId, tier] of liveTargets) illustratedItems.push(makeIllustrated(fruitId, tier));

    const snapshot = buildCropRegistrySnapshotV2({
        accountId: 'selftest',
        plants,
        cropIllustrated: {
            items: illustratedItems,
            summary: { total: illustratedItems.length },
            protocol: { service: 'IllustratedService', method: 'GetIllustratedListV2' },
        },
        mutationIllustrated: { items: [], summary: { total: 0 }, protocol: {} },
        activityOverview: {
            summary: { total: 1 },
            discovery: {
                nodes: [{
                    id: 2026081200,
                    title: 'fixture activity',
                    type: 12,
                    enabled: true,
                    activeByTime: true,
                    itemIds: [21037, 21050, 21221, 21251, 26032, 29003, 80001],
                    capabilities: ['fixture'],
                }],
                summary: {},
            },
        },
        seedShopSnapshot: { profiles: { shops: [] }, shops: [], seedIds: [20001, 20002] },
        bagItems: [
            { id: 21037, count: 28 },
            { id: 21050, count: 28 },
            { id: 21221, count: 59 },
            { id: 21251, count: 48 },
            { id: 26032, count: 36 },
            { id: 29003, count: 8 },
            { id: 80001, count: 3 },
        ],
        components: {
            cropIllustrated: true,
            mutationIllustrated: true,
            activities: true,
            seedShops: true,
        },
    });

    assert.equal(snapshot.version, 2);
    assert.equal(snapshot.mappingRule.validated, true);
    assert.equal(snapshot.mappingRule.dominantOffset, 20000);
    assert.equal(snapshot.mappingRule.matchedPairs, 20);
    console.log('✅ exact +20000 live mapping rule PASS');

    const ordinary = snapshot.crops.find(row => row.seedId === 20001);
    assert.ok(ordinary);
    assert.equal(ordinary.size, 1);
    assert.equal(ordinary.gridCount, 1);
    assert.equal(ordinary.footprintSource, 'static-plant-config');
    assert.equal(ordinary.autoPlantReady, true);
    console.log('✅ static ordinary crop size=0 becomes proven 1x1 PASS');

    const multi = snapshot.crops.find(row => row.seedId === 20020);
    assert.ok(multi);
    assert.equal(multi.size, 2);
    assert.equal(multi.gridCount, 4);
    assert.equal(multi.autoPlantReady, true);
    console.log('✅ static size=2 remains proven 2x2 PASS');

    for (const [seedId, fruitId, tier] of liveTargets) {
        const crop = snapshot.crops.find(row => row.seedId === seedId);
        assert.ok(crop, `missing live-derived crop ${seedId}`);
        assert.equal(crop.fruitId, fruitId);
        assert.equal(crop.illustratedTier, tier);
        assert.equal(crop.seedIdSource, 'validated-live-fruit-offset');
        assert.equal(crop.identityConfidence, 'proven-live-illustrated-map');
        assert.equal(crop.size, 0, `tier must not infer size for ${seedId}`);
        assert.equal(crop.gridCount, 0);
        assert.equal(crop.footprintSource, 'unknown');
        assert.equal(crop.autoPlantReady, false);
    }
    console.log('✅ six live illustrated seed identities proven while footprint stays unknown PASS');

    const fertilizer = snapshot.observedItems.find(row => row.itemId === 80001);
    assert.ok(fertilizer);
    assert.equal(fertilizer.matchedCropSeedId, 0);
    assert.equal(fertilizer.matchedCropFruitId, 0);
    console.log('✅ fertilizer remains outside crop identity PASS');

    const t1 = snapshot.tierStats.find(row => row.tier === 1);
    const t2 = snapshot.tierStats.find(row => row.tier === 2);
    const t3 = snapshot.tierStats.find(row => row.tier === 3);
    const t4 = snapshot.tierStats.find(row => row.tier === 4);
    assert.equal(t1.total, 20);
    assert.equal(t2.total, 3);
    assert.equal(t3.total, 2);
    assert.equal(t4.total, 1);
    assert.equal(t2.sizeUnknown, 3);
    assert.equal(t3.sizeUnknown, 2);
    assert.equal(t4.sizeUnknown, 1);
    assert.equal(snapshot.safety.tierNeverPromotesFootprint, true);
    console.log('✅ tier stats preserve classification without guessing footprint PASS');

    assert.equal(snapshot.readiness.fullReadComplete, true);
    assert.equal(snapshot.readiness.cropInferenceReady, true);

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        version: snapshot.version,
        mappingRule: snapshot.mappingRule.rule,
        liveTargets: liveTargets.map(([seedId, fruitId, tier]) => ({ seedId, fruitId, tier })),
        networkTouched: false,
        rpcTouched: false,
        plantTouched: false,
    }, null, 2));
}

try {
    main();
} catch (error) {
    console.error(`\n❌ Startup Crop Registry V2 Self-Test FAIL: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
}
