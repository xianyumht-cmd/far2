'use strict';

// Temporary P5 live-gate adapter. It intentionally lives behind an explicit
// module boundary so the final FAR2-native WMPF transport can replace it
// without changing FAR2WeChatAgent / Provider / RecoveryManager contracts.

const path = require('node:path');
const { fork, spawnSync } = require('node:child_process');
const { isLikelyCode } = require('./windows-runtime-code');

const EXPECTED_APP_ID = 'wx5306c5978fdb76e4';
const EXPECTED_WMPF_VERSION = 25297;
const DEFAULT_TIMEOUT_MS = 120000;

function safeText(value, max = 160) {
  return String(value || '').replace(/\b[A-Za-z0-9_-]{32}\b/g, '[REDACTED_32]').slice(0, max);
}

function getWindowsSessionId() {
  try {
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', '(Get-Process -Id $PID).SessionId',
    ], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const value = Number(String(result.stdout || '').trim());
    return Number.isFinite(value) ? value : -1;
  } catch { return -1; }
}

function getWmpfVersion() {
  try {
    const command = [
      '$versions = @()',
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '(?i)^WeChatAppEx\\.exe$' -and $_.ExecutablePath } | ForEach-Object {",
      "  $m = [regex]::Match([string]$_.ExecutablePath, '(?i)RadiumWMPF[\\\\/](\\d+)[\\\\/]extracted')",
      '  if ($m.Success) { $versions += [int]$m.Groups[1].Value }',
      '}',
      'if ($versions.Count -gt 0) { ($versions | Sort-Object -Unique -Descending | Select-Object -First 1) }',
    ].join('; ');
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
    ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    const value = Number(String(result.stdout || '').trim());
    return Number.isFinite(value) ? value : 0;
  } catch { return 0; }
}

function createWechatDiagnosticCaptureAdapter(options = {}) {
  const processRef = options.processRef || process;
  const timeoutMs = Math.max(15000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const childScript = options.childScript || path.join(__dirname, '../../scripts/wechat-agent-diagnostic-capture-child.js');

  async function inspectRuntime() {
    const wmpfVersion = getWmpfVersion();
    return {
      available: processRef.platform === 'win32' && wmpfVersion === EXPECTED_WMPF_VERSION,
      reason: processRef.platform !== 'win32'
        ? 'unsupported_platform'
        : (wmpfVersion === EXPECTED_WMPF_VERSION ? 'ok' : 'wechat_wmpf_version_mismatch'),
      platform: 'wx',
      appId: EXPECTED_APP_ID,
      windowsSessionId: getWindowsSessionId(),
      wmpfVersion,
      clientVersion: '1.13.2.7',
      gatewayVersion: '1.13.2.7_20260723',
      profileId: '',
    };
  }

  function captureFreshCode() {
    return new Promise((resolve, reject) => {
      const child = fork(childScript, [], {
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env: { ...processRef.env },
      });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill(); } catch {}
        const err = new Error('Windows WeChat live capture timed out');
        err.code = 'wechat_capture_timeout';
        reject(err);
      }, timeoutMs);

      const finishError = (code, message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const err = new Error(safeText(message || code));
        err.code = code;
        reject(err);
      };

      child.on('message', message => {
        if (!message || message.type !== 'far2_wechat_capture') return;
        if (message.ok !== true) {
          finishError('wechat_capture_failed', message.reason || 'capture failed');
          return;
        }
        const code = String(message.code || '').trim();
        if (!isLikelyCode(code)) {
          finishError('wechat_capture_invalid_code', 'capture returned invalid Code');
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
          wmpfVersion: Number(message.wmpfVersion) || 0,
          clientVersion: String(message.clientVersion || '').trim(),
          gatewayVersion: String(message.gatewayVersion || '').trim(),
          profileId: String(message.profileId || '').trim(),
        });
      });
      child.on('error', err => finishError('wechat_capture_child_error', err && err.message));
      child.on('exit', code => {
        if (!settled && code !== 0) finishError('wechat_capture_child_exit', `capture child exited with code ${code}`);
      });
    });
  }

  return {
    name: 'diagnostic_wmpf_transport',
    inspectRuntime,
    captureFreshCode,
  };
}

module.exports = {
  EXPECTED_APP_ID,
  EXPECTED_WMPF_VERSION,
  createWechatDiagnosticCaptureAdapter,
};
