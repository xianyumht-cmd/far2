const assert = require('node:assert/strict');
const express = require('express');
const fetch = require('node-fetch');
const { installCodeManagerApiHook } = require('../src/controllers/code-manager-api-hook');

async function main() {
    const accounts = [
        {
            id: '1',
            name: '4476',
            username: 'alice',
            platform: 'qq',
            running: true,
            codeRefreshEnabled: true,
            codeRefreshMode: 'windows_session',
            lastCodeRefreshAt: 1700000000000,
            lastCodeRefreshOk: true,
            lastCodeRefreshReason: 'ws_400',
            lastCodeRefreshError: '',
            lastCodeSource: 'isolated_qq_runtime',
        },
        {
            id: '2',
            name: '232',
            username: 'bob',
            platform: 'qq',
            running: false,
            codeRefreshEnabled: true,
            codeRefreshMode: 'windows_session',
        },
    ];
    const triggered = [];

    const provider = {
        getAccounts() { return { accounts: accounts.map(item => ({ ...item })) }; },
        resolveAccountId(ref) {
            const text = String(ref || '');
            const found = accounts.find(item => item.id === text || item.name === text);
            return found ? found.id : text;
        },
        getStatus(accountRef) {
            const id = this.resolveAccountId(accountRef);
            if (id === '1') {
                return {
                    accountId: '1',
                    accountName: '4476',
                    connection: { connected: true },
                    status: { name: 'Alice Farm', level: 112 },
                    uptime: 3600,
                    wsError: null,
                };
            }
            return {
                accountId: id,
                accountName: '232',
                connection: { connected: false },
                status: { name: '', level: 0 },
                uptime: 0,
                wsError: null,
            };
        },
        getRuntimeFriendStatus(account) {
            const id = String(account && account.id || '');
            if (id === '1') {
                return {
                    imported: true,
                    gidCount: 103,
                    openIdCount: 275,
                    source: 'windows_qq_runtime_friend_capture_v4',
                    capturedAt: 1700000005000,
                    methods: ['GetShareKey', 'SyncAll'],
                };
            }
            return { imported: false, gidCount: 0, openIdCount: 0, source: '', capturedAt: 0, methods: [] };
        },
        getAccountLogs() {
            return [
                { accountId: '1', time: '2026-08-13 02:00:10', action: 'code_refresh_ok', msg: 'Farm Code 刷新成功', reason: 'ws_400' },
                { accountId: '1', time: '2026-08-13 02:00:01', action: 'ws_400', msg: '连接被拒绝，可能需要更新 Code', reason: 'ws_400' },
                { accountId: '2', time: '2026-08-13 02:00:00', action: 'code_refresh_failed', msg: 'bob-only-event', reason: 'private' },
            ];
        },
        getIllustrated(accountRef) {
            const id = this.resolveAccountId(accountRef);
            return Promise.resolve({
                items: id === '1'
                    ? [{ seedId: 20003, name: '胡萝卜', image: '/fake.png', unlocked: true, planted: true, plantedCount: 12, harvestCount: 9, category: 1, hasReward: false }]
                    : [{ seedId: 29999, name: 'bob-private-seed', image: '', unlocked: false, planted: false, plantedCount: 0, harvestCount: 0, category: 9, hasReward: false }],
                summary: { total: 1, unlocked: id === '1' ? 1 : 0, locked: id === '1' ? 0 : 1, planted: id === '1' ? 1 : 0, rewardReady: 0 },
                protocol: { service: 'gamepb.illustratedpb.IllustratedService', method: 'GetIllustratedListV2', version: 2 },
            });
        },
        getShopProfiles(accountRef) {
            const id = this.resolveAccountId(accountRef);
            return Promise.resolve({
                shops: id === '1'
                    ? [{ shopId: 2, shopName: '种子商店', shopType: 2, shopTypeLabel: '种子商店' }]
                    : [{ shopId: 99, shopName: 'bob-private-shop', shopType: 2, shopTypeLabel: '种子商店' }],
                summary: { total: 1, seedShops: 1, petShops: 0, itemShops: 0 },
            });
        },
        getShopInfo(accountRef, shopId) {
            const id = this.resolveAccountId(accountRef);
            return Promise.resolve({
                shopId: Number(shopId),
                goods: id === '1'
                    ? [{ goodsId: 100, itemId: 20003, name: '胡萝卜', image: '/fake.png', itemCount: 1, price: 10, boughtNum: 0, limitCount: 0, unlocked: true, conditions: [] }]
                    : [{ goodsId: 999, itemId: 29999, name: 'bob-private-goods', image: '', itemCount: 1, price: 1, boughtNum: 0, limitCount: 0, unlocked: true, conditions: [] }],
                summary: { total: 1, unlocked: 1, locked: 0, limited: 0 },
            });
        },
        getCodeManagerStatus(accountRef = '') {
            const rows = accounts.map(item => ({
                accountId: item.id,
                accountName: item.name,
                qqUin: item.id === '1' ? '44****56' : '23****72',
                sessionStatus: item.id === '1' ? 'online' : 'unbound',
                sessionIdentityOk: item.id === '1',
                needsRebind: item.id !== '1',
                refreshing: false,
                state: { state: item.id === '1' ? 'ready' : 'waiting_session' },
            }));
            const id = accountRef ? this.resolveAccountId(accountRef) : '';
            return {
                enabled: true,
                started: true,
                globalEnabled: true,
                provider: 'isolated_qq_runtime',
                configuredCount: rows.length,
                accounts: id ? rows.filter(item => item.accountId === id) : rows,
            };
        },
        getCodeRefreshConfig(accountRef = '') {
            const build = item => ({ accountId: item.id, accountName: item.name, enabled: item.codeRefreshEnabled === true, mode: item.codeRefreshMode || '' });
            if (!accountRef) return { accounts: accounts.map(build) };
            const id = this.resolveAccountId(accountRef);
            const item = accounts.find(row => row.id === id);
            return item ? build(item) : null;
        },
        setCodeRefreshConfig(accountRef, payload = {}) {
            const id = this.resolveAccountId(accountRef);
            const item = accounts.find(row => row.id === id);
            if (!item) throw new Error('Account not found');
            item.codeRefreshEnabled = payload.enabled === true;
            item.codeRefreshMode = item.codeRefreshEnabled ? 'windows_session' : '';
            return { config: this.getCodeRefreshConfig(id), status: this.getCodeManagerStatus(id).accounts[0] };
        },
        triggerCodeRefresh(accountRef, reason) {
            const id = this.resolveAccountId(accountRef);
            triggered.push({ id, reason });
            return { accepted: false, accountId: id, reason: 'auto_refresh_disabled' };
        },
    };

    // IMPORTANT: mirror production startup order in core/client.js.
    // Install the hook BEFORE express() creates the app instance, otherwise
    // Express 4 has already copied application methods onto the app and the
    // prototype hook cannot observe app.use('/api', ...).
    const uninstall = installCodeManagerApiHook(provider);
    const app = express();
    app.use(express.json());
    app.use('/api', (req, _res, next) => {
        req.currentUser = {
            role: String(req.headers['x-test-role'] || 'user'),
            username: String(req.headers['x-test-user'] || 'alice'),
        };
        next();
    });
    uninstall();

    const server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const base = `http://127.0.0.1:${server.address().port}`;

    async function request(path, options = {}) {
        const response = await fetch(base + path, {
            ...options,
            headers: { 'content-type': 'application/json', 'x-test-user': 'alice', ...(options.headers || {}) },
        });
        const text = await response.text();
        let body;
        try {
            body = text ? JSON.parse(text) : null;
        } catch {
            throw new Error(`Expected JSON from ${path}, got HTTP ${response.status}: ${text.slice(0, 300)}`);
        }
        return { status: response.status, body };
    }

    try {
        console.log('QQ Farm CodeManager API Self-Test');
        console.log('安全: fake accounts / fake catalog / fake status / random localhost port，不访问 QQ、不读取 Farm Code。\n');

        const status = await request('/api/code-manager/status');
        assert.equal(status.status, 200);
        assert.equal(status.body.data.accounts.length, 1);
        assert.equal(status.body.data.accounts[0].accountId, '1');
        console.log('✅ status permission filter PASS');

        const health = await request('/api/runtime-health');
        assert.equal(health.status, 200);
        assert.equal(health.body.data.accounts.length, 1);
        assert.equal(health.body.data.accounts[0].accountId, '1');
        assert.equal(health.body.data.accounts[0].farm.connected, true);
        assert.equal(health.body.data.accounts[0].friends.gidCount, 103);
        assert.equal(health.body.data.accounts[0].friends.openIdCount, 275);
        assert.equal(health.body.data.accounts[0].recentEvents.length, 2);
        assert.equal(health.body.data.codeManager.configuredCount, 1);
        assert.equal(health.body.data.summary.accounts, 1);
        assert.equal(health.body.data.summary.running, 1);
        assert.equal(health.body.data.summary.connected, 1);
        assert.equal(JSON.stringify(health.body).includes('bob-only-event'), false);
        console.log('✅ runtime health scope + friend/code summary PASS');

        const illustrated = await request('/api/catalog/illustrated', { headers: { 'x-account-id': '1' } });
        assert.equal(illustrated.status, 200);
        assert.equal(illustrated.body.data.summary.total, 1);
        assert.equal(illustrated.body.data.items[0].name, '胡萝卜');
        assert.equal(JSON.stringify(illustrated.body).includes('bob-private-seed'), false);
        console.log('✅ illustrated read-only route PASS');

        const shops = await request('/api/catalog/shops', { headers: { 'x-account-id': '1' } });
        assert.equal(shops.status, 200);
        assert.equal(shops.body.data.shops[0].shopType, 2);
        assert.equal(JSON.stringify(shops.body).includes('bob-private-shop'), false);
        console.log('✅ shop profiles read-only route PASS');

        const shopInfo = await request('/api/catalog/shops/2', { headers: { 'x-account-id': '1' } });
        assert.equal(shopInfo.status, 200);
        assert.equal(shopInfo.body.data.shopId, 2);
        assert.equal(shopInfo.body.data.goods[0].itemId, 20003);
        assert.equal(JSON.stringify(shopInfo.body).includes('bob-private-goods'), false);
        console.log('✅ shop info read-only route PASS');

        const catalogForbidden = await request('/api/catalog/illustrated', { headers: { 'x-account-id': '2' } });
        assert.equal(catalogForbidden.status, 403);
        console.log('✅ catalog cross-account access denied PASS');

        const invalidShop = await request('/api/catalog/shops/not-a-number', { headers: { 'x-account-id': '1' } });
        assert.equal(invalidShop.status, 400);
        console.log('✅ invalid shop id rejected PASS');

        const ownConfig = await request('/api/code-manager/config', { headers: { 'x-account-id': '1' } });
        assert.equal(ownConfig.status, 200);
        assert.equal(ownConfig.body.data.accountId, '1');
        console.log('✅ own account config GET PASS');

        const forbidden = await request('/api/code-manager/config', { headers: { 'x-account-id': '2' } });
        assert.equal(forbidden.status, 403);
        console.log('✅ cross-account access denied PASS');

        const update = await request('/api/code-manager/config', {
            method: 'POST', headers: { 'x-account-id': '1' }, body: JSON.stringify({ enabled: false }),
        });
        assert.equal(update.status, 200);
        assert.equal(update.body.data.config.enabled, false);
        console.log('✅ config POST PASS');

        const refresh = await request('/api/code-manager/refresh', {
            method: 'POST', headers: { 'x-account-id': '1' }, body: JSON.stringify({ reason: 'selftest' }),
        });
        assert.equal(refresh.status, 200);
        assert.equal(refresh.body.data.accepted, false);
        assert.deepEqual(triggered, [{ id: '1', reason: 'selftest' }]);
        console.log('✅ manual refresh route PASS');

        const adminStatus = await request('/api/code-manager/status', { headers: { 'x-test-role': 'admin', 'x-test-user': 'admin' } });
        assert.equal(adminStatus.status, 200);
        assert.equal(adminStatus.body.data.accounts.length, 2);
        console.log('✅ admin status scope PASS');

        const adminHealth = await request('/api/runtime-health', { headers: { 'x-test-role': 'admin', 'x-test-user': 'admin' } });
        assert.equal(adminHealth.status, 200);
        assert.equal(adminHealth.body.data.accounts.length, 2);
        assert.equal(adminHealth.body.data.codeManager.configuredCount, 2);
        console.log('✅ admin health scope PASS');

        const serialized = JSON.stringify({ status, health, illustrated, shops, shopInfo, catalogForbidden, invalidShop, ownConfig, forbidden, update, refresh, adminStatus, adminHealth });
        assert.equal(/SELFTEST_FRESH|SELFTEST_OLD/i.test(serialized), false);
        assert.equal(serialized.includes('bob-private-seed'), false);
        assert.equal(serialized.includes('bob-private-shop'), false);
        assert.equal(serialized.includes('bob-private-goods'), false);
        console.log('✅ response credential/catalog privacy PASS');

        console.log('\n=== RESULT ===');
        console.log(JSON.stringify({
            ok: true,
            routeCount: 8,
            accountIsolation: true,
            runtimeHealthIsolation: true,
            catalogReadOnly: true,
            catalogIsolation: true,
            realQqTouched: false,
            realFarmCodeTouched: false,
        }, null, 2));
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(err => {
    console.error('\n❌ CodeManager API self-test FAIL:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
});
