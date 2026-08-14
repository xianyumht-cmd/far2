function normalizeIdList(value) {
    return (Array.isArray(value) ? value : [])
        .map(item => Number(item) || 0)
        .filter(item => item > 0);
}

function shouldBlockShopFallback(prepass) {
    if (!prepass || prepass.blockShopFallback !== true) return false;

    const unresolvedIds = normalizeIdList(prepass.unresolvedSeedIds);
    if (unresolvedIds.length === 0) {
        // Block came from a known-seed write/probe failure or unsupported known footprint.
        return true;
    }

    const priorityIds = normalizeIdList(prepass.prioritySeedIds);
    const candidates = prepass
        && prepass.inspection
        && prepass.inspection.inventory
        && Array.isArray(prepass.inspection.inventory.unresolvedCandidates)
        ? prepass.inspection.inventory.unresolvedCandidates
        : [];

    const unresolvedSet = new Set(unresolvedIds);
    const highConfidence = candidates.some(row => (
        unresolvedSet.has(Number(row && row.seedId) || 0)
        && String((row && row.confidence) || '') === 'high'
    ));

    // Activity references alone are generic reward evidence; only strong seed
    // evidence may stop ordinary planting.
    if (highConfidence) return true;

    // If a resolved special seed also participated, keep the conservative block because
    // the base prepass may have set it after a 1x1/2x2 write/probe failure.
    if (priorityIds.length > 0) return true;

    // Namespace-only medium candidates are still recorded and cache-learned, but must not
    // permanently stop a healthy farm when official cache evidence is absent.
    return false;
}

module.exports = {
    shouldBlockShopFallback,
};
