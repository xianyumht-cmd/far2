<script setup lang="ts">
import { useStorage } from '@vueuse/core'
import axios from 'axios'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

interface UpdateCapability {
  supported: boolean
  mode: string
  reason: string
  autoRestart: boolean
  origin?: string
}

interface UpdateState {
  phase?: string
  stage?: string
  message?: string
  lastError?: string
  rollbackError?: string
  available?: boolean
  currentVersion?: string
  latestVersion?: string
  currentSha?: string
  targetSha?: string
  previousSha?: string
  releaseNotes?: string[]
  checkedAt?: number
  updatedAt?: number
}

interface UpdateStatus {
  capability: UpdateCapability
  currentVersion: string
  currentSha: string
  branch: string
  busy: boolean
  state: UpdateState
}

const adminToken = useStorage('admin_token', '')
const status = ref<UpdateStatus | null>(null)
const loading = ref(false)
const action = ref('')
const errorMessage = ref('')
const reconnecting = ref(false)
let pollTimer: number | null = null

const headers = computed(() => ({ 'x-admin-token': String(adminToken.value || '') }))
const state = computed(() => status.value?.state || {})
const capability = computed(() => status.value?.capability)
const updateAvailable = computed(() => state.value.available === true || state.value.stage === 'update_available')
const recoveryRequired = computed(() => state.value.phase === 'recovery_required')
const operationActive = computed(() => Boolean(status.value?.busy || ['checking', 'updating', 'rolling_back', 'restart_pending'].includes(String(state.value.phase || ''))))
const currentShortSha = computed(() => String(status.value?.currentSha || '').slice(0, 12) || '-')
const targetShortSha = computed(() => String(state.value.targetSha || '').slice(0, 12) || '-')
const releaseNotes = computed(() => Array.isArray(state.value.releaseNotes) ? state.value.releaseNotes : [])

const reasonText: Record<string, string> = {
  ready: '当前部署支持 WebUI 一键升级',
  docker_requires_external_orchestrator: '当前运行在 Docker 中。容器内覆盖源码并不持久，因此禁止伪一键升级；需要先配置宿主机更新编排。',
  packaged_release_updater_not_configured: '当前为打包可执行文件，尚未配置签名 Release 资产升级器。',
  git_checkout_required: '当前不是 Git 源码部署，无法安全执行源代码升级。',
  checkout_main_required: '一键升级只允许在 main 分支执行。',
  automatic_restart_not_available: '没有检测到可自动拉起 FAR2 的服务管理器。Windows 请使用 FAR2Farm NSSM 服务运行。',
  windows_update_agent_not_installed: '尚未安装 Windows Update Agent。首次部署后运行 install-webui-update.cmd 一次。',
  windows_update_agent_unavailable: 'Windows Update Agent 计划任务不可用，请重新运行 install-webui-update.cmd 修复。',
  update_origin_rejected: 'Git origin 不是官方 xianyumht-cmd/far2，已拒绝升级。',
}

function formatTime(value?: number) {
  if (!value)
    return '-'
  return new Date(value).toLocaleString()
}

function phaseLabel(value?: string) {
  const labels: Record<string, string> = {
    idle: '空闲',
    checking: '检查更新',
    updating: '正在升级',
    rolling_back: '正在回滚',
    rolled_back: '已回滚',
    interrupted: '任务中断',
    recovery_required: '需要恢复',
    recovered: '已恢复',
    rollback_failed: '回滚失败',
    failed: '失败',
    restart_pending: '等待重启',
    completed: '升级完成',
  }
  return labels[String(value || '')] || String(value || '空闲')
}

async function loadStatus(silent = false) {
  if (!silent)
    errorMessage.value = ''
  try {
    const response = await axios.get('/api/admin/update/status', {
      headers: headers.value,
      timeout: 6000,
    })
    if (response.data?.ok) {
      status.value = response.data.data
      reconnecting.value = false
    }
  }
  catch (error: any) {
    if (state.value.phase === 'restart_pending' || action.value === 'apply') {
      reconnecting.value = true
      return
    }
    if (!silent)
      errorMessage.value = error?.response?.data?.error || error?.message || '读取升级状态失败'
  }
}

async function checkUpdate() {
  loading.value = true
  action.value = 'check'
  errorMessage.value = ''
  let accepted = false
  try {
    const response = await axios.post('/api/admin/update/check', {}, {
      headers: headers.value,
      timeout: 10000,
    })
    if (response.data?.ok) {
      status.value = response.data.data.status
      accepted = true
      startPolling()
    }
  }
  catch (error: any) {
    errorMessage.value = error?.response?.data?.error || error?.message || '检查更新失败'
    await loadStatus(true)
  }
  finally {
    loading.value = false
    if (!accepted)
      action.value = ''
  }
}

