// Internal worker bridge for one manual P7E action.
// This does not add a scheduler and does not alter normal Catalog actions.
function installDogFeedActionHook() {
    const catalog = require('./catalog');
    if (!catalog || typeof catalog.getShopInfoOverview !== 'function') {
        throw new Error('Catalog action bridge unavailable');
    }
    if (catalog.__far2DogFeedActionHookInstalled) return () => {};

    const original = catalog.getShopInfoOverview;
    const wrapped = async function far2DogFeedActionBridge(input) {
        if (input && typeof input === 'object' && !Array.isArray(input)
            && String(input.action || '') === 'feedDogFoodOnce') {
            try {
                return await require('./dog').feedDogFoodOnce(input.foodId);
            } catch (error) {
                const statusCode = Number(error && error.statusCode) || 0;
                if (statusCode >= 400 && statusCode < 500) {
                    return {
                        ok: false,
                        statusCode,
                        error: error && error.message ? error.message : String(error || 'unknown'),
                    };
                }
                throw error;
            }
        }
        return original(input);
    };

    catalog.getShopInfoOverview = wrapped;
    catalog.__far2DogFeedActionHookInstalled = true;

    return function uninstallDogFeedActionHook() {
        if (catalog.getShopInfoOverview === wrapped) catalog.getShopInfoOverview = original;
        delete catalog.__far2DogFeedActionHookInstalled;
    };
}

module.exports = {
    installDogFeedActionHook,
};
