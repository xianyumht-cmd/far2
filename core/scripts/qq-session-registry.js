const registry = require('../src/services/desktop-session-registry');

function maskUin(uin) {
  const text = String(uin || '').trim();
  if (!text) return '';
  if (text.length <= 4) return '****';
  return `${text.slice(0, 2)}****${text.slice(-2)}`;
}

function printSessions(sessions) {
  console.log('\n=== RUNTIME FARM SESSIONS ===');
  if (!sessions.length) {
    console.log('(none)');
    return;
  }
  for (const item of sessions) {
    console.log(`farmRootPid=${item.farmRootPid} mainQqPid=${item.mainQqPid} platformChannel=${item.platformChannel || '(none)'} qqUin=${maskUin(item.qqUin) || '(unknown)'}`);
  }
}

function printBindings(bindings) {
  console.log('\n=== SAVED BINDINGS ===');
  if (!bindings.length) {
    console.log('(none)');
    return;
  }
  for (const item of bindings) {
    console.log(`accountId=${item.accountId} qqUin=${maskUin(item.qqUin) || '(unknown)'} status=${item.status} needsRebind=${item.needsRebind}`);
    console.log(`  mainQqPid=${item.mainQqPid || 0} farmRootPid=${item.farmRootPid || 0} platformChannel=${item.platformChannel || '(none)'}`);
  }
}

function usage() {
  console.log('QQ Farm Desktop Session Registry');
  console.log('');
  console.log('用法:');
  console.log('  pnpm qr:sessions');
  console.log('  pnpm qr:session-bind -- <accountId> <farmRootPid> <qqUin>');
  console.log('  pnpm qr:session-unbind -- <accountId>');
  console.log('');
  console.log('说明: qqUin 只是 QQ 号，用于持久识别 Session；不会读取或保存 Cookie/Farm Code。');
}

function main() {
  const command = String(process.argv[2] || 'list').trim().toLowerCase();

  if (command === 'list' || command === 'status') {
    const status = registry.getStatus();
    console.log('QQ Farm Desktop Session Registry');
    console.log(`registryFile=${status.registryFile}`);
    printSessions(status.runtimeSessions);
    printBindings(status.bindings);
    return;
  }

  if (command === 'bind') {
    const accountId = String(process.argv[3] || '').trim();
    const farmRootPid = Number(process.argv[4] || 0);
    const qqUin = String(process.argv[5] || '').trim();
    if (!accountId || !farmRootPid || !/^\d{5,12}$/.test(qqUin)) {
      usage();
      process.exitCode = 2;
      return;
    }
    const bound = registry.bindAccount({ accountId, farmRootPid, qqUin });
    console.log('✅ Session 绑定已保存');
    console.log(JSON.stringify({
      accountId: bound.accountId,
      qqUin: maskUin(bound.qqUin),
      mainQqPid: bound.mainQqPid,
      farmRootPid: bound.farmRootPid,
      platformChannel: bound.platformChannel,
      status: bound.status,
      needsRebind: bound.needsRebind,
    }, null, 2));
    return;
  }

  if (command === 'unbind') {
    const accountId = String(process.argv[3] || '').trim();
    if (!accountId) {
      usage();
      process.exitCode = 2;
      return;
    }
    const removed = registry.unbindAccount(accountId);
    console.log(removed ? '✅ Session 绑定已删除' : '未找到对应绑定');
    return;
  }

  usage();
  process.exitCode = 2;
}

try {
  main();
} catch (err) {
  console.error('Session Registry 失败:', err && err.message ? err.message : err);
  process.exitCode = 1;
}
