'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');

// Install the proven Windows WeChat gateway profile before the P4 gateway helper
// imports `ws`. Keep the first-send race guard as well.
require('../src/services/wechat-gateway-profile');
require('./wechat-p4-gateway-racefix');

const { createWechatCodeAgent } = require('../src/services/wechat-code-agent');
const { createWechatRuntimeCodeProvider } = require('../src/services/wechat-runtime-code-provider');
const { createWechatDiagnosticCaptureAdapter } = require('../src/services/wechat-diagnostic-capture-adapter');
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
  const file = path.join(REPORT_ROOT, `wechat-agent-live-gate-${timestamp()}.json`);
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
    console.log('FAR2 WeChat P5 Live Agent / Provider Gate');
    console.log('========================================');
    console.log('This is a live plumbing gate for FAR2WeChatAgent -> Provider -> gateway Login.');
    console.log('The low-level WMPF transport is still the temporary pinned diagnostic transport.');
    console.log('Raw wx.login Code is kept only in memory / authenticated loopback HTTP and is never printed or written to the report.');
    console.log('');

    if (process.platform !== 'win32') throw new Error('P5 live gate only supports Windows.');

    const token = crypto.randomBytes(32).toString('hex');
    const port = await reserveFreePort();
    if (!port) throw new Error('Could not reserve a loopback port for FAR2WeChatAgent.');

    const adapter = createWechatDiagnosticCaptureAdapter({ processRef: process });
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
      healthTimeoutMs: 10000,
      refreshTimeoutMs: 120000,
    });

    const account = { id: 'p5-live-gate', platform: 'wx', wechatAppId: EXPECTED_APP_ID };
    const health = await provider.getAvailability(account);
    console.log(`Agent health available: ${health && health.available === true}`);
    if (!health || health.available !== true) {
      throw new Error(`Agent runtime is not available: ${safeText(health && health.reason ? health.reason : 'unknown')}`);
    }

    console.log('Requesting one fresh Code through the authenticated FAR2WeChatAgent Provider channel...');
    const refreshed = await provider.refresh({ account, reason: 'p5_live_gate' });
    rawCode = String(refreshed && refreshed.code || '').trim();
    if (!rawCode) throw new Error('Provider returned no fresh Code.');
    const codeLength = rawCode.length;
    const clientVersion = String(refreshed.clientVersion || '1.13.2.7');
    console.log(`Provider fresh Code received. Code length: ${codeLength}`);
    console.log(`Provider client version: ${clientVersion}`);

    console.log('Testing that Provider-delivered Code can complete one FAR2 gateway Login...');
    const gateway = await probeGatewayLogin(rawCode, clientVersion);
    rawCode = '';

    const gatePassed = !!(
      health.available === true
      && gateway.connected
      && gateway.responseReceived
      && gateway.loginReplyDecoded
      && gateway.basicPresent
      && gateway.gidPresent
      && gateway.gatePassed
    );

    const report = {
      version: 1,
      phase: 'wechat-p5-live-agent-provider-gate',
      generatedAt: new Date().toISOString(),
      safety: {
        wxLoginCalled: true,
        rawLoginCodePersisted: false,
        rawLoginCodePrinted: false,
        rawLoginCodeInCommandLine: false,
        providerTransport: 'authenticated_loopback_http',
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
        agentAvailable: health.available === true,
        providerRefreshSucceeded: codeLength > 0,
        gatewayLoginSucceeded: !!gateway.gatePassed,
        gatePassed,
      },
    };

    reportPath = writeReport(report);
    console.log('');
    console.log('P5 live Agent / Provider gate completed.');
    console.log(`Agent available: ${report.summary.agentAvailable}`);
    console.log(`Provider refresh succeeded: ${report.summary.providerRefreshSucceeded}`);
    console.log(`Gateway Login succeeded: ${report.summary.gatewayLoginSucceeded}`);
    console.log(`P5 live gate passed: ${report.summary.gatePassed}`);
    console.log('');
    console.log('Report path:');
    console.log(reportPath);
    process.exitCode = gatePassed ? 0 : 2;
  } catch (err) {
    rawCode = '';
    console.error('');
    console.error('P5 live Agent / Provider gate failed.');
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
