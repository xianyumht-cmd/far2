from pathlib import Path

farm_path = Path('core/src/services/farm.js')
core_pkg_path = Path('core/package.json')
root_pkg_path = Path('package.json')

text = farm_path.read_text(encoding='utf-8')

import_start = text.find("const { PlantPhase, PHASE_NAMES } = require('../config/config');")
import_end = text.find('// ============ 农场 API ============', import_start)
if import_start < 0 or import_end < 0:
    raise SystemExit(f'import block anchors missing: {import_start}, {import_end}')

new_imports = """const {
    getDisplayLandContext,
    isOccupiedSlaveLand,
    buildSlaveToMasterMap,
    getCurrentPhase,
    buildLandMap,
} = require('./farm-land-analyzer');
const { getAllLandsRaw } = require('./farm-api');
const { createFarmFertilizerService } = require('./farm-fertilizer');
const { createPlantingService } = require('./planting-service');
const { createFarmOrchestrator } = require('./farm-orchestrator');
const { createFarmSchedulerService } = require('./farm-scheduler');
const { createFarmQueryService } = require('./farm-query-service');

"""
text = text[:import_start] + new_imports + text[import_end:]

scheduler_anchor = """const {
    startFarmCheckLoop,
    stopFarmCheckLoop,
    refreshFarmCheckLoop,
} = createFarmSchedulerService({
    checkFarm,
    isChecking: isFarmCheckInProgress,
});

"""
if text.count(scheduler_anchor) != 1:
    raise SystemExit('scheduler instance anchor missing/duplicate')
query_instance = """const {
    getAvailableSeeds,
    getLandsDetail,
} = createFarmQueryService({
    // 土地详情必须继续经过 facade wrapper，以保持 operation-limit callback 语义。
    getAllLands,
});

"""
text = text.replace(scheduler_anchor, scheduler_anchor + query_instance, 1)

query_start = text.find('// ============ 种植执行：由 planting-service.js 提供 ============')
query_end = text.find('// ============ 巡田业务编排：由 farm-orchestrator.js 提供 ============', query_start + 1)
if query_start < 0 or query_end < 0:
    raise SystemExit(f'query implementation anchors missing: {query_start}, {query_end}')
text = text[:query_start] + '// ============ 只读查询：由 farm-query-service.js 提供 ============\n\n' + text[query_end:]

for removed in [
    'async function getAvailableSeeds(',
    'async function getLandsDetail(',
    "require('../config/gameConfig')",
    "require('../utils/network')",
    "require('../utils/utils')",
    "require('./farm-mutation')",
    "require('./warehouse')",
]:
    if removed in text:
        raise SystemExit(f'facade still contains query dependency/implementation: {removed}')

for required in [
    'function setOperationLimitsCallback(',
    'async function getAllLands()',
    'createFarmFertilizerService({',
    'createPlantingService({',
    'createFarmOrchestrator({',
    'createFarmSchedulerService({',
    'createFarmQueryService({',
    'checkFarm, startFarmCheckLoop, stopFarmCheckLoop,',
    'getLandsDetail,',
    'getAvailableSeeds,',
    'runFarmOperation,',
    'runFertilizerByConfig,',
    'buildLandMap,',
    'buildSlaveToMasterMap,',
    'getDisplayLandContext,',
    'isOccupiedSlaveLand,',
]:
    if required not in text:
        raise SystemExit(f'facade contract anchor lost: {required}')

farm_path.write_text(text, encoding='utf-8')

for pkg_path in [core_pkg_path, root_pkg_path]:
    pkg = pkg_path.read_text(encoding='utf-8')
    anchor = '    "farm:scheduler-selftest": '
    idx = pkg.find(anchor)
    if idx < 0:
        raise SystemExit(f'{pkg_path}: scheduler selftest anchor missing')
    line_end = pkg.find('\n', idx)
    command = 'node scripts/farm-query-selftest.js' if str(pkg_path).startswith('core/') else 'pnpm -C core farm:query-selftest'
    new_line = f'    "farm:query-selftest": "{command}",\n'
    if '"farm:query-selftest"' not in pkg:
        pkg = pkg[:line_end + 1] + new_line + pkg[line_end + 1:]
    pkg_path.write_text(pkg, encoding='utf-8')

print('P6F farm query/facade patch applied')
