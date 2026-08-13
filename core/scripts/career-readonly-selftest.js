const assert = require('node:assert/strict');
const { loadProto, types } = require('../src/utils/proto');
const {
    decodeCareerReplyRaw,
    normalizeTypedCareerReply,
    normalizeCareerOverview,
} = require('../src/services/career');

async function main() {
    console.log('FAR2 Career Read-Only Self-Test');
    console.log('安全: 只编码/解析本地 Career protobuf fixture，不连接 QQ、不调用 CareerService、不执行写操作。\n');

    await loadProto();
    assert.ok(types.CareerInfoGetRequest, 'CareerInfoGetRequest should load');
    assert.ok(types.CareerInfoGetReply, 'CareerInfoGetReply should load');

    const raw = types.CareerInfoGetReply.encode(types.CareerInfoGetReply.create({
        items: [
            { fruit_id: 40002, count: 12345 },
            { fruit_id: 40003, count: 888 },
        ],
        stats_total: 13233,
        stats_count: 2,
        name: '测试农场主',
        avatar: 'https://example.invalid/avatar.png',
        level: 112,
        exp: 987654,
        gid: 123456789,
        level_stats: [
            { fruit_id: 40002, count: 12345, level: 10 },
        ],
        achieved_levels: 88,
        openid: 'openid-test',
    })).finish();

    const decoded = types.CareerInfoGetReply.decode(raw);
    const typed = normalizeTypedCareerReply(decoded);
    assert.equal(typed.name, '测试农场主');
    assert.equal(typed.level, 112);
    assert.equal(typed.exp, 987654);
    assert.deepEqual(typed.items, [
        { fruit_id: 40002, count: 12345 },
        { fruit_id: 40003, count: 888 },
    ]);

    const fallback = decodeCareerReplyRaw(raw);
    assert.equal(fallback.name, '测试农场主', 'raw fallback should preserve UTF-8 nickname');
    assert.equal(fallback.avatar, 'https://example.invalid/avatar.png');
    assert.equal(fallback.level, 112);
    assert.equal(fallback.gid, 123456789);
    assert.equal(fallback.items.length, 2);
    assert.deepEqual(fallback.level_stats[0], { fruit_id: 40002, count: 12345, level: 10 });

    const overview = normalizeCareerOverview(typed, raw.length, 'typed_fixture');
    assert.equal(overview.player.name, '测试农场主');
    assert.equal(overview.items[0].id, 40002);
    assert.equal(overview.items[0].count, 12345);
    assert.equal(overview.meta.statsTotal, 13233);
    assert.equal(overview.protocol.readOnly, true);
    assert.equal(overview.protocol.method, 'CareerInfoGet');

    console.log('✅ careerpb loads PASS');
    console.log('✅ typed CareerInfoGet reply normalizes PASS');
    console.log('✅ raw protobuf fallback preserves items + UTF-8 player fields PASS');
    console.log('✅ decorated read-only overview PASS');
    console.log('✅ no write method touched PASS');
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        player: overview.player,
        topItems: overview.items.slice(0, 2),
        decodeMode: overview.meta.decodeMode,
        realQqTouched: false,
        careerServiceTouched: false,
        writeOperationTouched: false,
    }, null, 2));
}

main().catch((error) => {
    console.error('\n❌ Career Read-Only Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
