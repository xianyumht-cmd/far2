'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');
const WebSocket = require('ws');

const EXPECTED_WMPF_VERSION = 25297;
const DEBUGGER_COMMIT = '2b90b77fc6f13dd18480cd07d7dd9c052cc26c9d';
const DEBUG_PORT = 9421;
const CDP_PORT = 62000;
const TARGET_HOST = 'gate-obt.nqf.qq.com';
const TARGET_PATH = '/prod/ws';
const FARM_WINDOW_TITLE = 'QQ经典农场';
const TEMP_ROOT = path.join(os.tmpdir(), 'FAR2-WeChat-CDP');
const REPORT_ROOT = path.join(os.tmpdir(), 'FAR2-WeChat-Probe');
const DEBUGGER_DIR = path.join(TEMP_ROOT, `WMPFDebugger-${EXPECTED_WMPF_VERSION}`);

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function sanitizeText(value, max = 220) {
  let text = String(value || '');
  text = text.replace(/([?&](?:code|token|ticket|password|auth)=)[^&\s]+/gi, '$1[REDACTED]');
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
  const out = runPowerShell(command);
  const n = Number(out);
  return Number.isFinite(n) ? n : 0;
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
    await sleep(500);
  }
  return false;
}

function prompt(message) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(message, answer => { rl.close(); resolve(answer); }));
}

function assertDebuggerReady() {
  if (!fs.existsSync(path.join(DEBUGGER_DIR, '.git'))) throw new Error('Pinned WMPFDebugger checkout is missing. Run P3 first.');
  const result = spawnSync('git.exe', ['-C', DEBUGGER_DIR, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (result.status !== 0) throw new Error('git.exe is required to verify WMPFDebugger.');
  if (String(result.stdout || '').trim() !== DEBUGGER_COMMIT) throw new Error('WMPFDebugger is not at the pinned 25297 commit.');
  for (const item of [
    path.join(DEBUGGER_DIR, 'node_modules', 'frida'),
    path.join(DEBUGGER_DIR, 'node_modules', 'ts-node', 'dist', 'bin.js'),
    path.join(DEBUGGER_DIR, 'src', 'index.ts'),
  ]) {
    if (!fs.existsSync(item)) throw new Error('P3 debugger dependencies are incomplete.');
  }
}

function spawnDebugger() {
  const tsNodeBin = path.join(DEBUGGER_DIR, 'node_modules', 'ts-node', 'dist', 'bin.js');
  const entry = path.join(DEBUGGER_DIR, 'src', 'index.ts');
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  const stamp = timestamp();
  const stdoutPath = path.join(TEMP_ROOT, `wmpf-debugger-p4b-${stamp}.out.log`);
  const stderrPath = path.join(TEMP_ROOT, `wmpf-debugger-p4b-${stamp}.err.log`);
  const stdout = fs.openSync(stdoutPath, 'a');
  const stderr = fs.openSync(stderrPath, 'a');
  const child = spawn(process.execPath, [tsNodeBin, entry, '--debug-port', String(DEBUG_PORT), '--cdp-port', String(CDP_PORT)], {
    cwd: DEBUGGER_DIR, windowsHide: true, detached: false, stdio: ['ignore', stdout, stderr],
  });
  child.__far2Handles = [stdout, stderr];
  child.__far2Logs = { stdoutPath, stderrPath };
  return child;
}

function stopDebugger(child) {
  if (!child) return;
  try { child.kill(); } catch {}
  for (const fd of child.__far2Handles || []) { try { fs.closeSync(fd); } catch {} }
}

function normalizeHeaders(headers) {
  const source = headers && typeof headers === 'object' ? headers : {};
  const names = [];
  const safe = {};
  const valueAllow = new Set(['origin', 'user-agent', 'referer', 'sec-websocket-protocol']);
  for (const [rawName, rawValue] of Object.entries(source)) {
    const name = String(rawName || '').trim();
    const lower = name.toLowerCase();
    if (!name || /cookie|authorization|proxy-authorization|token|ticket|secret/i.test(lower)) continue;
    names.push(lower);
    if (valueAllow.has(lower)) safe[lower] = sanitizeText(rawValue, 500);
  }
  names.sort();
  return { names: [...new Set(names)], safeValues: safe };
}

function parseTargetUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    if (u.hostname.toLowerCase() !== TARGET_HOST || u.pathname !== TARGET_PATH) return null;
    const queryKeys = [...new Set([...u.searchParams.keys()].map(k => String(k).toLowerCase()))].sort();
    const get = key => u.searchParams.get(key) || '';
    const code = get('code');
    const openID = get('openID') || get('openid');
    return {
      scheme: u.protocol.replace(':', ''),
      host: u.hostname,
      path: u.pathname,
      platform: get('platform'),
      os: get('os'),
      ver: get('ver'),
      codePresent: code.length > 0,
      codeLength: code.length,
      openIDPresent: openID.length > 0,
      openIDLength: openID.length,
      queryKeys,
      otherQueryKeys: queryKeys.filter(k => !['platform', 'os', 'ver', 'code', 'openid'].includes(k)),
    };
  } catch { return null; }
}

