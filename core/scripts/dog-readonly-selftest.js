const assert = require('node:assert/strict');
const protobuf = require('protobufjs');
const { loadProto, types } = require('../src/utils/proto');
const { extractTopLevelVarint, normalizeDogInfoReply } = require('../src/services/dog');

async function main() {
    console.log('FAR2 Guard Dog Read-Only Self-Test');
    console.log('安全: 只编码/解析本地 protobuf fixture，不连接 QQ、不调用 DogService、不执行领取。\n');

    await loadProto();
    assert.ok(types.GetDogInfoReply, 'GetDogInfoReply should be loaded');

    const base = types.GetDogInfoReply.encode(types.GetDogInfoReply.create({
        dogs: [
            { id: 101, expire_time: 2000000000, status: 2, level: 6, active: 1 },
        ],
        coin: 345,
        protect_time: 1999999999,
        foods: [
            { id: 9001, duration: 3600, count: 3 },
        ],
    })).finish();

    const field7 = protobuf.Writer.create().uint32((7 << 3) | 0).uint64(66).finish();
    const raw = Buffer.concat([Buffer.from(base), Buffer.from(field7)]);
    const decoded = types.GetDogInfoReply.decode(raw);
    const overview = normalizeDogInfoReply(decoded, raw);

    assert.equal(extractTopLevelVarint(raw, 7), 66);
    assert.equal(overview.dogs.length, 1);
    assert.deepEqual(overview.dogs[0], {
        id: 101,
        expireTime: 2000000000,
        status: 2,
        level: 6,
        active: 1,
    });
    assert.deepEqual(overview.foods[0], { id: 9001, duration: 3600, count: 3 });
    assert.equal(overview.coin, 345);
    assert.equal(overview.protectTime, 1999999999);
    assert.equal(overview.claimableGiftCount, 66);
    assert.equal(overview.protocol.readOnly, true);
    assert.equal(overview.protocol.method, 'GetDogInfo');

    const noUnknown = types.GetDogInfoReply.encode(types.GetDogInfoReply.create({ dogs: [] })).finish();
    assert.equal(extractTopLevelVarint(noUnknown, 7), null);

    console.log('✅ dogpb loads PASS');
    console.log('✅ GetDogInfo known fields normalize PASS');
    console.log('✅ unknown top-level field 7 claimable count is preserved PASS');
    console.log('✅ no write/claim method touched PASS');
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        overview,
        realQqTouched: false,
        dogServiceTouched: false,
        claimSkillGiftsTouched: false,
        writeOperationTouched: false,
    }, null, 2));
}

main().catch((error) => {
    console.error('\n❌ Guard Dog Read-Only Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
