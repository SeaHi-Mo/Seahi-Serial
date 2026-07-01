# SeaHi Serial — AI 开发技能指南

> 本文件指导 AI 助手如何正确开发 SeaHi Serial 项目，包含项目约束、代码规范和常见陷阱。

---

## 1. 项目概况

SeaHi Serial 是一款基于 **Tauri 2 + Rust** 的 Windows 串口调试桌面工具。

- **前端**: 纯 HTML/CSS/JS 单文件（`src/index.html`，约 4400 行），无框架、无构建工具
- **后端**: 单个 Rust 文件（`src-tauri/src/main.rs`，约 1700 行）
- **平台**: 仅 Windows（依赖 Win32 SetupAPI、usbipd-win）
- **通信**: 前端通过 `window.__TAURI__.core.invoke()` 调用 Rust 命令

---

## 2. 常用命令

```bash
npm install        # 安装依赖
npm run dev        # 开发模式（热重载）
npm run build      # 发布构建
```

项目**无** lint、类型检查、格式化工具或测试套件。

---

## 3. 项目结构

```
serial-debugger-tauri/
├── src/index.html              # 前端全部代码（单文件）
├── src-tauri/src/main.rs       # 后端全部代码（单文件）
├── src-tauri/Cargo.toml        # Rust 依赖
├── src-tauri/tauri.conf.json   # Tauri 配置
├── src-tauri/capabilities/default.json  # ACL 权限
├── src-tauri/wsl-daemon/       # WSL bridge 脚本（base64 编码）
├── installer.iss               # Inno Setup 安装脚本
├── AGENTS.md                   # 项目说明
├── doc/ARCHITECTURE.md         # 技术架构文档
├── doc/HANDOVER.md             # 交接文档
└── TEST_CASES.md               # 测试用例
```

---

## 4. 必须遵守的约束

### 4.1 版本号同步（发版前必须检查）

版本号必须**同时更新 3 个文件**：
1. `src-tauri/Cargo.toml` → `version`
2. `src-tauri/tauri.conf.json` → `version`
3. `installer.iss` → `MyAppVersion`

遗漏任何一处都会导致构建产物版本不一致。

### 4.2 前端是单文件应用

所有 HTML、CSS、JS 都在 `src/index.html` 一个文件中。

**修改前端时必须注意**：
- CSS 在 `<style>` 标签内（文件前半部分），JS 在 `<script>` 标签内（文件后半部分）
- 不要引入外部 JS/CSS 文件，不要用 import/export
- 所有 SVG 图标以内联字符串形式存在 `ICONS` 对象中
- 前后端通信使用 `invoke('command_name', { args })`，不要用 npm 桥接包
- CSP 设为 `null`，可以使用内联脚本和样式

### 4.3 后端是单文件 Rust

所有 Rust 逻辑都在 `src-tauri/src/main.rs` 中。

**修改后端时必须注意**：
- 新增的 Tauri 命令必须在 `main()` 函数的 `.invoke_handler(tauri::generate_handler![...])` 中注册
- 串口操作使用 `serialport` crate（版本 3.3），不是 `tokio-serial`
- Win32 API 调用通过 `winapi` 和 `windows-sys` crate
- 全局状态通过 `Mutex` 保护，不引入 async runtime
- 串口友好名称通过 Win32 SetupAPI 获取（UTF-16），避免 `serialport` crate 读取中文设备名乱码

### 4.4 Windows 平台限制

- 仅支持 Windows 10 1809+（需要 WebView2 运行时）
- 串口枚举使用 Win32 SetupAPI（`winapi` crate）
- 设备插拔检测使用 `CM_Register_Notification`（`windows-sys` crate）
- USB 设备映射到 WSL 依赖 `usbipd-win` 工具
- Release 构建隐藏控制台窗口：`#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`

---

## 5. 前端开发指南

### 5.1 index.html 文件结构

| 区域 | 大致行号 | 内容 |
|------|---------|------|
| CSS 变量 | 9-45 | 主题色板（深色默认） |
| 浅色主题 | 48-145 | `[data-theme="default-light"]` |
| 多风格主题 | 147-1000 | 浮世绘彩、诗意东方、水墨丹青、桃之夭夭、金风玉露 |
| 组件样式 | 1020-1540 | 工具栏、按钮、下拉框、输出区等 |
| 引导样式 | 1540-1610 | 首次使用引导 |
| HTML 结构 | 1611-1660 | body、全局栏、分栏容器、引导 DOM |
| ICONS 对象 | 1674-1690 | SVG 图标常量 |
| JS 函数 | 1692-4440 | 全部业务逻辑 |

### 5.2 添加新功能的步骤

1. 在 `ICONS` 对象中添加 SVG 图标（如需要）
2. 在 `createMonitorPane()` 函数中添加 HTML 结构
3. 编写对应的 JS 函数
4. 如需后端支持，在 `main.rs` 中添加 `#[tauri::command]` 函数
5. 在 `main()` 的 `generate_handler!` 中注册新命令
6. 前端通过 `invoke('command_name', { args })` 调用

### 5.3 CSS 主题系统

所有颜色通过 CSS 变量控制，支持 6 种风格 × 深浅色 = 12 种主题。

**添加新主题时**：
- 在 CSS 中添加 `[data-theme="风格名"]` 和 `[data-theme="风格名-light"]` 选择器
- 必须定义所有 CSS 变量（参考 `:root` 中的变量列表）
- 包含 ANSI 颜色覆盖（`.ansi-0` ~ `.ansi-97`）
- 在主题选择器的 HTML 中添加选项

### 5.4 常见前端陷阱

