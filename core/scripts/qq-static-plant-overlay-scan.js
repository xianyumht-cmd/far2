const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const {
    getMiniAppRoot,
    findFarmFolders,
    scanTextForSeedConfig,
    selectDeterministicHit,
} = require('../src/services/qq-seed-config-learner');

const DEFAULT_TARGETS = [20264, 21037, 21050, 21221, 21251, 26032, 29003];
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 4000;
const MAX_SNIPPETS_PER_TOKEN = 4;
const CONTEXT_BYTES = 900;

function toPositiveInt(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function normalizeTargets(values) {
    const source = Array.isArray(values) && values.length ? values : DEFAULT_TARGETS;
    return [...new Set(source.map(toPositiveInt).filter(Boolean))];
}

function extLabel(filePath) {
    const base = path.basename(filePath);
    const ext = path.extname(base).toLowerCase();
    return ext || '<noext>';
}

function filePriority(filePath) {
    const name = String(filePath || '').toLowerCase();
    let score = 0;
    if (/plant|crop|seed/.test(name)) score += 8;
    if (/item|goods/.test(name)) score += 5;
    if (/config|setting|data|asset|bundle|import|native/.test(name)) score += 3;
    if (/\.(?:json|js|mjs|cjs|txt|bytes|bin|dat)$/i.test(name)) score += 2;
    if (!path.extname(name)) score += 2;
    return score;
}

function listAllFiles(folder) {
    const out = [];
    const stack = [folder];
    while (stack.length) {
        const dir = stack.pop();
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
                continue;
            }
            if (!entry.isFile()) continue;
            let stat;
            try { stat = fs.statSync(full); } catch { continue; }
            if (stat.size <= 0 || stat.size > MAX_FILE_BYTES) continue;
            out.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs || 0, score: filePriority(full) });
        }
    }
    return out.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs || a.size - b.size);
}

function isLikelyUtf16Le(buffer) {
    if (!buffer || buffer.length < 8) return false;
    const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
    let oddZero = 0;
    let pairs = 0;
    for (let i = 1; i < sample.length; i += 2) {
        pairs++;
        if (sample[i] === 0) oddZero++;
    }
    return pairs > 8 && oddZero / pairs > 0.35;
}

function isLikelyTextBuffer(buffer) {
    if (!buffer || buffer.length === 0) return false;
    const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
    let printable = 0;
    let zero = 0;
    for (const byte of sample) {
        if (byte === 0) zero++;
        if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126) || byte >= 0x80) printable++;
    }
    if (isLikelyUtf16Le(sample)) return true;
    return zero / sample.length < 0.05 && printable / sample.length > 0.82;
}

function maybeDecompress(buffer) {
    const variants = [];
    if (!buffer || buffer.length < 2) return variants;
    try {
        if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
            variants.push({ layer: 'gzip', buffer: zlib.gunzipSync(buffer, { maxOutputLength: 128 * 1024 * 1024 }) });
        } else if (buffer[0] === 0x78) {
            variants.push({ layer: 'zlib', buffer: zlib.inflateSync(buffer, { maxOutputLength: 128 * 1024 * 1024 }) });
        }
    } catch {
        // Fail closed: decompression is diagnostic-only.
    }
    return variants;
}

function countToken(text, token) {
    const source = String(text || '');
    const needle = String(token || '');
    if (!needle) return 0;
    let count = 0;
    let from = 0;
    while (from < source.length) {
        const index = source.indexOf(needle, from);
        if (index < 0) break;
        const before = index > 0 ? source[index - 1] : '';
        const after = index + needle.length < source.length ? source[index + needle.length] : '';
        if (!/\d/.test(before) && !/\d/.test(after)) count++;
        from = index + needle.length;
    }
    return count;
}

