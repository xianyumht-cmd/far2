const base = require('./activity-readonly-base');

const DEEP_DISCOVERY_FALLBACK_REASON = 'deep-discovery-failed';

async function listActivityOverview(options = {}) {
    try {
        const { discoverActivityOverview } = require('./activity-discovery-service');
        return await discoverActivityOverview(options);
    } catch (error) {
        // Preserve the previously accepted List-only contract when deep discovery fails.
        const fallback = await base.listActivityOverview();
        return {
            ...fallback,
            discovery: null,
            groups: [],
            deepSummary: null,
            groupSummary: { requested: 0, loaded: 0, failed: 0 },
            discoveryError: String(error && error.message ? error.message : error),
            framework: {
                ...(fallback.framework || {}),
                deepDiscovery: false,
                deepDiscoveryFallback: true,
                fallbackReason: DEEP_DISCOVERY_FALLBACK_REASON,
                readOnly: true,
                autoOperateEnabled: false,
            },
        };
    }
}

module.exports = {
    ...base,
    listActivityOverview,
    listActivityOverviewBase: base.listActivityOverview,
    DEEP_DISCOVERY_FALLBACK_REASON,
};
