const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getDataDir } = require('../src/config/runtime-paths');
const { scanFarmCache, DEFAULT_TARGETS } = require('./qq-static-plant-overlay-scan');

function toPositiveInt(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function uniquePositive(values) {
    return [...new Set((Array.isArray(values) ? values : []).map(toPositiveInt).filter(Boolean))];
}

function listRegistryFiles(dataDir = getDataDir()) {
    const dir = path.join(dataDir, 'crop_registry');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
        .map((entry) => {
            const full = path.join(dir, entry.name);
            let stat = null;
            try { stat = fs.statSync(full); } catch {}
            return { path: full, name: entry.name, mtimeMs: stat ? stat.mtimeMs || 0 : 0 };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
}

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function selectUnresolvedFootprintTargets(snapshot) {
    const crops = Array.isArray(snapshot && snapshot.crops) ? snapshot.crops : [];
    return uniquePositive(crops
        .filter(crop => crop && toPositiveInt(crop.seedId) > 0)
        .filter(crop => toPositiveInt(crop.size) <= 0)
        .filter(crop => crop.identityConfidence !== 'unknown')
        .map(crop => crop.seedId));
}

function resolveTargets(options = {}) {
    const explicit = uniquePositive(options.targets);
    if (explicit.length) {
        return { targets: explicit, source: 'explicit', registryFile: '' };
    }

    for (const file of listRegistryFiles(options.dataDir || getDataDir())) {
        const snapshot = readJson(file.path);
        const targets = selectUnresolvedFootprintTargets(snapshot);
        if (targets.length) {
            return { targets, source: 'latest-registry', registryFile: file.path };
        }
    }

    return { targets: [...DEFAULT_TARGETS], source: 'fallback-defaults', registryFile: '' };
}

function writeReport(report, options = {}) {
    const dir = options.outputDir || path.join(os.tmpdir(), 'FAR2-STATIC-PLANT-OVERLAY');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(dir, `static-plant-overlay-auto-${stamp}.json`);
    fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return target;
}

function runAutoScan(options = {}) {
    const resolved = resolveTargets(options);
    const scan = scanFarmCache({
        ...options,
        targets: resolved.targets,
    });
    const report = {
        ...scan,
        targetResolution: {
            source: resolved.source,
            registryFile: resolved.registryFile,
            targetCount: resolved.targets.length,
        },
    };
    const reportPath = writeReport(report, options);
    return { report, reportPath };
}

function main() {
    const { report, reportPath } = runAutoScan();
    console.log('FAR2 QQ Static Plant Overlay Auto Scan');
    console.log(`目标来源: ${report.targetResolution.source}`);
    if (report.targetResolution.registryFile) console.log(`Registry: ${report.targetResolution.registryFile}`);
    console.log(`待补 footprint: ${report.targetResolution.targetCount}`);
    console.log(`扫描文件: ${report.summary.scannedFiles}, bytes=${report.summary.scannedBytes}`);
    console.log(`直接 footprint 证明: ${report.summary.proven}/${report.entries.length}`);
    for (const row of report.entries) {
        const verdict = row.proven
            ? `${row.plantSize}x${row.plantSize} rawSize=${row.rawSize}${row.name ? ` name=${row.name}` : ''}`
            : row.reason;
        console.log(`${row.seedId} -> fruit ${row.fruitId}: ${verdict}`);
    }
    console.log(`报告: ${reportPath}`);
}

if (require.main === module) {
    try { main(); }
    catch (error) {
        console.error(`Static Plant Overlay Auto Scan FAIL: ${error && error.stack ? error.stack : error}`);
        process.exitCode = 1;
    }
}

module.exports = {
    listRegistryFiles,
    selectUnresolvedFootprintTargets,
    resolveTargets,
    writeReport,
    runAutoScan,
};
