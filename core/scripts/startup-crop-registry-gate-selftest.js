const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function main() {
    console.log('FAR2 Startup Crop Registry Gate Self-Test');
    console.log('安全: 只读取本地源码文本；不联网、不登录、不发送 RPC。\n');

    const networkFile = path.join(__dirname, '..', 'src', 'utils', 'network.js');
    const source = fs.readFileSync(networkFile, 'utf8');

    const gateFn = source.indexOf('async function releaseAutomationAfterStartupRegistry');
    const bagRead = source.indexOf('const bagItems = await fetchStartupBagItems();', gateFn);
    const registryRead = source.indexOf('.refreshStartupCropRegistry({', bagRead);
    const fullGate = source.indexOf('if (!full) {', registryRead);
    const releaseFlag = source.indexOf('startupAutomationReleased = true;', fullGate);
    const callback = source.indexOf('await onLoginSuccess(registry);', releaseFlag);

    assert.ok(gateFn >= 0, 'registry gate function missing');
    assert.ok(bagRead > gateFn, 'Bag must be read inside gate');
    assert.ok(registryRead > bagRead, 'Registry must start after Bag');
    assert.ok(fullGate > registryRead, 'full-read gate must follow Registry');
    assert.ok(releaseFlag > fullGate, 'automation release must follow full-read gate');
    assert.ok(callback > releaseFlag, 'worker onLoginSuccess must be last');
    console.log('✅ Bag -> Registry -> full-read Gate -> worker release ordering PASS');

    const loginFn = source.indexOf('async function sendLogin');
    const heartbeat = source.indexOf('startHeartbeat();', loginFn);
    const gateCall = source.indexOf('releaseAutomationAfterStartupRegistry(onLoginSuccess)', heartbeat);
    assert.ok(loginFn >= 0 && heartbeat > loginFn && gateCall > heartbeat);
    console.log('✅ heartbeat starts before potentially long readonly bootstrap PASS');

    assert.ok(source.includes("setTimeoutTask('startup_crop_registry_retry', 30000"));
    assert.ok(source.includes('完整图鉴/活动/种子商店尚未全部同步成功'));
    console.log('✅ incomplete startup data retries instead of releasing automation PASS');

    assert.equal(source.includes('ClaimAllRewardsV2'), false);
    assert.equal(source.includes('BuyGoods'), false);
    assert.equal(source.includes("'Plant'"), false);
    console.log('✅ startup gate contains no claim/buy/plant write method PASS');

    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        networkTouched: false,
        loginTouched: false,
        rpcTouched: false,
        writeOperationTouched: false,
    }, null, 2));
}

try {
    main();
} catch (error) {
    console.error(`\n❌ Startup Crop Registry Gate Self-Test FAIL: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
}
