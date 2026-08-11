const assert = require('node:assert/strict');
const { createIsolatedRuntimeCodeProvider } = require('../src/services/isolated-runtime-code-provider');
const { inspectIsolatedRuntime } = require('../src/services/isolated-code-agent');

function response(status, payload) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async text() {
            return JSON.stringify(payload);
        },
    };
}

function createProcessRef(extraEnv = {}) {
    return {
        platform: 'win32',
        env: {
            FARM_CODE_PROVIDER_TARGETS: JSON.stringify({
                123456789: {
                    name: 'runtime_a',
                    url: 'http://127.0.0.1:43101',
                    tokenEnv: 'TOKEN_A',
                },
                987654321: {
                    name: 'runtime_b',
                    url: 'http://127.0.0.1:43102',
                    tokenEnv: 'TOKEN_B',
                },
            }),
            TOKEN_A: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            TOKEN_B: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            ...extraEnv,
        },
    };
}

async function main() {
    const calls = [];
    let forceWrongIdentity = false;
    const fakeFetch = async (url, options = {}) => {
        calls.push({ url, method: options.method || 'GET', body: options.body || '' });
        const isA = String(url).includes(':43101/');
        const qqUin = forceWrongIdentity ? '555555555' : (isA ? '123456789' : '987654321');
        if (String(url).endsWith('/v1/health')) {
            return response(200, { ok: true, available: true, reason: 'ok', qqUin });
        }
        if (String(url).endsWith('/v1/code/refresh')) {
            return response(200, {
                ok: true,
                reason: 'ok',
                qqUin,
                code: isA ? 'FRESH_CODE_A_123' : 'FRESH_CODE_B_456',
            });
        }
        return response(404, { ok: false, reason: 'not_found', qqUin });
    };

    const processRef = createProcessRef();
    const provider = createIsolatedRuntimeCodeProvider({
        processRef,
        fetchImpl: fakeFetch,
        healthTimeoutMs: 2000,
        refreshTimeoutMs: 2000,
    });
    const accountA = { id: 'a', uin: '123456789' };
    const accountB = { id: 'b', uin: '987654321' };
    const bindingA = { accountId: 'a', qqUin: '123456789', status: 'online' };
    const bindingB = { accountId: 'b', qqUin: '987654321', status: 'online' };

    const availableA = await provider.getAvailability(accountA, bindingA);
    assert.equal(availableA.available, true);
    assert.match(calls.at(-1).url, /:43101\/v1\/health$/);

    const refreshA = await provider.refresh({ account: accountA, binding: bindingA, reason: 'selftest' });
    assert.equal(refreshA.code, 'FRESH_CODE_A_123');
    assert.match(calls.at(-1).url, /:43101\/v1\/code\/refresh$/);
    assert.equal(JSON.parse(calls.at(-1).body).qqUin, '123456789');

    const beforeMismatchCalls = calls.length;
    const mismatch = await provider.getAvailability(accountA, bindingB);
    assert.equal(mismatch.available, false);
    assert.equal(mismatch.reason, 'session_identity_mismatch');
    assert.equal(calls.length, beforeMismatchCalls, 'UIN mismatch must not call any provider endpoint');

    const availableB = await provider.getAvailability(accountB, bindingB);
    assert.equal(availableB.available, true);
    assert.match(calls.at(-1).url, /:43102\/v1\/health$/);

    forceWrongIdentity = true;
    const wrongProviderIdentity = await provider.getAvailability(accountA, bindingA);
    assert.equal(wrongProviderIdentity.available, false);
    assert.equal(wrongProviderIdentity.reason, 'provider_identity_mismatch');
    forceWrongIdentity = false;

    const insecureRef = createProcessRef({
        FARM_CODE_PROVIDER_TARGETS: JSON.stringify({
            123456789: {
                url: 'http://192.0.2.10:43101',
                tokenEnv: 'TOKEN_A',
            },
        }),
    });
    const insecureProvider = createIsolatedRuntimeCodeProvider({ processRef: insecureRef, fetchImpl: fakeFetch });
    const beforeInsecureCalls = calls.length;
    const insecure = await insecureProvider.getAvailability(accountA, bindingA);
    assert.equal(insecure.available, false);
    assert.equal(insecure.reason, 'provider_insecure_endpoint');
    assert.equal(calls.length, beforeInsecureCalls, 'insecure remote endpoint must be rejected before fetch');

    const singleRuntimeRegistry = {
        getCurrentWindowsSessionId: () => 7,
        scanMainQqProcesses: () => [{ qqUin: '123456789', mainQqPid: 100, windowsSessionId: 7 }],
        scanRuntimeSessions: () => [{ qqUin: '123456789', farmRootPid: 200, windowsSessionId: 7 }],
    };
    const runtimeCode = { findFarmFolders: () => ['farm-cache'] };
    const isolatedReady = inspectIsolatedRuntime({
        expectedUin: '123456789',
        processRef: { platform: 'win32' },
        desktopSessionRegistry: singleRuntimeRegistry,
        windowsRuntimeCode: runtimeCode,
    });
    assert.equal(isolatedReady.available, true);

    const multiQq = inspectIsolatedRuntime({
        expectedUin: '123456789',
        processRef: { platform: 'win32' },
        desktopSessionRegistry: {
            ...singleRuntimeRegistry,
            scanMainQqProcesses: () => [
                { qqUin: '123456789', mainQqPid: 100, windowsSessionId: 7 },
                { qqUin: '987654321', mainQqPid: 101, windowsSessionId: 7 },
            ],
        },
        windowsRuntimeCode: runtimeCode,
    });
    assert.equal(multiQq.available, false);
    assert.equal(multiQq.reason, 'agent_multiple_qq_in_session');

    const wrongRuntime = inspectIsolatedRuntime({
        expectedUin: '123456789',
        processRef: { platform: 'win32' },
        desktopSessionRegistry: {
            ...singleRuntimeRegistry,
            scanRuntimeSessions: () => [{ qqUin: '987654321', farmRootPid: 201, windowsSessionId: 7 }],
        },
        windowsRuntimeCode: runtimeCode,
    });
    assert.equal(wrongRuntime.available, false);
    assert.equal(wrongRuntime.reason, 'agent_runtime_identity_mismatch');

    console.log('✅ isolated Code Provider selftest passed');
    console.log('   - exact UIN routes to exact endpoint');
    console.log('   - account/session mismatch never calls provider');
    console.log('   - provider identity mismatch is rejected');
    console.log('   - remote plaintext HTTP is rejected by default');
    console.log('   - agent rejects multiple QQ in its Windows session');
    console.log('   - agent rejects runtime UIN mismatch');
}

main().catch(err => {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
});
