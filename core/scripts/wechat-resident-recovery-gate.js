'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const readline = require('node:readline');
const WebSocket = require('ws');
const { WebSocketServer } = require('ws');
const frida = require('frida');

require('../src/services/wechat-gateway-profile');
require('./wechat-p4-gateway-racefix');

const { createWechatCodeAgent } = require('../src/services/wechat-code-agent');
const { createWechatRuntimeCodeProvider } = require('../src/services/wechat-runtime-code-provider');
const { createWechatRecoveryManager } = require('../src/services/wechat-recovery-manager');
const { probeGatewayLogin } = require('./wechat-p4-e2e-login');
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
} = require('../src/services/wechat-wmpf-native-capture');

const FARM_WINDOW_TITLE = 'QQ经典农场';
const REPORT_ROOT = path.join(os.tmpdir(), 'FAR2-WeChat-Probe');
const WX_ACCOUNT_ID = 'p7r-wx-recovery';
const QQ_CONTROL_ID = 'p7r-qq-control';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function timestamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function safeText(value, max = 180) {
    return String(value || '')
        .replace(/([?&](?:code|token|ticket|password)=)[^&\s]+/gi, '$1[REDACTED]')
        .replace(/(Bearer\s+)[\w.-]+/gi, '$1[REDACTED]')
        .replace(/\b[A-Za-z0-9_-]{32}\b/g, '[REDACTED_32]')
        .slice(0, max);
}

function createError(code, message = code) {
    const err = new Error(message);
    err.code = code;
    return err;
}

function runPowerShell(command, timeout = 12000) {
    const result = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
    ], { encoding: 'utf8', windowsHide: true, timeout });
    if (result.error) throw result.error;
    if (result.status !== 0) throw createError('wechat_windows_command_failed', safeText(result.stderr || 'PowerShell command failed'));
    return String(result.stdout || '').trim();
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

