<script setup lang="ts">
defineProps<{ src?: string; poster: string; alt?: string; caption?: string }>()
</script>

<template>
  <figure class="gmedia">
    <video
      v-if="src"
      autoplay
      muted
      loop
      playsinline
      preload="metadata"
      :poster="poster"
      :aria-label="alt || caption"
    >
      <source :src="src" type="video/mp4" />
    </video>
    <img v-else class="gmedia-img" :src="poster" :alt="alt || caption" loading="lazy" />
    <img v-if="src" class="gmedia-fallback" :src="poster" :alt="alt || caption" loading="lazy" />
    <figcaption v-if="caption">{{ caption }}</figcaption>
  </figure>
</template>
