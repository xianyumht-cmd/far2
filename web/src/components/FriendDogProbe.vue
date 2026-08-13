<script setup lang="ts">
import { computed } from 'vue'

interface ProbeField {
  field?: number
  wire?: number
  varint?: string | number
  byteLength?: number
}

interface DogProbe {
  present?: boolean
  fieldNo?: number
  byteLength?: number
  parseComplete?: boolean
  readOnly?: boolean
  fields?: ProbeField[]
}

const props = defineProps<{
  probe?: DogProbe | null
}>()

const DOG_NAMES: Record<number, string> = {
  90001: '田园犬',
  90002: '牧羊犬',
  90003: '斑点狗',
  90011: '柯基',
  90021: '护主犬',
}

function getVarint(fieldNo: number) {
  const field = props.probe?.fields?.find(item => Number(item?.field) === fieldNo && Number(item?.wire) === 0)
  if (!field || field.varint === undefined)
    return 0
  const value = Number.parseInt(String(field.varint), 10)
  return Number.isFinite(value) && value > 0 ? value : 0
}

const dogId = computed(() => getVarint(1))
const dogName = computed(() => DOG_NAMES[dogId.value] || '')
const field2Value = computed(() => getVarint(2))
</script>

<template>
  <div
    v-if="probe"
    class="mb-3 border rounded-lg p-3"
    :class="probe.present
      ? 'border-violet-200 bg-violet-50 dark:border-violet-800/60 dark:bg-violet-950/20'
      : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800'"
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2 font-medium text-gray-700 dark:text-gray-200">
        <div class="i-carbon-data-vis-1" />
        护主犬协议探针
      </div>
      <span
        class="rounded px-2 py-0.5 text-xs"
        :class="probe.present
          ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300'
          : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300'"
      >
        {{ probe.present ? 'field 3 已返回' : 'field 3 未返回' }}
      </span>
    </div>

    <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">
      只读 · 不增加请求 · {{ probe.byteLength || 0 }} bytes
      <span v-if="probe.parseComplete === false"> · 解析未完整</span>
    </div>

    <div v-if="probe.present && dogId" class="mt-2 flex flex-wrap items-center gap-2 text-sm">
      <span class="rounded bg-violet-100 px-2 py-1 font-medium text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
        {{ dogName || '已识别犬种 ID' }}（{{ dogId }}）
      </span>
      <span v-if="field2Value" class="rounded bg-amber-50 px-2 py-1 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
        未确认字段 f2：{{ field2Value }}
      </span>
    </div>

    <div v-if="probe.fields?.length" class="mt-2 flex flex-wrap gap-1.5">
      <span
        v-for="(field, index) in probe.fields"
        :key="`dog-probe-${index}`"
        class="rounded bg-white px-2 py-1 font-mono text-xs text-gray-600 shadow-sm dark:bg-gray-800 dark:text-gray-300"
      >
        f{{ field.field }}/w{{ field.wire }}
        <template v-if="field.varint !== undefined">={{ field.varint }}</template>
        <template v-else-if="field.byteLength !== undefined"> · {{ field.byteLength }}B</template>
      </span>
    </div>
    <div v-else class="mt-2 text-xs text-gray-400">
      暂无可展示的嵌套 wire 字段。
    </div>
  </div>
</template>
