# SeaHi Serial - 项目交接文档

> 版本: v0.1.15 | 最后更新: 2026-07-01 | 作者: SeaHi

---

## 1. 项目简介

**SeaHi Serial** 是一款基于 Tauri 2 + Rust 的轻量级串口调试桌面工具，采用 VS Code Serial Monitor 风格界面。适用于嵌入式开发、物联网调试等需要串口通信的场景。

### 核心特性

- 多串口分栏同时调试
- 文本/Hex/双模式数据显示
- ANSI 颜色渲染
- 快速指令（自定义常用命令一键发送）
- 发送历史记录（最多 50 条，键盘上下键快速回填）
- 自动重连、自动滚动
- DTR/RTS 信号实时控制
- 日志导出
- 6 种主题风格 × 深浅色 = 12 种主题
- WSL 端口映射（通过 usbipd-win）
- WSL 串口监控（通过 Python bridge）
- USB 设备插拔自动检测
- 首次使用引导（9 步）
- 自动更新检测

---

## 2. 环境准备

### 2.1 开发环境要求

| 工具 | 版本要求 | 用途 |
|------|----------|------|
| **Rust** | stable (1.70+) | 后端编译 |
| **Node.js** | 18+ | 前端工具链 |
| **npm** | 随 Node.js 安装 | 包管理 |
| **WebView2 Runtime** | 系统预装 | 运行时 (Win10 1809+ 已内置) |
| **Inno Setup** | 6.x (可选) | 打包安装程序 |

### 2.2 安装步骤

```bash
# 1. 克隆仓库
git clone git@github.com:SeaHi-Mo/Seahi-Serial.git
cd SeaHi-Serial

# 2. 安装前端依赖
npm install

# 3. 开发模式运行（热重载）
npm run dev

# 4. 构建发布版
npm run build
```

构建产物位于 `src-tauri/target/release/bundle/`。

---

## 3. 项目结构说明

```
serial-debugger-tauri/
├── src/index.html              ⭐ 前端全部代码（HTML + CSS + JS，单文件 ~4400 行）
├── src-tauri/src/main.rs       ⭐ 后端全部代码（Rust，单文件 ~1745 行）
├── src-tauri/tauri.conf.json     Tauri 主配置
├── src-tauri/Cargo.toml           Rust 依赖
├── src-tauri/wsl-daemon/          WSL bridge 脚本（base64 编码）
├── installer.iss                  安装打包脚本
├── package.json                   Node.js 配置
├── skills/seahi-serial-dev/       AI 开发技能指南
├── doc/                           项目文档
└── .github/workflows/build.yml    CI/CD 自动构建
```

> ⚠️ **重要**: 前端是一个单文件应用，所有 CSS 和 JS 都内联在 `index.html` 中，没有模块拆分。

---

## 4. 代码导航指南

### 4.1 前端 (index.html)

| 区域 | 行号范围 | 内容 |
|------|----------|------|
| CSS 变量 | 9-45 | 主题色板（深色默认） |
| 浅色主题 | 48-145 | `[data-theme="default-light"]` |
| 多风格主题 | 147-1000 | 浮世绘彩、诗意东方、水墨丹青、桃之夭夭、金风玉露 |
| 组件样式 | 1020-1540 | 工具栏、按钮、下拉框、输出区等 |
| 引导样式 | 1540-1610 | 首次使用引导 |
| HTML 结构 | 1611-1660 | body、全局栏、分栏容器、引导 DOM |
| SVG 图标常量 | 1674-1690 | ICONS 对象（12 个内联 SVG） |
| 工具函数 | 1692-1715 | parseAnsi, escapeHtml |
| 窗格创建 | 1735-1870 | createMonitorPane（生成完整监视器 DOM） |
| 键盘事件 | 1880-1940 | sendInput 的 keydown 处理 |
| 波特率下拉 | 1956-2010 | toggleBaudDropdown, setBaud |
| 串口操作 | 2054-2400 | refreshPorts, connectPort, disconnectPort, startReading 等 |
| 发送逻辑 | 2423-2500 | sendData, addMonitor, closeMonitor, 行尾处理 |
| 日志保存 | 2480-2510 | chooseLogDir, saveLogToFile, copyOutput |
| 数据解码 | 2511-2570 | decodeData, decodeRaw, hexToBytes, bytesToHex |
| 快速指令 | 2585-2720 | makeQcmdItem, toggleQcmdDropdown, addQcmdItem 等 |
| 配置管理 | 2755-2970 | collectConfig, applyMonitorConfig, scheduleConfigSave |
| 主题系统 | 2994-3100 | toggleTheme, applyTheme, syncThemeUI |
| WSL 面板 | 3155-3700 | getWslMappingHtml, openWslMapping, initWslMonResize |
| WSL 串口 | 3378-3500 | initWslMonitor, WSL 数据收发 |
| 初始化 | 4221-4260 | DOMContentLoaded 事件、设备监听 |

