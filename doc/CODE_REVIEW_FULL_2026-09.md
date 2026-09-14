# Seahi-Serial 全量代码评估 — 2026-09

**评估日期**: 2026-09（BLE 调试开发会话之后）
**评估范围**: 全仓库（前端 / 后端 / 安全配置 / 构建发布 / 配套服务）
**方法**: 三路并行深读（Rust 后端、前端、安全与构建）+ 跨层量化检查（命令契约、死代码、文档漂移）+ 关键结论逐条复验
**基线**: `3d2892e`（工作区含本次修复）

> 与 `doc/CODE_REVIEW.md`（2026-07-27，仅错误上报系统）互补：本文是全量复核。
> 上一次评审的 P0/P1 大部分已闭环（见"已做对的部分"）。

---

## 1. 评估范围清单

| 文件 | 行数 | 角色 |
|------|------|------|
| `src/index.html` | 8563 | 全部前端（HTML/CSS/JS 单文件，无框架/无打包器） |
| `src-tauri/src/main.rs` | 4850 | 全部后端（72 个 `#[tauri::command]`，165 函数/45 async，BLE 全在 `fn main()` 内） |
| `src-tauri/tauri.conf.json` | 40 | 窗口/安全配置（`csp: null`、`withGlobalTauri`） |
| `src-tauri/capabilities/default.json` | 25 | ACL 权限（仅 `core:*`） |
| `installer.iss` | 348 | Inno Setup 安装器 |
| `.github/workflows/build.yml` | 95 | tag → Windows 构建 → Release |
| `server/*.js` | 853 | 自建错误收集服务 + Sentry webhook |
| `cloudflare-worker/*` | 477+ | Workers 版错误收集 |
| `src-tauri/vendor/btleplug` | 89 files | vendored fork（4 处本地补丁） |

**量化指标**

| 指标 | 数值 |
|------|------|
| 前端 `innerHTML` 赋值 / `escapeHtml(` 调用 | **71 / 25** |
| 前端内联 `onclick=` | **172** |
| 前端顶层 function / `var` 声明 | 220 / ~998 |
| 前端 `catch` 总数 / 空 `catch(){}` 静默吞错 | 126 / **22** |
| 后端 `unwrap()/expect()` / `let _ =` | 41 / 76 |
| 自动化测试 | Rust 8→9 个单测；前端 0（本次补了 75 条断言，但尚未纳入仓库） |
| CI 校验 | 无版本一致性、无 `cargo/npm audit`、无 `cargo test` |

---

## 2. 风险总览

| 等级 | 数量 | 已修 | 待处理 |
|------|------|------|--------|
| 🔴 严重 | 4 | **3** | 1（S4 CSP，需先做内联外置） |
| 🟠 中等 | 19 | 8 | 11 |
| 🟡 轻微 | 13 | 2 | 11 |

**评分**（各评审独立打分后的综合）

| 维度 | 分数 | 主要扣分项 |
|------|------|-----------|
| 后端（Rust） | 5.5 / 10 | 可维护性 4.0（4850 行单文件、BLE 写在 `main()` 内无法测试）、安全 4.5（提权脚本参数未校验） |
| 前端 | 5.0 / 10 | 安全（真实可用 XSS + `csp:null` + 172 内联 handler）、可维护性（8563 行单文件） |
| 安全成熟度 | 5.5 / 10 | 上报服务零鉴权、无签名、vendor 无基线 |
| 发布成熟度 | 4.5 / 10 | 版本四处人工同步且 CI 不校验、action/三方下载未固定 |

**综合结论**：工程基本功明显高于"随手写的单文件"（缓冲上限、定时器清理、单飞标志、错误上报、12 套主题变量一致性都做对了），
问题集中在**边界**（输入不校验、CSP 缺位、IPC 无二次防线）与**自动化**（无 lint/测试/CI 校验）。两个"严重"都不是新功能引入的，而是既有边界缺口在 BLE 新面上被放大。

---

## 3. 🔴 严重（4，已全部修复）

