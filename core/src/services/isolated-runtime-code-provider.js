const process = require('node:process');
const fetch = require('node-fetch');
const { isLikelyCode } = require('./windows-runtime-code');

const DEFAULT_HEALTH_TIMEOUT_MS = 20000;
const DEFAULT_REFRESH_TIMEOUT_MS = 120000;
const MAX_RESPONSE_BYTES = 64 * 1024;

function normalizeUin(value) {
    const text = String(value || '').trim();
    return /^\d{5,12}$/.test(text) ? text : '';
}

function createProviderError(code, message = code) {
    const err = new Error(message);
    err.code = code;
    return err;
}

function safeReason(value, fallback) {
    const text = String(value || '').trim().toLowerCase();
    if (text && text.length <= 96 && /^[a-z0-9_.:-]+$/.test(text)) return text;
    return fallback;
}

function isLoopbackHostname(hostname) {
    const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost'
        || host === '::1'
        || host === '0:0:0:0:0:0:0:1'
        || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function normalizeTargetUrl(value, allowInsecureRemote) {
    let url;
    try {
        url = new URL(String(value || '').trim());
    } catch {
        throw createProviderError('provider_target_url_invalid', 'Provider endpoint URL 无效');
    }

    if (url.username || url.password) {
        throw createProviderError('provider_target_url_credentials_forbidden', 'Provider endpoint URL 禁止内嵌凭据');
    }
    if (url.protocol === 'https:') return url;
    if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) return url;
    if (url.protocol === 'http:' && allowInsecureRemote) return url;
    throw createProviderError(
        'provider_insecure_endpoint',
        '远程 Provider 必须使用 HTTPS；仅 loopback HTTP 默认允许',
    );
}

function endpointUrl(baseUrl, route) {
    const base = new URL(baseUrl.toString());
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    return new URL(String(route || '').replace(/^\/+/, ''), base).toString();
}

function readTargetsRaw(processRef) {
    const raw = String(processRef.env.FARM_CODE_PROVIDER_TARGETS || '').trim();
    if (raw) return { configured: true, raw, source: 'json' };

    const encoded = String(processRef.env.FARM_CODE_PROVIDER_TARGETS_B64 || '').trim();
    if (!encoded) return { configured: false, raw: '', source: '' };

    try {
        const decoded = Buffer.from(encoded, 'base64').toString('utf8').trim();
        if (!decoded) return { configured: true, raw: '', source: 'base64' };
        return { configured: true, raw: decoded, source: 'base64' };
    } catch {
        return { configured: true, raw: '', source: 'base64' };
    }
}

function parseTargets(processRef) {
    const source = readTargetsRaw(processRef);
    if (!source.configured) return { configured: false, targets: new Map(), error: '' };
    if (!source.raw) return { configured: true, targets: new Map(), error: 'provider_targets_json_invalid' };

    let parsed;
    try {
        parsed = JSON.parse(source.raw);
    } catch {
        return { configured: true, targets: new Map(), error: 'provider_targets_json_invalid' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { configured: true, targets: new Map(), error: 'provider_targets_json_invalid' };
    }

    const targets = new Map();
    for (const [rawUin, rawSpec] of Object.entries(parsed)) {
        const qqUin = normalizeUin(rawUin);
        if (!qqUin) {
            return { configured: true, targets: new Map(), error: 'provider_target_uin_invalid' };
        }
        const spec = typeof rawSpec === 'string' ? { url: rawSpec } : rawSpec;
        if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
            return { configured: true, targets: new Map(), error: 'provider_target_spec_invalid' };
        }
        const tokenEnv = String(spec.tokenEnv || '').trim();
        const token = tokenEnv
            ? String(processRef.env[tokenEnv] || '').trim()
            : String(spec.token || '').trim();
        targets.set(qqUin, {
            qqUin,
            name: String(spec.name || 'isolated_runtime').trim().slice(0, 48) || 'isolated_runtime',
            url: String(spec.url || '').trim(),
            token,
            tokenEnv,
        });
    }
    return { configured: true, targets, error: '' };
}

function getExpectedIdentity(account, binding) {
    const accountUin = normalizeUin(account && (account.uin || account.qq));
    const bindingUin = normalizeUin(binding && binding.qqUin);
    if (!accountUin) throw createProviderError('account_uin_missing', '账号 QQ UIN 缺失');
    if (!bindingUin) throw createProviderError('session_identity_unverified', 'Session QQ UIN 未验证');
    if (accountUin !== bindingUin) {
        throw createProviderError('session_identity_mismatch', '账号与 Session QQ UIN 不一致');
    }
    return accountUin;
}

function getTarget(processRef, account, binding) {
    const qqUin = getExpectedIdentity(account, binding);
    const config = parseTargets(processRef);
    if (config.error) throw createProviderError(config.error, 'Provider targets 配置无效');
    if (!config.configured) throw createProviderError('provider_targets_not_configured', '未配置隔离 QQ Provider');
    const target = config.targets.get(qqUin);
    if (!target) throw createProviderError('provider_target_not_configured', '当前 QQ 未配置隔离 Provider');
    if (!target.url) throw createProviderError('provider_target_url_missing', 'Provider endpoint URL 缺失');
    if (!target.token) throw createProviderError('provider_token_missing', 'Provider token 缺失');
    return target;
}

