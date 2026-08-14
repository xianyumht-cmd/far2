<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'

interface DogItem {
  id: number
  expireTime: number
  status: number
  level: number
  active: number
}

interface DogFoodItem {
  id: number
  duration: number
  count: number
  name?: string
  image?: string
  itemType?: number
  description?: string
  effectDescription?: string
  recognizedDogFood?: boolean
  writeSupported?: boolean
  staticMetadataSource?: string
}

interface DogOverview {
  dogs: DogItem[]
  coin: number
  protectTime: number
  foods: DogFoodItem[]
  claimableGiftCount: number | null
  protocol?: {
    service?: string
    method?: string
    readOnly?: boolean
    foodWriteSupported?: boolean
    foodWriteEvidence?: string
    foodWriteMethod?: string
    manualOnly?: boolean
  }
}

const accountStore = useAccountStore()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)

const loading = ref(false)
const feedingFoodId = ref<number | null>(null)
const errorText = ref('')
const actionText = ref('')
const actionWarn = ref(false)
const overview = ref<DogOverview | null>(null)

const accountRunning = computed(() => !!currentAccount.value?.running)
const dogs = computed(() => Array.isArray(overview.value?.dogs) ? overview.value!.dogs : [])
const foods = computed(() => Array.isArray(overview.value?.foods) ? overview.value!.foods : [])

function formatTimeValue(value: number) {
  const numeric = Number(value) || 0
  if (numeric <= 0)
    return '无'
  const millis = numeric >= 1e12 ? numeric : (numeric >= 1e9 ? numeric * 1000 : 0)
  if (millis > 0) {
    const date = new Date(millis)
    if (!Number.isNaN(date.getTime()))
      return date.toLocaleString()
  }
  if (numeric < 60)
    return `${numeric} 秒`
  if (numeric < 3600)
    return `${Math.floor(numeric / 60)} 分钟`
  if (numeric < 86400)
    return `${Math.floor(numeric / 3600)} 小时`
  return `${Math.floor(numeric / 86400)} 天`
}

function dogStatusText(dog: DogItem) {
  if (Number(dog.active) > 0)
    return '已激活'
  if (Number(dog.status) > 0)
    return `状态 ${dog.status}`
  return '未激活'
}

async function refresh() {
  if (!currentAccountId.value) {
    overview.value = null
    errorText.value = '请先选择账号'
    return
  }
  if (!accountRunning.value) {
    overview.value = null
    errorText.value = '当前账号未运行，启动账号后才能读取护主犬状态'
    return
  }

  loading.value = true
  errorText.value = ''
  try {
    const response = await api.get('/api/dog/info', { timeout: 20000 })
    if (!response.data?.ok)
      throw new Error(response.data?.error || '读取护主犬状态失败')
    overview.value = response.data.data || null
  }
  catch (error: any) {
    overview.value = null
    errorText.value = String(error?.response?.data?.error || error?.message || '读取护主犬状态失败')
  }
  finally {
    loading.value = false
  }
}

async function feedOnce(food: DogFoodItem) {
  if (!food.writeSupported || Number(food.count) <= 0)
    return
  const name = food.name || `狗粮 #${food.id}`
  const confirmed = window.confirm(`确认使用 1 份「${name}」？\n\n本操作只执行一次，不会自动连续喂食。`)
  if (!confirmed)
    return

  feedingFoodId.value = food.id
  actionText.value = ''
  errorText.value = ''
  try {
    const response = await api.post('/api/dog/feed', { foodId: food.id }, { timeout: 30000 })
    if (!response.data?.ok)
      throw new Error(response.data?.error || '喂食失败')
    const result = response.data.data
    if (result?.after)
      overview.value = result.after
    const verified = result?.verification?.verified === true
    actionWarn.value = !verified
    actionText.value = verified
      ? `${result.foodName || name} 已使用 1 份，写后库存复核通过。`
      : '服务器已接受 AddFood，但写后库存暂未观察到变化；FAR2 不会自动重试写入，请手动刷新确认。'
  }
  catch (error: any) {
    actionWarn.value = true
    errorText.value = String(error?.response?.data?.error || error?.message || '喂食失败')
  }
  finally {
    feedingFoodId.value = null
  }
}

