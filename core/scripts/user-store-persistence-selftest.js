const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function listTempFiles(dir) {
    return fs.readdirSync(dir).filter(name => /\.tmp$/.test(name));
}

function findCorruptBackup(filePath) {
    const dir = path.dirname(filePath);
    const prefix = `${path.basename(filePath)}.corrupt-`;
    return fs.readdirSync(dir).find(name => name.startsWith(prefix) && name.endsWith('.bak')) || '';
}

function expectCriticalJson(fn, expectedFile) {
    let error = null;
    try { fn(); } catch (err) { error = err; }
    assert.ok(error, `expected critical JSON failure for ${expectedFile}`);
    assert.equal(error.code, 'critical_json_corrupt');
    assert.equal(path.basename(error.filePath), expectedFile);
    return error;
}

function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'far2-user-store-'));
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === '../config/runtime-paths' && parent && /[\\/]models[\\/]user-store\.js$/.test(parent.filename || '')) {
            return {
                getDataFile(name) { return path.join(dataDir, name); },
                ensureDataDir() { fs.mkdirSync(dataDir, { recursive: true }); return dataDir; },
            };
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    try {
        const userStore = require('../src/models/user-store');

        const usersFile = path.join(dataDir, 'users.json');
        const cardsFile = path.join(dataDir, 'cards.json');
        const attemptsFile = path.join(dataDir, 'login-attempts.json');
        const logsFile = path.join(dataDir, 'login-logs.json');
        const claimFile = path.join(dataDir, 'card-claim.json');

        const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
        assert.equal(users.users.length, 1);
        assert.equal(users.users[0].username, 'admin');
        assert.equal(listTempFiles(dataDir).length, 0, 'atomic writer must not leave temp files');

        userStore.validateUser('admin', 'wrong-password', '127.0.0.10');
        const attempts = JSON.parse(fs.readFileSync(attemptsFile, 'utf8'));
        assert.ok(attempts['ip:127.0.0.10']);
        assert.ok(attempts['user:admin']);

        userStore.addLoginLog({ action: 'selftest', ok: true });
        const logs = JSON.parse(fs.readFileSync(logsFile, 'utf8'));
        assert.equal(logs.logs.length, 1);
        assert.equal(logs.logs[0].action, 'selftest');

        const card = userStore.createCard('selftest-card', 1, 'time');
        const cards = JSON.parse(fs.readFileSync(cardsFile, 'utf8'));
        assert.ok(cards.cards.some(item => item.code === card.code));

        userStore.setCardClaimStatus(false);
        const claim = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
        assert.equal(claim.enabled, false);
        assert.equal(listTempFiles(dataDir).length, 0);

        fs.writeFileSync(attemptsFile, '{broken-attempts', 'utf8');
        expectCriticalJson(
            () => userStore.validateUser('admin', 'wrong-password', '127.0.0.11'),
            'login-attempts.json',
        );
        assert.ok(findCorruptBackup(attemptsFile), 'corrupt login-attempts.json must be preserved');

        fs.writeFileSync(cardsFile, '{broken-cards', 'utf8');
        expectCriticalJson(() => userStore.getAllCards(), 'cards.json');
        assert.ok(findCorruptBackup(cardsFile), 'corrupt cards.json must be preserved');

        fs.writeFileSync(claimFile, '{broken-claim', 'utf8');
        expectCriticalJson(() => userStore.getCardClaimStatus(), 'card-claim.json');
        assert.ok(findCorruptBackup(claimFile), 'corrupt card-claim.json must be preserved');

        fs.writeFileSync(usersFile, '{broken-users', 'utf8');
        expectCriticalJson(() => userStore.getAllUsers(), 'users.json');
        assert.ok(findCorruptBackup(usersFile), 'corrupt users.json must be preserved');

        console.log('✅ users/cards/login attempts/login logs/card-claim writes are valid JSON with no temp leakage');
        console.log('✅ critical user/security/card corruption fails closed and preserves backup bytes');
        console.log('✅ login log remains non-critical while its writer is atomic');
    } finally {
        Module._load = originalLoad;
        fs.rmSync(root, { recursive: true, force: true });
    }
}

try {
    main();
} catch (error) {
    console.error('❌ user-store persistence self-test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
}
