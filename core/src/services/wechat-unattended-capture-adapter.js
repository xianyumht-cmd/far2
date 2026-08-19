'use strict';

const path = require('node:path');
const { fork, spawnSync } = require('node:child_process');
const {
    EXPECTED_APP_ID,
    EXPECTED_WMPF_VERSION,
    CLIENT_VERSION,
    GATEWAY_VERSION,
    createWechatNativeWmpfCapture,
} = require('./wechat-wmpf-native-capture');
const { isLikelyCode } = require('./windows-runtime-code');

const FARM_WINDOW_TITLE = 'QQ经典农场';
const DEFAULT_TIMEOUT_MS = 180000;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
    ], {
        encoding: 'utf8',
        windowsHide: true,
        timeout,
    });
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

function invokeWechatScheme(uri) {
    const result = spawnSync('rundll32.exe', ['url.dll,FileProtocolHandler', uri], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
    });
    return !result.error && result.status === 0;
}

function buildLaunchCandidates(processRef = process) {
    const configuredPath = String(processRef.env.FARM_WECHAT_LAUNCH_PATH || '').trim().replace(/^\/+/, '');
    const candidates = [];
    if (configuredPath) {
        candidates.push({
            method: 'weixin_plain_scheme_configured_path',
            uri: `weixin://dl/business/?appid=${encodeURIComponent(EXPECTED_APP_ID)}&path=${encodeURIComponent(configuredPath)}&env_version=release`,
        });
    }
    // Do not guess a page path. Try only the app home forms; if the target
    // mini-program does not allow them, fail closed and surface that evidence.
    candidates.push({
        method: 'weixin_plain_scheme_home_no_path',
        uri: `weixin://dl/business/?appid=${encodeURIComponent(EXPECTED_APP_ID)}&env_version=release`,
    });
    candidates.push({
        method: 'weixin_plain_scheme_home_empty_path',
        uri: `weixin://dl/business/?appid=${encodeURIComponent(EXPECTED_APP_ID)}&path=&env_version=release`,
    });
    return candidates;
}

async function launchFarmUnattended(processRef = process) {
    const attempts = [];
    for (const candidate of buildLaunchCandidates(processRef)) {
        const invoked = invokeWechatScheme(candidate.uri);
        attempts.push({ method: candidate.method, invoked });
        if (!invoked) continue;
        const deadline = Date.now() + 3500;
        while (Date.now() < deadline) {
            if (isFarmWindowOpen()) {
                return { ok: true, method: candidate.method, attempts };
            }
            await sleep(250);
        }
    }
    // The WeChat protocol handler can return before WMPF creates the window.
    const finalDeadline = Date.now() + 7000;
    while (Date.now() < finalDeadline) {
        if (isFarmWindowOpen()) {
            const last = attempts.filter(item => item.invoked).slice(-1)[0];
            return { ok: true, method: last ? last.method : 'weixin_plain_scheme', attempts };
        }
        await sleep(300);
    }
    return { ok: false, method: '', attempts };
}