async function applyUpdate() {
  if (!capability.value?.supported)
    return
  const target = state.value.latestVersion || targetShortSha.value
  const recoveryNotice = recoveryRequired.value ? '检测到上次升级被意外中断，将先恢复上一个已验证版本，再重新升级。\n\n' : ''
  if (!window.confirm(`${recoveryNotice}确认升级 FAR2 到 ${target}？\n\n升级会执行完整 pnpm verify。失败会自动回滚；成功后 FAR2 服务会自动重启。`))
    return

  loading.value = true
  action.value = 'apply'
  errorMessage.value = ''
  try {
    const response = await axios.post('/api/admin/update/apply', {}, {
      headers: headers.value,
      timeout: 10000,
    })
    if (response.data?.ok) {
      status.value = response.data.data.status
      startPolling()
    }
  }
  catch (error: any) {
    errorMessage.value = error?.response?.data?.error || error?.message || '启动升级失败'
  }
  finally {
    loading.value = false
  }
}

function startPolling() {
  if (pollTimer !== null)
    return
  pollTimer = window.setInterval(async () => {
    await loadStatus(true)
    const phase = String(state.value.phase || '')
    if (!operationActive.value && !reconnecting.value && phase !== 'restart_pending') {
      if (pollTimer !== null)
        window.clearInterval(pollTimer)
      pollTimer = null
      action.value = ''
    }
  }, 1500)
}

onMounted(async () => {
  await loadStatus()
  if (operationActive.value)
    startPolling()
})

onBeforeUnmount(() => {
  if (pollTimer !== null)
    window.clearInterval(pollTimer)
})
</script>

<template>
  <div class="update-page">
    <section class="hero-card">
      <div>
        <p class="eyebrow">
          FAR2 SYSTEM UPDATE
        </p>
        <h1>系统升级</h1>
        <p class="subtitle">
          从官方 main 检查更新，验证通过后自动重启；失败自动恢复旧版本。
        </p>
      </div>
      <div class="hero-actions">
        <button class="btn secondary" :disabled="loading || operationActive || recoveryRequired" @click="checkUpdate">
          {{ action === 'check' ? '检查中…' : '检查更新' }}
        </button>
        <button class="btn primary" :disabled="loading || operationActive || !capability?.supported || (!updateAvailable && !recoveryRequired)" @click="applyUpdate">
          {{ recoveryRequired ? '恢复并重试升级' : operationActive ? '升级进行中…' : '一键升级' }}
        </button>
      </div>
    </section>

    <div v-if="errorMessage" class="alert error">
      {{ errorMessage }}
    </div>
    <div v-if="reconnecting" class="alert info">
      FAR2 正在重启，WebUI 正在自动重新连接…
    </div>

    <section class="grid">
      <article class="card">
        <div class="card-title">
          <span>部署能力</span>
          <span class="badge" :class="capability?.supported ? 'ok' : 'warn'">
            {{ capability?.supported ? '可一键升级' : '当前不可升级' }}
          </span>
        </div>
        <dl>
          <div><dt>运行模式</dt><dd>{{ capability?.mode || '-' }}</dd></div>
          <div><dt>自动重启</dt><dd>{{ capability?.autoRestart ? '已就绪' : '不可用' }}</dd></div>
          <div><dt>当前分支</dt><dd>{{ status?.branch || '-' }}</dd></div>
          <div>
            <dt>更新源</dt><dd class="mono break">
              {{ capability?.origin || 'xianyumht-cmd/far2 → main' }}
            </dd>
          </div>
        </dl>
        <p class="hint">
          {{ reasonText[capability?.reason || ''] || capability?.reason || '正在检测…' }}
        </p>
      </article>

      <article class="card">
        <div class="card-title">
          <span>版本</span>
          <span class="badge" :class="updateAvailable ? 'update' : 'ok'">
            {{ updateAvailable ? '有更新' : '当前版本' }}
          </span>
        </div>
        <dl>
          <div><dt>当前版本</dt><dd>v{{ status?.currentVersion || '-' }}</dd></div>
          <div><dt>最新版本</dt><dd>v{{ state.latestVersion || '-' }}</dd></div>
          <div>
            <dt>当前提交</dt><dd class="mono">
              {{ currentShortSha }}
            </dd>
          </div>
          <div>
            <dt>目标提交</dt><dd class="mono">
              {{ targetShortSha }}
            </dd>
          </div>
          <div><dt>上次检查</dt><dd>{{ formatTime(state.checkedAt) }}</dd></div>
        </dl>
      </article>
    </section>

    <section class="card progress-card">
      <div class="card-title">
        <span>升级状态</span>
        <span class="badge" :class="['failed', 'rollback_failed', 'recovery_required', 'interrupted'].includes(String(state.phase || '')) ? 'danger' : operationActive ? 'update' : 'ok'">
          {{ phaseLabel(state.phase) }}
        </span>
      </div>
      <div class="progress-line">
        <div class="dot" :class="{ active: operationActive }" />
        <div>
          <strong>{{ state.message || '等待检查更新' }}</strong>
          <p>阶段：{{ state.stage || '-' }} · 更新时间：{{ formatTime(state.updatedAt) }}</p>
        </div>
      </div>
      <div v-if="state.lastError" class="failure-box">
        <strong>失败原因</strong>
        <span>{{ state.lastError }}</span>
      </div>
      <div v-if="state.rollbackError" class="failure-box critical">
        <strong>自动回滚异常</strong>
        <span>{{ state.rollbackError }}</span>
      </div>
    </section>

    <section class="card">
      <div class="card-title">
        <span>本次更新内容</span>
        <span class="muted">最多显示 20 条提交</span>
      </div>
      <ul v-if="releaseNotes.length" class="notes">
        <li v-for="note in releaseNotes" :key="note" class="mono">
          {{ note }}
        </li>
      </ul>
      <p v-else class="empty">
        检查更新后会在这里显示 main 上的新提交。
      </p>
    </section>

    <section class="safety-card">
      <strong>升级保护</strong>
      <span>固定官方 origin/main</span>
      <span>拒绝脏工作区与分叉历史</span>
      <span>pnpm --frozen-lockfile</span>
      <span>完整 pnpm verify</span>
      <span>失败自动回滚</span>
      <span>成功才自动重启</span>
    </section>
  </div>
