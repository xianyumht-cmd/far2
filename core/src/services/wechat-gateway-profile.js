'use strict';

const { CONFIG } = require('../config/config');

const wsPath = require.resolve('ws');
const OriginalWebSocket = require(wsPath);

const FARM_GATEWAY_HOST = 'gate-obt.nqf.qq.com';
const FARM_GATEWAY_PATH = '/prod/ws';
const DEFAULT_WX_CLIENT_VERSION = '1.13.2.7';
const DEFAULT_WX_GATEWAY_VERSION = '1.13.2.7_20260723';
const DEFAULT_WX_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf2541c1a) XWEB/25297';
const DEFAULT_ORIGIN = 'https://gate-obt.nqf.qq.com';

function getWxProfile(processRef = process) {
    return {
        clientVersion: String(processRef.env.FARM_WECHAT_CLIENT_VERSION || DEFAULT_WX_CLIENT_VERSION).trim() || DEFAULT_WX_CLIENT_VERSION,
        gatewayVersion: String(processRef.env.FARM_WECHAT_GATEWAY_VERSION || DEFAULT_WX_GATEWAY_VERSION).trim() || DEFAULT_WX_GATEWAY_VERSION,
        userAgent: String(processRef.env.FARM_WECHAT_USER_AGENT || DEFAULT_WX_USER_AGENT).trim() || DEFAULT_WX_USER_AGENT,
        origin: String(processRef.env.FARM_WECHAT_GATEWAY_ORIGIN || DEFAULT_ORIGIN).trim() || DEFAULT_ORIGIN,
    };
}

function isTargetWechatGateway(rawUrl) {
    try {
        const url = new URL(String(rawUrl || ''));
        return url.protocol === 'wss:'
            && url.hostname.toLowerCase() === FARM_GATEWAY_HOST
            && url.pathname === FARM_GATEWAY_PATH
            && String(url.searchParams.get('platform') || '').toLowerCase() === 'wx';
    } catch {
        return false;
    }
}

function rewriteGatewayArgs(args, processRef = process) {
    const next = Array.from(args || []);
    const rawUrl = String(next[0] || '');
    if (!isTargetWechatGateway(rawUrl)) return next;

    const profile = getWxProfile(processRef);
    const url = new URL(rawUrl);
    url.searchParams.set('platform', 'wx');
    url.searchParams.set('os', 'Windows');
    url.searchParams.set('ver', profile.gatewayVersion);
    url.searchParams.delete('openID');
    url.searchParams.delete('openid');
    next[0] = url.toString();

    let optionsIndex = -1;
    if (next[1] && typeof next[1] === 'object' && !Array.isArray(next[1])) optionsIndex = 1;
    else if (next[2] && typeof next[2] === 'object' && !Array.isArray(next[2])) optionsIndex = 2;

    const headers = {
        Origin: profile.origin,
        'User-Agent': profile.userAgent,
    };
    if (optionsIndex === -1) {
        next[1] = { headers };
    } else {
        const options = { ...next[optionsIndex] };
        options.headers = { ...(options.headers || {}), ...headers };
        next[optionsIndex] = options;
    }

    // P4 proved that the gateway URL version and LoginRequest device version are
    // different on Windows WeChat. Keep the proven mini-program version for the
    // LoginRequest/Heartbeat body while the URL uses the build-suffixed version.
    CONFIG.platform = 'wx';
    CONFIG.os = 'Windows';
    CONFIG.clientVersion = profile.clientVersion;

    return next;
}

const marker = Symbol.for('far2.wechat.gateway-profile');
if (!OriginalWebSocket[marker]) {
    Object.defineProperty(OriginalWebSocket, marker, {
        value: true,
        enumerable: false,
        configurable: false,
        writable: false,
    });

    const PatchedWebSocket = new Proxy(OriginalWebSocket, {
        construct(target, args) {
            return Reflect.construct(target, rewriteGatewayArgs(args), target);
        },
        apply(target, thisArg, args) {
            return Reflect.apply(target, thisArg, rewriteGatewayArgs(args));
        },
    });

    require.cache[wsPath].exports = PatchedWebSocket;
}

module.exports = {
    FARM_GATEWAY_HOST,
    FARM_GATEWAY_PATH,
    DEFAULT_WX_CLIENT_VERSION,
    DEFAULT_WX_GATEWAY_VERSION,
    DEFAULT_WX_USER_AGENT,
    DEFAULT_ORIGIN,
    getWxProfile,
    isTargetWechatGateway,
    rewriteGatewayArgs,
};
