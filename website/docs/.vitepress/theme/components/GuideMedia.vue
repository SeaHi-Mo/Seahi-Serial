<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  src?: string
  poster: string
  alt?: string
  /**
   * 显示宽度。数字按像素（`width="760"`），字符串原样用（`width="80%"`）。
   * 不给就按 CSS 默认：截图保持原尺寸、录屏撑满正文宽度。
   * 图片本身仍有 max-width:100%，窄屏不会溢出。
   */
  width?: number | string
}>()

const figureStyle = computed(() => {
  const w = props.width
  if (w === undefined || w === null || w === '') return undefined
  // Markdown 里的属性一律是字符串（width="760"），数字串也要补单位，否则 CSS 不认
  const s = String(w).trim()
  return { width: /^\d+(\.\d+)?$/.test(s) ? `${s}px` : s }
})
</script>

<!--
  不出图注（2026-11 用户要求：所有图片都不需要 caption）。
  说明文字写在正文里，图片本身只负责给画面；alt 只在传了 alt 时才有内容。
-->
<template>
  <figure class="gmedia" :style="figureStyle">
    <video
      v-if="src"
      autoplay
      muted
      loop
      playsinline
      preload="metadata"
      :poster="poster"
      :aria-label="alt"
    >
      <source :src="src" type="video/mp4" />
    </video>
    <img v-else class="gmedia-img" :src="poster" :alt="alt || ''" loading="lazy" />
    <img v-if="src" class="gmedia-fallback" :src="poster" :alt="alt || ''" loading="lazy" />
  </figure>
</template>
