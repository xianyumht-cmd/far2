const fs = require('node:fs');
const path = require('node:path');
const { ensureDataDir } = require('../config/runtime-paths');
const {
    getAllPlants,
    getItemById,
    getPlantByFruitId,
    isSeedItem,
} = require('../config/gameConfig');
const {
    getIllustratedOverview,
    getShopProfilesOverview,
    getShopInfoOverview,
} = require('./catalog');
const { listActivityOverview } = require('./activity-readonly');

const SNAPSHOT_VERSION = 1;
const SEED_ID_MIN = 20000;
const SEED_ID_MAX = 29999;

let latestSnapshot = null;

function toNum(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function isSeedLikeId(id) {
    const n = toNum(id);
    return n >= SEED_ID_MIN && n <= SEED_ID_MAX;
}

function stableUnique(values) {
    return [...new Set((Array.isArray(values) ? values : []).map(toNum).filter(v => v > 0))];
}

function normalizePlantSize(value) {
    const size = toNum(value);
    return size > 0 ? size : 0;
}

function normalizeAccountFilePart(value) {
    return String(value || 'default').replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 80) || 'default';
}

function buildIllustratedOffsetRule(illustratedItems, plants) {
    const byFruit = new Map();
    for (const plant of (Array.isArray(plants) ? plants : [])) {
        const fruitId = toNum(plant && plant.fruit && plant.fruit.id);
        const seedId = toNum(plant && plant.seed_id);
        if (fruitId > 0 && seedId > 0) byFruit.set(fruitId, seedId);
    }

    const histogram = new Map();
    let matchedPairs = 0;
    for (const item of (Array.isArray(illustratedItems) ? illustratedItems : [])) {
        const rawId = toNum(item && (item.illustratedId || item.fruitId));
        const seedId = byFruit.get(rawId) || 0;
        if (!rawId || !seedId) continue;
        matchedPairs += 1;
        const offset = rawId - seedId;
        histogram.set(offset, (histogram.get(offset) || 0) + 1);
    }

    const ranked = [...histogram.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const dominantOffset = ranked.length ? ranked[0][0] : 0;
    const dominantCount = ranked.length ? ranked[0][1] : 0;
    const ratio = matchedPairs > 0 ? dominantCount / matchedPairs : 0;
    const validated = matchedPairs >= 20 && dominantOffset > 0 && dominantCount === matchedPairs;

    return {
        validated,
        matchedPairs,
        dominantOffset,
        dominantCount,
        ratio,
        histogram: Object.fromEntries(ranked.map(([offset, count]) => [String(offset), count])),
        rule: validated ? `fruitId-seedId=${dominantOffset}` : 'unverified',
    };
}

function collectActivityReferences(activityOverview) {
    const refsByItemId = new Map();
    const discoveryNodes = Array.isArray(activityOverview && activityOverview.discovery && activityOverview.discovery.nodes)
        ? activityOverview.discovery.nodes
        : [];

    for (const node of discoveryNodes) {
        const itemIds = stableUnique(node && node.itemIds);
        for (const itemId of itemIds) {
            if (!refsByItemId.has(itemId)) refsByItemId.set(itemId, []);
            refsByItemId.get(itemId).push({
                activityId: toNum(node && node.id),
                title: String((node && node.title) || '').trim(),
                type: toNum(node && node.type),
                capabilities: Array.isArray(node && node.capabilities) ? [...node.capabilities] : [],
                active: !!(node && node.enabled && node.activeByTime),
            });
        }
    }
    return refsByItemId;
}

async function readSeedShops() {
    const profiles = await getShopProfilesOverview();
    const seedShops = (Array.isArray(profiles && profiles.shops) ? profiles.shops : [])
        .filter(shop => toNum(shop && shop.shopType) === 2);
    const shops = [];
    const seedIds = [];

    for (const shop of seedShops) {
        const shopId = toNum(shop && shop.shopId);
        if (!shopId) continue;
        const info = await getShopInfoOverview(shopId);
        const goods = Array.isArray(info && info.goods) ? info.goods : [];
        shops.push({
            shopId,
            shopName: String((shop && shop.shopName) || ''),
            goods,
        });
        for (const row of goods) {
            const itemId = toNum(row && row.itemId);
            if (itemId) seedIds.push(itemId);
        }
    }

    return {
        profiles,
        shops,
        seedIds: stableUnique(seedIds),
    };
}

async function readComponent(name, fn, attempts = 2) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return { ok: true, name, attempt, value: await fn(), error: '' };
        } catch (error) {
            lastError = error;
        }
    }
    return {
        ok: false,
        name,
        attempt: attempts,
        value: null,
        error: String(lastError && lastError.message ? lastError.message : lastError || 'unknown'),
    };
}

