const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readJsonFile, writeJsonFileAtomic, isCriticalJsonFile } = require('../src/services/json-db');

function listBackups(filePath) {
    const dir = path.dirname(filePath);
    const prefix = `${path.basename(filePath)}.corrupt-`;
    return fs.readdirSync(dir).filter(name => name.startsWith(prefix) && name.endsWith('.bak'));
}

function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'far2-critical-json-'));
    try {
        const accounts = path.join(root, 'accounts.json');
        const cache = path.join(root, 'cache.json');

        assert.equal(isCriticalJsonFile(accounts), true);
        assert.equal(isCriticalJsonFile(cache), false);

        const missing = readJsonFile(accounts, () => ({ accounts: [], nextId: 1 }));
        assert.deepEqual(missing, { accounts: [], nextId: 1 }, 'missing critical file may use bootstrap fallback');

        writeJsonFileAtomic(accounts, { accounts: [{ id: '1', name: 'selftest' }], nextId: 2 });
        const valid = readJsonFile(accounts, () => ({ accounts: [], nextId: 1 }));
        assert.equal(valid.accounts.length, 1);
        assert.equal(valid.accounts[0].name, 'selftest');

        fs.writeFileSync(accounts, '{"accounts":[{"id":"1"}],', 'utf8');
        let thrown = null;
        try {
            readJsonFile(accounts, () => ({ accounts: [], nextId: 1 }));
        } catch (error) {
            thrown = error;
        }
        assert.ok(thrown, 'corrupt accounts.json must throw');
        assert.equal(thrown.code, 'critical_json_corrupt');
        assert.equal(thrown.reason, 'invalid_json');
        assert.ok(thrown.backupPath && fs.existsSync(thrown.backupPath), 'corrupt bytes must be preserved');
        assert.equal(fs.readFileSync(thrown.backupPath, 'utf8'), '{"accounts":[{"id":"1"}],');

        const backupsAfterFirstRead = listBackups(accounts);
        assert.equal(backupsAfterFirstRead.length, 1);
        try { readJsonFile(accounts, () => ({})); } catch {}
        assert.equal(listBackups(accounts).length, 1, 'same corrupt file must not create backup spam');

        fs.writeFileSync(accounts, '', 'utf8');
        let emptyError = null;
        try { readJsonFile(accounts, () => ({})); } catch (error) { emptyError = error; }
        assert.ok(emptyError);
        assert.equal(emptyError.code, 'critical_json_corrupt');
        assert.equal(emptyError.reason, 'empty_file');

        fs.writeFileSync(cache, '{bad json', 'utf8');
        assert.deepEqual(
            readJsonFile(cache, () => ({ tolerant: true })),
            { tolerant: true },
            'non-critical cache/artifact reads remain tolerant',
        );

        console.log('✅ missing accounts.json still supports first-run bootstrap');
        console.log('✅ valid accounts.json parses normally');
        console.log('✅ corrupt/empty accounts.json fails closed and preserves a backup');
        console.log('✅ repeated reads of the same corruption do not create backup spam');
        console.log('✅ non-critical JSON callers keep tolerant fallback behavior');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

try {
    main();
} catch (error) {
    console.error('❌ critical JSON fail-closed self-test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
}
