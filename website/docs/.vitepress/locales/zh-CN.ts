import type { LocaleContent } from './types.ts'
import { DOWNLOAD_ASSET } from '../download.ts'

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
    { text: '下载', link: DOWNLOAD_ASSET },
  ],

  sidebar: {
    '/dev/': [
      {
        text: '开发',
        items: [
          { text: '开发指南', link: '/dev/' },
          { text: '技能（skills）', link: '/dev/skills' },
        ],
      },
    ],
    '/guide/': [
      {
        text: '开始',
        items: [
          { text: '快速开始', link: '/guide/quick-start' },
          { text: '界面与设置', link: '/guide/interface' },
        ],
      },
      {
        text: '串口',
        items: [
          { text: '串口调试', link: '/guide/serial' },
          { text: '终端模式', link: '/guide/terminal' },
          { text: '快速指令', link: '/guide/quick-cmds' },
          { text: 'WSL 端口映射', link: '/guide/wsl' },
        ],
      },
      {
        text: '设备',
        items: [
          { text: '蓝牙调试', link: '/guide/ble' },
          { text: 'ADB 调试', link: '/guide/adb' },
        ],
      },
      {
        text: 'Node-RED 自动化 <span class="nav-new">new</span>',
        items: [
          { text: '概述', link: '/guide/automation/' },
          { text: '快速开始', link: '/guide/automation/quick-start' },
          {
            text: '节点说明',
            collapsed: true,
            items: [
              { text: '概览', link: '/guide/automation/nodes' },
              { text: 'serial txd', link: '/guide/automation/nodes/serial-txd' },
              { text: 'serial rxd', link: '/guide/automation/nodes/serial-rxd' },
              { text: 'serial request', link: '/guide/automation/nodes/serial-request' },
              { text: 'cmd list', link: '/guide/automation/nodes/cmd-list' },
              {
                text: '官方节点',
                collapsed: true,
                items: [
                  { text: '概览', link: '/guide/automation/nodes/official' },
                  {
                    text: '通用',
                    collapsed: true,
                    items: [
                      { text: 'inject', link: '/guide/automation/nodes/official/inject' },
                      { text: 'debug', link: '/guide/automation/nodes/official/debug' },
                      { text: 'complete', link: '/guide/automation/nodes/official/complete' },
                      { text: 'catch', link: '/guide/automation/nodes/official/catch' },
                      { text: 'status', link: '/guide/automation/nodes/official/status' },
                      { text: 'link in', link: '/guide/automation/nodes/official/link-in' },
                      { text: 'link out', link: '/guide/automation/nodes/official/link-out' },
                      { text: 'link call', link: '/guide/automation/nodes/official/link-call' },
                      { text: 'comment', link: '/guide/automation/nodes/official/comment' },
                      { text: 'global-config', link: '/guide/automation/nodes/official/global-config' },
                    ],
                  },
                  {
                    text: '功能',
                    collapsed: true,
                    items: [
                      { text: 'function', link: '/guide/automation/nodes/official/function' },
                      { text: 'switch', link: '/guide/automation/nodes/official/switch' },
                      { text: 'change', link: '/guide/automation/nodes/official/change' },
                      { text: 'range', link: '/guide/automation/nodes/official/range' },
                      { text: 'template', link: '/guide/automation/nodes/official/template' },
                      { text: 'delay', link: '/guide/automation/nodes/official/delay' },
                      { text: 'trigger', link: '/guide/automation/nodes/official/trigger' },
                      { text: 'exec', link: '/guide/automation/nodes/official/exec' },
                      { text: 'rbe', link: '/guide/automation/nodes/official/rbe' },
                    ],
                  },
                  {
                    text: '序列',
                    collapsed: true,
                    items: [
                      { text: 'split', link: '/guide/automation/nodes/official/split' },
                      { text: 'join', link: '/guide/automation/nodes/official/join' },
                      { text: 'sort', link: '/guide/automation/nodes/official/sort' },
                      { text: 'batch', link: '/guide/automation/nodes/official/batch' },
                    ],
                  },
                  {
                    text: '解析',
                    collapsed: true,
                    items: [
                      { text: 'csv', link: '/guide/automation/nodes/official/csv' },
                      { text: 'json', link: '/guide/automation/nodes/official/json' },
                      { text: 'xml', link: '/guide/automation/nodes/official/xml' },
                      { text: 'yaml', link: '/guide/automation/nodes/official/yaml' },
                      { text: 'html', link: '/guide/automation/nodes/official/html' },
                    ],
                  },
                ],
              },
            ],
          },
          { text: '常用流程', link: '/guide/automation/flows' },
        ],
      },
      {
        text: 'MCP',
        items: [{ text: 'MCP 接入', link: '/guide/mcp' }],
      },
      {
        text: '参考',
        items: [
          { text: '主题', link: '/guide/theme' },
          { text: '错误上报', link: '/guide/error-reporting' },
          { text: '常见问题', link: '/guide/faq' },
        ],
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
    lastUpdated: '更新时间',
    returnToTop: '回到顶部',
    sidebarMenu: '目录',
    darkMode: '主题',
    language: '语言',
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
