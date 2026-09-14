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

无 lint 与类型检查；后端有单测（`main.rs` 里的 `#[cfg(test)]` 模块，169 条 + 4 条 `#[ignore]`
真机/诊断）。BLE 从机相关的三条（需蓝牙硬件）：

```bash
# 环境诊断：一次性打全"广播为什么起不来"的证据（适配器/权限/能力位/真实广播结果）
cargo test --manifest-path src-tauri/Cargo.toml ble_periph_diagnose -- --ignored --nocapture
# 已证实：GATT 服务与特征建得出来（任何 Windows 机器都应通过）
cargo test --manifest-path src-tauri/Cargo.toml ble_periph_builds -- --ignored --nocapture
# 未达成：真的在对外广播吗（当前失败，见 doc/BLE_PERIPHERAL.md 第 5 节）
cargo test --manifest-path src-tauri/Cargo.toml ble_periph_starts_advertising -- --ignored --nocapture
```

前端**有**无头断言集 `.walkthrough/gen_ble_preview.js`（当前 1351 条，随代码演进增补；MCP 的 npm 安装器另有
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

## 窗口几何记忆的三条约定（别改回去）

窗口位置/尺寸/最大化由 **Rust 端** `%APPDATA%\seahi-serial\window.json` 统一管（`SavedWindowState`），
详见 `doc/ARCHITECTURE.md` §6.10。三条踩过的坑：

1. **`tauri.conf.json` 的主窗口是 `visible:false`，所以"把窗口显示出来"是一等公民**：任何让初始化
   走不到"页面就绪"的路径都必须能露出窗口 —— 前端 `revealMainWindow()`（`reveal_main_window` 命令）
   在成功、`catch`、`showFatalError` 三处都要调，Rust 端另有 4 秒兜底 `show()`。
   少一处就是"应用启动了但用户看不到窗口"，而且**报错页自己也看不见**。
2. **`config.json` 的 `windowWidth`/`windowHeight` 仍然要写**（`collectConfig`）：MCP 的
   `ui_get_state` 的 `window` 分支读它，同时它是老版本升级上来的迁移兜底
   （`legacy_window_state_from_config_json`，只取尺寸不取位置）。删了就两个功能一起坏。
3. **位置存 `outer_position()`、尺寸存 `inner_size()`**，且非强制的自动保存只在窗口可见时执行、
   最小化/最大化状态下不改写普通几何 —— 这三条各自对应一类真实故障：窗口每次开关往右下漂移、
   启动期隐藏窗口的瞬时尺寸（2068×2060）被写进记录、`-32000` 哨兵坐标污染位置。

## MCP 的十一条关键约定（别改回去）

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
9. **回执那一跳（`mcp_ui_ack`）不许丢字段**：前端的 `notFound` / `invalidParams` 是后端判定
   `-32602`（"参数/路径有问题 → 改参数重试"）还是 `-32006`（"工具跑了但没成 → 先做前置操作"）
   的**唯一依据**。丢一个字段 = 一整类错误码变成错的，而且**两端各自的单测都会是绿的**
   （2026-09 真机检查：`notFound` 就是这么丢的，`unwrap_ui_result` 里那条 `-32602` 分支
   在真机上从未生效）。加字段时三处必须一起改：前端 ack → `mcp_ui_ack` 入参 → `ui_ack_payload`，
   并由 `ui_ack_reply_shape_is_complete` 从 ack 入参**一路测到错误码**。
