# SeaHi Serial - 技术架构文档

> 版本: v0.1.15 | 最后更新: 2026-07-01

---

## 1. 项目概述

**SeaHi Serial** 是一款基于 **Tauri 2 + Rust** 的轻量级串口调试桌面工具，采用 VS Code Serial Monitor 风格界面，支持多串口分栏同时调试。

- **产品名称**: SeaHi Serial
- **应用标识**: `com.seahi.seahi-serial`
- **技术栈**: Tauri 2 (Rust 后端) + 原生 HTML/CSS/JS (前端)
- **目标平台**: Windows 10 1809+ / Windows 11 (WebView2)
- **许可证**: 待定

---

## 2. 目录结构

```
serial-debugger-tauri/
├── .github/
│   └── workflows/
│       └── build.yml                # GitHub Actions CI/CD
├── doc/                             # 项目文档
│   ├── ARCHITECTURE.md              # 本文件 - 技术架构
│   ├── HANDOVER.md                  # 交接文档
│   └── IMG/                         # 截图资源
├── skills/
│   └── seahi-serial-dev/
│       └── SKILL.md                 # AI 开发技能指南
├── src/                             # 前端源码
│   └── index.html                   # 单文件应用 (HTML + CSS + JS, ~4400 行)
├── src-tauri/                       # Rust 后端源码
│   ├── build.rs                     # Tauri 构建脚本
│   ├── Cargo.toml                   # Rust 依赖配置
│   ├── tauri.conf.json              # Tauri 应用主配置
│   ├── capabilities/
│   │   └── default.json            # Tauri 2 ACL 权限
│   ├── icons/                      # 应用图标资源 (ico, png)
│   ├── wsl-daemon/                 # WSL bridge 脚本（base64 编码）
│   └── src/
│       └── main.rs                  # Rust 后端全部逻辑 (~1745 行)
├── installer.iss                    # Inno Setup 安装脚本
├── package.json                     # Node.js 项目配置
├── README.md                        # 项目说明
├── RELEASE_NOTES.md                 # 版本发行说明
└── TEST_CASES.md                    # 测试用例
```

---

## 3. 系统架构

```
┌─────────────────────────────────────────────────┐
│                  Tauri Shell (WebView2)          │
│  ┌───────────────────────────────────────────────┐ │
│  │            前端 (src/index.html)            │ │
│  │                                               │ │
│  │  ┌─────────┐  ┌──────────┐  ┌────────────┐ │ │
│  │  │ UI 层   │  │ 业务逻辑  │  │  数据管理   │ │ │
│  │  │ CSS 渲染 │  │ JS 函数  │  │ monitors{} │ │ │
│  │  └────┬────┘  └────┬─────┘  └─────┬──────┘ │ │
│  └───────┼────────────┼──────────────┼─────────┘ │
│          │     invoke() 调用        │           │
└──────────┼────────────┼──────────────┼───────────┘
           │            │              │
┌──────────▼────────────▼──────────────▼───────────┐
│              Rust 后端 (main.rs)                  │
│                                                  │
│  ┌──────────────┐  ┌───────────┐  ┌───────────┐ │
│  │ Tauri Commands│  │ PortState │  │ serialport│ │
│  │ (9 个 IPC 命令)│  │ (全局状态)│  │ (串口驱动)│ │
│  └──────┬───────┘  └───────────┘  └───────────┘ │
│         │                                         │
└─────────┼───────────────────────────────────────┘
          │
    ┌─────▼──────┐
    │  系统串口   │
    │ (COM1~COMn) │
    └────────────┘
```

### 3.1 前后端通信

前后端通过 Tauri 的 IPC 机制通信，前端调用 `window.__TAURI__.core.invoke()` 触发 Rust 命令。

**调用链路**:
```
前端 JS  →  invoke("command_name", { args })  →  Tauri IPC  →  Rust handler  →  返回 Result
```

---

## 4. 前端架构

### 4.1 技术选型

- **零框架**: 纯原生 HTML/CSS/JavaScript，无 React/Vue 等依赖
- **单文件应用**: 所有前端代码集中在 `src/index.html`（约 4400 行）
- **内联 SVG 图标**: 12 个图标以 JS 常量形式嵌入，避免外部文件依赖
- **CSS 变量设计系统**: 6 种风格 × 深浅色 = 12 种主题

### 4.2 CSS 设计系统

#### 颜色变量 (Design Tokens)

| 变量 | 色值 | 用途 |
|------|------|------|
| `--bg` | `#1c1e22` | 主背景 |
| `--editor-bg` | `#1c1e22` | 编辑器/输出区背景 |
| `--toolbar-bg` | `#22252a` | 工具栏背景 |
| `--input-bg` | `#2e3138` | 输入框背景 |
| `--border` | `#2e3138` | 边框 |
| `--border-h` | `#3a3e46` | 边框悬停 |
| `--text` | `#b8bcc4` | 正文 |
| `--text-b` | `#dce0e8` | 加亮文本 |
| `--text-d` | `#6b7280` | 弱化文本 |
| `--link` | `#6a9fd8` | 链接 |
| `--btn-p` | `#4a7ab5` | 按钮主色 |
| `--btn-ph` | `#5888c0` | 按钮悬停 |
| `--btn-pa` | `#3c6aa5` | 按钮激活 |
| `--split-line` | `#4a7ab5` | 分栏分割线 |
| `--accent-green` | `#5a9e6e` | 成功/运行状态 |
| `--accent-red` | `#c45c5c` | 错误/停止状态 |

#### 主题风格

| 风格名 | data-theme 值 | 特点 |
|--------|--------------|------|
| 默认 | `default` / `default-light` | VS Code Dark/Light 风格 |
| 浮世绘彩 | `japanese` / `japanese-light` | 深蓝底+朱红点缀 |
| 诗意东方 | `poetic` / `poetic-dark` | 暮山紫主色调 |
| 水墨丹青 | `ink` / `ink-dark` | 青绿+宣纸底色 |
| 桃之夭夭 | `peach` / `peach-dark` | 桃花粉+嫩绿辅色 |
| 金风玉露 | `autumn` / `autumn-dark` | 琥珀金+暖棕 |

#### 字体

```css
--font-mono: 'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
--font-ui: 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif;
```

