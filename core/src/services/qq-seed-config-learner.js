const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const process = require('node:process');
const { getDataFile } = require('../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('./json-db');

const APP_ID = '1112386029';
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 300;
const MAX_TOTAL_BYTES = 192 * 1024 * 1024;
const NEGATIVE_TTL_MS = 10 * 60 * 1000;
const MAX_OBJECT_SCAN_CHARS = 16_000;
const negativeCache = new Map();

function normalizePositiveInt(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    const result = Math.trunc(num);
    return result > 0 ? result : 0;
}

function getQqexRoot() {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'QQEX');
}

function getMiniAppRoot() {
    return path.join(getQqexRoot(), 'miniapp', 'temps', 'miniapp_src');
}

function findFarmFolders(root = getMiniAppRoot()) {
    if (!fs.existsSync(root)) return [];
    const folders = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !new RegExp(`^${APP_ID}_3_.+$`).test(entry.name)) continue;
        const full = path.join(root, entry.name);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(full).mtimeMs || 0; } catch {}
        folders.push({ path: full, name: entry.name, mtimeMs });
    }
    return folders.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function filePriorityScore(file) {
    const name = String(file || '').toLowerCase();
    let score = 0;
    if (name.includes('plant')) score += 8;
    if (name.includes('config')) score += 6;
    if (name.includes('item')) score += 4;
    if (name.endsWith('.json')) score += 3;
    return score;
}

function listCandidateFiles(folder) {
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
            if (!/\.(?:js|mjs|cjs|json)$/i.test(entry.name)) continue;
            let stat;
            try { stat = fs.statSync(full); } catch { continue; }
            if (stat.size <= 0 || stat.size > MAX_FILE_BYTES) continue;
            out.push({
                path: full,
                size: stat.size,
                mtimeMs: stat.mtimeMs || 0,
                score: filePriorityScore(full),
            });
        }
    }
    out.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs || a.size - b.size);
    return out;
}

function findObjectEnd(text, start, limitEnd) {
    let depth = 0;
    let quote = '';
    let escaped = false;
    const end = Math.min(text.length, Math.max(start + 1, limitEnd));
    for (let i = start; i < end; i++) {
        const ch = text[i];
        if (quote) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                escaped = true;
                continue;
            }
            if (ch === quote) quote = '';
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            quote = ch;
            continue;
        }
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return i + 1;
            if (depth < 0) return -1;
        }
    }
    return -1;
}

function collectContainingObjectSnippets(text, index, options = {}) {
    const maxChars = Math.max(1000, Number(options.maxChars) || MAX_OBJECT_SCAN_CHARS);
    const min = Math.max(0, index - maxChars);
    const max = Math.min(text.length, index + maxChars);
    const starts = [];
    for (let i = index; i >= min && starts.length < 24; i--) {
        if (text[i] === '{') starts.push(i);
    }

    const snippets = [];
    for (const start of starts) {
        const end = findObjectEnd(text, start, max);
        if (end <= index || end < 0) continue;
        const snippet = text.slice(start, end);
        if (snippet.length > maxChars * 2) continue;
        snippets.push({ start, end, text: snippet });
    }
    return snippets;
}

/**
 * Keep only direct fields of the outer object. Nested object/array contents are replaced
 * with spaces while top-level quoted values are preserved. This prevents a parent object
 * `size` from being combined with a child object's `seed_id` (or vice versa).
 */
function maskTopLevelObject(text) {
    const source = String(text || '');
    if (!source.startsWith('{')) return '';

    let depth = 0;
    let quote = '';
    let escaped = false;
    let output = '';

    for (let i = 0; i < source.length; i++) {
        const ch = source[i];
        if (quote) {
            output += depth === 1 ? ch : ' ';
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                escaped = true;
                continue;
            }
            if (ch === quote) quote = '';
            continue;
        }

        if (ch === '"' || ch === "'" || ch === '`') {
            quote = ch;
            output += depth === 1 ? ch : ' ';
            continue;
        }
        if (ch === '{' || ch === '[') {
            depth++;
            output += depth === 1 ? ch : ' ';
            continue;
        }
        if (ch === '}' || ch === ']') {
            output += depth === 1 ? ch : ' ';
            depth--;
            continue;
        }
        output += depth === 1 ? ch : ' ';
    }
    return output;
}

