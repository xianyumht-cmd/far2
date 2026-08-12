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
