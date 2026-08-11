const store = require('../src/models/store');
const desktopSessions = require('../src/services/desktop-session-registry');

function maskUin(value) {
  const text = String(value || '').trim();
  if (!/^\d{5,12}$/.test(text)) return '(unknown)';
  if (text.length <= 4) return '****';
  return `${text.slice(0, 2)}****${text.slice(-2)}`;
}

function main() {
  const data = store.getAccounts();
  const accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
  const bindings = desktopSessions.getBindings();
  const sessions = desktopSessions.scanRuntimeSessions();

  console.log('QQ Farm Account / Session Binding Audit');
  console.log('只读审计：不会抓 Code、不会修改绑定、不会操作 QQ 进程。\n');

  const bindingByAccount = new Map(bindings.map(item => [String(item.accountId || ''), item]));
  const runtimeByUin = new Map(sessions.filter(item => item.qqUin).map(item => [String(item.qqUin), item]));
  const bindingOwnersByUin = new Map();
  for (const binding of bindings) {
    const uin = String(binding.qqUin || '');
    if (!uin) continue;
    const owners = bindingOwnersByUin.get(uin) || [];
    owners.push(String(binding.accountId || ''));
    bindingOwnersByUin.set(uin, owners);
  }

  const rows = [];
  let issueCount = 0;

  console.log('=== ACCOUNTS ===');
  for (const account of accounts) {
    const accountId = String(account.id || '');
    const expectedUin = String(account.uin || account.qq || '').trim();
    const binding = bindingByAccount.get(accountId) || null;
    const boundUin = String(binding && binding.qqUin || '').trim();
    const expectedRuntime = expectedUin ? runtimeByUin.get(expectedUin) || null : null;
    const boundRuntime = boundUin ? runtimeByUin.get(boundUin) || null : null;
    const duplicateOwners = boundUin ? (bindingOwnersByUin.get(boundUin) || []) : [];

    const problems = [];
    if (!expectedUin) problems.push('account_uin_missing');
    if (!binding) problems.push('binding_missing');
    if (binding && expectedUin && boundUin !== expectedUin) problems.push('binding_uin_mismatch');
    if (binding && !boundUin) problems.push('binding_uin_missing');
    if (duplicateOwners.length > 1) problems.push('duplicate_binding_uin');
    if (expectedUin && !expectedRuntime) problems.push('expected_session_offline');
    if (binding && boundUin && !boundRuntime) problems.push('bound_session_offline');

    const ok = problems.length === 0;
    if (!ok) issueCount += 1;

    rows.push({
      accountId,
      name: account.name || accountId,
      expectedUin: maskUin(expectedUin),
      boundUin: maskUin(boundUin),
      expectedRuntimeOnline: !!expectedRuntime,
      boundRuntimeOnline: !!boundRuntime,
      bindingStatus: binding ? String(binding.status || 'unknown') : 'unbound',
      needsRebind: binding ? !!binding.needsRebind : true,
      mainQqPid: boundRuntime ? boundRuntime.mainQqPid : Number(binding && binding.mainQqPid || 0),
      farmRootPid: boundRuntime ? boundRuntime.farmRootPid : Number(binding && binding.farmRootPid || 0),
      problems,
      ok,
    });

    console.log(`accountId=${accountId} name=${account.name || accountId}`);
    console.log(`  accountUin=${maskUin(expectedUin)} bindingUin=${maskUin(boundUin)}`);
    console.log(`  expectedSession=${expectedRuntime ? 'online' : 'offline'} boundSession=${boundRuntime ? 'online' : 'offline'}`);
    console.log(`  bindingStatus=${binding ? binding.status : 'unbound'} needsRebind=${binding ? !!binding.needsRebind : true}`);
    console.log(`  result=${ok ? 'OK' : problems.join(',')}`);
  }

  console.log('\n=== RUNTIME SESSIONS ===');
  if (!sessions.length) {
    console.log('(none)');
  } else {
    for (const session of sessions) {
      console.log(`qq=${maskUin(session.qqUin)} mainQqPid=${session.mainQqPid} farmRootPid=${session.farmRootPid} source=${session.uinSource || '(none)'}`);
    }
  }

  console.log('\n=== SAVED BINDINGS ===');
  if (!bindings.length) {
    console.log('(none)');
  } else {
    for (const binding of bindings) {
      console.log(`accountId=${binding.accountId} qq=${maskUin(binding.qqUin)} status=${binding.status} needsRebind=${!!binding.needsRebind}`);
    }
  }

  console.log('\n=== RESULT ===');
  console.log(JSON.stringify({
    ok: issueCount === 0,
    accountCount: accounts.length,
    bindingCount: bindings.length,
    runtimeSessionCount: sessions.length,
    issueCount,
    accounts: rows,
  }, null, 2));

  if (issueCount > 0) process.exitCode = 2;
}

try {
  main();
} catch (err) {
  console.error('Session binding audit 失败:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
}
