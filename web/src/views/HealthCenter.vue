<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { computed, onMounted, ref } from 'vue'
import api from '@/api'

interface HealthAccount {
  accountId: string
  accountName: string
  gameName: string
  platform: string
  running: boolean
  health: { state: string, label: string, message: string }
  farm: {
    connected: boolean
    level: number
    uptime: number
    wsError?: { code: number, message: string, at: number } | null
  }
  code: {
    enabled: boolean
    mode: string
    state: string
    stateLabel: string
    stateReason: string
    refreshing: boolean
    sessionStatus: string
    sessionIdentityOk: boolean | null
    needsRebind: boolean
    lastRefreshAt: number
    lastRefreshOk: boolean | null
    lastRefreshReason: string
    lastRefreshError: string
    lastCodeSource: string
  }
  friends: {
    imported: boolean
    gidCount: number | null
    openIdCount: number | null
    addedGidCount: number | null
    source: string
    capturedAt: number
  }
  recentEvents: Array<{
    time: string
    action: string
    msg: string
    reason: string
  }>
}

interface HealthData {
  generatedAt: number
  overall: { state: string, label: string, detail: string }
  summary: {
    accounts: number
    running: number
    connected: number
    codeReady: number
    friendReady: number
    issues: number
  }
  codeManager: {
    enabled: boolean
    started: boolean
    globalEnabled: boolean
    provider: string
    configuredCount: number
  }
  accounts: HealthAccount[]
}

const loading = ref(false)
const error = ref('')
const data = ref<HealthData | null>(null)

const lastUpdated = computed(() => {
  if (!data.value?.generatedAt)
    return '--'
  return formatDateTime(data.value.generatedAt)
})

function formatDateTime(value: number | string) {
  if (!value)
    return '--'
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value).replace(' ', 'T'))
  if (Number.isNaN(date.getTime()))
    return String(value)
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}

function formatDuration(seconds: number) {
  const sec = Math.max(0, Number(seconds) || 0)
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0)
    return `${d}天 ${h}小时`
  if (h > 0)
    return `${h}小时 ${m}分`
  return `${m}分`
}

function stateBadgeClass(state: string) {
  if (state === 'error')
    return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
  if (state === 'warning')
    return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
  if (state === 'idle')
    return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
  return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
}

function dotClass(state: string) {
  if (state === 'error')
    return 'bg-red-500'
  if (state === 'warning')
    return 'bg-amber-500'
  if (state === 'idle')
    return 'bg-gray-400'
  return 'bg-emerald-500'
}

function panelClass(state: string) {
  if (state === 'error')
    return 'border-red-200 bg-red-50/60 dark:border-red-900/40 dark:bg-red-950/20'
  if (state === 'warning')
    return 'border-amber-200 bg-amber-50/60 dark:border-amber-900/40 dark:bg-amber-950/20'
  if (state === 'idle')
    return 'border-gray-200 bg-gray-50/60 dark:border-gray-700 dark:bg-gray-800/30'
  return 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-900/40 dark:bg-emerald-950/20'
}

function codeTone(account: HealthAccount) {
  if (!account.code.enabled)
    return 'idle'
  if (account.code.state === 'session_mismatch' || account.code.state === 'provider_error')
    return 'error'
  if (account.code.state === 'waiting_session' || account.code.state === 'waiting_provider' || account.code.refreshing)
    return 'warning'
  return 'ok'
}

function friendTone(account: HealthAccount) {
  if (!account.running)
    return 'idle'
  return account.friends.imported ? 'ok' : 'warning'
}

function eventLabel(action: string) {
  const labels: Record<string, string> = {
    ws_400: '连接 400',
    kickout_stop: '被踢下线',
    code_refresh_start: '开始刷新 Code',
    code_refresh_ok: 'Code 刷新成功',
    code_refresh_failed: 'Code 刷新失败',
    code_refresh_session_mismatch: 'Session 身份异常',
    code_refresh_waiting_session: '等待 QQ Session',
    code_refresh_waiting_provider: '等待 Provider',
  }
  return labels[action] || action
}

function eventClass(action: string) {
  if (action === 'code_refresh_ok')
    return 'text-emerald-600 dark:text-emerald-400'
  if (action.includes('failed') || action.includes('mismatch') || action === 'ws_400' || action === 'kickout_stop')
    return 'text-red-600 dark:text-red-400'
  return 'text-gray-600 dark:text-gray-300'
}

