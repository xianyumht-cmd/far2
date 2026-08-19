<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseTextarea from '@/components/ui/BaseTextarea.vue'

const props = defineProps<{
  show: boolean
  editData?: any
}>()

const emit = defineEmits(['close', 'saved'])

const activeTab = ref<'wx' | 'manual'>('manual')
const loading = ref(false)
const errorMessage = ref('')
const residentAccountName = ref('微信农场')

const form = reactive({
  name: '',
  code: '',
  platform: 'qq' as 'qq' | 'wx',
})

const editingWx = computed(() => String(props.editData?.platform || '').toLowerCase() === 'wx')

async function addAccount(data: any) {
  const res = await api.post('/api/accounts', data)
  if (!res.data.ok)
    throw new Error(res.data.error || '保存失败')
  return res.data.data
}

async function submitManual() {
  errorMessage.value = ''

  if (editingWx.value) {
    if (!form.name.trim()) {
      errorMessage.value = '请输入账号备注'
      return
    }
    loading.value = true
    try {
      await addAccount({ id: props.editData.id, name: form.name.trim() })
      emit('saved')
      close()
    }
    catch (e: any) {
      errorMessage.value = `保存失败: ${e.response?.data?.error || e.message}`
    }
    finally {
      loading.value = false
    }
    return
  }

  if (!form.code) {
    errorMessage.value = '请输入Code'
    return
  }

  let code = form.code.trim()
  const match = code.match(/[?&]code=([^&]+)/i)
  if (match && match[1]) {
    code = decodeURIComponent(match[1])
    form.code = code
  }

  const payload = props.editData
    ? {
        id: props.editData.id,
        name: form.name,
        code,
        platform: 'qq',
        loginType: 'manual',
      }
    : {
        name: form.name,
        code,
        platform: 'qq',
        loginType: 'manual',
      }

  loading.value = true
  try {
    await addAccount(payload)
    emit('saved')
    close()
  }
  catch (e: any) {
    errorMessage.value = `保存失败: ${e.response?.data?.error || e.message}`
  }
  finally {
    loading.value = false
  }
}

async function enrollResidentWechat() {
  if (props.editData)
    return

  loading.value = true
  errorMessage.value = ''
  try {
    const name = residentAccountName.value.trim() || '微信农场'
    const data = await addAccount({
      name,
      platform: 'wx',
      loginType: 'windows_wechat',
      codeRefreshEnabled: true,
      codeRefreshMode: 'windows_wechat',
      wechatAppId: 'wx5306c5978fdb76e4',
    })

    const accounts = Array.isArray(data?.accounts) ? data.accounts : []
    const newAccount = accounts[accounts.length - 1]
    const accountId = String(newAccount?.id || '')
    if (!accountId)
      throw new Error('微信账号已保存，但无法确定账号 ID')

    const headers = { 'x-account-id': accountId }
    await api.post('/api/code-manager/config', {
      enabled: true,
      mode: 'windows_wechat',
    }, { headers })

    const refresh = await api.post('/api/code-manager/refresh', {
      reason: 'web_enroll',
    }, { headers })

    if (refresh.data?.data?.accepted !== true)
      throw new Error('Resident Agent 尚未就绪，账号已保存为等待 Provider 状态')

    emit('saved')
    close()
  }
  catch (e: any) {
    errorMessage.value = `微信接入失败: ${e.response?.data?.error || e.message}`
  }
  finally {
    loading.value = false
  }
}

function close() {
  emit('close')
}

watch(() => props.show, (newVal) => {
  if (!newVal)
    return

  errorMessage.value = ''
  if (props.editData) {
    activeTab.value = 'manual'
    form.name = props.editData.name || ''
    form.code = editingWx.value ? '' : (props.editData.code || '')
    form.platform = props.editData.platform || 'qq'
    residentAccountName.value = props.editData.name || '微信农场'
  }
  else {
    activeTab.value = 'manual'
    form.name = ''
    form.code = ''
    form.platform = 'qq'
    residentAccountName.value = '微信农场'
  }
})
</script>