class CdpClient {
  constructor(url, onEvent) {
    this.url = url;
    this.onEvent = onEvent;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }
  async connect() {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('CDP WebSocket connect timeout')), 8000);
      ws.once('open', () => { clearTimeout(timer); resolve(); });
      ws.once('error', err => { clearTimeout(timer); reject(err); });
      ws.on('message', data => this.handle(data));
      ws.on('close', () => {
        for (const item of this.pending.values()) item.reject(new Error('CDP WebSocket closed'));
        this.pending.clear();
      });
    });
  }
  handle(data) {
    let msg;
    try { msg = JSON.parse(Buffer.from(data).toString('utf8')); } catch { return; }
    if (msg && msg.method && typeof this.onEvent === 'function') {
      try { this.onEvent(msg.method, msg.params || {}); } catch {}
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
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP command timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { if (this.ws) { try { this.ws.close(); } catch {} } }
}

function writeReport(report) {
  fs.mkdirSync(REPORT_ROOT, { recursive: true });
  const file = path.join(REPORT_ROOT, `wechat-farm-p4b-handshake-${timestamp()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
  return file;
}

async function main() {
  let debuggerProcess = null;
  let cdp = null;
  let reportPath = '';
  const targetByRequestId = new Map();
  let firstTarget = null;

  try {
    console.log('');
    console.log('FAR2 WeChat Farm P4B Official Handshake Metadata');
    console.log('=================================================');
    console.log('This probe does NOT call wx.login and does NOT send a FAR2 gateway Login.');
    console.log('It only observes metadata for the official farm WebSocket handshake.');
    console.log('Code/openID values, cookies, auth headers, and WebSocket frames are NOT stored.');
    console.log('');

    if (process.platform !== 'win32') throw new Error('P4B only supports Windows.');
    const wmpfVersion = getWmpfVersion();
    if (wmpfVersion !== EXPECTED_WMPF_VERSION) throw new Error(`Unsupported WMPF version: ${wmpfVersion || 'none'}. Expected ${EXPECTED_WMPF_VERSION}.`);
    assertDebuggerReady();

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
    debuggerProcess = spawnDebugger();
    const ready = await waitPorts([DEBUG_PORT, CDP_PORT], 20000);
    if (!ready || debuggerProcess.exitCode !== null) throw new Error('WMPF CDP bridge did not become ready.');

    const onEvent = (method, params) => {
      if (method === 'Network.webSocketCreated') {
        const urlMeta = parseTargetUrl(params.url);
        if (!urlMeta) return;
        const row = {
          requestId: String(params.requestId || ''),
          url: urlMeta,
          requestHeaders: null,
          handshakeResponse: null,
          createdSeen: true,
          requestSeen: false,
          responseSeen: false,
        };
        targetByRequestId.set(row.requestId, row);
        if (!firstTarget) firstTarget = row;
      } else if (method === 'Network.webSocketWillSendHandshakeRequest') {
        const id = String(params.requestId || '');
        const row = targetByRequestId.get(id);
        if (!row) return;
        row.requestSeen = true;
        row.requestHeaders = normalizeHeaders(params.request && params.request.headers);
      } else if (method === 'Network.webSocketHandshakeResponseReceived') {
        const id = String(params.requestId || '');
        const row = targetByRequestId.get(id);
        if (!row) return;
        row.responseSeen = true;
        const response = params.response || {};
        row.handshakeResponse = {
          status: Number(response.status) || 0,
          statusText: sanitizeText(response.statusText || '', 120),
          headers: normalizeHeaders(response.headers),
        };
      }
      // Intentionally ignore Network.webSocketFrameSent/Received and payload events.
    };

    cdp = new CdpClient(`ws://127.0.0.1:${CDP_PORT}`, onEvent);
    await cdp.connect();
    await cdp.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 }, 8000);

    console.log('');
    console.log('CDP Network metadata listener is ready.');
    console.log('Now open QQ Classic Farm from desktop WeChat and wait for the home screen.');
    await prompt('Then return here and press Enter: ');

    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (firstTarget && firstTarget.requestSeen) {
        if (firstTarget.responseSeen) break;
        await sleep(500);
      } else {
        await sleep(500);
      }
    }

    const rows = [...targetByRequestId.values()].map(row => ({
      url: row.url,
      requestHeaders: row.requestHeaders,
      handshakeResponse: row.handshakeResponse,
      createdSeen: row.createdSeen,
      requestSeen: row.requestSeen,
      responseSeen: row.responseSeen,
    }));

    const report = {
      version: 1,
      phase: 'wechat-farm-p4b-official-handshake-metadata',
      generatedAt: new Date().toISOString(),
      safety: {
        wxLoginCalled: false,
        far2GatewayLoginSent: false,
        rawLoginCodeCaptured: false,
        rawOpenIdCaptured: false,
        cookieOrAuthorizationCaptured: false,
        websocketFramePayloadCaptured: false,
        chatDatabaseRead: false,
        networkPayloadCaptured: false,
      },
      environment: {
        wmpfVersion,
        debuggerCommit: DEBUGGER_COMMIT,
        nodeVersion: process.versions.node,
      },
      summary: {
        targetWebSocketCount: rows.length,
        targetCreatedSeen: rows.some(r => r.createdSeen),
        handshakeRequestSeen: rows.some(r => r.requestSeen),
        handshakeResponseSeen: rows.some(r => r.responseSeen),
        gatePassed: rows.some(r => r.requestSeen),
      },
      targetWebSockets: rows,
    };

    reportPath = writeReport(report);
    console.log('');
    console.log('P4B capture completed.');
    console.log(`Target WebSockets: ${report.summary.targetWebSocketCount}`);
    console.log(`Handshake request seen: ${report.summary.handshakeRequestSeen}`);
    console.log(`Handshake response seen: ${report.summary.handshakeResponseSeen}`);
    if (rows[0]) {
      console.log(`Official platform: ${rows[0].url.platform || '(empty)'}`);
      console.log(`Official os: ${rows[0].url.os || '(empty)'}`);
      console.log(`Official ver: ${rows[0].url.ver || '(empty)'}`);
      console.log(`Official code present/length: ${rows[0].url.codePresent}/${rows[0].url.codeLength}`);
      console.log(`Official openID present/length: ${rows[0].url.openIDPresent}/${rows[0].url.openIDLength}`);
      if (rows[0].requestHeaders && rows[0].requestHeaders.safeValues) {
        console.log(`Official Origin: ${rows[0].requestHeaders.safeValues.origin || '(not captured)'}`);
      }
    }
    console.log('');
    console.log('Report path:');
    console.log(reportPath);
    process.exitCode = report.summary.gatePassed ? 0 : 2;
  } catch (err) {
    console.error('');
    console.error('P4B probe failed.');
    console.error(sanitizeText(err && err.message ? err.message : err));
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    stopDebugger(debuggerProcess);
  }
}

if (require.main === module) main().catch(err => { console.error(sanitizeText(err)); process.exitCode = 1; });
