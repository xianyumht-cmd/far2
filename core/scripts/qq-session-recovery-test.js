const readline = require('node:readline');
const registry = require('../src/services/desktop-session-registry');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function maskUin(uin) {
  const text = String(uin || '').trim();
  if (!text) return '(unknown)';
  if (text.length <= 4) return '****';
  return `${text.slice(0, 2)}****${text.slice(-2)}`;
}

function waitEnter(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

function getBoundStatus(accountId) {
  const status = registry.getStatus();
  const binding = status.bindings.find(item => String(item.accountId || '') === String(accountId || '')) || null;
  return { status, binding };
}

async function waitUntil(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    process.stdout.write('.');
    await sleep(1000);
  }
  console.log('');
  throw new Error(`${label} 超时`);
}

async function main() {
  if (process.platform !== 'win32') throw new Error('此测试仅支持 Windows');

  const accountId = String(process.argv[2] || '').trim();
  if (!accountId) {
    console.log('用法: pnpm qr:session-recover-test -- <accountId>');
    console.log('例如: pnpm qr:session-recover-test -- 1');
    process.exitCode = 2;
    return;
  }

  const initial = getBoundStatus(accountId).binding;
  if (!initial) throw new Error(`账号 ${accountId} 尚未建立 Desktop Session 绑定`);
  if (!initial.qqUin) throw new Error(`账号 ${accountId} 的绑定没有 QQ/UIN，无法测试自动恢复`);

  const baseline = {
    qqUin: initial.qqUin,
    mainQqPid: Number(initial.mainQqPid || 0),
    farmRootPid: Number(initial.farmRootPid || 0),
    platformChannel: String(initial.platformChannel || ''),
  };

  console.log('QQ Farm Session Recovery Test');
  console.log(`accountId=${accountId} qq=${maskUin(baseline.qqUin)}`);
  console.log(`baseline mainQqPid=${baseline.mainQqPid} farmRootPid=${baseline.farmRootPid} platformChannel=${baseline.platformChannel || '(none)'}`);
  console.log('安全: 不读取 Cookie/Farm Code；只验证已保存 UIN 能否在 PID 改变后重新找到同一个 QQ Session。');

  await waitEnter('\n现在关闭“这个账号”的 QQ经典农场窗口，关闭后按 Enter 开始检测离线状态。');

  process.stdout.write('等待该 Session 离线');
  const offline = await waitUntil(() => {
    const current = getBoundStatus(accountId).binding;
    if (!current) return null;
    if (current.status === 'offline' && current.needsRebind === true) return current;
    return null;
  }, 120000, '等待 Session 离线');
  console.log('\n✅ 已检测到离线: status=offline needsRebind=true');

  await waitEnter(`\n现在重新打开同一个 QQ (${maskUin(baseline.qqUin)}) 的 QQ经典农场。若出现账号选择框，选这个 QQ；打开后按 Enter。`);

  process.stdout.write('等待 Registry 按 UIN 自动恢复');
  const recovered = await waitUntil(() => {
    const current = getBoundStatus(accountId).binding;
    if (!current) return null;
    if (current.qqUin !== baseline.qqUin) return null;
    if (current.status !== 'online' || current.needsRebind) return null;
    if (!current.mainQqPid || !current.farmRootPid) return null;
    return current;
  }, 120000, '等待 Session 自动恢复');

  console.log('\n\n=== RESULT ===');
  console.log(JSON.stringify({
    ok: true,
    accountId,
    qqUin: maskUin(recovered.qqUin),
    before: {
      mainQqPid: baseline.mainQqPid,
      farmRootPid: baseline.farmRootPid,
      platformChannel: baseline.platformChannel,
    },
    after: {
      mainQqPid: recovered.mainQqPid,
      farmRootPid: recovered.farmRootPid,
      platformChannel: recovered.platformChannel,
    },
    mainQqPidChanged: Number(recovered.mainQqPid || 0) !== baseline.mainQqPid,
    farmRootPidChanged: Number(recovered.farmRootPid || 0) !== baseline.farmRootPid,
    restoredBySavedUin: recovered.qqUin === baseline.qqUin,
    status: recovered.status,
    needsRebind: recovered.needsRebind,
  }, null, 2));

  console.log('\n✅ PASS：绑定在 Session 消失后可按保存的 QQ/UIN 自动恢复。');
}

main().catch(err => {
  console.error('\n❌ Recovery Test 失败:', err && err.message ? err.message : err);
  process.exitCode = 1;
});
