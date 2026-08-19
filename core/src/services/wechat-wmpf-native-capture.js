'use strict';

const process = require('node:process');
const { spawnSync } = require('node:child_process');
const readline = require('node:readline');
const zlib = require('node:zlib');
const WebSocket = require('ws');
const { WebSocketServer } = require('ws');
const protobuf = require('protobufjs');
const { isLikelyCode } = require('./windows-runtime-code');

const EXPECTED_APP_ID = 'wx5306c5978fdb76e4';
const EXPECTED_WMPF_VERSION = 25297;
const DEBUG_PORT = 9421;
const FARM_WINDOW_TITLE = 'QQ经典农场';
const CLIENT_VERSION = '1.13.2.7';
const GATEWAY_VERSION = '1.13.2.7_20260723';

const WMPF_CONFIG = Object.freeze({
    version: EXPECTED_WMPF_VERSION,
    moduleName: 'flue.dll',
    loadStartOffset: 0x2A5D800,
    cdpFilterOffset: 0x38EA370,
    sceneOffsets: [64, 1496, 8, 1432, 16, 456],
});

const DEBUG_SCENES = Object.freeze([
    1005, 1007, 1008, 1027, 1035, 1053, 1074,
    1145, 1178, 1256, 1260, 1302, 1308,
]);

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function safeText(value, max = 180) {
    let text = String(value || '');
    text = text.replace(/([?&](?:code|token|ticket|password)=)[^&\s]+/gi, '$1[REDACTED]');
    text = text.replace(/(Bearer\s+)[\w.-]+/gi, '$1[REDACTED]');
    text = text.replace(/\b[A-Za-z0-9_-]{32}\b/g, '[REDACTED_32]');
    return text.slice(0, max);
}

function createError(code, message = code) {
    const err = new Error(message);
    err.code = code;
    return err;
}

function runPowerShell(command, timeout = 15000) {
    const result = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
    ], {
        encoding: 'utf8',
        windowsHide: true,
        timeout,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(safeText(result.stderr || 'PowerShell command failed'));
    return String(result.stdout || '').trim();
}

function getWindowsSessionId() {
    try {
        const value = Number(runPowerShell('(Get-Process -Id $PID).SessionId', 5000));
        return Number.isFinite(value) ? value : -1;
    } catch {
        return -1;
    }
}

function getWmpfVersion() {
    try {
        const command = [
            '$versions = @()',
            "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '(?i)^WeChatAppEx\\.exe$' -and $_.ExecutablePath } | ForEach-Object {",
            "  $m = [regex]::Match([string]$_.ExecutablePath, '(?i)RadiumWMPF[\\\\/](\\d+)[\\\\/]extracted')",
            '  if ($m.Success) { $versions += [int]$m.Groups[1].Value }',
            '}',
            'if ($versions.Count -gt 0) { ($versions | Sort-Object -Unique -Descending | Select-Object -First 1) }',
        ].join('; ');
        const value = Number(runPowerShell(command, 10000));
        return Number.isFinite(value) ? value : 0;
    } catch {
        return 0;
    }
}

function isFarmWindowOpen() {
    try {
        const escaped = FARM_WINDOW_TITLE.replace(/'/g, "''");
        const command = `(Get-Process -Name WeChatAppEx -ErrorAction SilentlyContinue | Where-Object { [string]$_.MainWindowTitle -eq '${escaped}' } | Measure-Object).Count`;
        return Number(runPowerShell(command, 8000)) > 0;
    } catch {
        return false;
    }
}

function prompt(message) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(message, answer => {
        rl.close();
        resolve(answer);
    }));
}

function encodeChromeDevtools(payload, opId) {
    const writer = protobuf.Writer.create();
    writer.uint32(8).uint64(opId);
    writer.uint32(18).string(String(payload || ''));
    writer.uint32(26).string('');
    return writer.finish();
}

function decodeChromeDevtoolsResult(buffer) {
    const reader = protobuf.Reader.create(buffer);
    let opId = 0;
    let payload = '';
    let jscontextId = '';
    while (reader.pos < reader.len) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
            case 1:
                opId = reader.uint64();
                break;
            case 2:
                payload = reader.string();
                break;
            case 3:
                jscontextId = reader.string();
                break;
            default:
                reader.skipType(tag & 7);
                break;
        }
    }
    return { opId, payload, jscontextId };
}

