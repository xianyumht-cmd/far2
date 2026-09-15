import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const baselinePath = path.join(repoRoot, '.quality', 'eslint-baseline.json');

function getPnpmInvocation() {
    const lifecycleExecPath = String(process.env.npm_execpath || '').trim();
    if (lifecycleExecPath && /\.(?:c?js|mjs)$/i.test(lifecycleExecPath)) {
        return {
            command: process.execPath,
            prefixArgs: [lifecycleExecPath],
            shell: false,
        };
    }

    return {
        command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        prefixArgs: [],
        shell: process.platform === 'win32',
    };
}

function runEslint(workspace, targets) {
    const pnpm = getPnpmInvocation();
    const result = spawnSync(
        pnpm.command,
        [...pnpm.prefixArgs, '-C', workspace, 'exec', 'eslint', ...targets, '--format', 'json'],
        {
            cwd: repoRoot,
            encoding: 'utf8',
            maxBuffer: 50 * 1024 * 1024,
            shell: pnpm.shell,
        },
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
