const assert = require('node:assert/strict');
const protobuf = require('protobufjs');
const { loadProto, types } = require('../src/utils/proto');
const {
    PLANT_SERVICE,
    encodePlantRequest,
    getPlantingStrategyLabel,
    sortBagSeedsForPlanting,
    createPlantingService,
} = require('../src/services/planting-service');

function num(value) {
    if (value === undefined || value === null) return 0;
    if (typeof value === 'number') return value;
    if (typeof value.toString === 'function') return Number(value.toString()) || 0;
    return Number(value) || 0;
}

function decodePlantRequest(body) {
    const reader = protobuf.Reader.create(body);
    assert.equal(reader.uint32(), 18, 'top-level Plant item must be field 2');
    const itemLength = reader.uint32();
    const itemEnd = reader.pos + itemLength;

    assert.equal(reader.uint32(), 8, 'seed id must be item field 1');
    const seedId = num(reader.int64());
    assert.equal(reader.uint32(), 18, 'land ids must be item field 2');
    const landsLength = reader.uint32();
    const landsEnd = reader.pos + landsLength;
    const landIds = [];
    while (reader.pos < landsEnd) {
        landIds.push(num(reader.int64()));
    }
    assert.equal(reader.pos, itemEnd, 'Plant item should end after packed land ids');
    return { seedId, landIds };
}