function buildCropRegistrySnapshot(input = {}) {
    const accountId = String(input.accountId || '').trim();
    const plants = Array.isArray(input.plants) ? input.plants : [];
    const cropIllustrated = input.cropIllustrated && typeof input.cropIllustrated === 'object'
        ? input.cropIllustrated
        : { items: [], summary: {}, protocol: {} };
    const mutationIllustrated = input.mutationIllustrated && typeof input.mutationIllustrated === 'object'
        ? input.mutationIllustrated
        : { items: [], summary: {}, protocol: {} };
    const activityOverview = input.activityOverview && typeof input.activityOverview === 'object'
        ? input.activityOverview
        : { activities: [], discovery: { nodes: [], summary: {} }, summary: {} };
    const seedShopSnapshot = input.seedShopSnapshot && typeof input.seedShopSnapshot === 'object'
        ? input.seedShopSnapshot
        : { profiles: { shops: [] }, shops: [], seedIds: [] };
    const bagItems = Array.isArray(input.bagItems) ? input.bagItems : [];
    const components = input.components && typeof input.components === 'object' ? input.components : {};

    const cropItems = Array.isArray(cropIllustrated.items) ? cropIllustrated.items : [];
    const offsetRule = buildIllustratedOffsetRule(cropItems, plants);
    const activityRefs = collectActivityReferences(activityOverview);
    const seedShopIds = new Set(stableUnique(seedShopSnapshot.seedIds));
    const bagCountById = new Map();
    for (const item of bagItems) {
        const id = toNum(item && item.id);
        const count = Math.max(0, toNum(item && item.count));
        if (id > 0) bagCountById.set(id, (bagCountById.get(id) || 0) + count);
    }

    const plantByFruit = new Map();
    const plantBySeed = new Map();
    for (const plant of plants) {
        const fruitId = toNum(plant && plant.fruit && plant.fruit.id);
        const seedId = toNum(plant && plant.seed_id);
        if (fruitId > 0) plantByFruit.set(fruitId, plant);
        if (seedId > 0) plantBySeed.set(seedId, plant);
    }

    const crops = [];
    const cropSeedIds = new Set();
    const cropFruitIds = new Set();

    for (const illustrated of cropItems) {
        const fruitId = toNum(illustrated && (illustrated.illustratedId || illustrated.fruitId));
        if (!fruitId) continue;
        const plant = plantByFruit.get(fruitId) || null;
        let seedId = toNum(plant && plant.seed_id);
        let seedIdSource = seedId > 0 ? 'static-plant-fruit-map' : 'unknown';
        if (!seedId && offsetRule.validated) {
            const candidate = fruitId - offsetRule.dominantOffset;
            if (isSeedLikeId(candidate)) {
                seedId = candidate;
                seedIdSource = 'validated-live-fruit-offset';
            }
        }

        const size = normalizePlantSize(plant && plant.size);
        const seedItem = seedId > 0 ? getItemById(seedId) : null;
        const fruitItem = getItemById(fruitId);
        const refs = seedId > 0 ? (activityRefs.get(seedId) || []) : [];
        const bagCount = seedId > 0 ? (bagCountById.get(seedId) || 0) : 0;
        const name = String(
            (plant && plant.name)
            || (fruitItem && fruitItem.name)
            || (illustrated && illustrated.name)
            || `图鉴作物${fruitId}`
        );

        crops.push({
            fruitId,
            seedId,
            seedIdSource,
            plantId: toNum(plant && plant.id),
            name,
            seedName: String((seedItem && seedItem.name) || (seedId ? `种子${seedId}` : '')),
            illustratedPresent: true,
            illustratedTier: toNum(illustrated && illustrated.illustratedTier),
            illustratedUnlocked: !!(illustrated && illustrated.unlocked),
            size: size || 0,
            gridCount: size > 0 ? size * size : 0,
            seasons: toNum(plant && plant.seasons),
            levelNeed: toNum(plant && plant.land_level_need),
            growPhases: String((plant && plant.grow_phases) || ''),
            exp: toNum(plant && plant.exp),
            inSeedShop: seedId > 0 && seedShopIds.has(seedId),
            bagCount,
            activityRefs: refs,
            evidence: [
                'server-illustrated-type-1',
                plant ? 'static-plant-config' : '',
                seedIdSource === 'validated-live-fruit-offset' ? 'live-offset-rule' : '',
                seedId > 0 && seedShopIds.has(seedId) ? 'live-seed-shop' : '',
                refs.length ? 'live-activity-reference' : '',
                bagCount > 0 ? 'live-bag' : '',
            ].filter(Boolean),
            autoPlantReady: seedId > 0 && size > 0,
        });
        cropFruitIds.add(fruitId);
        if (seedId > 0) cropSeedIds.add(seedId);
    }

    for (const plant of plants) {
        const seedId = toNum(plant && plant.seed_id);
        const fruitId = toNum(plant && plant.fruit && plant.fruit.id);
        if (!seedId || cropSeedIds.has(seedId) || (fruitId && cropFruitIds.has(fruitId))) continue;
        const size = normalizePlantSize(plant && plant.size);
        const seedItem = getItemById(seedId);
        const refs = activityRefs.get(seedId) || [];
        const bagCount = bagCountById.get(seedId) || 0;
        crops.push({
            fruitId,
            seedId,
            seedIdSource: 'static-plant-config',
            plantId: toNum(plant && plant.id),
            name: String((plant && plant.name) || `植物${toNum(plant && plant.id)}`),
            seedName: String((seedItem && seedItem.name) || `种子${seedId}`),
            illustratedPresent: false,
            illustratedTier: 0,
            illustratedUnlocked: false,
            size: size || 0,
            gridCount: size > 0 ? size * size : 0,
            seasons: toNum(plant && plant.seasons),
            levelNeed: toNum(plant && plant.land_level_need),
            growPhases: String((plant && plant.grow_phases) || ''),
            exp: toNum(plant && plant.exp),
            inSeedShop: seedShopIds.has(seedId),
            bagCount,
            activityRefs: refs,
            evidence: ['static-plant-config', seedShopIds.has(seedId) ? 'live-seed-shop' : '', refs.length ? 'live-activity-reference' : '', bagCount > 0 ? 'live-bag' : ''].filter(Boolean),
            autoPlantReady: size > 0,
        });
        cropSeedIds.add(seedId);
        if (fruitId) cropFruitIds.add(fruitId);
    }

    const observedIds = stableUnique([
        ...bagCountById.keys(),
        ...activityRefs.keys(),
        ...seedShopIds,
    ]);
    const observedItems = observedIds.map((itemId) => {
        const info = getItemById(itemId);
        const crop = crops.find(row => row.seedId === itemId || row.fruitId === itemId) || null;
        return {
            itemId,
            name: String((info && info.name) || ''),
            type: toNum(info && info.type),
            interactionType: String((info && (info.interaction_type || info.interactionType)) || ''),
            bagCount: bagCountById.get(itemId) || 0,
            inSeedShop: seedShopIds.has(itemId),
            activityRefs: activityRefs.get(itemId) || [],
            staticSeed: isSeedItem(itemId),
            matchedCropSeedId: crop ? crop.seedId : 0,
            matchedCropFruitId: crop ? crop.fruitId : 0,
            cropIdentitySource: crop ? crop.seedIdSource : 'unmatched',
        };
    });

    const tierMap = new Map();
    for (const crop of crops.filter(row => row.illustratedPresent)) {
        const tier = crop.illustratedTier;
        if (!tierMap.has(tier)) {
            tierMap.set(tier, {
                tier,
                total: 0,
                seedMapped: 0,
                seedShop: 0,
                size1: 0,
                size2: 0,
                multiGrid: 0,
                sizeUnknown: 0,
                activityReferenced: 0,
            });
        }
        const stat = tierMap.get(tier);
        stat.total += 1;
        if (crop.seedId > 0) stat.seedMapped += 1;
        if (crop.inSeedShop) stat.seedShop += 1;
        if (crop.size === 1) stat.size1 += 1;
        else if (crop.size === 2) stat.size2 += 1;
        else if (crop.size > 2) stat.multiGrid += 1;
        else stat.sizeUnknown += 1;
        if (crop.activityRefs.length) stat.activityReferenced += 1;
    }

    const unresolvedSeedLikeIds = observedItems
        .filter(row => isSeedLikeId(row.itemId) && !row.matchedCropSeedId && !row.staticSeed && !row.inSeedShop)
        .map(row => row.itemId);

    const componentState = {
        cropIllustrated: !!components.cropIllustrated,
        mutationIllustrated: !!components.mutationIllustrated,
        activities: !!components.activities,
        seedShops: !!components.seedShops,
    };
    const fullReadComplete = Object.values(componentState).every(Boolean);
    const cropInferenceReady = componentState.cropIllustrated && componentState.activities;

    return {
        version: SNAPSHOT_VERSION,
        generatedAt: new Date().toISOString(),
        accountId,
        readiness: {
            fullReadComplete,
            cropInferenceReady,
            componentState,
        },
        mappingRule: offsetRule,
        sources: {
            cropIllustrated: {
                protocol: cropIllustrated.protocol || null,
                summary: cropIllustrated.summary || {},
            },
            mutationIllustrated: {
                protocol: mutationIllustrated.protocol || null,
                summary: mutationIllustrated.summary || {},
            },
            activities: {
                summary: activityOverview.summary || {},
                deepSummary: activityOverview.deepSummary || (activityOverview.discovery && activityOverview.discovery.summary) || {},
                groupSummary: activityOverview.groupSummary || {},
            },
            seedShops: {
                shopCount: Array.isArray(seedShopSnapshot.shops) ? seedShopSnapshot.shops.length : 0,
                seedIdCount: seedShopIds.size,
            },
        },
        tierStats: [...tierMap.values()].sort((a, b) => a.tier - b.tier),
        crops: crops.sort((a, b) => (a.illustratedTier - b.illustratedTier) || (a.fruitId - b.fruitId) || (a.seedId - b.seedId)),
        observedItems,
        unresolvedSeedLikeIds: stableUnique(unresolvedSeedLikeIds),
        safety: {
            readOnlySync: true,
            activityWriteCalled: false,
            illustratedClaimCalled: false,
            purchaseCalled: false,
            plantCalled: false,
            unknownSizeNeverInferredFromTier: true,
        },
    };
}