### S1 提权 PowerShell 注入（`main.rs` `run_usbipd_detach_elevated`）
`busid` 由前端直传，未经校验即插值进一段**以管理员身份执行**的 PowerShell：
```rust
// 修复前
let ps_script = format!("try {{ $out = & usbipd.exe detach --busid {busid} ...");
... Start-Process ... -Verb RunAs ...   // 提权执行
```
兄弟函数 `attach_port_to_wsl_blocking` 对同语义参数有 `数字-数字` 白名单，此处遗漏 →
`busid = "1-1; <任意命令>"` 即提权命令执行。
**修复**：抽出 `is_valid_busid()` 白名单（两边共用），非法直接拒绝；补 11 条注入用例单测。
**状态**：✅ 已修（`main.rs`，Rust 单测 9/9）

### S2 远端 BLE 广播名未转义 → DOM XSS → 全量 IPC（`index.html:7073`）
同一个值在列表转义、在详情漏转义：
```js
7018: '<span class="ble-dev-text">' + escapeHtml(dev.name || '未知设备') + '</span>'   // 有
7073: '<div class="ble-detail-name">' + (dev.name || '未知设备') + '</div>'              // 无
```
数据源是 BLE 广播 Local Name（附近任意设备可控，后端原样回传 `main.rs:4316`）；
`csp:null` + `withGlobalTauri` 使注入脚本可直接调用 72 个后端命令（含 S1 那条提权路径）。
**修复**：`escapeHtml`；同类 `showBleIncompatible`、WSL 加载失败文案一并改 `textContent`。
**状态**：✅ 已修

### S3 错误上报服务零鉴权 + 零限速（`server/error-server.js`、`cloudflare-worker/worker.js`）
`POST /report`、`GET /api/errors` 均无校验；客户端会带 `X-API-Key`，但 **node 版服务端根本不读该头**；
worker 版仅"配置了 key 才校验"（`wrangler.toml` 未配 → 默认放行）；全仓无限速/字段长度上限。
**影响**（前提：按文档部署到公网）：错误上下文（含本地路径）可被任意读取、可无限灌库。
**状态**：✅ 已修（node 版补 key 校验 + 字段长度上限 + 简单令牌桶；worker 版 key 缺失即 401）

### S4 CSP 缺位（`tauri.conf.json:27`）
`csp: null` 使任何 HTML 注入都无第二道防线。
**尝试与结论**：曾设为 `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost`
—— **结果整个界面丢样式**（工具栏竖排、卡片与边框消失）。
机制：Tauri 会往 CSP 中注入自己的 `nonce`，而按 CSP 规范**一旦存在 nonce，`'unsafe-inline'` 即被忽略**，
本应用的内联 `<style>` 与 172 处内联 `onclick` / `style="..."` 全部被拦。这正是项目原本写 `csp: null` 的原因。
**状态**：⏳ **已回滚**（维持 `csp: null`）。前置条件是先做"内联外置"重构（172 处 handler + 内联样式 → 独立 .js/.css），
在那之前不要动 CSP，否则等于把界面弄坏。

---

## 4. 🟠 中等（19）

### 后端
| # | 问题 | 位置 | 状态 |
|---|------|------|------|
| M1 | 工作流动作线程无限期 `lock()` + 阻塞 `write_all` → 设备不排空时该串口永久假死（读线程拿不到锁、后续写命令全超时） | `main.rs` 工作流执行块 | ✅ 已修（改用既有 `lock_port_with_timeout(500)`，两处） |
| M2 | 回调 context 先 `Box::from_raw` 释放、后 `CM_Unregister_Notification` → 窗口内 UAF | `main.rs` device_watcher | ✅ 已修（调换顺序） |
| M3 | `run_output_timeout` spawn 失败与超时都返回 `None`；输出 >64KB 时子进程阻塞在管道 → 必然"超时"且丢输出；usbipd 未装被误判为失败 → 误弹 UAC | `main.rs:906-935` | ⏳ |
| M4 | 三处无界队列：ADB PTY、BLE `notify_buf`、工作流 events（对照：串口缓冲有 256KB 上限） | `main.rs` | ⏳ |
| M5 | BLE 30+ 处 `lock().unwrap()`（中毒后 panic → 前端 invoke 永不 resolve） | `main.rs` BLE 段 | ⏳ |
| M6 | `open_port` 半更新：先拆旧连接再开新口，失败后旧连接也没了 | `main.rs:1100` | ⏳ |
| M7 | 配置非原子写 + 读失败等同"首次运行" → 半截 JSON 导致配置静默全丢 | `main.rs:2895/2909` | ⏳ |
| M8 | 数据面每包 3–4 次分配（`to_vec`/克隆 rules/新建 combined） | `main.rs:405-508` | ⏳ |
| M9 | 错误静默吞：WSL 设备失败表现为"正常但为空"，无法区分无设备与出错 | `main.rs:2402/2337` | ⏳ |

