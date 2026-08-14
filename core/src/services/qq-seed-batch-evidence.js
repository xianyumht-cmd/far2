const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { getItemById } = require('../config/gameConfig');
const { getDataFile } = require('../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('./json-db');
const {
    MAX_FILES,
    MAX_TOTAL_BYTES,
    getMiniAppRoot,
    findFarmFolders,
    listCandidateFiles,
    collectContainingObjectSnippets,
    maskTopLevelObject,
    scanTextForSeedConfig,
    selectDeterministicHit,
} = require('./qq-seed-config-learner');

function toPositiveInt(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    const i = Math.trunc(n);
    return i > 0 ? i : 0;
}

function normalizeSeedIds(values) {
    return [...new Set((Array.isArray(values) ? values : [])
        .map(toPositiveInt)
        .filter(Boolean))];
}

function unique(values) {
    return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function countStandaloneNumber(text, id) {
    const token = String(id);
    let count = 0;
    let from = 0;
    while (from < text.length) {
        const index = text.indexOf(token, from);
        if (index < 0) break;
        const before = index > 0 ? text[index - 1] : '';
        const after = index + token.length < text.length ? text[index + token.length] : '';
        if (!/\d/.test(before) && !/\d/.test(after)) count++;
        from = index + token.length;
    }
    return count;
}

function collectDirectSeedClues(text, seedId) {
    const id = toPositiveInt(seedId);
    if (!id) return [];
    const source = String(text || '');
    const token = String(id);
    const clues = [];
    let from = 0;

    while (from < source.length && clues.length < 50) {
        const index = source.indexOf(token, from);
        if (index < 0) break;
        const before = index > 0 ? source[index - 1] : '';
        const after = index + token.length < source.length ? source[index + token.length] : '';
        if (!/\d/.test(before) && !/\d/.test(after)) {
            for (const object of collectContainingObjectSnippets(source, index)) {
                const top = maskTopLevelObject(object.text);
                if (!top) continue;
                const seedPattern = new RegExp(`(?:["']?seed_id["']?|["']?seedId["']?)\\s*:\\s*${id}(?!\\d)`, 'i');
                if (!seedPattern.test(top)) continue;

                const names = [];
                for (const match of top.matchAll(/(?:["']?name["']?)\s*:\s*["']([^"'\\]{1,80})["']/gi)) {
                    const value = String(match[1] || '').trim();
                    if (value && !names.includes(value)) names.push(value);
                }
                const rawSizes = [];
                for (const match of top.matchAll(/(?:["']?size["']?)\s*:\s*(-?\d+)/gi)) {
                    const value = Number(match[1]);
                    if (Number.isFinite(value) && !rawSizes.includes(value)) rawSizes.push(value);
                }
                const levels = [];
                for (const match of top.matchAll(/(?:["']?land_level_need["']?|["']?landLevelNeed["']?)\s*:\s*(\d+)/gi)) {
                    const value = Number(match[1]);
                    if (Number.isFinite(value) && !levels.includes(value)) levels.push(value);
                }

                clues.push({
                    seedId: id,
                    index,
                    name: names.length === 1 ? names[0] : '',
                    names,
                    rawSizes,
                    requiredLevel: levels.length === 1 ? Math.max(0, levels[0]) : 0,
                });
                break;
            }
        }
        from = index + token.length;
    }

    const dedup = new Map();
    for (const clue of clues) {
        const key = JSON.stringify([clue.seedId, clue.name, clue.names, clue.rawSizes, clue.requiredLevel]);
        if (!dedup.has(key)) dedup.set(key, clue);
    }
    return [...dedup.values()];
}

function learnedCachePath() {
    return getDataFile('seed_discovery/qq_cache_learned.json');
}

function persistBatchLearned(entries) {
    const proven = (Array.isArray(entries) ? entries : []).filter(row => row && row.proven === true);
    if (proven.length === 0) return 0;

    const cache = readJsonFile(learnedCachePath(), () => ({ version: 1, entries: {} })) || { version: 1, entries: {} };
    const nextEntries = cache.entries && typeof cache.entries === 'object' ? cache.entries : {};
    const now = Date.now();

    for (const row of proven) {
        nextEntries[String(row.seedId)] = {
            seedId: row.seedId,
            plantSize: row.plantSize,
            rawSize: row.rawSize,
            name: String(row.name || ''),
            requiredLevel: Math.max(0, Number(row.requiredLevel) || 0),
            evidence: 'qq-cache:same-direct-object-seed_id+size',
            corroboratingHits: Math.max(1, Number(row.corroboratingHits) || 1),
            sourceFile: String(row.sourceFiles?.join(' | ') || ''),
            sourceFolder: String(row.sourceFolders?.join(' | ') || ''),
            learnedAt: now,
            proven: true,
        };
    }

    writeJsonFileAtomic(learnedCachePath(), { version: 1, updatedAt: now, entries: nextEntries });
    return proven.length;
}

function unresolvedReason({ directClues, validHits }) {
    if (!directClues.length) return 'no-direct-seed-id-object';
    const sizes = unique(directClues.flatMap(row => row.rawSizes).map(String));
    if (validHits.length === 0 && sizes.length === 0) return 'direct-seed-id-found-but-size-missing';
    if (validHits.length === 0 && sizes.length > 1) return 'direct-seed-id-found-but-size-conflicting-or-invalid';
    if (validHits.length > 0) return 'deterministic-hit-conflict-across-files';
    return 'direct-seed-id-found-but-not-proven';
}

function scanSeedEvidenceBatch(seedIds, options = {}) {
    const ids = normalizeSeedIds(seedIds);
    if (ids.length === 0) return { ok: true, entries: [], summary: { requested: 0, proven: 0, unresolved: 0 } };
    if (process.platform !== 'win32' && options.allowNonWindows !== true) {
        return {
            ok: false,
            error: 'windows-only-qq-cache-scan',
            entries: ids.map(seedId => ({ seedId, proven: false, reason: 'windows-only-qq-cache-scan' })),
            summary: { requested: ids.length, proven: 0, unresolved: ids.length },
        };
    }

    const miniAppRoot = options.miniAppRoot || getMiniAppRoot();
    const folders = findFarmFolders(miniAppRoot).slice(0, Math.max(1, Number(options.maxFolders) || 3));
    const evidence = new Map(ids.map(id => [id, {
        seedId: id,
        validHits: [],
        directClues: [],
        numericOccurrences: 0,
        filesWithNumber: new Set(),
        sourceFolders: new Set(),
    }]));

    let scannedFiles = 0;
    let filesRead = 0;
    let scannedBytes = 0;

    outer:
    for (const folder of folders) {
        for (const file of listCandidateFiles(folder.path)) {
            if (scannedFiles >= (Number(options.maxFiles) || MAX_FILES)) break outer;
            if (scannedBytes + file.size > (Number(options.maxTotalBytes) || MAX_TOTAL_BYTES)) break outer;
            scannedFiles++;
            scannedBytes += file.size;

            let text = '';
            try {
                text = fs.readFileSync(file.path, 'utf8');
                filesRead++;
            } catch {
                continue;
            }

            for (const id of ids) {
                if (!text.includes(String(id))) continue;
                const row = evidence.get(id);
                const occurrenceCount = countStandaloneNumber(text, id);
                row.numericOccurrences += occurrenceCount;
                if (occurrenceCount > 0) row.filesWithNumber.add(`${folder.name}/${path.relative(folder.path, file.path)}`);

                const validHits = scanTextForSeedConfig(text, id);
                for (const hit of validHits) {
                    row.validHits.push({
                        ...hit,
                        sourceFile: `${folder.name}/${path.relative(folder.path, file.path)}`,
                        sourceFolder: folder.name,
                    });
                }

                const clues = collectDirectSeedClues(text, id);
                for (const clue of clues) {
                    row.directClues.push({
                        ...clue,
                        sourceFile: `${folder.name}/${path.relative(folder.path, file.path)}`,
                        sourceFolder: folder.name,
                    });
                }
                if (validHits.length > 0 || clues.length > 0) row.sourceFolders.add(folder.name);
            }
        }
    }

    const readItem = typeof options.getItemById === 'function' ? options.getItemById : getItemById;
    const entries = ids.map(id => {
        const row = evidence.get(id);
        const selected = selectDeterministicHit(row.validHits);
        const clueNames = unique(row.directClues.map(hit => String(hit.name || '').trim()));
        const clueSizes = unique(row.directClues.flatMap(hit => hit.rawSizes).map(String)).map(Number);
        const itemInfo = readItem(id) || null;
        const sourceFiles = unique([
            ...row.validHits.map(hit => hit.sourceFile),
            ...row.directClues.map(hit => hit.sourceFile),
        ]);
        const base = {
            seedId: id,
            itemInfo: itemInfo ? {
                id: toPositiveInt(itemInfo.id) || id,
                name: String(itemInfo.name || ''),
                type: Number(itemInfo.type) || 0,
                interactionType: String(itemInfo.interaction_type || ''),
            } : null,
            numericOccurrences: row.numericOccurrences,
            filesWithNumber: [...row.filesWithNumber],
            directSeedIdClueCount: row.directClues.length,
            validDirectHitCount: row.validHits.length,
            clueNames,
            clueRawSizes: clueSizes,
            sourceFiles,
            sourceFolders: [...row.sourceFolders],
        };

        if (!selected) {
            return {
                ...base,
                proven: false,
                reason: unresolvedReason(row),
                name: clueNames.length === 1 ? clueNames[0] : String(itemInfo?.name || ''),
                plantSize: 0,
                rawSize: null,
            };
        }

        return {
            ...base,
            proven: true,
            reason: 'same-direct-object-seed_id+size',
            name: String(selected.name || (clueNames.length === 1 ? clueNames[0] : '') || itemInfo?.name || ''),
            plantSize: Number(selected.plantSize),
            rawSize: Number(selected.rawSize),
            requiredLevel: Math.max(0, Number(selected.requiredLevel) || 0),
            corroboratingHits: Math.max(1, Number(selected.corroboratingHits) || 1),
        };
    });

    const persisted = options.persist === false ? 0 : persistBatchLearned(entries);
    return {
        ok: true,
        generatedAt: new Date().toISOString(),
        miniAppRoot,
        folders: folders.map(row => row.name),
        scannedFiles,
        filesRead,
        scannedBytes,
        persisted,
        entries,
        summary: {
            requested: entries.length,
            proven: entries.filter(row => row.proven).length,
            unresolved: entries.filter(row => !row.proven).length,
            withDirectSeedIdClue: entries.filter(row => row.directSeedIdClueCount > 0).length,
            withAnyNumericOccurrence: entries.filter(row => row.numericOccurrences > 0).length,
        },
        safety: {
            qqCacheModified: false,
            networkTouched: false,
            rpcSent: false,
            plantWriteSent: false,
            onlyFar2LearnedCacheMayBeUpdated: options.persist !== false,
        },
    };
}

module.exports = {
    normalizeSeedIds,
    countStandaloneNumber,
    collectDirectSeedClues,
    unresolvedReason,
    persistBatchLearned,
    scanSeedEvidenceBatch,
};
