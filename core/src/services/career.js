const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const gameConfig = require('../config/gameConfig');

const CAREER_SERVICE = 'gamepb.careerpb.CareerService';

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

function readVarint(buffer, offset) {
    let value = 0n;
    let shift = 0n;
    let pos = offset;
    while (pos < buffer.length && shift <= 70n) {
        const byte = BigInt(buffer[pos]);
        value |= (byte & 0x7fn) << shift;
        pos += 1;
        if ((byte & 0x80n) === 0n) return { value, next: pos, ok: true };
        shift += 7n;
    }
    return { value: 0n, next: offset, ok: false };
}

function scanProtobufMessage(input) {
    const buffer = Buffer.from(input || []);
    const fields = [];
    let pos = 0;
    while (pos < buffer.length) {
        const tag = readVarint(buffer, pos);
        if (!tag.ok || tag.next <= pos) break;
        pos = tag.next;
        const field = Number(tag.value >> 3n);
        const wire = Number(tag.value & 0x7n);
        if (field <= 0) break;

        if (wire === 0) {
            const value = readVarint(buffer, pos);
            if (!value.ok) break;
            fields.push({ field, wire, value: value.value });
            pos = value.next;
            continue;
        }
        if (wire === 2) {
            const lengthValue = readVarint(buffer, pos);
            if (!lengthValue.ok) break;
            const length = Number(lengthValue.value);
            const start = lengthValue.next;
            const end = start + length;
            if (!Number.isSafeInteger(length) || length < 0 || end > buffer.length) break;
            fields.push({ field, wire, bytes: Buffer.from(buffer.subarray(start, end)) });
            pos = end;
            continue;
        }
        if (wire === 1) {
            if (pos + 8 > buffer.length) break;
            fields.push({ field, wire, bytes: Buffer.from(buffer.subarray(pos, pos + 8)) });
            pos += 8;
            continue;
        }
        if (wire === 5) {
            if (pos + 4 > buffer.length) break;
            fields.push({ field, wire, bytes: Buffer.from(buffer.subarray(pos, pos + 4)) });
            pos += 4;
            continue;
        }
        break;
    }
    return fields;
}

function decodeText(bytes) {
    if (!bytes) return '';
    const text = Buffer.from(bytes).toString('utf8').replace(/\u0000/g, '').trim();
    if (!text || text.includes('\ufffd')) return '';
    return text;
}

function decodeNestedStat(bytes) {
    const item = { fruit_id: 0, count: 0, level: 0 };
    for (const field of scanProtobufMessage(bytes)) {
        if (field.wire !== 0) continue;
        const numeric = toSafeNumber(field.value);
        if (field.field === 1) item.fruit_id = numeric;
        else if (field.field === 2) item.count = numeric;
        else if (field.field === 4) item.level = numeric;
    }
    return item;
}

function decodeCareerReplyRaw(rawBody) {
    const reply = {
        items: [],
        level_stats: [],
        name: '',
        avatar: '',
        level: 0,
        exp: 0,
        gid: 0,
        openid: '',
        achieved_levels: 0,
        stats_total: 0,
        stats_count: 0,
    };

    for (const field of scanProtobufMessage(rawBody)) {
        if (field.wire === 0) {
            const numeric = toSafeNumber(field.value);
            if (field.field === 2) reply.stats_total = numeric;
            else if (field.field === 3) reply.stats_count = numeric;
            else if (field.field === 9) reply.level = numeric;
            else if (field.field === 10) reply.exp = numeric;
            else if (field.field === 11) reply.gid = numeric;
            else if (field.field === 13) reply.achieved_levels = numeric;
            continue;
        }
        if (field.wire !== 2 || !field.bytes) continue;
        if (field.field === 4) reply.name = decodeText(field.bytes);
        else if (field.field === 5) reply.avatar = decodeText(field.bytes);
        else if (field.field === 15) reply.openid = decodeText(field.bytes);
        else if (field.field === 1) {
            const item = decodeNestedStat(field.bytes);
            if (item.fruit_id > 0) reply.items.push(item);
        }
        else if (field.field === 12) {
            const item = decodeNestedStat(field.bytes);
            if (item.fruit_id > 0) reply.level_stats.push(item);
        }
    }
    return reply;
}

