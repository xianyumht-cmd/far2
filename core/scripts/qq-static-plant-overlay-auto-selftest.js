const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    listRegistryFiles,
    selectUnresolvedFootprintTargets,
    resolveTargets,
} = require('./qq-static-plant-overlay-auto-scan');

function main() {
    console.log('FAR2 Static Plant Overlay Auto Target Self-Test');
    console.log('安全: 只使用临时 registry fixture；不读取真实 QQ、不联网、不发送 RPC。\n');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'far2-overlay-targets-'));
    const registryDir = path.join(root, 'crop_registry');
    fs.mkdirSync(registryDir, { recursive: true });

    const older = path.join(registryDir, 'old.json');
    fs.writeFileSync(older, JSON.stringify({
        crops: [{ seedId: 29999, size: 0, identityConfidence: 'proven-live-illustrated-map' }],
    }), 'utf8');
    const oldTime = new Date(Date.now() - 60_000);
    fs.utimesSync(older, oldTime, oldTime);

    const latest = path.join(registryDir, '2.json');
    fs.writeFileSync(latest, JSON.stringify({
        crops: [
            { seedId: 21037, size: 0, identityConfidence: 'proven-live-illustrated-map' },
            { seedId: 21050, size: 0, identityConfidence: 'proven-live-illustrated-map' },
            { seedId: 21221, size: 0, identityConfidence: 'proven-live-illustrated-map' },
            { seedId: 20001, size: 1, identityConfidence: 'proven-static-plant-map' },
            { seedId: 20020, size: 2, identityConfidence: 'proven-static-plant-map' },
            { seedId: 0, size: 0, identityConfidence: 'unknown' },
        ],
    }), 'utf8');

    const files = listRegistryFiles(root);
    assert.equal(files[0].name, '2.json');
    console.log('✅ latest registry selection PASS');

    const snapshot = JSON.parse(fs.readFileSync(latest, 'utf8'));
    assert.deepEqual(selectUnresolvedFootprintTargets(snapshot), [21037, 21050, 21221]);
    console.log('✅ only identity-proven size=0 crops become targets PASS');

    const resolved = resolveTargets({ dataDir: root });
    assert.equal(resolved.source, 'latest-registry');
    assert.equal(resolved.registryFile, latest);
    assert.deepEqual(resolved.targets, [21037, 21050, 21221]);
    console.log('✅ auto target resolution uses latest Crop Registry PASS');

    const explicit = resolveTargets({ dataDir: root, targets: [29003, 29003, 26032] });
    assert.equal(explicit.source, 'explicit');
    assert.deepEqual(explicit.targets, [29003, 26032]);
    console.log('✅ explicit targets still override registry PASS');

    fs.rmSync(root, { recursive: true, force: true });

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        registryTouched: false,
        qqCacheTouched: false,
        networkTouched: false,
        rpcTouched: false,
        plantTouched: false,
    }, null, 2));
}

try { main(); }
catch (error) {
    console.error(`\n❌ Static Plant Overlay Auto Target Self-Test FAIL: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
}
