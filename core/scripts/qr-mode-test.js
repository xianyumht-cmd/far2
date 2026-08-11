const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { QRLoginSession, MiniProgramLoginSession } = require('../src/services/qrlogin');
const { CONFIG } = require('../src/config/config');

const SUPPORTED_MODES = new Set(['miniapp', 'pc', 'auto']);
const mode = String(process.argv[2] || 'auto').trim().toLowerCase();
const probeVersion = String(process.argv[3] || '1.13.0.5_20260729').trim();

if (!SUPPORTED_MODES.has(mode)) {
    console.error('用法: node scripts/qr-mode-test.js [miniapp|pc|auto] [clientVersion]');
    process.exit(2);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isUsableFarmCode(value) {
    const text = String(value == null ? '' : value).trim();
    if (!text) return false;
    if (/^-\d+$/.test(text)) return false;
    if (text === '0') return false;
    return true;
}

function mask(value) {
    const text = String(value == null ? '' : value).trim();
    if (!text) return '(empty)';
    if (text.length <= 8) return text;
    return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function saveAndOpenQr(dataUrl, prefix) {
    const match = String(dataUrl || '').match(/^data:image\/png;base64,(.+)$/);
    if (!match) throw new Error('二维码图片格式异常');

    const filename = `${prefix}-${Date.now()}.png`;
    const file = path.join(os.tmpdir(), filename);
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

function extractCandidateFromJumpUrl(jumpUrl) {
    const raw = String(jumpUrl || '').trim();
    if (!raw) return '';

    try {
        const url = new URL(raw);
        for (const key of ['code', 'auth_code', 'ticket']) {
            const value = String(url.searchParams.get(key) || '').trim();
            if (value) return value;
        }

        const hashText = String(url.hash || '').replace(/^#/, '');
        if (hashText) {
            const hashParams = new URLSearchParams(hashText);
            for (const key of ['code', 'auth_code', 'ticket']) {
                const value = String(hashParams.get(key) || '').trim();
                if (value) return value;
            }
        }
    } catch {}

    return '';
}

async function probeFarmHandshake(code) {
    const candidate = String(code || '').trim();
    if (!isUsableFarmCode(candidate)) {
        return { ok: false, reason: 'candidate_invalid' };
    }

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
                    Origin: 'https://gate-obt.nqf.qq.com',
                },
            });

            ws.once('open', () => finish({ ok: true, reason: 'ws_open' }));
            ws.once('unexpected-response', (_req, res) => {
                finish({ ok: false, reason: `http_${res && res.statusCode ? res.statusCode : 'unknown'}` });
            });
            ws.once('error', (err) => {
                const message = String(err && err.message ? err.message : err || 'unknown');
                finish({ ok: false, reason: message });
            });
        } catch (err) {
            finish({ ok: false, reason: String(err && err.message ? err.message : err) });
        }
    });
}

async function runMiniapp() {
    console.log('\n=== MINIAPP ===');
    console.log('正在生成 QQ 小程序开发工具扫码二维码...');

    const created = await MiniProgramLoginSession.requestLoginCode();
    saveAndOpenQr(created.image, 'qq-farm-miniapp');
    console.log('请使用手机 QQ 扫码并确认。');

    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
        await sleep(2000);
        const status = await MiniProgramLoginSession.queryStatus(created.code);
        const state = String(status && status.status ? status.status : 'Error');

        if (state === 'Wait') {
            process.stdout.write('.');
            continue;
        }
        if (state === 'Used') {
            console.log('\nminiapp 二维码已失效。');
            return { ok: false, mode: 'miniapp', reason: 'qr_used' };
        }
        if (state !== 'OK') {
            console.log(`\nminiapp 状态异常: ${status && status.msg ? status.msg : state}`);
            return { ok: false, mode: 'miniapp', reason: status && status.msg ? status.msg : state };
        }

        console.log(`\n扫码确认成功，QQ=${status.uin || '(unknown)'}`);
        const authCode = await MiniProgramLoginSession.getAuthCode(status.ticket, '1112386029');
        const codeText = String(authCode == null ? '' : authCode).trim();
        console.log(`换取 Farm Code 结果: ${mask(codeText)}`);

        if (!isUsableFarmCode(codeText)) {
            console.log('miniapp 未得到可用 Farm Code（例如 -3000 会被判定为失败）。');
            return { ok: false, mode: 'miniapp', reason: `invalid_auth_code:${codeText || 'empty'}`, rawCode: codeText };
        }

        const probe = await probeFarmHandshake(codeText);
        console.log(`Farm WS 探测: ${probe.ok ? '通过' : '失败'} (${probe.reason})`);
        return { ok: probe.ok, mode: 'miniapp', code: codeText, reason: probe.reason, uin: status.uin || '' };
    }

    console.log('\nminiapp 扫码超时。');
    return { ok: false, mode: 'miniapp', reason: 'timeout' };
}

