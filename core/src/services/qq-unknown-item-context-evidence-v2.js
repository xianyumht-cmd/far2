const base = require('./qq-unknown-item-context-evidence');

function unique(values) {
    return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

// This layer is clue-only. QQ's minified bundles frequently use camelCase identifiers
// such as activitySeedIds / rewardTable / exchangeCost, so word-boundary matching is
// intentionally too strict here. These keywords never promote item identity by themselves.
function evidenceKeywords(text) {
    const source = String(text || '');
    const patterns = [
        ['seed', /seed|种子/iu],
        ['plant', /plant|作物|种植/iu],
        ['item', /item|道具|物品/iu],
        ['reward', /reward|奖励/iu],
        ['activity', /activity|活动/iu],
        ['exchange', /exchange|兑换/iu],
        ['shop', /shop|商店/iu],
        ['draw', /draw|抽奖|抽取/iu],
        ['fruit', /fruit|果实/iu],
        ['fertilizer', /fertilizer|化肥/iu],
        ['bag', /bag|背包/iu],
        ['gift', /gift|礼包/iu],
        ['task', /task|任务/iu],
    ];
    return patterns.filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
}

function scanUnknownItemContexts(itemIds, options = {}) {
    const result = base.scanUnknownItemContexts(itemIds, options);
    if (!result || result.ok !== true) return result;

    const entries = (Array.isArray(result.entries) ? result.entries : []).map(row => {
        const contexts = (Array.isArray(row.contexts) ? row.contexts : []).map(ctx => ({
            ...ctx,
            keywords: evidenceKeywords(ctx.context),
        }));
        return {
            ...row,
            contexts,
            aggregateKeywords: unique(contexts.flatMap(ctx => ctx.keywords)),
        };
    });

    return {
        ...result,
        entries,
    };
}

module.exports = {
    ...base,
    evidenceKeywords,
    scanUnknownItemContexts,
};
