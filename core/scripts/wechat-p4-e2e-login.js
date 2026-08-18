'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');

const WebSocket = require('ws');
const Long = require('long');
const { loadProto, types } = require('../src/utils/proto');
const cryptoWasm = require('../src/utils/crypto-wasm');

const EXPECTED_WMPF_VERSION = 25297;
const EXPECTED_MINI_APP_ID = 'wx5306c5978fdb76e4';
const DEBUGGER_COMMIT = '2b90b77fc6f13dd18480cd07d7dd9c052cc26c9d';
const DEBUG_PORT = 9421;
const CDP_PORT = 62000;
const SERVER_URL = 'wss://gate-obt.nqf.qq.com/prod/ws';
const FARM_WINDOW_TITLE = 'QQ经典农场';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13)';
const ORIGIN = 'https://gate-obt.nqf.qq.com';
const TEMP_ROOT = path.join(os.tmpdir(), 'FAR2-WeChat-CDP');
const REPORT_ROOT = path.join(os.tmpdir(), 'FAR2-WeChat-Probe');
const DEBUGGER_DIR = path.join(TEMP_ROOT, `WMPFDebugger-${EXPECTED_WMPF_VERSION}`);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeText(value, max = 180) {
  let text = String(value || '');
  text = text.replace(/([?&](?:code|token|ticket|password)=)[^&\s]+/gi, '$1[REDACTED]');
  text = text.replace(/(Bearer\s+)[\w.-]+/gi, '$1[REDACTED]');
  text = text.replace(/\b[A-Za-z0-9_-]{32}\b/g, '[REDACTED_32]');
  return text.slice(0, max);
}

function timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function runPowerShell(command) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(sanitizeText(result.stderr || 'PowerShell command failed'));
  return String(result.stdout || '').trim();
}

function getWmpfVersion() {
  const command = [
    "$versions = @()",
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '(?i)^WeChatAppEx\\.exe$' -and $_.ExecutablePath } | ForEach-Object {",
    "  $m = [regex]::Match([string]$_.ExecutablePath, '(?i)RadiumWMPF[\\\\/](\\d+)[\\\\/]extracted')",
    "  if ($m.Success) { $versions += [int]$m.Groups[1].Value }",
    "}",
    "if ($versions.Count -gt 0) { ($versions | Sort-Object -Unique -Descending | Select-Object -First 1) }",
  ].join('; ');
  const out = runPowerShell(command);
  const n = Number(out);
  return Number.isFinite(n) ? n : 0;
}

function isFarmWindowOpen() {
  const escaped = FARM_WINDOW_TITLE.replace(/'/g, "''");
  const command = `(Get-Process -Name WeChatAppEx -ErrorAction SilentlyContinue | Where-Object { [string]$_.MainWindowTitle -eq '${escaped}' } | Measure-Object).Count`;
  return Number(runPowerShell(command)) > 0;
}

function findFilesRecursive(root, name, maxDepth = 5) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) out.push(full);
      if (entry.isDirectory() && depth < maxDepth) queue.push({ dir: full, depth: depth + 1 });
    }
  }
  return out;
}

function findNode22() {
  const currentMajor = Number(String(process.versions.node || '0').split('.')[0]);
  if (currentMajor >= 22) return process.execPath;
  const candidates = findFilesRecursive(path.join(TEMP_ROOT, 'node22'), 'node.exe', 4);
  for (const file of candidates) {
    const result = spawnSync(file, ['-p', 'process.versions.node'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    const major = Number(String(result.stdout || '').trim().split('.')[0]);
    if (result.status === 0 && major >= 22) return file;
  }
  throw new Error('Node.js 22+ was not found. Run the P3 CDP probe first.');
}

function assertDebuggerReady() {
  if (!fs.existsSync(path.join(DEBUGGER_DIR, '.git'))) {
    throw new Error('Pinned WMPFDebugger checkout is missing. Run the P3 CDP probe first.');
  }
  const result = spawnSync('git.exe', ['-C', DEBUGGER_DIR, 'rev-parse', 'HEAD'], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  if (result.status !== 0) throw new Error('git.exe is required to verify the pinned debugger checkout.');
  const head = String(result.stdout || '').trim();
  if (head !== DEBUGGER_COMMIT) {
    throw new Error('WMPFDebugger checkout is not at the pinned 25297 commit. Run P3 again.');
  }
  const required = [
    path.join(DEBUGGER_DIR, 'node_modules', 'frida'),
    path.join(DEBUGGER_DIR, 'node_modules', 'ts-node', 'dist', 'bin.js'),
    path.join(DEBUGGER_DIR, 'src', 'index.ts'),
  ];
  for (const item of required) {
    if (!fs.existsSync(item)) throw new Error('P3 debugger dependencies are incomplete. Run P3 again.');
  }
}

function isPortListening(port) {
  try {
    const command = `@(Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue).Count`;
    return Number(runPowerShell(command)) > 0;
  } catch {
    return false;
  }
}

async function waitPorts(ports, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const states = ports.map(isPortListening);
    if (states.every(Boolean)) return true;
    await sleep(500);
  }
  return false;
}

function prompt(message) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(message, answer => {
    rl.close();
    resolve(answer);
  }));
}

