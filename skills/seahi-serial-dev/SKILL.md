# SeaHi Serial — AI 开发技能指南

> 本文件指导 AI 助手如何正确开发 SeaHi Serial 项目，包含项目约束、代码规范和常见陷阱。

---

## 1. 项目概况

SeaHi Serial 是一款基于 **Tauri 2 + Rust** 的 Windows 串口调试桌面工具。

- **前端**: 纯 HTML/CSS/JS（`src/index.html` 骨架 + `src/css/*.css` + `src/js/*.js`），无框架、无构建工具
- **后端**: 单个 Rust 文件（`src-tauri/src/main.rs`，约 1700 行）+ `src-tauri/src/mcp/` 模块
- **平台**: 仅 Windows（依赖 Win32 SetupAPI、usbipd-win）
- **通信**: 前端通过 `window.__TAURI__.core.invoke()` 调用 Rust 命令

---

## 2. 常用命令

```bash
npm install        # 安装依赖
npm run dev        # 开发模式（热重载）
npm run build      # 发布构建
```

项目**无** lint、类型检查与格式化工具；测试见下（前端无头断言集 + 后端单元测试 + 对着运行中应用的 MCP 工具自检，
命令与纪律以仓库根目录的 `AGENTS.md` 为准）。

---

## 3. 项目结构

