from pathlib import Path

friend_path = Path('core/src/services/friend.js')
core_pkg_path = Path('core/package.json')
root_pkg_path = Path('package.json')

text = friend_path.read_text(encoding='utf-8')

def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one anchor, found {count}')
    return source.replace(old, new, 1)

text = replace_once(
    text,
    "const { getPlantName, getPlantById, getSeedImageBySeedId, getPlantGrowTime } = require('../config/gameConfig');\n",
    "const { getPlantName, getPlantById, getSeedImageBySeedId, getPlantGrowTime, getMutantEffectsByIds } = require('../config/gameConfig');\n",
    'gameConfig mutation resolver import',
)
text = replace_once(
    text,
    "const { getCurrentPhase, setOperationLimitsCallback, buildLandMap, getDisplayLandContext, isOccupiedSlaveLand } = require('./farm');\n",
    "const { getCurrentPhase, setOperationLimitsCallback, buildLandMap, getDisplayLandContext, isOccupiedSlaveLand } = require('./farm');\nconst { buildMutationDetail } = require('./farm-mutation');\n",
    'farm mutation helper import',
)

helper_anchor = """const OP_NAMES = {
    10001: '收获',
    10002: '铲除',
    10003: '放草',
    10004: '放虫',
    10005: '除草',
    10006: '除虫',
    10007: '浇水',
    10008: '偷菜',
};

"""
helper = """function buildFriendLandMutationDetail(plant, currentPhase, occupiedByMaster, resolveEffects = getMutantEffectsByIds) {
    if (occupiedByMaster) {
        return {
            active: false,
            configIds: [],
            effects: [],
            unknownConfigIds: [],
            events: [],
        };
    }
    return buildMutationDetail(plant, currentPhase, resolveEffects);
}

"""
text = replace_once(text, helper_anchor, helper_anchor + helper, 'friend mutation DTO helper')

mutation_anchor = """            const totalGrowTime = getPlantGrowTime(plantId);
            let landStatus = 'growing';
"""
mutation_insertion = """            const totalGrowTime = getPlantGrowTime(plantId);
            const mutation = buildFriendLandMutationDetail(plant, currentPhase, occupiedByMaster);
            let landStatus = 'growing';
"""
text = replace_once(text, mutation_anchor, mutation_insertion, 'friend land mutation mapping')

fields_anchor = """                occupiedLandIds,
                plantSize,
            });
"""
fields_replacement = """                occupiedLandIds,
                plantSize,
                mutation,
                mutantConfigIds: mutation.configIds,
                mutantEffects: mutation.effects,
                mutantEvents: mutation.events,
            });
"""
text = replace_once(text, fields_anchor, fields_replacement, 'friend land mutation DTO fields')

export_anchor = """    getFriendsList,
    getFriendLandsDetail,
    doFriendOperation,
"""
export_replacement = """    getFriendsList,
    getFriendLandsDetail,
    buildFriendLandMutationDetail,
    doFriendOperation,
"""
text = replace_once(text, export_anchor, export_replacement, 'friend mutation helper export')

for required in [
    'const { buildMutationDetail } = require(\'./farm-mutation\');',
    'function buildFriendLandMutationDetail(',
    'const mutation = buildFriendLandMutationDetail(plant, currentPhase, occupiedByMaster);',
    'mutantConfigIds: mutation.configIds,',
    'mutantEffects: mutation.effects,',
    'mutantEvents: mutation.events,',
    'buildFriendLandMutationDetail,',
]:
    if required not in text:
        raise SystemExit(f'friend mutation contract anchor missing after patch: {required}')

friend_path.write_text(text, encoding='utf-8')

for pkg_path in [core_pkg_path, root_pkg_path]:
    pkg = pkg_path.read_text(encoding='utf-8')
    anchor = '    "mutation:readonly-selftest": '
    idx = pkg.find(anchor)
    if idx < 0:
        raise SystemExit(f'{pkg_path}: mutation selftest anchor missing')
    line_end = pkg.find('\n', idx)
    if line_end < 0:
        raise SystemExit(f'{pkg_path}: mutation selftest line end missing')
    command = 'node scripts/friend-mutation-readonly-selftest.js' if str(pkg_path).startswith('core/') else 'pnpm -C core friend:mutation-selftest'
    new_line = f'    "friend:mutation-selftest": "{command}",\n'
    if '"friend:mutation-selftest"' not in pkg:
        pkg = pkg[:line_end + 1] + new_line + pkg[line_end + 1:]
    pkg_path.write_text(pkg, encoding='utf-8')

print('P3B friend mutation read-only patch applied')
