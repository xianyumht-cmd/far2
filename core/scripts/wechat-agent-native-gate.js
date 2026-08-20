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
const { createWechatNativeWmpfCapture } = require('../src/services/wechat-wmpf-native-capture');
const { probeGatewayLogin } = require('./wechat-p4-e2e-login');

const EXPECTED_APP_ID = 'wx5306c5978fdb76e4';
const REPORT_ROOT = path.join(os.tmpdir(), 'FAR2-WeChat-Probe');

function timestamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function safeText(value, max = 180) {
    return String(value || '').replace(/\b[A-Za-z0-9_-]{32}\b/g, '[REDACTED_32]').slice(0, max);
}

function writeReport(report) {
    fs.mkdirSync(REPORT_ROOT, { recursive: true });
    const file = path.join(REPORT_ROOT, `wechat-agent-native-gate-${timestamp()}.json`);
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

async function main() {
    let agent = null;
    let rawCode = '';
    let reportPath = '';
    try {
        console.log('');
        console.log('FAR2 WeChat P6 Native WMPF Agent Gate');
        console.log('======================================');
        console.log('This gate removes the WMPFDebugger checkout from the capture path.');
        console.log('FAR2 owns the WMPF hook, remote-debug framing, CDP routing, exact AppId selection, and wx.login call.');
        console.log('Frida is used only as the local process instrumentation runtime.');
        console.log('Raw wx.login Code is kept only in memory / authenticated loopback HTTP and is never printed or written to the report.');
        console.log('');

        if (process.platform !== 'win32') throw new Error('P6 native gate only supports Windows.');

        const token = crypto.randomBytes(32).toString('hex');
        const port = await reserveFreePort();
        if (!port) throw new Error('Could not reserve a loopback port for FAR2WeChatAgent.');

        const adapter = createWechatNativeWmpfCapture({
            processRef: process,
            interactive: true,
            log: message => console.log(`[native] ${safeText(message)}`),
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
            refreshTimeoutMs: 150000,
        });

        const account = { id: 'p6-native-gate', platform: 'wx', wechatAppId: EXPECTED_APP_ID };
        const health = await provider.getAvailability(account);
        console.log(`Agent health available: ${health && health.available === true}`);
        if (!health || health.available !== true) {
            throw new Error(`Native Agent runtime is not available: ${safeText(health && health.reason ? health.reason : 'unknown')}`);
        }

        console.log('Requesting one fresh Code through FAR2-native WMPF capture -> Agent -> Provider...');
        const refreshed = await provider.refresh({ account, reason: 'p6_native_gate' });
        rawCode = String(refreshed && refreshed.code || '').trim();
        if (!rawCode) throw new Error('Provider returned no fresh Code.');
        const codeLength = rawCode.length;
        const clientVersion = String(refreshed.clientVersion || '1.13.2.7');
        console.log(`Provider fresh Code received. Code length: ${codeLength}`);
        console.log(`Provider client version: ${clientVersion}`);

        console.log('Testing one FAR2 gateway Login with the native-backend Code...');
        const gateway = await probeGatewayLogin(rawCode, clientVersion);
        rawCode = '';

        const gatePassed = !!(
            health.available === true
            && codeLength > 0
            && gateway.connected
            && gateway.responseReceived
            && gateway.loginReplyDecoded
            && gateway.basicPresent
            && gateway.gidPresent
            && gateway.gatePassed
        );

        const report = {
            version: 1,
            phase: 'wechat-p6-native-wmpf-agent-gate',
            generatedAt: new Date().toISOString(),
            safety: {
                wxLoginCalled: true,
                rawLoginCodePersisted: false,
                rawLoginCodePrinted: false,
                rawLoginCodeInCommandLine: false,
                providerTransport: 'authenticated_loopback_http',
                thirdPartyDebuggerCheckoutUsed: false,
                far2OwnsRemoteDebugProtocol: true,
                fridaInstrumentationRuntime: true,
                tokenOrCookieCaptured: false,
                websocketPayloadCaptured: false,
                farmAutomationStarted: false,
                heartbeatStarted: false,
                farmWriteStarted: false,
                gatewayLoginAttempts: 1,
            },
            agent: {
                available: health.available === true,
                platform: health.platform || '',
                appId: health.appId || '',
                windowsSessionId: Number(health.windowsSessionId),
                wmpfVersion: Number(health.wmpfVersion) || 0,
            },
            provider: {
                name: provider.name,
                codeLength,
                source: String(refreshed.source || ''),
                clientVersion,
                gatewayVersion: String(refreshed.gatewayVersion || ''),
                appId: String(refreshed.appId || ''),
            },
            gateway: {
                connected: !!gateway.connected,
                responseReceived: !!gateway.responseReceived,
                errorCode: gateway.errorCode,
                loginReplyDecoded: !!gateway.loginReplyDecoded,
                basicPresent: !!gateway.basicPresent,
                gidPresent: !!gateway.gidPresent,
                level: Number(gateway.level) || 0,
                gatePassed: !!gateway.gatePassed,
            },
            summary: {
                nativeRuntimeAvailable: health.available === true,
                nativeProviderRefreshSucceeded: codeLength > 0,
                gatewayLoginSucceeded: !!gateway.gatePassed,
                gatePassed,
            },
        };

        reportPath = writeReport(report);
        console.log('');
        console.log('P6 native WMPF Agent gate completed.');
        console.log(`Native runtime available: ${report.summary.nativeRuntimeAvailable}`);
        console.log(`Native Provider refresh succeeded: ${report.summary.nativeProviderRefreshSucceeded}`);
        console.log(`Gateway Login succeeded: ${report.summary.gatewayLoginSucceeded}`);
        console.log(`P6 native gate passed: ${report.summary.gatePassed}`);
        console.log('');
        console.log('Report path:');
        console.log(reportPath);
        process.exitCode = gatePassed ? 0 : 2;
    } catch (err) {
        rawCode = '';
        console.error('');
        console.error('P6 native WMPF Agent gate failed.');
        console.error(safeText(err && err.message ? err.message : err));
        process.exitCode = 1;
    } finally {
        rawCode = '';
        if (agent) {
            try { await agent.stop(); } catch {}
        }
    }
}

if (require.main === module) main().catch(err => {
    console.error(safeText(err && err.message ? err.message : err));
    process.exitCode = 1;
});
