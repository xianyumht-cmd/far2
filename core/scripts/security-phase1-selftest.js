const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const admin = fs.readFileSync(path.join(root, 'src/controllers/admin.js'), 'utf8');
const userStore = fs.readFileSync(path.join(root, 'src/models/user-store.js'), 'utf8');

for (const token of [
    "app.post('/api/proxy'",
    "req.path === '/proxy'",
    'x-proxy-api-url',
    'x-proxy-api-key',
    'x-proxy-app-id',
    'WX_PROXY_API_URL',
    'WX_PROXY_API_KEY',
]) {
    assert.equal(admin.includes(token), false, `retired proxy surface remains: ${token}`);
}

assert.equal(userStore.includes("const defaultPassword = 'admin'"), false, 'fixed admin/admin bootstrap must not return');
assert.equal(userStore.includes('默认密码: admin'), false, 'fixed admin password must never be logged');
assert.equal(userStore.includes('ADMIN_BOOTSTRAP_PASSWORD'), true, 'secure bootstrap password gate is required');
assert.equal(userStore.includes('admin_bootstrap_password_required'), true, 'missing bootstrap password must fail closed');
assert.equal(userStore.includes('password.length < 12'), true, 'bootstrap password must have a stronger minimum length');

console.log('security-phase1-selftest: PASS');
