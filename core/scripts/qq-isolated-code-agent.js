const process = require('node:process');
const { createIsolatedCodeAgent } = require('../src/services/isolated-code-agent');

function maskUin(value) {
    const text = String(value || '').trim();
    if (text.length <= 4) return '****';
    return `${text.slice(0, 2)}****${text.slice(-2)}`;
}

async function main() {
    const agent = createIsolatedCodeAgent({ processRef: process });
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
