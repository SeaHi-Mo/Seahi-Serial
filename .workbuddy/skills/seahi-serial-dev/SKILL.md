---
name: seahi-serial-dev
description: SeaHi Serial 串口调试器项目开发技能。在对此 Tauri 2 + Rust 串口调试器项目进行开发、构建、发布、修复 bug 或添加新功能时触发。涵盖项目架构、前后端代码导航、常见开发任务和版本发布流程。
agent_created: true
---

# SeaHi Serial Dev

SeaHi Serial 是一款基于 Tauri 2 + Rust 的轻量级串口调试桌面工具，采用 VS Code Serial Monitor 风格界面。本技能为该项目的开发提供架构导航和操作指南。

## 项目架构速览

```
serial-debugger-tauri/
├── src/index.html           ← 前端全部代码（HTML+CSS+JS 单文件，约 990 行）
├── src-tauri/src/main.rs    ← 后端全部代码（Rust 单文件，约 248 行）
├── src-tauri/tauri.conf.json  ← Tauri 主配置
├── src-tauri/Cargo.toml        ← Rust 依赖
├── installer.iss               ← Inno Setup 安装脚本
├── package.json                ← Node.js 配置（脚本: dev / build）
├── .github/workflows/build.yml ← GitHub Actions CI/CD
└── doc/                         ← 项目文档（ARCHITECTURE.md / HANDOVER.md）
```

前端为零框架单文件应用，所有 CSS 和 JS 内联在 `index.html` 中，通过 `window.__TAURI__.core.invoke()` 与 Rust 后端 IPC 通信。后端仅一个 `main.rs` 文件，通过 `serialport 3.3` 驱动串口 I/O。

## 核心命令

```bash
npm run dev      # 开发模式（热重载）
npm run build    # 构建发布版 exe
```

构建产物：
- `src-tauri/target/release/seahi-serial.exe` — 便携版
- `src-tauri/target/release/bundle/nsis/` — NSIS 安装包（如需 Inno Setup 打包，用 `installer.iss`）

## 版本发布流程

发布新版本时，按顺序完成以下步骤：

1. **同步版本号**（4 个文件必须一致）：
   - `Cargo.toml` → `package.version`
   - `tauri.conf.json` → `version`
   - `installer.iss` → `MyAppVersion`
   - `package.json` → `version`

2. **提交并推送**：
   ```bash
   git add -A && git commit -m "chore: 版本号更新至 v0.x.x"
   git push origin main
   ```

3. **创建标签触发自动构建**：
   ```bash
   git tag v0.x.x && git push origin v0.x.x
   ```

4. GitHub Actions 自动构建 Draft Release → 手动在 Releases 页面发布

> ⚠️ 避免创建与标签同名的分支（如 `v0.1.2` 分支 + `v0.1.2` 标签），会导致 `git push` 报 "matches more than one" 错误。推送时需用完整引用 `refs/heads/v0.1.2:refs/heads/v0.1.2`。

## 前端代码导航 (index.html)

| 区域 | 行号 | 内容 |
|------|------|------|
| CSS 样式 | 7 ~ 338 | 设计变量 + 组件样式 + ANSI 颜色类 |
| ICONS 常量 | 360 ~ 373 | 11 个内联 SVG 图标字符串 |
| parseAnsi / escapeHtml | 376 ~ 399 | ANSI 转义解析、HTML 转义 |
| createMonitorPane | 401 ~ 502 | 动态创建监视器 DOM |
| 键盘事件 | 504 ~ 556 | Enter 发送 / 上下键历史导航 / Esc 关闭 |
| 波特率下拉 | 564 ~ 583 | toggleBaudDropdown, setBaud |
| 串口操作 | 585 ~ 707 | refreshPorts, connectPort, disconnectPort, startReading |
| 发送逻辑 | 709 ~ 775 | sendData, hexToBytes, bytesToHex, 行尾处理 |
| 日志/复制 | 777 ~ 813 | chooseLogDir, saveLogToFile, copyOutput |
| 数据解码 | 815 ~ 852 | decodeData (text/hex/both 三模式), clearLog |
| 快速指令 | 854 ~ 988 | makeQcmdItem, toggleQcmdDropdown, addQcmdItem, removeQcmdItem, rebuildQcmdList |
| 初始化 | 983 ~ 987 | DOMContentLoaded 创建主监视器 + 3秒端口刷新 |

## 后端 API (main.rs)

9 个 Tauri 命令，前端通过 `invoke("命令名", { 参数 })` 调用：

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `list_ports` | 无 | `Vec<PortInfo>` | 枚举系统串口 |
| `open_port` | monitor_id, port_name, baud_rate, data_bits, stop_bits, parity, dtr, rts | `Result<(), String>` | 打开串口 |
| `close_port` | monitor_id | `Result<(), String>` | 关闭串口 |
| `send_data` | monitor_id, data: Vec\<u8\> | `Result<usize, String>` | 写入数据 |
| `read_data` | monitor_id | `Result<Vec<u8>, String>` | 非阻塞读取 (4KB) |
| `set_dtr` | monitor_id, level: bool | `Result<(), String>` | DTR 控制 |
| `set_rts` | monitor_id, level: bool | `Result<(), String>` | RTS 控制 |
| `choose_log_directory` | 无 | `Result<Option<String>, String>` | 原生目录选择 (rfd) |
| `save_log` | content, path | `Result<(), String>` | 保存日志文件 |

## 常见开发任务

### 添加新的前端 UI 组件

1. 在 `ICONS` 对象（约行 360）中添加 SVG 图标常量
2. 在 `createMonitorPane()`（约行 401）对应区域添加 HTML
3. 编写对应的 JS 函数
4. 在 `<style>` 区域添加 CSS

### 添加新的后端命令

1. 在 `main.rs` 中编写 `#[tauri::command]` 函数
2. 在 `main()` 的 `generate_handler![]` 中注册命令
3. 前端通过 `invoke("命令名", { 参数 })` 调用

### 修改应用图标

1. 替换 `src-tauri/icons/` 下的所有图标文件（32x32.png, 128x128.png, 128x128@2x.png, icon.ico）
2. 编译后 Windows 可能有图标缓存，需清除 `%LocalAppData%\IconCache.db` 或运行 `refresh-icon-cache.ps1`

### 替换内联 SVG 图标

1. 用 Python 脚本清理 SVG：移除 XML 声明、p-id、class、version 等属性，设 `fill="currentColor"`，移除固定 width/height
2. 直接在代码中替换 `ICONS.xxx` 的值
3. ⚠️ 不要用 Python 脚本做行级替换（容易吞掉闭合括号），使用 Edit 工具精确匹配替换

## 注意事项

- `tauri.conf.json` 中 `security.csp` 设为 `null`，支持内联脚本
- 前端读取串口用 50ms 轮询（非阻塞），后端超时/空读返回空 Vec
- ACL 权限配置在 `src-tauri/capabilities/default.json`
- `PortState` 用 `Mutex<HashMap<String, Box<dyn SerialPort>>>` 管理，key 为 monitor_id

## 参考文档

详细的项目架构和交接文档位于 `doc/` 目录：
- `doc/ARCHITECTURE.md` — 系统架构图、CSS 设计系统、数据流设计
- `doc/HANDOVER.md` — 环境准备、设计决策、已知问题清单
