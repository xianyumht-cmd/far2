/**
 * 一步拿 Farm Code（无人值守版）
 *
 * 做的事：
 *   1. 后台起一个「账号选择弹窗」看护进程（本机两个 QQ 时 QQ 可能弹窗问要开哪个号）
 *   2. 调 core 的 code 采集脚本：临时给农场 game.js 注入 qq.login() → 重新打开小程序 → 收 Code
 *   3. 采集脚本会自己恢复 game.js
 *   4. 可选 --apply：直接把 Code 写回 far2 账号并启动 worker
 *
 * 用法:
 *   node tools/capture-code.js --uin QQ_UIN
 *   node tools/capture-code.js --uin QQ_UIN --apply --account 1
 *
 * 退出码：0 = 拿到 Code；1 = 失败。
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'core');
const QQEX = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'QQEX');

function arg(name, fallback = '') {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
}
const hasFlag = name => process.argv.includes(`--${name}`);

function codeFileFor(uin) {
    return path.join(QQEX, 'miniapp', 'fs', String(uin), '1112386029', 'usr', '_code.txt');
}

async function main() {
    const uin = arg('uin', process.env.FAR2_TARGET_UIN || '');
    const apply = hasFlag('apply');
    const accountId = arg('account', '1');
    if (!uin) {
        console.error('Missing target UIN: provide --uin or FAR2_TARGET_UIN');
        process.exitCode = 2;
        return;
    }

    // 说明：QQ 的「选择账号」是主窗口内的 Chromium 弹层（EnumWindows 里找不到独立 HWND，
    // UIA 也拿不到节点），所以这里不做「点按钮」的尝试，只靠「按实际 UIN 绑定」保证不写错号。

    // 1.5) 先关掉已经打开的 QQ 农场窗口：
    //      采集原理是给 game.js 注入 qq.login() 后让小程序重新加载，
    //      窗口如果还开着，QQ 只会聚焦旧窗口，不会重新执行 game.js，就永远拿不到 Code。
    const closeOut = spawnSync(process.execPath, [
        path.join(__dirname, 'qq-account-picker.js'), 'close-farm', '--proc', 'QQ',
    ], { encoding: 'utf8', timeout: 30000 });
    console.log(`CLOSE_FARM ${String(closeOut.stdout || '').trim()}`);
    await new Promise(resolve => setTimeout(resolve, 2500));

    // 2) 采集 Code
    const startedAt = Date.now();
    const capture = spawnSync(process.execPath, [path.join(CORE, 'scripts', 'qq-runtime-code-capture-test.js')], {
        cwd: CORE,
        encoding: 'utf8',
        timeout: 150000,
    });
    const captureOut = `${capture.stdout || ''}${capture.stderr || ''}`;
    const ok = /"captured":\s*true/.test(captureOut) || /捕获到运行时 Code/.test(captureOut);

    // QQ 可能用「另一个已登录的号」把小程充打开（这时 picker 未必弹窗），
    // 所以这里扫描所有 UIN 目录，认最新那份 _code.txt，并把它对应的 UIN 一起报出来。
    let code = '';
    let actualUin = '';
    try {
        const fsRoot = path.join(QQEX, 'miniapp', 'fs');
        for (const entry of fs.readdirSync(fsRoot, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const candidate = codeFileFor(entry.name);
            try {
                const stat = fs.statSync(candidate);
                if (stat.mtimeMs < startedAt - 2000) continue;
                const value = fs.readFileSync(candidate, 'utf8').trim();
                if (!value) continue;
                code = value;
                actualUin = entry.name;
                break;
            } catch { /* 该 UIN 没有 code 文件 */ }
        }
    } catch { /* fs 目录不存在 */ }

    console.log(`UIN ${uin}`);
    console.log(`CAPTURE ${ok ? 'ok' : 'failed'}`);

    if (!ok || !code) {
        console.log('RESULT failed');
        process.exitCode = 1;
        return;
    }
    if (actualUin && actualUin !== uin) {
        console.log(`WARN QQ 实际打开的是 ${actualUin}（不是请求的 ${uin}）`);
        if (hasFlag('require-uin')) {
            console.log(`RESULT aborted 严格模式要求 ${uin}，本次丢弃（未写入任何账号）`);
            process.exitCode = 2;
            return;
        }
        console.log('      按实际 UIN 绑定（加 --require-uin 可改为丢弃重试）');
    }
    console.log(`ACTUAL_UIN ${actualUin || uin}`);
    console.log(`CODE ${code.slice(0, 4)}...${code.slice(-4)} (len=${code.length})`);

    if (!apply) {
        console.log('RESULT captured（未回写，加 --apply 可直接写进账号并重启 worker）');
        return;
    }

    // 4) 回写账号并启动
    const base = process.env.FAR2_BASE || 'http://127.0.0.1:3007';
    const password = process.env.FAR2_ADMIN_PASS || '';
    const loginRes = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: process.env.FAR2_ADMIN_USER || 'admin', password }),
    }).then(r => r.json());
    const token = loginRes && loginRes.data && loginRes.data.token;
    if (!token) throw new Error('管理员登录失败');

    const headers = { 'content-type': 'application/json', 'x-admin-token': token, 'x-account-id': String(accountId) };
    // 按「实际 UIN」找账号：没有就建，有就更新 code，然后启动
    const list = await fetch(`${base}/api/accounts`, { headers }).then(r => r.json());
    const accounts = (list && list.data && list.data.accounts) || [];
    const targetUin = actualUin || uin;
    let account = accounts.find(acc => String(acc.uin) === String(targetUin));

    if (!account) {
        const created = await fetch(`${base}/api/accounts`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                name: `本机农场-${targetUin}`,
                uin: targetUin,
                code,
                platform: 'qq',
                avatar: `https://q1.qlogo.cn/g?b=qq&nk=${targetUin}&s=640`,
            }),
        }).then(r => r.json());
        if (!created.ok) throw new Error(`建号失败: ${JSON.stringify(created).slice(0, 140)}`);
        const list2 = await fetch(`${base}/api/accounts`, { headers }).then(r => r.json());
        account = ((list2.data && list2.data.accounts) || []).find(acc => String(acc.uin) === String(targetUin));
    } else {
        const upd = await fetch(`${base}/api/accounts`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ id: account.id, uin: targetUin, code, platform: 'qq' }),
        }).then(r => r.json());
        if (!upd.ok) throw new Error(`回写失败: ${JSON.stringify(upd).slice(0, 140)}`);
    }

    if (!account) throw new Error('账号定位失败');
    const started = await fetch(`${base}/api/accounts/${account.id}/start`, {
        method: 'POST', headers, body: '{}',
    }).then(r => r.json()).catch(error => ({ ok: false, error: String(error.message) }));
    console.log(`APPLY account=${account.id} uin=${targetUin} start=${JSON.stringify(started).slice(0, 100)}`);
    console.log('RESULT applied');
}

main().catch((error) => {
    console.error('FAILED', error && error.message);
    process.exitCode = 1;
});
