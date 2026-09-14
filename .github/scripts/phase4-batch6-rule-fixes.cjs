const fs = require('node:fs');
const path = require('node:path');
const { ESLint } = require('../../core/node_modules/eslint');

const files = [
  'core/scripts/qq-activity-wire-capture.js',
  'core/scripts/qq-dog-addfood-wire-capture.js',
  'core/scripts/qq-official-readonly-ui-capture-selftest.js',
  'core/scripts/qq-official-readonly-ui-capture.js',
  'core/scripts/qq-static-plant-overlay-scan.js',
  'core/src/services/career.js',
  'core/src/services/mystery-shop.js',
];
const allowed = new Set(['unicorn/number-literal-case', 'unicorn/escape-case']);

(async () => {
  const eslint = new ESLint({ fix: false });
  const results = await eslint.lintFiles(files);
  let applied = 0;
  for (const result of results) {
    const fixes = (result.messages || [])
      .filter(m => allowed.has(m.ruleId) && m.fix && Array.isArray(m.fix.range))
      .map(m => ({ ruleId: m.ruleId, range: m.fix.range, text: m.fix.text }))
      .sort((a, b) => b.range[0] - a.range[0]);
    if (!fixes.length) continue;
    let output = result.source;
    for (const fix of fixes) {
      output = output.slice(0, fix.range[0]) + fix.text + output.slice(fix.range[1]);
      applied += 1;
      console.log(`${fix.ruleId}\t${path.relative(process.cwd(), result.filePath)}`);
    }
    fs.writeFileSync(result.filePath, output, 'utf8');
  }
  if (applied !== 13) throw new Error(`expected exactly 13 targeted fixes, got ${applied}`);
  console.log(`TARGETED_FIXES=${applied}`);
})().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
