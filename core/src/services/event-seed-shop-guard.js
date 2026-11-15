/**
 * Unknown seed-like inventory is diagnostic data, not verified land geometry.
 * Refuse speculative 2x2 land reservations. Keep a fail-closed shop fallback
 * only for explicit known-seed write/probe failures or a failed bag read.
 */
function shouldBlockShopFallback(prepass) {
    if (!prepass || prepass.blockShopFallback !== true) return false;
    if (prepass.knownSeedBlock === true) return true;
    if (Array.isArray(prepass.knownSeedBlockReasons) && prepass.knownSeedBlockReasons.length > 0) {
        return true;
    }
    const unresolvedIds = Array.isArray(prepass.unresolvedSeedIds)
        ? prepass.unresolvedSeedIds.filter(id => Number(id) > 0)
        : [];
    if (unresolvedIds.length > 0) return false;
    // A prepass read failure carries no unresolved ids but must not purchase.
    return true;
}

module.exports = { shouldBlockShopFallback };