function normalizeTypedCareerReply(decoded) {
    const reply = decoded && typeof decoded === 'object' ? decoded : {};
    return {
        items: (Array.isArray(reply.items) ? reply.items : []).map(item => ({
            fruit_id: toSafeNumber(item && item.fruit_id),
            count: toSafeNumber(item && item.count),
        })),
        level_stats: (Array.isArray(reply.level_stats) ? reply.level_stats : []).map(item => ({
            fruit_id: toSafeNumber(item && item.fruit_id),
            count: toSafeNumber(item && item.count),
            level: Number(item && item.level) || 0,
        })),
        name: String(reply.name || '').trim(),
        avatar: String(reply.avatar || '').trim(),
        level: Number(reply.level) || 0,
        exp: toSafeNumber(reply.exp),
        gid: toSafeNumber(reply.gid),
        openid: String(reply.openid || '').trim(),
        achieved_levels: Number(reply.achieved_levels) || 0,
        stats_total: toSafeNumber(reply.stats_total),
        stats_count: toSafeNumber(reply.stats_count),
    };
}

function decorateItem(raw) {
    const fruitId = toSafeNumber(raw && raw.fruit_id);
    const count = toSafeNumber(raw && raw.count);
    const info = fruitId > 0 && typeof gameConfig.getItemById === 'function'
        ? gameConfig.getItemById(fruitId)
        : null;
    const fallbackName = fruitId > 0 && typeof gameConfig.getFruitName === 'function'
        ? gameConfig.getFruitName(fruitId)
        : '';
    const image = fruitId > 0 && typeof gameConfig.getItemImageById === 'function'
        ? gameConfig.getItemImageById(fruitId)
        : '';
    return {
        id: fruitId,
        count,
        name: String((info && info.name) || fallbackName || `物品 ${fruitId}`).trim(),
        image: String(image || ''),
        level: Number(info && info.level) || 0,
        rarity: Number(info && info.rarity) || 0,
    };
}

function decorateLevelStat(raw) {
    const base = decorateItem(raw);
    return {
        id: base.id,
        count: base.count,
        name: base.name,
        image: base.image,
        level: Number(raw && raw.level) || 0,
    };
}

function normalizeCareerOverview(reply, rawBodyLength = 0, decodeMode = 'typed') {
    const items = (Array.isArray(reply && reply.items) ? reply.items : [])
        .map(decorateItem)
        .filter(item => item.id > 0 && item.count > 0)
        .sort((a, b) => b.count - a.count || a.id - b.id);
    const levelStats = (Array.isArray(reply && reply.level_stats) ? reply.level_stats : [])
        .map(decorateLevelStat)
        .filter(item => item.id > 0);

    return {
        player: {
            gid: toSafeNumber(reply && reply.gid),
            name: String((reply && reply.name) || '').trim(),
            avatar: String((reply && reply.avatar) || '').trim(),
            openid: String((reply && reply.openid) || '').trim(),
            level: Number(reply && reply.level) || 0,
            exp: toSafeNumber(reply && reply.exp),
        },
        items,
        levelStats,
        meta: {
            achievedLevels: Number(reply && reply.achieved_levels) || 0,
            statsTotal: toSafeNumber(reply && reply.stats_total),
            statsCount: toSafeNumber(reply && reply.stats_count),
            rawBodyLength: Math.max(0, Number(rawBodyLength) || 0),
            decodeMode,
        },
        protocol: {
            service: CAREER_SERVICE,
            method: 'CareerInfoGet',
            readOnly: true,
        },
    };
}

async function getCareerOverview() {
    if (!types.CareerInfoGetRequest || !types.CareerInfoGetReply) {
        throw new Error('Career protobuf not loaded');
    }
    const request = types.CareerInfoGetRequest.encode(types.CareerInfoGetRequest.create({})).finish();
    const { body } = await sendMsgAsync(CAREER_SERVICE, 'CareerInfoGet', request, 10000);

    let normalized;
    try {
        normalized = normalizeTypedCareerReply(types.CareerInfoGetReply.decode(body));
    } catch {
        const raw = decodeCareerReplyRaw(body);
        return normalizeCareerOverview(raw, body.length, 'raw');
    }

    if (normalized.items.length === 0) {
        const raw = decodeCareerReplyRaw(body);
        if (raw.items.length > 0) {
            return normalizeCareerOverview(raw, body.length, 'raw_fallback');
        }
    }
    return normalizeCareerOverview(normalized, body.length, 'typed');
}

module.exports = {
    CAREER_SERVICE,
    toSafeNumber,
    readVarint,
    scanProtobufMessage,
    decodeCareerReplyRaw,
    normalizeTypedCareerReply,
    normalizeCareerOverview,
    getCareerOverview,
};
