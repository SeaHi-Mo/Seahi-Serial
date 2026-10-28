<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useData } from 'vitepress'
import { getCopy } from './copy'
import AppWindow from './AppWindow.vue'
import FeatureCards from './FeatureCards.vue'
import { RELEASES_LIST } from './releases.generated'

const { lang, theme } = useData()
const t = computed(() => getCopy(lang.value))
const isEn = computed(() => lang.value.toLowerCase().startsWith('en'))

const REPO = 'https://github.com/SeaHi-Mo/Seahi-Serial'
const RELEASES = `${REPO}/releases/latest`

/* 下载走国内加速：ghfast.top 代理 GitHub 的发布页 / 安装包（哈希仍以 GitHub 为准） */
const MIRROR = 'https://ghfast.top/'
const appVersion = computed(() => String(theme.value.appVersion || '').replace(/^v/, ''))
const hasVersion = computed(() => /^\d+\.\d+\.\d+$/.test(appVersion.value))
const downloadPage = computed(() => `${MIRROR}${RELEASES}`)

/* 版本下拉：默认最新（RELEASES_LIST 是构建时从 git tag 生成的，倒序） */
const versions = computed(() => (RELEASES_LIST.length ? RELEASES_LIST : hasVersion.value ? [appVersion.value] : []))
const selectedVersion = ref(versions.value[0] || appVersion.value)
const downloadAsset = computed(() => {
  const v = selectedVersion.value
  if (!/^\d+\.\d+\.\d+$/.test(v)) return downloadPage.value
  return `${MIRROR}${REPO}/releases/download/v${v}/Seahi-Serial-Setup-${v}.exe`
})

/* 页脚社媒：Bilibili / 嘉立创开源广场 / 立创优选（链接里的 jlc_vid 是对方给的追踪参数，原样保留） */
const SOCIAL = {
  bilibili: 'https://space.bilibili.com/355202584',
  oshwhub:
    'https://oshwhub.com/seahi?tab=works&jspm=hub.ex.zp&jlc_vid=FlVcVVcFEVUNXgZUFARcAQdfFgBaAwYHElBZUwdQRlExVlNfRFBWVlNfQVlYXztWKAkaExQVTU5BCBcOAAkbBUoFGAw%3D',
  jlc: 'https://www.jlc-yx.com/store/629626440220585986?jlc_vid=T1AMA10CTwAPVQdWE1RcVFdSQQNaBQIDQlEKUlJXFlQxVlNfRFBWVl1XRFhbVTtWKAkaExQVTU5BEBMRWQsCBEkfD08NCAk=',
}



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
          <a class="lp-nav-link" :href="REPO" target="_blank" rel="noopener">{{ t.nav.github }}</a>
          <span class="lp-lang">
            <a href="/" :class="{ on: !isEn }">{{ t.lang.zh }}</a>
            <a href="/en/" :class="{ on: isEn }">{{ t.lang.en }}</a>
          </span>
          <a class="lp-btn lp-btn-primary lp-btn-s" :href="downloadPage">{{ t.nav.download }}</a>
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
              <a class="lp-btn lp-btn-primary lp-btn-m" :href="downloadAsset">
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
              <label v-if="versions.length" class="lp-ver">
                <select v-model="selectedVersion" aria-label="选择版本">
                  <option v-for="v in versions" :key="v" :value="v">v{{ v }}</option>
                </select>
              </label>

            </div>
          </div>

          <div class="lp-win-wrap">
            <AppWindow />
          </div>
        </div>
      </section>

      <FeatureCards />

      <section class="lp-sec lp-wrap lp-mcp-sec">
        <div class="lp-sec-h lp-reveal">
          <h2>{{ t.mcp.title }}</h2>
          <p class="lp-mcp-lede">{{ t.mcp.body }}</p>
        </div>
        <!-- 照真实设置窗：标题 + 监听状态 + 一行控件 -->
        <div class="lp-mcp lp-reveal">
          <div class="lp-mcp-hd">
            <span class="lp-mcp-name">MCP 服务器</span>
            <span class="lp-mcp-dot"></span>
            <span class="lp-mcp-status">监听中 · 127.0.0.1:7777 · 0 个会话</span>
          </div>
          <div class="lp-mcp-ctl">
            <span class="lp-mcp-btn primary">关闭 MCP 服务器</span>
            <span class="lp-mcp-select">HTTP<i>▾</i></span>
            <span class="lp-mcp-btn">只读模式</span>
            <span class="lp-mcp-btn ghost">重置令牌</span>
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
              :href="a.href === 'download' ? downloadAsset : a.href"
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
          <a :href="SOCIAL.bilibili" target="_blank" rel="noopener">
            <img class="lp-f-ico" src="/img/social/bilibili.png" width="16" height="16" alt="" />
            {{ t.footer.bilibili }}
          </a>
          <span class="lp-f-sep">·</span>
          <a :href="SOCIAL.oshwhub" target="_blank" rel="noopener">
            <img class="lp-f-ico" src="/img/social/oshwhub.png" width="16" height="16" alt="" />
            {{ t.footer.oshwhub }}
          </a>
          <span class="lp-f-sep">·</span>
          <a :href="SOCIAL.jlc" target="_blank" rel="noopener">
            <img class="lp-f-ico" src="/img/social/jlc.png" width="16" height="16" alt="" />
            {{ t.footer.jlc }}
          </a>
        </div>
        <div class="lp-f-mid">{{ t.footer.mid }}</div>
        <div class="lp-f-right">
          <a href="/guide/quick-start">{{ t.footer.docs }}</a>
          <span class="lp-f-sep">·</span>
          <a :href="downloadPage">{{ t.footer.download }}</a>
        </div>
      </div>
    </footer>
  </div>
</template>
