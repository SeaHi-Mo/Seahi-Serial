# AGENTS.md

## 项目简介

基于 Tauri 2 的串口/蓝牙调试桌面工具，仅支持 Windows。前端为纯 HTML/CSS/JS（无框架，单文件）；后端为 Rust（`main.rs` 主逻辑 + `src/mcp/` 模块，见下）。

## 常用命令

```bash
npm install        # 安装前端依赖 (@tauri-apps/cli)
npm run dev        # 开发模式（热重载）
npm run build      # 发布构建 → src-tauri/target/release/seahi-serial.exe
cargo test --manifest-path src-tauri/Cargo.toml   # 后端单测（广播解析/设备类型/从机属性/busid 白名单/MCP 协议与日志中心）
```

无 lint 与类型检查；后端有单测（`main.rs` 里的 `#[cfg(test)]` 模块，150 条 + 4 条 `#[ignore]`
真机/诊断）。BLE 从机相关的三条（需蓝牙硬件）：

```bash
# 环境诊断：一次性打全"广播为什么起不来"的证据（适配器/权限/能力位/真实广播结果）
cargo test --manifest-path src-tauri/Cargo.toml ble_periph_diagnose -- --ignored --nocapture
# 已证实：GATT 服务与特征建得出来（任何 Windows 机器都应通过）
cargo test --manifest-path src-tauri/Cargo.toml ble_periph_builds -- --ignored --nocapture
# 未达成：真的在对外广播吗（当前失败，见 doc/BLE_PERIPHERAL.md 第 5 节）
cargo test --manifest-path src-tauri/Cargo.toml ble_periph_starts_advertising -- --ignored --nocapture
```

前端**有**无头断言集 `.walkthrough/gen_ble_preview.js`（当前 908 条，随代码演进增补；MCP 的 npm 安装器另有
`npm/seahi-serial-mcp/test/self-test.js`，62 条）：直接从
`src/index.html` 抽取真实函数/对象丢进 `vm` 沙箱断言（既有源码正则，也有把渲染函数丢进假 DOM
跑行为断言），改前端后应先跑
`node .walkthrough/gen_ble_preview.js`。`.walkthrough/` 已纳入版本库（仅忽略 `__pycache__`）。
改了 MCP 工具定义后，顺手重跑 `node .walkthrough/gen_mcp_tools_doc.js` 重新生成 `doc/MCP_TOOLS.md`（断言集里有一条守着"文档必须列出全部内置工具"）。

## BLE 主机方向的三个关键约定（别改回去）

1. **设备不广播就搜不到**：从机一旦被 Windows 配对过、或被别的手机连走，往往就不再广播，
   于是永远进不了扫描列表。唯一出路是 `ble_connect_direct`（btleplug `add_peripheral`，
   按 MAC 直连）。改连接逻辑时别把这个入口去掉。
2. **状态里存的是 `adapters`（列表）而不是单个 adapter**：只留第一个会让"插在第二个适配器上的
   设备永远搜不到"。`ble_get_devices` / `ble_find_peripheral` / `ble_refresh_rssi` 都必须遍历全部。
3. 后端连接有 **10 秒显式超时**（`BLE_CONNECT_TIMEOUT_MS`，比前端的 15s 略短），超时会主动
   `disconnect` —— 为的是不让"前端放弃了、后端稍后才连上"造成长期状态错位。

## MCP 的八条关键约定（别改回去）

1. **MCP 服务器必须在应用进程内**：它要拿 `AppHandle` 才能访问托管状态、还要 `emit` 驱动 WebView 的 DOM。
   外部独立进程（含"做成 npm 包"）两样都做不到 —— 详见 `doc/MCP_DESIGN.md` §3.4。
2. **绝不加 `panic = "abort"`**：工具里任何一次 panic 都会杀掉整个进程（用户的串口会话就没了）。
   分派边界**真的有** `catch_unwind`（`handle_raw_guarded`，2026-09 补上 —— 在那之前文档一直
   声称有、实际全 crate 都没有），panic 会转成一条 JSON-RPC 错误 + 一次错误上报。
3. **工具改界面一律走"合成 DOM 事件"**（`el.click()` / 派发 `input`+`change`），复用既有 inline handler。
   不要为 AI 单写一套逻辑，否则两套必然漂移。
4. **AI 记录只写 `ai-config.json` / `ai-calls.jsonl`**，`config.json` 里绝不能出现 AI 痕迹
   （断言集里有专门守这条的检查）。AI 配置一律原子写（临时文件 + rename，别重犯 M7）。
5. **只监听回环**，`server.host` 只接受 `127.0.0.1`/`::1`/`localhost`；`/healthz` 是唯一免鉴权端点，
   且**只回 `{"ok":true}`**（泄露版本号等于给本机任意进程一个信息泄露点）。
