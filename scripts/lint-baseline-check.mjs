import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const baselinePath = path.join(repoRoot, '.quality', 'eslint-baseline.json');

function resolveEslintBin(workspace) {
    const workspaceRoot = path.join(repoRoot, workspace);
    const workspaceRequire = createRequire(path.join(workspaceRoot, 'package.json'));
    const eslintMainPath = workspaceRequire.resolve('eslint');
    const eslintPackageRoot = path.resolve(path.dirname(eslintMainPath), '..');
    const eslintBinPath = path.join(eslintPackageRoot, 'bin', 'eslint.js');
    if (!fs.existsSync(eslintBinPath)) {
        throw new Error(`Could not resolve ESLint CLI for ${workspace}: ${eslintBinPath}`);
    }
    return eslintBinPath;
}

function runEslint(workspace, targets) {
    const workspaceRoot = path.join(repoRoot, workspace);
    const result = spawnSync(
        process.execPath,
        [resolveEslintBin(workspace), ...targets, '--format', 'json'],
        { cwd: workspaceRoot, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
    );
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1) {
        process.stderr.write(result.stderr || '');
        throw new Error(`ESLint execution failed for ${workspace} with exit code ${result.status}`);
    }
    try {
        return JSON.parse(result.stdout || '[]');
    } catch (error) {
        process.stderr.write(result.stderr || '');
        throw new Error(`Could not parse ESLint JSON for ${workspace}: ${error.message}`);
    }
}

function collectIssues() {
    const reports = [
        ...runEslint('core', ['.']),
        ...runEslint('web', ['src/**/*.{ts,vue}']),
    ];
    const counts = new Map();
    let total = 0;
    for (const report of reports) {
        const file = path.relative(repoRoot, report.filePath).replaceAll('\\', '/');
        for (const message of report.messages || []) {
            if (!message.severity) continue;
            const rule = message.ruleId || 'unknown-rule';
            const key = `${file}|${rule}|${message.message}`;
            counts.set(key, (counts.get(key) || 0) + 1);
            total += 1;
        }
    }
    return { counts, total };
}

const current = collectIssues();
if (!fs.existsSync(baselinePath)) {
    console.error('Missing .quality/eslint-baseline.json. Baseline creation must be an explicit reviewed change.');
    process.exit(1);
}

const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const allowed = baseline.entries || {};
const regressions = [];
for (const [key, count] of current.counts.entries()) {
    const previous = Number(allowed[key] || 0);
    if (count > previous) regressions.push({ key, previous, current: count });
}

if (regressions.length > 0) {
    console.error(`ESLint baseline regression: ${regressions.length} finding groups increased or are new.`);
    for (const item of regressions.slice(0, 50)) {
        console.error(`- ${item.key} :: ${item.previous} -> ${item.current}`);
    }
    if (regressions.length > 50) console.error(`... ${regressions.length - 50} more`);
    process.exit(1);
}

console.log(`ESLint baseline gate PASS: ${current.total} current findings; baseline ${baseline.totalIssues}. No debt growth.`);
