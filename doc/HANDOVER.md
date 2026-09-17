# SeaHi Serial - 项目交接文档

> 版本: v0.2.9 | 最后更新: 2026-08-11 | 作者: SeaHi
>
> 📌 AI 会话记忆见 [MEMORY.md](MEMORY.md)（当前状态、近期改动、技术坑、发布流程）

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
├── src/index.html              ⭐ 前端骨架（head + body 结构 + 加载 4 个 css / 14 个 js）
├── src/css/*.css                 前端样式（4 块：主题变量 / 全局 / 快速指令 / 杂项）
├── src/js/*.js                   前端逻辑（14 块，普通脚本、共享全局作用域）
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

> ⚠️ **重要（2026-09 变更）**: 前端**已不再是单文件**。它拆成了 `src/index.html`（骨架）+ `src/css/*.css`（4 块）
> + `src/js/*.js`（14 块），用普通 `<link>` / `<script src>` 按顺序加载、共享同一个全局作用域
> （**不要**改成 `type="module"`）。**目录结构、加载顺序、每块管什么、以及本文件下面那些老行号怎么对回来，
> 全看 `doc/FRONTEND_LAYOUT.md`。**

---

## 4. 代码导航指南

### 4.1 前端

老版本的这一节是一张"行号 → 内容"大表，行号早已失效（前端从 4400 行长到了 15874 行，随后又拆成 18 个文件），
所以改成"**功能 → 文件**"（行号看编辑器，别写进文档）。权威表在 `doc/FRONTEND_LAYOUT.md`：

| 功能 | 文件 |
|------|------|
| head / body 结构、行内 `onclick` | `src/index.html` |
| 主题变量（12 套）、全局组件样式 | `src/css/01-theme.css`、`02-global.css` |
| 快速指令分栏样式、Toast / 引导 / 兜底页 | `src/css/03-quickcmd.css`、`04-misc.css` |
| Tauri 桥接降级、全局错误捕获、图标、ANSI | `src/js/00-bootstrap.js` |
| 窗格创建、端口/波特率、终端模式、连接管理 | `src/js/10-monitor.js` |
| 额外监视器、发送、日志保存、输出区裁剪 | `src/js/20-extras.js` |
| MCP 注册表 / 前端桥 / BLE·ADB·串口语义层 / 日志回灌 | `src/js/30-mcp.js` |
| 接收行缓冲、紧凑存储、工具函数 | `src/js/40-utils.js` |
| 快速指令（模型 / 外部文件 / 参数 / 跳转 / 循环发送） | `src/js/50-quickcmd.js`、`51-quickcmd-ui.js` |
| 自动化工作流（规则 UI 与边界） | `src/js/60-workflow.js` |
| 配置保存恢复、自动更新、主题切换 | `src/js/70-config.js` |
| WSL 映射与 WSL 串口监视器 | `src/js/80-wsl.js` |
| BLE 主机面板 / 配对 / 从机 | `src/js/81-ble.js` |
| ADB 面板与会话 | `src/js/82-adb.js` |
| WSL 端口映射（MCP 通用桥那一份）、授权窗口 | `src/js/83-wsl-mcp.js` |
| 窗口控制、标题栏拖动、初始化、tooltip、首次引导 | `src/js/90-init.js` |

> 各功能的**行为约定与"别改回去"清单**不在这里 —— 在 `AGENTS.md`（通用/MCP/BLE/窗口几何）、
> `doc/QUICK_CMDS.md`（快速指令文件格式）、`doc/MCP_TOOLS.md`（57 个工具）里。

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
# 1. 同步版本号（5 处，漏一处 CI 的 "Verify version consistency" 直接失败）
#    - src-tauri/Cargo.toml        → package.version
#    - src-tauri/tauri.conf.json   → version
#    - installer.iss               → MyAppVersion
#    - package.json                → version
#    - src-tauri/Cargo.lock        → seahi-serial 条目的 version
#    （package-lock.json 里的 version 不进 CI 校验，但顺手一起改，别留 0.4.0 这类旧值）

# 2. 提交并推送
git add -A && git commit -m "chore: 版本号更新至 v0.x.x"
git push origin main

# 3. 创建标签并推送
git tag v0.x.x
git push origin v0.x.x

# 4. GitHub Actions 自动构建并直接发布正式 Release（latest）
#    无需手动发布（releaseDraft/prerelease/draft 均为 false）

# 5. 【别忘】改了版本号必须重新编译本地发布产物再打安装包：
#    env!("CARGO_PKG_VERSION") 是编译期烘焙进 exe 的，只改文件不重编，
#    装出来的应用还是旧版本号（2026-09 真实事故，见 AGENTS.md 的版本号同步一节）。
npm run build   # 或 cargo build --release --manifest-path src-tauri/Cargo.toml
```

> 合并社区 PR 后要注意：**已发布的 tag 是不会跟着走的**。PR 合进 `main` 只影响后续版本，
> 已经发布出去的安装包里没有这些改动 —— 需要就再切一个版本号发一次。

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
| PR 分支 | 社区贡献（如 PR #20 的窗口几何记忆）。**用 `git merge --no-ff` 合并**，保留贡献者提交 —— rebase / cherry-pick 会让 GitHub 把 PR 标成 Closed 而不是 Merged |

---

## 10. 联系与资源

- **GitHub**: https://github.com/SeaHi-Mo/Seahi-Serial
- **Issue 反馈**: 提交至 GitHub Issues
- **技术文档**: `doc/ARCHITECTURE.md`
- **AI 开发指南**: `skills/seahi-serial-dev/SKILL.md`
- **测试用例**: `TEST_CASES.md`