10. **MCP 的运行不得影响主程序**（用户明确要求的硬约束，不是"尽量"）。落实到代码是这几条：
    ① 串口收发热路径上只有一次**非阻塞**日志旁路（`LogHub::push` 用 `try_lock`，拿不到锁就丢一条并计数；
    全局回收也是 `try_lock` + 单次最多 4 个通道，收不动就等下一条）；② 错误上报走**独立上报线程的
    channel**（`ERROR_SENDER`），Sentry SDK 自己缓冲；③ SSE 出站是「**有界队列 + `try_send`**」——
    生产者绝不 `await`、绝不阻塞，慢客户端直接断开；④ 界面命令有在途上限（32）与超时（5s）；
    ⑤ 工具 panic 由 `catch_unwind` 兜住（见 #2）。
    ⚠️ **加新工具时先问一句"它的输入有上限吗"**：任何接受外部数组/字符串的参数都必须在
    `mcp_limits` 里有对应上限，且校验要发生在**碰主程序之前**。`MAX_UI_SET_ITEMS` 就是教训 ——
    `ui_set` 最终跑在 **WebView 主线程**上，请求体虽有 1 MiB 上限，但一条 item 才 40 多字节，
    1 MiB 能塞两万多条，等于"AI 一句请求把界面冻住几秒"。
11. **每个工具都必须有"返回值契约"和"调用情况"测试**（用户的要求："不然预期的结果怎么确定
    是否已经完成？"）。三条一起才叫测过：
    ① **返回值契约**（`every_tool_has_a_tested_return_contract`）：38 个工具每个都要在表里交代
    清楚 —— 纯后端工具断言**顶层字段**（多一个少一个都要改契约），界面工具断言无界面时
    必须是 `isError` + `-32006`，有副作用的注明谁在管它。表里漏一个工具就 fail，
    所以**新增工具时必须一起想清契约**。三条全局不变量对所有工具生效：
    `structuredContent` 必须是对象、键必须 camelCase、**文本摘要必须真的把数据说出来**
    （只写"N 项"就等于把数据藏起来 —— `serial_list_ports` 的端口名就是这么消失的）。
    ② **调用情况**（`every_ui_tool_sends_the_expected_op_and_returns_expected_shape`）：
    界面工具靠单测专用的假前端（`McpCore::test_ui`）真的调一遍，钉住**发给前端的 op/参数序列**
    与**拿到回执后的返回**（包括 `serial_open/close` 的幂等分支与"点完轮询确认"那段）。
    ③ **跨边界**：断言集里扫 protocol.rs 发出的每个 `op`/`action`，要求 index.html 真有对应分支 ——
    "后端发了、前端没有"会静默失败，而两边各自测自己那一半时全是绿的。
    ⚠️ 假前端只证明 Rust 这一半；前端那一半必须由 `.walkthrough` 用**真实 handler** 跑。两边成对，缺一边就是假的安心。



## 项目结构

- `src/index.html` — 整个前端（单文件，约 10400 行，含 12 套主题变量；串口 / WSL / ADB / 蓝牙 四个面板）
- `src-tauri/src/mcp/` — **MCP 服务器**（模块级，约 5700 行）：`transport.rs`（hyper + SSE + 会话/鉴权/限流/广播）、`protocol.rs`（JSON-RPC + 工具定义与分派）、`bridge.rs`（前端桥：emit + 回执 + 超时回收）、`registry.rs`（控件注册表 → `ctl_*` 工具）、`loghub.rs`（日志中心）、`calllog.rs`（`ai-calls.jsonl`）、`aiconfig.rs`（`ai-config.json`）、`report.rs`（运行期错误 → 程序既有的错误上报通道）、`mod.rs`（启停/生命周期 + 8 个命令）
- `npm/seahi-serial-mcp/` — **MCP 客户端配置安装器**（零依赖 CLI + 62 条自测；`npx seahi-serial-mcp install`）
- `doc/MCP.md` — MCP 使用说明（面向使用者）｜`doc/MCP_TOOLS.md` — **38 个工具的参考手册**（工具名/描述/入参由 `.walkthrough/gen_mcp_tools_doc.js` 从 `protocol.rs` 生成，返回结构是实调抓的）｜`doc/MCP_DESIGN.md` — MCP 设计文档（含每步的实施记录）
- `src-tauri/src/main.rs` — 整个 Rust 后端（约 7700 行，91 个 `#[tauri::command]`）：串口枚举（SetupAPI）、多串口连接/断开、DTR/RTS 切换、收发数据、WSL 端口映射、USB 设备管理、ADB 会话、**快速指令外部文件（导入/导出/写回，见 `quick_cmds_*`）**、**BLE 主机（btleplug，代码在 `fn main()` 内）与 BLE 从机（WinRT `GattServiceProvider`，代码在模块级）**
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

