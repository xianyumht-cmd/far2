const assert = require('node:assert/strict');
const { buildCropRegistrySnapshotV2 } = require('../src/services/startup-crop-registry-v2');

function plant(seedId, fruitId = seedId + 20000) {
    return {
        id: 1000000 + seedId,
        name: `静态${seedId}`,
        seed_id: seedId,
        fruit: { id: fruitId, count: 5 },
        size: 0,
        seasons: 1,
        land_level_need: 1,
        grow_phases: '种子:30;成熟:0;',
        exp: 1,
    };
}

function illustrated(fruitId, tier = 1) {
    return { illustratedId: fruitId, fruitId, illustratedTier: tier, unlocked: true };
}

function runtimeEntry(candidateSeedId, seedId, fruitId, name, size) {
    return {
        ok: true,
        candidateSeedId,
        seedId,
        fruitId,
        illustratedTier: 4,
        plantId: 1000000 + seedId,
        name,
        rawSize: size === 1 ? null : 2,
        size,
        gridCount: size === 2 ? 4 : 1,
        levelNeed: 1,
        seasons: 1,
        growPhases: '种子:60;成熟:0;',
        exp: size === 2 ? 100 : 20,
        fruitCount: size === 2 ? 192 : 48,
        specialFruit: null,
        proofMode: candidateSeedId === seedId ? 'direct-seed' : 'fruit-fallback',
        mappingCorrected: candidateSeedId !== seedId,
        evidence: 'official-runtime-json-plant-object',
    };
}

function main() {
    console.log('FAR2 Startup Crop Registry Runtime Overlay Self-Test');
    console.log('安全: 纯 fixture；不读取本地 overlay、不联网、不发送 RPC。\n');

    const plants = [];
    const items = [];
    for (let i = 1; i <= 20; i += 1) {
        const seedId = 20000 + i;
        plants.push(plant(seedId));
        items.push(illustrated(seedId + 20000, 1));
    }
    items.push(illustrated(41037, 3));
    items.push(illustrated(49002, 4));

    const runtimePlantOverlay = {
        version: 1,
        calibration: { proven: true },
        entries: [
            runtimeEntry(21037, 21037, 41037, '银星海棠', 1),
            runtimeEntry(29002, 20416, 49002, '哈哈南瓜', 2),
        ],
        corrections: [{
            fruitId: 49002,
            previousCandidateSeedId: 29002,
            actualSeedId: 20416,
            name: '哈哈南瓜',
        }],
    };

    const snapshot = buildCropRegistrySnapshotV2({
        accountId: 'overlay-selftest',
        plants,
        runtimePlantOverlay,
        cropIllustrated: { items, summary: { total: items.length }, protocol: {} },
        mutationIllustrated: { items: [], summary: {}, protocol: {} },
        activityOverview: { discovery: { nodes: [] }, summary: {} },
        seedShopSnapshot: { profiles: { shops: [] }, shops: [], seedIds: [] },
        bagItems: [],
        components: { cropIllustrated: true, mutationIllustrated: true, activities: true, seedShops: true },
    });

    const ordinaryRuntime = snapshot.crops.find(row => row.fruitId === 41037);
    assert.ok(ordinaryRuntime);
    assert.equal(ordinaryRuntime.seedId, 21037);
    assert.equal(ordinaryRuntime.name, '银星海棠');
    assert.equal(ordinaryRuntime.size, 1);
    assert.equal(ordinaryRuntime.gridCount, 1);
    assert.equal(ordinaryRuntime.seedIdSource, 'runtime-plant-fruit-map');
    assert.equal(ordinaryRuntime.identityConfidence, 'proven-runtime-plant-map');
    assert.equal(ordinaryRuntime.footprintSource, 'runtime-plant-overlay');
    assert.equal(ordinaryRuntime.autoPlantReady, true);
    console.log('✅ runtime 1x1 overlay graduates identity + footprint PASS');

    const corrected = snapshot.crops.find(row => row.fruitId === 49002);
    assert.ok(corrected);
    assert.equal(corrected.seedId, 20416);
    assert.equal(corrected.name, '哈哈南瓜');
    assert.equal(corrected.size, 2);
    assert.equal(corrected.gridCount, 4);
    assert.equal(corrected.seedIdSource, 'runtime-plant-fruit-map');
    assert.equal(corrected.identityConfidence, 'proven-runtime-plant-map');
    assert.equal(corrected.autoPlantReady, true);
    assert.equal(snapshot.crops.some(row => row.fruitId === 49002 && row.seedId === 29002), false);
    console.log('✅ runtime fruit object corrects false +20000 candidate PASS');

    // Twenty static +20000 pairs plus one exact runtime +20000 pair and one
    // runtime exception are enough to prove the offset is common but NOT global.
    assert.equal(snapshot.mappingRule.validated, false);
    assert.equal(snapshot.mappingRule.dominantOffset, 20000);
    assert.equal(snapshot.mappingRule.matchedPairs, 22);
    assert.equal(snapshot.mappingRule.dominantCount, 21);
    assert.equal(snapshot.mappingRule.rule, 'unverified');
    console.log('✅ one proven exception disables global fruit-offset promotion PASS');

    assert.equal(snapshot.protocolEvidence.runtimePlantOverlay.loaded, true);
    assert.equal(snapshot.protocolEvidence.runtimePlantOverlay.entries, 2);
    assert.equal(snapshot.protocolEvidence.runtimePlantOverlay.corrections.length, 1);
    assert.equal(snapshot.liveIllustratedSummary.runtimeOverlaySeedIdentities, 2);
    console.log('✅ runtime overlay provenance is visible in Registry snapshot PASS');

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        mappingRule: snapshot.mappingRule,
        corrected: { fruitId: corrected.fruitId, seedId: corrected.seedId, size: corrected.size },
        networkTouched: false,
        rpcTouched: false,
        plantTouched: false,
    }, null, 2));
}

try {
    main();
} catch (error) {
    console.error(`\n❌ Startup Runtime Overlay Self-Test FAIL: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
}
