<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'

interface IllustratedItem {
  seedId: number
  name: string
  image: string
  unlocked: boolean
  planted: boolean
  plantedCount: number
  harvestCount: number
  category: number
  hasReward: boolean
}

interface IllustratedData {
  items: IllustratedItem[]
  summary: {
    total: number
    unlocked: number
    locked: number
    planted: number
    rewardReady: number
  }
  protocol: {
    service: string
    method: string
    version: number
  }
}

interface ShopProfile {
  shopId: number
  shopName: string
  shopType: number
  shopTypeLabel: string
}

interface ShopProfilesData {
  shops: ShopProfile[]
  summary: {
    total: number
    seedShops: number
    petShops: number
    itemShops: number
  }
}

interface ShopGoods {
  goodsId: number
  itemId: number
  name: string
  image: string
  itemCount: number
  price: number
  boughtNum: number
  limitCount: number
  unlocked: boolean
  conditions: Array<{ type: number, param: number }>
}

interface ShopInfoData {
  shopId: number
  goods: ShopGoods[]
  summary: {
    total: number
    unlocked: number
    locked: number
    limited: number
  }
}

const accountStore = useAccountStore()
const { currentAccount } = storeToRefs(accountStore)

const activeTab = ref<'illustrated' | 'shops'>('illustrated')
const illustrated = ref<IllustratedData | null>(null)
const shops = ref<ShopProfilesData | null>(null)
const shopInfo = ref<ShopInfoData | null>(null)
const selectedShopId = ref(0)
const illustratedLoading = ref(false)
const shopsLoading = ref(false)
const shopInfoLoading = ref(false)
const illustratedError = ref('')
const shopsError = ref('')
const search = ref('')
const illustratedFilter = ref<'all' | 'unlocked' | 'locked' | 'reward'>('all')

const filteredIllustrated = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  return (illustrated.value?.items || []).filter((item) => {
    if (illustratedFilter.value === 'unlocked' && !item.unlocked)
      return false
    if (illustratedFilter.value === 'locked' && item.unlocked)
      return false
    if (illustratedFilter.value === 'reward' && !item.hasReward)
      return false
    if (!keyword)
      return true
    return item.name.toLowerCase().includes(keyword) || String(item.seedId).includes(keyword)
  })
})

const selectedShop = computed(() => (shops.value?.shops || []).find(shop => shop.shopId === selectedShopId.value) || null)

function errorText(error: any, fallback: string) {
  return String(error?.response?.data?.error || error?.response?.data?.message || error?.message || fallback)
}

function numberText(value: number) {
  return new Intl.NumberFormat('zh-CN').format(Math.max(0, Number(value) || 0))
}

function conditionText(condition: { type: number, param: number }) {
  if (condition.type === 1)
    return `Lv${condition.param}`
  if (condition.type === 2)
    return '需解锁卡'
  return `条件${condition.type}:${condition.param}`
}

async function loadIllustrated() {
  illustratedLoading.value = true
  illustratedError.value = ''
  try {
    const res = await api.get('/api/catalog/illustrated')
    if (!res.data?.ok)
      throw new Error(res.data?.error || '图鉴读取失败')
    illustrated.value = res.data.data
  }
  catch (error: any) {
    illustrated.value = null
    illustratedError.value = errorText(error, '图鉴读取失败')
  }
  finally {
    illustratedLoading.value = false
  }
}

async function loadShopInfo(shopId: number) {
  if (!shopId)
    return
  selectedShopId.value = shopId
  shopInfoLoading.value = true
  shopsError.value = ''
  try {
    const res = await api.get(`/api/catalog/shops/${shopId}`)
    if (!res.data?.ok)
      throw new Error(res.data?.error || '商店商品读取失败')
    shopInfo.value = res.data.data
  }
  catch (error: any) {
    shopInfo.value = null
    shopsError.value = errorText(error, '商店商品读取失败')
  }
  finally {
    shopInfoLoading.value = false
  }
}

async function loadShops() {
  shopsLoading.value = true
  shopsError.value = ''
  try {
    const res = await api.get('/api/catalog/shops')
    if (!res.data?.ok)
      throw new Error(res.data?.error || '商店列表读取失败')
    shops.value = res.data.data
    const list = shops.value?.shops || []
    const preferred = list.find(shop => shop.shopType === 2) || list[0]
    if (preferred)
      await loadShopInfo(preferred.shopId)
    else {
      selectedShopId.value = 0
      shopInfo.value = null
    }
  }
  catch (error: any) {
    shops.value = null
    shopInfo.value = null
    shopsError.value = errorText(error, '商店列表读取失败')
  }
  finally {
    shopsLoading.value = false
  }
}