### 前端
| # | 问题 | 位置 | 状态 |
|---|------|------|------|
| M10 | `document.addEventListener('mouseup')` 写在 per-monitor 初始化内且从不解绑 → 每增删监视器泄漏一个监听器 | `index.html` initMonitor | ✅ 已修（改绑 outputEl） |
| M11 | `await` 后无守卫解引用 `monitors[mid]`（与 `closeMonitor` 的 `delete` 并发） | `index.html` startReading | ✅ 已修 |
| M12 | BLE 连接无进行中门闩 → 连点双发；且 `_bleDevices` 每 2s 整体替换，两段 await 后 `dev` 可能是孤儿对象 | `index.html:7274` | ✅ 已修（门闩 + 按地址重新定位） |
| M13 | `_savedOutputHtml` 只写不读（退出 WSL 页时全量序列化最多 10000 行 DOM） | `index.html:6362` | ✅ 已修（删除） |
| M14 | 死代码：`getDemoChars` / `bindMonitorEvents`（58 行重复绑定）/ `decodeData` / `refreshWslDevices` | `index.html` | ✅ 已修（全部删除） |
| M15 | 静默吞错 22 处空 `catch(){}`（失败对用户完全无感） | `index.html` 多处 | ⏳ |
| M16 | WSL 发行版名拼进内联 `onclick` 与 HTML 属性（只转义 `'`，`6264` 完全未转义） | `index.html:6245/6264` | ⏳ |
| M17 | `showBleIncompatible` / usbipd 加载失败文案未转义 | `index.html:6848/7787` | ✅ 已修 |
| M18 | `parseAnsi` 分块边界半截转义序列会**静默丢弃其后全部文本** | `index.html:2215` | ⏳ |
| M19 | 重复工具函数：`bytesToHex` vs `bleBytesToHex`；`hexToBytes`/`hexToLe`/`bleDataVal` 三套 hex 换算 | `index.html` | ⏳ |

### 安全/发布
| # | 问题 | 位置 | 状态 |
|---|------|------|------|
| M20 | 安装器取 `usbipd latest` + WebView2 fwlink，**无版本/哈希固定**，以管理员静默安装 | `installer.iss:165-198/232-244` | ⏳ |
| M21 | `[UninstallDelete]` 递归删整个 `{app}`（用户可自定义目录 → 连带删除）且不清 `%APPDATA%` | `installer.iss:346` | ⏳ |
| M22 | 安装默认改**系统级** PATH（HKLM） | `installer.iss:57/262-291` | ⏳ |
| M23 | CI action 未固定 SHA、`choco`/ADB/`.isl` 下载未校验、构建与发布共享可写 token | `build.yml` | ⏳ |
| M24 | `workflow_dispatch` 用分支名当 tag 建 Release | `build.yml:56-57/91` | ⏳ |
| M25 | 版本号**四处**人工同步、CI 零校验；`package.json` 已漂移到 0.3.0；运行时版本源(Cargo) ≠ 打包版本源(tauri.conf) | 4 文件 + `build.yml` | ✅ 已修（v0.4.0 对齐 5 处，并加 CI 版本一致性断言 + tag 规则） |
| M26 | 自动更新无签名（仅同源 sha256）、`%TEMP%` 落点可被同用户替换 | `main.rs:3487-3692` | ⏳ |
| M27 | Sentry→Issue：签名验证可选、`!==` 非时间安全比较、正文原样拼进 Issue Markdown | `server/sentry-webhook.js` | ⏳ |
| M28 | **重装/升级时 `platform-tools` 必然撞锁**：`adb` 服务器常驻（应用退出后仍在）并映射 `adb.exe`/`AdbWinApi.dll`/`AdbWinUsbApi.dll`；`ignoreversion` 又无条件重写全部 14 个文件 → Inno 重试 4 次后弹「尝试复制下列文件时出错」，同 AppId 升级时旧版卸载器删 `{app}` 同样失败、卸载留残骸 | `installer.iss` `[Files]` + `[Code]` | ✅ 已修（`StopAdbServer` 在 `PrepareToInstall`/`ssInstall`/`usUninstall` 停掉**镜像位于 `{app}\platform-tools` 下**的 adb，只杀自家那条；`ignoreversion` → `replacesameversion`，并补 `restartreplace`/`uninsrestartdelete`） |
| M29 | `CurPageChanged` 用 `TasksList.Items.Count - 1` 取「最后一项」当 usbipd 任务；2026-09 追加 `add_adb_path` 后它指到了 ADB 任务 → 未装 usbipd 时自动勾错对象，usbipd 永远不被勾选 | `installer.iss` `[Code]` | ✅ 已修（显式 `TaskIndexInstallUsbipd` 常量 + 注释约束） |

