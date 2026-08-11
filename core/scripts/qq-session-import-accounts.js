const fs = require('node:fs');
const path = require('node:path');
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

function findAccountsFile(inputPath) {
  const raw = String(inputPath || '').trim();
  if (!raw) return '';
  const resolved = path.resolve(raw);
  const candidates = [
    resolved,
    path.join(resolved, 'core', 'data', 'accounts.json'),
    path.join(resolved, 'data', 'accounts.json'),
    path.join(resolved, 'accounts.json'),
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return '';
}

function readAccounts(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed && parsed.accounts) ? parsed.accounts : [];
}

function safeMetadata(account) {
  const uin = normalizeUin(account && (account.uin || account.qq));
  return {
    id: String(account && account.id || '').trim(),
    name: String(account && account.name || '').trim(),
    platform: String(account && account.platform || 'qq').trim() || 'qq',
    uin,
    qq: uin,
    avatar: String(account && (account.avatar || account.avatarUrl) || '').trim(),
    username: String(account && account.username || '').trim(),
  };
}

function main() {
  if (process.platform !== 'win32') throw new Error('此命令仅支持 Windows');
  const sourceArg = process.argv[2] || process.argv[3] || '';
  const file = findAccountsFile(sourceArg);
  if (!file) {
    console.log('用法: pnpm qr:session-import -- D:\\project2\\farm');
    console.log('也可以直接传原项目 accounts.json 路径。');
    process.exitCode = 2;
    return;
  }

  const sourceAccounts = readAccounts(file);
  console.log('QQ Farm Account Metadata Importer');
  console.log(`来源: ${file}`);
  console.log(`发现原账号: ${sourceAccounts.length} 个`);
  console.log('安全: 只导入 id/name/platform/uin/qq/avatar/username；不会读取、复制或打印 Farm Code。\n');

  let imported = 0;
  let skipped = 0;
  for (const src of sourceAccounts) {
    const meta = safeMetadata(src);
    if (!meta.id) {
      skipped++;
      continue;
    }
    if (!meta.uin) {
      console.log(`⚠️ accountId=${meta.id} name=${meta.name || meta.id} qq=(unknown) 跳过：原账号没有 uin/qq`);
      skipped++;
      continue;
    }
    store.addOrUpdateAccount(meta);
    console.log(`✅ 导入 accountId=${meta.id} name=${meta.name || meta.id} qq=${maskUin(meta.uin)}`);
    imported++;
  }

  const sessions = registry.scanRuntimeSessions();
  console.log(`\n当前运行中 QQ 农场 Session: ${sessions.length} 个`);
  const byUin = new Map();
  for (const session of sessions) {
    const uin = normalizeUin(session.qqUin);
    if (!uin) continue;
    if (!byUin.has(uin)) byUin.set(uin, []);
    byUin.get(uin).push(session);
  }

  let bound = 0;
  const current = store.getAccounts();
  for (const account of Array.isArray(current.accounts) ? current.accounts : []) {
    const uin = normalizeUin(account.uin || account.qq);
    const matches = byUin.get(uin) || [];
    if (!uin || matches.length !== 1) continue;
    const session = matches[0];
    const result = registry.bindAccount({
      accountId: String(account.id || ''),
      farmRootPid: session.farmRootPid,
      qqUin: uin,
      note: 'imported_metadata_auto_bind',
    });
    console.log(`🔗 绑定 accountId=${result.accountId} qq=${maskUin(result.qqUin)} mainQqPid=${result.mainQqPid} farmRootPid=${result.farmRootPid}`);
    bound++;
  }

  console.log('\n=== RESULT ===');
  console.log(JSON.stringify({
    sourceAccountCount: sourceAccounts.length,
    imported,
    skipped,
    runtimeSessionCount: sessions.length,
    bound,
  }, null, 2));
  console.log('\n注意：本命令不会导入旧 Farm Code，因此 far2-test 仍只是 Session/绑定测试环境。');
}

try {
  main();
} catch (err) {
  console.error('Session metadata import 失败:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
}
