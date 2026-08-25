'use strict';

const assert = require('node:assert/strict');
const { createWechatRecoveryManager } = require('../src/services/wechat-recovery-manager');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await sleep(10);
    }
    throw new Error('condition timeout');
}

function createHarness(options = {}) {
    const accounts = [{
        id: 'wx1',
        name: '微信农场',
        platform: 'wx',
        code: 'stale-code',
        codeRefreshEnabled: true,
        codeRefreshMode: 'windows_wechat',
    }];
    const workers = {};
    const accountLogs = [];
    const logs = [];
    let providerReady = options.providerReady === true;
    let refreshCount = 0;
    let startCount = 0;
    let stopCount = 0;

    const store = {
        getAccounts() {
            return { accounts };
        },
        addOrUpdateAccount(update) {
            const account = accounts.find(item => String(item.id) === String(update.id));
            if (!account) throw new Error('account not found');
            Object.assign(account, update);
            return account;
        },
    };

    const provider = {
        name: 'windows_wechat_runtime',
        async getAvailability() {
            return providerReady
                ? { available: true, reason: 'ok' }
                : { available: false, reason: 'wechat_resident_wmpf_host_missing' };
        },
        async refresh() {
            refreshCount += 1;
            await sleep(options.refreshDelayMs || 0);
            if (!providerReady) {
                const err = new Error('provider not ready');
                err.code = 'wechat_provider_not_ready';
                throw err;
            }
            return {
                code: `fresh-${refreshCount}`,
                source: 'windows_wechat_runtime',
                clientVersion: '1.13.2.7',
                gatewayVersion: '1.13.2.7_20260723',
                wmpfVersion: 25297,
                windowsSessionId: 1,
                appId: 'wx5306c5978fdb76e4',
            };
        },
    };

    function startWorker(account) {
        if (!account || !account.id || workers[account.id]) return false;
        startCount += 1;
        workers[account.id] = { name: account.name, code: account.code };
        return true;
    }

    function stopWorker(id) {
        if (!workers[id]) return;
        stopCount += 1;
        delete workers[id];
    }

    const processRef = {
        platform: 'win32',
        env: {
            FARM_WECHAT_CODE_AUTO_REFRESH: '1',
            FARM_WECHAT_CODE_REFRESH_POLL_MS: '1000',
            FARM_WECHAT_CODE_REFRESH_RETRY_MS: '5000',
        },
    };

    const manager = createWechatRecoveryManager({
        store,
        workers,
        startWorker,
        stopWorker,
        provider,
        processRef,
        log: (tag, msg) => logs.push({ tag, msg }),
        addAccountLog: (action, msg, accountId, accountName, extra) => {
            accountLogs.push({ action, msg, accountId, accountName, ...(extra || {}) });
        },
    });

    return {
        accounts,
        workers,
        manager,
        accountLogs,
        logs,
        setProviderReady(value) { providerReady = !!value; },
        counts() { return { refreshCount, startCount, stopCount }; },
    };
}

async function testStartupWaitsThenAutoRecovers() {
    const h = createHarness({ providerReady: false });
    h.manager.start();
    await waitFor(() => h.accountLogs.some(item => item.action === 'wechat_code_refresh_waiting_provider'));

    assert.equal(Object.keys(h.workers).length, 0);
    assert.equal(h.manager.getStatus().accounts[0].pendingReason, 'startup_recover');

    h.setProviderReady(true);
    h.manager.handleProviderHealth({ available: true, reason: 'ok' });
    await waitFor(() => !!h.workers.wx1);

    assert.equal(h.accounts[0].code, 'fresh-1');
    assert.equal(h.manager.getStatus().accounts[0].pendingReason, '');
    assert.equal(h.manager.getStatus().accounts[0].state.state, 'ready');
    h.manager.stop();
}

async function testExistingWorkerIsAtomicallyReplaced() {
    const h = createHarness({ providerReady: true });
    h.workers.wx1 = { code: 'stale-code' };
    h.manager.start();
    await waitFor(() => h.accounts[0].code === 'fresh-1');

    const counts = h.counts();
    assert.equal(counts.stopCount, 1);
    assert.equal(counts.startCount, 1);
    assert.equal(h.workers.wx1.code, 'fresh-1');
    h.manager.stop();
}

async function testManualStopCancelsPendingRecovery() {
    const h = createHarness({ providerReady: false });
    h.manager.start();
    await waitFor(() => h.manager.getStatus().accounts[0].pendingReason === 'startup_recover');

    assert.equal(h.manager.suspendAccount('wx1', 'web_stop'), true);
    h.setProviderReady(true);
    h.manager.handleProviderHealth({ available: true, reason: 'ok' });
    await sleep(80);

    assert.equal(h.counts().startCount, 0);
    assert.equal(h.manager.getStatus().accounts[0].suspended, true);
    assert.equal(h.manager.getStatus().accounts[0].pendingReason, '');
    h.manager.stop();
}

async function testManualStartUsesFreshCodeAndIsIdempotent() {
    const h = createHarness({ providerReady: true });
    h.manager.start();
    h.manager.suspendAccount('wx1', 'web_stop');
    await sleep(20);

    assert.equal(h.manager.requestStart('wx1', 'web_start'), true);
    await waitFor(() => !!h.workers.wx1);
    assert.match(h.workers.wx1.code, /^fresh-/);
    assert.equal(h.manager.requestStart('wx1', 'web_start'), false);
    h.manager.stop();
}

async function testSilentWorkerExitRecovers() {
    const h = createHarness({ providerReady: true });
    h.manager.start();
    await waitFor(() => !!h.workers.wx1);

    delete h.workers.wx1;
    h.manager.tick();
    await waitFor(() => !!h.workers.wx1 && h.counts().startCount >= 2);

    assert.equal(h.manager.getStatus().accounts[0].state.state, 'ready');
    h.manager.stop();
}

async function main() {
    await testStartupWaitsThenAutoRecovers();
    await testExistingWorkerIsAtomicallyReplaced();
    await testManualStopCancelsPendingRecovery();
    await testManualStartUsesFreshCodeAndIsIdempotent();
    await testSilentWorkerExitRecovers();
    console.log('wechat-recovery-manager-selftest: PASS');
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
