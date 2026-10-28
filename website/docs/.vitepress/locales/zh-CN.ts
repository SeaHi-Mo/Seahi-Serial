import type { LocaleContent } from './types.ts'

const REPO = 'https://github.com/SeaHi-Mo/Seahi-Serial'
const RELEASES = `${REPO}/releases/latest`

/** 简体中文：挂在站点根路径（`/`），是默认语言 */
export const zhCN: LocaleContent = {
  label: '简体中文',
  lang: 'zh-CN',
  description:
    'Windows 上的串口 / 蓝牙调试工具：多串口分栏、xterm 真终端、GATT 浏览器、ADB 与内置 MCP 服务器。',

  nav: [
    { text: '指南', link: '/guide/quick-start', activeMatch: '/guide/' },
    { text: 'MCP', link: '/mcp/', activeMatch: '/mcp/' },
    { text: '下载', link: RELEASES },
    { text: 'GitHub', link: REPO },
  ],

  sidebar: {
    '/guide/': [
      {
        text: '开始',
        items: [{ text: '快速开始', link: '/guide/quick-start' }],
      },
      {
        text: '串口',
        items: [
          { text: '串口调试', link: '/guide/serial' },
          { text: '终端模式', link: '/guide/terminal' },
          { text: '快速指令', link: '/guide/quick-cmds' },
        ],
      },
      {
        text: '设备',
        items: [
          { text: '蓝牙调试', link: '/guide/ble' },
          { text: 'ADB 与 WSL', link: '/guide/adb-wsl' },
        ],
      },
      {
        text: '参考',
        items: [{ text: '常见问题', link: '/guide/faq' }],
      },
    ],
    '/mcp/': [
      {
        text: 'MCP（AI 控制接口）',
        items: [
          { text: '总览与接入', link: '/mcp/' },
          { text: '工具参考', link: '/mcp/tools' },
        ],
      },
    ],
  },

  text: {
    outline: '本页目录',
    prev: '上一篇',
    next: '下一篇',
    lastUpdated: '最后更新',
    returnToTop: '回到顶部',
    sidebarMenu: '目录',
    darkMode: '主题',
    language: '语言',
    editThisPage: '在 GitHub 上编辑此页',
    footerMessage: '基于 MIT 许可证发布 · 安装包未做代码签名',
  },

  searchTranslations: {
    button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
    modal: {
      displayDetails: '显示详情',
      resetButtonTitle: '清除',
      backButtonTitle: '返回',
      noResultsText: '没有找到相关内容',
      footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
    },
  },
}
