<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'

interface ActivityItemRef {
  id: number
  count: number
  name: string
  image: string
}

interface RandomShopItem {
  id: number
  name: string
  item: ActivityItemRef
  cost: ActivityItemRef
  stockCount: number
  boughtCount: number
  special: boolean
}

interface ExchangeShopItem {
  id: number
  name: string
  item: ActivityItemRef
  cost: ActivityItemRef
  status: number
  owned: boolean
  sort: number
  extra: string
}

interface DrawRewardItem {
  id: number
  rarity: number
  item: ActivityItemRef
  flag: number
  probability: string
}

interface ActivityEntry {
  id: number
  parentId: number
  type: number
  title: string
  payload: { raw: string; json: unknown; keys: string[] }
  startTime: number
  endTime: number
  sort: number
  visible: boolean
  status: number
  enabled: boolean
  activeByTime: boolean
  capabilities: { randomShop: boolean; exchangeShop: boolean; draw: boolean }
  randomShop: null | {
    items: RandomShopItem[]
    nextRefreshTime: number
    manualRefreshCost: number
    manualRefreshCurrencyId: number
    maxManualRefreshCount: number
    manualRefreshUsedCount: number
  }
  exchangeShop: null | { items: ExchangeShopItem[] }
  drawInfo: null | {
    freeRemainingCount: number
    maxFreeCount: number
    paidRemainingCount: number
    maxPaidCount: number
    paidCurrencyId: number
    paidPrice: number
    fallbackPrice: number
    rewards: DrawRewardItem[]
  }
  adapter: null | string
}

interface DiscoveryAction {
  kind: string
  count: number
  autoOperate: boolean
  reason: string
}

interface DiscoveryNode {
  id: number
  parentId: number
  type: number
  title: string
  visible: boolean
  enabled: boolean
  activeByTime: boolean
  capabilities: string[]
  structureFingerprint: string
  itemIds: number[]
  seedLikeItemIds: number[]
  signals: {
    freeDrawRemaining: number
    randomShopCandidates: number
    exchangeCandidates: number
  }
  potentialActions: DiscoveryAction[]
  writePolicy: {
    autoOperate: boolean
    reason: string
    requiredEvidence: string[]
  }
}

interface ActivityDiscovery {
  source: string
  groupSummary: {
    requested: number
    loaded: number
    failed: number
  }
  nodes: DiscoveryNode[]
  summary: {
    nodeCount: number
    activeNodeCount: number
    withRandomShop: number
    withExchangeShop: number
    withDraw: number
    potentialActionCount: number
    seedLikeItemIds: number[]
    structureFingerprints: string[]
  }
  operationFramework: {
    discoveryReadOnly: boolean
    autoOperateEnabled: boolean
    unknownStructuresFailClosed: boolean
  }
}

interface ActivityOverview {
  activities: ActivityEntry[]
  summary: {
    total: number
    visible: number
    active: number
    withRandomShop: number
    withExchangeShop: number
    withDraw: number
  }
  discovery?: ActivityDiscovery | null
  deepSummary?: ActivityDiscovery['summary'] | null
  groupSummary?: ActivityDiscovery['groupSummary']
  discoveryError?: string
  framework: {
    transport: string
    adapters: string[]
    operateEnabled: boolean
    readOnly: boolean
    listTransport?: string
    groupTransport?: string
    maxGroupsPerScan?: number
    cacheTtlMs?: number
    deepDiscovery?: boolean
    deepDiscoveryFallback?: boolean
    fallbackReason?: string
    autoOperateEnabled?: boolean
  }
}

const accountStore = useAccountStore()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)

const loading = ref(false)
const errorText = ref('')
const overview = ref<ActivityOverview | null>(null)
const showAll = ref(false)
const expandedPayloadIds = ref<number[]>([])
const expandedDiscoveryIds = ref<number[]>([])

const accountRunning = computed(() => !!currentAccount.value?.running)
const parentTitleMap = computed(() => new Map(
  (overview.value?.activities || []).map(item => [item.id, item.title]),
))
const displayedActivities = computed(() => {
  const items = Array.isArray(overview.value?.activities) ? overview.value!.activities : []
  const filtered = showAll.value ? items : items.filter(item => item.visible)
  return [...filtered].sort((a, b) => a.sort - b.sort || b.startTime - a.startTime || a.id - b.id)
})
const discoveryNodes = computed(() => overview.value?.discovery?.nodes || [])
const discoverySeedIds = computed(() => overview.value?.discovery?.summary?.seedLikeItemIds || [])

function formatTime(value: number) {
  const numeric = Number(value) || 0
  if (numeric <= 0)
    return '未设置'
  const date = new Date(numeric >= 1e12 ? numeric : numeric * 1000)
  if (Number.isNaN(date.getTime()))
    return String(value)
  return date.toLocaleString()
}

