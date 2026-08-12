const assert = require('node:assert/strict');
const {
    build2x2LandGroups,
    selectReady2x2Groups,
    validate2x2PlantReply,
} = require('../src/services/farm-2x2');

function unlockedLands() {
    return Array.from({ length: 24 }, (_, index) => ({ id: index + 1, unlocked: true }));
}

function main() {
    console.log('FAR2 2x2 Planting Self-Test');
    console.log('安全: 只测试 4x6 土地几何和回包关系，不连接 QQ、不调用农场 RPC。\n');

    const lands = unlockedLands();
    const groups = build2x2LandGroups(lands);
    const first = groups.find(group => group.masterLandId === 5);
    assert.deepEqual(first && first.landIds, [5, 6, 1, 2]);

    const selected = selectReady2x2Groups(lands, Array.from({ length: 24 }, (_, i) => i + 1), 4);
    assert.equal(selected.length, 4);
    const selectedIds = selected.flatMap(group => group.landIds);
    assert.equal(new Set(selectedIds).size, selectedIds.length, 'selected groups must not overlap');

    const missingOne = selectReady2x2Groups(lands, [1, 2, 5], 1);
    assert.equal(missingOne.length, 0, '2x2 group requires all four lands to be empty');

    const group = { masterLandId: 5, landIds: [5, 6, 1, 2] };
    const reply = {
        land: [
            { id: 5, slave_land_ids: [6, 1, 2] },
            { id: 6, master_land_id: 5 },
            { id: 1, master_land_id: 5 },
            { id: 2, master_land_id: 5 },
        ],
    };
    assert.equal(validate2x2PlantReply(reply, group).ok, true);
    assert.equal(validate2x2PlantReply({ land: [{ id: 5, slave_land_ids: [6, 1] }] }, group).ok, false);

    console.log('✅ 4x6 farmland geometry / left-bottom master PASS');
    console.log('✅ only fully-empty non-overlapping 2x2 groups selected PASS');
    console.log('✅ master/slave reply validation fails closed PASS');
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        realQqTouched: false,
        realFarmRpcTouched: false,
    }, null, 2));
}

try {
    main();
}
catch (error) {
    console.error('\n❌ 2x2 Planting Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
}
