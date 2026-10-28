import type { DefaultTheme, LocaleSpecificConfig } from 'vitepress'
import type { LocaleContent } from './types.ts'
import { zhCN } from './zh-CN.ts'
import { enUS } from './en-US.ts'

/**
 * 把语言包翻译成 VitePress 的 locale 配置。
 *
 * 只放**与语言相关**的 themeConfig：logo / socialLinks / editLink.pattern / appVersion
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
      sidebar: locale.sidebar,
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
      editLink: { text: locale.text.editThisPage },
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
