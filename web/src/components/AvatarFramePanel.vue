<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'

interface AvatarFrameItem {
  id: number
  count: number
  name: string
  image: string
  level: number
  priceId: number
  price: number
  priceUnit: string
  interactionType: string
  itemType: number
}

interface AvatarFrameOverview {
  itemType: number
  totalKinds: number
  totalCount: number
  frames: AvatarFrameItem[]
  equipped: {
    supported: boolean
    reason: string
  }
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
const overview = ref<AvatarFrameOverview | null>(null)
const imageErrors = ref<Record<number, boolean>>({})

const accountRunning = computed(() => !!currentAccount.value?.running)
const frames = computed(() => Array.isArray(overview.value?.frames) ? overview.value!.frames : [])

function onImageError(id: number) {
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
    errorText.value = '当前账号未运行，启动账号后才能读取头像框库存'
    return
  }

  loading.value = true
  errorText.value = ''
  try {
    const response = await api.get('/api/appearance/avatar-frames', { timeout: 15000 })
    if (!response.data?.ok)
      throw new Error(response.data?.error || '读取头像框库存失败')
    overview.value = response.data.data || null
  }
  catch (error: any) {
    overview.value = null
    errorText.value = String(error?.response?.data?.error || error?.message || '读取头像框库存失败')
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
          <div class="i-carbon-user-avatar-filled-alt text-lg" />
          头像框库存
          <span class="rounded bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
            只读
          </span>
        </div>
        <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          复用现有背包读取，只展示当前背包中实际拥有的 type=10 头像框；不会使用、购买或穿戴。
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
      <div class="grid grid-cols-2 gap-3 md:grid-cols-3">
        <div class="rounded-lg bg-white p-4 shadow dark:bg-gray-800">
          <div class="text-xs text-gray-500 dark:text-gray-400">已拥有种类</div>
          <div class="mt-1 text-xl font-semibold text-gray-800 dark:text-gray-100">{{ overview.totalKinds }}</div>
        </div>
        <div class="rounded-lg bg-white p-4 shadow dark:bg-gray-800">
          <div class="text-xs text-gray-500 dark:text-gray-400">库存总数</div>
          <div class="mt-1 text-xl font-semibold text-gray-800 dark:text-gray-100">{{ overview.totalCount }}</div>
        </div>
        <div class="col-span-2 rounded-lg bg-white p-4 shadow md:col-span-1 dark:bg-gray-800">
          <div class="text-xs text-gray-500 dark:text-gray-400">当前佩戴</div>
          <div class="mt-1 text-sm font-semibold text-amber-600 dark:text-amber-300">待协议确认</div>
          <div class="mt-1 text-[11px] text-gray-400">equip_avatar_frames 内部结构尚无可靠实机定义，不猜。</div>
        </div>
      </div>

      <div class="rounded-lg bg-white p-4 shadow dark:bg-gray-800">
        <div class="mb-3 flex items-center justify-between gap-3">
          <div class="font-semibold text-gray-800 dark:text-gray-100">已拥有头像框</div>
          <div class="text-xs text-gray-400">来源：ItemService.Bag / itemType=10</div>
        </div>

        <div v-if="frames.length === 0" class="rounded-lg bg-gray-50 px-4 py-8 text-center text-sm text-gray-500 dark:bg-gray-900/30 dark:text-gray-400">
          当前背包没有返回 type=10 的已拥有头像框。
        </div>
        <div v-else class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          <div v-for="frame in frames" :key="frame.id" class="rounded-lg border border-gray-100 p-3 text-center dark:border-gray-700">
            <img
              v-if="frame.image && !imageErrors[frame.id]"
              :src="frame.image"
              :alt="frame.name"
              class="mx-auto h-16 w-16 object-contain"
              @error="onImageError(frame.id)"
            >
            <div v-else class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-gray-100 text-lg font-bold text-gray-500 dark:bg-gray-700 dark:text-gray-300">
              {{ frame.name.charAt(0) || '?' }}
            </div>
            <div class="mt-2 truncate text-sm font-medium text-gray-800 dark:text-gray-100" :title="frame.name">{{ frame.name }}</div>
            <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">ID {{ frame.id }}</div>
            <div class="mt-1 inline-flex rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-950/30 dark:text-blue-300">×{{ frame.count }}</div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
