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

text = replace_once(text, "const protobuf = require('protobufjs');\n", '', 'protobuf import')
text = replace_once(
    text,
    "const { getPlantNameBySeedId, getPlantName, getPlantExp, formatGrowTime, getPlantGrowTime, getAllSeeds, getPlantById, getPlantBySeedId, getSeedImageBySeedId, getMutantEffectsByIds } = require('../config/gameConfig');\n",
    "const { getPlantNameBySeedId, getPlantName, getPlantExp, getPlantGrowTime, getAllSeeds, getPlantById, getSeedImageBySeedId, getMutantEffectsByIds } = require('../config/gameConfig');\n",
    'gameConfig import',
)
text = replace_once(
    text,
    "const { isAutomationOn, getPreferredSeed, getAutomation, getPlantingStrategy, getPrioritize2x2Crops, getBagSeedPriority, getBagSeedFallbackStrategy, getFertilizerBuyOrganicCount, getFertilizerBuyOrganicThresholdHours, getFertilizerBuyNormalCount, getFertilizerBuyNormalThresholdHours, getFertilizerBuyCheckIntervalMinutes } = require('../models/store');\n",
    "const { isAutomationOn, getAutomation, getPlantingStrategy, getPrioritize2x2Crops, getBagSeedPriority, getBagSeedFallbackStrategy, getFertilizerBuyOrganicCount, getFertilizerBuyOrganicThresholdHours, getFertilizerBuyNormalCount, getFertilizerBuyNormalThresholdHours, getFertilizerBuyCheckIntervalMinutes } = require('../models/store');\n",
    'store import',
)
text = replace_once(
    text,
    "const { sendMsgAsync, getUserState, networkEvents, getWsErrorState } = require('../utils/network');\n",
    "const { getUserState, networkEvents, getWsErrorState } = require('../utils/network');\n",
    'network import',
)
text = replace_once(text, "const { types } = require('../utils/proto');\n", '', 'proto import')
text = replace_once(text, "const { getPlantRankings } = require('./analytics');\n", '', 'analytics import')
text = replace_once(text, "const { selectReady2x2Groups, validate2x2PlantReply } = require('./farm-2x2');\n", '', 'farm-2x2 import')
text = replace_once(
    text,
    "    unlockLand,\n    getShopInfo,\n    buyGoods,\n} = require('./farm-api');\nconst { createFarmFertilizerService } = require('./farm-fertilizer');\n",
    "    unlockLand,\n    getShopInfo,\n} = require('./farm-api');\nconst { createFarmFertilizerService } = require('./farm-fertilizer');\nconst { createPlantingService, getPlantingStrategyLabel } = require('./planting-service');\n",
    'farm api / planting import',
)

fertilizer_anchor = """const { runFertilizerByConfig } = createFarmFertilizerService({
    // 必须注入 facade wrapper，不能直接使用 getAllLandsRaw；这样 operation-limit callback 语义保持不变。
    getAllLands,
});

"""
planting_instance = """const {
    plant2x2Seed,
    plantFromBagSeeds,
    plantFromShop,
} = createPlantingService({
    // 背包 2x2 探测必须继续经过 facade wrapper，保持 operation-limit callback 语义。
    getAllLands,
});

"""
text = replace_once(text, fertilizer_anchor, fertilizer_anchor + planting_instance, 'fertilizer instance')

start_marker = "// ============ 种植 ============\n\nfunction encodePlantRequest"
end_marker = "async function getAvailableSeeds() {"
start = text.find(start_marker)
end = text.find(end_marker, start + 1)
if start < 0 or end < 0:
    raise SystemExit(f'initial planting block anchors missing: start={start}, end={end}')
text = text[:start] + "// ============ 种植执行：由 planting-service.js 提供 ============\n\n" + text[end:]

shop_start_marker = "async function plantFromShop(landsToPlant, state, overrideStrategy) {"
shop_end_marker = "function analyzeLands(lands) {"
shop_start = text.find(shop_start_marker)
shop_end = text.find(shop_end_marker, shop_start + 1)
if shop_start < 0 or shop_end < 0:
    raise SystemExit(f'plantFromShop anchors missing: start={shop_start}, end={shop_end}')
text = text[:shop_start] + text[shop_end:]

for removed in [
    'function encodePlantRequest(',
    'async function plantSeeds(',
    'async function plant2x2Seed(',
    'async function plantFromBagSeeds(',
    'async function findBestSeed(',
    'async function plantFromShop(',
]:
    if removed in text:
        raise SystemExit(f'old planting implementation still present: {removed}')

for required in [
    'async function autoPlantEmptyLands(',
    'async function getAvailableSeeds()',
    'runPrioritized2x2Prepass({',
    'await runFertilizerByConfig(twoByTwo.plantedLandIds)',
    'await runFertilizerByConfig(plantedLands)',
]:
    if required not in text:
        raise SystemExit(f'production orchestration anchor lost: {required}')

farm_path.write_text(text, encoding='utf-8')

for pkg_path in [core_pkg_path, root_pkg_path]:
    pkg = pkg_path.read_text(encoding='utf-8')
    old = '    "farm:fertilizer-selftest": '
    idx = pkg.find(old)
    if idx < 0:
        raise SystemExit(f'{pkg_path}: fertilizer selftest anchor missing')
    line_end = pkg.find('\n', idx)
    line = pkg[idx:line_end + 1]
    indent = '    '
    command = 'node scripts/planting-service-selftest.js' if str(pkg_path).startswith('core/') else 'pnpm -C core planting:service-selftest'
    new_line = f'{indent}"planting:service-selftest": "{command}",\n'
    if '"planting:service-selftest"' not in pkg:
        pkg = pkg[:line_end + 1] + new_line + pkg[line_end + 1:]
    pkg_path.write_text(pkg, encoding='utf-8')

print('P6D planting-service patch applied')
