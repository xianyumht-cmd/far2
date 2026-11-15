/**
 * 扫码登录 + 自动建号（本机运维脚本）
 *
 * 流程：
 *   1. POST /api/qr/create 拿登录码 + 二维码 PNG
 *   2. 把 PNG 存到 data/login-qr.png（给人扫）
 *   3. 轮询 /api/qr/check，扫码确认后拿到 authCode + uin
 *   4. POST /api/accounts 建号，然后 POST /api/accounts/:id/start 启动 worker
 *
 * 用法:
 *   node tools/qr-login.js                 # 默认 http://127.0.0.1:3007
 *   node tools/qr-login.js --wait 300      # 最多等 300 秒
 *   FAR2_TOKEN=xxx node tools/qr-login.js   # 已有 token 时直接用
 */

const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.FAR2_BASE || 'http://127.0.0.1:3007';
const USER = process.env.FAR2_ADMIN_USER || 'admin';
const PASS = process.env.FAR2_ADMIN_PASS || '';
const WAIT_SEC = Number(process.argv.includes('--wait')
    ? process.argv[process.argv.indexOf('--wait') + 1]
    : 300);

async function api(pathname, { method = 'GET', body, token } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (token) headers['x-admin-token'] = token;
    const res = await fetch(`${BASE}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        json = { raw: text };
    }
    return { status: res.status, json };
}

async function login() {
    if (process.env.FAR2_TOKEN) return process.env.FAR2_TOKEN;
    const res = await api('/api/login', { method: 'POST', body: { username: USER, password: PASS } });
    if (!res.json || !res.json.ok) throw new Error(`登录失败: ${JSON.stringify(res.json).slice(0, 160)}`);
    return res.json.data.token;
}

async function main() {
    const token = await login();
    const created = await api('/api/qr/create', { method: 'POST', body: {}, token });
    if (!created.json || !created.json.ok) throw new Error(`取二维码失败: ${JSON.stringify(created.json).slice(0, 160)}`);

    const { code, url, image } = created.json.data;
    const outDir = path.join(__dirname, '..', 'data');
    fs.mkdirSync(outDir, { recursive: true });
    const png = path.join(outDir, 'login-qr.png');
    if (typeof image === 'string' && image.startsWith('data:image')) {
        fs.writeFileSync(png, Buffer.from(image.split(',')[1], 'base64'));
    }
    console.log(`QR_READY code=${code}`);
    console.log(`QR_PNG ${png}`);
    console.log(`QR_URL ${url}`);

    const deadline = Date.now() + WAIT_SEC * 1000;
    let lastStatus = '';
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 3000));
        const chk = await api('/api/qr/check', { method: 'POST', body: { code }, token });
        const data = (chk.json && chk.json.data) || {};
        const status = String(data.status || 'unknown');
        if (status !== lastStatus) {
            console.log(`QR_STATUS ${status}`);
            lastStatus = status;
        }
        if (status === 'OK') {
            const account = await api('/api/accounts', {
                method: 'POST',
                body: { name: `本机农场-${data.uin}`, uin: data.uin, code: data.code, avatar: data.avatar, platform: 'qq' },
                token,
            });
            console.log(`ACCOUNT_CREATED ${JSON.stringify(account.json).slice(0, 300)}`);
            const list = await api('/api/accounts', { token });
            const accounts = (list.json && list.json.data && list.json.data.accounts) || [];
            const target = accounts.find(a => String(a.uin) === String(data.uin));
            if (target) {
                const start = await api(`/api/accounts/${target.id}/start`, { method: 'POST', body: {}, token });
                console.log(`ACCOUNT_START id=${target.id} -> ${JSON.stringify(start.json).slice(0, 200)}`);
            } else {
                console.log('ACCOUNT_NOT_FOUND after create');
            }
            return;
        }
        if (status === 'Error') {
            console.log(`QR_ERROR ${JSON.stringify(data).slice(0, 200)}`);
            return;
        }
    }
    console.log('QR_TIMEOUT 未在等待时间内扫码');
}

main().catch((error) => {
    console.error('FAILED', error && error.message);
    process.exitCode = 1;
});
