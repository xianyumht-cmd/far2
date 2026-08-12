const FARM_COLUMNS = 4;
const FARM_ROWS = 6;

let reservedWaitingGroupKey = '';

function toId(value) {
    const direct = Number(value);
    if (Number.isSafeInteger(direct) && direct > 0) return direct;
    if (value && typeof value.toString === 'function') {
        const parsed = Number(value.toString());
        if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    }
    return 0;
}

function groupKey(landIds) {
    return [...(Array.isArray(landIds) ? landIds : [])]
        .map(toId)
        .filter(Boolean)
        .sort((a, b) => a - b)
        .join('-');
}

function isLiveEmptyLand(land) {
    if (!land || !land.unlocked) return false;
    const plant = land.plant;
    return !plant || !Array.isArray(plant.phases) || plant.phases.length === 0;
}

/**
 * QQ 农场当前 24 块地按 4 列 x 6 行排列。
 * 2x2 Plant 请求的锚点/master 是左下角。
 */
function build2x2LandGroups(lands) {
    const unlockedIds = new Set(
        (Array.isArray(lands) ? lands : [])
            .filter(land => land && land.unlocked)
            .map(land => toId(land.id))
            .filter(Boolean),
    );
    const groups = [];

    for (let bottomRow = 1; bottomRow < FARM_ROWS; bottomRow++) {
        for (let column = 0; column < FARM_COLUMNS - 1; column++) {
            const masterLandId = bottomRow * FARM_COLUMNS + column + 1;
            const landIds = [
                masterLandId,
                masterLandId + 1,
                masterLandId - FARM_COLUMNS,
                masterLandId - FARM_COLUMNS + 1,
            ];
            if (!landIds.every(id => unlockedIds.has(id))) continue;
            groups.push({
                key: groupKey(landIds),
                masterLandId,
                landIds,
            });
        }
    }
    return groups;
}

function getActive2x2Footprints(lands) {
    const result = [];
    for (const land of (Array.isArray(lands) ? lands : [])) {
        const masterLandId = toId(land && land.id);
        const slaves = Array.isArray(land && land.slave_land_ids)
            ? land.slave_land_ids.map(toId).filter(Boolean)
            : [];
        if (!masterLandId || slaves.length !== 3) continue;
        const landIds = [masterLandId, ...slaves];
        result.push({
            key: groupKey(landIds),
            masterLandId,
            landIds,
            occupied: new Set(landIds),
        });
    }
    return result;
}

function overlaps(left, occupiedSet) {
    return left.some(id => occupiedSet.has(id));
}

function selectMaximumNonOverlappingGroups(groups, limit) {
    const candidates = [...(Array.isArray(groups) ? groups : [])]
        .sort((a, b) => a.masterLandId - b.masterLandId);
    const max = Math.max(0, Number.parseInt(limit, 10) || 0);
    if (max <= 0 || candidates.length === 0) return [];

    let best = [];
    function search(index, selected, occupied) {
        if (selected.length > best.length) best = [...selected];
        if (selected.length >= max || index >= candidates.length) return;
        if (selected.length + (candidates.length - index) <= best.length) return;

        const group = candidates[index];
        if (!overlaps(group.landIds, occupied)) {
            const nextOccupied = new Set(occupied);
            group.landIds.forEach(id => nextOccupied.add(id));
            search(index + 1, [...selected, group], nextOccupied);
        }
        search(index + 1, selected, occupied);
    }

    search(0, [], new Set());
    return best;
}

function clear2x2Reservation() {
    reservedWaitingGroupKey = '';
}

/**
 * 规划本轮 2x2：
 * - 已经完整空闲的组合可以直接选中多组；
 * - 还没完全空闲的组合最多只预留一组；
 * - 预留优先沿用上一轮，避免每轮换地；否则优先选择当前空地最多的组合。
 */
