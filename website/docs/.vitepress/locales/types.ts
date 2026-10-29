import type { DefaultTheme } from 'vitepress'

/** 界面文案：和语言有关、但不属于页面内容的东西 */
export interface LocaleText {
  outline: string
  prev: string
  next: string
  lastUpdated: string
  returnToTop: string
  sidebarMenu: string
  darkMode: string
  language: string
  footerMessage: string
}

/** 本地搜索弹窗的文案（VitePress 的 LocalSearchTranslations 子集） */
export interface SearchTranslations {
  button: { buttonText: string; buttonAriaLabel: string }
  modal: {
    displayDetails: string
    resetButtonTitle: string
    backButtonTitle: string
    noResultsText: string
    footer: { selectText: string; navigateText: string; closeText: string }
  }
}

/**
 * 一个语言包需要提供的全部内容。
 * 新增语言 = 复制一份这个对象 + 在 locales/index.ts 里登记，不用碰 config.mts。
 */
export interface LocaleContent {
  /** 语言切换器上显示的标签 */
  label: string
  /** <html lang> 与 hreflang 用的 BCP 47 标记 */
  lang: string
  description: string
  nav: DefaultTheme.NavItem[]
  sidebar: DefaultTheme.Sidebar
  text: LocaleText
  searchTranslations: SearchTranslations
}
