function toNumber(value) {
    const direct = Number(value);
    if (Number.isFinite(direct)) return direct;
    if (value && typeof value.toString === 'function') {
        const parsed = Number(value.toString());
        if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
}

function uniquePositiveNumbers(values) {
    const seen = new Set();
    const result = [];
    for (const value of (Array.isArray(values) ? values : [])) {
        const numeric = toNumber(value);
        if (numeric <= 0 || seen.has(numeric)) continue;
        seen.add(numeric);
        result.push(numeric);
    }
    return result;
}

function normalizeMutationEffect(effect) {
    if (!effect || typeof effect !== 'object') return null;
    const id = toNumber(effect.id);
    if (id <= 0) return null;
    return {
        id,
        name: String(effect.name || effect.effect_name || `变异${id}`).trim(),
        description: String(effect.description || '').trim(),
        tag: String(effect.tag || '').trim(),
        icon: String(effect.icon || '').trim(),
        tips: String(effect.tips || '').trim(),
        fruitName: String(effect.fruit_name || '').trim(),
    };
}

function buildMutationDetail(plant, currentPhase, resolveEffects = () => []) {
    const phaseEvents = Array.isArray(currentPhase && currentPhase.mutants)
        ? currentPhase.mutants
        : [];
    const configIds = uniquePositiveNumbers([
        ...(Array.isArray(plant && plant.mutant_config_ids) ? plant.mutant_config_ids : []),
        ...phaseEvents.map(event => event && event.mutant_config_id),
    ]);

    const resolved = typeof resolveEffects === 'function' ? resolveEffects(configIds) : [];
    const effects = (Array.isArray(resolved) ? resolved : [])
        .map(normalizeMutationEffect)
        .filter(Boolean);
    const knownIds = new Set(effects.map(effect => effect.id));
    const unknownConfigIds = configIds.filter(id => !knownIds.has(id));
    const events = phaseEvents
        .map(event => ({
            mutantTime: Math.max(0, toNumber(event && event.mutant_time)),
            configId: Math.max(0, toNumber(event && event.mutant_config_id)),
            weatherId: Math.max(0, toNumber(event && event.weather_id)),
        }))
        .filter(event => event.configId > 0 || event.mutantTime > 0 || event.weatherId > 0);

    return {
        active: configIds.length > 0 || events.length > 0,
        configIds,
        effects,
        unknownConfigIds,
        events,
    };
}

module.exports = {
    toNumber,
    uniquePositiveNumbers,
    normalizeMutationEffect,
    buildMutationDetail,
};
