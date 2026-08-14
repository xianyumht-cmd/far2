const {
    getPlantBySeedId,
    getItemById,
} = require('../config/gameConfig');
const { getRegistryPlantBySeedId } = require('./runtime-crop-registry-resolver');
const { learnSeedConfigFromQqCache } = require('./qq-seed-config-learner');

function normalizePositiveInt(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    const result = Math.trunc(num);
    return result > 0 ? result : 0;
}

function isSeedNamespaceId(seedId) {
    const id = normalizePositiveInt(seedId);
    return id >= 20000 && id <= 29999;
}

function shouldTryRuntimeLearning(seedId, itemInfo) {
    const id = normalizePositiveInt(seedId);
    if (id <= 0) return false;
    const info = itemInfo && typeof itemInfo === 'object' ? itemInfo : null;
    if (Number(info && info.type) === 5) return true;
    if (String((info && info.interaction_type) || '').trim().toLowerCase() === 'plant') return true;
    if (/种子/u.test(String((info && info.name) || ''))) return true;
    return isSeedNamespaceId(id);
}

function buildLearnedPlant(seedId, learned, itemInfo) {
    const id = normalizePositiveInt(seedId);
    if (id <= 0 || !learned) return null;
    const plantSize = Math.max(0, Number(learned.plantSize) || 0);
    if (![1, 2].includes(plantSize)) return null;

    const rawName = String(
        learned.name
        || (itemInfo && itemInfo.name)
        || `种子${id}`,
    ).trim();
    const name = rawName.replace(/种子$/u, '').trim() || `种子${id}`;

    return {
        id: 2000000 + id,
        name,
        seed_id: id,
        land_level_need: Math.max(
            0,
            Number(learned.requiredLevel)
            || Number(itemInfo && itemInfo.level)
            || 0,
        ),
        seasons: 1,
        grow_phases: '',
        exp: 0,
        size: plantSize,
        fruit: null,
        config_fallback: true,
        runtime_learned: true,
        learned_evidence: String(learned.evidence || 'qq-cache:same-object-seed_id+size'),
        learned_source_file: String(learned.sourceFile || ''),
    };
}

function createLearnedSeedResolver(options = {}) {
    const readStaticPlant = typeof options.getPlantBySeedId === 'function'
        ? options.getPlantBySeedId
        : getPlantBySeedId;
    const readRegistryPlant = typeof options.getRegistryPlantBySeedId === 'function'
        ? options.getRegistryPlantBySeedId
        : getRegistryPlantBySeedId;
    const readItem = typeof options.getItemById === 'function'
        ? options.getItemById
        : getItemById;
    const learn = typeof options.learnSeedConfigFromQqCache === 'function'
        ? options.learnSeedConfigFromQqCache
        : learnSeedConfigFromQqCache;

    return function resolvePlantBySeedId(seedId) {
        const id = normalizePositiveInt(seedId);
        if (id <= 0) return null;

        const staticPlant = readStaticPlant(id);
        if (staticPlant) return staticPlant;

        // Startup Crop Registry is produced before worker automation is released.
        // Only exact, proven autoPlantReady rows are exposed by this resolver.
        // This is preferred over QQ cache learning because identity + footprint
        // have already been calibrated and persisted by the startup Gate.
        const registryPlant = readRegistryPlant(id);
        if (registryPlant) return registryPlant;

        const itemInfo = readItem(id) || null;
        if (!shouldTryRuntimeLearning(id, itemInfo)) return null;

        let learned = null;
        try {
            learned = learn(id);
        } catch {
            learned = null;
        }
        return buildLearnedPlant(id, learned, itemInfo);
    };
}

const getPlantBySeedIdWithLearning = createLearnedSeedResolver();

module.exports = {
    isSeedNamespaceId,
    shouldTryRuntimeLearning,
    buildLearnedPlant,
    createLearnedSeedResolver,
    getPlantBySeedIdWithLearning,
};
