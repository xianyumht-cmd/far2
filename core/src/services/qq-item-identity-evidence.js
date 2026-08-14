const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { getItemById } = require('../config/gameConfig');
const {
    MAX_FILES,
    MAX_TOTAL_BYTES,
    getMiniAppRoot,
    findFarmFolders,
    listCandidateFiles,
    collectContainingObjectSnippets,
    maskTopLevelObject,
} = require('./qq-seed-config-learner');

function toPositiveInt(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    const i = Math.trunc(n);
    return i > 0 ? i : 0;
}

function unique(values) {
    return [...new Set((Array.isArray(values) ? values : []).filter(value => value !== '' && value !== null && value !== undefined))];
}

function directStringValues(text, fieldNames) {
    const names = fieldNames.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const pattern = new RegExp(`(?:["']?(?:${names})["']?)\\s*:\\s*["']([^"'\\\\]{1,120})["']`, 'gi');
    return unique([...String(text || '').matchAll(pattern)].map(match => String(match[1] || '').trim()));
}

function directNumericValues(text, fieldNames) {
    const names = fieldNames.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const pattern = new RegExp(`(?:["']?(?:${names})["']?)\\s*:\\s*(-?\\d+)`, 'gi');
    return unique([...String(text || '').matchAll(pattern)].map(match => Number(match[1])).filter(Number.isFinite));
}

function collectDirectItemClues(text, targetId) {
    const id = toPositiveInt(targetId);
    if (!id) return [];
    const source = String(text || '');
    const token = String(id);
    const clues = [];
    let from = 0;

    while (from < source.length && clues.length < 80) {
        const index = source.indexOf(token, from);
        if (index < 0) break;
        const before = index > 0 ? source[index - 1] : '';
        const after = index + token.length < source.length ? source[index + token.length] : '';
        if (!/\d/.test(before) && !/\d/.test(after)) {
            for (const object of collectContainingObjectSnippets(source, index)) {
                const top = maskTopLevelObject(object.text);
                if (!top) continue;

                const idPattern = new RegExp(`(?:["']?(?:id|item_id|itemId)["']?)\\s*:\\s*${id}(?!\\d)`, 'i');
                if (!idPattern.test(top)) continue;

                const names = directStringValues(top, ['name', 'item_name', 'itemName']);
                const types = directNumericValues(top, ['type', 'item_type', 'itemType']);
                const interactions = directStringValues(top, ['interaction_type', 'interactionType', 'interaction']);

                clues.push({
                    targetId: id,
                    index,
                    names,
                    types,
                    interactions,
                });
                break;
            }
        }
        from = index + token.length;
    }

    const dedup = new Map();
    for (const clue of clues) {
        const key = JSON.stringify([clue.targetId, clue.names, clue.types, clue.interactions]);
        if (!dedup.has(key)) dedup.set(key, clue);
    }
    return [...dedup.values()];
}

function seedSignalsFromFields({ names = [], types = [], interactions = [] } = {}) {
    const nameSeed = names.some(name => /种子/u.test(String(name || '')));
    const typeSeed = types.some(type => Number(type) === 5);
    const interactionSeed = interactions.some(value => String(value || '').trim().toLowerCase() === 'plant');
    return {
        nameSeed,
        typeSeed,
        interactionSeed,
        score: [nameSeed, typeSeed, interactionSeed].filter(Boolean).length,
    };
}

function staticItemEvidence(itemInfo) {
    if (!itemInfo || typeof itemInfo !== 'object') return null;
    const names = [String(itemInfo.name || '').trim()].filter(Boolean);
    const types = Number.isFinite(Number(itemInfo.type)) ? [Number(itemInfo.type)] : [];
    const interactions = [String(itemInfo.interaction_type || itemInfo.interactionType || '').trim()].filter(Boolean);
    const signals = seedSignalsFromFields({ names, types, interactions });
    return {
        id: toPositiveInt(itemInfo.id),
        names,
        types,
        interactions,
        signals,
        source: 'static-item-config',
    };
}

