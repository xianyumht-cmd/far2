const { Buffer } = require('node:buffer');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * FAR2 神秘商店动态自动购买 - 正式版 v1
 *
 * 已实机验证：
 * - GetActiveNPC 当前返回 top.field2.nested.field1 = 1004
 * - Buy(1004) 请求正文 = 08ec07
 * - 2026-08-24 13:22:21 +08 实际购买成功
 *
 * 正式策略：
 * 1. GetActiveNPC
 * 2. 动态读取 top.field2.nested.field1 作为当前购买 ID
 * 3. 校验活动标志、时间窗口、ID 范围
 * 4. 每个活动实例只允许一次已确认成功购买
 * 5. 服务端明确拒绝后，同一活动实例不再猜其它字段/ID
 * 6. 成功才更新“今日购买 +1 / 最近成功”
 */

const SERVICE = 'gamepb.mysteryshoppb.MysteryShopService';
const GET_ACTIVE_METHOD = 'GetActiveNPC';
const BUY_METHOD = 'Buy';

const CHECK_COOLDOWN_MS = 15 * 1000;
const PROBE_TIMEOUT_MS = 8000;
const BUY_TIMEOUT_MS = 8000;
const CLOCK_SKEW_SEC = 300;
const ERROR_LOG_COOLDOWN_MS = 5 * 60 * 1000;

let inFlight = false;
let lastCheckAt = 0;
let lastResult = 'idle';
let lastCandidateId = 0;
let lastBodySha256 = '';
let lastErrorLogAt = 0;

function getNetwork() {
    return require('../utils/network');
}

function getConfig() {
    return require('../config/config').CONFIG;
}

function writeLog(tag, message, meta) {
    return require('../utils/utils').log(tag, message, meta);
}

function getStatsModule() {
    return require('./stats');
}

function getDataDir() {
    return process.env.FARM_DATA_DIR || path.join(__dirname, '../../data');
}

function getGuardDir() {
    return path.join(getDataDir(), 'mystery-shop-auto-state');
}

function safeAccountId() {
    return String(process.env.FARM_ACCOUNT_ID || 'unknown').replace(/[^0-9A-Za-z_.-]/g, '_');
}

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function sanitize(value) {
    return String(value == null ? '' : value)
        .replace(/(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._~+/=-]+/ig, '$1<REDACTED>')
        .replace(/(provider[_-]?token\s*[:=]\s*)[A-Za-z0-9._~+/=-]{8,}/ig, '$1<REDACTED>')
        .replace(/(\btoken\s*[:=]\s*)[A-Za-z0-9._~+/=-]{8,}/ig, '$1<REDACTED>')
        .replace(/(\bcode\s*[:=]\s*)[A-Za-z0-9._~+/=-]{20,}/ig, '$1<REDACTED>')
        .slice(0, 1000);
}

