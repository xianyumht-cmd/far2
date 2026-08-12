const assert = require('node:assert/strict');
const express = require('express');
const fetch = require('node-fetch');
const { registerCatalogApi } = require('../src/controllers/catalog-api');

async function main() {
    const calls = [];
    let plan = {
        shop: { shopId: 2, shopName: '种子商店', shopType: 2, shopTypeLabel: '种子商店' },
        items: [
            { fruitId: 40001, seedId: 20001, name: '测试作物A', canBuy: true, goodsId: 11, price: 10, ownedCount: 0 },
            { fruitId: 40002, seedId: 20002, name: '测试作物B', canBuy: true, goodsId: 12, price: 20, ownedCount: 0 },
        ],
        summary: { locked: 2, alreadyOwned: 0, buyable: 2, totalCost: 30 },
    };

    const provider = {
        getIllustrated(accountId) {
            calls.push({ accountId, method: 'getIllustrated' });
            return Promise.resolve({ items: [], summary: { total: 0 } });
        },
        getShopProfiles(accountId) {
            calls.push({ accountId, method: 'getShopProfiles' });
            return Promise.resolve({ shops: [], summary: { total: 0 } });
        },
        getShopInfo(accountId, input) {
            calls.push({ accountId, method: 'getShopInfo', input });
            if (typeof input === 'number') return Promise.resolve({ shopId: input, goods: [], summary: { total: 0 } });
            const action = String(input && input.action || '');
            if (action === 'getMissingSeedPurchasePlan') return Promise.resolve(JSON.parse(JSON.stringify(plan)));
            if (action === 'claimIllustratedRewards') return Promise.resolve({ totalKinds: 3, totalCount: 9, items: [], bonusItems: [] });
            if (action === 'buyIllustratedSeed') {
                const goodsId = Number(input.goodsId);
                return Promise.resolve({ goodsId, price: goodsId === 12 ? 20 : 10, count: 1 });
            }
            throw new Error(`unexpected action ${action}`);
        },
    };

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.currentUser = {
            role: String(req.headers['x-test-role'] || 'user'),
            username: String(req.headers['x-test-user'] || 'alice'),
        };
        next();
    });
    registerCatalogApi(app, {
        provider,
        getAccId: req => String(req.headers['x-account-id'] || ''),
        checkAccountAccess: (req, accountId) => req.currentUser.role === 'admin'
            || (req.currentUser.username === 'alice' && accountId === '1'),
        handleApiError: (res, err) => res.status(500).json({ ok: false, error: err.message }),
    });

    const server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const base = `http://127.0.0.1:${server.address().port}`;

    async function request(path, options = {}) {
        const response = await fetch(base + path, {
            ...options,
            headers: {
                'content-type': 'application/json',
                'x-account-id': '1',
                'x-test-user': 'alice',
                ...(options.headers || {}),
            },
        });
        const body = await response.json();
        return { status: response.status, body };
    }

    function purchaseCalls() {
        return calls.filter(row => row.input && row.input.action === 'buyIllustratedSeed');
    }

    try {
        console.log('Catalog Actions API Self-Test');
        console.log('安全: fake provider / random localhost port，不访问 QQ、不购买真实商品。\n');

        const purchasePlan = await request('/api/catalog/illustrated/purchase-plan');
        assert.equal(purchasePlan.status, 200);
        assert.equal(purchasePlan.body.data.summary.buyable, 2);
        assert.equal(purchasePlan.body.data.summary.totalCost, 30);
        console.log('✅ purchase plan route PASS');

        const claim = await request('/api/catalog/illustrated/claim', { method: 'POST', body: '{}' });
        assert.equal(claim.status, 200);
        assert.equal(claim.body.data.totalCount, 9);
        console.log('✅ claim route PASS');

        const invalidBuy = await request('/api/catalog/illustrated/buy-seed', { method: 'POST', body: JSON.stringify({ goodsId: 0 }) });
        assert.equal(invalidBuy.status, 400);
        console.log('✅ invalid single purchase rejected PASS');

        const beforeOutOfPlan = purchaseCalls().length;
        const outOfPlan = await request('/api/catalog/illustrated/buy-seed', {
            method: 'POST', body: JSON.stringify({ goodsId: 99 }),
        });
        assert.equal(outOfPlan.status, 409);
        assert.equal(purchaseCalls().length, beforeOutOfPlan);
        console.log('✅ out-of-plan single purchase rejected PASS');

        const buy = await request('/api/catalog/illustrated/buy-seed', {
            method: 'POST', body: JSON.stringify({ goodsId: 11, price: 999999 }),
        });
        assert.equal(buy.status, 200);
        assert.equal(buy.body.data.goodsId, 11);
        const buyCall = purchaseCalls().at(-1);
        assert.ok(buyCall);
        assert.equal(buyCall.input.goodsId, 11);
        assert.equal(Object.prototype.hasOwnProperty.call(buyCall.input, 'price'), false);
        console.log('✅ client price stripped before worker PASS');

        const beforeStaleBulk = purchaseCalls().length;
        const staleBulk = await request('/api/catalog/illustrated/buy-missing-seeds', {
            method: 'POST',
            body: JSON.stringify({ expectedBuyable: 2, expectedTotalCost: 29 }),
        });
        assert.equal(staleBulk.status, 409);
        assert.equal(purchaseCalls().length, beforeStaleBulk);
        console.log('✅ stale bulk confirmation rejected PASS');

        const beforeBulk = purchaseCalls().length;
        const bulk = await request('/api/catalog/illustrated/buy-missing-seeds', {
            method: 'POST',
            body: JSON.stringify({ expectedBuyable: 2, expectedTotalCost: 30 }),
        });
        assert.equal(bulk.status, 200);
        assert.equal(bulk.body.data.requested, 2);
        assert.equal(bulk.body.data.successCount, 2);
        assert.equal(bulk.body.data.failCount, 0);
        assert.equal(bulk.body.data.spentEstimate, 30);
        const bulkCalls = purchaseCalls().slice(beforeBulk);
        assert.deepEqual(bulkCalls.map(row => row.input.goodsId), [11, 12]);
        assert.equal(bulkCalls.some(row => Object.prototype.hasOwnProperty.call(row.input, 'price')), false);
        console.log('✅ exact bulk confirmation + fixed targets PASS');

        plan = { ...plan, summary: { ...plan.summary, buyable: 1, totalCost: 10 } };
        const beforeChangedBulk = purchaseCalls().length;
        const changedBulk = await request('/api/catalog/illustrated/buy-missing-seeds', {
            method: 'POST',
            body: JSON.stringify({ expectedBuyable: 2, expectedTotalCost: 30 }),
        });
        assert.equal(changedBulk.status, 409);
        assert.equal(purchaseCalls().length, beforeChangedBulk);
        console.log('✅ server-side recheck PASS');

        const forbidden = await request('/api/catalog/illustrated/claim', {
            method: 'POST', body: '{}', headers: { 'x-account-id': '2' },
        });
        assert.equal(forbidden.status, 403);
        console.log('✅ cross-account mutation denied PASS');

        console.log('\n=== RESULT ===');
        console.log(JSON.stringify({
            ok: true,
            accountIsolation: true,
            outOfPlanPurchaseRejected: true,
            clientPriceTrusted: false,
            fixedBulkTargetList: true,
            staleBulkRejected: true,
            realQqTouched: false,
            realPurchaseTouched: false,
        }, null, 2));
    }
    finally {
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch((err) => {
    console.error('\n❌ Catalog Actions API self-test FAIL:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
});
