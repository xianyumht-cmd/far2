/**
 * QQ Code 守护（事件驱动，不做定期刷新）
 *
 * 规则（按用户要求）：
 *   1. 开机不自作主张启动任何东西；只有检测到 QQ.exe 在跑才开始工作；
 *   2. **只有**日志/状态显示登录态失效（connected=false / kickout / code invalid）才刷新 Code；
 *   3. 不做「每隔 N 分钟刷一次」的定期刷新；
 *   4. 每个账号独立：刷新后按实际 UIN 校验，不是目标号就丢弃（不写错号）；
 *   5. 失败有冷却（默认 10 分钟），避免连点导致 QQ 反复顶号。
 *
 * 用法:
 *   node tools/code-supervisor.js                     # 前台跑（调试用）
 *   node tools/code-supervisor.js --interval 30       # 检查间隔（秒）
 *   node tools/code-supervisor.js --once              # 只检查一轮就退出
 *
 * 环境变量:
 *   FAR2_ADMIN_PASS    管理员密码（可选；缺省时读本机安全存储）
 *   FAR2_ADMIN_SECRET_FILE  密码文件路径，默认 %USERPROFILE%\.far2\admin-pass.txt
 *   FAR2_BASE          默认 http://127.0.0.1:3007
 *   FAR2_CODE_SUPERVISOR_UINS  可选 QQ UIN 白名单，逗号分隔；未设置则监控全部保存账号
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { parseScope, shouldMonitorAccount } = require('./code-supervisor-scope');

const BASE = process.env.FAR2_BASE || 'http://127.0.0.1:3007';
function readLocalAdminSecret() {
    // 本机安全存储：默认 %USERPROFILE%\.far2\admin-pass.txt（仅当前用户可读，从不入库）
    const file = process.env.FAR2_ADMIN_SECRET_FILE
        || path.join(os.homedir(), '.far2', 'admin-pass.txt');
    try {
        const value = fs.readFileSync(file, 'utf8').split(/\r?\n/)[0].trim();
        return value || '';
    } catch {
        return '';
    }
}

const PASS = process.env.FAR2_ADMIN_PASS || readLocalAdminSecret();
const USER = process.env.FAR2_ADMIN_USER || 'admin';
const TARGET_SCOPE = parseScope(process.env.FAR2_CODE_SUPERVISOR_UINS);
const INTERVAL = Number(process.argv.includes('--interval')
    ? process.argv[process.argv.indexOf('--interval') + 1]
    : 30);
const ONCE = process.argv.includes('--once');
const COOLDOWN_MS = 10 * 60 * 1000;
const FAIL_THRESHOLD = 2;

const state = {
    token: '',
    tokenAt: 0,
    failures: new Map(),      // accountId -> 连续失败次数
    lastRefreshAt: new Map(), // accountId -> 时间戳
};

function log(message) {
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

function qqRunning() {
    try {
        const out = execFileSync('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            '@(Get-Process QQ -ErrorAction SilentlyContinue).Count',
        ], { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim();
        return Number(out) > 0;
    } catch {
        return false;
    }
}

async function api(pathname, options = {}) {
    const headers = { 'content-type': 'application/json' };
    if (state.token) headers['x-admin-token'] = state.token;
    if (options.accountId) headers['x-account-id'] = String(options.accountId);
    const res = await fetch(`${BASE}${pathname}`, {
        method: options.method || 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json };
}

async function ensureToken() {
    if (state.token && Date.now() - state.tokenAt < 30 * 60 * 1000) return true;
    const res = await api('/api/login', { method: 'POST', body: { username: USER, password: PASS } });
    const token = res.json && res.json.data && res.json.data.token;
    if (!token) {
        log(`登录 far2 失败: ${JSON.stringify(res.json).slice(0, 120)}`);
        return false;
    }
    state.token = token;
    state.tokenAt = Date.now();
    return true;
}

function runCapture(uin) {
    const args = [
        path.join(__dirname, 'capture-code.js'),
        '--uin', String(uin),
        '--apply',
        '--require-uin',
    ];
    log(`刷新 Code: ${uin}`);
    try {
        const out = execFileSync(process.execPath, args, {
            encoding: 'utf8',
            timeout: 240000,
            env: { ...process.env, FAR2_ADMIN_PASS: PASS, FAR2_BASE: BASE },
        });
        const lines = String(out).trim().split(/\r?\n/).slice(-6).join(' | ');
        log(`刷新结果: ${lines}`);
        return /RESULT applied/.test(out);
    } catch (error) {
        const out = String(error.stdout || '') + String(error.stderr || '');
        const tail = out.trim().split(/\r?\n/).slice(-4).join(' | ');
        log(`刷新失败: ${error.status === 2 ? '采到的是别的号，已丢弃' : (tail || error.message)}`);
        return false;
    }
}

async function checkAccount(account) {
    const id = String(account.id);
    const res = await api('/api/status', { accountId: id });
    if (res.status !== 200 || !res.json || !res.json.ok) {
        state.failures.set(id, (state.failures.get(id) || 0) + 1);
        log(`账号 ${id} 状态查询失败（${res.status}）`);
        return false;
    }
    const connected = !!(res.json.data && res.json.data.connection && res.json.data.connection.connected);
    if (connected) {
        if (state.failures.get(id)) log(`账号 ${id} 已恢复连接`);
        state.failures.set(id, 0);
        return true;
    }

    const fails = (state.failures.get(id) || 0) + 1;
    state.failures.set(id, fails);
    log(`账号 ${id}(${account.uin}) 未连接 ${fails}/${FAIL_THRESHOLD}`);

    if (fails < FAIL_THRESHOLD) return false;

    const last = state.lastRefreshAt.get(id) || 0;
    if (Date.now() - last < COOLDOWN_MS) {
        log(`账号 ${id} 处于冷却期，等待 ${Math.ceil((COOLDOWN_MS - (Date.now() - last)) / 60000)} 分钟`);
        return false;
    }
    if (!account.uin) {
        log(`账号 ${id} 没有 uin，无法自动取码`);
        return false;
    }

    state.lastRefreshAt.set(id, Date.now());
    const ok = runCapture(account.uin);
    if (ok) state.failures.set(id, 0);
    return ok;
}

async function tick() {
    if (!qqRunning()) {
        log('QQ 未运行，待命');
        return;
    }
    if (!(await ensureToken())) return;

    const list = await api('/api/accounts');
    const accounts = (list.json && list.json.data && list.json.data.accounts) || [];
    if (!accounts.length) {
        log('还没有账号，跳过');
        return;
    }
    const summary = [];
    for (const account of accounts) {
        if (!shouldMonitorAccount(account, TARGET_SCOPE)) continue;
        const ok = await checkAccount(account);
        summary.push(`${account.uin || account.id}:${ok ? '在线' : '离线'}`);
    }
    if (summary.length) log(`巡检 ${summary.join(' ')}`);
}

async function main() {
    log(`Code supervisor 启动：base=${BASE} interval=${INTERVAL}s（只在掉线时刷新，无定期刷新）`);
    if (!PASS) log('警告：未找到管理员密码（FAR2_ADMIN_PASS 与本机 .far2/admin-pass.txt 均为空），无法登录 far2');
    if (TARGET_SCOPE !== null) {
        log(TARGET_SCOPE.size > 0
            ? `仅监控 ${TARGET_SCOPE.size} 个指定的 QQ 账号，其余保存账号不触发 Code 刷新`
            : '监控白名单为空或非法：不对任何账号执行刷新（fail-closed）');
    }

    for (;;) {
        try {
            await tick();
        } catch (error) {
            log(`tick 异常: ${error && error.message}`);
        }
        if (ONCE) break;
        await new Promise(resolve => setTimeout(resolve, INTERVAL * 1000));
    }
}

main().catch((error) => {
    console.error('FAILED', error && error.message);
    process.exitCode = 1;
});