function safeError(error) {
    return {
        name: sanitize(error && error.name),
        message: sanitize(error && error.message),
        code: sanitize(error && error.code),
    };
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function getGuardPath() {
    return path.join(getGuardDir(), `${safeAccountId()}.json`);
}

function loadGuard() {
    try {
        const file = getGuardPath();
        if (!fs.existsSync(file)) return null;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function saveGuard(state) {
    ensureDir(getGuardDir());
    const file = getGuardPath();
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, file);
}

function setUiStatus(status, meta = {}) {
    try {
        const stats = getStatsModule();
        if (stats && typeof stats.recordMysteryShopStatus === 'function') {
            stats.recordMysteryShopStatus(status, meta);
        }
    } catch {
        // UI 统计异常不能阻断购买主链路。
    }
}

function isQqRuntime() {
    const CONFIG = getConfig();
    return String(CONFIG.platform || 'qq').trim().toLowerCase() === 'qq';
}

function encodeVarint(value) {
    let n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`invalid varint: ${value}`);
    const out = [];
    do {
        let byte = n & 0x7F;
        n = Math.floor(n / 128);
        if (n > 0) byte |= 0x80;
        out.push(byte);
    } while (n > 0);
    return Buffer.from(out);
}

function buildBuyRequest(id) {
    return Buffer.concat([Buffer.from([0x08]), encodeVarint(id)]);
}

function readVarint(buf, start) {
    let value = 0n;
    let shift = 0n;
    let pos = start;

    while (pos < buf.length && pos < start + 10) {
        const byte = BigInt(buf[pos++]);
        value |= (byte & 0x7Fn) << shift;
        if ((byte & 0x80n) === 0n) {
            return {
                value: value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString(),
                next: pos,
            };
        }
        shift += 7n;
    }

    throw new Error(`invalid varint at ${start}`);
}

function parseFields(buf) {
    const out = [];
    let pos = 0;

    while (pos < buf.length) {
        const key = readVarint(buf, pos);
        pos = key.next;
        const keyNum = typeof key.value === 'number' ? key.value : Number(key.value);
        const field = Math.floor(keyNum / 8);
        const wire = keyNum & 7;

        if (!Number.isFinite(field) || field <= 0) {
            throw new Error(`invalid field at ${pos}`);
        }

        if (wire === 0) {
            const value = readVarint(buf, pos);
            pos = value.next;
            out.push({ field, wire, value: value.value });
        } else if (wire === 2) {
            const len = readVarint(buf, pos);
            pos = len.next;
            if (typeof len.value !== 'number' || len.value < 0 || pos + len.value > buf.length) {
                throw new Error(`invalid length field=${field}`);
            }
            out.push({ field, wire, bytes: buf.subarray(pos, pos + len.value) });
            pos += len.value;
        } else if (wire === 1) {
            if (pos + 8 > buf.length) throw new Error('truncated fixed64');
            out.push({ field, wire, bytes: buf.subarray(pos, pos + 8) });
            pos += 8;
        } else if (wire === 5) {
            if (pos + 4 > buf.length) throw new Error('truncated fixed32');
            out.push({ field, wire, bytes: buf.subarray(pos, pos + 4) });
            pos += 4;
        } else {
            throw new Error(`unsupported wire=${wire}`);
        }
    }

    return out;
}

function getVarint(fields, number, fallback = null) {
    const row = fields.find(item => item.field === number && item.wire === 0);
    return row ? row.value : fallback;
}

function getBytes(fields, number) {
    const row = fields.find(item => item.field === number && item.wire === 2);
    return row ? row.bytes : null;
}

function decodeActiveNpc(body) {
    const top = parseFields(body);

    const active = Number(getVarint(top, 1, 0)) || 0;
    const descriptorBytes = getBytes(top, 2);
    const startAt = Number(getVarint(top, 3, 0)) || 0;
    const endAt = Number(getVarint(top, 4, 0)) || 0;

    if (!descriptorBytes || descriptorBytes.length === 0) {
        return {
            active,
            startAt,
            endAt,
            candidateId: 0,
            observedPurchasedMarker: 0,
            descriptor: null,
        };
    }

    const nested = parseFields(descriptorBytes);
    const descriptor = {};
    for (const number of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
        const value = getVarint(nested, number, null);
        if (value !== null) descriptor[`field${number}`] = value;
    }

    return {
        active,
        startAt,
        endAt,
        candidateId: Number(getVarint(nested, 1, 0)) || 0,
        // 实机 Buy 成功响应里 field8 从缺失变为 1。
        // 这里仅作为“已购买保护标记”使用，不把它声明成官方字段语义。
        observedPurchasedMarker: Number(getVarint(nested, 8, 0)) || 0,
        descriptor,
    };
}

function getActivityKey(decoded) {
    return [
        Number(decoded.startAt) || 0,
        Number(decoded.endAt) || 0,
        Number(decoded.candidateId) || 0,
    ].join(':');
}

function validateCandidate(decoded) {
    const nowSec = Math.floor(Date.now() / 1000);

    if (decoded.active !== 1) {
        return { ok: false, reason: `active_flag_${decoded.active}` };
    }

    if (!Number.isSafeInteger(decoded.candidateId) || decoded.candidateId <= 0 || decoded.candidateId > 10000000) {
        return { ok: false, reason: `candidate_invalid_${decoded.candidateId}` };
    }

    if (decoded.startAt > 0 && nowSec + CLOCK_SKEW_SEC < decoded.startAt) {
        return { ok: false, reason: 'activity_not_started' };
    }

    if (decoded.endAt > 0 && nowSec - CLOCK_SKEW_SEC > decoded.endAt) {
        return { ok: false, reason: 'activity_expired' };
    }

    return { ok: true, reason: 'validated' };
}

function isNormalInactiveProbeError(error) {
    const message = sanitize(error && error.message);
    return /MysteryShopService\.GetActiveNPC.*code=/i.test(message);
}

async function getActiveNpcRaw() {
    const { sendMsgAsync } = getNetwork();
    const reply = await sendMsgAsync(
        SERVICE,
        GET_ACTIVE_METHOD,
        Buffer.alloc(0),
        PROBE_TIMEOUT_MS
    );
    return Buffer.from((reply && reply.body) || []);
}

async function buyCandidate(candidateId) {
    const { sendMsgAsync } = getNetwork();
    return sendMsgAsync(
        SERVICE,
        BUY_METHOD,
        buildBuyRequest(candidateId),
        BUY_TIMEOUT_MS
    );
}

function quietRepeatedError(message, meta) {
    const now = Date.now();
    if (now - lastErrorLogAt < ERROR_LOG_COOLDOWN_MS) return;
    lastErrorLogAt = now;
    writeLog('神秘商店', message, meta);
}

async function checkAndBuyMysteryShop(force = false) {
    if (!isQqRuntime()) {
        return { checked: false, bought: false, reason: 'skip_non_qq' };
    }

    if (inFlight) {
        return { checked: false, bought: false, reason: 'in_flight' };
    }

    const now = Date.now();
    if (!force && now - lastCheckAt < CHECK_COOLDOWN_MS) {
        return { checked: false, bought: false, reason: 'check_cooldown' };
    }

    inFlight = true;
    lastCheckAt = now;

    try {
        let body;
        try {
            body = await getActiveNpcRaw();
        } catch (error) {
            lastResult = 'probe_failed';

            if (isNormalInactiveProbeError(error)) {
                setUiStatus('waiting');
                return {
                    checked: true,
                    active: false,
                    bought: false,
                    reason: 'inactive_or_server_code',
                };
            }

            setUiStatus('waiting');
            quietRepeatedError(`检测失败: ${sanitize(error && error.message)}`, {
                module: 'mystery_shop',
                event: 'probe',
                result: 'error',
            });

            return {
                checked: true,
                active: false,
                bought: false,
                reason: lastResult,
                error: sanitize(error && error.message),
            };
        }

        if (body.length <= 0) {
            lastResult = 'inactive_empty';
            setUiStatus('waiting');
            return { checked: true, active: false, bought: false, reason: lastResult };
        }

        lastBodySha256 = sha256(body);

        let decoded;
        try {
            decoded = decodeActiveNpc(body);
        } catch (error) {
            lastResult = 'decode_failed';
            setUiStatus('failed', { error: `GetActiveNPC解析失败: ${sanitize(error.message)}` });
            quietRepeatedError(`GetActiveNPC解析失败: ${sanitize(error.message)}`, {
                module: 'mystery_shop',
                event: 'decode',
                result: 'error',
            });
            return { checked: true, active: true, bought: false, reason: lastResult };
        }

        lastCandidateId = decoded.candidateId;
        const validation = validateCandidate(decoded);

        if (!validation.ok) {
            lastResult = 'candidate_rejected_locally';
            setUiStatus('failed', { error: `动态ID校验失败: ${validation.reason}` });
            return {
                checked: true,
                active: true,
                bought: false,
                reason: lastResult,
                candidateId: decoded.candidateId,
            };
        }

        const activityKey = getActivityKey(decoded);
        const guard = loadGuard();

        // 成功 Buy 的实际响应里 descriptor.field8 出现 1。
        // 即使本地 guard 丢失，也用该观测值阻止再次购买。
        if (decoded.observedPurchasedMarker > 0) {
            lastResult = 'already_purchased_marker';
            saveGuard({
                version: 1,
                accountId: safeAccountId(),
                activityKey,
                candidateId: decoded.candidateId,
                startAt: decoded.startAt,
                endAt: decoded.endAt,
                status: 'observed_purchased',
                observedPurchasedMarker: decoded.observedPurchasedMarker,
                updatedAt: Date.now(),
            });
            setUiStatus('waiting');
            return {
                checked: true,
                active: true,
                bought: false,
                reason: lastResult,
                candidateId: decoded.candidateId,
            };
        }

        if (guard && String(guard.activityKey || '') === activityKey) {
            if (['success', 'observed_purchased'].includes(String(guard.status || ''))) {
                lastResult = 'already_purchased_guard';
                setUiStatus('waiting');
                return {
                    checked: true,
                    active: true,
                    bought: false,
                    reason: lastResult,
                    candidateId: decoded.candidateId,
                };
            }

            if (String(guard.status || '') === 'rejected') {
                lastResult = 'already_rejected_guard';
                setUiStatus('failed', {
                    error: String(guard.error && guard.error.message || '本轮神秘商店购买已被服务端拒绝'),
                });
                return {
                    checked: true,
                    active: true,
                    bought: false,
                    reason: lastResult,
                    candidateId: decoded.candidateId,
                };
            }

            // “attempting/uncertain” 不立即重试，先等服务器状态变化。
            if (['attempting', 'uncertain'].includes(String(guard.status || ''))) {
                lastResult = 'awaiting_post_attempt_state';
                setUiStatus('waiting');
                return {
                    checked: true,
                    active: true,
                    bought: false,
                    reason: lastResult,
                    candidateId: decoded.candidateId,
                };
            }
        }

        const request = buildBuyRequest(decoded.candidateId);

        // 在 RPC 前先写 guard。即便 Worker 此刻崩溃/重启，也不会对同一活动盲目重复下单。
        saveGuard({
            version: 1,
            accountId: safeAccountId(),
            activityKey,
            candidateId: decoded.candidateId,
            startAt: decoded.startAt,
            endAt: decoded.endAt,
            bodySha256: lastBodySha256,
            buyPayloadHex: request.toString('hex'),
            status: 'attempting',
            attemptAt: Date.now(),
        });

        try {
            const reply = await buyCandidate(decoded.candidateId);
            const successAt = Date.now();
            const replyBody = Buffer.from((reply && reply.body) || []);

            saveGuard({
                version: 1,
                accountId: safeAccountId(),
                activityKey,
                candidateId: decoded.candidateId,
                startAt: decoded.startAt,
                endAt: decoded.endAt,
                bodySha256: lastBodySha256,
                buyPayloadHex: request.toString('hex'),
                status: 'success',
                successAt,
                replyBodyLength: replyBody.length,
                replyBodySha256: replyBody.length ? sha256(replyBody) : '',
            });

            lastResult = 'success';

            // 唯一统计入口：服务端 Buy resolve 成功后才 +1。
            setUiStatus('success', {
                successAt,
                npcId: decoded.candidateId,
            });

            writeLog('神秘商店', `检测到神秘商店，已自动购买 (ID=${decoded.candidateId})`, {
                module: 'mystery_shop',
                event: 'auto_buy',
                result: 'ok',
                candidateId: decoded.candidateId,
                activityKey,
                bodySha256: lastBodySha256,
            });

            return {
                checked: true,
                active: true,
                bought: true,
                candidateId: decoded.candidateId,
                activityKey,
            };
        } catch (error) {
            const errorObj = safeError(error);
            const serverRejected = /MysteryShopService\.Buy.*code=/i.test(errorObj.message);

            saveGuard({
                version: 1,
                accountId: safeAccountId(),
                activityKey,
                candidateId: decoded.candidateId,
                startAt: decoded.startAt,
                endAt: decoded.endAt,
                bodySha256: lastBodySha256,
                buyPayloadHex: request.toString('hex'),
                status: serverRejected ? 'rejected' : 'uncertain',
                failedAt: Date.now(),
                error: errorObj,
            });

            lastResult = serverRejected ? 'buy_rejected' : 'buy_uncertain';

            if (serverRejected) {
                setUiStatus('failed', { error: errorObj.message });
            } else {
                // 超时/断线无法判断服务端是否已经完成购买，先保持等待，
                // 不立即重试，避免重复购买。
                setUiStatus('waiting');
            }

            quietRepeatedError(
                `自动购买${serverRejected ? '被拒绝' : '结果不确定'} ID=${decoded.candidateId}: ${errorObj.message}`,
                {
                    module: 'mystery_shop',
                    event: 'auto_buy',
                    result: serverRejected ? 'error' : 'uncertain',
                    candidateId: decoded.candidateId,
                    activityKey,
                }
            );

            return {
                checked: true,
                active: true,
                bought: false,
                candidateId: decoded.candidateId,
                activityKey,
                reason: lastResult,
                error: errorObj.message,
            };
        }
    } finally {
        inFlight = false;
    }
}

function getMysteryShopAutoBuyState() {
    return {
        enabled: true,
        production: true,
        qqOnly: true,
        service: SERVICE,
        getActiveMethod: GET_ACTIVE_METHOD,
        buyMethod: BUY_METHOD,
        candidateRule: 'GetActiveNPC.top.field2.nested.field1',
        checkCooldownMs: CHECK_COOLDOWN_MS,
        lastCheckAt,
        lastCandidateId,
        lastBodySha256,
        lastResult,
        inFlight,
    };
}

module.exports = {
    SERVICE,
    buildBuyRequest,
    decodeActiveNpc,
    validateCandidate,
    getActivityKey,
    checkAndBuyMysteryShop,
    getMysteryShopAutoBuyState,
};