async function runPc() {
    console.log('\n=== PC ===');
    console.log('正在生成 QQ 网页登录二维码（QZone preset）...');

    const created = await QRLoginSession.requestQRCode('qzone');
    saveAndOpenQr(created.qrcode, 'qq-farm-pc');
    console.log('请使用手机 QQ 扫码并确认。');

    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
        await sleep(2000);
        const status = await QRLoginSession.checkStatus(created.qrsig, 'qzone');
        const ret = String(status && status.ret != null ? status.ret : '');

        if (ret === '66' || ret === '67') {
            process.stdout.write('.');
            continue;
        }
        if (ret === '65' || ret === '68') {
            console.log(`\npc 二维码已失效/取消: ${status.msg || ret}`);
            return { ok: false, mode: 'pc', reason: `ptqr_${ret}` };
        }
        if (ret !== '0') {
            console.log(`\npc 登录状态异常: ret=${ret} ${status.msg || ''}`);
            return { ok: false, mode: 'pc', reason: `ptqr_${ret || 'unknown'}` };
        }

        console.log(`\nQQ 网页扫码成功，昵称=${status.nickname || '(unknown)'}`);
        const candidate = extractCandidateFromJumpUrl(status.jumpUrl);
        if (!candidate) {
            console.log('网页登录成功，但 jumpUrl 中没有 code/auth_code/ticket。');
            console.log(`jumpUrl: ${status.jumpUrl || '(empty)'}`);
            return { ok: false, mode: 'pc', reason: 'no_farm_code_in_jump_url', jumpUrl: status.jumpUrl || '' };
        }

        console.log(`PC 候选 Code: ${mask(candidate)}`);
        const probe = await probeFarmHandshake(candidate);
        console.log(`Farm WS 探测: ${probe.ok ? '通过' : '失败'} (${probe.reason})`);
        return { ok: probe.ok, mode: 'pc', code: candidate, reason: probe.reason };
    }

    console.log('\npc 扫码超时。');
    return { ok: false, mode: 'pc', reason: 'timeout' };
}

async function main() {
    console.log('QQ Farm QR Mode Tester');
    console.log(`模式: ${mode}`);
    console.log(`Farm WS 探测版本: ${probeVersion}`);
    console.log('说明: 只测试登录链路，不写入账号、不启动自动挂机。');

    let result;
    if (mode === 'miniapp') {
        result = await runMiniapp();
    } else if (mode === 'pc') {
        result = await runPc();
    } else {
        const mini = await runMiniapp();
        if (mini.ok) {
            result = mini;
        } else {
            console.log(`\nAUTO: miniapp 失败 (${mini.reason})，自动切换 pc。`);
            result = await runPc();
        }
    }

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: !!result.ok,
        mode: result.mode,
        reason: result.reason || '',
        code: result.code ? mask(result.code) : '',
        uin: result.uin || '',
    }, null, 2));

    if (result.ok) {
        console.log('\n✅ 找到通过 Farm WebSocket 握手的候选 Code。');
        console.log('完整 Code 只保存在本次进程内，不会写入日志文件或仓库。');
    } else {
        console.log('\n❌ 当前线路没有得到可通过 Farm WebSocket 握手的 Code。');
    }
}

main().catch((err) => {
    console.error('\n测试器异常:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
});
