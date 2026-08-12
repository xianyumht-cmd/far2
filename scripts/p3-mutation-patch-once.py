from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly 1 anchor, found {count}')
    return text.replace(old, new, 1)


# gameConfig.js: load static read-only mutation metadata.
path = Path('core/src/config/gameConfig.js')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    "const seedAssetImageMap = new Map(); // asset_name (Crop_xxx) -> image url\n",
    "const seedAssetImageMap = new Map(); // asset_name (Crop_xxx) -> image url\nlet mutantEffectConfig = null;\nconst mutantEffectMap = new Map(); // mutant config id -> read-only display metadata\n",
    'game config mutation declarations',
)
text = replace_once(
    text,
    """    } catch (e) {
        console.warn('[配置] 加载 seed_images_named 失败:', e.message);
    }
}

// ============ 等级经验相关 ============""",
    """    } catch (e) {
        console.warn('[配置] 加载 seed_images_named 失败:', e.message);
    }

    // 加载变异效果静态元数据（只读展示，不参与任何自动刷变异逻辑）
    try {
        const mutantPath = path.join(configDir, 'MutantEffect.json');
        mutantEffectMap.clear();
        mutantEffectConfig = null;
        if (fs.existsSync(mutantPath)) {
            mutantEffectConfig = JSON.parse(fs.readFileSync(mutantPath, 'utf8'));
            for (const effect of (Array.isArray(mutantEffectConfig) ? mutantEffectConfig : [])) {
                const id = Number(effect && effect.id) || 0;
                if (id > 0) mutantEffectMap.set(id, effect);
            }
            console.warn(`[配置] 已加载变异效果元数据 (${mutantEffectMap.size} 项)`);
        }
    } catch (e) {
        console.warn('[配置] 加载 MutantEffect.json 失败:', e.message);
    }
}

// ============ 等级经验相关 ============""",
    'game config mutation loader',
)
text = replace_once(
    text,
    """function getSeedPlantSize(seedId) {
    const plant = getPlantBySeedId(seedId);
    return Math.max(1, Number(plant && plant.size) || 1);
}

function getSeedPrice(seedId) {""",
    """function getSeedPlantSize(seedId) {
    const plant = getPlantBySeedId(seedId);
    return Math.max(1, Number(plant && plant.size) || 1);
}

function getMutantEffectById(mutantId) {
    return mutantEffectMap.get(Number(mutantId) || 0) || null;
}

function getMutantEffectsByIds(ids) {
    const seen = new Set();
    const result = [];
    for (const rawId of (Array.isArray(ids) ? ids : [])) {
        const id = Number(rawId) || 0;
        if (id <= 0 || seen.has(id)) continue;
        seen.add(id);
        const effect = mutantEffectMap.get(id);
        if (effect) result.push(effect);
    }
    return result;
}

function getSeedPrice(seedId) {""",
    'game config mutation getters',
)
text = replace_once(
    text,
    "    getSeedPlantSize,\n    getSeedPrice,",
    "    getSeedPlantSize,\n    getMutantEffectById,\n    getMutantEffectsByIds,\n    getSeedPrice,",
    'game config mutation exports',
)
path.write_text(text, encoding='utf-8')


# farm.js: expose a mutation read model in the existing land DTO.
path = Path('core/src/services/farm.js')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    "const { getPlantNameBySeedId, getPlantName, getPlantExp, formatGrowTime, getPlantGrowTime, getAllSeeds, getPlantById, getPlantBySeedId, getSeedImageBySeedId } = require('../config/gameConfig');",
    "const { getPlantNameBySeedId, getPlantName, getPlantExp, formatGrowTime, getPlantGrowTime, getAllSeeds, getPlantById, getPlantBySeedId, getSeedImageBySeedId, getMutantEffectsByIds } = require('../config/gameConfig');",
    'farm mutation config import',
)
text = replace_once(
    text,
    "const { runPrioritized2x2Prepass } = require('./farm-2x2-priority');\n",
    "const { runPrioritized2x2Prepass } = require('./farm-2x2-priority');\nconst { buildMutationDetail } = require('./farm-mutation');\n",
    'farm mutation helper import',
)
text = replace_once(
    text,
    """            const needWater = (toNum(plant.dry_num) > 0) || (toTimeSec(currentPhase.dry_time) > 0 && toTimeSec(currentPhase.dry_time) <= nowSec);
            const needWeed = (plant.weed_owners && plant.weed_owners.length > 0) || (toTimeSec(currentPhase.weeds_time) > 0 && toTimeSec(currentPhase.weeds_time) <= nowSec);
            const needBug = (plant.insect_owners && plant.insect_owners.length > 0) || (toTimeSec(currentPhase.insect_time) > 0 && toTimeSec(currentPhase.insect_time) <= nowSec);

            lands.push({""",
    """            const needWater = (toNum(plant.dry_num) > 0) || (toTimeSec(currentPhase.dry_time) > 0 && toTimeSec(currentPhase.dry_time) <= nowSec);
            const needWeed = (plant.weed_owners && plant.weed_owners.length > 0) || (toTimeSec(currentPhase.weeds_time) > 0 && toTimeSec(currentPhase.weeds_time) <= nowSec);
            const needBug = (plant.insect_owners && plant.insect_owners.length > 0) || (toTimeSec(currentPhase.insect_time) > 0 && toTimeSec(currentPhase.insect_time) <= nowSec);
            const mutation = occupiedByMaster
                ? { active: false, configIds: [], effects: [], unknownConfigIds: [], events: [] }
                : buildMutationDetail(plant, currentPhase, getMutantEffectsByIds);

            lands.push({""",
    'farm mutation DTO build',
)
text = replace_once(
    text,
    """                occupiedLandIds,
                plantSize,
            });""",
    """                occupiedLandIds,
                plantSize,
                mutation,
                mutantConfigIds: mutation.configIds,
                mutantEffects: mutation.effects,
                mutantEvents: mutation.events,
            });""",
    'farm mutation DTO fields',
)
path.write_text(text, encoding='utf-8')


