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
    """const {
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
    """const {
    getDisplayLandContext,
    isOccupiedSlaveLand,
    buildSlaveToMasterMap,
    summarizeLandDetails,
    getLandTypeByLevel,
    getCurrentPhase,
    buildLandMap,
    classifyHarvestedLandsByMap,
} = require('./farm-land-analyzer');
const {
    getAllLandsRaw,
    harvest,
    waterLand,
    weedOut,
    insecticide,
    removePlant,
    upgradeLand,
    unlockLand,
    getShopInfo,
    buyGoods,
} = require('./farm-api');
""",
    'farm API import',
)

# Replace the original raw PlantService block with a thin compatibility wrapper.
start = text.find('/**\n * 通用植物操作请求\n */')
end = text.find('// 普通肥料 ID', start)
if start < 0 or end < 0:
    raise SystemExit('farm API top block anchors not found')
wrapper = """async function getAllLands() {
    const reply = await getAllLandsRaw();
    // 保持原有副作用边界：transport 只负责 RPC，operation-limit 回调仍由 farm facade 触发。
    if (reply.operation_limits && onOperationLimitsUpdate) {
        onOperationLimitsUpdate(reply.operation_limits);
    }
    return reply;
}

"""
text = text[:start] + wrapper + text[end:]

# Remove raw remove/unlock/shop transport functions while retaining the planting section.
text = remove_slice(
    text,
    'async function removePlant(landIds) {',
    '// ============ 种植 ============',
    'remove/unlock/shop API block',
)
text = text.replace('// ============ 种植 ============', '// ============ 种植 ============', 1)

path.write_text(text, encoding='utf-8')

for filename in ('core/package.json', 'package.json'):
    path = Path(filename)
    text = path.read_text(encoding='utf-8')
    if filename == 'core/package.json':
        anchor = '    "farm:land-analyzer-selftest": "node scripts/farm-land-analyzer-selftest.js",\n'
        addition = anchor + '    "farm:api-selftest": "node scripts/farm-api-selftest.js",\n'
    else:
        anchor = '    "farm:land-analyzer-selftest": "pnpm -C core farm:land-analyzer-selftest",\n'
        addition = anchor + '    "farm:api-selftest": "pnpm -C core farm:api-selftest",\n'
    text = replace_once(text, anchor, addition, f'{filename} farm api selftest')
    path.write_text(text, encoding='utf-8')

print('P6B farm API extraction applied')
