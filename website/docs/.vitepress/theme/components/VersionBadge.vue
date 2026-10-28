<script setup>
import { computed } from 'vue'
import { useData } from 'vitepress'

// 版本号来自 themeConfig.appVersion（见 .vitepress/config.mts 的注释）：
// 用 themeConfig 而不是 Vite 的 define，是因为 define 在 SSR 阶段不生效。
const { theme } = useData()
const version = computed(() => theme.value.appVersion ?? 'dev')
</script>

<template>
  <span class="version-badge">{{ version }}</span>
</template>