function createWechatUnattendedCaptureAdapter(options = {}) {
    const processRef = options.processRef || process;
    const timeoutMs = Math.max(30000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
    const childScript = options.childScript || path.join(__dirname, '../../scripts/wechat-native-unattended-capture-child.js');
    const logger = typeof options.log === 'function' ? options.log : (() => {});
    const inspector = createWechatNativeWmpfCapture({ processRef, interactive: false });
    let captureInFlight = null;
    let lastCaptureStatus = null;

    async function inspectRuntime() {
        return inspector.inspectRuntime();
    }

    function captureFreshCode() {
        if (captureInFlight) return captureInFlight;
        captureInFlight = new Promise((resolve, reject) => {
            const child = fork(childScript, [], {
                stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
                env: { ...processRef.env },
            });
            let settled = false;
            let stdoutTail = '';
            let stderrTail = '';
            let closeHandled = false;
            let launchHandled = false;
            const status = {
                farmWindowWasOpen: false,
                farmWindowClosedGracefully: false,
                launchAttempted: false,
                launchSucceeded: false,
                launchMethod: '',
                launchAttempts: [],
            };
            lastCaptureStatus = status;

            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                try { child.kill(); } catch {}
                reject(createError('wechat_native_unattended_timeout', 'FAR2-native unattended capture timed out'));
            }, timeoutMs);

            const fail = (code, message) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { child.kill(); } catch {}
                reject(createError(code, safeText(message || code)));
            };

            const writeEnter = () => {
                try { child.stdin.write('\r\n'); } catch {}
            };

            const handleClosePrompt = async () => {
                if (closeHandled || settled) return;
                closeHandled = true;
                status.farmWindowWasOpen = true;
                logger('Closing only the QQ Classic Farm mini-program window before native hook arm');
                const closed = await closeFarmWindowGracefully();
                status.farmWindowClosedGracefully = !!closed.closed;
                if (!closed.closed) {
                    fail('wechat_farm_window_close_failed', 'Could not close the farm mini-program window without terminating WeChat');
                    return;
                }
                writeEnter();
            };

            const handleLaunchPrompt = async () => {
                if (launchHandled || settled) return;
                launchHandled = true;
                status.launchAttempted = true;
                logger('Opening QQ Classic Farm through the Windows WeChat protocol handler');
                const launched = await launchFarmUnattended(processRef);
                status.launchSucceeded = !!launched.ok;
                status.launchMethod = launched.method || '';
                status.launchAttempts = (launched.attempts || []).map(item => ({ ...item }));
                // Even when the visible window check is late, let the child wait for the
                // authoritative native WMPF debug connection before declaring failure.
                writeEnter();
            };

            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', chunk => {
                stdoutTail = (stdoutTail + String(chunk || '')).slice(-8192);
                if (stdoutTail.includes('Close ONLY the farm mini-program window')) {
                    handleClosePrompt().catch(err => fail(err.code || 'wechat_farm_window_close_failed', err.message));
                }
                if (stdoutTail.includes('FAR2-native WMPF transport is ready.')) {
                    handleLaunchPrompt().catch(err => fail(err.code || 'wechat_farm_autolaunch_failed', err.message));
                }
            });
            child.stderr.on('data', chunk => {
                stderrTail = (stderrTail + String(chunk || '')).slice(-4096);
            });

            child.on('message', message => {
                if (!message || message.type !== 'far2_wechat_native_unattended_capture') return;
                if (message.ok !== true) {
                    fail(String(message.reason || 'wechat_native_unattended_capture_failed'), message.message || message.reason || stderrTail);
                    return;
                }
                const code = String(message.code || '').trim();
                if (!isLikelyCode(code)) {
                    fail('wechat_native_unattended_invalid_code', 'Native unattended capture returned an invalid Code');
                    return;
                }
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({
                    code,
                    platform: 'wx',
                    appId: EXPECTED_APP_ID,
                    windowsSessionId: Number(message.windowsSessionId),
                    wmpfVersion: Number(message.wmpfVersion) || EXPECTED_WMPF_VERSION,
                    clientVersion: String(message.clientVersion || CLIENT_VERSION),
                    gatewayVersion: String(message.gatewayVersion || GATEWAY_VERSION),
                    profileId: String(message.profileId || ''),
                    envVersion: String(message.envVersion || ''),
                    transport: 'far2_native_wmpf_unattended',
                });
            });
            child.on('error', err => fail('wechat_native_unattended_child_error', err && err.message));
            child.on('exit', code => {
                if (!settled) {
                    fail('wechat_native_unattended_child_exit', stderrTail || `capture child exited with code ${code}`);
                }
            });
        }).finally(() => {
            captureInFlight = null;
        });
        return captureInFlight;
    }

    return {
        name: 'far2_native_wmpf_unattended',
        inspectRuntime,
        captureFreshCode,
        getLastCaptureStatus: () => lastCaptureStatus ? JSON.parse(JSON.stringify(lastCaptureStatus)) : null,
    };
}

module.exports = {
    FARM_WINDOW_TITLE,
    closeFarmWindowGracefully,
    buildLaunchCandidates,
    launchFarmUnattended,
    createWechatUnattendedCaptureAdapter,
};