function encodeDebugMessage(seq, category, data) {
    const writer = protobuf.Writer.create();
    writer.uint32(8).uint32(seq);
    writer.uint32(26).string(category);
    writer.uint32(34).bytes(data);
    writer.uint32(40).uint32(0);
    writer.uint32(48).uint32(0);
    return writer.finish();
}

function decodeDebugMessage(buffer) {
    const reader = protobuf.Reader.create(buffer);
    const message = {
        seq: 0,
        after: 0,
        category: '',
        data: Buffer.alloc(0),
        compressAlgo: 0,
        originalSize: 0,
    };
    while (reader.pos < reader.len) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
            case 1:
                message.seq = reader.uint32();
                break;
            case 2:
                message.after = reader.uint32();
                break;
            case 3:
                message.category = reader.string();
                break;
            case 4:
                message.data = Buffer.from(reader.bytes());
                break;
            case 5:
                message.compressAlgo = reader.uint32();
                break;
            case 6:
                message.originalSize = reader.uint32();
                break;
            default:
                reader.skipType(tag & 7);
                break;
        }
    }
    if (message.data.length && (message.compressAlgo & 1) !== 0) {
        message.data = zlib.inflateSync(message.data);
    }
    return message;
}

function buildFridaSource() {
    const cfg = WMPF_CONFIG;
    const sceneOffsets = JSON.stringify(cfg.sceneOffsets);
    const scenes = JSON.stringify(DEBUG_SCENES);
    return `
'use strict';
const cfg = {
  moduleName: ${JSON.stringify(cfg.moduleName)},
  loadStartOffset: ${cfg.loadStartOffset},
  cdpFilterOffset: ${cfg.cdpFilterOffset},
  sceneOffsets: ${sceneOffsets},
  scenes: ${scenes},
};
const mod = Process.findModuleByName(cfg.moduleName);
if (!mod) throw new Error('WMPF module not found: ' + cfg.moduleName);
const base = mod.base;

function resolveScenePtr(container) {
  let p = container.add(cfg.sceneOffsets[0]).readPointer();
  if (p.isNull()) return null;
  p = p.add(cfg.sceneOffsets[1]).readPointer();
  if (p.isNull()) return null;
  p = p.add(cfg.sceneOffsets[2]).readPointer();
  if (p.isNull()) return null;
  p = p.add(cfg.sceneOffsets[3]).readPointer();
  if (p.isNull()) return null;
  p = p.add(cfg.sceneOffsets[4]).readPointer();
  if (p.isNull()) return null;
  return p.add(cfg.sceneOffsets[5]);
}

Interceptor.attach(base.add(cfg.loadStartOffset), {
  onEnter(args) {
    try {
      this.context.rdx = ptr('0x1');
      const scenePtr = resolveScenePtr(this.context.rcx);
      if (!scenePtr) return;
      const scene = scenePtr.readS32();
      if (cfg.scenes.indexOf(scene) !== -1) scenePtr.writeS32(1101);
    } catch (_) {}
  }
});

Interceptor.attach(base.add(cfg.cdpFilterOffset), {
  onEnter(args) {
    this.holder = args[0];
  },
  onLeave() {
    try {
      if (!this.holder || this.holder.isNull()) return;
      const input = this.holder.readPointer();
      if (input.isNull()) return;
      const statePtr = input.add(8);
      if (statePtr.readU32() === 6) statePtr.writeU32(0);
    } catch (_) {}
  }
});

send({ type: 'far2_wmpf_hook_ready' });
`;
}

async function loadFrida() {
    try {
        return require('frida');
    } catch {
        throw createError('wechat_native_frida_missing', 'FAR2-native WMPF backend requires the isolated frida runtime');
    }
}

function selectWmpfHostProcess(processes) {
    const rows = (processes || []).filter(item => String(item && item.name || '').toLowerCase() === 'wechatappex.exe');
    if (!rows.length) return null;
    const counts = new Map();
    for (const row of rows) {
        const ppid = Number(row && row.parameters && row.parameters.ppid) || 0;
        if (ppid > 0) counts.set(ppid, (counts.get(ppid) || 0) + 1);
    }
    const candidates = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [pid] of candidates) {
        const row = (processes || []).find(item => Number(item && item.pid) === Number(pid));
        if (!row) continue;
        const path = String(row && row.parameters && row.parameters.path || '');
        const match = path.match(/RadiumWMPF[\\/](\d+)[\\/]extracted/i);
        const version = match ? Number(match[1]) : 0;
        if (version === EXPECTED_WMPF_VERSION) return row;
    }
    return null;
}