#### 核心布局组件

| CSS 类 | 功能 | 布局方式 |
|--------|------|----------|
| `.global-bar` | 顶部全局操作栏 | flex |
| `.pane-container` | 水平分栏容器 | flex, row |
| `.monitor-pane` | 单个监视器窗格 | flex:1, column |
| `.pane-header` | 窗格标题栏 | flex |
| `.toolbar` | 串口参数工具栏 | flex-wrap |
| `.ibtn-group` | 图标按钮组容器 | inline-flex |
| `.output` | 数据输出区 | flex:1, overflow:auto |
| `.send-bar` | 底部发送栏 | flex, flex-shrink:0 |
| `.mon-body` | 输出区那一行的横向容器（输出区 + 右侧快速指令分栏） | flex, row |
| `.qcmd-side` | 快速指令分栏（折叠 14px；展开宽度 = `var(--qcmd-side-w, 300px)`，可由用户拖动调宽），**只占输出区高度** | flex, row |
| `.qcmd-side-tab` | 折叠条（热区 14px 宽、整高，**视觉**另说）：折叠态 = 居中的 3×34 细握把（`::before`，`--link` 45% → 悬停点亮），`cursor:pointer`；展开态 = 握把长成**顶到面板左缘、贯穿整高的 6px 竖色条**（`left:0`，`--btn-p` → 悬停/拖动 `--btn-ph`，无圆角无花纹），`cursor:col-resize` 可拖，且**脱离文档流**（`position:absolute; left:0`，见下）；`z-index:3` 必须高于 sticky 列标题的 1（否则列标题那段的不透明底会把色条盖断）；展开态同时 `border-left-width:0` 收掉面板那条 1px 分栏线；`::after` 只在**折叠态**且循环发送时出现（底部闪点），展开态 `display:none` | flex, 居中 |
| `.qcmd-side.dragging` | 拖动调宽中：`transition:none`（宽度跟手），折叠条点亮为 `--btn-ph` | |
| `.qcmd-side-body` | 展开态的分栏内容区（标题行 + 来源行 + 列表） | flex, column |
| `.qcmd-side-hd` | 标题行：**不自带底色**（用 `--surface-3` 的话那条浅色带只能从 x=14 开始 —— 右边 14px 是折叠条的地盘 —— 标题栏会跟面板左缘裂开，用户 2026-09 反馈的"割裂"）；只用一条 `--border` 细线与列表分隔；`margin-right:8px` 让出滚动条槽（线才与数据行等长） | flex（可换行） |
| `.qcmd-hd-acts` | 标题行右侧三个按钮：＋添加 / 导入 / 导出 | inline-flex |
| `.qcmd-side-src` | 来源行：只在挂了外部文件时出现（文件名 + 重载 + 断开），底色同样透明（同标题行的道理） | flex |
| `.qcmd-cols` | **列标题行**（顺序 / 指令 / 延时(ms) / HEX）：**每组一份**（组盒子里：抬头 → 列标题 → 数据行），与 `.qcmd-item` **同一套 `grid-template-columns`/`areas`** 所以永远对齐；六列**全是固定宽**（延时 48px / HEX 34px）—— `auto` 是每个 grid 各按自己内容算的（表头里是文字、行里是按钮），列边界会不一致。单元格的 padding 照抄对应输入框（val 左 5px、delay 右 3px），字才真的对着格。它在组盒子里 → 与数据行共享同一个滚动容器，滚动条占的 8px 两边一起让，分隔线永远等长（用户 2026-09 报的"每行下方的线不够长"）。`rebuildQcmdList` 按组重建（`qcmdColsInnerHtml` + 一个 `.qcmd-cols` 元素） | grid |
| `.qcmd-group` / `.qcmd-group-hd` | **循环组**：组盒子（折叠时藏掉列标题与数据行）+ 抬头（**拖动握把（最左）** · 折叠 · **组名输入框** · 条数 · `＋ 添加` · 删组）。抬头 `padding-left:22px`、底色 `--surface-3`（从面板左缘铺开，不存在"割裂"）；拖动时 `.dragging` 整条点亮 | flex |
| `.adv-row` | 高级设置行 | flex-wrap |

#### ANSI 颜色支持

CSS 类 `.ansi-0` ~ `.ansi-37` 和 `.ansi-90` ~ `.ansi-97`，覆盖标准 ANSI 16 色。每个主题风格都定义了对应的 ANSI 颜色映射。

### 4.3 JavaScript 架构

#### 全局状态

```javascript
const monitors = {};          // { mid: { isConnected, portName, readTimer, sendHistory[], histNavIdx, quickCmds[], _editing } }
let extraCount = 0;           // 额外监视器递增 ID
let logDirPath = '';          // 日志保存目录
const MAX_SEND_HISTORY = 50;  // 发送历史最大条数
```

#### 内联图标 (ICONS 对象)

12 个 SVG 图标以字符串常量形式嵌入：

| 属性 | 说明 |
|------|------|
| `ICONS.reconnect` | 重连按钮图标 |
| `ICONS.timestamp` | 时间戳开关图标 |
| `ICONS.clear` | 清除输出图标 |
| `ICONS.terminal` | 终端模式图标 |
| `ICONS.settings` | 设置/更多图标 |
| `ICONS.copy` | 复制图标 |
| `ICONS.rollback` | 自动滚动图标 |
| `ICONS.saveLog` | 保存日志图标 |
| `ICONS.copyAll` | 复制全部图标 |
| `ICONS.sendIcon` | 发送图标 |
| `ICONS.lineNum` | 行号图标 |

#### 函数分类

**窗格管理**:

| 函数 | 功能 |
|------|------|
| `createMonitorPane(mid, title, closable)` | 创建完整监视器 DOM 结构 |
| `addMonitor()` | 创建额外监视器分栏 |
| `closeMonitor(mid)` | 关闭并销毁指定监视器 |

**串口操作**:

