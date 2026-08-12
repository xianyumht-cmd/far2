const assert = require('node:assert/strict');
const path = require('node:path');
const protobuf = require('protobufjs');

function main() {
    const protoDir = path.join(__dirname, '../src/proto');
    const root = new protobuf.Root();
    root.loadSync([
        path.join(protoDir, 'corepb.proto'),
        path.join(protoDir, 'illustratedpb.proto'),
    ], { keepCase: true });

    const Request = root.lookupType('gamepb.illustratedpb.GetIllustratedListV2Request');
    const Reply = root.lookupType('gamepb.illustratedpb.GetIllustratedListV2Reply');

    const requestBytes = Request.encode(Request.create({
        refresh: true,
        illustrated_type: 1,
    })).finish();
    const request = Request.decode(requestBytes);
    assert.equal(request.refresh, true);
    assert.equal(request.illustrated_type, 1);

    const replyBytes = Reply.encode(Reply.create({
        items: [{
            seed_id: 20003,
            illustrated_tier: 2,
            unlocked: true,
            reward_score: 15,
            harvest_count: 27,
            reward_info: Buffer.from([0x08, 0x01, 0x10, 0x05]),
            has_reward: true,
        }],
        current_score: 88,
        level: 4,
        unlocked_tiers: [1, 2],
        current_tier: 2,
        next_score: 120,
        has_level_reward: true,
    })).finish();

    const reply = Reply.decode(replyBytes);
    assert.equal(reply.items.length, 1);
    assert.equal(Number(reply.items[0].seed_id), 20003);
    assert.equal(reply.items[0].illustrated_tier, 2);
    assert.equal(reply.items[0].unlocked, true);
    assert.equal(reply.items[0].reward_score, 15);
    assert.equal(reply.items[0].harvest_count, 27);
    assert.equal(Buffer.from(reply.items[0].reward_info).toString('hex'), '08011005');
    assert.equal(reply.items[0].has_reward, true);
    assert.equal(reply.current_score, 88);
    assert.equal(reply.level, 4);
    assert.deepEqual(reply.unlocked_tiers, [1, 2]);
    assert.equal(reply.current_tier, 2);
    assert.equal(reply.next_score, 120);
    assert.equal(reply.has_level_reward, true);

    console.log('Illustrated Proto Self-Test PASS');
    console.log(JSON.stringify({
        ok: true,
        illustratedType: request.illustrated_type,
        itemField6Bytes: Buffer.from(reply.items[0].reward_info).length,
        currentScore: reply.current_score,
        realQqTouched: false,
    }, null, 2));
}

try {
    main();
}
catch (err) {
    console.error('Illustrated Proto Self-Test FAIL:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
}
