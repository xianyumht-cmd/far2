const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanUnknownItemContexts } = require('../src/services/qq-unknown-item-context-evidence');

function write(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
}

function main() {
    console.log('FAR2 QQ Unknown Item Context Evidence Self-Test');
    console.log('安全: 只扫描临时 fixture，不读真实 QQ、不联网、不发送 RPC。\n');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'far2-unknown-context-'));
    const farm1 = path.join(root, '1112386029_3_fixtureA');
    const farm2 = path.join(root, '1112386029_3_fixtureB');
    const game = [
        `const activitySeedIds=[21037,21050];`,
        `const rewardTable={main:{item_id:21221,name:'星币奖励',kind:'reward'}};`,
        `const exchangeCost=[21251,3];`,
        `function resolveItem(id){if(id===26032)return 'mystery_activity_item';}`,
        `const plainNumber=29003;`,
        `const api='<url>';`,
    ].join('\n');
    write(path.join(farm1, 'game.js'), game.replace('<url>', 'https://example.test/path?token=abc123'));
    write(path.join(farm2, 'game.js'), game.replace('<url>', 'https://example.test/path?token=abc123'));

    try {
        const result = scanUnknownItemContexts(
            [21037, 21050, 21221, 21251, 26032, 29003],
            {
                miniAppRoot: root,
                allowNonWindows: true,
                contextChars: 180,
            },
        );
        assert.equal(result.ok, true);
        assert.equal(result.summary.requested, 6);
        const byId = new Map(result.entries.map(row => [row.itemId, row]));

        assert.equal(byId.get(21037).occurrenceCount, 2);
        assert.equal(byId.get(21037).uniqueContextCount, 1);
        assert.ok(byId.get(21037).aggregateKeywords.includes('seed'));
        assert.equal(byId.get(21037).contexts[0].sourceFiles.length, 2);
        console.log('✅ duplicate cache copies collapse into one context signature PASS');

        assert.ok(byId.get(21221).aggregateKeywords.includes('reward'));
        assert.ok(byId.get(21221).aggregateKeys.includes('item_id'));
        assert.ok(byId.get(21221).aggregateStrings.includes('星币奖励'));
        console.log('✅ reward-like nearby keys/strings are retained as clue-only context PASS');

        assert.ok(byId.get(21251).aggregateKeywords.includes('exchange'));
        assert.equal(byId.get(29003).occurrenceCount, 2);
        assert.equal(Object.prototype.hasOwnProperty.call(byId.get(29003), 'classification'), false);
        console.log('✅ plain numeric occurrence remains evidence-only with no identity classification PASS');

        const serialized = JSON.stringify(result);
        assert.equal(serialized.includes('https://example.test'), false);
        assert.ok(serialized.includes('<url>'));
        console.log('✅ URLs are redacted from exported context PASS');

        assert.equal(result.safety.qqCacheModified, false);
        assert.equal(result.safety.far2DataModified, false);
        assert.equal(result.safety.rpcSent, false);
        assert.equal(result.safety.plantWriteSent, false);
        assert.equal(result.safety.identityPromotedFromContext, false);
        console.log('✅ context scanner is read-only and never promotes identity PASS');

        console.log('\n=== RESULT ===');
        console.log(JSON.stringify({
            ok: true,
            summary: result.summary,
            networkTouched: false,
            rpcTouched: false,
            plantWriteTouched: false,
            identityPromoted: false,
        }, null, 2));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

try {
    main();
} catch (error) {
    console.error('\n❌ Unknown Item Context Evidence Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
}