> ⚠️ **改完版本号必须重新编译发布产物**：主程序版本来自 `env!("CARGO_PKG_VERSION")`，是**编译期烘焙**进
> exe 的 —— 只改文件、不重编，`src-tauri/target/release/seahi-serial.exe` 里仍是旧版本号（2026-09 真实
> 事故：安装包文件名/产品版本 0.5.0，装出来的应用却是 0.4.0）。本地打安装包前先 `npm run build`
> （或 `cargo build --release --manifest-path src-tauri/Cargo.toml`）；`installer.iss` 顶部已有 ISPP
> 编译期守卫（主程序 exe 版本 ≠ `MyAppVersion` 直接 `#error`），并会用 `#pragma message` 打印实际版本。

## 关键约定

- Release 构建通过 `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` 隐藏控制台窗口
- 串口友好名称直接调用 Win32 SetupAPI（UTF-16），避免 `serialport` crate 读取中文设备名时乱码（U+FFFD）
- 前端通过 `withGlobalTauri: true` 与 Rust 通信，无 npm 桥接包
- CSP 设为 `null`，无内容安全限制
- **release 构建不带 DevTools**（用户要求）。真正的开关是 **tauri 的 `devtools` cargo feature 必须保持关闭**：`tauri-runtime-wry` 里那段 `with_devtools(..)` 被 `#[cfg(any(debug_assertions, feature = "devtools"))]` 整个门控，所以 release（`debug_assertions` 关闭）只要不开这个 feature，那段代码根本不编译，落到 wry 自己的默认值 `false`。**debug 构建仍然有 DevTools**（内存分析要靠它）。⚠️ `tauri.conf.json` 里的 `devtools` 字段是**死配置** —— tauri 2.11.2 / codegen / build 里没有任何代码读它（逐个 crate 搜过），写了也不生效，只会让人误判，**别再加回去**（断言集里两条守着）
- 磁盘上的程序名为 `seahi-serial.exe`（带连字符）；Rust 包名为 `seahi_serial`（带下划线）
- **`platform-tools` 会被自家 adb 服务器锁住，安装器必须先停掉服务器**：`adb` 启动的服务是常驻后台进程（应用退出后依然活着，直到 `adb kill-server` 或注销），它把 `{app}\platform-tools` 下的 `adb.exe`、`AdbWinApi.dll`、`AdbWinUsbApi.dll` 全部映射住 —— 运行中的 .exe 无法就地覆写，已加载的 DLL 连删除都不允许。所以重复安装/升级会重试 4 次后弹「尝试复制下列文件时出错」，同 AppId 升级时旧版卸载器也删不掉 `{app}`。`installer.iss` 的 `StopAdbServer` 在 `PrepareToInstall` / `ssInstall` / `usUninstall` 三处**只结束镜像路径位于本应用 `platform-tools` 下**的 adb（别误伤 Android Studio 等其它来源）；`[Files]` 用 `replacesameversion`（不是 `ignoreversion`）+ `restartreplace`/`uninsrestartdelete` 兜底。注意 `adb.exe`/`fastboot.exe` **没有版本信息**，按 Inno 规则每次安装仍会覆写它们，靠的就是先停服务器
- 设备插拔检测使用 `CM_Register_Notification`（windows-sys crate），触发 `device-changed` 事件
- **快速指令的外部文件：路径只认"用户在原生框里亲手选过"的**（`save_log` / BLE 从机配置同一套纪律）。
  `quick_cmds_pick_file` / `quick_cmds_export_file` 弹原生框并把路径记进**后端自己的**
  `%APPDATA%\seahi-serial\quick-cmds-files.json`（LRU 上限 50，前端碰不到这张表）；`quick_cmds_read_file` /
  `quick_cmds_write_file` **只接受表里的路径** —— 绝不能让前端传任意路径进来，那等于给本机任意进程一个
  文件读写原语（MCP 工具也不接受路径，只操作界面）。另外三条同样别改回去：**写回是原子的**（临时文件 +
  rename）、**写回前比对内容哈希**（文件被别的编辑器改过就报冲突，不静默覆盖；**只有成功读过一次、
  手里有哈希的挂载才允许写回** —— 没有基线就拒写，两端各拦一道）、**沿用读入时的编码**
  （UTF-8/BOM → 失败回退 GBK，别把用户的 GBK 文件写成乱码）。前端一侧：文件即存储，增删改都写回
  （去抖 600ms）；解析**绝不按逗号切分**（AT 指令里逗号是常态）；注释与额外列按原位置保留（块序列），
  别用"读进列表再重新生成一份"的做法；**文件头（YAML `---` / TOML `+++` front matter）原样保留但不解释**
  —— 不识别它的话 `baud: 115200` 会被当成一条指令读进来、写回时还会被转成表格行（实测踩过）；
  `baud`/`mode`/`lineEnding`/`delay`/`expect`/`timeout`/`hex` 这些 key 要提示"暂不生效"，别做静默 no-op。
  另有两条同属"别改回去"：**每条指令的 `seq`/`delay`/`hex`（顺序号/延时/HEX 使能）只认"表头声明了列名"
  的列** —— 表头写了 `顺序号 / 延时(ms) / HEX` 才读进来、才写回同一列；**没有这些列的文件一律按老规矩**
  （第 3 列起是用户的备注，原样保留），绝不按列号硬塞（那会把用户写在第 3 列的「备注甲」读成顺序号、
  再改写成 `0`，真丢数据）；**写回挂载文件不擅自补列**（用户的表结构由用户定），
  需要自包含的三列文件走「导出」——导出的是副本，一律补全这三列（纯指令行载体放不下就升级成
  Markdown 表格并提示；**导出物不带「名称」列**，面板里没有名称入口，文件就该与面板一一对应）。
  以及**整行都空的条目不写回文件**（写进去也活不过一次重载：解析端把空行当结构行丢掉；
  但表头声明了 顺序号/延时/HEX 的文件里，"还没填内容、参数格有值"的行**必须留着** ——
  跳掉它，导出/写回的条数就跟面板对不上了）。用户没填过的参数格写回时**保持空格**
  （别把缺省值硬写进他的表）。
  另一个"别改回去"（2026-09 加的循环组）：**一组一张表、循环顺序 = 组的上下顺序 → 组内顺序号**，
  组的上下顺序**靠拖抬头调整**（拖到最上面的那组就是循环起点），组名可重命名、可折叠，
  首次启动默认 1 组、新建组默认 1 条空指令、**最后一组删不掉**；每条指令自己的配置（顺序号/延时/HEX）不变。
  文件里用 `## 组名` 抬头分隔各组（**两个及以上 `#`**；单个 `#` 仍是注释）；导出（副本）一定写抬头，
  写回挂载文件时只有一组不写（不擅自改用户结构）。面板里**每组自带一份列标题**（抬头 → 列标题 → 数据行），
  共用一份会夹在抬头与数据行之间、读起来是断的（用户 2026-09 指出的）。
  ⚠️ **改了文件格式/列名/上限/写回规则，必须同步 `doc/QUICK_CMDS.md`**（面向使用者的那份格式说明；断言里有 7 条守着它别烂掉）。
  循环发送的开关状态**不持久化**（开机自动发指令太危险），
  掉线/关监视器/列表里再无可发条目时必须**自愈停止**并提示。
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
