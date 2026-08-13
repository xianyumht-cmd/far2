const { PlantPhase, PHASE_NAMES } = require('../config/config');
const { toNum, getServerTimeSec, toTimeSec } = require('../utils/utils');

function getSlaveLandIds(land) {
    const ids = Array.isArray(land && land.slave_land_ids) ? land.slave_land_ids : [];
    return [...new Set(ids.map(id => toNum(id)).filter(Boolean))];
}

function hasPlantData(land) {
    const plant = land && land.plant;
    return !!(plant && Array.isArray(plant.phases) && plant.phases.length > 0);
}

function getLinkedMasterLand(land, landsMap) {
    const landId = toNum(land && land.id);
    const masterLandId = toNum(land && land.master_land_id);
    if (!masterLandId || masterLandId === landId) return null;

    const masterLand = landsMap.get(masterLandId);
    if (!masterLand) return null;

    const slaveIds = getSlaveLandIds(masterLand);
    if (slaveIds.length > 0 && !slaveIds.includes(landId)) return null;

    return masterLand;
}

function getDisplayLandContext(land, landsMap) {
    const masterLand = getLinkedMasterLand(land, landsMap);
    if (masterLand && hasPlantData(masterLand)) {
        const occupiedLandIds = [toNum(masterLand.id), ...getSlaveLandIds(masterLand)].filter(Boolean);
        return {
            sourceLand: masterLand,
            occupiedByMaster: true,
            masterLandId: toNum(masterLand.id),
            occupiedLandIds: occupiedLandIds.length > 0 ? occupiedLandIds : [toNum(masterLand.id)].filter(Boolean),
        };
    }

    const selfId = toNum(land && land.id);
    return {
        sourceLand: land,
        occupiedByMaster: false,
        masterLandId: selfId,
        occupiedLandIds: [selfId].filter(Boolean),
    };
}

function isOccupiedSlaveLand(land, landsMap) {
    return !!getDisplayLandContext(land, landsMap).occupiedByMaster;
}

function buildSlaveToMasterMap(lands) {
    const map = new Map();
    for (const land of (Array.isArray(lands) ? lands : [])) {
        const slaveIds = getSlaveLandIds(land);
        const masterId = toNum(land && land.id);
        if (slaveIds.length > 0 && masterId > 0) {
            for (const slaveId of slaveIds) {
                if (slaveId > 0 && slaveId !== masterId) {
                    map.set(slaveId, masterId);
                }
            }
        }
    }
    return map;
}

function summarizeLandDetails(lands) {
    const summary = {
        harvestable: 0,
        growing: 0,
        empty: 0,
        dead: 0,
        needWater: 0,
        needWeed: 0,
        needBug: 0,
    };

    for (const land of Array.isArray(lands) ? lands : []) {
        if (!land || !land.unlocked) continue;

        const status = String(land.status || '');
        if (status === 'harvestable') summary.harvestable++;
        else if (status === 'dead') summary.dead++;
        else if (status === 'empty') summary.empty++;
        else if (status === 'growing' || status === 'stealable' || status === 'harvested') summary.growing++;

        if (land.needWater) summary.needWater++;
        if (land.needWeed) summary.needWeed++;
        if (land.needBug) summary.needBug++;
    }

    return summary;
}

function getLandTypeByLevel(level) {
    const lv = toNum(level);
    if (lv === 5) return 'purple';
    if (lv === 4) return 'gold';
    if (lv === 3) return 'black';
    if (lv === 2) return 'red';
    return 'normal';
}

function getCurrentPhase(phases, debug, landLabel) {
    if (!phases || phases.length === 0) return null;

    const nowSec = getServerTimeSec();

    if (debug) {
        console.warn(`    ${landLabel} 服务器时间=${nowSec} (${new Date(nowSec * 1000).toLocaleTimeString()})`);
        for (let i = 0; i < phases.length; i++) {
            const p = phases[i];
            const bt = toTimeSec(p.begin_time);
            const phaseName = PHASE_NAMES[p.phase] || `阶段${p.phase}`;
            const diff = bt > 0 ? (bt - nowSec) : 0;
            const diffStr = diff > 0 ? `(未来 ${diff}s)` : diff < 0 ? `(已过 ${-diff}s)` : '';
            console.warn(`    ${landLabel}   [${i}] ${phaseName}(${p.phase}) begin=${bt} ${diffStr} dry=${toTimeSec(p.dry_time)} weed=${toTimeSec(p.weeds_time)} insect=${toTimeSec(p.insect_time)}`);
        }
    }

    for (let i = phases.length - 1; i >= 0; i--) {
        const beginTime = toTimeSec(phases[i].begin_time);
        if (beginTime > 0 && beginTime <= nowSec) {
            if (debug) {
                console.warn(`    ${landLabel}   → 当前阶段: ${PHASE_NAMES[phases[i].phase] || phases[i].phase}`);
            }
            return phases[i];
        }
    }

    if (debug) {
        console.warn(`    ${landLabel}   → 所有阶段都在未来，使用第一个: ${PHASE_NAMES[phases[0].phase] || phases[0].phase}`);
    }
    return phases[0];
}

function buildLandMap(lands) {
    const map = new Map();
    const list = Array.isArray(lands) ? lands : [];
    for (const land of list) {
        const id = toNum(land && land.id);
        if (id > 0) map.set(id, land);
    }
    return map;
}

function getLandLifecycleState(land) {
    if (!land) return 'unknown';
    const plant = land.plant;
    if (!plant || !Array.isArray(plant.phases) || plant.phases.length === 0) {
        return 'empty';
    }

    const currentPhase = getCurrentPhase(plant.phases, false, '');
    if (!currentPhase) return 'empty';

    const phaseVal = toNum(currentPhase.phase);
    if (phaseVal === PlantPhase.DEAD) return 'dead';
    if (phaseVal === PlantPhase.UNKNOWN) return 'empty';
    if (phaseVal >= PlantPhase.SEED && phaseVal <= PlantPhase.MATURE) return 'growing';
    return 'unknown';
}

function classifyHarvestedLandsByMap(landIds, landsMap) {
    const removable = [];
    const growing = [];
    const unknown = [];
    for (const id of (Array.isArray(landIds) ? landIds : [])) {
        const land = landsMap.get(id);
        if (!land) {
            unknown.push(id);
            continue;
        }
        const state = getLandLifecycleState(land);
        if (state === 'dead' || state === 'empty') {
            removable.push(id);
            continue;
        }
        if (state === 'growing') {
            growing.push(id);
            continue;
        }
        unknown.push(id);
    }
    return { removable, growing, unknown };
}

module.exports = {
    getSlaveLandIds,
    hasPlantData,
    getLinkedMasterLand,
    getDisplayLandContext,
    isOccupiedSlaveLand,
    buildSlaveToMasterMap,
    summarizeLandDetails,
    getLandTypeByLevel,
    getCurrentPhase,
    buildLandMap,
    getLandLifecycleState,
    classifyHarvestedLandsByMap,
};
