# AGENTS.md

## 项目简介

基于 Tauri 2 的串口调试桌面工具，仅支持 Windows。前端为纯 HTML/CSS/JS（无框架），后端为单个 Rust 文件。

## 常用命令

```bash
npm install        # 安装前端依赖 (@tauri-apps/cli)
npm run dev        # 开发模式（热重载）
npm run build      # 发布构建 → src-tauri/target/release/seahi-serial.exe
```

项目无 lint、类型检查、格式化工具或测试套件。

## 项目结构

- `src/index.html` — 整个前端（单文件，约 4400 行，VS Code Dark 主题风格）
- `src-tauri/src/main.rs` — 整个 Rust 后端（约 1745 行）：串口枚举（SetupAPI）、多串口连接/断开、DTR/RTS 切换、收发数据、WSL 端口映射、USB 设备管理
- `src-tauri/Cargo.toml` — Rust 依赖（serialport 3.3, rfd 0.15, winapi 0.3, windows-sys 0.59, reqwest 0.12, base64 0.22）
- `src-tauri/tauri.conf.json` — Tauri 窗口配置，CSP 设为 `null`（无安全限制）
- `src-tauri/capabilities/default.json` — 窗口/Webview 的 ACL 权限
- `src-tauri/wsl-daemon/` — WSL bridge 脚本（base64 编码嵌入）
- `installer.iss` — Inno Setup 安装脚本（包含 usbipd-win.msi 打包）
- `skills/seahi-serial-dev/SKILL.md` — AI 开发技能指南

## 版本号同步

版本号必须**同时更新 3 个文件**：
1. `src-tauri/Cargo.toml` → `version`
2. `src-tauri/tauri.conf.json` → `version`
3. `installer.iss` → `MyAppVersion`

## 关键约定

- Release 构建通过 `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` 隐藏控制台窗口
- 串口友好名称直接调用 Win32 SetupAPI（UTF-16），避免 `serialport` crate 读取中文设备名时乱码（U+FFFD）
- 前端通过 `withGlobalTauri: true` 与 Rust 通信，无 npm 桥接包
- CSP 设为 `null`，无内容安全限制
- 磁盘上的程序名为 `seahi-serial.exe`（带连字符）；Rust 包名为 `seahi_serial`（带下划线）
- 设备插拔检测使用 `CM_Register_Notification`（windows-sys crate），触发 `device-changed` 事件
- WSL 串口转发通过 Python bridge 脚本实现，使用持久化 shell 避免 fork 延迟
- USB 设备映射到 WSL 依赖 `usbipd-win` 工具，需管理员权限

## CI/CD

GitHub Actions 工作流位于 `.github/workflows/build.yml`：推送 `v*` tag 触发 Windows 构建并生成 Draft Release，也支持手动触发。

## 错误上报系统

项目支持两种错误上报方案：

### 方案 1：自建错误收集服务（推荐）
```
Tauri 应用 → 自建服务 (SQLite)
```

### 方案 2：Sentry + GitHub Webhook
```
Tauri 应用 → Sentry → Webhook 服务 → GitHub Issue
```

### 文件结构
- `server/error-server.js` — 自建错误收集服务（SQLite 存储）
- `server/sentry-webhook.js` — Sentry Webhook 服务
- `server/package.json` — 服务依赖配置
- `server/INSTALL.md` — 安装部署指南
- `cloudflare-worker/` — Cloudflare Workers 版本（推荐，免费全球部署）
- `.env.example` — 环境变量示例

### 自建服务配置（本地）
```bash
cd server
npm install
node error-server.js
```

访问 http://localhost:3000 查看错误列表

### Cloudflare Workers 部署（推荐）
```bash
cd cloudflare-worker
npm install -g wrangler
wrangler login
wrangler d1 create seahi-errors
# 更新 wrangler.toml 中的 database_id
wrangler d1 execute seahi-errors --file=./schema.sql
wrangler deploy
```

部署后访问 `https://seahi-error-server.xxx.workers.dev` 查看错误列表

### Sentry 配置（可选）
1. 创建 Sentry 账号（免费版，5,000 事件/月）
2. 获取 Sentry DSN
3. 创建 GitHub Personal Access Token
4. 部署 Webhook 服务
5. 在 Sentry 项目中配置 Webhook URL

### 使用方式
```bash
# 设置环境变量（自建服务）
set ERROR_SERVER_URL=http://localhost:3000

# 设置环境变量（Sentry）
set SENTRY_DSN=https://xxx@sentry.io/xxx

# 构建 Release 版本
cargo build --release

# 启动 Webhook 服务
cd server
node sentry-webhook.js
```

### 功能特性
- 自动捕获 Panic 和运行时错误
- 错误自动去重，避免重复创建 Issue
- 详细的错误上下文（堆栈、环境信息、操作记录）
- 自动添加 `bug`, `auto-reported` 标签
- 支持离线缓存，网络恢复后上报

详见 `server/README.md`。