function select2x2Reservations(lands, emptyLandIds, desiredCount = 1) {
    const max = Math.max(0, Number.parseInt(desiredCount, 10) || 0);
    if (max <= 0) {
        clear2x2Reservation();
        return { readyGroups: [], waitingGroup: null, reservedLandIds: [] };
    }

    const list = Array.isArray(lands) ? lands : [];
    const landMap = new Map(list.map(land => [toId(land && land.id), land]).filter(([id]) => id > 0));
    const empty = new Set((Array.isArray(emptyLandIds) ? emptyLandIds : []).map(toId).filter(Boolean));
    const activeOccupied = new Set(getActive2x2Footprints(list).flatMap(row => row.landIds));
    const candidates = build2x2LandGroups(list)
        .filter(group => !overlaps(group.landIds, activeOccupied));

    const readyCandidates = candidates
        .filter(group => group.landIds.every(id => empty.has(id)))
        .filter(group => group.landIds.every(id => isLiveEmptyLand(landMap.get(id))));
    const readyGroups = selectMaximumNonOverlappingGroups(readyCandidates, max);
    const occupiedByReady = new Set(readyGroups.flatMap(group => group.landIds));

    let waitingGroup = null;
    if (readyGroups.length < max) {
        const waitingCandidates = candidates
            .filter(group => !group.landIds.every(id => empty.has(id) && isLiveEmptyLand(landMap.get(id))))
            .filter(group => !overlaps(group.landIds, occupiedByReady))
            .map(group => ({
                ...group,
                emptyCount: group.landIds.filter(id => empty.has(id) && isLiveEmptyLand(landMap.get(id))).length,
            }))
            .sort((a, b) => {
                const aReserved = a.key === reservedWaitingGroupKey ? 1 : 0;
                const bReserved = b.key === reservedWaitingGroupKey ? 1 : 0;
                if (aReserved !== bReserved) return bReserved - aReserved;
                if (a.emptyCount !== b.emptyCount) return b.emptyCount - a.emptyCount;
                return a.masterLandId - b.masterLandId;
            });
        waitingGroup = waitingCandidates[0] || null;
    }

    reservedWaitingGroupKey = waitingGroup ? waitingGroup.key : '';
    const reservedLandIds = [
        ...readyGroups.flatMap(group => group.landIds),
        ...(waitingGroup ? waitingGroup.landIds : []),
    ];

    return {
        readyGroups,
        waitingGroup,
        reservedLandIds: [...new Set(reservedLandIds)],
    };
}

/**
 * 兼容首版调用：只返回当前可立即种植的 2x2 组合，不产生等待预留。
 */
function selectReady2x2Groups(lands, emptyLandIds, limit = 1) {
    const max = Math.max(0, Number.parseInt(limit, 10) || 0);
    if (max <= 0) return [];

    const list = Array.isArray(lands) ? lands : [];
    const landMap = new Map(list.map(land => [toId(land && land.id), land]).filter(([id]) => id > 0));
    const empty = new Set((Array.isArray(emptyLandIds) ? emptyLandIds : []).map(toId).filter(Boolean));
    if (empty.size < 4) return [];

    const activeOccupied = new Set(getActive2x2Footprints(list).flatMap(row => row.landIds));
    const candidates = build2x2LandGroups(list)
        .filter(group => group.landIds.every(id => empty.has(id)))
        .filter(group => group.landIds.every(id => isLiveEmptyLand(landMap.get(id))))
        .filter(group => !overlaps(group.landIds, activeOccupied));
    return selectMaximumNonOverlappingGroups(candidates, max);
}

function validate2x2PlantReply(reply, group) {
    const expected = group && Array.isArray(group.landIds)
        ? group.landIds.map(toId).filter(Boolean)
        : [];
    const masterLandId = toId(group && group.masterLandId);
    if (masterLandId <= 0 || expected.length !== 4) {
        return { ok: false, reason: 'invalid_expected_group' };
    }

    const map = new Map();
    for (const land of (reply && Array.isArray(reply.land) ? reply.land : [])) {
        const id = toId(land && land.id);
        if (id > 0) map.set(id, land);
    }
    const master = map.get(masterLandId);
    if (!master) return { ok: false, reason: 'master_missing' };

    const actualSlaves = new Set(
        (Array.isArray(master.slave_land_ids) ? master.slave_land_ids : [])
            .map(toId)
            .filter(Boolean),
    );
    const expectedSlaves = expected.filter(id => id !== masterLandId);
    if (expectedSlaves.length !== 3 || !expectedSlaves.every(id => actualSlaves.has(id))) {
        return { ok: false, reason: 'master_slave_list_mismatch' };
    }

    for (const slaveId of expectedSlaves) {
        const slave = map.get(slaveId);
        if (!slave || toId(slave.master_land_id) !== masterLandId) {
            return { ok: false, reason: `slave_${slaveId}_master_mismatch` };
        }
    }

    return {
        ok: true,
        masterLandId,
        occupiedLandIds: [...expected],
    };
}

module.exports = {
    FARM_COLUMNS,
    FARM_ROWS,
    groupKey,
    isLiveEmptyLand,
    build2x2LandGroups,
    getActive2x2Footprints,
    selectMaximumNonOverlappingGroups,
    clear2x2Reservation,
    select2x2Reservations,
    selectReady2x2Groups,
    validate2x2PlantReply,
};
