<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'

interface CareerItem {
  id: number
  count: number
  name: string
  image: string
  level: number
  rarity: number
}

interface CareerPlayer {
  gid: number
  name: string
  avatar: string
  openid: string
  level: number
  exp: number
}

interface CareerOverview {
  player: CareerPlayer
  items: CareerItem[]
  levelStats: Array<{ id: number; count: number; name: string; image: string; level: number }>
  meta: {
    achievedLevels: number
    statsTotal: number
    statsCount: number
    rawBodyLength: number
    decodeMode: string
  }
}

const accountStore = useAccountStore()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)

const loading = ref(false)
const errorText = ref('')
const overview = ref<CareerOverview | null>(null)
const imageErrors = ref<Record<number, boolean>>({})
const avatarFailed = ref(false)

const accountRunning = computed(() => !!currentAccount.value?.running)
const items = computed(() => Array.isArray(overview.value?.items) ? overview.value!.items : [])
const topItems = computed(() => items.value.slice(0, 3))
const remainingItems = computed(() => items.value.slice(3))

function formatNumber(value: number) {
  const numeric = Number(value) || 0
  return Math.round(numeric).toLocaleString('zh-CN')
}

function onItemImageError(id: number) {
  imageErrors.value[id] = true
}

async function refresh() {
  if (!currentAccountId.value) {
    overview.value = null
    errorText.value = '请先选择账号'
    return
  }
  if (!accountRunning.value) {
    overview.value = null
    errorText.value = '当前账号未运行，启动账号后才能读取个人生涯'
    return
  }

  loading.value = true
  errorText.value = ''
  avatarFailed.value = false
  try {
    const response = await api.get('/api/career/info', { timeout: 15000 })
    if (!response.data?.ok)
      throw new Error(response.data?.error || '读取个人生涯失败')
    overview.value = response.data.data || null
  }
  catch (error: any) {
    overview.value = null
    errorText.value = String(error?.response?.data?.error || error?.message || '读取个人生涯失败')
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
          <div class="i-carbon-chart-histogram text-lg" />
          个人生涯
          <span class="rounded bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
            只读
          </span>
        </div>
        <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          读取 CareerService.CareerInfoGet；这里只展示生涯统计，不领取、不购买、不修改资料。
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
      <div class="rounded-lg bg-white p-4 shadow dark:bg-gray-800">
        <div class="flex flex-col gap-4 sm:flex-row sm:items-center">
          <img
            v-if="overview.player.avatar && !avatarFailed"
            :src="overview.player.avatar"
            :alt="overview.player.name"
            class="h-16 w-16 rounded-full bg-gray-100 object-cover"
            @error="avatarFailed = true"
          >
          <div v-else class="flex h-16 w-16 items-center justify-center rounded-full bg-gray-100 text-xl font-bold text-gray-500 dark:bg-gray-700 dark:text-gray-300">
            {{ (overview.player.name || '?').charAt(0) }}
          </div>
          <div class="min-w-0 flex-1">
            <div class="truncate text-lg font-semibold text-gray-900 dark:text-gray-100">
              {{ overview.player.name || '未返回昵称' }}
            </div>
            <div class="mt-1 flex flex-wrap gap-2 text-xs">
              <span class="rounded bg-orange-50 px-2 py-1 text-orange-700 dark:bg-orange-950/30 dark:text-orange-300">Lv{{ overview.player.level }}</span>
              <span class="rounded bg-blue-50 px-2 py-1 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300">经验 {{ formatNumber(overview.player.exp) }}</span>
              <span class="rounded bg-gray-100 px-2 py-1 text-gray-600 dark:bg-gray-700 dark:text-gray-300">GID {{ overview.player.gid || '-' }}</span>
            </div>
          </div>
          <div class="text-right text-[11px] text-gray-400">
            <div>解码: {{ overview.meta.decodeMode }}</div>
            <div>响应: {{ overview.meta.rawBodyLength }} bytes</div>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div class="rounded-lg bg-white p-4 shadow dark:bg-gray-800">
          <div class="text-xs text-gray-500 dark:text-gray-400">统计总量</div>
          <div class="mt-1 text-xl font-semibold text-gray-800 dark:text-gray-100">{{ formatNumber(overview.meta.statsTotal) }}</div>
        </div>
        <div class="rounded-lg bg-white p-4 shadow dark:bg-gray-800">
          <div class="text-xs text-gray-500 dark:text-gray-400">统计条目</div>
          <div class="mt-1 text-xl font-semibold text-gray-800 dark:text-gray-100">{{ items.length }}</div>
        </div>
        <div class="rounded-lg bg-white p-4 shadow dark:bg-gray-800">
          <div class="text-xs text-gray-500 dark:text-gray-400">服务端统计类型数</div>
          <div class="mt-1 text-xl font-semibold text-gray-800 dark:text-gray-100">{{ overview.meta.statsCount }}</div>
        </div>
        <div class="rounded-lg bg-white p-4 shadow dark:bg-gray-800">
          <div class="text-xs text-gray-500 dark:text-gray-400">达成等级数</div>
          <div class="mt-1 text-xl font-semibold text-gray-800 dark:text-gray-100">{{ overview.meta.achievedLevels }}</div>
        </div>
      </div>

      <div v-if="topItems.length" class="rounded-lg bg-white p-4 shadow dark:bg-gray-800">
        <div class="mb-3 font-semibold text-gray-800 dark:text-gray-100">收获 Top 3</div>
        <div class="grid grid-cols-3 gap-3">
          <div v-for="(item, index) in topItems" :key="item.id" class="rounded-lg border border-amber-100 bg-amber-50/50 p-3 text-center dark:border-amber-900/40 dark:bg-amber-950/10">
            <div class="mx-auto mb-2 flex h-7 w-7 items-center justify-center rounded-full bg-amber-500 text-xs font-bold text-white">{{ index + 1 }}</div>
            <img
              v-if="item.image && !imageErrors[item.id]"
              :src="item.image"
              :alt="item.name"
              class="mx-auto h-12 w-12 object-contain"
              @error="onItemImageError(item.id)"
            >
            <div v-else class="mx-auto flex h-12 w-12 items-center justify-center rounded bg-white/80 text-sm font-bold text-gray-500 dark:bg-gray-800">{{ item.name.charAt(0) || '?' }}</div>
            <div class="mt-2 truncate text-xs text-gray-600 dark:text-gray-300" :title="item.name">{{ item.name }}</div>
            <div class="mt-1 font-semibold text-gray-900 dark:text-gray-100">{{ formatNumber(item.count) }}</div>
          </div>
        </div>
      </div>

      <div class="rounded-lg bg-white p-4 shadow dark:bg-gray-800">
        <div class="mb-3 font-semibold text-gray-800 dark:text-gray-100">收获明细</div>
        <div v-if="items.length === 0" class="rounded-lg bg-gray-50 px-4 py-6 text-center text-sm text-gray-500 dark:bg-gray-900/30 dark:text-gray-400">
          CareerInfoGet 当前没有返回收获条目。
        </div>
        <div v-else class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
          <div v-for="item in remainingItems.length ? remainingItems : items" :key="`detail-${item.id}`" class="rounded-lg border border-gray-100 p-3 text-center dark:border-gray-700">
            <img
              v-if="item.image && !imageErrors[item.id]"
              :src="item.image"
              :alt="item.name"
              class="mx-auto h-10 w-10 object-contain"
              @error="onItemImageError(item.id)"
            >
            <div v-else class="mx-auto flex h-10 w-10 items-center justify-center rounded bg-gray-100 text-xs font-bold text-gray-500 dark:bg-gray-700 dark:text-gray-300">{{ item.name.charAt(0) || '?' }}</div>
            <div class="mt-2 truncate text-xs text-gray-600 dark:text-gray-300" :title="item.name">{{ item.name }}</div>
            <div class="mt-1 text-sm font-semibold text-gray-900 dark:text-gray-100">{{ formatNumber(item.count) }}</div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
