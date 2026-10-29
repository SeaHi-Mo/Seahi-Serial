# SeaHi Serial

一款基于 **Tauri 2 + Rust** 的轻量级串口调试桌面工具，VS Code Serial Monitor 风格界面。

> 在线文档（含真实界面截图与录屏）：**https://www.seahi-serial.c-hi.cn/**

![Tauri](https://img.shields.io/badge/Tauri-2-blue?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-2021-orange?logo=rust&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-Windows-blue?logo=windows&logoColor=white)

<div align="center">
<img src="https://www.seahi-serial.c-hi.cn/img/landing/hero.png" width="55%">
<img src="https://www.seahi-serial.c-hi.cn/img/landing/feature-panes.png" width="55%">
</div>

## 功能特性

- **多串口同时连接** — 同窗口分栏显示，每个分栏独立操作互不干扰
- **完整串口配置** — 波特率（支持自定义输入）、数据位、停止位、校验位
- **DTR / RTS 实时切换** — 一键切换高低电平，适配不同硬件复位需求
- **发送历史记录** — 每栏独立保存最近 50 条发送记录，支持上下键快速回填
- **快速指令** — 自定义常用命令一键发送；支持**循环组**、**发一条等它回话**（超时 / 重试 / 成功与失败跳转）、
  可挂到外部文件上双向写回（见[快速指令](https://www.seahi-serial.c-hi.cn/guide/quick-cmds)）
- **自动化工作流** — 「收到匹配数据 → 自动执行动作（发数据 / 切 DTR·RTS / 存日志）」，规则可启停，命中会写进独立日志通道
- **ANSI 颜色解析** — 自动解析转义序列，以对应颜色显示
- **终端模式（真终端）** — 输出区换成 xterm.js：ANSI 光标/清屏/颜色、`vi`/`top` 这类全屏 TUI、
  方向键与 Ctrl 组合键、Tab 都**原样发给设备**（Linux 串口控制台直接可用）
- **自动重连** — 串口断开后自动尝试重新连接
- **原生日志导出** — 通过系统文件对话框选择日志保存路径
- **日志隐形缓存** — 每次打开串口后如有收发内容，自动缓存本次会话日志，最多保留 10 个文件、新建时自动淘汰最旧的
- **12 种主题** — 6 种风格（默认、浮世绘彩、诗意东方、水墨丹青、桃之夭夭、金风玉露）× 深浅色
- **WSL 端口映射** — 通过 usbipd-win 将 USB 串口映射到 WSL 环境（含自动映射与授权窗口）
- **WSL 串口监控** — 在 WSL 内直接调试串口设备
- **蓝牙调试（主机方向）** — 扫描周边 BLE 设备（含原始广播字节解析、设备类型识别、RSSI），
  连接后浏览 GATT 服务树并读写特征 / 描述符、订阅通知与指示、WinRT 配对；
  **服务名与特征名来自 Bluetooth SIG 官方 UUID 表**（78 个服务 + 512 个特征）；
  **CTS（Current Time Service）时间会就地翻成人话**：`2A2B` 时间本身 / `2A0F` 时区与夏令时 /
  `2A14` 这个参考时间可不可信（时间源、精度、距上次对时）
- **ADB 调试** — 设备列表与状态（`device` / `unauthorized`）、打开设备终端（xterm）、命令输入与 PTY 输出、
  改尺寸、关闭会话；被 ADB 占用的 `platform-tools` 由安装器在升级前自动停服
- **USB 设备插拔检测** — 设备插拔自动刷新列表
- **MCP 服务器（AI 控制接口）** — 程序内置 Model Context Protocol 服务器
  （**Streamable HTTP `POST /mcp` + 遗留 SSE 两种并存**，仅监听回环），把串口、蓝牙、ADB、日志、
  界面控件暴露成 **54 个内置工具**供 AI 客户端调用；工具操作**与前端界面实时同步**，
  调用记录写在独立的 `ai-calls.jsonl`，绝不污染用户配置
- **首次使用引导** — 9 步聚光灯引导，快速上手
- **自动更新** — 启动时检测 GitHub 最新版本


## 下载与安装（未签名说明）

> ⚠️ 本项目为个人开发，**安装包暂未做代码签名**，Windows SmartScreen 可能提示「未知发布者」——
> 这是未签名程序的正常提示，不等于病毒。请只从
> [官方 Release](https://github.com/SeaHi-Mo/Seahi-Serial/releases) 下载，并按
> [代码签名与安装说明](./doc/SIGNING.md) 核对 SHA-256 后再运行。
> Release 附带 `SHA256SUMS.txt` 与 cosign keyless 签名（`.sigstore.json`），验签命令见说明文档 §4.1。


## 开发

环境准备、构建、测试、目录结构与发版流程都搬到了文档站：

- **[开发指南](https://www.seahi-serial.c-hi.cn/dev/)** —— 依赖、`npm run dev/build`、三套测试、目录结构、版本号五处同步与 tag 发版
- **[用技能（skills）开发](https://www.seahi-serial.c-hi.cn/dev/skills)** —— 仓库里的 `skills/` 是写给 AI 助手的开发手册（项目约束 + 已踩过的坑），改代码前先让助手读一遍

改代码前请先读 [`AGENTS.md`](./AGENTS.md)：MCP、BLE、窗口几何、终端模式等硬约束都在里面。

```bash
npm install     # 依赖（只有 @tauri-apps/cli）
npm run dev     # 开发模式（热重载）
npm run build   # 发布构建 → src-tauri/target/release/seahi-serial.exe
```

## MCP（AI 控制接口）

程序内置一个 **MCP（Model Context Protocol）服务器**，让 Claude Code / Claude Desktop / Cursor 等 AI 客户端直接操作本程序。

### 设计要点

| 项 | 说明 |
|------|------|
| **运行方式** | 与程序同进程（开箱即用，无需额外启动任何服务）；随程序启动自动监听 |
| **传输协议** | **两种并存**：① **Streamable HTTP**（`POST /mcp`，2025-03-26+ 规范，新版客户端默认走它）；② **遗留 SSE**（`GET /sse` 建立会话，`POST /messages` 发请求）。弹窗里还能选「仅 /mcp」或「仅 SSE」，选单档时另一条端点直接返回 404（立即生效，不用重启）。**只监听回环地址** |
| **鉴权** | 每次请求必须携带 token（`?token=` 或 `Authorization: Bearer`）；`/healthz` 是唯一免鉴权端点，且只回 `{"ok":true}` |
| **显隐** | 顶栏 MCP 图标 → 弹窗内「启用 / 关闭」一键切换；开关状态保存到 `ai-config.json` |
| **配置隔离** | 用户配置 `config.json` **完全不受影响**；AI 相关设置与调用记录单独存放（见下） |
| **AI 调用效率** | 握手时通过 `initialize.instructions` 一次性下发工作方式（先看状态→串口主流程→错误码语义→上限），让 Agent 第一次就做对；错误信息里直接给出可选值/下一步工具；**没有设备或界面时立刻失败**（不白等轮询超时）；限流回包带请求 id（客户端能对上号，不会挂到超时） |
| **读日志省 token** | `log_tail` / `serial_get_output` 支持 `format:"text"`（一行一条纯文本，同样内容比默认 JSON 省一半以上 token，正文在 `content[].text` 里、**一条都不会少看**）；`log_search` / `adb_shell_read` / `ble_get_output` 支持三档 `mode`：`count`（只回计数）/ `matches`（只回片段）/ `lines`（默认，回整行） |
| **只读（沙箱）模式** | 弹窗里一键打开后，AI **只能读、不能改**：所有写操作（`ui_set`/`ui_click`/`serial_open`/`serial_send`/`log_clear`/`mcp_config_set`…）一律被拒并返回 `-32007`，**界面与配置文件一个字都不变**。适合"先让 AI 自由探索、确认无误再放开"。⚠️ 这个开关**只能由用户在界面上关**（`mcp_config_set` 自己也是写工具，AI 打开后就关不掉了） |
| **危险动作二次确认** | 开 adb shell、写 adb 命令、运行工作流这类"会对外产生不可撤销影响"的工具，必须带 `confirm:true` 才执行（否则回 `-32006` 并说明后果）；界面上对应按钮对通用点击工具**不可见也点不动**，绕不过去 |
| **稳定性** | 会话数 / 队列长度 / 请求体大小 / 调用频率均有限额，空闲会话自动回收，日志中心按通道环形缓冲并有总量上限 |

### 内置工具（**54 个**：19 通用 + 16 串口语义 + 13 蓝牙语义 + 6 ADB）

| 分类 | 工具 |
|------|------|
| 应用信息 | `app_info`、`mcp_status`、`mcp_limits`、`serial_list_ports` |
| 串口语义（**优先用这些**，比按控件路径操作更准）| `serial_get_state`、`serial_select_port`、`serial_set_baud`、`serial_set_frame`、`serial_set_lines`、`serial_set_display`、`serial_open`、`serial_close`、`serial_send`、`serial_clear`、`serial_get_history`、`serial_get_output`、`serial_quick_cmd`、`serial_workflow`、`serial_workflow_run`（后者**危险**，要 `confirm`）|
| 蓝牙语义（主机方向）| `ble_get_state`、`ble_list_devices`、`ble_start_scan`、`ble_stop_scan`、`ble_connect`、`ble_disconnect`、`ble_get_services`、`ble_read`、`ble_write`、`ble_subscribe`、`ble_get_output`、`ble_refresh_rssi`、`ble_cts_time`（**纯后端**：把 CTS 的字节翻成人话）|
| ADB（shell）| `adb_list_devices`、`adb_open_shell`⚠️、`adb_shell_write`⚠️、`adb_shell_read`、`adb_shell_resize`、`adb_close_shell` |
| 界面控件 | `ui_list`、`ui_describe`、`ui_get`、`ui_set`、`ui_click`、`ui_get_state` |
| 日志中心 | `log_channels`、`log_tail`、`log_search`、`log_stats`、`log_clear` |
| MCP 自身 | `mcp_calls`、`mcp_stats`、`mcp_config_get`、`mcp_config_set`、`mcp_danger`（危险工具清单） |

典型的串口主流程：`serial_get_state` → `serial_select_port` → `serial_set_baud` → `serial_open` → `serial_send` → `serial_get_output`（看设备回了什么）→ `serial_close`。

蓝牙：`ble_get_state` → `ble_start_scan` → `ble_list_devices` → `ble_connect`（列表里没有就按 MAC 直连）→ `ble_get_services` → `ble_read` / `ble_subscribe` → `ble_get_output`（**CTS 的时间会自动翻成人话**）。
⚠️ **连上设备会同步停止扫描**（不用再调 `ble_stop_scan`，`ble_get_state.scanning` 会是 false）。

此外可选开启 `expose.autoControlTools`：程序启动时会扫描界面上的按钮 / 输入框 / 下拉框，按控件生成 `ctl_*` 工具（**默认关闭**——几百个工具会显著拖累模型选工具的准确率）。

### 文件位置

| 文件 | 内容 |
|------|------|
| `%APPDATA%\seahi-serial\ai-config.json` | MCP 服务器设置（开关、端口、token、暴露策略） |
| `%APPDATA%\seahi-serial\ai-calls.jsonl` | AI 工具调用记录（追加写，按大小轮转；默认不落盘，可在弹窗里开启） |
| `%APPDATA%\seahi-serial\mcp-endpoint.json` | 当前监听地址与 token（供安装器自动探测） |

### 客户端接入

```bash
# 一键写入客户端 MCP 配置（自动探测本机正在运行的程序实例）
npx seahi-serial-mcp install

# 只预览将要改动的内容，不落盘
npx seahi-serial-mcp install --dry-run

# 查看当前状态 / 卸载
npx seahi-serial-mcp status
npx seahi-serial-mcp uninstall
```

也可以在程序顶栏点击 MCP 图标，弹窗内直接复制「连接地址」与「安装提示词」手动配置。

> 详细使用说明见 [MCP 接入](https://www.seahi-serial.c-hi.cn/guide/mcp)；**54 个工具的完整参考（入参 + 返回结构）见 [MCP 工具参考](https://www.seahi-serial.c-hi.cn/mcp/tools)**；架构与设计取舍见 [`doc/MCP_DESIGN.md`](./doc/MCP_DESIGN.md)。


## 使用教程

完整图文教程（含真实截图与录屏）在在线文档：

**https://www.seahi-serial.c-hi.cn/**

| 主题 | 文档 |
|---|---|
| 安装、连接第一个串口、发送命令 | [快速开始](https://www.seahi-serial.c-hi.cn/guide/quick-start) |
| 分栏、行尾、DTR/RTS、日志、工作流 | [串口调试](https://www.seahi-serial.c-hi.cn/guide/serial) |
| 把 USB 串口映射进 WSL | [WSL 端口映射](https://www.seahi-serial.c-hi.cn/guide/wsl) |
| 直发/行缓冲、终端行为、配色 | [终端模式](https://www.seahi-serial.c-hi.cn/guide/terminal) |
| 循环组、超时、跳转、外部文件 | [快速指令](https://www.seahi-serial.c-hi.cn/guide/quick-cmds) |
| 扫描、连接、GATT、CTS | [蓝牙调试](https://www.seahi-serial.c-hi.cn/guide/ble) |
| ADB 设备调试 | [ADB 调试](https://www.seahi-serial.c-hi.cn/guide/adb) |
| MCP 服务器与客户端接入 | [MCP 接入](https://www.seahi-serial.c-hi.cn/guide/mcp) |
| 54 个 MCP 工具的参数与返回 | [MCP 工具参考](https://www.seahi-serial.c-hi.cn/mcp/tools) |
| 安装签名、端口占用等 | [常见问题](https://www.seahi-serial.c-hi.cn/guide/faq) |
| 12 套主题与配色 | [主题](https://www.seahi-serial.c-hi.cn/guide/theme) |

### 快速上手

1. 插入设备，确认设备管理器里能看到对应 COM 口。
2. 在工具栏的「端口」下拉框选择端口；插拔设备时列表自动刷新。
3. 波特率默认 `115200`，按设备要求调整。
4. 点击「开始监控」，输出区开始显示数据。
5. 在底部输入框输入内容，按 Enter 或点发送；行尾在工具栏选择。

### 界面总览

<div align="center">
<img src="https://www.seahi-serial.c-hi.cn/img/landing/hero.png" width="55%">
</div>

| 区域 | 说明 |
|---|---|
| 全局操作栏 | 新增监视器分栏、WSL 端口映射、ADB 调试、蓝牙调试、主题、MCP 开关 |
| 工具栏 | 查看模式、端口、波特率、行尾、开始/停止监控、高级设置 |
| 输出区 | 串口数据、日志；右侧可展开快速指令面板 |
| 发送栏 | 输入内容、文本/HEX 模式、发送历史 |

### 常用功能

- **多串口**：工具栏「＋」新增分栏，每栏独立端口、波特率、行尾和发送历史。
- **终端模式**：工具栏终端按钮切换 xterm 画布；串口分栏默认行缓冲，AT 指令建议开启行缓冲并选 `\r\n`。
- **快速指令**：输出区右侧面板，按循环组发送；支持等待回话、重试、跳转和外部 Markdown 文件。
- **蓝牙调试**：扫描、连接、浏览 GATT 服务树；连接成功后自动停止扫描。
- **ADB / WSL**：ADB 面板打开设备终端；WSL 面板把 USB 串口映射进 WSL 后可直接在 WSL 分栏收发。
- **MCP**：顶栏 MCP 按钮启用服务器，客户端通过 `npx seahi-serial-mcp install` 或弹窗里的地址接入。

### 键盘快捷键

| 按键 | 功能 |
|---|---|
| `Enter` | 发送输入框内容 |
| `↑` / `↓` | 浏览发送历史 |
| `Escape` | 关闭历史下拉列表 |

## License

MIT
