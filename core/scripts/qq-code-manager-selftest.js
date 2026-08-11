const assert = require('node:assert/strict');
const { createCodeManager } = require('../src/services/code-manager');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function main() {
  const accounts = [
    {
      id: '1',
      name: '4476',
      platform: 'qq',
      uin: '447677756',
      qq: '447677756',
      code: 'SELFTEST_OLD_1',
      codeRefreshEnabled: true,
      codeRefreshMode: 'windows_session',
    },
    {
      id: '2',
      name: '232',
      platform: 'qq',
      uin: '2320006072',
      qq: '2320006072',
      code: 'SELFTEST_OLD_2',
      codeRefreshEnabled: true,
      codeRefreshMode: 'windows_session',
    },
  ];

  const store = {
    getAccounts() {
      return { accounts: clone(accounts) };
    },
    addOrUpdateAccount(patch) {
      const id = String(patch && patch.id || '');
      const index = accounts.findIndex(a => String(a.id || '') === id);
      if (index < 0) throw new Error(`selftest account not found: ${id}`);
      accounts[index] = { ...accounts[index], ...clone(patch) };
      return { accounts: clone(accounts) };
    },
  };

  let bindings = [
    {
      accountId: '1',
      qqUin: '447677756',
      mainQqPid: 11001,
      farmRootPid: 12001,
      status: 'online',
      needsRebind: false,
    },
    {
      accountId: '2',
      qqUin: '2320006072',
      mainQqPid: 11002,
      farmRootPid: 12002,
      status: 'online',
      needsRebind: false,
    },
  ];

  const desktopSessionRegistry = {
    getStatus() {
      return {
        bindings: clone(bindings),
        runtimeSessions: [],
      };
    },
  };

  const workers = {
    1: { selftest: true },
    2: { selftest: true },
  };
  const stopped = [];
  const started = [];

  function stopWorker(id) {
    const key = String(id || '');
    stopped.push(key);
    delete workers[key];
  }

  function startWorker(account) {
    const key = String(account && account.id || '');
    started.push(key);
    workers[key] = { selftest: true, code: account.code };
    return true;
  }

  const unavailable = new Set();
  let sequence = 0;
  let providerRefreshCalls = 0;
  const fakeProvider = {
    name: 'selftest_targeted_provider',
    async getAvailability(account, binding) {
      const id = String(account && account.id || '');
      if (!binding) return { available: false, reason: 'desktop_session_not_bound' };
      if (binding.status !== 'online' || binding.needsRebind) {
        return { available: false, reason: 'desktop_session_offline' };
      }
      if (unavailable.has(id)) {
        return { available: false, reason: 'selftest_provider_unavailable' };
      }
      return { available: true, reason: 'ok' };
    },
    async refresh({ account, binding }) {
      providerRefreshCalls += 1;
      assert.equal(String(account.id), String(binding.accountId), 'provider received mismatched account/session');
      sequence += 1;
      return {
        code: `SELFTEST_FRESH_${account.id}_${sequence}`,
        source: 'selftest',
      };
    },
  };

  const manager = createCodeManager({
    store,
    workers,
    startWorker,
    stopWorker,
    log: () => {},
    addAccountLog: () => {},
    processRef: {
      platform: 'win32',
      env: {
        FARM_CODE_AUTO_REFRESH: '1',
        FARM_CODE_REFRESH_INTERVAL_MS: '30000',
        FARM_CODE_REFRESH_POLL_MS: '1000',
        FARM_CODE_REFRESH_RETRY_MS: '5000',
        FARM_CODE_WORKER_STOP_TIMEOUT_MS: '1000',
      },
    },
    codeRefreshProvider: fakeProvider,
    desktopSessionRegistry,
  });

  console.log('QQ Farm CodeManager Multi-Account Self-Test');
  console.log('安全: 使用 fake Provider / fake Code / fake Session，不访问 QQ、不访问农场服务器。\n');

  const old2 = accounts[1].code;
  const r1 = await manager.refreshAccount('1', 'selftest_account_1');
  assert.equal(r1.ok, true);
  assert.match(accounts[0].code, /^SELFTEST_FRESH_1_/);
  assert.equal(accounts[1].code, old2, 'account 2 code changed while refreshing account 1');
  assert.deepEqual(stopped, ['1']);
  assert.deepEqual(started, ['1']);
  console.log('✅ account 1 refresh isolation PASS');

  stopped.length = 0;
  started.length = 0;
  const old1 = accounts[0].code;
  const r2 = await manager.refreshAccount('2', 'selftest_account_2');
  assert.equal(r2.ok, true);
  assert.match(accounts[1].code, /^SELFTEST_FRESH_2_/);
  assert.equal(accounts[0].code, old1, 'account 1 code changed while refreshing account 2');
  assert.deepEqual(stopped, ['2']);
  assert.deepEqual(started, ['2']);
  console.log('✅ account 2 refresh isolation PASS');

  stopped.length = 0;
  started.length = 0;
  const beforeOfflineCode = accounts[1].code;
  bindings = bindings.map(item => String(item.accountId) === '2'
    ? { ...item, status: 'offline', needsRebind: true }
    : item);
  const offline = await manager.refreshAccount('2', 'selftest_offline');
  assert.equal(offline.ok, false);
  assert.equal(offline.state, 'waiting_session');
  assert.equal(accounts[1].code, beforeOfflineCode);
  assert.deepEqual(stopped, []);
  assert.deepEqual(started, []);
  console.log('✅ offline Session does not stop worker PASS');

  bindings = bindings.map(item => String(item.accountId) === '2'
    ? { ...item, status: 'online', needsRebind: false }
    : item);
  stopped.length = 0;
  started.length = 0;
  unavailable.add('1');
  const beforeProviderCode = accounts[0].code;
  const pending = await manager.refreshAccount('1', 'selftest_provider_pending');
  assert.equal(pending.ok, false);
  assert.equal(pending.state, 'waiting_provider');
  assert.equal(accounts[0].code, beforeProviderCode);
  assert.deepEqual(stopped, []);
  assert.deepEqual(started, []);
  console.log('✅ unavailable Provider does not stop worker PASS');

  unavailable.delete('1');
  stopped.length = 0;
  started.length = 0;
  const beforeMismatchCode = accounts[0].code;
  const callsBeforeMismatch = providerRefreshCalls;
  bindings = bindings.map(item => String(item.accountId) === '1'
    ? { ...item, qqUin: '2320006072', status: 'online', needsRebind: false }
    : item);
  const mismatch = await manager.refreshAccount('1', 'selftest_identity_mismatch');
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.state, 'session_mismatch');
  assert.equal(mismatch.reason, 'session_identity_mismatch');
  assert.equal(accounts[0].code, beforeMismatchCode, 'code changed despite session identity mismatch');
  assert.equal(providerRefreshCalls, callsBeforeMismatch, 'provider.refresh was called despite identity mismatch');
  assert.deepEqual(stopped, []);
  assert.deepEqual(started, []);
  const mismatchStatus = manager.getAccountStatus('1');
  assert.equal(mismatchStatus.sessionIdentityOk, false);
  assert.equal(mismatchStatus.sessionIdentityReason, 'session_identity_mismatch');
  assert.equal(mismatchStatus.expectedQqUin, '44****56');
  assert.equal(mismatchStatus.qqUin, '23****72');
  console.log('✅ mismatched Session is blocked before Provider PASS');

  bindings = bindings.map(item => String(item.accountId) === '1'
    ? { ...item, qqUin: '447677756', status: 'online', needsRebind: false }
    : item);
  stopped.length = 0;
  started.length = 0;
  const recovered = await manager.refreshAccount('1', 'selftest_identity_recovered');
  assert.equal(recovered.ok, true);
  assert.equal(providerRefreshCalls, callsBeforeMismatch + 1);
  console.log('✅ corrected Session can refresh again PASS');

  const status = manager.getStatus();
  assert.equal(status.configuredCount, 2);
  assert.equal(status.provider, 'selftest_targeted_provider');
  assert.equal(status.accounts.length, 2);
  assert.equal(status.accounts.find(x => x.accountId === '1').qqUin, '44****56');
  assert.equal(status.accounts.find(x => x.accountId === '2').qqUin, '23****72');
  assert.equal(status.accounts.find(x => x.accountId === '1').sessionIdentityOk, true);
  assert.equal(status.accounts.find(x => x.accountId === '2').sessionIdentityOk, true);
  console.log('✅ status isolation/privacy PASS');

  console.log('\n=== RESULT ===');
  console.log(JSON.stringify({
    ok: true,
    accountCount: status.accounts.length,
    provider: status.provider,
    sessionIdentityHardGuard: true,
    account1: {
      qq: status.accounts.find(x => x.accountId === '1').qqUin,
      state: status.accounts.find(x => x.accountId === '1').state.state,
    },
    account2: {
      qq: status.accounts.find(x => x.accountId === '2').qqUin,
      state: status.accounts.find(x => x.accountId === '2').state.state,
    },
    realQqTouched: false,
    realFarmCodeTouched: false,
  }, null, 2));
}

main().catch(err => {
  console.error('\n❌ CodeManager self-test FAIL:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});