class DirectCdpBridge {
    constructor() {
        this.server = null;
        this.miniapp = null;
        this.seq = 0;
        this.opId = 1000;
        this.nextCdpId = 1;
        this.pending = new Map();
        this.contexts = new Map();
        this.connectedWaiters = [];
    }

    async start() {
        this.server = new WebSocketServer({ host: '127.0.0.1', port: DEBUG_PORT });
        this.server.on('connection', socket => {
            this.miniapp = socket;
            socket.binaryType = 'arraybuffer';
            socket.on('message', data => this.onMiniappMessage(data));
            socket.on('close', () => {
                if (this.miniapp === socket) this.miniapp = null;
            });
            const waiters = this.connectedWaiters.splice(0);
            for (const resolve of waiters) resolve(true);
        });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(createError('wechat_native_debug_server_timeout', 'WMPF debug server start timeout')), 5000);
            this.server.once('listening', () => {
                clearTimeout(timer);
                resolve();
            });
            this.server.once('error', err => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    async waitMiniapp(timeoutMs = 20000) {
        if (this.miniapp && this.miniapp.readyState === WebSocket.OPEN) return true;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const index = this.connectedWaiters.indexOf(done);
                if (index >= 0) this.connectedWaiters.splice(index, 1);
                reject(createError('wechat_native_miniapp_debug_timeout', 'Mini-program did not connect to FAR2-native WMPF debug server'));
            }, timeoutMs);
            const done = value => {
                clearTimeout(timer);
                resolve(value);
            };
            this.connectedWaiters.push(done);
        });
    }

    onMiniappMessage(data) {
        let outer;
        try {
            outer = decodeDebugMessage(Buffer.isBuffer(data) ? data : Buffer.from(data));
        } catch {
            return;
        }
        if (outer.category !== 'chromeDevtoolsResult' || !outer.data.length) return;
        let inner;
        try {
            inner = decodeChromeDevtoolsResult(outer.data);
        } catch {
            return;
        }
        let message;
        try {
            message = JSON.parse(String(inner.payload || ''));
        } catch {
            return;
        }
        if (message && message.method === 'Runtime.executionContextCreated' && message.params && message.params.context) {
            const ctx = message.params.context;
            const id = Number(ctx.id) || 0;
            if (id > 0) {
                this.contexts.set(id, {
                    id,
                    name: String(ctx.name || ''),
                    origin: String(ctx.origin || ''),
                });
            }
        }
        if (message && Object.prototype.hasOwnProperty.call(message, 'id')) {
            const id = Number(message.id);
            const pending = this.pending.get(id);
            if (!pending) return;
            this.pending.delete(id);
            clearTimeout(pending.timer);
            if (message.error) pending.reject(createError('wechat_native_cdp_error', safeText(message.error.message || 'CDP error')));
            else pending.resolve(message);
        }
    }

    sendRawCdp(message) {
        if (!this.miniapp || this.miniapp.readyState !== WebSocket.OPEN) {
            throw createError('wechat_native_miniapp_not_connected', 'Mini-program debug transport is not connected');
        }
        const inner = encodeChromeDevtools(JSON.stringify(message), ++this.opId);
        const outer = encodeDebugMessage(++this.seq, 'chromeDevtools', inner);
        this.miniapp.send(outer, { binary: true });
    }

    send(method, params = {}, timeoutMs = 10000) {
        const id = this.nextCdpId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(createError('wechat_native_cdp_timeout', `CDP command timeout: ${method}`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            try {
                this.sendRawCdp({ id, method, params });
            } catch (err) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(err);
            }
        });
    }

    async evaluate(expression, contextId, awaitPromise = false, timeoutMs = 12000) {
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

    async stop() {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(createError('wechat_native_bridge_stopped', 'FAR2-native WMPF bridge stopped'));
        }
        this.pending.clear();
        if (this.miniapp) {
            try { this.miniapp.close(); } catch {}
            this.miniapp = null;
        }
        if (this.server) {
            const server = this.server;
            this.server = null;
            await new Promise(resolve => server.close(() => resolve()));
        }
    }
}

