/** 落地页文案（中英各一份）。页面结构在 LandingHome.vue 里，这里只放会变的字。 */

export interface LandingCopy {
  nav: { guide: string; mcp: string; github: string; download: string }
  lang: { zh: string; en: string }
  hero: {
    titleA: string
    titleSub: string
    lede1: string
    lede2: string
    cta: string
    winLabel: string
  }
  section: {
    title: string
    /** 每张卡按名字取文案，顺序由 FeatureCards 的模板决定（WSL 排在第二位） */
    panes: { title: string; body: string }
    wsl: { title: string; body: string }
    qcmd: { title: string; body: string }
    gatt: { title: string; body: string }
    terminal: { title: string; body: string }
  }
  /** 内置 MCP 服务器（替换掉原来的「接入方式」整章） */
  mcp: { title: string; body: string }
  closing: {
    title: string
    body: string
    actions: { label: string; href: string; primary?: boolean }[]
  }
  footer: { bilibili: string; oshwhub: string; jlc: string; mid: string; docs: string; download: string }
}

const REPO = 'https://github.com/SeaHi-Mo/Seahi-Serial'
const RELEASES = `${REPO}/releases/latest`

const zh: LandingCopy = {
  nav: { guide: '指南', mcp: 'MCP', github: 'GitHub', download: '下载' },
  lang: { zh: '中文', en: 'EN' },
  hero: {
    titleA: 'SeaHi Serial',
    titleSub: '所有调试口，收进一个窗口',
    lede1: '串口、蓝牙、ADB、WSL 各开一栏，互不打扰。',
    lede2: '内置 54 个 MCP 工具，AI 可以读日志、发指令。12 套主题可选。',
    cta: '下载安装包',
    winLabel: '真实界面截图：串口已连接，快速指令侧栏展开',
  },
  section: {
    title: '功能一览',
    panes: {
      title: '多串口同屏',
      body: '每个分栏有独立的端口、波特率和行尾，可以同时开多栏。',
    },
    wsl: {
      title: 'WSL 端口映射',
      body: '把 USB 串口映射进 WSL。设备、状态和自动映射在一张表里，映射后可在 WSL 分栏收发。',
    },
    qcmd: {
      title: '快速指令',
      body: '一组一张表，按顺序号循环发送。可以等设备回话：OK 继续，ERROR 重发，超时跳转。',
    },
    gatt: {
      title: '蓝牙 GATT',
      body: '扫描、连接、浏览服务树。服务和特征用 SIG 名称，CTS 时间会转成可读时间。',
    },
    terminal: {
      title: '真终端',
      body: '输出区可以切成 xterm 终端。vim、top 能用，方向键和 Ctrl 组合键直接发给设备。',
    },
  },
  mcp: {
    title: '内置 MCP 服务器',
    body: '程序自带 MCP 服务器。AI 客户端连上后能直接读日志、发指令、订阅通知，不用你手动复制输出。',
  },
  closing: {
    title: '把串口助手交给 AI',
    body: '下载后在设置里启用 MCP 服务器，再按文档把客户端连上。',
    actions: [
      { label: '查看 GitHub', href: REPO, primary: true },
      { label: '阅读文档', href: '/guide/quick-start' },
      { label: '下载安装包', href: 'download' },
    ],
  },
  footer: { bilibili: 'Bilibili', oshwhub: '嘉立创开源广场', jlc: '立创优选', mid: '© 2026 SeaHi Serial · MIT License', docs: '文档', download: '下载' },
}

const en: LandingCopy = {
  nav: { guide: 'Guide', mcp: 'MCP', github: 'GitHub', download: 'Download' },
  lang: { zh: '中文', en: 'EN' },
  hero: {
    titleA: 'SeaHi Serial',
    titleSub: 'Every debug port, one window.',
    lede1: 'Serial, BLE, ADB and WSL, each in its own pane.',
    lede2: '54 built-in MCP tools let an AI read logs and send commands. 12 themes.',
    cta: 'Download installer',
    winLabel: 'Real app screenshot: serial connected, quick-command sidebar open',
  },
  section: {
    title: 'Features',
    panes: {
      title: 'Many ports, one window',
      body: 'Each pane has its own port, baud rate and line ending. Open as many as you need.',
    },
    wsl: {
      title: 'WSL port mapping',
      body: 'Map a USB serial port into WSL. Device, status and auto-map in one table.',
    },
    qcmd: {
      title: 'Quick commands',
      body: 'Groups send in order. Wait for a reply: OK continues, ERROR retries, timeout jumps.',
    },
    gatt: {
      title: 'BLE GATT',
      body: 'Scan, connect and browse the GATT tree. Services use SIG names; CTS time is decoded.',
    },
    terminal: {
      title: 'A real terminal',
      body: 'Switch the pane to an xterm terminal. vim and top work; arrow keys and Ctrl combos go to the device.',
    },
  },
  mcp: {
    title: 'Built-in MCP server',
    body: 'The app ships an MCP server. An AI client can read logs, send commands and subscribe to notifications instead of copying output by hand.',
  },
  closing: {
    title: 'Hand your serial console to an AI',
    body: 'Install it, enable the MCP server in settings, then connect your client as described in the docs.',
    actions: [
      { label: 'View on GitHub', href: REPO, primary: true },
      { label: 'Read the docs', href: '/en/guide/quick-start' },
      { label: 'Download', href: 'download' },
    ],
  },
  footer: { bilibili: 'Bilibili', oshwhub: 'OSHWHub', jlc: 'JLC Store', mid: '© 2026 SeaHi Serial · MIT License', docs: 'Docs', download: 'Download' },
}

export function getCopy(lang: string): LandingCopy {
  return lang.toLowerCase().startsWith('en') ? en : zh
}
