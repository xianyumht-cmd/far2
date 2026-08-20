'use strict';

const process = require('node:process');
const { spawnSync } = require('node:child_process');
const WebSocket = require('ws');
const { WebSocketServer } = require('ws');
const frida = require('frida');
const { isLikelyCode } = require('./windows-runtime-code');
const {
    EXPECTED_APP_ID,
    EXPECTED_WMPF_VERSION,
    DEBUG_PORT,
    CLIENT_VERSION,
    GATEWAY_VERSION,
    encodeChromeDevtools,
    decodeChromeDevtoolsResult,
    encodeDebugMessage,
    decodeDebugMessage,
    buildFridaSource,
    selectWmpfHostProcess,
} = require('./wechat-wmpf-native-capture');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function createError(code, message = code) {
    const err = new Error(message);
    err.code = code;
    return err;
}

function safeText(value, max = 180) {
    return String(value || '')
        .replace(/([?&](?:code|token|ticket|password)=)[^&\s]+/gi, '$1[REDACTED]')
        .replace(/(Bearer\s+)[\w.-]+/gi, '$1[REDACTED]')
        .replace(/\b[A-Za-z0-9_-]{32}\b/g, '[REDACTED_32]')
        .slice(0, max);
}

function getWindowsSessionId() {
    try {
        const result = spawnSync('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
            '(Get-Process -Id $PID).SessionId',
        ], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
        if (result.status !== 0) return -1;
        const value = Number(String(result.stdout || '').trim());
        return Number.isFinite(value) ? value : -1;
    } catch {
        return -1;
    }
}

class ResidentCdpBridge {
    constructor(options = {}) {
        this.server = null;
        this.miniapp = null;
        this.seq = 0;
        this.opId = 1000;
        this.nextCdpId = 1;
        this.pending = new Map();
        this.contexts = new Map();
        this.onConnect = typeof options.onConnect === 'function' ? options.onConnect : (() => {});
        this.onDisconnect = typeof options.onDisconnect === 'function' ? options.onDisconnect : (() => {});
    }

    async start() {
        if (this.server) return;
        this.server = new WebSocketServer({ host: '127.0.0.1', port: DEBUG_PORT });
        this.server.on('connection', socket => {
            this.contexts.clear();
            this.miniapp = socket;
            socket.binaryType = 'arraybuffer';
            socket.on('message', data => this.onMessage(data));
            socket.on('close', () => {
                if (this.miniapp !== socket) return;
                this.miniapp = null;
                this.contexts.clear();
                this.rejectPending('wechat_resident_runtime_disconnected', 'Resident farm runtime disconnected');
                this.onDisconnect();
            });
            this.onConnect();
        });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(createError('wechat_resident_debug_server_timeout', 'WMPF debug server start timeout')), 5000);
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

    isConnected() {
        return !!(this.miniapp && this.miniapp.readyState === WebSocket.OPEN);
    }