async function closeFarmWindowGracefully(timeoutMs = 8000) {
    if (!isFarmWindowOpen()) return true;
    const escaped = FARM_WINDOW_TITLE.replace(/'/g, "''");
    const command = `Get-Process -Name WeChatAppEx -ErrorAction SilentlyContinue | Where-Object { [string]$_.MainWindowTitle -eq '${escaped}' } | ForEach-Object { [void]$_.CloseMainWindow() }`;
    runPowerShell(command, 8000);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isFarmWindowOpen()) return true;
        await sleep(250);
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

function writeReport(report) {
    fs.mkdirSync(REPORT_ROOT, { recursive: true });
    const file = path.join(REPORT_ROOT, `wechat-resident-recovery-gate-${timestamp()}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
    return file;
}

function reserveFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = address && typeof address === 'object' ? Number(address.port) : 0;
            server.close(err => err ? reject(err) : resolve(port));
        });
    });
}

class ResidentBridge {
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
            socket.on('message', data => this.onMessage(data));
            socket.on('close', () => {
                if (this.miniapp === socket) this.miniapp = null;
            });
            const waiters = this.connectedWaiters.splice(0);
            for (const resolve of waiters) resolve(true);
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

    waitMiniapp(timeoutMs = 25000) {
        if (this.miniapp && this.miniapp.readyState === WebSocket.OPEN) return Promise.resolve(true);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const index = this.connectedWaiters.indexOf(done);
                if (index >= 0) this.connectedWaiters.splice(index, 1);
                reject(createError('wechat_resident_miniapp_timeout', 'Farm mini-game did not connect to FAR2 resident debug bridge'));
            }, timeoutMs);
            const done = value => {
                clearTimeout(timer);
                resolve(value);
            };
            this.connectedWaiters.push(done);
        });
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
            if (id > 0) this.contexts.set(id, { id, name: String(ctx.name || ''), origin: String(ctx.origin || '') });
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
        if (!this.miniapp || this.miniapp.readyState !== WebSocket.OPEN) {
            throw createError('wechat_resident_miniapp_not_connected', 'Farm mini-game debug transport is not connected');
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
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(createError('wechat_resident_bridge_stopped', 'Resident bridge stopped'));
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
    const infoExpr = "(() => { const o={hasLogin:false,appId:'',envVersion:'',version:''}; try { const w=globalThis.wx; o.hasLogin=!!(w&&typeof w.login==='function'); if(w&&typeof w.getAccountInfoSync==='function'){const i=w.getAccountInfoSync();const m=i&&i.miniProgram?i.miniProgram:{};o.appId=typeof m.appId==='string'?m.appId:'';o.envVersion=typeof m.envVersion==='string'?m.envVersion:'';o.version=typeof m.version==='string'?m.version:'';} } catch(e){} return o; })()";
    const targets = [];
    for (const ctx of contexts) {
        let value = null;
        try { value = await bridge.evaluate(infoExpr, ctx.id, false, 7000); } catch {}
        if (value && value.hasLogin && value.appId === EXPECTED_APP_ID) {
            targets.push({ id: ctx.id, version: String(value.version || ''), envVersion: String(value.envVersion || '') });
        }
    }
    if (!targets.length) throw createError('wechat_resident_target_context_missing', 'Exact farm AppId context with wx.login was not found');
    return targets[0];
}

function createResidentCapture(bridge, selected) {
    let inFlight = null;
    const loginExpr = "new Promise((resolve)=>{let done=false;const finish=(v)=>{if(done)return;done=true;resolve(v)};const timer=setTimeout(()=>finish({ok:false,code:'',errMsg:'timeout'}),10000);try{globalThis.wx.login({success:(r)=>{clearTimeout(timer);const c=(r&&typeof r.code==='string')?r.code:'';finish({ok:c.length>0,code:c,errMsg:''})},fail:(e)=>{clearTimeout(timer);finish({ok:false,code:'',errMsg:String(e&&e.errMsg?e.errMsg:'wx.login fail').slice(0,160)})}})}catch(e){clearTimeout(timer);finish({ok:false,code:'',errMsg:String(e&&e.message?e.message:e).slice(0,160)})}})";

    async function captureFreshCode() {
        if (inFlight) return inFlight;
        inFlight = (async () => {
            if (!bridge.miniapp || bridge.miniapp.readyState !== WebSocket.OPEN) {
                throw createError('wechat_resident_runtime_disconnected', 'Resident farm runtime is no longer connected');
            }
            const result = await bridge.evaluate(loginExpr, selected.id, true, 16000);
            const code = String(result && result.code || '').trim();
            if (!result || result.ok !== true || code.length !== 32) {
                throw createError('wechat_resident_wx_login_failed', `wx.login failed: ${safeText(result && result.errMsg ? result.errMsg : 'no code')}`);
            }
            return {
                code,
                platform: 'wx',
                appId: EXPECTED_APP_ID,
                windowsSessionId: -1,
                wmpfVersion: EXPECTED_WMPF_VERSION,
                clientVersion: selected.version || CLIENT_VERSION,
                gatewayVersion: GATEWAY_VERSION,
                profileId: '',
                envVersion: selected.envVersion,
                transport: 'far2_native_wmpf_resident',
            };
        })().finally(() => { inFlight = null; });
        return inFlight;
    }

    async function inspectRuntime() {
        const connected = !!(bridge.miniapp && bridge.miniapp.readyState === WebSocket.OPEN);
        return {
            available: connected,
            reason: connected ? 'ok' : 'wechat_resident_runtime_disconnected',
            platform: 'wx',
            appId: EXPECTED_APP_ID,
            windowsSessionId: -1,
            wmpfVersion: EXPECTED_WMPF_VERSION,
            clientVersion: selected.version || CLIENT_VERSION,
            gatewayVersion: GATEWAY_VERSION,
            profileId: '',
        };
    }

    return { captureFreshCode, inspectRuntime };
}

function createEphemeralStore(initialAccounts) {
    const accounts = initialAccounts.map(item => ({ ...item }));
    return {
        getAccounts() { return { accounts: accounts.map(item => ({ ...item })) }; },
        addOrUpdateAccount(update) {
            const id = String(update && update.id || '');
            const index = accounts.findIndex(item => String(item.id || '') === id);
            if (index < 0) accounts.push({ ...update });
            else accounts[index] = { ...accounts[index], ...update };
            return accounts.find(item => String(item.id || '') === id) || null;
        },
        getRawAccount(id) { return accounts.find(item => String(item.id || '') === String(id || '')) || null; },
        clearCode(id) {
            const item = accounts.find(account => String(account.id || '') === String(id || ''));
            if (item) item.code = '';
        },
    };
}

function baseReport() {
    return {
        version: 1,
        phase: 'wechat-p7r-resident-session-recovery-gate',
        generatedAt: new Date().toISOString(),
        safety: {
            bootstrapManualOpenRequired: true,
            recoveryAfterBootstrapUnattended: false,
            wxLoginCalledDuringRecovery: false,
            rawLoginCodePersisted: false,
            rawLoginCodePrinted: false,
            rawLoginCodeInCommandLine: false,
            thirdPartyDebuggerCheckoutUsed: false,
            far2OwnsRemoteDebugProtocol: true,
            tokenOrCookieCaptured: false,
            websocketPayloadCaptured: false,
            realFarmWorkerAutomationStarted: false,
            heartbeatStarted: false,
            farmWriteStarted: false,
            gatewayLoginAttempts: 0,
        },
        bootstrap: {
            farmWindowClosedGracefully: false,
            hookPid: 0,
            runtimeConnected: false,
            exactAppContextSelected: false,
            clientVersion: '',
        },
        recovery: {
            providerRefreshSucceeded: false,
            freshCodeLength: 0,
            wxWorkerStopCalls: 0,
            wxWorkerStartCalls: 0,
            qqWorkerStopCalls: 0,
            qqWorkerStartCalls: 0,
            qqAccountUntouched: false,
            qqWorkerUntouched: false,
            refreshReason: '',
        },
        gateway: {
            connected: false,
            responseReceived: false,
            errorCode: null,
            loginReplyDecoded: false,
            basicPresent: false,
            gidPresent: false,
            level: 0,
            gatePassed: false,
        },
        summary: {
            residentBootstrapSucceeded: false,
            ws400RecoveryWithoutManualAction: false,
            targetWxWorkerOnlyRestarted: false,
            qqControlUntouched: false,
            gatewayLoginSucceeded: false,
            gatePassed: false,
        },
        failure: null,
    };
}

async function main() {
    const report = baseReport();
    let bridge = null;
    let hook = null;
    let agent = null;
    let manager = null;
    let rawCode = '';
    let reportPath = '';

    const qqOriginalCode = 'qq-control-code-do-not-change';
    const qqOriginalWorker = { id: QQ_CONTROL_ID, platform: 'qq', marker: 'original-qq-worker' };
    const workers = {
        [WX_ACCOUNT_ID]: { id: WX_ACCOUNT_ID, platform: 'wx', marker: 'stale-wx-worker' },
        [QQ_CONTROL_ID]: qqOriginalWorker,
    };
    const stopCalls = [];
    const startCalls = [];
    const store = createEphemeralStore([
        {
            id: WX_ACCOUNT_ID,
            name: 'P7R Windows WeChat resident recovery gate',
            platform: 'wx',
            code: 'stale-wx-code',
            codeRefreshEnabled: true,
            codeRefreshMode: 'windows_wechat',
            wechatAppId: EXPECTED_APP_ID,
        },
        {
            id: QQ_CONTROL_ID,
            name: 'P7R QQ untouched control',
            platform: 'qq',
            code: qqOriginalCode,
            codeRefreshEnabled: true,
            codeRefreshMode: 'windows_session',
        },
    ]);

    try {
        console.log('');
        console.log('FAR2 WeChat P7R Resident Recovery Gate');
        console.log('======================================');
        console.log('Bootstrap requires opening QQ Classic Farm once after the FAR2-native hook is armed.');
        console.log('After bootstrap, the ws_400 recovery itself requires NO manual action.');
        console.log('');

        if (process.platform !== 'win32') throw createError('unsupported_platform', 'Windows only');
        report.bootstrap.farmWindowClosedGracefully = await closeFarmWindowGracefully();
        if (!report.bootstrap.farmWindowClosedGracefully) throw createError('wechat_resident_close_failed', 'Could not close only the farm mini-game window');

        bridge = new ResidentBridge();
        await bridge.start();
        hook = await attachHook();
        report.bootstrap.hookPid = hook.pid;

        console.log('FAR2 resident WMPF transport is armed.');
        console.log('Open QQ Classic Farm manually from desktop WeChat and wait for the home screen.');
        await prompt('Then return here and press Enter: ');
        await bridge.waitMiniapp(25000);
        report.bootstrap.runtimeConnected = true;

        const selected = await selectFarmContext(bridge);
        report.bootstrap.exactAppContextSelected = true;
        report.bootstrap.clientVersion = selected.version;
        console.log(`Resident farm context ready. Client version: ${selected.version}`);
        console.log('From this point onward, do NOT touch the farm window. Recovery is automatic.');

        const capture = createResidentCapture(bridge, selected);
        const token = crypto.randomBytes(32).toString('hex');
        const port = await reserveFreePort();
        if (!port) throw createError('wechat_resident_port_failed', 'Could not reserve loopback port');

        agent = createWechatCodeAgent({
            processRef: process,
            token,
            host: '127.0.0.1',
            port,
            inspectRuntime: capture.inspectRuntime,
            captureFreshCode: capture.captureFreshCode,
            log: message => console.log(`[agent] ${safeText(message)}`),
        });
        await agent.start();

        const provider = createWechatRuntimeCodeProvider({
            processRef: process,
            token,
            baseUrl: `http://127.0.0.1:${port}/`,
            healthTimeoutMs: 12000,
            refreshTimeoutMs: 60000,
        });

        manager = createWechatRecoveryManager({
            store,
            workers,
            provider,
            processRef: process,
            startWorker(account) {
                const id = String(account && account.id || '');
                startCalls.push(id);
                workers[id] = { id, platform: String(account && account.platform || ''), marker: `replacement-${startCalls.length}` };
                return true;
            },
            stopWorker(accountId) {
                const id = String(accountId || '');
                stopCalls.push(id);
                delete workers[id];
                return true;
            },
            log(level, message) { console.log(`[recovery:${safeText(level, 24)}] ${safeText(message)}`); },
            addAccountLog() {},
        });
        manager.start();

        const triggeredAt = Date.now();
        console.log('Injecting one scoped ws_400 event now. No manual action is allowed after this line.');
        manager.handleAccountLog({ accountId: WX_ACCOUNT_ID, action: 'ws_400' });

        const deadline = Date.now() + 90000;
        let wxAccount = null;
        while (Date.now() < deadline) {
            wxAccount = store.getRawAccount(WX_ACCOUNT_ID);
            if (wxAccount && Number(wxAccount.lastCodeRefreshAt) >= triggeredAt) {
                if (wxAccount.lastCodeRefreshOk === true) break;
                if (wxAccount.lastCodeRefreshOk === false) {
                    const err = createError('wechat_resident_recovery_failed', wxAccount.lastCodeRefreshError || 'Resident recovery failed');
                    throw err;
                }
            }
            await sleep(250);
        }
        wxAccount = store.getRawAccount(WX_ACCOUNT_ID);
        if (!wxAccount || wxAccount.lastCodeRefreshOk !== true) throw createError('wechat_resident_recovery_timeout', 'Timed out waiting for resident ws_400 recovery');

        rawCode = String(wxAccount.code || '').trim();
        const codeLength = rawCode.length;
        if (codeLength !== 32) throw createError('wechat_resident_missing_code', 'Resident recovery did not produce a 32-character fresh Code');

        const wxStopCalls = stopCalls.filter(id => id === WX_ACCOUNT_ID).length;
        const wxStartCalls = startCalls.filter(id => id === WX_ACCOUNT_ID).length;
        const qqStopCalls = stopCalls.filter(id => id === QQ_CONTROL_ID).length;
        const qqStartCalls = startCalls.filter(id => id === QQ_CONTROL_ID).length;
        const qqAccount = store.getRawAccount(QQ_CONTROL_ID);
        const qqAccountUntouched = !!qqAccount && qqAccount.code === qqOriginalCode;
        const qqWorkerUntouched = workers[QQ_CONTROL_ID] === qqOriginalWorker;

        report.safety.recoveryAfterBootstrapUnattended = true;
        report.safety.wxLoginCalledDuringRecovery = true;
        report.recovery = {
            providerRefreshSucceeded: true,
            freshCodeLength: codeLength,
            wxWorkerStopCalls: wxStopCalls,
            wxWorkerStartCalls: wxStartCalls,
            qqWorkerStopCalls: qqStopCalls,
            qqWorkerStartCalls: qqStartCalls,
            qqAccountUntouched,
            qqWorkerUntouched,
            refreshReason: String(wxAccount.lastCodeRefreshReason || ''),
        };

        console.log(`Fresh Code received automatically. Code length: ${codeLength}`);
        console.log(`WeChat worker stop/start calls: ${wxStopCalls}/${wxStartCalls}`);
        console.log(`QQ worker stop/start calls: ${qqStopCalls}/${qqStartCalls}`);
        console.log('Testing one isolated FAR2 gateway Login with the recovered Code...');

        report.safety.gatewayLoginAttempts = 1;
        const gateway = await probeGatewayLogin(rawCode, String(wxAccount.clientVersion || selected.version || CLIENT_VERSION));
        rawCode = '';
        store.clearCode(WX_ACCOUNT_ID);
        report.gateway = {
            connected: !!gateway.connected,
            responseReceived: !!gateway.responseReceived,
            errorCode: gateway.errorCode,
            loginReplyDecoded: !!gateway.loginReplyDecoded,
            basicPresent: !!gateway.basicPresent,
            gidPresent: !!gateway.gidPresent,
            level: Number(gateway.level) || 0,
            gatePassed: !!gateway.gatePassed,
        };

        const targetWxWorkerOnlyRestarted = wxStopCalls === 1 && wxStartCalls === 1 && qqStopCalls === 0 && qqStartCalls === 0;
        const qqControlUntouched = qqAccountUntouched && qqWorkerUntouched && qqStopCalls === 0 && qqStartCalls === 0;
        const residentBootstrapSucceeded = report.bootstrap.runtimeConnected && report.bootstrap.exactAppContextSelected;
        const ws400RecoveryWithoutManualAction = report.recovery.providerRefreshSucceeded && codeLength === 32 && wxAccount.lastCodeRefreshReason === 'ws_400';
        const gatePassed = residentBootstrapSucceeded && ws400RecoveryWithoutManualAction && targetWxWorkerOnlyRestarted && qqControlUntouched && gateway.gatePassed;

        report.summary = {
            residentBootstrapSucceeded,
            ws400RecoveryWithoutManualAction,
            targetWxWorkerOnlyRestarted,
            qqControlUntouched,
            gatewayLoginSucceeded: !!gateway.gatePassed,
            gatePassed,
        };

        reportPath = writeReport(report);
        console.log('');
        console.log('P7R resident recovery gate completed.');
        console.log(`Resident bootstrap succeeded: ${residentBootstrapSucceeded}`);
        console.log(`WS400 recovery without manual action: ${ws400RecoveryWithoutManualAction}`);
        console.log(`Only target WeChat worker restarted: ${targetWxWorkerOnlyRestarted}`);
        console.log(`QQ control untouched: ${qqControlUntouched}`);
        console.log(`Gateway Login succeeded: ${gateway.gatePassed}`);
        console.log(`P7R gate passed: ${gatePassed}`);
        console.log('');
        console.log('Report path:');
        console.log(reportPath);
        process.exitCode = gatePassed ? 0 : 2;
    } catch (err) {
        rawCode = '';
        store.clearCode(WX_ACCOUNT_ID);
        report.failure = {
            code: safeText(err && err.code ? err.code : 'p7r_gate_failed', 96),
            message: safeText(err && err.message ? err.message : err),
        };
        try { reportPath = writeReport(report); } catch {}
        console.error('');
        console.error('P7R resident recovery gate failed.');
        console.error(`${report.failure.code}: ${report.failure.message}`);
        if (reportPath) {
            console.error('Report path:');
            console.error(reportPath);
        }
        process.exitCode = 1;
    } finally {
        rawCode = '';
        store.clearCode(WX_ACCOUNT_ID);
        if (manager) { try { manager.stop(); } catch {} }
        if (agent) { try { await agent.stop(); } catch {} }
        if (bridge) { try { await bridge.stop(); } catch {} }
        await releaseHook(hook);
    }
}

main().catch(err => {
    console.error(safeText(err && err.message ? err.message : err));
    process.exitCode = 1;
});
