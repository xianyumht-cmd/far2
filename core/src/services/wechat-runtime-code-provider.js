'use strict';

const process = require('node:process');
const fetch = require('node-fetch');
const { isLikelyCode } = require('./windows-runtime-code');

const EXPECTED_APP_ID = 'wx5306c5978fdb76e4';
const DEFAULT_BASE_URL = 'http://127.0.0.1:43201/';
const DEFAULT_HEALTH_TIMEOUT_MS = 15000;
const DEFAULT_REFRESH_TIMEOUT_MS = 90000;
const MAX_RESPONSE_BYTES = 64 * 1024;

function createProviderError(code, message = code) {
    const err = new Error(message);
    err.code = code;
    return err;
}

function isLoopbackHostname(hostname) {
    const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost'
        || host === '::1'
        || host === '0:0:0:0:0:0:0:1'
        || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function normalizeBaseUrl(value, allowInsecureRemote) {
    let url;
    try {
        url = new URL(String(value || '').trim() || DEFAULT_BASE_URL);
    } catch {
        throw createProviderError('wechat_provider_url_invalid', 'WeChat Provider endpoint URL 无效');
    }
    if (url.username || url.password) {
        throw createProviderError('wechat_provider_url_credentials_forbidden', 'WeChat Provider URL 禁止内嵌凭据');
    }
    if (url.protocol === 'https:') return url;
    if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) return url;
    if (url.protocol === 'http:' && allowInsecureRemote) return url;
    throw createProviderError('wechat_provider_insecure_endpoint', '远程 WeChat Provider 必须使用 HTTPS');
}

function endpointUrl(baseUrl, route) {
    const base = new URL(baseUrl.toString());
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    return new URL(String(route || '').replace(/^\/+/, ''), base).toString();
}

function safeReason(value, fallback) {
    const text = String(value || '').trim().toLowerCase();
    if (text && text.length <= 96 && /^[a-z0-9_.:-]+$/.test(text)) return text;
    return fallback;
}

async function readJsonResponse(response) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
        throw createProviderError('wechat_provider_response_too_large', 'WeChat Provider 响应过大');
    }
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        throw createProviderError('wechat_provider_response_invalid', 'WeChat Provider 返回无效 JSON');
    }
}

async function requestJson(fetchImpl, url, options = {}) {
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_HEALTH_TIMEOUT_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const headers = {
            Accept: 'application/json',
            Authorization: `Bearer ${options.token}`,
            'Cache-Control': 'no-store',
        };
        let body;
        if (options.body !== undefined) {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(options.body);
        }
        const response = await fetchImpl(url, {
            method: options.method || 'GET',
            headers,
            body,
            signal: controller.signal,
        });
        const data = await readJsonResponse(response);
        return { response, data };
    } catch (err) {
        if (err && err.name === 'AbortError') {
            throw createProviderError('wechat_provider_timeout', 'WeChat Provider 请求超时');
        }
        if (err && err.code) throw err;
        throw createProviderError('wechat_provider_network_error', 'WeChat Provider 网络请求失败');
    } finally {
        clearTimeout(timer);
    }
}

function normalizeMetadata(data) {
    const source = data && typeof data === 'object' ? data : {};
    return {
        platform: String(source.platform || '').toLowerCase(),
        appId: String(source.appId || ''),
        windowsSessionId: Number(source.windowsSessionId),
        wmpfVersion: Number(source.wmpfVersion) || 0,
        clientVersion: String(source.clientVersion || source.appVersion || '').trim(),
        gatewayVersion: String(source.gatewayVersion || '').trim(),
        profileId: String(source.profileId || '').trim().slice(0, 96),
    };
}

