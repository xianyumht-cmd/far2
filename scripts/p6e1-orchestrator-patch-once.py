from pathlib import Path

farm_path = Path('core/src/services/farm.js')
core_pkg_path = Path('core/package.json')
root_pkg_path = Path('package.json')

text = farm_path.read_text(encoding='utf-8')

def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one anchor, found {count}')
    return source.replace(old, new, 1)

text = replace_once(
    text,
    "const { getPlantNameBySeedId, getPlantName, getPlantExp, getPlantGrowTime, getAllSeeds, getPlantById, getSeedImageBySeedId, getMutantEffectsByIds } = require('../config/gameConfig');\n",
    "const { getPlantNameBySeedId, getPlantName, getPlantGrowTime, getAllSeeds, getPlantById, getSeedImageBySeedId, getMutantEffectsByIds } = require('../config/gameConfig');\n",
    'gameConfig import',
)
text = replace_once(
    text,
    "const { isAutomationOn, getAutomation, getPlantingStrategy, getPrioritize2x2Crops, getBagSeedPriority, getBagSeedFallbackStrategy, getFertilizerBuyOrganicCount, getFertilizerBuyOrganicThresholdHours, getFertilizerBuyNormalCount, getFertilizerBuyNormalThresholdHours, getFertilizerBuyCheckIntervalMinutes } = require('../models/store');\n",
    "const { isAutomationOn, getFertilizerBuyOrganicCount, getFertilizerBuyOrganicThresholdHours, getFertilizerBuyNormalCount, getFertilizerBuyNormalThresholdHours, getFertilizerBuyCheckIntervalMinutes } = require('../models/store');\n",
    'store import',
)
text = replace_once(
    text,
    "const { toLong, toNum, getServerTimeSec, toTimeSec, log, logWarn, sleep, randomDelay } = require('../utils/utils');\n",
    "const { toNum, getServerTimeSec, toTimeSec, log, logWarn } = require('../utils/utils');\n",
    'utils import',
)
text = replace_once(text, "const { recordOperation } = require('./stats');\n", '', 'stats import')
text = replace_once(
    text,
    "const { getBagSeeds, getBag, getBagItems, getContainerHoursFromBagItems } = require('./warehouse');\n",
    "const { getBag, getBagItems, getContainerHoursFromBagItems } = require('./warehouse');\n",
    'warehouse import',
)
text = replace_once(text, "const { runPrioritized2x2Prepass } = require('./farm-2x2-priority');\n", '', '2x2 prepass import')
text = replace_once(
    text,
    "    summarizeLandDetails,\n    getLandTypeByLevel,\n    getCurrentPhase,\n    buildLandMap,\n    classifyHarvestedLandsByMap,\n",
    "    summarizeLandDetails,\n    getCurrentPhase,\n    buildLandMap,\n",
    'analyzer import',
)
text = replace_once(
    text,
    "    getAllLandsRaw,\n    harvest,\n    waterLand,\n    weedOut,\n    insecticide,\n    removePlant,\n    upgradeLand,\n    unlockLand,\n    getShopInfo,\n",
    "    getAllLandsRaw,\n    getShopInfo,\n",
    'farm api import',
)
text = replace_once(
    text,
    "const { createPlantingService, getPlantingStrategyLabel } = require('./planting-service');\n",
    "const { createPlantingService } = require('./planting-service');\nconst { createFarmOrchestrator } = require('./farm-orchestrator');\n",
    'planting/orchestrator import',
)
text = replace_once(text, "let isCheckingFarm = false;\nlet isFirstFarmCheck = true;\n", '', 'orchestrator state')

planting_anchor = """const {
    plant2x2Seed,
    plantFromBagSeeds,
    plantFromShop,
} = createPlantingService({
    // 背包 2x2 探测必须继续经过 facade wrapper，保持 operation-limit callback 语义。
    getAllLands,
});

"""
orchestrator_instance = """const {
    checkFarm,
    runFarmOperation,
    isChecking: isFarmCheckInProgress,
} = createFarmOrchestrator({
    // 所有补拉继续通过 facade wrapper，保持 operation-limit callback 语义。
    getAllLands,
    runFertilizerByConfig,
    plant2x2Seed,
    plantFromBagSeeds,
    plantFromShop,
});

"""
text = replace_once(text, planting_anchor, planting_anchor + orchestrator_instance, 'planting instance')

start = text.find('async function autoPlantEmptyLands(deadLandIds, emptyLandIds) {')
end = text.find('function scheduleNextFarmCheck(', start + 1)
if start < 0 or end < 0:
    raise SystemExit(f'orchestrator block anchors missing: start={start}, end={end}')
text = text[:start] + '// ============ 巡田业务编排：由 farm-orchestrator.js 提供 ============\n\n' + text[end:]

text = text.replace('if (isCheckingFarm) return;', 'if (isFarmCheckInProgress()) return;')
text = text.replace('if (!isCheckingFarm) await checkFarm();', 'if (!isFarmCheckInProgress()) await checkFarm();')

for removed in [
    'async function autoPlantEmptyLands(',
    'function analyzeLands(',
    'async function resolveRemovableHarvestedLands(',
    'async function runFarmOperation(',
    'async function checkFarm(',
]:
    if removed in text:
        raise SystemExit(f'old orchestrator implementation still present: {removed}')

for required in [
    'function scheduleNextFarmCheck(',
    'function startFarmCheckLoop(',
    'function onLandsChangedPush(',
    'function stopFarmCheckLoop(',
    'function startFertilizerBuyCheckTimer(',
    'async function checkFertilizerBuyOnce(',
    'getLandsDetail,',
    'getAvailableSeeds,',
    'runFarmOperation,',
]:
    if required not in text:
        raise SystemExit(f'facade/scheduler anchor lost: {required}')

if text.count('isFarmCheckInProgress()') != 2:
    raise SystemExit(f'expected two scheduler busy checks, found {text.count("isFarmCheckInProgress()")}')

farm_path.write_text(text, encoding='utf-8')

for pkg_path in [core_pkg_path, root_pkg_path]:
    pkg = pkg_path.read_text(encoding='utf-8')
    anchor = '    "planting:service-selftest": '
    idx = pkg.find(anchor)
    if idx < 0:
        raise SystemExit(f'{pkg_path}: planting selftest anchor missing')
    line_end = pkg.find('\n', idx)
    command = 'node scripts/farm-orchestrator-selftest.js' if str(pkg_path).startswith('core/') else 'pnpm -C core farm:orchestrator-selftest'
    new_line = f'    "farm:orchestrator-selftest": "{command}",\n'
    if '"farm:orchestrator-selftest"' not in pkg:
        pkg = pkg[:line_end + 1] + new_line + pkg[line_end + 1:]
    pkg_path.write_text(pkg, encoding='utf-8')

print('P6E1 farm orchestrator patch applied')
