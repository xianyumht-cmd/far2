const FARM_COLUMNS = 4;
const FARM_ROWS = 6;

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

/**
 * 只挑“当前四块都已经空闲”的组合；不主动铲地，也不预留仍在生长的土地。
 * 这样首版 2x2 支持不会改变现有作物生命周期。
 */
function selectReady2x2Groups(lands, emptyLandIds, limit = 1) {
    const max = Math.max(0, Number.parseInt(limit, 10) || 0);
    if (max <= 0) return [];

    const empty = new Set((Array.isArray(emptyLandIds) ? emptyLandIds : []).map(toId).filter(Boolean));
    if (empty.size < 4) return [];

    const active = getActive2x2Footprints(lands);
    const activeOccupied = new Set(active.flatMap(row => row.landIds));
    const candidates = build2x2LandGroups(lands)
        .filter(group => group.landIds.every(id => empty.has(id)))
        .filter(group => !overlaps(group.landIds, activeOccupied))
        .sort((a, b) => a.masterLandId - b.masterLandId);

    const selected = [];
    const selectedOccupied = new Set();
    for (const group of candidates) {
        if (selected.length >= max) break;
        if (overlaps(group.landIds, selectedOccupied)) continue;
        selected.push(group);
        for (const id of group.landIds) selectedOccupied.add(id);
    }
    return selected;
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
    build2x2LandGroups,
    getActive2x2Footprints,
    selectReady2x2Groups,
    validate2x2PlantReply,
};
