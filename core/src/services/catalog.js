const { getPlantNameBySeedId, getSeedImageBySeedId, getItemById, getItemImageById } = require('../config/gameConfig');
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum } = require('../utils/utils');

const SHOP_TYPE_LABELS = {
    1: '道具商店',
    2: '种子商店',
    3: '宠物商店',
};

const ILLUSTRATED_TYPE_LABELS = {
    1: '作物图鉴',
    2: '变异图鉴',
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

function readVarint(buffer, offset) {
    let value = 0n;
    let shift = 0n;
    let pos = offset;
    while (pos < buffer.length && shift <= 70n) {
        const byte = BigInt(buffer[pos]);
        value |= (byte & 0x7Fn) << shift;
        pos += 1;
        if ((byte & 0x80n) === 0n) return { value, next: pos };
        shift += 7n;
    }
    throw new Error(`protobuf varint truncated at offset ${offset}`);
}

function scanProtobufMessage(input) {
    const buffer = Buffer.from(input || []);
    const fields = [];
    let pos = 0;
    while (pos < buffer.length) {
        const tag = readVarint(buffer, pos);
        pos = tag.next;
        const field = Number(tag.value >> 3n);
        const wire = Number(tag.value & 0x7n);
        if (field <= 0) throw new Error(`invalid protobuf field at offset ${pos}`);

        if (wire === 0) {
            const value = readVarint(buffer, pos);
            fields.push({ field, wire, value: value.value });
            pos = value.next;
            continue;
        }
        if (wire === 1) {
            const end = pos + 8;
            if (end > buffer.length) throw new Error(`truncated fixed64 field ${field}`);
            fields.push({ field, wire, bytes: buffer.subarray(pos, end) });
            pos = end;
            continue;
        }
        if (wire === 2) {
            const len = readVarint(buffer, pos);
            const length = Number(len.value);
            const start = len.next;
            const end = start + length;
            if (!Number.isSafeInteger(length) || length < 0 || end > buffer.length) {
                throw new Error(`truncated length-delimited field ${field}`);
            }
            fields.push({ field, wire, bytes: buffer.subarray(start, end) });
            pos = end;
            continue;
        }
        if (wire === 5) {
            const end = pos + 4;
            if (end > buffer.length) throw new Error(`truncated fixed32 field ${field}`);
            fields.push({ field, wire, bytes: buffer.subarray(pos, end) });
            pos = end;
            continue;
        }
        throw new Error(`unsupported protobuf wire type ${wire} at offset ${pos}`);
    }
    return fields;
}

function varintField(fields, field, fallback = 0) {
    const found = fields.find(row => row.field === field && row.wire === 0);
    return found ? Number(found.value) : fallback;
}

function packedVarints(fields, field) {
    const result = [];
    for (const row of fields.filter(item => item.field === field)) {
        if (row.wire === 0) {
            result.push(Number(row.value));
            continue;
        }
        if (row.wire !== 2 || !row.bytes) continue;
        let pos = 0;
        while (pos < row.bytes.length) {
            const value = readVarint(row.bytes, pos);
            result.push(Number(value.value));
            pos = value.next;
        }
    }
    return result;
}

function decodeIllustratedWireFallback(replyBody) {
    const fields = scanProtobufMessage(replyBody);
    const items = fields
        .filter(row => row.field === 1 && row.wire === 2 && row.bytes)
        .map((row) => {
            const itemFields = scanProtobufMessage(row.bytes);
            return {
                seed_id: varintField(itemFields, 1),
                illustrated_tier: varintField(itemFields, 2),
                unlocked: varintField(itemFields, 3) > 0,
                reward_score: varintField(itemFields, 4),
                harvest_count: varintField(itemFields, 5),
                reward_info: itemFields.find(item => item.field === 6 && item.wire === 2)?.bytes || Buffer.alloc(0),
                has_reward: varintField(itemFields, 7) > 0,
            };
        })
        .filter(item => item.seed_id > 0);

    return {
        items,
        current_score: varintField(fields, 2),
        level: varintField(fields, 3),
        unlocked_tiers: packedVarints(fields, 5),
        current_tier: varintField(fields, 6),
        next_score: varintField(fields, 7),
        has_level_reward: varintField(fields, 9) > 0,
    };
}

function normalizeIllustratedReply(reply, illustratedType, decodeMode, decodeWarning = '') {
    const items = (Array.isArray(reply && reply.items) ? reply.items : []).map((item) => {
        const seedId = toNum(item && item.seed_id);
        return {
            seedId,
            name: getPlantNameBySeedId(seedId),
            image: getSeedImageBySeedId(seedId),
            illustratedType,
            illustratedTypeLabel: ILLUSTRATED_TYPE_LABELS[illustratedType] || `图鉴${illustratedType}`,
            illustratedTier: toNum(item && item.illustrated_tier),
            unlocked: !!(item && item.unlocked),
            rewardScore: toNum(item && item.reward_score),
            harvestCount: toNum(item && item.harvest_count),
            hasReward: !!(item && item.has_reward),
        };
    });

    return {
        illustratedType,
        illustratedTypeLabel: ILLUSTRATED_TYPE_LABELS[illustratedType] || `图鉴${illustratedType}`,
        items,
        summary: {
            total: items.length,
            unlocked: items.filter(item => item.unlocked).length,
            locked: items.filter(item => !item.unlocked).length,
            rewardReady: items.filter(item => item.hasReward).length,
            currentScore: toNum(reply && reply.current_score),
            level: toNum(reply && reply.level),
            currentTier: toNum(reply && reply.current_tier),
            nextScore: toNum(reply && reply.next_score),
            hasLevelReward: !!(reply && reply.has_level_reward),
            unlockedTiers: (Array.isArray(reply && reply.unlocked_tiers) ? reply.unlocked_tiers : []).map(toNum),
        },
        protocol: {
            service: 'gamepb.illustratedpb.IllustratedService',
            method: 'GetIllustratedListV2',
            version: 2,
            schema: '2026-08-current',
            decodeMode,
            decodeWarning,
        },
    };
}

async function getIllustratedOverview(options = {}) {
    if (!types.GetIllustratedListV2Request || !types.GetIllustratedListV2Reply) {
        throw new Error('Illustrated V2 protobuf 未加载');
    }

    const illustratedType = Number(options.illustratedType) === 2 ? 2 : 1;
    const body = types.GetIllustratedListV2Request.encode(
        types.GetIllustratedListV2Request.create({
            refresh: options.refresh !== false,
            illustrated_type: illustratedType,
        }),
    ).finish();
    const { body: replyBody } = await sendMsgAsync(
        'gamepb.illustratedpb.IllustratedService',
        'GetIllustratedListV2',
        body,
    );

    try {
        const reply = types.GetIllustratedListV2Reply.decode(replyBody);
        return normalizeIllustratedReply(reply, illustratedType, 'protobufjs');
    }
    catch (err) {
        const fallback = decodeIllustratedWireFallback(replyBody);
        return normalizeIllustratedReply(
            fallback,
            illustratedType,
            'wire-fallback',
            err && err.message ? err.message : 'protobuf decode failed',
        );
    }
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
    ILLUSTRATED_TYPE_LABELS,
};
