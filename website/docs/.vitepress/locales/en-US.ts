import type { LocaleContent } from './types.ts'
import { DOWNLOAD_ASSET } from '../download.ts'

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
    { text: 'Download', link: DOWNLOAD_ASSET },
  ],

  sidebar: {
    '/en/dev/': [
      {
        text: 'Development',
        items: [
          { text: 'Development guide', link: '/en/dev/' },
          { text: 'Skills', link: '/en/dev/skills' },
        ],
      },
    ],
    '/en/guide/': [
      {
        text: 'Get started',
        items: [
          { text: 'Quick start', link: '/en/guide/quick-start' },
          { text: 'App interface and settings', link: '/en/guide/interface' },
        ],
      },
      {
        text: 'Serial',
        items: [
          { text: 'Serial debugging', link: '/en/guide/serial' },
          { text: 'Terminal mode', link: '/en/guide/terminal' },
          { text: 'Quick commands', link: '/en/guide/quick-cmds' },
          { text: 'WSL port mapping', link: '/en/guide/wsl' },
        ],
      },
      {
        text: 'Devices',
        items: [
          { text: 'Bluetooth', link: '/en/guide/ble' },
          { text: 'ADB debugging', link: '/en/guide/adb' },
        ],
      },
      {
        text: 'Node-RED automation <span class="nav-new">new</span>',
        items: [
          { text: 'Overview', link: '/en/guide/automation/' },
          { text: 'Quick start', link: '/en/guide/automation/quick-start' },
          {
            text: 'Node reference',
            collapsed: true,
            items: [
              { text: 'Overview', link: '/en/guide/automation/nodes' },
              { text: 'serial txd', link: '/en/guide/automation/nodes/serial-txd' },
              { text: 'serial rxd', link: '/en/guide/automation/nodes/serial-rxd' },
              { text: 'serial request', link: '/en/guide/automation/nodes/serial-request' },
              { text: 'cmd list', link: '/en/guide/automation/nodes/cmd-list' },
              {
                text: 'Built-in nodes',
                collapsed: true,
                items: [
                  { text: 'Overview', link: '/en/guide/automation/nodes/official' },
                  {
                    text: 'Common',
                    collapsed: true,
                    items: [
                      { text: 'inject', link: '/en/guide/automation/nodes/official/inject' },
                      { text: 'debug', link: '/en/guide/automation/nodes/official/debug' },
                      { text: 'complete', link: '/en/guide/automation/nodes/official/complete' },
                      { text: 'catch', link: '/en/guide/automation/nodes/official/catch' },
                      { text: 'status', link: '/en/guide/automation/nodes/official/status' },
                      { text: 'link in', link: '/en/guide/automation/nodes/official/link-in' },
                      { text: 'link out', link: '/en/guide/automation/nodes/official/link-out' },
                      { text: 'link call', link: '/en/guide/automation/nodes/official/link-call' },
                      { text: 'comment', link: '/en/guide/automation/nodes/official/comment' },
                      { text: 'global-config', link: '/en/guide/automation/nodes/official/global-config' },
                    ],
                  },
                  {
                    text: 'Function',
                    collapsed: true,
                    items: [
                      { text: 'function', link: '/en/guide/automation/nodes/official/function' },
                      { text: 'switch', link: '/en/guide/automation/nodes/official/switch' },
                      { text: 'change', link: '/en/guide/automation/nodes/official/change' },
                      { text: 'range', link: '/en/guide/automation/nodes/official/range' },
                      { text: 'template', link: '/en/guide/automation/nodes/official/template' },
                      { text: 'delay', link: '/en/guide/automation/nodes/official/delay' },
                      { text: 'trigger', link: '/en/guide/automation/nodes/official/trigger' },
                      { text: 'exec', link: '/en/guide/automation/nodes/official/exec' },
                      { text: 'rbe', link: '/en/guide/automation/nodes/official/rbe' },
                    ],
                  },
                  {
                    text: 'Sequence',
                    collapsed: true,
                    items: [
                      { text: 'split', link: '/en/guide/automation/nodes/official/split' },
                      { text: 'join', link: '/en/guide/automation/nodes/official/join' },
                      { text: 'sort', link: '/en/guide/automation/nodes/official/sort' },
                      { text: 'batch', link: '/en/guide/automation/nodes/official/batch' },
                    ],
                  },
                  {
                    text: 'Parser',
                    collapsed: true,
                    items: [
                      { text: 'csv', link: '/en/guide/automation/nodes/official/csv' },
                      { text: 'json', link: '/en/guide/automation/nodes/official/json' },
                      { text: 'xml', link: '/en/guide/automation/nodes/official/xml' },
                      { text: 'yaml', link: '/en/guide/automation/nodes/official/yaml' },
                      { text: 'html', link: '/en/guide/automation/nodes/official/html' },
                    ],
                  },
                ],
              },
            ],
          },
          { text: 'Common flows', link: '/en/guide/automation/flows' },
        ],
      },
      {
        text: 'MCP',
        items: [{ text: 'MCP setup', link: '/en/guide/mcp' }],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Themes', link: '/en/guide/theme' },
          { text: 'Error reporting', link: '/en/guide/error-reporting' },
          { text: 'FAQ', link: '/en/guide/faq' },
        ],
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
