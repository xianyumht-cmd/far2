/**
 * WMPF 逆向探针（微信小程序运行时）
 *
 * 目的：不安装对应微信版本，直接对本机正在运行的微信农场（WMPF 宿主 WeChatAppEx.exe）
 * 取证，找出 far2 需要的三个东西：
 *   1. 真实 WMPF 版本（far2 里写死 25297）
 *   2. flue.dll 的加载基址与大小（far2 里写死 loadStartOffset 0x2A5D800）
 *   3. 调试通道（far2 期望 CDP debug port 9421 / cdpFilterOffset 0x38EA370）
 *
 * 只做只读探测：attach + enumerate modules + 读内存/字符串，**不 patch、不注入业务逻辑**。
 *
 * 用法（需要 Node 20 + frida）:
 *   set PATH=D:\project2\far2\.toolchain\node20;%PATH%
 *   node tools\wmpf-probe.js
 *   node tools\wmpf-probe.js --pid 18280
 */

const path = require('node:path');

async function loadFrida() {
    const mod = await import('frida');
    return mod && mod.default ? (mod.default.default || mod.default) : mod;
}

function arg(name, fallback = '') {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
    const frida = await loadFrida();
    const device = await frida.getLocalDevice();
    const processes = await device.enumerateProcesses({ scope: frida.Scope.Metadata });
    const hosts = processes.filter(p => String(p.name || '').toLowerCase() === 'wechatappex.exe');
    console.log(`WeChatAppEx 进程数: ${hosts.length}`);
    for (const p of hosts) console.log(`  pid=${p.pid} name=${p.name}`);

    const wantedPid = Number(arg('pid', '0')) || 0;
    const target = wantedPid
        ? hosts.find(p => p.pid === wantedPid) || { pid: wantedPid, name: 'wechatappex.exe' }
        : hosts[0];
    if (!target) {
        console.log('没有找到 WeChatAppEx，先在微信里打开「QQ经典农场」再跑本探针');
        return;
    }
    console.log(`\nattach -> pid=${target.pid}`);

    const session = await device.attach(target.pid);
    const script = await session.createScript(`
        const out = [];
        function push(o) { send(o); }
        try {
            const flue = Process.findModuleByName('flue.dll');
            if (flue) {
                push({ kind: 'module', name: flue.name, base: flue.base.toString(), size: flue.size, path: flue.path });
                // 在模块里扫 WMPF 版本号候选：25297 = 0x62D1（小端 32 位）
                const ranges = [[0, Math.min(flue.size, 4 * 1024 * 1024)]];
                for (const [start, len] of ranges) {
                    const pat = 'D1 62 00 00';
                    const hits = Memory.scanSync(flue.base.add(start), len, pat).slice(0, 5);
                    if (hits.length) push({ kind: 'version-candidate', pattern: pat, hits: hits.map(h => h.address.toString()) });
                }
            } else {
                push({ kind: 'module-missing', name: 'flue.dll' });
            }
            // 列出所有模块里名字含 flue / wmpf 的
            for (const m of Process.enumerateModules()) {
                const n = m.name.toLowerCase();
                if (n.includes('flue') || n.includes('wmpf')) {
                    push({ kind: 'module-any', name: m.name, base: m.base.toString(), size: m.size });
                }
            }
            // 找 js 引擎迹象（V8）
            for (const m of Process.enumerateModules()) {
                if (/v8|node|electron/i.test(m.name)) push({ kind: 'js-engine', name: m.name });
            }
        } catch (e) {
            push({ kind: 'error', message: String(e) });
        }
        push({ kind: 'done' });
    `);

    const done = new Promise((resolve) => {
        script.message.connect((message) => {
            if (message.type === 'error') {
                console.log('script error:', message.description);
                resolve();
                return;
            }
            const payload = message.payload || {};
            if (payload.kind === 'done') return resolve();
            console.log(' ', JSON.stringify(payload));
        });
    });
    await script.load();
    await Promise.race([done, new Promise(r => setTimeout(r, 20000))]);
    await session.detach();
    console.log('\n完成（只读探测，未修改任何内存）');
}

main().catch((error) => {
    console.error('FAILED', error && error.message);
    process.exitCode = 1;
});
