import type { LocaleContent } from './types.ts'

const REPO = 'https://github.com/SeaHi-Mo/Seahi-Serial'
const RELEASES = `${REPO}/releases/latest`

/**
 * English：挂在 `/en/` 下。
 * 侧边栏分组与中文保持一致；新增英文页时同步更新这里（指向不存在的页面会构建失败）。
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
      {
        text: 'Serial',
        items: [
          { text: 'Serial debugging', link: '/en/guide/serial' },
          { text: 'Terminal mode', link: '/en/guide/terminal' },
          { text: 'Quick commands', link: '/en/guide/quick-cmds' },
        ],
      },
      {
        text: 'Devices',
        items: [
          { text: 'Bluetooth', link: '/en/guide/ble' },
          { text: 'ADB and WSL', link: '/en/guide/adb-wsl' },
        ],
      },
      {
        text: 'Reference',
        items: [{ text: 'FAQ', link: '/en/guide/faq' }],
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