function createWechatRuntimeCodeProvider(options = {}) {
    const processRef = options.processRef || process;
    const fetchImpl = options.fetchImpl || fetch;
    const token = String(options.token || processRef.env.FARM_WECHAT_CODE_PROVIDER_TOKEN || '').trim();
    const allowInsecureRemote = options.allowInsecureRemote === true
        || String(processRef.env.FARM_WECHAT_CODE_PROVIDER_ALLOW_INSECURE_REMOTE || '0') === '1';
    const baseUrl = normalizeBaseUrl(
        options.baseUrl || processRef.env.FARM_WECHAT_CODE_PROVIDER_URL || DEFAULT_BASE_URL,
        allowInsecureRemote,
    );
    const healthTimeoutMs = Math.max(
        1000,
        Number(options.healthTimeoutMs || processRef.env.FARM_WECHAT_CODE_PROVIDER_HEALTH_TIMEOUT_MS) || DEFAULT_HEALTH_TIMEOUT_MS,
    );
    const refreshTimeoutMs = Math.max(
        5000,
        Number(options.refreshTimeoutMs || processRef.env.FARM_WECHAT_CODE_PROVIDER_REFRESH_TIMEOUT_MS) || DEFAULT_REFRESH_TIMEOUT_MS,
    );

    if (token.length < 24) {
        throw createProviderError('wechat_provider_token_invalid', 'FARM_WECHAT_CODE_PROVIDER_TOKEN 至少需要 24 个字符');
    }

    async function getHealth() {
        const { response, data } = await requestJson(
            fetchImpl,
            endpointUrl(baseUrl, 'v1/health'),
            { token, timeoutMs: healthTimeoutMs },
        );
        if (!response.ok) {
            return { available: false, reason: `wechat_provider_health_http_${response.status}` };
        }
        const meta = normalizeMetadata(data);
        if (meta.platform !== 'wx') return { available: false, reason: 'wechat_provider_platform_mismatch' };
        if (meta.appId !== EXPECTED_APP_ID) return { available: false, reason: 'wechat_provider_appid_mismatch' };
        if (!data || data.ok !== true || data.available !== true) {
            return {
                available: false,
                reason: safeReason(data && data.reason, 'wechat_provider_not_ready'),
                ...meta,
            };
        }
        return { available: true, reason: 'ok', ...meta };
    }

    return {
        name: 'windows_wechat_runtime',
        platform: 'wx',

        async getAvailability(account) {
            if (String(account && account.platform || '').toLowerCase() !== 'wx') {
                return { available: false, reason: 'wechat_provider_wrong_platform' };
            }
            try {
                return await getHealth();
            } catch (err) {
                return {
                    available: false,
                    reason: err && err.code ? err.code : 'wechat_provider_health_failed',
                };
            }
        },

        async refresh({ account, reason }) {
            if (String(account && account.platform || '').toLowerCase() !== 'wx') {
                throw createProviderError('wechat_provider_wrong_platform', 'WeChat Provider 只处理 platform=wx');
            }
            const { response, data } = await requestJson(
                fetchImpl,
                endpointUrl(baseUrl, 'v1/code/refresh'),
                {
                    method: 'POST',
                    token,
                    timeoutMs: refreshTimeoutMs,
                    body: {
                        accountId: String(account && account.id || ''),
                        appId: EXPECTED_APP_ID,
                        reason: String(reason || 'scheduled').slice(0, 96),
                    },
                },
            );
            if (!response.ok) {
                const agentReason = safeReason(data && data.reason, `wechat_provider_refresh_http_${response.status}`);
                throw createProviderError(agentReason, `WeChat Provider 刷新失败 (${agentReason})`);
            }
            const meta = normalizeMetadata(data);
            if (meta.platform !== 'wx') throw createProviderError('wechat_provider_platform_mismatch', 'Provider platform 不匹配');
            if (meta.appId !== EXPECTED_APP_ID) throw createProviderError('wechat_provider_appid_mismatch', 'Provider AppId 不匹配');
            if (!data || data.ok !== true) {
                const agentReason = safeReason(data && data.reason, 'wechat_provider_refresh_failed');
                throw createProviderError(agentReason, `WeChat Provider 未能生成 fresh Code (${agentReason})`);
            }
            const code = String(data.code || '').trim();
            if (!isLikelyCode(code)) {
                throw createProviderError('wechat_provider_invalid_code', 'WeChat Provider 返回的 Code 格式无效');
            }
            return {
                code,
                source: 'windows_wechat_runtime',
                clientVersion: meta.clientVersion,
                gatewayVersion: meta.gatewayVersion,
                windowsSessionId: meta.windowsSessionId,
                wmpfVersion: meta.wmpfVersion,
                profileId: meta.profileId,
                appId: meta.appId,
            };
        },
    };
}

function createWechatRuntimeCodeProviderFromEnv(options = {}) {
    const processRef = options.processRef || process;
    const token = String(processRef.env.FARM_WECHAT_CODE_PROVIDER_TOKEN || '').trim();
    const url = String(processRef.env.FARM_WECHAT_CODE_PROVIDER_URL || '').trim();
    if (!token && !url) return null;
    return createWechatRuntimeCodeProvider({ ...options, processRef });
}

module.exports = {
    EXPECTED_APP_ID,
    DEFAULT_BASE_URL,
    createWechatRuntimeCodeProvider,
    createWechatRuntimeCodeProviderFromEnv,
    isLoopbackHostname,
};
