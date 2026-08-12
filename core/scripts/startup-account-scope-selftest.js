const assert = require('node:assert/strict');
const { resolveStartupAccountScope } = require('../src/services/startup-account-scope');

function fakeProcess(env = {}) {
    return { env: { ...env } };
}

function encodeTargets(targets) {
    return Buffer.from(JSON.stringify(targets), 'utf8').toString('base64');
}

function ids(scope) {
    return (scope.accounts || []).map(item => String(item.id));
}

function main() {
    const accounts = [
        { id: '1', name: '4476', uin: '447600001' },
        { id: '2', name: '232', uin: '2320006072' },
        { id: '3', name: 'wx', platform: 'wx' },
    ];

    console.log('FAR2 Startup Account Scope Self-Test');
    console.log('安全: 纯配置解析，不启动 Worker、不访问 QQ/农场。\n');

    const generic = resolveStartupAccountScope(accounts, fakeProcess());
    assert.equal(generic.mode, 'all_saved');
    assert.deepEqual(ids(generic), ['1', '2', '3']);
    console.log('✅ no Provider targets -> keep generic all-saved behavior PASS');

    const singleTarget = resolveStartupAccountScope(accounts, fakeProcess({
        FARM_CODE_PROVIDER_TARGETS_B64: encodeTargets({
            2320006072: { url: 'http://127.0.0.1:43101', tokenEnv: 'TEST_TOKEN' },
        }),
    }));
    assert.equal(singleTarget.mode, 'provider_targets');
    assert.deepEqual(singleTarget.providerTargetUins, ['2320006072']);
    assert.deepEqual(ids(singleTarget), ['2']);
    console.log('✅ single Provider target -> only matching saved QQ PASS');

    const multiTarget = resolveStartupAccountScope(accounts, fakeProcess({
        FARM_CODE_PROVIDER_TARGETS: JSON.stringify({
            447600001: { url: 'http://127.0.0.1:43101' },
            2320006072: { url: 'http://127.0.0.1:43102' },
        }),
    }));
    assert.equal(multiTarget.mode, 'provider_targets');
    assert.deepEqual(ids(multiTarget), ['1', '2']);
    console.log('✅ multi Provider targets -> only matching QQ accounts PASS');

    const explicit = resolveStartupAccountScope(accounts, fakeProcess({
        FARM_AUTO_START_ACCOUNT_REFS: '1;2320006072',
        FARM_CODE_PROVIDER_TARGETS_B64: encodeTargets({
            2320006072: { url: 'http://127.0.0.1:43101' },
        }),
    }));
    assert.equal(explicit.mode, 'explicit_refs');
    assert.deepEqual(ids(explicit), ['1', '2']);
    console.log('✅ explicit refs override Provider-derived scope PASS');

    const invalid = resolveStartupAccountScope(accounts, fakeProcess({
        FARM_CODE_PROVIDER_TARGETS_B64: Buffer.from('{not-json', 'utf8').toString('base64'),
    }));
    assert.equal(invalid.failClosed, true);
    assert.deepEqual(ids(invalid), []);
    console.log('✅ invalid configured Provider targets -> fail closed PASS');

    const unmatched = resolveStartupAccountScope(accounts, fakeProcess({
        FARM_CODE_PROVIDER_TARGETS: JSON.stringify({
            99999999: { url: 'http://127.0.0.1:43109' },
        }),
    }));
    assert.equal(unmatched.failClosed, false);
    assert.deepEqual(ids(unmatched), []);
    console.log('✅ valid but unmatched Provider target -> no accidental Worker PASS');

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        genericBehaviorPreserved: true,
        providerScopedAutostart: true,
        explicitOverride: true,
        invalidConfigFailClosed: true,
        realQqTouched: false,
    }, null, 2));
}

try {
    main();
}
catch (err) {
    console.error('\n❌ Startup account scope self-test FAIL:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
}
