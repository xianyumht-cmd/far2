const fs = require('node:fs');
const path = require('node:path');
const { ensureDataDir } = require('../config/runtime-paths');

const OVERLAY_VERSION = 1;
const DEFAULT_FILE = 'runtime-plant-overlay.json';

function toNum(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function hasOwn(object, key) {
    return !!object && Object.prototype.hasOwnProperty.call(object, key);
}

function isPlantSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
    const fruit = snapshot.fruit && typeof snapshot.fruit === 'object' ? snapshot.fruit : null;
    return toNum(snapshot.seed_id) > 0
        && toNum(fruit && fruit.id) > 0
        && toNum(snapshot.id) > 0
        && typeof snapshot.name === 'string'
        && snapshot.name.trim().length > 0
        && typeof snapshot.grow_phases === 'string'
        && hasOwn(snapshot, 'size');
}

function directReferenceRows(report) {
    const rows = Array.isArray(report && report.rawEvidence) ? report.rawEvidence : [];
    return rows.filter((row) => {
        const snapshot = row && row.snapshot;
        if (!row || row.kind !== 'reference' || row.markerKind !== 'seed' || row.matchPath !== 'seed_id') return false;
        if (!isPlantSnapshot(snapshot)) return false;
        if (toNum(snapshot.seed_id) !== toNum(row.seedId)) return false;
        if (toNum(snapshot.fruit && snapshot.fruit.id) !== toNum(row.fruitId)) return false;
        if (String(snapshot.name || '') !== String(row.referenceName || '')) return false;
        return true;
    });
}

function calibrateRuntimeSizeEncoding(report) {
    const rows = directReferenceRows(report);
    const one = rows.filter(row => toNum(row.expectedRawSize) === 0);
    const two = rows.filter(row => toNum(row.expectedRawSize) === 2);

    const oneMismatch = one.filter(row => row.snapshot.size !== null && row.snapshot.size !== undefined);
    const twoMismatch = two.filter(row => toNum(row.snapshot.size) !== 2);

    return {
        proven: one.length >= 6 && two.length >= 2 && oneMismatch.length === 0 && twoMismatch.length === 0,
        oneByOne: {
            references: one.length,
            observedRuntimeValue: null,
            mismatches: oneMismatch.length,
        },
        twoByTwo: {
            references: two.length,
            observedRuntimeValue: 2,
            mismatches: twoMismatch.length,
        },
        rule: 'runtime Plant.size null => 1x1; runtime Plant.size 2 => 2x2',
    };
}

function plantSignature(row) {
    const snapshot = row && row.snapshot;
    if (!isPlantSnapshot(snapshot)) return '';
    return [
        toNum(snapshot.id),
        toNum(snapshot.seed_id),
        toNum(snapshot.fruit && snapshot.fruit.id),
        String(snapshot.name || ''),
        snapshot.size === null || snapshot.size === undefined ? 'null' : String(snapshot.size),
        String(snapshot.grow_phases || ''),
    ].join('|');
}

function uniquePlantRows(rows) {
    const map = new Map();
    for (const row of rows) {
        const signature = plantSignature(row);
        if (signature) map.set(signature, row);
    }
    return [...map.values()];
}

function targetPlantRows(report, target) {
    const rows = Array.isArray(report && report.rawEvidence) ? report.rawEvidence : [];
    const seedId = toNum(target && target.seedId);
    const fruitId = toNum(target && target.fruitId);
    const plantRows = rows.filter(row => row && row.kind === 'target' && isPlantSnapshot(row.snapshot));

    const exactSeed = uniquePlantRows(plantRows.filter(row => (
        row.matchPath === 'seed_id'
        && toNum(row.snapshot.seed_id) === seedId
        && toNum(row.snapshot.fruit && row.snapshot.fruit.id) === fruitId
    )));
    if (exactSeed.length) return { mode: 'direct-seed', rows: exactSeed };

    const exactFruit = uniquePlantRows(plantRows.filter(row => (
        toNum(row.snapshot.fruit && row.snapshot.fruit.id) === fruitId
    )));
    return { mode: 'fruit-fallback', rows: exactFruit };
}

function normalizeRuntimeSize(snapshot, calibration) {
    if (!calibration || calibration.proven !== true || !hasOwn(snapshot, 'size')) return 0;
    if (snapshot.size === null || snapshot.size === undefined) return 1;
    if (toNum(snapshot.size) === 2) return 2;
    return 0;
}

