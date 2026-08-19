'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const process = require('node:process');
const { isLikelyCode } = require('./windows-runtime-code');

const EXPECTED_APP_ID = 'wx5306c5978fdb76e4';
const DEFAULT_PORT = 43201;
const MAX_BODY_BYTES = 8 * 1024;

function isLoopbackHost(value) {
    const host = String(value || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost'
        || host === '::1'
        || host === '0:0:0:0:0:0:0:1'
        || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function safeEqual(left, right) {
    const a = Buffer.from(String(left || ''), 'utf8');
    const b = Buffer.from(String(right || ''), 'utf8');
    if (!a.length || a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function bearerToken(req) {
    const raw = String(req.headers.authorization || '');
    const match = raw.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload || {});
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store, max-age=0',
        Pragma: 'no-cache',
        'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                const err = new Error('request body too large');
                err.code = 'request_body_too_large';
                reject(err);
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (!chunks.length) return resolve({});
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
                const err = new Error('invalid json');
                err.code = 'invalid_json';
                reject(err);
            }
        });
        req.on('error', reject);
    });
}

function normalizeRuntimeMeta(input = {}) {
    const data = input && typeof input === 'object' ? input : {};
    return {
        platform: 'wx',
        appId: EXPECTED_APP_ID,
        windowsSessionId: Number.isFinite(Number(data.windowsSessionId)) ? Number(data.windowsSessionId) : -1,
        wmpfVersion: Number(data.wmpfVersion) || 0,
        clientVersion: String(data.clientVersion || data.appVersion || '').trim(),
        gatewayVersion: String(data.gatewayVersion || '').trim(),
        profileId: String(data.profileId || '').trim().slice(0, 96),
    };
}

function createWechatCodeAgent(options = {}) {
    const processRef = options.processRef || process;
    const token = String(options.token || processRef.env.FAR2_WECHAT_AGENT_TOKEN || '').trim();
    const host = String(options.host || processRef.env.FAR2_WECHAT_AGENT_HOST || '127.0.0.1').trim();
    const port = Math.max(1, Math.min(65535, Number(options.port || processRef.env.FAR2_WECHAT_AGENT_PORT) || DEFAULT_PORT));
    const allowInsecureRemote = options.allowInsecureRemote === true
        || String(processRef.env.FAR2_WECHAT_AGENT_ALLOW_INSECURE_REMOTE || '0') === '1';
    const inspectRuntime = typeof options.inspectRuntime === 'function'
        ? options.inspectRuntime
        : async () => ({ available: false, reason: 'wechat_capture_backend_pending' });
    const captureFreshCode = typeof options.captureFreshCode === 'function'
        ? options.captureFreshCode
        : null;
    const logger = typeof options.log === 'function' ? options.log : (() => {});

    if (processRef.platform !== 'win32') throw new Error('FAR2WeChatAgent 仅支持 Windows');
    if (token.length < 24) throw new Error('FAR2_WECHAT_AGENT_TOKEN 至少需要 24 个字符');
    if (!isLoopbackHost(host) && !allowInsecureRemote) {
        throw new Error('FAR2WeChatAgent 默认只允许 loopback；远程必须使用 HTTPS/VPN 或显式开启不安全远程');
    }

    let server = null;
    let refreshInFlight = null;

    async function inspect() {
        try {
            const runtime = await inspectRuntime();
            const meta = normalizeRuntimeMeta(runtime);
            return {
                ok: true,
                available: !!(runtime && runtime.available),
                reason: String(runtime && runtime.reason || (runtime && runtime.available ? 'ok' : 'wechat_runtime_not_ready')).slice(0, 96),
                ...meta,
            };
        } catch (err) {
            return {
                ok: true,
                available: false,
                reason: err && err.code ? String(err.code) : 'wechat_runtime_inspect_failed',
                ...normalizeRuntimeMeta(),
            };
        }
    }

    async function refresh(reason) {
        if (!captureFreshCode) {
            const err = new Error('FAR2WeChatAgent capture backend 尚未配置');
            err.code = 'wechat_capture_backend_pending';
            throw err;
        }
        if (refreshInFlight) return refreshInFlight;
        refreshInFlight = (async () => {
            const result = await captureFreshCode({ reason: String(reason || 'provider').slice(0, 96) });
            const code = String(result && result.code || '').trim();
            if (!isLikelyCode(code)) {
                const err = new Error('wx.login 未返回有效 fresh Code');
                err.code = 'wechat_capture_invalid_code';
                throw err;
            }
            return {
                code,
                ...normalizeRuntimeMeta(result),
            };
        })().finally(() => {
            refreshInFlight = null;
        });
        return refreshInFlight;
    }

    async function handle(req, res) {
        if (!safeEqual(bearerToken(req), token)) {
            sendJson(res, 401, { ok: false, reason: 'unauthorized' });
            return;
        }

        const url = new URL(req.url || '/', `http://${host}:${port}`);
        if (req.method === 'GET' && url.pathname === '/v1/health') {
            sendJson(res, 200, await inspect());
            return;
        }

        if (req.method === 'POST' && url.pathname === '/v1/code/refresh') {
            let body;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                sendJson(res, 400, { ok: false, reason: err && err.code ? err.code : 'invalid_request' });
                return;
            }
            if (String(body && body.appId || '') !== EXPECTED_APP_ID) {
                sendJson(res, 409, { ok: false, reason: 'wechat_appid_mismatch' });
                return;
            }
            try {
                const result = await refresh(body && body.reason);
                sendJson(res, 200, {
                    ok: true,
                    code: result.code,
                    platform: 'wx',
                    appId: EXPECTED_APP_ID,
                    windowsSessionId: result.windowsSessionId,
                    wmpfVersion: result.wmpfVersion,
                    clientVersion: result.clientVersion,
                    gatewayVersion: result.gatewayVersion,
                    profileId: result.profileId,
                });
            } catch (err) {
                const reason = err && err.code ? String(err.code) : 'wechat_capture_failed';
                logger(`WeChat Code refresh failed: ${reason}`);
                sendJson(res, 503, { ok: false, reason });
            }
            return;
        }

        sendJson(res, 404, { ok: false, reason: 'not_found' });
    }

    async function start() {
        if (server) return { host, port };
        server = http.createServer((req, res) => {
            handle(req, res).catch(() => sendJson(res, 500, { ok: false, reason: 'internal_error' }));
        });
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, host, () => {
                server.off('error', reject);
                resolve();
            });
        });
        logger(`FAR2WeChatAgent listening on ${host}:${port}`);
        return { host, port };
    }

    async function stop() {
        if (!server) return;
        const current = server;
        server = null;
        await new Promise(resolve => current.close(() => resolve()));
    }

    return {
        name: 'FAR2WeChatAgent',
        host,
        port,
        inspect,
        refresh,
        start,
        stop,
    };
}

module.exports = {
    EXPECTED_APP_ID,
    DEFAULT_PORT,
    createWechatCodeAgent,
    isLoopbackHost,
};
