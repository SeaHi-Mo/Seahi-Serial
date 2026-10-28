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
  window: {
    title: string
    port: string
    baud: string
    lineEnd: string
    run: string
    sendPlaceholder: string
    cmdTitle: string
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
    lede1: '多串口分栏、xterm 真终端、蓝牙 GATT、ADB 与 WSL —— 调试时在几个工具之间来回切的日子结束了。',
    lede2: '内置 54 个 MCP 工具，让 AI 直接读日志、发指令；12 套主题，盯一整天也不刺眼。',
    cta: '下载安装包',
    ghostLabel: 'GitHub',
    winLabel: '产品界面预览：多串口输出区与快速指令面板',
  },
  window: {
    title: 'SeaHi Serial — COM3 · 115200',
    port: 'COM3',
    baud: '115200',
    lineEnd: '行尾 CRLF',
    run: '开始监控',
    sendPlaceholder: '输入要发送的内容，↑↓ 翻历史',
    cmdTitle: '快速指令',
  },
  section: {
    title: '插上、打开、发一条 —— 剩下的它都在',
    cards: [
      {
        title: '多串口同屏',
        body: '每个分栏独立的端口、波特率与行尾；多个分栏同时在线，插拔自动刷新列表。',
      },
      {
        title: '真终端',
        body: '输出区切成 xterm：vim、top 能用，方向键与 Ctrl 组合键原样发给设备。',
      },
      {
        title: '快速指令',
        body: '一组一张表，按顺序号循环；发一条等回话，OK 继续、ERROR 重发、超时跳转。',
      },
      {
        title: '蓝牙 GATT',
        body: '扫描、连接、浏览服务树；服务与特征用 SIG 官方名称，CTS 时间直接翻成人话。',
      },
    ],
    wsl: {
      title: 'WSL 端口映射',
      body: '把 USB 串口映射进 WSL：设备、状态、自动映射都在一张表里；映射完直接在 WSL 分栏里收发。',
    },
  },
  dev: {
    title: '两种接法',
    cards: [
      {
        title: '让 AI 接管',
        body: '程序内置 MCP 服务器，一条命令把客户端配置写好。',
        cmd: 'npx seahi-serial-mcp install',
      },
      {
        title: '从源码构建',
        body: 'Rust + Tauri 2，仓库里带着完整的构建与测试说明。',
        cmd: 'git clone https://github.com/SeaHi-Mo/Seahi-Serial',
      },
    ],
  },
  closing: {
    title: '把 AI 接上你的串口',
    body: 'MCP 服务器随程序启动、只监听回环。客户端连上后，AI 能读日志、发指令、订阅蓝牙通知 —— 和你点按钮走的是同一条路，调用记录单独存放，绝不污染你的配置。',
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
    lede1:
      'Multiple serial panes, a real xterm terminal, BLE GATT, ADB and WSL — no more juggling three tools while debugging.',
    lede2:
      '54 built-in MCP tools let an AI read logs and send commands; 12 themes keep it easy on the eyes all day.',
    cta: 'Download installer',
    ghostLabel: 'GitHub',
    winLabel: 'Product preview: multiple serial panes with the quick-command panel',
  },
  window: {
    title: 'SeaHi Serial — COM3 · 115200',
    port: 'COM3',
    baud: '115200',
    lineEnd: 'Line ending CRLF',
    run: 'Start',
    sendPlaceholder: 'Type to send, ↑↓ for history',
    cmdTitle: 'Quick commands',
  },
  section: {
    title: 'Plug in, open, send — the rest is already there',
    cards: [
      {
        title: 'Many ports, one window',
        body: 'Each pane has its own port, baud rate and line ending. Run several at once; the list refreshes on plug/unplug.',
      },
      {
        title: 'A real terminal',
        body: 'Switch the pane to xterm: vim and top work, arrow keys and Ctrl combos go straight to the device.',
      },
      {
        title: 'Quick commands',
        body: 'Groups loop in order. Send a line and wait for the reply: OK continues, ERROR retries, timeout jumps.',
      },
      {
        title: 'BLE GATT',
        body: 'Scan, connect, browse the tree. Services use Bluetooth SIG names, and CTS time is decoded into plain text.',
      },
    ],
    wsl: {
      title: 'WSL port mapping',
      body: 'Map a USB serial port into WSL — device, status and auto-map in one table, then use it from any WSL pane.',
    },
  },
  dev: {
    title: 'Two ways in',
    cards: [
      {
        title: 'Let an AI drive',
        body: 'The MCP server is built into the app — one command writes the client config.',
        cmd: 'npx seahi-serial-mcp install',
      },
      {
        title: 'Build from source',
        body: 'Rust + Tauri 2, with the full build and test instructions in the repo.',
        cmd: 'git clone https://github.com/SeaHi-Mo/Seahi-Serial',
      },
    ],
  },
  closing: {
    title: 'Plug an AI into your serial port',
    body: 'The MCP server starts with the app and binds to loopback only. Once connected, the model can read logs, send data and subscribe to BLE notifications — through the same code paths as the UI, with call records kept separate.',
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
