import type { DefaultTheme, LocaleSpecificConfig } from 'vitepress'
import type { LocaleContent } from './types.ts'
import { zhCN } from './zh-CN.ts'
import { enUS } from './en-US.ts'
import { CHANGELOG_VERSIONS } from '../changelog-versions.ts'

/**
 * 更新日志不在指南的章节树里，但排版要和指南页一致（左侧要有导航）。
 * 语言包只声明了 `/guide/`（英文是 `/en/guide/`），这里给它派生一个侧栏：
 * 直接列出每个版本页，**最新在最上面**（没有单独的「全部版本」索引页 ——
 * 顶部「更新日志」标签直接落到最新版本页，历史版本从这里的列表进）。
 */
function withChangelogSidebar(sidebar: DefaultTheme.Sidebar | undefined, lang: string) {
  if (!sidebar || Array.isArray(sidebar)) return sidebar
  const out: Record<string, unknown> = { ...sidebar }
  const isEn = lang.toLowerCase().startsWith('en')
  const label = isEn ? 'Changelog' : '更新日志'
  for (const key of Object.keys(sidebar)) {
    if (!key.endsWith('/guide/')) continue
    const prefix = key.slice(0, -'/guide/'.length) // '' 或 '/en'
    out[`${prefix}/changelog`] = [
      {
        text: label,
        items: CHANGELOG_VERSIONS.map((v) => ({ text: v, link: `${prefix}/changelog/${v}` })),
      },
    ]
  }
  return out as DefaultTheme.Sidebar
}

/**
 * 把语言包翻译成 VitePress 的 locale 配置。
 *
 * 只放**与语言相关**的 themeConfig：nav / sidebar / 文案 / appVersion
 * 这些全站共用的留在 config.mts 的根 themeConfig 里 —— VitePress 会按属性合并
 * （locale 覆盖同名键，未覆盖的继承根配置），所以这里不用重复抄一遍。
 */
export function toLocaleConfig(
  locale: LocaleContent,
): LocaleSpecificConfig<DefaultTheme.Config> & { label: string } {
  return {
    label: locale.label,
    lang: locale.lang,
    description: locale.description,
    themeConfig: {
      nav: locale.nav,
      sidebar: withChangelogSidebar(locale.sidebar, locale.lang),
      search: {
        provider: 'local',
        options: { translations: locale.searchTranslations },
      } as DefaultTheme.Config['search'],
      outline: { level: [2, 3], label: locale.text.outline },
      docFooter: { prev: locale.text.prev, next: locale.text.next },
      lastUpdated: { text: locale.text.lastUpdated },
      returnToTopLabel: locale.text.returnToTop,
      sidebarMenuLabel: locale.text.sidebarMenu,
      darkModeSwitchLabel: locale.text.darkMode,
      langMenuLabel: locale.text.language,
      footer: { message: locale.text.footerMessage, copyright: 'SeaHi Serial' },
    },
  }
}

/**
 * 语言表。`root` 就是站点根路径（`/`），其余键是路径前缀（`en` → `/en/`）。
 * 新增语言：写好 `locales/xx-XX.ts`，在这里加一行，再到 docs 下建 `xx-XX/` 目录。
 */
export const locales = {
  root: toLocaleConfig(zhCN),
  en: toLocaleConfig(enUS),
}
