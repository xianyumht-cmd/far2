<script setup lang="ts">
import { ref } from 'vue'
import AvatarFramePanel from '@/components/AvatarFramePanel.vue'
import BagPanel from '@/components/BagPanel.vue'
import CareerPanel from '@/components/CareerPanel.vue'
import DogPanel from '@/components/DogPanel.vue'
import FarmPanel from '@/components/FarmPanel.vue'
import TaskPanel from '@/components/TaskPanel.vue'

const currentTab = ref<'farm' | 'bag' | 'task' | 'dog' | 'career' | 'appearance'>('farm')
</script>

<template>
  <div class="h-full flex flex-col p-4">
    <div class="mb-4 flex space-x-2">
      <button
        class="rounded-lg px-4 py-2 font-medium transition-colors"
        :class="currentTab === 'farm'
          ? 'text-white shadow-md'
          : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="currentTab === 'farm' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="currentTab = 'farm'"
      >
        <div class="flex items-center space-x-2">
          <div class="i-carbon-sprout text-lg" />
          <span>我的农场</span>
        </div>
      </button>
      <button
        class="rounded-lg px-4 py-2 font-medium transition-colors"
        :class="currentTab === 'bag'
          ? 'text-white shadow-md'
          : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="currentTab === 'bag' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="currentTab = 'bag'"
      >
        <div class="flex items-center space-x-2">
          <div class="i-carbon-box text-lg" />
          <span>我的背包</span>
        </div>
      </button>
      <button
        class="rounded-lg px-4 py-2 font-medium transition-colors"
        :class="currentTab === 'task'
          ? 'text-white shadow-md'
          : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="currentTab === 'task' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="currentTab = 'task'"
      >
        <div class="flex items-center space-x-2">
          <div class="i-carbon-task text-lg" />
          <span>我的任务</span>
        </div>
      </button>
      <button
        class="rounded-lg px-4 py-2 font-medium transition-colors"
        :class="currentTab === 'dog'
          ? 'text-white shadow-md'
          : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="currentTab === 'dog' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="currentTab = 'dog'"
      >
        <div class="flex items-center space-x-2">
          <div class="i-carbon-paw text-lg" />
          <span>护主犬</span>
        </div>
      </button>
      <button
        class="rounded-lg px-4 py-2 font-medium transition-colors"
        :class="currentTab === 'career'
          ? 'text-white shadow-md'
          : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="currentTab === 'career' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="currentTab = 'career'"
      >
        <div class="flex items-center space-x-2">
          <div class="i-carbon-chart-histogram text-lg" />
          <span>个人生涯</span>
        </div>
      </button>
      <button
        class="rounded-lg px-4 py-2 font-medium transition-colors"
        :class="currentTab === 'appearance'
          ? 'text-white shadow-md'
          : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
        :style="currentTab === 'appearance' ? { backgroundColor: 'var(--theme-primary)' } : {}"
        @click="currentTab = 'appearance'"
      >
        <div class="flex items-center space-x-2">
          <div class="i-carbon-user-avatar-filled-alt text-lg" />
          <span>头像框</span>
        </div>
      </button>
    </div>

    <div class="flex-1 overflow-hidden overflow-y-auto">
      <Transition
        mode="out-in"
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="transform opacity-0 scale-95"
        enter-to-class="transform opacity-100 scale-100"
        leave-active-class="transition duration-150 ease-in"
        leave-from-class="transform opacity-100 scale-100"
        leave-to-class="transform opacity-0 scale-95"
      >
        <component :is="currentTab === 'farm' ? FarmPanel : (currentTab === 'bag' ? BagPanel : (currentTab === 'task' ? TaskPanel : (currentTab === 'dog' ? DogPanel : (currentTab === 'career' ? CareerPanel : AvatarFramePanel))))" />
      </Transition>
    </div>
  </div>
</template>
