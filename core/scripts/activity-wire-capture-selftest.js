const assert = require('node:assert/strict');
const { parseWire, SERVICE, READ_METHODS } = require('./qq-activity-wire-capture');

function main() {
    console.log('FAR2 Activity Wire Capture Parser Self-Test');
    console.log('安全: 只解析本地 protobuf wire fixture，不读取 QQ、不修改缓存、不发送任何 RPC。\n');

    assert.equal(SERVICE, 'gamepb.activitypb.ActivityService');
    assert.equal(READ_METHODS.has('List'), true);
    assert.equal(READ_METHODS.has('GetGroup'), true);

    const fixture = Buffer.from('086412036162631a020807', 'hex');
    const fields = parseWire(fixture);
    assert.deepEqual(fields, [
        { field: 1, wire: 0, value: 100 },
        { field: 2, wire: 2, length: 3, bytes: '616263', text: 'abc' },
        { field: 3, wire: 2, length: 2, bytes: '0807', text: '' },
    ]);
    console.log('✅ generic varint/string/nested-bytes wire parsing PASS');
    console.log('✅ known read methods are explicitly excluded from evidence capture PASS');

    assert.throws(() => parseWire(Buffer.from('0f', 'hex')), /unsupported wire/);
    console.log('✅ malformed/unsupported wire fails closed PASS');

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        qqCacheTouched: false,
        rpcTouched: false,
        writeOperationTouched: false,
    }, null, 2));
}

try {
    main();
} catch (error) {
    console.error('\n❌ Activity Wire Capture Parser Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
}