# LandCard.vue: text-only read-only mutation badges, no game asset dependency.
path = Path('web/src/components/LandCard.vue')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    "const canUpgrade = computed(() => !!(land.value?.unlocked && land.value?.couldUpgrade))\n",
    """const canUpgrade = computed(() => !!(land.value?.unlocked && land.value?.couldUpgrade))

const mutationDetail = computed(() => {
  const value = land.value?.mutation
  if (value && typeof value === 'object')
    return value
  const effects = Array.isArray(land.value?.mutantEffects) ? land.value.mutantEffects : []
  const configIds = Array.isArray(land.value?.mutantConfigIds) ? land.value.mutantConfigIds : []
  return { active: effects.length > 0 || configIds.length > 0, effects, configIds, unknownConfigIds: [], events: [] }
})

const mutantEffects = computed(() => Array.isArray(mutationDetail.value?.effects) ? mutationDetail.value.effects : [])
const unknownMutantIds = computed(() => Array.isArray(mutationDetail.value?.unknownConfigIds) ? mutationDetail.value.unknownConfigIds : [])
""",
    'land card mutation computed',
)
text = replace_once(
    text,
    """  if (status === 'stealable')
    return `${baseClass} ring-2 ring-purple-500 ring-offset-1 dark:ring-offset-gray-900`

  return baseClass""",
    """  if (status === 'stealable')
    return `${baseClass} ring-2 ring-purple-500 ring-offset-1 dark:ring-offset-gray-900`

  if (mutationDetail.value?.active)
    return `${baseClass} ring-1 ring-pink-400 dark:ring-pink-700`

  return baseClass""",
    'land card mutation ring',
)
text = replace_once(
    text,
    """    <div class="mb-1 text-[10px] text-gray-400">
      季数 {{ land.totalSeason > 0 ? (`${land.currentSeason}/${land.totalSeason}`) : '-/-' }}
    </div>

    <div class="flex origin-bottom gap-0.5 text-[10px]">""",
    """    <div class="mb-1 text-[10px] text-gray-400">
      季数 {{ land.totalSeason > 0 ? (`${land.currentSeason}/${land.totalSeason}`) : '-/-' }}
    </div>

    <div
      v-if="mutationDetail.active"
      class="mb-1 w-full rounded border border-pink-200 bg-pink-50/80 px-1.5 py-1 text-[10px] dark:border-pink-900/50 dark:bg-pink-950/20"
    >
      <div class="mb-0.5 font-semibold text-pink-700 dark:text-pink-300">
        变异
      </div>
      <div class="flex flex-wrap justify-center gap-1">
        <span
          v-for="effect in mutantEffects"
          :key="`${land.id}-mutant-${effect.id}`"
          class="rounded bg-pink-100 px-1 py-0.5 text-pink-700 dark:bg-pink-900/40 dark:text-pink-200"
          :title="effect.description || effect.tips || effect.name"
        >
          {{ effect.name }}<template v-if="effect.description"> · {{ effect.description }}</template>
        </span>
        <span
          v-for="mutantId in unknownMutantIds"
          :key="`${land.id}-unknown-mutant-${mutantId}`"
          class="rounded bg-gray-100 px-1 py-0.5 text-gray-600 dark:bg-gray-700 dark:text-gray-300"
          title="服务器返回了当前本地配置尚未识别的变异 ID"
        >
          未知变异 #{{ mutantId }}
        </span>
      </div>
    </div>

    <div class="flex origin-bottom gap-0.5 text-[10px]">""",
    'land card mutation badges',
)
path.write_text(text, encoding='utf-8')


# Self-test command entries.
for filename in ('core/package.json', 'package.json'):
    path = Path(filename)
    text = path.read_text(encoding='utf-8')
    if filename == 'core/package.json':
        old = '    "planting:2x2-selftest": "node scripts/purple-land-selftest.js && node scripts/planting-2x2-selftest.js && node scripts/seed-2x2-fallback-selftest.js",\n'
        new = old + '    "mutation:readonly-selftest": "node scripts/mutation-readonly-selftest.js",\n'
    else:
        old = '    "planting:2x2-selftest": "pnpm -C core planting:2x2-selftest",\n'
        new = old + '    "mutation:readonly-selftest": "pnpm -C core mutation:readonly-selftest",\n'
    text = replace_once(text, old, new, f'{filename} mutation selftest script')
    path.write_text(text, encoding='utf-8')

print('P3 mutation read-only source patch applied')