<template>
  <div v-if="show" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
    <div class="max-h-[90vh] max-w-md w-full overflow-hidden rounded-lg shadow-xl" :style="{ background: 'var(--theme-bg)' }">
      <div class="flex items-center justify-between border-b p-4" :style="{ borderColor: 'color-mix(in srgb, var(--theme-text) 10%, transparent)' }">
        <h3 class="text-lg font-semibold" :style="{ color: 'var(--theme-text)' }">
          {{ editData ? '编辑账号' : '添加账号' }}
        </h3>
        <BaseButton variant="ghost" class="!p-1" @click="close">
          <div class="i-carbon-close text-xl" :style="{ color: 'var(--theme-text)' }" />
        </BaseButton>
      </div>

      <div class="max-h-[calc(90vh-80px)] overflow-y-auto p-4">
        <div v-if="errorMessage" class="mb-4 rounded p-3 text-sm" :style="{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444' }">
          {{ errorMessage }}
        </div>

        <div v-if="!editData" class="mb-4 flex border-b" :style="{ borderColor: 'color-mix(in srgb, var(--theme-text) 10%, transparent)' }">
          <button
            class="flex-1 py-2 text-center text-sm font-medium transition-colors"
            :class="activeTab === 'manual' ? 'border-b-2' : 'opacity-60'"
            :style="{
              color: activeTab === 'manual' ? 'var(--theme-primary)' : 'var(--theme-text)',
              borderColor: 'var(--theme-primary)',
            }"
            @click="activeTab = 'manual'"
          >
            QQ / 手动 Code
          </button>
          <button
            class="flex-1 py-2 text-center text-sm font-medium transition-colors"
            :class="activeTab === 'wx' ? 'border-b-2' : 'opacity-60'"
            :style="{
              color: activeTab === 'wx' ? 'var(--theme-primary)' : 'var(--theme-text)',
              borderColor: 'var(--theme-primary)',
            }"
            @click="activeTab = 'wx'"
          >
            使用当前已登录微信
          </button>
        </div>

        <div v-if="activeTab === 'wx' && !editData" class="space-y-4">
          <div class="rounded-lg border p-4 text-sm leading-6" :style="{ borderColor: 'color-mix(in srgb, var(--theme-text) 12%, transparent)', color: 'var(--theme-text)' }">
            <div class="font-semibold">
              Windows 桌面微信 Resident Agent
            </div>
            <div class="mt-2 opacity-75">
              使用当前电脑已经登录的微信接入 QQ经典农场。无需扫码、无需粘贴 Code，也不再使用旧 8059 登录接口。
            </div>
            <div class="mt-2 opacity-75">
              请先确保 FAR2WeChatAgent 正在运行，并已打开过一次 QQ经典农场。
            </div>
          </div>

          <BaseInput
            v-model="residentAccountName"
            label="账号备注"
            placeholder="微信农场"
          />

          <BaseButton variant="primary" block :loading="loading" @click="enrollResidentWechat">
            使用当前已登录微信
          </BaseButton>

          <div class="text-xs leading-5 opacity-60" :style="{ color: 'var(--theme-text)' }">
            FAR2 会通过 Resident Agent 获取 fresh Code，并启用 windows_wechat 自动恢复。若 Agent 暂时未就绪，会保持等待 Provider，不会回退到旧扫码/8059 路径。
          </div>
        </div>

        <div v-if="activeTab === 'manual'" class="space-y-4">
          <template v-if="editingWx">
            <div class="rounded-lg border p-4 text-sm leading-6" :style="{ borderColor: 'color-mix(in srgb, var(--theme-text) 12%, transparent)', color: 'var(--theme-text)' }">
              当前为 Windows 微信 Resident 账号。这里只修改备注，不显示或手工修改生产 Code。
            </div>
            <BaseInput
              v-model="form.name"
              label="账号备注"
              placeholder="微信农场"
            />
          </template>

          <template v-else>
            <BaseInput
              v-model="form.name"
              label="账号备注（可选）"
              placeholder="留空默认账号"
            />

            <BaseTextarea
              v-model="form.code"
              label="QQ 登录 Code"
              placeholder="请输入 QQ 小程序登录 Code"
              :rows="3"
            />

            <div v-if="!editData" class="rounded-lg border px-3 py-2 text-sm" :style="{ borderColor: 'color-mix(in srgb, var(--theme-text) 12%, transparent)', color: 'var(--theme-text)' }">
              平台：QQ 小程序
            </div>
          </template>

          <div class="flex justify-end gap-2 pt-4">
            <BaseButton variant="outline" @click="close">
              取消
            </BaseButton>
            <BaseButton variant="primary" :loading="loading" @click="submitManual">
              {{ editData ? '保存' : '添加 QQ 账号' }}
            </BaseButton>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
