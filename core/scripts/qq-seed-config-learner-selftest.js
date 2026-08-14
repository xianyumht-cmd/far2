const assert = require('node:assert/strict');
const {
    collectContainingObjectSnippets,
    maskTopLevelObject,
    parsePlantObjectText,
    scanTextForSeedConfig,
    selectDeterministicHit,
} = require('../src/services/qq-seed-config-learner');

function main() {
    console.log('FAR2 QQ Seed Config Learner Self-Test');
    console.log('安全: 只解析本地字符串 fixture，不读取真实 QQ、不连接网络、不发送 RPC。\n');

    const oneByOne = '{"id":1020901,"name":"活动花","seed_id":20901,"land_level_need":1,"size":0,"fruit":{"id":40901}}';
    const parsed1 = parsePlantObjectText(oneByOne, 20901);
    assert.ok(parsed1);
    assert.equal(parsed1.seedId, 20901);
    assert.equal(parsed1.plantSize, 1);
    assert.equal(parsed1.rawSize, 0);
    assert.equal(parsed1.name, '活动花');
    assert.equal(parsed1.requiredLevel, 1);
    console.log('✅ same direct object seed_id + size=0 resolves to 1x1 PASS');

    const twoByTwo = "{id:1020902,name:'活动大花',seed_id:20902,land_level_need:2,size:2,offsetPosition:{x:0,y:0}}";
    const parsed2 = parsePlantObjectText(twoByTwo, 20902);
    assert.ok(parsed2);
    assert.equal(parsed2.plantSize, 2);
    assert.equal(parsed2.rawSize, 2);
    console.log('✅ same direct object seed_id + size=2 resolves to 2x2 PASS');

    const masked = maskTopLevelObject('{seed_id:20902,size:2,nested:{seed_id:3,size:1}}');
    assert.match(masked, /seed_id:20902/);
    assert.match(masked, /size:2/);
    assert.doesNotMatch(masked, /seed_id:3/);
    console.log('✅ nested object fields are masked out of direct-field proof PASS');

    const nestedSeedParentSize = '{size:2,item:{seed_id:20903}}';
    assert.equal(parsePlantObjectText(nestedSeedParentSize, 20903), null);
    const parentSeedNestedSize = '{seed_id:20904,item:{size:2}}';
    assert.equal(parsePlantObjectText(parentSeedNestedSize, 20904), null);
    console.log('✅ parent/child fields cannot be combined into a false seed footprint PASS');

    const ambiguous = '{"seed_id":20905,"size":0,"size":2}';
    assert.equal(parsePlantObjectText(ambiguous, 20905), null);
    console.log('✅ conflicting direct size values fail closed PASS');

    const unrelated = '{"item_id":20906,"size":0}';
    assert.equal(parsePlantObjectText(unrelated, 20906), null);
    console.log('✅ numeric coincidence without seed_id does not learn a mapping PASS');

    const bundled = `xxx,{foo:1},{id:1020902,name:'活动大花',seed_id:20902,land_level_need:2,size:2,offsetPosition:{x:0,y:0}},yyy`;
    const tokenIndex = bundled.indexOf('20902');
    const snippets = collectContainingObjectSnippets(bundled, tokenIndex);
    assert.ok(snippets.length >= 1);
    const hits = scanTextForSeedConfig(bundled, 20902);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].plantSize, 2);
    console.log('✅ minified bundle context can isolate containing plant object PASS');

    const falseParentBundle = `{size:2,item:{seed_id:20907,name:'not a plant object'}}`;
    assert.deepEqual(scanTextForSeedConfig(falseParentBundle, 20907), []);
    console.log('✅ containing parent with unrelated size is rejected PASS');

    const selected = selectDeterministicHit([
        { seedId: 20902, plantSize: 2, rawSize: 2, name: '活动大花', requiredLevel: 2, evidence: 'fixture' },
        { seedId: 20902, plantSize: 2, rawSize: 2, name: '活动大花', requiredLevel: 2, evidence: 'fixture' },
    ]);
    assert.ok(selected);
    assert.equal(selected.corroboratingHits, 2);

    const rejected = selectDeterministicHit([
        { seedId: 20902, plantSize: 1, rawSize: 0, name: '', requiredLevel: 0, evidence: 'fixture' },
        { seedId: 20902, plantSize: 2, rawSize: 2, name: '', requiredLevel: 0, evidence: 'fixture' },
    ]);
    assert.equal(rejected, null);
    console.log('✅ inconsistent cache hits are rejected instead of guessed PASS');

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        directFieldProof: true,
        realQqCacheTouched: false,
        networkTouched: false,
        rpcTouched: false,
        writeOperationTouched: false,
    }, null, 2));
}

try {
    main();
} catch (error) {
    console.error('\n❌ QQ Seed Config Learner Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
}
