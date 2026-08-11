const { execFileSync, execSync } = require('node:child_process');
const readline = require('node:readline');

const MINIAPP_URI = 'tencent://ntqq-open/?&subCmd=miniapp&action=openQQMiniApp&actionParams=%7B%22sourceType%22%3A%22open%22%2C%22appId%22%3A%221112386029%22%2C%22hostScene%22%3A%221246700100%22%7D';
const FARM_APP_ID = '1112386029';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

function getProcessSnapshot() {
  const ps = [
    '$ErrorActionPreference="SilentlyContinue";',
    'Get-CimInstance Win32_Process |',
    'Select-Object Name,ProcessId,ParentProcessId,ExecutablePath,CommandLine,CreationDate |',
    'ConvertTo-Json -Compress -Depth 3',
  ].join(' ');
  const out = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps,
  ], { windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
  const raw = out.toString('utf8').trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return (Array.isArray(parsed) ? parsed : [parsed]).map(row => ({
    name: String(row.Name || ''),
    pid: Number(row.ProcessId || 0),
    ppid: Number(row.ParentProcessId || 0),
    exe: String(row.ExecutablePath || ''),
    cmd: String(row.CommandLine || ''),
    created: String(row.CreationDate || ''),
  }));
}

function isQQRelated(row) {
  const name = String(row.name || '').toLowerCase();
  const cmd = String(row.cmd || '').toLowerCase();
  return name === 'qq.exe'
    || name === 'qqex.exe'
    || name.includes('qqex')
    || cmd.includes('qqex')
    || cmd.includes('--loadapp=mini-app')
    || cmd.includes('--loadapp=exapp')
    || cmd.includes('1112386029')
    || cmd.includes('openqqminiapp');
}

function sanitize(text) {
  let value = String(text || '');
  value = value.replace(/((?:code|ticket|token|auth_code|authcode|skey|p_skey|pt4_token|session|cookie)=)[^\s&"']+/gi, '$1<redacted>');
  value = value.replace(new RegExp(`(?<!\\d)${FARM_APP_ID}(?!\\d)`, 'g'), '__FARM_APP_ID__');
  value = value.replace(/(?<!\d)(\d{8,12})(?!\d)/g, m => `${m.slice(0, 2)}****${m.slice(-2)}`);
  value = value.replace(/__FARM_APP_ID__/g, FARM_APP_ID);
  value = value.replace(/[A-Za-z0-9_-]{32,}/g, '<long-value-redacted>');
  return value;
}

function openFarm() {
  try {
    execSync(`rundll32 url.dll,FileProtocolHandler "${MINIAPP_URI}"`, { windowsHide: true, timeout: 10000 });
    return true;
  } catch {
    try {
      execSync(`cmd.exe /c start "" "${MINIAPP_URI}"`, { windowsHide: true, timeout: 10000, shell: true });
      return true;
    } catch {
      return false;
    }
  }
}

function getDescendants(rows, rootPids) {
  const selected = new Set(rootPids.map(Number).filter(Boolean));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (selected.has(Number(row.ppid)) && !selected.has(Number(row.pid))) {
        selected.add(Number(row.pid));
        changed = true;
      }
    }
  }
  return rows.filter(row => selected.has(Number(row.pid)));
}

function printRows(title, rows) {
  console.log(`\n=== ${title} ===`);
  if (!rows.length) {
    console.log('(none)');
    return;
  }
  for (const row of rows) {
    console.log(`PID=${row.pid} PPID=${row.ppid} NAME=${row.name}`);
    if (row.exe) console.log(`EXE=${sanitize(row.exe)}`);
    if (row.cmd) console.log(`CMD=${sanitize(row.cmd)}`);
    console.log('---');
  }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('此诊断仅支持 Windows');

  console.log('QQ Multi-Account MiniApp Process Mapper');
  console.log('用途: 找出“选择某个 QQ 账号后”农场小程序实际绑定到哪个 QQ/QQEX 进程。');
  console.log('安全: 不读取 Cookie、不读取 Farm Code；命令行中的疑似凭证会自动脱敏。');
  console.log('请先关闭当前已经打开的 QQ经典农场窗口，但保持多个 Windows QQ 账号正常登录。');

  await waitEnter('\n准备好后按 Enter。脚本会打开 QQ经典农场；如果出现账号选择框，只手动选择一次你要测试的 QQ。');

  const before = getProcessSnapshot();
  const beforePids = new Set(before.map(row => row.pid));
  const beforeQQ = before.filter(isQQRelated);
  console.log(`\n打开前 QQ/QQEX 相关进程: ${beforeQQ.length} 个`);

  const opened = openFarm();
  console.log(opened ? '已请求打开 QQ经典农场。现在如果出现账号选择框，请选择一个目标 QQ。' : '自动打开失败，请现在手动打开 QQ经典农场并选择一个目标 QQ。');
  console.log('正在观察 25 秒...');

  const seen = new Map();
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    let rows = [];
    try { rows = getProcessSnapshot(); } catch { continue; }
    for (const row of rows) {
      if (!beforePids.has(row.pid) && isQQRelated(row)) seen.set(row.pid, row);
    }
    process.stdout.write('.');
  }
  console.log('');

  const after = getProcessSnapshot();
  const newQQ = Array.from(seen.values()).sort((a, b) => a.pid - b.pid);
  printRows('NEW QQ / QQEX PROCESSES', newQQ);

  const farmCandidates = after.filter(row => {
    const cmd = String(row.cmd || '').toLowerCase();
    return cmd.includes('1112386029')
      || cmd.includes('--loadapp=mini-app')
      || cmd.includes('--loadapp=exapp')
      || String(row.name || '').toLowerCase().includes('qqex');
  });
  printRows('CURRENT MINIAPP CANDIDATES', farmCandidates);

  const rootPids = farmCandidates.map(row => row.pid);
  const tree = getDescendants(after, rootPids).filter(isQQRelated);
  if (tree.length) printRows('MINIAPP DESCENDANT TREE', tree);

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({
    beforeQQCount: beforeQQ.length,
    newQQProcessCount: newQQ.length,
    miniappCandidateCount: farmCandidates.length,
    hasUserDataDir: farmCandidates.some(r => /--user-data-dir=/i.test(r.cmd)),
    hasLoadApp: farmCandidates.some(r => /--loadapp=/i.test(r.cmd)),
    hasFarmAppId: farmCandidates.some(r => r.cmd.includes(FARM_APP_ID)),
  }, null, 2));

  console.log('\n把 NEW QQ / QQEX PROCESSES、CURRENT MINIAPP CANDIDATES 和 SUMMARY 发回来即可。');
  console.log('不要额外发送 Cookie、Code 或登录票据。');
}

main().catch(err => {
  console.error('\n诊断失败:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