</template>

<style scoped>
.update-page {
  width: min(1120px, 100%);
  margin: 0 auto;
  padding: 8px 4px 40px;
  display: grid;
  gap: 18px;
}

.hero-card,
.card,
.safety-card {
  border: 1px solid var(--border-color, rgba(148, 163, 184, 0.2));
  background: var(--card-bg, rgba(15, 23, 42, 0.72));
  border-radius: 18px;
}

.hero-card {
  padding: 26px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
}

.eyebrow {
  margin: 0 0 8px;
  font-size: 12px;
  letter-spacing: 0.16em;
  opacity: 0.55;
}

h1 {
  margin: 0;
  font-size: 30px;
}

.subtitle {
  margin: 9px 0 0;
  opacity: 0.7;
}

.hero-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.btn {
  min-width: 112px;
  border: 0;
  border-radius: 11px;
  padding: 10px 16px;
  font-weight: 650;
  cursor: pointer;
}

.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.btn.primary {
  background: #2563eb;
  color: white;
}

.btn.secondary {
  background: rgba(148, 163, 184, 0.13);
  color: inherit;
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
}

.card {
  padding: 20px;
}

.card-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
  font-weight: 700;
}

.badge {
  border-radius: 999px;
  padding: 4px 9px;
  font-size: 12px;
  font-weight: 650;
}

.badge.ok {
  background: rgba(34, 197, 94, 0.14);
  color: #22c55e;
}
.badge.warn {
  background: rgba(245, 158, 11, 0.14);
  color: #f59e0b;
}
.badge.update {
  background: rgba(59, 130, 246, 0.14);
  color: #60a5fa;
}
.badge.danger {
  background: rgba(239, 68, 68, 0.14);
  color: #f87171;
}

dl {
  margin: 0;
  display: grid;
  gap: 11px;
}

dl > div {
  display: flex;
  justify-content: space-between;
  gap: 16px;
}

dt {
  opacity: 0.55;
}
dd {
  margin: 0;
  text-align: right;
}

.hint,
.empty,
.progress-line p {
  margin: 14px 0 0;
  opacity: 0.62;
  line-height: 1.6;
}

.progress-line {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.dot {
  width: 10px;
  height: 10px;
  margin-top: 6px;
  border-radius: 50%;
  background: #64748b;
}

.dot.active {
  background: #3b82f6;
  box-shadow: 0 0 0 6px rgba(59, 130, 246, 0.12);
}

.failure-box,
.alert {
  border-radius: 12px;
  padding: 12px 14px;
}

.failure-box {
  margin-top: 14px;
  display: grid;
  gap: 5px;
  background: rgba(239, 68, 68, 0.08);
  color: #f87171;
}

.failure-box.critical {
  background: rgba(239, 68, 68, 0.16);
}
.alert.error {
  background: rgba(239, 68, 68, 0.12);
  color: #f87171;
}
.alert.info {
  background: rgba(59, 130, 246, 0.12);
  color: #60a5fa;
}

.notes {
  margin: 0;
  padding-left: 20px;
  display: grid;
  gap: 8px;
}

.safety-card {
  padding: 14px 18px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  font-size: 13px;
}

.safety-card span {
  opacity: 0.62;
}
.muted {
  font-size: 12px;
  opacity: 0.5;
  font-weight: 500;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.break {
  overflow-wrap: anywhere;
}

@media (max-width: 760px) {
  .hero-card {
    align-items: stretch;
    flex-direction: column;
  }
  .hero-actions {
    width: 100%;
  }
  .btn {
    flex: 1;
  }
  .grid {
    grid-template-columns: 1fr;
  }
  dl > div {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
  }
  dd {
    text-align: left;
  }
}
</style>