async function refresh(silent = false) {
  if (!silent)
    loading.value = true
  error.value = ''
  try {
    const res = await api.get('/api/runtime-health')
    if (!res.data?.ok)
      throw new Error(res.data?.error || '运行健康状态获取失败')
    data.value = res.data.data
  }
  catch (e: any) {
    error.value = e?.response?.data?.error || e?.message || '运行健康状态获取失败'
  }
  finally {
    loading.value = false
  }
}

onMounted(() => refresh(false))
useIntervalFn(() => refresh(true), 10000)
</script>

<template>
  <div class="flex flex-col gap-6 pt-6">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div class="flex items-center gap-2">
          <div class="i-carbon-health-status text-2xl" :style="{ color: 'var(--theme-primary)' }" />
          <h1 class="text-2xl font-bold">
            运行健康中心
          </h1>
        </div>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          只读监控 Worker、Farm、Code 自动恢复和 QQ 好友池，每 10 秒自动刷新。
        </p>
      </div>
      <div class="flex items-center gap-3">
        <span class="text-xs text-gray-400">更新于 {{ lastUpdated }}</span>
        <button
          class="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-white disabled:opacity-60"
          :style="{ background: 'var(--theme-primary)' }"
          :disabled="loading"
          @click="refresh(false)"
        >
          <div class="i-carbon-renew" :class="loading ? 'animate-spin' : ''" />
          {{ loading ? '刷新中' : '立即刷新' }}
        </button>
      </div>
    </div>

    <div
      v-if="error"
      class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/20 dark:text-red-300"
    >
      {{ error }}
    </div>

    <template v-if="data">
      <div class="rounded-xl border p-5" :class="panelClass(data.overall.state)">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex items-center gap-3">
            <span class="h-3 w-3 rounded-full" :class="dotClass(data.overall.state)" />
            <div>
              <div class="text-lg font-bold">
                {{ data.overall.label }}
              </div>
              <div class="text-sm text-gray-600 dark:text-gray-300">
                {{ data.overall.detail }}
              </div>
            </div>
          </div>
          <div class="text-xs text-gray-500 dark:text-gray-400">
            Provider: {{ data.codeManager.provider || '未配置' }}
          </div>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <div class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500">账号</div>
          <div class="mt-1 text-2xl font-bold">{{ data.summary.accounts }}</div>
        </div>
        <div class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500">Worker 运行</div>
          <div class="mt-1 text-2xl font-bold">{{ data.summary.running }}</div>
        </div>
        <div class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500">Farm 在线</div>
          <div class="mt-1 text-2xl font-bold">{{ data.summary.connected }}</div>
        </div>
        <div class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500">Code 恢复可用</div>
          <div class="mt-1 text-2xl font-bold">
            {{ data.summary.codeReady }}<span class="ml-1 text-sm text-gray-400">/ {{ data.codeManager.configuredCount }}</span>
          </div>
        </div>
        <div class="col-span-2 rounded-xl border border-gray-200 bg-white p-4 lg:col-span-1 dark:border-gray-700 dark:bg-gray-800">
          <div class="text-xs text-gray-500">好友池已导入</div>
          <div class="mt-1 text-2xl font-bold">{{ data.summary.friendReady }}</div>
        </div>
      </div>

      <div v-if="data.accounts.length === 0" class="rounded-xl border border-dashed border-gray-300 py-16 text-center text-gray-500 dark:border-gray-700">
        当前没有可查看的账号。
      </div>

      <div v-for="account in data.accounts" :key="account.accountId" class="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div class="flex flex-col gap-3 border-b border-gray-100 pb-4 sm:flex-row sm:items-center sm:justify-between dark:border-gray-700">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="truncate text-lg font-bold">
                {{ account.gameName || account.accountName }}
              </h2>
              <span v-if="account.gameName && account.accountName && account.gameName !== account.accountName" class="text-xs text-gray-400">
                {{ account.accountName }}
              </span>
              <span class="rounded px-2 py-0.5 text-xs font-medium" :class="stateBadgeClass(account.health.state)">
                {{ account.health.label }}
              </span>
            </div>
            <div class="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {{ account.health.message }}
            </div>
          </div>
          <div class="text-xs text-gray-400">
            ID {{ account.accountId }} · {{ account.platform.toUpperCase() }}
          </div>
        </div>

        <div class="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-4 md:grid-cols-2">
          <div class="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
            <div class="mb-3 flex items-center justify-between">
              <div class="flex items-center gap-2 text-sm font-semibold">
                <div class="i-carbon-application-web" />
                Worker
              </div>
              <span class="h-2.5 w-2.5 rounded-full" :class="account.running ? 'bg-emerald-500' : 'bg-gray-400'" />
            </div>
            <div class="text-lg font-bold">
              {{ account.running ? '运行中' : '未运行' }}
            </div>
            <div class="mt-1 text-xs text-gray-500">
              {{ account.running ? 'FAR2 Worker 已启动' : '当前没有 Worker，不视为故障' }}
            </div>
          </div>

          <div class="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
            <div class="mb-3 flex items-center justify-between">
              <div class="flex items-center gap-2 text-sm font-semibold">
                <div class="i-carbon-sprout" />
                Farm
              </div>
              <span class="h-2.5 w-2.5 rounded-full" :class="account.farm.connected ? 'bg-emerald-500' : (account.running ? 'bg-amber-500' : 'bg-gray-400')" />
            </div>
            <div class="text-lg font-bold">
              {{ account.farm.connected ? `在线 · Lv${account.farm.level}` : '未连接' }}
            </div>
            <div class="mt-1 text-xs text-gray-500">
              {{ account.farm.connected ? `本次在线 ${formatDuration(account.farm.uptime)}` : (account.farm.wsError?.code ? `最近 WS ${account.farm.wsError.code}` : '等待连接状态') }}
            </div>
          </div>

          <div class="rounded-lg border p-4" :class="panelClass(codeTone(account))">
            <div class="mb-3 flex items-center justify-between">
              <div class="flex items-center gap-2 text-sm font-semibold">
                <div class="i-carbon-renew" />
                Code 自动恢复
              </div>
              <span class="rounded px-2 py-0.5 text-[11px]" :class="stateBadgeClass(codeTone(account))">
                {{ account.code.enabled ? account.code.stateLabel : '未启用' }}
              </span>
            </div>
            <div class="text-sm font-semibold">
              {{ account.code.enabled ? (account.code.refreshing ? '正在刷新 Code' : '事件驱动恢复已配置') : '该账号未启用自动恢复' }}
            </div>
            <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              <template v-if="account.code.lastRefreshAt">
                最近刷新 {{ formatDateTime(account.code.lastRefreshAt) }}
                <span v-if="account.code.lastRefreshOk === true"> · 成功</span>
                <span v-else-if="account.code.lastRefreshOk === false"> · 失败</span>
              </template>
              <template v-else>
                暂无刷新记录
              </template>
            </div>
            <div v-if="account.code.lastRefreshError" class="mt-2 break-words text-xs text-red-600 dark:text-red-400">
              {{ account.code.lastRefreshError }}
            </div>
          </div>

          <div class="rounded-lg border p-4" :class="panelClass(friendTone(account))">
            <div class="mb-3 flex items-center justify-between">
              <div class="flex items-center gap-2 text-sm font-semibold">
                <div class="i-carbon-user-multiple" />
                QQ 好友池
              </div>
              <span class="rounded px-2 py-0.5 text-[11px]" :class="stateBadgeClass(friendTone(account))">
                {{ account.friends.imported ? '已导入' : (account.running ? '待确认' : '未运行') }}
              </span>
            </div>
            <div class="flex gap-5">
              <div>
                <div class="text-xs text-gray-500">GID</div>
                <div class="text-xl font-bold">{{ account.friends.gidCount ?? '--' }}</div>
              </div>
              <div>
                <div class="text-xs text-gray-500">openId</div>
                <div class="text-xl font-bold">{{ account.friends.openIdCount ?? '--' }}</div>
              </div>
            </div>
            <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {{ account.friends.capturedAt ? `采集于 ${formatDateTime(account.friends.capturedAt)}` : '本次启动暂无完整好友导入记录' }}
            </div>
          </div>
        </div>

        <div v-if="account.recentEvents.length" class="mt-4 rounded-lg bg-gray-50 p-4 dark:bg-gray-900/40">
          <div class="mb-3 flex items-center gap-2 text-sm font-semibold">
            <div class="i-carbon-time" />
            最近恢复事件
          </div>
          <div class="space-y-2">
            <div v-for="(event, index) in account.recentEvents" :key="`${event.time}-${event.action}-${index}`" class="flex flex-col gap-1 text-xs sm:flex-row sm:items-start sm:gap-3">
              <span class="shrink-0 text-gray-400">{{ event.time || '--' }}</span>
              <span class="shrink-0 font-medium" :class="eventClass(event.action)">{{ eventLabel(event.action) }}</span>
              <span class="min-w-0 break-words text-gray-600 dark:text-gray-300">{{ event.msg }}</span>
            </div>
          </div>
        </div>
      </div>
    </template>

    <div v-else-if="loading" class="flex items-center justify-center py-20 text-gray-500">
      <div class="i-carbon-renew mr-2 animate-spin text-xl" />
      正在读取运行状态...
    </div>
  </div>
</template>
