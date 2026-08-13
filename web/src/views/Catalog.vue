<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'

interface IllustratedItem {
  illustratedId: number
  fruitId: number
  seedId: number
  name: string
  image: string
  illustratedType: number
  illustratedTypeLabel: string
  illustratedTier: number
  unlocked: boolean
  rewardScore: number
  harvestCount: number
  hasReward: boolean
  rewardFlag?: boolean
}

interface IllustratedData {
  illustratedType: number
  illustratedTypeLabel: string
  items: IllustratedItem[]
  summary: {
    total: number
    unlocked: number
    locked: number
    rewardReady: number
    rewardFlagged?: number
    rewardSemanticsVerified?: boolean
    currentScore: number
    level: number
    currentTier: number
    nextScore: number
    hasLevelReward: boolean
    unlockedTiers: number[]
  }
  protocol: {
    service: string
    method: string
    version: number
    schema: string
    decodeMode: string
    decodeWarning?: string
    rewardSemantics?: string
  }
}

interface PurchasePlanItem {
  fruitId: number
  seedId: number
  name: string
  image: string
  illustratedTier: number
  ownedCount: number
  canBuy: boolean
  reason: string
  goodsId: number
  price: number
  itemCount: number
  boughtNum: number
  limitCount: number
}

interface PurchasePlan {
  shop: { shopId: number, shopName: string, shopType: number, shopTypeLabel: string }
  items: PurchasePlanItem[]
  summary: {
    locked: number
    alreadyOwned: number
    buyable: number
    totalCost: number
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
  summary: { total: number, seedShops: number, petShops: number, itemShops: number }
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
  summary: { total: number, unlocked: number, locked: number, limited: number }
}

const accountStore = useAccountStore()
const { currentAccount } = storeToRefs(accountStore)

const activeTab = ref<'illustrated' | 'shops'>('illustrated')
const illustrated = ref<IllustratedData | null>(null)
const purchasePlan = ref<PurchasePlan | null>(null)
const shops = ref<ShopProfilesData | null>(null)
const shopInfo = ref<ShopInfoData | null>(null)
const selectedShopId = ref(0)
const illustratedLoading = ref(false)
const planLoading = ref(false)
const shopsLoading = ref(false)
const shopInfoLoading = ref(false)
const actionLoading = ref('')
const illustratedError = ref('')
const shopsError = ref('')
const actionMessage = ref('')
const actionError = ref('')
const search = ref('')
const illustratedFilter = ref<'all' | 'unlocked' | 'locked' | 'buyable'>('all')

const planByFruitId = computed(() => {
  const map = new Map<number, PurchasePlanItem>()
  for (const item of purchasePlan.value?.items || [])
    map.set(item.fruitId, item)
  return map
})

const filteredIllustrated = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  return (illustrated.value?.items || []).filter((item) => {
    const plan = planByFruitId.value.get(item.fruitId)
    if (illustratedFilter.value === 'unlocked' && !item.unlocked)
      return false
    if (illustratedFilter.value === 'locked' && item.unlocked)
      return false
    if (illustratedFilter.value === 'buyable' && !plan?.canBuy)
      return false
    if (!keyword)
      return true
    return item.name.toLowerCase().includes(keyword)
      || String(item.fruitId).includes(keyword)
      || String(item.seedId).includes(keyword)
  })
})

const selectedShop = computed(() => (shops.value?.shops || []).find(shop => shop.shopId === selectedShopId.value) || null)
const busy = computed(() => illustratedLoading.value || planLoading.value || shopsLoading.value || shopInfoLoading.value || !!actionLoading.value)

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

function petGoodsBlockReason(goods: ShopGoods) {
  if (!goods.unlocked)
    return '尚未解锁'
  if (goods.limitCount > 0 && goods.boughtNum >= goods.limitCount)
    return '已达限购'
  return ''
}

function rewardText(items: Array<{ name?: string, id?: number, count?: number }> = []) {
  return items.map(item => `${item.name || `物品${item.id || 0}`}×${Math.max(1, Number(item.count) || 1)}`).join('、')
}

