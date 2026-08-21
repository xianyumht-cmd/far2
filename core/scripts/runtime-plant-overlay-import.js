const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    buildRuntimePlantOverlay,
    persistRuntimePlantOverlay,
} = require('../src/services/runtime-plant-overlay-evidence');

function candidateReports() {
    const args = process.argv.slice(2).filter(Boolean);
    const out = [...args];
    if (process.platform === 'win32') out.push('D:\\download\\runtime-plant-overlay-latest.json');
    out.push(path.join(os.tmpdir(), 'FAR2-RUNTIME-PLANT-OVERLAY', 'runtime-plant-overlay-latest.json'));

    const tempDir = path.join(os.tmpdir(), 'FAR2-RUNTIME-PLANT-OVERLAY');
    try {
        const latest = fs.readdirSync(tempDir, { withFileTypes: true })
            .filter(entry => entry.isFile() && /^runtime-plant-overlay-.*\.json$/.test(entry.name))
            .map(entry => {
                const full = path.join(tempDir, entry.name);
                return { full, mtimeMs: fs.statSync(full).mtimeMs };
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
        if (latest) out.push(latest.full);
    } catch {}

    return [...new Set(out.map(file => path.resolve(file)))];
}

function findReport() {
    for (const file of candidateReports()) {
        try {
            if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
        } catch {}
    }
    return '';
}

function main() {
    const reportFile = findReport();
    if (!reportFile) throw new Error('未找到 runtime-plant-overlay 报告；可把 JSON 路径作为第一个参数传入。');

    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    const overlay = buildRuntimePlantOverlay(report);
    const target = persistRuntimePlantOverlay(overlay);

    console.log('FAR2 Runtime Plant Overlay Import');
    console.log(`报告: ${reportFile}`);
    console.log(`输出: ${target}`);
    console.log(`标尺: 1x1=${overlay.calibration.oneByOne.references}, 2x2=${overlay.calibration.twoByTwo.references}`);
    console.log(`解析: ${overlay.summary.resolved}/${overlay.summary.targets}`);
    console.log(`1x1=${overlay.summary.size1}, 2x2=${overlay.summary.size2}, unresolved=${overlay.summary.unresolved}`);
    console.log(`映射纠正: ${overlay.summary.mappingCorrections}`);
    for (const row of overlay.corrections) {
        console.log(`  fruit ${row.fruitId}: candidate seed ${row.previousCandidateSeedId} -> actual seed ${row.actualSeedId} (${row.name})`);
    }

    const focus = new Set([20264, 21037, 21050, 21221, 21251, 26032, 29003]);
    console.log('\n重点作物:');
    for (const row of overlay.entries.filter(entry => focus.has(entry.seedId) || focus.has(entry.candidateSeedId))) {
        console.log(`${row.seedId} -> ${row.fruitId} ${row.name} size=${row.size} grid=${row.gridCount} exp=${row.exp}`);
    }

    if (overlay.summary.unresolved > 0) {
        console.log('\n未解析项:');
        for (const row of overlay.unresolved) console.log(`${row.candidateSeedId}/${row.fruitId}: ${row.reason}`);
        process.exitCode = 2;
    }
}

try {
    main();
} catch (error) {
    console.error(`Runtime Plant Overlay Import FAIL: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
}