| 函数 | 功能 | 后端命令 |
|------|------|----------|
| `refreshPorts(mid)` | 刷新可用串口列表 | `list_ports` |
| `connectPort(mid)` | 打开串口连接 | `open_port` |
| `disconnectPort(mid)` | 关闭串口 | `close_port` |
| `reconnectPort(mid)` | 自动重连 | `open_port` |
| `startReading(mid)` | 启动 50ms 轮询读取 | `read_data` |
| `stopReading(mid)` | 停止读取定时器 | - |
| `sendData(mid)` | 发送数据 | `send_data` |
| `toggleDTR(mid, level)` | 切换 DTR | `set_dtr` |
| `toggleRTS(mid, level)` | 切换 RTS | `set_rts` |

**数据解码与显示**:

| 函数 | 功能 |
|------|------|
| `decodeData(mid, bytes)` | 按视图模式解码 |
| `decodeRaw(bytes, mode)` | text/hex/both 三模式解码 |
| `parseAnsi(text)` | ANSI 转义序列 → HTML |
| `escapeHtml(s)` | HTML 实体转义 |
| `appendOutput(mid, type, text)` | 追加日志行到输出区 |
| `clearLog(mid)` | 清空输出 |
| `updateLineNumbers(mid)` | 更新行号显示 |

**发送历史**:

| 函数 | 功能 |
|------|------|
| `showSendHistory(mid)` | 显示发送历史下拉 |
| 键盘 Enter/ArrowDown/ArrowUp/Escape | 历史导航 |

**快速指令**:

| 函数 | 功能 |
|------|------|
| `qcmdSideHtml(mid)` | 生成侧栏 HTML（通用监视器与 WSL 监视器共用，避免两处漂移） |
| `toggleQcmdSide(mid)` | 展开/收起侧栏（默认折叠） |
| `setQcmdSideOpen(mid, open)` | 直接设定展开态并同步标签高亮/箭头/提示 |
| `qcmdSideOpen(mid)` | 读当前展开态（无头断言用） |
| `makeQcmdItem(mid, idx, label, value)` | 创建指令条目 DOM（顺序号 / 内容 / 延时 / HEX / 发送 / 删除六格） |
| `addQcmdItem(mid)` | 添加新指令（默认 0 / 1000ms / HEX 关） |
| `removeQcmdItem(mid, idx)` | 删除指定指令 |
| `rebuildQcmdList(mid)` | 重建指令列表 DOM |
| `sendQcmdItem(mid, idx)` | 快速发送指令（格式取本条自己的 HEX 开关） |
| `sendQcmdPayload(mid, text, hexMode)` | 文本/HEX 两种格式的实际发送（手动、Enter、循环发送共用） |
| `qcmdItemSeq/Delay/Hex(it)` | 读某条的发送参数（缺省 / 越界 / 脏值都在这里收敛） |
| `qcmdLoopPlan(mid)` | 参与循环发送的条目（顺序号 > 0）按序号升序 |
| `setQcmdLoop` / `toggleQcmdLoop` | 开/关循环发送（前置不满足则拒绝并说明） |
| `qcmdLoopStep(mid)` | 循环的一步：发当前条 → 按它的延时排下一步 |
| `stopQcmdLoop(mid, reason)` | 停止循环（`reason` 只在自愈停止时给，会 toast） |
| `qcmdCarryItemPrefs(mid, items)` | 从文件重载时按指令内容带回顺序号/延时/HEX |

**日志保存**:

| 函数 | 功能 | 后端命令 |
|------|------|----------|
| `chooseLogDir(mid)` | 选择日志目录 | `choose_log_directory` |
| `saveLogToFile(mid)` | 保存日志到文件 | - |

**主题系统**:

| 函数 | 功能 |
|------|------|
| `toggleTheme()` | 深浅色切换 |
| `toggleThemeStyleDrop(e)` | 主题风格下拉 |
| `selectThemeStyle(style)` | 选择主题风格 |
| `applyTheme(theme)` | 应用主题到 DOM |
| `syncThemeUI()` | 同步主题按钮状态 |

**WSL 管理**:

| 函数 | 功能 | 后端命令 |
|------|------|----------|
| `openWslMapping()` | 打开 WSL 面板 | `list_wsl_devices` |
| `restoreMonitorPane()` | 返回监视器 | - |
| `initWslMonitor()` | 初始化 WSL 串口监控 | `get_wsl_serial_devices` |
| `wslDistAction(cmd, dist)` | 启动/关闭 WSL 发行版 | `launch_wsl` / `shutdown_wsl` |

**首次引导**:

| 函数 | 功能 |
|------|------|
| `showOnboarding()` | 显示 9 步引导 |
| `goStep(idx)` | 跳转到指定步骤 |
| `nextStep()` | 下一步 |
| `closeOnboarding()` | 关闭引导 |

**配置管理**:

| 函数 | 功能 |
|------|------|
| `collectConfig()` | 收集全局配置 |
| `collectConfigForMonitor(mid)` | 收集监视器配置 |
| `applyMonitorConfig(mid, mc)` | 应用配置到监视器 |
| `scheduleConfigSave()` | 延迟保存配置（500ms 防抖） |
| `loadAndApplyConfig()` | 加载并应用配置 |

#### 数据流设计

```
发送: sendInput.value → sendData()
  ├── 文本模式: new TextEncoder().encode(text + lineEnding) → invoke("send_data", {data: bytes})
  └── Hex模式:  hexToBytes(input) → invoke("send_data", {data: bytes})

接收: setInterval(50ms) → invoke("read_data") → Vec<u8>
  → decodeData(mid, bytes)
    ├── text: TextDecoder → parseAnsi → appendOutput
    ├── hex:  bytesToHex → appendOutput
    └── both: 两模式合并 → appendOutput

WSL接收: setInterval(50ms) → invoke("read_wsl_serial") → Vec<u8> → 同上解码流程
```

---

## 5. 后端架构

### 5.1 技术选型

- **语言**: Rust (stable channel)
- **框架**: Tauri 2
- **串口驱动**: `serialport 3.3`（跨平台串口 I/O）
- **文件对话框**: `rfd 0.15`（原生目录选择器）
- **Win32 API**: `winapi 0.3`（SetupAPI）+ `windows-sys 0.59`（CM_Register_Notification）
- **HTTP 请求**: `reqwest 0.12`（自动更新检测）
- **Base64**: `base64 0.22`（WSL bridge 脚本解码）
- **代码组织**: 单文件 `main.rs`（约 1745 行）

