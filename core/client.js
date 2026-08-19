const path = require('node:path');
const process = require('node:process');
/**
 * 主程序 - 进程管理器
 * 负责启动 Web 面板，并管理多个 Bot 子进程
 */
const {
    startAdminServer,
    emitRealtimeStatus,
    emitRealtimeLog,
    emitRealtimeAccountLog,
} = require('./src/controllers/admin');
const { installCodeManagerApiHook } = require('./src/controllers/code-manager-api-hook');
const { installDogFeedApiHook } = require('./src/controllers/dog-feed-api-hook');
const { createRuntimeEngine } = require('./src/runtime/runtime-engine');
const { createIsolatedRuntimeCodeProviderFromEnv } = require('./src/services/isolated-runtime-code-provider');
const { createWechatRuntimeCodeProviderFromEnv } = require('./src/services/wechat-runtime-code-provider');
const { createWechatRecoveryManager } = require('./src/services/wechat-recovery-manager');
const { installDogFeedActionHook } = require('./src/services/dog-feed-action-hook');
const { createModuleLogger } = require('./src/services/logger');
const mainLogger = createModuleLogger('main');

function startAdminServerWithCodeManagerApi(dataProvider) {
    const uninstallCodeManager = installCodeManagerApiHook(dataProvider);
    const uninstallDogFeed = installDogFeedApiHook(dataProvider);
    try {
        return startAdminServer(dataProvider);
    } finally {
        uninstallDogFeed();
        uninstallCodeManager();
    }
}