async function main() {
    console.log('FAR2 Planting Service Contract Self-Test');
    console.log('安全: 真实 protobuf 编解码 + 假 Shop/Plant 发送器，不连接 QQ、不购买真实种子。\n');

    await loadProto();

    assert.equal(getPlantingStrategyLabel('bag_priority'), '背包种子优先');
    assert.equal(getPlantingStrategyLabel('custom'), 'custom');

    const sorted = sortBagSeedsForPlanting([
        { seedId: 3, requiredLevel: 30 },
        { seedId: 1, requiredLevel: 10 },
        { seedId: 2, requiredLevel: 20 },
    ], [2]);
    assert.deepEqual(sorted.map(item => item.seedId), [2, 3, 1]);

    const encoded = decodePlantRequest(encodePlantRequest(20002, [1, 2, 5, 6]));
    assert.deepEqual(encoded, { seedId: 20002, landIds: [1, 2, 5, 6] });

    const plantCalls = [];
    async function fakeSend(service, method, body) {
        assert.equal(service, PLANT_SERVICE);
        assert.equal(method, 'Plant');
        const request = decodePlantRequest(body);
        plantCalls.push(request);
        const landId = request.landIds[0] || 0;
        const reply = types.PlantReply.create({ land: landId > 0 ? [{ id: landId }] : [] });
        return { body: types.PlantReply.encode(reply).finish() };
    }

    const service = createPlantingService({
        send: fakeSend,
        types,
        getState: () => ({ level: 30, gold: 25 }),
        getBagSeeds: async () => [],
        getBagSeedPriority: () => [],
        getPlantingStrategy: () => 'level',
        getPreferredSeed: () => 0,
        getPlantBySeedId: (seedId) => ({ size: Number(seedId) === 20002 ? 2 : 1 }),
        getPlantNameBySeedId: (seedId) => `种子${seedId}`,
        getPlantGrowTime: () => 0,
        formatGrowTime: (value) => String(value),
        getShopInfo: async () => ({
            goods_list: [
                { id: 101, item_id: 20001, price: 10, unlocked: true, conds: [{ type: 1, param: 10 }], limit_count: 0, bought_num: 0 },
                { id: 102, item_id: 20002, price: 10, unlocked: true, conds: [{ type: 1, param: 25 }], limit_count: 0, bought_num: 0 },
                { id: 103, item_id: 20003, price: 12, unlocked: true, conds: [{ type: 1, param: 20 }], limit_count: 0, bought_num: 0 },
            ],
        }),
        buyGoods: async () => ({ get_items: [], cost_items: [] }),
        getPlantRankings: () => [],
        getAllLands: async () => ({ lands: [] }),
        log: () => {},
        logWarn: () => {},
        sleep: async () => {},
    });

    assert.equal(service.getPlantSizeBySeedId(20001), 1);
    assert.equal(service.getPlantSizeBySeedId(20002), 2);

    const planted = await service.plantSeeds(20001, [1, 2, 3], { maxPlantCount: 2 });
    assert.equal(planted.planted, 2);
    assert.deepEqual(planted.plantedLandIds, [1, 2]);
    assert.deepEqual(planted.occupiedLandIds, [1, 2]);
    assert.deepEqual(plantCalls.slice(0, 2), [
        { seedId: 20001, landIds: [1] },
        { seedId: 20001, landIds: [2] },
    ]);

    const best = await service.findBestSeed('level');
    assert.equal(best.seedId, 20003, 'shop selection must keep 2x2 auto-purchase excluded');

    const emptyBag = await service.plantFromBagSeeds([11, 12]);
    assert.deepEqual(emptyBag.remainingLandIds, [11, 12]);
    assert.equal(emptyBag.fallbackAllowed, true);
    assert.equal(emptyBag.totalPlanted, 0);

    const shopState = { level: 30, gold: 25 };
    const buyCalls = [];
    const shopPlantCalls = [];
    const shopService = createPlantingService({
        send: async (serviceName, method, body) => {
            assert.equal(serviceName, PLANT_SERVICE);
            assert.equal(method, 'Plant');
            const request = decodePlantRequest(body);
            shopPlantCalls.push(request);
            const reply = types.PlantReply.create({ land: [{ id: request.landIds[0] }] });
            return { body: types.PlantReply.encode(reply).finish() };
        },
        types,
        getState: () => shopState,
        getPlantingStrategy: () => 'level',
        getPreferredSeed: () => 0,
        getBagSeeds: async () => [],
        getBagSeedPriority: () => [],
        getPlantBySeedId: () => ({ size: 1 }),
        getPlantNameBySeedId: (seedId) => `种子${seedId}`,
        getPlantGrowTime: () => 0,
        formatGrowTime: (value) => String(value),
        getShopInfo: async () => ({
            goods_list: [
                { id: 101, item_id: 20001, price: 10, unlocked: true, conds: [{ type: 1, param: 10 }], limit_count: 0, bought_num: 0 },
            ],
        }),
        buyGoods: async (goodsId, count, price) => {
            buyCalls.push([goodsId, count, price]);
            return {
                get_items: [{ id: 20001 }],
                cost_items: [{ count: count * price }],
            };
        },
        getPlantRankings: () => [],
        getAllLands: async () => ({ lands: [] }),
        log: () => {},
        logWarn: () => {},
        sleep: async () => {},
    });

    const shopResult = await shopService.plantFromShop([21, 22, 23], shopState, 'level');
    assert.deepEqual(buyCalls, [[101, 2, 10]], 'insufficient gold must cap purchase count');
    assert.equal(shopState.gold, 5, 'existing cost_items state mutation must remain');
    assert.deepEqual(shopResult.plantedLands, [21, 22]);
    assert.deepEqual(shopPlantCalls, [
        { seedId: 20001, landIds: [21] },
        { seedId: 20001, landIds: [22] },
    ]);

    console.log('✅ Plant wire encoding contract PASS');
    console.log('✅ bag priority sorting/fallback contract PASS');
    console.log('✅ 1x1 Plant loop/maxPlantCount contract PASS');
    console.log('✅ shop strategy keeps 2x2 auto-purchase excluded PASS');
    console.log('✅ insufficient-gold purchase cap/state mutation PASS');
    console.log('✅ no real QQ/Shop/Plant write touched PASS');
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        realQqTouched: false,
        plantRpcTouched: false,
        shopPurchaseTouched: false,
        writeOperationTouched: false,
    }, null, 2));
}

main().catch((error) => {
    console.error('\n❌ Planting Service Contract Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
