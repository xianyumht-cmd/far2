const protobuf = require('protobufjs');
const { getItemById, getItemImageById } = require('../config/gameConfig');
const { sendMsgAsync } = require('../utils/network');
const { types, getRoot } = require('../utils/proto');
const { log, sleep } = require('../utils/utils');

const DOG_SERVICE = 'gamepb.dogpb.DogService';
const DOG_FOOD_ITEM_TYPE = 9;
const ADD_FOOD_METHOD = 'AddFood';
const ADD_FOOD_OBSERVED_ARG2 = 1;
const SUPPORTED_DOG_FOOD_IDS = new Set([90004, 90005, 90006]);
let addFoodInFlight = false;

function toSafeNumber(value) {
    if (value === undefined || value === null) return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'bigint') {
        const numeric = Number(value);
        return Number.isSafeInteger(numeric) ? numeric : 0;
    }
    if (typeof value.toNumber === 'function') {
        const numeric = value.toNumber();
        return Number.isSafeInteger(numeric) ? numeric : 0;
    }
    if (typeof value.toString === 'function') {
        const numeric = Number(value.toString());
        return Number.isSafeInteger(numeric) ? numeric : 0;
    }
    return 0;
}

function extractTopLevelVarint(bodyBytes, fieldNo) {
    const targetField = Math.max(1, Number.parseInt(fieldNo, 10) || 0);
    if (!bodyBytes || bodyBytes.length === 0 || targetField <= 0) return null;
    try {
        const reader = protobuf.Reader.create(Buffer.from(bodyBytes));
        while (reader.pos < reader.len) {
            const key = reader.uint32();
            const currentField = key >>> 3;
            const wireType = key & 7;
            if (currentField === targetField && wireType === 0) {
                return toSafeNumber(reader.uint64());
            }
            reader.skipType(wireType);
        }
    } catch {
        return null;
    }
    return null;
}

function normalizeDogFoodItem(food) {
    const id = toSafeNumber(food && food.id);
    const duration = toSafeNumber(food && food.duration);
    const count = Math.max(0, Number(food && food.count) || 0);
    const item = getItemById(id) || null;
    const itemType = item ? (Number(item.type) || 0) : 0;

    return {
        id,
        duration,
        count,
        name: item && item.name ? String(item.name) : `狗粮 #${id}`,
        image: getItemImageById(id) || '',
        itemType,
        description: item && item.desc ? String(item.desc) : '',
        effectDescription: item && item.effectDesc ? String(item.effectDesc) : '',
        interactionType: item && item.interaction_type ? String(item.interaction_type) : '',
        configCanUse: !!(item && Number(item.can_use) > 0),
        recognizedDogFood: itemType === DOG_FOOD_ITEM_TYPE,
        writeSupported: itemType === DOG_FOOD_ITEM_TYPE && SUPPORTED_DOG_FOOD_IDS.has(id),
        staticMetadataSource: item ? 'ItemInfo' : 'none',
    };
}

function normalizeDogInfoReply(decoded, rawBody) {
    const reply = decoded && typeof decoded === 'object' ? decoded : {};
    const dogs = (Array.isArray(reply.dogs) ? reply.dogs : []).map(dog => ({
        id: toSafeNumber(dog && dog.id),
        expireTime: toSafeNumber(dog && dog.expire_time),
        status: Number(dog && dog.status) || 0,
        level: Number(dog && dog.level) || 0,
        active: Number(dog && dog.active) || 0,
    }));
    const foods = (Array.isArray(reply.foods) ? reply.foods : []).map(normalizeDogFoodItem);
    const claimableGiftCount = extractTopLevelVarint(rawBody, 7);

    return {
        dogs,
        coin: toSafeNumber(reply.coin),
        protectTime: toSafeNumber(reply.protect_time),
        foods,
        claimableGiftCount: claimableGiftCount === null ? null : Math.max(0, claimableGiftCount),
        protocol: {
            service: DOG_SERVICE,
            method: 'GetDogInfo',
            requestBody: 'empty',
            claimableField: 7,
            readOnly: true,
            foodWriteSupported: true,
            foodWriteEvidence: 'request-wire-proven-fixed-arg2',
            foodWriteMethod: ADD_FOOD_METHOD,
            foodWriteRequest: {
                foodIdField: 1,
                field2: 2,
                field2Semantics: 'unproven',
                fixedObservedValue: ADD_FOOD_OBSERVED_ARG2,
            },
            manualOnly: true,
            supportedFoodIds: [...SUPPORTED_DOG_FOOD_IDS],
            foodWriteReason: '官方客户端实机已证实 AddFood field 1=狗粮ID、field 2=1。FAR2 不猜 field 2 语义，只固定复现值 1，并仅开放单次手动喂食。',
        },
    };
}

async function getDogInfoOverview() {
    if (!types.GetDogInfoReply) throw new Error('Dog protobuf not loaded');
    // Own-account query: official-client evidence uses an empty body.
    const { body } = await sendMsgAsync(DOG_SERVICE, 'GetDogInfo', Buffer.alloc(0));
    const decoded = types.GetDogInfoReply.decode(body);
    return normalizeDogInfoReply(decoded, body);
}

function createDogFeedError(message, statusCode = 409) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function normalizeFoodId(value) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) {
        throw createDogFeedError('无效狗粮 ID', 400);
    }
    return id;
}

