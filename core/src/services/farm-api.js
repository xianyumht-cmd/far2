const { sendMsgAsync, getUserState } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong } = require('../utils/utils');

const PLANT_SERVICE = 'gamepb.plantpb.PlantService';
const SHOP_SERVICE = 'gamepb.shoppb.ShopService';

function createFarmApiTransport(options = {}) {
    const send = typeof options.send === 'function' ? options.send : sendMsgAsync;
    const getState = typeof options.getState === 'function' ? options.getState : getUserState;
    const protoTypes = options.types || types;
    const toLongValue = typeof options.toLong === 'function' ? options.toLong : toLong;

    async function sendPlantRequest(RequestType, ReplyType, method, landIds, hostGid) {
        const body = RequestType.encode(RequestType.create({
            land_ids: landIds,
            host_gid: toLongValue(hostGid),
        })).finish();
        const { body: replyBody } = await send(PLANT_SERVICE, method, body);
        return ReplyType.decode(replyBody);
    }

    async function getAllLandsRaw() {
        const body = protoTypes.AllLandsRequest.encode(protoTypes.AllLandsRequest.create({})).finish();
        const { body: replyBody } = await send(PLANT_SERVICE, 'AllLands', body);
        return protoTypes.AllLandsReply.decode(replyBody);
    }

    async function harvest(landIds) {
        const state = getState() || {};
        const body = protoTypes.HarvestRequest.encode(protoTypes.HarvestRequest.create({
            land_ids: landIds,
            host_gid: toLongValue(state.gid),
            is_all: true,
        })).finish();
        const { body: replyBody } = await send(PLANT_SERVICE, 'Harvest', body);
        return protoTypes.HarvestReply.decode(replyBody);
    }

    async function waterLand(landIds) {
        const state = getState() || {};
        return sendPlantRequest(protoTypes.WaterLandRequest, protoTypes.WaterLandReply, 'WaterLand', landIds, state.gid);
    }

    async function weedOut(landIds) {
        const state = getState() || {};
        return sendPlantRequest(protoTypes.WeedOutRequest, protoTypes.WeedOutReply, 'WeedOut', landIds, state.gid);
    }

    async function insecticide(landIds) {
        const state = getState() || {};
        return sendPlantRequest(protoTypes.InsecticideRequest, protoTypes.InsecticideReply, 'Insecticide', landIds, state.gid);
    }

    async function removePlant(landIds) {
        const body = protoTypes.RemovePlantRequest.encode(protoTypes.RemovePlantRequest.create({
            land_ids: landIds.map(id => toLongValue(id)),
        })).finish();
        const { body: replyBody } = await send(PLANT_SERVICE, 'RemovePlant', body);
        return protoTypes.RemovePlantReply.decode(replyBody);
    }

    async function upgradeLand(landId) {
        const body = protoTypes.UpgradeLandRequest.encode(protoTypes.UpgradeLandRequest.create({
            land_id: toLongValue(landId),
        })).finish();
        const { body: replyBody } = await send(PLANT_SERVICE, 'UpgradeLand', body);
        return protoTypes.UpgradeLandReply.decode(replyBody);
    }

    async function unlockLand(landId, doShared = false) {
        const body = protoTypes.UnlockLandRequest.encode(protoTypes.UnlockLandRequest.create({
            land_id: toLongValue(landId),
            do_shared: !!doShared,
        })).finish();
        const { body: replyBody } = await send(PLANT_SERVICE, 'UnlockLand', body);
        return protoTypes.UnlockLandReply.decode(replyBody);
    }

    async function getShopInfo(shopId) {
        const body = protoTypes.ShopInfoRequest.encode(protoTypes.ShopInfoRequest.create({
            shop_id: toLongValue(shopId),
        })).finish();
        const { body: replyBody } = await send(SHOP_SERVICE, 'ShopInfo', body);
        return protoTypes.ShopInfoReply.decode(replyBody);
    }

    async function buyGoods(goodsId, num, price) {
        const body = protoTypes.BuyGoodsRequest.encode(protoTypes.BuyGoodsRequest.create({
            goods_id: toLongValue(goodsId),
            num: toLongValue(num),
            price: toLongValue(price),
        })).finish();
        const { body: replyBody } = await send(SHOP_SERVICE, 'BuyGoods', body);
        return protoTypes.BuyGoodsReply.decode(replyBody);
    }

    return {
        sendPlantRequest,
        getAllLandsRaw,
        harvest,
        waterLand,
        weedOut,
        insecticide,
        removePlant,
        upgradeLand,
        unlockLand,
        getShopInfo,
        buyGoods,
    };
}

const defaultTransport = createFarmApiTransport();

module.exports = {
    PLANT_SERVICE,
    SHOP_SERVICE,
    createFarmApiTransport,
    ...defaultTransport,
};
