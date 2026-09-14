const fs = require('node:fs');
const path = require('node:path');

const inputs = ['/tmp/core-eslint.json', '/tmp/web-eslint.json'];
const results = inputs.flatMap((file) => {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8').trim();
  return text ? JSON.parse(text) : [];
});

const rows = [];
for (const file of results) {
  const rel = path.relative(process.cwd(), file.filePath || '').replaceAll('\\', '/');
  for (const message of file.messages || []) {
    rows.push({
      file: rel,
      line: message.line || 0,
      column: message.column || 0,
      rule: message.ruleId || '(parser)',
      severity: message.severity || 0,
      message: String(message.message || '').replace(/\s+/g, ' ').trim(),
    });
  }
}

function tally(keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

console.log(`TOTAL=${rows.length}`);
console.log('\nTOP_RULES');
for (const [rule, count] of tally(r => r.rule).slice(0, 30)) console.log(`${count}\t${rule}`);
console.log('\nTOP_FILES');
for (const [file, count] of tally(r => r.file).slice(0, 40)) console.log(`${count}\t${file}`);

const preferred = new Set(['no-unused-vars', 'unused-imports/no-unused-vars', 'no-undef', 'prefer-const', 'eqeqeq', 'no-useless-catch']);
console.log('\nMECHANICAL_CANDIDATES');
for (const row of rows.filter(r => preferred.has(r.rule)).slice(0, 160)) {
  console.log(`${row.rule}\t${row.file}:${row.line}:${row.column}\t${row.message}`);
}