```
serial-debugger-tauri/
├── src/index.html              # 前端骨架（head + body + 4 个 <link> + 14 个 <script src>）
├── src/css/*.css               # 前端样式（4 块）
├── src/js/*.js                 # 前端逻辑（14 块，普通脚本、共享全局作用域）
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

版本号必须**同时更新 5 处**（CI 会校验一致性，不一致直接构建失败）：
1. `src-tauri/Cargo.toml` → `version`
2. `src-tauri/tauri.conf.json` → `version`
3. `installer.iss` → `MyAppVersion`
4. `package.json` → `version`（曾漂移到 0.3.0）
5. `src-tauri/Cargo.lock` → `seahi-serial` 条目的 `version`

遗漏任何一处都会导致构建产物版本不一致。

### 4.2 前端是多文件、但仍然"一个全局作用域"

2026-09 之前全部 HTML/CSS/JS 都在 `src/index.html` 一个文件里；现在拆成骨架 + `src/css/*.css`（4 块）
+ `src/js/*.js`（14 块）。**加载顺序、每块管什么、原行号映射，见 `doc/FRONTEND_LAYOUT.md`**。

**修改前端时必须注意**：
- 只加**普通** `<link rel="stylesheet">` 与 `<script src>`；**绝不要 `type="module"`** —— 模块作用域会让
  行内 `onclick` 全部失效（拆分时 HTML 里 51 处 + JS 模板串里 151 处）。也别加打包器/转译器
- 所有块共享同一个全局作用域，顺序就是执行顺序（CSS 靠层叠，后面的覆盖前面的）
- 新代码放进"语义相邻的那一块"（面板样式进对应 css、跨面板工具函数进 `40-utils.js` 等）
- 所有 SVG 图标以内联字符串形式存在图标对象中（现位于 `src/js/81-ble.js` 的 `BLE_DEV_ICONS` 等）
- 前后端通信使用 `invoke('command_name', { args })`，不要用 npm 桥接包
- CSP 设为 `null`，可以使用行内 `onclick` 与 `style="…"`（拆分只外置了 `<style>`/`<script>` 块，
  行内属性仍在 —— 所以"顺手设个 CSP"仍然会让界面掉样式）

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

### 5.1 前端文件结构

前端 2026-09 已按功能拆分（**不是**按"HTML / CSS / JS 三段"切）。权威表在 `doc/FRONTEND_LAYOUT.md`
（含每块管什么、加载顺序、原单文件行号映射）。粗查：

| 你想找的东西 | 去哪个文件 |
|------|---------|
| head / body 结构 / 行内 `onclick` | `src/index.html` |
| 主题变量（`:root` + 12 套主题） | `src/css/01-theme.css` |
| 标题栏 / 监视器窗格 / 工具栏 / 输出区 / 发送栏 | `src/css/02-global.css` |
| 快速指令分栏 / 循环组 | `src/css/03-quickcmd.css` |
| Toast / 引导 / 启动兜底页 / xterm 滚动条 | `src/css/04-misc.css` |
| Tauri 桥接降级 / 全局错误捕获 / 图标 / ANSI | `src/js/00-bootstrap.js` |
| 创建窗格 / 下拉 / 端口 / 终端模式 / 连接管理 | `src/js/10-monitor.js` |
| 额外监视器 / 发送 / 日志 / 输出区 | `src/js/20-extras.js` |
| MCP 入口 / 控件注册表 / 前端桥 / 语义层 | `src/js/30-mcp.js` |
| 接收行缓冲 / 工具函数 | `src/js/40-utils.js` |
| 快速指令（模型 / 外部文件 / 参数 / 跳转）+ 组 UI / 循环发送 | `src/js/50-quickcmd.js`、`51-quickcmd-ui.js` |
| 工作流 UI | `src/js/60-workflow.js` |
| 自动更新 / 配置 / 主题切换 | `src/js/70-config.js` |
| WSL 映射与监视器 / ADB / BLE（含从机） | `src/js/80-wsl.js`、`82-adb.js`、`81-ble.js` |
| 初始化 / 窗口控制 / 首次引导 | `src/js/90-init.js` |

> ⚠️ 文件里的行号**别写进文档**（每次都漂）。要断言"这段代码存在"，写进
> `.walkthrough/gen_ble_preview.js`（它会按标签顺序把 css/js 内联回"逻辑单文件"再做源码正则）。

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
- **快速指令**: 每个监视器独立维护，支持动态增删；每条有 `{label, value, seq, timeout, hex, expect, retry, okGoto, errGoto}`
  （`label` 只保留在数据/外部文件里，界面上没有入口）；循环发送是**发一条等它回话**：
  `busy` 继续等 / 收到 OK 走下一条（或按 `okGoto` 跳）/ 收到 ERROR 重发（`retry` 次）/ 等满 `timeout` 或重试用尽
  就按 `errGoto` 跳或**终止整条链**。判定只在 Rust 做一份（`QcmdHs`），文件格式见 `doc/QUICK_CMDS.md`
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
| 快速指令 | `toggleQcmdSide(mid)` / `toggleQcmdLoop(mid)` | 无 | 纯前端；输出区右侧的可折叠分栏（默认折叠、只占输出区高度），每条可设顺序号/延时/HEX；配置写入 config.json（scheduleConfigSave），**循环发送开关本身不持久化** |
| 首次引导 | `showOnboarding()` | 无 | 纯前端，localStorage 记录状态 |
| 自动更新 | `checkForUpdate()` | 无 | 前端直接请求 GitHub API |

---

## 8. 版本发布清单

1. 同步更新 **5 处**版本号（`Cargo.toml`、`tauri.conf.json`、`installer.iss`、`package.json`、`Cargo.lock` 中 seahi-serial 条目 —— CI 会校验一致性）
2. 提交代码
3. `git tag v0.x.x && git push origin v0.x.x`
4. GitHub Actions 自动构建，并**直接发布为正式 Release（latest）**（`releaseDraft/prerelease/draft` 均为 false，无需手动发布）

---

## 9. 禁止事项

- **不要**引入前端框架（React、Vue 等），保持纯 HTML/CSS/JS
- **不要**把前端改成 `type="module"` 或引入打包器（模块作用域会让行内 `onclick` 全部失效；
  拆分方式与理由见 `doc/FRONTEND_LAYOUT.md`）
- **不要**使用 npm 桥接包调用 Tauri，使用 `window.__TAURI__.core.invoke()`
- **不要**修改 `src-tauri/gen/` 目录（Tauri 自动生成）
- **不要**在后端引入 async runtime（tokio 等），使用同步 Mutex
- **不要**修改 `installer.iss` 的 `PrivilegesRequired`（串口需要管理员权限）
- **不要**添加跨平台支持（项目仅支持 Windows）
