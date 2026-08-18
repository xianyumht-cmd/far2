'use strict';

// P5 live-gate transport only.
// This reuses the already-proven pinned WMPFDebugger checkout as a temporary
// diagnostic transport so FAR2WeChatAgent -> Provider can be tested end-to-end.
// It is NOT the final production capture backend.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');
const WebSocket = require('ws');

const EXPECTED_WMPF_VERSION = 25297;
const EXPECTED_APP_ID = 'wx5306c5978fdb76e4';
const DEBUGGER_COMMIT = '2b90b77fc6f13dd18480cd07d7dd9c052cc26c9d';
const DEBUG_PORT = 9421;
const CDP_PORT = 62000;
const FARM_WINDOW_TITLE = 'QQ经典农场';
const TEMP_ROOT = path.join(os.tmpdir(), 'FAR2-WeChat-CDP');
const DEBUGGER_DIR = path.join(TEMP_ROOT, `WMPFDebugger-${EXPECTED_WMPF_VERSION}`);

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function sanitizeText(value, max = 180) {
  let text = String(value || '');
  text = text.replace(/([?&](?:code|token|ticket|password)=)[^&\s]+/gi, '$1[REDACTED]');
  text = text.replace(/(Bearer\s+)[\w.-]+/gi, '$1[REDACTED]');
  text = text.replace(/\b[A-Za-z0-9_-]{32}\b/g, '[REDACTED_32]');
  return text.slice(0, max);
}

function runPowerShell(command) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(sanitizeText(result.stderr || 'PowerShell command failed'));
  return String(result.stdout || '').trim();
}

function getWmpfVersion() {
  const command = [
    '$versions = @()',
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '(?i)^WeChatAppEx\\.exe$' -and $_.ExecutablePath } | ForEach-Object {",
    "  $m = [regex]::Match([string]$_.ExecutablePath, '(?i)RadiumWMPF[\\\\/](\\d+)[\\\\/]extracted')",
    '  if ($m.Success) { $versions += [int]$m.Groups[1].Value }',
    '}',
    'if ($versions.Count -gt 0) { ($versions | Sort-Object -Unique -Descending | Select-Object -First 1) }',
  ].join('; ');
  const value = Number(runPowerShell(command));
  return Number.isFinite(value) ? value : 0;
}

function getWindowsSessionId() {
  try {
    const out = runPowerShell('(Get-Process -Id $PID).SessionId');
    const value = Number(out);
    return Number.isFinite(value) ? value : -1;
  } catch { return -1; }
}

function isFarmWindowOpen() {
  const escaped = FARM_WINDOW_TITLE.replace(/'/g, "''");
  const command = `(Get-Process -Name WeChatAppEx -ErrorAction SilentlyContinue | Where-Object { [string]$_.MainWindowTitle -eq '${escaped}' } | Measure-Object).Count`;
  return Number(runPowerShell(command)) > 0;
}

function isPortListening(port) {
  try {
    return Number(runPowerShell(`@(Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue).Count`)) > 0;
  } catch { return false; }
}

async function waitPorts(ports, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ports.every(isPortListening)) return true;
    await sleep(400);
  }
  return false;
}

function prompt(message) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(message, answer => { rl.close(); resolve(answer); }));
}

