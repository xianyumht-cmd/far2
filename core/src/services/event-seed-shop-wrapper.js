const { select2x2Reservations } = require('./farm-2x2');
const { shouldBlockShopFallback } = require('./event-seed-shop-guard');
const { log, logWarn } = require('../utils/utils');

function normalizeIds(value) {
    return [...new Set((Array.isArray(value) ? value : [])
        .map(item => Number(item) || 0)
        .filter(item => item > 0))];
}

function getUsableSpecialSeeds(prepass, userLevel) {
    const knownSeeds = prepass
        && prepass.inspection
        && prepass.inspection.inventory
        && Array.isArray(prepass.inspection.inventory.knownSeeds)
        ? prepass.inspection.inventory.knownSeeds
        : [];
    const level = Math.max(0, Number(userLevel) || 0);
    return knownSeeds.filter(row => (
        row
        && row.specialCandidate === true
        && Number(row.count) > 0
        && Number(row.requiredLevel || 0) <= level
    ));
}

function createEventSeedLogWarn(options = {}) {
    const logInfo = typeof options.log === 'function' ? options.log : log;
    const logWarning = typeof options.logWarn === 'function' ? options.logWarn : logWarn;

    return function eventSeedLogWarn(tag, message, meta = {}) {
        if (meta && meta.result === 'unresolved_seed_block_shop') {
            const adjusted = String(message || '').replace(
                '；为避免误买普通种子，本轮暂停商店补种并记录学习证据',
                '；已记录学习证据，安全门将按证据置信度决定是否暂停商店补种',
            );
            logInfo(tag, adjusted, {
                ...meta,
                result: 'unresolved_seed_guarded',
            });
            return;
        }
        logWarning(tag, message, meta);
    };
}

