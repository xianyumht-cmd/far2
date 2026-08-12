function registerCatalogApi(app, options = {}) {
    const {
        provider,
        getAccId,
        checkAccountAccess,
        handleApiError,
    } = options;

    if (!app) throw new Error('Catalog API requires express app');

    function requireAccount(req, res) {
        const accountId = typeof getAccId === 'function' ? String(getAccId(req) || '').trim() : '';
        if (!accountId) {
            res.status(400).json({ ok: false, error: 'Missing x-account-id' });
            return '';
        }
        if (typeof checkAccountAccess === 'function' && !checkAccountAccess(req, accountId)) {
            res.status(403).json({ ok: false, error: '无权访问此账号' });
            return '';
        }
        return accountId;
    }

    function fail(res, err) {
        if (typeof handleApiError === 'function') return handleApiError(res, err);
        return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err || 'unknown') });
    }

    async function runCatalogAction(req, res, action) {
        const accountId = requireAccount(req, res);
        if (!accountId) return;
        try {
            if (!provider || typeof provider.getShopInfo !== 'function') {
                return res.status(503).json({ ok: false, error: 'Catalog action unavailable' });
            }
            const payload = { action, ...(req.body && typeof req.body === 'object' ? req.body : {}) };
            const data = await provider.getShopInfo(accountId, payload);
            return res.json({ ok: true, data });
        }
        catch (err) {
            return fail(res, err);
        }
    }

    app.get('/api/catalog/illustrated', async (req, res) => {
        const accountId = requireAccount(req, res);
        if (!accountId) return;
        try {
            if (!provider || typeof provider.getIllustrated !== 'function') {
                return res.status(503).json({ ok: false, error: 'Illustrated catalog unavailable' });
            }
            const data = await provider.getIllustrated(accountId);
            return res.json({ ok: true, data });
        }
        catch (err) {
            return fail(res, err);
        }
    });

    app.get('/api/catalog/illustrated/purchase-plan', async (req, res) => {
        return runCatalogAction(req, res, 'getMissingSeedPurchasePlan');
    });

    app.post('/api/catalog/illustrated/claim', async (req, res) => {
        return runCatalogAction(req, res, 'claimIllustratedRewards');
    });

    app.post('/api/catalog/illustrated/buy-seed', async (req, res) => {
        const goodsId = Number(req.body && req.body.goodsId);
        if (!Number.isSafeInteger(goodsId) || goodsId <= 0) {
            return res.status(400).json({ ok: false, error: 'Invalid goodsId' });
        }
        return runCatalogAction(req, res, 'buyIllustratedSeed');
    });

    app.post('/api/catalog/illustrated/buy-missing-seeds', async (req, res) => {
        return runCatalogAction(req, res, 'buyAllMissingIllustratedSeeds');
    });

    app.get('/api/catalog/shops', async (req, res) => {
        const accountId = requireAccount(req, res);
        if (!accountId) return;
        try {
            if (!provider || typeof provider.getShopProfiles !== 'function') {
                return res.status(503).json({ ok: false, error: 'Shop catalog unavailable' });
            }
            const data = await provider.getShopProfiles(accountId);
            return res.json({ ok: true, data });
        }
        catch (err) {
            return fail(res, err);
        }
    });

    app.get('/api/catalog/shops/:shopId', async (req, res) => {
        const accountId = requireAccount(req, res);
        if (!accountId) return;
        const shopId = Number.parseInt(String(req.params.shopId || ''), 10);
        if (!Number.isSafeInteger(shopId) || shopId <= 0) {
            return res.status(400).json({ ok: false, error: 'Invalid shopId' });
        }
        try {
            if (!provider || typeof provider.getShopInfo !== 'function') {
                return res.status(503).json({ ok: false, error: 'Shop catalog unavailable' });
            }
            const data = await provider.getShopInfo(accountId, shopId);
            return res.json({ ok: true, data });
        }
        catch (err) {
            return fail(res, err);
        }
    });
}

module.exports = {
    registerCatalogApi,
};