function persistSnapshot(snapshot) {
    const dir = path.join(ensureDataDir(), 'crop_registry');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${normalizeAccountFilePart(snapshot && snapshot.accountId)}.json`);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, target);
    return target;
}

async function refreshStartupCropRegistry(options = {}) {
    const accountId = String(options.accountId || '').trim();
    const bagItems = Array.isArray(options.bagItems) ? options.bagItems : [];
    const plants = getAllPlants();

    const cropIllustrated = await readComponent('cropIllustrated', () => getIllustratedOverview({ illustratedType: 1, refresh: true }));
    const mutationIllustrated = await readComponent('mutationIllustrated', () => getIllustratedOverview({ illustratedType: 2, refresh: true }));
    const activities = await readComponent('activities', () => listActivityOverview({ force: true, groupLimit: 32 }));
    const seedShops = await readComponent('seedShops', () => readSeedShops());

    const snapshot = buildCropRegistrySnapshot({
        accountId,
        plants,
        bagItems,
        cropIllustrated: cropIllustrated.value || undefined,
        mutationIllustrated: mutationIllustrated.value || undefined,
        activityOverview: activities.value || undefined,
        seedShopSnapshot: seedShops.value || undefined,
        components: {
            cropIllustrated: cropIllustrated.ok,
            mutationIllustrated: mutationIllustrated.ok,
            activities: activities.ok,
            seedShops: seedShops.ok,
        },
    });
    snapshot.componentErrors = [cropIllustrated, mutationIllustrated, activities, seedShops]
        .filter(row => !row.ok)
        .map(row => ({ name: row.name, error: row.error }));
    snapshot.persistedPath = persistSnapshot(snapshot);
    latestSnapshot = snapshot;
    return snapshot;
}

function getStartupCropRegistrySnapshot() {
    return latestSnapshot;
}

module.exports = {
    SNAPSHOT_VERSION,
    SEED_ID_MIN,
    SEED_ID_MAX,
    isSeedLikeId,
    buildIllustratedOffsetRule,
    collectActivityReferences,
    buildCropRegistrySnapshot,
    refreshStartupCropRegistry,
    getStartupCropRegistrySnapshot,
};
