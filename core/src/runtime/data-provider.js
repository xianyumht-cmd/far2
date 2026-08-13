const { findAccountByRef, normalizeAccountRef, resolveAccountId: resolveAccountIdByList } = require('../services/account-resolver');
const { getSchedulerRegistrySnapshot } = require('../services/scheduler');
const desktopSessions = require('../services/desktop-session-registry');

function createDataProvider(options) {
    const {
        workers,
        globalLogs,
        accountLogs,
        store,
        getAccounts,
        callWorkerApi,
        buildDefaultStatus,
        normalizeStatusForPanel,
        filterLogs,
        addAccountLog,
        nextConfigRevision,
        broadcastConfigToWorkers,
        startWorker,
        stopWorker,
        restartWorker,
        codeManager,
    } = options;

    function getStoredAccountsList() {
        const data = getAccounts();
        return Array.isArray(data.accounts) ? data.accounts : [];
    }

    function resolveAccountRefId(accountRef) {
        const raw = normalizeAccountRef(accountRef);
        if (!raw) return '';
        const resolved = resolveAccountIdByList(getStoredAccountsList(), raw);
        return resolved || raw;
    }

    function findAccountByAnyRef(accountRef) {
        return findAccountByRef(getStoredAccountsList(), accountRef);
    }

    function buildCodeRefreshConfig(account) {
        if (!account) return null;
        const id = String(account.id || '');
        return {
            accountId: id,
            accountName: account.name || id,
            platform: String(account.platform || 'qq').toLowerCase(),
            enabled: account.codeRefreshEnabled === true,
            mode: String(account.codeRefreshMode || ''),
            configuredAt: Number(account.codeRefreshConfiguredAt || 0),
        };
    }

    function getCodeRefreshConfig(accountRef = '') {
        const raw = normalizeAccountRef(accountRef);
        if (!raw) {
            return {
                accounts: getStoredAccountsList().map(buildCodeRefreshConfig).filter(Boolean),
            };
        }
        const accountId = resolveAccountRefId(raw);
        const account = findAccountByAnyRef(accountId || raw);
        if (!account) return null;
        return buildCodeRefreshConfig(account);
    }

    return {
        resolveAccountId: (accountRef) => resolveAccountRefId(accountRef),

        // 获取指定账号的状态 (如果 accountId 为空，返回概览?)
        getStatus: (accountRef) => {
            const accountId = resolveAccountRefId(accountRef);
            if (!accountId) return buildDefaultStatus('');
            const w = workers[accountId];
            if (!w || !w.status) return buildDefaultStatus(accountId);
            return {
                ...buildDefaultStatus(accountId),
                ...normalizeStatusForPanel(w.status, accountId, w.name),
                wsError: w.wsError || null,
            };
        },

        getLogs: (accountRef, optionsOrLimit) => {
            const opts = (typeof optionsOrLimit === 'object' && optionsOrLimit) ? optionsOrLimit : { limit: optionsOrLimit };
            const max = Math.max(1, Number(opts.limit) || 100);
            const rawRef = normalizeAccountRef(accountRef);
            const accountId = resolveAccountRefId(accountRef);
            // 如果没有指定账号或指定为 'all'，返回所有日志
            if (!rawRef || rawRef === 'all') {
                return filterLogs(globalLogs, opts).slice(-max);
            }
            if (!accountId) return [];
            const accId = String(accountId || '');
            return filterLogs(globalLogs.filter(l => String(l.accountId || '') === accId), opts).slice(-max);
        },

        getAccountLogs: (limit) => accountLogs.slice(-limit).reverse(),
        addAccountLog: (action, msg, accountId, accountName, extra) => addAccountLog(action, msg, accountId, accountName, extra),

        clearLogs: (accountRef) => {
            const rawRef = normalizeAccountRef(accountRef);
            const accountId = resolveAccountRefId(accountRef);
            
            if (!rawRef || rawRef === 'all') {
                globalLogs.length = 0;
                return { cleared: 'all' };
            }
            
            if (!accountId) return { cleared: 0 };
            
            const accId = String(accountId || '');
            const before = globalLogs.length;
            for (let i = globalLogs.length - 1; i >= 0; i--) {
                if (String(globalLogs[i].accountId || '') === accId) {
                    globalLogs.splice(i, 1);
                }
            }
            const after = globalLogs.length;
            return { cleared: before - after, accountId };
        },

        // 透传方法
        getLands: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getLands'),
        getFriends: (accountRef, forceSync = false) => callWorkerApi(resolveAccountRefId(accountRef), 'getFriends', forceSync),
        clearFriendsCache: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'clearFriendsCache'),
        getInteractRecords: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getInteractRecords'),
        getFriendLands: (accountRef, gid) => callWorkerApi(resolveAccountRefId(accountRef), 'getFriendLands', gid),
        doFriendOp: (accountRef, gid, opType) => callWorkerApi(resolveAccountRefId(accountRef), 'doFriendOp', gid, opType),
        getBag: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getBag'),
        getBagSeeds: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getBagSeeds'),
        useItem: (accountRef, itemId, count) => callWorkerApi(resolveAccountRefId(accountRef), 'useItem', itemId, count),
        sellItems: (accountRef, items) => callWorkerApi(resolveAccountRefId(accountRef), 'sellItems', items),
        getDailyGifts: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getDailyGiftOverview'),
        getSeeds: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getSeeds'),
        getIllustrated: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getIllustrated'),
        getDogInfo: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getDogInfo'),
        getCareerInfo: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getCareerInfo'),
        getAvatarFrames: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getAvatarFrames'),
        getShopProfiles: (accountRef) => callWorkerApi(resolveAccountRefId(accountRef), 'getShopProfiles'),
        getShopInfo: (accountRef, shopId) => callWorkerApi(resolveAccountRefId(accountRef), 'getShopInfo', shopId),

        setAutomation: async (accountRef, key, value) => {
            const accountId = resolveAccountRefId(accountRef);
            if (!accountId) {
                throw new Error('Missing x-account-id');
            }
            store.setAutomation(key, value, accountId);
            const rev = nextConfigRevision();
            broadcastConfigToWorkers(accountId);
            return { automation: store.getAutomation(accountId), configRevision: rev };
        },

        doFarmOp: (accountRef, opType) => callWorkerApi(resolveAccountRefId(accountRef), 'doFarmOp', opType),
        doAnalytics: (accountRef, sortBy) => callWorkerApi(resolveAccountRefId(accountRef), 'getAnalytics', sortBy),
        buyFertilizer: (accountRef, type, count) => callWorkerApi(resolveAccountRefId(accountRef), 'buyFertilizer', type, count),
        checkAndBuyFertilizer: (accountRef, options) => callWorkerApi(resolveAccountRefId(accountRef), 'checkAndBuyFertilizer', options),
        saveSettings: async (accountRef, payload) => {
            const accountId = resolveAccountRefId(accountRef);
            if (!accountId) {
                throw new Error('Missing x-account-id');
            }
            const body = (payload && typeof payload === 'object') ? payload : {};
            const plantingStrategy = (body.plantingStrategy !== undefined) ? body.plantingStrategy : body.strategy;
            const preferredSeedId = (body.preferredSeedId !== undefined) ? body.preferredSeedId : body.seedId;
            const snapshot = {
                plantingStrategy,
                preferredSeedId,
                intervals: body.intervals,
                friendQuietHours: body.friendQuietHours,
                stealDelaySeconds: body.stealDelaySeconds,
                plantOrderRandom: body.plantOrderRandom,
                plantDelaySeconds: body.plantDelaySeconds,
                fertilizerBuyOrganicCount: body.fertilizerBuyOrganicCount,
                fertilizerBuyOrganicThresholdHours: body.fertilizerBuyOrganicThresholdHours,
                fertilizerBuyNormalCount: body.fertilizerBuyNormalCount,
                fertilizerBuyNormalThresholdHours: body.fertilizerBuyNormalThresholdHours,
                fertilizerBuyCheckIntervalMinutes: body.fertilizerBuyCheckIntervalMinutes,
                bagSeedPriority: body.bagSeedPriority,
                bagSeedFallbackStrategy: body.bagSeedFallbackStrategy,
            };
            store.applyConfigSnapshot(snapshot, { accountId });
            const rev = nextConfigRevision();
            broadcastConfigToWorkers(accountId);
            return {
                strategy: store.getPlantingStrategy(accountId),
                preferredSeed: store.getPreferredSeed(accountId),
                intervals: store.getIntervals(accountId),
                friendQuietHours: store.getFriendQuietHours(accountId),
                stealDelaySeconds: store.getStealDelaySeconds(accountId),
                plantOrderRandom: store.getPlantOrderRandom(accountId),
                plantDelaySeconds: store.getPlantDelaySeconds(accountId),
                fertilizerBuyOrganicCount: store.getFertilizerBuyOrganicCount(accountId),
                fertilizerBuyOrganicThresholdHours: store.getFertilizerBuyOrganicThresholdHours(accountId),
                fertilizerBuyNormalCount: store.getFertilizerBuyNormalCount(accountId),
                fertilizerBuyNormalThresholdHours: store.getFertilizerBuyNormalThresholdHours(accountId),
                fertilizerBuyCheckIntervalMinutes: store.getFertilizerBuyCheckIntervalMinutes(accountId),
                bagSeedPriority: store.getBagSeedPriority(accountId),
                bagSeedFallbackStrategy: store.getBagSeedFallbackStrategy(accountId),
                configRevision: rev,
            };
        },

        setUITheme: async (theme) => {
            const snapshot = store.setUITheme(theme);
            return { ui: snapshot.ui || store.getUI() };
        },

        broadcastConfig: (accountId) => {
            broadcastConfigToWorkers(accountId);
        },

        setRuntimeAccountName: (accountRef, accountName) => {
            const accountId = resolveAccountRefId(accountRef);
            if (!accountId) return;
            const worker = workers[accountId];
            if (worker) {
                worker.name = String(accountName || worker.name || accountId);
            }
        },

        // 账号管理直接操作 store
        getAccounts: () => {
            const data = getAccounts();
            data.accounts.forEach((a) => {
                const worker = workers[a.id];
                a.running = !!worker;
                if (worker && worker.status && worker.status.status && worker.status.status.name) {
                    a.nick = worker.status.status.name;
                }
            });
            return data;
        },

        startAccount: (accountRef) => {
            const accountId = resolveAccountRefId(accountRef);
            const acc = findAccountByAnyRef(accountId || accountRef);
            if (!acc) return false;
            startWorker(acc);
            return true;
        },

        stopAccount: (accountRef) => {
            const accountId = resolveAccountRefId(accountRef);
            const acc = findAccountByAnyRef(accountId || accountRef);
            if (!acc) return false;
            if (accountId) stopWorker(accountId);
            return true;
        },

        restartAccount: (accountRef) => {
            const accountId = resolveAccountRefId(accountRef);
            const acc = findAccountByAnyRef(accountId || accountRef);
            if (!acc) return false;
            restartWorker(acc);
            return true;
        },

        isAccountRunning: (accountRef) => {
            const accountId = resolveAccountRefId(accountRef);
            return !!(accountId && workers[accountId]);
        },

        // Windows QQ Desktop Session Registry
        getDesktopSessions: () => desktopSessions.getStatus(),

        bindDesktopSession: (accountRef, payload = {}) => {
            const accountId = resolveAccountRefId(accountRef) || String(accountRef || '').trim();
            if (!accountId) throw new Error('Missing accountId');
            return desktopSessions.bindAccount({
                accountId,
                farmRootPid: payload.farmRootPid,
                qqUin: payload.qqUin,
                note: payload.note,
            });
        },

        unbindDesktopSession: (accountRef) => {
            const accountId = resolveAccountRefId(accountRef) || String(accountRef || '').trim();
            if (!accountId) return false;
            return desktopSessions.unbindAccount(accountId);
        },

        refreshDesktopSessions: () => desktopSessions.refreshBindings(),

        // Session-aware CodeManager config/status. No Farm Code is returned here.
        getCodeRefreshConfig: (accountRef = '') => getCodeRefreshConfig(accountRef),

        setCodeRefreshConfig: (accountRef, payload = {}) => {
            const accountId = resolveAccountRefId(accountRef);
            if (!accountId) throw new Error('Missing accountId');
            const account = findAccountByAnyRef(accountId);
            if (!account) throw new Error('Account not found');
            if (String(account.platform || 'qq').toLowerCase() !== 'qq') {
                throw new Error('CodeManager windows_session 仅支持 QQ 账号');
            }

            const body = payload && typeof payload === 'object' ? payload : {};
            const enabled = body.enabled === true;
            const requestedMode = String(body.mode || (enabled ? 'windows_session' : '')).toLowerCase();
            if (enabled && requestedMode !== 'windows_session') {
                throw new Error(`Unsupported CodeManager mode: ${requestedMode || '(empty)'}`);
            }

            store.addOrUpdateAccount({
                id: accountId,
                codeRefreshEnabled: enabled,
                codeRefreshMode: enabled ? 'windows_session' : '',
                codeRefreshConfiguredAt: Date.now(),
            });

            return {
                config: getCodeRefreshConfig(accountId),
                status: codeManager && typeof codeManager.getAccountStatus === 'function'
                    ? codeManager.getAccountStatus(accountId)
                    : null,
            };
        },

        getCodeManagerStatus: (accountRef = '') => {
            if (!codeManager || typeof codeManager.getStatus !== 'function') {
                return { enabled: false, provider: 'unavailable', accounts: [] };
            }
            const status = codeManager.getStatus();
            const raw = normalizeAccountRef(accountRef);
            if (!raw) return status;
            const accountId = resolveAccountRefId(raw);
            return {
                ...status,
                accounts: (status.accounts || []).filter(item => String(item.accountId || '') === String(accountId || '')),
            };
        },

        triggerCodeRefresh: (accountRef, reason = 'manual') => {
            const accountId = resolveAccountRefId(accountRef);
            if (!accountId) throw new Error('Missing accountId');
            if (!codeManager || typeof codeManager.triggerRefresh !== 'function') {
                return { accepted: false, reason: 'code_manager_unavailable' };
            }
            const accepted = codeManager.triggerRefresh(accountId, String(reason || 'manual'));
            return {
                accepted,
                accountId,
                status: typeof codeManager.getAccountStatus === 'function'
                    ? codeManager.getAccountStatus(accountId)
                    : null,
            };
        },

        getSchedulerStatus: async (accountRef) => {
            const accountId = resolveAccountRefId(accountRef);
            const runtime = getSchedulerRegistrySnapshot();
            let worker = null;
            let workerError = '';

            if (!accountId) {
                return { accountId: '', runtime, worker, workerError };
            }

            if (!workers[accountId]) {
                return { accountId, runtime, worker, workerError: '账号未运行' };
            }

            try {
                worker = await callWorkerApi(accountId, 'getSchedulers');
            } catch (e) {
                workerError = (e && e.message) ? e.message : String(e || 'unknown');
            }
            return { accountId, runtime, worker, workerError };
        },
    };
}

module.exports = {
    createDataProvider,
};
