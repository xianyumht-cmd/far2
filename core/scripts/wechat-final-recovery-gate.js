'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');

require('../src/services/wechat-gateway-profile');
require('./wechat-p4-gateway-racefix');

const { createWechatCodeAgent } = require('../src/services/wechat-code-agent');
const { createWechatRuntimeCodeProvider } = require('../src/services/wechat-runtime-code-provider');
const { createWechatRecoveryManager } = require('../src/services/wechat-recovery-manager');
const { createWechatUnattendedCaptureAdapter } = require('../src/services/wechat-unattended-capture-adapter');
const { probeGatewayLogin } = require('./wechat-p4-e2e-login');

const EXPECTED_APP_ID = 'wx5306c5978fdb76e4';
const REPORT_ROOT = path.join(os.tmpdir(), 'FAR2-WeChat-Probe');
const WX_ACCOUNT_ID = 'p7-wx-recovery';
const QQ_CONTROL_ID = 'p7-qq-control';

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

function writeReport(report) {
    fs.mkdirSync(REPORT_ROOT, { recursive: true });
    const file = path.join(REPORT_ROOT, `wechat-final-recovery-gate-${timestamp()}.json`);
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

function createEphemeralStore(initialAccounts) {
    const accounts = initialAccounts.map(item => ({ ...item }));
    return {
        getAccounts() {
            return { accounts: accounts.map(item => ({ ...item })) };
        },
        addOrUpdateAccount(update) {
            const id = String(update && update.id || '');
            const index = accounts.findIndex(item => String(item.id || '') === id);
            if (index < 0) accounts.push({ ...update });
            else accounts[index] = { ...accounts[index], ...update };
            return accounts.find(item => String(item.id || '') === id) || null;
        },
        getRawAccount(id) {
            return accounts.find(item => String(item.id || '') === String(id || '')) || null;
        },
        clearCode(id) {
            const item = accounts.find(account => String(account.id || '') === String(id || ''));
            if (item) item.code = '';
        },
    };
}

function baseReport() {
    return {
        version: 1,
        phase: 'wechat-p7-final-unattended-recovery-gate',
        generatedAt: new Date().toISOString(),
        safety: {
            wxLoginCalled: false,
            rawLoginCodePersisted: false,
            rawLoginCodePrinted: false,
            rawLoginCodeInCommandLine: false,
            providerTransport: 'authenticated_loopback_http',
            thirdPartyDebuggerCheckoutUsed: false,
            far2OwnsRemoteDebugProtocol: true,
            fridaInstrumentationRuntime: true,
            farmWindowCloseMethod: 'CloseMainWindow_only',
            weixinProcessTerminated: false,
            tokenOrCookieCaptured: false,
            websocketPayloadCaptured: false,
            realFarmWorkerAutomationStarted: false,
            heartbeatStarted: false,
            farmWriteStarted: false,
            gatewayLoginAttempts: 0,
        },
        trigger: {
            action: 'ws_400',
            routedToWechatAccountOnly: false,
        },
        unattendedLaunch: {
            attempted: false,
            succeeded: false,
            method: '',
            farmWindowWasOpen: false,
            farmWindowClosedGracefully: false,
            attempts: [],
        },
        recovery: {
            providerRefreshSucceeded: false,
            freshCodeLength: 0,
            wxWorkerStopCalls: 0,
            wxWorkerStartCalls: 0,
            qqWorkerStopCalls: 0,
            qqWorkerStartCalls: 0,
            wxAccountUpdated: false,
            qqAccountUntouched: false,
            qqWorkerUntouched: false,
            refreshReason: '',
            clientVersion: '',
            gatewayVersion: '',
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
            nativeUnattendedCaptureSucceeded: false,
            ws400RecoverySucceeded: false,
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
    const accountLogs = [];

    const store = createEphemeralStore([
        {
            id: WX_ACCOUNT_ID,
            name: 'P7 Windows WeChat recovery gate',
            platform: 'wx',
            code: 'stale-wx-code',
            codeRefreshEnabled: true,
            codeRefreshMode: 'windows_wechat',
            wechatAppId: EXPECTED_APP_ID,
        },
        {
            id: QQ_CONTROL_ID,
            name: 'P7 QQ untouched control',
            platform: 'qq',
            code: qqOriginalCode,
            codeRefreshEnabled: true,
            codeRefreshMode: 'windows_session',
        },
    ]);

    try {
        console.log('');
        console.log('FAR2 WeChat P7 Final Unattended Recovery Gate');
        console.log('==============================================');
        console.log('This gate does not require you to open the farm manually.');
        console.log('It verifies WS400 -> native unattended wx.login -> Agent -> Provider -> only the target WeChat worker restart.');
        console.log('The QQ control account/worker must remain untouched.');
        console.log('No real farm automation, heartbeat, or farm write is started.');
        console.log('');

        if (process.platform !== 'win32') throw new Error('P7 final recovery gate only supports Windows.');

        const token = crypto.randomBytes(32).toString('hex');
        const port = await reserveFreePort();
        if (!port) throw new Error('Could not reserve a loopback port for FAR2WeChatAgent.');

        const adapter = createWechatUnattendedCaptureAdapter({
            processRef: process,
            timeoutMs: 180000,
            log: message => console.log(`[unattended] ${safeText(message)}`),
        });

        agent = createWechatCodeAgent({
            processRef: process,
            token,
            host: '127.0.0.1',
            port,
            inspectRuntime: adapter.inspectRuntime,
            captureFreshCode: adapter.captureFreshCode,
            log: message => console.log(`[agent] ${safeText(message)}`),
        });
        await agent.start();

        const provider = createWechatRuntimeCodeProvider({
            processRef: process,
            token,
            baseUrl: `http://127.0.0.1:${port}/`,
            healthTimeoutMs: 12000,
            refreshTimeoutMs: 180000,
        });

        const health = await provider.getAvailability(store.getRawAccount(WX_ACCOUNT_ID));
        if (!health || health.available !== true) {
            throw Object.assign(new Error(`Native WeChat Agent unavailable: ${safeText(health && health.reason || 'unknown')}`), {
                code: health && health.reason ? health.reason : 'wechat_agent_unavailable',
            });
        }

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
            log(level, message) {
                console.log(`[recovery:${safeText(level, 24)}] ${safeText(message)}`);
            },
            addAccountLog(action, message, accountId, accountName, extra) {
                accountLogs.push({
                    action: safeText(action, 64),
                    accountId: String(accountId || ''),
                    accountName: safeText(accountName, 80),
                    message: safeText(message),
                    reason: safeText(extra && extra.reason || '', 96),
                });
            },
        });
        manager.start();

        const triggeredAt = Date.now();
        console.log('Injecting one scoped ws_400 account-log event for the WeChat test account...');
        manager.handleAccountLog({ accountId: WX_ACCOUNT_ID, action: 'ws_400' });

        const deadline = Date.now() + 210000;
        let wxAccount = null;
        while (Date.now() < deadline) {
            wxAccount = store.getRawAccount(WX_ACCOUNT_ID);
            if (wxAccount && Number(wxAccount.lastCodeRefreshAt) >= triggeredAt) {
                if (wxAccount.lastCodeRefreshOk === true) break;
                if (wxAccount.lastCodeRefreshOk === false) {
                    const err = new Error(wxAccount.lastCodeRefreshError || 'WeChat recovery refresh failed');
                    err.code = 'wechat_recovery_refresh_failed';
                    throw err;
                }
            }
            await sleep(300);
        }
        wxAccount = store.getRawAccount(WX_ACCOUNT_ID);
        if (!wxAccount || wxAccount.lastCodeRefreshOk !== true) {
            const err = new Error('Timed out waiting for scoped WeChat ws_400 recovery');
            err.code = 'wechat_recovery_timeout';
            throw err;
        }

        rawCode = String(wxAccount.code || '').trim();
        const codeLength = rawCode.length;
        if (!rawCode || codeLength < 6) {
            const err = new Error('Recovery manager did not store a fresh WeChat Code');
            err.code = 'wechat_recovery_missing_code';
            throw err;
        }

        const captureStatus = adapter.getLastCaptureStatus() || {};
        report.safety.wxLoginCalled = true;
        report.unattendedLaunch = {
            attempted: !!captureStatus.launchAttempted,
            succeeded: !!captureStatus.launchSucceeded,
            method: String(captureStatus.launchMethod || ''),
            farmWindowWasOpen: !!captureStatus.farmWindowWasOpen,
            farmWindowClosedGracefully: !!captureStatus.farmWindowClosedGracefully,
            attempts: Array.isArray(captureStatus.launchAttempts)
                ? captureStatus.launchAttempts.map(item => ({ method: String(item.method || ''), invoked: !!item.invoked }))
                : [],
        };

        const wxStopCalls = stopCalls.filter(id => id === WX_ACCOUNT_ID).length;
        const wxStartCalls = startCalls.filter(id => id === WX_ACCOUNT_ID).length;
        const qqStopCalls = stopCalls.filter(id => id === QQ_CONTROL_ID).length;
        const qqStartCalls = startCalls.filter(id => id === QQ_CONTROL_ID).length;
        const qqAccount = store.getRawAccount(QQ_CONTROL_ID);
        const qqAccountUntouched = !!qqAccount && qqAccount.code === qqOriginalCode;
        const qqWorkerUntouched = workers[QQ_CONTROL_ID] === qqOriginalWorker;
        const routedOnly = qqStopCalls === 0 && qqStartCalls === 0;

        report.trigger.routedToWechatAccountOnly = routedOnly;
        report.recovery = {
            providerRefreshSucceeded: true,
            freshCodeLength: codeLength,
            wxWorkerStopCalls: wxStopCalls,
            wxWorkerStartCalls: wxStartCalls,
            qqWorkerStopCalls: qqStopCalls,
            qqWorkerStartCalls: qqStartCalls,
            wxAccountUpdated: wxAccount.lastCodeRefreshOk === true && wxAccount.lastCodeRefreshReason === 'ws_400',
            qqAccountUntouched,
            qqWorkerUntouched,
            refreshReason: String(wxAccount.lastCodeRefreshReason || ''),
            clientVersion: String(wxAccount.clientVersion || ''),
            gatewayVersion: String(wxAccount.gatewayVersion || ''),
        };

        console.log(`Fresh Code received through unattended recovery. Code length: ${codeLength}`);
        console.log(`WeChat worker stop/start calls: ${wxStopCalls}/${wxStartCalls}`);
        console.log(`QQ worker stop/start calls: ${qqStopCalls}/${qqStartCalls}`);
        console.log('Testing one isolated FAR2 gateway Login with the recovered Code...');

        report.safety.gatewayLoginAttempts = 1;
        const gateway = await probeGatewayLogin(rawCode, String(wxAccount.clientVersion || '1.13.2.7'));
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

        const targetWxWorkerOnlyRestarted = wxStopCalls === 1 && wxStartCalls === 1 && routedOnly;
        const qqControlUntouched = qqAccountUntouched && qqWorkerUntouched && routedOnly;
        const nativeUnattendedCaptureSucceeded = report.unattendedLaunch.attempted
            && report.unattendedLaunch.succeeded
            && report.recovery.providerRefreshSucceeded
            && codeLength === 32;
        const ws400RecoverySucceeded = report.recovery.wxAccountUpdated && targetWxWorkerOnlyRestarted;
        const gatePassed = nativeUnattendedCaptureSucceeded
            && ws400RecoverySucceeded
            && qqControlUntouched
            && gateway.gatePassed;

        report.summary = {
            nativeUnattendedCaptureSucceeded,
            ws400RecoverySucceeded,
            targetWxWorkerOnlyRestarted,
            qqControlUntouched,
            gatewayLoginSucceeded: !!gateway.gatePassed,
            gatePassed,
        };

        reportPath = writeReport(report);
        console.log('');
        console.log('P7 final unattended recovery gate completed.');
        console.log(`Native unattended capture: ${nativeUnattendedCaptureSucceeded}`);
        console.log(`WS400 recovery: ${ws400RecoverySucceeded}`);
        console.log(`Only target WeChat worker restarted: ${targetWxWorkerOnlyRestarted}`);
        console.log(`QQ control untouched: ${qqControlUntouched}`);
        console.log(`Gateway Login succeeded: ${gateway.gatePassed}`);
        console.log(`P7 final gate passed: ${gatePassed}`);
        console.log('');
        console.log('Report path:');
        console.log(reportPath);
        process.exitCode = gatePassed ? 0 : 2;
    } catch (err) {
        rawCode = '';
        store.clearCode(WX_ACCOUNT_ID);
        report.failure = {
            code: safeText(err && err.code ? err.code : 'p7_gate_failed', 96),
            message: safeText(err && err.message ? err.message : err),
        };
        try {
            const wxAccount = store.getRawAccount(WX_ACCOUNT_ID);
            const qqAccount = store.getRawAccount(QQ_CONTROL_ID);
            report.recovery.wxWorkerStopCalls = stopCalls.filter(id => id === WX_ACCOUNT_ID).length;
            report.recovery.wxWorkerStartCalls = startCalls.filter(id => id === WX_ACCOUNT_ID).length;
            report.recovery.qqWorkerStopCalls = stopCalls.filter(id => id === QQ_CONTROL_ID).length;
            report.recovery.qqWorkerStartCalls = startCalls.filter(id => id === QQ_CONTROL_ID).length;
            report.recovery.qqAccountUntouched = !!qqAccount && qqAccount.code === qqOriginalCode;
            report.recovery.qqWorkerUntouched = workers[QQ_CONTROL_ID] === qqOriginalWorker;
            report.recovery.refreshReason = String(wxAccount && wxAccount.lastCodeRefreshReason || '');
        } catch {}
        try {
            reportPath = writeReport(report);
        } catch {}
        console.error('');
        console.error('P7 final unattended recovery gate failed.');
        console.error(`${report.failure.code}: ${report.failure.message}`);
        if (reportPath) {
            console.error('Report path:');
            console.error(reportPath);
        }
        process.exitCode = 1;
    } finally {
        rawCode = '';
        store.clearCode(WX_ACCOUNT_ID);
        if (manager) {
            try { manager.stop(); } catch {}
        }
        if (agent) {
            try { await agent.stop(); } catch {}
        }
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error(safeText(err && err.message ? err.message : err));
        process.exitCode = 1;
    });
}