function resolveRuntimeTarget(report, target, calibration) {
    const selected = targetPlantRows(report, target);
    if (selected.rows.length !== 1) {
        return {
            ok: false,
            candidateSeedId: toNum(target && target.seedId),
            fruitId: toNum(target && target.fruitId),
            reason: selected.rows.length > 1 ? 'conflicting-runtime-plant-objects' : 'no-runtime-plant-object',
            mode: selected.mode,
        };
    }

    const row = selected.rows[0];
    const snapshot = row.snapshot;
    const size = normalizeRuntimeSize(snapshot, calibration);
    if (!size) {
        return {
            ok: false,
            candidateSeedId: toNum(target && target.seedId),
            fruitId: toNum(target && target.fruitId),
            reason: 'runtime-size-unproven',
            mode: selected.mode,
        };
    }

    const actualSeedId = toNum(snapshot.seed_id);
    const actualFruitId = toNum(snapshot.fruit && snapshot.fruit.id);
    if (!actualSeedId || actualFruitId !== toNum(target && target.fruitId)) {
        return {
            ok: false,
            candidateSeedId: toNum(target && target.seedId),
            fruitId: toNum(target && target.fruitId),
            reason: 'runtime-identity-mismatch',
            mode: selected.mode,
        };
    }

    return {
        ok: true,
        candidateSeedId: toNum(target && target.seedId),
        seedId: actualSeedId,
        fruitId: actualFruitId,
        illustratedTier: toNum(target && target.illustratedTier),
        plantId: toNum(snapshot.id),
        name: String(snapshot.name || '').trim(),
        rawSize: snapshot.size === undefined ? null : snapshot.size,
        size,
        gridCount: size === 2 ? 4 : 1,
        levelNeed: toNum(snapshot.land_level_need),
        seasons: toNum(snapshot.seasons),
        growPhases: String(snapshot.grow_phases || ''),
        exp: toNum(snapshot.exp),
        fruitCount: toNum(snapshot.fruit && snapshot.fruit.count),
        specialFruit: snapshot.special_fruit == null ? null : String(snapshot.special_fruit),
        proofMode: selected.mode,
        mappingCorrected: actualSeedId !== toNum(target && target.seedId),
        evidence: 'official-runtime-json-plant-object',
    };
}

function buildRuntimePlantOverlay(report) {
    if (!report || typeof report !== 'object') throw new Error('runtime overlay report required');
    if (!report.safety || report.safety.qqCacheRestored !== true) throw new Error('runtime report cache restore is not proven');
    if (report.safety.readOnlyCapture !== true || report.safety.far2RpcSent !== false) throw new Error('runtime report safety contract invalid');

    const calibration = calibrateRuntimeSizeEncoding(report);
    if (!calibration.proven) {
        throw new Error(`runtime size calibration failed: 1x1=${calibration.oneByOne.references}/${calibration.oneByOne.mismatches} 2x2=${calibration.twoByTwo.references}/${calibration.twoByTwo.mismatches}`);
    }

    const targets = Array.isArray(report.targets) ? report.targets : [];
    const resolved = targets.map(target => resolveRuntimeTarget(report, target, calibration));
    const entries = resolved.filter(row => row.ok);
    const unresolved = resolved.filter(row => !row.ok);
    const corrections = entries
        .filter(row => row.mappingCorrected)
        .map(row => ({
            fruitId: row.fruitId,
            previousCandidateSeedId: row.candidateSeedId,
            actualSeedId: row.seedId,
            name: row.name,
        }));

    return {
        version: OVERLAY_VERSION,
        generatedAt: new Date().toISOString(),
        sourceReportGeneratedAt: String(report.generatedAt || ''),
        calibration,
        summary: {
            targets: targets.length,
            resolved: entries.length,
            unresolved: unresolved.length,
            size1: entries.filter(row => row.size === 1).length,
            size2: entries.filter(row => row.size === 2).length,
            mappingCorrections: corrections.length,
        },
        corrections,
        entries,
        unresolved,
        safety: {
            officialRuntimeReadOnlyEvidence: true,
            sizeEncodingCalibratedByKnown1x1And2x2: true,
            numericCoincidenceNeverPromotes: true,
            fruitFallbackRequiresDirectPlantObject: true,
        },
    };
}

function overlayFilePath() {
    return path.join(ensureDataDir(), 'crop_registry', DEFAULT_FILE);
}

function persistRuntimePlantOverlay(overlay, target = overlayFilePath()) {
    if (!overlay || !overlay.calibration || overlay.calibration.proven !== true) throw new Error('refusing to persist unproven runtime overlay');
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(overlay, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, target);
    return target;
}

function loadRuntimePlantOverlay(target = overlayFilePath()) {
    try {
        if (!fs.existsSync(target)) return null;
        const overlay = JSON.parse(fs.readFileSync(target, 'utf8'));
        if (!overlay || overlay.version !== OVERLAY_VERSION || !overlay.calibration || overlay.calibration.proven !== true) return null;
        return overlay;
    } catch {
        return null;
    }
}

function runtimeOverlayPlants(overlay) {
    if (!overlay || !overlay.calibration || overlay.calibration.proven !== true) return [];
    return (Array.isArray(overlay.entries) ? overlay.entries : [])
        .filter(row => row && row.ok && toNum(row.seedId) > 0 && toNum(row.fruitId) > 0 && (toNum(row.size) === 1 || toNum(row.size) === 2))
        .map(row => ({
            id: toNum(row.plantId),
            name: String(row.name || ''),
            fruit: { id: toNum(row.fruitId), count: toNum(row.fruitCount) },
            seed_id: toNum(row.seedId),
            land_level_need: toNum(row.levelNeed),
            seasons: toNum(row.seasons),
            grow_phases: String(row.growPhases || ''),
            exp: toNum(row.exp),
            size: toNum(row.size),
            special_fruit: row.specialFruit == null ? null : String(row.specialFruit),
            _runtimeOverlay: true,
            _runtimeCandidateSeedId: toNum(row.candidateSeedId),
        }));
}

module.exports = {
    OVERLAY_VERSION,
    isPlantSnapshot,
    directReferenceRows,
    calibrateRuntimeSizeEncoding,
    targetPlantRows,
    normalizeRuntimeSize,
    resolveRuntimeTarget,
    buildRuntimePlantOverlay,
    overlayFilePath,
    persistRuntimePlantOverlay,
    loadRuntimePlantOverlay,
    runtimeOverlayPlants,
};
