<script setup lang="ts">
import { computed } from 'vue'
import { useData } from 'vitepress'
import { getCopy } from './copy'

const { lang } = useData()
const t = computed(() => getCopy(lang.value))

/**
 * 首页产品窗口 = **真实程序的录制画面**，不是 DOM 临摹、也不是 CSS 假动画。
 *
 * hero.mp4 由 v0.5.21 release 构建逐帧抓窗口（15fps）后编码：主分栏接真实 Linux 设备
 * （COM9 / USB-SERIAL CH340），期间真的发送命令、日志真的滚动，快速指令侧栏的数据
 * 来自程序自己的配置。同名 hero.png 是第一帧（poster + 减少动态效果时的静态回退）。
 * 更新流程：跑起程序 → 连接设备 → 按需切换界面 → 录帧/截图覆盖 `docs/public/img/landing/`。
 * **别再照着源码重画一个"像界面"的东西** —— 页面上展示的必须是程序真的渲染出来的画面。
 */
</script>

<template>
  <figure class="aw-shot motion" role="img" :aria-label="t.hero.winLabel">
    <video autoplay muted loop playsinline preload="metadata" poster="/img/landing/hero.png" :aria-label="t.hero.winLabel">
      <source src="/img/landing/hero.mp4" type="video/mp4" />
    </video>
    <img class="motion-still" src="/img/landing/hero.png" width="1456" height="959" :alt="t.hero.winLabel" loading="lazy" />
  </figure>
</template>
