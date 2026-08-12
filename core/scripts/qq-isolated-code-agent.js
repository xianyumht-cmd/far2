const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const process = require('node:process');
const { createIsolatedCodeAgent } = require('../src/services/isolated-code-agent');
const { captureFarmFriendGids } = require('../src/services/windows-runtime-friends-v3');

function maskUin(value) {
    const text = String(value || '').trim();
    if (text.length <= 4) return '****';
    return `${text.slice(0, 2)}****${text.slice(-2)}`;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getFriendArtifactPath(uin) {
    const dataDir = path.join(__dirname, '..', 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    return path.join(dataDir, `runtime-friend-gids-${String(uin || '').replace(/\D/g, '')}.json`);
}

function getBootStartedAt() {
    return Math.max(0, Date.now() - Math.round(os.uptime() * 1000));
}

function alreadyCapturedThisBoot(file, bootStartedAt) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const priorBoot = Number(parsed && parsed.bootStartedAt) || 0;
        const gids = Array.isArray(parsed && parsed.gids) ? parsed.gids : [];
        const openIds = Array.isArray(parsed && parsed.openIds) ? parsed.openIds : [];
        return (gids.length > 0 || openIds.length > 0)
            && priorBoot > 0
            && Math.abs(priorBoot - bootStartedAt) < 60 * 1000;
    } catch {
        return false;
    }
}

function writeFriendArtifact(file, payload) {
    const temp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(temp, file);
}

async function waitForAgentRuntime(agent, timeoutMs = 30000) {
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    let status = agent.inspect();
    while (!status.available && Date.now() < deadline) {
        await sleep(1000);
        status = agent.inspect();
    }
    return status;
}

async function captureStartupFriends(agent) {
    if (String(process.env.FAR2_CODE_AGENT_STARTUP_FRIEND_CAPTURE || '1') === '0') return;

    const bootStartedAt = getBootStartedAt();
    const artifact = getFriendArtifactPath(agent.expectedUin);
    if (alreadyCapturedThisBoot(artifact, bootStartedAt)) {
        console.log('[FAR2 Friend Import] already captured during this Windows boot; skip');
        return;
    }

    const status = await waitForAgentRuntime(agent, 30000);
    if (!status.available) {
        console.log(`[FAR2 Friend Import] skipped: ${status.reason}`);
        return;
    }

    try {
        console.log(`[FAR2 Friend Import] capture start qq=${maskUin(agent.expectedUin)}`);
        const captured = await captureFarmFriendGids({
            timeoutMs: 65000,
            captureWindowMs: 50000,
            log: message => console.log(`[FAR2 Friend Import] ${message}`),
        });

        const after = agent.inspect();
        if (!after.available) {
            throw Object.assign(new Error(after.reason || 'agent_runtime_identity_unverified'), {
                code: after.reason || 'agent_runtime_identity_unverified',
            });
        }

        writeFriendArtifact(artifact, {
            version: 3,
            qqUin: String(agent.expectedUin),
            bootStartedAt,
            capturedAt: Date.now(),
            gids: Array.isArray(captured.gids) ? captured.gids : [],
            openIds: Array.isArray(captured.openIds) ? captured.openIds : [],
            source: captured.source || 'windows_qq_runtime_friend_capture_v3',
            methods: Array.isArray(captured.methods) ? captured.methods : [],
        });
        console.log(`[FAR2 Friend Import] capture ok gids=${captured.gids.length} openIds=${captured.openIds.length} methods=${captured.methods.join(',') || '-'}`);
    } catch (err) {
        const reason = err && err.code ? err.code : (err && err.message ? err.message : String(err || 'unknown'));
        console.log(`[FAR2 Friend Import] capture failed: ${reason}`);
    }
}

async function main() {
    const agent = createIsolatedCodeAgent({ processRef: process });

    // Run the one-shot friend capture before opening the Agent HTTP listener. This keeps
    // game.js patching exclusive from a simultaneous fresh-Code request during boot.
    await captureStartupFriends(agent);

    const address = await agent.start();
    const host = address && typeof address === 'object' ? address.address : agent.host;
    const port = address && typeof address === 'object' ? address.port : agent.port;

    console.log('FAR2 Isolated QQ Runtime Code Agent');
    console.log(`QQ: ${maskUin(agent.expectedUin)}`);
    console.log(`Listen: http://${host}:${port}`);
    console.log('安全要求: 当前 Windows 登录会话只能运行一个 QQ 主进程；Code 不写日志。');

    const status = agent.inspect();
    console.log(`Initial status: ${status.available ? 'ready' : 'not ready'} (${status.reason})`);

    let stopping = false;
    const stop = async (signal) => {
        if (stopping) return;
        stopping = true;
        console.log(`Stopping Code Agent (${signal})...`);
        try { await agent.stop(); } catch {}
        process.exit(0);
    };

    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
}

main().catch(err => {
    console.error(`Code Agent start failed: ${err && err.message ? err.message : String(err)}`);
    process.exitCode = 1;
});
