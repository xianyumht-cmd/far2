const assert = require('node:assert/strict');
const {
    calibrateRuntimeSizeEncoding,
    buildRuntimePlantOverlay,
    runtimeOverlayPlants,
} = require('../src/services/runtime-plant-overlay-evidence');

function plant(seedId, fruitId, name, size, extra = {}) {
    return {
        id: 1000000 + seedId,
        name,
        fruit: { id: fruitId, count: size === 2 ? 192 : 48 },
        seed_id: seedId,
        land_level_need: 1,
        seasons: 1,
        grow_phases: '种子:10;成熟:0;',
        exp: size === 2 ? 100 : 20,
        size,
        ...extra,
    };
}

function row(meta, snapshot, matchPath = 'seed_id') {
    return { source: 'JSON.parse', matchPath, snapshot, ...meta };
}

function reference(seedId, fruitId, name, expectedRawSize, observedSize) {
    return row({
        seedId,
        fruitId,
        kind: 'reference',
        markerKind: 'seed',
        expectedRawSize,
        referenceName: name,
    }, plant(seedId, fruitId, name, observedSize));
}

function target(seedId, fruitId, tier, snapshot, matchPath = 'seed_id', markerKind = 'seed') {
    return row({ seedId, fruitId, illustratedTier: tier, kind: 'target', markerKind }, snapshot, matchPath);
}

function fixture() {
    const references = [];
    const rawEvidence = [];
    for (let i = 0; i < 6; i += 1) {
        const seedId = 20001 + i;
        const fruitId = 40001 + i;
        const name = `普通${i}`;
        references.push({ seedId, fruitId, name, expectedRawSize: 0, kind: 'reference' });
        rawEvidence.push(reference(seedId, fruitId, name, 0, null));
    }
    for (let i = 0; i < 2; i += 1) {
        const seedId = 20501 + i;
        const fruitId = 40501 + i;
        const name = `多格${i}`;
        references.push({ seedId, fruitId, name, expectedRawSize: 2, kind: 'reference' });
        rawEvidence.push(reference(seedId, fruitId, name, 2, 2));
    }

    const targets = [
        { seedId: 21037, fruitId: 41037, illustratedTier: 3, kind: 'target' },
        { seedId: 29003, fruitId: 49003, illustratedTier: 4, kind: 'target' },
        { seedId: 29002, fruitId: 49002, illustratedTier: 4, kind: 'target' },
    ];
    rawEvidence.push(target(21037, 41037, 3, plant(21037, 41037, '银星海棠', null)));
    rawEvidence.push(target(29003, 49003, 4, plant(29003, 49003, '星语铃花', 2)));
    rawEvidence.push(target(29002, 49002, 4, plant(20416, 49002, '哈哈南瓜', 2), 'fruit.id', 'fruit'));

    // Numeric coincidence / unrelated object must not qualify as a Plant row.
    rawEvidence.push(target(21037, 41037, 3, { id: 21037, size: 2, name: 'fake' }, 'id'));

    return {
        generatedAt: '2026-08-14T18:01:44.425Z',
        targets,
        references,
        rawEvidence,
        safety: { readOnlyCapture: true, far2RpcSent: false, qqCacheRestored: true },
    };
}

function test(name, fn) {
    try {
        fn();
        console.log(`✅ ${name} PASS`);
    } catch (error) {
        console.error(`❌ ${name} FAIL`);
        throw error;
    }
}

function main() {
    console.log('FAR2 Runtime Plant Overlay Evidence Self-Test');
    console.log('安全: 只使用内存 fixture；不读取 QQ、不联网、不发送 RPC。\n');

    test('runtime size encoding calibrates null=1x1 and 2=2x2', () => {
        const calibration = calibrateRuntimeSizeEncoding(fixture());
        assert.equal(calibration.proven, true);
        assert.equal(calibration.oneByOne.references, 6);
        assert.equal(calibration.twoByTwo.references, 2);
    });

    test('direct Plant object resolves ordinary target as 1x1', () => {
        const overlay = buildRuntimePlantOverlay(fixture());
        const crop = overlay.entries.find(row => row.seedId === 21037);
        assert.equal(crop.name, '银星海棠');
        assert.equal(crop.size, 1);
        assert.equal(crop.gridCount, 1);
        assert.equal(crop.proofMode, 'direct-seed');
    });

    test('direct Plant object resolves multi-grid target as 2x2', () => {
        const overlay = buildRuntimePlantOverlay(fixture());
        const crop = overlay.entries.find(row => row.seedId === 29003);
        assert.equal(crop.name, '星语铃花');
        assert.equal(crop.size, 2);
        assert.equal(crop.gridCount, 4);
    });

    test('fruit fallback corrects invalid +20000 seed mapping', () => {
        const overlay = buildRuntimePlantOverlay(fixture());
        const crop = overlay.entries.find(row => row.fruitId === 49002);
        assert.equal(crop.candidateSeedId, 29002);
        assert.equal(crop.seedId, 20416);
        assert.equal(crop.name, '哈哈南瓜');
        assert.equal(crop.mappingCorrected, true);
        assert.deepEqual(overlay.corrections[0], {
            fruitId: 49002,
            previousCandidateSeedId: 29002,
            actualSeedId: 20416,
            name: '哈哈南瓜',
        });
    });

    test('numeric coincidence cannot become runtime Plant evidence', () => {
        const overlay = buildRuntimePlantOverlay(fixture());
        assert.equal(overlay.summary.resolved, 3);
        assert.equal(overlay.summary.unresolved, 0);
    });

    test('overlay converts to exact Plant records for startup Registry', () => {
        const overlay = buildRuntimePlantOverlay(fixture());
        const plants = runtimeOverlayPlants(overlay);
        const corrected = plants.find(row => row.fruit.id === 49002);
        assert.equal(corrected.seed_id, 20416);
        assert.equal(corrected.size, 2);
        assert.equal(corrected._runtimeOverlay, true);
    });

    test('calibration fails closed when known 1x1 observes size=2', () => {
        const bad = fixture();
        const row = bad.rawEvidence.find(entry => entry.kind === 'reference' && entry.expectedRawSize === 0);
        row.snapshot.size = 2;
        assert.equal(calibrateRuntimeSizeEncoding(bad).proven, false);
        assert.throws(() => buildRuntimePlantOverlay(bad));
    });

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        qqTouched: false,
        networkTouched: false,
        rpcTouched: false,
        plantTouched: false,
    }, null, 2));
}

try {
    main();
} catch (error) {
    console.error(`\n❌ Runtime Plant Overlay Evidence Self-Test FAIL: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
}
