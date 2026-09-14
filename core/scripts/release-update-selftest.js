const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertCanonicalOrigin, createReleaseUpdater, isDockerRuntime } = require('../src/services/release-updater');
const { requireAdmin } = require('../src/controllers/update-api');

function fakeResponse() {
    return {
        statusCode: 200,
        payload: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.payload = payload;
            return this;
        },
    };
}

function makeRunner(currentSha, targetSha) {
    const calls = [];
    const runner = (file, args) => {
        calls.push([file, ...args]);
        const joined = args.join(' ');
        if (joined === 'branch --show-current') return { status: 0, stdout: 'main', stderr: '' };
        if (joined === 'remote get-url origin') return { status: 0, stdout: 'https://github.com/xianyumht-cmd/far2.git', stderr: '' };
        if (joined === 'status --porcelain --untracked-files=no') return { status: 0, stdout: '', stderr: '' };
        if (joined === 'rev-parse HEAD') return { status: 0, stdout: currentSha, stderr: '' };
        if (joined === 'rev-parse origin/main') return { status: 0, stdout: targetSha, stderr: '' };
        if (joined.startsWith('merge-base --is-ancestor ')) return { status: 0, stdout: '', stderr: '' };
        if (joined === 'fetch --prune origin main') return { status: 0, stdout: '', stderr: '' };
        if (joined === 'show origin/main:core/package.json') return { status: 0, stdout: '{"version":"2.3.1"}', stderr: '' };
        if (joined.startsWith('log --format=')) return { status: 0, stdout: 'abc123\tfeat: updater', stderr: '' };
        if (file === 'sc.exe' || file === 'sc') return { status: 0, stdout: 'RUNNING', stderr: '' };
        if ((file === 'schtasks.exe' || file === 'schtasks') && joined.startsWith('/Query /TN ')) return { status: 0, stdout: 'Ready', stderr: '' };
        if ((file === 'schtasks.exe' || file === 'schtasks') && joined.startsWith('/Run /TN ')) return { status: 0, stdout: 'SUCCESS', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
    };
    return { runner, calls };
}

async function main() {
    assert.equal(assertCanonicalOrigin('https://github.com/xianyumht-cmd/far2.git'), 'https://github.com/xianyumht-cmd/far2.git');
    assert.equal(assertCanonicalOrigin('git@github.com:xianyumht-cmd/far2.git'), 'git@github.com:xianyumht-cmd/far2.git');
    assert.throws(() => assertCanonicalOrigin('https://evil.example/far2.git'), error => error.code === 'update_origin_rejected');
    assert.throws(() => assertCanonicalOrigin('https://github.com/attacker/far2.git'), error => error.code === 'update_origin_rejected');

    assert.equal(isDockerRuntime({ existsSync: p => p === '/.dockerenv' }, { env: {} }), true);
    assert.equal(isDockerRuntime({ existsSync: () => false }, { env: { FAR2_DEPLOYMENT_MODE: 'docker' } }), true);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'far2-update-selftest-'));
    fs.mkdirSync(path.join(root, '.git'));
    fs.mkdirSync(path.join(root, 'core', 'data'), { recursive: true });
    fs.mkdirSync(path.join(root, 'core', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'core', 'package.json'), '{"version":"2.2.2"}\n');
    fs.writeFileSync(path.join(root, 'core', 'scripts', 'release-update-worker.js'), '// fixture\n');

    const currentSha = '1'.repeat(40);
    const targetSha = '2'.repeat(40);
    const { runner, calls } = makeRunner(currentSha, targetSha);
    let spawnArgs = null;
    const updater = createReleaseUpdater({
        projectRoot: root,
        runner,
        restartSupported: true,
        processRef: {
            platform: 'win32',
            pid: 4567,
            execPath: 'C:\\Program Files\\nodejs\\node.exe',
            env: {},
            pkg: false,
        },
        spawnRef(file, args, options) {
            spawnArgs = { file, args, options };
            return { pid: 7654, unref() {} };
        },
    });

    const capability = updater.capability();
    assert.equal(capability.supported, true);
    assert.equal(capability.mode, 'source');
    assert.equal(capability.origin, 'https://github.com/xianyumht-cmd/far2.git');

    const checked = await updater.check();
    assert.equal(checked.available, true);
    assert.equal(checked.targetSha, targetSha);
    assert.equal(checked.latestVersion, '2.3.1');
    assert.deepEqual(checked.releaseNotes, ['abc123\tfeat: updater']);
    assert.ok(calls.some(call => call.join(' ').includes('fetch --prune origin main')));
    assert.ok(!calls.some(call => call.join(' ').includes('evil.example')));

    const started = updater.beginApply();
    assert.equal(started.accepted, true);
    assert.equal(started.workerPid, 7654);
    assert.equal(spawnArgs.file, 'C:\\Program Files\\nodejs\\node.exe');
    assert.deepEqual(spawnArgs.args.slice(-2), ['--parent-pid', '4567']);
    assert.equal(updater.loadState().phase, 'queued');
    assert.equal(updater.beginApply().accepted, false);

    updater.saveState({ phase: 'idle', requestedAction: '' });
    const scheduledUpdater = createReleaseUpdater({
        projectRoot: root,
        runner,
        processRef: {
            platform: 'win32',
            pid: 4567,
            execPath: 'C:\\Program Files\\nodejs\\node.exe',
            env: { FAR2_SERVICE_NAME: 'FAR2Farm', FAR2_UPDATE_TASK_NAME: 'FAR2UpdateAgent' },
            pkg: false,
        },
    });
    const scheduledCapability = scheduledUpdater.capability();
    assert.equal(scheduledCapability.supported, true);
    assert.equal(scheduledCapability.executionMode, 'windows_task');
    assert.equal(scheduledCapability.updateTaskName, 'FAR2UpdateAgent');
    const queuedCheck = scheduledUpdater.beginCheck();
    assert.equal(queuedCheck.accepted, true);
    assert.equal(queuedCheck.action, 'check');
    assert.equal(queuedCheck.transport, 'windows_task');
    assert.equal(scheduledUpdater.loadState().requestedAction, 'check');
    assert.ok(calls.some(call => call.join(' ').includes('/Run /TN FAR2UpdateAgent')));
    const scheduledCheck = scheduledUpdater.performCheck({ allowQueued: true });
    assert.equal(scheduledCheck.available, true);
    assert.equal(scheduledUpdater.loadState().phase, 'idle');

    scheduledUpdater.saveState({
        phase: 'updating',
        stage: 'verify',
        previousSha: currentSha,
        targetSha,
        requestedAction: 'apply',
        workerPid: 9999,
        workerStartedAt: Date.now(),
    });
    const recoveryUpdater = createReleaseUpdater({
        projectRoot: root,
        runner,
        isProcessAlive: () => false,
        processRef: {
            platform: 'win32',
            pid: 4567,
            execPath: 'C:\\Program Files\\nodejs\\node.exe',
            env: { FAR2_SERVICE_NAME: 'FAR2Farm', FAR2_UPDATE_TASK_NAME: 'FAR2UpdateAgent' },
            pkg: false,
        },
    });
    assert.throws(() => recoveryUpdater.beginCheck(), error => error.code === 'update_recovery_required');
    const queuedRecovery = recoveryUpdater.beginApply();
    assert.equal(queuedRecovery.accepted, true);
    assert.equal(recoveryUpdater.loadState().recoveryRequired, true);
    const recovered = recoveryUpdater.recoverInterruptedUpdate();
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.previousSha, currentSha);
    assert.ok(calls.some(call => call.join(' ').includes(`reset --hard ${currentSha}`)));
    assert.ok(calls.some(call => call.join(' ').includes('install --frozen-lockfile')));
    assert.ok(calls.some(call => call.join(' ').includes('build')));

    recoveryUpdater.saveState({
        phase: 'checking',
        stage: 'fetch',
        requestedAction: 'check',
        workerPid: 9998,
        workerStartedAt: Date.now(),
        previousSha: '',
        targetSha: '',
    });
    assert.equal(recoveryUpdater.beginCheck().accepted, true);
    assert.equal(recoveryUpdater.loadState().phase, 'queued');
    assert.equal(recoveryUpdater.loadState().recoveryRequired, false);
    recoveryUpdater.saveState({ phase: 'idle', requestedAction: '', recoveryRequired: false });

    const installerPath = path.join(__dirname, '..', '..', 'scripts', 'windows', 'install-far2-update-agent.ps1');
    const installer = fs.readFileSync(installerPath, 'utf8');
    assert.match(installer, /FAR2_UPDATE_TASK_NAME/);
    assert.match(installer, /LogonType Interactive/);
    assert.match(installer, /ls-remote/);
    assert.match(installer, /GIT_TERMINAL_PROMPT/);
    assert.ok(installer.includes("@('install', '--frozen-lockfile')"));
    assert.ok(installer.includes("@('verify')"));
    assert.match(installer, /Verification changed tracked files/);

    const bootstrapCmdPath = path.join(__dirname, '..', '..', 'install-webui-update.cmd');
    const bootstrapCmd = fs.readFileSync(bootstrapCmdPath, 'utf8');
    assert.match(bootstrapCmd, /install-far2-update-agent\.ps1/);

    const denied = fakeResponse();
    assert.equal(requireAdmin({ currentUser: { role: 'user' } }, denied), false);
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.payload.errorCode, 'admin_required');
    const allowed = fakeResponse();
    assert.equal(requireAdmin({ currentUser: { role: 'admin' } }, allowed), true);
    assert.equal(allowed.statusCode, 200);

    const dockerUpdater = createReleaseUpdater({
        projectRoot: root,
        runner,
        restartSupported: true,
        processRef: { platform: 'linux', pid: 1, execPath: '/usr/bin/node', env: { FAR2_DEPLOYMENT_MODE: 'docker' }, pkg: false },
    });
    const dockerCapability = dockerUpdater.capability();
    assert.equal(dockerCapability.supported, false);
    assert.equal(dockerCapability.reason, 'docker_requires_external_orchestrator');

    fs.rmSync(root, { recursive: true, force: true });
    console.log('release-update-selftest: PASS');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