### 5.2 全局状态

```rust
struct PortState {
    ports: Mutex<HashMap<String, Box<dyn SerialPort>>>,
}

struct WslSerialState {
    sessions: Mutex<HashMap<String, WslSerialSession>>,
}
```

- **PortState Key**: `monitor_id`（如 `"main"`, `"extra-1"`）
- **WslSerialState Key**: `monitor_id`（如 `"wsl"`）
- **线程安全**: `std::sync::Mutex`
- **生命周期**: 通过 Tauri `manage()` 注入，随应用运行期间存在

### 5.3 数据结构

```rust
#[derive(Debug, Serialize, Clone)]
struct PortInfo {
    port_name: String,       // "COM3"
    friendly_name: String,   // "USB 串行设备 (COM3)"
    product_name: String,    // USB iProduct 字符串，如 "FlashKey"
}
```

友好名称通过 Win32 SetupAPI 获取，避免 `serialport` crate 读取中文设备名时乱码。

### 5.4 Tauri 命令 API

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `list_ports` | 无 | `Vec<PortInfo>` | SetupAPI 枚举系统串口 |
| `open_port` | monitor_id, port_name, baud_rate, data_bits, stop_bits, parity, dtr, rts | `Result<(), String>` | 打开并配置串口 |
| `close_port` | monitor_id | `Result<(), String>` | 关闭串口 |
| `send_data` | monitor_id, data: Vec\<u8\> | `Result<usize, String>` | 写入数据 |
| `read_data` | monitor_id | `Result<Vec<u8>, String>` | 非阻塞读取 (4KB) |
| `set_dtr` | monitor_id, level: bool | `Result<(), String>` | 设置 DTR 信号 |
| `set_rts` | monitor_id, level: bool | `Result<(), String>` | 设置 RTS 信号 |
| `choose_log_directory` | 无 | `Result<Option<String>, String>` | 原生目录选择 |
| `list_wsl_devices` | 无 | `Result<Vec<Value>, String>` | USB 设备列表（usbipd） |
| `check_wsl_status` | 无 | `Vec<String>` | 运行中的 WSL 发行版 |
| `get_wsl_distributions` | 无 | `Result<Vec<Value>, String>` | WSL 发行版详细信息 |
| `launch_wsl` | dist: Option\<String\> | `Result<(), String>` | 启动 WSL 终端 |
| `shutdown_wsl` | dist: String | `Result<(), String>` | 关闭 WSL 发行版 |
| `attach_port_to_wsl` | port_name: String | `Result<String, String>` | USB 设备映射到 WSL |
| `detach_port_from_wsl` | port_name: String | `Result<String, String>` | 解除 WSL 映射 |
| `open_wsl_serial` | monitor_id, device_path, baud_rate | `Result<(), String>` | 打开 WSL 串口 |
| `close_wsl_serial` | monitor_id | `Result<(), String>` | 关闭 WSL 串口 |
| `read_wsl_serial` | monitor_id | `Result<Vec<u8>, String>` | 读取 WSL 串口数据 |
| `send_wsl_serial` | monitor_id, data: Vec\<u8\> | `Result<usize, String>` | 发送 WSL 串口数据 |
| `get_wsl_serial_devices` | 无 | `Result<Vec<String>, String>` | WSL 内串口设备列表 |
| `set_wsl_dtr` | monitor_id, level: bool | `Result<(), String>` | 设置 WSL DTR |
| `set_wsl_rts` | monitor_id, level: bool | `Result<(), String>` | 设置 WSL RTS |
| `open_url` | url: String | `Result<(), String>` | 打开外部链接 |

### 5.5 串口参数映射

| 前端参数 | Rust 枚举 |
|----------|-----------|
| data_bits: 5/6/7/8 | `DataBits::Five/Six/Seven/Eight` |
| stop_bits: 1/2 | `StopBits::One/Two` |
| parity: "none"/"odd"/"even" | `Parity::None/Odd/Even` |
| dtr: true/false | `write_data_terminal_ready(bool)` |
| rts: true/false | `write_request_to_send(bool)` |

### 5.6 读取机制

```rust
fn read_data(state: State<PortState>, monitor_id: String) -> Result<Vec<u8>, String> {
    let mut ports = state.ports.lock().unwrap_or_else(|e| e.into_inner());
    let port = ports.get_mut(&monitor_id).ok_or("未连接串口")?;
    let mut all_data = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        match port.read(&mut buf) {
            Ok(n) if n > 0 => all_data.extend_from_slice(&buf[..n]),
            Ok(_) => break,
            Err(e) if e.kind() == ErrorKind::TimedOut || e.kind() == ErrorKind::WouldBlock => break,
            Err(e) if all_data.is_empty() => return Err(format!("读取失败: {}", e)),
            Err(_) => break,
        }
    }
    Ok(all_data)
}
```

- 非阻塞读取，依赖串口超时机制
- 前端以 50ms 间隔轮询
- 循环读取直到无数据或超时
- 空/超时返回空 Vec（正常情况，不触发错误）

### 5.7 设备插拔检测

```rust
// 使用 CM_Register_Notification 监听 USB 设备变化
// 触发 device-changed 事件通知前端刷新串口列表
unsafe extern "system" fn device_callback(...) {
    app.emit("device-changed", ());
}
```

前端监听 `device-changed` 事件，防抖 150ms 后刷新所有未连接监视器的串口列表。

### 5.8 WSL 串口转发

WSL 串口通过 Python bridge 脚本实现：
1. bridge 脚本以 base64 编码嵌入 `wsl-daemon/bridge_b64.txt`
2. 运行时解码到 WSL 的 `/tmp/seahi_serial_bridge.py`
3. 通过 stdin/stdout JSON 协议通信
4. WSL shell 使用持久化进程避免每次 fork 的 300ms 延迟

---

## 6. 关键功能实现

### 6.1 多串口分栏

- 每个监视器维护独立状态（端口、参数、输出、历史、指令）
- 前端 `monitors[mid]` 和后端 `ports[mid]` 通过 `monitor_id` 一一对应
- 默认创建主监视器（不可关闭），支持添加/关闭额外监视器

### 6.2 数据显示模式

