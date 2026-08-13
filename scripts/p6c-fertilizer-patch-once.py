from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly 1 anchor, found {count}')
    return text.replace(old, new, 1)


path = Path('core/src/services/farm.js')
text = path.read_text(encoding='utf-8')

text = replace_once(
    text,
    """const {
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
    """const {
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
const { createFarmFertilizerService } = require('./farm-fertilizer');
""",
    'farm fertilizer service import',
)

wrapper = """async function getAllLands() {
    const reply = await getAllLandsRaw();
    // 保持原有副作用边界：transport 只负责 RPC，operation-limit 回调仍由 farm facade 触发。
    if (reply.operation_limits && onOperationLimitsUpdate) {
        onOperationLimitsUpdate(reply.operation_limits);
    }
    return reply;
}
"""
replacement = wrapper + """

const { runFertilizerByConfig } = createFarmFertilizerService({
    // 必须注入 facade wrapper，不能直接使用 getAllLandsRaw；这样 operation-limit callback 语义保持不变。
    getAllLands,
});
"""
text = replace_once(text, wrapper, replacement, 'fertilizer service injection')

start_marker = '// 普通肥料 ID\n'
end_marker = '// ============ 种植 ============\n'
start = text.find(start_marker)
end = text.find(end_marker, start)
if start < 0 or end < 0:
    raise SystemExit('fertilizer block anchors not found')
text = text[:start] + end_marker + text[end + len(end_marker):]

path.write_text(text, encoding='utf-8')

for filename in ('core/package.json', 'package.json'):
    path = Path(filename)
    text = path.read_text(encoding='utf-8')
    if filename == 'core/package.json':
        anchor = '    "farm:api-selftest": "node scripts/farm-api-selftest.js",\n'
        addition = anchor + '    "farm:fertilizer-selftest": "node scripts/farm-fertilizer-selftest.js",\n'
    else:
        anchor = '    "farm:api-selftest": "pnpm -C core farm:api-selftest",\n'
        addition = anchor + '    "farm:fertilizer-selftest": "pnpm -C core farm:fertilizer-selftest",\n'
    text = replace_once(text, anchor, addition, f'{filename} fertilizer selftest')
    path.write_text(text, encoding='utf-8')

print('P6C fertilizer extraction applied')