function clearActionState() {
  actionMessage.value = ''
  actionError.value = ''
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

async function loadPurchasePlan() {
  clearActionState()
  planLoading.value = true
  try {
    const res = await api.get('/api/catalog/illustrated/purchase-plan')
    if (!res.data?.ok)
      throw new Error(res.data?.error || '缺失种子分析失败')
    purchasePlan.value = res.data.data
  }
  catch (error: any) {
    purchasePlan.value = null
    actionError.value = errorText(error, '缺失种子分析失败')
  }
  finally {
    planLoading.value = false
  }
}

async function refreshIllustratedWorkspace() {
  clearActionState()
  await loadIllustrated()
  if (purchasePlan.value)
    await loadPurchasePlan()
}

async function buyOneSeed(item: PurchasePlanItem) {
  if (!item.canBuy || !item.goodsId)
    return
  if (!window.confirm(`购买「${item.name}」对应种子 1 份？\n价格：${numberText(item.price)} 金币`))
    return
  clearActionState()
  actionLoading.value = `buy-${item.goodsId}`
  try {
    const res = await api.post('/api/catalog/illustrated/buy-seed', { goodsId: item.goodsId })
    if (!res.data?.ok)
      throw new Error(res.data?.error || '购买失败')
    actionMessage.value = `已购买 ${item.name} 对应种子 1 份，价格 ${numberText(item.price)} 金币。`
    await loadPurchasePlan()
  }
  catch (error: any) {
    actionError.value = errorText(error, '购买种子失败')
  }
  finally {
    actionLoading.value = ''
  }
}

async function buyAllMissingSeeds() {
  const summary = purchasePlan.value?.summary
  if (!summary || summary.buyable <= 0)
    return
  const message = `将为当前未解锁图鉴中“背包没有、商店已解锁”的 ${summary.buyable} 种种子各买 1 份。\n预计总价：${numberText(summary.totalCost)} 金币。\n\n确认继续？`
  if (!window.confirm(message))
    return
  clearActionState()
  actionLoading.value = 'buy-all'
  try {
    const res = await api.post('/api/catalog/illustrated/buy-missing-seeds', {
      expectedBuyable: summary.buyable,
      expectedTotalCost: summary.totalCost,
    })
    if (!res.data?.ok)
      throw new Error(res.data?.error || '批量购买失败')
    const data = res.data.data || {}
    actionMessage.value = `一键购买完成：成功 ${data.successCount || 0}，失败 ${data.failCount || 0}，预计消耗 ${numberText(data.spentEstimate || 0)} 金币。`
    await loadPurchasePlan()
  }
  catch (error: any) {
    actionError.value = errorText(error, '批量购买种子失败')
  }
  finally {
    actionLoading.value = ''
  }
}

async function buyPetGoods(goods: ShopGoods) {
  if (selectedShop.value?.shopType !== 3)
    return
  const blocked = petGoodsBlockReason(goods)
  if (blocked) {
    actionError.value = `当前不可购买：${blocked}`
    return
  }
  if (!window.confirm(`购买「${goods.name}」1 份？\n服务器当前显示价格：${numberText(goods.price)} 金币\n\n提交时会重新读取服务器价格、解锁和限购状态。`))
    return

  clearActionState()
  actionLoading.value = `pet-buy-${goods.goodsId}`
  try {
    const res = await api.post('/api/catalog/pet-shop/buy', { goodsId: goods.goodsId })
    if (!res.data?.ok)
      throw new Error(res.data?.error || '宠物购买失败')
    const data = res.data.data || {}
    const purchase = data.purchase || {}
    const got = rewardText(purchase.getItems || [])
    const cost = rewardText(purchase.costItems || [])
    actionMessage.value = `宠物购买成功：${purchase.name || goods.name}，实际价格 ${numberText(purchase.price || goods.price)} 金币${got ? `；获得 ${got}` : ''}${cost ? `；消耗 ${cost}` : ''}。`
    await loadShopInfo(selectedShopId.value)
  }
  catch (error: any) {
    actionError.value = errorText(error, '宠物购买失败')
    await loadShopInfo(selectedShopId.value)
  }
  finally {
    actionLoading.value = ''
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
  clearActionState()
  if (tab === 'illustrated' && !illustrated.value && !illustratedLoading.value)
    await loadIllustrated()
  if (tab === 'shops' && !shops.value && !shopsLoading.value)
    await loadShops()
}

async function refreshCurrent() {
  if (activeTab.value === 'illustrated')
    await refreshIllustratedWorkspace()
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
          <h1 class="text-2xl font-bold">图鉴与商店</h1>
        </div>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          默认只读取作物图鉴；缺失种子和商店按需读取，避免影响正在运行的巡田、好友和任务请求。
        </p>
      </div>
      <div class="flex items-center gap-2">
        <span class="max-w-56 truncate text-xs text-gray-400">
          {{ currentAccount?.nick || currentAccount?.name || currentAccount?.uin || '未选择账号' }}
        </span>
        <button
          class="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-white disabled:opacity-60"
          :style="{ background: 'var(--theme-primary)' }"
          :disabled="busy"
          @click="refreshCurrent"
        >
          <div class="i-carbon-renew" :class="busy ? 'animate-spin' : ''" />
          重新读取
        </button>
      </div>
    </div>

    <div v-if="actionMessage" class="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-300">
      {{ actionMessage }}
    </div>
    <div v-if="actionError" class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/20 dark:text-red-300">
      {{ actionError }}
    </div>

    <div class="flex gap-2 border-b border-gray-200 dark:border-gray-700">
      <button
        class="border-b-2 px-4 py-3 text-sm font-medium transition-colors"
        :class="activeTab === 'illustrated' ? 'border-current' : 'border-transparent text-gray-500'"
        :style="activeTab === 'illustrated' ? { color: 'var(--theme-primary)' } : {}"
        @click="switchTab('illustrated')"
      >
        作物图鉴
      </button>
      <button
        class="border-b-2 px-4 py-3 text-sm font-medium transition-colors"
        :class="activeTab === 'shops' ? 'border-current' : 'border-transparent text-gray-500'"
        :style="activeTab === 'shops' ? { color: 'var(--theme-primary)' } : {}"
        @click="switchTab('shops')"
      >
        商店
      </button>
    </div>

    <template v-if="activeTab === 'illustrated'">
      <div v-if="illustratedError" class="rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900/40 dark:bg-red-950/20">
        <div class="font-semibold text-red-700 dark:text-red-300">图鉴读取失败</div>
        <div class="mt-2 break-all font-mono text-xs text-red-600 dark:text-red-400">{{ illustratedError }}</div>
      </div>

      <div v-if="illustrated" class="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <div class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500">图鉴总数</div><div class="mt-1 text-2xl font-bold">{{ illustrated.summary.total }}</div>
        </div>
        <div class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500">已解锁</div><div class="mt-1 text-2xl font-bold text-emerald-600">{{ illustrated.summary.unlocked }}</div>
        </div>
        <div class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500">当前积分</div><div class="mt-1 text-2xl font-bold">{{ numberText(illustrated.summary.currentScore) }}</div>
        </div>
        <div class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500">图鉴等级</div><div class="mt-1 text-2xl font-bold">Lv{{ illustrated.summary.level }}</div>
        </div>
        <div class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500">当前 Tier</div><div class="mt-1 text-2xl font-bold">{{ illustrated.summary.currentTier }}</div>
        </div>
        <div class="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/40 dark:bg-amber-950/20">
          <div class="text-xs text-amber-700 dark:text-amber-300">奖励状态</div>
          <div class="mt-1 text-xl font-bold text-amber-700 dark:text-amber-300">待确认</div>
        </div>
      </div>

      <div v-if="illustrated" class="grid gap-3 lg:grid-cols-2">
        <div class="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/40 dark:bg-amber-950/20">
          <div class="font-semibold text-amber-800 dark:text-amber-300">图鉴奖励暂不开放领取</div>
          <div class="mt-1 text-xs leading-5 text-amber-700 dark:text-amber-400">
            当前协议里的奖励标记不能可靠区分“已领取”和“未领取”。在字段语义完成实机确认前，领取接口已锁定，不会向游戏发送领奖请求。
          </div>
        </div>

        <div class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div class="font-semibold">补齐缺失种子</div>
              <div v-if="purchasePlan" class="mt-1 text-xs text-gray-500">
                未解锁 {{ purchasePlan.summary.locked }} · 背包已有 {{ purchasePlan.summary.alreadyOwned }} · 可买 {{ purchasePlan.summary.buyable }} · 预计 {{ numberText(purchasePlan.summary.totalCost) }} 金币
              </div>
              <div v-else class="mt-1 text-xs text-gray-500">
                {{ planLoading ? '正在串行分析图鉴、种子商店和背包...' : '按需分析，不会在打开页面时自动追加多组游戏请求。' }}
              </div>
            </div>
            <div class="flex gap-2">
              <button
                v-if="!purchasePlan"
                class="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                :disabled="busy"
                @click="loadPurchasePlan"
              >
                {{ planLoading ? '分析中...' : '分析缺失种子' }}
              </button>
              <button
                v-else
                class="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-600 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
                :disabled="busy"
                @click="loadPurchasePlan"
              >
                重新分析
              </button>
              <button
                v-if="purchasePlan"
                class="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
                :disabled="busy || purchasePlan.summary.buyable <= 0"
                @click="buyAllMissingSeeds"
              >
                {{ actionLoading === 'buy-all' ? '购买中...' : '一键各买 1 份' }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div v-if="illustrated?.protocol.decodeMode === 'wire-fallback'" class="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-700 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-300">
        标准 Proto 解码仍有字段漂移，本次已自动使用线级容错解析：{{ illustrated.protocol.decodeWarning }}
      </div>

      <div v-if="illustrated" class="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between dark:border-gray-700 dark:bg-gray-800">
        <div class="flex flex-wrap gap-2">
          <button
            v-for="item in [
              { key: 'all', label: '全部' },
              { key: 'unlocked', label: '已解锁' },
              { key: 'locked', label: '未解锁' },
              { key: 'buyable', label: '缺失可买' },
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
        <div class="relative sm:w-72">
          <div class="i-carbon-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input v-model="search" class="w-full border border-gray-200 rounded-lg bg-transparent py-2 pl-9 pr-3 text-sm outline-none dark:border-gray-700" placeholder="搜索名称 / 果实ID / 种子ID">
        </div>
      </div>

      <div v-if="illustratedLoading && !illustrated" class="flex items-center justify-center py-20 text-gray-500">
        <div class="i-carbon-renew mr-2 animate-spin text-xl" />正在读取当前作物图鉴...
      </div>

      <div v-else-if="illustrated" class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        <div
          v-for="item in filteredIllustrated"
          :key="item.fruitId"
          class="relative overflow-hidden rounded-xl border bg-white p-3 dark:bg-gray-800"
          :class="item.unlocked ? 'border-gray-200 dark:border-gray-700' : 'border-dashed border-gray-300 dark:border-gray-600'"
        >
          <div class="h-20 flex items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-900/40">
            <img v-if="item.image" :src="item.image" :alt="item.name" class="max-h-16 max-w-16 object-contain">
            <div v-else class="i-carbon-sprout text-3xl text-gray-300" />
          </div>
          <div class="mt-3 truncate text-sm font-semibold" :title="item.name">{{ item.name }}</div>
          <div class="mt-1 text-[11px] text-gray-400">
            果实 {{ item.fruitId }}<span v-if="item.seedId"> · 种子 {{ item.seedId }}</span>
          </div>
          <div class="mt-2 flex items-center justify-between text-xs">
            <span :class="item.unlocked ? 'text-emerald-600' : 'text-gray-400'">{{ item.unlocked ? '已解锁' : '未解锁' }}</span>
            <span class="text-gray-400">Tier {{ item.illustratedTier }}</span>
          </div>
          <div class="mt-2 grid grid-cols-2 gap-2 text-[11px] text-gray-500">
            <div>奖励分 {{ numberText(item.rewardScore) }}</div>
            <div>收获 {{ numberText(item.harvestCount) }}</div>
          </div>

          <div v-if="!item.unlocked && planByFruitId.get(item.fruitId)" class="mt-3 border-t border-gray-100 pt-3 dark:border-gray-700">
            <template v-if="planByFruitId.get(item.fruitId)?.canBuy">
              <div class="mb-2 flex items-center justify-between text-xs">
                <span class="text-amber-600">缺失种子</span>
                <span class="font-medium">{{ numberText(planByFruitId.get(item.fruitId)?.price || 0) }} 金币</span>
              </div>
              <button
                class="w-full rounded-lg border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs font-medium text-amber-700 disabled:opacity-50 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
                :disabled="busy"
                @click="buyOneSeed(planByFruitId.get(item.fruitId)!)"
              >
                {{ actionLoading === `buy-${planByFruitId.get(item.fruitId)?.goodsId}` ? '购买中...' : '买 1 份种子' }}
              </button>
            </template>
            <div v-else class="text-[11px] text-gray-400">
              {{ planByFruitId.get(item.fruitId)?.reason || '当前不可购买' }}
            </div>
          </div>
        </div>
      </div>

      <div v-if="illustrated && filteredIllustrated.length === 0" class="rounded-xl border border-dashed border-gray-300 py-16 text-center text-sm text-gray-500 dark:border-gray-700">
        没有符合当前筛选条件的图鉴条目。
      </div>

      <div v-if="illustrated" class="flex flex-wrap justify-end gap-3 font-mono text-[11px] text-gray-400">
        <span>{{ illustrated.protocol.service }} / {{ illustrated.protocol.method }}</span>
        <span>{{ illustrated.protocol.schema }}</span>
        <span>{{ illustrated.protocol.decodeMode }}</span>
      </div>
    </template>

    <template v-else>
      <div v-if="shopsError" class="rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900/40 dark:bg-red-950/20">
        <div class="font-semibold text-red-700 dark:text-red-300">商店读取失败</div>
        <div class="mt-2 break-all font-mono text-xs text-red-600 dark:text-red-400">{{ shopsError }}</div>
      </div>

      <div v-if="shops" class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800"><div class="text-xs text-gray-500">商店总数</div><div class="mt-1 text-2xl font-bold">{{ shops.summary.total }}</div></div>
        <div class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800"><div class="text-xs text-gray-500">种子商店</div><div class="mt-1 text-2xl font-bold">{{ shops.summary.seedShops }}</div></div>
        <div class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800"><div class="text-xs text-gray-500">道具商店</div><div class="mt-1 text-2xl font-bold">{{ shops.summary.itemShops }}</div></div>
        <div class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800"><div class="text-xs text-gray-500">宠物商店</div><div class="mt-1 text-2xl font-bold">{{ shops.summary.petShops }}</div></div>
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
        <div class="i-carbon-renew mr-2 animate-spin text-xl" />正在读取商店协议...
      </div>

      <div v-if="selectedShop && shopInfo" class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <div class="flex flex-col gap-2 border-b border-gray-100 pb-4 sm:flex-row sm:items-center sm:justify-between dark:border-gray-700">
          <div>
            <div class="text-lg font-bold">{{ selectedShop.shopName || selectedShop.shopTypeLabel }}</div>
            <div class="mt-1 text-xs text-gray-400">Shop #{{ selectedShop.shopId }} · {{ selectedShop.shopTypeLabel }}</div>
          </div>
          <div class="text-xs text-gray-500">商品 {{ shopInfo.summary.total }} · 已解锁 {{ shopInfo.summary.unlocked }} · 限购 {{ shopInfo.summary.limited }}</div>
        </div>

        <div v-if="shopInfoLoading" class="flex items-center justify-center py-12 text-gray-500"><div class="i-carbon-renew mr-2 animate-spin" />读取商品中...</div>
        <div v-else class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
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
              <div>每份 ×{{ goods.itemCount || 1 }}</div><div>已买 {{ goods.boughtNum }}</div>
              <div>{{ goods.limitCount > 0 ? `限购 ${goods.limitCount}` : '不限购' }}</div><div :class="goods.unlocked ? 'text-emerald-600' : 'text-gray-400'">{{ goods.unlocked ? '已解锁' : '未解锁' }}</div>
            </div>
            <div v-if="goods.conditions.length" class="mt-2 flex flex-wrap gap-1">
              <span v-for="condition in goods.conditions" :key="`${condition.type}-${condition.param}`" class="rounded bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500 dark:bg-gray-700 dark:text-gray-300">{{ conditionText(condition) }}</span>
            </div>
            <div v-if="selectedShop?.shopType === 3" class="mt-3 border-t border-gray-100 pt-3 dark:border-gray-700">
              <div v-if="petGoodsBlockReason(goods)" class="rounded-lg bg-gray-50 px-3 py-2 text-center text-xs text-gray-500 dark:bg-gray-900/30">
                {{ petGoodsBlockReason(goods) }}
              </div>
              <button
                v-else
                class="w-full rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700 disabled:opacity-50 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
                :disabled="busy"
                @click="buyPetGoods(goods)"
              >
                {{ actionLoading === `pet-buy-${goods.goodsId}` ? '购买中...' : `购买 ${numberText(goods.price)} 金币` }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