function createEventSeedShopWrapper(options = {}) {
    const runPrepass = options.runEventSeedPriorityBeforeShop;
    const plantFromShopBase = options.plantFromShopBase;
    const readAllLands = options.getAllLands;
    const plan2x2 = typeof options.select2x2Reservations === 'function'
        ? options.select2x2Reservations
        : select2x2Reservations;
    const shouldBlock = typeof options.shouldBlockShopFallback === 'function'
        ? options.shouldBlockShopFallback
        : shouldBlockShopFallback;
    const logInfo = typeof options.log === 'function' ? options.log : log;
    const logWarning = typeof options.logWarn === 'function' ? options.logWarn : logWarn;

    if (typeof runPrepass !== 'function') throw new Error('event seed prepass is required');
    if (typeof plantFromShopBase !== 'function') throw new Error('base shop planter is required');

    async function resolveShopLandIds(prepass, remainingLandIds, state = {}) {
        const remaining = normalizeIds(remainingLandIds);
        if (remaining.length === 0) return [];
        if (!shouldBlock(prepass)) return remaining;

        const unresolved = normalizeIds(prepass && prepass.unresolvedSeedIds);
        const knownSeedBlock = prepass && prepass.knownSeedBlock === true;
        if (unresolved.length > 0 && !knownSeedBlock) {
            // A high-confidence unresolved seed may be 1x1 or 2x2. Preserve one possible
            // 2x2 footprint, but never leave the entire farm empty while learning.
            if (typeof readAllLands !== 'function') {
                return [];
            }

            try {
                const latest = await readAllLands();
                const lands = Array.isArray(latest && latest.lands) ? latest.lands : [];
                const plan = plan2x2(lands, remaining, 1);
                const reserved = new Set(normalizeIds(plan && plan.reservedLandIds));

                if (reserved.size === 0) {
                    logWarning('种植', '检测到高置信未知活动种子，但当前无法形成可预留 2x2 组合；本轮允许普通策略继续种植', {
                        module: 'farm',
                        event: '活动种子未知尺寸预留',
                        result: 'unknown_no_reservable_group',
                        seedIds: unresolved,
                    });
                    return remaining;
                }

                const allowed = remaining.filter(id => !reserved.has(id));
                logInfo('种植', `为高置信未知活动种子预留 ${reserved.size} 块地，其余 ${allowed.length} 块继续原种植策略`, {
                    module: 'farm',
                    event: '活动种子未知尺寸预留',
                    result: 'unknown_reserved',
                    seedIds: unresolved,
                    reservedLandIds: [...reserved],
                    shopAllowedLandIds: allowed,
                });
                return allowed;
            } catch (error) {
                logWarning('种植', `高置信未知活动种子预留失败，本轮保持保守不买普通种子: ${error.message}`, {
                    module: 'farm',
                    event: '活动种子未知尺寸预留',
                    result: 'unknown_reservation_error',
                    seedIds: unresolved,
                });
                return [];
            }
        }

        const usableSpecial = getUsableSpecialSeeds(prepass, state.level);
        const oneByOne = usableSpecial.filter(row => Number(row.plantSize) === 1);
        const unsupported = usableSpecial.filter(row => ![1, 2].includes(Number(row.plantSize)));
        if (oneByOne.length > 0 || unsupported.length > 0) {
            // A known 1x1/unsupported seed still being blocked means the prepass could not
            // safely complete it. Do not fill those lands with shop seeds in the same cycle.
            return [];
        }

        const twoByTwo = usableSpecial.filter(row => Number(row.plantSize) === 2);
        if (twoByTwo.length === 0 || typeof readAllLands !== 'function') {
            return [];
        }

        try {
            const latest = await readAllLands();
            const lands = Array.isArray(latest && latest.lands) ? latest.lands : [];
            const desiredCount = twoByTwo.reduce((sum, row) => sum + Math.max(0, Number(row.count) || 0), 0);
            const plan = plan2x2(lands, remaining, desiredCount);
            const reserved = new Set(normalizeIds(plan && plan.reservedLandIds));

            if (reserved.size === 0) {
                // No valid 2x2 footprint exists in the currently unlocked layout. Keeping all
                // land empty forever would be worse than allowing normal planting.
                logWarning('种植', '检测到活动/特殊 2x2 种子，但当前已解锁土地无法形成可预留 2x2 组合；本轮允许普通策略继续种植', {
                    module: 'farm',
                    event: '活动种子2x2预留',
                    result: 'no_reservable_group',
                    seedIds: twoByTwo.map(row => row.seedId),
                });
                return remaining;
            }

            const allowed = remaining.filter(id => !reserved.has(id));
            logInfo('种植', `已为活动/特殊 2x2 种子保留 ${reserved.size} 块地，其余 ${allowed.length} 块空地可继续原种植策略`, {
                module: 'farm',
                event: '活动种子2x2预留',
                result: 'reserved',
                seedIds: twoByTwo.map(row => row.seedId),
                reservedLandIds: [...reserved],
                shopAllowedLandIds: allowed,
            });
            return allowed;
        } catch (error) {
            logWarning('种植', `活动/特殊 2x2 土地预留复核失败，本轮保持保守不买普通种子: ${error.message}`, {
                module: 'farm',
                event: '活动种子2x2预留',
                result: 'reservation_error',
            });
            return [];
        }
    }

    return async function plantFromShopWithEventSeedPriority(landIds, state, overrideStrategy) {
        let prepass;
        try {
            prepass = await runPrepass({ landIds, state });
        } catch (error) {
            logWarning('种植', `活动种子优先链异常，本轮暂停商店补种: ${error.message}`, {
                module: 'farm',
                event: '活动种子发现',
                result: 'priority_prepass_error',
            });
            return { plantedLands: [] };
        }

        const plantedLands = normalizeIds(prepass && prepass.plantedLandIds);
        const remaining = normalizeIds(prepass && prepass.remainingLandIds);
        const shopLandIds = await resolveShopLandIds(prepass, remaining, state);

        if (shopLandIds.length === 0) {
            return { plantedLands };
        }

        const shopResult = await plantFromShopBase(shopLandIds, state, overrideStrategy);
        plantedLands.push(...normalizeIds(shopResult && shopResult.plantedLands));
        return { plantedLands: [...new Set(plantedLands)] };
    };
}

module.exports = {
    normalizeIds,
    getUsableSpecialSeeds,
    createEventSeedLogWarn,
    createEventSeedShopWrapper,
};
