const fs = require('node:fs');
const path = require('node:path');
const { ensureDataDir } = require('../config/runtime-paths');
const { getAllPlants } = require('../config/gameConfig');
const {
    getIllustratedOverview,
    getShopProfilesOverview,
    getShopInfoOverview,
} = require('./catalog');
const { listActivityOverview } = require('./activity-readonly');
const { buildCropRegistrySnapshot } = require('./startup-crop-registry');
const {
    loadRuntimePlantOverlay,
    runtimeOverlayPlants,
} = require('./runtime-plant-overlay-evidence');

const SNAPSHOT_VERSION = 2;

function toNum(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function normalizeStaticPlant(plant) {
    if (!plant || typeof plant !== 'object') return plant;
    const rawSize = toNum(plant.size);
    // QQ Plant config uses size=0 for an ordinary single-land crop.
    // FAR2 runtime has historically normalized it to 1 via getSeedPlantSize().
    // Keep unknown footprint as 0 only when there is no static plant record at all.
    if (rawSize > 0) return plant;
    return { ...plant, size: 1, _registryRawSize: rawSize };
}

function normalizeStaticPlants(plants) {
    return (Array.isArray(plants) ? plants : []).map(normalizeStaticPlant);
}

function stableUnique(values) {
    return [...new Set((Array.isArray(values) ? values : [])
        .map(toNum)
        .filter(value => value > 0))];
}

function requireIllustratedItems(value, label) {
    const items = Array.isArray(value && value.items) ? value.items : [];
    if (!items.length) throw new Error(`${label} returned no items`);
    return value;
}

function requireDeepActivity(value) {
    const framework = value && value.framework && typeof value.framework === 'object' ? value.framework : {};
    const groupSummary = value && value.groupSummary && typeof value.groupSummary === 'object'
        ? value.groupSummary
        : {};
    if (!value || !value.discovery || framework.deepDiscovery !== true) {
        throw new Error(`activity deep discovery incomplete: ${String((value && value.discoveryError) || 'no discovery snapshot')}`);
    }
    const requested = Math.max(0, toNum(groupSummary.requested));
    const loaded = Math.max(0, toNum(groupSummary.loaded));
    const failed = Math.max(0, toNum(groupSummary.failed));
    if (failed > 0 || loaded < requested) {
        throw new Error(`activity groups incomplete: requested=${requested} loaded=${loaded} failed=${failed}`);
    }
    return value;
}

async function readSeedShops() {
    const profiles = await getShopProfilesOverview();
    const seedShops = (Array.isArray(profiles && profiles.shops) ? profiles.shops : [])
        .filter(shop => toNum(shop && shop.shopType) === 2);
    if (!seedShops.length) throw new Error('server returned no seed shop profile');

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
    if (!shops.length) throw new Error('seed shop profile exists but no shop detail loaded');
    return { profiles, shops, seedIds: stableUnique(seedIds) };
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

function decorateSnapshot(snapshot, rawPlants, runtimeOverlay = null) {
    const plantSeedIds = new Set((Array.isArray(rawPlants) ? rawPlants : [])
        .map(plant => toNum(plant && plant.seed_id))
        .filter(Boolean));
    const overlayEntries = runtimeOverlay && runtimeOverlay.calibration && runtimeOverlay.calibration.proven === true
        ? (Array.isArray(runtimeOverlay.entries) ? runtimeOverlay.entries : [])
        : [];
    const overlayByFruit = new Map(overlayEntries
        .filter(row => row && row.ok && toNum(row.fruitId) > 0 && toNum(row.seedId) > 0)
        .map(row => [toNum(row.fruitId), row]));

    snapshot.version = SNAPSHOT_VERSION;
    snapshot.protocolEvidence = {
        cropIllustratedType: 1,
        mutationIllustratedType: 2,
        cropTierMeaning: 'server-tier-preserved; tier alone never proves footprint',
        fruitOffsetIdentityPolicy: 'diagnostic-only; never promotes seed identity',
        ordinaryStaticSizeRule: 'Plant.size=0 => 1x1',
        runtimePlantSizeRule: overlayEntries.length
            ? 'calibrated official runtime: size=null => 1x1; size=2 => 2x2'
            : 'no proven runtime overlay loaded',
        runtimePlantOverlay: {
            loaded: overlayEntries.length > 0,
            entries: overlayEntries.length,
            corrections: Array.isArray(runtimeOverlay && runtimeOverlay.corrections) ? runtimeOverlay.corrections : [],
        },
    };

    snapshot.crops = (Array.isArray(snapshot.crops) ? snapshot.crops : []).map((crop) => {
        const seedId = toNum(crop && crop.seedId);
        const fruitId = toNum(crop && crop.fruitId);
        const tier = toNum(crop && crop.illustratedTier);
        const hasStaticPlant = seedId > 0 && plantSeedIds.has(seedId);
        const runtimeEntry = overlayByFruit.get(fruitId) || null;
        const hasRuntimePlant = !!runtimeEntry && toNum(runtimeEntry.seedId) === seedId;
        const derivedLiveIdentity = crop && crop.seedIdSource === 'validated-live-fruit-offset';
        const size = toNum(crop && crop.size);
        const evidence = Array.isArray(crop && crop.evidence) ? [...crop.evidence] : [];
        if (hasRuntimePlant && !evidence.includes('runtime-plant-overlay')) evidence.push('runtime-plant-overlay');
        if (hasRuntimePlant && !hasStaticPlant) {
            const index = evidence.indexOf('static-plant-config');
            if (index >= 0) evidence.splice(index, 1);
        }

        return {
            ...crop,
            seedIdSource: hasRuntimePlant ? 'runtime-plant-fruit-map' : crop.seedIdSource,
            illustratedClass: tier <= 0 ? 'not-in-live-illustrated' : (tier === 1 ? 'tier-1' : `special-tier-${tier}`),
            identityConfidence: seedId <= 0
                ? 'unknown'
                : (hasRuntimePlant
                    ? 'proven-runtime-plant-map'
                    : (derivedLiveIdentity ? 'proven-live-illustrated-map' : (hasStaticPlant ? 'proven-static-plant-map' : 'observed'))),
            footprintSource: size > 0
                ? (hasRuntimePlant ? 'runtime-plant-overlay' : (hasStaticPlant ? 'static-plant-config' : 'unknown'))
                : 'unknown',
            footprintConfidence: size > 0 && (hasRuntimePlant || hasStaticPlant) ? 'proven-config' : 'unknown',
            evidence,
            // Runtime overlay is accepted only after known 1x1/2x2 calibration,
            // so it can safely graduate both identity and footprint together.
            autoPlantReady: seedId > 0 && size > 0 && (hasRuntimePlant || hasStaticPlant),
        };
    });

    const tierStats = new Map();
    for (const crop of snapshot.crops.filter(row => row && row.illustratedPresent)) {
        const tier = toNum(crop.illustratedTier);
        if (!tierStats.has(tier)) {
            tierStats.set(tier, {
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
        const stat = tierStats.get(tier);
        stat.total += 1;
        if (toNum(crop.seedId) > 0) stat.seedMapped += 1;
        if (crop.inSeedShop) stat.seedShop += 1;
        if (toNum(crop.size) === 1) stat.size1 += 1;
        else if (toNum(crop.size) === 2) stat.size2 += 1;
        else if (toNum(crop.size) > 2) stat.multiGrid += 1;
        else stat.sizeUnknown += 1;
        if (Array.isArray(crop.activityRefs) && crop.activityRefs.length) stat.activityReferenced += 1;
    }
    snapshot.tierStats = [...tierStats.values()].sort((a, b) => a.tier - b.tier);

    const illustratedCrops = snapshot.crops.filter(row => row && row.illustratedPresent);
    snapshot.liveIllustratedSummary = {
        total: illustratedCrops.length,
        tierCounts: Object.fromEntries(snapshot.tierStats.map(row => [String(row.tier), row.total])),
        liveDerivedSeedIdentities: illustratedCrops.filter(row => row.seedIdSource === 'validated-live-fruit-offset').length,
        runtimeOverlaySeedIdentities: illustratedCrops.filter(row => row.seedIdSource === 'runtime-plant-fruit-map').length,
        unresolvedFootprints: illustratedCrops.filter(row => toNum(row.seedId) > 0 && toNum(row.size) <= 0).length,
    };

    snapshot.safety = {
        ...(snapshot.safety || {}),
        identityAndFootprintSeparated: true,
        tierNeverPromotesFootprint: true,
        liveIllustratedSeedWithoutFootprintNeverAutoPlants: true,
        runtimeOverlayRequiresKnownSizeCalibration: true,
        runtimeOverlayOverridesFruitOffsetGuess: true,
        fruitOffsetNeverPromotesIdentity: true,
    };
    return snapshot;
}

function buildCropRegistrySnapshotV2(input = {}) {
    const rawPlants = Array.isArray(input.plants) ? input.plants : [];
    // Pure fixture/build callers never read local core/data implicitly.
    // Real startup passes a proven local overlay explicitly from refreshStartupCropRegistry().
    const runtimeOverlay = input.runtimePlantOverlay && typeof input.runtimePlantOverlay === 'object'
        ? input.runtimePlantOverlay
        : null;
    const runtimePlants = runtimeOverlayPlants(runtimeOverlay);
    const snapshot = buildCropRegistrySnapshot({
        ...input,
        // Official runtime Plant proved at least one real exception
        // (fruit 49002 -> seed 20416), so +20000 can never prove identity.
        allowOffsetIdentityPromotion: false,
        plants: [...normalizeStaticPlants(rawPlants), ...runtimePlants],
    });
    return decorateSnapshot(snapshot, rawPlants, runtimeOverlay);
}

function persistSnapshot(snapshot) {
    const accountPart = String((snapshot && snapshot.accountId) || 'default')
        .replace(/[^a-zA-Z0-9_.-]+/g, '_')
        .slice(0, 80) || 'default';
    const dir = path.join(ensureDataDir(), 'crop_registry');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${accountPart}.json`);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, target);
    return target;
}

async function refreshStartupCropRegistry(options = {}) {
    const accountId = String(options.accountId || '').trim();
    const bagItems = Array.isArray(options.bagItems) ? options.bagItems : [];
    const plants = getAllPlants();
    const runtimePlantOverlay = loadRuntimePlantOverlay();

    // These are all read-only RPCs. Keep them sequential to avoid competing for
    // the shared websocket pending-request slots during account bootstrap.
    const cropIllustrated = await readComponent('cropIllustrated', async () => requireIllustratedItems(
        await getIllustratedOverview({ illustratedType: 1, refresh: false }),
        'crop illustrated type=1',
    ));
    const mutationIllustrated = await readComponent('mutationIllustrated', async () => requireIllustratedItems(
        await getIllustratedOverview({ illustratedType: 2, refresh: false }),
        'mutation illustrated type=2',
    ));
    const activities = await readComponent('activities', async () => requireDeepActivity(
        await listActivityOverview({ force: true, groupLimit: 32 }),
    ));
    const seedShops = await readComponent('seedShops', () => readSeedShops());

    const snapshot = buildCropRegistrySnapshotV2({
        accountId,
        plants,
        runtimePlantOverlay,
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
    return snapshot;
}

module.exports = {
    SNAPSHOT_VERSION,
    normalizeStaticPlant,
    normalizeStaticPlants,
    requireIllustratedItems,
    requireDeepActivity,
    decorateSnapshot,
    buildCropRegistrySnapshotV2,
    refreshStartupCropRegistry,
};