function spawnDebugger(nodePath) {
  const tsNodeBin = path.join(DEBUGGER_DIR, 'node_modules', 'ts-node', 'dist', 'bin.js');
  const entry = path.join(DEBUGGER_DIR, 'src', 'index.ts');
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  const stamp = timestamp();
  const stdoutPath = path.join(TEMP_ROOT, `wmpf-debugger-p4-${stamp}.out.log`);
  const stderrPath = path.join(TEMP_ROOT, `wmpf-debugger-p4-${stamp}.err.log`);
  const stdout = fs.openSync(stdoutPath, 'a');
  const stderr = fs.openSync(stderrPath, 'a');
  const child = spawn(nodePath, [tsNodeBin, entry, '--debug-port', String(DEBUG_PORT), '--cdp-port', String(CDP_PORT)], {
    cwd: DEBUGGER_DIR,
    windowsHide: true,
    detached: false,
    stdio: ['ignore', stdout, stderr],
  });
  child.__far2Handles = [stdout, stderr];
  child.__far2Logs = { stdoutPath, stderrPath };
  return child;
}

function stopDebugger(child) {
  if (!child) return;
  try { child.kill(); } catch {}
  for (const fd of child.__far2Handles || []) {
    try { fs.closeSync(fd); } catch {}
  }
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
      const timeout = setTimeout(() => reject(new Error('CDP WebSocket connect timeout')), 8000);
      ws.once('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      ws.once('error', err => {
        clearTimeout(timeout);
        reject(err);
      });
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
        name: String(ctx.name || ''),
        origin: String(ctx.origin || ''),
      });
    }
    if (msg && msg.id && this.pending.has(Number(msg.id))) {
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

  close() {
    if (!this.ws) return;
    try { this.ws.close(); } catch {}
  }
}

function toLong(value) {
  return Long.fromNumber(Number(value) || 0);
}

async function buildLoginFrame(clientVersion) {
  await loadProto();
  const loginBody = types.LoginRequest.encode(types.LoginRequest.create({
    sharer_id: toLong(0),
    sharer_open_id: '',
    device_info: {
      client_version: clientVersion,
      sys_software: 'iOS 26.2.1',
      network: 'wifi',
      memory: '7672',
      device_id: 'iPhone X<iPhone18,3>',
    },
    share_cfg_id: toLong(0),
    scene_id: '1256',
    report_data: {
      callback: '',
      cd_extend_info: '',
      click_id: '',
      clue_token: '',
      minigame_channel: 'other',
      minigame_platid: 2,
      req_id: '',
      trackid: '',
    },
  })).finish();
  const encrypted = await cryptoWasm.encryptBuffer(loginBody);
  return types.GateMessage.encode(types.GateMessage.create({
    meta: {
      service_name: 'gamepb.userpb.UserService',
      method_name: 'Login',
      message_type: 1,
      client_seq: toLong(1),
      server_seq: toLong(0),
    },
    body: encrypted,
  })).finish();
}

