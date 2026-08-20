const assert = require('node:assert/strict');
const { createCodeManager } = require('../src/services/code-manager');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

async function waitFor(predicate, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    return predicate();
}

async function main() {
    const accounts = [{
        id: '232',
        name: '232',
        platform: 'qq',
        uin: '2320006072',
        qq: '2320006072',
        code: 'SELFTEST_OLD',
        codeRefreshEnabled: true,
        codeRefreshMode: 'windows_session',
    }];

    const store = {
        getAccounts() {
            return { accounts: clone(accounts) };
        },
        addOrUpdateAccount(patch) {
            const index = accounts.findIndex(item => String(item.id) === String(patch.id));
            if (index < 0) throw new Error('account not found');
            accounts[index] = { ...accounts[index], ...clone(patch) };
            return { accounts: clone(accounts) };
        },
    };

    let desktopStatusCalls = 0;
    const desktopSessionRegistry = {
        getStatus() {
            desktopStatusCalls += 1;
            return {
                bindings: [{
                    accountId: '232',
                    qqUin: '2320006072',
                    mainQqPid: 1001,
                    farmRootPid: 1002,
                    status: 'online',
                    needsRebind: false,
                }],
                runtimeSessions: [],
            };
        },
    };

    const workers = { 232: { selftest: true } };
    let providerRefreshCalls = 0;
    const provider = {
        name: 'selftest_provider',
        async getAvailability() {
            return { available: true, reason: 'ok' };
        },
        async refresh() {
            providerRefreshCalls += 1;
            return {
                code: `SELFTEST_FRESH_${providerRefreshCalls}`,
                source: 'selftest',
            };
        },
    };

    const manager = createCodeManager({
        store,
        workers,
        startWorker(account) {
            workers[String(account.id)] = { selftest: true };
            return true;
        },
        stopWorker(id) {
            delete workers[String(id)];
        },
        log: () => {},
        addAccountLog: () => {},
        processRef: {
            platform: 'win32',
            env: {
                FARM_CODE_AUTO_REFRESH: '1',
                FARM_CODE_SCHEDULED_REFRESH: '0',
                FARM_CODE_REFRESH_INTERVAL_MS: '30000',
                FARM_CODE_REFRESH_POLL_MS: '1000',
                FARM_CODE_REFRESH_RETRY_MS: '5000',
                FARM_CODE_WORKER_STOP_TIMEOUT_MS: '500',
            },
        },
        codeRefreshProvider: provider,
        desktopSessionRegistry,
    });

    manager.start();
    assert.equal(desktopStatusCalls, 1, 'startup should take exactly one desktop snapshot');

    const initial = manager.getStatus();
    assert.equal(initial.scheduledRefreshEnabled, false);
    assert.equal(initial.accounts.length, 1);
    assert.equal(initial.accounts[0].nextRefreshAt, 0);
    assert.equal(initial.accounts[0].state.state, 'ready');
    assert.equal(initial.accounts[0].state.reason, 'event_only');

    for (let i = 0; i < 20; i += 1) {
        manager.getStatus();
        manager.getAccountStatus('232');
    }
    assert.equal(
        desktopStatusCalls,
        1,
        'status/health reads must not rescan Windows processes in event-only mode',
    );

    for (let i = 0; i < 5; i += 1) {
        manager.tick();
    }
    assert.equal(
        desktopStatusCalls,
        1,
        'idle event-only poll ticks must not rescan Windows processes',
    );
    assert.equal(providerRefreshCalls, 0, 'healthy event-only account must not refresh Code on idle ticks');

    const accepted = manager.triggerRefresh('232', 'ws_400');
    assert.equal(accepted, true);
    assert.equal(
        await waitFor(() => providerRefreshCalls === 1),
        true,
        'WS400 event should still invoke Provider refresh',
    );
    assert.equal(desktopStatusCalls, 2, 'event-driven refresh should take one fresh desktop snapshot');
    assert.equal(accounts[0].code, 'SELFTEST_FRESH_1');

    const after = manager.getStatus();
    assert.equal(desktopStatusCalls, 2, 'post-refresh status should remain cache-only');
    assert.equal(after.accounts[0].nextRefreshAt, 0);
    assert.equal(after.accounts[0].state.state, 'ready');

    manager.stop();

    console.log('✅ CodeManager event-only idle poll does not spawn desktop-session scans');
    console.log('✅ status/health reads use cached desktop-session state');
    console.log('✅ WS400-style event still refreshes Code with a fresh session snapshot');
}

main().catch((err) => {
    console.error('❌ CodeManager event-only regression self-test FAIL:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
});
