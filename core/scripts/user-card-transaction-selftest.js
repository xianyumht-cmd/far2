const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeJsonFileAtomic, readJsonFile } = require('../src/services/json-db');
const {
    persistUserCardTransaction,
    recoverUserCardTransaction,
} = require('../src/services/user-card-transaction');

function readState(usersFile, cardsFile) {
    return {
        users: readJsonFile(usersFile, () => ({ users: [] })).users,
        cards: readJsonFile(cardsFile, () => ({ cards: [] })).cards,
    };
}

function writeState(usersFile, cardsFile, state) {
    writeJsonFileAtomic(usersFile, { users: state.users });
    writeJsonFileAtomic(cardsFile, { cards: state.cards });
}

function writeJournal(journalFile, before, next) {
    writeJsonFileAtomic(journalFile, {
        version: 1,
        createdAt: Date.now(),
        before,
        next,
    });
}

function makeFixture(root) {
    const usersFile = path.join(root, 'users.json');
    const cardsFile = path.join(root, 'cards.json');
    const journalFile = path.join(root, 'user-card-transaction.json');
    const before = {
        users: [{ username: 'admin', accountLimit: 2 }],
        cards: [{ code: 'CARD-1', usedBy: null }],
    };
    const next = {
        users: [
            { username: 'admin', accountLimit: 2 },
            { username: 'new-user', cardCode: 'CARD-1' },
        ],
        cards: [{ code: 'CARD-1', usedBy: 'new-user' }],
    };
    writeState(usersFile, cardsFile, before);
    return { usersFile, cardsFile, journalFile, before, next };
}

function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'far2-user-card-txn-'));
    try {
        {
            const dir = path.join(root, 'success');
            fs.mkdirSync(dir, { recursive: true });
            const f = makeFixture(dir);
            const result = persistUserCardTransaction({
                ...f,
                beforeUsers: f.before.users,
                beforeCards: f.before.cards,
                nextUsers: f.next.users,
                nextCards: f.next.cards,
            });
            assert.equal(result.ok, true);
            assert.deepEqual(readState(f.usersFile, f.cardsFile), f.next);
            assert.equal(fs.existsSync(f.journalFile), false, 'successful transaction must remove journal');
        }

        {
            const dir = path.join(root, 'partial-crash');
            fs.mkdirSync(dir, { recursive: true });
            const f = makeFixture(dir);
            writeJournal(f.journalFile, f.before, f.next);
            writeJsonFileAtomic(f.usersFile, { users: f.next.users });
            const recovered = recoverUserCardTransaction(f);
            assert.equal(recovered.action, 'rolled_back');
            assert.deepEqual(readState(f.usersFile, f.cardsFile), f.before);
            assert.equal(fs.existsSync(f.journalFile), false);
        }

        {
            const dir = path.join(root, 'both-next');
            fs.mkdirSync(dir, { recursive: true });
            const f = makeFixture(dir);
            writeJournal(f.journalFile, f.before, f.next);
            writeState(f.usersFile, f.cardsFile, f.next);
            const recovered = recoverUserCardTransaction(f);
            assert.equal(recovered.action, 'commit_confirmed');
            assert.deepEqual(readState(f.usersFile, f.cardsFile), f.next);
            assert.equal(fs.existsSync(f.journalFile), false);
        }

        {
            const dir = path.join(root, 'prepared-noop');
            fs.mkdirSync(dir, { recursive: true });
            const f = makeFixture(dir);
            writeJournal(f.journalFile, f.before, f.next);
            const recovered = recoverUserCardTransaction(f);
            assert.equal(recovered.action, 'prepared_noop');
            assert.deepEqual(readState(f.usersFile, f.cardsFile), f.before);
            assert.equal(fs.existsSync(f.journalFile), false);
        }

        {
            const dir = path.join(root, 'write-failure');
            fs.mkdirSync(dir, { recursive: true });
            const f = makeFixture(dir);
            let injected = false;
            const writeWithOneFailure = (filePath, data) => {
                if (!injected && path.resolve(filePath) === path.resolve(f.cardsFile)) {
                    injected = true;
                    const error = new Error('selftest second-file write failure');
                    error.code = 'SELFTEST_SECOND_WRITE';
                    throw error;
                }
                writeJsonFileAtomic(filePath, data);
            };

            let error = null;
            try {
                persistUserCardTransaction({
                    ...f,
                    beforeUsers: f.before.users,
                    beforeCards: f.before.cards,
                    nextUsers: f.next.users,
                    nextCards: f.next.cards,
                    writeJsonFile: writeWithOneFailure,
                });
            } catch (err) {
                error = err;
            }
            assert.ok(error);
            assert.equal(error.code, 'SELFTEST_SECOND_WRITE');
            assert.equal(error.recoveryError, undefined, 'compensating recovery should succeed');
            assert.deepEqual(readState(f.usersFile, f.cardsFile), f.before);
            assert.equal(fs.existsSync(f.journalFile), false, 'successful rollback must remove journal');
        }

        {
            const dir = path.join(root, 'unknown-divergence');
            fs.mkdirSync(dir, { recursive: true });
            const f = makeFixture(dir);
            writeJournal(f.journalFile, f.before, f.next);
            writeJsonFileAtomic(f.usersFile, { users: [{ username: 'unexpected' }] });
            let error = null;
            try { recoverUserCardTransaction(f); } catch (err) { error = err; }
            assert.equal(error && error.code, 'user_card_transaction_inconsistent');
            assert.equal(fs.existsSync(f.journalFile), true, 'unknown divergence must remain for manual recovery');
        }

        console.log('✅ user/card transaction commits both files and removes journal');
        console.log('✅ crash between files rolls back both files to before-state');
        console.log('✅ both-next crash state is recognized as committed');
        console.log('✅ second-file write failure compensates back to before-state');
        console.log('✅ unknown divergence fails closed and preserves journal evidence');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

try {
    main();
} catch (error) {
    console.error('❌ user/card transaction self-test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
}
