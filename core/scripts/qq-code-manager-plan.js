const store = require('../src/models/store');
const registry = require('../src/services/desktop-session-registry');

function maskUin(uin) {
  const text = String(uin || '').trim();
  if (!text) return '(unknown)';
  if (text.length <= 4) return '****';
  return `${text.slice(0, 2)}****${text.slice(-2)}`;
}

function main() {
  const data = store.getAccounts();
  const accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
  const status = registry.getStatus();
  const bindings = Array.isArray(status.bindings) ? status.bindings : [];

  console.log('QQ Farm Multi-Account CodeManager Plan');
  console.log('只读诊断：不会抓 Code、不会修改账号、不会操作 QQ 进程。');
  console.log('provider=targeted_provider_pending');
  console.log('fallbackGlobalTencentUri=false\n');

  const rows = accounts.map(account => {
    const id = String(account.id || '');
    const binding = bindings.find(item => String(item.accountId || '') === id) || null;
    const configured = account.codeRefreshEnabled === true
      && String(account.codeRefreshMode || 'windows_session').toLowerCase() === 'windows_session';
    const plannedState = !binding || binding.status !== 'online' || binding.needsRebind
      ? 'waiting_session'
      : 'waiting_provider';

    return {
      accountId: id,
      accountName: account.name || id,
      qqUin: binding ? maskUin(binding.qqUin) : '(unbound)',
      sessionStatus: binding ? binding.status : 'unbound',
      needsRebind: binding ? !!binding.needsRebind : true,
      configured,
      codeRefreshMode: String(account.codeRefreshMode || ''),
      plannedState,
    };
  });

  console.log('=== ACCOUNTS ===');
  for (const row of rows) {
    console.log(`accountId=${row.accountId} name=${row.accountName} qq=${row.qqUin}`);
    console.log(`  session=${row.sessionStatus} needsRebind=${row.needsRebind} configured=${row.configured} mode=${row.codeRefreshMode || '(none)'}`);
    console.log(`  plannedState=${row.plannedState}`);
  }

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({
    accountCount: rows.length,
    boundCount: rows.filter(row => row.sessionStatus !== 'unbound').length,
    onlineBoundCount: rows.filter(row => row.sessionStatus === 'online' && !row.needsRebind).length,
    configuredCount: rows.filter(row => row.configured).length,
    provider: 'targeted_provider_pending',
    fallbackGlobalTencentUri: false,
  }, null, 2));
}

try {
  main();
} catch (err) {
  console.error('CodeManager Plan 失败:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
}
