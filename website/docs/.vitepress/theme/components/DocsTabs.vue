<script setup lang="ts">
import { computed } from 'vue'
import { useData } from 'vitepress'

/**
 * 文档页的快捷栏（操作指南 / 更新日志）。
 * - variant="bar"：桌面端，固定在导航下方、横跨整行（含左侧导航之上）；
 * - variant="side"：窄屏，放进侧栏抽屉顶部（桌面端隐藏）。
 * 由 theme/index.ts 分别挂到 `layout-top` 与 `sidebar-nav-before`。
 */
const props = withDefaults(defineProps<{ variant?: 'bar' | 'side' }>(), { variant: 'bar' })

const { lang, page } = useData()
const isEn = computed(() => lang.value.toLowerCase().startsWith('en'))
const rel = computed(() => page.value.relativePath || '')

const tabs = computed(() => [
  {
    label: isEn.value ? 'Guide' : '操作指南',
    href: isEn.value ? '/en/guide/quick-start' : '/guide/quick-start',
    active: /^(en\/)?guide\//.test(rel.value),
  },
  {
    label: isEn.value ? 'Changelog' : '更新日志',
    href: isEn.value ? '/en/changelog' : '/changelog',
    active: /changelog\.md$/.test(rel.value),
  },
])
</script>

<template>
  <nav class="docs-tabs" :class="`docs-tabs--${props.variant}`" aria-label="文档快捷入口">
    <a
      v-for="t in tabs"
      :key="t.href"
      :href="t.href"
      class="docs-tab"
      :class="{ active: t.active }"
      :aria-current="t.active ? 'page' : undefined"
      >{{ t.label }}</a
    >
  </nav>
</template>
