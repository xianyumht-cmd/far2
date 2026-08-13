const assert = require('node:assert/strict');
const { loadProto, types } = require('../src/utils/proto');
const { PLANT_SERVICE, SHOP_SERVICE, createFarmApiTransport } = require('../src/services/farm-api');

function num(value) {
    if (value === undefined || value === null) return 0;
    if (typeof value === 'number') return value;
    if (typeof value.toString === 'function') return Number(value.toString()) || 0;
    return Number(value) || 0;
}

async function main() {
    console.log('FAR2 Farm API Transport Contract Self-Test');
    console.log('安全: 使用真实 protobuf 编解码 + 假 sendMsgAsync，不连接 QQ、不发送 Farm/Shop RPC。\n');

    await loadProto();

    const calls = [];
    const replyTypeByMethod = {
        AllLands: types.AllLandsReply,
        Harvest: types.HarvestReply,
        WaterLand: types.WaterLandReply,
        WeedOut: types.WeedOutReply,
        Insecticide: types.InsecticideReply,
        RemovePlant: types.RemovePlantReply,
        UpgradeLand: types.UpgradeLandReply,
        UnlockLand: types.UnlockLandReply,
        ShopInfo: types.ShopInfoReply,
        BuyGoods: types.BuyGoodsReply,
    };

    async function fakeSend(service, method, body) {
        calls.push({ service, method, body: Buffer.from(body) });
        const ReplyType = replyTypeByMethod[method];
        assert.ok(ReplyType, `missing fixture reply type for ${method}`);
        return { body: ReplyType.encode(ReplyType.create({})).finish() };
    }

    const transport = createFarmApiTransport({
        send: fakeSend,
        getState: () => ({ gid: 987654321 }),
        types,
    });

    await transport.getAllLandsRaw();
    await transport.harvest([1, 2]);
    await transport.waterLand([3, 4]);
    await transport.weedOut([5]);
    await transport.insecticide([6]);
    await transport.removePlant([7, 8]);
    await transport.upgradeLand(9);
    await transport.unlockLand(10, true);
    await transport.getShopInfo(2);
    await transport.buyGoods(77, 3, 1200);

    assert.deepEqual(calls.map(call => [call.service, call.method]), [
        [PLANT_SERVICE, 'AllLands'],
        [PLANT_SERVICE, 'Harvest'],
        [PLANT_SERVICE, 'WaterLand'],
        [PLANT_SERVICE, 'WeedOut'],
        [PLANT_SERVICE, 'Insecticide'],
        [PLANT_SERVICE, 'RemovePlant'],
        [PLANT_SERVICE, 'UpgradeLand'],
        [PLANT_SERVICE, 'UnlockLand'],
        [SHOP_SERVICE, 'ShopInfo'],
        [SHOP_SERVICE, 'BuyGoods'],
    ]);

    const byMethod = new Map(calls.map(call => [call.method, call]));

    const allLands = types.AllLandsRequest.decode(byMethod.get('AllLands').body);
    assert.ok(allLands, 'AllLands empty request should decode');

    const harvest = types.HarvestRequest.decode(byMethod.get('Harvest').body);
    assert.deepEqual(harvest.land_ids.map(num), [1, 2]);
    assert.equal(num(harvest.host_gid), 987654321);
    assert.equal(harvest.is_all, true);

    for (const [method, RequestType, expectedIds] of [
        ['WaterLand', types.WaterLandRequest, [3, 4]],
        ['WeedOut', types.WeedOutRequest, [5]],
        ['Insecticide', types.InsecticideRequest, [6]],
    ]) {
        const request = RequestType.decode(byMethod.get(method).body);
        assert.deepEqual(request.land_ids.map(num), expectedIds, `${method} land_ids`);
        assert.equal(num(request.host_gid), 987654321, `${method} host_gid`);
    }

    const remove = types.RemovePlantRequest.decode(byMethod.get('RemovePlant').body);
    assert.deepEqual(remove.land_ids.map(num), [7, 8]);

    const upgrade = types.UpgradeLandRequest.decode(byMethod.get('UpgradeLand').body);
    assert.equal(num(upgrade.land_id), 9);

    const unlock = types.UnlockLandRequest.decode(byMethod.get('UnlockLand').body);
    assert.equal(num(unlock.land_id), 10);
    assert.equal(unlock.do_shared, true);

    const shop = types.ShopInfoRequest.decode(byMethod.get('ShopInfo').body);
    assert.equal(num(shop.shop_id), 2);

    const buy = types.BuyGoodsRequest.decode(byMethod.get('BuyGoods').body);
    assert.equal(num(buy.goods_id), 77);
    assert.equal(num(buy.num), 3);
    assert.equal(num(buy.price), 1200);

    console.log('✅ PlantService/ShopService method routing PASS');
    console.log('✅ AllLands/Harvest/clear-action request contracts PASS');
    console.log('✅ Remove/Upgrade/Unlock request contracts PASS');
    console.log('✅ ShopInfo/BuyGoods request contracts PASS');
    console.log('✅ no real network/RPC touched PASS');
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        callCount: calls.length,
        methods: calls.map(call => call.method),
        realQqTouched: false,
        farmRpcTouched: false,
        shopRpcTouched: false,
        writeOperationTouched: false,
    }, null, 2));
}

main().catch((error) => {
    console.error('\n❌ Farm API Transport Contract Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
