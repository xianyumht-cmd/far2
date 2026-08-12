<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { onMounted, onUnmounted, ref, watch } from 'vue'
import ConfirmModal from '@/components/ConfirmModal.vue'
import LandCard from '@/components/LandCard.vue'
import { useAccountStore } from '@/stores/account'
import { useFarmStore } from '@/stores/farm'
import { useStatusStore } from '@/stores/status'

const farmStore = useFarmStore()
const accountStore = useAccountStore()
const statusStore = useStatusStore()
const { lands, summary, loading } = storeToRefs(farmStore)
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { status, loading: statusLoading, realtimeConnected } = storeToRefs(statusStore)

const operating = ref(false)
const actionMessage = ref('')
const actionError = ref('')
const confirmVisible = ref(false)
const confirmConfig = ref({
  title: '',
  message: '',
  opType: '',
})

function clearActionState() {
  actionMessage.value = ''
  actionError.value = ''
}

function errorText(error: any) {
  return String(error?.response?.data?.error || error?.message || '土地操作失败')
}

async function executeOperate() {
  if (!currentAccountId.value || !confirmConfig.value.opType)
    return
  confirmVisible.value = false
  operating.value = true
  clearActionState()
  try {
    const result = await farmStore.operate(currentAccountId.value, confirmConfig.value.opType)
    actionMessage.value = String(result?.message || '操作完成，土地状态已重新读取')
  }
  catch (error: any) {
    actionError.value = errorText(error)
  }
  finally {
    operating.value = false
  }
}

function handleOperate(opType: string) {
  if (!currentAccountId.value || operating.value)
    return

  const confirmMap: Record<string, string> = {
    harvest: '确定要收获所有成熟作物吗？',
    clear: '确定要一键除草/除虫吗？',
    plant: '确定要一键种植吗？（根据当前策略配置）',
    upgrade: '确定要升级所有当前可升级的土地吗？（可能消耗金币）',
    all: '确定要一键全收吗？（包含收获、除草、种植等）',
    'remove-all': '确定要铲除当前所有已种植作物吗？此操作不可恢复。',
  }

  confirmConfig.value = {
    title: opType === 'remove-all' ? '确认一键铲除' : '确认操作',
    message: confirmMap[opType] || '确定执行此操作吗？',
    opType,
  }
  confirmVisible.value = true
}

function handleLandOperate(action: 'remove' | 'fertilize-normal' | 'fertilize-organic' | 'upgrade', land: any) {
  if (!currentAccountId.value || operating.value || !land?.id)
    return

  const landId = Number(land.id)
  const plantName = String(land.plantName || '').trim()
  const label = plantName ? `土地 #${landId}（${plantName}）` : `土地 #${landId}`
  const messages: Record<string, string> = {
    remove: `确定铲除${label}当前作物吗？此操作不可恢复。`,
    'fertilize-normal': `确定对${label}使用 1 次普通肥吗？`,
    'fertilize-organic': `确定对${label}使用 1 次有机肥吗？`,
    upgrade: `确定升级土地 #${landId} 吗？仅服务器当前仍判定满足升级条件时才会执行。`,
  }

  confirmConfig.value = {
    title: action === 'remove' ? '确认铲除单块土地' : '确认单块土地操作',
    message: messages[action] || `确定操作土地 #${landId} 吗？`,
    opType: `land:${action}:${landId}`,
  }
  confirmVisible.value = true
}

const operations = [
  { type: 'harvest', label: '收获', icon: 'i-carbon-wheat', color: 'bg-blue-600 hover:bg-blue-700' },
  { type: 'clear', label: '除草/虫', icon: 'i-carbon-clean', color: 'bg-teal-600 hover:bg-teal-700' },
  { type: 'plant', label: '种植', icon: 'i-carbon-sprout', color: 'bg-green-600 hover:bg-green-700' },
  { type: 'upgrade', label: '升级土地', icon: 'i-carbon-upgrade', color: 'bg-purple-600 hover:bg-purple-700' },
  { type: 'all', label: '一键全收', icon: 'i-carbon-flash', color: 'bg-orange-600 hover:bg-orange-700' },
  { type: 'remove-all', label: '一键铲除', icon: 'i-carbon-trash-can', color: 'bg-red-600 hover:bg-red-700' },
]

async function refresh() {
  if (currentAccountId.value) {
    const acc = currentAccount.value
    if (!acc)
      return

    if (!realtimeConnected.value) {
      await statusStore.fetchStatus(currentAccountId.value)
    }

    if (acc.running && status.value?.connection?.connected) {
      farmStore.fetchLands(currentAccountId.value)
    }
  }
}

watch(currentAccountId, () => {
  clearActionState()
  refresh()
})

