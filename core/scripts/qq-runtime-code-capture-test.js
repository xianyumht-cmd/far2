const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, execSync } = require('node:child_process');
const WebSocket = require('ws');
const { CONFIG } = require('../src/config/config');

const APP_ID = '1112386029';
const MARKER = '/*__FAR2_RUNTIME_CODE_CAPTURE__*/';
const MINIAPP_URI = 'tencent://ntqq-open/?&subCmd=miniapp&action=openQQMiniApp&actionParams=%7B%22sourceType%22%3A%22open%22%2C%22appId%22%3A%221112386029%22%2C%22hostScene%22%3A%221246700100%22%7D';
const probeVersion = String(process.argv[2] || '1.13.0.5_20260729').trim();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function mask(value) {
  const text = String(value || '').trim();
  if (!text) return '(empty)';
  if (text.length <= 8) return text;
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function getQqexRoot() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'QQEX');
}

function getMiniAppRoot() {
  return path.join(getQqexRoot(), 'miniapp', 'temps', 'miniapp_src');
}

function findFarmFolders() {
  const root = getMiniAppRoot();
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && new RegExp(`^${APP_ID}_3_.+$`).test(entry.name))
    .map(entry => path.join(root, entry.name));
}

function findGameJs(folder) {
  const direct = [
    path.join(folder, 'game.js'),
    path.join(folder, 'cocos-js', 'assets', 'game.js'),
  ];
  for (const file of direct) {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }

  const queue = [{ dir: folder, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (depth > 2) continue;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === 'game.js') return full;
      if (entry.isDirectory()) queue.push({ dir: full, depth: depth + 1 });
    }
  }
  return '';
}

function buildPayload() {
  return `${MARKER}\n;(function(){\n  var tries=0;\n  function closeSoon(api){\n    setTimeout(function(){\n      try{ if(api&&typeof api.exitMiniProgram==='function') return api.exitMiniProgram(); }catch(e){}\n      try{ if(api&&typeof api.exitMiniApp==='function') return api.exitMiniApp(); }catch(e){}\n    },180);\n  }\n  function run(){\n    tries++;\n    var api=null;\n    try{ if(typeof qq!=='undefined'&&qq&&typeof qq.login==='function') api=qq; }catch(e){}\n    if(!api){ try{ if(typeof wx!=='undefined'&&wx&&typeof wx.login==='function') api=wx; }catch(e){} }\n    if(!api){ if(tries<120) setTimeout(run,250); return; }\n    try{\n      api.login({\n        success:function(res){\n          var code=res&&res.code?String(res.code):'';\n          if(!code) return;\n          try{ if(typeof api.setClipboardData==='function') api.setClipboardData({data:code}); }catch(e){}\n          try{\n            var fsApi=api.getFileSystemManager&&api.getFileSystemManager();\n            var base=api.env&&api.env.USER_DATA_PATH?api.env.USER_DATA_PATH:'';\n            if(fsApi&&base) fsApi.writeFileSync(base+'/_code.txt',code,'utf8');\n          }catch(e){}\n          try{ if(typeof api.showToast==='function') api.showToast({title:'Code captured',icon:'none',duration:800}); }catch(e){}\n          closeSoon(api);\n        },\n        fail:function(){}\n      });\n    }catch(e){}\n  }\n  run();\n})();\n`;
}

function recoverIfNeeded(gameJs) {
  const backup = `${gameJs}.far2-runtime-code-capture.bak`;
  let current = fs.readFileSync(gameJs, 'utf8');
  if (current.includes(MARKER) && fs.existsSync(backup)) {
    current = fs.readFileSync(backup, 'utf8');
    fs.writeFileSync(gameJs, current, 'utf8');
  }
  return { original: current, backup };
}

function patchGameFiles() {
  const folders = findFarmFolders();
  if (!folders.length) {
    throw new Error(`未找到 QQ 农场缓存目录。请先在 Windows QQ 里手动打开一次“QQ经典农场”。\n期望目录: ${getMiniAppRoot()}`);
  }

  const patched = [];
  for (const folder of folders) {
    const gameJs = findGameJs(folder);
    if (!gameJs) continue;
    const { original, backup } = recoverIfNeeded(gameJs);
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, 'utf8');
    fs.writeFileSync(gameJs, buildPayload() + original, 'utf8');
    patched.push({ gameJs, original, backup });
  }

  if (!patched.length) throw new Error('找到 QQ 农场缓存，但未找到 game.js。');
  return patched;
}

function restoreGameFiles(patched) {
  for (const item of patched || []) {
    try {
      fs.writeFileSync(item.gameJs, item.original, 'utf8');
      if (fs.existsSync(item.backup)) fs.unlinkSync(item.backup);
    } catch (err) {
      console.warn(`恢复失败: ${item.gameJs} -> ${err.message}`);
    }
  }
}

function listCodeFiles(root = getQqexRoot()) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name === '_code.txt') out.push(full);
    }
  }
  return out;
}

