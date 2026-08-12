<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

const props = defineProps<{
  land: any
  operating?: boolean
}>()

const emit = defineEmits<{
  (e: 'operate', action: 'remove' | 'fertilize-normal' | 'fertilize-organic' | 'upgrade', land: any): void
}>()

const land = computed(() => props.land)
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (timer) {
    clearInterval(timer)
  }
})

const growProgress = computed(() => {
  const matureInSec = land.value.matureInSec || 0
  const totalGrowTime = land.value.totalGrowTime || 0

  if (totalGrowTime <= 0 || matureInSec <= 0) {
    return 0
  }

  const progress = Math.min(100, Math.max(0, (matureInSec / totalGrowTime) * 100))
  return progress
})

const canOperatePlant = computed(() => {
  const item = land.value
  if (!item || !item.unlocked || item.occupiedByMaster)
    return false
  if (!item.plantName)
    return false
  return !['locked', 'empty'].includes(String(item.status || ''))
})

const canUpgrade = computed(() => !!(land.value?.unlocked && land.value?.couldUpgrade))

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

function getLandStatusClass(land: any) {
  const status = land.status
  const level = Number(land.level) || 0

  if (status === 'locked')
    return 'bg-gray-100 dark:bg-gray-800 opacity-60 border-dashed'

  let baseClass = 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700'

  // 土地等级样式。当前协议字段是 level；5+ 先作为紫土地展示，等待实机确认后再接入自动施肥范围。
  if (level >= 5) {
    baseClass = 'bg-violet-50/80 dark:bg-violet-900/15 border-violet-300 dark:border-violet-700'
  }
  else {
    switch (level) {
      case 1: // 黄土地
        baseClass = 'bg-yellow-50/80 dark:bg-yellow-900/10 border-yellow-200 dark:border-yellow-800'
        break
      case 2: // 红土地
        baseClass = 'bg-red-50/80 dark:bg-red-900/10 border-red-200 dark:border-red-800'
        break
      case 3: // 黑土地
        baseClass = 'bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-600'
        break
      case 4: // 金土地
        baseClass = 'bg-amber-100/80 dark:bg-amber-900/20 border-amber-300 dark:border-amber-600'
        break
    }
  }

  if (status === 'dead')
    return 'bg-gray-200 dark:bg-gray-700 border-gray-300 dark:border-gray-600 grayscale'

  if (status === 'harvestable')
    return `${baseClass} ring-2 ring-yellow-500 ring-offset-1 dark:ring-offset-gray-900`

  if (status === 'stealable')
    return `${baseClass} ring-2 ring-purple-500 ring-offset-1 dark:ring-offset-gray-900`

  if (mutationDetail.value?.active)
    return `${baseClass} ring-1 ring-pink-400 dark:ring-pink-700`

  return baseClass
}

