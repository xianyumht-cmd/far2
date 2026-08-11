const http = require('node:http');
const crypto = require('node:crypto');
const process = require('node:process');
const desktopSessions = require('./desktop-session-registry');
const windowsRuntimeCode = require('./windows-runtime-code');

const DEFAULT_PORT = 43101;
const DEFAULT_CAPTURE_TIMEOUT_MS = 90000;
const DEFAULT_IDENTITY_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 8 * 1024;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeUin(value) {
    const text = String(value || '').trim();
    return /^\d{5,12}$/.test(text) ? text : '';
}

function maskUin(value) {
    const text = normalizeUin(value);
    if (!text) return '';
    if (text.length <= 4) return '****';
    return `${text.slice(0, 2)}****${text.slice(-2)}`;
}

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

function getBearerToken(req) {
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

function getRegistrySnapshot(registry) {
    if (!registry || typeof registry.getProcessSnapshot !== 'function') return null;
    try {
        const rows = registry.getProcessSnapshot();
        return Array.isArray(rows) ? rows : null;
    } catch {
        return null;
    }
}

function inspectIsolatedRuntime(options = {}) {
    const expectedUin = normalizeUin(options.expectedUin);
    const processRef = options.processRef || process;
    const registry = options.desktopSessionRegistry || desktopSessions;
    const runtimeCode = options.windowsRuntimeCode || windowsRuntimeCode;

    if (processRef.platform !== 'win32') {
        return { available: false, reason: 'unsupported_platform', qqUin: expectedUin };
    }
    if (!expectedUin) {
        return { available: false, reason: 'agent_uin_invalid', qqUin: '' };
    }

    let windowsSessionId = -1;
    let mainQqProcesses = [];
    let farmSessions = [];
    try {
        const rows = getRegistrySnapshot(registry);
        windowsSessionId = Number(registry.getCurrentWindowsSessionId(rows || undefined));
        mainQqProcesses = registry.scanMainQqProcesses(rows || undefined)
            .filter(item => Number(item.windowsSessionId) === windowsSessionId);
        farmSessions = registry.scanRuntimeSessions(rows || undefined)
            .filter(item => Number(item.windowsSessionId) === windowsSessionId);
    } catch {
        return { available: false, reason: 'agent_session_scan_failed', qqUin: expectedUin };
    }

    if (!Number.isFinite(windowsSessionId) || windowsSessionId < 0) {
        return { available: false, reason: 'agent_windows_session_unknown', qqUin: expectedUin };
    }
    if (mainQqProcesses.length === 0) {
        return {
            available: false,
            reason: 'agent_qq_not_running',
            qqUin: expectedUin,
            windowsSessionId,
        };
    }
    if (mainQqProcesses.length !== 1) {
        return {
            available: false,
            reason: 'agent_multiple_qq_in_session',
            qqUin: expectedUin,
            windowsSessionId,
        };
    }

    const knownMainUin = normalizeUin(mainQqProcesses[0].qqUin);
    if (knownMainUin && knownMainUin !== expectedUin) {
        return {
            available: false,
            reason: 'agent_runtime_identity_mismatch',
            qqUin: expectedUin,
            windowsSessionId,
        };
    }

    for (const session of farmSessions) {
        const runtimeUin = normalizeUin(session.qqUin);
        if (runtimeUin && runtimeUin !== expectedUin) {
            return {
                available: false,
                reason: 'agent_runtime_identity_mismatch',
                qqUin: expectedUin,
                windowsSessionId,
            };
        }
    }

    let farmCacheCount = 0;
    try {
        farmCacheCount = runtimeCode.findFarmFolders().length;
    } catch {
        farmCacheCount = 0;
    }
    if (!farmCacheCount) {
        return {
            available: false,
            reason: 'missing_miniapp_cache',
            qqUin: expectedUin,
            windowsSessionId,
        };
    }

    return {
        available: true,
        reason: 'ok',
        qqUin: expectedUin,
        windowsSessionId,
        mainQqPid: Number(mainQqProcesses[0].mainQqPid || 0),
        farmRuntimeSeen: farmSessions.some(item => normalizeUin(item.qqUin) === expectedUin),
        farmCacheCount,
    };
}

async function waitForCapturedRuntimeIdentity(options = {}) {
    const expectedUin = normalizeUin(options.expectedUin);
    const windowsSessionId = Number(options.windowsSessionId);
    const registry = options.desktopSessionRegistry || desktopSessions;
    const timeoutMs = Math.max(500, Number(options.timeoutMs) || DEFAULT_IDENTITY_TIMEOUT_MS);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        let sessions = [];
        try {
            const rows = getRegistrySnapshot(registry);
            sessions = registry.scanRuntimeSessions(rows || undefined)
                .filter(item => Number(item.windowsSessionId) === windowsSessionId);
        } catch {}

        const knownUins = sessions.map(item => normalizeUin(item.qqUin)).filter(Boolean);
        if (knownUins.some(uin => uin !== expectedUin)) {
            return { ok: false, reason: 'agent_capture_identity_mismatch' };
        }
        if (knownUins.includes(expectedUin)) {
            return { ok: true, reason: 'ok' };
        }
        await sleep(150);
    }
    return { ok: false, reason: 'agent_capture_identity_unverified' };
}

