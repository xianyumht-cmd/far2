'use strict';

const assert = require('node:assert/strict');

async function main() {
    const { CONFIG } = require('../src/config/config');
    const gateway = require('../src/services/wechat-gateway-profile');
    const { createWechatRecoveryManager } = require('../src/services/wechat-recovery-manager');

    const originalUrl = 'wss://gate-obt.nqf.qq.com/prod/ws?platform=wx&os=iOS&ver=1.13.2.7&code=ABCDEF123456&openID=';
    const rewritten = gateway.rewriteGatewayArgs([
        originalUrl,
        { headers: { Origin: 'https://gate-obt.nqf.qq.com', 'User-Agent': 'old' } },
    ]);
    const rewrittenUrl = new URL(rewritten[0]);
    assert.equal(rewrittenUrl.searchParams.get('platform'), 'wx');
    assert.equal(rewrittenUrl.searchParams.get('os'), 'Windows');
    assert.equal(rewrittenUrl.searchParams.get('ver'), '1.13.2.7_20260723');
    assert.equal(rewrittenUrl.searchParams.get('code'), 'ABCDEF123456');
    assert.equal(rewrittenUrl.searchParams.has('openID'), false);
    assert.equal(rewrittenUrl.searchParams.has('openid'), false);
    assert.match(String(rewritten[1].headers['User-Agent'] || ''), /XWEB\/25297/);
    assert.equal(CONFIG.platform, 'wx');
    assert.equal(CONFIG.os, 'Windows');
    assert.equal(CONFIG.clientVersion, '1.13.2.7');

    const qqUrl = 'wss://gate-obt.nqf.qq.com/prod/ws?platform=qq&os=iOS&ver=qq-version&code=QQCODE&openID=';
    const qqArgs = gateway.rewriteGatewayArgs([qqUrl, { headers: { 'User-Agent': 'qq-ua' } }]);
    assert.equal(qqArgs[0], qqUrl);
    assert.equal(qqArgs[1].headers['User-Agent'], 'qq-ua');

    const state = {
        accounts: [
            {
                id: '1',
                name: 'wx-selftest',
                platform: 'wx',
                code: 'OLDWXCODE',
                codeRefreshEnabled: true,
                codeRefreshMode: 'windows_wechat',
            },
            {
                id: '2',
                name: 'qq-control',
                platform: 'qq',
                code: 'QQCONTROL',
                codeRefreshEnabled: true,
                codeRefreshMode: 'windows_session',
                uin: '123456789',
            },
        ],
        nextId: 3,
    };
    const store = {
        getAccounts() {
            return { accounts: state.accounts.map(item => ({ ...item })), nextId: state.nextId };
        },
        addOrUpdateAccount(update) {
            const idx = state.accounts.findIndex(item => item.id === String(update.id || ''));
            if (idx >= 0) state.accounts[idx] = { ...state.accounts[idx], ...update };
            return this.getAccounts();
        },
    };
    const workers = { '1': { process: {} } };
    let startedAccount = null;
    function stopWorker(id) {
        delete workers[String(id)];
    }
    function startWorker(account) {
        startedAccount = { ...account };
        workers[String(account.id)] = { process: {} };
        return true;
    }
    const logs = [];
    const provider = {
        name: 'windows_wechat_runtime_selftest',
        async getAvailability(account) {
            return { available: account.platform === 'wx', reason: 'ok' };
        },
        async refresh() {
            return {
                code: 'WXSELFTESTCODE1234567890ABCDEF12',
                source: 'windows_wechat_runtime_selftest',
                clientVersion: '1.13.2.7',
                gatewayVersion: '1.13.2.7_20260723',
                windowsSessionId: 1,
                wmpfVersion: 25297,
                profileId: 'selftest-profile',
                appId: 'wx5306c5978fdb76e4',
            };
        },
    };
    const processRef = {
        platform: 'win32',
        env: {
            FARM_WECHAT_CODE_AUTO_REFRESH: '1',
            FARM_WECHAT_CODE_WORKER_STOP_TIMEOUT_MS: '500',
        },
    };
    const manager = createWechatRecoveryManager({
        store,
        workers,
        startWorker,
        stopWorker,
        log: (...args) => logs.push(args),
        addAccountLog: (...args) => logs.push(args),
        provider,
        processRef,
    });

    const result = await manager.refreshAccount('1', 'selftest');
    manager.stop();
    assert.equal(result.ok, true);
    const wxAccount = state.accounts.find(item => item.id === '1');
    const qqAccount = state.accounts.find(item => item.id === '2');
    assert.equal(wxAccount.code, 'WXSELFTESTCODE1234567890ABCDEF12');
    assert.equal(wxAccount.clientVersion, '1.13.2.7');
    assert.equal(wxAccount.gatewayVersion, '1.13.2.7_20260723');
    assert.equal(wxAccount.codeRefreshMode, 'windows_wechat');
    assert.equal(qqAccount.code, 'QQCONTROL');
    assert.ok(startedAccount);
    assert.equal(startedAccount.platform, 'wx');

    console.log('FAR2 WeChat production foundation selftest: PASS');
    console.log('  gateway profile: PASS');
    console.log('  openID omission: PASS');
    console.log('  QQ gateway isolation: PASS');
    console.log('  WeChat recovery restart flow: PASS');
    console.log('  QQ account untouched: PASS');
}

main().catch(err => {
    console.error('FAR2 WeChat production foundation selftest: FAIL');
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
});