| 模式 | 说明 |
|------|------|
| **文本 (text)** | UTF-8 解码 + ANSI 颜色渲染 |
| **Hex** | 大写十六进制，空格分隔 (如 `48 65 6C 6C 6F`) |
| **文本 & Hex** | 同时显示：`Hello [48 65 6C 6C 6F]` |

### 6.3 自动重连

读取失败时检查自动重连开关：
1. 显示 "连接中断，正在尝试重连..."
2. 关闭旧端口（忽略错误）
3. 标记断开状态
4. 自动调用 `connectPort()` 重新连接

### 6.4 快速指令系统

- 每个监视器独立维护 `quickCmds[]`，每条 = `{ label, value, seq, delay, hex }`
  （`label` 是外部文件里的「名称」列，**界面上已没有入口**，只原样保留/写回）
- 支持动态增删、编辑内容
- 呈现方式是**监控输出区最右侧的可折叠分栏**：只占输出区那一行的高度（`.mon-body`），**不跨越**上方工具栏与下方发送栏
- 折叠态（默认）只有一条 14px 折叠条：与输出区同底色 + 一条主题色分栏线；**没有图标、没有文字、也没有小三角**；
  可发现性靠 `title` 提示与引导第 7 步的高亮
- 折叠条（2026-09 反复试错后定稿，**这些都别改回去**）：
  - **展开态 = 一条顶到面板左缘、贯穿整栏的 6px 竖色条**（`--btn-p`，悬停/拖动 `--btn-ph`，无圆角无花纹）。
    这里试过五版：① 14px 整条 × 整高刷主题蓝 → 一堵蓝墙，太吵；② 只留一颗居中的小珠子 →
    几百像素高的空栏里一颗孤零零的珠子，没设计感；③ 再加一条贯穿到底的虚线轨 → 像"沿虚线剪开"；
    ④ 把手贴顶的小舌 → 还是"栏里飘着一个小块"；⑤ 居中的 6px 色条 → **和面板那条 1px 分栏线
    并排 5px**，两条蓝竖线贴在一起（逐像素量过：x=0 是 `--split-line`、x=6..9 是 `--btn-p`），
    看着脏。定稿 = 色条顶到左缘（`left:0`）+ 展开态把那条分栏线 `border-left-width:0` 收掉，
    **全栏只留一条竖线**
  - 条上不叠花纹：试过在条心画浅色握把，浅色主题下白线压在浅蓝条上像"这根条断了"
  - **折叠态 = 居中的 3×34 细握把**（`--link` 45%，悬停点亮）：它是折叠态唯一的可发现性来源，别删
  - 折叠条**自身宽度仍是 14px**：那是点击/拖动热区，只收窄视觉、不缩热区
  - **循环发送的闪点只在折叠态出现**：展开时标题行那颗循环开关本身就亮着，再点一颗就是重复装饰
- 宽度可调：**展开后**拖动折叠条即可调宽（往左拖变宽，`cursor:col-resize`）；折叠态不启用拖动（那一下的语义是"展开"）
  - 宽度走 CSS 变量 `--qcmd-side-w`（缺省 300px：一条六格要放得下）；下限 120px，**上限跟着窗格走**：
  `min(窗格 × 60%, 窗格 − 160px)` —— 原来是写死的 640px，窗口拉到 2000 多也拖不过 640（用户 2026-09 的反馈）。
  两个口径值在 JS（`QCMD_SIDE_MAX_RATIO` / `QCMD_SIDE_RESERVE`）与 CSS
  （`.qcmd-side.open` 的 `max-width:min(60%, calc(100% - 160px))`，兜底用）里**必须一致**，断言里守着
  - 按监视器各记一份、写入 `config.json`（`qcmdSideWidth`），重启/切页后沿用；拖动位移 < 3px 仍按点击处理（松手那次 click 不会把刚调好的分栏收起来）
- 标题行（不再有「快速指令」文字）只有控件，**分两端**：左 = 状态（`循环发送` 开关）、
  右 = 动作（`＋ 新建循环组` / `导入` / `导出`，包在 `.qcmd-hd-acts` 里）——
  常规工具条的分法，用户 2026-09 明确要求"按钮还是摆右侧"（中途试过整体靠左聚拢，用户否了）。
  注意**没有**「＋ 添加」：它属于某个组，所以挪进每个组的抬头里去了
- **循环组**（2026-09 加）：一个监视器可以有多组，**每组自成一张表**（抬头 → 列标题 → 数据行）：
  - 抬头依次是：**拖动握把（最左）** · 折叠 · **组名（可重命名）** · 条数 · `＋ 添加` · 删组；
    组名用 DOM API 造，**不拼 HTML**（组名来自用户文件，可能含引号/尖括号，同 `renderQcmdSource` 的纪律）
  - **拖动握把上下拖 = 调整组的顺序**：指针越过邻组中线就换位（经典 sortable 手感），
    松手写配置 + 写回文件（`qcmdMoveGroupBlocks` 把文件里那张表整段挪过去）
  - **循环顺序 = 组的上下顺序 → 组内顺序号**（一条链，走完最后一组回到最上面那组）。
    所以"把哪一组拖到最上面"就是"循环从哪一组开始"；每步都重算计划，改顺序/加组/删条**不用重启循环**
  - 新建组：追加到最下面 + **默认 1 条空指令**；首次启动**默认 1 组**（老配置的扁平 `quickCmds`
    由 `qcmdGroups()` 现场包成一组 —— 迁移，不丢任何一条）；**最后一组删不掉**（面板不能没有组）
  - 每条指令自己的配置（顺序号/延时/HEX/内容）**一律不变**（用户明确要求）：只是被分了段
- **列标题行**（`.qcmd-cols`：顺序 / 指令 / 延时(ms) / HEX）**每组一份**（放在组盒子里），
  与数据行同一套 grid 轨道，六列全是固定宽、单元格 padding 照抄输入框 —— 宽栏下"一排飘着的框"
  因此读得成一张表。共用一份会夹在"组抬头"与"数据行"之间、读起来是断的（用户 2026-09 指出的正是这里）；
  每组一份还让面板与文件**同形**（文件里也是"一组一张表"）
