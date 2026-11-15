/**
 * 活动写链（gamepb.activitypb.ActivityService / Operate）
 *
 * 背景：FAR2 原有的活动层是纯只读的（services/activity-readonly*.js），
 * proto 里也只有 List / GetGroup，所以「参与活动」这件事一直做不到。
 * 本文件补上 Operate 这一条写链，但刻意只实现已经在实机上验证过选择器的两种操作：
 *
 *   operate_type = 1  → 兑换商店购买，选择器 OperateRequest.101 {goods_id, count}
 *   operate_type = 21 → 星座点亮 / 一键领取，选择器 OperateRequest.119 {}（空消息）
 *
 * 其它 operate_type（随机商店 2/3、抽奖 9、青梅 4/14/15/16、公益红花 35~38 …）
 * 选择器语义尚未在本仓库内验证，一律不实现、不盲打——保持 fail-closed。
 *
 * 写链纪律（与仓库既有原则一致）：
 *   写前读取 → 条件校验 → 单次写入 → 回包结构校验 → 写后复核
 * 任何一步不确定就抛错退出，不重试。默认 dryRun：即使开启也只返回计划不落包。
 *
 * 选择性引入的语义（实机抓包 / 同源仓库交叉验证）：
 *   OperateRequest.1   activity_id
 *   OperateRequest.2   operate_type
 *   OperateRequest.101 exchange_shop_operate {goods_id=1, count=2}
 *   OperateRequest.119 constellation_operate  {}（空消息）
 *   OperateReply.3     ActivityNode（与 GetGroupReply.group 同构）
 *   OperateReply.104   repeated corepb.Item rewards
 *   1034038            星座「当前无可领取节点」幂等信号
 */

const process = require('node:process');

const ACTIVITY_SERVICE = 'gamepb.activitypb.ActivityService';

const OPERATE_TYPE = {
    EXCHANGE_SHOP: 1,
    CONSTELLATION_CLAIM: 21,
};

const NO_REWARD_CODE = 1034038;

const MAX_COUNT_PER_OPERATE = 99;
const DEFAULT_MAX_PER_HOUR = 20;

function readPolicyFromEnv() {
    const enabled = String(process.env.FAR2_ACTIVITY_OPERATE || '') === '1';
    // 即使总开关打开，dryRun 仍默认开启；必须显式 FAR2_ACTIVITY_DRY_RUN=0 才真的发包。
    const dryRun = String(process.env.FAR2_ACTIVITY_DRY_RUN ?? '1') !== '0';
    const parsed = Number(process.env.FAR2_ACTIVITY_OPERATE_MAX_PER_HOUR);
    const maxPerHour = Number.isFinite(parsed) && parsed > 0
        ? Math.min(Math.floor(parsed), 200)
        : DEFAULT_MAX_PER_HOUR;
    return { enabled, dryRun, maxPerHour };
}

function positiveInt(value, field, max = Number.MAX_SAFE_INTEGER) {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric) || numeric <= 0 || numeric > max) {
        const err = new Error(`${field} 必须是 1..${max} 的整数`);
        err.code = 'ACTIVITY_PARAM_INVALID';
        throw err;
    }
    return numeric;
}

function classifyError(message) {
    const text = String(message || '');
    if (text.includes(String(NO_REWARD_CODE)) || text.includes('无可领取')) return 'no-reward';
    if (text.includes('重复') || text.includes('已领取')) return 'already-claimed';
    if (text.includes('不足') || text.includes('不够')) return 'insufficient';
    if (text.includes('售罄') || text.includes('库存')) return 'out-of-stock';
    if (text.includes('过期') || text.includes('结束')) return 'activity-closed';
    if (text.includes('未开始')) return 'activity-not-open';
    return 'unknown';
}