### 4.2 后端 (main.rs)

| 区域 | 行号范围 | 内容 |
|------|----------|------|
| 入口 + 设备监听 | 1-88 | `main()`、`start_device_watcher` |
| WSL shell | 90-160 | 持久化 WSL shell 进程 |
| 全局状态 | 164-210 | `PortState`、`WslSerialState`、辅助函数 |
| 串口枚举 | 215-350 | SetupAPI 调用、`list_ports` |
| 串口操作 | 350-485 | `open_port`、`close_port`、`send_data`、`read_data`、`set_dtr`、`set_rts` |
| WSL 设备管理 | 485-700 | `list_wsl_devices`、`check_wsl_status`、WSL 发行版管理 |
| WSL 串口转发 | 700-1100 | bridge 脚本部署、`open_wsl_serial`、`read_wsl_serial`、`send_wsl_serial` |
| USB 映射 | 1100-1500 | `attach_port_to_wsl`、`detach_port_from_wsl`（含管理员提权） |
| 杂项 | 1500-1745 | `open_url`、日志、配置保存 |

---

## 5. 关键设计决策

### 5.1 为什么选择单文件前端？

- 项目规模较小，模块化收益不明显
- 部署简单，`frontendDist` 直接指向 `src/` 目录
- 无需打包工具（webpack/vite），减少构建复杂度

### 5.2 为什么轮询读取而非事件驱动？

- `serialport` crate 的事件驱动 API 在 Windows 上稳定性不佳
- 50ms 轮询间隔在串口调试场景下完全足够
- 实现简单，可靠性高

### 5.3 为什么用 Mutex 而非 tokio？

- 当前串口操作不需要异步（读写都是阻塞式）
- Tauri 的 invoke handler 已经是异步的，前端不会被阻塞
- 保持依赖最小化，不引入 async runtime

---

## 6. 常见开发任务

### 6.1 添加新的 Tauri 命令

1. 在 `main.rs` 中添加 `#[tauri::command]` 函数
2. 在 `main()` 的 `generate_handler!` 中注册
3. 前端通过 `invoke('command_name', { args })` 调用

### 6.2 添加新的工具栏按钮

1. 在 `ICONS` 对象中添加 SVG 图标常量
2. 在 `createMonitorPane()` 的 `.ibtn-group` 区域添加按钮 HTML
3. 编写对应的 JS 函数
4. 如需后端支持，添加新的 Tauri 命令

### 6.3 发布新版本

```bash
# 1. 同步版本号（3 处）
#    - Cargo.toml        → package.version
#    - tauri.conf.json   → version
#    - installer.iss     → MyAppVersion

# 2. 提交并推送
git add -A && git commit -m "chore: 版本号更新至 v0.x.x"
git push origin main

# 3. 创建标签并推送
git tag v0.x.x
git push origin v0.x.x

# 4. GitHub Actions 自动构建 Draft Release
# 5. 到 GitHub Releases 页面手动发布
```

---

## 7. 已知问题与注意事项

### 7.1 Windows 图标缓存

Windows 会缓存 exe 图标。修改应用图标后需要清除缓存。

### 7.2 串口权限

- Windows 下串口访问通常需要管理员权限
- 安装程序设置了 `PrivilegesRequired=admin`

### 7.3 CSP 已禁用

`tauri.conf.json` 中 `security.csp` 设为 `null`，这是为了支持内联 `<script>` 和 `style`。

---

## 8. 功能开关说明

| 按钮 | 默认状态 | 说明 |
|------|----------|------|
| 自动滚动 | 开启 | 输出区满时自动滚动到底部 |
| 自动重连 | 关闭 | 串口断开时自动尝试重新连接 |
| 终端模式 | 关闭 | 输出区行为模拟终端 |
| 时间戳 | 关闭 | 每条接收数据前显示时间戳 |
| 消息回显 | 关闭 | 发送数据时在输出区显示已发送内容 |
| 行号 | 关闭 | 显示行号列 |

---

## 9. Git 分支策略

| 分支 | 用途 |
|------|------|
| `main` | 稳定发布分支 |
| `v*` tag | 版本发布标签，触发 GitHub Actions 自动构建 |

---

## 10. 联系与资源

- **GitHub**: https://github.com/SeaHi-Mo/Seahi-Serial
- **Issue 反馈**: 提交至 GitHub Issues
- **技术文档**: `doc/ARCHITECTURE.md`
- **AI 开发指南**: `skills/seahi-serial-dev/SKILL.md`
- **测试用例**: `TEST_CASES.md`
