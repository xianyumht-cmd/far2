'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const process = require('node:process');
const { spawnSync } = require('node:child_process');
const readline = require('node:readline');
const WebSocket = require('ws');
const { WebSocketServer } = require('ws');
const frida = require('frida');

const {
    EXPECTED_APP_ID,
    EXPECTED_WMPF_VERSION,
    DEBUG_PORT,
    encodeChromeDevtools,
    decodeChromeDevtoolsResult,
    encodeDebugMessage,
    decodeDebugMessage,
    buildFridaSource,
    selectWmpfHostProcess,
} = require('../src/services/wechat-wmpf-native-capture');

const FARM_WINDOW_TITLE = 'QQ\u7ecf\u5178\u519c\u573a';
const REPORT_ROOT = path.join(os.tmpdir(), 'FAR2-WeChat-Probe');
const PROFILE_ROOT = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'FAR2');
const PROFILE_PATH = path.join(PROFILE_ROOT, 'wechat-launch-profile.json');

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
    if (!isFarmWindowOpen()) return { needed: false, closed: true };
    const escaped = FARM_WINDOW_TITLE.replace(/'/g, "''");
    const command = `Get-Process -Name WeChatAppEx -ErrorAction SilentlyContinue | Where-Object { [string]$_.MainWindowTitle -eq '${escaped}' } | ForEach-Object { [void]$_.CloseMainWindow() }`;
    runPowerShell(command, 8000);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isFarmWindowOpen()) return { needed: true, closed: true };
        await sleep(250);
    }
    return { needed: true, closed: false };
}

function prompt(message) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(message, answer => {
        rl.close();
        resolve(answer);
    }));
}

