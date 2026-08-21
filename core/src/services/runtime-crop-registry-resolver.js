const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { ensureDataDir } = require('../config/runtime-paths');

const PROVEN_IDENTITY = new Set([
    'proven-runtime-plant-map',
    'proven-static-plant-map',
]);

function toPositiveInt(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    const result = Math.trunc(num);
    return result > 0 ? result : 0;
}

function normalizeAccountFilePart(value) {
    return String(value || '')
        .trim()
        .replace(/[^a-zA-Z0-9_.-]+/g, '_')
        .slice(0, 80);
}

function isProvenAutoPlantCrop(crop) {
    if (!crop || typeof crop !== 'object') return false;
    const seedId = toPositiveInt(crop.seedId);
    const size = toPositiveInt(crop.size);
    if (!seedId || ![1, 2].includes(size)) return false;
    if (crop.autoPlantReady !== true) return false;
    if (!PROVEN_IDENTITY.has(String(crop.identityConfidence || ''))) return false;
    if (String(crop.footprintConfidence || '') !== 'proven-config') return false;
    if (!['runtime-plant-overlay', 'static-plant-config'].includes(String(crop.footprintSource || ''))) return false;
    return true;
}

function buildPlantFromRegistryCrop(crop) {
    if (!isProvenAutoPlantCrop(crop)) return null;
    const seedId = toPositiveInt(crop.seedId);
    const fruitId = toPositiveInt(crop.fruitId);
    const plantId = toPositiveInt(crop.plantId);
    const size = toPositiveInt(crop.size);
    return {
        id: plantId || (3000000 + seedId),
        name: String(crop.name || crop.seedName || `种子${seedId}`).replace(/种子$/u, '').trim() || `种子${seedId}`,
        seed_id: seedId,
        land_level_need: Math.max(0, Number(crop.levelNeed) || 0),
        seasons: Math.max(1, Number(crop.seasons) || 1),
        grow_phases: String(crop.growPhases || ''),
        exp: Math.max(0, Number(crop.exp) || 0),
        size,
        fruit: fruitId > 0 ? { id: fruitId } : null,
        config_fallback: true,
        runtime_registry: true,
        registry_identity_confidence: String(crop.identityConfidence || ''),
        registry_footprint_source: String(crop.footprintSource || ''),
    };
}

function buildRegistryPlantIndex(snapshot) {
    const index = new Map();
    const conflicts = new Set();
    if (!snapshot || snapshot.readiness?.fullReadComplete !== true) return index;

    for (const crop of (Array.isArray(snapshot.crops) ? snapshot.crops : [])) {
        const plant = buildPlantFromRegistryCrop(crop);
        if (!plant) continue;
        const seedId = toPositiveInt(plant.seed_id);
        if (!seedId || conflicts.has(seedId)) continue;

        const previous = index.get(seedId);
        if (!previous) {
            index.set(seedId, plant);
            continue;
        }

        const same = Number(previous.size) === Number(plant.size)
            && toPositiveInt(previous.fruit && previous.fruit.id) === toPositiveInt(plant.fruit && plant.fruit.id)
            && String(previous.name || '') === String(plant.name || '');
        if (!same) {
            index.delete(seedId);
            conflicts.add(seedId);
        }
    }
    return index;
}

function createRuntimeCropRegistryReader(options = {}) {
    const fsRef = options.fs || fs;
    const getDataDir = typeof options.getDataDir === 'function' ? options.getDataDir : ensureDataDir;
    const getAccountId = typeof options.getAccountId === 'function'
        ? options.getAccountId
        : () => process.env.FARM_ACCOUNT_ID || '';

    let cache = {
        file: '',
        mtimeMs: -1,
        size: -1,
        index: new Map(),
    };

    function loadIndex() {
        const accountPart = normalizeAccountFilePart(getAccountId());
        if (!accountPart) return new Map();
        const file = path.join(getDataDir(), 'crop_registry', `${accountPart}.json`);

        try {
            const stat = fsRef.statSync(file);
            const mtimeMs = Number(stat.mtimeMs) || 0;
            const size = Number(stat.size) || 0;
            if (cache.file === file && cache.mtimeMs === mtimeMs && cache.size === size) {
                return cache.index;
            }

            const snapshot = JSON.parse(fsRef.readFileSync(file, 'utf8'));
            const index = buildRegistryPlantIndex(snapshot);
            cache = { file, mtimeMs, size, index };
            return index;
        } catch {
            cache = { file, mtimeMs: -1, size: -1, index: new Map() };
            return cache.index;
        }
    }

    return function getRegistryPlantBySeedId(seedId) {
        const id = toPositiveInt(seedId);
        if (!id) return null;
        return loadIndex().get(id) || null;
    };
}

const getRegistryPlantBySeedId = createRuntimeCropRegistryReader();

module.exports = {
    PROVEN_IDENTITY,
    toPositiveInt,
    normalizeAccountFilePart,
    isProvenAutoPlantCrop,
    buildPlantFromRegistryCrop,
    buildRegistryPlantIndex,
    createRuntimeCropRegistryReader,
    getRegistryPlantBySeedId,
};
