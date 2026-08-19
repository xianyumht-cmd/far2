'use strict';

const { createWechatNativeWmpfCapture } = require('../src/services/wechat-wmpf-native-capture');

function safeText(value, max = 180) {
    return String(value || '')
        .replace(/([?&](?:code|token|ticket|password)=)[^&\s]+/gi, '$1[REDACTED]')
        .replace(/(Bearer\s+)[\w.-]+/gi, '$1[REDACTED]')
        .replace(/\b[A-Za-z0-9_-]{32}\b/g, '[REDACTED_32]')
        .slice(0, max);
}

async function main() {
    let code = '';
    try {
        const capture = createWechatNativeWmpfCapture({
            processRef: process,
            interactive: true,
            log: message => console.log(`[native] ${safeText(message)}`),
        });
        const result = await capture.captureFreshCode();
        code = String(result && result.code || '').trim();
        if (!code) throw new Error('FAR2-native capture returned no Code');
        if (!process.send) throw new Error('Unattended capture IPC channel is unavailable');
        process.send({
            type: 'far2_wechat_native_unattended_capture',
            ok: true,
            code,
            platform: 'wx',
            appId: String(result.appId || ''),
            windowsSessionId: Number(result.windowsSessionId),
            wmpfVersion: Number(result.wmpfVersion) || 0,
            clientVersion: String(result.clientVersion || ''),
            gatewayVersion: String(result.gatewayVersion || ''),
            profileId: String(result.profileId || ''),
            envVersion: String(result.envVersion || ''),
            transport: 'far2_native_wmpf',
        });
        code = '';
    } catch (err) {
        code = '';
        const reason = err && err.code ? String(err.code) : 'wechat_native_unattended_capture_failed';
        const message = safeText(err && err.message ? err.message : err);
        if (process.send) {
            try {
                process.send({
                    type: 'far2_wechat_native_unattended_capture',
                    ok: false,
                    reason,
                    message,
                });
            } catch {}
        }
        process.exitCode = 1;
    } finally {
        code = '';
    }
}

main().catch(err => {
    console.error(safeText(err && err.message ? err.message : err));
    process.exitCode = 1;
});
