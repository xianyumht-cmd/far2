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
  }
}

const accountStore = useAccountStore()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)

const loading = ref(false)
const errorText = ref('')
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
  return `${Math.floor(numeric / 3600)} 小时`
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
          <span class="rounded bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
            只读
          </span>
        </div>
        <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          读取 DogService.GetDogInfo；本页不会喂食、领取礼包或修改宠物状态。
        </div>
      </div>
      <button
        class="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-700"
        :disabled="loading || !accountRunning"
        @click="refresh"
      >
        {{ loading ? '读取中…' : '刷新' }}
      </button>
    </div>

    <div v-if="errorText" class="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-300">
      {{ errorText }}
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
        <div class="mb-3 font-semibold text-gray-800 dark:text-gray-100">狗粮</div>
        <div v-if="foods.length === 0" class="text-sm text-gray-500 dark:text-gray-400">当前没有返回狗粮数据。</div>
        <div v-else class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <div v-for="food in foods" :key="`${food.id}-${food.duration}`" class="rounded-lg bg-gray-50 p-3 text-sm dark:bg-gray-900/30">
            <div class="font-medium text-gray-800 dark:text-gray-100">狗粮 #{{ food.id }} ×{{ food.count }}</div>
            <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">持续时间: {{ formatTimeValue(food.duration) }}</div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
