const fs = require('node:fs');
const {
    readJsonFile,
    writeJsonFileAtomic,
} = require('./json-db');

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function sameJson(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function removeJournal(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return;
    fs.unlinkSync(filePath);
}

function validateJournal(journal) {
    if (!journal || typeof journal !== 'object' || Array.isArray(journal)) return false;
    if (Number(journal.version) !== 1) return false;
    if (!journal.before || !journal.next) return false;
    if (!Array.isArray(journal.before.users) || !Array.isArray(journal.before.cards)) return false;
    if (!Array.isArray(journal.next.users) || !Array.isArray(journal.next.cards)) return false;
    return true;
}

function readJournal(journalFile) {
    if (!fs.existsSync(journalFile)) return null;
    const journal = readJsonFile(journalFile, () => null);
    if (!validateJournal(journal)) {
        const error = new Error(`User/card transaction journal is invalid: ${journalFile}`);
        error.code = 'user_card_transaction_journal_invalid';
        error.filePath = journalFile;
        throw error;
    }
    return journal;
}

function readCurrentState(usersFile, cardsFile) {
    const usersData = readJsonFile(usersFile, () => ({ users: [] }));
    const cardsData = readJsonFile(cardsFile, () => ({ cards: [] }));
    return {
        users: Array.isArray(usersData.users) ? usersData.users : [],
        cards: Array.isArray(cardsData.cards) ? cardsData.cards : [],
    };
}

function recoverUserCardTransaction(options = {}) {
    const usersFile = String(options.usersFile || '');
    const cardsFile = String(options.cardsFile || '');
    const journalFile = String(options.journalFile || '');
    const readCurrentStateFn = options.readCurrentState || readCurrentState;
    const writeJsonFileFn = options.writeJsonFile || writeJsonFileAtomic;
    const removeJournalFn = options.removeJournal || removeJournal;

    if (!usersFile || !cardsFile || !journalFile) {
        throw new Error('user/card transaction paths are required');
    }
    if (!fs.existsSync(journalFile)) {
        return { recovered: false, action: 'none' };
    }

    const journal = options.journal || readJournal(journalFile);
    if (!validateJournal(journal)) {
        const error = new Error(`User/card transaction journal is invalid: ${journalFile}`);
        error.code = 'user_card_transaction_journal_invalid';
        throw error;
    }

    const current = readCurrentStateFn(usersFile, cardsFile);
    const beforeUsers = journal.before.users;
    const beforeCards = journal.before.cards;
    const nextUsers = journal.next.users;
    const nextCards = journal.next.cards;

    const usersAreBefore = sameJson(current.users, beforeUsers);
    const cardsAreBefore = sameJson(current.cards, beforeCards);
    const usersAreNext = sameJson(current.users, nextUsers);
    const cardsAreNext = sameJson(current.cards, nextCards);

    if (usersAreNext && cardsAreNext) {
        removeJournalFn(journalFile);
        return { recovered: true, action: 'commit_confirmed' };
    }

    if (usersAreBefore && cardsAreBefore) {
        removeJournalFn(journalFile);
        return { recovered: true, action: 'prepared_noop' };
    }

    const expectedMixedState = (usersAreNext || usersAreBefore)
        && (cardsAreNext || cardsAreBefore);
    if (expectedMixedState) {
        writeJsonFileFn(usersFile, { users: cloneJson(beforeUsers) });
        writeJsonFileFn(cardsFile, { cards: cloneJson(beforeCards) });
        removeJournalFn(journalFile);
        return { recovered: true, action: 'rolled_back' };
    }

    const error = new Error('User/card transaction state diverged from both before/next snapshots; refusing automatic recovery');
    error.code = 'user_card_transaction_inconsistent';
    error.journalFile = journalFile;
    throw error;
}

function persistUserCardTransaction(options = {}) {
    const usersFile = String(options.usersFile || '');
    const cardsFile = String(options.cardsFile || '');
    const journalFile = String(options.journalFile || '');
    const beforeUsers = cloneJson(options.beforeUsers || []);
    const beforeCards = cloneJson(options.beforeCards || []);
    const nextUsers = cloneJson(options.nextUsers || []);
    const nextCards = cloneJson(options.nextCards || []);
    const writeJsonFileFn = options.writeJsonFile || writeJsonFileAtomic;
    const removeJournalFn = options.removeJournal || removeJournal;
    const recoverFn = options.recover || recoverUserCardTransaction;

    if (!usersFile || !cardsFile || !journalFile) {
        throw new Error('user/card transaction paths are required');
    }

    const journal = {
        version: 1,
        createdAt: Date.now(),
        before: {
            users: beforeUsers,
            cards: beforeCards,
        },
        next: {
            users: nextUsers,
            cards: nextCards,
        },
    };

    writeJsonFileFn(journalFile, journal);

    try {
        writeJsonFileFn(usersFile, { users: nextUsers });
        writeJsonFileFn(cardsFile, { cards: nextCards });
        removeJournalFn(journalFile);
        return { ok: true };
    } catch (error) {
        try {
            recoverFn({
                usersFile,
                cardsFile,
                journalFile,
                journal,
                writeJsonFile: writeJsonFileFn,
                removeJournal: removeJournalFn,
            });
        } catch (recoveryError) {
            error.recoveryError = recoveryError;
        }
        throw error;
    }
}

module.exports = {
    persistUserCardTransaction,
    recoverUserCardTransaction,
    validateJournal,
    sameJson,
};