- **元素 ID 命名**: 使用 `mid + '-元素名'` 格式，如 `main-portSelect`、`wsl-btnStart`
- **发送栏**: `.send-bar` 使用 `flex-shrink:0` 防止被挤压
- **输出区**: `.output` 使用 `flex:1; min-height:0` 允许收缩
- **下拉框**: 使用 `position:absolute` + `z-index` 弹出，点击外部关闭
- **发送历史**: 每个监视器独立维护，最多 50 条
- **快速指令**: 每个监视器独立维护，支持动态增删
- **引导系统**: 9 步聚光灯引导，目标元素通过 CSS 选择器定位

---

## 6. 后端开发指南

### 6.1 main.rs 文件结构

| 区域 | 大致行号 | 内容 |
|------|---------|------|
| 入口 + 设备监听 | 1-88 | `main()`、`start_device_watcher` |
| WSL shell | 90-160 | 持久化 WSL shell 进程 |
| 全局状态 | 164-210 | `PortState`、`WslSerialState`、辅助函数 |
| 串口枚举 | 215-350 | SetupAPI 调用、`list_ports` |
| 串口操作 | 350-485 | `open_port`、`close_port`、`send_data`、`read_data`、`set_dtr`、`set_rts` |
| WSL 设备管理 | 485-700 | `list_wsl_devices`、`check_wsl_status`、WSL 发行版管理 |
| WSL 串口转发 | 700-1100 | bridge 脚本部署、`open_wsl_serial`、`read_wsl_serial`、`send_wsl_serial` |
| USB 映射 | 1100-1500 | `attach_port_to_wsl`、`detach_port_from_wsl`（含管理员提权） |
| 杂项 | 1500-1745 | `open_url`、日志、配置保存 |

### 6.2 添加新的 Tauri 命令

```rust
#[tauri::command]
fn my_new_command(
    state: tauri::State<'_, PortState>,  // 如需访问全局状态
    param1: String,
    param2: u32,
) -> Result<String, String> {
    // 命令逻辑
    Ok("success".into())
}
```

然后在 `main()` 中注册：
```rust
.invoke_handler(tauri::generate_handler![
    // ... 已有命令,
    my_new_command,
])
```

前端调用：
```javascript
const result = await invoke('my_new_command', { param1: 'hello', param2: 42 });
```

### 6.3 WSL 相关开发

WSL 功能通过 Python bridge 脚本实现串口转发：
- bridge 脚本以 base64 编码嵌入 `src-tauri/wsl-daemon/bridge_b64.txt`
- 运行时解码到 WSL 的 `/tmp/seahi_serial_bridge.py`
- 通过 stdin/stdout JSON 协议通信
- WSL shell 使用持久化进程避免每次 fork 的 300ms 延迟

### 6.4 常见后端陷阱

- **串口读取**: 使用非阻塞轮询（前端 50ms 间隔调用 `read_data`），不是事件驱动
- **Mutex 锁**: 使用 `unwrap_or_else(|e| e.into_inner())` 避免 poisoned lock 导致崩溃
- **隐藏窗口**: 所有子进程使用 `CREATE_NO_WINDOW` flag
- **WSL 编码**: `wsl --list` 输出可能是 UTF-16LE/UTF-32LE，需要 `decode_wsl_output` 处理
- **设备路径校验**: WSL 设备路径必须以 `/dev/tty` 开头，只允许字母数字和 `/` `_`

---

## 7. 功能模块速查

| 模块 | 前端入口函数 | 后端命令 | 说明 |
|------|------------|---------|------|
| 串口枚举 | `refreshPorts(mid)` | `list_ports` | SetupAPI 枚举 COM 口 |
| 连接/断开 | `connectPort(mid)` / `disconnectPort(mid)` | `open_port` / `close_port` | |
| 数据收发 | `sendData(mid)` / `startReading(mid)` | `send_data` / `read_data` | 50ms 轮询 |
| DTR/RTS | `toggleDTR(mid)` / `toggleRTS(mid)` | `set_dtr` / `set_rts` | |
| 日志保存 | `chooseLogDir(mid)` / `saveLogToFile(mid)` | `choose_log_directory` | |
| WSL 映射 | `openWslMapping()` | `list_wsl_devices` / `attach_port_to_wsl` | 依赖 usbipd-win |
| WSL 串口 | `initWslMonitor()` | `open_wsl_serial` / `read_wsl_serial` / `send_wsl_serial` | 通过 Python bridge |
| 主题切换 | `toggleTheme()` / `toggleThemeStyleDrop()` | 无 | 纯前端 |
| 快速指令 | `toggleQcmdDropdown(mid)` | 无 | 纯前端，localStorage 持久化 |
| 首次引导 | `showOnboarding()` | 无 | 纯前端，localStorage 记录状态 |
| 自动更新 | `checkForUpdate()` | 无 | 前端直接请求 GitHub API |

---

## 8. 版本发布清单

1. 同步更新 3 处版本号（Cargo.toml、tauri.conf.json、installer.iss）
2. 提交代码
3. `git tag v0.x.x && git push origin v0.x.x`
4. GitHub Actions 自动构建 Draft Release
5. 手动发布 Release

---

## 9. 禁止事项

- **不要**引入前端框架（React、Vue 等），保持纯 HTML/CSS/JS
- **不要**拆分 `index.html` 为多个文件（当前架构依赖单文件）
- **不要**使用 npm 桥接包调用 Tauri，使用 `window.__TAURI__.core.invoke()`
- **不要**修改 `src-tauri/gen/` 目录（Tauri 自动生成）
- **不要**在后端引入 async runtime（tokio 等），使用同步 Mutex
- **不要**修改 `installer.iss` 的 `PrivilegesRequired`（串口需要管理员权限）
- **不要**添加跨平台支持（项目仅支持 Windows）
