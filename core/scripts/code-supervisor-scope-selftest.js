const assert = require('node:assert/strict');
const { parseScope, shouldMonitorAccount } = require('../../tools/code-supervisor-scope');

const a = { id: 1, uin: '1234567890', platform: 'qq' };
const b = { id: 2, uin: '9876543210', platform: 'qq' };
const c = { id: 3, uin: '1234567890', platform: 'wechat' };

assert.equal(parseScope(undefined), null);
assert.equal(shouldMonitorAccount(a, null), true);
assert.equal(shouldMonitorAccount(b, null), true);
assert.equal(shouldMonitorAccount(c, null), false);

const scope = parseScope('1234567890,1234567890');
assert.equal(scope.size, 1);
assert.equal(shouldMonitorAccount(a, scope), true);
assert.equal(shouldMonitorAccount(b, scope), false);
assert.equal(shouldMonitorAccount(c, scope), false);

assert.equal(parseScope('').size, 0);
assert.equal(parseScope('malformed').size, 0);
assert.equal(parseScope('1234567890,malformed').size, 0);
assert.equal(shouldMonitorAccount(a, parseScope('malformed')), false);
assert.equal(parseScope('1234567890;9876543210').size, 2);
console.log('code-supervisor-scope-selftest: PASS');