function activityStateText(item: ActivityEntry) {
  if (!item.visible)
    return '隐藏'
  if (!item.enabled)
    return '未启用'
  if (!item.activeByTime)
    return '非活动期'
  return '进行中'
}

function activityStateClass(item: ActivityEntry) {
  if (item.visible && item.enabled && item.activeByTime)
    return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
  if (!item.visible)
    return 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300'
  return 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'
}

function togglePayload(id: number) {
  if (expandedPayloadIds.value.includes(id))
    expandedPayloadIds.value = expandedPayloadIds.value.filter(item => item !== id)
  else
    expandedPayloadIds.value = [...expandedPayloadIds.value, id]
}

function isPayloadExpanded(id: number) {
  return expandedPayloadIds.value.includes(id)
}

function toggleDiscovery(id: number) {
  if (expandedDiscoveryIds.value.includes(id))
    expandedDiscoveryIds.value = expandedDiscoveryIds.value.filter(item => item !== id)
  else
    expandedDiscoveryIds.value = [...expandedDiscoveryIds.value, id]
}

function isDiscoveryExpanded(id: number) {
  return expandedDiscoveryIds.value.includes(id)
}

function actionLabel(kind: string) {
  if (kind === 'free-draw')
    return '免费抽取机会'
  if (kind === 'random-shop')
    return '随机商店候选'
  if (kind === 'exchange-shop')
    return '兑换候选'
  return kind
}

