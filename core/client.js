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
    // CodeManager. This keeps QQ session identity rules unchanged while the
    // Windows WeChat provider/agent reaches production parity.
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
    }

    // Unattended production default: start every saved account when FAR2 starts.
    // Set FARM_AUTO_START_ACCOUNTS=0 only when intentionally running panel-only.
    runtimeEngine.start({
        startAdminServer: true,
    }).catch((err) => {
        mainLogger.error('runtime bootstrap failed', { error: err && err.message ? err.message : String(err) });
    });
}