- 每条指令是**一行六格**：`顺序号 | 指令内容 | 延时(ms) | HEX | 发送 | 删除`
  - **顺序号**（方形框，默认 `0`）：`0` = 不参与循环发送；`>0` 参与，**组内**按数字从小到大依次发（同号按列表先后）。参与的那几条描边点亮
  - **延时**（默认 `1000`，上限 600000 = 10 分钟）：本条发完到下发下一条的间隔；清空即回缺省 1000（避免 0 毫秒疯跑）
  - **HEX**（默认关，每条独立）：本条按 HEX 解析后发送；**与主发送栏的文本/HEX 无关** ——
    同一轮循环里"一条文本 + 一条 HEX"是常见需求，跟着全局模式走就做不到
  - 三个控件都带 id（`{mid}-qcmdi-{组id}-{i}-seq/-delay/-hex`），否则 MCP 控件注册表只能靠文档序兜底
- **观感纪律**（2026-09 按"日本排版"那一套收过一版，都是纯视觉、不动交互）：
  - **面（背景）只留两个**：顺序号的方框（用户点名要的顺序标识，底色常驻）与指令内容。
    延时退成"右对齐的一列等宽数字"，平时无面，`hover`/`focus` 才浮出面来 —— 一行里少一个框就安静一档
  - 数字一律 `font-variant-numeric:tabular-nums`（`1000 / 500 / 80` 的个位要能对齐成一条竖线）
  - 标题行 / 来源行 / 数据行同为 8px 边距：右缘连成一条竖线；行分隔线压到 `rgba(60,60,60,.3)`，不抢内容
- **整块面板是一个面**：标题行与来源行都**不带自己的底色**（不然浅色带只能从 x=14 开始，会被
  折叠条的地盘切出一道竖缝 —— 用户说的"标题栏有割裂"），只用 `--border` 细线分隔
- **面板里的横向分隔线**（标题行 / 来源行 / 每组的列标题 / 每行下方）**必须等长，且左端顶到面板左缘** ——
  两条都是像素量出来的：
  - **等长**：列表 `overflow-y:auto` 出滚动条时占 8px 宽，滚动容器**外面**的元素就比数据行宽 8px，
    线于是差一截（实测溢出时行线 278px、标题行的线 286px）。落地是三件配套的事：
    ① 列表 `scrollbar-gutter:stable`（槽位恒定预留，顺便消掉"长出滚动条时整列线跳 8px"的抖动）；
    ② 标题行/来源行 `margin-right:8px` 让出同一条槽；③ 列标题/数据行都在组盒子里（同一个滚动容器）。
    ⚠️ 那个 8px 是跟 `::-webkit-scrollbar { width:8px }` 对账的：**改一个必须改另一个**（断言里有守）
  - **左端顶到左缘**：展开态把折叠条**脱离文档流**（`position:absolute; left:0`），面板内容因此拿到
    整个宽度 —— 线才能从面板左缘拉起；内容让开那 14px 靠 `padding-left:22px`（= 14 折叠条 + 8 视觉留白），
    见 `.qcmd-item` / `.qcmd-cols` / `.qcmd-side-hd` / `.qcmd-side-src` / `.qcmd-group-hd`。
    折叠条 `z-index:3` 在最上层，色条不会被任何内容盖断
  - 发送与删除同宽（20px）并压低不透明度，成为"一对次要动作"；`hover` 才提到 1
- 展开态本身**不做持久化**：每次打开监视器都从折叠开始（宽度会保留）
- `seq`/`delay`/`hex` 随 `config.json` 持久化（在 `quickCmds` 里）；**循环发送的开关状态不持久化**
  （开机自动发指令太危险），掉线/关监视器/列表里再没有可发条目时**自愈停止**并提示

### 6.4.1 循环发送（`setQcmdLoop` / `qcmdLoopStep`）

按顺序号依次发，发完一条等**它自己的延时**再发下一条，一轮发完从头再来。

- 开启前置：串口已连接 **且** 至少有一条顺序号 > 0 —— 不满足当场拒绝并说明原因（绝不"开着但什么都不发"）
- 每步都重取一遍计划（`qcmdLoopPlan`）：中途改顺序号/删条目/改延时立刻生效，不用重启循环
- 发送走的就是 `sendQcmdItem` → `sendQcmdPayload` —— 与手动点发、Enter 键**同一条路径**（不为循环另写一套）
- **折叠起来循环不会停**：分栏折叠后标题行看不见了，所以折叠条上会点一颗一闪一闪的小点
  （`.qcmd-side-tab.loop::after`，仍是主题色 `--link`，不引入新的语义色），`title` 也写明「循环发送进行中，展开可停止」
- 自愈停止的三条路径：连接掉线（`updateMonitorUI` 里立即停，不留还在倒计时的定时器）、
  监视器被关闭（`closeMonitor` / `closeWslMonitor`）、列表里再没有可发的条目；都带一次 `showToast` 说明原因

### 6.4.2 外部文件（导入 / 导出 / 写回）

**语义：文件就是列表的存储**。导入一个文件后，面板里的增/删/改都会写回它，不再有两份真相；
没挂文件时列表照旧只存在 `config.json` 里。

- **载体**（读取时自动识别，写回时保持原样）：Markdown 表格 `| 名称 | 指令 |`、TSV（`<TAB>` 分隔）、
  纯指令行（一行一条，名称取指令本身）。**刻意不按逗号切分** —— AT 指令里逗号是常态
  （`AT+CWJAP="ssid","pass"`），按 CSV 切必然把一条指令切碎；文件名是 `.csv` 也按"整行一条"读。
- **文件头（front matter）**：首行是 `---`（YAML）或 `+++`（TOML）时，整个头部**原样保留、一字不动**。
  这是必须的：不识别它的话 `baud: 115200` 这种没有分隔符的行会被当成一条"指令"读进列表，
  写回时更会被转成表格行 —— 等于把用户的文件头改写成数据（2026-09 实测踩到）。
  头部里的 key 会被读出来，但**本版不解释**；`baud` / `mode` / `lineEnding` / `delay` / `expect` /
  `timeout` / `hex` 这些"看起来该生效"的 key 会明确提示「暂不生效（发送沿用面板设置）」，
  免得用户以为写了就生效（静默 no-op 比报错更坑）。头部缺收尾行时只当第一行是头部并提示，
  不会整份吞掉（以 `---` 开头的普通 Markdown 也可能只是条水平线）。
