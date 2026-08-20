'use strict';

// P4 diagnostic preload based on P4B official Windows WeChat handshake evidence.
// It changes only the outbound WebSocket handshake metadata for the exact farm
// gateway. It does not inspect or persist the login Code or frame payload.

const fs = require('node:fs');
const wsPath = require.resolve('ws');
const OriginalWebSocket = require(wsPath);

const TARGET_PREFIX = 'wss://gate-obt.nqf.qq.com/prod/ws';
const OFFICIAL_OS = 'Windows';
const OFFICIAL_GATEWAY_VERSION = '1.13.2.7_20260723';
const OFFICIAL_ORIGIN = 'https://gate-obt.nqf.qq.com';
const OFFICIAL_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf2541c1a) XWEB/25297';

const marker = Symbol.for('far2.wechat.p4.official-handshake-profile');
const reportMarker = Symbol.for('far2.wechat.p4.official-handshake-report');

if (!OriginalWebSocket[marker]) {
  Object.defineProperty(OriginalWebSocket, marker, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  function rewriteArgs(args) {
    const next = Array.from(args);
    const rawUrl = String(next[0] || '');
    if (!rawUrl.startsWith(TARGET_PREFIX)) return next;

    const url = new URL(rawUrl);
    url.searchParams.set('platform', 'wx');
    url.searchParams.set('os', OFFICIAL_OS);
    url.searchParams.set('ver', OFFICIAL_GATEWAY_VERSION);
    url.searchParams.delete('openID');
    url.searchParams.delete('openid');
    next[0] = url.toString();

    let optionsIndex = -1;
    if (next[1] && typeof next[1] === 'object' && !Array.isArray(next[1])) optionsIndex = 1;
    else if (next[2] && typeof next[2] === 'object' && !Array.isArray(next[2])) optionsIndex = 2;

    if (optionsIndex === -1) {
      next[1] = { headers: { Origin: OFFICIAL_ORIGIN, 'User-Agent': OFFICIAL_USER_AGENT } };
    } else {
      const options = { ...next[optionsIndex] };
      options.headers = {
        ...(options.headers || {}),
        Origin: OFFICIAL_ORIGIN,
        'User-Agent': OFFICIAL_USER_AGENT,
      };
      next[optionsIndex] = options;
    }

    return next;
  }

  const PatchedWebSocket = new Proxy(OriginalWebSocket, {
    construct(target, args) {
      return Reflect.construct(target, rewriteArgs(args), target);
    },
    apply(target, thisArg, args) {
      return Reflect.apply(target, thisArg, rewriteArgs(args));
    },
  });

  require.cache[wsPath].exports = PatchedWebSocket;
}

if (!fs[reportMarker]) {
  const originalWriteFileSync = fs.writeFileSync.bind(fs);
  Object.defineProperty(fs, reportMarker, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  fs.writeFileSync = function far2P4WriteReport(file, data, ...rest) {
    let nextData = data;
    const fileText = String(file || '');
    if (fileText.includes('wechat-farm-p4-e2e-') && typeof data === 'string') {
      try {
        const parsed = JSON.parse(data);
        if (parsed && parsed.phase === 'wechat-farm-p4-e2e-login-gate' && parsed.gateway) {
          parsed.gateway.os = OFFICIAL_OS;
          parsed.gateway.clientVersion = OFFICIAL_GATEWAY_VERSION;
          parsed.gateway.openIdQueryPresent = false;
          parsed.gateway.handshakeProfile = 'p4b-observed-windows-wechat-25297';
          parsed.gateway.userAgentProfile = 'Chrome144+UnifiedPCWindowsWechat+XWEB25297';
          nextData = JSON.stringify(parsed, null, 2);
        }
      } catch {}
    }
    return originalWriteFileSync(file, nextData, ...rest);
  };
}
