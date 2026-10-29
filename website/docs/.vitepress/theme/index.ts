import { h } from 'vue'
import DefaultTheme from 'vitepress/theme'
import DocsTabs from './components/DocsTabs.vue'
import VersionBadge from './components/VersionBadge.vue'
import GuideMedia from './components/GuideMedia.vue'
import LandingHome from './components/landing/LandingHome.vue'
import './styles/vars.css'
import './styles/base.css'
import './styles/home.css'
import './styles/landing.css'
import './styles/guide-media.css'
import './styles/docs-layout.css'
import './styles/docs-tabs.css'

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'layout-top': () => h(DocsTabs, { variant: 'bar' }),
      'sidebar-nav-before': () => h(DocsTabs, { variant: 'side' }),
    })
  },
  enhanceApp({ app }: { app: any }) {
    // 全局组件：Markdown 里直接写标签
    app.component('VersionBadge', VersionBadge)
    app.component('GuideMedia', GuideMedia)
    app.component('LandingHome', LandingHome)
  },
}
