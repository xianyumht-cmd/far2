'use strict';

const path = require('node:path');
const process = require('node:process');

const stageCore = String(process.env.FAR2_P8_STAGE_CORE || '').trim();
if (!stageCore) {
    console.error('FAR2_P8_STAGE_CORE is required');
    process.exit(2);
}

function stageRequire(relativePath) {
    return require(path.join(stageCore, relativePath));
}

// Install the exact Windows WeChat gateway profile before loading network.js.
stageRequire('src/services/wechat-gateway-profile.js');
const { CONFIG } = stageRequire('src/config/config.js');
const { loadProto } = stageRequire('src/utils/proto.js');
const { connect, cleanup, getWs, networkEvents } = stageRequire('src/utils/network.js');

let started = false;
let loginReady = false;
let stopping = false;
let loginTimer = null;
let onWsError = null;
let onKickout = null;

function send(message) {
    if (process.send) {
        try { process.send(message); } catch {}
    }
}

function finishStop(code = 0) {
    if (stopping) return;
    stopping = true;
    if (loginTimer) clearTimeout(loginTimer);
    loginTimer = null;
    if (onWsError) networkEvents.off('ws_error', onWsError);
    if (onKickout) networkEvents.off('kickout', onKickout);
    try { cleanup(); } catch {}
    const ws = getWs();
    if (ws) {
        try { ws.close(); } catch {}
    }
    setTimeout(() => process.exit(code), 20).unref();
}

async function startLoginOnly(config = {}) {
    if (started) return;
    started = true;
    const code = String(config.code || '').trim();
    if (!code) {
        send({ type: 'login_failed', reason: 'missing_code' });
        return finishStop(3);
    }

    CONFIG.platform = 'wx';
    await loadProto();

    onWsError = (payload) => {
        send({
            type: 'ws_error',
            code: Number(payload && payload.code) || 0,
            reason: 'gateway_ws_error',
        });
    };
    onKickout = () => {
        send({ type: 'login_failed', reason: 'account_kicked' });
    };
    networkEvents.on('ws_error', onWsError);
    networkEvents.on('kickout', onKickout);

    loginTimer = setTimeout(() => {
        if (loginReady) return;
        send({ type: 'login_failed', reason: 'login_timeout' });
        finishStop(4);
    }, 30000);

    connect(code, () => {
        if (loginReady) return;
        loginReady = true;
        if (loginTimer) clearTimeout(loginTimer);
        loginTimer = null;
        send({
            type: 'login_ready',
            platform: 'wx',
            clientVersion: String(CONFIG.clientVersion || ''),
        });
    });
}

process.on('message', (msg) => {
    const payload = msg && typeof msg === 'object' ? msg : {};
    if (payload.type === 'start') {
        startLoginOnly(payload.config || {}).catch(() => {
            send({ type: 'login_failed', reason: 'login_exception' });
            finishStop(5);
        });
        return;
    }
    if (payload.type === 'stop') {
        finishStop(0);
    }
});

process.once('SIGINT', () => finishStop(0));
process.once('SIGTERM', () => finishStop(0));

send({ type: 'worker_ready' });