function assertDebuggerReady() {
  if (!fs.existsSync(path.join(DEBUGGER_DIR, '.git'))) throw new Error('Pinned WMPF debugger checkout is missing. Run the earlier P3/P4 gate once.');
  const result = spawnSync('git.exe', ['-C', DEBUGGER_DIR, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (result.status !== 0 || String(result.stdout || '').trim() !== DEBUGGER_COMMIT) {
    throw new Error('Pinned WMPF debugger checkout does not match the proven WMPF 25297 revision.');
  }
  for (const item of [
    path.join(DEBUGGER_DIR, 'node_modules', 'frida'),
    path.join(DEBUGGER_DIR, 'node_modules', 'ts-node', 'dist', 'bin.js'),
    path.join(DEBUGGER_DIR, 'src', 'index.ts'),
  ]) {
    if (!fs.existsSync(item)) throw new Error('Pinned WMPF debugger dependencies are incomplete.');
  }
}

function spawnDebugger() {
  const tsNodeBin = path.join(DEBUGGER_DIR, 'node_modules', 'ts-node', 'dist', 'bin.js');
  const entry = path.join(DEBUGGER_DIR, 'src', 'index.ts');
  const child = spawn(process.execPath, [tsNodeBin, entry, '--debug-port', String(DEBUG_PORT), '--cdp-port', String(CDP_PORT)], {
    cwd: DEBUGGER_DIR,
    windowsHide: true,
    detached: false,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return child;
}

function stopDebugger(child) {
  if (!child) return;
  try { child.kill(); } catch {}
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.contexts = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('CDP WebSocket connect timeout')), 8000);
      ws.once('open', () => { clearTimeout(timer); resolve(); });
      ws.once('error', err => { clearTimeout(timer); reject(err); });
      ws.on('message', data => this.onMessage(data));
      ws.on('close', () => {
        for (const item of this.pending.values()) item.reject(new Error('CDP WebSocket closed'));
        this.pending.clear();
      });
    });
  }

  onMessage(data) {
    let msg;
    try { msg = JSON.parse(Buffer.from(data).toString('utf8')); } catch { return; }
    if (msg && msg.method === 'Runtime.executionContextCreated' && msg.params && msg.params.context) {
      const ctx = msg.params.context;
      this.contexts.set(Number(ctx.id), {
        id: Number(ctx.id),
        origin: String(ctx.origin || ''),
      });
    }
    if (msg && Object.prototype.hasOwnProperty.call(msg, 'id') && this.pending.has(Number(msg.id))) {
      const item = this.pending.get(Number(msg.id));
      this.pending.delete(Number(msg.id));
      clearTimeout(item.timer);
      if (msg.error) item.reject(new Error(sanitizeText(msg.error.message || 'CDP command failed')));
      else item.resolve(msg);
    }
  }

  send(method, params = {}, timeoutMs = 8000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP WebSocket is not open'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, contextId, awaitPromise = false, timeoutMs = 10000) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      contextId,
      returnByValue: true,
      awaitPromise,
      silent: true,
    }, timeoutMs);
    const result = response && response.result && response.result.result;
    return result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : null;
  }

  close() { try { if (this.ws) this.ws.close(); } catch {} }
}

