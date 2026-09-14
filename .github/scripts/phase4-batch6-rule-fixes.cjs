const fs = require('node:fs');
const path = require('node:path');
const { ESLint } = require('../../core/node_modules/eslint');

const coreDir = path.resolve(__dirname, '../../core');
const files = [
  'scripts/qq-activity-wire-capture.js',
  'scripts/qq-dog-addfood-wire-capture.js',
  'scripts/qq-official-readonly-ui-capture-selftest.js',
  'scripts/qq-official-readonly-ui-capture.js',
  'src/services/career.js',
  'src/services/mystery-shop.js',
];
const allowed = new Set(['unicorn/number-literal-case', 'unicorn/escape-case']);

(async () => {
  const eslint = new ESLint({ fix: false, cwd: coreDir });
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
  if (applied !== 10) throw new Error(`expected exactly 10 targeted fixes, got ${applied}`);
  console.log(`TARGETED_FIXES=${applied}`);
})().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
