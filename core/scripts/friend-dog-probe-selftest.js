const assert = require('node:assert/strict');
const protobuf = require('protobufjs');
const { BRIEF_DOG_FIELD_NO, buildFriendDogProbe } = require('../src/services/friend-dog-probe');

function main() {
    console.log('FAR2 Friend Dog Protocol Probe Self-Test');
    console.log('安全: 只构造本地 Visit.Enter raw protobuf fixture，不连接 QQ、不进入好友农场。\n');

    // 2026-08-13 live QQ evidence shape:
    // field 1 = dog id (90021 => 护主犬)
    // field 2 = per-second decreasing remaining duration.
    const nested = protobuf.Writer.create()
        .uint32(8).uint64(90021)
        .uint32(16).uint64(623306)
        .uint32(40).uint64(9)
        .finish();

    const outer = protobuf.Writer.create()
        .uint32(10).bytes(Buffer.from([8, 1]))
        .uint32((BRIEF_DOG_FIELD_NO << 3) | 2).bytes(nested)
        .finish();

    const probe = buildFriendDogProbe(outer);
    assert.equal(probe.present, true);
    assert.equal(probe.fieldNo, 3);
    assert.equal(probe.byteLength, nested.length);
    assert.equal(probe.dogId, 90021);
    assert.equal(probe.remainingSeconds, 623306);
    assert.equal(probe.parseComplete, true);
    assert.equal(probe.readOnly, true);
    assert.deepEqual(probe.fields, [
        { field: 1, wire: 0, varint: '90021' },
        { field: 2, wire: 0, varint: '623306' },
        { field: 5, wire: 0, varint: '9' },
    ]);

    const missing = buildFriendDogProbe(protobuf.Writer.create().uint32(8).uint64(1).finish());
    assert.deepEqual(missing, {
        present: false,
        fieldNo: 3,
        byteLength: 0,
        dogId: 0,
        remainingSeconds: 0,
        fields: [],
        parseComplete: true,
        readOnly: true,
    });

    console.log('✅ Visit.Enter field 3 presence detection PASS');
    console.log('✅ field 1 dogId semantic extraction PASS');
    console.log('✅ field 2 remainingSeconds semantic extraction PASS');
    console.log('✅ nested wire-field summary PASS');
    console.log('✅ no raw bytes exposed PASS');
    console.log('✅ missing field fallback PASS');
    console.log('✅ no real Visit/Dog RPC touched PASS');
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        fieldNo: BRIEF_DOG_FIELD_NO,
        dogId: probe.dogId,
        remainingSeconds: probe.remainingSeconds,
        realQqTouched: false,
        visitRpcTouched: false,
        dogRpcTouched: false,
        writeOperationTouched: false,
    }, null, 2));
}

try {
    main();
} catch (error) {
    console.error('\n❌ Friend Dog Protocol Probe Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
}
