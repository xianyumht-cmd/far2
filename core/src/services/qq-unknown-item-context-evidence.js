const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const {
    MAX_FILES,
    MAX_TOTAL_BYTES,
    getMiniAppRoot,
    findFarmFolders,
    listCandidateFiles,
} = require('./qq-seed-config-learner');

const DEFAULT_CONTEXT_CHARS = 360;
const DEFAULT_MAX_CONTEXTS_PER_ID = 16;

function toPositiveInt(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    const i = Math.trunc(n);
    return i > 0 ? i : 0;
}

function unique(values) {
    return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function standaloneIndices(text, targetId, limit = 80) {
    const source = String(text || '');
    const token = String(toPositiveInt(targetId));
    if (!token || token === '0') return [];
    const out = [];
    let from = 0;
    while (from < source.length && out.length < Math.max(1, Number(limit) || 80)) {
        const index = source.indexOf(token, from);
        if (index < 0) break;
        const before = index > 0 ? source[index - 1] : '';
        const after = index + token.length < source.length ? source[index + token.length] : '';
        if (!/\d/.test(before) && !/\d/.test(after)) out.push(index);
        from = index + token.length;
    }
    return out;
}

function sanitizeContext(text) {
    return String(text || '')
        .replace(/https?:\/\/[^\s"'`]+/gi, '<url>')
        .replace(/\b[A-Fa-f0-9]{40,}\b/g, '<long-hex>')
        .replace(/\b[A-Za-z0-9+/_=-]{64,}\b/g, '<long-token>')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function nearbyKeys(text) {
    const keys = [];
    for (const match of String(text || '').matchAll(/["']?([A-Za-z_$][\w$]{1,48})["']?\s*:/g)) {
        const key = String(match[1] || '').trim();
        if (key && !keys.includes(key)) keys.push(key);
        if (keys.length >= 24) break;
    }
    return keys;
}

function nearbyStrings(text) {
    const values = [];
    for (const match of String(text || '').matchAll(/["']([^"'\\\r\n]{2,80})["']/g)) {
        const value = sanitizeContext(match[1]);
        if (!value || value.startsWith('<url>') || value.length > 80) continue;
        if (!values.includes(value)) values.push(value);
        if (values.length >= 24) break;
    }
    return values;
}

function evidenceKeywords(text) {
    const source = String(text || '');
    const patterns = [
        ['seed', /\bseed(?:_id|Id|s)?\b|种子/iu],
        ['plant', /\bplant(?:_id|Id|s|ing)?\b|作物|种植/iu],
        ['item', /\bitem(?:_id|Id|s)?\b|道具|物品/iu],
        ['reward', /\breward(?:_id|Id|s)?\b|奖励/iu],
        ['activity', /\bactivity\b|活动/iu],
        ['exchange', /\bexchange\b|兑换/iu],
        ['shop', /\bshop\b|商店/iu],
        ['draw', /\bdraw\b|抽奖|抽取/iu],
        ['fruit', /\bfruit\b|果实/iu],
        ['fertilizer', /\bfertilizer\b|化肥/iu],
        ['bag', /\bbag\b|背包/iu],
        ['gift', /\bgift\b|礼包/iu],
        ['task', /\btask\b|任务/iu],
    ];
    return patterns.filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
}

function contextSignature(context, targetId) {
    const normalized = String(context || '').replace(new RegExp(`\\b${toPositiveInt(targetId)}\\b`, 'g'), '<ID>');
    return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}

function collectOccurrenceContext(text, targetId, index, options = {}) {
    const source = String(text || '');
    const radius = Math.max(120, Number(options.contextChars) || DEFAULT_CONTEXT_CHARS);
    const start = Math.max(0, index - radius);
    const end = Math.min(source.length, index + String(targetId).length + radius);
    const raw = source.slice(start, end);
    const context = sanitizeContext(raw);
    return {
        offset: index,
        context,
        contextHash: contextSignature(context, targetId),
        nearbyKeys: nearbyKeys(raw),
        nearbyStrings: nearbyStrings(raw),
        keywords: evidenceKeywords(raw),
    };
}

function scanUnknownItemContexts(itemIds, options = {}) {
    const ids = unique((Array.isArray(itemIds) ? itemIds : []).map(toPositiveInt).filter(Boolean));
    if (ids.length === 0) return { ok: true, entries: [], summary: { requested: 0 } };
    if (process.platform !== 'win32' && options.allowNonWindows !== true) {
        return { ok: false, error: 'windows-only-qq-cache-scan', entries: [] };
    }

    const miniAppRoot = options.miniAppRoot || getMiniAppRoot();
    const folders = findFarmFolders(miniAppRoot).slice(0, Math.max(1, Number(options.maxFolders) || 3));
    const evidence = new Map(ids.map(id => [id, {
        occurrenceCount: 0,
        contexts: new Map(),
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
                const indices = standaloneIndices(text, id, Number(options.maxOccurrencesPerFile) || 80);
                row.occurrenceCount += indices.length;
                for (const index of indices) {
                    const found = collectOccurrenceContext(text, id, index, options);
                    const sourceFile = `${folder.name}/${path.relative(folder.path, file.path)}`;
                    const current = row.contexts.get(found.contextHash);
                    if (current) {
                        if (!current.sourceFiles.includes(sourceFile)) current.sourceFiles.push(sourceFile);
                        current.duplicateCount += 1;
                        continue;
                    }
                    if (row.contexts.size >= (Number(options.maxContextsPerId) || DEFAULT_MAX_CONTEXTS_PER_ID)) continue;
                    row.contexts.set(found.contextHash, {
                        ...found,
                        sourceFiles: [sourceFile],
                        duplicateCount: 1,
                    });
                }
            }
        }
    }

    const entries = ids.map(itemId => {
        const row = evidence.get(itemId);
        const contexts = [...row.contexts.values()];
        return {
            itemId,
            occurrenceCount: row.occurrenceCount,
            uniqueContextCount: contexts.length,
            contexts,
            aggregateKeywords: unique(contexts.flatMap(ctx => ctx.keywords)),
            aggregateKeys: unique(contexts.flatMap(ctx => ctx.nearbyKeys)).slice(0, 48),
            aggregateStrings: unique(contexts.flatMap(ctx => ctx.nearbyStrings)).slice(0, 48),
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
            withOccurrences: entries.filter(row => row.occurrenceCount > 0).length,
            totalOccurrences: entries.reduce((sum, row) => sum + row.occurrenceCount, 0),
            uniqueContexts: entries.reduce((sum, row) => sum + row.uniqueContextCount, 0),
        },
        safety: {
            qqCacheModified: false,
            far2DataModified: false,
            networkTouched: false,
            rpcSent: false,
            plantWriteSent: false,
            identityPromotedFromContext: false,
        },
    };
}

module.exports = {
    standaloneIndices,
    sanitizeContext,
    nearbyKeys,
    nearbyStrings,
    evidenceKeywords,
    contextSignature,
    collectOccurrenceContext,
    scanUnknownItemContexts,
};
