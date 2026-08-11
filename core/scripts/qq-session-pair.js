const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
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
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(parsed && parsed.accounts) ? parsed.accounts : [];
}

function ask(rl, prompt) {
  return new Promise(resolve => rl.question(prompt, answer => resolve(String(answer || '').trim())));
}

function getAccountsList() {
  const data = store.getAccounts();
  return Array.isArray(data && data.accounts) ? data.accounts : [];
}

function ensureLocalMetadataAccount(sourceAccount, uin) {
  const sourceId = String(sourceAccount.id || '').trim();
  const current = getAccountsList();

  // Prefer the same source ID when it already exists locally.
  const sameId = current.find(a => String(a.id || '') === sourceId);
  if (sameId) {
    store.addOrUpdateAccount({
      id: sameId.id,
      name: sourceAccount.name,
      platform: sourceAccount.platform || 'qq',
      uin,
      qq: uin,
      avatar: sourceAccount.avatar,
      username: sourceAccount.username,
    });
    return String(sameId.id);
  }

  // Reruns should reuse the account already created for this QQ instead of duplicating it.
  const sameUin = current.find(a => normalizeUin(a.uin || a.qq) === uin);
  if (sameUin) {
    store.addOrUpdateAccount({
      id: sameUin.id,
      name: sourceAccount.name,
      platform: sourceAccount.platform || 'qq',
      uin,
      qq: uin,
      avatar: sourceAccount.avatar,
      username: sourceAccount.username,
    });
    return String(sameUin.id);
  }

  const beforeIds = new Set(current.map(a => String(a.id || '')));
  const result = store.addOrUpdateAccount({
    name: sourceAccount.name,
    platform: sourceAccount.platform || 'qq',
    uin,
    qq: uin,
    avatar: sourceAccount.avatar,
    username: sourceAccount.username,
  });
  const nextAccounts = Array.isArray(result && result.accounts) ? result.accounts : getAccountsList();
  const created = nextAccounts.find(a => !beforeIds.has(String(a.id || '')) && normalizeUin(a.uin || a.qq) === uin)
    || nextAccounts.find(a => normalizeUin(a.uin || a.qq) === uin);
  if (!created || !created.id) throw new Error(`无法为源账号 ${sourceId || sourceAccount.name} 创建测试元数据账号`);
  return String(created.id);
}

async function main() {
  if (process.platform !== 'win32') throw new Error('此命令仅支持 Windows');

  const sourceArg = process.argv[2] || '';
  const sourceFile = findAccountsFile(sourceArg);
  if (!sourceFile) {
    console.log('用法: pnpm qr:session-pair -- D:\\project2\\farm');
    process.exitCode = 2;
    return;
  }

  const sourceAccounts = readAccounts(sourceFile)
    .filter(a => a && a.id)
    .map(a => ({
      id: String(a.id),
      name: String(a.name || a.id),
      platform: String(a.platform || 'qq'),
      avatar: String(a.avatar || a.avatarUrl || ''),
      username: String(a.username || ''),
    }));

  const sessions = registry.scanRuntimeSessions().filter(s => normalizeUin(s.qqUin));

  console.log('QQ Farm Session Interactive Pairing');
  console.log(`来源账号文件: ${sourceFile}`);
  console.log(`原项目账号数: ${sourceAccounts.length}`);
  console.log(`当前可识别 Windows QQ 农场 Session: ${sessions.length}`);
  console.log('说明: 完整 QQ/UIN 只在本机内存、测试账号元数据和 desktop-sessions.json 中使用，终端只显示脱敏值。');
  console.log('说明: 不读取、不复制原项目 Farm Code，也不会修改原项目 accounts.json。\n');

  if (!sourceAccounts.length) throw new Error('原项目没有账号');
  if (!sessions.length) throw new Error('当前没有可识别的 QQ 农场 Session，请先打开对应账号的 QQ经典农场');

  console.log('=== 原项目账号 ===');
  sourceAccounts.forEach((a, i) => {
    console.log(`[A${i + 1}] sourceAccountId=${a.id} name=${a.name}`);
  });

  console.log('\n=== Windows QQ Sessions ===');
  sessions.forEach((s, i) => {
    console.log(`[S${i + 1}] qq=${maskUin(s.qqUin)} mainQqPid=${s.mainQqPid} farmRootPid=${s.farmRootPid}`);
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const usedSessionIndexes = new Set();
  let paired = 0;

  try {
    for (let i = 0; i < sourceAccounts.length; i++) {
      const account = sourceAccounts[i];
      console.log(`\n为 [A${i + 1}] ${account.name} 选择对应 Windows QQ Session。`);
      console.log('输入 S 序号，例如 1；输入 0 跳过。');

      while (true) {
        const answer = await ask(rl, `A${i + 1} -> S: `);
        if (answer === '0') {
          console.log('已跳过。');
          break;
        }
        const idx = Number.parseInt(answer, 10) - 1;
        if (!Number.isInteger(idx) || idx < 0 || idx >= sessions.length) {
          console.log('无效序号，请重新输入。');
          continue;
        }
        if (usedSessionIndexes.has(idx)) {
          console.log('这个 Session 已经配给另一个账号，请重新选择。');
          continue;
        }

        const session = sessions[idx];
        const uin = normalizeUin(session.qqUin);
        if (!uin) {
          console.log('该 Session 无法识别 UIN，请选择其他 Session。');
          continue;
        }

        const localAccountId = ensureLocalMetadataAccount(account, uin);
        const bound = registry.bindAccount({
          accountId: localAccountId,
          farmRootPid: session.farmRootPid,
          qqUin: uin,
          note: `interactive_pair_source_account:${account.id}`,
        });

        usedSessionIndexes.add(idx);
        paired++;
        console.log(`✅ 已配对 ${account.name} (源ID=${account.id}, 测试ID=${localAccountId}) -> ${maskUin(uin)} (mainQqPid=${bound.mainQqPid}, farmRootPid=${bound.farmRootPid})`);
        break;
      }
    }
  } finally {
    rl.close();
  }

  const status = registry.getStatus();
  console.log('\n=== SAVED BINDINGS ===');
  for (const item of status.bindings) {
    console.log(`accountId=${item.accountId} qq=${maskUin(item.qqUin)} status=${item.status} needsRebind=${item.needsRebind}`);
    console.log(`  mainQqPid=${item.mainQqPid} farmRootPid=${item.farmRootPid} platformChannel=${item.platformChannel || '(none)'}`);
  }

  console.log(`\n完成：本次配对 ${paired} 个。`);
  console.log('以后 QQ 或农场 PID 改变时，Registry 会优先按保存的 QQ/UIN 自动恢复对应 Session。');
}

main().catch(err => {
  console.error('Session pairing 失败:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
