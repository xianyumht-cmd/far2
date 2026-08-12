const assert = require('node:assert/strict');
const {
    getPlantBySeedId,
    getPlantNameBySeedId,
    getSeedPlantSize,
} = require('../src/config/gameConfig');

function main() {
    console.log('FAR2 2x2 Seed Fallback Self-Test');
    console.log('安全: 只读取本地配置，不连接 QQ、不调用农场 RPC。\n');

    const seedId = 20046;
    const plant = getPlantBySeedId(seedId);
    assert.ok(plant, 'known 2x2 fallback seed should resolve');
    assert.equal(Number(plant.seed_id), seedId);
    assert.equal(getPlantNameBySeedId(seedId), '爱心果');
    assert.equal(getSeedPlantSize(seedId), 2);

    const normal = getPlantBySeedId(20002);
    assert.ok(normal, 'normal Plant.json seed should still resolve');
    assert.equal(getSeedPlantSize(20002), Math.max(1, Number(normal.size) || 1));

    console.log('✅ missing Plant.json seed 20046 resolves as 爱心果 PASS');
    console.log('✅ seed 20046 plantSize=2 PASS');
    console.log('✅ normal Plant.json seed resolution unchanged PASS');
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        seedId,
        name: getPlantNameBySeedId(seedId),
        plantSize: getSeedPlantSize(seedId),
        realQqTouched: false,
        realFarmRpcTouched: false,
    }, null, 2));
}

try {
    main();
}
catch (error) {
    console.error('\n❌ 2x2 Seed Fallback Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
}
