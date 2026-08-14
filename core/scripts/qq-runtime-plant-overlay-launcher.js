const { spawn, execSync } = require('node:child_process');
const path = require('node:path');

const MINIAPP_URI = 'tencent://ntqq-open/?&subCmd=miniapp&action=openQQMiniApp&actionParams=%7B%22sourceType%22%3A%22open%22%2C%22appId%22%3A%221112386029%22%2C%22hostScene%22%3A%221246700100%22%7D';

function openMiniApp() {
    if (process.platform !== 'win32') return;
    try {
        execSync(`start "" "${MINIAPP_URI}"`, {
            shell: 'cmd.exe',
            stdio: 'ignore',
            windowsHide: true,
        });
        process.stdout.write('\n[launcher] 已使用已验证的 Windows URI 方式请求打开经典农场。\n');
    } catch (error) {
        process.stderr.write(`\n[launcher] 自动打开经典农场失败: ${error && error.message ? error.message : error}\n`);
        process.stderr.write('[launcher] 可直接从 QQ 主界面手动打开经典农场，当前采集仍可继续。\n');
    }
}

function main() {
    const capture = path.join(__dirname, 'qq-runtime-plant-overlay-capture.js');
    const child = spawn(process.execPath, [capture], {
        cwd: path.join(__dirname, '..'),
        stdio: ['inherit', 'pipe', 'pipe'],
        windowsHide: false,
        env: process.env,
    });

    let opened = false;
    let pending = '';

    function forward(chunk, target) {
        const text = chunk.toString();
        target.write(text);
        if (opened) return;
        pending = (pending + text).slice(-4000);
        if (pending.includes('已临时补丁') || pending.includes('官方农场已请求打开')) {
            opened = true;
            setTimeout(openMiniApp, 300);
        }
    }

    child.stdout.on('data', chunk => forward(chunk, process.stdout));
    child.stderr.on('data', chunk => forward(chunk, process.stderr));

    child.on('error', error => {
        process.stderr.write(`Runtime Plant Overlay launcher FAIL: ${error && error.stack ? error.stack : error}\n`);
        process.exitCode = 1;
    });

    child.on('exit', (code, signal) => {
        if (signal) {
            process.stderr.write(`Runtime Plant Overlay child exited by signal ${signal}\n`);
            process.exitCode = 1;
            return;
        }
        process.exitCode = Number.isInteger(code) ? code : 1;
    });
}

if (require.main === module) main();

module.exports = { openMiniApp };
