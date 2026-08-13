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

text = replace_once(text, "const { CONFIG, PlantPhase, PHASE_NAMES } = require('../config/config');\n", "const { PlantPhase, PHASE_NAMES } = require('../config/config');\n", 'config import')
text = replace_once(text, "const { isAutomationOn, getFertilizerBuyOrganicCount, getFertilizerBuyOrganicThresholdHours, getFertilizerBuyNormalCount, getFertilizerBuyNormalThresholdHours, getFertilizerBuyCheckIntervalMinutes } = require('../models/store');\n", '', 'store import')
text = replace_once(text, "const { getUserState, networkEvents, getWsErrorState } = require('../utils/network');\n", "const { getUserState, getWsErrorState } = require('../utils/network');\n", 'network import')
text = replace_once(text, "const { toNum, getServerTimeSec, toTimeSec, log, logWarn } = require('../utils/utils');\n", "const { toNum, getServerTimeSec, toTimeSec, logWarn } = require('../utils/utils');\n", 'utils import')
text = replace_once(text, "const { createScheduler } = require('./scheduler');\n", '', 'scheduler import')
text = replace_once(text, "const { autoBuyFertilizer, checkAndBuyFertilizerBoth } = require('./mall');\n", '', 'mall import')
text = replace_once(
    text,
    "const { createFarmOrchestrator } = require('./farm-orchestrator');\n",
    "const { createFarmOrchestrator } = require('./farm-orchestrator');\nconst { createFarmSchedulerService } = require('./farm-scheduler');\n",
    'scheduler service import',
)

state_block = """// ============ 内部状态 ============
let farmLoopRunning = false;
let externalSchedulerMode = false;
let fertilizerBuyCheckTimer = null;
let lastFertilizerBuyCheckAt = 0;
const farmScheduler = createScheduler('farm');

"""
text = replace_once(text, state_block, '', 'scheduler state block')

orchestrator_anchor = """const {
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
scheduler_instance = """const {
    startFarmCheckLoop,
    stopFarmCheckLoop,
    refreshFarmCheckLoop,
} = createFarmSchedulerService({
    checkFarm,
    isChecking: isFarmCheckInProgress,
});

"""
text = replace_once(text, orchestrator_anchor, orchestrator_anchor + scheduler_instance, 'orchestrator instance')

start = text.find('function scheduleNextFarmCheck(')
end = text.find('module.exports = {', start + 1)
if start < 0 or end < 0:
    raise SystemExit(f'scheduler block anchors missing: start={start}, end={end}')
text = text[:start] + '// ============ 巡田调度：由 farm-scheduler.js 提供 ============\n\n' + text[end:]

for removed in [
    'function scheduleNextFarmCheck(',
    'function onLandsChangedPush(',
    'function startFertilizerBuyCheckTimer(',
    'async function checkFertilizerBuyOnce(',
    'lastFertilizerBuyCheckAt',
]:
    if removed in text:
        raise SystemExit(f'old scheduler implementation/state still present: {removed}')

for required in [
    'startFarmCheckLoop, stopFarmCheckLoop,',
    'refreshFarmCheckLoop,',
    'checkFarm,',
    'runFarmOperation,',
    'getLandsDetail,',
    'getAvailableSeeds,',
]:
    if required not in text:
        raise SystemExit(f'facade public anchor lost: {required}')

farm_path.write_text(text, encoding='utf-8')

for pkg_path in [core_pkg_path, root_pkg_path]:
    pkg = pkg_path.read_text(encoding='utf-8')
    anchor = '    "farm:orchestrator-selftest": '
    idx = pkg.find(anchor)
    if idx < 0:
        raise SystemExit(f'{pkg_path}: orchestrator selftest anchor missing')
    line_end = pkg.find('\n', idx)
    command = 'node scripts/farm-scheduler-selftest.js' if str(pkg_path).startswith('core/') else 'pnpm -C core farm:scheduler-selftest'
    new_line = f'    "farm:scheduler-selftest": "{command}",\n'
    if '"farm:scheduler-selftest"' not in pkg:
        pkg = pkg[:line_end + 1] + new_line + pkg[line_end + 1:]
    pkg_path.write_text(pkg, encoding='utf-8')

print('P6E2 farm scheduler patch applied')
