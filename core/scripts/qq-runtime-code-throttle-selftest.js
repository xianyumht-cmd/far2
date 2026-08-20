const assert = require('node:assert/strict');
const { waitForRuntimeCode } = require('../src/services/windows-runtime-code');

async function testClipboardIsThrottled() {
    let now = 1_000_000;
    let clipboardCalls = 0;

    const result = await waitForRuntimeCode(now, 4500, {
        now: () => now,
        sleep: async (ms) => { now += ms; },
        listCodeFiles: () => [],
        readClipboard: () => {
            clipboardCalls += 1;
            return '';
        },
        filePollMs: 250,
        clipboardPollMs: 2000,
        clipboardInitialDelayMs: 1000,
    });

    assert.equal(result, null);
    assert.equal(clipboardCalls, 2, '4.5s wait should invoke clipboard fallback only twice');
}

async function testClipboardFallbackStillWorks() {
    let now = 2_000_000;
    let clipboardCalls = 0;

    const result = await waitForRuntimeCode(now, 5000, {
        now: () => now,
        sleep: async (ms) => { now += ms; },
        listCodeFiles: () => [],
        readClipboard: () => {
            clipboardCalls += 1;
            return clipboardCalls >= 2 ? 'SELFTEST_FRESH_CODE_2' : '';
        },
        filePollMs: 250,
        clipboardPollMs: 2000,
        clipboardInitialDelayMs: 1000,
    });

    assert.equal(clipboardCalls, 2);
    assert.equal(result.source, 'clipboard');
    assert.equal(result.code, 'SELFTEST_FRESH_CODE_2');
}

async function testFileArtifactRemainsFastPath() {
    let now = 3_000_000;
    let clipboardCalls = 0;
    let fileReads = 0;

    const result = await waitForRuntimeCode(now, 5000, {
        now: () => now,
        sleep: async (ms) => { now += ms; },
        listCodeFiles: () => ['selftest/_code.txt'],
        statFile: () => ({ mtimeMs: now }),
        readFile: () => {
            fileReads += 1;
            return 'SELFTEST_FILE_CODE_1';
        },
        readClipboard: () => {
            clipboardCalls += 1;
            return 'SHOULD_NOT_BE_USED';
        },
        filePollMs: 250,
        clipboardPollMs: 2000,
        clipboardInitialDelayMs: 1000,
    });

    assert.equal(result.source, '_code.txt');
    assert.equal(result.code, 'SELFTEST_FILE_CODE_1');
    assert.equal(fileReads, 1);
    assert.equal(clipboardCalls, 0, 'file artifact must win before shell fallback');
}

async function main() {
    await testClipboardIsThrottled();
    await testClipboardFallbackStillWorks();
    await testFileArtifactRemainsFastPath();

    console.log('✅ runtime Code file artifact remains the fast path');
    console.log('✅ PowerShell clipboard fallback is bounded to the slower fallback cadence');
    console.log('✅ clipboard fallback still returns a valid Code when the file artifact is unavailable');
}

main().catch((err) => {
    console.error('❌ runtime Code throttle self-test FAIL:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
});