function createActivityOperateService(deps = {}) {
    const sendMsgAsync = deps.sendMsgAsync || require('../utils/network').sendMsgAsync;
    const types = deps.types || require('../utils/proto').types;
    const log = deps.log || require('../utils/utils').log;
    const now = deps.now || (() => Date.now());
    const policy = { ...readPolicyFromEnv(), ...(deps.policy || {}) };

    let mutationTail = Promise.resolve();
    let callTimestamps = [];

    function serializeMutation(operation) {
        const run = mutationTail.then(operation, operation);
        mutationTail = run.then(() => undefined, () => undefined);
        return run;
    }

    function takeBudget() {
        const cutoff = now() - 3600 * 1000;
        callTimestamps = callTimestamps.filter(ts => ts > cutoff);
        if (callTimestamps.length >= policy.maxPerHour) {
            const err = new Error(`活动写操作超出每小时预算（${policy.maxPerHour} 次）`);
            err.code = 'ACTIVITY_RATE_LIMITED';
            throw err;
        }
        callTimestamps.push(now());
    }

    function assertProtoReady() {
        for (const name of ['ActivityOperateRequest', 'ActivityOperateReply', 'ActivityGetGroupRequest', 'ActivityGetGroupReply']) {
            if (!types[name]) {
                const err = new Error(`活动 protobuf 未加载: ${name}`);
                err.code = 'ACTIVITY_PROTO_MISSING';
                throw err;
            }
        }
    }

    async function readGroup(activityId) {
        assertProtoReady();
        const request = types.ActivityGetGroupRequest.encode(
            types.ActivityGetGroupRequest.create({ id: activityId })
        ).finish();
        const { body } = await sendMsgAsync(ACTIVITY_SERVICE, 'GetGroup', request, 10000);
        return types.ActivityGetGroupReply.decode(body);
    }

    function findExchangeGoods(groupReply, goodsId) {
        const items = groupReply && groupReply.group && groupReply.group.exchange_shop
            ? groupReply.group.exchange_shop.items
            : null;
        if (!Array.isArray(items)) return null;
        return items.find(entry => Number(entry && entry.id) === goodsId) || null;
    }

    function buildOperateRequest({ activityId, operateType, exchangeShop, constellation }) {
        const payload = { activity_id: activityId, operate_type: operateType };
        if (exchangeShop) {
            payload.exchange_shop_operate = {
                goods_id: exchangeShop.goodsId,
                count: exchangeShop.count,
            };
        }
        if (constellation) {
            payload.constellation_operate = {};
        }
        return types.ActivityOperateRequest.encode(
            types.ActivityOperateRequest.create(payload)
        ).finish();
    }

    function verifyReply(reply, activityId, operateType) {
        const replyActivityId = Number(reply && reply.activity_id);
        const replyOperateType = Number(reply && reply.operate_type);
        if (replyActivityId !== activityId) {
            const err = new Error(`活动回包 activity_id 不匹配: ${replyActivityId} != ${activityId}`);
            err.code = 'ACTIVITY_REPLY_MISMATCH';
            throw err;
        }
        if (replyOperateType !== operateType) {
            const err = new Error(`活动回包 operate_type 不匹配: ${replyOperateType} != ${operateType}`);
            err.code = 'ACTIVITY_REPLY_MISMATCH';
            throw err;
        }
        const hasNode = !!(reply && reply.group);
        const rewards = Array.isArray(reply && reply.rewards) ? reply.rewards : [];
        if (!hasNode && rewards.length === 0) {
            const err = new Error('活动回包缺少 ActivityNode 与 rewards，无法确认写入结果');
            err.code = 'ACTIVITY_REPLY_EMPTY';
            throw err;
        }
        return rewards.map(item => ({ id: Number(item && item.id) || 0, count: Number(item && item.count) || 0 }));
    }

    async function executeOperate({ activityId, operateType, requestBytes }) {
        takeBudget();
        const { body } = await sendMsgAsync(ACTIVITY_SERVICE, 'Operate', requestBytes, 15000);
        const reply = types.ActivityOperateReply.decode(body);
        const rewards = verifyReply(reply, activityId, operateType);
        log('活动', `Operate 成功 activity=${activityId} type=${operateType} rewards=${rewards.length}`, {
            module: 'task',
            event: 'activity_operate',
            activityId,
            operateType,
            rewardCount: rewards.length,
        });
        return { activityId, operateType, rewards, reply };
    }

    function gate(operation) {
        const tag = `activity-operate:${operation}`;
        if (!policy.enabled) {
            const err = new Error(`${tag} 未开启（设置 FAR2_ACTIVITY_OPERATE=1 才允许活动写操作）`);
            err.code = 'ACTIVITY_OPERATE_DISABLED';
            throw err;
        }
    }

    /**
     * 兑换商店购买。写前必须读得到该活动分组与该商品，否则不发包。
     */
    async function exchangeGoods(options = {}) {
        return serializeMutation(async () => {
            const activityId = positiveInt(options.activityId, 'activityId');
            const goodsId = positiveInt(options.goodsId, 'goodsId');
            const count = positiveInt(options.count || 1, 'count', MAX_COUNT_PER_OPERATE);
            gate('exchange');

            const before = await readGroup(activityId);
            const goods = findExchangeGoods(before, goodsId);
            if (!goods) {
                const err = new Error(`活动 ${activityId} 的兑换商店里没有商品 ${goodsId}`);
                err.code = 'ACTIVITY_GOODS_NOT_FOUND';
                throw err;
            }
            if (goods.owned && Number(goods.status) === 2) {
                const err = new Error(`商品 ${goodsId} 已兑换过（owned=true, status=2），按 fail-closed 跳过`);
                err.code = 'ACTIVITY_GOODS_ALREADY_OWNED';
                throw err;
            }

            const requestBytes = buildOperateRequest({
                activityId,
                operateType: OPERATE_TYPE.EXCHANGE_SHOP,
                exchangeShop: { goodsId, count },
            });

            const plan = {
                activityId,
                goodsId,
                count,
                goodsName: String(goods.name || ''),
                cost: goods.cost ? { id: Number(goods.cost.id) || 0, count: Number(goods.cost.count) || 0 } : null,
                requestBytes: requestBytes.length,
            };

            if (policy.dryRun) {
                log('活动', `[dry-run] 兑换计划 activity=${activityId} goods=${goodsId} x${count}`, {
                    module: 'task',
                    event: 'activity_operate_dry_run',
                    ...plan,
                });
                return { ok: true, dryRun: true, plan, before: { owned: !!goods.owned, status: Number(goods.status) || 0 } };
            }

            const result = await executeOperate({
                activityId,
                operateType: OPERATE_TYPE.EXCHANGE_SHOP,
                requestBytes,
            });

            // 写后复核：重新读一次分组，确认该商品状态确实变了，避免「回包成功但服务端没落地」。
            const after = await readGroup(activityId);
            const afterGoods = findExchangeGoods(after, goodsId);
            return {
                ok: true,
                dryRun: false,
                plan,
                rewards: result.rewards,
                verified: {
                    found: !!afterGoods,
                    owned: afterGoods ? !!afterGoods.owned : null,
                    status: afterGoods ? Number(afterGoods.status) || 0 : null,
                    changed: !!afterGoods && (
                        !!afterGoods.owned !== !!goods.owned
                        || (Number(afterGoods.status) || 0) !== (Number(goods.status) || 0)
                    ),
                },
            };
        });
    }

    /**
     * 星座点亮 / 一键领取。幂等：1034038（当前无可领取节点）当作成功返回。
     */
    async function claimConstellation(options = {}) {
        return serializeMutation(async () => {
            const activityId = positiveInt(options.activityId, 'activityId');
            gate('constellation');

            const requestBytes = buildOperateRequest({
                activityId,
                operateType: OPERATE_TYPE.CONSTELLATION_CLAIM,
                constellation: true,
            });

            if (policy.dryRun) {
                log('活动', `[dry-run] 星座领取计划 activity=${activityId}`, {
                    module: 'task',
                    event: 'activity_operate_dry_run',
                    activityId,
                });
                return { ok: true, dryRun: true, plan: { activityId, operateType: OPERATE_TYPE.CONSTELLATION_CLAIM } };
            }

            try {
                const result = await executeOperate({
                    activityId,
                    operateType: OPERATE_TYPE.CONSTELLATION_CLAIM,
                    requestBytes,
                });
                return { ok: true, dryRun: false, rewards: result.rewards };
            } catch (error) {
                const kind = classifyError(error && error.message);
                if (kind === 'no-reward') {
                    return { ok: true, dryRun: false, idempotent: true, rewards: [] };
                }
                throw error;
            }
        });
    }

    function getPolicy() {
        return { ...policy };
    }

    function setPolicy(next = {}) {
        if (next.enabled !== undefined) policy.enabled = !!next.enabled;
        if (next.dryRun !== undefined) policy.dryRun = !!next.dryRun;
        if (next.maxPerHour !== undefined) {
            const value = Number(next.maxPerHour);
            if (Number.isSafeInteger(value) && value > 0) policy.maxPerHour = Math.min(value, 200);
        }
        return getPolicy();
    }

    function getState() {
        const cutoff = now() - 3600 * 1000;
        return {
            policy: getPolicy(),
            operatesLastHour: callTimestamps.filter(ts => ts > cutoff).length,
            supported: {
                exchange: OPERATE_TYPE.EXCHANGE_SHOP,
                constellation: OPERATE_TYPE.CONSTELLATION_CLAIM,
            },
        };
    }

    return {
        OPERATE_TYPE,
        NO_REWARD_CODE,
        exchangeGoods,
        claimConstellation,
        readGroup,
        getPolicy,
        setPolicy,
        getState,
        classifyError,
    };
}

module.exports = {
    ACTIVITY_SERVICE,
    OPERATE_TYPE,
    NO_REWARD_CODE,
    createActivityOperateService,
    defaultService: createActivityOperateService(),
};
