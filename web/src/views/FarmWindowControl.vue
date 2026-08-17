<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import api from '@/api'
import { useToastStore } from '@/stores/toast'

interface FarmWindowControlState {
  version: number
  hidden: boolean
  visible: boolean
  updatedAt: number
  updatedBy: string
}

const toast = useToastStore()
const loading = ref(false)
const saving = ref(false)
const state = ref<FarmWindowControlState | null>(null)

const hidden = computed(() => state.value?.hidden !== false)
const statusText = computed(() => hidden.value ? '已隐藏' : '已显示')
const statusDetail = computed(() => hidden.value
  ? '农场仍在后台运行，只把 QQ 农场窗口移到屏幕外。'
  : '农场窗口保持在桌面可见，后台挂机与自动化不会停止。')

function formatTime(value: number) {
  if (!value)
    return '沿用默认隐藏状态'
  return new Date(value).toLocaleString()
}

async function load() {
  loading.value = true
  try {
    const res = await api.get('/api/code-manager/farm-window')
    state.value = res.data?.data || null
  }
  catch (error: any) {
    toast.error(error?.response?.data?.error || '读取农场窗口状态失败')
  }
  finally {
    loading.value = false
  }
}

async function setHidden(nextHidden: boolean) {
  if (saving.value || loading.value || hidden.value === nextHidden)
    return

  saving.value = true
  try {
    const res = await api.post('/api/code-manager/farm-window', { hidden: nextHidden })
    state.value = res.data?.data || state.value
    toast.success(nextHidden ? '农场窗口已切换为隐藏' : '农场窗口已切换为显示')
  }
  catch (error: any) {
    toast.error(error?.response?.data?.error || '切换农场窗口状态失败')
    await load()
  }
  finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="mx-auto w-full max-w-4xl space-y-5">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <div class="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
          <div class="i-carbon-view" />
          农场窗口控制
        </div>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          控制 Windows 桌面上的 QQ 农场窗口显示状态，不会关闭农场进程。
        </p>
      </div>
      <button
        class="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
        :disabled="loading || saving"
        @click="load"
      >
        <div class="i-carbon-restart" :class="loading ? 'animate-spin' : ''" />
        刷新状态
      </button>
    </div>

    <section class="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div class="flex flex-col gap-6 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-3">
            <h2 class="text-lg font-semibold text-gray-900 dark:text-white">
              隐藏农场窗口
            </h2>
            <span
              class="rounded-full px-2.5 py-1 text-xs font-semibold"
              :class="hidden ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'"
            >
              {{ loading && !state ? '读取中' : statusText }}
            </span>
          </div>
          <p class="mt-2 max-w-2xl text-sm leading-6 text-gray-500 dark:text-gray-400">
            {{ statusDetail }}
          </p>
        </div>

        <button
          type="button"
          role="switch"
          :aria-checked="hidden"
          :aria-label="hidden ? '显示农场窗口' : '隐藏农场窗口'"
          class="relative h-8 w-14 shrink-0 rounded-full transition disabled:cursor-not-allowed disabled:opacity-50"
          :class="hidden ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-gray-600'"
          :disabled="loading || saving || !state"
          @click="setHidden(!hidden)"
        >
          <span
            class="absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-transform"
            :class="hidden ? 'translate-x-3' : '-translate-x-6'"
          />
        </button>
      </div>

      <div class="grid gap-px border-t border-gray-100 bg-gray-100 sm:grid-cols-3 dark:border-gray-700 dark:bg-gray-700">
        <div class="bg-white p-5 dark:bg-gray-800">
          <div class="text-xs text-gray-400">当前状态</div>
          <div class="mt-1 font-medium text-gray-900 dark:text-white">
            {{ hidden ? '隐藏（后台运行）' : '显示（桌面可见）' }}
          </div>
        </div>
        <div class="bg-white p-5 dark:bg-gray-800">
          <div class="text-xs text-gray-400">最后修改</div>
          <div class="mt-1 text-sm font-medium text-gray-900 dark:text-white">
            {{ formatTime(state?.updatedAt || 0) }}
          </div>
        </div>
        <div class="bg-white p-5 dark:bg-gray-800">
          <div class="text-xs text-gray-400">修改来源</div>
          <div class="mt-1 text-sm font-medium text-gray-900 dark:text-white">
            {{ state?.updatedBy || '系统默认' }}
          </div>
        </div>
      </div>
    </section>

    <section class="rounded-xl border border-blue-200 bg-blue-50 p-5 text-sm leading-6 text-blue-800 dark:border-blue-900/50 dark:bg-blue-900/20 dark:text-blue-200">
      <div class="flex gap-3">
        <div class="i-carbon-information mt-1 shrink-0 text-lg" />
        <div>
          <div class="font-semibold">
            这不是“关闭农场”
          </div>
          <p class="mt-1">
            FAR2CodeAgent 的计划任务会在当前 Windows 用户会话里启动窗口控制脚本。开启隐藏时只把识别到的 QQ 农场窗口移出屏幕；切回显示后会恢复窗口，农场进程和自动化始终继续运行。
          </p>
        </div>
      </div>
    </section>
  </div>
</template>
