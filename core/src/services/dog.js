const protobuf = require('protobufjs');
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');

const DOG_SERVICE = 'gamepb.dogpb.DogService';

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

function normalizeDogInfoReply(decoded, rawBody) {
    const reply = decoded && typeof decoded === 'object' ? decoded : {};
    const dogs = (Array.isArray(reply.dogs) ? reply.dogs : []).map(dog => ({
        id: toSafeNumber(dog && dog.id),
        expireTime: toSafeNumber(dog && dog.expire_time),
        status: Number(dog && dog.status) || 0,
        level: Number(dog && dog.level) || 0,
        active: Number(dog && dog.active) || 0,
    }));
    const foods = (Array.isArray(reply.foods) ? reply.foods : []).map(food => ({
        id: toSafeNumber(food && food.id),
        duration: toSafeNumber(food && food.duration),
        count: Number(food && food.count) || 0,
    }));
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
        },
    };
}

async function getDogInfoOverview() {
    if (!types.GetDogInfoReply) {
        throw new Error('Dog protobuf not loaded');
    }

    // Own-account query: captured clients send an empty protobuf body. Do not add host_gid
    // until a real FAR2 capture requires it; this keeps P4A aligned with the proven read path.
    const { body } = await sendMsgAsync(DOG_SERVICE, 'GetDogInfo', Buffer.alloc(0));
    const decoded = types.GetDogInfoReply.decode(body);
    return normalizeDogInfoReply(decoded, body);
}

module.exports = {
    DOG_SERVICE,
    toSafeNumber,
    extractTopLevelVarint,
    normalizeDogInfoReply,
    getDogInfoOverview,
};