- **手写文件不被破坏**：内存里保留**块序列**（`raw` 原样行 / `item` 数据行），增删改只动 item 块 ——
  注释、空行、表头、`|---|` 分隔行、第 3 列起的额外列都在原位；原本只写一列的行不会被"补"成两列。
  逐行容错：坏行/超限行跳过并给出行号原因，能部分加载就部分加载。
- **一组一张表**（2026-09 与循环组一起加）：文件里**每组的表 = 一个 Markdown 表格**，
  组与组之间用 `## 组名` 抬头分隔（**两个及以上 `#`** 开头的那一行；单个 `#` 仍是注释，原样保留）。
  解析时抬头一出现就切到新组，那一组里的表头各自声明列；**没有抬头的老文件 = 隐含的一组**
  （名字留空、面板给默认名）→ 老文件一字不动。拖组排顺序时**文件里那几张表跟着挪**
  （`qcmdMoveGroupBlocks` 按段搬），新建组补一整节（抬头 + 表头 + 分隔行 + 那一行），删组把那段删掉。
  导出（副本）**一定**写抬头；写回用户的挂载文件时只有一组**不写抬头**（不擅自改他的结构），
  多组才必须写（否则表达不了组）。⚠️ 纯指令行载体表达不了分组 —— 多组时导出升级成 Markdown 表格并提示
- **顺序号 / 延时 / HEX 三列：表头驱动**（2026-09）。文件表头写了列名，那一列才被当作该参数：
  - 认得的列名：`名称`（name/label/title）、`指令`（命令/内容/cmd/command/value/data）、
    `顺序号`（顺序/序号/次序/序/order/seq/sequence）、`延时(ms)`（延时/延迟/间隔/delay/interval/ms）、
    `HEX`（十六进制/格式/format/mode）。归一化会抹平大小写、空格与 `(ms)` 这类括注。
    别名表**刻意收窄**：`编号`/`no`/`num`/`index` 这种很可能是用户自己的 ID 列**不认** —— 认错就把 `A1` 改写成 `0`。
  - **HEX 列的值**：读的时候宽容（`true` / `1` / `hex` / `是` / `十六进制` 都算开，其余算关），
    写回统一成**布尔字面** `true` / `false`（用户 2026-09 要求：这是布尔开关，别写 `hex`/`text`）。
  - **没写这些列的文件一律按老规矩**（第 1 列名称、第 2 列指令、第 3 列起是用户的备注，原样保留）。
    绝不按列号硬塞：那会把用户写在第 3 列的「备注甲」读成顺序号再改写成 `0`（真丢数据）。
  - **写回挂载文件不擅自补列**（用户的表结构由用户定）；表头声明了列却缺列的条目，
    新增数据行会按表头的列补齐（`0 / 1000 / false`），不会把表格撑歪。
  - **没动过的格子原样回吐**：用户写的 `0` / `是` / 空格原样保留，只有他真改了值（或面板新建/导出）
    才规范化成 `0 / 1000 / false`（`qcmdParamCell`）—— 往返保真因此仍成立。
  - 文件没声明那几列时，参数只随 `config.json` 走，重载/导入时按**指令内容**带回来
    （`qcmdCarryItemPrefs`）：内容改过就对不上、回到默认；导入这类文件时会**提示一次**
    「这三项只保存在本机配置里，点导出可得到带三列的文件」（不做静默 no-op）。
  - 顺带：名称已退出界面。**整行都空的条目**不写回文件（写进去也活不过一次重载 —— 解析端把空行当结构行丢掉）；
  但**表头声明了 顺序号/延时/HEX 的文件里，"还没填内容、参数格有值"的行必须留着** ——
  跳掉它，写回/导出的条数就跟面板对不上了（用户 2026-09 报的"文件与前端对不上"）。
- **导出 = 自包含快照**：`qcmdExportPrep` 一律补全三列，**列序照抄面板**
  （`顺序号 | 指令 | 延时(ms) | HEX`，用户 2026-09 反馈过"顺序号怎么在指令右边"），且**一条都不跳**
  （`fill:true` 把 0 / 1000 / true|false 写全，空条目也占一行）—— 行数必须与面板上的条数一致；
  **不带「名称」列**（面板里没有名称入口，导出的副本就该与面板一一对应；挂载文件自己的名称列
  由写回路径原样保留，不受影响）。纯指令行载体放不下这三项且确实有非默认参数时，
  升级成 Markdown 表格并提示（`qcmdItemHasParams`）。导出的是副本，补列只动副本、不碰用户的挂载文件。
- **上限**（`mcp_limits` 里可查）：文件 256 KB、条目 500、名称 64 字符、指令 4096 字符；
  字节数在 Rust 侧拦（读前先看 metadata），条目/长度在解析时截断。
- **安全**：路径只认**用户在原生文件框里亲手选过**的（记在后端自己的
  `%APPDATA%\seahi-serial\quick-cmds-files.json`，LRU 50；前端与 MCP 都传不了任意路径）；
  写回原子（临时文件 + rename）；写回前比对内容哈希，被别的编辑器改过就报冲突而不是静默覆盖；
  **只有"成功读过一次"（手里有内容哈希）的挂载才允许写回** —— 文件被删/读不到/超限时宁可拒写
  （两端各拦一道），也绝不拿内存里的列表把用户文件重写一遍；沿用读入时的编码
  （UTF-8/BOM → 失败回退 GBK），不会把用户的 GBK 文件变成乱码。
- **UX**：标题行右侧 `＋添加 / 导入 / 导出`；挂了文件后来源行显示文件名 + `重载` + `断开`；
  同一个文件不允许被两个监视器同时挂载（否则互相写回打架）；读不到文件时保留上次列表并提示，
  绝不清空；关闭窗口前会把去抖中的写回刷掉。

### 6.5 发送历史

- 每个监视器保存最近 50 条记录
- 连续去重（相同内容不重复）
- 支持下拉选择和键盘上下键快速回填

### 6.6 波特率选择

- 预设常用波特率：50 ~ 4000000 全范围
- 支持自定义输入任意波特率

