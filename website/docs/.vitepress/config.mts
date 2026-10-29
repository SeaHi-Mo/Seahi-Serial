import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitepress'
import type { DefaultTheme } from 'vitepress'
import { locales } from './locales/index.ts'
import { APP_VERSION as APP_VERSION_RAW } from './download.ts'

const DOCS_ROOT = resolve(process.cwd(), 'docs')

/**
 * 版本号优先取 CI 注入的 APP_VERSION（tag 名，例如 v0.5.22）。
 * 没有时从仓库根目录的 package.json 读取 —— Cloudflare Pages 这类只跑
 * `npm run build` 的环境不需要额外配置环境变量，发版时更新 package.json 即可。
 * 走 themeConfig 而不是 Vite 的 define：define 在 SSR 渲染阶段不生效，
 * 首页那个 <VersionBadge /> 会在构建时报 "__APP_VERSION__ is not defined"。
 */
const APP_VERSION = APP_VERSION_RAW

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
  // 本地搜索：索引在构建时生成。provider 必须写在**根** themeConfig 里，
  // 只放语言包不会触发索引生成（搜索框会是空的）。
  search: { provider: 'local' },
}

export default defineConfig({
  // 站点挂在 www.seahi-serial.c-hi.cn 根上，不要改成带路径的 base
  base: '/',
  cleanUrls: true,
  lastUpdated: true,

  title: 'SeaHi Serial',
  titleTemplate: ':title · SeaHi Serial',

  head: [
    ['link', { rel: 'icon', href: '/favicon.ico' }],
    ['meta', { name: 'theme-color', content: '#0b57d0' }],
  ],

  // zh-CN 在根路径，en 在 /en/
  locales,

  themeConfig,

  // 兜底：某些构建环境（浅克隆 / VitePress 缓存）拿不到 page.lastUpdated，
  // 这里直接从 git 补一次文件最后提交时间，保证页脚能显示「更新时间」。
  transformPageData(pageData) {
    if (pageData.lastUpdated) return
    try {
      const out = execSync(`git log -1 --pretty=%at -- "${pageData.filePath}"`, {
        cwd: DOCS_ROOT,
        encoding: 'utf8',
      }).trim()
      const ts = Number(out)
      if (ts > 0) pageData.lastUpdated = ts * 1000
    } catch {
      // 没有 git 或浅克隆里取不到时保持原值
    }
  },
})
