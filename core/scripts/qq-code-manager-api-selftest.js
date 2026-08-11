const assert = require('node:assert/strict');
const express = require('express');
const fetch = require('node-fetch');
const { installCodeManagerApiHook } = require('../src/controllers/code-manager-api-hook');

async function main() {
    const accounts = [
        { id: '1', name: '4476', username: 'alice', codeRefreshEnabled: true, codeRefreshMode: 'windows_session' },
        { id: '2', name: '232', username: 'bob', codeRefreshEnabled: true, codeRefreshMode: 'windows_session' },
    ];
    const triggered = [];

    const provider = {
        getAccounts() { return { accounts: accounts.map(item => ({ ...item })) }; },
        resolveAccountId(ref) {
            const text = String(ref || '');
            const found = accounts.find(item => item.id === text || item.name === text);
            return found ? found.id : text;
        },
        getCodeManagerStatus(accountRef = '') {
            const rows = accounts.map(item => ({
                accountId: item.id,
                accountName: item.name,
                qqUin: item.id === '1' ? '44****56' : '23****72',
                state: { state: 'waiting_provider' },
            }));
            const id = accountRef ? this.resolveAccountId(accountRef) : '';
            return { enabled: false, provider: 'targeted_provider_pending', accounts: id ? rows.filter(item => item.accountId === id) : rows };
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
        console.log('安全: fake accounts / fake status / random localhost port，不访问 QQ、不读取 Farm Code。\n');

        const status = await request('/api/code-manager/status');
        assert.equal(status.status, 200);
        assert.equal(status.body.data.accounts.length, 1);
        assert.equal(status.body.data.accounts[0].accountId, '1');
        console.log('✅ status permission filter PASS');

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

        const serialized = JSON.stringify({ status, ownConfig, forbidden, update, refresh, adminStatus });
        assert.equal(/SELFTEST_FRESH|SELFTEST_OLD/i.test(serialized), false);
        console.log('✅ response credential privacy PASS');

        console.log('\n=== RESULT ===');
        console.log(JSON.stringify({
            ok: true,
            routeCount: 4,
            accountIsolation: true,
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