async function attachWmpfHook(frida) {
    const device = await frida.getLocalDevice();
    const processes = await device.enumerateProcesses({ scope: frida.Scope.Metadata });
    const host = selectWmpfHostProcess(processes);
    if (!host) {
        throw createError('wechat_native_wmpf_host_missing', 'Could not identify the WMPF 25297 host process');
    }
    const session = await device.attach(Number(host.pid));
    const script = await session.createScript(buildFridaSource());
    let hookReady = false;
    let hookError = null;
    script.message.connect(message => {
        if (message && message.type === 'send' && message.payload && message.payload.type === 'far2_wmpf_hook_ready') {
            hookReady = true;
        }
        if (message && message.type === 'error') hookError = safeText(message.description || message.stack || 'Frida hook error');
    });
    await script.load();
    const deadline = Date.now() + 3000;
    while (!hookReady && !hookError && Date.now() < deadline) await sleep(30);
    if (!hookReady) {
        try { await script.unload(); } catch {}
        try { await session.detach(); } catch {}
        throw createError('wechat_native_hook_failed', hookError || 'FAR2-native WMPF hook did not become ready');
    }
    return { session, script, pid: Number(host.pid) };
}

async function releaseWmpfHook(handle) {
    if (!handle) return;
    try { if (handle.script) await handle.script.unload(); } catch {}
    try { if (handle.session) await handle.session.detach(); } catch {}
}