async function switchTab(tab: 'illustrated' | 'shops') {
  activeTab.value = tab
  if (tab === 'illustrated' && !illustrated.value && !illustratedLoading.value)
    await loadIllustrated()
  if (tab === 'shops' && !shops.value && !shopsLoading.value)
    await loadShops()
}

async function refreshCurrent() {
  if (activeTab.value === 'illustrated')
    await loadIllustrated()
  else
    await loadShops()
}

onMounted(() => loadIllustrated())
</script>

<template>
  <div class="flex flex-col gap-5 pt-6">
    <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
      <div>
        <div class="flex items-center gap-2">
          <div class="i-carbon-book text-2xl" :style="{ color: 'var(--theme-primary)' }" />
          <h1 class="text-2xl font-bold">
            图鉴与商店
          </h1>
        </div>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          当前是只读协议探测版：读取真实图鉴、种子/道具/宠物商店，不会领奖，也不会购买任何商品。
        </p>
      </div>
      <div class="flex items-center gap-2">
        <span class="max-w-56 truncate text-xs text-gray-400">
          {{ currentAccount?.nick || currentAccount?.name || currentAccount?.uin || '未选择账号' }}
        </span>
        <button
          class="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-white disabled:opacity-60"
          :style="{ background: 'var(--theme-primary)' }"
          :disabled="illustratedLoading || shopsLoading || shopInfoLoading"
          @click="refreshCurrent"
        >
          <div class="i-carbon-renew" :class="(illustratedLoading || shopsLoading || shopInfoLoading) ? 'animate-spin' : ''" />
          重新读取
        </button>
      </div>
    </div>

    <div class="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700 dark:border-blue-900/40 dark:bg-blue-950/20 dark:text-blue-300">
      <div class="flex items-start gap-2">
        <div class="i-carbon-information mt-0.5 shrink-0" />
        <div>
          这一版专门确认后续版本留下的协议在当前游戏是否仍有效。若失败，页面会直接显示真实后端错误；确认可读后再开放“领取图鉴奖励”和“购买缺失种子”。
        </div>
      </div>
    </div>

    <div class="flex gap-2 border-b border-gray-200 dark:border-gray-700">
      <button
        class="border-b-2 px-4 py-3 text-sm font-medium transition-colors"
        :class="activeTab === 'illustrated' ? 'border-current' : 'border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'"
        :style="activeTab === 'illustrated' ? { color: 'var(--theme-primary)' } : {}"
        @click="switchTab('illustrated')"
      >
        图鉴
      </button>
      <button
        class="border-b-2 px-4 py-3 text-sm font-medium transition-colors"
        :class="activeTab === 'shops' ? 'border-current' : 'border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'"
        :style="activeTab === 'shops' ? { color: 'var(--theme-primary)' } : {}"
        @click="switchTab('shops')"
      >
        商店探测
      </button>
    </div>

    <template v-if="activeTab === 'illustrated'">
      <div
        v-if="illustratedError"
        class="rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900/40 dark:bg-red-950/20"
      >
        <div class="font-semibold text-red-700 dark:text-red-300">
          图鉴协议读取失败
        </div>
        <div class="mt-2 break-all font-mono text-xs text-red-600 dark:text-red-400">
          {{ illustratedError }}
        </div>
      </div>

      <div v-if="illustrated" class="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <div class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500">图鉴总数</div>
          <div class="mt-1 text-2xl font-bold">{{ illustrated.summary.total }}</div>
        </div>
        <div class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500">已解锁</div>
          <div class="mt-1 text-2xl font-bold text-emerald-600">{{ illustrated.summary.unlocked }}</div>
        </div>
        <div class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500">未解锁</div>
          <div class="mt-1 text-2xl font-bold">{{ illustrated.summary.locked }}</div>
        </div>
        <div class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500">种植过</div>
          <div class="mt-1 text-2xl font-bold">{{ illustrated.summary.planted }}</div>
        </div>
        <div class="col-span-2 rounded-xl border border-gray-200 bg-white p-4 lg:col-span-1 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500">可领奖</div>
          <div class="mt-1 text-2xl font-bold text-amber-600">{{ illustrated.summary.rewardReady }}</div>
        </div>
      </div>

      <div v-if="illustrated" class="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between dark:border-gray-700 dark:bg-gray-800">
        <div class="flex flex-wrap gap-2">
          <button
            v-for="item in [
              { key: 'all', label: '全部' },
              { key: 'unlocked', label: '已解锁' },
              { key: 'locked', label: '未解锁' },
              { key: 'reward', label: '可领奖' },
            ]"
            :key="item.key"
            class="rounded-lg px-3 py-1.5 text-xs font-medium"
            :class="illustratedFilter === item.key ? 'text-white' : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'"
            :style="illustratedFilter === item.key ? { background: 'var(--theme-primary)' } : {}"
            @click="illustratedFilter = item.key as typeof illustratedFilter"
          >
            {{ item.label }}
          </button>
        </div>
        <div class="relative sm:w-64">
          <div class="i-carbon-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            v-model="search"
            class="w-full border border-gray-200 rounded-lg bg-transparent py-2 pl-9 pr-3 text-sm outline-none focus:border-gray-400 dark:border-gray-700"
            placeholder="搜索名称 / seedId"
          >
        </div>
      </div>

      <div v-if="illustratedLoading && !illustrated" class="flex items-center justify-center py-20 text-gray-500">
        <div class="i-carbon-renew mr-2 animate-spin text-xl" />
        正在请求当前游戏图鉴协议...
      </div>

      <div v-else-if="illustrated" class="grid grid-cols-2 gap-3 xl:grid-cols-6 lg:grid-cols-5 md:grid-cols-4 sm:grid-cols-3">
        <div
          v-for="item in filteredIllustrated"
          :key="item.seedId"
          class="relative overflow-hidden rounded-xl border bg-white p-3 dark:bg-gray-800"
          :class="item.unlocked ? 'border-gray-200 dark:border-gray-700' : 'border-dashed border-gray-300 opacity-70 dark:border-gray-600'"
        >
          <div v-if="item.hasReward" class="absolute right-2 top-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
            可领奖
          </div>
          <div class="h-20 flex items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-900/40">
            <img v-if="item.image" :src="item.image" :alt="item.name" class="max-h-16 max-w-16 object-contain">
            <div v-else class="i-carbon-sprout text-3xl text-gray-300" />
          </div>
          <div class="mt-3 truncate text-sm font-semibold" :title="item.name">
            {{ item.name }}
          </div>
          <div class="mt-1 text-[11px] text-gray-400">Seed {{ item.seedId }}</div>
          <div class="mt-2 flex items-center justify-between text-xs">
            <span :class="item.unlocked ? 'text-emerald-600' : 'text-gray-400'">
              {{ item.unlocked ? '已解锁' : '未解锁' }}
            </span>
            <span class="text-gray-400">分类 {{ item.category }}</span>
          </div>
          <div class="mt-2 grid grid-cols-2 gap-2 text-[11px] text-gray-500">
            <div>种植 {{ numberText(item.plantedCount) }}</div>
            <div>收获 {{ numberText(item.harvestCount) }}</div>
          </div>
        </div>
      </div>

      <div v-if="illustrated && filteredIllustrated.length === 0" class="rounded-xl border border-dashed border-gray-300 py-16 text-center text-sm text-gray-500 dark:border-gray-700">
        没有符合当前筛选条件的图鉴条目。
      </div>

      <div v-if="illustrated" class="text-right font-mono text-[11px] text-gray-400">
        {{ illustrated.protocol.service }} / {{ illustrated.protocol.method }} · V{{ illustrated.protocol.version }}
      </div>
    </template>

    <template v-else>
      <div
        v-if="shopsError"
        class="rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900/40 dark:bg-red-950/20"
      >
        <div class="font-semibold text-red-700 dark:text-red-300">
          商店协议读取失败
        </div>
        <div class="mt-2 break-all font-mono text-xs text-red-600 dark:text-red-400">
          {{ shopsError }}
        </div>
      </div>

      <div v-if="shops" class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500">商店总数</div>
          <div class="mt-1 text-2xl font-bold">{{ shops.summary.total }}</div>
        </div>
        <div class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500">种子商店</div>
          <div class="mt-1 text-2xl font-bold">{{ shops.summary.seedShops }}</div>
        </div>
        <div class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500">道具商店</div>
          <div class="mt-1 text-2xl font-bold">{{ shops.summary.itemShops }}</div>
        </div>
        <div class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500">宠物商店</div>
          <div class="mt-1 text-2xl font-bold">{{ shops.summary.petShops }}</div>
        </div>
      </div>

      <div v-if="shops" class="flex flex-wrap gap-2">
        <button
          v-for="shop in shops.shops"
          :key="shop.shopId"
          class="rounded-lg border px-3 py-2 text-sm transition-colors"
          :class="selectedShopId === shop.shopId ? 'text-white' : 'border-gray-200 bg-white text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300'"
          :style="selectedShopId === shop.shopId ? { background: 'var(--theme-primary)', borderColor: 'var(--theme-primary)' } : {}"
          @click="loadShopInfo(shop.shopId)"
        >
          {{ shop.shopName || shop.shopTypeLabel }}
          <span class="ml-1 text-xs opacity-70">#{{ shop.shopId }} · {{ shop.shopTypeLabel }}</span>
        </button>
      </div>

      <div v-if="shopsLoading && !shops" class="flex items-center justify-center py-20 text-gray-500">
        <div class="i-carbon-renew mr-2 animate-spin text-xl" />
        正在请求当前游戏商店协议...
      </div>

      <div v-if="selectedShop && shopInfo" class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <div class="flex flex-col gap-2 border-b border-gray-100 pb-4 sm:flex-row sm:items-center sm:justify-between dark:border-gray-700">
          <div>
            <div class="text-lg font-bold">{{ selectedShop.shopName || selectedShop.shopTypeLabel }}</div>
            <div class="mt-1 text-xs text-gray-400">Shop #{{ selectedShop.shopId }} · {{ selectedShop.shopTypeLabel }}</div>
          </div>
          <div class="text-xs text-gray-500">
            商品 {{ shopInfo.summary.total }} · 已解锁 {{ shopInfo.summary.unlocked }} · 限购 {{ shopInfo.summary.limited }}
          </div>
        </div>

        <div v-if="shopInfoLoading" class="flex items-center justify-center py-12 text-gray-500">
          <div class="i-carbon-renew mr-2 animate-spin" />
          读取商品中...
        </div>

        <div v-else class="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-4 lg:grid-cols-3 sm:grid-cols-2">
          <div
            v-for="goods in shopInfo.goods"
            :key="goods.goodsId"
            class="rounded-xl border p-4"
            :class="goods.unlocked ? 'border-gray-200 dark:border-gray-700' : 'border-dashed border-gray-300 opacity-70 dark:border-gray-600'"
          >
            <div class="flex gap-3">
              <div class="h-16 w-16 flex shrink-0 items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-900/40">
                <img v-if="goods.image" :src="goods.image" :alt="goods.name" class="max-h-14 max-w-14 object-contain">
                <div v-else class="i-carbon-shopping-catalog text-2xl text-gray-300" />
              </div>
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm font-semibold" :title="goods.name">{{ goods.name }}</div>
                <div class="mt-1 text-[11px] text-gray-400">Item {{ goods.itemId }} · Goods {{ goods.goodsId }}</div>
                <div class="mt-2 text-base font-bold">{{ numberText(goods.price) }} 金币</div>
              </div>
            </div>
            <div class="mt-3 grid grid-cols-2 gap-2 text-xs text-gray-500">
              <div>每份 ×{{ goods.itemCount || 1 }}</div>
              <div>已买 {{ goods.boughtNum }}</div>
              <div>{{ goods.limitCount > 0 ? `限购 ${goods.limitCount}` : '不限购' }}</div>
              <div :class="goods.unlocked ? 'text-emerald-600' : 'text-gray-400'">{{ goods.unlocked ? '已解锁' : '未解锁' }}</div>
            </div>
            <div v-if="goods.conditions.length" class="mt-2 flex flex-wrap gap-1">
              <span v-for="condition in goods.conditions" :key="`${condition.type}-${condition.param}`" class="rounded bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500 dark:bg-gray-700 dark:text-gray-300">
                {{ conditionText(condition) }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="shops && shops.shops.length === 0" class="rounded-xl border border-dashed border-gray-300 py-16 text-center text-sm text-gray-500 dark:border-gray-700">
        协议请求成功，但当前服务器没有返回商店列表。
      </div>
    </template>
  </div>
</template>