function installWechatRecoveryDataProviderBridge(runtimeEngine, wechatRecoveryManager, wechatCodeProvider) {
    const dataProvider = runtimeEngine && runtimeEngine.dataProvider;
    if (!dataProvider || !wechatRecoveryManager) return;

    const originalGetCodeManagerStatus = typeof dataProvider.getCodeManagerStatus === 'function'
        ? dataProvider.getCodeManagerStatus.bind(dataProvider)
        : (() => ({ enabled: false, started: false, globalEnabled: false, provider: 'unavailable', accounts: [] }));
    const originalSetCodeRefreshConfig = typeof dataProvider.setCodeRefreshConfig === 'function'
        ? dataProvider.setCodeRefreshConfig.bind(dataProvider)
        : null;
    const originalTriggerCodeRefresh = typeof dataProvider.triggerCodeRefresh === 'function'
        ? dataProvider.triggerCodeRefresh.bind(dataProvider)
        : null;
    const originalStartAccount = typeof dataProvider.startAccount === 'function'
        ? dataProvider.startAccount.bind(dataProvider)
        : null;

    let providerHealth = {
        available: false,
        reason: 'wechat_provider_health_unknown',
        updatedAt: 0,
        clientVersion: '',
        gatewayVersion: '',
        wmpfVersion: 0,
        windowsSessionId: -1,
    };

    async function pollProviderHealth() {
        if (!wechatCodeProvider || typeof wechatCodeProvider.getAvailability !== 'function') return;
        try {
            const result = await wechatCodeProvider.getAvailability({ platform: 'wx' });
            providerHealth = {
                available: !!(result && result.available),
                reason: String(result && result.reason || (result && result.available ? 'ok' : 'wechat_provider_not_ready')),
                updatedAt: Date.now(),
                clientVersion: String(result && result.clientVersion || ''),
                gatewayVersion: String(result && result.gatewayVersion || ''),
                wmpfVersion: Number(result && result.wmpfVersion) || 0,
                windowsSessionId: Number.isFinite(Number(result && result.windowsSessionId))
                    ? Number(result.windowsSessionId)
                    : -1,
            };
        } catch (err) {
            providerHealth = {
                ...providerHealth,
                available: false,
                reason: err && err.code ? String(err.code) : 'wechat_provider_health_failed',
                updatedAt: Date.now(),
            };
        }
    }

    pollProviderHealth().catch(() => null);
    const providerHealthTimer = setInterval(() => pollProviderHealth().catch(() => null), 5000);
    if (providerHealthTimer && typeof providerHealthTimer.unref === 'function') providerHealthTimer.unref();
    runtimeEngine.wechatProviderHealthTimer = providerHealthTimer;

    function getAccount(accountRef) {
        const raw = String(accountRef || '').trim();
        const id = typeof dataProvider.resolveAccountId === 'function'
            ? String(dataProvider.resolveAccountId(raw) || raw).trim()
            : raw;
        const data = runtimeEngine.store.getAccounts();
        const accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
        return accounts.find(item => String(item.id || '') === id) || null;
    }

    function normalizeWechatStatusItem(item) {
        const source = item && typeof item === 'object' ? item : {};
        let state = source.state && typeof source.state === 'object'
            ? source.state
            : { state: source.refreshing ? 'refreshing' : 'scheduled', updatedAt: 0 };
        if (!source.refreshing && !providerHealth.available) {
            state = {
                state: 'waiting_provider',
                updatedAt: Number(providerHealth.updatedAt) || 0,
                reason: String(providerHealth.reason || 'wechat_provider_not_ready'),
            };
        }
        return {
            accountId: String(source.accountId || ''),
            accountName: String(source.accountName || source.accountId || ''),
            platform: 'wx',
            sessionIdentityOk: true,
            sessionIdentityReason: 'windows_wechat_resident',
            sessionStatus: providerHealth.available ? 'resident_connected' : String(providerHealth.reason || 'resident_waiting'),
            needsRebind: false,
            nextRefreshAt: Number(source.nextRefreshAt) || 0,
            refreshing: !!source.refreshing,
            pendingReason: String(source.pendingReason || ''),
            state,
        };
    }

    dataProvider.startAccount = (accountRef) => {
        const account = getAccount(accountRef);
        if (account && String(account.platform || '').toLowerCase() === 'wx') {
            const id = String(account.id || '');
            const code = String(account.code || '').trim();
            const mode = String(account.codeRefreshMode || 'windows_wechat').toLowerCase();
            const residentConfigured = account.codeRefreshEnabled === true
                && (mode === 'windows_wechat' || mode === 'windows_session');
            if (residentConfigured && !code) {
                return wechatRecoveryManager.triggerRefresh(id, 'web_enroll');
            }
        }
        if (!originalStartAccount) return false;
        return originalStartAccount(accountRef);
    };

    dataProvider.getCodeManagerStatus = (accountRef = '') => {
        const base = originalGetCodeManagerStatus(accountRef) || {};
        const wxRaw = wechatRecoveryManager.getStatus();
        const wxAccounts = (wxRaw.accounts || []).map(normalizeWechatStatusItem);
        const raw = String(accountRef || '').trim();
        const wxMeta = {
            enabled: !!wxRaw.enabled,
            started: !!wxRaw.started,
            provider: String(wxRaw.provider || ''),
            configuredCount: wxAccounts.length,
            agent: { ...providerHealth },
        };

        if (raw) {
            const account = getAccount(raw);
            if (!account || String(account.platform || 'qq').toLowerCase() !== 'wx') return base;
            const id = String(account.id || '');
            return {
                enabled: !!wxRaw.enabled,
                started: !!wxRaw.started,
                globalEnabled: !!wxRaw.enabled,
                provider: String(wxRaw.provider || 'windows_wechat_runtime'),
                refreshIntervalMs: Number(wxRaw.refreshIntervalMs) || 0,
                pollMs: Number(wxRaw.pollMs) || 0,
                retryMs: Number(wxRaw.retryMs) || 0,
                configuredCount: wxAccounts.length,
                accounts: wxAccounts.filter(item => item.accountId === id),
                wechat: wxMeta,
            };
        }

        const baseAccounts = Array.isArray(base.accounts) ? base.accounts : [];
        const wxIds = new Set(wxAccounts.map(item => item.accountId));
        const mergedAccounts = [
            ...baseAccounts.filter(item => !wxIds.has(String(item.accountId || ''))),
            ...wxAccounts,
        ];
        const providers = [String(base.provider || ''), String(wxRaw.provider || '')].filter(Boolean);
        return {
            ...base,
            enabled: !!base.enabled || !!wxRaw.enabled,
            started: !!base.started || !!wxRaw.started,
            globalEnabled: !!base.globalEnabled || !!wxRaw.enabled,
            provider: providers.join('+') || 'unavailable',
            configuredCount: mergedAccounts.length,
            accounts: mergedAccounts,
            wechat: wxMeta,
        };
    };

    dataProvider.setCodeRefreshConfig = (accountRef, payload = {}) => {
        const account = getAccount(accountRef);
        if (!account || String(account.platform || 'qq').toLowerCase() !== 'wx') {
            if (!originalSetCodeRefreshConfig) throw new Error('CodeManager config unavailable');
            return originalSetCodeRefreshConfig(accountRef, payload);
        }

        const enabled = payload && payload.enabled === true;
        const requestedMode = String(payload && payload.mode || (enabled ? 'windows_wechat' : '')).toLowerCase();
        if (enabled && !['windows_wechat', 'windows_session'].includes(requestedMode)) {
            throw new Error(`Unsupported WeChat CodeManager mode: ${requestedMode || '(empty)'}`);
        }
        runtimeEngine.store.addOrUpdateAccount({
            id: String(account.id || ''),
            codeRefreshEnabled: enabled,
            codeRefreshMode: enabled ? 'windows_wechat' : '',
            codeRefreshConfiguredAt: Date.now(),
            wechatAppId: account.wechatAppId || 'wx5306c5978fdb76e4',
        });
        return {
            config: typeof dataProvider.getCodeRefreshConfig === 'function'
                ? dataProvider.getCodeRefreshConfig(account.id)
                : null,
            status: dataProvider.getCodeManagerStatus(account.id),
        };
    };

    dataProvider.triggerCodeRefresh = (accountRef, reason = 'manual') => {
        const account = getAccount(accountRef);
        if (!account || String(account.platform || 'qq').toLowerCase() !== 'wx') {
            if (!originalTriggerCodeRefresh) return { accepted: false, reason: 'code_manager_unavailable' };
            return originalTriggerCodeRefresh(accountRef, reason);
        }
        const id = String(account.id || '');
        const accepted = wechatRecoveryManager.triggerRefresh(id, String(reason || 'manual'));
        return {
            accepted,
            accountId: id,
            status: dataProvider.getCodeManagerStatus(id),
        };
    };
}

