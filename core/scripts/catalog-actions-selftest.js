const assert = require('node:assert/strict');
const express = require('express');
const fetch = require('node-fetch');
const { registerCatalogApi } = require('../src/controllers/catalog-api');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    const calls = [];
    let activeProviderCalls = 0;
    let maxProviderCalls = 0;
    let buyActionCount = 0;
    let plan = {
        shop: { shopId: 2, shopName: '种子商店', shopType: 2, shopTypeLabel: '种子商店' },
        items: [
            { fruitId: 40001, seedId: 20001, name: '测试作物A', canBuy: true, goodsId: 11, price: 10, ownedCount: 0 },
            { fruitId: 40002, seedId: 20002, name: '测试作物B', canBuy: true, goodsId: 12, price: 20, ownedCount: 0 },
        ],
        summary: { locked: 2, alreadyOwned: 0, buyable: 2, totalCost: 30 },
    };

    async function tracked(method, accountId, fn) {
        activeProviderCalls++;
        maxProviderCalls = Math.max(maxProviderCalls, activeProviderCalls);
        calls.push({ accountId, method });
        try {
            await sleep(5);
            return await fn();
        }
        finally {
            activeProviderCalls--;
        }
    }

    const provider = {
        getIllustrated(accountId) {
            return tracked('getIllustrated', accountId, () => ({
                items: [
                    { fruitId: 40001, seedId: 20001, name: '测试作物A', unlocked: false, hasReward: true, illustratedTier: 1 },
                    { fruitId: 40002, seedId: 20002, name: '测试作物B', unlocked: false, hasReward: true, illustratedTier: 1 },
                ],
                summary: { total: 2, unlocked: 0, locked: 2, rewardReady: 2 },
                protocol: { version: 2 },
            }));
        },
        getShopProfiles(accountId) {
            return tracked('getShopProfiles', accountId, () => ({ shops: [], summary: { total: 0 } }));
        },
        getShopInfo(accountId, input) {
            if (typeof input === 'number') {
                return tracked('getShopInfo', accountId, () => ({ shopId: input, goods: [], summary: { total: 0 } }));
            }
            const action = String(input && input.action || '');
            return tracked(`action:${action}`, accountId, () => {
                if (action === 'getMissingSeedPurchasePlan') return JSON.parse(JSON.stringify(plan));
                if (action === 'claimIllustratedRewards') throw new Error('claim action must be locked at HTTP layer');
                if (action === 'buyIllustratedSeed') {
                    buyActionCount++;
                    const goodsId = Number(input.goodsId);
                    return { goodsId, price: goodsId === 12 ? 20 : 10, count: 1 };
                }
                throw new Error(`unexpected action ${action}`);
            });
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

    try {
        console.log('Catalog Actions API Self-Test');
        console.log('安全: fake provider / random localhost port，不访问 QQ、不购买真实商品。\n');

        // Simulate the current page starting illustrated + purchase-plan together.
        // The controller must serialize those provider/Worker calls for one account.
        const [illustrated, purchasePlan] = await Promise.all([
            request('/api/catalog/illustrated'),
            request('/api/catalog/illustrated/purchase-plan'),
        ]);
        assert.equal(illustrated.status, 200);
        assert.equal(illustrated.body.data.summary.rewardReady, 0);
        assert.equal(illustrated.body.data.summary.rewardFlagged, 2);
        assert.equal(illustrated.body.data.summary.rewardSemanticsVerified, false);
        assert.equal(illustrated.body.data.items.every(item => item.hasReward === false), true);
        assert.equal(purchasePlan.status, 200);
        assert.equal(purchasePlan.body.data.summary.buyable, 2);
        assert.equal(purchasePlan.body.data.summary.totalCost, 30);
        assert.equal(maxProviderCalls, 1);
        console.log('✅ concurrent page calls serialized PASS');
        console.log('✅ reward semantics masked until verified PASS');

        const claim = await request('/api/catalog/illustrated/claim', { method: 'POST', body: '{}' });
        assert.equal(claim.status, 409);
        assert.match(claim.body.error, /临时锁定/);
        assert.equal(calls.some(row => row.method === 'action:claimIllustratedRewards'), false);
        console.log('✅ unverified reward mutation locked PASS');

        const invalidBuy = await request('/api/catalog/illustrated/buy-seed', {
            method: 'POST', body: JSON.stringify({ goodsId: 0 }),
        });
        assert.equal(invalidBuy.status, 400);
        console.log('✅ invalid single purchase rejected PASS');

        const beforeOutOfPlan = buyActionCount;
        const outOfPlan = await request('/api/catalog/illustrated/buy-seed', {
            method: 'POST', body: JSON.stringify({ goodsId: 99 }),
        });
        assert.equal(outOfPlan.status, 409);
        assert.equal(buyActionCount, beforeOutOfPlan);
        console.log('✅ out-of-plan single purchase rejected PASS');

        const buy = await request('/api/catalog/illustrated/buy-seed', {
            method: 'POST', body: JSON.stringify({ goodsId: 11, price: 999999 }),
        });
        assert.equal(buy.status, 200);
        assert.equal(buy.body.data.goodsId, 11);
        assert.equal(buy.body.data.price, 10);
        console.log('✅ client price ignored PASS');

        const beforeStaleBulk = buyActionCount;
        const staleBulk = await request('/api/catalog/illustrated/buy-missing-seeds', {
            method: 'POST',
            body: JSON.stringify({ expectedBuyable: 2, expectedTotalCost: 29 }),
        });
        assert.equal(staleBulk.status, 409);
        assert.equal(buyActionCount, beforeStaleBulk);
        console.log('✅ stale bulk confirmation rejected PASS');

        plan = {
            ...plan,
            items: plan.items.slice(0, 1),
            summary: { ...plan.summary, buyable: 1, totalCost: 10 },
        };
        const changedBulk = await request('/api/catalog/illustrated/buy-missing-seeds', {
            method: 'POST',
            body: JSON.stringify({ expectedBuyable: 2, expectedTotalCost: 30 }),
        });
        assert.equal(changedBulk.status, 409);
        console.log('✅ server-side plan change rejected PASS');

        const forbidden = await request('/api/catalog/illustrated/claim', {
            method: 'POST', body: '{}', headers: { 'x-account-id': '2' },
        });
        assert.equal(forbidden.status, 403);
        console.log('✅ cross-account mutation denied PASS');

        console.log('\n=== RESULT ===');
        console.log(JSON.stringify({
            ok: true,
            catalogSerialized: true,
            maxProviderConcurrency: maxProviderCalls,
            rewardClaimLocked: true,
            rewardSemanticsVerified: false,
            accountIsolation: true,
            outOfPlanPurchaseRejected: true,
            clientPriceTrusted: false,
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
