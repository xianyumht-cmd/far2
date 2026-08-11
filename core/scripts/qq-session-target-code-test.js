const path = require('node:path');
const { spawnSync } = require('node:child_process');
const registry = require('../src/services/desktop-session-registry');

function maskUin(uin) {
  const text = String(uin || '').trim();
  if (!text) return '(unknown)';
  if (text.length <= 4) return '****';
  return `${text.slice(0, 2)}****${text.slice(-2)}`;
}

function main() {
  if (process.platform !== 'win32') throw new Error('此测试仅支持 Windows');

  const accountId = String(process.argv[2] || '').trim();
  if (!accountId) {
    console.log('用法: pnpm qr:session-target-code -- <accountId>');
    process.exitCode = 2;
    return;
  }

  const status = registry.getStatus();
  const binding = status.bindings.find(item => String(item.accountId || '') === accountId);
  if (!binding) throw new Error(`accountId=${accountId} 尚未建立 Desktop Session 绑定`);
  if (binding.status !== 'online' || binding.needsRebind || !binding.farmRootPid) {
    throw new Error(`accountId=${accountId} 当前 Session 不在线，请先打开对应 QQ经典农场`);
  }

  const target = status.runtimeSessions.find(item =>
    String(item.qqUin || '') === String(binding.qqUin || '')
    && Number(item.farmRootPid || 0) === Number(binding.farmRootPid || 0));
  if (!target) throw new Error('绑定存在，但当前运行时 Session 与保存的 UIN/PID 不一致');

  console.log('QQ Farm Bound Session Code Test');
  console.log(`accountId=${accountId} qq=${maskUin(binding.qqUin)}`);
  console.log(`mainQqPid=${binding.mainQqPid} farmRootPid=${binding.farmRootPid} platformChannel=${binding.platformChannel || '(none)'}`);
  console.log('目标: 不调用全局 tencent:// 账号选择器，只重载这个已绑定农场窗口。');
  console.log('注意: 复用现有 runtime-code tester；测试成功后目标农场窗口可能按旧测试逻辑自动关闭，这是本轮预期行为。');
  console.log('另一个 QQ 农场窗口不应被重载或关闭。\n');

  const preload = path.join(__dirname, 'qq-target-session-preload.js');
  const tester = path.join(__dirname, 'qq-runtime-code-capture-test.js');
  const child = spawnSync(process.execPath, ['-r', preload, tester], {
    stdio: 'inherit',
    env: {
      ...process.env,
      FAR2_TARGET_FARM_PID: String(binding.farmRootPid),
      FAR2_TARGET_ACCOUNT_ID: accountId,
      FAR2_TARGET_QQ_UIN: String(binding.qqUin || ''),
    },
  });

  const after = registry.getStatus();
  const afterBinding = after.bindings.find(item => String(item.accountId || '') === accountId) || null;
  console.log('\n=== TARGET SESSION RESULT ===');
  console.log(JSON.stringify({
    accountId,
    qqUin: maskUin(binding.qqUin),
    childExitCode: Number(child.status ?? -1),
    sessionStatusAfter: afterBinding ? afterBinding.status : 'missing',
    needsRebindAfter: afterBinding ? !!afterBinding.needsRebind : true,
    otherRuntimeSessionCount: after.runtimeSessions.filter(item => String(item.qqUin || '') !== String(binding.qqUin || '')).length,
  }, null, 2));

  if (child.error) throw child.error;
  if (child.status !== 0) process.exitCode = child.status || 1;
}

try {
  main();
} catch (err) {
  console.error('Bound Session Code Test 失败:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
}
