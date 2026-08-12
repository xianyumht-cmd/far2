const assert = require('node:assert/strict');
const {
    build2x2LandGroups,
    clear2x2Reservation,
    select2x2Reservations,
    selectReady2x2Groups,
    validate2x2PlantReply,
} = require('../src/services/farm-2x2');

function unlockedLands() {
    return Array.from({ length: 24 }, (_, index) => ({ id: index + 1, unlocked: true }));
}

function main() {
    console.log('FAR2 2x2 Planting Self-Test');
    console.log('安全: 只测试 4x6 土地几何、预留和回包关系，不连接 QQ、不调用农场 RPC。\n');

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

    const staleLands = unlockedLands();
    staleLands[0].plant = { phases: [{ phase: 1 }] };
    const staleCandidate = selectReady2x2Groups(staleLands, [1, 2, 5, 6], 1);
    assert.equal(staleCandidate.length, 0, 'live AllLands plant data must override stale empty ids');

    clear2x2Reservation();
    const partlyEmptyLands = unlockedLands();
    partlyEmptyLands[0].plant = { phases: [{ phase: 2 }] };
    partlyEmptyLands[1].plant = { phases: [{ phase: 2 }] };
    const reservation1 = select2x2Reservations(partlyEmptyLands, [5, 6], 1);
    assert.equal(reservation1.readyGroups.length, 0);
    assert.ok(reservation1.waitingGroup, 'one incomplete group should be reserved');
    assert.deepEqual(reservation1.waitingGroup.landIds, [5, 6, 1, 2]);
    assert.deepEqual(reservation1.reservedLandIds, [5, 6, 1, 2]);

    const reservation2 = select2x2Reservations(partlyEmptyLands, [5, 6, 9], 1);
    assert.equal(reservation2.waitingGroup && reservation2.waitingGroup.key, reservation1.waitingGroup.key,
        'waiting reservation should stay stable across farm cycles');

    const nowReadyLands = unlockedLands();
    const reservation3 = select2x2Reservations(nowReadyLands, [1, 2, 5, 6], 1);
    assert.equal(reservation3.readyGroups.length, 1);
    assert.deepEqual(reservation3.readyGroups[0].landIds, [5, 6, 1, 2]);
    assert.equal(reservation3.waitingGroup, null);

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
    console.log('✅ only live-empty non-overlapping 2x2 groups selected PASS');
    console.log('✅ stale empty ids cannot bypass latest AllLands state PASS');
    console.log('✅ only one incomplete 2x2 group is reserved PASS');
    console.log('✅ waiting reservation stays stable across cycles PASS');
    console.log('✅ reserved group becomes ready after all four lands clear PASS');
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
