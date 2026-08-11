const store = require('../src/models/store');

const VALID_MODES = new Set(['windows_session']);

function normalizeAccountId(value) {
  return String(value || '').trim();
}

function getAccounts() {
  const data = store.getAccounts();
  return Array.isArray(data && data.accounts) ? data.accounts : [];
}

function maskUin(value) {
  const text = String(value || '').trim();
  if (!/^\d{5,12}$/.test(text)) return '(unknown)';
  if (text.length <= 4) return '****';
  return `${text.slice(0, 2)}****${text.slice(-2)}`;
}

function printAccount(account) {
  const id = String(account.id || '');
  const uin = String(account.uin || account.qq || '');
  const enabled = account.codeRefreshEnabled === true;
  const mode = String(account.codeRefreshMode || '(none)');
  console.log(`accountId=${id} name=${account.name || id} qq=${maskUin(uin)} enabled=${enabled} mode=${mode}`);
}

function main() {
  const action = String(process.argv[2] || 'status').trim().toLowerCase();
  const ids = process.argv.slice(3).map(normalizeAccountId).filter(Boolean);
  const accounts = getAccounts();

  console.log('QQ Farm CodeManager Account Config');
  console.log('说明: 只修改账号级 codeRefreshEnabled/codeRefreshMode；不会抓 Code，不会操作 QQ，不会启用全局自动刷新。\n');

  if (action === 'status') {
    console.log('=== ACCOUNTS ===');
    accounts.forEach(printAccount);
    return;
  }

  if (!['enable', 'disable'].includes(action)) {
    console.log('用法:');
    console.log('  pnpm qr:code-manager-config -- status');
    console.log('  pnpm qr:code-manager-config -- enable 1 2');
    console.log('  pnpm qr:code-manager-config -- disable 1');
    process.exitCode = 2;
    return;
  }

  const targets = ids.length
    ? accounts.filter(a => ids.includes(String(a.id || '')))
    : accounts;

  if (!targets.length) {
    throw new Error('没有匹配到账号');
  }

  const enabled = action === 'enable';
  const mode = enabled ? 'windows_session' : '';
  if (enabled && !VALID_MODES.has(mode)) throw new Error(`unsupported mode: ${mode}`);

  for (const account of targets) {
    store.addOrUpdateAccount({
      id: String(account.id || ''),
      codeRefreshEnabled: enabled,
      codeRefreshMode: mode,
      codeRefreshConfiguredAt: Date.now(),
    });
  }

  console.log(`=== UPDATED (${action}) ===`);
  const updated = getAccounts();
  for (const account of updated) {
    if (targets.some(t => String(t.id || '') === String(account.id || ''))) {
      printAccount(account);
    }
  }

  console.log('\n注意: 这只是账号级配置。FARM_CODE_AUTO_REFRESH 未设置为 1 时，CodeManager 不会执行刷新。');
}

try {
  main();
} catch (err) {
  console.error('CodeManager account config 失败:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
}
