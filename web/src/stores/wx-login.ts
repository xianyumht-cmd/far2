import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export interface WxLoginConfig {
  enabled: boolean
  apiBase: string
  apiKey: string
  proxyApiUrl: string
  appId: string
  autoAddAccount: boolean
  userIsolation: boolean
}

const retiredMessage = '旧微信扫码/8059 登录链路已退役，请使用“使用当前已登录微信” Resident Agent 接入。'

export const useWxLoginStore = defineStore('wx-login', () => {
  const rawConfig = ref<WxLoginConfig>({
    enabled: false,
    apiBase: '',
    apiKey: '',
    proxyApiUrl: '',
    appId: 'wx5306c5978fdb76e4',
    autoAddAccount: false,
    userIsolation: true,
  })

  const config = computed<WxLoginConfig>(() => ({
    ...rawConfig.value,
    enabled: false,
    apiBase: '',
    apiKey: '',
    proxyApiUrl: '',
    appId: 'wx5306c5978fdb76e4',
    autoAddAccount: false,
  }))

  const isLoading = ref(false)
  const qrCode = ref<string | null>(null)
  const uuid = ref('')
  const wxid = ref('')
  const status = ref<'idle' | 'qr_loading' | 'qr_ready' | 'scanning' | 'confirming' | 'success' | 'error'>('idle')
  const statusMessage = ref('')
  const errorMessage = ref('')
  const qrEndpoint = ''
  const currentUserId = computed(() => 'resident')
  const useProxyMode = computed(() => false)

  function resetState() {
    qrCode.value = null
    uuid.value = ''
    wxid.value = ''
    status.value = 'idle'
    statusMessage.value = ''
    errorMessage.value = ''
  }

  async function loadConfigFromServer() {
    rawConfig.value = {
      ...rawConfig.value,
      enabled: false,
      apiBase: '',
      apiKey: '',
      proxyApiUrl: '',
      appId: 'wx5306c5978fdb76e4',
      autoAddAccount: false,
    }
  }

  async function getQRCode(): Promise<boolean> {
    status.value = 'error'
    statusMessage.value = ''
    errorMessage.value = retiredMessage
    return false
  }

  async function checkLogin(): Promise<{ success: boolean, wxid?: string, nickname?: string }> {
    status.value = 'error'
    statusMessage.value = ''
    errorMessage.value = retiredMessage
    return { success: false }
  }

  async function getFarmCode(): Promise<{ success: boolean, code?: string }> {
    status.value = 'error'
    statusMessage.value = ''
    errorMessage.value = retiredMessage
    return { success: false }
  }

  return {
    config,
    isLoading,
    qrCode,
    uuid,
    wxid,
    status,
    statusMessage,
    errorMessage,
    qrEndpoint,
    currentUserId,
    useProxyMode,
    resetState,
    getQRCode,
    checkLogin,
    getFarmCode,
    loadConfigFromServer,
  }
})
