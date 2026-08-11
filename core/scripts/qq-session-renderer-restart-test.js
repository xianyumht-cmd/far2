const { execFileSync } = require('node:child_process');
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

function getProcessSnapshot() {
  const ps = [
    '$ErrorActionPreference="SilentlyContinue";',
    'Get-CimInstance Win32_Process |',
    'Select-Object Name,ProcessId,ParentProcessId,CommandLine |',
    'ConvertTo-Json -Compress -Depth 3',
  ].join(' ');
  const out = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps,
  ], { windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
  const text = out.toString('utf8').trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return (Array.isArray(parsed) ? parsed : [parsed]).map(row => ({
    name: String(row.Name || ''),
    pid: Number(row.ProcessId || 0),
    ppid: Number(row.ParentProcessId || 0),
    cmd: String(row.CommandLine || ''),
  }));
}

function getDescendants(rows, rootPid) {
  const result = [];
  const queue = [Number(rootPid)];
  const seen = new Set(queue);
  while (queue.length) {
    const ppid = queue.shift();
    for (const row of rows) {
      if (Number(row.ppid) !== ppid || seen.has(Number(row.pid))) continue;
      seen.add(Number(row.pid));
      result.push(row);
      queue.push(Number(row.pid));
    }
  }
  return result;
}

function isRenderer(row) {
  return String(row && row.name || '').toLowerCase() === 'qq.exe'
    && /--type=renderer(?:\s|$)/i.test(String(row && row.cmd || ''));
}

function safeFlags(cmd) {
  const text = String(cmd || '');
  const flags = [];
  for (const match of text.matchAll(/--([A-Za-z0-9_-]+)(?:=([^\s"]+|"[^"]*"))?/g)) {
    const key = match[1];
    if (/token|ticket|cookie|code|auth|skey|session/i.test(key)) continue;
    if (['type', 'user-data-dir', 'app-path', 'lang', 'renderer-client-id', 'enable-features', 'disable-features'].includes(key)) {
      let value = String(match[2] || '');
      if (key === 'user-data-dir') value = '<QQEX>';
      if (value.length > 120) value = value.slice(0, 117) + '...';
      flags.push(`--${key}${value ? '=' + value : ''}`);
    }
  }
  return flags.join(' ');
}

function killPids(pids) {
  const ids = pids.map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (!ids.length) return;
  const list = ids.join(',');
  const ps = `$ErrorActionPreference='Stop'; Stop-Process -Id ${list} -Force`;
  execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps,
  ], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
}

async function main() {
  if (process.platform !== 'win32') throw new Error('此测试仅支持 Windows');
  const accountId = String(process.argv[2] || '').trim();
  if (!accountId) throw new Error('用法: pnpm qr:session-renderer-restart -- <accountId>');

  const beforeStatus = registry.getStatus();
  const binding = beforeStatus.bindings.find(x => String(x.accountId || '') === accountId);
  if (!binding || binding.status !== 'online' || binding.needsRebind || !binding.farmRootPid) {
    throw new Error(`accountId=${accountId} 当前绑定 Session 不在线，请先打开对应 QQ经典农场`);
  }

  const rows = getProcessSnapshot();
  const descendants = getDescendants(rows, binding.farmRootPid);
  const renderers = descendants.filter(isRenderer);

  console.log('QQ Farm Bound Session Renderer Restart Test');
  console.log(`accountId=${accountId} qq=${maskUin(binding.qqUin)}`);
  console.log(`mainQqPid=${binding.mainQqPid} farmRootPid=${binding.farmRootPid}`);
  console.log(`rendererCount=${renderers.length}`);
  for (const r of renderers) console.log(`renderer PID=${r.pid} PPID=${r.ppid} ${safeFlags(r.cmd)}`);
  console.log('安全范围: 只终止上述 farmRootPid 的 renderer 子进程；不终止 QQ 主进程/farmRoot/另一个账号。');

  if (!renderers.length) {
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({ ok: false, reason: 'no_renderer_found', accountId, qqUin: maskUin(binding.qqUin) }, null, 2));
    process.exitCode = 2;
    return;
  }

  const oldRendererPids = renderers.map(r => r.pid);
  killPids(oldRendererPids);
  console.log(`已终止目标 renderer: ${oldRendererPids.join(', ')}`);
  console.log('等待 QQEX 自动恢复 renderer...');

  let newRenderers = [];
  let finalBinding = null;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(500);
    const status = registry.getStatus();
    finalBinding = status.bindings.find(x => String(x.accountId || '') === accountId) || null;
    if (!finalBinding || finalBinding.status !== 'online' || !finalBinding.farmRootPid) continue;
    const currentRows = getProcessSnapshot();
    const currentDesc = getDescendants(currentRows, finalBinding.farmRootPid);
    newRenderers = currentDesc.filter(isRenderer).filter(r => !oldRendererPids.includes(r.pid));
    if (newRenderers.length) break;
  }

  const finalStatus = registry.getStatus();
  finalBinding = finalStatus.bindings.find(x => String(x.accountId || '') === accountId) || finalBinding;
  const otherSessions = finalStatus.runtimeSessions.filter(x => String(x.qqUin || '') !== String(binding.qqUin || ''));
  const ok = !!(finalBinding && finalBinding.status === 'online' && !finalBinding.needsRebind && newRenderers.length > 0);

  console.log('\n=== RESULT ===');
  console.log(JSON.stringify({
    ok,
    accountId,
    qqUin: maskUin(binding.qqUin),
    beforeFarmRootPid: binding.farmRootPid,
    afterFarmRootPid: finalBinding ? finalBinding.farmRootPid : 0,
    oldRendererPids,
    newRendererPids: newRenderers.map(r => r.pid),
    sessionStatusAfter: finalBinding ? finalBinding.status : 'missing',
    needsRebindAfter: finalBinding ? !!finalBinding.needsRebind : true,
    otherRuntimeSessionCount: otherSessions.length,
    reason: ok ? 'renderer_respawned' : 'renderer_not_respawned',
  }, null, 2));

  if (ok) console.log('\n✅ PASS：目标农场 renderer 可独立重启并由 QQEX 自动恢复。');
  else {
    console.log('\n❌ FAIL：QQEX 没有在测试窗口内自动恢复目标 renderer。');
    console.log('如果目标农场窗口异常/关闭，手动重新打开对应 QQ 的 QQ经典农场即可；不要重跑旧 target-code 测试。');
    process.exitCode = 2;
  }
}

main().catch(err => {
  console.error('Renderer Restart Test 失败:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