watch([currentAccountId, accountRunning], refresh)
onMounted(refresh)
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-col gap-3 rounded-lg bg-white p-4 shadow sm:flex-row sm:items-center sm:justify-between dark:bg-gray-800">
      <div>
        <div class="flex items-center gap-2 font-semibold text-gray-800 dark:text-gray-100">
          <div class="i-carbon-paw text-lg" />
          护主犬状态
          <span class="rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-950/30 dark:text-blue-300">
            手动单次
          </span>
        </div>
        <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          状态读取使用 DogService.GetDogInfo；狗粮仅允许显式确认后调用一次 AddFood，不提供自动喂食或礼包领取。
        </div>
      </div>
      <button
        class="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-700"
        :disabled="loading || feedingFoodId !== null || !accountRunning"
        @click="refresh"
      >
        {{ loading ? '读取中…' : '刷新' }}
      </button>
    </div>

    <div v-if="errorText" class="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-300">
      {{ errorText }}
    </div>

    <div
      v-if="actionText"
      class="rounded-lg border px-4 py-3 text-sm"
      :class="actionWarn
        ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-300'
        : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-300'"
    >
      {{ actionText }}
    </div>

    <template v-if="overview">
      <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div class="rounded-lg bg-white p-4 shadow dark:bg-gray-800">
          <div class="text-xs text-gray-500 dark:text-gray-400">护主犬数量</div>
          <div class="mt-1 text-xl font-semibold text-gray-800 dark:text-gray-100">{{ dogs.length }}</div>
        </div>
        <div class="rounded-lg bg-white p-4 shadow dark:bg-gray-800">
          <div class="text-xs text-gray-500 dark:text-gray-400">犬币 / coin</div>
          <div class="mt-1 text-xl font-semibold text-gray-800 dark:text-gray-100">{{ overview.coin }}</div>
        </div>
        <div class="rounded-lg bg-white p-4 shadow dark:bg-gray-800">
          <div class="text-xs text-gray-500 dark:text-gray-400">保护时间</div>
          <div class="mt-1 text-sm font-semibold text-gray-800 dark:text-gray-100">{{ formatTimeValue(overview.protectTime) }}</div>
        </div>
        <div class="rounded-lg bg-white p-4 shadow dark:bg-gray-800">
          <div class="text-xs text-gray-500 dark:text-gray-400">同气礼包可领</div>
          <div class="mt-1 text-xl font-semibold text-gray-800 dark:text-gray-100">
            {{ overview.claimableGiftCount === null ? '字段未返回' : overview.claimableGiftCount }}
          </div>
          <div class="mt-1 text-[11px] text-gray-400">仅显示，不提供领取按钮</div>
        </div>
      </div>

      <div class="rounded-lg bg-white p-4 shadow dark:bg-gray-800">
        <div class="mb-3 font-semibold text-gray-800 dark:text-gray-100">护主犬</div>
        <div v-if="dogs.length === 0" class="rounded-lg bg-gray-50 px-4 py-6 text-center text-sm text-gray-500 dark:bg-gray-900/30 dark:text-gray-400">
          GetDogInfo 当前没有返回狗狗条目。
        </div>
        <div v-else class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <div v-for="dog in dogs" :key="dog.id" class="rounded-lg border border-gray-100 p-4 dark:border-gray-700">
            <div class="flex items-start justify-between gap-3">
              <div>
                <div class="font-medium text-gray-800 dark:text-gray-100">护主犬 #{{ dog.id }}</div>
                <div class="mt-1 text-sm text-gray-500 dark:text-gray-400">等级 Lv{{ dog.level }}</div>
              </div>
              <span class="rounded bg-blue-50 px-2 py-1 text-xs text-blue-700 dark:bg-blue-950/30 dark:text-blue-300">
                {{ dogStatusText(dog) }}
              </span>
            </div>
            <div class="mt-3 grid grid-cols-2 gap-2 text-xs text-gray-500 dark:text-gray-400">
              <div>status: {{ dog.status }}</div>
              <div>active: {{ dog.active }}</div>
              <div class="col-span-2">有效期: {{ formatTimeValue(dog.expireTime) }}</div>
            </div>
          </div>
        </div>
      </div>

      <div class="rounded-lg bg-white p-4 shadow dark:bg-gray-800">
        <div class="mb-1 font-semibold text-gray-800 dark:text-gray-100">狗粮</div>
        <div class="mb-3 text-xs text-gray-500 dark:text-gray-400">
          仅 90004 / 90005 / 90006 且服务器当前库存大于 0 时开放“喂 1 份”；field 2 仍保持未知语义并固定使用官方实机值 1。
        </div>
        <div v-if="foods.length === 0" class="text-sm text-gray-500 dark:text-gray-400">当前没有返回狗粮数据。</div>
        <div v-else class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div v-for="food in foods" :key="`${food.id}-${food.duration}`" class="rounded-lg border border-gray-100 bg-gray-50 p-3 text-sm dark:border-gray-700 dark:bg-gray-900/30">
            <div class="flex items-start justify-between gap-2">
              <div>
                <div class="font-medium text-gray-800 dark:text-gray-100">{{ food.name || `狗粮 #${food.id}` }} ×{{ food.count }}</div>
                <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">ID {{ food.id }} · 持续 {{ formatTimeValue(food.duration) }}</div>
              </div>
              <span
                class="rounded px-2 py-0.5 text-[11px]"
                :class="food.writeSupported
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
                  : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'"
              >
                {{ food.writeSupported ? '已识别' : '只读' }}
              </span>
            </div>
            <div v-if="food.description" class="mt-2 text-xs text-gray-500 dark:text-gray-400">{{ food.description }}</div>
            <button
              v-if="food.writeSupported && overview.protocol?.foodWriteSupported"
              class="mt-3 w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="feedingFoodId !== null || food.count <= 0"
              @click="feedOnce(food)"
            >
              {{ feedingFoodId === food.id ? '喂食中…' : '喂 1 份' }}
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