6. **日志旁路必须挂"生产端"且非阻塞**：写日志的可能是串口读线程（25ms 轮询，延迟敏感），
   所以 `LogHub::push` 用 `try_lock`，拿不到锁就丢一条并计数。**绝不去 drain 前端轮询的队列**
   （那是单消费者队列，抢走会让界面丢数据）。另外**内存上限必须是被执行的、不只是被报告的**：
   通道名是动态的（`serial:<面板>:<方向>`，开 N 个监视器就多 2N 个通道），所以除了每通道上限，
   还必须有**全局** `TOTAL_CAP_BYTES`（超了按"裁最大的通道"尽力回收，`try_lock` + 单次最多 4 个通道）
   与 `MAX_CHANNELS`（到顶不建新通道，丢弃计入 `channelSkips`）。
7. **`expose.autoControlTools` 默认关闭**：几百个 `ctl_*` 工具会明显拖累模型选工具的准确率。
   要打开就打开，但别改成默认开。
8. **运行期错误必须进错误上报**（不只是写本地日志）：MCP 出问题以前只写 `dbg_log`，用户报障时
   既看不到也数不清。现在统一走 `mcp::report::report(kind, detail)` → 程序既有的 `report_error`
   （LogHub 的 `error` 通道 + 本地日志 + Sentry + 自建服务/SQLite）。三条纪律：
   ① **同类错误 5 分钟内只报一次**（`DEDUP_WINDOW_SECS`）—— 服务端去重是最后一道闸，
   不能让一个每秒重试的客户端把网络和库打爆；② **上报前把 token 打码**（`remember_secret`
   在启动时登记当前令牌）；③ **上报路径自己不阻塞、不 panic**。



## 项目结构

- `src/index.html` — 整个前端（单文件，约 10400 行，含 12 套主题变量；串口 / WSL / ADB / 蓝牙 四个面板）
- `src-tauri/src/mcp/` — **MCP 服务器**（模块级，约 5700 行）：`transport.rs`（hyper + SSE + 会话/鉴权/限流/广播）、`protocol.rs`（JSON-RPC + 工具定义与分派）、`bridge.rs`（前端桥：emit + 回执 + 超时回收）、`registry.rs`（控件注册表 → `ctl_*` 工具）、`loghub.rs`（日志中心）、`calllog.rs`（`ai-calls.jsonl`）、`aiconfig.rs`（`ai-config.json`）、`report.rs`（运行期错误 → 程序既有的错误上报通道）、`mod.rs`（启停/生命周期 + 8 个命令）
- `npm/seahi-serial-mcp/` — **MCP 客户端配置安装器**（零依赖 CLI + 62 条自测；`npx seahi-serial-mcp install`）
- `doc/MCP.md` — MCP 使用说明（面向使用者）｜`doc/MCP_TOOLS.md` — **20 个工具的参考手册**（工具名/描述/入参由 `.walkthrough/gen_mcp_tools_doc.js` 从 `protocol.rs` 生成，返回结构是实调抓的）｜`doc/MCP_DESIGN.md` — MCP 设计文档（含每步的实施记录）
- `src-tauri/src/main.rs` — 整个 Rust 后端（约 7400 行，89 个 `#[tauri::command]`）：串口枚举（SetupAPI）、多串口连接/断开、DTR/RTS 切换、收发数据、WSL 端口映射、USB 设备管理、ADB 会话、**BLE 主机（btleplug，代码在 `fn main()` 内）与 BLE 从机（WinRT `GattServiceProvider`，代码在模块级）**
- `src-tauri/Cargo.toml` — Rust 依赖（serialport 3.3, rfd 0.15, winapi 0.3, windows-sys 0.59, **windows 0.62 + windows-future 0.3（BLE 配对与 BLE 从机用 WinRT）**, **tokio（`time::timeout` + MCP 的 `rt/net/sync/io-util`，刻意不开 `macros`）**, reqwest 0.12, base64 0.22, btleplug 0.13, **hyper 1 + hyper-util + http-body-util + bytes（MCP 的 SSE 服务器；都已由 reqwest 带入依赖树，无新增下载）**）
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
- **release 构建不带 DevTools**（用户要求）。真正的开关是 **tauri 的 `devtools` cargo feature 必须保持关闭**：`tauri-runtime-wry` 里那段 `with_devtools(..)` 被 `#[cfg(any(debug_assertions, feature = "devtools"))]` 整个门控，所以 release（`debug_assertions` 关闭）只要不开这个 feature，那段代码根本不编译，落到 wry 自己的默认值 `false`。**debug 构建仍然有 DevTools**（内存分析要靠它）。⚠️ `tauri.conf.json` 里的 `devtools` 字段是**死配置** —— tauri 2.11.2 / codegen / build 里没有任何代码读它（逐个 crate 搜过），写了也不生效，只会让人误判，**别再加回去**（断言集里两条守着）
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
