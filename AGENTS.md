# AGENTS.md

## 项目简介

基于 Tauri 2 的串口/蓝牙调试桌面工具，仅支持 Windows。前端为纯 HTML/CSS/JS（无框架），后端为单个 Rust 文件。

## 常用命令

```bash
npm install        # 安装前端依赖 (@tauri-apps/cli)
npm run dev        # 开发模式（热重载）
npm run build      # 发布构建 → src-tauri/target/release/seahi-serial.exe
cargo test --manifest-path src-tauri/Cargo.toml   # 后端单测（广播解析/设备类型/从机属性/busid 白名单）
```

无 lint 与类型检查；后端有单测（`main.rs` 里的 `#[cfg(test)]` 模块，27 条 + 3 条 `#[ignore]`
真机/诊断）。BLE 从机相关的三条（需蓝牙硬件）：

```bash
# 环境诊断：一次性打全"广播为什么起不来"的证据（适配器/权限/能力位/真实广播结果）
cargo test --manifest-path src-tauri/Cargo.toml ble_periph_diagnose -- --ignored --nocapture
# 已证实：GATT 服务与特征建得出来（任何 Windows 机器都应通过）
cargo test --manifest-path src-tauri/Cargo.toml ble_periph_builds -- --ignored --nocapture
# 未达成：真的在对外广播吗（当前失败，见 doc/BLE_PERIPHERAL.md 第 5 节）
cargo test --manifest-path src-tauri/Cargo.toml ble_periph_starts_advertising -- --ignored --nocapture
```

前端**有**无头断言集 `.walkthrough/gen_ble_preview.js`（当前 500+ 条，随代码演进增补）：直接从
`src/index.html` 抽取真实函数/对象丢进 `vm` 沙箱断言（既有源码正则，也有把渲染函数丢进假 DOM
跑行为断言），改前端后应先跑
`node .walkthrough/gen_ble_preview.js`。`.walkthrough/` 已纳入版本库（仅忽略 `__pycache__`）。

## BLE 主机方向的三个关键约定（别改回去）

1. **设备不广播就搜不到**：从机一旦被 Windows 配对过、或被别的手机连走，往往就不再广播，
   于是永远进不了扫描列表。唯一出路是 `ble_connect_direct`（btleplug `add_peripheral`，
   按 MAC 直连）。改连接逻辑时别把这个入口去掉。
2. **状态里存的是 `adapters`（列表）而不是单个 adapter**：只留第一个会让"插在第二个适配器上的
   设备永远搜不到"。`ble_get_devices` / `ble_find_peripheral` / `ble_refresh_rssi` 都必须遍历全部。
3. 后端连接有 **10 秒显式超时**（`BLE_CONNECT_TIMEOUT_MS`，比前端的 15s 略短），超时会主动
   `disconnect` —— 为的是不让"前端放弃了、后端稍后才连上"造成长期状态错位。

## 项目结构

- `src/index.html` — 整个前端（单文件，约 10400 行，含 12 套主题变量；串口 / WSL / ADB / 蓝牙 四个面板）
- `src-tauri/src/main.rs` — 整个 Rust 后端（约 7000 行，85 个 `#[tauri::command]`）：串口枚举（SetupAPI）、多串口连接/断开、DTR/RTS 切换、收发数据、WSL 端口映射、USB 设备管理、ADB 会话、**BLE 主机（btleplug，代码在 `fn main()` 内）与 BLE 从机（WinRT `GattServiceProvider`，代码在模块级）**
- `src-tauri/Cargo.toml` — Rust 依赖（serialport 3.3, rfd 0.15, winapi 0.3, windows-sys 0.59, **windows 0.62 + windows-future 0.3（BLE 配对与 BLE 从机用 WinRT）**, **tokio（只用于 `time::timeout`：给连接加超时）**, reqwest 0.12, base64 0.22, btleplug 0.13）
- `src-tauri/vendor/btleplug/` — **btleplug 的 vendored fork**（`[patch.crates-io]` 指向此处），共 4 处本地补丁；**升级依赖时必须按 `vendor/btleplug/VENDOR.md` 重新打**
- `src-tauri/tauri.conf.json` — Tauri 窗口配置，CSP 设为 `null`；**不要擅自设 CSP**：Tauri 会注入 nonce，按规范 `'unsafe-inline'` 即失效，本应用的内联样式与 172 处内联 onclick 会全被拦（界面掉样式）。要设 CSP 必须先做「内联外置」重构
- `src-tauri/capabilities/default.json` — 窗口/Webview 的 ACL 权限（仅 `core:*`，无 shell/fs/http 插件权限）
- `src-tauri/wsl-daemon/` — WSL bridge 脚本（base64 编码嵌入）
- `installer.iss` — Inno Setup 安装脚本（包含 usbipd-win.msi 打包）
- `doc/` — 架构、交接、代码评估（`CODE_REVIEW_FULL_2026-09.md`）、BLE 真机验证（`BLE_VERIFICATION.md`，主机方向）、**BLE 从机（`BLE_PERIPHERAL.md`）** 等
- `skills/seahi-serial-dev/SKILL.md` — AI 开发技能指南

## 版本号同步

发布时版本号必须**同时更新 4 个文件 + 锁文件**（漏改会导致"装着 0.3.6 却提示 0.3.7"这类更新异常）：
1. `src-tauri/Cargo.toml` → `version`（运行时版本来源：`env!("CARGO_PKG_VERSION")`）
2. `src-tauri/tauri.conf.json` → `version`（安装包 / MSI 版本来源）
3. `installer.iss` → `MyAppVersion`
4. `package.json` → `version`（曾漂移成 0.3.0，已修正）
5. `src-tauri/Cargo.lock` → `seahi-serial` 条目的 `version`

> CI 已在构建前**自动校验版本一致性**（`.github/workflows/build.yml` 的 `Verify version consistency` 步骤）：
> 上述 5 处必须完全一致；tag 触发时还要求 tag == `v{版本号}`，否则构建直接失败。
> 详见 `doc/CODE_REVIEW_FULL_2026-09.md` M25（状态：✅ 已修，v0.4.0 落地）。

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

GitHub Actions 工作流位于 `.github/workflows/build.yml`：推送 `v*` tag 触发 Windows 构建并**直接发布正式 Release（latest）**（`releaseDraft: false` + `prerelease: false`，安装包由 `softprops/action-gh-release` 以 `draft: false` 上传，**无需人工发布**），也支持手动触发。

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
