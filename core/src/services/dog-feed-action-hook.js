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
            return require('./dog').feedDogFoodOnce(input.foodId);
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
