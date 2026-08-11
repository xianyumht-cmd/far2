const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const axios = require('axios');
const WebSocket = require('ws');
const { QRLoginSession, MiniProgramLoginSession } = require('../src/services/qrlogin');
const { CONFIG } = require('../src/config/config');

const probeVersion = String(process.argv[2] || '1.13.0.5_20260729').trim();
const ChromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function mask(value) {
    const text = String(value == null ? '' : value).trim();
    if (!text) return '(empty)';
    if (text.length <= 8) return text;
    return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function isUsableFarmCode(value) {
    const text = String(value == null ? '' : value).trim();
    if (!text) return false;
    if (/^-\d+$/.test(text)) return false;
    if (text === '0') return false;
    return true;
}

function saveAndOpenQr(dataUrl, prefix) {
    const match = String(dataUrl || '').match(/^data:image\/png;base64,(.+)$/);
    if (!match) throw new Error('二维码图片格式异常');

    const file = path.join(os.tmpdir(), `${prefix}-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(match[1], 'base64'));

    if (process.platform === 'win32') {
        try {
            spawn('cmd.exe', ['/c', 'start', '', file], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
            }).unref();
        } catch {}
    }

    console.log(`二维码文件: ${file}`);
    return file;
}

function createCookieJar() {
    return new Map();
}

function mergeSetCookie(jar, setCookie) {
    const rows = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
    for (const row of rows) {
        const first = String(row || '').split(';', 1)[0].trim();
        const idx = first.indexOf('=');
        if (idx <= 0) continue;
        const name = first.slice(0, idx).trim();
        const value = first.slice(idx + 1).trim();
        if (!name) continue;
        if (!value) jar.delete(name);
        else jar.set(name, value);
    }
}

function cookieHeader(jar) {
    return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

function cookieNames(jar) {
    return Array.from(jar.keys()).sort();
}

async function followWithJar(startUrl, jar, options = {}) {
    let current = String(startUrl || '').trim();
    if (!current) throw new Error('跳转 URL 为空');

    const maxHops = Number(options.maxHops || 10);
    const referer = String(options.referer || 'https://qzone.qq.com/');
    let lastStatus = 0;
    let finalUrl = current;

    for (let i = 0; i < maxHops; i++) {
        const response = await axios.get(current, {
            maxRedirects: 0,
            validateStatus: status => status >= 200 && status < 400,
            headers: {
                'User-Agent': ChromeUA,
                'Referer': referer,
                'Cookie': cookieHeader(jar),
            },
        });

        lastStatus = response.status;
        mergeSetCookie(jar, response.headers['set-cookie']);
        finalUrl = current;

        const location = String(response.headers.location || '').trim();
        if (!location) break;
        current = new URL(location, current).toString();
        finalUrl = current;
    }

    return { finalUrl, status: lastStatus };
}

async function probeFarmHandshake(code) {
    const candidate = String(code || '').trim();
    if (!isUsableFarmCode(candidate)) return { ok: false, reason: 'candidate_invalid' };

    const serverUrl = String(CONFIG.serverUrl || 'wss://gate-obt.nqf.qq.com/prod/ws');
    const platform = String(CONFIG.platform || 'qq');
    const osName = String(CONFIG.os || 'iOS');
    const url = `${serverUrl}?platform=${encodeURIComponent(platform)}&os=${encodeURIComponent(osName)}&ver=${encodeURIComponent(probeVersion)}&code=${encodeURIComponent(candidate)}&openID=`;

    return new Promise((resolve) => {
        let settled = false;
        let ws = null;

        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
                if (ws) {
                    ws.removeAllListeners();
                    ws.close();
                }
            } catch {}
            resolve(result);
        };

        const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), 10000);

        try {
            ws = new WebSocket(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132.0.0.0 Safari/537.36',
                    'Origin': 'https://gate-obt.nqf.qq.com',
                },
            });
            ws.once('open', () => finish({ ok: true, reason: 'ws_open' }));
            ws.once('unexpected-response', (_req, res) => {
                finish({ ok: false, reason: `http_${res && res.statusCode ? res.statusCode : 'unknown'}` });
            });
            ws.once('error', (err) => {
                finish({ ok: false, reason: String(err && err.message ? err.message : err || 'unknown') });
            });
        } catch (err) {
            finish({ ok: false, reason: String(err && err.message ? err.message : err) });
        }
    });
}

async function loginPcAndBuildJar() {
    console.log('\n=== STEP 1: PC QQ LOGIN STATE ===');
    const created = await QRLoginSession.requestQRCode('qzone');
    saveAndOpenQr(created.qrcode, 'qq-farm-dual-pc');
    console.log('请使用手机 QQ 扫描第 1 个二维码并确认。');

    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
        await sleep(2000);
        const status = await QRLoginSession.checkStatus(created.qrsig, 'qzone');
        const ret = String(status && status.ret != null ? status.ret : '');

        if (ret === '66' || ret === '67') {
            process.stdout.write('.');
            continue;
        }
        if (ret === '65' || ret === '68') throw new Error(`PC 二维码失效/取消: ${status.msg || ret}`);
        if (ret !== '0') throw new Error(`PC 登录异常: ret=${ret} ${status.msg || ''}`);
        if (!status.jumpUrl) throw new Error('PC 登录成功但没有 check_sig 地址');

        console.log(`\nPC QQ 登录成功，昵称=${status.nickname || '(unknown)'}`);
        const jar = createCookieJar();
        jar.set('qrsig', created.qrsig);
        mergeSetCookie(jar, status.cookie);
        const followed = await followWithJar(status.jumpUrl, jar, { referer: 'https://qzone.qq.com/' });
        console.log(`check_sig 跟随完成: HTTP ${followed.status}`);
        console.log(`QQ 登录态 Cookie 名称: ${cookieNames(jar).join(', ') || '(none)'}`);
        console.log('Cookie 值不会打印，也不会写入文件。');
        return { jar, nickname: status.nickname || '' };
    }

    throw new Error('PC 扫码超时');
}

async function scanMiniappForTicket() {
    console.log('\n=== STEP 2: MINIAPP TICKET ===');
    const created = await MiniProgramLoginSession.requestLoginCode();
    saveAndOpenQr(created.image, 'qq-farm-dual-miniapp');
    console.log('请使用同一个手机 QQ 扫描第 2 个二维码并确认。');

    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
        await sleep(2000);
        const status = await MiniProgramLoginSession.queryStatus(created.code);
        const state = String(status && status.status ? status.status : 'Error');

        if (state === 'Wait') {
            process.stdout.write('.');
            continue;
        }
        if (state === 'Used') throw new Error('miniapp 二维码已失效');
        if (state !== 'OK') throw new Error(`miniapp 状态异常: ${status && status.msg ? status.msg : state}`);

        console.log(`\nminiapp 扫码成功，QQ=${status.uin || '(unknown)'}`);
        console.log(`ticket: ${status.ticket ? '已获得' : '未获得'}（值不打印）`);
        if (!status.ticket) throw new Error('miniapp 未返回 ticket');
        return { ticket: status.ticket, uin: status.uin || '' };
    }

    throw new Error('miniapp 扫码超时');
}

async function exchangeFarmCode(ticket, jar) {
    console.log('\n=== STEP 3: QQ SESSION + TICKET -> FARM CODE ===');
    const response = await axios.post('https://q.qq.com/ide/login', {
        appid: '1112386029',
        ticket: String(ticket || ''),
    }, {
        validateStatus: () => true,
        headers: {
            ...MiniProgramLoginSession.getHeaders(),
            'Cookie': cookieHeader(jar),
            'Origin': 'https://q.qq.com',
            'Referer': 'https://q.qq.com/',
        },
    });

    const data = response && response.data && typeof response.data === 'object' ? response.data : {};
    const code = String(data.code == null ? '' : data.code).trim();
    const message = String(data.message || data.msg || data.errMsg || '').trim();
    console.log(`HTTP: ${response.status}`);
    console.log(`响应字段: ${Object.keys(data).join(', ') || '(none)'}`);
    console.log(`返回 code: ${mask(code)}`);
    if (message) console.log(`返回信息: ${message}`);

    if (!isUsableFarmCode(code)) {
        return { ok: false, code: '', rawCode: code, reason: `invalid_auth_code:${code || 'empty'}` };
    }

    const probe = await probeFarmHandshake(code);
    console.log(`Farm WS 探测: ${probe.ok ? '通过' : '失败'} (${probe.reason})`);
    return { ok: probe.ok, code, reason: probe.reason };
}

async function main() {
    console.log('QQ Farm Dual-Scan Tester');
    console.log(`Farm WS 探测版本: ${probeVersion}`);
    console.log('目的: 验证 miniapp 的 -3000 是否由缺少 QQ 登录态导致。');
    console.log('流程: PC 扫码拿登录态 -> miniapp 扫码拿 ticket -> 合并换 Farm Code。');
    console.log('安全: 不写入账号、不启动挂机、不打印/落盘 QQ Cookie 或 ticket。');

    const pc = await loginPcAndBuildJar();
    const mini = await scanMiniappForTicket();
    const exchanged = await exchangeFarmCode(mini.ticket, pc.jar);
    const result = { ...exchanged, uin: mini.uin || '' };

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: !!result.ok,
        reason: result.reason || '',
        code: result.code ? mask(result.code) : '',
        uin: result.uin || '',
    }, null, 2));

    if (result.ok) {
        console.log('\n✅ 双扫码成功换到可通过 Farm WebSocket 握手的 Code。');
        console.log('这证明 -3000 与缺少 QQ 登录态有关，后续可以继续压缩为单扫码流程。');
    } else if (String(result.reason || '').includes('-3000')) {
        console.log('\n❌ 即使合并完整 QQ 登录态仍返回 -3000。');
        console.log('这基本排除“仅缺 Cookie”假设，下一步应追 QUA/IDE 校验或真实 QQ 小程序运行时授权链。');
    } else {
        console.log('\n❌ 双扫码没有得到可通过 Farm WS 的 Code。');
    }
}

main().catch((err) => {
    console.error('\n测试器异常:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
});
