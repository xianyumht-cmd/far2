const assert = require('node:assert/strict');
const { PlantPhase } = require('../src/config/config');
const { createFarmQueryService } = require('../src/services/farm-query-service');

async function main() {
    console.log('FAR2 Farm Query Contract Self-Test');
    console.log('安全: 纯本地 shop/land fixture，不连接 QQ、不发送任何写 RPC。\n');

    const warnings = [];
    const query = createFarmQueryService({
        getUserState: () => ({ level: 15 }),
        getShopInfo: async () => ({
            goods_list: [
                { id: 2, item_id: 20002, price: 20, unlocked: true, conds: [{ type: 1, param: 20 }], limit_count: 0, bought_num: 0 },
                { id: 1, item_id: 20001, price: 10, unlocked: true, conds: [{ type: 1, param: 5 }], limit_count: 1, bought_num: 1 },
            ],
        }),
        getPlantNameBySeedId: (id) => `种子${id}`,
        getWsErrorState: () => null,
        logWarn: (...args) => warnings.push(args),
        getAllSeeds: () => [{ seedId: 9, name: '本地种子' }],
        getAllLands: async () => ({
            lands: [
                { id: 1, unlocked: false, level: 1, max_level: 5, could_unlock: true },
                { id: 2, unlocked: true, level: 2, plant: null },
                {
                    id: 3,
                    unlocked: true,
                    level: 3,
                    slave_land_ids: [4],
                    plant: {
                        id: 1020003,
                        name: '成熟作物',
                        season: 2,
                        phases: [{ phase: PlantPhase.MATURE, begin_time: 1 }],
                    },
                },
                { id: 4, unlocked: true, level: 3, master_land_id: 3 },
            ],
        }),
        getPlantName: (id) => `作物${id}`,
        getPlantById: () => ({ seed_id: 20003, size: 2, seasons: 3 }),
        getSeedImageBySeedId: (id) => `seed://${id}`,
        getPlantGrowTime: () => 3600,
        getMutantEffectsByIds: () => [],
        getServerTimeSec: () => 1000,
    });

    const seeds = await query.getAvailableSeeds();
    assert.deepEqual(seeds.map((item) => item.seedId), [20001, 20002]);
    assert.equal(seeds[0].soldOut, true);
    assert.equal(seeds[0].locked, false);
    assert.equal(seeds[1].locked, true);

    const detail = await query.getLandsDetail();
    assert.equal(detail.lands.length, 4);
    assert.equal(detail.lands[0].status, 'locked');
    assert.equal(detail.lands[1].status, 'empty');
    assert.equal(detail.lands[2].status, 'harvestable');
    assert.equal(detail.lands[2].plantSize, 2);
    assert.equal(detail.lands[2].currentSeason, 2);
    assert.equal(detail.lands[2].totalSeason, 3);
    assert.equal(detail.lands[2].seedImage, 'seed://20003');
    assert.equal(detail.lands[3].occupiedByMaster, true);
    assert.equal(detail.lands[3].masterLandId, 3);
    assert.equal(detail.lands[3].plantName, '作物1020003');
    assert.equal(detail.lands[3].mutation.active, false, '2x2 slave must not duplicate master mutation display');
    assert.equal(detail.summary.harvestable, 2, 'master and display slave both retain UI status semantics');

    const fallbackWarnings = [];
    const fallbackQuery = createFarmQueryService({
        getUserState: () => ({ level: 1 }),
        getShopInfo: async () => { throw new Error('offline'); },
        getWsErrorState: () => ({ code: 400 }),
        logWarn: (...args) => fallbackWarnings.push(args),
        getAllSeeds: () => [{ seedId: 99, name: '离线种子' }],
    });
    const fallback = await fallbackQuery.getAvailableSeeds();
    assert.deepEqual(fallback, [{
        seedId: 99,
        name: '离线种子',
        goodsId: 0,
        price: null,
        requiredLevel: null,
        unknownMeta: true,
        locked: false,
        soldOut: false,
    }]);
    assert.equal(fallbackWarnings.length, 0, 'WS400 fallback must remain quiet');

    console.log('✅ shop seed DTO/sort/lock/sold-out contract PASS');
    console.log('✅ land DTO + 2x2 display context contract PASS');
    console.log('✅ WS400 local seed fallback contract PASS');
    console.log('✅ no real network/write touched PASS');
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({ ok: true, realQqTouched: false, writeOperationTouched: false }, null, 2));
}

main().catch((error) => {
    console.error('\n❌ Farm Query Contract Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