    rejectPending(code, message) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(createError(code, message));
        }
        this.pending.clear();
    }

    onMessage(data) {
        let outer;
        try { outer = decodeDebugMessage(Buffer.isBuffer(data) ? data : Buffer.from(data)); } catch { return; }
        if (outer.category !== 'chromeDevtoolsResult' || !outer.data.length) return;
        let inner;
        try { inner = decodeChromeDevtoolsResult(outer.data); } catch { return; }
        let message;
        try { message = JSON.parse(String(inner.payload || '')); } catch { return; }

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
            if (message.error) pending.reject(createError('wechat_resident_cdp_error', safeText(message.error.message || 'CDP error')));
            else pending.resolve(message);
        }
    }

    sendRaw(message) {
        if (!this.isConnected()) throw createError('wechat_resident_runtime_disconnected', 'Resident farm runtime is not connected');
        const inner = encodeChromeDevtools(JSON.stringify(message), ++this.opId);
        const outer = encodeDebugMessage(++this.seq, 'chromeDevtools', inner);
        this.miniapp.send(outer, { binary: true });
    }

    send(method, params = {}, timeoutMs = 10000) {
        const id = this.nextCdpId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(createError('wechat_resident_cdp_timeout', `CDP command timeout: ${method}`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            try { this.sendRaw({ id, method, params }); }
            catch (err) {
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
        this.rejectPending('wechat_resident_bridge_stopped', 'Resident bridge stopped');
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

async function attachHook() {
    const device = await frida.getLocalDevice();
    const processes = await device.enumerateProcesses({ scope: frida.Scope.Metadata });
    const host = selectWmpfHostProcess(processes);
    if (!host) throw createError('wechat_resident_wmpf_host_missing', `Could not identify WMPF ${EXPECTED_WMPF_VERSION} host`);
    const session = await device.attach(Number(host.pid));
    const script = await session.createScript(buildFridaSource());
    let ready = false;
    let hookError = '';
    script.message.connect(message => {
        if (message && message.type === 'send' && message.payload && message.payload.type === 'far2_wmpf_hook_ready') ready = true;
        if (message && message.type === 'error') hookError = safeText(message.description || message.stack || 'Frida hook error');
    });
    await script.load();
    const deadline = Date.now() + 3000;
    while (!ready && !hookError && Date.now() < deadline) await sleep(30);
    if (!ready) {
        try { await script.unload(); } catch {}
        try { await session.detach(); } catch {}
        throw createError('wechat_resident_hook_failed', hookError || 'FAR2-native WMPF hook did not become ready');
    }
    return { session, script, pid: Number(host.pid) };
}

async function releaseHook(handle) {
    if (!handle) return;
    try { if (handle.script) await handle.script.unload(); } catch {}
    try { if (handle.session) await handle.session.detach(); } catch {}
}

async function selectFarmContext(bridge) {
    await bridge.send('Runtime.enable', {}, 10000);
    await sleep(4200);
    const contexts = [...bridge.contexts.values()].sort((a, b) => a.id - b.id).slice(0, 64);
    if (!contexts.length) throw createError('wechat_resident_no_contexts', 'No CDP execution contexts were reported');

    const infoExpr = "(() => { const o={hasLogin:false,appId:'',envVersion:'',version:''}; try { const w=globalThis.wx; o.hasLogin=!!(w&&typeof w.login==='function'); if(w&&typeof w.getAccountInfoSync==='function'){const i=w.getAccountInfoSync();const m=i&&i.miniProgram?i.miniProgram:{};o.appId=typeof m.appId==='string'?m.appId:'';o.envVersion=typeof m.envVersion==='string'?m.envVersion:'';o.version=typeof m.version==='string'?m.version:'';} } catch(e){} return o; })()";
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
    if (!targets.length) throw createError('wechat_resident_target_context_missing', 'Exact farm AppId context with wx.login was not found');
    return targets[0];
}

function createWechatResidentWmpfCapture(options = {}) {
    const processRef = options.processRef || process;
    const logger = typeof options.log === 'function' ? options.log : (() => {});
    let bridge = null;
    let hook = null;
    let selected = null;
    let started = false;
    let bootstrapping = null;
    let captureInFlight = null;
    let state = 'stopped';
    let lastError = '';

    function setState(next, error = '') {
        state = next;
        lastError = safeText(error, 96);
        logger({
            state,
            reason: lastError || state,
            connected: !!(bridge && bridge.isConnected()),
            selected: !!selected,
        });
    }

    async function bootstrapConnectedRuntime() {
        if (!started || !bridge || !bridge.isConnected()) return;
        if (bootstrapping) return bootstrapping;
        bootstrapping = (async () => {
            selected = null;
            setState('selecting_context');
            try {
                const target = await selectFarmContext(bridge);
                if (!/^\d+\.\d+\.\d+\.\d+$/.test(target.version)) {
                    throw createError('wechat_resident_client_version_invalid', 'Farm mini-program version is missing or invalid');
                }
                selected = target;
                setState('resident_connected');
                return target;
            } catch (err) {
                selected = null;
                setState('waiting_bootstrap', err && err.code ? err.code : 'wechat_resident_bootstrap_failed');
                return null;
            }
        })().finally(() => { bootstrapping = null; });
        return bootstrapping;
    }

    async function start() {
        if (started) return getStatus();
        if (processRef.platform !== 'win32') throw createError('unsupported_platform', 'Windows only');
        bridge = new ResidentCdpBridge({
            onConnect() {
                setState('runtime_connected');
                setImmediate(() => bootstrapConnectedRuntime().catch(() => null));
            },
            onDisconnect() {
                selected = null;
                setState('waiting_bootstrap', 'wechat_resident_runtime_disconnected');
            },
        });
        await bridge.start();
        try {
            hook = await attachHook();
        } catch (err) {
            await bridge.stop().catch(() => {});
            bridge = null;
            throw err;
        }
        started = true;
        setState('waiting_bootstrap');
        return getStatus();
    }

    async function stop() {
        started = false;
        selected = null;
        captureInFlight = null;
        if (bridge) await bridge.stop().catch(() => {});
        bridge = null;
        await releaseHook(hook);
        hook = null;
        setState('stopped');
    }

    function getStatus() {
        return {
            started,
            state,
            reason: lastError || state,
            connected: !!(bridge && bridge.isConnected()),
            exactAppContextSelected: !!selected,
            hookPid: hook ? Number(hook.pid) : 0,
            appId: EXPECTED_APP_ID,
            windowsSessionId: getWindowsSessionId(),
            wmpfVersion: EXPECTED_WMPF_VERSION,
            clientVersion: selected && selected.version ? selected.version : CLIENT_VERSION,
            gatewayVersion: GATEWAY_VERSION,
            envVersion: selected && selected.envVersion ? selected.envVersion : '',
        };
    }

    async function inspectRuntime() {
        const current = getStatus();
        return {
            available: current.state === 'resident_connected' && current.connected && current.exactAppContextSelected,
            reason: current.state === 'resident_connected' ? 'ok' : current.reason,
            platform: 'wx',
            appId: EXPECTED_APP_ID,
            windowsSessionId: current.windowsSessionId,
            wmpfVersion: current.wmpfVersion,
            clientVersion: current.clientVersion,
            gatewayVersion: current.gatewayVersion,
            profileId: '',
            residentState: current.state,
        };
    }

    async function captureFreshCode() {
        if (captureInFlight) return captureInFlight;
        captureInFlight = (async () => {
            if (!started || !bridge || !bridge.isConnected() || !selected) {
                throw createError('wechat_resident_not_ready', `Resident WeChat runtime is not ready (${state})`);
            }
            const loginExpr = "new Promise((resolve)=>{let done=false;const finish=(v)=>{if(done)return;done=true;resolve(v)};const timer=setTimeout(()=>finish({ok:false,code:'',errMsg:'timeout'}),10000);try{globalThis.wx.login({success:(r)=>{clearTimeout(timer);const c=(r&&typeof r.code==='string')?r.code:'';finish({ok:c.length>0,code:c,errMsg:''})},fail:(e)=>{clearTimeout(timer);finish({ok:false,code:'',errMsg:String(e&&e.errMsg?e.errMsg:'wx.login fail').slice(0,160)})}})}catch(e){clearTimeout(timer);finish({ok:false,code:'',errMsg:String(e&&e.message?e.message:e).slice(0,160)})}})";
            let result;
            try {
                result = await bridge.evaluate(loginExpr, selected.id, true, 16000);
            } catch (err) {
                selected = null;
                setState('waiting_bootstrap', err && err.code ? err.code : 'wechat_resident_wx_login_transport_failed');
                throw err;
            }
            const code = String(result && result.code || '').trim();
            if (!result || result.ok !== true || !isLikelyCode(code)) {
                throw createError('wechat_resident_wx_login_failed', `wx.login failed: ${safeText(result && result.errMsg ? result.errMsg : 'no code')}`);
            }
            return {
                code,
                platform: 'wx',
                appId: EXPECTED_APP_ID,
                windowsSessionId: getWindowsSessionId(),
                wmpfVersion: EXPECTED_WMPF_VERSION,
                clientVersion: selected.version || CLIENT_VERSION,
                gatewayVersion: GATEWAY_VERSION,
                profileId: '',
                envVersion: selected.envVersion || '',
                transport: 'far2_native_wmpf_resident',
            };
        })().finally(() => { captureInFlight = null; });
        return captureInFlight;
    }

    return {
        name: 'far2_native_wmpf_resident',
        start,
        stop,
        getStatus,
        inspectRuntime,
        captureFreshCode,
        bootstrapConnectedRuntime,
    };
}

module.exports = {
    createWechatResidentWmpfCapture,
};
