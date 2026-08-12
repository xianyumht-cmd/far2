const { getPlantNameBySeedId, getSeedImageBySeedId, getItemById, getItemImageById } = require('../config/gameConfig');
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum } = require('../utils/utils');

const SHOP_TYPE_LABELS = {
    1: '道具商店',
    2: '种子商店',
    3: '宠物商店',
};

function normalizeConditions(conds) {
    return (Array.isArray(conds) ? conds : []).map(cond => ({
        type: toNum(cond && cond.type),
        param: toNum(cond && cond.param),
    }));
}

function buildCatalogItemName(itemId) {
    const id = toNum(itemId);
    if (!id) return '';
    const item = getItemById(id);
    if (item && item.name) return String(item.name);
    const plantName = getPlantNameBySeedId(id);
    return plantName && plantName !== `种子${id}` ? plantName : `物品${id}`;
}

function buildCatalogItemImage(itemId) {
    const id = toNum(itemId);
    if (!id) return '';
    return getSeedImageBySeedId(id) || getItemImageById(id) || '';
}

async function getIllustratedOverview(options = {}) {
    if (!types.GetIllustratedListV2Request || !types.GetIllustratedListV2Reply) {
        throw new Error('Illustrated V2 protobuf 未加载');
    }

    const body = types.GetIllustratedListV2Request.encode(
        types.GetIllustratedListV2Request.create({
            refresh: options.refresh !== false,
            full: options.full !== false,
        }),
    ).finish();
    const { body: replyBody } = await sendMsgAsync(
        'gamepb.illustratedpb.IllustratedService',
        'GetIllustratedListV2',
        body,
    );
    const reply = types.GetIllustratedListV2Reply.decode(replyBody);
    const items = (Array.isArray(reply && reply.items) ? reply.items : []).map((item) => {
        const seedId = toNum(item && item.seed_id);
        return {
            seedId,
            name: getPlantNameBySeedId(seedId),
            image: getSeedImageBySeedId(seedId),
            unlocked: !!(item && item.unlocked),
            planted: !!(item && item.planted),
            plantedCount: toNum(item && item.planted_count),
            harvestCount: toNum(item && item.harvest_count),
            category: toNum(item && item.category),
            hasReward: !!(item && item.has_reward),
        };
    });

    return {
        items,
        summary: {
            total: items.length,
            unlocked: items.filter(item => item.unlocked).length,
            locked: items.filter(item => !item.unlocked).length,
            planted: items.filter(item => item.planted).length,
            rewardReady: items.filter(item => item.hasReward).length,
        },
        protocol: {
            service: 'gamepb.illustratedpb.IllustratedService',
            method: 'GetIllustratedListV2',
            version: 2,
        },
    };
}

async function getShopProfilesOverview() {
    if (!types.ShopProfilesRequest || !types.ShopProfilesReply) {
        throw new Error('ShopProfiles protobuf 未加载');
    }
    const body = types.ShopProfilesRequest.encode(types.ShopProfilesRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.shoppb.ShopService', 'ShopProfiles', body);
    const reply = types.ShopProfilesReply.decode(replyBody);
    const shops = (Array.isArray(reply && reply.shop_profiles) ? reply.shop_profiles : []).map(profile => ({
        shopId: toNum(profile && profile.shop_id),
        shopName: String((profile && profile.shop_name) || ''),
        shopType: toNum(profile && profile.shop_type),
        shopTypeLabel: SHOP_TYPE_LABELS[toNum(profile && profile.shop_type)] || '其他商店',
    }));
    return {
        shops,
        summary: {
            total: shops.length,
            seedShops: shops.filter(shop => shop.shopType === 2).length,
            petShops: shops.filter(shop => shop.shopType === 3).length,
            itemShops: shops.filter(shop => shop.shopType === 1).length,
        },
    };
}

async function getShopInfoOverview(shopId) {
    if (!types.ShopInfoRequest || !types.ShopInfoReply) {
        throw new Error('ShopInfo protobuf 未加载');
    }
    const id = toNum(shopId);
    if (!id) throw new Error('Invalid shopId');
    const body = types.ShopInfoRequest.encode(types.ShopInfoRequest.create({ shop_id: toLong(id) })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.shoppb.ShopService', 'ShopInfo', body);
    const reply = types.ShopInfoReply.decode(replyBody);
    const goods = (Array.isArray(reply && reply.goods_list) ? reply.goods_list : []).map((row) => {
        const itemId = toNum(row && row.item_id);
        return {
            goodsId: toNum(row && row.id),
            itemId,
            name: buildCatalogItemName(itemId),
            image: buildCatalogItemImage(itemId),
            itemCount: toNum(row && row.item_count),
            price: toNum(row && row.price),
            boughtNum: toNum(row && row.bought_num),
            limitCount: toNum(row && row.limit_count),
            unlocked: !!(row && row.unlocked),
            conditions: normalizeConditions(row && row.conds),
        };
    });
    return {
        shopId: id,
        goods,
        summary: {
            total: goods.length,
            unlocked: goods.filter(item => item.unlocked).length,
            locked: goods.filter(item => !item.unlocked).length,
            limited: goods.filter(item => item.limitCount > 0).length,
        },
    };
}

module.exports = {
    getIllustratedOverview,
    getShopProfilesOverview,
    getShopInfoOverview,
    SHOP_TYPE_LABELS,
};
