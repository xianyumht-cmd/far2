'use strict';

const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { fork } = require('node:child_process');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function safeText(value, max = 160) {
    return String(value || '')
        .replace(/([?&](?:code|token|ticket|password)=)[^&\s]+/gi, '$1[REDACTED]')
        .replace(/(Bearer\s+)[\w.-]+/gi, '$1[REDACTED]')
        .replace(/\b[A-Za-z0-9_-]{32}\b/g, '[REDACTED_32]')
        .slice(0, max);
}

function stageRequire(stageCore, relativePath) {
    return require(path.join(stageCore, relativePath));
}

async function waitUntil(predicate, timeoutMs, intervalMs = 100) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await sleep(intervalMs);
    }
    return !!predicate();
}

async function main() {
    if (process.platform !== 'win32') throw new Error('Windows only');

    const stageCore = path.resolve(String(process.env.FAR2_P8_STAGE_CORE || '').trim());
    const reportPath = String(process.env.FAR2_P8_GATE_REPORT_PATH || '').trim();
    if (!stageCore || !fs.existsSync(stageCore)) throw new Error('FAR2_P8_STAGE_CORE is missing');
    if (!reportPath) throw new Error('FAR2_P8_GATE_REPORT_PATH is missing');

    const accountsFile = path.join(stageCore, 'data', 'accounts.json');
    if (!fs.existsSync(accountsFile)) throw new Error('Stage accounts.json is missing');

    const baseStore = stageRequire(stageCore, 'src/models/store.js');
    const { createWechatRuntimeCodeProviderFromEnv, EXPECTED_APP_ID } = stageRequire(stageCore, 'src/services/wechat-runtime-code-provider.js');
    const { createWechatRecoveryManager } = stageRequire(stageCore, 'src/services/wechat-recovery-manager.js');

    const provider = createWechatRuntimeCodeProviderFromEnv({ processRef: process });
    if (!provider) throw new Error('WeChat Provider environment is not configured');

    const validationId = '__p8_wx_validation__';
    const validationName = 'P8 WeChat Validation';
    const workers = Object.create(null);
    const volatileCodeByAccount = new Map();
    const capturedCodes = [];
    const codeLengths = [];
    const accountLog = [];
    let starts = 0;
    let stops = 0;
    let loginGeneration = 0;
    let loginClientVersion = '';
    let childFailure = '';

    // Stage-only account metadata. Never place a raw wx.login Code in the staged JSON.
    try { baseStore.deleteAccount(validationId); } catch {}
    baseStore.addOrUpdateAccount({
        id: validationId,
        name: validationName,
        platform: 'wx',
        codeRefreshEnabled: true,
        codeRefreshMode: 'windows_wechat',
        wechatAppId: EXPECTED_APP_ID,
    });

    const storeFacade = {
        getAccounts() {
            const source = baseStore.getAccounts();
            const accounts = Array.isArray(source && source.accounts) ? source.accounts : [];
            return {
                ...(source || {}),
                accounts: accounts.map(account => {
                    const id = String(account && account.id || '');
                    if (!volatileCodeByAccount.has(id)) return account;
                    return { ...account, code: volatileCodeByAccount.get(id) };
                }),
            };
        },
        addOrUpdateAccount(update) {
            const input = update && typeof update === 'object' ? { ...update } : {};
            const id = String(input.id || '').trim();
            if (Object.prototype.hasOwnProperty.call(input, 'code')) {
                const code = String(input.code || '').trim();
                if (code) {
                    volatileCodeByAccount.set(id, code);
                    capturedCodes.push(code);
                    codeLengths.push(code.length);
                }
                delete input.code;
            }
            return baseStore.addOrUpdateAccount(input);
        },
    };

    function spawnLoginOnlyWorker(account) {
        const id = String(account && account.id || '');
        if (!id || workers[id]) return false;
        const code = String(account && account.code || '').trim();
        if (!code) throw new Error('Volatile stage Code is missing before worker start');

        const child = fork(path.join(__dirname, 'wechat-p8-login-only-worker.js'), [], {
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            env: {
                ...process.env,
                FAR2_P8_STAGE_CORE: stageCore,
                FARM_ACCOUNT_ID: id,
            },
            windowsHide: true,
        });
        starts += 1;
        workers[id] = { process: child, name: validationName };

        let startSent = false;
        const sendStart = () => {
            if (startSent || !child.connected) return;
            startSent = true;
            child.send({ type: 'start', config: { code, platform: 'wx' } });
        };

        child.on('message', msg => {
            const payload = msg && typeof msg === 'object' ? msg : {};
            if (payload.type === 'worker_ready') {
                sendStart();
                return;
            }
            if (payload.type === 'login_ready') {
                loginGeneration += 1;
                loginClientVersion = String(payload.clientVersion || loginClientVersion || '');
                return;
            }
            if (payload.type === 'login_failed' || payload.type === 'ws_error') {
                childFailure = safeText(payload.reason || `worker_${payload.type}`);
            }
        });
        child.on('error', err => {
            childFailure = safeText(err && err.message ? err.message : 'worker_error');
        });
        child.on('exit', () => {
            if (workers[id] && workers[id].process === child) delete workers[id];
        });
        setTimeout(sendStart, 250).unref();
        return true;
    }

    function stopLoginOnlyWorker(accountId) {
        const id = String(accountId || '');
        const entry = workers[id];
        if (!entry) return;
        stops += 1;
        const child = entry.process;
        try { child.send({ type: 'stop' }); } catch {}
        setTimeout(() => {
            if (workers[id] && workers[id].process === child) {
                try { child.kill(); } catch {}
            }
        }, 1200).unref();
    }

    const recovery = createWechatRecoveryManager({
        store: storeFacade,
        workers,
        startWorker: spawnLoginOnlyWorker,
        stopWorker: stopLoginOnlyWorker,
        log(tag, message) {
            accountLog.push({ type: 'log', tag: safeText(tag, 24), message: safeText(message) });
        },
        addAccountLog(action, message, accountId, accountName, extra) {
            accountLog.push({
                type: 'account_log',
                action: safeText(action, 64),
                message: safeText(message),
                accountId: String(accountId || ''),
                accountName: safeText(accountName, 64),
                reason: extra && extra.reason ? safeText(extra.reason, 96) : '',
            });
        },
        provider,
        processRef: process,
    });

    const report = {
        version: 1,
        phase: 'wechat-p8-isolated-stage-real-login-recovery',
        generatedAt: new Date().toISOString(),
        stageCore,
        validationAccountId: validationId,
        safety: {
            productionServiceTouched: false,
            productionDataTouchedByNodeGate: false,
            stageOnlyAccountMutation: true,
            rawCodePrinted: false,
            rawCodePersistedInReport: false,
            rawCodePersistedInStage: null,
            providerTokenPrinted: false,
            farmAutomationStarted: false,
            loginOnlyWorker: true,
        },
        provider: {
            available: false,
            reason: '',
            appId: '',
            clientVersion: '',
        },
        initialLogin: {
            refreshOk: false,
            loginReady: false,
        },
        ws400Recovery: {
            triggered: false,
            secondLoginReady: false,
            freshCodeRotated: false,
        },
        worker: {
            starts: 0,
            stops: 0,
            loginGeneration: 0,
            clientVersion: '',
            failure: '',
        },
        code: {
            refreshCount: 0,
            lengths: [],
        },
        stageCleanup: {
            validationAccountRemoved: false,
            wxAccountsAfterCleanup: null,
        },
        gatePassed: false,
    };

    try {
        recovery.start();

        const availability = await provider.getAvailability({ id: validationId, platform: 'wx' });
        report.provider.available = !!(availability && availability.available === true);
        report.provider.reason = safeText(availability && availability.reason ? availability.reason : '');
        report.provider.appId = String(availability && availability.appId || '');
        report.provider.clientVersion = String(availability && availability.clientVersion || '');
        if (!report.provider.available || report.provider.appId !== EXPECTED_APP_ID) {
            throw new Error(`Provider not ready: ${report.provider.reason || 'unknown'}`);
        }

        const first = await recovery.refreshAccount(validationId, 'p8_stage_initial');
        report.initialLogin.refreshOk = !!(first && first.ok === true);
        if (!report.initialLogin.refreshOk) {
            throw new Error(`Initial refresh failed: ${safeText(first && first.reason ? first.reason : 'unknown')}`);
        }
        report.initialLogin.loginReady = await waitUntil(() => loginGeneration >= 1 || !!childFailure, 35000, 100);
        if (childFailure || loginGeneration < 1) {
            throw new Error(`Initial login-only worker failed: ${childFailure || 'timeout'}`);
        }

        report.ws400Recovery.triggered = true;
        recovery.handleAccountLog({
            accountId: validationId,
            accountName: validationName,
            action: 'ws_400',
        });

        const recovered = await waitUntil(
            () => loginGeneration >= 2 || !!childFailure,
            50000,
            100,
        );
        report.ws400Recovery.secondLoginReady = recovered && loginGeneration >= 2 && !childFailure;
        if (!report.ws400Recovery.secondLoginReady) {
            throw new Error(`WS400 recovery login failed: ${childFailure || 'timeout'}`);
        }

        report.ws400Recovery.freshCodeRotated = capturedCodes.length >= 2 && capturedCodes[0] !== capturedCodes[1];
        if (!report.ws400Recovery.freshCodeRotated) {
            throw new Error('Second Provider refresh did not rotate the transient Code');
        }

        const persistedText = fs.readFileSync(accountsFile, 'utf8');
        report.safety.rawCodePersistedInStage = capturedCodes.some(code => code && persistedText.includes(code));
        if (report.safety.rawCodePersistedInStage) {
            throw new Error('Safety violation: transient Code appeared in staged accounts.json');
        }

        report.gatePassed = true;
    } finally {
        recovery.stop();
        stopLoginOnlyWorker(validationId);
        await waitUntil(() => !workers[validationId], 3000, 50);
        try { baseStore.deleteAccount(validationId); } catch {}

        const after = baseStore.getAccounts();
        const afterAccounts = Array.isArray(after && after.accounts) ? after.accounts : [];
        report.stageCleanup.validationAccountRemoved = !afterAccounts.some(account => String(account && account.id || '') === validationId);
        report.stageCleanup.wxAccountsAfterCleanup = afterAccounts.filter(account => String(account && account.platform || '').toLowerCase() === 'wx').length;
        report.worker.starts = starts;
        report.worker.stops = stops;
        report.worker.loginGeneration = loginGeneration;
        report.worker.clientVersion = loginClientVersion;
        report.worker.failure = childFailure;
        report.code.refreshCount = capturedCodes.length;
        report.code.lengths = codeLengths.slice(0, 4);
        if (report.safety.rawCodePersistedInStage === null) {
            try {
                const persistedText = fs.readFileSync(accountsFile, 'utf8');
                report.safety.rawCodePersistedInStage = capturedCodes.some(code => code && persistedText.includes(code));
            } catch {
                report.safety.rawCodePersistedInStage = null;
            }
        }
        report.gatePassed = !!report.gatePassed
            && report.stageCleanup.validationAccountRemoved
            && report.stageCleanup.wxAccountsAfterCleanup === 0
            && report.safety.rawCodePersistedInStage === false
            && starts === 2
            && stops >= 1
            && loginGeneration >= 2;

        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }

    console.log('P8 isolated stage login/recovery gate completed.');
    console.log(`Provider ready: ${report.provider.available}`);
    console.log(`Initial real login-only worker: ${report.initialLogin.loginReady}`);
    console.log(`WS400 second real login: ${report.ws400Recovery.secondLoginReady}`);
    console.log(`Fresh Code rotated: ${report.ws400Recovery.freshCodeRotated}`);
    console.log(`Worker starts/stops: ${report.worker.starts}/${report.worker.stops}`);
    console.log(`Transient Code persisted in stage: ${report.safety.rawCodePersistedInStage}`);
    console.log(`Stage validation account removed: ${report.stageCleanup.validationAccountRemoved}`);
    console.log(`Gate passed: ${report.gatePassed}`);
    console.log(`Report: ${reportPath}`);

    if (!report.gatePassed) process.exitCode = 2;
}

main().catch(err => {
    const message = safeText(err && err.message ? err.message : err);
    console.error(`P8 isolated stage gate failed: ${message}`);
    process.exitCode = 2;
});
