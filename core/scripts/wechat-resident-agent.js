'use strict';

const process = require('node:process');
const { createWechatCodeAgent } = require('../src/services/wechat-code-agent');
const { createWechatResidentWmpfCapture } = require('../src/services/wechat-wmpf-resident-capture');

function safeText(value, max = 180) {
    return String(value || '')
        .replace(/([?&](?:code|token|ticket|password)=)[^&\s]+/gi, '$1[REDACTED]')
        .replace(/(Bearer\s+)[\w.-]+/gi, '$1[REDACTED]')
        .replace(/\b[A-Za-z0-9_-]{32}\b/g, '[REDACTED_32]')
        .slice(0, max);
}

async function main() {
    if (process.platform !== 'win32') throw new Error('Windows only');

    const token = String(process.env.FAR2_WECHAT_AGENT_TOKEN || process.env.FARM_WECHAT_CODE_PROVIDER_TOKEN || '').trim();
    if (token.length < 24) {
        throw new Error('FAR2_WECHAT_AGENT_TOKEN / FARM_WECHAT_CODE_PROVIDER_TOKEN is missing or too short');
    }

    const host = String(process.env.FAR2_WECHAT_AGENT_HOST || '127.0.0.1').trim();
    const port = Math.max(1, Math.min(65535, Number(process.env.FAR2_WECHAT_AGENT_PORT) || 43201));
    let lastState = '';

    const capture = createWechatResidentWmpfCapture({
        processRef: process,
        log(status) {
            if (!status || typeof status !== 'object') return;
            const key = `${status.state}:${status.reason}`;
            if (key === lastState) return;
            lastState = key;
            if (status.state === 'resident_connected') {
                console.log('[resident] exact farm runtime connected and ready');
                return;
            }
            if (status.state === 'waiting_bootstrap') {
                console.log(`[resident] waiting for QQ Classic Farm bootstrap (${safeText(status.reason, 96)})`);
                return;
            }
            console.log(`[resident] ${safeText(status.state, 64)} (${safeText(status.reason, 96)})`);
        },
    });

    const agent = createWechatCodeAgent({
        processRef: process,
        token,
        host,
        port,
        inspectRuntime: capture.inspectRuntime,
        captureFreshCode: capture.captureFreshCode,
        log(message) {
            console.log(`[agent] ${safeText(message)}`);
        },
    });

    let stopping = false;
    async function shutdown(reason) {
        if (stopping) return;
        stopping = true;
        console.log(`[agent] stopping (${safeText(reason, 48)})`);
        try { await agent.stop(); } catch {}
        try { await capture.stop(); } catch {}
    }

    process.once('SIGINT', () => shutdown('SIGINT').finally(() => process.exit(0)));
    process.once('SIGTERM', () => shutdown('SIGTERM').finally(() => process.exit(0)));

    await capture.start();
    await agent.start();

    console.log('');
    console.log('FAR2WeChatAgent resident backend is running.');
    console.log(`Loopback endpoint: http://${host}:${port}/`);
    console.log('Raw wx.login Code logging: disabled');
    console.log('Third-party WMPFDebugger checkout: NOT USED');
    console.log('');
    console.log('Bootstrap requirement:');
    console.log('  Open QQ Classic Farm once AFTER this agent is armed.');
    console.log('  If the farm was already open before the agent started, close only the farm window and reopen it once.');
    console.log('  After [resident] exact farm runtime connected and ready appears, ws_400 refresh can run unattended.');
    console.log('');

    await new Promise(() => {});
}

main().catch(err => {
    console.error(`FAR2WeChatAgent failed: ${safeText(err && err.message ? err.message : err)}`);
    process.exitCode = 1;
});