---

## 5. 🟡 轻微（13，摘要）

| # | 问题 | 位置 | 状态 |
|---|------|------|------|
| L1 | `devtools: true` 实际不生效（release 需 `devtools` feature）；配置表达与实践不符 | `tauri.conf.json:23` | ⏳ 未动（改动无实际收益，维持原样） |
| L2 | `capabilities` 含未使用项（`window:allow-create/set-size/...`、`webview:allow-create-webview-window`） | `capabilities/default.json` | ⏳ 已回滚（收窄本身安全，但需逐功能验证后再改；属全局配置，须先经确认） |
| L3 | 调试日志 `%TEMP%` 无轮转/上限；上报上下文含本地路径与用户名 | `main.rs:16-26/2794` | ⏳ |
| L4 | 错误服务 SQL 全参数化 ✅，但 LIKE 通配未转义、字段无长度上限 | `server`/`worker` | ✅ 已修（长度上限已补） |
| L5 | `.env.example` 无真实密钥 ✅，仅缺 `ERROR_API_KEY` 说明 | `.env.example` | ✅ 已修 |
| L6 | 无测试、CI 无审计、`package.json` 用 `npm install` 而非 `npm ci`、`GIT_COMMIT_HASH` 未注入（发布版显示 dev） | `build.yml` | ⏳ |
| L7 | vendored fork 无 `VENDOR.md`/补丁基线，升级会丢改动 | `vendor/btleplug` | ⏳（见 TODO#5） |
| L8 | 注释谎报：串口退避注释"1ms→2ms"实为恒 2ms；`run_usbipd_list_elevated` 挂着"获取所有串口"的 doc 注释 | `main.rs:408/1492` | ⏳ |
| L9 | `dbg_log` 每行开关文件；`report_js_error` 存在日志注入面 | `main.rs:3785` | ⏳ |
| L10 | 正则缓存 >100 全表 clear → 重新编译抖动 | `main.rs:653` | ⏳ |
| L11 | `(payload.len() as u8)+1` 截断（name 有 ≤29 校验，services/manufacturer 无；可达性待确认） | `main.rs:4222` | ⏳ |
| L12 | `_scrollRaf` 以 elementId 为键，元素删除后条目不清 | `index.html` | ⏳ |
| L13 | `s.uuid` / `data-modes` 等拼进 HTML 属性与内联 JS（UUID 受 OS 约束为 GUID，待确认无自定义路径） | `index.html` | ⏳ |

---

## 6. 跨层检查（本轮新增，非三路报告内容）