async function capture() {
  let debuggerProcess = null;
  let cdp = null;
  let code = '';
  try {
    if (process.platform !== 'win32') throw new Error('Windows only');
    const wmpfVersion = getWmpfVersion();
    if (wmpfVersion !== EXPECTED_WMPF_VERSION) {
      throw new Error(`Unsupported WMPF version: ${wmpfVersion || 'none'}. Expected ${EXPECTED_WMPF_VERSION}.`);
    }
    assertDebuggerReady();

    if (isFarmWindowOpen()) {
      console.log('QQ Classic Farm is currently open.');
      console.log('Close ONLY the farm mini-program window. Keep desktop WeChat logged in.');
      await prompt('After the farm window is closed, press Enter: ');
      await sleep(700);
      if (isFarmWindowOpen()) throw new Error('Farm window is still open.');
    }
    if (isPortListening(DEBUG_PORT) || isPortListening(CDP_PORT)) throw new Error('WMPF diagnostic ports are already in use.');

    console.log('Starting temporary WMPF transport for the P5 live Agent gate...');
    debuggerProcess = spawnDebugger();
    const ready = await waitPorts([DEBUG_PORT, CDP_PORT], 20000);
    if (!ready || debuggerProcess.exitCode !== null) throw new Error('Temporary WMPF transport did not become ready.');

    console.log('Temporary runtime transport is ready.');
    console.log('Now open QQ Classic Farm from desktop WeChat and wait for the home screen.');
    await prompt('Then return here and press Enter: ');
    await sleep(1800);
    if (!isFarmWindowOpen()) throw new Error('Farm window was not detected after opening.');

    cdp = new CdpClient(`ws://127.0.0.1:${CDP_PORT}`);
    await cdp.connect();
    await cdp.send('Runtime.enable', {}, 8000);
    await sleep(4200);

    const contexts = [...cdp.contexts.values()].sort((a, b) => a.id - b.id).slice(0, 64);
    if (!contexts.length) throw new Error('No CDP execution contexts were reported.');

    const infoExpr = "(() => { const out={hasLogin:false,appId:'',envVersion:'',version:''}; try { const w=globalThis.wx; out.hasLogin=!!(w&&typeof w.login==='function'); if(w&&typeof w.getAccountInfoSync==='function'){ const i=w.getAccountInfoSync(); const m=i&&i.miniProgram?i.miniProgram:{}; out.appId=typeof m.appId==='string'?m.appId:''; out.envVersion=typeof m.envVersion==='string'?m.envVersion:''; out.version=typeof m.version==='string'?m.version:''; } } catch(e) {} return out; })()";
    const targets = [];
    for (const ctx of contexts) {
      let value = null;
      try { value = await cdp.evaluate(infoExpr, ctx.id, false, 6000); } catch {}
      if (value && value.hasLogin && value.appId === EXPECTED_APP_ID) {
        targets.push({ id: ctx.id, version: String(value.version || ''), envVersion: String(value.envVersion || '') });
      }
    }
    if (!targets.length) throw new Error('Exact farm AppId context with wx.login was not found.');
    const selected = targets[0];
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(selected.version)) throw new Error('Farm mini-program version is missing or invalid.');

    const loginExpr = "new Promise((resolve)=>{let done=false;const finish=(v)=>{if(done)return;done=true;resolve(v)};const timer=setTimeout(()=>finish({ok:false,code:'',errMsg:'timeout'}),10000);try{globalThis.wx.login({success:(r)=>{clearTimeout(timer);const c=(r&&typeof r.code==='string')?r.code:'';finish({ok:c.length>0,code:c,errMsg:''})},fail:(e)=>{clearTimeout(timer);finish({ok:false,code:'',errMsg:String(e&&e.errMsg?e.errMsg:'wx.login fail').slice(0,160)})}})}catch(e){clearTimeout(timer);finish({ok:false,code:'',errMsg:String(e&&e.message?e.message:e).slice(0,160)})}})";
    const result = await cdp.evaluate(loginExpr, selected.id, true, 15000);
    if (!result || result.ok !== true || typeof result.code !== 'string' || !result.code) {
      throw new Error(`wx.login failed: ${sanitizeText(result && result.errMsg ? result.errMsg : 'no code')}`);
    }
    code = result.code;

    const payload = {
      type: 'far2_wechat_capture',
      ok: true,
      code,
      platform: 'wx',
      appId: EXPECTED_APP_ID,
      windowsSessionId: getWindowsSessionId(),
      wmpfVersion,
      clientVersion: selected.version,
      gatewayVersion: `${selected.version}_20260723`,
      profileId: '',
      envVersion: selected.envVersion,
    };
    if (!process.send) throw new Error('Capture child IPC channel is unavailable.');
    process.send(payload);
    console.log(`wx.login capture succeeded. Code length: ${code.length}`);
    code = '';
  } finally {
    code = '';
    if (cdp) cdp.close();
    stopDebugger(debuggerProcess);
  }
}

capture().then(() => {
  process.exitCode = 0;
}).catch(err => {
  const reason = sanitizeText(err && err.message ? err.message : err);
  if (process.send) {
    try { process.send({ type: 'far2_wechat_capture', ok: false, reason }); } catch {}
  }
  console.error(`P5 live capture failed: ${reason}`);
  process.exitCode = 1;
});
