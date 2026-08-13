from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly 1 anchor, found {count}')
    return text.replace(old, new, 1)


def remove_slice(text, start_marker, end_marker, label):
    start = text.find(start_marker)
    if start < 0:
        raise SystemExit(f'{label}: start marker not found')
    end = text.find(end_marker, start)
    if end < 0:
        raise SystemExit(f'{label}: end marker not found')
    return text[:start] + text[end:]


path = Path('core/src/services/farm.js')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    "const { buildMutationDetail } = require('./farm-mutation');\n",
    """const { buildMutationDetail } = require('./farm-mutation');
const {
    getDisplayLandContext,
    isOccupiedSlaveLand,
    buildSlaveToMasterMap,
    summarizeLandDetails,
    getLandTypeByLevel,
    getCurrentPhase,
    buildLandMap,
    classifyHarvestedLandsByMap,
} = require('./farm-land-analyzer');
""",
    'farm land analyzer import',
)

# Remove pure master/slave/context/summary helpers, stopping before fertilizer constants.
text = remove_slice(
    text,
    'function getSlaveLandIds(land) {',
    "const LEGACY_ALL_FERTILIZER_LAND_TYPES = ['gold', 'black', 'red', 'normal'];",
    'master slave helper block',
)

# getLandTypeByLevel now comes from farm-land-analyzer; fertilizer config stays here for P6C.
text = remove_slice(
    text,
    'function getLandTypeByLevel(level) {',
    'function normalizeFertilizerLandTypes(input) {',
    'land type function',
)

# Phase selection moves to analyzer; analyzeLands remains in farm.js for this first migration.
text = remove_slice(
    text,
    'function getCurrentPhase(phases, debug, landLabel) {',
    'function analyzeLands(lands) {',
    'current phase function',
)

# Map/lifecycle/post-harvest classification pure helpers move; RPC-based resolution remains here.
text = remove_slice(
    text,
    'function buildLandMap(lands) {',
    'async function resolveRemovableHarvestedLands(harvestedLandIds, harvestReply) {',
    'land lifecycle helper block',
)

path.write_text(text, encoding='utf-8')

for filename in ('core/package.json', 'package.json'):
    path = Path(filename)
    text = path.read_text(encoding='utf-8')
    if filename == 'core/package.json':
        anchor = '    "activity:readonly-selftest": "node scripts/activity-readonly-selftest.js",\n'
        addition = anchor + '    "farm:land-analyzer-selftest": "node scripts/farm-land-analyzer-selftest.js",\n'
    else:
        anchor = '    "activity:readonly-selftest": "pnpm -C core activity:readonly-selftest",\n'
        addition = anchor + '    "farm:land-analyzer-selftest": "pnpm -C core farm:land-analyzer-selftest",\n'
    text = replace_once(text, anchor, addition, f'{filename} analyzer selftest')
    path.write_text(text, encoding='utf-8')

print('P6A farm land analyzer extraction applied')
