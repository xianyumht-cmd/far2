const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    SENSITIVE_KEY_RE,
    loadUnknownTargets,
    chooseReferences,
    buildMarkerTable,
    buildPayload,
    analyzeRows,
    restorePatchedFiles,
} = require('./qq-runtime-plant-overlay-capture');

function test(name, fn) {
    try {
        fn();
        console.log(`✅ ${name} PASS`);
    } catch (error) {
        console.error(`❌ ${name} FAIL`);
        throw error;
    }
}

function ref(seedId, rawSize, name) {
    return {
        t: new Date().toISOString(),
        source: 'fixture',
        seedId,
        fruitId: seedId + 20000,
        kind: 'reference',
        markerKind: 'seed',
        expectedRawSize: rawSize,
        referenceName: name,
        matchPath: 'seedField',
        snapshot: {
            seedField: seedId,
            sizeField: rawSize,
            nameField: name,
            unrelatedZero: 0,
            unrelatedClass: seedId % 3,
            level: 50 + (seedId % 9),
            fruit: { id: seedId + 20000, count: 5 },
        },
    };
}

function target(seedId, rawSize, name) {
    return {
        t: new Date().toISOString(),
        source: 'fixture-target',
        seedId,
        fruitId: seedId + 20000,
        kind: 'target',
        markerKind: 'seed',
        expectedRawSize: undefined,
        referenceName: '',
        matchPath: 'seedField',
        snapshot: {
            seedField: seedId,
            sizeField: rawSize,
            nameField: name,
            unrelatedZero: 0,
            fruit: { id: seedId + 20000, count: 1 },
        },
    };
}

function main() {
    console.log('FAR2 Runtime Plant Overlay Self-Test');
    console.log('安全: 只使用临时 registry / fixture；不读取真实 QQ、不联网、不发送 RPC。\n');

    test('registry target selection keeps only identity-proven size=0 crops', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'far2-runtime-overlay-registry-'));
        const file = path.join(dir, '2.json');
        fs.writeFileSync(file, JSON.stringify({
            crops: [
                { seedId: 21037, fruitId: 41037, size: 0, illustratedTier: 3, identityConfidence: 'proven-live-illustrated-map' },
                { seedId: 21050, fruitId: 41050, size: 1, illustratedTier: 3, identityConfidence: 'proven-static' },
                { seedId: 21221, fruitId: 41221, size: 0, illustratedTier: 2, identityConfidence: 'medium-namespace' },
                { seedId: 21251, fruitId: 41251, size: 0, illustratedTier: 2, identityConfidence: 'proven-live-illustrated-map' },
            ],
        }), 'utf8');
        const selected = loadUnknownTargets(file);
        assert.deepEqual(selected.targets.map(row => row.seedId), [21037, 21251]);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('reference selection contains both known 1x1 and known 2x2 classes', () => {
        const plants = [];
        for (let i = 0; i < 8; i++) plants.push({ seed_id: 20000 + i, fruit: { id: 40000 + i }, name: `one-${i}`, size: 0 });
        for (let i = 0; i < 4; i++) plants.push({ seed_id: 20100 + i, fruit: { id: 40100 + i }, name: `two-${i}`, size: 2 });
        const refs = chooseReferences(plants, 8);
        assert.equal(refs.filter(row => row.expectedRawSize === 0).length, 8);
        assert.equal(refs.filter(row => row.expectedRawSize === 2).length, 4);
    });

    test('payload hooks decoded objects and masks sensitive fields without sending RPC', () => {
        const markers = buildMarkerTable(
            [{ seedId: 21037, fruitId: 41037, kind: 'target' }],
            [{ seedId: 20002, fruitId: 40002, name: '白萝卜', expectedRawSize: 0, kind: 'reference' }],
        );
        const payload = buildPayload(markers);
        assert.ok(payload.includes('JSON.parse=function'));
        assert.ok(payload.includes('cc.assetManager.loadAny'));
        assert.ok(payload.includes('cc.resources.load'));
        assert.ok(payload.includes('sensitiveKeys') === false);
        assert.equal(/WebSocket\.prototype|\.send\(/.test(payload), false);
        assert.equal(/PlantService|ShopService|ActivityService/.test(payload), false);
        assert.equal(SENSITIVE_KEY_RE.test('access_token'), true);
        assert.equal(SENSITIVE_KEY_RE.test('sessionTicket'), true);
    });

    test('known references infer seed/size/name fields before target footprint promotion', () => {
        const rows = [];
        for (let i = 0; i < 8; i++) rows.push(ref(20010 + i, 0, `one-${i}`));
        for (let i = 0; i < 5; i++) rows.push(ref(20110 + i, 2, `two-${i}`));
        rows.push(target(21037, 2, 'target-multi'));
        rows.push(target(21050, 0, 'target-one'));

        const analysis = analyzeRows(rows, [
            { seedId: 21037, fruitId: 41037, illustratedTier: 3 },
            { seedId: 21050, fruitId: 41050, illustratedTier: 3 },
        ]);
        assert.equal(analysis.fieldMap.seedField.proven, true);
        assert.equal(analysis.fieldMap.seedField.key, 'seedField');
        assert.equal(analysis.fieldMap.sizeField.proven, true);
        assert.equal(analysis.fieldMap.sizeField.key, 'sizeField');
        assert.equal(analysis.fieldMap.nameField.proven, true);
        assert.equal(analysis.fieldMap.nameField.key, 'nameField');

        const a = analysis.resolved.find(row => row.seedId === 21037);
        const b = analysis.resolved.find(row => row.seedId === 21050);
        assert.equal(a.footprintProven, true);
        assert.equal(a.plantSize, 2);
        assert.equal(a.gridCount, 4);
        assert.equal(a.name, 'target-multi');
        assert.equal(b.footprintProven, true);
        assert.equal(b.plantSize, 1);
        assert.equal(b.gridCount, 1);
    });

    test('conflicting runtime size observations fail closed', () => {
        const rows = [];
        for (let i = 0; i < 8; i++) rows.push(ref(20030 + i, 0, `one-${i}`));
        for (let i = 0; i < 4; i++) rows.push(ref(20130 + i, 2, `two-${i}`));
        rows.push(target(21221, 0, 'x'));
        rows.push(target(21221, 2, 'x'));
        const analysis = analyzeRows(rows, [{ seedId: 21221, fruitId: 41221, illustratedTier: 2 }]);
        const row = analysis.resolved[0];
        assert.equal(row.conflict, true);
        assert.equal(row.footprintProven, false);
        assert.equal(row.plantSize, 0);
    });

    test('restore writes exact original bytes and validates hash path', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'far2-runtime-overlay-restore-'));
        const gameJs = path.join(dir, 'game.js');
        const backup = `${gameJs}.bak`;
        const original = Buffer.from('original\r\nbytes\n\u0000tail', 'utf8');
        fs.writeFileSync(gameJs, Buffer.from('patched'));
        fs.writeFileSync(backup, original);
        const hash = require('node:crypto').createHash('sha256').update(original).digest('hex');
        const failures = restorePatchedFiles([{ gameJs, backup, original, originalSha256: hash }]);
        assert.deepEqual(failures, []);
        assert.deepEqual(fs.readFileSync(gameJs), original);
        assert.equal(fs.existsSync(backup), false);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        realQqCacheTouched: false,
        networkTouched: false,
        rpcTouched: false,
        writeOperationTouched: false,
    }, null, 2));
}

try { main(); }
catch (error) {
    console.error(`\n❌ Runtime Plant Overlay Self-Test FAIL: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
}