### 6.7 主题系统

- 6 种风格 × 深浅色 = 12 种主题
- 通过 CSS 变量 + `data-theme` 属性切换
- 首次启动自动匹配系统深浅色
- 主题偏好保存到 localStorage

### 6.8 WSL 端口映射

- 通过 `usbipd-win` 工具将 USB 设备映射到 WSL
- 支持手动映射和自动映射（设备插拔自动重连）
- WSL 发行版启动/关闭管理
- 运行时间和内存使用实时监控

### 6.9 首次使用引导

- 9 步聚光灯引导，覆盖所有核心功能
- 目标元素高亮 + 卡片定位（自动避让视口边界）
- 支持跳过和点击外部关闭
- localStorage 记录完成状态

### 6.10 主窗口几何记忆（window.json）

窗口位置/尺寸/最大化状态由 **Rust 端**统一记忆，前端不再参与（PR #20，v0.5.1 起）。

| 环节 | 实现 | 为什么 |
|------|------|--------|
| 存储 | `%APPDATA%\seahi-serial\window.json`（`SavedWindowState{x,y,width,height,maximized}`） | 与用户配置 `config.json` 分开：两者写入时机与责任人都不同，混在一起会互相覆盖 |
| 采集 | `Moved`/`Resized` → `window_auto_save(window, false)`，400ms 去抖；`CloseRequested` → `window_auto_save(window, true)` 强制写 | 拖动时每帧写盘不可接受；但退出前最后一下几何必须留住 |
| 保护 | 非强制保存只在 `window.is_visible()` 时执行；最大化只翻 `maximized` 标志、保留最近一次普通几何；最小化（`-32000` 哨兵坐标）不改写普通几何 | 启动期隐藏窗口摆放的瞬时态（甚至 2068×2060 这类异常尺寸）不能污染记录 |
| 坐标 | 位置取 `outer_position()`、尺寸取 `inner_size()` | 恢复时 `set_position` 设外框、`set_size` 设客户区；取错一个，每次开关窗口都会向右下漂移一格 |
| 恢复 | `setup` 里设完最小尺寸后 `apply_window_state()`；位置需通过 `rect_on_screen()`（与任一显示器至少重叠 60×40）才恢复 | 拔掉外接显示器后，窗口不能被"放"到不存在的虚拟屏上再也找不回来 |
| 迁移 | 读不到 `window.json` 时回退 `config.json` 的 `windowWidth`/`windowHeight`（只取尺寸、不取位置） | 老用户升级后第一次启动不该看到窗口尺寸被重置；旧字段里没有位置，(0,0) 会把窗口顶到左上角 |
| 显示 | `tauri.conf.json` 主窗口 `visible:false`；前端页面就绪后 `revealMainWindow()` → `reveal_main_window`；Rust 端另有 4 秒兜底显示 | 先显示再移动/缩放会看到窗口跳变；但**任何**异常路径都必须能把窗口露出来，否则用户面对的是"应用启动了但没有窗口" |

`config.json` 里的 `windowWidth`/`windowHeight` **仍然照写不误**（`collectConfig`）：MCP 的
`ui_get_state` 的 `window` 分支读的就是它，同时它也是上面那条迁移回退的数据来源。

---

## 7. 构建配置

### 7.1 Cargo.toml 依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| `tauri` | 2.x | 桌面框架 |
| `serialport` | 3.3 | 串口驱动 |
| `rfd` | 0.15 | 原生对话框 |
| `serde` + `serde_json` | 1.x | 序列化 |
| `winapi` | 0.3 | Win32 SetupAPI |
| `windows-sys` | 0.59 | CM_Register_Notification |
| `reqwest` | 0.12 | HTTP 请求（更新检测） |
| `base64` | 0.22 | WSL bridge 解码 |
| `tauri-build` | 2.x (build) | 构建工具 |

### 7.2 Tauri 配置要点

| 配置 | 值 | 说明 |
|------|-----|------|
| `build.frontendDist` | `../src` | 前端直接使用 src 目录 |
| `app.withGlobalTauri` | `true` | 全局 __TAURI__ API |
| `app.security.csp` | `null` | 禁用 CSP（内联脚本需要） |
| `app.windows[0].visible` | `false` | 启动先隐藏，等 Rust 恢复几何 + 前端就绪后由 `reveal_main_window` 一次性显示（见 §6.10；改了它窗口会先闪一下默认几何） |
| `bundle.targets` | `"all"` | 所有打包格式 |

### 7.3 ACL 权限 (capabilities/default.json)

- `core:default` — 核心默认权限
- `core:window:*` — 全部窗口操作权限
- `core:webview:default` — WebView 默认权限
- `core:webview:allow-create-webview-window` — 创建子 WebView

### 7.4 Inno Setup 安装程序

- 需要管理员权限（串口访问要求）
- LZMA2 最高压缩
- 简体中文界面
- 创建桌面快捷方式 + 开始菜单
- 安装后可选立即运行
- 包含 usbipd-win.msi 安装包

---

## 8. CI/CD

### GitHub Actions 工作流

| 属性 | 值 |
|------|-----|
| 触发条件 | 推送 `v*` 标签 / 手动触发 |
| 运行环境 | `windows-latest` |
| Node.js | v22 |
| Rust | stable (dtolnay) |
| 缓存 | swatinem/rust-cache |
| 构建 | tauri-apps/tauri-action@v0 |
| 产物 | 正式 Release（latest，非草稿） |

**发布流程**:
1. 同步更新版本号（`Cargo.toml`、`tauri.conf.json`、`installer.iss`、`package.json`、`Cargo.lock` 共 5 处 —— CI 会校验一致性）
2. 提交并推送到 main 分支
3. 创建并推送版本标签：`git tag v0.x.x && git push origin v0.x.x`
4. GitHub Actions 自动构建并**直接发布正式 Release（latest）**，无需人工发布

---

## 9. 版本号同步清单

每次发布新版本时，需同步更新以下文件中的版本号：

| 文件 | 字段 | 当前版本 |
|------|------|----------|
| `Cargo.toml` | `package.version` | 0.1.15 |
| `tauri.conf.json` | `version` | 0.1.15 |
| `installer.iss` | `MyAppVersion` | 0.1.15 |
