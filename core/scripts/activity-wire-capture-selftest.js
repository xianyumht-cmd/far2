const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    SERVICE,
    READ_METHODS,
    MARKER,
    buildPayload,
    restoreGameFiles,
    parseWire,
} = require('./qq-activity-wire-capture');

function main() {
    console.log('FAR2 Activity Wire Capture Parser / Restore Self-Test');
    console.log('安全: 只解析本地 wire fixture + 临时目录文件，不读取真实 QQ、不发送 RPC。\n');

    assert.equal(SERVICE, 'gamepb.activitypb.ActivityService');
    assert.equal(READ_METHODS.has('List'), true);
    assert.equal(READ_METHODS.has('GetGroup'), true);

    const payload = buildPayload();
    assert.equal(payload.includes(MARKER), true);
    assert.equal(payload.includes('READ={List:1,GetGroup:1}'), true);
    assert.equal(payload.includes(SERVICE), true);
    console.log('✅ capture payload filters exact ActivityService and excludes List/GetGroup PASS');

    const fixture = Buffer.from('086412036162631a020807', 'hex');
    const fields = parseWire(fixture);
    assert.deepEqual(fields, [
        { field: 1, wire: 0, value: 100 },
        { field: 2, wire: 2, length: 3, bytes: '616263', text: 'abc' },
        { field: 3, wire: 2, length: 2, bytes: '0807', text: '' },
    ]);
    console.log('✅ generic varint/string/nested-bytes wire parsing PASS');

    assert.throws(() => parseWire(Buffer.from('0f', 'hex')), /unsupported wire/);
    console.log('✅ malformed/unsupported wire fails closed PASS');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'far2-activity-wire-selftest-'));
    const gameJs = path.join(dir, 'game.js');
    const backup = `${gameJs}.far2-activity-wire.bak`;
    const original = 'console.log("original");\n';
    fs.writeFileSync(gameJs, `${MARKER}\npatched`, 'utf8');
    fs.writeFileSync(backup, original, 'utf8');

    const failures = restoreGameFiles([{ gameJs, original, backup }]);
    assert.deepEqual(failures, []);
    assert.equal(fs.readFileSync(gameJs, 'utf8'), original);
    assert.equal(fs.existsSync(backup), false);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('✅ cache restore writes original bytes and removes backup PASS');

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        qqCacheTouched: false,
        tempFileRestoreTested: true,
        rpcTouched: false,
        writeOperationTouched: false,
    }, null, 2));
}

try {
    main();
} catch (error) {
    console.error('\n❌ Activity Wire Capture Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
}