function findDogFood(overview, foodId) {
    const foods = Array.isArray(overview && overview.foods) ? overview.foods : [];
    return foods.find(food => Number(food && food.id) === foodId) || null;
}

function requireFeedableDogFood(overview, foodId) {
    const food = findDogFood(overview, foodId);
    if (!food) throw createDogFeedError('当前 DogInfo 已不再返回该狗粮，请刷新后重试');
    if (!food.recognizedDogFood || Number(food.itemType) !== DOG_FOOD_ITEM_TYPE) {
        throw createDogFeedError('该物品未被静态配置识别为狗粮，已拒绝写入');
    }
    if (!SUPPORTED_DOG_FOOD_IDS.has(foodId)) {
        throw createDogFeedError('该狗粮 ID 尚未进入 P7E 写入白名单，已拒绝写入');
    }
    if (Number(food.count) <= 0) {
        throw createDogFeedError('当前狗粮库存不足，请刷新后重试');
    }
    return food;
}

function getAddFoodRequestType() {
    const root = getRoot();
    if (!root) throw new Error('Dog protobuf root not loaded');
    return root.lookupType('gamepb.dogpb.AddFoodRequest');
}

function buildAddFoodRequestBody(foodId) {
    const id = normalizeFoodId(foodId);
    const type = getAddFoodRequestType();
    return Buffer.from(type.encode(type.create({
        food_id: id,
        arg2: ADD_FOOD_OBSERVED_ARG2,
    })).finish());
}

function buildFeedVerification(before, after, foodId) {
    const beforeFood = findDogFood(before, foodId);
    const afterFood = findDogFood(after, foodId);
    const beforeCount = Math.max(0, Number(beforeFood && beforeFood.count) || 0);
    const afterCount = afterFood ? Math.max(0, Number(afterFood.count) || 0) : 0;
    const consumed = Math.max(0, beforeCount - afterCount);
    const beforeProtectTime = Math.max(0, Number(before && before.protectTime) || 0);
    const afterProtectTime = Math.max(0, Number(after && after.protectTime) || 0);
    return {
        verified: consumed > 0,
        consumed,
        beforeCount,
        afterCount,
        beforeProtectTime,
        afterProtectTime,
        protectTimeDelta: afterProtectTime - beforeProtectTime,
    };
}

async function feedDogFoodOnce(foodId, deps = {}) {
    const id = normalizeFoodId(foodId);
    if (addFoodInFlight) throw createDogFeedError('已有一笔狗粮喂食正在执行，请等待完成后再试');

    const readOverview = typeof deps.getDogInfoOverview === 'function' ? deps.getDogInfoOverview : getDogInfoOverview;
    const send = typeof deps.sendMsgAsync === 'function' ? deps.sendMsgAsync : sendMsgAsync;
    const wait = typeof deps.sleep === 'function' ? deps.sleep : sleep;

    addFoodInFlight = true;
    try {
        const before = await readOverview();
        const food = requireFeedableDogFood(before, id);
        const requestBody = buildAddFoodRequestBody(id);

        // Exact regression pin for the captured 1-day food sample.
        if (id === 90004 && requestBody.toString('hex') !== '0894bf051001') {
            throw new Error('AddFood wire regression: 90004 request no longer matches official-client evidence');
        }

        const response = await send(DOG_SERVICE, ADD_FOOD_METHOD, requestBody);

        // Read-only verification only; never retry the write automatically.
        let after = await readOverview();
        let verification = buildFeedVerification(before, after, id);
        if (!verification.verified) {
            await wait(300);
            after = await readOverview();
            verification = buildFeedVerification(before, after, id);
        }

        log('护主犬', `手动喂食 ${food.name} x1${verification.verified ? '，库存复核通过' : '，RPC成功但库存变化未确认'}`, {
            module: 'dog',
            event: '手动喂食',
            result: verification.verified ? 'verified' : 'accepted_unverified',
            foodId: id,
            beforeCount: verification.beforeCount,
            afterCount: verification.afterCount,
        });

        return {
            ok: true,
            foodId: id,
            foodName: food.name,
            manualOnly: true,
            requestedUnits: 1,
            requestEvidence: {
                service: DOG_SERVICE,
                method: ADD_FOOD_METHOD,
                field1FoodId: id,
                field2ObservedValue: ADD_FOOD_OBSERVED_ARG2,
                field2Semantics: 'unproven',
            },
            replyBodyLength: response && response.body ? response.body.length : 0,
            verification,
            before,
            after,
        };
    } finally {
        addFoodInFlight = false;
    }
}

function resetDogFeedLockForTest() {
    addFoodInFlight = false;
}

module.exports = {
    DOG_SERVICE,
    DOG_FOOD_ITEM_TYPE,
    ADD_FOOD_METHOD,
    ADD_FOOD_OBSERVED_ARG2,
    SUPPORTED_DOG_FOOD_IDS,
    toSafeNumber,
    extractTopLevelVarint,
    normalizeDogFoodItem,
    normalizeDogInfoReply,
    getDogInfoOverview,
    normalizeFoodId,
    findDogFood,
    requireFeedableDogFood,
    buildAddFoodRequestBody,
    buildFeedVerification,
    feedDogFoodOnce,
    resetDogFeedLockForTest,
};
