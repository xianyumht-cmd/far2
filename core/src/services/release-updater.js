const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { spawn, spawnSync } = require('node:child_process');

const OFFICIAL_ORIGIN_PATTERNS = [
    /^https:\/\/github\.com\/xianyumht-cmd\/far2(?:\.git)?\/?$/i,
    /^git@github\.com:xianyumht-cmd\/far2(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/xianyumht-cmd\/far2(?:\.git)?\/?$/i,
];
const UPDATE_BRANCH = 'main';
const STATE_VERSION = 1;
const WORKER_MAX_RUNTIME_MS = 3 * 60 * 60 * 1000;
const ACTIVE_PHASES = new Set(['queued', 'checking', 'updating', 'rolling_back', 'restart_pending']);
const WORKER_PHASES = new Set(['checking', 'updating', 'rolling_back']);

function assertCanonicalOrigin(value) {
    const origin = String(value || '').trim();
    if (!OFFICIAL_ORIGIN_PATTERNS.some(pattern => pattern.test(origin))) {
        const error = new Error(`Unexpected FAR2 origin: ${origin || '(empty)'}`);
        error.code = 'update_origin_rejected';
        throw error;
    }
    return origin;
}

function isDockerRuntime(fsRef = fs, processRef = process) {
    if (String(processRef.env.FAR2_DEPLOYMENT_MODE || '').toLowerCase() === 'docker') return true;
    try {
        return fsRef.existsSync('/.dockerenv');
    } catch {
        return false;
    }
}

function commandName(name, processRef = process) {
    if (processRef.platform === 'win32' && name === 'pnpm') return 'pnpm.cmd';
    if (processRef.platform === 'win32' && name === 'sc') return 'sc.exe';
    if (processRef.platform === 'win32' && name === 'schtasks') return 'schtasks.exe';
    return name;
}

function defaultRunner(file, args, options = {}) {
    const result = spawnSync(file, args, {
        cwd: options.cwd,
        encoding: 'utf8',
        windowsHide: true,
        timeout: options.timeout || 120000,
        maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
        env: options.env || process.env,
    });
    const stdout = String(result.stdout || '').trim();
    const stderr = String(result.stderr || '').trim();
    const status = Number.isInteger(result.status) ? result.status : (result.error ? -1 : 0);
    if (result.error && !options.allowFailure) throw result.error;
    if (status !== 0 && !options.allowFailure) {
        const error = new Error(`${file} ${args.join(' ')} failed (${status}): ${stderr || stdout || 'no output'}`);
        error.code = 'update_command_failed';
        error.command = file;
        error.status = status;
        throw error;
    }
    return { status, stdout, stderr, error: result.error || null };
}

function atomicWriteJson(fsRef, filename, value) {
    const directory = path.dirname(filename);
    fsRef.mkdirSync(directory, { recursive: true });
    const temp = `${filename}.${process.pid}.${Date.now()}.tmp`;
    fsRef.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsRef.renameSync(temp, filename);
}

function safeReadJson(fsRef, filename, fallback) {
    try {
        const parsed = JSON.parse(fsRef.readFileSync(filename, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function createReleaseUpdater(options = {}) {
    const fsRef = options.fsRef || fs;
    const processRef = options.processRef || process;
    const runner = options.runner || defaultRunner;
    const spawnRef = options.spawnRef || spawn;
    const projectRoot = path.resolve(options.projectRoot || path.join(__dirname, '../../..'));
    const coreDir = path.join(projectRoot, 'core');
    const dataDir = path.resolve(options.dataDir || path.join(coreDir, 'data'));
    const statePath = path.join(dataDir, 'update-state.json');
    const gitDir = path.join(projectRoot, '.git');

    function run(file, args, extra = {}) {
        return runner(commandName(file, processRef), args, {
            cwd: projectRoot,
            timeout: extra.timeout,
            allowFailure: !!extra.allowFailure,
            maxBuffer: extra.maxBuffer,
            env: processRef.env,
        });
    }

    function git(args, extra = {}) {
        return run('git', args, extra);
    }

    function pnpm(args, extra = {}) {
        return run('pnpm', args, extra);
    }

    function loadState() {
        return safeReadJson(fsRef, statePath, {
            version: STATE_VERSION,
            phase: 'idle',
            updatedAt: 0,
        });
    }

    function saveState(patch) {
        const next = {
            ...loadState(),
            ...patch,
            version: STATE_VERSION,
            updatedAt: Date.now(),
        };
        atomicWriteJson(fsRef, statePath, next);
        return next;
    }

    function isProcessAlive(pid) {
        const numericPid = Number(pid) || 0;
        if (!numericPid) return false;
        if (typeof options.isProcessAlive === 'function') return !!options.isProcessAlive(numericPid);
        if (typeof processRef.kill !== 'function') return true;
        try {
            processRef.kill(numericPid, 0);
            return true;
        } catch (error) {
            return !!(error && error.code === 'EPERM');
        }
    }

    function getCurrentVersion() {
        try {
            const pkg = JSON.parse(fsRef.readFileSync(path.join(coreDir, 'package.json'), 'utf8'));
            return String(pkg.version || 'unknown');
        } catch {
            return 'unknown';
        }
    }

    function getGitSnapshot() {
        if (!fsRef.existsSync(gitDir)) return { branch: '', sha: '' };
        const branch = git(['branch', '--show-current'], { allowFailure: true }).stdout;
        const sha = git(['rev-parse', 'HEAD'], { allowFailure: true }).stdout;
        return { branch, sha };
    }

    function getServiceName() {
        const serviceName = String(processRef.env.FAR2_SERVICE_NAME || 'FAR2Farm').trim();
        return /^[\w.-]{1,64}$/.test(serviceName) ? serviceName : '';
    }

    function getUpdateTaskName() {
        const configured = options.updateTaskName !== undefined
            ? options.updateTaskName
            : processRef.env.FAR2_UPDATE_TASK_NAME;
        const taskName = String(configured || '').trim();
        return /^[\w.-]{1,64}$/.test(taskName) ? taskName : '';
    }

    function getUpdateTransport() {
        if (options.restartSupported !== undefined) {
            const supported = !!options.restartSupported;
            return {
                supported,
                executionMode: supported ? 'direct_worker' : '',
                reason: supported ? 'ready' : 'automatic_restart_not_available',
                autoRestart: supported,
                updateTaskName: '',
            };
        }

        if (processRef.platform === 'win32') {
            const serviceName = getServiceName();
            if (!serviceName) {
                return { supported: false, executionMode: '', reason: 'automatic_restart_not_available', autoRestart: false, updateTaskName: '' };
            }
            const service = run('sc', ['query', serviceName], { allowFailure: true, timeout: 10000 });
            if (service.status !== 0) {
                return { supported: false, executionMode: '', reason: 'automatic_restart_not_available', autoRestart: false, updateTaskName: '' };
            }

            const updateTaskName = getUpdateTaskName();
            if (!updateTaskName) {
                return { supported: false, executionMode: '', reason: 'windows_update_agent_not_installed', autoRestart: true, updateTaskName: '' };
            }
            const task = run('schtasks', ['/Query', '/TN', updateTaskName], { allowFailure: true, timeout: 10000 });
            if (task.status !== 0) {
                return { supported: false, executionMode: '', reason: 'windows_update_agent_unavailable', autoRestart: true, updateTaskName };
            }
            return { supported: true, executionMode: 'windows_task', reason: 'ready', autoRestart: true, updateTaskName, serviceName };
        }

        const supported = String(processRef.env.FAR2_UPDATE_EXIT_RESTART || '') === '1';
        return {
            supported,
            executionMode: supported ? 'direct_worker' : '',
            reason: supported ? 'ready' : 'automatic_restart_not_available',
            autoRestart: supported,
            updateTaskName: '',
        };
    }

    function capability() {
        if (processRef.pkg) {
            return { supported: false, mode: 'packaged', reason: 'packaged_release_updater_not_configured', autoRestart: false };
        }
        if (isDockerRuntime(fsRef, processRef)) {
            return { supported: false, mode: 'docker', reason: 'docker_requires_external_orchestrator', autoRestart: false };
        }
        if (!fsRef.existsSync(gitDir)) {
            return { supported: false, mode: 'source', reason: 'git_checkout_required', autoRestart: false };
        }
        const snapshot = getGitSnapshot();
        if (snapshot.branch !== UPDATE_BRANCH) {
            return { supported: false, mode: 'source', reason: `checkout_${UPDATE_BRANCH}_required`, autoRestart: false };
        }
        let origin = '';
        try {
            origin = assertCanonicalOrigin(git(['remote', 'get-url', 'origin']).stdout);
        } catch (error) {
            return { supported: false, mode: 'source', reason: error.code || 'update_origin_rejected', autoRestart: false };
        }
        const transport = getUpdateTransport();
        return {
            ...transport,
            mode: 'source',
            origin,
        };
    }

    function ensureCleanMain() {
        const cap = capability();
        if (!cap.supported) {
            const error = new Error(cap.reason);
            error.code = cap.reason;
            throw error;
        }
        const dirty = git(['status', '--porcelain', '--untracked-files=no']).stdout;
        if (dirty) {
            const error = new Error('FAR2 source checkout has tracked local changes; update refused.');
            error.code = 'update_worktree_dirty';
            throw error;
        }
        return cap;
    }

    function versionAt(ref) {
        const raw = git(['show', `${ref}:core/package.json`]).stdout;
        try {
            return String(JSON.parse(raw).version || 'unknown');
        } catch {
            return 'unknown';
        }
    }

    function reconcileRestartState() {
        const state = loadState();
        if (state.phase !== 'restart_pending') return state;
        const oldPid = Number(state.restartFromPid) || 0;
        if (!oldPid || oldPid === Number(processRef.pid)) return state;
        const current = getGitSnapshot();
        if (current.sha && current.sha === state.targetSha) {
            return saveState({
                phase: 'completed',
                stage: 'healthy_after_restart',
                message: '升级完成，FAR2 已使用新版本重新启动。',
                completedAt: Date.now(),
                restartPending: false,
                workerPid: 0,
            });
        }
        return state;
    }

    function reconcileQueuedState(state) {
        if (!state || state.phase !== 'queued') return state;
        const updatedAt = Number(state.updatedAt) || 0;
        if (!updatedAt || Date.now() - updatedAt < 45000) return state;
        return saveState({
            phase: 'failed',
            stage: 'update_agent_start_timeout',
            message: 'Windows Update Agent 未在 45 秒内启动。请确认安装任务且对应 Windows 用户处于登录状态。',
            lastError: 'Update Agent start timed out.',
            errorCode: 'update_agent_start_timeout',
            requestedAction: '',
            restartPending: false,
            workerPid: 0,
            workerStartedAt: 0,
        });
    }

    function reconcileWorkerState(state) {
        if (!state || !WORKER_PHASES.has(String(state.phase || ''))) return state;
        const workerPid = Number(state.workerPid) || 0;
        const workerStartedAt = Number(state.workerStartedAt) || 0;
        const runtimeExceeded = !!workerStartedAt && Date.now() - workerStartedAt > WORKER_MAX_RUNTIME_MS;
        if (workerPid && !runtimeExceeded && isProcessAlive(workerPid)) return state;

        const previousSha = String(state.previousSha || '').trim();
        const hasRollbackPoint = /^[0-9a-f]{40}$/i.test(previousSha);
        const requiresRecovery = state.phase === 'rolling_back'
            || (state.phase === 'updating' && hasRollbackPoint);
        return saveState({
            phase: requiresRecovery ? 'recovery_required' : 'interrupted',
            stage: requiresRecovery ? 'worker_interrupted_recovery_required' : 'worker_interrupted',
            message: requiresRecovery
                ? '升级 Worker 意外中断。下一次“一键升级”会先恢复上一个已验证版本，再重新升级。'
                : '升级 Worker 意外中断，可以重新执行检查或升级。',
            lastError: runtimeExceeded
                ? 'Update Agent exceeded the maximum runtime.'
                : (workerPid ? 'Update Agent process is no longer running.' : 'Update Agent process metadata is missing.'),
            errorCode: requiresRecovery ? 'update_recovery_required' : 'update_worker_interrupted',
            requestedAction: '',
            restartPending: false,
            workerPid: 0,
            workerStartedAt: 0,
        });
    }

    function status() {
        const snapshot = getGitSnapshot();
        const state = reconcileWorkerState(reconcileQueuedState(reconcileRestartState()));
        return {
            capability: capability(),
            currentVersion: getCurrentVersion(),
            currentSha: snapshot.sha,
            branch: snapshot.branch,
            busy: ACTIVE_PHASES.has(String(state.phase || '')),
            state,
        };
    }

    function performCheck({ allowQueued = false } = {}) {
        const currentState = loadState();
        if (!allowQueued && ACTIVE_PHASES.has(String(currentState.phase || ''))) {
            const error = new Error('An update operation is already running.');
            error.code = 'update_busy';
            throw error;
        }
        ensureCleanMain();
        saveState({ phase: 'checking', stage: 'fetch', message: '正在检查 origin/main…', lastError: '', rollbackError: '' });
        try {
            git(['fetch', '--prune', 'origin', UPDATE_BRANCH], { timeout: 120000 });
            const currentSha = git(['rev-parse', 'HEAD']).stdout;
            const targetSha = git(['rev-parse', `origin/${UPDATE_BRANCH}`]).stdout;
            const ancestor = git(['merge-base', '--is-ancestor', currentSha, targetSha], { allowFailure: true });
            if (ancestor.status !== 0) {
                const error = new Error('Local main and origin/main diverged; automatic update is blocked.');
                error.code = 'update_non_fast_forward';
                throw error;
            }
            const available = currentSha !== targetSha;
            const releaseNotes = available
                ? git(['log', '--format=%h%x09%s', '--max-count=20', `${currentSha}..${targetSha}`]).stdout.split(/\r?\n/).filter(Boolean)
                : [];
            const result = {
                available,
                currentSha,
                targetSha,
                currentVersion: getCurrentVersion(),
                latestVersion: versionAt(`origin/${UPDATE_BRANCH}`),
                releaseNotes,
                checkedAt: Date.now(),
            };
            saveState({
                phase: 'idle',
                stage: available ? 'update_available' : 'up_to_date',
                message: available ? '发现可用更新。' : '当前已是最新版本。',
                requestedAction: '',
                ...result,
            });
            return result;
        } catch (error) {
            saveState({ phase: 'failed', stage: 'check', message: '检查更新失败。', lastError: error.message, errorCode: error.code || 'update_check_failed', requestedAction: '' });
            throw error;
        }
    }

    async function check() {
        return performCheck();
    }

    function rollback(previousSha, originalError) {
        let rollbackError = null;
        try {
            saveState({ phase: 'rolling_back', stage: 'git_reset', message: '升级失败，正在恢复旧版本…', lastError: originalError.message });
            git(['reset', '--hard', previousSha], { timeout: 120000 });
            pnpm(['install', '--frozen-lockfile'], { timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
            pnpm(['build'], { timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
        } catch (error) {
            rollbackError = error;
        }
        if (rollbackError) {
            saveState({
                phase: 'rollback_failed',
                stage: 'rollback',
                message: '升级失败且自动回滚未完成，需要人工处理。',
                lastError: originalError.message,
                rollbackError: rollbackError.message,
                restartPending: false,
            });
        } else {
            saveState({
                phase: 'rolled_back',
                stage: 'rollback_complete',
                message: '升级验证失败，已自动恢复旧版本。',
                lastError: originalError.message,
                rollbackSha: previousSha,
                restartPending: false,
            });
        }
    }

    function recoverInterruptedUpdate() {
        const state = loadState();
        if (!state.recoveryRequired) return { recovered: false };

        const previousSha = String(state.recoveryPreviousSha || state.previousSha || '').trim();
        if (!/^[0-9a-f]{40}$/i.test(previousSha)) {
            const error = new Error('Interrupted update does not contain a valid rollback commit.');
            error.code = 'update_recovery_invalid_rollback_sha';
            saveState({
                phase: 'rollback_failed',
                stage: 'recovery',
                message: '上次升级中断，但缺少可验证的回滚提交，需要人工处理。',
                lastError: error.message,
                rollbackError: error.message,
                errorCode: error.code,
                restartPending: false,
            });
            throw error;
        }

        const cap = capability();
        if (!cap.supported) {
            const error = new Error(cap.reason);
            error.code = cap.reason;
            throw error;
        }

        try {
            saveState({
                phase: 'rolling_back',
                stage: 'recovery_reset',
                message: '检测到上次升级中断，正在恢复上一个已验证版本…',
                rollbackError: '',
            });
            git(['cat-file', '-e', `${previousSha}^{commit}`], { timeout: 30000 });
            git(['reset', '--hard', previousSha], { timeout: 120000 });
            pnpm(['install', '--frozen-lockfile'], { timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
            pnpm(['build'], { timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
            const restoredSha = git(['rev-parse', 'HEAD']).stdout;
            if (restoredSha !== previousSha) {
                const error = new Error(`Recovery target mismatch: ${restoredSha} != ${previousSha}`);
                error.code = 'update_recovery_target_mismatch';
                throw error;
            }
            saveState({
                phase: 'recovered',
                stage: 'recovery_complete',
                message: '已恢复上一个已验证版本，正在重新执行升级。',
                recoveryRequired: false,
                recoveryPreviousSha: '',
                recoveryTargetSha: '',
                rollbackSha: previousSha,
                lastError: '',
                rollbackError: '',
                restartPending: false,
            });
            return { recovered: true, previousSha };
        } catch (error) {
            saveState({
                phase: 'rollback_failed',
                stage: 'recovery',
                message: '上次升级中断且自动恢复失败，需要人工处理。',
                lastError: error.message,
                rollbackError: error.message,
                errorCode: error.code || 'update_recovery_failed',
                restartPending: false,
            });
            throw error;
        }
    }

    function performUpdate({ restartFromPid = 0 } = {}) {
        ensureCleanMain();
        saveState({ phase: 'updating', stage: 'fetch', message: '正在获取最新版本…', lastError: '', rollbackError: '', restartFromPid });
        git(['fetch', '--prune', 'origin', UPDATE_BRANCH], { timeout: 120000 });
        const previousSha = git(['rev-parse', 'HEAD']).stdout;
        const targetSha = git(['rev-parse', `origin/${UPDATE_BRANCH}`]).stdout;
        const ancestor = git(['merge-base', '--is-ancestor', previousSha, targetSha], { allowFailure: true });
        if (ancestor.status !== 0) {
            const error = new Error('Local main and origin/main diverged; automatic update is blocked.');
            error.code = 'update_non_fast_forward';
            saveState({ phase: 'failed', stage: 'fast_forward_check', message: '升级被阻止：本地 main 与远程发生分叉。', lastError: error.message, restartPending: false });
            throw error;
        }
        if (previousSha === targetSha) {
            return saveState({ phase: 'completed', stage: 'up_to_date', message: '当前已是最新版本。', currentSha: previousSha, targetSha, restartPending: false });
        }

        let switched = false;
        try {
            saveState({ phase: 'updating', stage: 'fast_forward', message: '正在切换到新版本…', previousSha, targetSha, restartFromPid });
            git(['merge', '--ff-only', `origin/${UPDATE_BRANCH}`], { timeout: 120000 });
            switched = true;

            saveState({ phase: 'updating', stage: 'install', message: '正在安装锁定依赖…', previousSha, targetSha, restartFromPid });
            pnpm(['install', '--frozen-lockfile'], { timeout: 600000, maxBuffer: 32 * 1024 * 1024 });

            saveState({ phase: 'updating', stage: 'verify', message: '正在执行完整 pnpm verify…', previousSha, targetSha, restartFromPid });
            pnpm(['verify'], { timeout: 20 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });

            const finalSha = git(['rev-parse', 'HEAD']).stdout;
            if (finalSha !== targetSha) throw new Error(`Update target mismatch: ${finalSha} != ${targetSha}`);
            return saveState({
                phase: restartFromPid ? 'restart_pending' : 'completed',
                stage: 'verified',
                message: restartFromPid ? '新版本验证通过，FAR2 即将自动重启…' : '新版本验证通过。',
                previousSha,
                targetSha,
                currentSha: finalSha,
                currentVersion: getCurrentVersion(),
                restartPending: !!restartFromPid,
                restartFromPid,
                verifiedAt: Date.now(),
            });
        } catch (error) {
            if (switched) rollback(previousSha, error);
            else saveState({ phase: 'failed', stage: 'apply', message: '升级失败，未切换版本。', lastError: error.message, restartPending: false });
            throw error;
        }
    }

    function launchDirectWorker(action) {
        const workerPath = path.join(coreDir, 'scripts', 'release-update-worker.js');
        if (!fsRef.existsSync(workerPath)) {
            const error = new Error(`Update worker missing: ${workerPath}`);
            error.code = 'update_worker_missing';
            throw error;
        }
        const args = [workerPath, '--action', action];
        if (action === 'apply') args.push('--parent-pid', String(processRef.pid));
        const child = spawnRef(processRef.execPath, args, {
            cwd: projectRoot,
            detached: false,
            windowsHide: true,
            stdio: 'ignore',
            env: processRef.env,
        });
        if (!child || !child.pid) {
            const error = new Error('Unable to start update worker.');
            error.code = 'update_worker_start_failed';
            throw error;
        }
        if (typeof child.unref === 'function') child.unref();
        return child.pid;
    }

    function beginOperation(action) {
        if (!['check', 'apply'].includes(action)) {
            const error = new Error(`Unsupported update action: ${action}`);
            error.code = 'update_action_invalid';
            throw error;
        }
        const currentState = reconcileWorkerState(reconcileQueuedState(reconcileRestartState()));
        if (ACTIVE_PHASES.has(String(currentState.phase || ''))) {
            return { accepted: false, reason: 'update_busy', action };
        }
        const recoveryRequired = currentState.phase === 'recovery_required';
        if (recoveryRequired && action !== 'apply') {
            const error = new Error('Interrupted update must be recovered before checking for updates.');
            error.code = 'update_recovery_required';
            throw error;
        }

        let cap;
        if (recoveryRequired) {
            cap = capability();
            if (!cap.supported) {
                const error = new Error(cap.reason);
                error.code = cap.reason;
                throw error;
            }
            const rollbackSha = String(currentState.previousSha || '').trim();
            if (!/^[0-9a-f]{40}$/i.test(rollbackSha)) {
                const error = new Error('Interrupted update does not contain a valid rollback commit.');
                error.code = 'update_recovery_invalid_rollback_sha';
                throw error;
            }
        } else {
            cap = ensureCleanMain();
        }

        const restartFromPid = action === 'apply' ? processRef.pid : 0;
        saveState({
            phase: 'queued',
            stage: 'dispatch',
            message: recoveryRequired ? '恢复任务已排队，随后会重新执行升级…' : (action === 'check' ? '检查更新任务已排队…' : '升级任务已排队…'),
            requestedAction: action,
            recoveryRequired,
            recoveryPreviousSha: recoveryRequired ? String(currentState.previousSha || '') : '',
            recoveryTargetSha: recoveryRequired ? String(currentState.targetSha || '') : '',
            workerPid: 0,
            workerStartedAt: 0,
            restartFromPid,
            restartPending: false,
            lastError: '',
            rollbackError: '',
        });

        try {
            if (cap.executionMode === 'windows_task') {
                run('schtasks', ['/Run', '/TN', cap.updateTaskName], { timeout: 10000 });
                return { accepted: true, action, transport: 'windows_task', updateTaskName: cap.updateTaskName };
            }

            const workerPid = launchDirectWorker(action);
            const afterSpawn = loadState();
            if (afterSpawn.phase === 'queued' && afterSpawn.requestedAction === action) {
                saveState({ stage: 'worker_started', workerPid });
            }
            return { accepted: true, action, transport: 'direct_worker', workerPid };
        } catch (error) {
            saveState({
                phase: 'failed',
                stage: 'dispatch',
                message: '无法启动升级任务。',
                lastError: error.message,
                errorCode: error.code || 'update_dispatch_failed',
                requestedAction: '',
                restartPending: false,
            });
            throw error;
        }
    }

    function beginCheck() {
        return beginOperation('check');
    }

    function beginApply() {
        return beginOperation('apply');
    }

    return {
        status,
        check,
        beginCheck,
        beginApply,
        capability,
        loadState,
        saveState,
        performCheck,
        recoverInterruptedUpdate,
        performUpdate,
        statePath,
        projectRoot,
    };
}

module.exports = {
    ACTIVE_PHASES,
    UPDATE_BRANCH,
    assertCanonicalOrigin,
    isDockerRuntime,
    createReleaseUpdater,
};
