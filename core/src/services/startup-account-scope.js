function normalizeText(value) {
    return String(value == null ? '' : value).trim();
}

function normalizeUin(value) {
    const text = normalizeText(value);
    return /^\d{5,12}$/.test(text) ? text : '';
}

function readProviderTargetsRaw(processRef) {
    const env = (processRef && processRef.env) || {};
    const raw = normalizeText(env.FARM_CODE_PROVIDER_TARGETS);
    if (raw) {
        return { configured: true, raw, source: 'json' };
    }

    const encoded = normalizeText(env.FARM_CODE_PROVIDER_TARGETS_B64);
    if (!encoded) {
        return { configured: false, raw: '', source: '' };
    }

    try {
        return {
            configured: true,
            raw: Buffer.from(encoded, 'base64').toString('utf8').trim(),
            source: 'base64',
        };
    }
    catch {
        return { configured: true, raw: '', source: 'base64' };
    }
}

function readProviderTargetUins(processRef) {
    const source = readProviderTargetsRaw(processRef);
    if (!source.configured) {
        return { configured: false, valid: true, uins: [], source: '', error: '' };
    }
    if (!source.raw) {
        return { configured: true, valid: false, uins: [], source: source.source, error: 'provider_targets_empty' };
    }

    let parsed;
    try {
        parsed = JSON.parse(source.raw);
    }
    catch {
        return { configured: true, valid: false, uins: [], source: source.source, error: 'provider_targets_json_invalid' };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { configured: true, valid: false, uins: [], source: source.source, error: 'provider_targets_json_invalid' };
    }

    const uins = [];
    for (const rawUin of Object.keys(parsed)) {
        const uin = normalizeUin(rawUin);
        if (!uin) {
            return { configured: true, valid: false, uins: [], source: source.source, error: 'provider_target_uin_invalid' };
        }
        if (!uins.includes(uin)) uins.push(uin);
    }

    if (uins.length === 0) {
        return { configured: true, valid: false, uins: [], source: source.source, error: 'provider_targets_empty' };
    }

    return { configured: true, valid: true, uins, source: source.source, error: '' };
}

function readExplicitAccountRefs(processRef) {
    const env = (processRef && processRef.env) || {};
    const raw = normalizeText(env.FARM_AUTO_START_ACCOUNT_REFS);
    if (!raw) return [];
    return [...new Set(raw.split(/[\s,;]+/).map(normalizeText).filter(Boolean))];
}

function getAccountRefs(account) {
    const refs = [
        normalizeText(account && account.id),
        normalizeUin(account && account.uin),
        normalizeUin(account && account.qq),
    ].filter(Boolean);
    return [...new Set(refs)];
}

function filterAccountsByRefs(accounts, refs) {
    const wanted = new Set((refs || []).map(normalizeText).filter(Boolean));
    if (wanted.size === 0) return [];
    return (accounts || []).filter(account => getAccountRefs(account).some(ref => wanted.has(ref)));
}

function resolveStartupAccountScope(accounts, processRef = process) {
    const allAccounts = Array.isArray(accounts) ? accounts : [];
    const explicitRefs = readExplicitAccountRefs(processRef);
    if (explicitRefs.length > 0) {
        return {
            accounts: filterAccountsByRefs(allAccounts, explicitRefs),
            mode: 'explicit_refs',
            configuredRefs: explicitRefs,
            providerTargetUins: [],
            failClosed: false,
            error: '',
        };
    }

    const providerTargets = readProviderTargetUins(processRef);
    if (!providerTargets.configured) {
        return {
            accounts: allAccounts,
            mode: 'all_saved',
            configuredRefs: [],
            providerTargetUins: [],
            failClosed: false,
            error: '',
        };
    }

    if (!providerTargets.valid) {
        return {
            accounts: [],
            mode: 'provider_targets_invalid',
            configuredRefs: [],
            providerTargetUins: [],
            failClosed: true,
            error: providerTargets.error,
        };
    }

    const matched = allAccounts.filter((account) => {
        const uin = normalizeUin(account && (account.uin || account.qq));
        return !!uin && providerTargets.uins.includes(uin);
    });

    return {
        accounts: matched,
        mode: 'provider_targets',
        configuredRefs: [],
        providerTargetUins: providerTargets.uins,
        failClosed: false,
        error: '',
    };
}

module.exports = {
    normalizeUin,
    readProviderTargetsRaw,
    readProviderTargetUins,
    readExplicitAccountRefs,
    resolveStartupAccountScope,
};
