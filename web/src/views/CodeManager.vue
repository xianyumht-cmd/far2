<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import api from '@/api'
import { useAccountStore } from '@/stores/account'
import { useToastStore } from '@/stores/toast'

interface CodeRefreshConfig {
  accountId: string
  accountName: string
  platform: string
  enabled: boolean
  mode: string
  configuredAt: number
}

interface CodeManagerAccountStatus {
  accountId: string
  accountName: string
  qqUin: string
  sessionStatus: string
  needsRebind: boolean
  nextRefreshAt: number
  refreshing: boolean
  pendingReason: string
  state: {
    state: string
    updatedAt?: number
    reason?: string
    message?: string
  }
}

interface CodeManagerStatus {
  enabled: boolean
  started: boolean
  globalEnabled: boolean
  provider: string
  refreshIntervalMs: number
  pollMs: number
  retryMs: number
  configuredCount: number
  accounts: CodeManagerAccountStatus[]
}

const accountStore = useAccountStore()
const toast = useToastStore()
const { currentAccount } = storeToRefs(accountStore)

const loading = ref(false)
const saving = ref(false)
const refreshing = ref(false)
const config = ref<CodeRefreshConfig | null>(null)
const status = ref<CodeManagerStatus | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

function maskUin(value: unknown) {
  const text = String(value || '').trim()
  if (!/^\d{5,12}$/.test(text))
    return ''
  if (text.length <= 4)
    return '****'
  return `${text.slice(0, 2)}****${text.slice(-2)}`
}

const accountStatus = computed(() => status.value?.accounts?.[0] || null)
const expectedAccountUin = computed(() => maskUin(currentAccount.value?.uin))
const boundSessionUin = computed(() => String(accountStatus.value?.qqUin || ''))
const sessionIdentityMismatch = computed(() => Boolean(
  expectedAccountUin.value
  && boundSessionUin.value
  && expectedAccountUin.value !== boundSessionUin.value,
))

const providerReady = computed(() => {
  const provider = String(status.value?.provider || '')
  return !!provider && provider !== 'targeted_provider_pending' && provider !== 'unavailable'
})

const canManualRefresh = computed(() => Boolean(
  config.value?.enabled
  && status.value?.globalEnabled
  && providerReady.value
  && !sessionIdentityMismatch.value
  && accountStatus.value?.sessionStatus === 'online'
  && !accountStatus.value?.needsRebind
  && !accountStatus.value?.refreshing,
))

