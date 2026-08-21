'use strict';

const process = require('node:process');
const { createWechatCodeAgent } = require('../src/services/wechat-code-agent');
const { createWechatResidentWmpfCapture } = require('../src/services/wechat-wmpf-resident-capture');

function safeText(value, max = 180) {
    return String(value || '')
        .replace(/([?&](?:code|token|ticket|password)=)[^\s&]+/gi, '$1[REDACTED]')
        .replace(/(Bearer\s+)[\w.-]+/gi, '$1[REDACTED]')
        .replace(/\b[A-Za-z0-9_-]{32}\b/g, '[REDACTED_32]')
        .slice(0, max);
}

function pidAlive(pid) {
    const value = Number(pid) || 0;
    if (!Number.isInteger(value) || value <= 0) return false;
    try {
        process.kill(value, 0);
        return true;
    } catch {
        return false;
    }
}

async function main() {
    if (process.platform !== 'win32') throw new Error('Windows only');

    const token = String(
        process.env.FAR2_WECHAT_AGENT_TOKEN
        || process.env.FARM_WECHAT_CODE_PROVIDER_TOKEN
        || ''
    ).trim();
    if (token.length < 24) {
        throw new Error('FAR2_WECHAT_AGENT_TOKEN / FARM_WECHAT_CODE_PROVIDER_TOKEN is missing or too short');
    }

    const host = String(process.env.FAR2_WECHAT_AGENT_HOST || '127.0.0.1').trim();
    const port = Math.max(1, Math.min(65535, Number(process.env.FAR2_WECHAT_AGENT_PORT) || 43201));

    let stopping = false;
    let captureStartInFlight = null;
    let captureSupervisorTimer = null;
    let bootstrapRetryTimer = null;
    let bootstrapRetryBusy = false;
    let lastCaptureStartError = 'wechat_runtime_start_pending';
    let lastSupervisorNotice = '';
    let lastResidentState = '';

    const capture = createWechatResidentWmpfCapture({
        processRef: process,
        log(status) {
            if (!status || typeof status !== 'object') return;
            const key = `${status.state}:${status.reason}`;
            if (key === lastResidentState) return;
            lastResidentState = key;

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

    async function ensureCaptureStarted(trigger = 'supervisor') {
        if (stopping) return capture.getStatus();
        if (captureStartInFlight) return captureStartInFlight;

        captureStartInFlight = (async () => {
            let status = capture.getStatus();

            if (status && status.started) {
                const hookPid = Number(status.hookPid) || 0;
                if (hookPid > 0 && !pidAlive(hookPid)) {
                    lastCaptureStartError = 'wechat_resident_wmpf_host_exited';
                    const notice = `hook-exited:${hookPid}`;
                    if (notice !== lastSupervisorNotice) {
                        lastSupervisorNotice = notice;
                        console.log(`[supervisor] WMPF host pid ${hookPid} exited; rearming capture`);
                    }
                    try { await capture.stop(); } catch {}
                    status = capture.getStatus();
                } else {
                    return status;
                }
            }

            try {
                const started = await capture.start();
                lastCaptureStartError = '';
                lastSupervisorNotice = '';
                console.log(`[supervisor] WeChat capture armed (${safeText(trigger, 48)})`);
                return started;
            } catch (err) {
                const reason = err && err.code
                    ? String(err.code)
                    : 'wechat_capture_start_failed';
                lastCaptureStartError = reason;
                const notice = `waiting:${reason}`;
                if (notice !== lastSupervisorNotice) {
                    lastSupervisorNotice = notice;
                    console.log(`[supervisor] runtime not ready; agent stays online (${safeText(reason, 96)})`);
                }
                return capture.getStatus();
            }
        })().finally(() => {
            captureStartInFlight = null;
        });

        return captureStartInFlight;
    }

    async function inspectRuntime() {
        const runtime = await capture.inspectRuntime();
        const status = capture.getStatus();
        if (runtime && runtime.available) return runtime;

        if ((!status || !status.started) && lastCaptureStartError) {
            return {
                ...(runtime || {}),
                available: false,
                reason: lastCaptureStartError,
                residentState: 'waiting_runtime',
            };
        }
        return runtime;
    }

    async function captureFreshCode(input = {}) {
        await ensureCaptureStarted('provider_refresh');
        return capture.captureFreshCode(input);
    }

    const agent = createWechatCodeAgent({
        processRef: process,
        token,
        host,
        port,
        inspectRuntime,
        captureFreshCode,
        log(message) {
            console.log(`[agent] ${safeText(message)}`);
        },
    });

    async function shutdown(reason) {
        if (stopping) return;
        stopping = true;

        if (captureSupervisorTimer) clearInterval(captureSupervisorTimer);
        if (bootstrapRetryTimer) clearInterval(bootstrapRetryTimer);
        captureSupervisorTimer = null;
        bootstrapRetryTimer = null;

        console.log(`[agent] stopping (${safeText(reason, 48)})`);
        try { await agent.stop(); } catch {}
        try { await capture.stop(); } catch {}
    }

    process.once('SIGINT', () => shutdown('SIGINT').finally(() => process.exit(0)));
    process.once('SIGTERM', () => shutdown('SIGTERM').finally(() => process.exit(0)));

    // QQ-style lifecycle:
    // 1) Keep the authenticated provider endpoint online first.
    // 2) Treat desktop runtime/WMPF as readiness state, not process lifetime.
    // 3) Re-arm capture automatically when the WMPF host appears or restarts.
    await agent.start();

    console.log('');
    console.log('FAR2 WeChat Isolated Runtime Code Agent');
    console.log(`Listen: http://${host}:${port}`);
    console.log('Lifecycle: QQ-style persistent Agent + WeChat-specific WMPF runtime adapter');
    console.log('Raw wx.login Code logging: disabled');
    console.log('');

    await ensureCaptureStarted('startup');

    captureSupervisorTimer = setInterval(() => {
        ensureCaptureStarted('supervisor').catch(() => null);
    }, 2000);

    bootstrapRetryTimer = setInterval(async () => {
        if (stopping || bootstrapRetryBusy) return;
        const status = capture.getStatus();
        if (!status || !status.started) return;
        if (status.state === 'resident_connected' || !status.connected) return;

        bootstrapRetryBusy = true;
        try {
            await capture.bootstrapConnectedRuntime();
        } catch {
            // Capture backend already exposes the state through inspectRuntime().
        } finally {
            bootstrapRetryBusy = false;
        }
    }, 2500);

    await new Promise(() => {});
}

main().catch(err => {
    console.error(`WeChat Code Agent start failed: ${safeText(err && err.message ? err.message : err)}`);
    process.exitCode = 1;
});
