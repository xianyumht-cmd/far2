const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { scanFarmCache } = require('./qq-static-plant-overlay-scan');

function write(root, rel, data) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    return target;
}

function main() {
    console.log('FAR2 QQ Static Plant Overlay Self-Test');
    console.log('安全: 只使用临时 fixture；不读取真实 QQ、不联网、不发送 RPC。\n');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'far2-static-overlay-test-'));
    const folder = path.join(root, '1112386029_3_fixture');
    fs.mkdirSync(folder, { recursive: true });

    write(folder, 'assets/no-extension-resource', 'const rows=[{seed_id:21037,size:2,name:"多格测试",land_level_need:88}];');
    write(folder, 'assets/plain.bin', Buffer.from('{"seed_id":21050,"size":0,"name":"普通测试"}', 'utf8'));
    write(folder, 'assets/utf16.bytes', Buffer.from('{"seed_id":21221,"size":2,"name":"UTF16测试"}', 'utf16le'));
    write(folder, 'assets/gzip.dat', zlib.gzipSync(Buffer.from('{"seed_id":21251,"size":0,"name":"GZIP测试"}', 'utf8')));
    write(folder, 'assets/coincidence.bin', Buffer.from('random 26032 random 46032 but no seed_id or size relationship', 'utf8'));

    const report = scanFarmCache({
        miniAppRoot: root,
        targets: [21037, 21050, 21221, 21251, 26032],
        maxFolders: 1,
        maxFiles: 100,
        maxTotalBytes: 10 * 1024 * 1024,
    });

    assert.equal(report.summary.folders, 1);
    assert.equal(report.safety.qqCacheModified, false);
    assert.equal(report.safety.networkTouched, false);
    console.log('✅ full-cache read-only traversal PASS');

    const byId = new Map(report.entries.map(row => [row.seedId, row]));
    assert.equal(byId.get(21037).proven, true);
    assert.equal(byId.get(21037).plantSize, 2);
    assert.equal(byId.get(21037).rawSize, 2);
    console.log('✅ extensionless direct seed_id+size proof PASS');

    assert.equal(byId.get(21050).proven, true);
    assert.equal(byId.get(21050).plantSize, 1);
    assert.equal(byId.get(21050).rawSize, 0);
    console.log('✅ .bin UTF-8 ordinary size=0 proof PASS');

    assert.equal(byId.get(21221).proven, true);
    assert.equal(byId.get(21221).plantSize, 2);
    assert.ok(byId.get(21221).proofLayers.some(value => value.includes('utf16le')));
    console.log('✅ UTF-16LE resource proof PASS');

    assert.equal(byId.get(21251).proven, true);
    assert.equal(byId.get(21251).plantSize, 1);
    assert.ok(byId.get(21251).proofLayers.some(value => value.startsWith('gzip/')));
    console.log('✅ gzip resource proof PASS');

    assert.equal(byId.get(26032).proven, false);
    assert.equal(byId.get(26032).reason, 'no-direct-proof');
    console.log('✅ numeric coincidence cannot promote footprint PASS');

    assert.ok(report.extensionStats.some(row => row.extension === '<noext>'));
    assert.ok(report.extensionStats.some(row => row.extension === '.bin'));
    assert.ok(report.extensionStats.some(row => row.extension === '.bytes'));
    assert.ok(report.extensionStats.some(row => row.extension === '.dat'));
    console.log('✅ extension inventory covers previously skipped resource types PASS');

    fs.rmSync(root, { recursive: true, force: true });

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        proven: report.entries.filter(row => row.proven).map(row => ({ seedId: row.seedId, plantSize: row.plantSize })),
        qqCacheTouched: false,
        networkTouched: false,
        rpcTouched: false,
        plantTouched: false,
    }, null, 2));
}

try { main(); }
catch (error) {
    console.error(`\n❌ Static Plant Overlay Self-Test FAIL: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
}