function createIsolatedCodeAgent(options = {}) {
    const processRef = options.processRef || process;
    const registry = options.desktopSessionRegistry || desktopSessions;
    const runtimeCode = options.windowsRuntimeCode || windowsRuntimeCode;
    const expectedUin = normalizeUin(options.expectedUin || processRef.env.FAR2_CODE_AGENT_UIN);
    const token = String(options.token || processRef.env.FAR2_CODE_AGENT_TOKEN || '').trim();
    const host = String(options.host || processRef.env.FAR2_CODE_AGENT_HOST || '127.0.0.1').trim();
    const port = Math.max(1, Math.min(65535, Number(options.port || processRef.env.FAR2_CODE_AGENT_PORT) || DEFAULT_PORT));
    const captureTimeoutMs = Math.max(
        5000,
        Number(options.captureTimeoutMs || processRef.env.FAR2_CODE_AGENT_CAPTURE_TIMEOUT_MS) || DEFAULT_CAPTURE_TIMEOUT_MS,
    );
    const identityTimeoutMs = Math.max(
        500,
        Number(options.identityTimeoutMs || processRef.env.FAR2_CODE_AGENT_IDENTITY_TIMEOUT_MS) || DEFAULT_IDENTITY_TIMEOUT_MS,
    );
    const allowInsecureRemote = options.allowInsecureRemote === true
        || String(processRef.env.FAR2_CODE_AGENT_ALLOW_INSECURE_REMOTE || '0') === '1';
    const logger = typeof options.log === 'function' ? options.log : console.log;

    if (processRef.platform !== 'win32') {
        throw new Error('isolated Code Agent 仅支持 Windows');
    }
    if (!expectedUin) throw new Error('FAR2_CODE_AGENT_UIN 必须是有效 QQ UIN');
    if (token.length < 24) throw new Error('FAR2_CODE_AGENT_TOKEN 至少需要 24 个字符');
    if (!isLoopbackHost(host) && !allowInsecureRemote) {
        throw new Error('Code Agent 内置 HTTP 服务默认只允许 loopback；远程场景请使用 HTTPS 反向代理/VPN，或显式启用 FAR2_CODE_AGENT_ALLOW_INSECURE_REMOTE=1');
    }

    let refreshInFlight = null;

    function inspect() {
        return inspectIsolatedRuntime({
            expectedUin,
            processRef,
            desktopSessionRegistry: registry,
            windowsRuntimeCode: runtimeCode,
        });
    }

    async function refresh(reason) {
        if (refreshInFlight) return refreshInFlight;
        refreshInFlight = (async () => {
            const preflight = inspect();
            if (!preflight.available) {
                const err = new Error(preflight.reason);
                err.code = preflight.reason;
                throw err;
            }

            logger(`[FAR2 Code Agent] refresh start qq=${maskUin(expectedUin)} reason=${String(reason || 'manual').slice(0, 64)}`);
            const captured = await runtimeCode.captureFreshFarmCode({
                timeoutMs: captureTimeoutMs,
                closeDelayMs: Math.max(3500, identityTimeoutMs + 750),
                log: message => logger(`[FAR2 Code Agent] ${message}`),
            });

            const identity = await waitForCapturedRuntimeIdentity({
                expectedUin,
                windowsSessionId: preflight.windowsSessionId,
                desktopSessionRegistry: registry,
                timeoutMs: identityTimeoutMs,
            });
            if (!identity.ok) {
                const err = new Error(identity.reason);
                err.code = identity.reason;
                throw err;
            }
            logger(`[FAR2 Code Agent] refresh ok qq=${maskUin(expectedUin)} source=${captured.source || 'runtime'}`);
            return captured;
        })().finally(() => {
            refreshInFlight = null;
        });
        return refreshInFlight;
    }

    const server = http.createServer(async (req, res) => {
        res.setHeader('Connection', 'close');
        if (!safeEqual(getBearerToken(req), token)) {
            sendJson(res, 401, { ok: false, reason: 'unauthorized' });
            return;
        }

        const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
        if (req.method === 'GET' && requestUrl.pathname === '/v1/health') {
            const status = inspect();
            sendJson(res, 200, {
                ok: true,
                service: 'far2-isolated-code-agent',
                qqUin: expectedUin,
                available: status.available === true,
                reason: status.reason,
                windowsSessionId: status.windowsSessionId,
                farmRuntimeSeen: status.farmRuntimeSeen === true,
            });
            return;
        }

        if (req.method === 'POST' && requestUrl.pathname === '/v1/code/refresh') {
            let body;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                sendJson(res, err && err.code === 'request_body_too_large' ? 413 : 400, {
                    ok: false,
                    reason: err && err.code ? err.code : 'invalid_request',
                    qqUin: expectedUin,
                });
                return;
            }

            const requestedUin = normalizeUin(body && body.qqUin);
            if (!requestedUin || requestedUin !== expectedUin) {
                sendJson(res, 409, {
                    ok: false,
                    reason: 'requested_uin_mismatch',
                    qqUin: expectedUin,
                });
                return;
            }

            try {
                const captured = await refresh(body && body.reason);
                sendJson(res, 200, {
                    ok: true,
                    reason: 'ok',
                    qqUin: expectedUin,
                    code: String(captured.code || ''),
                    source: 'windows_qq_runtime',
                });
            } catch (err) {
                const reason = err && err.code ? String(err.code) : 'capture_failed';
                logger(`[FAR2 Code Agent] refresh failed qq=${maskUin(expectedUin)} reason=${reason}`);
                sendJson(res, 503, {
                    ok: false,
                    reason,
                    qqUin: expectedUin,
                });
            }
            return;
        }

        sendJson(res, 404, { ok: false, reason: 'not_found' });
    });

    return {
        expectedUin,
        host,
        port,
        inspect,
        refresh,
        server,
        start() {
            return new Promise((resolve, reject) => {
                const onError = err => {
                    server.off('listening', onListening);
                    reject(err);
                };
                const onListening = () => {
                    server.off('error', onError);
                    resolve(server.address());
                };
                server.once('error', onError);
                server.once('listening', onListening);
                server.listen(port, host);
            });
        },
        stop() {
            return new Promise(resolve => server.close(() => resolve()));
        },
    };
}

module.exports = {
    createIsolatedCodeAgent,
    inspectIsolatedRuntime,
    waitForCapturedRuntimeIdentity,
    normalizeUin,
    isLoopbackHost,
};