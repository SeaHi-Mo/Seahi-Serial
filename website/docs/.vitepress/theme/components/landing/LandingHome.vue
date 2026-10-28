<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useData } from 'vitepress'
import { getCopy } from './copy'
import AppWindow from './AppWindow.vue'
import FeatureCards from './FeatureCards.vue'

const { lang } = useData()
const t = computed(() => getCopy(lang.value))
const isEn = computed(() => lang.value.toLowerCase().startsWith('en'))

const REPO = 'https://github.com/SeaHi-Mo/Seahi-Serial'
const RELEASES = `${REPO}/releases/latest`

const copyLabel = computed(() => (isEn.value ? 'Copy' : '复制'))
const copiedLabel = computed(() => (isEn.value ? 'Copied' : '已复制'))

/* 顶栏：滚过 8px 变毛玻璃胶囊 */
const scrolled = ref(false)
const onScroll = () => {
  scrolled.value = window.scrollY > 8
}

/* 区块进入视口时淡入 */
let io: IntersectionObserver | undefined
onMounted(() => {
  onScroll()
  window.addEventListener('scroll', onScroll, { passive: true })
  if (!('IntersectionObserver' in window)) {
    document.querySelectorAll('.lp-reveal').forEach((el) => el.classList.add('lp-in'))
    return
  }
  io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('lp-in')
          io?.unobserve(e.target)
        }
      })
    },
    { threshold: 0.15, rootMargin: '0px 0px -8% 0px' },
  )
  document.querySelectorAll<HTMLElement>('.lp-reveal').forEach((el) => {
    // 已经在视口里的立刻显示：别让首屏内容等一次异步回调
    if (el.getBoundingClientRect().top < window.innerHeight * 0.92) el.classList.add('lp-in')
    io?.observe(el)
  })
  // 兜底：IO 不触发（截图工具 / 很老的浏览器）时也不能整页空着
  window.setTimeout(() => {
    document.querySelectorAll('.lp-reveal:not(.lp-in)').forEach((el) => el.classList.add('lp-in'))
  }, 1200)
})
onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll)
  io?.disconnect()
})

/* 复制命令 */
const copied = ref('')
const copy = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    return
  }
  copied.value = text
  window.setTimeout(() => {
    if (copied.value === text) copied.value = ''
  }, 1400)
}
</script>

<template>
  <div class="lp-root">
    <header class="lp-hdr">
      <div class="lp-hdr-bar" :class="{ 'lp-scrolled': scrolled }">
        <a class="lp-logo" href="/">
          <img src="/logo.png" width="22" height="22" alt="" />
          <span>SeaHi Serial</span>
        </a>
        <nav class="lp-nav">
          <a class="lp-nav-link" href="/guide/quick-start">{{ t.nav.guide }}</a>
          <a class="lp-nav-link" href="/mcp/">{{ t.nav.mcp }}</a>
          <a class="lp-nav-link" :href="REPO" target="_blank" rel="noopener">{{ t.nav.github }}</a>
          <span class="lp-lang">
            <a href="/" :class="{ on: !isEn }">{{ t.lang.zh }}</a>
            <a href="/en/" :class="{ on: isEn }">{{ t.lang.en }}</a>
          </span>
          <a class="lp-btn lp-btn-primary lp-btn-s" :href="RELEASES">{{ t.nav.download }}</a>
        </nav>
      </div>
    </header>

    <main>
      <section class="lp-hero">
        <div class="lp-hero-glow" aria-hidden="true"></div>
        <div class="lp-wrap lp-hero-inner">
          <div class="lp-hero-copy">
            <div class="lp-enter lp-hero-head">
              <h1>
                <span class="lp-lat">{{ t.hero.titleA }}</span><br />
                {{ t.hero.titleSub }}
              </h1>
            </div>
            <div class="lp-lede lp-enter lp-d1">
              <p>{{ t.hero.lede1 }}</p>
              <p>{{ t.hero.lede2 }}</p>
            </div>
            <div class="lp-cta-row lp-enter lp-d2">
              <a class="lp-btn lp-btn-primary lp-btn-m" :href="RELEASES">
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M8 1.5v8.2m0 0L4.9 6.6M8 9.7l3.1-3.1M2 11.6v1.4c0 .8.7 1.5 1.5 1.5h9c.8 0 1.5-.7 1.5-1.5v-1.4"
                    stroke="currentColor"
                    stroke-width="1.3"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                {{ t.hero.cta }}
              </a>
              <a class="lp-btn lp-btn-secondary lp-btn-m" :href="REPO" target="_blank" rel="noopener">
                <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path
                    d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"
                  />
                </svg>
                {{ t.hero.ghostLabel }}
              </a>
            </div>
          </div>

          <div class="lp-win-wrap">
            <AppWindow />
          </div>
        </div>
      </section>

      <FeatureCards />

      <section class="lp-dev-sec lp-wrap">
        <div class="lp-dev-h lp-reveal">
          <h2>{{ t.dev.title }}</h2>
        </div>
        <div class="lp-grid2 lp-grid-tight">
          <div
            v-for="(c, i) in t.dev.cards"
            :key="i"
            class="lp-dev-card lp-reveal"
            :class="i ? 'lp-d1' : ''"
          >
            <div class="lp-dev-inner">
              <h3>{{ c.title }}</h3>
              <p>{{ c.body }}</p>
              <div class="lp-code">
                <code><span class="lp-dollar">$ </span>{{ c.cmd }}</code>
                <button type="button" class="lp-copy" @click="copy(c.cmd)">
                  {{ copied === c.cmd ? copiedLabel : copyLabel }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div class="lp-closing">
        <div class="lp-grid-bg" aria-hidden="true"><div class="lp-grid-inner"></div></div>
        <div class="lp-halo lp-a" aria-hidden="true"></div>
        <div class="lp-halo lp-b" aria-hidden="true"></div>
        <div class="lp-halo lp-c" aria-hidden="true"></div>
        <section class="lp-wrap lp-closing-inner lp-reveal">
          <h2>{{ t.closing.title }}</h2>
          <p class="lp-cta-desc">{{ t.closing.body }}</p>
          <div class="lp-cta-actions">
            <a
              v-for="a in t.closing.actions"
              :key="a.label"
              class="lp-btn lp-btn-m"
              :class="a.primary ? 'lp-btn-primary' : 'lp-btn-secondary'"
              :href="a.href"
            >
              {{ a.label }}
            </a>
          </div>
        </section>
      </div>
    </main>

    <footer class="lp-footer lp-wrap">
      <div class="lp-f-line"></div>
      <div class="lp-f-body">
        <div class="lp-f-left">
          <a :href="REPO" target="_blank" rel="noopener">{{ t.footer.github }}</a>
        </div>
        <div class="lp-f-mid">{{ t.footer.mid }}</div>
        <div class="lp-f-right">
          <a href="/guide/quick-start">{{ t.footer.docs }}</a>
          <span class="lp-f-sep">·</span>
          <a :href="RELEASES">{{ t.footer.download }}</a>
        </div>
      </div>
    </footer>
  </div>
</template>