function formatTime(sec: number) {
  if (sec <= 0)
    return ''
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return `${h > 0 ? `${h}:` : ''}${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

function getSafeImageUrl(url: string) {
  if (!url)
    return ''
  if (url.startsWith('http://'))
    return url.replace('http://', 'https://')
  return url
}

function getLandTypeName(level: number) {
  const value = Number(level) || 0
  if (value >= 5)
    return '紫土地'
  const typeMap: Record<number, string> = {
    0: '普通',
    1: '黄土地',
    2: '红土地',
    3: '黑土地',
    4: '金土地',
  }
  return typeMap[value] || ''
}

function getPlantSizeText(land: any) {
  const size = Number(land?.plantSize) || 1
  if (size <= 1)
    return ''
  return `${size}x${size}`
}

function operate(action: 'remove' | 'fertilize-normal' | 'fertilize-organic' | 'upgrade') {
  if (props.operating)
    return
  emit('operate', action, props.land)
}
</script>

<template>
  <div
    class="relative min-h-[188px] flex flex-col items-center border rounded-lg p-2 transition dark:border-gray-700 hover:shadow-md"
    :class="getLandStatusClass(land)"
  >
    <div class="absolute left-1 top-1 text-[10px] text-gray-400 font-mono">
      #{{ land.id }} · Lv{{ land.level ?? 0 }}
    </div>
    <div
      v-if="land.plantSize > 1"
      class="absolute right-1 top-1 rounded bg-pink-100 px-1 py-0.5 text-[10px] text-pink-700 dark:bg-pink-900/30 dark:text-pink-300"
    >
      合种 {{ getPlantSizeText(land) }}
    </div>
    <div
      v-else-if="land.occupiedByMaster"
      class="absolute right-1 top-1 rounded bg-gray-100 px-1 py-0.5 text-[10px] text-gray-500 dark:bg-gray-700 dark:text-gray-300"
    >
      合种副地
    </div>

    <div class="mb-1 mt-4 h-10 w-10 flex items-center justify-center">
      <img
        v-if="land.seedImage"
        :src="getSafeImageUrl(land.seedImage)"
        class="max-h-full max-w-full object-contain"
        loading="lazy"
        referrerpolicy="no-referrer"
      >
      <div v-else class="i-carbon-sprout text-xl text-gray-300" />
    </div>

    <div class="w-full truncate px-1 text-center text-xs font-bold" :title="land.plantName">
      {{ land.plantName || '-' }}
    </div>

    <div class="mb-0.5 mt-0.5 w-full text-center text-[10px] text-gray-500">
      <span v-if="land.matureInSec > 0" class="text-orange-500">
        预计 {{ formatTime(land.matureInSec) }} 后成熟
      </span>
      <span v-else>
        {{ land.phaseName || (land.status === 'locked' ? '未解锁' : '未开垦') }}
      </span>
    </div>

    <div v-if="land.matureInSec > 0 && land.totalGrowTime > 0" class="w-full px-1">
      <div class="rainbow-progress-bar">
        <div
          class="rainbow-progress-fill"
          :style="{ width: `${growProgress}%` }"
        />
      </div>
    </div>

    <div class="text-[10px] text-gray-400">
      {{ getLandTypeName(land.level) }}
    </div>

    <div class="mb-1 text-[10px] text-gray-400">
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

    <div class="flex origin-bottom gap-0.5 text-[10px]">
      <span v-if="land.needWater" class="rounded bg-blue-100 px-0.5 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">水</span>
      <span v-if="land.needWeed" class="rounded bg-green-100 px-0.5 text-green-700 dark:bg-green-900/30 dark:text-green-400">草</span>
      <span v-if="land.needBug" class="rounded bg-red-100 px-0.5 text-red-700 dark:bg-red-900/30 dark:text-red-400">虫</span>
      <span v-if="land.status === 'harvestable'" class="rounded bg-orange-100 px-0.5 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">可收</span>
    </div>

    <div v-if="canOperatePlant || canUpgrade" class="mt-auto w-full border-t border-black/5 pt-2 dark:border-white/10">
      <div v-if="canOperatePlant" class="grid grid-cols-3 gap-1">
        <button
          class="rounded border border-red-200 bg-red-50 px-1 py-1 text-[10px] text-red-600 disabled:opacity-40 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300"
          :disabled="operating"
          title="铲除当前土地作物"
          @click.stop="operate('remove')"
        >
          铲除
        </button>
        <button
          class="rounded border border-blue-200 bg-blue-50 px-1 py-1 text-[10px] text-blue-600 disabled:opacity-40 dark:border-blue-900/50 dark:bg-blue-950/20 dark:text-blue-300"
          :disabled="operating"
          title="使用 1 次普通肥"
          @click.stop="operate('fertilize-normal')"
        >
          普肥
        </button>
        <button
          class="rounded border border-green-200 bg-green-50 px-1 py-1 text-[10px] text-green-600 disabled:opacity-40 dark:border-green-900/50 dark:bg-green-950/20 dark:text-green-300"
          :disabled="operating"
          title="使用 1 次有机肥"
          @click.stop="operate('fertilize-organic')"
        >
          有机
        </button>
      </div>
      <button
        v-if="canUpgrade"
        class="mt-1 w-full rounded border border-violet-200 bg-violet-50 px-1 py-1 text-[10px] text-violet-600 disabled:opacity-40 dark:border-violet-900/50 dark:bg-violet-950/20 dark:text-violet-300"
        :disabled="operating"
        title="升级当前土地"
        @click.stop="operate('upgrade')"
      >
        升级土地
      </button>
    </div>
  </div>
</template>

<style scoped>
.rainbow-progress-bar {
  width: 80%;
  margin: 0 auto;
  height: 8px;
  background: linear-gradient(145deg, #f0f0f0, #e6e6e6);
  border-radius: 10px;
  overflow: hidden;
  box-shadow:
    inset 3px 3px 6px rgba(0, 0, 0, 0.1),
    inset -3px -3px 6px rgba(255, 255, 255, 0.9),
    2px 2px 4px rgba(0, 0, 0, 0.05);
  position: relative;
}

.rainbow-progress-bar::before {
  content: '';
  position: absolute;
  top: 1px;
  left: 2px;
  right: 2px;
  height: 3px;
  background: linear-gradient(90deg, rgba(255,255,255,0.8), rgba(255,255,255,0.2));
  border-radius: 10px 10px 0 0;
  pointer-events: none;
}

.rainbow-progress-fill {
  height: 100%;
  background: linear-gradient(
    90deg,
    #ff6b9d 0%,
    #ff9f43 20%,
    #ffd32a 40%,
    #26de81 60%,
    #45aaf2 80%,
    #a55eea 100%
  );
  border-radius: 10px;
  transition: width 1s linear;
  position: relative;
  box-shadow:
    inset 0 2px 4px rgba(255, 255, 255, 0.6),
    inset 0 -1px 2px rgba(0, 0, 0, 0.1);
  animation: cute-pulse 2s ease-in-out infinite;
}

.rainbow-progress-fill::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.4) 50%,
    transparent 100%
  );
  animation: shimmer 2s infinite;
  border-radius: 10px;
}

@keyframes cute-pulse {
  0%, 100% {
    filter: brightness(1) saturate(1);
  }
  50% {
    filter: brightness(1.1) saturate(1.1);
  }
}

@keyframes shimmer {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(100%);
  }
}

@media (prefers-color-scheme: dark) {
  .rainbow-progress-bar {
    background: linear-gradient(145deg, #2a2a2a, #1e1e1e);
    box-shadow:
      inset 3px 3px 6px rgba(0, 0, 0, 0.3),
      inset -3px -3px 6px rgba(60, 60, 60, 0.3),
      2px 2px 4px rgba(0, 0, 0, 0.2);
  }

  .rainbow-progress-bar::before {
    background: linear-gradient(90deg, rgba(255,255,255,0.1), rgba(255,255,255,0.02));
  }

  .rainbow-progress-fill {
    box-shadow:
      inset 0 2px 4px rgba(255, 255, 255, 0.2),
      inset 0 -1px 2px rgba(0, 0, 0, 0.2);
  }
}
</style>
