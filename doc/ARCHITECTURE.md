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
| `.qcmd-wrap` | 快速指令容器 | position:relative |
| `.qcmd-dropdown` | 快速指令下拉面板 | position:absolute, 向上弹出 |
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
| `ICONS.quickCmd` | 快速指令列表图标 |
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
| `makeQcmdItem(mid, idx, label, value)` | 创建指令条目 DOM |
| `toggleQcmdDropdown(mid)` | 开关下拉面板 |
| `addQcmdItem(mid)` | 添加新指令 |
| `removeQcmdItem(mid, idx)` | 删除指定指令 |
| `rebuildQcmdList(mid)` | 重建指令列表 DOM |
| `sendQcmdItem(mid, idx)` | 快速发送指令 |

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

- 每个监视器独立维护 `quickCmds[]`
- 支持动态增删、编辑名称和内容
- 下拉面板向上弹出
- 每条指令有独立发送按钮

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
| 产物 | Draft Release |

**发布流程**:
1. 同步更新版本号（`Cargo.toml`、`tauri.conf.json`、`installer.iss`）
2. 提交并推送到 main 分支
3. 创建并推送版本标签：`git tag v0.x.x && git push origin v0.x.x`
4. GitHub Actions 自动构建并创建 Draft Release
5. 在 Releases 页面手动发布

---

## 9. 版本号同步清单

每次发布新版本时，需同步更新以下文件中的版本号：

| 文件 | 字段 | 当前版本 |
|------|------|----------|
| `Cargo.toml` | `package.version` | 0.1.15 |
| `tauri.conf.json` | `version` | 0.1.15 |
| `installer.iss` | `MyAppVersion` | 0.1.15 |