async function refresh() {
  if (!currentAccountId.value) {
    overview.value = null
    errorText.value = '请先选择账号'
    return
  }
  if (!accountRunning.value) {
    overview.value = null
    errorText.value = '当前账号未运行，启动账号后才能读取活动列表'
    return
  }

  loading.value = true
  errorText.value = ''
  try {
    const response = await api.get('/api/activities', { timeout: 30000 })
    if (!response.data?.ok)
      throw new Error(response.data?.error || '读取活动列表失败')
    overview.value = response.data.data || null
  }
  catch (error: any) {
    overview.value = null
    errorText.value = String(error?.response?.data?.error || error?.message || '读取活动列表失败')
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
        <div class="flex flex-wrap items-center gap-2 font-semibold text-gray-800 dark:text-gray-100">
          <div class="i-carbon-events text-lg" />
          活动中心
          <span class="rounded bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
            深度只读发现
          </span>
        </div>
        <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          自动读取 ActivityService.List + GetGroup，识别活动结构、奖励和潜在动作。当前没有任何活动写协议，不购买、不刷新、不抽奖、不领取。
        </div>
      </div>
      <div class="flex items-center gap-2">
        <label class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          <input v-model="showAll" type="checkbox" class="rounded border-gray-300">
          显示隐藏/未启用
        </label>
        <button
          class="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-700"
          :disabled="loading || !accountRunning"
          @click="refresh"
        >
          {{ loading ? '发现中…' : '刷新' }}
        </button>
      </div>
    </div>

    <div v-if="errorText" class="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-300">
      {{ errorText }}
    </div>

    <template v-if="overview">
      <div class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <div class="rounded-lg bg-white p-4 shadow dark:bg-gray-800"><div class="text-xs text-gray-500">全部</div><div class="mt-1 text-xl font-semibold">{{ overview.summary.total }}</div></div>
        <div class="rounded-lg bg-white p-4 shadow dark:bg-gray-800"><div class="text-xs text-gray-500">可见</div><div class="mt-1 text-xl font-semibold">{{ overview.summary.visible }}</div></div>
        <div class="rounded-lg bg-white p-4 shadow dark:bg-gray-800"><div class="text-xs text-gray-500">进行中</div><div class="mt-1 text-xl font-semibold">{{ overview.summary.active }}</div></div>
        <div class="rounded-lg bg-white p-4 shadow dark:bg-gray-800"><div class="text-xs text-gray-500">随机商店</div><div class="mt-1 text-xl font-semibold">{{ overview.summary.withRandomShop }}</div></div>
        <div class="rounded-lg bg-white p-4 shadow dark:bg-gray-800"><div class="text-xs text-gray-500">兑换商店</div><div class="mt-1 text-xl font-semibold">{{ overview.summary.withExchangeShop }}</div></div>
        <div class="rounded-lg bg-white p-4 shadow dark:bg-gray-800"><div class="text-xs text-gray-500">抽奖</div><div class="mt-1 text-xl font-semibold">{{ overview.summary.withDraw }}</div></div>
      </div>

      <section v-if="overview.discovery" class="rounded-lg border border-indigo-200 bg-indigo-50/60 p-4 dark:border-indigo-900/40 dark:bg-indigo-950/15">
        <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div class="font-medium text-indigo-800 dark:text-indigo-200">结构发现结果</div>
            <div class="mt-1 text-xs text-indigo-700/80 dark:text-indigo-300/80">
              {{ overview.discovery.source }} · GetGroup {{ overview.discovery.groupSummary.loaded }}/{{ overview.discovery.groupSummary.requested }} 成功
              <template v-if="overview.discovery.groupSummary.failed"> · {{ overview.discovery.groupSummary.failed }} 失败</template>
              · 60 秒缓存
            </div>
          </div>
          <div class="flex flex-wrap gap-2 text-xs">
            <span class="rounded bg-white px-2 py-1 text-indigo-700 dark:bg-gray-800 dark:text-indigo-300">节点 {{ overview.discovery.summary.nodeCount }}</span>
            <span class="rounded bg-white px-2 py-1 text-indigo-700 dark:bg-gray-800 dark:text-indigo-300">潜在动作 {{ overview.discovery.summary.potentialActionCount }}</span>
            <span class="rounded bg-white px-2 py-1 text-indigo-700 dark:bg-gray-800 dark:text-indigo-300">结构 {{ overview.discovery.summary.structureFingerprints.length }}</span>
            <span class="rounded bg-emerald-100 px-2 py-1 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">自动执行关闭</span>
          </div>
        </div>

        <div v-if="discoverySeedIds.length" class="mt-3 text-xs text-indigo-700 dark:text-indigo-300">
          疑似种子/活动奖励 ID：{{ discoverySeedIds.join(', ') }}
        </div>

        <div v-if="discoveryNodes.length" class="mt-3 grid gap-2 xl:grid-cols-2">
          <div v-for="node in discoveryNodes" :key="`discovery-${node.id}`" class="rounded-lg bg-white/90 p-3 text-xs dark:bg-gray-800/90">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-medium text-gray-800 dark:text-gray-100">{{ node.title || `节点 #${node.id}` }}</span>
              <span class="text-gray-400">#{{ node.id }} · type {{ node.type }}</span>
              <span v-for="cap in node.capabilities" :key="`${node.id}-${cap}`" class="rounded bg-gray-100 px-1.5 py-0.5 text-gray-500 dark:bg-gray-700 dark:text-gray-300">{{ cap }}</span>
            </div>
            <div v-if="node.potentialActions.length" class="mt-2 flex flex-wrap gap-1">
              <span v-for="action in node.potentialActions" :key="`${node.id}-${action.kind}`" class="rounded bg-amber-50 px-2 py-1 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                {{ actionLabel(action.kind) }} ×{{ action.count }} · 仅信号
              </span>
            </div>
            <div v-if="node.seedLikeItemIds.length" class="mt-2 text-emerald-700 dark:text-emerald-300">
              seed-like: {{ node.seedLikeItemIds.join(', ') }}
            </div>
            <button class="mt-2 text-indigo-600 hover:underline dark:text-indigo-300" @click="toggleDiscovery(node.id)">
              {{ isDiscoveryExpanded(node.id) ? '收起结构指纹' : '查看结构指纹' }}
            </button>
            <div v-if="isDiscoveryExpanded(node.id)" class="mt-2 break-all rounded bg-gray-50 p-2 font-mono text-[11px] text-gray-500 dark:bg-gray-900 dark:text-gray-400">
              {{ node.structureFingerprint }}
            </div>
          </div>
        </div>
      </section>

      <div v-else-if="overview.framework.deepDiscoveryFallback" class="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-700 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-300">
        深发现本轮失败，已安全回退 ActivityService.List：{{ overview.discoveryError || overview.framework.fallbackReason || 'unknown' }}
      </div>

      <div class="rounded-lg border border-blue-200 bg-blue-50/70 px-4 py-3 text-xs text-blue-700 dark:border-blue-900/40 dark:bg-blue-950/20 dark:text-blue-300">
        Transport: {{ overview.framework.listTransport || overview.framework.transport }}<template v-if="overview.framework.groupTransport"> + {{ overview.framework.groupTransport }}</template>
        · adapters: {{ overview.framework.adapters.length }} · Operate: {{ overview.framework.operateEnabled ? 'enabled' : 'disabled' }}
      </div>

      <div v-if="displayedActivities.length === 0" class="rounded-lg bg-white px-4 py-10 text-center text-sm text-gray-500 shadow dark:bg-gray-800 dark:text-gray-400">
        当前 ActivityService.List 没有返回可展示活动。
      </div>

      <div v-else class="space-y-3">
        <article v-for="activity in displayedActivities" :key="activity.id" class="rounded-lg bg-white p-4 shadow dark:bg-gray-800">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <h3 class="truncate font-semibold text-gray-900 dark:text-gray-100">{{ activity.title || `活动 #${activity.id}` }}</h3>
                <span class="rounded px-2 py-0.5 text-xs" :class="activityStateClass(activity)">{{ activityStateText(activity) }}</span>
                <span v-if="activity.parentId" class="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-300">
                  子活动 · {{ parentTitleMap.get(activity.parentId) || `#${activity.parentId}` }}
                </span>
              </div>
              <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
                <span>ID {{ activity.id }}</span><span>type {{ activity.type }}</span><span>status {{ activity.status }}</span><span>sort {{ activity.sort }}</span>
              </div>
              <div class="mt-2 text-xs text-gray-500 dark:text-gray-400">
                {{ formatTime(activity.startTime) }} → {{ formatTime(activity.endTime) }}
              </div>
            </div>
            <div class="flex flex-wrap gap-1 text-xs">
              <span v-if="activity.capabilities.randomShop" class="rounded bg-purple-50 px-2 py-1 text-purple-700 dark:bg-purple-950/30 dark:text-purple-300">随机商店</span>
              <span v-if="activity.capabilities.exchangeShop" class="rounded bg-cyan-50 px-2 py-1 text-cyan-700 dark:bg-cyan-950/30 dark:text-cyan-300">兑换商店</span>
              <span v-if="activity.capabilities.draw" class="rounded bg-pink-50 px-2 py-1 text-pink-700 dark:bg-pink-950/30 dark:text-pink-300">抽奖</span>
            </div>
          </div>

          <div v-if="activity.randomShop" class="mt-3 rounded-lg bg-purple-50/50 p-3 text-xs dark:bg-purple-950/10">
            <div class="font-medium text-purple-700 dark:text-purple-300">随机商店 · {{ activity.randomShop.items.length }} 项</div>
            <div class="mt-2 flex flex-wrap gap-2">
              <span v-for="item in activity.randomShop.items.slice(0, 8)" :key="`random-${activity.id}-${item.id}`" class="rounded bg-white px-2 py-1 text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                {{ item.name || item.item.name }} ×{{ item.item.count }} / {{ item.cost.name }} ×{{ item.cost.count }} · {{ item.boughtCount }}/{{ item.stockCount || '-' }}
              </span>
            </div>
          </div>

          <div v-if="activity.exchangeShop" class="mt-3 rounded-lg bg-cyan-50/50 p-3 text-xs dark:bg-cyan-950/10">
            <div class="font-medium text-cyan-700 dark:text-cyan-300">兑换商店 · {{ activity.exchangeShop.items.length }} 项</div>
            <div class="mt-2 flex flex-wrap gap-2">
              <span v-for="item in activity.exchangeShop.items.slice(0, 8)" :key="`exchange-${activity.id}-${item.id}`" class="rounded bg-white px-2 py-1 text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                {{ item.name || item.item.name }} ×{{ item.item.count }} / {{ item.cost.name }} ×{{ item.cost.count }}<template v-if="item.owned"> · 已拥有</template>
              </span>
            </div>
          </div>

          <div v-if="activity.drawInfo" class="mt-3 rounded-lg bg-pink-50/50 p-3 text-xs dark:bg-pink-950/10">
            <div class="font-medium text-pink-700 dark:text-pink-300">抽奖池 · {{ activity.drawInfo.rewards.length }} 项</div>
            <div class="mt-1 text-gray-500 dark:text-gray-400">
              免费 {{ activity.drawInfo.freeRemainingCount }}/{{ activity.drawInfo.maxFreeCount }} · 付费 {{ activity.drawInfo.paidRemainingCount }}/{{ activity.drawInfo.maxPaidCount }} · 单价 {{ activity.drawInfo.paidPrice }} (货币 {{ activity.drawInfo.paidCurrencyId }})
            </div>
          </div>

          <div v-if="activity.payload.raw" class="mt-3 border-t border-gray-100 pt-3 dark:border-gray-700">
            <button class="text-xs text-blue-600 hover:underline dark:text-blue-300" @click="togglePayload(activity.id)">
              {{ isPayloadExpanded(activity.id) ? '收起 payload' : `查看 payload${activity.payload.keys.length ? ` (${activity.payload.keys.join(', ')})` : ''}` }}
            </button>
            <pre v-if="isPayloadExpanded(activity.id)" class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-gray-50 p-3 text-[11px] text-gray-600 dark:bg-gray-900 dark:text-gray-300">{{ activity.payload.json ? JSON.stringify(activity.payload.json, null, 2) : activity.payload.raw }}</pre>
          </div>
        </article>
      </div>
    </template>
  </div>
</template>