// 打包后 worker 由当前可执行文件以 --worker 模式启动
const isWorkerProcess = process.env.FARM_WORKER === '1';
if (isWorkerProcess) {
    // Fork/pkg worker 也必须在 worker.js 导入 network.js 之前安装微信网关 profile。
    require('./src/services/wechat-gateway-profile');
    installDogFeedActionHook();
    require('./src/core/worker');
} else {
    const codeRefreshProvider = createIsolatedRuntimeCodeProviderFromEnv({ processRef: process });
    if (codeRefreshProvider) {
        mainLogger.info('isolated QQ runtime Code Provider configured');
    }

    let wechatCodeProvider = null;
    try {
        wechatCodeProvider = createWechatRuntimeCodeProviderFromEnv({ processRef: process });
        if (wechatCodeProvider) {
            mainLogger.info('Windows WeChat runtime Code Provider configured');
        }
    } catch (err) {
        mainLogger.warn('Windows WeChat runtime Code Provider configuration rejected', {
            error: err && err.code ? err.code : (err && err.message ? err.message : String(err)),
        });
    }

    const runtimeEngine = createRuntimeEngine({
        processRef: process,
        mainEntryPath: __filename,
        workerScriptPath: path.join(__dirname, 'src/core/worker-bootstrap.js'),
        startAdminServer: startAdminServerWithCodeManagerApi,
        codeRefreshProvider,
        onStatusSync: (accountId, status) => {
            emitRealtimeStatus(accountId, status);
        },
        onLog: (entry, accountId) => {
            if (accountId && entry) {
                entry.accountId = accountId;
            }
            emitRealtimeLog(entry);
        },
        onAccountLog: (entry) => {
            emitRealtimeAccountLog(entry);
        },
    });

    // WeChat recovery is intentionally separate from the mature QQ exact-UIN
    // CodeManager. The data-provider bridge only multiplexes config/status/API
    // routing; it does not change QQ session identity or QQ provider behavior.
    if (wechatCodeProvider) {
        const wechatRecoveryManager = createWechatRecoveryManager({
            store: runtimeEngine.store,
            workers: runtimeEngine.workers,
            startWorker: runtimeEngine.startWorker,
            stopWorker: runtimeEngine.stopWorker,
            log: runtimeEngine.log,
            addAccountLog: runtimeEngine.addAccountLog,
            provider: wechatCodeProvider,
            processRef: process,
        });
        runtimeEngine.runtimeEvents.on('account_log', entry => {
            wechatRecoveryManager.handleAccountLog(entry);
        });
        wechatRecoveryManager.start();
        runtimeEngine.wechatRecoveryManager = wechatRecoveryManager;
        installWechatRecoveryDataProviderBridge(runtimeEngine, wechatRecoveryManager, wechatCodeProvider);
    }

    // Unattended production default: start every saved account when FAR2 starts.
    // Set FARM_AUTO_START_ACCOUNTS=0 only when intentionally running panel-only.
    runtimeEngine.start({
        startAdminServer: true,
    }).catch((err) => {
        mainLogger.error('runtime bootstrap failed', { error: err && err.message ? err.message : String(err) });
    });
}
