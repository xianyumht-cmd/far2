const assert = require('node:assert/strict');

function getLandTypeByLevel(level) {
    const lv = Number(level) || 0;
    if (lv === 5) return 'purple';
    if (lv === 4) return 'gold';
    if (lv === 3) return 'black';
    if (lv === 2) return 'red';
    return 'normal';
}

function normalizeLandTypes(input) {
    const legacy = ['gold', 'black', 'red', 'normal'];
    const all = ['purple', ...legacy];
    const result = [];
    for (const item of (Array.isArray(input) ? input : all)) {
        const value = String(item || '').trim().toLowerCase();
        if (all.includes(value) && !result.includes(value)) result.push(value);
    }
    if (legacy.every(type => result.includes(type)) && result.length === legacy.length) result.unshift('purple');
    return result;
}

function main() {
    assert.equal(getLandTypeByLevel(5), 'purple');
    assert.equal(getLandTypeByLevel(4), 'gold');
    assert.equal(getLandTypeByLevel(3), 'black');
    assert.equal(getLandTypeByLevel(2), 'red');
    assert.equal(getLandTypeByLevel(1), 'normal');
    assert.deepEqual(normalizeLandTypes(['gold', 'black', 'red', 'normal']), ['purple', 'gold', 'black', 'red', 'normal']);
    assert.deepEqual(normalizeLandTypes(['gold', 'black']), ['gold', 'black']);

    console.log('✅ Lv5=purple / Lv4=gold mapping PASS');
    console.log('✅ legacy four-type all-selected config migrates to purple at runtime PASS');
    console.log(JSON.stringify({ ok: true, realQqTouched: false, realFarmRpcTouched: false }, null, 2));
}

try {
    main();
}
catch (error) {
    console.error('❌ Purple Land Self-Test FAIL:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
}
