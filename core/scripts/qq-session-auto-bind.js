const store = require('../src/models/store');
const registry = require('../src/services/desktop-session-registry');

function normalizeUin(value) {
  const text = String(value || '').trim();
  return /^\d{5,12}$/.test(text) ? text : '';
}

function maskUin(uin) {
  const text = normalizeUin(uin);
  if (!text) return '(unknown)';
  if (text.length <= 4) return '****';
  return `${text.slice(0, 2)}****${text.slice(-2)}`;
}

function getAccountUin(account) {
  return normalizeUin(account && (account.uin || account.qq));
}

function main() {
  if (process.platform !== 'win32') {
    throw new Error('此命令仅支持 Windows QQ 环境');
  }

  const data = store.getAccounts();
  const accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
  const sessions = registry.scanRuntimeSessions();

  console.log('QQ Farm Session Auto Binder');
  console.log(`农场账号数: ${accounts.length}`);
  console.log(`运行中 QQ 农场 Session 数: ${sessions.length}`);
  console.log('规则: 仅当“账号 QQ/UIN ↔ Windows Session UIN”一一唯一匹配时才自动绑定。\n');

  const accountsByUin = new Map();
  for (const account of accounts) {
    const uin = getAccountUin(account);
    if (!uin) continue;
    if (!accountsByUin.has(uin)) accountsByUin.set(uin, []);
    accountsByUin.get(uin).push(account);
  }

  const sessionsByUin = new Map();
  for (const session of sessions) {
    const uin = normalizeUin(session.qqUin);
    if (!uin) continue;
    if (!sessionsByUin.has(uin)) sessionsByUin.set(uin, []);
    sessionsByUin.get(uin).push(session);
  }

  const results = [];
  const allUins = new Set([...accountsByUin.keys(), ...sessionsByUin.keys()]);

  for (const uin of allUins) {
    const accountList = accountsByUin.get(uin) || [];
    const sessionList = sessionsByUin.get(uin) || [];

    if (accountList.length === 1 && sessionList.length === 1) {
      const account = accountList[0];
      const session = sessionList[0];
      const bound = registry.bindAccount({
        accountId: String(account.id || ''),
        farmRootPid: session.farmRootPid,
        qqUin: uin,
        note: 'auto_bind_by_account_uin',
      });
      results.push({
        status: 'bound',
        accountId: bound.accountId,
        accountName: account.name || bound.accountId,
        qqUin: maskUin(uin),
        mainQqPid: bound.mainQqPid,
        farmRootPid: bound.farmRootPid,
        platformChannel: bound.platformChannel,
      });
      continue;
    }

    let reason = '';
    if (accountList.length === 0) reason = 'Windows Session 有 QQ，但后台没有对应农场账号';
    else if (sessionList.length === 0) reason = '后台有农场账号，但当前未找到对应 Windows QQ 农场 Session';
    else if (accountList.length > 1) reason = `同一 QQ 对应 ${accountList.length} 个农场账号，存在歧义`;
    else if (sessionList.length > 1) reason = `同一 QQ 对应 ${sessionList.length} 个运行 Session，存在歧义`;

    results.push({
      status: 'skipped',
      qqUin: maskUin(uin),
      accountIds: accountList.map(a => String(a.id || '')),
      farmRootPids: sessionList.map(s => s.farmRootPid),
      reason,
    });
  }

  const accountsWithoutUin = accounts.filter(account => !getAccountUin(account));
  for (const account of accountsWithoutUin) {
    results.push({
      status: 'skipped',
      accountId: String(account.id || ''),
      accountName: account.name || String(account.id || ''),
      qqUin: '(unknown)',
      reason: '该农场账号没有 uin/qq 字段，无法自动匹配',
    });
  }

  console.log('=== RESULT ===');
  for (const item of results) {
    if (item.status === 'bound') {
      console.log(`✅ accountId=${item.accountId} name=${item.accountName} qq=${item.qqUin}`);
      console.log(`   mainQqPid=${item.mainQqPid} farmRootPid=${item.farmRootPid} platformChannel=${item.platformChannel || '(none)'}`);
    } else {
      console.log(`⚠️ qq=${item.qqUin} accountId=${item.accountId || (item.accountIds || []).join(',') || '(none)'}`);
      console.log(`   ${item.reason}`);
    }
  }

  const status = registry.getStatus();
  console.log('\n=== SAVED BINDINGS ===');
  if (!status.bindings.length) {
    console.log('(none)');
  } else {
    for (const item of status.bindings) {
      console.log(`accountId=${item.accountId} qq=${maskUin(item.qqUin)} status=${item.status} needsRebind=${item.needsRebind}`);
      console.log(`  mainQqPid=${item.mainQqPid} farmRootPid=${item.farmRootPid} platformChannel=${item.platformChannel || '(none)'}`);
    }
  }

  const boundCount = results.filter(item => item.status === 'bound').length;
  console.log(`\n自动绑定完成: ${boundCount} 个。`);
  if (boundCount === 0) {
    console.log('如果后台账号尚未写入 QQ/UIN，请先不要手工猜绑定；把本命令输出发回来。');
  }
}

try {
  main();
} catch (err) {
  console.error('Session Auto Bind 失败:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
}