function createWechatNativeWmpfCapture(options = {}) {
    const processRef = options.processRef || process;
    const interactive = options.interactive === true;
    const logger = typeof options.log === 'function' ? options.log : (() => {});
    let captureInFlight = null;

    async function inspectRuntime() {
        const wmpfVersion = getWmpfVersion();
        let fridaAvailable = true;
        try { await loadFrida(); } catch { fridaAvailable = false; }
        const available = processRef.platform === 'win32'
            && wmpfVersion === EXPECTED_WMPF_VERSION
            && fridaAvailable;
        let reason = 'ok';
        if (processRef.platform !== 'win32') reason = 'unsupported_platform';
        else if (wmpfVersion !== EXPECTED_WMPF_VERSION) reason = 'wechat_wmpf_version_mismatch';
        else if (!fridaAvailable) reason = 'wechat_native_frida_missing';
        return {
            available,
            reason,
            platform: 'wx',
            appId: EXPECTED_APP_ID,
            windowsSessionId: getWindowsSessionId(),
            wmpfVersion,
            clientVersion: CLIENT_VERSION,
            gatewayVersion: GATEWAY_VERSION,
            profileId: '',
        };
    }

    async function doCapture() {
        if (processRef.platform !== 'win32') throw createError('unsupported_platform', 'Windows only');
        const runtime = await inspectRuntime();
        if (!runtime.available) throw createError(runtime.reason, `WeChat runtime unavailable: ${runtime.reason}`);

        if (isFarmWindowOpen()) {
            if (!interactive) {
                throw createError('wechat_farm_window_must_restart', 'Farm window is already open; restart it after the native WMPF hook is armed');
            }
            console.log('QQ Classic Farm is currently open.');
            console.log('Close ONLY the farm mini-program window. Keep desktop WeChat logged in.');
            await prompt('After the farm window is closed, press Enter: ');
            await sleep(700);
            if (isFarmWindowOpen()) throw createError('wechat_farm_window_still_open', 'Farm window is still open');
        }

        const frida = await loadFrida();
        const bridge = new DirectCdpBridge();
        let hook = null;
        let code = '';
        try {
            await bridge.start();
            hook = await attachWmpfHook(frida);
            logger(`FAR2-native WMPF hook armed: pid=${hook.pid}, version=${EXPECTED_WMPF_VERSION}`);

            if (!interactive) {
                throw createError('wechat_farm_autolaunch_pending', 'Native backend is armed, but unattended farm auto-launch is not implemented yet');
            }

            console.log('FAR2-native WMPF transport is ready.');
            console.log('Now open QQ Classic Farm from desktop WeChat and wait for the home screen.');
            await prompt('Then return here and press Enter: ');
            await bridge.waitMiniapp(20000);
            await bridge.send('Runtime.enable', {}, 10000);
            await sleep(4200);

            const contexts = [...bridge.contexts.values()].sort((a, b) => a.id - b.id).slice(0, 64);
            if (!contexts.length) throw createError('wechat_native_no_contexts', 'No CDP execution contexts were reported');

            const infoExpr = "(() => { const out={hasLogin:false,appId:'',envVersion:'',version:''}; try { const w=globalThis.wx; out.hasLogin=!!(w&&typeof w.login==='function'); if(w&&typeof w.getAccountInfoSync==='function'){ const i=w.getAccountInfoSync(); const m=i&&i.miniProgram?i.miniProgram:{}; out.appId=typeof m.appId==='string'?m.appId:''; out.envVersion=typeof m.envVersion==='string'?m.envVersion:''; out.version=typeof m.version==='string'?m.version:''; } } catch(e) {} return out; })()";
            const targets = [];
            for (const ctx of contexts) {
                let value = null;
                try { value = await bridge.evaluate(infoExpr, ctx.id, false, 7000); } catch {}
                if (value && value.hasLogin && value.appId === EXPECTED_APP_ID) {
                    targets.push({
                        id: ctx.id,
                        version: String(value.version || ''),
                        envVersion: String(value.envVersion || ''),
                    });
                }
            }
            if (!targets.length) throw createError('wechat_native_target_context_missing', 'Exact farm AppId context with wx.login was not found');
            const selected = targets[0];
            if (!/^\d+\.\d+\.\d+\.\d+$/.test(selected.version)) {
                throw createError('wechat_native_client_version_invalid', 'Farm mini-program version is missing or invalid');
            }

            const loginExpr = "new Promise((resolve)=>{let done=false;const finish=(v)=>{if(done)return;done=true;resolve(v)};const timer=setTimeout(()=>finish({ok:false,code:'',errMsg:'timeout'}),10000);try{globalThis.wx.login({success:(r)=>{clearTimeout(timer);const c=(r&&typeof r.code==='string')?r.code:'';finish({ok:c.length>0,code:c,errMsg:''})},fail:(e)=>{clearTimeout(timer);finish({ok:false,code:'',errMsg:String(e&&e.errMsg?e.errMsg:'wx.login fail').slice(0,160)})}})}catch(e){clearTimeout(timer);finish({ok:false,code:'',errMsg:String(e&&e.message?e.message:e).slice(0,160)})}})";
            const result = await bridge.evaluate(loginExpr, selected.id, true, 16000);
            if (!result || result.ok !== true || !isLikelyCode(result.code)) {
                throw createError('wechat_native_wx_login_failed', `wx.login failed: ${safeText(result && result.errMsg ? result.errMsg : 'no code')}`);
            }
            code = String(result.code).trim();
            return {
                code,
                platform: 'wx',
                appId: EXPECTED_APP_ID,
                windowsSessionId: getWindowsSessionId(),
                wmpfVersion: EXPECTED_WMPF_VERSION,
                clientVersion: selected.version,
                gatewayVersion: selected.version === CLIENT_VERSION ? GATEWAY_VERSION : `${selected.version}_20260723`,
                profileId: '',
                envVersion: selected.envVersion,
                transport: 'far2_native_wmpf',
            };
        } finally {
            code = '';
            await bridge.stop().catch(() => {});
            await releaseWmpfHook(hook);
        }
    }

    function captureFreshCode() {
        if (captureInFlight) return captureInFlight;
        captureInFlight = doCapture().finally(() => {
            captureInFlight = null;
        });
        return captureInFlight;
    }

    return {
        name: 'far2_native_wmpf',
        inspectRuntime,
        captureFreshCode,
    };
}

module.exports = {
    EXPECTED_APP_ID,
    EXPECTED_WMPF_VERSION,
    DEBUG_PORT,
    CLIENT_VERSION,
    GATEWAY_VERSION,
    createWechatNativeWmpfCapture,
    encodeChromeDevtools,
    decodeChromeDevtoolsResult,
    encodeDebugMessage,
    decodeDebugMessage,
    buildFridaSource,
    selectWmpfHostProcess,
};
