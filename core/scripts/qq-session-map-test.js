const { execFileSync } = require('node:child_process');

const FARM_APP_ID = '1112386029';

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

function maskUin(uin) {
  const s = String(uin || '').trim();
  if (!/^\d{5,12}$/.test(s)) return s || '';
  if (s.length <= 4) return '****';
  return `${s.slice(0, 2)}****${s.slice(-2)}`;
}

function sanitize(text) {
  let value = String(text || '');
  value = value.replace(/((?:code|ticket|token|auth_code|authcode|skey|p_skey|pt4_token|session|cookie)=)[^\s&"']+/gi, '$1<redacted>');
  value = value.replace(/--annotation=uin=(\d{5,12})/gi, (_m, u) => `--annotation=uin=${maskUin(u)}`);
  value = value.replace(/(?<!\d)(\d{8,12})(?!\d)/g, m => m === FARM_APP_ID ? m : maskUin(m));
  value = value.replace(/[A-Za-z0-9_-]{40,}/g, '<long-value-redacted>');
  return value;
}

function getDescendants(rows, rootPid) {
  const out = [];
  const queue = [Number(rootPid)];
  const seen = new Set(queue);
  while (queue.length) {
    const parent = queue.shift();
    for (const row of rows) {
      if (Number(row.ppid) !== parent || seen.has(Number(row.pid))) continue;
      seen.add(Number(row.pid));
      queue.push(Number(row.pid));
      out.push(row);
    }
  }
  return out;
}

function getAncestors(rows, pid) {
  const byPid = new Map(rows.map(r => [Number(r.pid), r]));
  const out = [];
  let cur = byPid.get(Number(pid));
  const seen = new Set();
  while (cur && cur.ppid && !seen.has(cur.ppid)) {
    seen.add(cur.ppid);
    const parent = byPid.get(Number(cur.ppid));
    if (!parent) break;
    out.push(parent);
    cur = parent;
    if (out.length >= 12) break;
  }
  return out;
}

function parseFarmUin(rows) {
  for (const row of rows) {
    const cmd = String(row.cmd || '');
    if (!cmd.includes(`appIdOrLink=${FARM_APP_ID}`)) continue;
    const m = cmd.match(/--annotation=uin=(\d{5,12})/i);
    if (m) return m[1];
  }
  return '';
}

function parseChannel(cmd) {
  const m = String(cmd || '').match(/--pcqq-platform-channel-handle=(\d+)/i);
  return m ? m[1] : '';
}

function isFarmRoot(row) {
  const cmd = String(row.cmd || '');
  return String(row.name || '').toLowerCase() === 'qq.exe'
    && /--loadapp=mini-app/i.test(cmd)
    && /--exApp=QQEXMiniProgram/i.test(cmd);
}

function isMainQQ(row) {
  const name = String(row.name || '').toLowerCase();
  const cmd = String(row.cmd || '');
  return name === 'qq.exe'
    && !/--type=/i.test(cmd)
    && !/--loadapp=/i.test(cmd);
}

function shortRow(row) {
  if (!row) return null;
  return {
    pid: row.pid,
    ppid: row.ppid,
    name: row.name,
    exe: sanitize(row.exe),
    cmd: sanitize(row.cmd),
  };
}

function printRow(prefix, row) {
  if (!row) return;
  console.log(`${prefix} PID=${row.pid} PPID=${row.ppid} NAME=${row.name}`);
  if (row.exe) console.log(`${prefix} EXE=${sanitize(row.exe)}`);
  if (row.cmd) console.log(`${prefix} CMD=${sanitize(row.cmd)}`);
}

function main() {
  if (process.platform !== 'win32') throw new Error('此诊断仅支持 Windows');

  console.log('QQ Farm Session Mapper');
  console.log('用途: 把已经打开的 QQ经典农场实例映射到具体 QQ UIN 和父 QQ 进程。');
  console.log('安全: 不读取 Cookie、不读取 Farm Code，UIN 会脱敏。');
  console.log('请保持至少一个已经选好账号并打开的 QQ经典农场窗口。\n');

  const rows = getProcessSnapshot();
  const byPid = new Map(rows.map(r => [Number(r.pid), r]));
  const roots = rows.filter(isFarmRoot);
  const mainQQs = rows.filter(isMainQQ);

  const mappings = [];
  for (const root of roots) {
    const descendants = getDescendants(rows, root.pid);
    const uin = parseFarmUin(descendants);
    const ancestors = getAncestors(rows, root.pid);
    const directParent = byPid.get(Number(root.ppid)) || null;
    const mainAncestor = ancestors.find(isMainQQ) || null;
    const crash = descendants.find(r => String(r.cmd || '').includes(`appIdOrLink=${FARM_APP_ID}`)) || null;

    console.log('=== FARM SESSION ===');
    console.log(`FarmRoot PID=${root.pid}`);
    console.log(`Farm UIN=${maskUin(uin) || '(未从 crashpad 解析到)'}`);
    console.log(`PlatformChannel=${parseChannel(root.cmd) || '(none)'}`);
    printRow('ROOT', root);
    if (directParent) printRow('PARENT', directParent);
    if (mainAncestor && (!directParent || mainAncestor.pid !== directParent.pid)) printRow('MAINQQ', mainAncestor);
    if (crash) printRow('UIN-SOURCE', crash);
    console.log('ANCESTOR PIDS=' + ancestors.map(r => r.pid).join(' -> '));
    console.log('---');

    mappings.push({
      uin: maskUin(uin),
      farmRootPid: root.pid,
      farmRootParentPid: root.ppid,
      mainQqPid: mainAncestor ? mainAncestor.pid : (directParent && isMainQQ(directParent) ? directParent.pid : 0),
      platformChannel: parseChannel(root.cmd),
      hasUinAnnotation: !!uin,
      directParentIsMainQQ: !!(directParent && isMainQQ(directParent)),
    });
  }

  console.log('\n=== TOP-LEVEL QQ PROCESSES ===');
  for (const qq of mainQQs) {
    const descendants = getDescendants(rows, qq.pid);
    const farmChildren = descendants.filter(isFarmRoot);
    const uins = [...new Set(farmChildren.map(root => parseFarmUin(getDescendants(rows, root.pid))).filter(Boolean))];
    console.log(`PID=${qq.pid} FARM_CHILDREN=${farmChildren.map(r => r.pid).join(',') || '(none)'} FARM_UINS=${uins.map(maskUin).join(',') || '(none)'}`);
    console.log(`CMD=${sanitize(qq.cmd)}`);
    console.log('---');
  }

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({
    farmSessionCount: mappings.length,
    topLevelQqCount: mainQQs.length,
    mappings,
    canMapFarmToUin: mappings.some(m => m.hasUinAnnotation),
    canMapFarmToParentQq: mappings.some(m => m.directParentIsMainQQ || m.mainQqPid > 0),
  }, null, 2));

  console.log('\n把 FARM SESSION、TOP-LEVEL QQ PROCESSES、SUMMARY 发回来即可。');
}

try {
  main();
} catch (err) {
  console.error('\n诊断失败:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
}
