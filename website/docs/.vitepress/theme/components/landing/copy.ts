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
    ghostLabel: string
    winLabel: string
  }
  section: {
    title: string
    cards: { title: string; body: string }[]
    wsl: { title: string; body: string }
  }
  dev: {
    title: string
    cards: { title: string; body: string; cmd: string }[]
  }
  closing: {
    title: string
    body: string
    actions: { label: string; href: string; primary?: boolean }[]
  }
  footer: { github: string; mid: string; docs: string; download: string }
}

const REPO = 'https://github.com/SeaHi-Mo/Seahi-Serial'
const RELEASES = `${REPO}/releases/latest`

const zh: LandingCopy = {
  nav: { guide: '指南', mcp: 'MCP', github: 'GitHub', download: '下载' },
  lang: { zh: '中文', en: 'EN' },
  hero: {
    titleA: 'SeaHi Serial',
    titleSub: '一个窗口，把设备调通',
    lede1: '串口、蓝牙、ADB、WSL，都在一个窗口里。',
    lede2: '内置 54 个 MCP 工具，AI 可以读日志、发指令。12 套主题可选。',
    cta: '下载安装包',
    ghostLabel: 'GitHub',
    winLabel: '产品界面预览：多串口输出区与快速指令面板',
  },
  section: {
    title: '功能一览',
    cards: [
      {
        title: '多串口同屏',
        body: '每个分栏有独立的端口、波特率和行尾。插拔设备时列表自动刷新。',
      },
      {
        title: '真终端',
        body: '输出区可以切成 xterm 终端。vim、top 能用，方向键和 Ctrl 组合键直接发给设备。',
      },
      {
        title: '快速指令',
        body: '一组一张表，按顺序号循环发送。可以等设备回话：OK 继续，ERROR 重发，超时跳转。',
      },
      {
        title: '蓝牙 GATT',
        body: '扫描、连接、浏览服务树。服务和特征用 SIG 名称，CTS 时间会转成可读时间。',
      },
    ],
    wsl: {
      title: 'WSL 端口映射',
      body: '把 USB 串口映射进 WSL。设备、状态和自动映射在一张表里，映射后可在 WSL 分栏收发。',
    },
  },
  dev: {
    title: '接入方式',
    cards: [
      {
        title: '接入 AI',
        body: '内置 MCP 服务器，一条命令写好客户端配置。',
        cmd: 'npx seahi-serial-mcp install',
      },
      {
        title: '从源码构建',
        body: 'Rust + Tauri 2，构建和测试说明在仓库里。',
        cmd: 'git clone https://github.com/SeaHi-Mo/Seahi-Serial',
      },
    ],
  },
  closing: {
    title: '把 AI 接上你的串口',
    body: 'MCP 服务器随程序启动，只监听本机。客户端连上后可以读日志、发指令、订阅蓝牙通知。调用记录单独保存，不写入 config.json。',
    actions: [
      { label: '查看 GitHub', href: REPO, primary: true },
      { label: '阅读文档', href: '/guide/quick-start' },
      { label: '下载安装包', href: RELEASES },
    ],
  },
  footer: { github: 'GitHub', mid: '© 2026 SeaHi Serial · MIT License', docs: '文档', download: '下载' },
}

const en: LandingCopy = {
  nav: { guide: 'Guide', mcp: 'MCP', github: 'GitHub', download: 'Download' },
  lang: { zh: '中文', en: 'EN' },
  hero: {
    titleA: 'SeaHi Serial',
    titleSub: 'One window. Everything talks.',
    lede1: 'Serial, BLE, ADB and WSL in one window.',
    lede2: '54 built-in MCP tools let an AI read logs and send commands. 12 themes.',
    cta: 'Download installer',
    ghostLabel: 'GitHub',
    winLabel: 'Product preview: multiple serial panes with the quick-command panel',
  },
  section: {
    title: 'Features',
    cards: [
      {
        title: 'Many ports, one window',
        body: 'Each pane has its own port, baud rate and line ending. The port list refreshes on plug/unplug.',
      },
      {
        title: 'A real terminal',
        body: 'Switch the pane to an xterm terminal. vim and top work; arrow keys and Ctrl combos go to the device.',
      },
      {
        title: 'Quick commands',
        body: 'Groups send in order. Wait for a reply: OK continues, ERROR retries, timeout jumps.',
      },
      {
        title: 'BLE GATT',
        body: 'Scan, connect and browse the GATT tree. Services use SIG names; CTS time is decoded.',
      },
    ],
    wsl: {
      title: 'WSL port mapping',
      body: 'Map a USB serial port into WSL. Device, status and auto-map in one table.',
    },
  },
  dev: {
    title: 'Get started',
    cards: [
      {
        title: 'Connect an AI',
        body: 'The MCP server is built in. One command writes the client config.',
        cmd: 'npx seahi-serial-mcp install',
      },
      {
        title: 'Build from source',
        body: 'Rust + Tauri 2. Build and test notes are in the repo.',
        cmd: 'git clone https://github.com/SeaHi-Mo/Seahi-Serial',
      },
    ],
  },
  closing: {
    title: 'Plug an AI into your serial port',
    body: 'The MCP server starts with the app and listens on localhost only. A connected client can read logs, send data and subscribe to BLE notifications. Call records are kept out of your config.',
    actions: [
      { label: 'View on GitHub', href: REPO, primary: true },
      { label: 'Read the docs', href: '/en/guide/quick-start' },
      { label: 'Download', href: RELEASES },
    ],
  },
  footer: { github: 'GitHub', mid: '© 2026 SeaHi Serial · MIT License', docs: 'Docs', download: 'Download' },
}

export function getCopy(lang: string): LandingCopy {
  return lang.toLowerCase().startsWith('en') ? en : zh
}
