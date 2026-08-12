const assert = require('node:assert/strict');
const { parseCommand, NORMAL_FERTILIZER_ID, ORGANIC_FERTILIZER_ID } = require('../src/services/land-controls');

function main() {
    console.log('FAR2 Land Controls Self-Test');
    console.log('安全: 只测试命令解析，不连接 QQ、不调用农场 RPC。\n');

    assert.deepEqual(parseCommand('land:remove:12'), { action: 'remove', landId: 12 });
    assert.deepEqual(parseCommand('land:fertilize-normal:8'), { action: 'fertilize-normal', landId: 8 });
    assert.deepEqual(parseCommand('land:fertilize-organic:9'), { action: 'fertilize-organic', landId: 9 });
    assert.deepEqual(parseCommand('land:upgrade:24'), { action: 'upgrade', landId: 24 });
    assert.deepEqual(parseCommand('remove-all'), { action: 'remove-all', landId: 0 });

    for (const invalid of [
        '', 'remove', 'upgrade', 'land:remove:0', 'land:remove:-1',
        'land:remove:not-a-number', 'land:harvest:1', 'land:fertilize:1',
        'land:upgrade:1:extra', 'remove-all:1',
    ]) {
        assert.equal(parseCommand(invalid), null, `expected invalid command: ${invalid}`);
    }

    assert.equal(NORMAL_FERTILIZER_ID, 1011);
    assert.equal(ORGANIC_FERTILIZER_ID, 1012);

    console.log('✅ strict single-land command whitelist PASS');
    console.log('✅ destructive commands require explicit land id / remove-all PASS');
    console.log('✅ fertilizer ids remain 1011 / 1012 PASS');
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify({
        ok: true,
        strictCommands: true,
        realQqTouched: false,
        realFarmRpcTouched: false,
    }, null, 2));
}

try {
    main();
}
catch (err) {
    console.error('\n❌ Land Controls Self-Test FAIL:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
}