const stateMeta = computed(() => {
  if (sessionIdentityMismatch.value) {
    return {
      label: 'Session 错绑',
      detail: `当前账号 QQ ${expectedAccountUin.value}，但绑定 Session 是 ${boundSessionUin.value}。为防止串号，Code 刷新已强制禁止。`,
      cls: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    }
  }

  const key = String(accountStatus.value?.state?.state || (config.value?.enabled ? 'configured' : 'disabled'))
  const map: Record<string, { label: string, detail: string, cls: string }> = {
    disabled: { label: '未启用', detail: '当前账号未加入 Code 自动刷新。', cls: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300' },
    configured: { label: '已配置', detail: '账号级配置已完成，但全局自动刷新尚未启用。', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' },
    scheduled: { label: '等待调度', detail: 'Session 正常，等待下一次刷新时间。', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
    refreshing: { label: '正在刷新', detail: '正在为当前账号获取 fresh Code。', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
    ready: { label: '刷新成功', detail: '最近一次刷新已完成。', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
    waiting_session: { label: '等待 Session', detail: '对应 Windows QQ 农场 Session 当前不在线。若保存的 QQ/UIN 正确，重新打开该 QQ 的农场后会自动恢复。', cls: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300' },
    waiting_provider: { label: '等待 Provider', detail: '定向 Code Provider 尚未就绪，不会回退到全局 QQ 选择器。', cls: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300' },
    provider_error: { label: 'Provider 异常', detail: accountStatus.value?.state?.message || '定向 Provider 执行失败。', cls: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
  }
  return map[key] || { label: key || '未知', detail: '等待运行状态更新。', cls: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300' }
})

const manualRefreshHint = computed(() => {
  if (sessionIdentityMismatch.value)
    return `账号 QQ ${expectedAccountUin.value} 与绑定 Session ${boundSessionUin.value} 不一致，禁止刷新。`
  if (!config.value?.enabled)
    return '请先启用当前账号的 Code 自动刷新。'
  if (!status.value?.globalEnabled)
    return '全局 FARM_CODE_AUTO_REFRESH 尚未启用。'
  if (!providerReady.value)
    return '定向 Provider 尚未就绪，当前禁止手动刷新。'
  if (accountStatus.value?.sessionStatus !== 'online' || accountStatus.value?.needsRebind)
    return '对应 Windows QQ Session 当前不可用。'
  if (accountStatus.value?.refreshing)
    return '当前账号正在刷新。'
  return '立即触发当前账号的一次 Code 刷新。'
})

function formatTime(value: number) {
  if (!value)
    return '—'
  return new Date(value).toLocaleString()
}

function formatDuration(ms: number) {
  if (!ms)
    return '—'
  if (ms % 60000 === 0)
    return `${Math.round(ms / 60000)} 分钟`
  return `${Math.round(ms / 1000)} 秒`
}

async function load(silent = false) {
  if (!currentAccount.value?.id) {
    config.value = null
    status.value = null
    return
  }
  if (!silent)
    loading.value = true
  try {
    const [configRes, statusRes] = await Promise.all([
      api.get('/api/code-manager/config'),
      api.get('/api/code-manager/status'),
    ])
    config.value = configRes.data?.data || null
    status.value = statusRes.data?.data || null
  }
  catch (error: any) {
    if (!silent)
      toast.error(error?.response?.data?.error || '读取 CodeManager 状态失败')
  }
  finally {
    if (!silent)
      loading.value = false
  }
}

async function toggleEnabled() {
  if (!currentAccount.value?.id || !config.value)
    return
  saving.value = true
  try {
    const next = !config.value.enabled
    const res = await api.post('/api/code-manager/config', {
      enabled: next,
      mode: next ? 'windows_session' : '',
    })
    config.value = res.data?.data?.config || config.value
    toast.success(next ? '当前账号已加入 Code 自动刷新' : '当前账号已关闭 Code 自动刷新')
    await load(true)
  }
  catch (error: any) {
    toast.error(error?.response?.data?.error || '保存 CodeManager 配置失败')
  }
  finally {
    saving.value = false
  }
}

async function triggerRefresh() {
  if (!canManualRefresh.value)
    return
  refreshing.value = true
  try {
    const res = await api.post('/api/code-manager/refresh', { reason: 'manual_web' })
    if (res.data?.data?.accepted)
      toast.success('已提交刷新任务')
    else
      toast.warning('当前条件不允许执行刷新')
    await load(true)
  }
  catch (error: any) {
    toast.error(error?.response?.data?.error || '触发 Code 刷新失败')
  }
  finally {
    refreshing.value = false
  }
}

watch(() => currentAccount.value?.id || '', () => load(), { immediate: false })

onMounted(async () => {
  if (!currentAccount.value?.id)
    await accountStore.fetchAccounts()
  await load()
  timer = setInterval(() => load(true), 5000)
})

onBeforeUnmount(() => {
  if (timer)
    clearInterval(timer)
})
</script>

<template>
  <div class="mx-auto w-full max-w-6xl space-y-5">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <div class="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
          <div class="i-carbon-renew" />
          Code 自动刷新
        </div>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          当前账号：{{ currentAccount?.name || currentAccount?.id || '未选择账号' }}。页面跟随左侧账号切换。
        </p>
      </div>
      <button
        class="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
        :disabled="loading"
        @click="load()"
      >
        <div class="i-carbon-restart" :class="loading ? 'animate-spin' : ''" />
        刷新状态
      </button>
    </div>

    <div v-if="!currentAccount" class="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
      请先在左侧选择或添加一个账号。
    </div>

    <template v-else>
      <div v-if="sessionIdentityMismatch" class="rounded-xl border border-red-300 bg-red-50 p-4 text-sm leading-6 text-red-800 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
        <div class="font-semibold">
          检测到账号 / Session 身份不一致，已强制禁止 Code 刷新
        </div>
        <div class="mt-1">
          当前账号 QQ：{{ expectedAccountUin || '未知' }}；绑定 Session：{{ boundSessionUin || '未绑定' }}。请先修复绑定关系，再继续 Provider 测试。
        </div>
      </div>

      <div class="grid gap-4 lg:grid-cols-3">
        <section class="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs font-medium uppercase tracking-wide text-gray-400">
            当前状态
          </div>
          <div class="mt-3 flex items-center gap-2">
            <span class="rounded-full px-3 py-1 text-sm font-semibold" :class="stateMeta.cls">{{ stateMeta.label }}</span>
          </div>
          <p class="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-300">
            {{ stateMeta.detail }}
          </p>
        </section>

        <section class="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs font-medium uppercase tracking-wide text-gray-400">
            Windows QQ Session
          </div>
          <div class="mt-3 text-lg font-semibold text-gray-900 dark:text-white">
            {{ accountStatus?.qqUin || '未绑定' }}
          </div>
          <div class="mt-1 text-xs text-gray-400">
            当前账号 QQ：{{ expectedAccountUin || '未知' }}
          </div>
          <div class="mt-2 flex flex-wrap gap-2 text-xs">
            <span class="rounded-full px-2.5 py-1" :class="accountStatus?.sessionStatus === 'online' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'">
              {{ accountStatus?.sessionStatus || 'unbound' }}
            </span>
            <span v-if="sessionIdentityMismatch" class="rounded-full bg-red-100 px-2.5 py-1 text-red-700 dark:bg-red-900/30 dark:text-red-300">
              身份不一致
            </span>
            <span v-else-if="accountStatus?.needsRebind" class="rounded-full bg-orange-100 px-2.5 py-1 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300">
              等待自动恢复
            </span>
          </div>
        </section>

        <section class="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs font-medium uppercase tracking-wide text-gray-400">
            定向 Provider
          </div>
          <div class="mt-3 break-all text-sm font-semibold text-gray-900 dark:text-white">
            {{ status?.provider || 'unavailable' }}
          </div>
          <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
            {{ providerReady ? 'Provider 已接入。' : '尚未接入可安全定向到指定 QQ Session 的 Provider。' }}
          </p>
        </section>
      </div>

      <section class="rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div class="flex flex-col gap-4 border-b border-gray-100 p-5 sm:flex-row sm:items-center sm:justify-between dark:border-gray-700">
          <div>
            <h2 class="font-semibold text-gray-900 dark:text-white">
              账号级配置
            </h2>
            <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
              仅控制当前账号是否参与 windows_session Code 刷新。
            </p>
          </div>
          <button
            class="inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50"
            :class="config?.enabled ? 'bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-300' : 'bg-gray-900 text-white hover:bg-gray-800 dark:bg-white dark:text-gray-900'"
            :disabled="saving || loading || !config"
            @click="toggleEnabled"
          >
            {{ saving ? '保存中…' : (config?.enabled ? '关闭当前账号刷新' : '启用当前账号刷新') }}
          </button>
        </div>

        <div class="grid gap-px bg-gray-100 md:grid-cols-2 lg:grid-cols-4 dark:bg-gray-700">
          <div class="bg-white p-5 dark:bg-gray-800">
            <div class="text-xs text-gray-400">账号配置</div>
            <div class="mt-1 font-medium text-gray-900 dark:text-white">{{ config?.enabled ? '已启用' : '未启用' }}</div>
          </div>
          <div class="bg-white p-5 dark:bg-gray-800">
            <div class="text-xs text-gray-400">模式</div>
            <div class="mt-1 font-medium text-gray-900 dark:text-white">{{ config?.mode || '—' }}</div>
          </div>
          <div class="bg-white p-5 dark:bg-gray-800">
            <div class="text-xs text-gray-400">全局调度</div>
            <div class="mt-1 font-medium" :class="status?.globalEnabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'">
              {{ status?.globalEnabled ? '已启用' : '未启用' }}
            </div>
          </div>
          <div class="bg-white p-5 dark:bg-gray-800">
            <div class="text-xs text-gray-400">刷新周期</div>
            <div class="mt-1 font-medium text-gray-900 dark:text-white">{{ formatDuration(status?.refreshIntervalMs || 0) }}</div>
          </div>
        </div>
      </section>

      <section class="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 class="font-semibold text-gray-900 dark:text-white">
              手动刷新
            </h2>
            <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {{ manualRefreshHint }}
            </p>
          </div>
          <button
            class="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500 dark:disabled:bg-gray-700 dark:disabled:text-gray-400"
            :disabled="!canManualRefresh || refreshing"
            @click="triggerRefresh"
          >
            <div class="i-carbon-renew" :class="refreshing ? 'animate-spin' : ''" />
            {{ refreshing ? '提交中…' : '立即刷新当前账号' }}
          </button>
        </div>

        <div class="mt-5 grid gap-4 border-t border-gray-100 pt-5 sm:grid-cols-3 dark:border-gray-700">
          <div>
            <div class="text-xs text-gray-400">下次刷新</div>
            <div class="mt-1 text-sm font-medium text-gray-900 dark:text-white">{{ formatTime(accountStatus?.nextRefreshAt || 0) }}</div>
          </div>
          <div>
            <div class="text-xs text-gray-400">等待原因</div>
            <div class="mt-1 break-all text-sm font-medium text-gray-900 dark:text-white">{{ accountStatus?.pendingReason || accountStatus?.state?.reason || '—' }}</div>
          </div>
          <div>
            <div class="text-xs text-gray-400">轮询 / 重试</div>
            <div class="mt-1 text-sm font-medium text-gray-900 dark:text-white">
              {{ formatDuration(status?.pollMs || 0) }} / {{ formatDuration(status?.retryMs || 0) }}
            </div>
          </div>
        </div>
      </section>

      <div v-if="status && !status.globalEnabled" class="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200">
        当前全局自动刷新仍处于关闭状态。即使账号级配置显示“已启用”，CodeManager 也不会执行真实刷新；这是当前 Provider 尚未完成前的保护状态。
      </div>
    </template>
  </div>
</template>