| 检查 | 结论 |
|------|------|
| **命令契约**：前端 62 处 `invoke` vs 后端 72 个命令 | ✅ **无"前端调用不存在的命令"**（这类会必崩）；后端 4 个注册了但前端从不调用的死接口：`adb_exec`、`adb_tool_status`、`list_log_cache`、`load_workflows`（`run_usbipd_list_elevated` 实为内部调用，但也多余暴露给前端） |
| **死代码** | 前端 4 个零调用函数（已删）；后端 1 个 doc 注释错挂（L8） |
| **重构残留引用** | ✅ 无（`updateBleSendTarget`/`clearBleWriteTarget`/`ble-sendInput`/`_bleLogs` 等旧名全部清零） |
| **文档漂移** | ✗ `AGENTS.md` 称 main.rs ~1745 行 / 前端 ~4400 行，实际 **4850 / 8563**；且 **0 次提及 BLE/蓝牙/btleplug/vendor**；`TEST_CASES.md` 版本停在 `v0.1.15-dev`、0 条 BLE 用例 |
| **发布状态** | BLE 全部改动在 `v0.3.6` tag **之后**（`9fd993f` 起），即**未发布**；RELEASE_NOTES 无 BLE 段落 |
| **12 套主题变量一致性** | ✅ 逐套脚本比对：`:root` 35 个（含 2 字体变量），另 11 套各 33 个，无遗漏无不一致 |

---

## 7. 已做对的部分（避免"只列问题"的偏差）

- **后端命令级防线扎实且集中**：`install_update` 限定 `%TEMP%\seahi-serial-update` + 扩展名白名单；`download_update` 不信任前端传入的 url/sha256（改用后端缓存）；`save_log` 只允许最近一次选择的目录；`open_url` 弃 `cmd /C` 改 rundll32 + 元字符校验；WSL 统一 `sh_quote`
- **capabilities 极窄**：无 `shell`/`fs`/`http`/`process`/`dialog` 任何插件权限，无 remote-domain IPC
- **无内存边界**：串口缓冲 256KB、BLE 日志 400 行、发送历史 50 条、DOM 双阈值 + 选区保护、`bufferPush` 超 100 万行裁半
- **定时器基本配对清理**；竞态有主动防护（`reading` 门闩、`_wslRefreshing` 单飞、ADB 卡片只绑一次）；ADB 用 xterm 渲染（无 HTML 解析面）
- **锁纪律**：不存在 `MutexGuard` 跨 `await`；锁顺序一致（未发现死锁）；SetupAPI/`sha256` 自实现等 unsafe 核查无误
- **无密钥入库**（`.env.example` 全占位符）、`Cargo.lock` 入库

---

## 8. 修复优先级（剩余项）

> ⚠️ **本轮实践教训（务必遵守）**
> 1. **不要用 GUI 自动化驱动用户正在使用的应用实例**：应用会把窗口尺寸持久化到
>    `%APPDATA%\seahi-serial\config.json`，自动化过程中的 `MoveWindow` 会被保存，导致用户下次启动时
>    窗口尺寸被改（本次已发生并修复：恢复为 1351×1026）。
> 2. **全局配置（`tauri.conf.json` / `capabilities/default.json`）不擅自修改**，先出方案、经确认再动；
>    本次的 CSP 改动即造成了界面样式失效。
> 3. 验证 UI 相关改动时，优先用**无头断言**（`gen_ble_preview.js`）与源码级断言，其次才是截图；
>    必须截图时，事后恢复窗口尺寸与 UI 状态。

1. **M25 / TODO#8 版本发布会话**：4 处版本号对齐 + CI 加一致性断言（防"装着 0.3.6 报 0.3.7"）
2. **L7 / TODO#5 fork 基线**：补 `VENDOR.md`（4 处补丁清单 + 升级步骤），否则下次升级必丢改动
3. **M3**：`run_output_timeout` 区分 spawn 失败/超时、解除管道死锁（当前会误弹 UAC + 丢输出）
4. **M4**：三处无界队列加上限（ADB PTY 最危险，logcat 可达 MB/s）
5. **M16/M18**：WSL 名改 `textContent`+`dataset`；`parseAnsi` 分块边界丢文本
6. **M20/M21/M22**：安装器哈希固定、卸载精确删除、PATH 改可选
7. **M23/M24**：CI action 固定 SHA + 手动触发不建 Release
8. **遗留**：未使用的 `capabilities` 项已收窄；内联 `onclick` 外置（172 处，分批做）