async function probeGatewayLogin(code, clientVersion) {
  const result = {
    platform: 'wx',
    os: 'iOS',
    clientVersion,
    connected: false,
    loginRequestSent: false,
    responseReceived: false,
    errorCode: null,
    errorMessage: '',
    loginReplyDecoded: false,
    basicPresent: false,
    gidPresent: false,
    level: 0,
    gatePassed: false,
  };

  const frame = await buildLoginFrame(clientVersion);
  const url = new URL(SERVER_URL);
  url.searchParams.set('platform', 'wx');
  url.searchParams.set('os', 'iOS');
  url.searchParams.set('ver', clientVersion);
  url.searchParams.set('code', code);
  url.searchParams.set('openID', '');

  let ws;
  try {
    ws = new WebSocket(url.toString(), {
      headers: {
        'User-Agent': USER_AGENT,
        Origin: ORIGIN,
      },
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Gateway connect timeout')), 12000);
      ws.once('open', () => {
        clearTimeout(timer);
        result.connected = true;
        try {
          ws.send(frame);
          result.loginRequestSent = true;
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      ws.once('unexpected-response', (_req, response) => {
        clearTimeout(timer);
        result.errorCode = Number(response && response.statusCode) || 0;
        result.errorMessage = `gateway_http_${result.errorCode}`;
        reject(new Error(result.errorMessage));
      });
      ws.once('error', err => {
        if (!result.connected) {
          clearTimeout(timer);
          reject(err);
        }
      });
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Gateway Login response timeout')), 15000);
      const onMessage = data => {
        let msg;
        try { msg = types.GateMessage.decode(Buffer.isBuffer(data) ? data : Buffer.from(data)); }
        catch { return; }
        const meta = msg && msg.meta;
        if (!meta) return;
        const clientSeq = Number(meta.client_seq && meta.client_seq.toString ? meta.client_seq.toString() : meta.client_seq) || 0;
        if (Number(meta.message_type) !== 2 || clientSeq !== 1) return;
        clearTimeout(timer);
        ws.off('message', onMessage);
        result.responseReceived = true;
        result.errorCode = Number(meta.error_code && meta.error_code.toString ? meta.error_code.toString() : meta.error_code) || 0;
        result.errorMessage = result.errorCode === 0 ? '' : sanitizeText(meta.error_message || `gateway_error_${result.errorCode}`);
        if (result.errorCode !== 0) {
          resolve();
          return;
        }
        try {
          const reply = types.LoginReply.decode(msg.body);
          result.loginReplyDecoded = true;
          result.basicPresent = !!(reply && reply.basic);
          if (reply && reply.basic) {
            const gid = Number(reply.basic.gid && reply.basic.gid.toString ? reply.basic.gid.toString() : reply.basic.gid) || 0;
            result.gidPresent = gid > 0;
            result.level = Number(reply.basic.level) || 0;
          }
          result.gatePassed = result.loginReplyDecoded && result.basicPresent && result.gidPresent;
        } catch (err) {
          result.errorMessage = `login_reply_decode_failed:${sanitizeText(err.message || err)}`;
        }
        resolve();
      };
      ws.on('message', onMessage);
      ws.once('close', () => {
        if (!result.responseReceived) {
          clearTimeout(timer);
          reject(new Error('Gateway closed before Login response'));
        }
      });
    });
  } catch (err) {
    if (!result.errorMessage) result.errorMessage = sanitizeText(err && err.message ? err.message : err);
  } finally {
    if (ws) {
      try { ws.removeAllListeners(); } catch {}
      try { ws.close(); } catch {}
      try { ws.terminate(); } catch {}
    }
  }
  return result;
}

function writeReport(report) {
  fs.mkdirSync(REPORT_ROOT, { recursive: true });
  const file = path.join(REPORT_ROOT, `wechat-farm-p4-e2e-${timestamp()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
  return file;
}

async function main() {
  let debuggerProcess = null;
  let cdp = null;
  let loginCode = '';
  let reportPath = '';
  try {
    console.log('');
    console.log('FAR2 WeChat Farm P4 E2E Login Gate');
    console.log('==================================');
    console.log('This probe calls wx.login once in the exact farm AppId context,');
    console.log('then immediately tests ONE FAR2 gateway Login with platform=wx.');
    console.log('No farm automation, heartbeat, post-login reads, or writes are started.');
    console.log('The raw wx.login Code is never printed or written to the report.');
    console.log('');

    if (process.platform !== 'win32') throw new Error('P4 probe only supports Windows.');
    const wmpfVersion = getWmpfVersion();
    if (!wmpfVersion) throw new Error('No running WeChat WMPF runtime was found.');
    if (wmpfVersion !== EXPECTED_WMPF_VERSION) {
      throw new Error(`Unsupported WMPF version: ${wmpfVersion}. Expected ${EXPECTED_WMPF_VERSION}.`);
    }
    assertDebuggerReady();
    const node22 = findNode22();
    const nodeVersion = String(spawnSync(node22, ['-p', 'process.versions.node'], { encoding: 'utf8', windowsHide: true }).stdout || '').trim();

    if (isFarmWindowOpen()) {
      console.log('QQ Classic Farm is currently open.');
      console.log('Close ONLY the farm mini-program window. Keep desktop WeChat logged in.');
      await prompt('After the farm window is closed, press Enter: ');
      await sleep(700);
      if (isFarmWindowOpen()) throw new Error('Farm window is still open.');
    }

    if (isPortListening(DEBUG_PORT)) throw new Error(`Local port ${DEBUG_PORT} is already in use.`);
    if (isPortListening(CDP_PORT)) throw new Error(`Local port ${CDP_PORT} is already in use.`);

    console.log('Starting isolated WMPF CDP bridge...');
    debuggerProcess = spawnDebugger(node22);
    const ready = await waitPorts([DEBUG_PORT, CDP_PORT], 20000);
    if (!ready || debuggerProcess.exitCode !== null) {
      const logs = debuggerProcess && debuggerProcess.__far2Logs ? debuggerProcess.__far2Logs : {};
      throw new Error(`WMPF CDP bridge did not become ready. Logs: ${sanitizeText(logs.stderrPath || '')}`);
    }

    console.log('');
    console.log('CDP bridge is ready.');
    console.log('Now open QQ Classic Farm from desktop WeChat and wait for the home screen.');
    await prompt('Then return here and press Enter: ');
    await sleep(1800);
    if (!isFarmWindowOpen()) throw new Error('Farm window was not detected after opening.');

    cdp = new CdpClient(`ws://127.0.0.1:${CDP_PORT}`);
    await cdp.connect();
    await cdp.send('Runtime.enable', {}, 8000);
    await sleep(4500);
    const contexts = [...cdp.contexts.values()].sort((a, b) => a.id - b.id).slice(0, 64);
    if (!contexts.length) throw new Error('No CDP Runtime execution contexts were reported.');

    const accountInfoExpr = "(() => { const out={hasWx:false,hasLogin:false,hasAccountInfo:false,appId:'',envVersion:'',version:'',error:''}; try { out.hasWx=(typeof globalThis.wx==='object'&&globalThis.wx!==null); out.hasLogin=(out.hasWx&&typeof globalThis.wx.login==='function'); out.hasAccountInfo=(out.hasWx&&typeof globalThis.wx.getAccountInfoSync==='function'); if(out.hasAccountInfo){ const i=globalThis.wx.getAccountInfoSync(); const m=(i&&i.miniProgram)?i.miniProgram:{}; out.appId=(typeof m.appId==='string'?m.appId:''); out.envVersion=(typeof m.envVersion==='string'?m.envVersion:''); out.version=(typeof m.version==='string'?m.version:''); } } catch(e) { out.error=String(e&&e.message?e.message:e).slice(0,160); } return out; })()";
    const contextRows = [];
    for (const ctx of contexts) {
      let value = null;
      try { value = await cdp.evaluate(accountInfoExpr, ctx.id, false, 6000); } catch {}
      contextRows.push({
        contextId: ctx.id,
        origin: ctx.origin,
        evaluationOk: !!value,
        hasWx: !!(value && value.hasWx),
        hasWxLogin: !!(value && value.hasLogin),
        hasAccountInfo: !!(value && value.hasAccountInfo),
        appId: value && typeof value.appId === 'string' ? value.appId : '',
        envVersion: value && typeof value.envVersion === 'string' ? value.envVersion : '',
        version: value && typeof value.version === 'string' ? value.version : '',
        error: value && value.error ? sanitizeText(value.error) : '',
      });
    }

    const targets = contextRows.filter(row => row.hasWxLogin && row.appId === EXPECTED_MINI_APP_ID).sort((a, b) => a.contextId - b.contextId);
    if (!targets.length) throw new Error('Exact farm AppId context with wx.login was not found.');
    const versions = [...new Set(targets.map(row => row.version).filter(Boolean))];
    if (versions.length !== 1 || !/^\d+\.\d+\.\d+\.\d+(?:_[A-Za-z0-9.-]+)?$/.test(versions[0])) {
      throw new Error('Farm mini-program version is missing or inconsistent across target contexts.');
    }
    const miniAppVersion = versions[0];
    const selected = targets[0];

    const loginExpr = "new Promise((resolve)=>{let done=false;const finish=(v)=>{if(done)return;done=true;resolve(v)};const timer=setTimeout(()=>finish({ok:false,code:'',errMsg:'timeout'}),10000);try{globalThis.wx.login({success:(r)=>{clearTimeout(timer);const c=(r&&typeof r.code==='string')?r.code:'';finish({ok:c.length>0,code:c,errMsg:(r&&typeof r.errMsg==='string')?r.errMsg:''})},fail:(e)=>{clearTimeout(timer);finish({ok:false,code:'',errMsg:String(e&&e.errMsg?e.errMsg:'wx.login fail').slice(0,200)})}})}catch(e){clearTimeout(timer);finish({ok:false,code:'',errMsg:String(e&&e.message?e.message:e).slice(0,200)})}})";
    const loginValue = await cdp.evaluate(loginExpr, selected.contextId, true, 15000);
    if (!loginValue || loginValue.ok !== true || typeof loginValue.code !== 'string' || !loginValue.code) {
      throw new Error(`wx.login failed: ${sanitizeText(loginValue && loginValue.errMsg ? loginValue.errMsg : 'no code')}`);
    }
    loginCode = loginValue.code;
    const codeLength = loginCode.length;

    console.log('wx.login succeeded in the exact farm context.');
    console.log(`Code length: ${codeLength}`);
    console.log(`Farm mini-program version: ${miniAppVersion}`);
    console.log('Testing one FAR2 gateway Login with platform=wx...');

    const gateway = await probeGatewayLogin(loginCode, miniAppVersion);
    loginCode = '';

    const report = {
      version: 1,
      phase: 'wechat-farm-p4-e2e-login-gate',
      generatedAt: new Date().toISOString(),
      safety: {
        wxLoginCalled: true,
        rawLoginCodePersisted: false,
        rawLoginCodePrinted: false,
        rawLoginCodeInCommandLine: false,
        tokenOrCookieCaptured: false,
        chatDatabaseRead: false,
        networkPayloadCaptured: false,
        farmAutomationStarted: false,
        heartbeatStarted: false,
        postLoginFarmReadStarted: false,
        farmWriteStarted: false,
        gatewayLoginAttempts: 1,
      },
      environment: {
        wmpfVersion,
        nodeVersion,
        debuggerCommit: DEBUGGER_COMMIT,
        expectedMiniAppId: EXPECTED_MINI_APP_ID,
      },
      app: {
        executionContextCount: contextRows.length,
        targetAppContextCount: targets.length,
        selectedContextId: selected.contextId,
        envVersion: selected.envVersion,
        version: miniAppVersion,
        wxLoginSuccess: true,
        codeLength,
      },
      gateway,
      summary: {
        wxLoginSuccess: true,
        gatewayConnected: gateway.connected,
        gatewayResponseReceived: gateway.responseReceived,
        loginReplyDecoded: gateway.loginReplyDecoded,
        basicPresent: gateway.basicPresent,
        gidPresent: gateway.gidPresent,
        gatePassed: gateway.gatePassed,
      },
      contexts: contextRows.map(row => ({
        contextId: row.contextId,
        origin: row.origin,
        evaluationOk: row.evaluationOk,
        hasWx: row.hasWx,
        hasWxLogin: row.hasWxLogin,
        hasAccountInfo: row.hasAccountInfo,
        appId: row.appId === EXPECTED_MINI_APP_ID ? EXPECTED_MINI_APP_ID : (row.appId ? '[OTHER_APP]' : ''),
        envVersion: row.appId === EXPECTED_MINI_APP_ID ? row.envVersion : '',
        version: row.appId === EXPECTED_MINI_APP_ID ? row.version : '',
        error: row.error,
      })),
    };

    reportPath = writeReport(report);
    console.log('');
    console.log('P4 E2E capture completed.');
    console.log(`Gateway connected: ${gateway.connected}`);
    console.log(`Gateway response: ${gateway.responseReceived}`);
    console.log(`Login reply decoded: ${gateway.loginReplyDecoded}`);
    console.log(`P4 Gate passed: ${gateway.gatePassed}`);
    if (!gateway.gatePassed && gateway.errorCode !== null) console.log(`Gateway error code: ${gateway.errorCode}`);
    if (!gateway.gatePassed && gateway.errorMessage) console.log(`Gateway error: ${gateway.errorMessage}`);
    console.log('');
    console.log('Report path:');
    console.log(reportPath);
    process.exitCode = gateway.gatePassed ? 0 : 2;
  } catch (err) {
    loginCode = '';
    console.error('');
    console.error('P4 E2E probe failed.');
    console.error(sanitizeText(err && err.message ? err.message : err));
    process.exitCode = 1;
  } finally {
    loginCode = '';
    if (cdp) cdp.close();
    stopDebugger(debuggerProcess);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(sanitizeText(err && err.message ? err.message : err));
    process.exitCode = 1;
  });
}

module.exports = {
  sanitizeText,
  probeGatewayLogin,
};