function classifyIdentity(itemInfo, directClues = []) {
    const staticEvidence = staticItemEvidence(itemInfo);
    if (staticEvidence && staticEvidence.signals.score >= 2) {
        return {
            classification: 'known-seed',
            confidence: 'high',
            reason: 'static-item-seed-signals',
            name: staticEvidence.names.length === 1 ? staticEvidence.names[0] : '',
            evidence: staticEvidence,
        };
    }

    const cacheEvidence = directClues.map(clue => ({
        ...clue,
        signals: seedSignalsFromFields(clue),
    }));
    const seedProofs = cacheEvidence.filter(clue => clue.signals.score >= 2);
    if (seedProofs.length > 0) {
        const names = unique(seedProofs.flatMap(clue => clue.names));
        return {
            classification: 'known-seed',
            confidence: 'high',
            reason: 'qq-cache-direct-item-seed-signals',
            name: names.length === 1 ? names[0] : '',
            evidence: seedProofs,
        };
    }

    const candidates = cacheEvidence.filter(clue => clue.signals.score === 1);
    if (candidates.length > 0) {
        const names = unique(candidates.flatMap(clue => clue.names));
        return {
            classification: 'seed-candidate',
            confidence: 'medium',
            reason: 'single-seed-signal-only',
            name: names.length === 1 ? names[0] : '',
            evidence: candidates,
        };
    }

    const explicitNonPlant = cacheEvidence.filter(clue => {
        const hasTypedIdentity = clue.names.length > 0 && clue.types.length > 0 && clue.interactions.length > 0;
        if (!hasTypedIdentity) return false;
        const interactionPlant = clue.interactions.some(value => String(value || '').trim().toLowerCase() === 'plant');
        const typeSeed = clue.types.some(type => Number(type) === 5);
        const nameSeed = clue.names.some(name => /种子/u.test(String(name || '')));
        return !interactionPlant && !typeSeed && !nameSeed;
    });
    if (explicitNonPlant.length > 0) {
        const names = unique(explicitNonPlant.flatMap(clue => clue.names));
        return {
            classification: 'non-seed',
            confidence: 'high',
            reason: 'qq-cache-direct-item-non-seed-signals',
            name: names.length === 1 ? names[0] : '',
            evidence: explicitNonPlant,
        };
    }

    if (staticEvidence && staticEvidence.names.length > 0) {
        return {
            classification: staticEvidence.signals.score === 1 ? 'seed-candidate' : 'unknown',
            confidence: staticEvidence.signals.score === 1 ? 'medium' : 'low',
            reason: staticEvidence.signals.score === 1 ? 'static-single-seed-signal-only' : 'static-item-insufficient-signals',
            name: staticEvidence.names[0],
            evidence: staticEvidence,
        };
    }

    return {
        classification: 'unknown',
        confidence: 'low',
        reason: directClues.length > 0 ? 'direct-item-object-found-but-no-seed-signals' : 'no-direct-item-object',
        name: '',
        evidence: directClues,
    };
}

function scanItemIdentityBatch(itemIds, options = {}) {
    const ids = unique((Array.isArray(itemIds) ? itemIds : []).map(toPositiveInt).filter(Boolean));
    if (ids.length === 0) return { ok: true, entries: [], summary: { requested: 0 } };
    if (process.platform !== 'win32' && options.allowNonWindows !== true) {
        return { ok: false, error: 'windows-only-qq-cache-scan', entries: [] };
    }

    const miniAppRoot = options.miniAppRoot || getMiniAppRoot();
    const folders = findFarmFolders(miniAppRoot).slice(0, Math.max(1, Number(options.maxFolders) || 3));
    const evidence = new Map(ids.map(id => [id, { clues: [], files: new Set(), occurrences: 0 }]));
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
                const token = String(id);
                if (!text.includes(token)) continue;
                const row = evidence.get(id);
                row.occurrences += text.split(token).length - 1;
                const clues = collectDirectItemClues(text, id);
                if (clues.length > 0) row.files.add(`${folder.name}/${path.relative(folder.path, file.path)}`);
                for (const clue of clues) {
                    row.clues.push({
                        ...clue,
                        sourceFile: `${folder.name}/${path.relative(folder.path, file.path)}`,
                    });
                }
            }
        }
    }

    const readItem = typeof options.getItemById === 'function' ? options.getItemById : getItemById;
    const entries = ids.map(id => {
        const row = evidence.get(id);
        const itemInfo = readItem(id) || null;
        const identity = classifyIdentity(itemInfo, row.clues);
        return {
            itemId: id,
            itemInfo: itemInfo ? {
                id: toPositiveInt(itemInfo.id) || id,
                name: String(itemInfo.name || ''),
                type: Number(itemInfo.type) || 0,
                interactionType: String(itemInfo.interaction_type || itemInfo.interactionType || ''),
            } : null,
            directItemClueCount: row.clues.length,
            numericOccurrences: row.occurrences,
            sourceFiles: [...row.files],
            classification: identity.classification,
            confidence: identity.confidence,
            reason: identity.reason,
            name: identity.name,
            evidence: identity.evidence,
        };
    });

    return {
        ok: true,
        generatedAt: new Date().toISOString(),
        miniAppRoot,
        folders: folders.map(row => row.name),
        scannedFiles,
        filesRead,
        scannedBytes,
        entries,
        summary: {
            requested: entries.length,
            knownSeed: entries.filter(row => row.classification === 'known-seed').length,
            seedCandidate: entries.filter(row => row.classification === 'seed-candidate').length,
            nonSeed: entries.filter(row => row.classification === 'non-seed').length,
            unknown: entries.filter(row => row.classification === 'unknown').length,
        },
        safety: {
            qqCacheModified: false,
            far2DataModified: false,
            networkTouched: false,
            rpcSent: false,
            plantWriteSent: false,
        },
    };
}

module.exports = {
    directStringValues,
    directNumericValues,
    collectDirectItemClues,
    seedSignalsFromFields,
    classifyIdentity,
    scanItemIdentityBatch,
};