function sanitizeSnippet(value) {
    return String(value || '')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
        .replace(/https?:\/\/[^\s"']+/gi, '[URL]')
        .replace(/(?:authorization|token|ticket|session|openid|code)\s*[:=]\s*["']?[^\s,"'}]{12,}/gi, '$1=[MASKED]')
        .replace(/[A-Za-z0-9+/_=-]{64,}/g, '[LONG_VALUE_MASKED]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 2200);
}

function snippetsAround(text, token) {
    const source = String(text || '');
    const needle = String(token || '');
    const snippets = [];
    let from = 0;
    while (snippets.length < MAX_SNIPPETS_PER_TOKEN) {
        const index = source.indexOf(needle, from);
        if (index < 0) break;
        const start = Math.max(0, index - CONTEXT_BYTES);
        const end = Math.min(source.length, index + needle.length + CONTEXT_BYTES);
        snippets.push(sanitizeSnippet(source.slice(start, end)));
        from = index + needle.length;
    }
    return [...new Set(snippets.filter(Boolean))];
}

function decodeTextVariants(buffer, force = false) {
    const out = [];
    if (!buffer || buffer.length === 0) return out;
    if (force || isLikelyTextBuffer(buffer)) {
        out.push({ encoding: 'utf8', text: buffer.toString('utf8') });
    }
    if (isLikelyUtf16Le(buffer)) {
        out.push({ encoding: 'utf16le', text: buffer.toString('utf16le') });
    }
    return out;
}

function scanTextLayer(text, targets, meta) {
    const proofs = [];
    const targetEvidence = [];
    let hasAnyTarget = false;
    let hasAnyFruit = false;

    for (const seedId of targets) {
        const fruitId = seedId + 20000;
        const seedCount = countToken(text, seedId);
        const fruitCount = countToken(text, fruitId);
        if (seedCount > 0 || fruitCount > 0) {
            hasAnyTarget = hasAnyTarget || seedCount > 0;
            hasAnyFruit = hasAnyFruit || fruitCount > 0;
            targetEvidence.push({
                seedId,
                fruitId,
                seedCount,
                fruitCount,
                seedSnippets: seedCount ? snippetsAround(text, seedId) : [],
                fruitSnippets: fruitCount ? snippetsAround(text, fruitId) : [],
            });
        }

        if (seedCount > 0) {
            for (const hit of scanTextForSeedConfig(text, seedId)) {
                proofs.push({
                    ...hit,
                    sourceFolder: meta.sourceFolder,
                    sourceFile: meta.sourceFile,
                    layer: meta.layer,
                    encoding: meta.encoding,
                });
            }
        }
    }

    return {
        proofs,
        targetEvidence,
        hasAnyTarget,
        hasAnyFruit,
        keywords: {
            seedId: /seed_id|seedId/.test(text),
            size: /(?:^|[^A-Za-z])size(?:[^A-Za-z]|$)/.test(text),
            name: /(?:^|[^A-Za-z])name(?:[^A-Za-z]|$)/.test(text),
            landLevelNeed: /land_level_need|landLevelNeed/.test(text),
            growPhases: /grow_phases|growPhases/.test(text),
        },
    };
}

function scanFarmCache(options = {}) {
    const targets = normalizeTargets(options.targets);
    const miniAppRoot = options.miniAppRoot || getMiniAppRoot();
    const maxFolders = Math.max(1, Math.min(8, Number(options.maxFolders) || 3));
    const folders = findFarmFolders(miniAppRoot).slice(0, maxFolders);
    const extensionStats = new Map();
    const allProofs = new Map(targets.map(id => [id, []]));
    const interestingFiles = [];
    let scannedFiles = 0;
    let readFiles = 0;
    let scannedBytes = 0;

    outer:
    for (const folder of folders) {
        for (const file of listAllFiles(folder.path)) {
            if (scannedFiles >= (Number(options.maxFiles) || MAX_FILES)) break outer;
            if (scannedBytes + file.size > (Number(options.maxTotalBytes) || MAX_TOTAL_BYTES)) break outer;
            scannedFiles++;
            scannedBytes += file.size;

            const ext = extLabel(file.path);
            const stat = extensionStats.get(ext) || { extension: ext, files: 0, bytes: 0, targetFiles: 0 };
            stat.files++;
            stat.bytes += file.size;
            extensionStats.set(ext, stat);

            let buffer;
            try {
                buffer = fs.readFileSync(file.path);
                readFiles++;
            } catch {
                continue;
            }

            const sourceFile = path.relative(folder.path, file.path);
            const layers = [{ layer: 'raw', buffer }, ...maybeDecompress(buffer)];
            const fileEvidence = [];
            let targetFile = false;
            let keywordFile = false;

            for (const layer of layers) {
                const asciiProbe = layer.buffer.toString('latin1');
                const hasRawTarget = targets.some(id => asciiProbe.includes(String(id)) || asciiProbe.includes(String(id + 20000)));
                const forceDecode = hasRawTarget || file.score >= 5;
                const variants = decodeTextVariants(layer.buffer, forceDecode);
                for (const variant of variants) {
                    const result = scanTextLayer(variant.text, targets, {
                        sourceFolder: folder.name,
                        sourceFile,
                        layer: layer.layer,
                        encoding: variant.encoding,
                    });
                    targetFile = targetFile || result.hasAnyTarget || result.hasAnyFruit;
                    keywordFile = keywordFile || Object.values(result.keywords).some(Boolean);
                    for (const proof of result.proofs) allProofs.get(proof.seedId)?.push(proof);
                    if (result.targetEvidence.length || result.proofs.length) {
                        fileEvidence.push({
                            layer: layer.layer,
                            encoding: variant.encoding,
                            targets: result.targetEvidence,
                            proofs: result.proofs,
                            keywords: result.keywords,
                        });
                    }
                }
            }

            if (targetFile) stat.targetFiles++;
            if (targetFile || (keywordFile && file.score >= 5)) {
                interestingFiles.push({
                    folder: folder.name,
                    file: sourceFile,
                    size: file.size,
                    extension: ext,
                    priority: file.score,
                    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
                    evidence: fileEvidence,
                });
            }
        }
    }

    const entries = targets.map((seedId) => {
        const proofs = allProofs.get(seedId) || [];
        const selected = selectDeterministicHit(proofs);
        return {
            seedId,
            fruitId: seedId + 20000,
            proven: !!selected,
            plantSize: selected ? Number(selected.plantSize) : 0,
            rawSize: selected ? Number(selected.rawSize) : null,
            name: selected ? String(selected.name || '') : '',
            requiredLevel: selected ? Math.max(0, Number(selected.requiredLevel) || 0) : 0,
            proofCount: proofs.length,
            proofFiles: [...new Set(proofs.map(row => `${row.sourceFolder}/${row.sourceFile}`))],
            proofLayers: [...new Set(proofs.map(row => `${row.layer}/${row.encoding}`))],
            reason: selected ? 'same-direct-object-seed_id+size' : (proofs.length ? 'conflicting-direct-proof' : 'no-direct-proof'),
        };
    });

    return {
        generatedAt: new Date().toISOString(),
        miniAppRoot,
        folders: folders.map(row => row.name),
        targets,
        summary: {
            folders: folders.length,
            scannedFiles,
            readFiles,
            scannedBytes,
            interestingFiles: interestingFiles.length,
            proven: entries.filter(row => row.proven).length,
            unresolved: entries.filter(row => !row.proven).length,
        },
        extensionStats: [...extensionStats.values()].sort((a, b) => b.bytes - a.bytes || b.files - a.files),
        entries,
        interestingFiles: interestingFiles.slice(0, 250),
        safety: {
            qqCacheModified: false,
            far2DataModified: false,
            networkTouched: false,
            rpcSent: false,
            plantWriteSent: false,
            fullRawFilesExported: false,
            snippetsSanitized: true,
        },
    };
}

function parseCliTargets(argv) {
    const ids = [];
    for (const token of argv) {
        for (const part of String(token || '').split(/[\s,;]+/)) {
            const id = toPositiveInt(part);
            if (id) ids.push(id);
        }
    }
    return normalizeTargets(ids);
}

function main() {
    const targets = parseCliTargets(process.argv.slice(2));
    const report = scanFarmCache({ targets });
    const dir = path.join(os.tmpdir(), 'FAR2-STATIC-PLANT-OVERLAY');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(dir, `static-plant-overlay-${stamp}.json`);
    fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    console.log('FAR2 QQ Static Plant Overlay Scan');
    console.log(`缓存目录: ${report.miniAppRoot}`);
    console.log(`最近目录: ${report.folders.join(', ') || 'NONE'}`);
    console.log(`文件: ${report.summary.scannedFiles}, bytes=${report.summary.scannedBytes}`);
    console.log(`直接 footprint 证明: ${report.summary.proven}/${report.entries.length}`);
    for (const row of report.entries) {
        console.log(`${row.seedId} -> fruit ${row.fruitId}: ${row.proven ? `${row.plantSize}x${row.plantSize} rawSize=${row.rawSize}` : row.reason}`);
    }
    console.log(`报告: ${target}`);
}

if (require.main === module) {
    try { main(); }
    catch (error) {
        console.error(`Static Plant Overlay Scan FAIL: ${error && error.stack ? error.stack : error}`);
        process.exitCode = 1;
    }
}

module.exports = {
    DEFAULT_TARGETS,
    normalizeTargets,
    listAllFiles,
    isLikelyUtf16Le,
    isLikelyTextBuffer,
    maybeDecompress,
    scanTextLayer,
    scanFarmCache,
};