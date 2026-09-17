const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { getTrustProxySetting, normalizeClientIp } = require('../src/services/client-ip');

const originalTrustProxy = process.env.TRUST_PROXY;
delete process.env.TRUST_PROXY;
assert.equal(getTrustProxySetting(), false);
if (originalTrustProxy === undefined)
    delete process.env.TRUST_PROXY;
else
    process.env.TRUST_PROXY = originalTrustProxy;
assert.equal(getTrustProxySetting('false'), false);
assert.equal(getTrustProxySetting('loopback'), 'loopback');
assert.deepEqual(getTrustProxySetting('loopback, 10.0.0.0/8'), ['loopback', '10.0.0.0/8']);
for (const unsafe of ['true', '1', '2', '*', 'yes']) {
    assert.throws(() => getTrustProxySetting(unsafe), error => error && error.code === 'unsafe_trust_proxy');
}
assert.equal(normalizeClientIp('::ffff:203.0.113.4'), '203.0.113.4');
assert.equal(normalizeClientIp('2001:db8::1'), '2001:db8::1');
assert.equal(normalizeClientIp(''), 'unknown');

const adminSource = fs.readFileSync(path.join(__dirname, '../src/controllers/admin.js'), 'utf8');
assert.equal(adminSource.includes("app.set('trust proxy', true)"), false);
assert.equal(adminSource.includes("req.headers['cf-connecting-ip']"), false);
assert.equal(adminSource.includes("req.headers['x-real-ip']"), false);
assert.equal(adminSource.includes("req.headers['x-forwarded-for']"), false);
assert.equal(adminSource.includes("app.set('trust proxy', getTrustProxySetting())"), true);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'far2-security-phase2-'));
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const originalLoad = Module._load;
const originalBootstrapPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD;
process.env.ADMIN_BOOTSTRAP_PASSWORD = 'FAR2-Phase2-Selftest-9!';

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

    const originalMathRandom = Math.random;
    Math.random = () => {
        throw new Error('Math.random must not be used for card secrets, card selection, or login-log identifiers');
    };
    try {
        const singleCard = userStore.createCard('security-random-single', 1, 'time');
        const batchCards = userStore.createCardsBatch('security-random-batch', 1, 100, 'time');
        const generatedCards = [singleCard, ...batchCards];
        assert.equal(generatedCards.length, 101);
        assert.equal(new Set(generatedCards.map(card => card.code)).size, generatedCards.length, 'generated card codes must be unique');
        for (const card of generatedCards) {
            assert.match(card.code, /^[A-Z0-9]{16}$/, 'card code format must remain compatible');
        }

        const claimed = userStore.claimCardByUA('far2-security-randomness-selftest');
        assert.equal(claimed.ok, true, 'card claim selection must not depend on Math.random');

        const loginLog = userStore.addLoginLog({ event: 'security-randomness-selftest' });
        assert.match(loginLog.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 'login log IDs must use crypto.randomUUID');
    } finally {
        Math.random = originalMathRandom;
    }
    const attemptsFile = path.join(dataDir, 'login-attempts.json');
    const now = Date.now();
    const stale = now - (16 * 60 * 1000);
    const attempts = {
        'user:fresh-user': { count: 1, firstAttempt: now, lastAttempt: now },
    };
    for (let index = 0; index < 250; index++) {
        attempts[`user:stale-${index}`] = { count: 1, firstAttempt: stale, lastAttempt: stale };
    }
    fs.writeFileSync(attemptsFile, JSON.stringify(attempts), 'utf8');

    const login = userStore.validateUser('admin', 'FAR2-Phase2-Selftest-9!', '198.51.100.10');
    assert.equal(login.role, 'admin');
    let persisted = JSON.parse(fs.readFileSync(attemptsFile, 'utf8'));
    assert.ok(persisted['user:fresh-user'], 'fresh username attempt state must remain');
    assert.equal(Object.keys(persisted).some(key => key.startsWith('user:stale-')), false, 'stale random usernames must expire');

    const oversized = {};
    for (let index = 0; index < 5000; index++) {
        oversized[`user:burst-${index}`] = { count: 1, firstAttempt: now, lastAttempt: now + index };
    }
    fs.writeFileSync(attemptsFile, JSON.stringify(oversized), 'utf8');
    const secondLogin = userStore.validateUser('admin', 'FAR2-Phase2-Selftest-9!', '198.51.100.11');
    assert.equal(secondLogin.role, 'admin');
    persisted = JSON.parse(fs.readFileSync(attemptsFile, 'utf8'));
    assert.ok(Object.keys(persisted).length <= 4096, 'login-attempt state must be bounded');

    console.log('security-phase2-selftest: PASS');
} finally {
    Module._load = originalLoad;
    if (originalBootstrapPassword === undefined)
        delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
    else
        process.env.ADMIN_BOOTSTRAP_PASSWORD = originalBootstrapPassword;
    fs.rmSync(root, { recursive: true, force: true });
}
