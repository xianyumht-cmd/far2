const process = require('node:process');
const { createIsolatedRuntimeCodeProvider, normalizeUin } = require('../src/services/isolated-runtime-code-provider');

function maskUin(value) {
    const text = normalizeUin(value);
    if (!text) return '';
    if (text.length <= 4) return '****';
    return `${text.slice(0, 2)}****${text.slice(-2)}`;
}

function parseArgs(argv) {
    const args = argv.slice(2);
    let uin = '';
    let refresh = false;
    for (const arg of args) {
        if (arg === '--refresh') {
            refresh = true;
            continue;
        }
        if (!uin) uin = normalizeUin(arg);
    }
    return { uin, refresh };
}

async function main() {
    const { uin, refresh } = parseArgs(process.argv);
    if (!uin) {
        console.error('用法: pnpm code:provider-check -- <QQ UIN> [--refresh]');
        console.error('默认只检查 Provider health；--refresh 会显式生成一次 fresh Code，但不会打印或保存 Code。');
        process.exitCode = 2;
        return;
    }

    if (!String(process.env.FARM_CODE_PROVIDER_TARGETS || '').trim()) {
        console.error('未配置 FARM_CODE_PROVIDER_TARGETS');
        process.exitCode = 2;
        return;
    }

    const provider = createIsolatedRuntimeCodeProvider({ processRef: process });
    const account = { id: 'provider-check', uin };
    const binding = { accountId: 'provider-check', qqUin: uin, status: 'online', needsRebind: false };

    console.log(`Provider check QQ=${maskUin(uin)} mode=${refresh ? 'health+refresh' : 'health-only'}`);
    const availability = await provider.getAvailability(account, binding);
    console.log(`health: ${availability.available ? 'READY' : 'NOT_READY'} (${availability.reason || 'unknown'})`);
    if (!availability.available) {
        process.exitCode = 1;
        return;
    }

    if (!refresh) {
        console.log('未生成 Code。要做一次隔离运行时 mint 验证，请显式追加 --refresh。');
        return;
    }

    const result = await provider.refresh({
        account,
        binding,
        reason: 'acceptance_probe',
    });
    const codeLength = String(result && result.code || '').length;
    if (!codeLength) throw new Error('Provider 未返回 fresh Code');

    console.log(`refresh: PASS source=${result.source || provider.name} codeLength=${codeLength}`);
    console.log('Code 已在内存中验证后丢弃；未打印、未保存、未修改 FAR2 账号、未重启 worker。');
}

main().catch(err => {
    const reason = err && err.code ? err.code : (err && err.message ? err.message : String(err));
    console.error(`Provider check failed: ${reason}`);
    process.exitCode = 1;
});
