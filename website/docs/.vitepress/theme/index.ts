import DefaultTheme from 'vitepress/theme'
import VersionBadge from './components/VersionBadge.vue'
import GuideMedia from './components/GuideMedia.vue'
import LandingHome from './components/landing/LandingHome.vue'
import './styles/vars.css'
import './styles/base.css'
import './styles/home.css'
import './styles/landing.css'
import './styles/guide-media.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }: { app: any }) {
    // 全局组件：Markdown 里直接写标签
    app.component('VersionBadge', VersionBadge)
    app.component('GuideMedia', GuideMedia)
    app.component('LandingHome', LandingHome)
  },
}
