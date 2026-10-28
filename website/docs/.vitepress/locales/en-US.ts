import type { LocaleContent } from './types.ts'

const REPO = 'https://github.com/SeaHi-Mo/Seahi-Serial'
const RELEASES = `${REPO}/releases/latest`

/**
 * English：挂在 `/en/` 下。
 * ⚠️ 侧边栏只能指向**已经存在的 /en/ 页面** —— 指向没翻译的页面会被 VitePress 的失效链接检查判为构建失败。
 */
export const enUS: LocaleContent = {
  label: 'English',
  lang: 'en-US',
  description:
    'Serial & BLE debugging for Windows: multiple ports, a real xterm terminal, GATT browser, ADB and a built-in MCP server.',

  nav: [
    { text: 'Guide', link: '/en/guide/quick-start', activeMatch: '/en/guide/' },
    { text: 'MCP', link: '/en/mcp/', activeMatch: '/en/mcp/' },
    { text: 'Download', link: RELEASES },
    { text: 'GitHub', link: REPO },
  ],

  sidebar: {
    '/en/guide/': [
      {
        text: 'Get started',
        items: [{ text: 'Quick start', link: '/en/guide/quick-start' }],
      },
    ],
    '/en/mcp/': [
      {
        text: 'MCP',
        items: [{ text: 'Overview', link: '/en/mcp/' }],
      },
    ],
  },

  text: {
    outline: 'On this page',
    prev: 'Previous',
    next: 'Next',
    lastUpdated: 'Last updated',
    returnToTop: 'Return to top',
    sidebarMenu: 'Menu',
    darkMode: 'Appearance',
    language: 'Language',
    editThisPage: 'Edit this page on GitHub',
    footerMessage: 'Released under the MIT License · installers are not code-signed',
  },

  searchTranslations: {
    button: { buttonText: 'Search', buttonAriaLabel: 'Search' },
    modal: {
      displayDetails: 'Show details',
      resetButtonTitle: 'Reset',
      backButtonTitle: 'Back',
      noResultsText: 'No results found',
      footer: { selectText: 'select', navigateText: 'navigate', closeText: 'close' },
    },
  },
}
