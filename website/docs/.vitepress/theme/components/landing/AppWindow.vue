<script setup lang="ts">
import { computed } from 'vue'
import { useData } from 'vitepress'
import { getCopy } from './copy'

const { lang } = useData()
const t = computed(() => getCopy(lang.value))

/**
 * 首页产品窗口 = **真实程序的截图**，不是 DOM 临摹。
 *
 * 截图来源：v0.5.21 release 构建，窗口 1440×950，主分栏接真实 Linux 设备（COM9 /
 * USB-SERIAL CH340），快速指令侧栏展开（数据来自程序自己的配置文件）。
 * 生成/更新方式：跑起程序 → 连接设备 → 按需切换界面 → 窗口截图另存到
 * `docs/public/img/landing/hero.png`。**别再照着源码重画一个"像界面"的东西** ——
 * 页面上展示的必须是程序真的渲染出来的画面。
 */
</script>

<template>
  <figure class="aw-shot" role="img" :aria-label="t.hero.winLabel">
    <img src="/img/landing/hero.png" width="1456" height="959" :alt="t.hero.winLabel" loading="lazy" />
  </figure>
</template>