function uniqueNumericMatches(text, pattern) {
    const values = new Set();
    for (const match of String(text || '').matchAll(pattern)) {
        const value = Number(match[1]);
        if (Number.isFinite(value)) values.add(Math.trunc(value));
    }
    return [...values];
}

function parsePlantObjectText(text, seedId) {
    const id = normalizePositiveInt(seedId);
    const snippet = String(text || '');
    if (id <= 0 || !snippet) return null;

    const topLevel = maskTopLevelObject(snippet);
    if (!topLevel) return null;

    const seedPattern = new RegExp(`(?:["']?seed_id["']?|["']?seedId["']?)\\s*:\\s*${id}(?!\\d)`, 'i');
    if (!seedPattern.test(topLevel)) return null;

    const rawSizes = uniqueNumericMatches(topLevel, /(?:["']?size["']?)\s*:\s*(-?\d+)/gi);
    if (rawSizes.length !== 1) return null;
    const rawSize = rawSizes[0];
    const plantSize = rawSize === 2 ? 2 : (rawSize === 0 || rawSize === 1 ? 1 : 0);
    if (![1, 2].includes(plantSize)) return null;

    const names = [];
    for (const match of topLevel.matchAll(/(?:["']?name["']?)\s*:\s*["']([^"'\\]{1,80})["']/gi)) {
        const value = String(match[1] || '').trim();
        if (value && !names.includes(value)) names.push(value);
    }
    const levels = uniqueNumericMatches(
        topLevel,
        /(?:["']?land_level_need["']?|["']?landLevelNeed["']?)\s*:\s*(\d+)/gi,
    );

    return {
        seedId: id,
        plantSize,
        rawSize,
        name: names.length === 1 ? names[0] : '',
        requiredLevel: levels.length === 1 ? Math.max(0, levels[0]) : 0,
        evidence: 'qq-cache:same-direct-object-seed_id+size',
    };
}

function scanTextForSeedConfig(text, seedId) {
    const id = normalizePositiveInt(seedId);
    if (id <= 0) return [];
    const source = String(text || '');
    const token = String(id);
    const hits = [];
    let from = 0;

    while (from < source.length && hits.length < 50) {
        const index = source.indexOf(token, from);
        if (index < 0) break;
        const before = index > 0 ? source[index - 1] : '';
        const after = index + token.length < source.length ? source[index + token.length] : '';
        const standalone = !/\d/.test(before) && !/\d/.test(after);
        if (standalone) {
            for (const object of collectContainingObjectSnippets(source, index)) {
                const parsed = parsePlantObjectText(object.text, id);
                if (!parsed) continue;
                hits.push({ ...parsed, index, objectStart: object.start, objectEnd: object.end });
                break;
            }
        }
        from = index + token.length;
    }

    const unique = new Map();
    for (const hit of hits) {
        const key = `${hit.seedId}:${hit.plantSize}:${hit.rawSize}:${hit.requiredLevel}:${hit.name}`;
        if (!unique.has(key)) unique.set(key, hit);
    }
    return [...unique.values()];
}

function selectDeterministicHit(hits) {
    const list = Array.isArray(hits) ? hits : [];
    if (list.length === 0) return null;
    const signatures = new Set(list.map(hit => `${hit.seedId}:${hit.plantSize}:${hit.rawSize}`));
    if (signatures.size !== 1) return null;

    const first = list[0];
    const names = [...new Set(list.map(hit => String(hit.name || '').trim()).filter(Boolean))];
    const levels = [...new Set(list.map(hit => Math.max(0, Number(hit.requiredLevel) || 0)).filter(value => value > 0))];
    return {
        seedId: first.seedId,
        plantSize: first.plantSize,
        rawSize: first.rawSize,
        name: names.length === 1 ? names[0] : '',
        requiredLevel: levels.length === 1 ? levels[0] : 0,
        evidence: first.evidence,
        corroboratingHits: list.length,
    };
}

function cacheFilePath() {
    return getDataFile('seed_discovery/qq_cache_learned.json');
}

function readLearnedCache() {
    return readJsonFile(cacheFilePath(), () => ({ version: 1, entries: {} })) || { version: 1, entries: {} };
}

function writeLearnedCache(cache) {
    writeJsonFileAtomic(cacheFilePath(), cache);
}

function getCachedLearned(seedId) {
    const id = normalizePositiveInt(seedId);
    if (id <= 0) return null;
    const cache = readLearnedCache();
    const entry = cache.entries && cache.entries[String(id)];
    if (!entry || entry.proven !== true) return null;
    const plantSize = Number(entry.plantSize) || 0;
    if (![1, 2].includes(plantSize)) return null;
    return { ...entry, seedId: id, source: 'persisted-qq-cache' };
}

function persistLearned(seedId, result) {
    const id = normalizePositiveInt(seedId);
    if (id <= 0 || !result || ![1, 2].includes(Number(result.plantSize))) return false;
    const cache = readLearnedCache();
    const entries = cache.entries && typeof cache.entries === 'object' ? cache.entries : {};
    entries[String(id)] = {
        seedId: id,
        plantSize: Number(result.plantSize),
        rawSize: Number(result.rawSize),
        name: String(result.name || ''),
        requiredLevel: Math.max(0, Number(result.requiredLevel) || 0),
        evidence: String(result.evidence || 'qq-cache:same-direct-object-seed_id+size'),
        corroboratingHits: Math.max(1, Number(result.corroboratingHits) || 1),
        sourceFile: String(result.sourceFile || ''),
        sourceFolder: String(result.sourceFolder || ''),
        learnedAt: Date.now(),
        proven: true,
    };
    writeLearnedCache({ version: 1, updatedAt: Date.now(), entries });
    return true;
}

function learnSeedConfigFromQqCache(seedId, options = {}) {
    const id = normalizePositiveInt(seedId);
    if (id <= 0) return null;

    const cached = getCachedLearned(id);
    if (cached) return cached;
    if (process.platform !== 'win32' && options.allowNonWindows !== true) return null;

    const negativeAt = Number(negativeCache.get(id) || 0);
    if (negativeAt > 0 && Date.now() - negativeAt < NEGATIVE_TTL_MS) return null;

    const root = options.miniAppRoot || getMiniAppRoot();
    const folders = findFarmFolders(root).slice(0, 3);
    if (folders.length === 0) {
        negativeCache.set(id, Date.now());
        return null;
    }

    const allHits = [];
    let scannedFiles = 0;
    let scannedBytes = 0;

    outer:
    for (const folder of folders) {
        const files = listCandidateFiles(folder.path);
        for (const file of files) {
            if (scannedFiles >= MAX_FILES || scannedBytes + file.size > MAX_TOTAL_BYTES) break outer;
            scannedFiles++;
            scannedBytes += file.size;

            let text = '';
            try { text = fs.readFileSync(file.path, 'utf8'); } catch { continue; }
            if (!text.includes(String(id))) continue;

            const hits = scanTextForSeedConfig(text, id);
            for (const hit of hits) {
                allHits.push({
                    ...hit,
                    sourceFile: path.relative(folder.path, file.path),
                    sourceFolder: folder.name,
                });
            }
        }
    }

    const selected = selectDeterministicHit(allHits);
    if (!selected) {
        negativeCache.set(id, Date.now());
        return null;
    }

    const sourceFiles = [...new Set(allHits.map(hit => `${hit.sourceFolder}/${hit.sourceFile}`))];
    const result = {
        ...selected,
        sourceFile: sourceFiles.join(' | '),
        sourceFolder: [...new Set(allHits.map(hit => hit.sourceFolder))].join(' | '),
        scannedFiles,
        scannedBytes,
        readOnly: true,
        rpcSent: false,
        filesModified: false,
        source: 'qq-miniapp-cache',
    };
    persistLearned(id, result);
    negativeCache.delete(id);
    return result;
}

function clearSeedLearnerMemoryForTest() {
    negativeCache.clear();
}

module.exports = {
    APP_ID,
    MAX_FILE_BYTES,
    MAX_FILES,
    MAX_TOTAL_BYTES,
    NEGATIVE_TTL_MS,
    getQqexRoot,
    getMiniAppRoot,
    findFarmFolders,
    listCandidateFiles,
    collectContainingObjectSnippets,
    maskTopLevelObject,
    parsePlantObjectText,
    scanTextForSeedConfig,
    selectDeterministicHit,
    getCachedLearned,
    learnSeedConfigFromQqCache,
    clearSeedLearnerMemoryForTest,
};