function normalizeRoute(value) {
    let route = String(value || '').trim().replace(/\\\//g, '/');
    while (route.startsWith('/')) route = route.slice(1);
    route = route.split(/[?#]/, 1)[0];
    if (!route || route.length > 256) return '';
    if (route.includes('..') || route.includes('\\') || route.includes(':')) return '';
    if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(route)) return '';
    return route;
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
            socket.on('message', data => this.onMessage(data));
            socket.on('close', () => {
                if (this.miniapp === socket) this.miniapp = null;
            });
            const waiters = this.connectedWaiters.splice(0);
            for (const resolve of waiters) resolve(true);
        });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(createError('wechat_runtime_route_debug_server_timeout', 'WMPF debug server start timeout')), 5000);
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
                reject(createError('wechat_runtime_route_miniapp_timeout', 'Mini-program did not connect to FAR2-native WMPF debug server'));
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
            if (message.error) pending.reject(createError('wechat_runtime_route_cdp_error', safeText(message.error.message || 'CDP error')));
            else pending.resolve(message);
        }
    }

    sendRaw(message) {
        if (!this.miniapp || this.miniapp.readyState !== WebSocket.OPEN) {
            throw createError('wechat_runtime_route_miniapp_not_connected', 'Mini-program debug transport is not connected');
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
                reject(createError('wechat_runtime_route_cdp_timeout', `CDP command timeout: ${method}`));
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

    async evaluate(expression, contextId, timeoutMs = 12000) {
        const response = await this.send('Runtime.evaluate', {
            expression,
            contextId,
            returnByValue: true,
            awaitPromise: false,
            silent: true,
        }, timeoutMs);
        const result = response && response.result && response.result.result;
        return result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : null;
    }

    async stop() {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(createError('wechat_runtime_route_bridge_stopped', 'Runtime route bridge stopped'));
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
    if (!host) throw createError('wechat_runtime_route_wmpf_host_missing', `Could not identify the WMPF ${EXPECTED_WMPF_VERSION} host process`);
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
        throw createError('wechat_runtime_route_hook_failed', hookError || 'FAR2-native WMPF hook did not become ready');
    }
    return { session, script, pid: Number(host.pid) };
}

async function releaseHook(handle) {
    if (!handle) return;
    try { if (handle.script) await handle.script.unload(); } catch {}
    try { if (handle.session) await handle.session.detach(); } catch {}
}

function timestamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

async function main() {
    const report = {
        version: 1,
        generatedAt: new Date().toISOString(),
        phase: 'wechat-runtime-launch-path-learner',
        appId: EXPECTED_APP_ID,
        safety: {
            wxLoginCalled: false,
            chatDatabaseRead: false,
            messageContentRead: false,
            contactDataRead: false,
            tokenOrCookieCaptured: false,
            launchQueryPersisted: false,
            persistedData: 'exact appId + published route + non-sensitive runtime metadata only',
        },
        farmWindowClosedGracefully: false,
        hookPid: 0,
        targetContextCount: 0,
        targetContexts: [],
        selected: null,
        failure: null,
    };

    let bridge = null;
    let hook = null;
    const reportPath = path.join(REPORT_ROOT, `wechat-runtime-launch-path-${timestamp()}.json`);
    try {
        if (process.platform !== 'win32') throw createError('unsupported_platform', 'Windows only');
        const closed = await closeFarmWindowGracefully();
        report.farmWindowClosedGracefully = !!closed.closed;
        if (!closed.closed) throw createError('wechat_runtime_route_close_failed', 'Could not close only the farm mini-program window');

        bridge = new DirectCdpBridge();
        await bridge.start();
        hook = await attachHook();
        report.hookPid = hook.pid;

        console.log('FAR2-native runtime route transport is ready.');
        console.log('Now open QQ Classic Farm manually from desktop WeChat and wait for the home screen.');
        await prompt('Then return here and press Enter: ');
        await bridge.waitMiniapp(25000);
        await bridge.send('Runtime.enable', {}, 10000);
        await sleep(4200);

        const contexts = [...bridge.contexts.values()].sort((a, b) => a.id - b.id).slice(0, 64);
        const expr = "(() => { const o={appId:'',envVersion:'',version:'',launchPath:'',enterPath:'',currentPage:''}; try { const w=globalThis.wx; if(w&&typeof w.getAccountInfoSync==='function'){ const i=w.getAccountInfoSync(); const m=i&&i.miniProgram?i.miniProgram:{}; o.appId=typeof m.appId==='string'?m.appId:''; o.envVersion=typeof m.envVersion==='string'?m.envVersion:''; o.version=typeof m.version==='string'?m.version:''; } if(w&&typeof w.getLaunchOptionsSync==='function'){ const x=w.getLaunchOptionsSync()||{}; o.launchPath=typeof x.path==='string'?x.path:''; } if(w&&typeof w.getEnterOptionsSync==='function'){ const x=w.getEnterOptionsSync()||{}; o.enterPath=typeof x.path==='string'?x.path:''; } if(typeof globalThis.getCurrentPages==='function'){ const ps=globalThis.getCurrentPages()||[]; const p=ps.length?ps[ps.length-1]:null; o.currentPage=p&&typeof p.route==='string'?p.route:(p&&typeof p.__route__==='string'?p.__route__:''); } } catch(e) {} return o; })()";
        const rows = [];
        for (const ctx of contexts) {
            let value = null;
            try { value = await bridge.evaluate(expr, ctx.id, 7000); } catch {}
            if (!value || value.appId !== EXPECTED_APP_ID) continue;
            rows.push({
                contextId: ctx.id,
                origin: String(ctx.origin || ''),
                envVersion: String(value.envVersion || ''),
                version: String(value.version || ''),
                launchPath: normalizeRoute(value.launchPath),
                enterPath: normalizeRoute(value.enterPath),
                currentPage: normalizeRoute(value.currentPage),
            });
        }
        report.targetContextCount = rows.length;
        report.targetContexts = rows;
        if (!rows.length) throw createError('wechat_runtime_route_target_context_missing', 'Exact farm AppId context was not found');

        const chooseUnique = field => {
            const values = [...new Set(rows.map(row => row[field]).filter(Boolean))];
            if (values.length === 1) return values[0];
            if (values.length > 1) throw createError('wechat_runtime_launch_path_ambiguous', `Multiple exact runtime ${field} values were observed`);
            return '';
        };

        let selectedPath = chooseUnique('launchPath');
        let source = selectedPath ? 'wx.getLaunchOptionsSync.path' : '';
        if (!selectedPath) {
            selectedPath = chooseUnique('enterPath');
            source = selectedPath ? 'wx.getEnterOptionsSync.path' : '';
        }
        if (!selectedPath) {
            selectedPath = chooseUnique('currentPage');
            source = selectedPath ? 'getCurrentPages.route' : '';
        }
        if (!selectedPath) throw createError('wechat_runtime_launch_path_missing', 'Exact farm runtime did not expose a valid published route');

        const chosen = rows.find(row => row.launchPath === selectedPath || row.enterPath === selectedPath || row.currentPage === selectedPath) || rows[0];
        report.selected = {
            path: selectedPath,
            source,
            envVersion: chosen.envVersion,
            version: chosen.version,
        };

        writeJson(PROFILE_PATH, {
            version: 2,
            appId: EXPECTED_APP_ID,
            path: selectedPath,
            learnedAt: new Date().toISOString(),
            evidenceSource: source,
            transport: 'far2_native_wmpf_runtime',
        });
        writeJson(reportPath, report);

        console.log('');
        console.log('Exact runtime launch path learned and saved locally.');
        console.log(`Launch path: ${selectedPath}`);
        console.log(`Evidence source: ${source}`);
        console.log(`Profile: ${PROFILE_PATH}`);
        console.log('You can now run test-wechat-final-recovery-gate.cmd.');
        console.log('');
        console.log('Evidence report:');
        console.log(reportPath);
    } catch (err) {
        report.failure = {
            code: safeText(err && err.code ? err.code : 'wechat_runtime_route_failed', 96),
            message: safeText(err && err.message ? err.message : err),
        };
        try { writeJson(reportPath, report); } catch {}
        console.error('');
        console.error('Runtime launch path learner failed.');
        console.error(`${report.failure.code}: ${report.failure.message}`);
        console.error('Evidence report:');
        console.error(reportPath);
        process.exitCode = 2;
    } finally {
        if (bridge) await bridge.stop().catch(() => {});
        await releaseHook(hook);
    }
}

main().catch(err => {
    console.error(safeText(err && err.message ? err.message : err));
    process.exitCode = 2;
});
