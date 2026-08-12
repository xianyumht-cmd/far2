const { clear2x2Reservation, select2x2Reservations } = require('./farm-2x2');

let lastWaitingSignature = '';
let lastLockedSignature = '';

function sortSeeds(seeds, priorityList) {
    const priority = new Map();
    for (const [index, seedId] of (Array.isArray(priorityList) ? priorityList : []).entries()) {
        const id = Number(seedId) || 0;
        if (id > 0) priority.set(id, index);
    }
    return [...(Array.isArray(seeds) ? seeds : [])].sort((a, b) => {
        const ai = priority.has(Number(a && a.seedId)) ? priority.get(Number(a.seedId)) : Number.MAX_SAFE_INTEGER;
        const bi = priority.has(Number(b && b.seedId)) ? priority.get(Number(b.seedId)) : Number.MAX_SAFE_INTEGER;
        if (ai !== bi) return ai - bi;
        const levelDiff = (Number(b && b.requiredLevel) || 0) - (Number(a && a.requiredLevel) || 0);
        if (levelDiff !== 0) return levelDiff;
        return (Number(a && a.seedId) || 0) - (Number(b && b.seedId) || 0);
    });
}

async function runPrioritized2x2Prepass(options = {}) {
    const {
        enabled = true,
        landIds = [],
        getBagSeeds,
        bagSeedPriority = [],
        userLevel = 0,
        getAllLands,
        plant2x2Seed,
        log = () => {},
        logWarn = () => {},
        sleep = async () => {},
    } = options;

    const targetLandIds = [...new Set((Array.isArray(landIds) ? landIds : [])
        .map(id => Number(id) || 0)
        .filter(id => id > 0))];
    const emptyResult = {
        remainingLandIds: targetLandIds,
        plantedLandIds: [],
        totalPlanted: 0,
        occupiedCount: 0,
        reservedLandIds: [],
    };

    if (targetLandIds.length === 0) return emptyResult;
    if (!enabled) {
        clear2x2Reservation();
        lastWaitingSignature = '';
        lastLockedSignature = '';
        return emptyResult;
    }
    if (typeof getBagSeeds !== 'function' || typeof getAllLands !== 'function' || typeof plant2x2Seed !== 'function') {
        throw new Error('2x2 prepass dependencies are incomplete');
    }

    let bagSeeds;
    try {
        bagSeeds = await getBagSeeds();
    } catch (error) {
        logWarn('种植', `读取 2x2 背包种子失败，继续原种植策略: ${error.message}`, {
            module: 'farm', event: '种植2x2作物', result: 'bag_load_error',
        });
        return emptyResult;
    }

    const size2Seeds = sortSeeds(
        (Array.isArray(bagSeeds) ? bagSeeds : []).filter(seed => Number(seed && seed.count) > 0 && Number(seed && seed.plantSize) === 2),
        bagSeedPriority,
    );
    const lockedSeeds = size2Seeds.filter(seed => Number(seed.requiredLevel || 0) > Number(userLevel || 0));
    const usableSeeds = size2Seeds
        .filter(seed => Number(seed.requiredLevel || 0) <= Number(userLevel || 0))
        .map(seed => ({ ...seed, remainingCount: Math.max(0, Number(seed.count) || 0) }));

    const lockedSignature = lockedSeeds.map(seed => `${seed.seedId}:${seed.requiredLevel}`).join('|');
    if (lockedSignature && lockedSignature !== lastLockedSignature) {
        log('种植', `已跳过当前等级未解锁的 2x2 背包种子: ${lockedSeeds.map(seed => seed.name || seed.seedId).join('、')}`, {
            module: 'farm', event: '种植2x2作物', result: 'skip_locked',
            seedIds: lockedSeeds.map(seed => seed.seedId), userLevel: Number(userLevel || 0),
        });
    }
    lastLockedSignature = lockedSignature;

    const desiredCount = usableSeeds.reduce((sum, seed) => sum + seed.remainingCount, 0);
    if (desiredCount <= 0) {
        clear2x2Reservation();
        lastWaitingSignature = '';
        return emptyResult;
    }

    let latestLands;
    try {
        const latest = await getAllLands();
        latestLands = Array.isArray(latest && latest.lands) ? latest.lands : [];
    } catch (error) {
        logWarn('种植', `检查 2x2 土地状态失败，继续原种植策略: ${error.message}`, {
            module: 'farm', event: '种植2x2作物', result: 'land_probe_error',
        });
        return emptyResult;
    }

    const plan = select2x2Reservations(latestLands, targetLandIds, desiredCount);
    const reservedSet = new Set(plan.reservedLandIds || []);
    const remainingLandIds = targetLandIds.filter(id => !reservedSet.has(id));
    const plantedLandIds = [];
    let totalPlanted = 0;
    let occupiedCount = 0;

    for (const group of (plan.readyGroups || [])) {
        const seed = usableSeeds.find(item => item.remainingCount > 0);
        if (!seed) break;
        try {
            const result = await plant2x2Seed(seed.seedId, group);
            seed.remainingCount--;
            totalPlanted++;
            plantedLandIds.push(result.masterLandId || group.masterLandId);
            occupiedCount += (result.occupiedLandIds || group.landIds).length;
            log('种植', `已优先种植 2x2 作物 ${seed.name}，主地块#${result.masterLandId || group.masterLandId}，占地 ${(result.occupiedLandIds || group.landIds).join(',')}`, {
                module: 'farm', event: '种植2x2作物', result: 'ok', seedId: seed.seedId,
                masterLandId: result.masterLandId || group.masterLandId,
                landIds: result.occupiedLandIds || group.landIds,
            });
        } catch (error) {
            // 失败时保留该组空地，不让普通 1x1 立即填回去，下一轮可继续尝试。
            logWarn('种植', `2x2 作物 ${seed.name}(${seed.seedId}) 种植失败，已保留该组土地等待重试: ${error.message}`, {
                module: 'farm', event: '种植2x2作物', result: 'error_reserved',
                seedId: seed.seedId, landIds: group.landIds,
            });
        }
        await sleep(100);
    }

    if (plan.waitingGroup) {
        const currentlyEmpty = plan.waitingGroup.landIds.filter(id => targetLandIds.includes(id));
        const signature = `${plan.waitingGroup.key}:${currentlyEmpty.join(',')}`;
        if (signature !== lastWaitingSignature) {
            log('种植', `已为 2x2 作物预留一组土地，等待其余地块自然清空: ${plan.waitingGroup.landIds.join(',')}`, {
                module: 'farm', event: '预留2x2土地', result: 'waiting',
                landIds: plan.waitingGroup.landIds, emptyLandIds: currentlyEmpty,
            });
        }
        lastWaitingSignature = signature;
    } else {
        lastWaitingSignature = '';
    }

    return {
        remainingLandIds,
        plantedLandIds: [...new Set(plantedLandIds)],
        totalPlanted,
        occupiedCount,
        reservedLandIds: [...reservedSet],
    };
}

module.exports = {
    runPrioritized2x2Prepass,
};