async function readJsonResponse(response) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
        throw createProviderError('provider_response_too_large', 'Provider 响应过大');
    }
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        throw createProviderError('provider_response_invalid', 'Provider 返回了无效 JSON');
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
            throw createProviderError('provider_timeout', 'Provider 请求超时');
        }
        if (err && err.code) throw err;
        throw createProviderError('provider_network_error', 'Provider 网络请求失败');
    } finally {
        clearTimeout(timer);
    }
}

function createIsolatedRuntimeCodeProvider(options = {}) {
    const processRef = options.processRef || process;
    const fetchImpl = options.fetchImpl || fetch;
    const healthTimeoutMs = Math.max(
        1000,
        Number(options.healthTimeoutMs || processRef.env.FARM_CODE_PROVIDER_HEALTH_TIMEOUT_MS) || DEFAULT_HEALTH_TIMEOUT_MS,
    );
    const refreshTimeoutMs = Math.max(
        5000,
        Number(options.refreshTimeoutMs || processRef.env.FARM_CODE_PROVIDER_REFRESH_TIMEOUT_MS) || DEFAULT_REFRESH_TIMEOUT_MS,
    );

    function allowInsecureRemote() {
        return String(processRef.env.FARM_CODE_PROVIDER_ALLOW_INSECURE_REMOTE || '0') === '1';
    }

    async function resolveTarget(account, binding) {
        const target = getTarget(processRef, account, binding);
        const baseUrl = normalizeTargetUrl(target.url, allowInsecureRemote());
        return { ...target, baseUrl };
    }

    return {
        name: 'isolated_qq_runtime',

        async getAvailability(account, binding) {
            let target;
            let expectedUin;
            try {
                expectedUin = getExpectedIdentity(account, binding);
                target = await resolveTarget(account, binding);
            } catch (err) {
                return {
                    available: false,
                    reason: err && err.code ? err.code : 'provider_config_error',
                };
            }

            try {
                const { response, data } = await requestJson(
                    fetchImpl,
                    endpointUrl(target.baseUrl, 'v1/health'),
                    { token: target.token, timeoutMs: healthTimeoutMs },
                );
                if (!response.ok) {
                    return { available: false, reason: `provider_health_http_${response.status}` };
                }
                const providerUin = normalizeUin(data && data.qqUin);
                if (!providerUin) return { available: false, reason: 'provider_identity_unverified' };
                if (providerUin !== expectedUin) {
                    return { available: false, reason: 'provider_identity_mismatch' };
                }
                if (!data || data.ok !== true || data.available !== true) {
                    return {
                        available: false,
                        reason: safeReason(data && data.reason, 'provider_not_ready'),
                    };
                }
                return {
                    available: true,
                    reason: 'ok',
                    provider: target.name,
                };
            } catch (err) {
                return {
                    available: false,
                    reason: err && err.code ? err.code : 'provider_health_failed',
                };
            }
        },

        async refresh({ account, binding, reason }) {
            const expectedUin = getExpectedIdentity(account, binding);
            const target = await resolveTarget(account, binding);
            const { response, data } = await requestJson(
                fetchImpl,
                endpointUrl(target.baseUrl, 'v1/code/refresh'),
                {
                    method: 'POST',
                    token: target.token,
                    timeoutMs: refreshTimeoutMs,
                    body: {
                        qqUin: expectedUin,
                        reason: String(reason || 'scheduled').slice(0, 96),
                    },
                },
            );

            if (!response.ok) {
                const agentReason = safeReason(data && data.reason, `provider_refresh_http_${response.status}`);
                throw createProviderError(agentReason, `Provider 刷新失败 (${agentReason})`);
            }
            const providerUin = normalizeUin(data && data.qqUin);
            if (!providerUin) {
                throw createProviderError('provider_identity_unverified', 'Provider 未返回 QQ UIN');
            }
            if (providerUin !== expectedUin) {
                throw createProviderError('provider_identity_mismatch', 'Provider 返回 QQ UIN 不匹配');
            }
            if (!data || data.ok !== true) {
                const agentReason = safeReason(data && data.reason, 'provider_refresh_failed');
                throw createProviderError(agentReason, `Provider 未能生成 fresh Code (${agentReason})`);
            }
            const code = String(data.code || '').trim();
            if (!isLikelyCode(code)) {
                throw createProviderError('provider_invalid_code', 'Provider 返回的 Code 格式无效');
            }
            return {
                code,
                source: `isolated_qq_runtime:${target.name}`,
            };
        },
    };
}

function createIsolatedRuntimeCodeProviderFromEnv(options = {}) {
    const processRef = options.processRef || process;
    const hasJson = String(processRef.env.FARM_CODE_PROVIDER_TARGETS || '').trim();
    const hasBase64 = String(processRef.env.FARM_CODE_PROVIDER_TARGETS_B64 || '').trim();
    if (!hasJson && !hasBase64) return null;
    return createIsolatedRuntimeCodeProvider({ ...options, processRef });
}

module.exports = {
    createIsolatedRuntimeCodeProvider,
    createIsolatedRuntimeCodeProviderFromEnv,
    normalizeUin,
    isLoopbackHostname,
};