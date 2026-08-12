const BULK_BUY_DELAY_MS = 250;
const BULK_BUY_LIMIT = 100;
const SEED_SHOP_TYPE = 2;

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function registerCatalogApi(app, options = {}) {
    const {
        provider,
        getAccId,
        checkAccountAccess,
        handleApiError,
    } = options;

    if (!app) throw new Error('Catalog API requires express app');

    // Catalog operations share the same Farm websocket with patrol/task/friend loops.
    // Keep at most one catalog request active per account so opening the page cannot
    // flood the worker's pending callback queue.
    const accountQueues = new Map();

    function enqueueAccountCatalog(accountId, task) {
        const key = String(accountId || '');
        const previous = accountQueues.get(key) || Promise.resolve();
        const run = previous.catch(() => {}).then(task);
        let tracked;
        tracked = run.finally(() => {
            if (accountQueues.get(key) === tracked) accountQueues.delete(key);
        });
        accountQueues.set(key, tracked);
        return tracked;
    }

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

    async function runCatalogActionForAccount(accountId, payload) {
        if (!provider || typeof provider.getShopInfo !== 'function') {
            const err = new Error('Catalog action unavailable');
            err.statusCode = 503;
            throw err;
        }
        return provider.getShopInfo(accountId, payload);
    }

    function maskUnverifiedRewardSemantics(data) {
        if (!data || typeof data !== 'object') return data;
        const rawFlagged = Number(data.summary && data.summary.rewardReady) || 0;
        return {
            ...data,
            items: (Array.isArray(data.items) ? data.items : []).map(item => ({
                ...item,
                rewardFlag: !!(item && item.hasReward),
                hasReward: false,
            })),
            summary: {
                ...(data.summary || {}),
                rewardFlagged: rawFlagged,
                rewardReady: 0,
                rewardSemanticsVerified: false,
            },
            protocol: {
                ...(data.protocol || {}),
                rewardSemantics: 'unverified',
            },
        };
    }

    async function buildPurchasePlanForAccount(accountId) {
        if (!provider
            || typeof provider.getIllustrated !== 'function'
            || typeof provider.getShopProfiles !== 'function'
            || typeof provider.getShopInfo !== 'function'
            || typeof provider.getBagSeeds !== 'function') {
            const err = new Error('Catalog purchase plan unavailable');
            err.statusCode = 503;
            throw err;
        }

        // Deliberately sequential. These all use the same Farm websocket.
        const illustrated = await provider.getIllustrated(accountId);
        const profiles = await provider.getShopProfiles(accountId);
        const seedShop = (Array.isArray(profiles && profiles.shops) ? profiles.shops : [])
            .find(shop => Number(shop && shop.shopType) === SEED_SHOP_TYPE);
        if (!seedShop || !Number(seedShop.shopId)) {
            throw new Error('当前服务器未返回种子商店');
        }
        const shopInfo = await provider.getShopInfo(accountId, Number(seedShop.shopId));
        const bagSeeds = await provider.getBagSeeds(accountId);

        const bagCountBySeed = new Map(
            (Array.isArray(bagSeeds) ? bagSeeds : []).map(row => [Number(row && row.seedId) || 0, Number(row && row.count) || 0]),
        );
        const goodsByItemId = new Map(
            (Array.isArray(shopInfo && shopInfo.goods) ? shopInfo.goods : [])
                .map(row => [Number(row && row.itemId) || 0, row]),
        );

        const items = (Array.isArray(illustrated && illustrated.items) ? illustrated.items : [])
            .filter(item => item && item.unlocked !== true)
            .map((item) => {
                const seedId = Number(item.seedId) || 0;
                const ownedCount = bagCountBySeed.get(seedId) || 0;
                const goods = seedId > 0 ? goodsByItemId.get(seedId) : null;
                const limitCount = Number(goods && goods.limitCount) || 0;
                const boughtNum = Number(goods && goods.boughtNum) || 0;
                const limitRemaining = goods && limitCount > 0 ? Math.max(0, limitCount - boughtNum) : null;
                let reason = '';
                if (!seedId) reason = '本地配置暂未映射到种子ID';
                else if (ownedCount > 0) reason = '背包已有该种子';
                else if (!goods) reason = '种子商店未找到该商品';
                else if (!goods.unlocked) reason = '商店尚未解锁';
                else if (limitRemaining === 0) reason = '已达限购';
                const canBuy = !!goods && !!goods.unlocked && ownedCount <= 0 && limitRemaining !== 0;
                return {
                    fruitId: Number(item.fruitId) || Number(item.illustratedId) || 0,
                    seedId,
                    name: String(item.name || ''),
                    image: String(item.image || (goods && goods.image) || ''),
                    illustratedTier: Number(item.illustratedTier) || 0,
                    ownedCount,
                    canBuy,
                    reason,
                    goodsId: Number(goods && goods.goodsId) || 0,
                    price: Number(goods && goods.price) || 0,
                    itemCount: goods ? Math.max(1, Number(goods.itemCount) || 1) : 0,
                    boughtNum,
                    limitCount,
                };
            });

        const buyable = items.filter(item => item.canBuy);
        return {
            shop: seedShop,
            items,
            summary: {
                locked: items.length,
                alreadyOwned: items.filter(item => item.ownedCount > 0).length,
                buyable: buyable.length,
                totalCost: buyable.reduce((sum, item) => sum + Math.max(0, item.price), 0),
            },
        };
    }

    app.get('/api/catalog/illustrated', async (req, res) => {
        const accountId = requireAccount(req, res);
        if (!accountId) return;
        try {
            const data = await enqueueAccountCatalog(accountId, async () => {
                if (!provider || typeof provider.getIllustrated !== 'function') {
                    const err = new Error('Illustrated catalog unavailable');
                    err.statusCode = 503;
                    throw err;
                }
                return provider.getIllustrated(accountId);
            });
            return res.json({ ok: true, data: maskUnverifiedRewardSemantics(data) });
        }
        catch (err) {
            if (err && err.statusCode === 503) return res.status(503).json({ ok: false, error: err.message });
            return fail(res, err);
        }
    });

    app.get('/api/catalog/illustrated/purchase-plan', async (req, res) => {
        const accountId = requireAccount(req, res);
        if (!accountId) return;
        try {
            const data = await enqueueAccountCatalog(accountId, () => buildPurchasePlanForAccount(accountId));
            return res.json({ ok: true, data });
        }
        catch (err) {
            if (err && err.statusCode === 503) return res.status(503).json({ ok: false, error: err.message });
            return fail(res, err);
        }
    });

    app.post('/api/catalog/illustrated/claim', async (req, res) => {
        const accountId = requireAccount(req, res);
        if (!accountId) return;
        return res.status(409).json({
            ok: false,
            error: '图鉴奖励状态字段语义尚未完成实机确认，领取功能已临时锁定',
        });
    });

    app.post('/api/catalog/illustrated/buy-seed', async (req, res) => {
        const accountId = requireAccount(req, res);
        if (!accountId) return;
        const goodsId = Number(req.body && req.body.goodsId);
        if (!Number.isSafeInteger(goodsId) || goodsId <= 0) {
            return res.status(400).json({ ok: false, error: 'Invalid goodsId' });
        }
        try {
            const data = await enqueueAccountCatalog(accountId, async () => {
                const plan = await buildPurchasePlanForAccount(accountId);
                const allowed = Array.isArray(plan && plan.items)
                    ? plan.items.find(item => Number(item && item.goodsId) === goodsId && item.canBuy === true)
                    : null;
                if (!allowed) {
                    const err = new Error('该商品不在当前缺失图鉴可购买清单中，请重新读取');
                    err.statusCode = 409;
                    throw err;
                }
                return runCatalogActionForAccount(accountId, { action: 'buyIllustratedSeed', goodsId });
            });
            return res.json({ ok: true, data });
        }
        catch (err) {
            if (err && err.statusCode === 409) return res.status(409).json({ ok: false, error: err.message });
            if (err && err.statusCode === 503) return res.status(503).json({ ok: false, error: err.message });
            return fail(res, err);
        }
    });

    app.post('/api/catalog/illustrated/buy-missing-seeds', async (req, res) => {
        const accountId = requireAccount(req, res);
        if (!accountId) return;
        const expectedBuyable = Number(req.body && req.body.expectedBuyable);
        const expectedTotalCost = Number(req.body && req.body.expectedTotalCost);
        if (!Number.isSafeInteger(expectedBuyable) || expectedBuyable < 0
            || !Number.isSafeInteger(expectedTotalCost) || expectedTotalCost < 0) {
            return res.status(400).json({ ok: false, error: 'Missing purchase confirmation snapshot' });
        }
        try {
            const data = await enqueueAccountCatalog(accountId, async () => {
                const plan = await buildPurchasePlanForAccount(accountId);
                const actualBuyable = Number(plan && plan.summary && plan.summary.buyable) || 0;
                const actualTotalCost = Number(plan && plan.summary && plan.summary.totalCost) || 0;
                if (actualBuyable !== expectedBuyable || actualTotalCost !== expectedTotalCost) {
                    const err = new Error('购买清单已变化，请重新读取后再确认');
                    err.statusCode = 409;
                    err.data = { actualBuyable, actualTotalCost };
                    throw err;
                }

                const targets = (Array.isArray(plan && plan.items) ? plan.items : [])
                    .filter(item => item && item.canBuy === true && Number(item.goodsId) > 0)
                    .slice(0, BULK_BUY_LIMIT)
                    .map(item => ({
                        goodsId: Number(item.goodsId),
                        seedId: Number(item.seedId) || 0,
                        name: String(item.name || ''),
                        confirmedPrice: Number(item.price) || 0,
                    }));

                if (targets.length !== actualBuyable) {
                    const err = new Error('可购买数量超过单次安全上限或清单异常，请重新读取');
                    err.statusCode = 409;
                    err.data = { actualBuyable, executable: targets.length, limit: BULK_BUY_LIMIT };
                    throw err;
                }

                const results = [];
                for (const target of targets) {
                    try {
                        const purchase = await runCatalogActionForAccount(accountId, {
                            action: 'buyIllustratedSeed',
                            goodsId: target.goodsId,
                        });
                        results.push({
                            ...target,
                            ok: true,
                            price: Number(purchase && purchase.price) || target.confirmedPrice,
                            purchase,
                        });
                    }
                    catch (err) {
                        results.push({
                            ...target,
                            ok: false,
                            error: err && err.message ? err.message : String(err || 'unknown'),
                        });
                    }
                    if (targets.length > 1) await delay(BULK_BUY_DELAY_MS);
                }

                return {
                    requested: targets.length,
                    successCount: results.filter(item => item.ok).length,
                    failCount: results.filter(item => !item.ok).length,
                    spentEstimate: results.filter(item => item.ok).reduce((sum, item) => sum + Math.max(0, Number(item.price) || 0), 0),
                    results,
                };
            });
            return res.json({ ok: true, data });
        }
        catch (err) {
            if (err && err.statusCode === 409) return res.status(409).json({ ok: false, error: err.message, data: err.data || null });
            if (err && err.statusCode === 503) return res.status(503).json({ ok: false, error: err.message });
            return fail(res, err);
        }
    });

    app.get('/api/catalog/shops', async (req, res) => {
        const accountId = requireAccount(req, res);
        if (!accountId) return;
        try {
            const data = await enqueueAccountCatalog(accountId, async () => {
                if (!provider || typeof provider.getShopProfiles !== 'function') {
                    const err = new Error('Shop catalog unavailable');
                    err.statusCode = 503;
                    throw err;
                }
                return provider.getShopProfiles(accountId);
            });
            return res.json({ ok: true, data });
        }
        catch (err) {
            if (err && err.statusCode === 503) return res.status(503).json({ ok: false, error: err.message });
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
            const data = await enqueueAccountCatalog(accountId, async () => {
                if (!provider || typeof provider.getShopInfo !== 'function') {
                    const err = new Error('Shop catalog unavailable');
                    err.statusCode = 503;
                    throw err;
                }
                return provider.getShopInfo(accountId, shopId);
            });
            return res.json({ ok: true, data });
        }
        catch (err) {
            if (err && err.statusCode === 503) return res.status(503).json({ ok: false, error: err.message });
            return fail(res, err);
        }
    });
}

module.exports = {
    registerCatalogApi,
};
