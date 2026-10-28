import { defineConfig } from 'vitepress'
import type { DefaultTheme } from 'vitepress'
import { locales } from './locales/index.ts'

/**
 * 版本号由 CI 注入（tag 名，例如 v0.5.20）；本地构建/预览显示 dev。
 * 走 themeConfig 而不是 Vite 的 define：define 在 SSR 渲染阶段不生效，
 * 首页那个 <VersionBadge /> 会在构建时报 "__APP_VERSION__ is not defined"。
 */
const APP_VERSION = process.env.APP_VERSION || 'dev'

const REPO = 'https://github.com/SeaHi-Mo/Seahi-Serial'

/**
 * 全站共用、与语言无关的 themeConfig。
 * 各语言的 nav / sidebar / 文案在 locales/*.ts 里，由 locales/index.ts 组装；
 * VitePress 按属性合并两者（语言包覆盖同名键，其余继承这里）。
 */
const themeConfig: DefaultTheme.Config & { appVersion: string } = {
  logo: '/logo.png',
  siteTitle: 'SeaHi Serial',
  appVersion: APP_VERSION,
  socialLinks: [{ icon: 'github', link: REPO }],
  // 语言包只补 text，pattern 留在这里
  editLink: { pattern: `${REPO}/edit/main/website/docs/:path` },
}

export default defineConfig({
  // 站点挂在子域根上（serial.<你的域名>），不要改成带路径的 base
  base: '/',
  cleanUrls: true,

  title: 'SeaHi Serial',
  titleTemplate: ':title · SeaHi Serial',

  head: [
    ['link', { rel: 'icon', href: '/favicon.ico' }],
    ['meta', { name: 'theme-color', content: '#0b57d0' }],
  ],

  // zh-CN 在根路径，en 在 /en/
  locales,

  themeConfig,
})