function clearOldCodeFiles() {
  for (const file of listCodeFiles()) {
    try { fs.unlinkSync(file); } catch {}
  }
  try {
    execFileSync('cmd.exe', ['/c', 'echo.|clip'], { windowsHide: true, timeout: 2000 });
  } catch {}
}

function readClipboard() {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', 'Get-Clipboard -Raw',
    ], { windowsHide: true, timeout: 3000, maxBuffer: 1024 * 1024 });
    return out.toString('utf8').trim();
  } catch {
    return '';
  }
}

function isLikelyCode(value) {
  const code = String(value || '').trim();
  return code.length >= 6 && code.length <= 256 && /^[A-Za-z0-9_-]+$/.test(code) && !/^-\d+$/.test(code);
}

async function waitForRuntimeCode(startedAt, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const file of listCodeFiles()) {
      try {
        const stat = fs.statSync(file);
        if (stat.mtimeMs < startedAt - 1000) continue;
        const code = fs.readFileSync(file, 'utf8').trim();
        if (isLikelyCode(code)) return { code, source: file, capturedAt: stat.mtimeMs };
      } catch {}
    }

    const clipboard = readClipboard();
    if (isLikelyCode(clipboard)) return { code: clipboard, source: 'clipboard', capturedAt: Date.now() };
    process.stdout.write('.');
    await sleep(500);
  }
  return null;
}

function openFarmMiniApp() {
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

async function probeFarmHandshake(code) {
  const serverUrl = String(CONFIG.serverUrl || 'wss://gate-obt.nqf.qq.com/prod/ws');
  const platform = String(CONFIG.platform || 'qq');
  const osName = String(CONFIG.os || 'iOS');
  const url = `${serverUrl}?platform=${encodeURIComponent(platform)}&os=${encodeURIComponent(osName)}&ver=${encodeURIComponent(probeVersion)}&code=${encodeURIComponent(code)}&openID=`;

  return new Promise(resolve => {
    let done = false;
    let ws;
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (ws) { ws.removeAllListeners(); ws.close(); } } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), 10000);
    try {
      ws = new WebSocket(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132.0.0.0 Safari/537.36',
          Origin: 'https://gate-obt.nqf.qq.com',
        },
      });
      ws.once('open', () => finish({ ok: true, reason: 'ws_open' }));
      ws.once('unexpected-response', (_req, res) => finish({ ok: false, reason: `http_${res && res.statusCode ? res.statusCode : 'unknown'}` }));
      ws.once('error', err => finish({ ok: false, reason: String(err && err.message ? err.message : err) }));
    } catch (err) {
      finish({ ok: false, reason: String(err && err.message ? err.message : err) });
    }
  });
}

async function main() {
  console.log('QQ Farm Windows Runtime Code Capture Tester');
  console.log(`QQEX: ${getQqexRoot()}`);
  console.log(`Farm WS 探测版本: ${probeVersion}`);
  console.log('用途: 从 Windows QQ 小程序自己的 qq.login() 获取 fresh Farm Code。');
  console.log('说明: 会临时修改本地农场 game.js，结束时自动恢复；不会写入 far2 账号。');

  if (process.platform !== 'win32') throw new Error('当前测试器仅支持 Windows。');

  clearOldCodeFiles();
  let patched = [];
  try {
    patched = patchGameFiles();
    console.log(`已临时注入 ${patched.length} 个农场 game.js:`);
    for (const item of patched) console.log(`- ${item.gameJs}`);

    const startedAt = Date.now();
    const opened = openFarmMiniApp();
    console.log(opened ? '已请求 Windows QQ 打开 QQ经典农场。' : '自动打开失败，请现在手动打开 QQ经典农场。');
    console.log('等待 qq.login() 返回 Code...');

    const captured = await waitForRuntimeCode(startedAt);
    console.log('');
    if (!captured) {
      console.log('❌ 90 秒内没有捕获到 Code。');
      console.log('如果 QQ 农场没有被真正打开，先手动打开一次后再重试。');
      process.exitCode = 2;
      return;
    }

    console.log(`✅ 捕获到运行时 Code: ${mask(captured.code)}`);
    console.log(`来源: ${captured.source === 'clipboard' ? 'clipboard' : '_code.txt'}`);
    const probe = await probeFarmHandshake(captured.code);
    console.log(`Farm WS 探测: ${probe.ok ? '通过' : '失败'} (${probe.reason})`);

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
      ok: probe.ok,
      captured: true,
      source: captured.source === 'clipboard' ? 'clipboard' : '_code.txt',
      reason: probe.reason,
      code: mask(captured.code),
    }, null, 2));

    if (probe.ok) {
      console.log('\n✅ 这条线路成立：Windows QQ 运行时可以自动生成可用 Farm Code。');
      console.log('下一步即可接入 CodeManager：定时刷新 + HTTP 400/Kickout 立即刷新 + 回写后台账号。');
    }
  } finally {
    restoreGameFiles(patched);
    if (patched.length) console.log('已恢复 QQ 农场 game.js 原文件。');
  }
}

main().catch(err => {
  console.error('\n测试失败:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