const { pause, resume } = useIntervalFn(() => {
  if (lands.value) {
    lands.value = lands.value.map((l: any) =>
      l.matureInSec > 0 ? { ...l, matureInSec: l.matureInSec - 1 } : l,
    )
  }
}, 1000)

const { pause: pauseRefresh, resume: resumeRefresh } = useIntervalFn(refresh, 60000)

onMounted(() => {
  refresh()
  resume()
  resumeRefresh()
})

onUnmounted(() => {
  pause()
  pauseRefresh()
})
</script>

<template>
  <div class="space-y-4">
    <div v-if="actionMessage" class="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-300">
      {{ actionMessage }}
    </div>
    <div v-if="actionError" class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/20 dark:text-red-300">
      {{ actionError }}
    </div>

    <div class="rounded-lg bg-white shadow dark:bg-gray-800">
      <div class="flex flex-col items-center justify-between gap-4 border-b border-gray-100 p-4 sm:flex-row dark:border-gray-700">
        <div>
          <h3 class="flex items-center gap-2 text-lg font-bold">
            <div class="i-carbon-grid text-xl" />
            土地详情
          </h3>
          <div class="mt-1 text-xs text-gray-400">
            单块铲除、普通肥、有机肥、升级均会二次确认；合种副地不会重复显示作物操作。
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          <button
            v-for="op in operations"
            :key="op.type"
            class="flex items-center justify-center gap-1.5 rounded px-3 py-2 text-sm text-white transition disabled:cursor-not-allowed disabled:opacity-50"
            :class="op.color"
            :disabled="operating"
            @click="handleOperate(op.type)"
          >
            <div :class="op.icon" />
            {{ op.label }}
          </button>
        </div>
      </div>

      <div class="flex flex-wrap gap-4 border-b border-gray-100 bg-gray-50 p-4 text-sm dark:border-gray-700 dark:bg-gray-900/50">
        <div class="flex items-center gap-1.5 rounded-full bg-orange-100 px-3 py-1 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">
          <div class="i-carbon-clean" />
          <span class="font-medium">可收: {{ summary?.harvestable || 0 }}</span>
        </div>
        <div class="flex items-center gap-1.5 rounded-full bg-green-100 px-3 py-1 text-green-700 dark:bg-green-900/30 dark:text-green-400">
          <div class="i-carbon-sprout" />
          <span class="font-medium">生长: {{ summary?.growing || 0 }}</span>
        </div>
        <div class="flex items-center gap-1.5 rounded-full bg-gray-100 px-3 py-1 text-gray-700 dark:bg-gray-800 dark:text-gray-400">
          <div class="i-carbon-checkbox" />
          <span class="font-medium">空闲: {{ summary?.empty || 0 }}</span>
        </div>
        <div class="flex items-center gap-1.5 rounded-full bg-red-100 px-3 py-1 text-red-700 dark:bg-red-900/30 dark:text-red-400">
          <div class="i-carbon-warning" />
          <span class="font-medium">枯萎: {{ summary?.dead || 0 }}</span>
        </div>
      </div>

      <div class="p-4">
        <div v-if="loading || statusLoading" class="flex justify-center py-12">
          <div class="i-svg-spinners-90-ring-with-bg text-4xl text-blue-500" />
        </div>

        <div v-else-if="!currentAccountId" class="flex flex-col items-center justify-center gap-4 rounded-lg bg-white p-12 text-center text-gray-500 shadow dark:bg-gray-800">
          <div class="i-carbon-user-offline text-4xl text-gray-400" />
          <div>
            <div class="text-lg text-gray-700 font-medium dark:text-gray-300">
              未登录账号
            </div>
            <div class="mt-1 text-sm text-gray-400">
              请先添加农场账号
            </div>
          </div>
        </div>

        <div v-else-if="!status?.connection?.connected" class="flex flex-col items-center justify-center gap-4 rounded-lg bg-white p-12 text-center text-gray-500 shadow dark:bg-gray-800">
          <div class="i-carbon-connection-signal-off text-4xl text-gray-400" />
          <div>
            <div class="text-lg text-gray-700 font-medium dark:text-gray-300">
              账号未登录
            </div>
            <div class="mt-1 text-sm text-gray-400">
              请先运行账号或检查网络连接
            </div>
          </div>
        </div>

        <div v-else-if="!lands || lands.length === 0" class="flex justify-center py-12 text-gray-500">
          暂无土地数据
        </div>

        <div v-else class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          <LandCard
            v-for="land in lands"
            :key="land.id"
            :land="land"
            :operating="operating"
            @operate="handleLandOperate"
          />
        </div>
      </div>
    </div>

    <ConfirmModal
      :show="confirmVisible"
      :title="confirmConfig.title"
      :message="confirmConfig.message"
      @confirm="executeOperate"
      @cancel="confirmVisible = false"
    />
  </div>
</template>
