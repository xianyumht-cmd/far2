const process = require('node:process');
const { createReleaseUpdater } = require('../src/services/release-updater');

function parseValue(argv, flag) {
    const index = argv.indexOf(flag);
    if (index < 0) return '';
    return String(argv[index + 1] || '').trim();
}

function parseParentPid(argv) {
    const value = Number.parseInt(parseValue(argv, '--parent-pid'), 10);
    return Number.isInteger(value) && value > 0 ? value : 0;
}

function terminateParent(pid) {
    if (!pid) return;
    try {
        process.kill(pid, 'SIGTERM');
    } catch (error) {
        const updater = createReleaseUpdater({ restartSupported: true });
        updater.saveState({
            phase: 'failed',
            stage: 'restart_signal',
            message: '新版本验证通过，但无法通知旧 FAR2 进程退出。',
            lastError: error && error.message ? error.message : String(error),
            restartPending: false,
        });
        throw error;
    }
}

function main() {
    const argv = process.argv.slice(2);
    const updater = createReleaseUpdater({ restartSupported: true });
    const queuedState = updater.loadState();
    updater.saveState({ workerPid: process.pid, workerStartedAt: Date.now() });
    const scheduledTask = argv.includes('--scheduled-task');
    const requestedAction = scheduledTask
        ? String(queuedState.requestedAction || '').trim()
        : (parseValue(argv, '--action') || 'apply');
    const parentPid = scheduledTask
        ? (Number(queuedState.restartFromPid) || 0)
        : parseParentPid(argv);

    if (requestedAction === 'check') {
        updater.performCheck({ allowQueued: true });
        return;
    }
    if (requestedAction !== 'apply') {
        const error = new Error(`Unsupported update action: ${requestedAction || '(empty)'}`);
        error.code = 'update_action_invalid';
        throw error;
    }
    if (!parentPid) {
        const error = new Error('Update apply requires a FAR2 parent PID.');
        error.code = 'update_parent_pid_missing';
        throw error;
    }

    if (queuedState.recoveryRequired) updater.recoverInterruptedUpdate();
    updater.performUpdate({ restartFromPid: parentPid });
    terminateParent(parentPid);
}

try {
    main();
    process.exit(0);
} catch (error) {
    try {
        const updater = createReleaseUpdater({ restartSupported: true });
        const state = updater.loadState();
        if (!['rolled_back', 'rollback_failed', 'failed'].includes(String(state.phase || ''))) {
            updater.saveState({
                phase: 'failed',
                stage: state.stage || 'worker',
                message: '升级 Worker 执行失败。',
                lastError: error && error.message ? error.message : String(error),
                errorCode: error && error.code ? error.code : 'update_worker_failed',
                restartPending: false,
            });
        }
    } catch {}
    process.exit(1);
}
