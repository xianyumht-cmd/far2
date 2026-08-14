const assert = require('node:assert/strict');
const protobuf = require('protobufjs');
const { loadProto, types } = require('../src/utils/proto');
const {
    extractTopLevelVarint,
    normalizeDogInfoReply,
    requireFeedableDogFood,
    buildAddFoodRequestBody,
    buildFeedVerification,
    feedDogFoodOnce,
    resetDogFeedLockForTest,
} = require('../src/services/dog');

async function main() {
    console.log('FAR2 Guard Dog / P7E Feed Safety Self-Test');
    console.log('安全: 只使用本地 protobuf fixture 和 fake sender，不连接 QQ、不消耗狗粮。\n');

    await loadProto();
    assert.ok(types.GetDogInfoReply, 'GetDogInfoReply should be loaded');

    const base = types.GetDogInfoReply.encode(types.GetDogInfoReply.create({
        dogs: [{ id: 101, expire_time: 2000000000, status: 2, level: 6, active: 1 }],
        coin: 345,
        protect_time: 1999999999,
        foods: [{ id: 90004, duration: 86400, count: 3 }],
    })).finish();
    const field7 = protobuf.Writer.create().uint32((7 << 3) | 0).uint64(66).finish();
    const raw = Buffer.concat([Buffer.from(base), Buffer.from(field7)]);
    const overview = normalizeDogInfoReply(types.GetDogInfoReply.decode(raw), raw);

    assert.equal(extractTopLevelVarint(raw, 7), 66);
    assert.equal(overview.foods[0].id, 90004);
    assert.equal(overview.foods[0].name, '1天狗粮');
    assert.equal(overview.foods[0].itemType, 9);
    assert.equal(overview.foods[0].recognizedDogFood, true);
    assert.equal(overview.foods[0].writeSupported, true);
    assert.equal(overview.protocol.foodWriteSupported, true);
    assert.equal(overview.protocol.foodWriteRequest.field2Semantics, 'unproven');
    assert.equal(overview.protocol.foodWriteRequest.fixedObservedValue, 1);

    const encoded = buildAddFoodRequestBody(90004);
    assert.equal(encoded.toString('hex'), '0894bf051001');

    assert.equal(requireFeedableDogFood(overview, 90004).count, 3);
    assert.throws(
        () => requireFeedableDogFood({ foods: [{ id: 90004, count: 0, itemType: 9, recognizedDogFood: true }] }, 90004),
        /库存不足/,
    );
    assert.throws(
        () => requireFeedableDogFood({ foods: [{ id: 99999, count: 1, itemType: 9, recognizedDogFood: true }] }, 99999),
        /白名单/,
    );

    const verification = buildFeedVerification(
        { protectTime: 100, foods: [{ id: 90004, count: 3 }] },
        { protectTime: 200, foods: [{ id: 90004, count: 2 }] },
        90004,
    );
    assert.equal(verification.verified, true);
    assert.equal(verification.consumed, 1);

    let readCount = 0;
    let sendCount = 0;
    resetDogFeedLockForTest();
    const fakeAfter = {
        ...overview,
        protectTime: overview.protectTime + 86400,
        foods: overview.foods.map(food => food.id === 90004 ? { ...food, count: 2 } : food),
    };
    const result = await feedDogFoodOnce(90004, {
        getDogInfoOverview: async () => (++readCount === 1 ? overview : fakeAfter),
        sendMsgAsync: async (service, method, body) => {
            sendCount += 1;
            assert.equal(service, 'gamepb.dogpb.DogService');
            assert.equal(method, 'AddFood');
            assert.equal(Buffer.from(body).toString('hex'), '0894bf051001');
            return { body: Buffer.alloc(0), meta: {} };
        },
        sleep: async () => {},
    });

    assert.equal(sendCount, 1);
    assert.equal(result.manualOnly, true);
    assert.equal(result.requestedUnits, 1);
    assert.equal(result.requestEvidence.field2ObservedValue, 1);
    assert.equal(result.requestEvidence.field2Semantics, 'unproven');
    assert.equal(result.verification.verified, true);
    assert.equal(result.verification.consumed, 1);

    console.log('✅ GetDogInfo normalization PASS');
    console.log('✅ type=9 dog food metadata / write whitelist PASS');
    console.log('✅ AddFood 90004 wire == official plainHex PASS');
    console.log('✅ arg2 remains opaque and fixed at observed value 1 PASS');
    console.log('✅ out-of-stock / unknown food fail closed PASS');
    console.log('✅ fake one-shot AddFood sends exactly once and post-read verifies PASS');
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        realQqTouched: false,
        dogServiceTouched: false,
        writeOperationTouched: false,
        fakeSendCount: sendCount,
        verification: result.verification,
    }, null, 2));
}

main().catch((error) => {
    console.error('\n❌ Guard Dog / P7E Feed Safety Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
