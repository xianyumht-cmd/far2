const assert = require('node:assert/strict');
const {
    createEventSeedShopWrapper,
    createEventSeedLogWarn,
} = require('../src/services/event-seed-shop-wrapper');

async function main() {
    console.log('FAR2 Event Seed Shop Wrapper Self-Test');
    console.log('安全: 只用 fixture，不连接 QQ、不调用真实商店/种植 RPC。\n');

    const calls = [];
    const passThrough = createEventSeedShopWrapper({
        runEventSeedPriorityBeforeShop: async ({ landIds }) => ({
            remainingLandIds: [...landIds],
            plantedLandIds: [],
            blockShopFallback: false,
            unresolvedSeedIds: [],
            prioritySeedIds: [],
            inspection: { inventory: { knownSeeds: [], unresolvedCandidates: [] } },
        }),
        plantFromShopBase: async (landIds, state, strategy) => {
            calls.push(['shop', [...landIds], state.level, strategy]);
            return { plantedLands: [...landIds] };
        },
        getAllLands: async () => ({ lands: [] }),
        log: () => {},
        logWarn: () => {},
    });
    assert.deepEqual(await passThrough([1, 2], { level: 113 }, 'max_exp'), { plantedLands: [1, 2] });
    assert.deepEqual(calls, [['shop', [1, 2], 113, 'max_exp']]);
    console.log('✅ no block passes remaining lands to original shop strategy PASS');

    let unknownShopCalls = 0;
    const unknownProtected = createEventSeedShopWrapper({
        runEventSeedPriorityBeforeShop: async ({ landIds }) => ({
            remainingLandIds: [...landIds],
            plantedLandIds: [],
            blockShopFallback: true,
            unresolvedSeedIds: [20999],
            prioritySeedIds: [],
            inspection: {
                inventory: {
                    knownSeeds: [],
                    unresolvedCandidates: [{ seedId: 20999, confidence: 'high', activityReferenced: false }],
                },
            },
        }),
        plantFromShopBase: async () => {
            unknownShopCalls++;
            return { plantedLands: [] };
        },
        getAllLands: async () => ({ lands: [] }),
        log: () => {},
        logWarn: () => {},
    });
    assert.deepEqual(await unknownProtected([1, 2], { level: 113 }), { plantedLands: [] });
    assert.equal(unknownShopCalls, 0);
    console.log('✅ high-confidence unresolved seed protects lands from shop planting PASS');

    const reservationCalls = [];
    const reserved2x2 = createEventSeedShopWrapper({
        runEventSeedPriorityBeforeShop: async ({ landIds }) => ({
            remainingLandIds: [...landIds],
            plantedLandIds: [],
            blockShopFallback: true,
            unresolvedSeedIds: [],
            prioritySeedIds: [20902],
            inspection: {
                inventory: {
                    knownSeeds: [{
                        seedId: 20902,
                        count: 1,
                        requiredLevel: 1,
                        plantSize: 2,
                        specialCandidate: true,
                    }],
                    unresolvedCandidates: [],
                },
            },
        }),
        plantFromShopBase: async (landIds) => {
            reservationCalls.push(['shop', [...landIds]]);
            return { plantedLands: [...landIds] };
        },
        getAllLands: async () => ({ lands: [1, 2, 3, 4, 5, 6].map(id => ({ id, unlocked: true, plant: null })) }),
        select2x2Reservations: (_lands, empty, desired) => {
            reservationCalls.push(['reserve', [...empty], desired]);
            return { reservedLandIds: [1, 2, 3, 4] };
        },
        log: () => {},
        logWarn: () => {},
    });
    assert.deepEqual(await reserved2x2([1, 2, 3, 4, 5, 6], { level: 113 }), { plantedLands: [5, 6] });
    assert.deepEqual(reservationCalls, [
        ['reserve', [1, 2, 3, 4, 5, 6], 1],
        ['shop', [5, 6]],
    ]);
    console.log('✅ waiting 2x2 reserves only its footprint while unrelated empty lands keep farming PASS');

    const noGroupCalls = [];
    const noReservableGroup = createEventSeedShopWrapper({
        runEventSeedPriorityBeforeShop: async ({ landIds }) => ({
            remainingLandIds: [...landIds],
            plantedLandIds: [],
            blockShopFallback: true,
            unresolvedSeedIds: [],
            prioritySeedIds: [20902],
            inspection: {
                inventory: {
                    knownSeeds: [{
                        seedId: 20902,
                        count: 1,
                        requiredLevel: 1,
                        plantSize: 2,
                        specialCandidate: true,
                    }],
                    unresolvedCandidates: [],
                },
            },
        }),
        plantFromShopBase: async (landIds) => {
            noGroupCalls.push([...landIds]);
            return { plantedLands: [...landIds] };
        },
        getAllLands: async () => ({ lands: [{ id: 1, unlocked: true, plant: null }] }),
        select2x2Reservations: () => ({ reservedLandIds: [] }),
        log: () => {},
        logWarn: () => {},
    });
    assert.deepEqual(await noReservableGroup([1], { level: 113 }), { plantedLands: [1] });
    assert.deepEqual(noGroupCalls, [[1]]);
    console.log('✅ impossible 2x2 layout does not leave the farm permanently empty PASS');

    let oneByOneShopCalls = 0;
    const oneByOneFailure = createEventSeedShopWrapper({
        runEventSeedPriorityBeforeShop: async ({ landIds }) => ({
            remainingLandIds: [...landIds],
            plantedLandIds: [1],
            blockShopFallback: true,
            unresolvedSeedIds: [],
            prioritySeedIds: [20901],
            inspection: {
                inventory: {
                    knownSeeds: [{
                        seedId: 20901,
                        count: 2,
                        requiredLevel: 1,
                        plantSize: 1,
                        specialCandidate: true,
                    }],
                    unresolvedCandidates: [],
                },
            },
        }),
        plantFromShopBase: async () => {
            oneByOneShopCalls++;
            return { plantedLands: [] };
        },
        getAllLands: async () => ({ lands: [] }),
        log: () => {},
        logWarn: () => {},
    });
    assert.deepEqual(await oneByOneFailure([2, 3], { level: 113 }), { plantedLands: [1] });
    assert.equal(oneByOneShopCalls, 0);
    console.log('✅ known 1x1 partial/failure remains fail-closed for the same cycle PASS');

    const logEvents = [];
    const warningAdapter = createEventSeedLogWarn({
        log: (tag, message, meta) => logEvents.push(['info', tag, message, meta.result]),
        logWarn: (tag, message, meta) => logEvents.push(['warn', tag, message, meta.result]),
    });
    warningAdapter('种植', '发现未知；为避免误买普通种子，本轮暂停商店补种并记录学习证据', {
        result: 'unresolved_seed_block_shop',
    });
    warningAdapter('种植', 'real failure', { result: 'real_failure' });
    assert.equal(logEvents[0][0], 'info');
    assert.equal(logEvents[0][3], 'unresolved_seed_guarded');
    assert.equal(logEvents[1][0], 'warn');
    console.log('✅ unresolved log wording waits for confidence guard while real failures stay warnings PASS');

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        networkTouched: false,
        shopRpcTouched: false,
        plantRpcTouched: false,
        writeOperationTouched: false,
    }, null, 2));
}

main().catch(error => {
    console.error('\n❌ Event Seed Shop Wrapper Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
