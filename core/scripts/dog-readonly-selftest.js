const assert = require('node:assert/strict');
const path = require('node:path');
const protobuf = require('protobufjs');
const { loadProto, types } = require('../src/utils/proto');
const { extractTopLevelVarint, normalizeDogInfoReply } = require('../src/services/dog');

async function main() {
    console.log('FAR2 Guard Dog / P7E Protocol Self-Test');
    console.log('安全: 只编码/解析本地 protobuf fixture，不连接 QQ、不调用 DogService、不执行领取或喂食。\n');

    await loadProto();
    assert.ok(types.GetDogInfoReply, 'GetDogInfoReply should be loaded');

    const base = types.GetDogInfoReply.encode(types.GetDogInfoReply.create({
        dogs: [
            { id: 101, expire_time: 2000000000, status: 2, level: 6, active: 1 },
        ],
        coin: 345,
        protect_time: 1999999999,
        foods: [
            { id: 90004, duration: 86400, count: 3 },
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
    assert.equal(overview.foods.length, 1);
    assert.equal(overview.foods[0].id, 90004);
    assert.equal(overview.foods[0].duration, 86400);
    assert.equal(overview.foods[0].count, 3);
    assert.equal(overview.foods[0].name, '1天狗粮');
    assert.equal(overview.foods[0].itemType, 9);
    assert.equal(overview.foods[0].configCanUse, false);
    assert.equal(overview.foods[0].recognizedDogFood, true);
    assert.equal(overview.foods[0].staticMetadataSource, 'ItemInfo');
    assert.equal(overview.coin, 345);
    assert.equal(overview.protectTime, 1999999999);
    assert.equal(overview.claimableGiftCount, 66);
    assert.equal(overview.protocol.readOnly, true);
    assert.equal(overview.protocol.method, 'GetDogInfo');
    assert.equal(overview.protocol.foodWriteSupported, false);
    assert.equal(overview.protocol.foodWriteEvidence, 'request-shape-proven');
    assert.equal(overview.protocol.foodWriteMethod, 'AddFood');
    assert.deepEqual(overview.protocol.foodWriteRequest, { foodIdField: 1, countField: 2 });

    const dogProtoRoot = protobuf.loadSync(path.join(__dirname, '..', 'src', 'proto', 'dogpb.proto'), { keepCase: true });
    const AddFoodRequest = dogProtoRoot.lookupType('gamepb.dogpb.AddFoodRequest');
    const encodedAddFood = Buffer.from(AddFoodRequest.encode(AddFoodRequest.create({
        food_id: 90004,
        count: 1,
    })).finish());

    // 2026-08-14 official-client live evidence after local tsdk.wasm decrypt:
    // plainHex = 0894bf051001 => field 1 = 90004, field 2 = 1.
    assert.equal(encodedAddFood.toString('hex'), '0894bf051001');

    const noUnknown = types.GetDogInfoReply.encode(types.GetDogInfoReply.create({ dogs: [] })).finish();
    assert.equal(extractTopLevelVarint(noUnknown, 7), null);

    console.log('✅ dogpb loads PASS');
    console.log('✅ GetDogInfo known fields normalize PASS');
    console.log('✅ type=9 dog food metadata enrichment PASS');
    console.log('✅ AddFoodRequest field layout matches live decrypted wire PASS');
    console.log('✅ dog food runtime write remains disabled PASS');
    console.log('✅ unknown top-level field 7 claimable count is preserved PASS');
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        overview,
        addFoodEvidence: {
            service: 'gamepb.dogpb.DogService',
            method: 'AddFood',
            foodId: 90004,
            count: 1,
            encodedHex: encodedAddFood.toString('hex'),
            expectedLivePlainHex: '0894bf051001',
            matched: true,
        },
        realQqTouched: false,
        dogServiceTouched: false,
        claimSkillGiftsTouched: false,
        feedDogTouched: false,
        itemServiceUseTouched: false,
        writeOperationTouched: false,
    }, null, 2));
}

main().catch((error) => {
    console.error('\n❌ Guard Dog / P7E Protocol Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
