/**
 * Official-config seed regression self-test.
 *
 * Runs entirely offline against the imported official tables
 * (core/src/gameConfig/Plant.json = 318 rows, ItemInfo.json = 1,066 rows).
 *
 * Covers the acceptance points of the FR3GB seed/config integration:
 *   1. official table integrity and footprint encoding
 *   2. size:null => 1x1, size:2 => 2x2
 *   3. normal store seeds resolve instead of entering unknown learning
 *   4. only configuration gaps enter the unknown record (and never reserve land)
 *   5. absence from one account's shop is not proof of an event seed
 *   6. ItemInfo.level is never used as a planting gate
 *   7. 2x2 reservation respects already-planted slave plots
 *   8. no usable 2x2 seed => reservation released
 *   9. 2x2 plant reply validation (no blind retry on mismatch)
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const plantTable = require(path.join(__dirname, '..', 'src', 'gameConfig', 'Plant.json'));
const itemTable = require(path.join(__dirname, '..', 'src', 'gameConfig', 'ItemInfo.json'));
const { inspectSeedEvidence, buildBagSeedInventory } = require('../src/services/event-seed-priority');
const { shouldBlockShopFallback } = require('../src/services/event-seed-shop-guard');
const {
    getActive2x2Footprints,
    selectReady2x2Groups,
    select2x2Reservations,
    clear2x2Reservation,
    validate2x2PlantReply,
    build2x2LandGroups,
} = require('../src/services/farm-2x2');

const PRIORITY_IDS = [
    20108, 20154, 20184, 20185, 20186, 20193, 20256, 20258, 20261, 20264, 20304,
    20133, 20176, 20243, 20251, 20267, 20375, 20435, 20516, 20883, 21038, 21044,
    21050, 21135, 21221, 21251, 21353, 21380, 21404, 26032, 29003,
];
const EXPECTED_2X2_SEEDS = [29998, 20046, 20416, 21032, 29003, 29004, 29005];

const plantBySeed = new Map(plantTable.filter(r => r.seed_id).map(r => [Number(r.seed_id), r]));
const itemById = new Map(itemTable.map(r => [Number(r.id), r]));
const getPlantBySeedId = id => plantBySeed.get(Number(id)) || null;
const getItemById = id => itemById.get(Number(id)) || null;

let passed = 0;
const results = [];
function check(name, fn) {
    try { fn(); passed += 1; results.push(`PASS ${name}`); } catch (err) { results.push(`FAIL ${name}: ${err.message}`); throw err; }
}

function inventoryFor(entries) {
    return buildBagSeedInventory(entries, { getItemById, getPlantBySeedId, activityItemIds: new Set() });
}

function main() {
    console.log('FAR2 official-config seed regression self-test');
    console.log('offline only: fixture tables, no QQ connection, no planting, no purchase\n');

    // 1. table integrity
    check('official Plant table has 318 rows', () => assert.equal(plantTable.length, 318));
    check('official ItemInfo table has 1066 rows', () => assert.equal(itemTable.length, 1066));
    check('Plant.size only uses null or 2', () => {
        const sizes = [...new Set(plantTable.map(r => r.size))].map(String).sort();
        assert.deepEqual(sizes, ['2', 'null']);
    });
    check('all 31 priority seed ids are configured', () => {
        const missing = PRIORITY_IDS.filter(id => !plantBySeed.has(id));
        assert.deepEqual(missing, []);
    });

    // 2. footprint decoding
    check('2x2 seed list matches official size:2 rows with seed_id', () => {
        const actual = plantTable.filter(r => Number(r.size) === 2 && r.seed_id).map(r => Number(r.seed_id)).sort((a, b) => a - b);
        assert.deepEqual(actual, [...EXPECTED_2X2_SEEDS].sort((a, b) => a - b));
    });
    check('size:null decodes to a single tile', () => {
        const inv = inventoryFor([{ id: 20002, count: 5 }]);
        assert.equal(inv.knownSeeds[0].plantSize, 1);
        assert.equal(inv.knownSeeds[0].safeToPlant, true);
    });
    check('size:2 decodes to a 2x2 footprint', () => {
        const inv = inventoryFor([{ id: 29004, count: 5 }]);
        assert.equal(inv.knownSeeds[0].plantSize, 2);
        assert.equal(inv.knownSeeds[0].safeToPlant, true);
    });
    check('29003 / 29004 / 29005 are all 2x2 and plantable', () => {
        for (const id of [29003, 29004, 29005]) {
            const inv = inventoryFor([{ id, count: 1 }]);
            assert.equal(inv.knownSeeds[0].plantSize, 2, `seed ${id} should be 2x2`);
            assert.equal(inv.knownSeeds[0].safeToPlant, true, `seed ${id} should be plantable`);
        }
    });

    // 3. normal store seeds resolve (they are in the official table)
    check('ordinary store seed resolves with proven config', () => {
        const inv = inventoryFor([{ id: 20002, count: 9 }]);
        assert.equal(inv.unresolvedCandidates.length, 0);
        assert.equal(inv.knownSeeds[0].confidence, 'proven-config');
    });

    // 4. configuration gaps are recorded but must not block shop planting
    check('a seed with ItemInfo but no Plant row is recorded as a config gap', () => {
        const gapId = 20136; // ItemInfo type=5, absent from the official Plant table
        assert.equal(getPlantBySeedId(gapId), null);
        assert.equal(Number(getItemById(gapId).type), 5);
        const inv = inventoryFor([{ id: gapId, count: 2 }]);
        assert.equal(inv.unresolvedCandidates.length, 1);
        assert.equal(inv.unresolvedCandidates[0].seedId, gapId);
    });
    check('configuration gap does not borrow ItemInfo.level as a planting gate', () => {
        const inv = inventoryFor([{ id: 20136, count: 2 }]);
        const row = inv.unresolvedCandidates[0];
        assert.equal(Number(row.requiredLevel) || 0, 0);
    });
    check('unknown seed-like inventory never blocks the shop fallback', () => {
        const inv = inventoryFor([{ id: 20136, count: 2 }]);
        const prepass = {
            blockShopFallback: false,
            knownSeedBlock: false,
            knownSeedBlockReasons: [],
            unresolvedSeedIds: inv.unresolvedCandidates.map(r => r.seedId),
            prioritySeedIds: [],
        };
        assert.equal(shouldBlockShopFallback(prepass), false);
    });
    check('an explicit known-seed failure still blocks this cycle', () => {
        assert.equal(shouldBlockShopFallback({ blockShopFallback: true, knownSeedBlock: true, knownSeedBlockReasons: ['probe_failed'] }), true);
    });

    // 5. absence from the shop is not event evidence
    check('non-shop 2x2 seed is not classified as an event seed', () => {
        const evidence = inspectSeedEvidence(29003, getItemById(29003), getPlantBySeedId(29003), new Set());
        assert.equal(evidence.knownPlant, true);
        assert.equal(evidence.confidence, 'proven-config');
        assert.equal(evidence.activityReferenced, false);
        assert.equal(evidence.candidate, true);
    });
    check('known non-seed item is not a seed candidate even inside the id range', () => {
        const nonSeed = { id: 21037, type: 3, name: '道具', interaction_type: 'use' };
        const evidence = inspectSeedEvidence(21037, nonSeed, null, new Set());
        assert.equal(evidence.candidate, false);
    });
    check('namespace hint still surfaces ids that ItemInfo cannot describe', () => {
        const evidence = inspectSeedEvidence(21998, null, null, new Set());
        assert.equal(evidence.candidate, true);
        assert.equal(evidence.confidence, 'medium');
    });

    // 7. slave plots of a live 2x2 crop are protected
    const lands = Array.from({ length: 24 }, (_, i) => ({ id: i + 1, unlocked: true, plant: null }));
    lands[4] = { id: 5, unlocked: true, plant: { phases: [{ name: 'seed' }] }, slave_land_ids: [1, 2, 6] };
    check('active 2x2 footprint is detected from server slave_land_ids', () => {
        const footprints = getActive2x2Footprints(lands);
        assert.equal(footprints.length, 1);
        assert.deepEqual([...footprints[0].landIds].sort((a, b) => a - b), [1, 2, 5, 6]);
    });
    check('a group overlapping a live 2x2 crop is never selected', () => {
        const groups = build2x2LandGroups(lands);
        const overlapping = groups.filter(g => g.landIds.some(id => [1, 2, 5, 6].includes(id)));
        assert.ok(overlapping.length > 0, 'fixture should contain overlapping groups');
        const ready = selectReady2x2Groups(lands, [1, 2, 6, 7], 2);
        assert.equal(ready.length, 0);
    });

    // 8. no usable 2x2 seed => release the reservation
    check('zero desired 2x2 count releases any reservation', () => {
        const withWaiting = select2x2Reservations(lands, [1, 2, 3], 1);
        assert.ok(withWaiting.reservedLandIds.length >= 0);
        const released = select2x2Reservations(lands, [1, 2, 3], 0);
        assert.deepEqual(released.reservedLandIds, []);
        assert.equal(released.waitingGroup, null);
        clear2x2Reservation();
    });

    // 9. plant reply validation
    check('2x2 reply with missing master is rejected', () => {
        const group = { masterLandId: 5, landIds: [5, 6, 1, 2] };
        const verdict = validate2x2PlantReply({ land: [] }, group);
        assert.equal(verdict.ok, false);
        assert.equal(verdict.reason, 'master_missing');
    });
    check('2x2 reply with wrong slave ownership is rejected', () => {
        const group = { masterLandId: 5, landIds: [5, 6, 1, 2] };
        const reply = {
            land: [
                { id: 5, slave_land_ids: [6, 1, 2] },
                { id: 6, master_land_id: 9 },
                { id: 1, master_land_id: 5 },
                { id: 2, master_land_id: 5 },
            ],
        };
        const verdict = validate2x2PlantReply(reply, group);
        assert.equal(verdict.ok, false);
        assert.match(verdict.reason, /master_mismatch/);
    });
    check('2x2 reply matching master/slave layout is accepted', () => {
        const group = { masterLandId: 5, landIds: [5, 6, 1, 2] };
        const reply = {
            land: [
                { id: 5, slave_land_ids: [6, 1, 2] },
                { id: 6, master_land_id: 5 },
                { id: 1, master_land_id: 5 },
                { id: 2, master_land_id: 5 },
            ],
        };
        const verdict = validate2x2PlantReply(reply, group);
        assert.equal(verdict.ok, true);
        assert.equal(verdict.masterLandId, 5);
    });

    console.log(results.join('\n'));
    console.log(`\nPASSED ${passed}/${results.length}`);
    if (passed !== results.length) process.exitCode = 1;
}

main();
