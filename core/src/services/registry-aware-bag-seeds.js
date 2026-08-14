const { getSeedImageBySeedId, getItemImageById } = require('../config/gameConfig');
const { getBag, getBagItems } = require('./warehouse');
const { getPlantBySeedIdWithLearning } = require('./learned-seed-resolver');

function toPositiveInt(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    const result = Math.trunc(num);
    return result > 0 ? result : 0;
}

function buildBagSeedsFromItems(rawItems, options = {}) {
    const resolvePlant = typeof options.getPlantBySeedId === 'function'
        ? options.getPlantBySeedId
        : getPlantBySeedIdWithLearning;
    const getSeedImage = typeof options.getSeedImageBySeedId === 'function'
        ? options.getSeedImageBySeedId
        : getSeedImageBySeedId;
    const getItemImage = typeof options.getItemImageById === 'function'
        ? options.getItemImageById
        : getItemImageById;
    const merged = new Map();

    for (const item of (Array.isArray(rawItems) ? rawItems : [])) {
        const seedId = toPositiveInt(item && item.id);
        const count = toPositiveInt(item && item.count);
        if (!seedId || !count) continue;

        const plant = resolvePlant(seedId);
        if (!plant) continue;
        const plantSize = Math.max(1, Number(plant.size) || 1);
        if (![1, 2].includes(plantSize)) continue;

        const current = merged.get(seedId) || {
            seedId,
            name: String(plant.name || `种子#${seedId}`),
            count: 0,
            requiredLevel: Math.max(0, Number(plant.land_level_need) || 0),
            image: getSeedImage(seedId) || getItemImage(seedId) || '',
            plantSize,
            runtimeRegistry: plant.runtime_registry === true,
            runtimeLearned: plant.runtime_learned === true,
        };
        current.count += count;
        merged.set(seedId, current);
    }

    return Array.from(merged.values());
}

function createRegistryAwareBagSeedReader(options = {}) {
    const readBag = typeof options.getBag === 'function' ? options.getBag : getBag;
    const extractBagItems = typeof options.getBagItems === 'function' ? options.getBagItems : getBagItems;

    return async function getRegistryAwareBagSeeds() {
        const bagReply = await readBag();
        return buildBagSeedsFromItems(extractBagItems(bagReply), options);
    };
}

const getRegistryAwareBagSeeds = createRegistryAwareBagSeedReader();

module.exports = {
    toPositiveInt,
    buildBagSeedsFromItems,
    createRegistryAwareBagSeedReader,
    getRegistryAwareBagSeeds,
};
