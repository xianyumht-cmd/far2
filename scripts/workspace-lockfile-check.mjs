import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const rootLockfile = path.join(repoRoot, 'pnpm-lock.yaml');
const skippedDirectoryNames = new Set(['.git', 'node_modules', 'dist', 'coverage']);
const nestedLockfiles = [];

function scanDirectory(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (skippedDirectoryNames.has(entry.name)) continue;
            const childDirectory = path.join(directory, entry.name);
            if (childDirectory === path.join(repoRoot, 'core', 'data')) continue;
            scanDirectory(childDirectory);
            continue;
        }

        if (!entry.isFile() || entry.name !== 'pnpm-lock.yaml') continue;
        const lockfile = path.join(directory, entry.name);
        if (lockfile !== rootLockfile) nestedLockfiles.push(lockfile);
    }
}

if (!fs.existsSync(rootLockfile)) {
    console.error('Workspace lockfile gate FAIL: root pnpm-lock.yaml is missing.');
    process.exit(1);
}

scanDirectory(repoRoot);
nestedLockfiles.sort();

if (nestedLockfiles.length > 0) {
    console.error('Workspace lockfile gate FAIL: only the repository-root pnpm-lock.yaml is authoritative.');
    for (const lockfile of nestedLockfiles) {
        console.error(`- ${path.relative(repoRoot, lockfile).replaceAll('\\', '/')}`);
    }
    process.exit(1);
}

console.log('Workspace lockfile gate PASS: root pnpm-lock.yaml is the only lockfile.');
