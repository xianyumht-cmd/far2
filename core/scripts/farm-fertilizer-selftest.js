const assert = require('node:assert/strict');
const { PlantPhase } = require('../src/config/config');
const { loadProto, types } = require('../src/utils/proto');
const {
    NORMAL_FERTILIZER_ID,
    ORGANIC_FERTILIZER_ID,
    normalizeFertilizerLandTypes,
    filterLandIdsByTypes,
    getOrganicFertilizerTargetsFromLands,
    getFastMatureLands,
    createFarmFertilizerService,
} = require('../src/services/farm-fertilizer');

function num(value) {
    if (value === undefined || value === null) return 0;
    if (typeof value === 'number') return value;
    if (typeof value.toString === 'function') return Number(value.toString()) || 0;
    return Number(value) || 0;
}

async function main() {
    console.log('FAR2 Farm Fertilizer Contract Self-Test');
    console.log('安全: 使用本地 land fixture + 假 sendMsgAsync，不连接 QQ、不发送施肥 RPC。\n');

    await loadProto();

    assert.deepEqual(
        normalizeFertilizerLandTypes(['gold', 'black', 'red', 'normal']),
        ['purple', 'gold', 'black', 'red', 'normal'],
        'legacy all-selected scope must still include purple',
    );
    assert.deepEqual(normalizeFertilizerLandTypes(['gold']), ['gold']);

    const landTypeMap = new Map([[1, 'purple'], [2, 'gold'], [3, 'black']]);
    assert.deepEqual(filterLandIdsByTypes([1, 2, 3], landTypeMap, ['gold']), [2]);
    assert.deepEqual(
        filterLandIdsByTypes([1, 2, 3], landTypeMap, ['gold', 'black', 'red', 'normal']),
        [1, 2, 3],
        'legacy all-selected scope must be all lands after migration',
    );

    const now = Math.floor(Date.now() / 1000);
    const organicTargets = getOrganicFertilizerTargetsFromLands([
        { id: 1, unlocked: true, plant: { phases: [{ phase: PlantPhase.SEED, begin_time: 1 }], left_inorc_fert_times: 1 } },
        { id: 2, unlocked: true, plant: { phases: [{ phase: PlantPhase.SEED, begin_time: 1 }], left_inorc_fert_times: 0 } },
        { id: 3, unlocked: true, plant: { phases: [{ phase: PlantPhase.DEAD, begin_time: 1 }], left_inorc_fert_times: 5 } },
        { id: 4, unlocked: false, plant: { phases: [{ phase: PlantPhase.SEED, begin_time: 1 }] } },
    ]);
    assert.deepEqual(organicTargets, [1]);

    const fastTargets = getFastMatureLands([
        {
            id: 5,
            unlocked: true,
            plant: {
                phases: [
                    { phase: PlantPhase.SEED, begin_time: now - 10 },
                    { phase: PlantPhase.MATURE, begin_time: now + 120 },
                ],
                left_inorc_fert_times: 1,
            },
        },
        {
            id: 6,
            unlocked: true,
            plant: {
                phases: [
                    { phase: PlantPhase.SEED, begin_time: now - 10 },
                    { phase: PlantPhase.MATURE, begin_time: now + 120 },
                ],
                left_inorc_fert_times: 0,
            },
        },
    ], 300, now);
    assert.deepEqual(fastTargets, [5]);

    const calls = [];
    const records = [];
    let automation = {
        fertilizer: 'normal',
        fertilizer_land_types: ['gold', 'black', 'red', 'normal'],
        fertilizer_smart_seconds: 300,
    };
    const lands = [
        { id: 1, unlocked: true, level: 5 },
        { id: 2, unlocked: true, level: 4 },
        { id: 3, unlocked: true, level: 3 },
    ];

    async function fakeSend(service, method, body) {
        calls.push({ service, method, body: Buffer.from(body) });
        return { body: Buffer.alloc(0) };
    }

    const service = createFarmFertilizerService({
        send: fakeSend,
        types,
        getAllLands: async () => ({ lands }),
        getAutomation: () => automation,
        recordOperation: (name, count) => records.push([name, count]),
        log: () => {},
        logWarn: () => {},
        sleep: async () => {},
        randomDelay: async () => {},
    });

    const allResult = await service.runFertilizerByConfig([1, 2, 3]);
    assert.deepEqual(allResult, { normal: 3, organic: 0 });
    assert.equal(calls.length, 3);
    assert.deepEqual(records, [['fertilize', 3]]);
    for (const [index, call] of calls.entries()) {
        assert.equal(call.service, 'gamepb.plantpb.PlantService');
        assert.equal(call.method, 'Fertilize');
        const request = types.FertilizeRequest.decode(call.body);
        assert.deepEqual(request.land_ids.map(num), [index + 1]);
        assert.equal(num(request.fertilizer_id), NORMAL_FERTILIZER_ID);
    }

    calls.length = 0;
    records.length = 0;
    automation = {
        fertilizer: 'normal',
        fertilizer_land_types: ['gold'],
    };
    const goldResult = await service.runFertilizerByConfig([1, 2, 3]);
    assert.deepEqual(goldResult, { normal: 1, organic: 0 });
    assert.equal(calls.length, 1);
    const goldRequest = types.FertilizeRequest.decode(calls[0].body);
    assert.deepEqual(goldRequest.land_ids.map(num), [2]);
    assert.equal(num(goldRequest.fertilizer_id), NORMAL_FERTILIZER_ID);

    assert.equal(ORGANIC_FERTILIZER_ID, 1012);

    console.log('✅ legacy purple-land fertilizer scope migration PASS');
    console.log('✅ land-type filtering contract PASS');
    console.log('✅ organic/fast-mature target selection PASS');
    console.log('✅ normal fertilizer request contract + recordOperation PASS');
    console.log('✅ production service dependency injection works PASS');
    console.log('✅ no real network/RPC touched PASS');
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        normalFertilizerId: NORMAL_FERTILIZER_ID,
        organicFertilizerId: ORGANIC_FERTILIZER_ID,
        realQqTouched: false,
        fertilizerRpcTouched: false,
        writeOperationTouched: false,
    }, null, 2));
}

main().catch((error) => {
    console.error('\n❌ Farm Fertilizer Contract Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
