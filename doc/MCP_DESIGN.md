# SeaHi Serial MCP 功能设计方案

> 版本: v0.1（草案，待评审） | 目标版本: v0.5.0 | 最后更新: 2026-09-13
>
> 本文是**设计文档**，不是使用说明。落地进度与实测结论请追加到文末"实施记录"。

---

## 1. 需求与设计项映射

| # | 你的原话 | 设计项 | 章节 |
|---|---|---|---|
| R1 | 程序的所有可操控的按钮、输入框、选择框、界面风格等都做成 MCP 工具供 AI 使用 | 控件注册表 + 自动生成工具；分层暴露 | §5 |
| R2 | 最终的所有日志内容，也需要设计相应的工具 | 后端统一日志中心 + 日志工具/资源 | §7 |
| R3 | 切换页面等等 | 页面/视图切换本身也是注册表条目 | §5.3 |
| R4 | 工具的操作需要与前端同步，比如工具选择了端口，程序的显示也应该有所反应 | 工具→界面：合成 DOM 事件 + 回执；界面→工具：状态变更通知 | §6 |
| R5 | 操作记录不计入用户配置文件，而是 AI 配置文件中，用来记录工具的调用记录 | `ai-config.json` + `ai-calls.jsonl`，与 `config.json` 完全隔离 | §8 |
| R6 | MCP 服务器应该随着程序的启动而运行 | 进程内启动，挂在 Tauri `setup()`，失败不影响主功能 | §4.4 |
| R7 | 只采用 SSE 模式启动 | 传输层只做 SSE 形态；不开 stdio | §4 |

**非目标**（本期不做）：stdio 传输、把应用做成远程可访问的服务、公网/局域网监听、多用户并发、AI 直接读写用户任意磁盘文件。

---

## 2. 现状勘察（设计的事实基础）

### 2.1 关键事实与代码位置

| 事实 | 位置 | 对设计的意义 |
|---|---|---|
| 前端有**唯一**的 invoke 包装 `const invoke = _safeInvoke` | `src/index.html` L2287 | 所有前端→后端的调用都过这一个点，天然适合做审计与日志回灌 |
| 前端有完整的状态序列化器 `collectConfig()` | L5334 | 直接就是 `ui_get_state` 的返回值来源，无需另写状态收集 |
| 前端有完整的状态恢复器 `loadAndApplyConfig()` | L5756 | `ui_apply_state` 的基础 |
| 配置保存是**前端拼 JSON 交给后端存**：`invoke('save_config', { configJson })`，500ms 防抖 | L5610 `scheduleConfigSave()` | 后端只是哑存储 ⇒ AI 记录走独立命令/文件即可，不会污染用户配置 |
| 恢复期间有 `_loadingConfig` 闸门跳过保存 | L5611 | 回声抑制可以复用同样的闸门思路 |
| 退出前保存靠后端发 `save-before-exit` 事件 | L10353 | AI 配置的收尾落盘也应挂到这里 |
| 现有事件仅 4 个：`device-changed` / `wsl-status-changed` / `ble-pair-request` / `save-before-exit` | L6136, L10314, L10320, L10353 | 事件面很干净，新增 `mcp-*` 系列不会冲突 |
| 后端 85 个 `#[tauri::command]`，全部通过 `.manage()` 持有状态 | `src-tauri/src/main.rs` | 工具目录的第 2 层直接映射这些命令 |
| 配置 schema 已经版本化（`"version": 2`），并有 `extraCount` 这类迁移字段 | 实测 `config.json` | AI 配置同样从 `version: 1` 起步，预留迁移 |
| 依赖树里 **`hyper 1.10.1` / `http 1.4.1` / `http-body 1.0.1` / `tower 0.5.3` / `tokio 1.53.1(net+rt)` / `socket2` / `mio` 已存在**（由 reqwest 带入） | `src-tauri/Cargo.lock` | 加 HTTP 服务器的边际成本很低，不会引入第二套网络栈 |


### 2.2 前端规模实测（v0.4.1）

| 项 | 实测值 | 说明 |
|---|---|---|
| `src/index.html` | **10610 行 / 590849 字节** | 单文件，含内联 `<style>` 1 块、`<script>` 2 块 |
| `<button>` | 78 | 静态标签 |
| `<input>` | 31 | 静态标签 |
| `<select>` / `<textarea>` / `<option>` | 4 / 1 / 11 | |
| **静态可交互标签合计** | **≈114** | 上四项之和（`<option>` 归入其 `<select>`） |
| `onclick=` 出现次数 | **196** | `AGENTS.md` 里写的是 172 处内联 `onclick`（口径可能只数了元素属性），两者都在同一量级 |
| `oninput=` / `onchange=` | 21 | 输入型控件的绑定 |
| `addEventListener(` | 59 | 动态绑定/DOM 级监听 |
| `id="` | 182 | 稳定锚点数量可观，自动推导路径可行性高 |
| `data-*` 属性 | 77 | 已有一批 `data-val` 之类，可直接复用为 `data-mcp` 之外的线索 |
| CSS 变量 `--x:` | 398 | 12 套主题的实现基础 |

#### 权威统计（逐段通读全文后，来自 `.walkthrough/mcp_inv_frontend.md`）

> 上面那张表是"数标签"的近似值；下表是逐段读完 10610 行后的权威口径——**可交互元素**不只 `<button>/<input>`，还有大量 `div[onclick]`/`span[onclick]`。

| 项 | 权威统计 | 备注 |
|---|---|---|
| **可交互标签总数** | **230** | button 78 + input 30（text16/number4/checkbox10）+ select 4 + textarea 1 + **div[onclick] 102** + **span[onclick] 15** |
| **带 `id`** | **83（36.1%）** | 39 个字面量 id + 44 个 `{mid}-` 模板 id（`mid ∈ main/extra-N/wsl/wsl-xN/ble-mon`，可预测） |
| **无 `id`** | **147（63.9%）** | 8 个靠 `name`、60 个靠 `data-*`、**77 个 class-only（同容器内重复出现，无法唯一定位）**、2 个裸标签 |
| 内联事件 | **230** | `onclick` 196 / `onchange` 13 / `oninput` 8 / 其余 mouse·key 类 |
| `addEventListener(` | 59 | 内联 : addEventListener ≈ **3.9 : 1** |
| **运行时换绑** `setAttribute('onclick',…)` | **13** | ⇒ **静态扫描得到的 handler ≠ 运行时 handler** |
| 可切换视图 | **26 类** | 4 顶层面板 + 子视图（高级设置/工作流/工具栏折叠/终端模式/内嵌监视器/主机·从机模式/2 个拖拽条）+ 9 个下拉抽屉 + 6 个模态浮层 |
| 主题 | 12 套 = 6 风格 × 深浅 | 源码只声明 11 个 `[data-theme]` 块，第 12 套是 `:root`（`default` 深色**不设属性**） |
| CSS 变量 | 35 个（`:root`） | 命名 `--<域>-<修饰>`（`-b/-d/-h/-a/-p`）；ANSI 色**不走变量**，每主题写 16 条 `.ansi-N` |
| 字号 / 密度 / 缩放 | **不存在** | `html,body` 固定 `font-size:14px`；xterm 硬编码 `fontSize:13`。**需新增才能暴露**（见 §13 D8） |
| `input[type=radio\|range\|file\|color]` | **全为 0** | 选文件一律走后端 `rfd` 原生对话框（⇒ "选文件"类工具必须走原生对话框，无法静默） |
| JS `createElement` 造的控件家族 | input×3 / button×2 / textarea×1 / div×28 / span×7 / option×1 | **运行且面板打开后才存在** |

**对设计的直接结论：只有 36.1% 的控件有稳定 `id`，所以"靠选择器寻址"这条路走不通** —— 必须在 boot 时**注入自己的锚点**（§5.4）。

**⚠️ 关键发现：实际控件面远大于 114。** 监视器分栏是**按需克隆**的（`mid + '-portSelect'`、`mid + '-baudRate'`…每多一个"额外监视器"就多一整套控件，`mid` 为 `extra-1`、`extra-2`…），蓝牙的服务树/特征编辑器/已保存配置列表、ADB 设备列表、WSL 设备列表也都是渲染函数动态生成的。

对设计的三点影响：

1. **注册表必须是动态的**：条目要支持"前缀 + 工厂"注册，`el()` 延迟解析（§5.3 第 3 层）。
2. **`ctl_*` 工具数量随界面状态变化**，不能当成静态清单——需要在打开/关闭面板、增删监视器时发 `notifications/tools/list_changed`（§4.6）。
3. **`ui_list` + `ui_describe` 才是可靠入口**：AI 应先枚举当前真实存在的控件，而不是依赖一份可能过期的工具清单。这也是 D2 建议"默认只开 A+B"的另一个理由。

### 2.3 磁盘上真实的用户配置（实测）

路径 `%APPDATA%\seahi-serial\config.json`，1774 字节，顶层字段：

```
version, extraCount, wslExtraCount, monitors{main,wsl,extra-N}.{port,baud,lineEnding,viewMode,
sendAs,dataBits,stopBits,parity,dtr,rts,advOpen,btnScroll,btnAutoReconnect,btnSendLE,btnTs,
btnEcho,btnLineNum,quickCmds[],sendHistory[],panelHeight,workflows[]},
logDir, wslAutoMap, theme, themeStyle, windowWidth, windowHeight,
ble.{monitor,monitorWidth,monitorCfg,openSvcs,advOpen,filterText,filterOpen,selected,mode,
     periph{...}, scanSecs, periphSaved}
```

**结论**：`config.json` 是"用户的设置"，语义上只应由用户操作产生。MCP 的调用记录必须写到**另一个文件**（§8）。但 AI 通过工具改掉的界面状态**仍然照常持久化**——否则用户下次启动会看到界面"反弹"，反而更困惑；"谁改的"这件事记录在 AI 配置里（§8.5 有决策点）。

### 2.4 后端事实（实测，来自 `.walkthrough/mcp_inv_backend.md`）

| 项 | 实测 | 对 MCP 的意义 |
|---|---|---|
| `main.rs` | **7045 行** | 再加 MCP（2500~3500 行）必须拆模块（§3.1） |
| `#[tauri::command]` | 标记 **87**，实际注册 **85**（`list_ports` 双平台实现；`run_usbipd_list_elevated` 带宏但未注册进 handler） | B 层语义工具的上限参考 |
| 前端实际调用 | **80 / 85** | |
| **前端零调用的 5 个命令** | `list_log_cache`、`load_workflows`、`adb_tool_status`、**`adb_shell`**、**`adb_exec`** | 🔎 **白捡的 MCP 入口**：`adb_shell`/`adb_exec` 连界面都从没暴露过，MCP 一接就是**新能力**；`list_log_cache` 正好给 §7 的 `session-cache` 通道用。**不需要改任何现有代码** |
| 命令分类 | 纯读 **17** / 改后端状态 **7** / 有外部副作用 **61** | 那 61 个必须过 §9 的策略闸门 |
| 阻塞性质 | 约 **48** 条；21 条已移出主线程，**仍会阻塞命令线程**的有 `open_port`、`close_port`、`set_dtr/rts`、`check_workflow_matches`（含**无上限** `delay_before` sleep）、3 个原生对话框命令、`save_config`/`load_config`/`backup_config`/`save_log`/`append_log_cache`/`end_log_cache`、`launch_wsl`(≤5s)、`install_update`、`open_url`、`set_title_bar_color` | **MCP 工具处理器绝不能直接 await 这些**，一律 `spawn_blocking`，否则会卡住 SSE 服务乃至整个运行时 |
| **4 条"async 但内部同步阻塞"** | `adb_tool_status`(5s)、`adb_devices`(5s)、`adb_shell`(10s)、`adb_exec`(15s) | 签名是 `async fn` 但内部是阻塞实现，最容易被误用 —— 必须同样 `spawn_blocking` |
| 配置路径 | `dirs_config_path()` L2990 —— **直接读 `APPDATA` 环境变量**（没用 `dirs` crate，也没用 Tauri `app_config_dir()`），非 Windows 走 `HOME/.config` | AI 配置必须用**同一个函数**拼路径，别自己拼一套 |
| 配置读写 | `save_config`/`load_config`/`backup_config`，后端**完全不解析 JSON**（纯字符串进出） | 用户配置的 schema 由前端 `collectConfig()` 定义；**AI 配置反过来应由 Rust 侧定义 schema**（它没有前端这个"作者"） |
| ⚠️ 配置写入 | **无锁、无原子替换、无 fsync**，裸 `fs::write` 覆盖（崩溃可留截断文件） | `ai-config.json` **必须**用临时文件 + rename（§8.1），不要复制这个坏榜样 |
| 事件通道 | **仅 4 个**：`device-changed`(null)、`wsl-status-changed`(bool)、`ble-pair-request`({address,kind,pin})、`save-before-exit`(null) | 新增 `mcp-*` 系列不冲突 |
| **高频数据不走事件** | 串口/BLE/ADB/WSL 全部是**前端轮询命令**取走：`read_data`、`ble_poll_notifications`(~250ms)、`ble_periph_poll_events`(~500ms)、`adb_shell_read`、`read_wsl_serial`… | ⚠️ **关键约束**：这是"单消费者队列"，MCP 若也去取就**抢走界面的数据**。见 §7.0 |
| `CM_Register_Notification` | 只监听 **GUID_DEVCLASS_PORTS**（COM 类），payload 是 `null`；**BLE 插拔没有任何原生通知** | BLE 上下线只能靠扫描/轮询发现 |
| 托管状态 | `.manage()` **8 个**（`PortState`/`WslSerialState`/`AdbPtyState`/`WorkflowState`/`LogCacheState`/`BleState`/`BlePairState`/`BlePeripheralState`）+ **11 个模块级 static**（`ERROR_SENDER`、`LAST_LOG_DIR`、`WSL_WATCHER_STOP`…） | MCP 拿 `AppHandle` 即可访问托管状态；模块级 static 要谨慎 |
| 进程内监听端口 | **0 个**（无 `TcpListener`、无 HTTP server、无监听 named pipe） | ✅ 加 MCP SSE **无端口冲突** |
| 需避开的端口 | **3000**（两个 Node 错误服务默认同端口）、**19876**（`wsl-daemon/seahi_serial_daemon.py` 绑 `0.0.0.0:19876`，**已是死代码**，main.rs 只内嵌 `bridge_b64.txt` 从未引用它） | 默认端口别选这两个 |
| 启动 | `fn main()` L6026：`init_error_reporter` → `set_panic_hook` → 可选 Sentry → `Builder` → **8× `.manage()`** → `.invoke_handler(85)` → **`.setup()`**（`start_device_watcher` + `set_min_size` + `start_wsl_watcher`） | MCP 挂在 `.setup()` 内、`start_wsl_watcher` **之后**（8 个状态已全部注册） |
| 退出清理 | **只有 `on_window_event(CloseRequested)`**（L6983-7042）；**没有 `RunEvent::Exit`/`ExitRequested`**；`install_update` 用 `process::exit(0)` **绕过全部清理** | MCP 要在 `CloseRequested` 序列里优雅关闭；并**补 `RunEvent::Exit`**；`install_update` 这条路要么蹭它的 600ms 落盘窗口，要么接受"最后一次统计可能丢" |

---

## 3. 总体架构

```
┌──────────────────────────────────────────────────────────────────────┐
│  AI 客户端 (Claude / Cursor / 任意 MCP host)                          │
└───────────────┬──────────────────────────────────────────────────────┘
                │  SSE (HTTP/1.1, 仅 127.0.0.1)
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  seahi-serial.exe (单进程)                                            │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ McpServer  (axum, 独立 tokio task)                             │  │
│  │  GET /sse            → 建立 SSE 流 + 下发 endpoint              │  │
│  │  POST /messages      → 收 JSON-RPC，202 受理，回包走 SSE 流     │  │
│  │  POST /mcp           → Streamable HTTP（兼容新客户端，可选）    │  │
│  │  SessionRegistry · ToolRouter · CallLog · RateLimiter          │  │
│  └───────┬──────────────────────────────┬─────────────────────────┘  │
│          │ ①直连后端能力                 │ ②经前端桥                  │
│          ▼                              ▼                            │
│  ┌──────────────────┐        ┌──────────────────────────────────┐   │
│  │ 现有 #[command]  │        │ UiBridge                          │   │
│  │ 串口/BLE/ADB/WSL │        │  emit("mcp-ui-cmd") → 前端执行     │   │
│  │ LogHub 环形缓冲  │        │  invoke("mcp_ui_ack") ← 前端回执   │   │
│  └──────────────────┘        └────────────┬─────────────────────┘   │
│                                            │ Tauri event             │
│  ┌─────────────────────────────────────────▼─────────────────────┐   │
│  │ WebView2 前端 (src/index.html)                                 │   │
│  │  控件注册表 ControlRegistry (path → 元素 + read/write)          │   │
│  │  执行 = 合成 DOM 事件（click / input / change）                 │   │
│  │  现有 inline onclick / 事件逻辑 → 原样复用，界面自然同步        │   │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

**三条数据通道，职责不重叠：**

| 通道 | 用途 | 同步性 |
|---|---|---|
| ① 工具 → 后端命令 | 查询/驱动真实能力（枚举串口、连 BLE、查日志） | 同步、直接返回 |
| ② 工具 → 前端桥 | 任何"界面上的东西"（选端口、切主题、切页面、点按钮） | 请求/回执，带超时 |
| ③ 前端 → 服务端事件 | 状态变更通知、日志回灌、AI 连接状态 | 异步通知 |

> **为什么不用通用的桌面自动化 MCP**（如 `desktop-operator`，见 `doc/USER_RESEARCH_HEURISTIC_WALKTHROUGH.md` L285）：那种方案靠截图+坐标点击，脆弱、拿不到内部状态、读不到日志、也无法知道"这个按钮现在为什么是灰的"。本方案是在进程内做**语义化**暴露。

### 3.1 代码组织（需要破一次既有约定）

`AGENTS.md` 的约定是"后端为单个 Rust 文件"，`main.rs` 现在已经 7000 行。MCP 子系统预计再加 **2500~3500 行**（HTTP/SSE + 路由 + 注册表服务端 + LogHub + AI 配置 + 调用记录），全塞进 `main.rs` 会到 10000 行以上，后续维护成本不可接受。

**建议**：`main.rs` 保持为入口与现有逻辑，新增模块目录，由 `main.rs` 顶部 `mod` 声明：

```
src-tauri/src/
├── main.rs              # 入口 + 现有串口/WSL/ADB/BLE 逻辑（不动）
└── mcp/
    ├── mod.rs           # 启动/关闭、把各块拼起来
    ├── transport.rs     # axum 路由、SSE 流、会话、token 鉴权、限流
    ├── protocol.rs      # JSON-RPC 编解码、错误码、initialize/tools/resources 分派
    ├── registry.rs      # 控件注册表的服务端视图 + ctl_* 工具生成/命名
    ├── bridge.rs        # UiBridge：emit + oneshot 回执 + 超时
    ├── tools.rs         # B 层语义工具（按面板分文件亦可）
    ├── loghub.rs        # 日志中心（通道/环形缓冲/seq/订阅）
    └── aiconfig.rs      # ai-config.json + ai-calls.jsonl + 统计
```

前端侧新增（都在 `src/index.html` 内，与现有代码风格一致）：
`MCP_CONTROL_META`（手工元数据表）、`mcpControlRegistry`（注册表）、`mcpOnUiCmd`（执行+回执）、`mcpNotifyState`（状态变更通知）、`mcpRenderPanel`（MCP 面板）。

> 这需要同步更新 `AGENTS.md` 的"单个 Rust 文件"描述与目录结构段（历史上已因 BLE 做过一次同类修正）。

### 3.2 一次典型调用的完整时序

以"AI 选中 COM3、打开串口、发一条 AT、读回显"为例：

```
AI → POST /messages?sessionId=s1&token=…   {"jsonrpc":"2.0","id":7,"method":"tools/call",
                                            "params":{"name":"serial_open",
                                                      "arguments":{"monitor":"main","port":"COM3","baud":115200}}}
server → 202 Accepted（不算结果，结果走 SSE）
server → policy 检查：serial_open 属危险工具 → confirm
server → emit("mcp-confirm", {id:77, tool:"serial_open", args:{…}})
前端 → 弹窗「AI 想打开 COM3@115200，允许？」   ← 用户点"允许"
前端 → invoke("mcp_confirm_ack", {id:77, allow:true})
server → ① 前端桥：emit("mcp-ui-cmd", {cmdId:12, op:"set", path:"serial.conn.portSelect", value:"COM3"})
         前端执行 el.value="COM3" + 派发 change → 现有逻辑更新 monitors.main.portName
         前端 → invoke("mcp_ui_ack", {cmdId:12, ok:true, value:"COM3"})
       → ② 后端命令：open_port{…}（现有 85 个命令之一）
       → ③ LogHub 记一行 channel="app"
server → SSE: event: message
              data: {"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text",
                     "text":"已打开 COM3 @115200（界面已同步）"}],
                     "structuredContent":{"port":"COM3","baud":115200,"monitor":"main"}}}
server → 写 ai-calls.jsonl：{seq, ts, tool:"serial_open", ok:true, durationMs:143,
                             effects:[{path:"serial.conn.portSelect",from:"COM1",to:"COM3"}]}
server → notifications/resources/updated {uri:"ui://state"}

AI → tools/call serial_send {monitor:"main", data:"AT", lineEnding:"crlf"}
   → 后端写串口 → 设备回 "OK\r\n" → LogHub channel="serial:main:rx"
   → notifications/message {level:"info", logger:"serial.main", data:"← OK\r\n"}
AI → tools/call log_tail {channel:"serial:main:rx", lines:20}   → 拿到回显
```


---

### 3.3 依赖与组件选型（新增什么、不新增什么）

**一句话：后端只新增 3 个直接依赖（`hyper` / `hyper-util` / `http-body-util`，全部已在依赖树里），前端新增 0 个 npm 包，不需要 Python，也不新增任何服务或进程。**

> ⚠️ **落地时的偏离（2026-09-13）**：本节原计划用 **`axum`**，但开发环境里 **cargo 无法联网**
> （`curl failed ... SEC_E_NO_CREDENTIALS`），而 `axum` 不在本地 cargo 缓存中，**取不到**。
> 好在 `hyper 1.10.1` / `hyper-util 0.1.20` / `http-body-util 0.1.3` / `tokio` / `tower` / `bytes`
> 早就由 `reqwest` 带进依赖树且都在缓存里，于是**改用 hyper 直接实现**：路由与 SSE 分帧自己写，
> chunked / keep-alive / 请求解析仍交给 hyper。
>
> **取舍**：新增直接依赖从 1 个（axum）变成 3 个（hyper 一族，但全都已编译过、不新增下载与编译量）；
> 代价是路由与 SSE 分帧要自己维护（约 300 行）。**你可以选择保持现状**（已验证可用、零新增下载），
> 或等有网络时换回 axum —— 协议层（`protocol.rs`）与传输层已完全解耦，替换 `transport.rs` 即可。

#### 后端（Rust）

| 角色 | 用什么 | 状态 |
|---|---|---|
| HTTP + SSE 服务器 | **`hyper` 1.x + `hyper-util` + `http-body-util`**（原计划 `axum`，见上方偏离说明） | 🆕 三个直接依赖，**但都已在依赖树里**（reqwest 带入），无新增下载 |
| 异步运行时 | `tokio`（Tauri 内部本就在用） | 已有，需**加 feature**：现只有 `["time"]`，要补 `rt`/`net`/`sync`/`macros`。reqwest 已间接启用 `net`/`rt`，**不增加编译量** |
| SSE 流桥接 | `tokio-stream`（把 mpsc/broadcast 接收端变成 `Stream`） | 已在依赖树里（0.1.19）；声明为直接依赖即零成本。也可不用它，改用 `futures::stream::unfold` |
| JSON / JSON-RPC | `serde` + `serde_json` | 已有 |
| token 生成 | `uuid` v4（已有）或 `rand`（已在树里 0.8.7） | 已有，无需新增 |
| 时间戳 | `chrono` | 已有 |
| Stream 类型 | `futures` 0.3 | 已有 |
| 日志 / 错误上报 | 复用现有 `dbg_log()` + `report_error()` | 已有 |

**加 `axum` 真正新增的子树很小**（拿 `Cargo.lock` 逐条对照过）：只有 **`axum` + `axum-core` + `matchit` + `serde_path_to_error`**（约 4 个）；而它依赖的 `hyper 1.10.1` / `hyper-util 0.1.20` / `http 1.4.1` / `http-body-util 0.1.3` / `tower 0.5.3` / `tower-layer` / `tower-service` / `bytes` / `mio` / `socket2` / `sync_wrapper` **全都已经在树里**（由 `reqwest` 带入）。这就是"加 HTTP 服务器边际成本低"的实测依据；版本也都是 axum 0.8 要求的（hyper 1.x + tower 0.5 + http 1.x），**不会出现同 crate 两份版本**。

**实际落地时写入 `Cargo.toml` 的内容**：

```toml
# 新增：hyper 一族（都已在依赖树里，不新增下载；axum 取不到）
hyper = { version = "1", features = ["http1", "server"] }
hyper-util = { version = "0.1", features = ["tokio"] }
http-body-util = "0.1"
bytes = "1"
# 修改：原来只有 ["time"]；刻意不开 macros（tokio-macros 不在本地缓存）
tokio = { version = "1", features = ["time", "rt", "net", "sync", "io-util"] }
```

> 若换回 `axum`：`axum = { version = "0.8", default-features = false, features = ["http1", "json", "tokio", "query"] }`，
> 并给 tokio 补 `macros`（需要能联网下载 `tokio-macros`）。

> `default-features = false` 是为了不带进 `tower-log`/`tracing` 那套用不上的东西；注意 `tokio` feature 仍要保留（`axum::serve` 的优雅关闭依赖它）。

**为什么选 axum：**

| 方案 | 评价 |
|---|---|
| **`axum`（选它）** | 自带 `Sse` 响应类型 + KeepAlive、路由、优雅关闭；依赖基本已在树里；自己写的代码最少、最容易对 |
| `hyper` 直接用 | 依赖已在树里，但要自己写路由、SSE 分帧、keep-alive，容易在 chunked 编码与半关闭上出错 |
| `tiny_http` / `rouille`（阻塞式） | 会再引入一套独立 HTTP 实现；SSE 长连接需要"每连接一线程"，与 Tauri 的 tokio 运行时混用别扭 |
| 纯 `TcpListener` 手写 HTTP/1.1 | 本仓库确实偏爱手写（SetupAPI、WinRT 都是），但 SSE + keep-alive + 请求解析的边角很容易错，不值得 |

#### 前端

| 项 | 结论 |
|---|---|
| npm 包 | **0 个新增**。`package.json` 现在只有 devDependency `@tauri-apps/cli`，MCP 不需要任何运行时包（**应用侧恒为 0**；另有一个独立的安装器包，见 §3.5，**不进入应用的依赖图与构建**） |
| 控件注册表 / 桥 / 弹窗 | 全部是 `src/index.html` 里的原生 JS，与现有风格一致（无框架、无构建步骤、无打包器） |
| 剪贴板 | `navigator.clipboard.writeText`，失败回退仓库已有的 `fallbackCopy`（`index.html:4197`），不用库 |
| 与 MCP 服务器通信 | **前端不直连 HTTP**：不需要 `EventSource`，也不需要 Tauri http 插件权限。服务端通过 Tauri `emit` 找前端，前端用 `invoke` 回执 |
| 图标 | 内联 SVG（**图形源不留在仓库**：本体就是 index.html 里那段内联 SVG） |

> 因此 **`src-tauri/capabilities/default.json` 不用改**：MCP 逻辑全在 Rust 侧，前端没有新增任何跨进程能力需求。

#### Python / 其他

| 项 | 结论 |
|---|---|
| Python | **完全不需要**。仓库里的 Python 只有 WSL bridge（`src-tauri/wsl-daemon/*.py`，base64 内嵌），与 MCP 无关 |
| 端到端测试 | 用 **Node 脚本**（与现有 `.walkthrough/gen_ble_preview.js` 一致），**不需要 npm 依赖**：SSE 用 Node 内置 `http` 手写、或对 Streamable HTTP 端点用 `fetch` 读流。Rust 侧单测沿用 `cargo test` |
| 新增构建步骤 | **无**。不引入前端打包器；CI 在现有 `cargo test` + node 断言脚本上各加几步即可 |
| 新增服务 / 进程 | **无**。MCP 服务器跑在 `seahi-serial.exe` 进程内（这正是"随程序启动而运行"的实现方式），不额外起 Node/Python 守护进程 |

**供应链影响**：直接依赖 +1，传递依赖约 +4，`Cargo.lock` 条目从 599 增至约 603。全部是 Rust 生态最主流的 HTTP 组件。`vendor/btleplug` 的 4 处补丁**不受影响**（没动 btleplug）。

---

### 3.4 能不能把 MCP 做成独立 npm 包？——服务器不行，周边可以

**结论：MCP 服务器本身不能是独立进程/npm 包。** 这不是偏好问题，而是被你自己定的两条硬需求锁死的。

| 你的需求 | 为什么必须在应用进程内 |
|---|---|
| "MCP 服务器随程序启动而运行" | 服务器要拿到 Tauri `AppHandle` 才能访问 8 个 `.manage()` 状态（`PortState`/`BleState`/`AdbPtyState`/`WorkflowState`/…）与 11 个模块级 static。串口句柄、BLE 连接对象、ConPTY 主从端都是**进程内对象**，跨进程根本拿不到 |
| "工具操作要与前端同步" | 必须能 `emit` 到 WebView，让前端合成 DOM 事件并回执（§6.1）。**外部进程没有任何途径触碰 WebView 的 DOM** —— 它连"界面上有没有这个按钮、为什么是灰的"都不知道 |
| 日志（§7） | LogHub 要挂在生产端旁路（串口读线程、`ble_notify_loop`、PTY 读线程），这些都在进程内 |

**"npx 模式"隐含的生命周期与你的要求正好相反。** 主流 MCP 服务器的 `npx -y xxx` 用法意味着：**由客户端拉起服务器进程，生命周期归客户端**。而你要的是**随桌面应用启动**。两者互斥。硬凑的话——应用没启动时那个 npm 包无事可做，只能反过来去启动 GUI 应用，即"让 AI 拉起一个带界面的桌面程序"，这是个坏设计。

**如果坚持"独立进程的 MCP 服务器"**，架构会变成 `MCP 进程 → 本地 IPC → 应用进程`：同一功能拆成两半，还要**新造一套 IPC 协议**（或让应用再开一个只给内部用的 HTTP 服务），而"随程序启动"依然解决不了（除非由应用去拉起它，那它就不"独立"了）。收益为负。

#### 但 npm 包在这套设计里有三个站得住脚的用法

| 方案 | 做什么 | 建议 |
|---|---|---|
| **A. 客户端配置安装器** | `npx seahi-serial-mcp install`：读应用写出的发现文件 `%APPDATA%\seahi-serial\mcp-endpoint.json`（§4.3），把 `mcpServers` 条目**自动写进** Claude Desktop / Cursor 的配置文件，并提示重启客户端 | ✅ **推荐**。纯增量、不碰架构，把"复制粘贴配置"升级成"一条命令"；弹窗里的一键复制（§10.2）仍作为保底路径 |
| **B. stdio↔SSE 适配器** | 一个瘦包，把本机 SSE 端点转成 stdio 暴露给**只支持 stdio** 的客户端 | ⚠️ 可选但**先不做**：与你"只采用 SSE 模式"的约束冲突（多一条链路、多一个进程、多一处要维护的失败模式） |
| **C. 用 npm 分发"应用本身"** | `postinstall` 自动下载 `Seahi-Serial-Setup-x.y.z.exe` 或绿色版 exe | ❌ 不推荐：会丢掉 Inno Setup 已有的快捷方式、卸载项、WebView2 引导、usbipd-win 打包、PATH 处理；且 postinstall 下载 exe 容易撞企业代理、npm 脚本禁用策略、杀软与 SmartScreen 告警 |

> 另注意：`package.json` 现在是 `"private": true`（它只作为 `@tauri-apps/cli` 的宿主，`name` 还是 `serial-debugger`）。要发包必须**另建一个包**（如 `seahi-serial-mcp`），不能直接复用这个。

**"安装时自动下载"真正该作用的对象是"应用"，不是 MCP。** 应用的分发已经走 GitHub Releases + Inno Setup MSI（CI 自动发布），这条路是通的。是否再加一条 npm 分发渠道，属于**独立于 MCP 的需求**（见 §13 D12）。

---

### 3.5 「A 方案」npm 客户端配置安装器（已选定 ✅）

**一句话**：一个**零运行时依赖**的瘦 Node 包 `seahi-serial-mcp`，唯一职责是把"应用已经告诉你的 MCP 端点"写进各家 AI 客户端的配置文件。它**不是 MCP 服务器**，也**不下载任何东西**。

#### 为什么它比"手工复制粘贴"更有价值

不只是省事：**应用端口回退后会变**（默认 7777 被占用则递增，§4.3）。URL 一变，用户只需重跑一次

```
npx seahi-serial-mcp install
```

就把所有客户端一次修好；手工粘贴则要逐个客户端改配置文件。**幂等修正**才是它的核心价值，而不只是"首次安装"。

#### 命令行

| 命令 | 作用 |
|---|---|
| `npx seahi-serial-mcp` (= `install`) | 发现端点 → 找到已安装的客户端 → 逐个写入 `mcpServers["seahi-serial"]` |
| `install --client claude,cursor` | 只写指定客户端 |
| `install --url <url>` | 手动指定端点（跳过发现文件，用于非默认端口/调试） |
| `install --dry-run` | 只打印将要写入的内容与 diff，不落盘 |
| `status` | 应用是否在跑、端点 URL（token 打码）、每个客户端是否已配置、是否指向当前 URL |
| `uninstall` | 从各客户端移除 `seahi-serial` 条目（**只删自己那一条**） |

#### 端点发现

读 `%APPDATA%\seahi-serial\mcp-endpoint.json`（应用启用 MCP 时写出，§4.3）：

```json
{ "version": 1, "url": "http://127.0.0.1:7777/sse?token=…", "host": "127.0.0.1",
  "port": 7777, "pid": 23084, "appVersion": "0.5.0", "startedAt": "…" }
```

**两步校验，避免把死配置写进客户端**：

1. **pid 还在**（`process.kill(pid, 0)` 探测；Windows 上的行为差异要单独处理）；
2. **端口能应答** —— 为此新增一个轻量探活端点 **`GET /healthz`**，无 token 也返回 `{"ok":true}`，**不含版本、会话数等任何信息**（避免无鉴权泄露）；带 token 的 `/status` 才返回详情。**这条已回填到 §4.2。**

校验不过就**拒绝写入**，提示"应用未运行"，而不是写进一个连不上的地址。

#### 客户端与配置位置

⚠️ **下表路径必须在实现时逐个在本机核实后再定稿** —— 我这边没有公网，无法核对各客户端当前版本的官方文档。这是该包的第一步工作，不要照抄路径直接写盘。

| 客户端 | 预期位置（**待核实**） | 备注 |
|---|---|---|
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` | 键 `mcpServers` |
| Claude Code | 用户级 `~/.claude.json` + 项目级 `.mcp.json` | 两种作用域都要考虑 |
| Cursor | `~/.cursor/mcp.json`（全局）/ `.cursor/mcp.json`（项目） | 待核实 |
| VS Code | 工作区 `.vscode/mcp.json` | 待核实 |
| 其它（Windsurf / Cline 等） | 插件设置 | 低优先级，先留扩展点 |

**写法：只动"我们自己那一把键"** —— 读入 JSON → 只增改 `mcpServers["seahi-serial"]` → 其余键原样保留。

#### 写入安全（照抄 M7 的教训）

| 措施 | 说明 |
|---|---|
| **先备份** | 同目录 `xxx.json.seahi-bak-<时间戳>`，保留最近 5 份 |
| **原子写** | 临时文件 → rename（同盘），绝不做"截断后重写" |
| **JSONC 兜底** | 目标文件若含注释（VS Code/Cursor 允许），`JSON.parse` 会失败 → **绝不硬改**，改为打印"请手工粘贴以下片段"并以非 0 退出 |
| **只增不删** | 不碰其它 MCP server 条目；`uninstall` 也只删 `seahi-serial` |
| **幂等** | 已是目标 URL 时输出"无需修改"，不写盘 |
| **默认打印 diff** | 写之前显示将新增/修改的内容；`--dry-run` 则完全不写 |
| **token 打码** | `status`/日志里 token 默认显示为 `…abcd`，避免泄进终端回滚缓冲或 AI 对话记录 |

#### 包本身的性质

| 项 | 值 |
|---|---|
| 名字 | `seahi-serial-mcp`（**npm 上是否已被占用待确认**——我无法联网查） |
| 位置 | 新目录（如 `npm/seahi-serial-mcp/`），**与应用的 `package.json` 无关** |
| 运行时依赖 | **0 个**（只用 Node 内置 `fs`/`path`/`os`/`http`/`process`） |
| `postinstall` | **不要**。不下载、不执行任何东西 —— 只有这样才能彻底避开 §3.4 C 方案那些坑 |
| Node 版本 | `>=18` |
| 平台 | **仅 Windows**（路径都是 Windows 的）；非 Windows 直接报错退出 |
| 对应用的影响 | 应用的 `package.json` **一个字都不改**，依赖图也不变（所以 §3.3 的"0 个 npm 包"依然成立） |
| 发布 | 需要你提供 `NPM_TOKEN` 才能进 CI（tag 触发 `npm publish`）；在此之前可先用 `npm link` 本地验证 |

#### 验收标准

1. 在装了 Claude Desktop 的机器上，`status` 能正确区分"已配置 / 未配置 / URL 已过期"三种状态；
2. **关掉应用后 `install` 必须拒绝写入**并提示"应用未运行"；
3. 应用端口从 7777 回退到 7778 后，重跑 `install` 能把客户端配置修正过来；
4. `install` 前后 diff 客户端配置文件：**除 `mcpServers["seahi-serial"]` 外无任何差异**（写成自动化断言，用临时目录里的样本文件跑）；
5. 目标文件含注释时，如实失败并给出可粘贴片段，**不破坏原文件**。

---

## 4. MCP 服务器：传输与运行时

### 4.1 形态选择

MCP 规范里"SSE 模式"实际对应两种形态，本方案**主实现遗留 SSE 传输**，同时**同端口挂着 Streamable HTTP**：

| 形态 | 端点 | 何时用 | 本期 |
|---|---|---|---|
| HTTP+SSE（2024-11-05 规范） | `GET /sse` + `POST /messages?sessionId=` | 客户端配置里写 `"type": "sse"` 时用 | ✅ 主实现 |
| Streamable HTTP（2025-03-26 规范） | `POST /mcp`（**直接回 `application/json`**）、`GET /mcp`（挂 SSE 流收通知）、`DELETE /mcp`（终止会话） | 新版客户端默认走这个 | ✅ **已落地**（2026-09-16，见 §17） |

理由：用户要求"只采用 SSE 模式"，但主流客户端在新版本里已经默认 Streamable HTTP；两者共用同一套工具与状态，附带实现的成本远低于"客户端连不上再返工"的成本。配置项 `streamableHttp` 可关（默认开）。

> 2026-09-16 落地时的取舍见 §17：POST **不返回 SSE 流**（我们的工具是一问一答，没有中途消息，
> 规范允许服务器在 JSON 与 SSE 之间二选一）；两类会话共用同一张表与上限；表满时只淘汰最久未活动的
> **HTTP** 会话（SSE 会话被踢掉会变成收不到东西的僵尸，而客户端拿到 429 又无从恢复）。

**SSE 帧格式（遗留传输）：**

```
event: endpoint
data: /messages?sessionId=8f3c...&token=...

event: message
data: {"jsonrpc":"2.0","id":1,"result":{...}}
```

### 4.2 端点与鉴权

- 只绑定 `127.0.0.1`（含 `::1`），**绝不绑 `0.0.0.0`**。
- 首次启动生成 32 字节随机 token（`uuid`/`rand`），存 AI 配置。
- **token 放在 URL 路径/查询里**，因为遗留 SSE 客户端（Claude Desktop 的 `type: sse` 配置）不一定能带自定义 Header：
  - SSE：`GET /sse?token=<token>`
  - 消息：`POST /messages?sessionId=<sid>&token=<token>`
  - 同时接受 `Authorization: Bearer <token>`（新版客户端）。
- 校验失败返回 401/404，不做任何提示性回显（避免探测）。
- **探活端点 `GET /healthz`**：**不需要 token**，只返回 `{"ok":true}`，**不含版本/会话数/工具数等任何信息**。用途：① §3.5 的 npm 安装器校验"应用真的在跑"；② 界面状态灯；③ 用户自查"端口通不通"。任何"有信息量"的查询都必须带 token（如 `GET /status`）。
  - 存在的理由：无鉴权的探活如果返回版本号，等于给本机任意进程一个免费的信息泄露点；只回 `ok` 就没有这个顾虑。

### 4.3 端口与发现

- 默认端口 **7777**；被占用则顺序尝试 7778..7796（可配 `portRange`）。
- 实际端口与完整 URL 写回 `ai-config.json`，并在 `%APPDATA%\seahi-serial\mcp-endpoint.json` 落一份发现文件，供外部工具读取。
- 界面提供"复制 MCP 客户端配置"，一键生成可直接粘贴的 JSON 片段：

```json
{ "mcpServers": { "seahi-serial": { "type": "sse",
  "url": "http://127.0.0.1:7777/sse?token=XXXX" } } }
```

### 4.4 生命周期

- 在 Tauri `setup()` 末尾、`.manage()` 全部注册之后启动：`tauri::async_runtime::spawn(server::run(app_handle, cfg))`。
- **硬性约束：MCP 服务器起不来不能影响主功能。** 端口全占/绑定失败/依赖异常 → 记日志 + 界面状态灯变红 + 继续正常运行。
- 关闭：监听 `RunEvent::ExitRequested`/`Exit`，先广播 `notifications/...` 收尾信号，再 `axum::serve(...).with_graceful_shutdown(...)`。
- 不随窗口最小化停止；窗口关闭 = 进程退出 = 服务停止（这符合"随程序启动而运行"）。若以后要"关窗不退出"，需要托盘，属独立需求。

### 4.5 并发、限流、超时

| 项 | 值 | 说明 |
|---|---|---|
| 最大会话数 | 4 | 够用；防端口被反复连 |
| SSE 心跳 | 每 15s 发 `: ping` 注释帧 | 防中间层/NAT 断流、探测客户端存活 |
| 单次工具超时 | 默认 10s；设备类 30s | 超时返回 JSON-RPC error，**不**让请求悬挂 |
| 前端桥回执超时 | 5s | 见 §6.1 |
| 速率限制 | 60 次/分/会话，超限 -32000 | 防 AI 打转刷爆 UI |
| 请求体上限 | 1 MiB | 防大 payload |

### 4.6 MCP 协议实现清单

**方法（server 侧）：**

| 方法 | 类型 | 说明 |
|---|---|---|
| `initialize` | req | 协商 `protocolVersion`（优先 `2025-06-18`，回退 `2024-11-05`）；返回 `capabilities = { tools:{listChanged:true}, resources:{subscribe:true,listChanged:true}, logging:{} }`、`serverInfo = { name:"seahi-serial", version: env!("CARGO_PKG_VERSION") }` |
| `notifications/initialized` | notif | 握手完成 |
| `ping` | req | 存活探测 |
| `tools/list` | req | **必须分页**（`limit=50` + `nextCursor`），因为 C 层可能数百个工具 |
| `tools/call` | req | 见下面"错误语义" |
| `resources/list` / `resources/read` | req | 状态与日志资源 |
| `resources/subscribe` / `unsubscribe` | req | 订阅 uri 变更 |
| `logging/setLevel` | req | 控制 `notifications/message` 的下限 |
| `completion/complete` | req | **给 `ui_set.path` 之类的参数做补全**——AI 不用先查列表就能补全控件路径，很实用 |
| `notifications/resources/updated` | 出 | `{uri}`：状态/日志变了 |
| `notifications/resources/list_changed` | 出 | 新增/移除资源 |
| `notifications/tools/list_changed` | 出 | 控件动态增减（打开蓝牙面板会新增一批） |
| `notifications/message` | 出 | `{level, logger, data}`：用户操作播报、日志订阅推送 |

**错误语义（容易做错的地方）：**

- **协议级错误**用 JSON-RPC `error`：`-32700` 解析失败 / `-32600` 非法请求 / `-32601` 方法不存在 / `-32602` 参数非法 / `-32603` 内部错误。
- **工具执行失败**（比如端口被占用）必须返回**正常 result**，内容里 `isError: true` —— 这是 MCP 规范要求，客户端才会把错误文本回灌给模型而不是当成连接故障。
- 自定义错误码（放在 `error.code`，或 `isError` 文本里的机器可读前缀）：

| code | 含义 | AI 应有的反应 |
|---|---|---|
| `-32000` | 触发限流 | 退避重试 |
| `-32001` | 未授权 / 会话失效 | 让用户重置 token |
| `-32002` | 该工具被策略禁用（`policy`） | 告知用户去开开关 |
| `-32003` | 用户拒绝了危险操作确认 | **不要重试**，问用户 |
| `-32004` | 前端桥回执超时 | 可用 `ui_get` 核对实际状态后再决定 |
| `-32005` | 用户正在操作该控件（busy） | 稍后重试 |
| `-32006` | 设备未就绪（串口没开、蓝牙没连） | 先做前置操作 |

**结果形状**：一律返回 `content:[{type:"text", text:"<人类可读>"}]`，同时给 `structuredContent`（机器可读 JSON）——既照顾只会读文本的客户端，也让能解析结构的客户端拿到精确数据。

---

### 4.7 稳定性设计（首要目标：不拖垮宿主）

MCP 是**寄生在用户正在用的调试器里**的。它一崩，用户正在跑的串口会话就没了。所以"稳定"的第一含义不是"服务不挂"，而是**"它挂了也不能影响主功能"**。

**铁律 1 —— 故障隔离，绝不连坐。**

- ⛔ **`panic = "abort"` 绝对不能加。** 现在 `Cargo.toml` 没有 `[profile]` 段 → 默认 `unwind`，这是本设计的前提。一旦改成 abort，MCP 里任何一次 panic（哪怕只是工具参数解析失败）都会**直接杀掉整个进程**。
- 工具分派边界套 `catch_unwind`：单个工具 panic → 返回 JSON-RPC 错误 + 走现有 `report_error()` 上报，**连接不断、进程不死**。
- ⛔ **绝不 `unwrap()` 锁**，用 `into_inner()` 容忍锁中毒 —— 这是本项目已经踩过的坑（TODO M5：BLE 段 39 处 `lock().unwrap()` → 锁中毒后前端卡死）。
- ⛔ `std::sync::Mutex` **绝不跨 `.await` 持有**（会占住 worker 并埋下死锁）。
- 服务器任务本身允许失败：`axum::serve` 意外返回 → 记日志 + 状态灯变红 + 弹窗给"重启"按钮；**自动重启上限 3 次/5 分钟**，超了停在失败态并显示原因（避免崩溃循环刷爆日志与 CPU）。

**铁律 2 —— 绝不阻塞运行时。**

- 那 ~48 条阻塞命令（含 4 条"`async fn` 但内部同步 5~15s"）一律 `spawn_blocking`（§2.4）。
- ⚠️ 但 **`spawn_blocking` 的超时只是"不再等"，线程不会被打断**：卡住的线程仍占着 tokio blocking 池，而该池**默认上限 512 线程、每线程 2 MiB 栈**。所以必须自己限并发，否则一个打转的 AI 能同时把线程和内存吃光：

| 闸门 | 上限 | 超限行为 |
|---|---|---|
| 全局工具执行并发 | **4**（`Semaphore`） | 立刻返回 `-32000`，**不排队** |
| 每会话在途请求 | 8 | 同上 |
| 前端桥在途 UI 命令 | **32** | 返回 `-32005 busy`，绝不堆积（否则几千条 `emit` 会把 WebView 卡死） |
| 速率 | 60 次/分/会话 | `-32000` |

> **考虑过但否掉**：给 MCP 单独起一个 tokio 运行时（`Builder::new_multi_thread`）来隔离 CPU 抢占。否决理由：多一套线程池（每 worker 2 MiB 栈）**反而多占内存**，而"限并发 + `spawn_blocking` + 超时"已经能防住抢占；本应用是桌面工具，不值得为理论上的隔离多付这份内存。**实现时不要"顺手"加第二个运行时**（真需要隔离时再谈，且要连带重新评估内存预算）。

**铁律 3 —— 热路径上不做事。**

- 日志旁路必须 **非阻塞 + 可丢弃 + 计数**：串口读线程是延迟敏感的（窗口可见时 25ms 轮询），**绝不能让 LogHub 拖慢它**。做法：`try_lock`/`try_send`，拿不到就 `dropped += 1` 直接丢，**绝不等待、绝不阻塞**。
- ⛔ **绝不为每条日志/每个通知 `spawn` 一个任务**（这是最容易写出的灾难）。
- **每通道独立锁**，不要一把全局锁 —— 串口 92KB/s 与 ADB 数十 MB/s 不能互相争锁。
- 格式化（HEX 转换、时间戳字符串、JSON 序列化）**只在读取时做**；**绝不在持锁期间序列化** —— 先快照，再格式化。

**铁律 4 —— 一切队列都有上限**（§4.8 表），不存在"临时无界"。

**铁律 5 —— 会话必须能自己死掉。**

- 每个 session 的 `tokio::spawn` 都必须有明确退出条件（channel 关闭 / shutdown token）；SSE 流被 drop 时要能收敛掉心跳与 janitor 任务。
- **慢消费者策略**（笔记本休眠、客户端崩了没发 RST、AI 卡住都属此类）：出站队列涨满 → **丢最旧的"通知"并插一条"另有 N 条已丢弃"的折叠消息**；若是"响应"发不出去（正常不该发生）→ 直接关闭该会话。
- **空闲 30 分钟无流量 → 关闭会话**。
- **停止 MCP 必须真正释放** listener、任务、队列；start/stop **幂等**（反复开关不能漏任务、漏端口）。

### 4.8 内存预算与背压

**总预算：MCP 子系统稳态 ≤ 24 MiB**（作为实现期的验收线）。

⚠️ 必须说清楚：**这份内存是叠加的，不能替代现有缓冲。** 现有的串口 256KB、ADB 4MB、BLE 2000 条都是"等前端来取的未消费数据"，与 LogHub"给 AI 看的历史"用途不同，两者都要在。所以只能靠上限管住。

| 分配项 | 上限 | 说明 |
|---|---|---|
| **LogHub 合计** | **16 MiB** | 硬上限；超了先裁最大的通道 |
| ├ `serial:<mid>` | 512 KiB / 监视器 | 只保尾部 |
| ├ `adb` | 1 MiB | 该通道可到数十 MB/s，**只存文本尾部**，HEX 不落 |
| ├ `wsl:<mid>` | 256 KiB | |
| ├ `ble:*` | 256 KiB | |
| ├ `app` / `error` / `mcp` | 128 KiB | |
| └ `ui:*` / `workflow` | 64 KiB | |
| `session-cache` | **0（不进内存）** | 按需从磁盘 `log-cache\*.log` 读 |
| 每会话出站队列（通知） | 200 条 / 256 KiB | 溢出丢最旧 + 折叠计数 |
| 每会话出站队列（响应） | 32 条 / 512 KiB | 溢出 = 关闭该会话（异常情况） |
| 在途 UI 命令关联表 | ≤ 32 条 | 5s 超时必回收 + 30s janitor 兜底清扫 |
| 工具目录缓存 | ≤ 1 MiB | `tools/list` 结果缓存，注册表变才重建（别每次重新序列化几百个工具） |
| 单次工具响应 | ≤ 256 KiB | 超了截断 + `truncated:true`（§7.3） |
| 会话数 | ≤ 4 | |

**降低"每条日志"的开销**（这是最容易被忽略的内存大头）：

| 做法 | 收益 |
|---|---|
| 时间戳存 `i64` 毫秒，**不存 RFC3339 字符串** | 每条省 ~35 字节 + 一次分配 |
| 通道名**池化**成 `u16` id，名字用 `Arc<str>` 共享 | 每条省一次 `String` 分配 |
| 载荷用 `Box<str>`（不留 `String` 的容量冗余） | 省 8~24 字节/条，减少碎片 |
| HEX **不在存储期生成**，读取时才格式化并按需截断 | HEX 体积是原始的约 3 倍，绝不预生成 |
| 上限按**字节**而不是条数 | 4KB 的行与 20 字节的行，按条数算完全不是一个量级 |

> 反例（很容易写出来）：`VecDeque<LogLine>` + 每条一个 `String` 时间戳 + 每条一个 `String` 通道名。2 万条就能吃掉好几 MB，且分配器碎片严重 —— 这就是"明明只存了 1MB 数据，RSS 却涨了 10MB"的典型成因。

**背压原则：宁可明确拒绝，不要悄悄堆积。**

| 情况 | 行为 |
|---|---|
| 并发/速率超限 | 立刻 `-32000`，不排队 |
| 前端桥饱和 | `-32005 busy`，让 AI 稍后重试 |
| LogHub 通道满 | 丢最旧 + `dropped++`（**生产者绝不等待**） |
| 订阅推送跟不上 | 折叠成"另有 N 条"，最多 5 条/秒/会话 |
| 客户端不读 | 丢通知 + 折叠；持续则断开该会话 |

### 4.9 可观测与自愈（"稳定"必须能被看到）

- `mcp_stats` 暴露：LogHub 各通道的字节数/条数/`dropped`、会话数与各自队列深度、在途命令数、被限流次数、工具耗时 P50/P95。
- 弹窗里显示同样这几个数字 —— **内存与队列压力可见，出问题不用猜**。
- `notifications/message` 把"丢弃了 N 条""会话因慢消费者被断开"**明确告知 AI**，而不是静默丢。本项目已经在 BLE 通知上吃过"静默丢弃"的亏（G8 才补上丢弃计数），不要重复。
- 会话建立/断开、服务器启停、自愈重启，都写 `app` 通道 + `dbg_log`。

**必须写成自动化测试的验收项：**

1. **慢消费者浸泡测试（最关键）**：连上 → 订阅高频通道 → **故意不读** → 跑 5 分钟，断言 ① 应用 RSS 增幅 < 10 MiB；② 该会话被判定为慢消费者并断开；③ **主界面的串口收发不受任何影响**。
2. **LogHub 溢出**：灌入超过上限的数据，断言总量不超上限、`dropped` 递增、`since_seq` 仍可用。
3. **在途命令泄漏**：模拟前端不回执，断言 5s 后关联表清空、30s janitor 无漏网。
4. **启停幂等**：反复开关 50 次，断言端口可重新绑定、任务数不增长。
5. **工具 panic**：故意让一个工具 panic，断言进程存活、连接仍可用、有错误上报。

---

## 5. 控件注册表：把整个界面变成工具

### 5.1 控件路径（control path）

稳定、可读、可预测，形如 `<panel>.<group>.<name>`：

```
serial.conn.portSelect      串口-连接栏-端口下拉
serial.conn.baudRate        串口-连接栏-波特率
serial.toolbar.btnSend      串口-工具栏-发送
serial.toolbar.btnTs        串口-工具栏-时间戳开关
serial.adv.quickCmd1        串口-高级-快捷指令1
wsl.conn.portSelect
adb.toolbar.refresh
ble.scan.secs               蓝牙-扫描-时长
ble.conn.connect            蓝牙-连接
ble.periph.svcUuid          蓝牙从机-服务UUID（入口默认隐藏）
ui.panel.serial             切换到串口面板
ui.panel.ble
ui.theme.style              界面风格（12 套）
ui.theme.dark               明暗
mcp.server.enabled          MCP 开关（新增控件自己也进注册表）
```

规则：`^[a-z][a-z0-9]*(\.[a-zA-Z0-9_]+)+$`，最多 5 段。路径一旦发布**只增不改**（AI 提示词/用户脚本会依赖它），需要改名时保留旧名做别名。

### 5.2 注册表条目

```js
{
  path: 'serial.conn.portSelect',
  kind: 'select' | 'button' | 'toggle' | 'text' | 'number' | 'checkbox'
      | 'range' | 'file' | 'color' | 'view' | 'custom',
  el: () => HTMLElement | null,      // 延迟解析，因为面板是动态重建的
  panel: 'serial', group: 'conn',
  label: '端口',
  description: '选择要打开的串口设备',
  enum: [...],                       // 下拉/枚举型：可选值（运行时从 DOM 读，保证与界面一致）
  min: 1, max: 3600, unit: 's',      // 数值型
  pattern: '^(COM\\d+|/dev/tty.*)$', // 文本型
  read: () => value,                 // 读当前值（优先从 DOM/状态读，不另存一份）
  write: (v) => {...},               // 写：合成 DOM 事件（§5.4）
  enabled: () => bool,               // 是否可用
  disabledReason: () => string,      // 灰掉的原因（AI 最需要这个）
  sideEffect: true,                  // 会真的发数据/连设备
  dangerous: false,                  // 需二次确认
  requiresDevice: 'serial'|'ble'|'adb'|'wsl'|null,
  aiPolicy: 'allow'|'confirm'|'deny'  // 单个控件的 AI 策略
}
```

### 5.3 注册表怎么建

**三层来源，从自动到手工：**

1. **自动发现（覆盖绝大多数）**：启动时遍历
   `button, input, select, textarea, [onclick], [role=tab], .tree-item, .card-clickable`，
   按 DOM 归属面板 + 已有 `id` 自动推导路径：
   - `id="main-portSelect"` → `serial.conn.portSelect`
   - `id="ble-btnScan"` → `ble.toolbar.btnScan`
   - `data-mcp="ble.scan.secs"` 优先（手工覆盖）
   - 推导不出来且无 id 的 → 归到 `<panel>.misc.<hash>`，并**记进"待补元数据"清单**（开发期跑一次，看清单把关键项补上）
2. **手工元数据表** `MCP_CONTROL_META`：只写"自动推不出来的部分"——中文标签、枚举值、单位、危险等级、禁用原因、语义化 tool 名。**不重写**已有逻辑。
3. **动态控件**：监视器/分栏/蓝牙从机特征等是运行时生成的。注册表支持 `registerDynamic(prefix, factory)`，在渲染函数里顺带登记；`el()` 用函数延迟解析，面板销毁后自然返回 null 并给出 `enabled=false, disabledReason='面板未打开'`。

> **视图切换也是条目**：`ui.panel.*`（串口/WSL/ADB/蓝牙 四个面板）、面板内的子视图（高级设置展开、蓝牙服务树、从机配置、日志缓存视图、各模态框）。它们的 `write` 就是调用现有的切换函数。

### 5.4 写操作 = 合成 DOM 事件（本方案的关键决策）

工具改界面**不走第二套逻辑**，而是驱动同一个 DOM：

| 控件 | write 实现 |
|---|---|
| button / toggle | `el.click()` |
| select | `el.value = v; el.dispatchEvent(new Event('change', {bubbles:true}))` |
| input[text/number] | `el.value = v;` 派发 `input` + `change`（两类监听都要覆盖） |
| checkbox | 仅在值不同时 `el.click()`（保留既有 change 逻辑） |
| range | 同 input，再派发 `input` |
| 自定义 | 调现有函数（如 `setBleMode('periph')`） |

好处：
- **界面必然同步**——因为它走过的就是用户点击那条路（含所有副作用、防抖、重渲染、校验）。
- 没有"AI 专用分支"，不存在两套逻辑漂移。
- 现有的 172 处内联 `onclick` 一行都不用改。

约束：`write` 必须在**主线程**且面板已渲染；对需要"先展开再操作"的控件，元数据里给 `prerequisite: ['serial.adv.open']`，桥在写入前按序满足前置条件。

#### 5.4.1 必须解决的问题：63.9% 的控件没有稳定 `id`

实测只有 83/230 个控件有 `id`，**77 个是 class-only 且在同容器内重复出现**（`.ibtn`、`.wf-row-btn`、`.btn-ref`、`.pane-close`、`.win-ctrl-btn`、`.sel-opt`…），例如 `createMonitorPane` 的 `.ibtn-group` 里 5 个 `.ibtn` 只有 4 个带 id。

**解决方案：boot 时给每个控件注入 `data-mcp` 属性，之后一律用它寻址。**

```
① boot 扫描（一次，在 DOMContentLoaded 之后、面板懒加载之前+每次面板首次构建后）
   遍历 button/input/select/textarea/[onclick]/[role=tab] → 按"所属面板 + 容器内文档序"推导路径
   命中唯一 id 的用 id 命名；否则用"容器路径 + 序号"命名（如 serial.toolbar.ibtn.2）
   把 path 写进 el.setAttribute('data-mcp', path)  ← 之后就只需要 [data-mcp="…"] 这一个选择器
② 手工元数据表 MCP_CONTROL_META 覆盖：中文标签/枚举/单位/危险级/禁用原因/语义工具名
③ CI 门禁：断言"所有 [onclick]/[data-mcp] 元素都能解析出 path"，模板一改就会红
```

为什么这样能成立：`data-mcp` 是**我们自己写上去的**，所以不依赖源码里有没有 id；而"容器 + 文档序"在**模板不变**时是稳定的，模板变了由 CI 断言兜底。注入是幂等的，面板被重新渲染后重跑即可。

定位优先级（供人工排查）：`[data-mcp]` → `#字面量id` → `#{mid}-模板id` → `[data-*]`/`[name]` → 文案 fallback。**永远不要依赖 class。**

#### 5.4.2 写操作的两种手段（混用，各有适用面）

| 控件类型 | 手段 | 理由 |
|---|---|---|
| 按钮 / 开关 / 可点卡片 | `el.click()`（合成事件） | 逻辑都在 `onclick` 里，合成事件是唯一不重复实现的办法；且天然触发副作用 |
| 输入 / 下拉 / 勾选（**单点**） | 设置值 + 派发 `input`/`change` | 与用户操作同路径 |
| **成组的配置项** | 复用既有函数：`applyMonitorConfig(mid,mc)`（5475）、`restoreBleState(b)`（3947）、`restoreBlePeriphForm(p)`（9043）、`setBleMode(m)`（8827）、`selectThemeStyle(s)`（5715） | 这些函数已经把"下拉 `data-val` + 文案 + `.active` 类 + 复选框 + 按钮 `.on` 类"都同步好了；自己操作 DOM 反而容易漏 |
| 下拉项 / 动态卡片 | `[data-mcp]` 命中后 `click()` | 它们本来就靠 `onclick`/委托 |

**统一收尾**：任何写操作完成 → `scheduleConfigSave()`（500ms 防抖）→ 用户配置落盘；同时 `mcpNotifyState()` 通知服务端。

#### 5.4.3 注册表必须**运行时**采集，不能只靠静态分析

13 处 `setAttribute('onclick', …)` 会在切页时改写同一个按钮的语义（顶栏 4 个按钮在 4 个页面功能不同），且 `renderWorkflowList`/`renderWslDeviceList`/`renderBlePfPending` 会在字符串里拼 `onclick`。因此：

- 静态提取只用来生成"**候选路径模板**"（含 `{mid}` 展开）；
- **权威注册表在运行时构建**，并在以下时机重建：面板首次打开（`wslPane._initialized`/`adbPane._initialized`/`blePane._initialized` 转真）、监视器增删、动态列表重渲染；
- 变化后发 `notifications/tools/list_changed`（§4.6）。

**顺带要补一个门面**：现在**没有任何"当前在哪一页"的状态变量**（只能从 `#xxx-pane` 的 `style.display` 反推，且当前页不写配置）。P1 阶段应加一个显式的 `getUiState()`/`setUiState()` 门面，把"当前页 / 当前选中 mid / 当前 BLE 选中设备"显式化，`ui_get_state` 与 `ui_switch_panel` 都建在它上面。

#### 5.4.4 特例：BLE 从机 UI 当前是"死 UI"

`BLE_PERIPH_MODE_ENABLED=false`（`index.html:8680`）⇒ `bleModeSegHtml()` 返回空串、模式切换按钮不渲染、`setBleMode('periph')` 被折回 `host`。面板 DOM 仍在但入口不可达。

注册表对这批条目应标记 `enabled:()=>false, disabledReason:'入口已关闭（本机不支持 BLE 从机广播）', aiPolicy:'deny'` —— 让 AI 明确得到"存在但不可用 + 为什么"，而不是调用后莫名失败。


### 5.5 MCP 工具命名

MCP 客户端对工具名有字符集约束（`^[a-zA-Z0-9_-]{1,64}$`），**不能用点号**。映射规则：

| 层 | 命名 | 例子 |
|---|---|---|
| 桥工具 | `ui_*` / `log_*` / `mcp_*` | `ui_set`, `log_tail`, `mcp_stats` |
| 全量自动工具 | `ctl_` + 路径点换下划线 | `ctl_serial_conn_portSelect`、`ctl_ui_theme_dark` |
| 语义工具 | 手写短名 | `serial_open`, `ble_connect`, `adb_shell` |

超 64 字符时按 `panel_group_name` 截断并保证唯一（注册时查重，冲突则加数字后缀，并在 `ui_describe` 里回显完整路径）。

### 5.6 工具分层与暴露策略

全量控件可能数百个，一次性塞进 AI 的 tool 列表会严重拖累模型表现（工具选择变差、上下文被吃掉）。所以分三层，**由 AI 配置决定暴露哪些**：

| 层 | 数量级 | 默认 | 内容 |
|---|---|---|---|
| **A. 通用桥** | ~8 | ✅ 常开 | `ui_list`、`ui_describe`、`ui_get_state`、`ui_set`、`ui_click`、`ui_watch`、`ui_apply_state`、`ui_wait` |
| **B. 语义工具** | ~50 | ✅ 常开 | 高频/组合/需要跨控件编排的操作（打开串口、发数据、扫 BLE、连 BLE、写特征、ADB shell、日志查询…） |
| **C. 全量自动工具** | 数百 | ⚙️ 按命名空间开关 | `ctl_*`，一个控件一个 |

**A 层保证"没有任何控件够不到"**（`ui_list` 可枚举、`ui_set` 可操作），C 层保证"你想把每个控件都做成工具"这个诉求被真正满足。默认建议只开 A+B，需要时在 AI 配置里 `expose.namespaces` / `expose.autoControlTools` 打开 C。这是"上下文预算 vs 完备性"的取舍，**需要你拍板**（§13 D2）。

### 5.7 工具目录（初稿）

**A 层 · 通用桥（8 个，常开）**

| 工具 | 入参 | 返回 |
|---|---|---|
| `ui_list` | `{panel?, kind?, query?, cursor?, limit=100}` | 控件数组：`path / label / kind / panel / enabled / disabledReason / value / mcpName` |
| `ui_describe` | `{path}` | 完整元数据 + 该控件的**输入 JSON Schema**（AI 拿到就能直接调） |
| `ui_get` | `{path}` | 当前值（实时从界面读） |
| `ui_get_state` | `{section?, redact?}` | `collectConfig()` 的对应子树 |
| `ui_set` | `{path, value}` 或 `{items:[{path,value}], dryRun?}` | 每个条目的 `{path, ok, value(写后真实值), error?, disabledReason?}` |
| `ui_click` | `{path}` | 同 `ui_set`（按钮语义糖） |
| `ui_watch` | `{paths?, ttlSecs?}` | 订阅状态变更通知；返回订阅 id |
| `ui_apply_state` | `{state, dryRun?}` | 部分快照批量回放（AI 帮你恢复一套调试环境） |
| `ui_wait` | `{path, expect?, timeoutSecs}` | 等到控件达到条件（"等设备连上再发数据"） |

**B 层 · 语义工具（~50 个，常开；最终以 §2.4 的 85 个命令为准逐条对齐）**

| 分组 | 工具 |
|---|---|
| 应用/界面 | `app_info`、`app_window{minimize\|maximize\|close}`、`ui_switch_panel{serial\|wsl\|adb\|ble}`、`ui_set_theme{style, dark}` |
| 串口 | `serial_list_ports`、`serial_status{monitor?}`、`serial_open{monitor,port,baud,dataBits,stopBits,parity,dtr,rts}`、`serial_close{monitor}`、`serial_send{monitor,data,as:text\|hex,lineEnding}`、`serial_monitor_add`、`serial_monitor_remove`、`serial_quick_cmd{monitor,index}`、`serial_workflow_run{monitor,workflow}` |
| 蓝牙 | `ble_scan_start{secs}`、`ble_scan_stop`、`ble_scan_results{filter?}`、`ble_connect{address}`、`ble_disconnect`、`ble_services`、`ble_read{char}`、`ble_write{char,data,withResponse}`、`ble_subscribe{char}`、`ble_unsubscribe{char}`、`ble_pair`、`ble_mtu`、`ble_rssi` |
| 蓝牙从机（入口默认隐藏） | `ble_periph_*` 全套后端命令；**入口隐藏期间策略为 `deny`**，避免 AI 去调一个本机不可用的功能 |
| ADB | `adb_list_devices`、`adb_connect{addr}`、`adb_shell{cmd}`、`adb_push/pull`、`adb_install{apk}` |
| WSL | `wsl_list_distros`、`wsl_list_devices`、`wsl_map_port{...}`、`wsl_unmap`、`wsl_attach_device`、`wsl_detach_device`、`wsl_status` |
| 日志 | §7.3 的 8 个（`log_channels` / `log_tail` / `log_search` / `log_stats` / `log_clear` / `log_mark` / `log_export` / `log_subscribe`） |
| MCP 自身 | `mcp_status`、`mcp_config_get`、`mcp_config_set`、`mcp_client_config`（返回可直接粘贴的客户端配置）、`mcp_calls`、`mcp_stats`、`mcp_calls_export`、`mcp_reset_token` |

> 🔎 **白捡的 5 个工具**：实测有 5 个后端命令**前端从来没调用过** —— `list_log_cache`、`load_workflows`、`adb_tool_status`、`adb_shell`、`adb_exec`。其中 `adb_shell`/`adb_exec` 是**界面完全没暴露过的能力**（当年写了没接 UI），MCP 一包就是新功能；`list_log_cache` 正好给 §7 的 `session-cache` 通道用。这 5 个**不需要改任何现有代码**。
>
> ⚠️ 另有 ~48 条命令是阻塞实现（含 4 条"`async fn` 但内部同步阻塞 5~15s"），工具处理器一律走 `spawn_blocking`（§2.4）。

> `serial_send` / `serial_open` / `ble_connect` / `ble_write` / `adb_shell` / `wsl_attach_device` / `log_export` 属危险工具，默认走 `confirm`（§9）。
> 提权类操作**不提供**工具入口：USB 映射到 WSL 需要 UAC 的部分仍由用户手工完成。


---

## 6. 工具调用与前端状态的双向同步

### 6.1 工具 → 界面（请求/回执）

```
MCP tool ui_set{path, value}
  → 后端 UiBridge 分配 cmdId，注册 oneshot，emit("mcp-ui-cmd", {cmdId, op, path, value})
  → 前端 mcpOnUiCmd()：查注册表 → 校验 → write()（合成 DOM 事件）→
      等一帧（requestAnimationFrame）让重渲染完成 → 读回真实值
  → invoke("mcp_ui_ack", {cmdId, ok, value, error, disabledReason})
  → 后端唤醒 oneshot → 组装 MCP 结果返回
```

- 关联表：`Mutex<HashMap<u64, oneshot::Sender<UiAck>>>`，`cmdId` 单调递增。
- 超时 5s：返回 error 并**从表里移除**，避免泄漏（历史上的 BLE 连接超时问题就是"前端放弃了后端才成功"造成状态错位，这里同理，超时后前端若回执要能安全丢弃）。
- 回执里**必须带"写后的真实值"**，因为很多控件的值会被规范化（比如波特率输入框会纠正非法值、端口下拉可能因为设备已拔掉而回退）。AI 需要看到真实结果而不是它请求的值。
- 批量：`ui_set` 支持 `[{path,value}, ...]` 数组形式，一次性下发（前端顺序执行），用于"配置回放"场景。

### 6.2 界面 → 工具（通知 + 资源）

- 前端在**用户**操作导致状态变化时（复用 `scheduleConfigSave` 的 500ms 防抖点，成本几乎为零），调用新命令 `mcp_notify_state({changed:[paths], digest})`。
- 后端据此：
  - 更新 MCP **资源** `ui://state`（完整快照）、`ui://panel/current`、`ui://device/serial` 等；
  - 向所有会话推 `notifications/resources/updated`（带 uri）与自定义 `notifications/message`（人类可读，如"用户把波特率改成 9600"）。
- 于是 AI 能"看到"用户的操作，而不是只能轮询 `ui_get_state`。
- 设备类变化（插拔、BLE 上下线）复用现有 `device-changed` → 同样映射成资源更新通知。

### 6.3 回声抑制（必须处理）

工具改了界面 → 界面触发状态变化 → 又通知回 AI，会形成"AI 收到自己造成的变更"的噪声与潜在循环。方案：

- 前端维护 `_mcpOrigin` 深度计数/时间窗：`mcpOnUiCmd` 执行期间置位，期间的 `scheduleConfigSave`/通知打上 `origin:'mcp'` 标签。
- 后端对 `origin:'mcp'` 的通知**不**再推给发起该次调用的会话（其他会话仍可收到），只写审计记录。
- 用户操作（`origin:'user'`）正常广播。
- 等价地复用了现有 `_loadingConfig` 闸门的思想（恢复配置期间不保存）。

### 6.4 状态快照：复用 `collectConfig()`

- `ui_get_state` 直接返回 `collectConfig()` 的结果，并可 `?section=` 只取子树（`serial` / `ble` / `window` / `theme`）——避免每次把 1.7KB 全量 JSON 灌给模型。
- **脱敏**：`sendHistory`、`quickCmds`、`workflows` 可能含用户隐私/密钥。默认策略：
  - `ai-config.json` 里 `privacy.sendHistory: false` 时，`sendHistory` 仅返回条数与最后一条的时间，不回传内容；
  - 提供 `ui_get_state{redact:false}` 显式关闭脱敏（默认开）。
- `ui_apply_state` 接受部分快照（只写给定字段），内部走 §6.1 的批量写入路径，逐项返回成功/失败——便于"AI 帮我恢复一套调试环境"。

### 6.5 与用户抢操作的冲突

- 用户正在拖动/输入时（元素 `document.activeElement` 且处于输入中），桥的 `write` 若目标就是该元素，返回 `busy` 并让 AI 稍后重试，避免把用户正在输入的内容冲掉。
- 危险操作（发数据、连设备）受 §9 策略约束。

---

## 7. 日志系统与日志工具

### 7.0 ⚠️ 前提：只能"旁路复制"，不能"抢队列"

实测发现：**串口 / BLE / ADB / WSL 的高频数据全部不走事件**，而是前端用轮询命令从后端缓冲里取走（`read_data`、`ble_poll_notifications` ~250ms、`ble_periph_poll_events` ~500ms、`adb_shell_read`、`read_wsl_serial`…）。这是**单消费者队列**语义：谁取走就没了。

所以 LogHub **绝不能**靠"也去 drain 那个队列"取数据 —— 那会把界面要的数据抢走，表现为**界面丢数据/卡顿，而 AI 那边看着一切正常**，是最难排查的一类 bug。

**正确做法：LogHub 挂在"生产端"（数据刚产生、刚入队那一刻）复制一份。**

| 通道 | 生产端旁路点 |
|---|---|
| `serial:*` | 串口读线程 `PortReader` 数据入 buffer 处（`main.rs:392-428`） |
| `ble:conn/rx/tx/scan` | `ble_notify_loop`（`main.rs:6249`）收到 WinRT 通知时 |
| `ble:periph` | `ble_periph_emit`（`main.rs:4421`） |
| `adb` | `adb_open_shell` 的 PTY 读线程（`main.rs:3925-3948`） |
| `wsl:*` | `read_wsl_serial` 的 bridge 读取处（`main.rs:2368`） |
| `workflow` | `execute_workflow_actions_bg` 的事件入队处（`main.rs:853-860`） |
| `app` | `dbg_log()`（`main.rs:16-26`） |
| `error` | `report_error()`（`main.rs:107`） |

附带的好处：**即使界面没在轮询**（窗口不可见时读轮询被降到 500ms，或对应面板根本没打开），LogHub 依然完整记录 —— AI 拿到的是比界面更全的数据。这也是这个设计真正的价值所在。

### 7.1 为什么日志要在后端建中心


现状是"日志产生于各处、显示在前端 DOM"，AI 拿不到。但日志的**源头大多在后端**（串口 RX/TX、BLE 通知、ADB/WSL 进程输出），前端只是渲染。所以在后端建一个 **LogHub**：

```
LogHub {
  channels: HashMap<String, Channel>,
}
Channel {
  lines: VecDeque<LogLine>,   // 环形，默认 20000 条 / 8 MiB 上限
  nextSeq: u64,               // 每通道单调递增
  bytes: usize,
  dropped: u64,               // 被环形覆盖丢弃的条数
  subscribers: Vec<SessionId>,
}
```

- **每通道独立 `seq`**：AI 用 `since_seq` 增量拉取，不重复、不丢（被覆盖时返回 `dropped` 提示，让它知道有空洞）。
- **每个通道的字节上限、全局 16 MiB 预算、以及"生产者非阻塞可丢弃"的写入纪律见 §4.7-4.8** —— 这两节是 LogHub 实现的硬约束，不是建议。
- 后端在 emit 给前端的同时顺手写一份进 LogHub —— **零额外开销**，因为数据本来就过这里。
- 前端专有的日志（界面提示、渲染警告等）通过一个**批量节流**命令回灌：`log_push_batch({channel, lines[]})`，200ms 合并一次，避免高频串口数据把 IPC 打爆。

### 7.2 统一日志信封

```json
{ "seq": 10231, "ts": "2026-09-13T13:52:48.123+08:00", "t": 1757742768123,
  "channel": "serial:main:rx", "direction": "rx", "level": "info",
  "format": "text|hex|json", "payload": "...", "bytes": 64,
  "source": "backend|frontend", "meta": { "port": "COM1", "session": "..." } }
```

通道命名（**已按实测对齐**：13 条通道，来自 `.walkthrough/mcp_inv_logs.md`）：

| 通道 | 现状（实测） | LogHub 接入方式 |
|---|---|---|
| `app` | `dbg_log()` `main.rs:16-26`，**58 处调用**，写 `%TEMP%\seahi-serial-debug.log`，格式 `[<unix毫秒>ms] <msg>`；**无级别/无开关/无轮转/无上限** | 在 `dbg_log` 内旁路写 LogHub；顺带补级别与上限（同时解决 TODO L3） |
| `serial:<mid>:rx` / `:tx` | 后端读线程 `main.rs:392-428`（256KB → 超限 drain 到 128KB）；前端 `appendRecvText` 4396 / `appendOutput` 4242；DOM 上限 10000（软限 15000）；紧凑缓冲 **100 万行** | 在 emit 处旁路；**不要重复存储**（LogHub 只留尾部 + 计数） |
| `wsl:<mid>:rx` / `:tx` | `read_wsl_serial` `main.rs:2368` / `send_wsl_serial` 2391（单次 ≤4096B） | 同上 |
| `adb` | PTY `adb_open_shell` `main.rs:3898`，读线程 3925-3948，512 块 × 8KB ≈ **4MB**；前端 xterm（scrollback 1000）；**无复制/无导出/无落盘** | 旁路；该通道现有 4MB 已偏大，LogHub 只存文本尾部 |
| `ble:conn` / `ble:rx` / `ble:tx` / `ble:scan` | `ble_notify_loop` `main.rs:6249`（缓冲 2000）→ 前端 `logBle` 7103（`_bleLogMax=400`）；**主机日志没有时间戳**（`_bleLog` 只有 `{text,dim}`） | 旁路；**补时间戳** |
| `ble:periph` | `ble_periph_emit` `main.rs:4421`（400 条）；前端 `pushBlePeriphLog` 9287；**400 条溢出无 dropped 计数** | 旁路 + 补 `dropped` |
| `workflow` | `execute_workflow_actions_bg` `main.rs:853-860`（200 条，丢最旧**无提示**）；另有 `<logDir>\workflow_log.txt` | 旁路 + 补丢弃提示 |
| `ui:sys` / `ui:err` | 45 处 `appendOutput`（`.ol.sys` 灰 / `.ol.err` 橙）；`showToast` 2471（**67 处调用**）；前端 `console.*` **69 处**（只进 WebView 控制台，从不落盘） | 新增 `log_push_batch` 回灌；**把 `console.*` 也接进来**，否则 AI 看不到前端告警 |
| `error` | `report_error` `main.rs:107`（dbg_log + 可选 Sentry + 自建服务）；panic hook 124-148；前端 3 个入口 → `report_js_error` 3874。**CI 未启用 sentry feature** | 旁路，含"已上报/已跳过"状态 |
| `session-cache` | `%APPDATA%\seahi-serial\log-cache\session-*.log`，只限**文件数 10**、**单文件无上限**（单会话可达数百 MB） | 只读暴露。**现成的死入口可用**：`list_log_cache`（`main.rs:3233`，已注册但前端零调用） |
| `mcp` | 新增 | MCP 会话与工具调用（与 §8.3 的 `ai-calls.jsonl` 互补：这里给 AI 读，那里做审计） |

**顺带被 LogHub 修掉的既有问题**（已在 §15 立项并给出修法）：

1. `dbg_log` 无上限、无轮转、无级别（TODO L3）。
2. BLE 主机日志**无时间戳**；BLE 从机与工作流丢事件**无提示**。
3. ADB（xterm）与 BLE 两套日志**无导出、无落盘**。
4. **完全没有"多路日志汇总导出"的能力** —— `log_export{channels:[…]}` 是全新能力。
5. 前端 `console.*`（69 处）与 Toast（67 处）从未落盘，AI 看不到界面侧告警。

**内存预算**：LogHub 总量默认上限 **32 MiB**，高频通道（serial/wsl/adb）只保尾部文本，不与现有 256KB/4MB 缓冲重复存储。前端那个"100 万行紧凑缓冲（HEX 视图下估算 ~200MB）"是独立的既有问题，不在本期范围。


### 7.3 日志工具与资源

**工具：**

| 工具 | 作用 |
|---|---|
| `log_channels` | 列出所有通道：条数、字节数、seq 区间、丢弃数、最后一条时间 |
| `log_tail` | `{channel, lines=100, since_seq?, format?}` 取尾部 |
| `log_search` | `{channel|all, pattern, regex?, caseSensitive?, since_seq?, limit=100}` 正则/子串检索，返回命中行 + 上下文 N 行 |
| `log_stats` | 速率、字节/秒、错误数、按 level 汇总——"现在是不是在刷屏" |
| `log_clear` | 清空指定通道（写审计记录） |
| `log_mark` | 打一个书签（`{label}`），后续可按书签区间取日志——用于"改配置前后对比" |
| `log_export` | `{channels, format: txt|csv|json|md, path?}` 导出；`path` 省略则落到 `logDir` |
| `log_subscribe` / `log_unsubscribe` | 订阅通道，新行以 `notifications/message` 实时推送（带节流，默认最多 5 条/秒/会话，超出折叠为"另有 N 条"） |

**资源（供客户端按需读取）：** `log://app`、`log://serial/main`、`log://ble`、`log://mcp`，返回最近 500 行的纯文本/JSON，便于 AI 直接 attach。

**防爆措施：** 单次返回上限 256 KiB；超限截断并给 `truncated:true` + 建议缩小范围；HEX 数据默认只回长度与首尾切片（全量需显式 `format:'hex'`，因为 HEX 体积是原始的 2~3 倍）。

---

## 8. AI 配置文件（与用户配置严格隔离）

### 8.1 隔离原则

| 文件 | 谁写 | 内容 |
|---|---|---|
| `%APPDATA%\seahi-serial\config.json` | **只有用户操作** | 界面/设备设置（现状不变） |
| `%APPDATA%\seahi-serial\ai-config.json` | MCP 子系统 | 服务器开关/端口/token/暴露策略/隐私/统计 |
| `%APPDATA%\seahi-serial\ai-calls.jsonl` | MCP 子系统 | **工具调用记录**（追加写，一行一条） |

硬性约束（要有测试保证）：**任何 MCP 工具调用都不得写 `config.json`**（除了"AI 改动照常持久化"这一条——那是前端 `scheduleConfigSave` 的行为，且内容仍是用户配置本身，不含任何 AI 痕迹）。`ai-calls.jsonl` 采用 JSONL 追加而非写进 JSON 数组，理由：高频追加不必重写整个文件、崩溃不损坏已有记录、方便外部 `grep`/`jq`。

**写入方式（不要重犯 M7）**：代码评估文档 `CODE_REVIEW_FULL_2026-09.md` 的 **M7** 记录过一次真实事故——"配置非原子写 + `load_config` 把读取失败等同首次运行 → 半截 JSON 让配置静默全丢"。所以：

| 文件 | 写策略 |
|---|---|
| `ai-config.json` | **原子写**：写 `ai-config.json.tmp` → `fsync` → `rename` 覆盖。解析失败时**保留原文件**并告警，绝不回退成默认值覆盖 |
| `ai-calls.jsonl` | `OpenOptions::append` 追加单行（< PIPE_BUF 级别的小心处理），不重写；轮转时 rename 旧文件 |

`stats` 这类高频小改动一律"内存累计 + 定时落盘"，不做每次调用一写。

### 8.2 `ai-config.json` schema（v1）

```json
{
  "version": 1,
  "server": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 7777,
    "portRange": 20,
    "transport": "sse",
    "streamableHttp": true,
    "token": "32字节hex",
    "maxSessions": 4,
    "heartbeatSecs": 15
  },
  "expose": {
    "bridgeTools": true,
    "semanticTools": true,
    "autoControlTools": false,
    "namespaces": ["serial", "ble", "adb", "wsl", "ui", "log", "mcp"],
    "maxTools": 0
  },
  "policy": {
    "dangerousTools": "confirm",
    "requireConfirmFor": ["serial_send", "serial_open", "ble_connect", "adb_shell", "log_export"],
    "readOnly": false,
    "rateLimitPerMin": 60
  },
  "privacy": {
    "includeSendHistory": false,
    "includeQuickCmds": true,
    "logRedactPatterns": ["(password|token|secret)\\s*[:=]\\s*\\S+"]
  },
  "persistAiChanges": true,
  "callLog": {
    "enabled": true,
    "includeArgs": true,
    "includeResults": false,
    "maxPayloadChars": 2048,
    "maxFileMiB": 32,
    "rotateKeep": 3
  },
  "stats": { "totalCalls": 0, "byTool": {}, "firstCallAt": null, "lastCallAt": null }
}
```

### 8.3 调用记录（`ai-calls.jsonl`）

一行一条，字段：

```json
{ "seq": 17, "ts": "2026-09-13T13:52:48.123+08:00", "session": "8f3c", "client": "claude-desktop/1.2",
  "tool": "ui_set", "args": {"path":"serial.conn.portSelect","value":"COM3"},
  "ok": true, "durationMs": 12, "error": null,
  "effects": [{"path":"serial.conn.portSelect","from":"COM1","to":"COM3"}],
  "result": {"value":"COM3"} }
```

- `effects` 记录**前后值差异**——这是"AI 到底改了什么"的答案，也是排查"我的配置怎么变了"的唯一线索。
- `includeResults:false` 时不写 `result`（结果可能很大或含敏感数据）。
- 轮转：超过 `maxFileMiB` 就 `ai-calls.1.jsonl` … 保留 `rotateKeep` 份。
- 提供工具读取：`mcp_calls{limit, since, tool?, okOnly?}`、`mcp_stats`、`mcp_calls_export{format}`。

### 8.4 统计

`stats` 里维护总量与按工具计数。**注意**：统计值变化很频繁，若每次调用都重写 `ai-config.json` 会造成频繁磁盘写；因此 `stats` 采用**内存累计 + 60s 落盘 + 退出前落盘**（挂到现有 `save-before-exit` 时机）。

### 8.5 ⚠️ 决策点：AI 改动是否持久化

| 方案 | 行为 | 优点 | 缺点 |
|---|---|---|---|
| **(a) 照常持久化（推荐默认）** | AI 改端口/主题 → 与用户操作一样写入 `config.json`，重启保持 | 界面不"反弹"，用户看到的就是实际状态 | 用户配置里混入了"AI 改的值"（但无 AI 痕迹，是合法配置值） |
| (b) 不持久化 | AI 改动只在本次会话生效 | 用户配置绝对干净 | 重启后界面回退，用户困惑；且与 R5 的字面要求也不完全一致（R5 只要求"操作记录"不进用户配置） |
| (c) 可切换 | 默认 (a)，开"沙箱模式"则 (b) | 灵活 | 多一条状态路径要测 |

**建议 (c)**，默认走 (a)：`persistAiChanges: true`。请确认（§13 D3）。

---

## 9. 安全模型

| 面 | 措施 |
|---|---|
| 网络面 | 仅回环；不监听 0.0.0.0；不做 UPnP/端口转发 |
| 鉴权 | 32 字节随机 token，URL 查询串 + `Authorization` 双支持；token 可在界面重置（重置即踢掉所有会话） |
| 危险工具 | `serial_send`（会真发数据）、`serial_open/close`、`ble_connect`、`ble_write`、`adb_shell`、`wsl_map`、`log_export`（写磁盘）默认 `confirm`：调用时后端向前端推确认请求，界面弹"AI 想执行 X，参数…，允许？"，用户点允许才执行，超时 30s 自动拒绝。用户可在 AI 配置里改成 `allow`（信任模式）或 `deny`。 |
| 只读模式 | `policy.readOnly: true` 时所有 `sideEffect` 工具直接拒绝——可以给"只想让 AI 看日志"的场景 |
| 速率/体积 | §4.5 限流 + §7.3 体积上限 |
| 审计 | 每次调用（含被拒绝的）都进 `ai-calls.jsonl`；界面有调用记录面板 |
| 脱敏 | §6.4 / §8.2 `privacy` |
| 提权绕过 | 明确：MCP **不**提供"以管理员身份运行/映射 USB 到 WSL"这类需要 UAC 的操作入口（那类操作仍必须用户手工点） |

---

## 10. 界面改动（AI 相关）

### 10.1 标题栏 MCP 图标（★ 用户指定）

| 项 | 规格 |
|---|---|
| 位置 | `#globalBar` 内、**`#themeStyleWrap`（"风格"下拉，`index.html:2138`）的紧左边**，即插入到 L2137 的 `<span style="flex:1;">` 之后、L2138 之前 —— 正好落在右侧图标组的首位 |
| 元素 | `<span id="mcpBtn" class="add-btn icon-btn" onclick="openMcpModal()" title="MCP 服务器">` |
| 图形 | **不要用 `<img src="…">`**：当初的图形源里 path 硬编码了 `fill="#bfbfbf"`，用 img 引入无法跟随主题换色。做法是把它的 `viewBox="0 0 1024 1024"` 和 `path d` **内联**成 `<svg width="20" height="20" viewBox="0 0 1024 1024" fill="currentColor">`（与相邻的 `#wslToggleBtn`/`#adbToggleBtn`/`#bleToggleBtn` 三个图标同规格），**去掉 `#bfbfbf`** |
| 源文件 | **不留在仓库里**（2026-09 用户要求删除）。图标本体就是 `index.html` 里那段内联 SVG，**那才是唯一真源**；留一份 .svg 只会让人以为改它能生效（其实没有任何地方引用它）。要换图标：把新 svg 给开发方，照同样方式内联。**2026-09 换过一版**（用户给的 `MCP.svg`：螺旋/环状字形，单条 path，开头 `M895.67 256.204`）；内联进 `index.html` 的同时也把仓库根这份图形源换成了同一份，断言里钉住了这个起点，防止回退 |
| 状态可视化 | 图标右下角一个小圆点：未启用(灰) / 监听中(绿) / 有会话(蓝) / 启动失败(红)；`title` 同步为 `MCP 服务器：监听中 127.0.0.1:7777（1 个会话）` |
| 颜色 | `color: var(--text)`（与「风格」下拉 `.sel` 同一个 token），且 `#mcpBtn > svg { opacity:.8 }` —— **同色不等于同观感**：本图形墨量约 27%、调色板约 21%，不压亮度就会显得比旁边那个亮。亮度只能压在 `svg` 上，压父节点会连带压暗状态点 |
| 注册表条目 | `mcp.server.open`（点击=开弹窗）—— 新控件自己也进注册表，形成闭环 |

### 10.2 点击后的弹窗（★ 用户指定）

复用现有模态框结构（`#bleWriteModal` 那套 `.ble-modal-mask` + `.ble-modal` 的外观与"点遮罩关闭"交互；若其 CSS 足够通用就直接复用类名，否则按同结构新增 `.mcp-modal-mask`/`.mcp-modal`）。

**内容随状态变化：**

| 区块 | 未启用时 | 已启用时 |
|---|---|---|
| 标题 | `MCP 服务器` | 同 |
| 状态行 | `已关闭` | `监听中 · 127.0.0.1:7777 · N 个会话`（N 实时刷新）；**悬停**可看版本/工具数/请求数/丢弃数/发现文件路径 |
| 操作按钮（**一个切换按钮**） | **[启用 MCP 服务器]** | **[关闭 MCP 服务器]** —— 同一个按钮，文案写"点了会发生什么"；命令发出期间禁用并显示"处理中…" |
| 三块内容 | 隐藏 | **上下结构**：标题单独一行、内容占满整行；**复制按钮绝对定位在内容框内的右上角**，内容右侧留 64px 让位；**单行的 URL 框内容再整体下移一行**（`padding-top:26px`），不撞按钮。连接 URL / 客户端配置 / 安装提示词 |
| 底部提示 | 隐藏 | 隐藏 |

> **2026-09 用户改的口径**：最初定的是"**启用/关闭两个并排按钮**"（且明确"不要切换开关"），真机看过后改成
> **一个按钮点一下开、再点一下关**。所以断言里原来那条「`不是`一个切换按钮」已经反过来钉成「只有一个
> 切换按钮、两个并列按钮必须不存在」。底部那行"版本 · 工具 · 请求 · 丢弃 · 发现文件"也按用户要求删掉，
> 数字挪进状态文案的悬停提示。

**"安装提示词"给两份内容**（两种用法都需要，建议两个小 tab 或并列两块）：

1. **客户端配置片段**（直接粘进 Claude Desktop / Cursor 配置）：
```json
{ "mcpServers": { "seahi-serial": { "type": "sse",
  "url": "http://127.0.0.1:7777/sse?token=<token>" } } }
```
2. **安装提示词**（自然语言，粘给 AI 让它完成安装/知道怎么用）：
```
请把下面这个 MCP 服务器（SSE 传输）加入你的 MCP 配置并连接：
  URL: http://127.0.0.1:7777/sse?token=<token>
它是本机 "SeaHi Serial" 串口/蓝牙调试器暴露的工具集，包含
ui_list / ui_get_state / ui_set / serial_* / ble_* / adb_* / wsl_* / log_* 等工具。
连上后请先用 ui_list 看一眼当前可用的控件，再决定怎么操作。
```

**一键复制的实现细节：**
- 优先 `navigator.clipboard.writeText`；失败回退到仓库里**已有**的 `fallbackCopy`（`index.html:4197`），不要另写一套。
- 复制后按钮文案短暂变"已复制"（复用 Toast 也行）。
- ⚠️ **复制出去的内容必须带 token**，否则粘到客户端直接 401 连不上 —— 这是最容易出错的细节。
- 关闭 MCP 时应把 URL/提示词区块收起，并明确提示"当前地址已失效"。

### 10.3 危险操作确认弹窗

§9 的 `confirm` 策略落地点，样式同 §10.2：内容为"AI 想执行 `serial_open`，参数 {…}，是否允许？"，按钮 [允许] / [拒绝]，30s 无操作自动拒绝，结果回给 AI（错误码 `-32003`）。

### 10.4 进阶界面（可选，见 §13 D4）

调用记录列表（时间/工具/参数/耗时/成败/effects，可筛选、导出、清空）与控件浏览器（树形展示注册表全部条目 + 对应 MCP 工具名，用来确认"每个控件都是工具"）信息量较大，建议作为 §10.2 弹窗的第二个 tab，或独立成"设置 → MCP"页面。

### 10.5 空状态引导

没启用过时，弹窗里除了开关，给一句话说明 + 一个"去复制配置"的引导；不弹二次引导遮罩，避免打扰。


---

## 11. 测试与验收

| 层 | 内容 |
|---|---|
| Rust 单测 | JSON-RPC 编解码与错误码；`initialize`/`tools/list`/`tools/call` 路由；工具名生成与去重（含 64 字符截断）；token 鉴权（正确/错误/缺失）；LogHub 环形覆盖与 `seq`/`dropped` 语义；`ai-config.json` 读写与默认值迁移；**隔离性断言：执行一批工具后 `config.json` 的 mtime 与内容不变** |
| 前端无头断言 | 扩展现有 `.walkthrough/` 风格，新增 `gen_mcp_preview.js`：<br>· 注册表覆盖率——**每个** `[onclick]`/`button`/`input`/`select` 都能解析出 path（否则列出漏网的，作为 CI 门禁）<br>· 路径唯一性、命名正则合规<br>· `read`/`write` 往返一致（写进去再读出来等于写后的规范值）<br>· 每个条目有 label、kind、panel<br>· 危险控件都被标了 `dangerous`/`aiPolicy` |
| 端到端 | `.walkthrough/mcp_e2e.js`：起应用（或起一个只跑 server 的测试模式）→ SSE 连接 → `initialize` → `tools/list` → 调 `ui_set` 改主题/选端口 → `ui_get_state` 断言界面状态已变 → 读 `ai-calls.jsonl` 断言有记录 → 断言 `config.json` 未被 AI 记录污染 |
| 手工验收 | 用真实 Claude Desktop / Cursor 连一次，跑通"AI 选端口→开串口→发 AT→读日志"全链路 |
| CI | 在 `build.yml` 里加 `cargo test` + 两个 node 断言脚本；MCP 相关失败不阻塞发布（标记为可选阶段，稳定后再转为门禁） |
| **稳定性/内存** | §4.9 的五项必须自动化：**慢消费者浸泡**（RSS 增幅 < 10 MiB + 会话被断开 + **主界面串口收发不受影响**）、LogHub 溢出与 `dropped`、在途命令泄漏与 janitor、启停 50 次幂等、工具 panic 不致命 |

---

## 12. 分阶段实施计划

| 阶段 | 内容 | 产出/验收 | 估时 |
|---|---|---|---|
| **P0.5 既有问题热修** | **L3**（`dbg_log` 加 4 MiB 上限 + 轮转 + 开关）、**M28**（会话缓存单文件 8 MiB 上限 + 目录总预算 64 MiB）、**M29**（前端紧凑缓冲改字节预算 + 裁剪后压缩容量 + DOM 清理由"跳过"改"延后+硬上限"）→ **先发 0.4.2** | 磁盘与内存都不再随时间无限增长；不依赖 MCP | 0.5~1 天 |
| **P0 骨架** | 加 `axum`；起服务器；token/端口/发现文件；`initialize`、`tools/list`、`ping`；生命周期挂 `setup`/`CloseRequested`+补 `RunEvent::Exit`；**标题栏 MCP 图标 + 开关弹窗（URL / 安装提示词 / 一键复制，§10.1-10.2）** | 客户端能连上并看到空工具列表；弹窗里能开关、能复制出可用配置 | 1.5~2 天 |
| **P1 桥 + 同步** | 控件注册表（自动发现 + 关键项元数据）；`ui_*` 8 个工具；oneshot 回执；回声抑制；`ui_get_state`/`ui_apply_state` | AI 能改主题、切页面、选端口，界面实时反应 | 2~3 天 |
| **P2 全量工具** | `ctl_*` 自动生成 + 命名空间裁剪 + 控件浏览（弹窗第二 tab，§10.4） | 每个控件都有对应工具（可验证） | 1~1.5 天 |
| **P3 语义工具** | ~50 个手写语义工具（串口/BLE/ADB/WSL 高频操作） | "开端口→发 AT→看回显"一句话完成 | 2~3 天 |
| **P4 日志中心** | 后端 LogHub + 通道接入（串口/BLE/ADB/WSL/app）+ 前端回灌 + `log_*` 8 个工具 + 订阅推送 + 资源 | AI 能 tail/search/订阅/导出日志 | 2~3 天 |
| **P5 AI 配置与安全** | `ai-config.json` + `ai-calls.jsonl` + 统计落盘 + 危险确认弹窗 + 只读模式 + 脱敏 + 调用记录面板 | 记录与隔离可验证；危险操作需确认 | 2 天 |
| **P6 npm 安装器（A 方案）** | `npm/seahi-serial-mcp/`：零依赖 CLI（`install`/`status`/`uninstall`/`--dry-run`）+ 端点发现与 `/healthz` 探活 + **逐客户端路径核实** + 备份/原子写/JSONC 兜底 + diff 自动化断言（§3.5） | 一条命令配好客户端；应用没跑时拒绝写入 | 1 天 |
| **P7 加固与文档** | 限流/超时/体积上限、错误码统一、`doc/MCP.md` 用户手册、`AGENTS.md`/`README`/`RELEASE_NOTES`、CI、版本 0.5.0 | 可发布 | 1.5~2 天 |

合计约 **15~20 人天**。P0+P1 是关键路径，做完就有"AI 能操作界面"的最小闭环（约 4~5 天）。

**版本与兼容**：`0.5.0`（新功能）。MCP 默认**开启**，但 `policy.dangerousTools` 默认 `confirm`，且只监听回环——对现有用户无感、无风险。若你希望更保守，可以默认 `server.enabled: false` 让用户手动开。

---

## 13. 需要你拍板的决策点

| # | 决策 | 我的建议 |
|---|---|---|
| D1 | 是否同意"合成 DOM 事件"作为工具改界面的唯一实现路径 | ✅ 推荐：天然同步、零逻辑重复、不用改 172 处 onclick |
| D2 | 工具暴露策略：默认 A+B（桥+语义，~58 个工具）还是 A+B+C（全量控件，数百个） | 默认 A+B，C 做开关。要"字面意义上每个控件都是工具"就默认开 C，但会影响 AI 的工具选择准确率 |
| D3 | AI 改动是否持久化到用户配置 | 默认持久化（否则界面反弹），"沙箱模式"可关 |
| D4 | MCP 的**进阶信息**（调用记录、控件浏览）放哪 | 入口已定：标题栏图标 + 弹窗（§10.1-10.2）。进阶信息建议做成该弹窗的**第二个 tab**，不另开面板 |
| D5 | 危险工具默认策略：`confirm`（弹窗确认）还是 `allow`（信任） | `confirm` |
| D6 | 是否需要托盘（关窗不退出，MCP 继续服务） | 本期不做；AI 依赖应用常开，托盘是另一个需求 |
| D7 | 是否要把 MCP 也做成"可被外部脚本调用的 HTTP API"（非 MCP 协议） | 不做，避免扩大攻击面；MCP 已够用 |
| D8 | 你说的"界面风格等"是否包含**字号 / 密度 / 缩放** | 实测**目前完全没有**这些项（主题只切颜色，`html,body` 固定 `font-size:14px`，xterm 硬编码 `fontSize:13`）。如果只要 12 套配色，现有 `ui_set_theme` 就够；如果字号也要能被 AI 调，需先实现它（新增 `--font-size`/`--density` 变量 + 改 `index.html:1019` 与 xterm 参数）—— 这是一块**独立小需求**，建议放 P2 之后单独排 |
| D9 | §10.2 的"安装提示词"具体给哪种 | 建议**两份都给**：① 客户端配置 JSON（直接粘进 Claude/Cursor）② 自然语言安装提示词（粘给 AI）。两者都带 token、都能一键复制 |
| D10 | 端口策略：固定默认 7777（占用则递增并把**实际端口写回 ai-config**）vs `127.0.0.1:0` 动态分配 | 建议**固定 + 回退**。动态端口虽然零冲突，但 URL 每次启动都变，**用户粘过一次的客户端配置下次就失效**，与"显示连接 URL 供复制"的诉求冲突 |
| D11 | MCP 是否要做成 npm 包形态 | **服务器必须留在应用进程内**（§3.4）。只建议做"客户端配置安装器"那一个 npm 包；**已定：只做客户端配置安装器（§3.5）** |
| D12 | 是否给"应用"加一条 npm 分发渠道（postinstall 自动下载 exe/msi） | 不推荐（会丢掉 MSI 的快捷方式/卸载/WebView2 引导/usbipd 打包），且与本 MCP 功能无关，属独立需求 |
| D13 | **L3b 上报脱敏**（上报上下文含本地路径与用户名）要不要跟 L3a 一起做 | 建议做。属隐私而非内存/磁盘，改动只在 `report_error`（`main.rs:107-121`）与 payload（`55-61`），成本很小；但要单独测，别和轮转混在一个提交里 |
| **D14** | **紧凑存储 8 MiB 上限**与"完整日志"语义的冲突：紧凑存储由 `4ba545a`（v0.2.5）引入，其注释写明目的是"保留完整日志、不受 DOM maxLines 限制"，即**专门给「导出 / 复制全部」提供完整内容**；M29 把上限从 **100 万行**收紧到 **8 MiB（≈20 万行）** | 三选一：**A** 维持现状（内存优先，接受长会话丢中段）／**B** 内存上限放宽到 **32 MiB**（改一个常量，仍是有界的）／**C** 内存那份保持小、把"完整日志"职责交给**磁盘**缓存，并实现"从磁盘导出"（`list_log_cache` 早已注册却从未被前端调用，正好用起来）。**倾向 C，B 最省事** |
| **D15** | 初始容量 64 KB（M29-d）是否过于激进 | 可折中到 `TEXT_BUF_INIT = 256 KB` / `TEXT_IDX_INIT = 16384`：单监视器 92 KB → 约 300 KB（**仍比 1,707 KB 省 82%**），扩容次数 7→5。改两个常量即可 |
| **D16** | 「清空输出」现在会**立刻**把容量收回到 64 KB（M29-d 新增），若清空属高频动作会反复扩容 | 若确认高频，可改为"清空后空闲一段时间再回收"，而不是当场回收 |

---

## 14. 已知风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 沙箱/受限环境下无法绑定本地端口 | 无法在本机自测服务 | 实现期先在普通会话验证；Rust 单测不依赖真实端口（用 `tools/call` 直接走 Router） |
| 前端控件没有稳定 id 的比例偏高 | 自动生成工具质量差 | P1 先跑"待补元数据清单"，关键控件手工补 `data-mcp`；其余允许 `misc.hash` 兜底 |
| 高频串口数据把 IPC 打爆 | UI 卡顿、日志丢失 | 日志回灌批量节流 + LogHub 环形上限 + 订阅推送限速 |
| AI 反复调用造成界面抖动 | 体验差 | 限流 + `effects` 去重（同值写入短路） |
| 工具数量过多拖累模型 | AI 选错工具 | 分层暴露 + `ui_list` 检索式发现 |
| `write` 触发的渲染是异步的 | 读到旧值 | 回执在 `requestAnimationFrame`/`setTimeout(0)` 后读回真实值 |
| **堆快照变小 ≠ 进程内存变小** | V8 的 ArrayBuffer 分配器不保证把释放的内存归还 OS，可能出现"堆快照降了、任务管理器不降"，使 M29-d 的收益落空 | **必须实测 RSS**（任务管理器）而不只看堆快照；若不降，需重新评估本次调整的意义（见 §17 遗留待定项） |
| 内存与磁盘两处上限**从相反方向**截断（内存留**结尾**、磁盘留**开头**），各 8 MiB | 文本超过 ~8 MiB 的会话，**中段两边都没有** | 见 §13 **D14**（倾向把磁盘那份放开，由磁盘承担"完整日志"职责） |

---

## 15. 顺带一起修：三项既有内存/磁盘问题（先发 0.4.2）

这三项**都不是 MCP 引入的**，但都是**会随时间恶化**的问题（磁盘被写满、内存被吃光），而且与 P4 日志中心改的是同一批代码路径，所以一起修。**独立成 0.4.2 先发**，不绑在 MCP 上 —— MCP 若延期，用户也已经拿到修复。

### L3 · `dbg_log` 无上限、无轮转、无开关

**现状**（`main.rs:16-26`，**58 处调用**）：每次调用 `OpenOptions::create(true).append(true)` 打开 → 写 → 关闭，**从不检查大小**，错误被 `let _ =` 静默吞掉。格式 `[<unix毫秒>ms] <msg>\n`。Release 版也一直往 `%TEMP%\seahi-serial-debug.log` 写。

**修法**（保留"每次开/写/关"这个崩溃安全的模式，只加**上限 + 轮转 + 开关**）：

| 项 | 方案 |
|---|---|
| 常量 | `DEBUG_LOG_MAX_BYTES = 4 MiB`，保留 1 份 `.1` 备份 |
| 计数器 | `static DEBUG_LOG_BYTES: AtomicU64`，用 `OnceLock` 在首次调用时以文件**真实大小**初始化（避免每次 `metadata()` 系统调用） |
| 并发 | `static DEBUG_LOG_LOCK: Mutex<()>` 包住"检查-轮转-写"；本来就有文件 I/O，加锁开销可忽略，且避免两个线程同时轮转 |
| 轮转 | 删旧 `.1` → 把当前文件 rename 成 `.1` → 计数器归零 → 新建 |
| 开关 | `SEAHI_DEBUG_LOG=0` 时整体跳过（压测/排查性能时用） |
| **不做** | 不改常驻句柄、**不引入 `log`/`tracing`**（那是 P4 LogHub 的活）、不改任何调用点的语义 |

> L3 原文还含"**上报前脱敏**"（上报上下文里有本地路径与用户名）。那属于**隐私**而非内存/磁盘，改动点在 `report_error`（`main.rs:107-121`）与上报 payload（`55-61`）。要不要一起做 → **§13 D13**。

### M28 · 会话日志缓存：只限文件数，不限单文件大小

**现状**（`main.rs:3064-3213`）：`LOG_CACHE_MAX_COUNT = 10` —— **只限个数**；`enforce_log_cache_limit()` 只在**新建文件时**跑一次，且只按个数删最旧；`append_log_cache()` 每次追加后 `flush()`，**完全不计字节**。按 921600 波特 ≈ 92 KB/s 算，单会话 1 小时约 **330 MB**，10 个文件最坏 **GB 级**。

| 项 | 方案 |
|---|---|
| 结构 | `LogCacheSession`（3072）增加 `bytes: u64` 与 `capped: bool` |
| 单文件上限 | `LOG_CACHE_MAX_BYTES = 8 MiB`；超限时**写一行终止标记**（`--- 已达上限 8 MiB，后续内容不再写入 ---`）、置 `capped = true`、之后不再追加 |
| 目录总预算 | 新增 `LOG_CACHE_MAX_TOTAL_BYTES = 64 MiB`；`enforce_log_cache_limit` 改为**同时**满足"个数 ≤ 10"与"总字节 ≤ 64 MiB"，从最旧开始删 |
| 让用户知道 | 触顶时 `dbg_log` 记一条 + 向该监视器提示一次（复用现有 sys 行/Toast），**不静默**（别重演 BLE G8 那种静默丢弃） |
| ⚠️ 幂等 | `start_log_cache` 是幂等的（重连复用同一文件），所以 `bytes` **只在新建文件时置 0**，之后累加；**不要**每次 append 都去 `metadata()` |

### M29 · 前端紧凑缓冲：100 万行才裁剪 + 容量永不收缩 + DOM 清理可被无限跳过

**现状**（`index.html`）是三个问题叠在一起：

1. **`bufferPush`（4546）**：`if (m._textCount > 1000000) bufferTrimOld(m, 500000)` —— **100 万行**才裁一次，裁完还剩 50 万行。
2. **`_textData` 按 2 倍扩容且永不收缩（4556-4560）**：容量最大可到活跃数据的 2 倍，而扩容瞬间要同时持有"旧 + 新"两份 → **瞬时峰值可达活跃数据的 3 倍**。`_textOffsets`(`Uint32`)、`_textTypes`(`Uint8`)、`_textTsLens`(`Uint16`) 也各自翻倍：满 100 万行时 ≈ 4+1+2 = **7 MB**，容量翻倍后 **14 MB**。
3. **DOM 清理可被无限跳过（4304-4317）**：`softLimit = 15000`，但只要 `scrollTop < 100`（用户在顶部看历史）**或**"有任何选区"，清理就**整个跳过** → DOM 行数无上限增长。每行是**真实 DOM 元素**，比字节缓冲贵得多。

**修法**：

| # | 方案 |
|---|---|
| a | **改为按字节预算**：新增 `_textDataMaxBytes`（默认 **8 MiB**）；`_textDataLen` 超预算时按行裁到**一半字节**（不再按"50 万行"）。字节预算才反映真实内存 —— 20 字节的行和 4 KB 的行完全不是一个量级 |
| b | **裁剪后压缩容量**：当 `_textData.length > 2 × _textDataLen` 时重新分配到 `_textDataLen`（向上取整到 2 的幂），并同步压缩三个索引数组 —— 让容量**跟随**活跃数据，而不是单调增长 |
| c | **DOM 从"跳过"改成"延后 + 硬上限"**：保留"保护用户正在看的内容"的意图，但 ① 设 `hardLimit`（如 30000 行）**无论如何都裁**，并做**滚动补偿**（记"距底部距离"，裁完恢复，视觉不跳）；② 有选区时**延后**而非永久跳过：加 `selectionchange` 监听，选区一消失就补裁 |
| d | **已做（有实测依据）**：`_textData` 与三个索引数组改为**小容量起步**（`TEXT_BUF_INIT = 64 KB` / `TEXT_IDX_INIT = 4096`），`bufferCompactCapacity` 的收缩下限同步改为这两个值，「清空输出」时也回收容量。<br>依据：Chrome 堆快照里两个监视器的「Typed arrays」占 **3,502 kB ≈ 2 × 1,707 kB**，而这 1,707 kB 全是**预留未用**的容量 |

**修 M29 时顺带发现并修掉的两个既有 bug**（都是"平时看不出来、量到了就出事"）：

| # | bug | 影响 | 修法 |
|---|---|---|---|
| **B1** | `bufferPush` 扩容索引数组时**没拷贝旧数据**（`new Uint32Array(newSize)` 零填充后直接替换） | 一旦触发，已积累的偏移表被清零 → 保存 / 复制 / 历史加载读到错乱数据。原来要 **10 万行**才踩到，**容量调小后会变成 4096 行**就爆 | 扩容时 `set()` 拷旧值；数据缓冲扩容改成 `Math.max(翻倍, 实际需要)`（只翻倍时，单行比容量大就会 `set` 越界抛错） |
| **B2** | 两条 WSL 监视器创建路径（`addWslMonitor` / `initWslMonitor`）**没设 `_textDataMaxBytes`** | 裁剪入口统一成 `bufferEnforceBudget` 后，`len <= undefined` 恒为 false、`undefined >> 1` 为 0 → **每写一行就把 WSL 的紧凑缓冲裁到只剩 1 行**（保存 / 复制全废）。这是**本次改动引入**的 | 两处补上预算字段；并给 `bufferEnforceBudget` 加防御：字段非法时回退默认 8 MiB，而不是裁空 |

**验证**：三个场景各跑一次看任务管理器内存曲线 —— ① 长时间高频收数据 ② 停在顶部不动 ③ 挂着选区 —— 断言内存**收敛到平台期**而不是持续爬升（用 §11 的浸泡测试方法）。

---

## 16. MCP 开发执行计划（施工级）

> §12 是"分几期、各多少天"；本节是"**按什么顺序动手、每步的产出与验证门**"。

### 16.1 三条推进原则

1. **先能连上 → 再能操作 → 最后才完备。** C 层全量工具是"完备性"，A/B 层才是"可用性"；不要一上来就生成几百个工具。
2. **每一步都要能独立验证、独立提交**，不留"三期都做完才能跑"的中间态。
3. **纯逻辑先测，真机后验。** 协议层、注册表、LogHub、AI 配置都能在不依赖端口与设备的前提下做单测。

### 16.2 每步：产出 / 涉及文件 / 验证门

| 步骤 | 产出 | 涉及文件 | **验证门（过了才进下一步）** |
|---|---|---|---|
| **S0 依赖探路** | `cargo tree` 确认 axum 0.8 与现有 `tower 0.5.3`/`hyper 1.10.1` 不冲突，记录真实新增的包 | `src-tauri/Cargo.toml` | 新增依赖 ≤ 6、**无重复版本**；`cargo build` 通过 |
| **S1 协议内核** | JSON-RPC 编解码 + 错误码 + `initialize`/`ping`/`tools/list` 分派；**直接调 Router 的单测**（不绑端口） | `mcp/{mod,protocol}.rs` | `cargo test` 全绿；断言协议版本协商与各错误码；**完全不需要端口** |
| **S2 传输与鉴权** | `/sse` + `/messages` + `/healthz` + token；写出 `mcp-endpoint.json` | `mcp/transport.rs` | ⚠️ **必须你在本机跑**：`curl` 能收到 `event: endpoint`；错 token 得 401；`/healthz` 不含任何信息 |
| **S3 生命周期 + 界面** | 挂 `setup()`；`CloseRequested` 优雅关闭；补 `RunEvent::Exit`；标题栏图标 + 弹窗（开关/URL/提示词/一键复制） | `main.rs`、`index.html`、`mcp/mod.rs` | 开关幂等（反复 20 次）；关窗无残留；**弹窗复制出来的配置能真的连上** |
| **S4 注册表** | `data-mcp` 注入 + `MCP_CONTROL_META` + 运行时采集 + 路径唯一性 | `index.html`、`.walkthrough/gen_mcp_preview.js` | `node .walkthrough/gen_mcp_preview.js` 断言：**每个 `[onclick]`/`button`/`input`/`select`/`textarea` 都能解析出 path**、路径唯一、命名合规 |
| **S5 前端桥** | `ui_*` 8 个工具；oneshot 回执 + 5s 超时；回声抑制；`ui_get_state`/`ui_apply_state` | `mcp/bridge.rs`、`index.html` | 单测覆盖超时回收/busy/饱和拒绝；⚠️ 本机：**改主题、选端口 → 界面实时反应** |
| **S6 全量 + 语义工具** | `ctl_*` 生成 + 命名空间裁剪；~50 个语义工具 | `mcp/{registry,tools}.rs` | `tools/list` 分页与 64 字符截断去重单测；语义工具逐条对齐 §2.4 的 85 个命令 |
| **S7 日志中心** | LogHub + 8 条通道的生产端旁路 + 前端回灌 + `log_*` + 订阅 | `mcp/loghub.rs`、`main.rs`、`index.html` | 溢出/`dropped`/`since_seq` 单测；**慢消费者浸泡测试**（§4.9 第 1 项） |
| **S8 AI 配置与安全** | `ai-config.json`、`ai-calls.jsonl`、统计落盘、危险确认、只读、脱敏 | `mcp/aiconfig.rs`、`index.html` | **隔离性断言**：跑一批工具后 `config.json` 内容与 mtime 不变；原子写/崩溃安全；确认弹窗超时自动拒绝 |
| **S9 npm 安装器** | `npm/seahi-serial-mcp/`（§3.5） | 新目录 | 样本文件 diff 断言；应用未运行时拒绝写入；JSONC 失败不破坏原文件 |
| **S10 收紧** | §4.9 五项全绿；CI 门禁；文档；0.5.0 | 全仓 | 慢消费者浸泡 RSS 增幅 < 10 MiB 且**主界面不受影响**；启停 50 次幂等 |

**里程碑**：**M1 = S0~S5**（AI 能改界面 + 读状态）→ **M2 = S6**（AI 能完成一次真实调试）→ **M3 = S7**（AI 能读日志诊断）→ **M4 = S8~S10**（可交付）。

### 16.3 分工：哪些我做、哪些必须你来

| 类别 | 内容 |
|---|---|
| **我能独立做完并自测** | Rust 单测（直接调 Router，不绑端口）、前端无头断言、npm 安装器的样本文件测试、文档、`cargo build` |
| **必须你在本机验证**（我会给可直接粘贴的命令 + 期望输出） | ① 真实端口绑定与 SSE 连接（沙箱可能禁止 bind）② 界面对合成 DOM 事件的反应 ③ 真机串口/BLE 全链路 ④ RSS 浸泡测试 ⑤ 与你实际 AI 客户端联调 |

每一步做完我会给一份"验证清单"，你跑完把输出贴回来再进下一步 —— 避免出现"代码写完了，但你这边一次都没真跑过"。

### 16.4 版本与提交策略

- **0.4.2**：只含 §15 的三项热修（L3 / M28 / M29），**与 MCP 无关，先发**。
- **0.5.0**：MCP 全套。若想按里程碑发预览版，需先改 CI —— 现在 tag 必须是 `v{版本}` 且**直接发正式 Release**（`prerelease: false`），要发 `-beta.1` 得先动 `.github/workflows/build.yml`（顺带处理 M24：`workflow_dispatch` 用分支名当 tag 的问题）。**这是动工前要确认的一件事。**
- 提交粒度：每步一个可独立回滚的提交；**前后端同改时放同一个提交**（否则注册表与服务端工具表会不一致）。

### 16.5 动工前要落定的不确定项

| # | 事项 | 怎么确认 |
|---|---|---|
| 1 | 沙箱能否绑定本地端口 | S2 第一个动作就试；失败则 S2 起全部由你在本机验证 |
| 2 | axum 0.8 的实际依赖解析 | S0 跑 `cargo tree` |
| 3 | MCP 客户端的 `protocolVersion` 协商行为 | 与你实际客户端联调时观察；我无法联网核对规范 |
| 4 | `completion/complete` 在各客户端的支持度 | 可能白做，先只留扩展点 |
| 5 | 是否发 0.5.0-beta（需先改 CI） | §16.4，等你定 |
| 6 | 是否连带做 L3b 上报脱敏 | §13 D13 |

### 16.6 剩余语义工具的施工计划（BLE / ADB+WSL / 全局 / 危险确认）

> S0~S12 已落地（基础设施 + 串口语义 12 个 + 日志中心 + 只读模式 + npm 安装器）；
> 2026-09-13 的 S12 记录里写着"**还没做**：BLE（第二批）、ADB/WSL（第三批）、全局（第四批），
> 以及危险动作的二次确认"。本节把那四块补成**施工级**：每个工具给入参/返回契约、读写分类、
> 危险级别与验证门，照它就能一步步做、一步步验。

#### 16.6.0 每批都要先做的三件共用事

| # | 事 | 说明 |
|---|---|---|
| 1 | **Rust 侧 `xxx_call(core, action, args, extra)`** | 抄 `serial_call`：拼 `{action, pane?}` → `core.ui_call("<面板>", payload)`。BLE/ADB/WSL 各自的 op 名**只在前端定义一处**，Rust 只转发 —— 工具名到 op 的映射写在 `protocol.rs` 的分派里（与 `serial_quick_cmd` 同款） |
| 2 | **前端 `mcpBleOp/mcpAdbOp/mcpWslOp`** | 与 `mcpSerialOp` 同构：一个 `action` 分支表，**每个分支都调面板按钮走的那个函数**（AGENTS #3）；只读的 `*_get_state`/`*_list_*` 不许有任何副作用 |
| 3 | **三处断言一起加** | ① Rust：`every_tool_has_a_tested_return_contract` 的表加行 + 假前端用例（钉住 op/参数与返回形状）② 前端：`index.html` 里每个 op 都有分支（跨端断言，已有骨架）③ 危险工具表断言（见 16.6.4） |

#### 16.6.1 第二批：BLE 语义工具（`ble_*`，估 1.5~2 天）

BLE 面板有两套完全不同的东西：**主机**（当中央去连别人的设备）与**从机**（把自己变成外设，
对外广播服务）。工具按这两组划分，名字前缀都带 `ble_` 以免与串口的混。

| 工具 | 对应后端命令 / 前端动作 | 入参 | 返回（顶层字段） | 分类 |
|---|---|---|---|---|
| `ble_get_state` | `ble_get_adapters`+`ble_get_connection`+`ble_get_mtu`+扫描状态 | `pane?` | `{pane, adapters[], connected, device, mtu, scanning, scanSecs, notifyCounters}` | 读 |
| `ble_list_devices` | 扫描结果（内存里的列表，不触发扫描） | `pane?`, `limit?` | `{pane, total, devices:[{mac,name,rssi,paired,services}]}` | 读 |
| `ble_start_scan` | 面板的"开始扫描" | `pane?`, `seconds?` | `{pane, scanning, seconds, devicesAfterWait}` | **写**（射频） |
| `ble_stop_scan` | "停止扫描" | `pane?` | `{pane, scanning:false, devices}` | 写 |
| `ble_connect` | 从列表连 / `ble_connect_direct`（按 MAC 直连） | `pane?`, `mac?`（省略=连列表里选中的那条） | `{pane, connected, device, mtu, services}` | **写**（占设备） |
| `ble_disconnect` | `ble_disconnect` | `pane?` | `{pane, connected:false, keptValue}` | 写 |
| `ble_get_services` | `ble_get_services`（服务/特征树） | `pane?` | `{pane, services:[{uuid,name,chars:[{uuid,props,descs}]}]}` | 读 |
| `ble_read` | `ble_read`（特征）/ `ble_read_descriptor`（描述符） | `pane?`, `char` 或 `descriptor` | `{pane, uuid, bytes, hex, text}` | 读（但会占用链路） |
| `ble_write` | `ble_write` / `ble_write_descriptor`（含"带响应/不带响应"） | `pane?`, `char`/`descriptor`, `data`, `asHex?`, `withResponse?` | `{pane, uuid, written, bytes, mode}` | **写** |
| `ble_subscribe` | 订阅/退订通知 | `pane?`, `char`, `on` | `{pane, uuid, subscribed}` | 写 |
| `ble_get_output` | **复用 LogHub 的 `ble:rx` 通道**（与 `serial_get_output` 同一套纪律：不在前端另存一份） | `pane?`, `sinceSeq?`, `limit?` | `{pane, count, items:[{seq,ts,uuid,hex,text}], truncated}` | 读 |
| `ble_refresh_rssi` | `ble_refresh_rssi` | `pane?` | `{pane, mac, rssi}` | 读 |
| `ble_pair` / `ble_pair_respond` | `ble_pair` / `ble_pair_respond` | `pane?`, `accept?` | `{pane, pairing, prompt, answered}` | **写**（系统弹窗） |
| `ble_periph_status` | `ble_periph_status` | `pane?` | `{pane, advertising, mode, chars:[{uuid,value,notifying,subscribers}], pendingWrites}` | 读 |
| `ble_periph_start` / `ble_periph_stop` | 从机开始/停止广播 | `pane?` | `{pane, advertising}` | **写 + 危险**（对外广播） |
| `ble_periph_set_value` | `ble_periph_set_value`（改某个特征的值） | `pane?`, `char`, `data`, `asHex?` | `{pane, uuid, value}` | 写 |
| `ble_periph_notify` | `ble_periph_notify`（主动推给订阅者） | `pane?`, `char`, `data?` | `{pane, uuid, subscribers, sent}` | 写 |
| `ble_periph_respond_write` | `ble_periph_respond_write`（手动应答中心设备的写） | `pane?`, `accept` | `{pane, answered}` | **写 + 危险**（放行外部写入） |
| `ble_periph_import_config` / `export_config` | `ble_periph_pick_config_file` / `save_config_file` | 无路径入参！ | `{pane, path|null, chars}` | 写（走原生框） |

**验证门**：① 以上每个都有返回契约 + 假前端用例；② `ble_periph_start` 在只读模式被拦、
在**危险确认**下才执行（16.6.4）；③ 前端无头断言里补"每个 `ble_*` op 都有分支"；
④ 真机验证只能你来（沙箱没有蓝牙适配器）：扫描→连接→读特征→订阅→收通知 走一遍，
把 `ble_get_state` 的输出贴回来。

#### 16.6.2 第三批：ADB / WSL 语义工具（估 1 天）

| 工具 | 对应 | 入参 | 返回 | 分类 |
|---|---|---|---|---|
| `adb_list_devices` | `adb_devices` | 无 | `{total, devices:[{serial,state,model}]}` | 读 |
| `adb_open_shell` | `adb_open_shell` | `serial?` | `{serial, opened, cols, rows}` | **写 + 危险**（在设备上开 shell） |
| `adb_shell_write` | `adb_shell_write` | `data`, `asHex?` | `{serial, written, bytes}` | **写 + 危险**（真的执行命令） |
| `adb_shell_read` | `adb_shell_read`（也复用 loghub `adb:rx`） | `sinceSeq?`, `limit?` | `{serial, count, items, truncated}` | 读 |
| `adb_shell_resize` | `adb_shell_resize` | `cols`, `rows` | `{serial, cols, rows}` | 写 |
| `adb_close_shell` | `adb_shell_close` | 无 | `{serial, opened:false}` | 写 |
| `wsl_get_state` | `get_wsl_distributions` + `get_wsl_serial_devices` + 映射状态 | 无 | `{distros[], devices[], mapped[], monitorOpen}` | 读 |
| `wsl_map_device` / `wsl_unmap_device` | usbipd 映射（**要管理员**） | `busid` | `{busid, mapped}` | **写 + 危险**（动宿主机的 USB 挂载） |
| `wsl_open_monitor` / `wsl_close_monitor` | WSL 监视器开关 | `pane?` | `{pane, isConnected}` | 写 |
| `wsl_send` / `wsl_get_output` | 同串口的 `serial_send`/`serial_get_output`（通道前缀 `wsl:`） | 同串口那套 | 同串口那套 | 写 / 读 |

**验证门**：① `busid` 只接受 `get_wsl_serial_devices` 报出来的那种格式（**不接受路径/任意串**）；
② 危险工具（map/unmap/open_shell/shell_write）走确认机制；③ 真机验证由你跑（要 WSL + usbipd）。

#### 16.6.3 第四批：全局 / 应用级工具（估 0.5 天）

| 工具 | 对应 | 入参 | 返回 | 分类 |
|---|---|---|---|---|
| `app_get_theme` | 当前主题（12 套） | 无 | `{theme, dark, themes[]}` | 读 |
| `app_set_theme` | 主题切换 | `theme`（必须是 `themes` 里的值） | `{theme, applied}` | 写 |
| `app_get_window` | 窗口几何（与 `ui_get_state(window)` 同一份数据） | 无 | `{width, height, maximized}` | 读 |
| `app_set_window` | 尺寸/最大化 | `width?`, `height?`, `maximized?` | `{width, height, maximized}` | 写 |
| `app_get_update` | 检查更新（**唯一会出网的读工具**） | 无 | `{current, latest, hasUpdate, notesUrl}` | 读（联网，需在说明里写明） |

**不做**：截图、任意文件读写、执行外部程序 —— 这些要么做不到（无界面外能力），
要么等于给本机任意进程一个读写/执行原语（与"路径只认原生框选过的"同一条纪律）。

#### 16.6.4 危险动作的二次确认（设计 §9，估 0.5 天）

**判定"危险"的统一口径**（写进一张常量表，断言守着）：**会对外产生不可撤销影响**的操作 ——
对外广播（`ble_periph_start/stop`）、放行外部写入（`ble_periph_respond_write`）、
在别人的设备上执行（`adb_open_shell`/`adb_shell_write`）、动宿主机的硬件挂载（`wsl_map_device`/`unmap`）、
系统弹窗配对（`ble_pair`）。

**机制**（一层就够，不引入会话状态）：

1. 工具表里标注 `danger: "<一句话说清后果>"`；`mcp_limits` 或一个只读工具 `mcp_danger` 把它列出来
2. 调用时**必须带 `confirm: true`**；没带 → 返回 `-32006`（isError），文本是
   "这一步会<后果>。确认后带 `confirm:true` 重试" —— 与现有"前置条件没满足"同一类错误码，
   Agent 拿到就知道该改什么（不是参数错，不该反复重试）
3. `confirm` 只对**危险工具**有意义，普通工具传了忽略（不做"两个参数名"）
4. **只读模式优先**：`expose.read_only` 时，危险工具连确认也不给过（`-32007`）
5. 断言：① 危险表里的每个工具都必须真的走确认（假前端能观察到"没执行"）；
   ② 表外的工具**不得**要求 `confirm`（否则 Agent 会以为普通操作也能确认了事）；
   ③ `mcp_limits`/文档里列出的危险工具集合与代码里的常量**逐字一致**

#### 16.6.5 顺序、依赖与"做完的标准"

```
第二批 BLE ──┐
第三批 ADB/WSL ├─→ 每批独立提交（前后端同改放同一个提交）
第四批 全局 ──┘
              └─→ 16.6.4 危险确认：**与第二批同时落地**（ble_periph_* 是第一批危险工具，
                  先有机制再有工具，否则要么漏确认、要么回头补）
```

每批"做完"= 下面五条全绿，缺一条都不算：

1. `cargo test --manifest-path src-tauri/Cargo.toml` 全绿（含新工具的返回契约与假前端用例）
2. `node .walkthrough/gen_ble_preview.js` 全绿（含"每个 op 都有前端分支"与真实 handler 行为）
3. `node .walkthrough/gen_mcp_tools_doc.js` 重跑，`doc/MCP_TOOLS.md` 里每个新工具都有入参与实测返回结构
4. `doc/MCP.md`（使用者视角）与 `.walkthrough/mcp_inv_frontend.md`（控件/op 台账）同步
5. 需要真机的项，我给出**可直接粘贴的命令 + 期望输出**，你跑完贴回来（§16.3 的分工不变）

#### 16.6.6 明确不做的

- **不为了"工具数好看"而生成**：`ctl_*` 全量工具已经覆盖"够不到就用控件路径"的长尾，
  语义工具只补"有业务语义、值得先给 AI 一个名字"的那些（判据：面板上有专门的按钮/开关/流程）
- **不给 AI 任何"任意路径/任意命令"的入参**（同 `quick_cmds_*` 与 `ble_periph_*_config_file` 的纪律）
- **不把 UI 状态镜像到 Rust**：读状态一律问前端（`ui_call`），Rust 侧不缓存一份（避免两处真相）

---

## 17. 实施记录

### 2026-09-17 · 用户报的四处改进：**日志来源标签** / BLE 写回灌 / **滚动条普查** / 快捷指令自带案例（+ 工作流动作行 bug）✅

**一、「AI 发送的数据在日志里要和接收的区分开」→ 新增日志来源 `src`**

先查清了事实：**"发送 vs 接收"本来就分得开**（`serial:<分栏>:rx` 与 `:tx` 是两个独立通道，
条目还有 `dir` 字段），但**"AI 发的 vs 用户手点的"分不开** —— 因为 `serial_send` 的实现就是
"填进输入框 + 点发送按钮"，与用户手点**同一条路**（AGENTS #3 那条"不为 AI 单写一套逻辑"的代价）。

做法：`LogHub` 的 `LogLine` 加一个字节的 `src`（`none`/`ui`/`ai`），全链路三处**必须成对**：

- 前端：`mcpSerialOp` 的 send 分支**先挂 `_mcpAiSend` 标记再 `click()`**（click 是同步派发，
  顺序反了 `sendData` 已经跑完、认领不到）→ `bufferPush` 认领它并把那条标 `ai`；
- **没被认领就补记一条**：`sendData` 只在 **echo 开着、且输出区已渲染**时才记 `send`
  （`appendOutput` 第一行就 `return`）—— 也就是说**echo 一关，AI 发送在日志里原本是一片空白**。
  补记不是装饰，是"AI 干了什么必须可追溯"的前提；
- 后端：`log_push_batch` 入参 → `push_batch_into`（用 `loghub::src_of`，**唯一的字符串→常量映射**）
  → `LogHub::push_src`。`push()` 保留为"不标来源"的写法（Rust 侧那几路本来就有通道名可区分）；
- 输出：json 每条带 `"src"`；**text 编码只在是 `ui`/`ai` 时写 `[ai]` 标记**
  （逐行写 `[none]` 是白烧 token；但 `src` 不像 `dir` 能从通道名推，所以有值时必须写）。

**顺带补齐一个不对称**：BLE 的写日志原来只在面板内存 `_bleLog` 里（`kind:'tx'`），
**不进日志中心** —— 所以 `log_tail` 看不到 BLE 写过什么、跨会话就丢了。现在前端 `bleLogRecord`
把 `tx` 回灌到 `ble:tx`（**只回灌 tx**：rx 那边 Rust 侧已在推 `ble:rx`，再推一遍就是逐条重复），
`ble_get_output` 的 `channels` 也一并给出 `tx`。

**二、「确认所有的滚动条都已经做了美化」→ 查出 6 处漏美化 + 3 处漏 corner**

靠人眼看界面确认不了（有些区域要先展开、要连上设备、或只在特定主题下才看得见），所以**做源码对账**：
把 4 个 CSS 里所有 `overflow:auto/scroll` 的选择器与所有 `::-webkit-scrollbar` 的选择器各取一份，
前者必须是后者的子集。一次就查出来：

- **漏美化 6 处**：`.ble-devList`（蓝牙设备列表）、`.ble-detail-sec`、`.ble-modal-inp`、
  `#paneContainer`（面板横向滚动）、`.send-hist`（发送历史下拉）、`.term-comp`（终端 TAB 补全弹层）
  —— 它们一直在用 Windows 原生滚动条，深色主题下就是一条白杠；
- **漏 corner 3 处**：`.output` / `.adv-wf-wrap` / `.qcmd-list`（漏了就是横竖交汇处一个白方块）；
- 还发现一处**打空了目标**的规则：`#mcpModal .ble-modal-body::-webkit-scrollbar` 指的是一个
  **不滚动**的元素（第 215 行没有 overflow），真正滚的是它里面的 `.ble-modal-inp`。

两条断言守着（并修掉一条脆弱的旧断言：它钉的是"corner 规则数量 === 4"，一加滚动区就得改数字，
而那正是最容易漏 corner 的时刻 —— 这次它就当场 fail 了，已改成按选择器集合对账）。

**三、工作流「改回发送数据后 DTR/RTS 不消失」（用户报的 bug）**

根因在 `renderWfActRow`：它按"第几个 `.wf-row`"定位要重渲染的那一行
（`querySelectorAll('.wf-row')[targetIdx + 1]`，注释还写着"rows[0] 是标题行"），
可**标题的 class 是 `.wf-section-title`（不在 `.wf-row` 里）**，而末尾那颗「+ 添加动作」按钮**是**
`.wf-row` —— 于是整体错位一行：改第 0 个动作被重渲染的是第 1 个，只有 1 个动作时被替换掉的是那颗
添加按钮。**真正该刷新的那行从头到尾没被刷新过**，`extraInputs` 一直是上一次渲染的残留。
改成给动作行打 `data-wf-act-idx` 标记、按标记定位（不按位置数），并补上重渲染时漏掉的
`mcpWfElId(...)` 稳定 id（少了它，MCP 控件注册表在切完类型后就丢了这个控件）。
断言集加了 7 条（含"★ 改回发送数据后 DTR/RTS 必须消失"这一步的行为断言）。

**四、快捷指令文件自带案例（用户要求："用注释的方式提供案例，比如表格案例、DSL 编写案例"）**

导出物（`qcmdExportPrep` 的 `withHelp`）开头加一段**注释形式**的说明：表格案例（含跳转两列的真实写法）、
DSL 案例（只写「指令」一列）、HEX 案例，以及各列取值含义。三条纪律：

- **只在导出物里出现**：`qcmdCurrentText`（要写回用户挂载文件的那条路）不传 `withHelp` ——
  往用户的表里塞几十行说明就是污染（有一条断言专门守这个方向）；
- 每行都以单个 `#` 开头：解析端是"单个 `#` 注释、`##` 及以上才是组抬头"，
  所以案例里的 `## 组名` 只能写成 `#   ## 组名`（否则导入时凭空多出一个空组）；
- **行尾必须是 `\r\n`**：`qcmdBuildText` 最后是 `out.join('\r\n')`，raw 块原样回吐 ——
  用 `\n` 就成了混合行尾，后果是"导出 → 导入 → 原样写回"**不再逐字节一致**（往返断言当场逮住）。

`doc/QUICK_CMDS.md` 的"导出 vs 写回"一节同步说明这件事。

**补记（同日稍后）**：用户追问"DSL 没有判断功能吗？" —— 判断能力**一直有**（`期望` = 条件、
`成功跳转`/`失败跳转` = 分支出口，见 `doc/QUICK_CMDS.md` §四/§五），但它**只活在文件里**：
面板上这四列一个入口都没有，而我第一版的注释案例只是把两列摆进表头、**一个字都没解释**
—— 所以从导出物上完全看不出这是判断功能。已补三处：

1. 导出物加一段 **【判断与分支案例】**（"整行收到 `WIFI GOT IP` → 跳到 5；超时或用完重试 → 跳到 8"
   的读法 + 内置判定顺序 + 成环有上限保护）；
2. `doc/QUICK_CMDS.md` 写明**「期望」是"整行完全相等"**（不是包含）—— 而内置的 `ERROR` 判定
   **反而是包含**，这个不对称最容易误解（`+CWJAP:WIFI GOT IP` 匹配不上、`+CME ERROR:5` 却算失败），
   并指向工作流规则的 `string_contains`（子串匹配，还支持正则与多条件）；
3. 两条断言分别守着"导出物讲了判断与分支""文档写了整行相等"，别再退化。

**没有做（有意）**：给跳转两列**在面板上加入口**。那要动 `renderQcmdList`、列标题、`mcpWfElId`
注册表、写回规则，还要同步文档与断言 —— 属于"别和别的改动混在一起"的那类，留待单独评估。

**验证**：`cargo test` **249 通过 + 1 ignored**（+2：`source_survives_storage_and_both_encodings`、
`log_push_batch_carries_source`）；前端断言集 **1631 通过**（+19，含滚动条两条对账、工作流动作行 7 条、
AI 来源标记 3 条、导出说明段往返）。`gen_mcp_tools_doc.js` 重生成（54 个工具）。

### 2026-09-17 · 「AI 怎么知道该用哪个工具、用在什么场景」—— annotations + 任务链指引 + 幽灵工具守卫 ✅

**问题**：工具能用，但**用得对不对**是另一回事。54 个工具平铺在 `tools/list` 里，
模型得自己判断"这个场景该调哪个、什么时候不该调"。而**团队文档（本页 / `MCP_TOOLS.md` /
`MCP.md` / README）AI 一个字都看不到** —— 它只认协议里传过去的四个通道：
`initialize.instructions`、`tools/list` 的 `description` 与 `inputSchema` 字段描述、
以及运行时的返回与错误码。所以"让 AI 知道"这件事，等价于"把场景信息塞进那几个槽位"。

**做了四件事，按性价比排**：

1. **补 `annotations`（原来一个都没给）**。MCP 规范给这几个字段的**默认值是反的**：
   不写 `readOnlyHint` 就当"非只读"，不写 `destructiveHint` 就当 **`true`（破坏性）** ——
   也就是说在此之前，`mcp_status` 这种纯读工具在规范意义上也是"破坏性操作"，
   带审批 UI 的客户端会照此处理。现在"只读"来自**显式登记**的 `READ_ONLY_TOOLS`（28 个）、
   "破坏性"来自 `DANGER_TOOLS`：`annotations_for()` + `annotate_tools()` 在 `tool_defs()` 与
   `exposed_tools()` 返回前统一注入，内置工具与 `ctl_*` 一起覆盖。新增常量
   `SOMETIMES_WRITE_TOOLS`（`serial_quick_cmd` / `serial_workflow`）—— 这两个**性质随调用而变**，
   给它们标 `readOnlyHint:true` 就等于告诉客户端"带 index 真把指令发出去也算只读"，比不标更坏。
   ⚠️ **这是提示，不是约束**：它不替代只读模式的 `-32007` 硬拦，也不替代 `confirm:true` ——
   安全判定必须留在服务端（客户端可以整个忽略 annotations）。

   ⚠️ **中途踩的坑（值得单独记）**：第一版写的是"**不在 `WRITE_TOOLS` 里 → `readOnlyHint:true`**"，
   也就是白名单否定。新加的断言里有一句"没登记的名字必须回非只读"，**当场把它抓了出来**。
   原因很实在：**名字判断不出读写**，"不在写表里"只等于"**没分类**"，不等于"只读"。
   照那个写法，以后新增一个写工具却忘了加进 `WRITE_TOOLS`，`annotations` 会**主动告诉客户端
   "这是只读的"**，而只读模式也不会拦它 —— 两边一起错，且**所有现存断言都是绿的**
   （它们只核"已登记的那部分彼此一致"）。改成显式登记后，另加
   `every_tool_is_explicitly_classified` 守"读 / 写 / 按调用变 三选一，三张表不重、不漏、不过期"，
   **新增工具忘了登记会 fail**，而不是静默落到只读那一侧。
   这是 AGENTS #9 那条老教训（"两端各自测自己那一半，全是绿的"）的翻版：
   **标注与拦截若共用同一个来源，一致性断言就退化成同义反复**。

2. **补一条"描述只能引用真实工具"的断言**（`descriptions_only_reference_real_tools`）。
   工具描述**大量**跨工具指路（"见 `ble_get_services`…"、"要再找别的设备就重新
   `ble_start_scan`"）—— 这正是"让 AI 知道下一步调什么"的主要手段；但工具一旦改名或删除，
   描述里就留下指向**幽灵**的引用，AI 会照着调、拿到一句"工具不存在"，而**两端各自的单测全绿**
   （描述是文本，此前没有任何东西在核它）。口径刻意收窄（以已知工具前缀开头且含下划线），
   免得把 `case_sensitive` / `since_seq` / `ok_only` 这些"旧拼写别名"误报到没法用。
   与 `.walkthrough` 那条"`protocol.rs` 发出的每个 `op`，前端必须有对应分支"是同一个模式：
   **跨边界的名字引用，必须在握有权威名单的那一侧校验**。断言本身带反向自检
   （要求至少扫到 10 处真实引用），否则"没有幽灵"可能只是没扫到。

3. **`instructions` 从"两条任务链"扩到"四面板 + 三场景"**。原来只写了串口与 ADB，
   缺 BLE / WSL / 日志 / 快速指令 / 工作流 —— 而**"用在哪些场景"正是 `instructions`
   最该回答的问题**（挑错工具的代价，比顺序写错大得多）。现在按场景分块：
   Windows 串口 / WSL 串口（`pane` 传 `wsl`，端口是该 WSL 内的 `/dev/*`，**不是** COM）/
   蓝牙（含"设备不广播就只能按 MAC 直连"这条唯一出路）/ ADB /
   **"读内容该选哪个"**（`serial_get_output` · `ble_get_output` · `adb_shell_read` ·
   `log_channels`→`log_tail`/`log_search` 这四者最容易选错）/ 快速指令与工作流 /
   通用界面桥。断言同步扩到 9 个场景关键词，守着"四个面板的任务链都在"。

4. **入口工具的首句前移 + 一处销毁性动作的警告**。`serial_get_state` 的
   "操作串口前先调它"原来在末尾，现在提到首句（它是所有串口操作的第一步，
   而首句是最不容易被截断的位置）；`log_channels` 同理（"不确定日志在哪时先调它"）；
   `log_clear` 补一句 **"这是销毁证据的动作"** —— 清掉的行回不来，AI 不该为"看起来干净"随手清。

**验证**：`cargo test` **247 通过 + 1 ignored**（+4 条新断言；其中 `annotations_agree_with_write_and_danger_tables`
顺带守着"两张表里指向的工具名都真实存在"，`every_tool_is_explicitly_classified` 守"不重不漏不过期"，
`tools_list_carries_annotations` 从**真实出口** `tools/list` 再验一次 —— 注入点是 `exposed_tools()`
而不是 `tool_defs()`，写错一处的话上面那几条查 `tool_defs()` 的断言全是绿的）。
前端断言集 **1612 通过**（本轮没碰前端）。
`node .walkthrough/gen_mcp_tools_doc.js` 重生成，仍是 54 个工具，diff 6 行（3 处 description × 两处引用）。

**没做（有意）**：不标 `idempotentHint` / `openWorldHint` —— 前者要手工维护一张
"哪些写工具重试安全"的表，标错会鼓励客户端重试一个非幂等操作，而规范默认 `false` 本就是保守值。
`prompts/list` 与 `resources/list` 也仍然空着：它们是"用户显式选一个工作流"的入口，
对自主 Agent 的场景认知没有增量，不如把力气花在 `instructions` 与工具描述上。

### 2026-09-17 · 扫描过程中连上设备 → **同步停止扫描**（用户提的修复）✅

**用户原话**："做一个修复，如果在扫描过程中连接了设备，就应该同步停止扫描。"

**为什么必须停**（三条都是真问题，不只是"顺手"）：
1. 扫描期间每 2 秒 `refreshBleDevices` 一次，会跟"连接成功后写状态 / 渲染详情"抢 ——
   实测过类似的：列表重渲染把 `connected` 标记刷掉、或把刚拉到的服务树盖回去；
2. 适配器继续扫是白耗电，而且会让"这台设备已经不广播了"这种**正常现象**被当成问题；
3. AI 那边最要命：`ble_connect` 成功后 `ble_get_state.scanning` 若还是 `true`，
   调用方只能猜"到底连上没有 / 还在不在扫"。

**做法**（三个点，少一个都不算修好）：
- **唯一出口**：`stopBleScan()` 收拢"手动 / 到点自动 / 连接成功"三条路径 —— 以前
  `invoke('ble_stop_scan')` 是无条件的，连接时（多数情况根本没在扫）会白发一条，
  失败还往控制台打一句没意义的警告；现在只在**确实在扫**时才惊动后端，并返回是否真停过。
- **挂在所有连接路径的唯一出口上**：新函数 `stopBleScanOnConnect()` 放在 `bleOnConnected()`
  的**第一行**（列表点卡片 / 按 MAC 直连 / MCP 的 `ble_connect` / 配对后自动重连，全都经过它），
  这样"停扫描"发生在写连接状态、拉服务树**之前**；停了还会在数据日志留一行
  `[扫描] 已停止（已连上设备，不需要继续搜索）`，免得用户以为按钮坏了。
- **挡住"迟到的启动回执"**（真会撞上的竞态）：点「开始扫描」→ 后端回执还没回来 → 这期间设备连上了
  （`_bleScanning` 被置 false）→ 回执回来时那段 `.then` 会把轮询和自动停止定时器**又装回去**，
  于是按钮写着「开始扫描」、后台每 2 秒刷一次。现在 `.then` 先看 `_bleScanning`：
  已经不在扫了就**补一条 `ble_stop_scan` 给后端**然后直接返回；
  `enableBleScanAutoStop()` 也加了同样的守卫。

**没做（有意）**：**不拦"连着设备时再去扫描"** —— 用户的要求是"连上就停"，反过来"连着的状态还想找
下一台设备"是正常需求（扫完想换设备就再点一次），拦掉反而碍事。

**验证**：前端断言集 **1612 通过**（+10，新增一整块行为断言：连上后 `_bleScanning=false`、
两个定时器被摘、`ble_stop_scan` 只发一次、按钮文案复位、日志留痕；没在扫时连接**不**惊动后端；
迟到的启动回执不再装轮询/定时器且补发一次停止）。`cargo test` **243 通过 + 1 ignored**（本轮没碰 Rust）；
npm 自测 94。MCP 侧同步更新了 `ble_start_scan` / `ble_connect` 的描述，
让 AI 知道"连上会自动停扫描、`scanning` 会是 false"。

### 2026-09-17 · 补上 CTS 的第三件套：**`0x2A14` Reference Time Information 的解码** ✅

**为什么现在才做**：第一版 CTS（见下面两条记录）只解了 `2A2B`（时间本身）与 `2A0F`（时区/DST），
`2A14` 只在服务树里显示了个名字 —— 当时的原话是"字段少用且我对 Time Accuracy 的单位没把握，
宁可不解也不编"。用户 2026-09 明确点了这条，于是**先把规范核清楚再写**。

**规范怎么说**（SIG 官方公开仓库的 GATT Specification Supplement，三条定义互相引用）：
- `reference_time_information.yaml`：4 字节 = Time Source(1) + Time Accuracy(1) +
  Days Since Update(1) + Hours Since Update(1)；天 0~254、小时 0~23，
  **255 表示"距上次对时 ≥255 天"**（天与小时两个字段都这么定义）。
- `time_source.yaml`：`0` 未知 / `1` NTP / `2` GPS / `3` 无线电时间信号 / `4` 手动 /
  `5` 原子钟 / `6` 蜂窝网络 / **`7` 未同步** / `8~255` 保留。
- `time_accuracy.yaml`：Base unit second、**M=1 d=0 b=-3** → **步长 1/8 秒（125 ms）**；
  0~253 有效（0 ~ 31.625 秒）、**254 = 比 31.625 秒还差**、**255 = 未知**。

**做成什么**：`ble_cts_decode` 加 `4 =>` 分支（`field: "referenceTimeInfo"`），
`charUuid: "2a14"`；前端 `BLE_CTS_CHARS` 加 `'2A14': 4`；`attach_cts_decodes` 加 `"2a14" => 4`
（`ble_get_output` 里同样的自动解读）；`summarize_cts_time` 的字段分派加 `referenceTimeInfo`。

**结论字段**（数据 + 人话成对，与 `dstName`/`dstOffsetMinutes` 同一套写法）：
`timeSource`/`timeSourceName`、`timeAccuracy`/`accuracyMillis`/`accuracyName`、
`daysSinceUpdate`/`hoursSinceUpdate`/`sinceUpdateHours`/`sinceUpdateText`。
摘要一行：`参考时间：网络时间协议（NTP） · 精度 ±1 秒 · 距上次对时 3 天 12 小时`。

**纪律照旧（"没给出/超量程"一律不给具体数）**：
- 精度 `254`/`255` → `accuracyMillis: null`（`254` 只说"差于 31.625 秒"）；
- 距上次对时 `255` → `sinceUpdateText: "≥255 天"` + `sinceUpdateHours: null`；
- 时间源 `> 7` → 名字写"保留值"+ notes 里点名原始值；
- **时间源 `7`（未同步）主动进 notes** —— 这是本特征最有诊断价值的一条：设备自己说没同步，
  那 `2A2B` 报出来的时间就不该信；
- **自相矛盾也报**：天数字段在量程内、小时字段却是 `255`（规范说 255 是"≥255 天"）→
  notes 里指出两个字段矛盾，**但不猜**哪个对；
- `0 天 0 小时` 说成"刚刚（0 天 0 小时）"——"0"在这里是**有效结论**（刚对过时），不是"没有信息"。

**验证**：`cargo test` **243 通过 + 1 ignored**（+1 条 `cts_reference_time_info_decodes_source_accuracy_and_age`，
里面钉住 1/8 秒这个单位（`1`→125ms、`4`→500ms、`253`→31.625s）、254/255 的 null、
`255` 天的"≥255 天"、字段矛盾、"刚刚"、保留时间源与未同步）；MCP 层加一条 4 字节用例
（顺带把"长度不对"的探针从 `01 02 03 04` 改成 3 字节 —— 那个 4 字节现在**是合法的**，
不改就会变成"测的是错的"）；前端断言集 **1602 通过**（+3：2A14 也认、长度表三条齐全、
长度与特征对不上不解读）。

### 2026-09-17 · 真机演示时抓到 CTS 的 **DST / 时区映射错了一档**（+ 时区"-128 未给出"被编成一个值） ✅

**怎么发现的**：用户问"CTS 体现在哪里"，我顺手对**正在跑的应用**真调了一遍 `ble_cts_time`
（演示脚本，用完即删）。第二条用例 `20 02` 打出来的是
`时区 +08:00（32 个 1/4 小时） · DST 夏令时`、`dstOffsetMinutes: 60` —— 我当时写的用例标签是
"标准时间"，对不上，于是去查规范。

**规范怎么说**（SIG 官方公开仓库的 GATT Specification Supplement，两份定义）：
- `gss/org.bluetooth.characteristic.dst_offset.yaml`：
  `0: Standard Time / 2: Half an hour Daylight Time (+ 0.5h) / 4: Daylight Time (+ 1h) /
  8: Double Daylight Time (+ 2h) / 255: DST offset unknown / 其余保留`
- `gss/org.bluetooth.characteristic.time_zone.yaml`：`sint8`、**15 分钟**为单位、有效范围 **-48~+56**、
  **-128 = 时区未给出**、其余保留。
- `gss/org.bluetooth.characteristic.local_time_information.yaml`：`0x2A0F` 就是上面两个字段拼起来。

**错在哪（三处，都在 `ble_cts_decode` 的 2 字节分支）**：

| 输入 | 规范 | 我们原来 |
|---|---|---|
| DST `2` | 半小时夏令时（**+30 分**） | 夏令时（+60）❌ |
| DST `4` | 夏令时（**+60 分**） | 双倍夏令时（+120）❌ |
| DST `8` | 双倍夏令时（**+120 分，合法**） | 当成"保留值"❌ |
| 时区 `-128` | **未给出** | 算成确定的 `-32:00` ❌ |

三处都是"**给一个看着确定的错值**"，正好踩在我们自己立的纪律上（"宁可不说，也不给一句看着确定、
其实错的解读"）。DST 那两处最阴：时区对、时间对，只有 DST 差半小时，用户根本看不出来。
`255`（未给出）我们原来回 `dstOffsetMinutes: 0` —— `0` 是"标准时间"这个**结论**，也不能拿它冒充"不知道"。

**怎么修的**：按规范重排映射（`0/2/4/8/255` + 保留值），并把"未给出/保留"统一成
**`utcOffset` / `dstOffsetMinutes` 回 `null`**（原始字节仍留在 `timeZoneQuarterHours` / `dstOffset` 里，
`notes` 说清为什么没给结论）。摘要 `ble_cts_summary` 也跟着不再编时区（改成
`时区 未知（原始值 -128） · DST 未知`）。

**为什么测试没拦住**：那条测试（`cts_local_time_info_decodes_timezone_and_dst`）是**照着当时的实现写的**，
它把错的当成对的钉死了 —— "两端各自测自己那一半都绿"的另一种形态：**测试与实现同源，就一起错**。
修完顺手把五个合法 DST 取值各钉一个锚点，并在断言集里加了一条**源码级**回归
（直接读 `main.rs` 的匹配臂 + `matches!(dst, 0 | 2 | 4 | 8 | 255)` + `tz_raw == -128`），
免得再被"照着实现改测试"。

**验证**：`cargo test` **242 通过 + 1 ignored**；前端断言集 **1599 通过**；对运行中的应用真调
五个取值（`20 02` / `20 04` / `20 08` / `20 FF` / `80 00`）逐个核对输出。

### 2026-09-17 · BLE 的 **UUID 名称表改成生成**（SIG 官方数据；特征 9 条 → **512 条**）✅

**起因**：用户盯着界面问"0x2A00 这个确定是 Device Name？依据是什么？"，接着问
"这个表足够完整吗？"。答：那是 `BLE_CHAR_NAMES` / `BLE_SVC_NAMES` 两张**手写**表查出来的，
服务表 67 条（基本齐）、描述符表 15 条（本来就齐），但**特征表只有 9 条** —— 而 SIG 公报的
特征有 **512 条**。手写的表既不全、也没法跟进更新。用户定的方案：**B —— 从权威数据生成，
而且 `Custom Service` 那条兜底一个字都不许动**。

**做成什么**：新增生成器 `.walkthrough/gen_ble_uuids.js`，产物是新的前端文件
`src/js/81-ble-uuids.js`（`<script>` 插在 `81-ble.js` 之前），`81-ble.js` 里那两张手写表删掉。
- **源**：Bluetooth SIG **官方公开仓库**（`bluetooth-SIG/public`）的
  `assigned_numbers/uuids/{service,characteristic}_uuids.yaml` —— 服务 **78** 条（76 条 SIG +
  2 条补遗）、特征 **512** 条。生成物头部写清抓取的**提交号与日期**（这次是 `4904c3c73170`）。
- **源文件不进仓库**：那份 YAML 抬头写明 *"This document is proprietary to Bluetooth SIG …
  The furnishing of this document does not grant any license"* —— 不能随产品再分发。
  所以只提交**生成物**（我们自己的 JS 表），生成是本地一条命令的事；`--from <目录>` 支持离线。
- **对比过 Nordic 的 BSD-3 镜像**（`bluetooth-numbers-database`，可再分发）：它只是个镜像，
  实测比 SIG **少 8 个服务、60 条特征**，还留着 **23 条已废止**的旧编号（`2A0B` Exact Time 100、
  `2A1F/2A20` Temperature Celsius/Fahrenheit、`2A2F/2A30` Position 2D/3D …），拿它当源反而更差。
- **名称只做机械清洗**：`CO\textsubscript{2} Concentration` → `CO2 Concentration`（规范文档里的
  排版标记），不做逐条手改 —— 手改就等于把"生成"又变回"手写"。
- **补遗只有 2 条**（`SVC_EXTRA`，生成器里带注释）：`FE59` Nordic DFU（成员 16 位 UUID，
  SIG 的 `member_uuids.yaml` 给的是公司名而不是服务名）、`6E400001-…` Nordic UART（厂商 128 位）。

**四条纪律（都写进了 AGENTS.md 的 BLE 约定）**：
1. **兜底逻辑不在生成文件里**：查不到服务仍走 `renderBleServiceRow` 里的
   `BLE_SVC_NAMES[su] || 'Custom Service'` —— **一行没动**（用户明确要求）；查不到特征仍不显示名字。
   断言集里专门有一条盯着这行原文。
2. **别手写回去**：生成器 `--check` 会比对产物与 SIG 当前数据；断言集直接读 `81-ble.js` 源文件，
   发现 `var BLE_SVC_NAMES` / `var BLE_CHAR_NAMES` 就 fail，并守住"生成文件必须在 81-ble.js 之前加载"。
3. **生成物必须提交**（前端无构建步骤），且**不能塞 `FF00`** 这类泛化号码（既有断言守着）。
4. CTS 那条链路依赖 `2A2B`/`2A0F`/`2A14` 在表里 —— 生成器与断言集各有一道自检。
   生成器另有锚点自检（`1800`=GAP、`180A`=Device Information、`2A00`=Device Name、
   `2A24`=Model Number String…）+ 规模下限（服务 ≥76、特征 ≥500），源一变就直接失败，不写错表。

**可见变化（要告诉用户）**：`0x1800` 由 "Generic Access" 变成 SIG 官方的 **"GAP"**、
`0x1801` 由 "Generic Attribute" 变成 **"GATT"**（这两条本来就是缩写名）；其余服务的名字与手写表
**逐条一致**（当初就是照 SIG 抄的）。服务名里多出 8 条（`183D`/`183F`/`1840`/`185A`/`185C`/`185D`/
`185E`/`185F`），特征名多出 **503 条**。

**验证**：`cargo test` **242 通过 + 1 ignored**（本轮没碰 Rust）；前端断言集 **1598 通过**
（改 2 条把名字写死的旧断言 → 改成按表断言，新增 9 条：生成文件头、别手写回去、加载顺序、
规模下限、两表锚点、CTS 三件套、排版标记拍平、兜底原文）。

### 2026-09-17 · CTS 的 **B 方案**：UUID 随日志条目带出去，`ble_get_output` 自动附上解读 ✅

**为什么还要一步**：A 方案（上一节）只让**界面**多了一行人话；AI 那边仍是"`ble_read` → `ble_get_output`
拿到一串 HEX → 再调一次 `ble_cts_time`"。而这一步本来是**可以省掉的**：日志条目里已经有 `hex`
（原始字节），缺的只有"**这是哪个特征的值**"—— 有了它就能在读到的那一刻当场判定。

**做成什么**：

- 日志条目补结构化元数据：`bleLogEntry(base, meta)` 收 `{kind, hex, charUuid, descUuid}`，
  UUID 统一**小写**（后端按短号比对）。`logBle` / `logBleDim` 都多一个 `meta` 参数，
  读取 / 通知 / 特征写入三条路各自填上自己的 UUID。
- `30-mcp.js` 的 `getOutput` 把 `charUuid`/`descUuid` **原样透传**（没有就给 `null` —— 缺键会让
  客户端字段不稳，而且"没有"与"是 null"在后端代码里是同一件事，索性显式）。
  ⚠️ 这两个字段以前**根本没传**：后端 `attach_cts_decodes` 再正确也判不出来 ——
  典型的"两端各自测自己那一半都是绿的"。
- 后端 `attach_cts_decodes(&mut all)` 在 `ble_get_output` 里就地给条目补
  `decoded`（完整字段）与 `decodedSummary`（一行结论），判据**只有两条**：
  `charUuid` 归一后的短号 ∈ {`2a2b`, `2a0f`}，且 `hex` 长度正好等于 10 / 2。
  于是"AI 读一次日志就看到设备现在几点"，不用再多一次往返。
- 文本摘要 `summarize_ble_output` 把**解读出来的那一行提到最前面**：通用渲染只展开前几个键，
  正好可能把 `decodedSummary` 挤出去 —— 那就等于"功能做了但 AI 看不到"。
  末尾仍接通用摘要（契约要求它把条目内容说出来），整体按 600 字截断。

**三条纪律**：

1. **描述符的值绝不解读**：`CCCD`（0x2902）也是 **2 字节**（`0100`），按 Local Time Information 解
   会给出一个"看着确定、其实完全错"的时区（`+1 分钟`）。所以前端对描述符行**只填 `descUuid`、
   不填 `charUuid`**，后端也只读 `charUuid` —— 两端各拦一道，宁可少解读，也不给错的。
   断言里有一条直接扫 `attach_cts_decodes` 的函数体：出现 `descUuid` 就 fail。
2. **长度不符 / HEX 非法一律静默跳过**：原始 `hex` 还在条目里，调用方照样能自己看；
   解读失败只 `console.warn`（界面）与 `continue`（后端），不影响任何主流程。
3. **原始 HEX 一个字节都不改**：解读是**附加**字段，不是替换。

**验证**：`cargo test` **242 通过 + 1 ignored**（+2：`ble_short_uuid` 的三种真实写法与"自定义 128 位
不许截成 4 位"、`attach_cts_decodes` 的判据矩阵（含 CCCD 误伤那条））；前端断言集 **1586 通过**
（+10：条目元数据 3 条、`getOutput` 透传 3 条、后端口径与摘要提升 4 条）。
`doc/MCP_TOOLS.md` 重生成时**顺带修掉一处旧伤**：上一轮用 PowerShell 替换 `gen_mcp_tools_doc.js` 时
把 `ble_cts_time` / `ble_get_output` 两条 META 粘成了一条（还塞进一个 `\f`），
于是 `ble_get_output` 在手册里**整条消失**、`ble_cts_time` 的返回结构是错的。

### 2026-09-17 · 实现 BLE **CTS**（Current Time Service 0x1805，主机方向：把值翻译成人话）✅

**决定做什么**：上一批评估的结论是"主机方向值得做，而且不是实现协议栈、是**加解码**"——因为
`ble_read{char:"0x2a2b"}` 拿到的就是 **10 字节原始值**（年 = uint16 **小端**、星期 1..7、
Fractions256 = 1/256 秒、Adjust Reason 是位域），调用方（尤其模型）自己解很容易错，
而错一个字段结论就全歪 —— **"设备时间是 2000 年"这种真实 bug 恰恰靠这几个字段看出来**。

**做成什么**：
- 新增**纯后端**工具 `ble_cts_time`（`data` 收 HEX 字符串或字节数组），
  解码逻辑是 `main.rs` 里的纯函数 `ble_cts_decode`（放在其它 BLE 解析函数旁边，便于单测）：
  - **10 字节** → `currentTime`：`utc` / **`skewSecs`（与本机的差）** / `dayOfWeekName` /
    `fractions256`+`fractionMillis` / `adjustReasons`（位域名）/ **`notes`**；
  - **2 字节** → `localTimeInfo`：时区（int8 × 15 分钟 → `utcOffset`）+ DST 名称/偏移。
  - 长度不对 → **说清"该读 10 或 2 字节、别截断"**（不硬解出垃圾）。
- **`notes` 是这个工具的价值所在**（不是装饰）：年份 ≤2000（`2000-01-01` 正是"RTC 没初始化"的经典签名，
  写成 `< 2000` 会正好漏掉）、月份/日期/时间越界、**星期几与日期对不上**（很多实现把 0 当周日）、
  与本机差 ≥5 分钟、设备自报的调整原因。越界**不 panic**，`utc`/`skewSecs` 回 null 而不是猜一个时间。
  偏差按 **分 / 小时 / 天** 分档写成人话（端到端实测时发现"与本机时间差 131374 分"等于没给信息 ——
  RTC 没初始化的设备差的是几年），方向用"快/慢"，摘要里也不再把同一条抄两遍。
- 前端 `BLE_CHAR_NAMES` 补上 CTS 三件套（`2A2B` Current Time / `2A0F` Local Time Information /
  `2A14` Reference Time Information）—— 服务树里能认出它们，而不是只显示裸 UUID。
- 加了一条**工具感知的文本摘要**（`summarize_cts_time`）：通用渲染只展开**前 8 个键**（字母序），
  正好把 `utc`/`notes` 挤出去，只读文本的客户端就只看到一堆原始字段 —— 契约测试当场抓到
  （"文本摘要没把数据说出来"），所以给它自己的紧凑摘要（`2026-12-17T15:45:58.500Z（周四）· 与本机差 2 分 3 秒 · 注意：…`）。

**界面呈现（A 方案，同日补）**：面板在**读到 / 收到** `2A2B`·`2A0F` 时就地调新命令
`ble_cts_decode_value`，日志里紧跟原始 HEX 多一行 `  → 2026-12-17T15:45:58.500Z（周四） · 设备时钟比本机快 …`
（订阅后能直接看着设备时钟走）。三条纪律：

1. **解码不在 JS 里重写**（AGENTS #3：两套逻辑必然漂移）—— JS 只负责"调后端 + 打一行日志"；
2. 摘要函数 `ble_cts_summary` 挪到 **crate 根**（`pub(crate)`），界面日志与 MCP 的文本摘要**共用同一份**
   （原先它只在 protocol.rs 里，界面拿不到就只能抄一份）；顺手把 600 字截断抽成 `cap_text_summary` 给两处共用；
3. 只对**长度正好对得上**的 CTS 特征动手，长度不符（值被截断）**不猜**；解读失败只 `console.warn`，
   不抛异常也不写日志（原始 HEX 那一行已经记过了）。

断言集为此加了 10 条（行为 8 条：走后端命令 / 整条值 / 日志前缀 / 长度不符不猜 / 非 CTS 不解读 /
`2A0F` 也认 / 失败不抛不写 / 两条路都接了；源级 2 条：命令已注册、摘要共用一份）。
⚠️ 加这一行时**断言集当场抓到一处真问题**：另一个沙箱跑 `bleCharAction` 的读取分支，
新依赖 `bleCtsLogDecoded` 没注入 → `ReferenceError` —— 这正是"假前端沙箱必须补全被调函数"的意义
（AGENTS #11 ③：跨边界漏一处，两边各自测自己那一半时全是绿的）。

**没做（有意）**：
- **不做从机方向的 CTS**：从机方向已整条删除（广播起不来），先有广播再说。
- **不做 `2A14` Reference Time Information 的解码**：字段少用且我对 Time Accuracy 的单位没把握，
  宁可不解也不编（要加先对着 SIG 规范核）。
- **不在界面加"解读为时间"按钮**：这一步的消费者是 AI（`ble_read` 的返回值本来就只进面板日志）；
  真要做"AI 也自动看到"的自动识别，得先把 UUID 带进日志条目 —— 那件事在同日的 **B 方案**里做了
  （见本节开头那条记录）。

**验证**：`cargo test` **238 通过 + 1 ignored**（+6：解码器 5 条（正常值/可疑值/位域/时区与 DST/长度校验）
+ MCP 层 1 条（HEX 与数组两种输入同结果、四种误用都是 -32602））；前端断言集 **1566 通过**（只改了工具数断言）；
`doc/MCP_TOOLS.md` 重生成（**54** 个工具 = 19 通用 + 16 串口语义 + **13** 蓝牙语义 + 6 ADB）。

### 2026-09-17 · **删除 BLE 从机（外设）方向** + 发布 v0.5.10 ✅

**定案依据**：`ble_periph_starts_advertising`（那条 `#[ignore]` 真机用例）在本机一直失败 ——
适配器自报 `present=true / low_energy=true / peripheral_role=true`、**GATT 服务与特征建得出来**
（`ble_periph_builds` 通过），但 `StartAdvertisingWithParameters` 的落定状态是 **Aborted**：
广播起不来 ⇒ 中心设备永远发现不了本机 ⇒ 整条从机链路没有意义。用户据此拍板：
"从机方向的代码删除，确认是实现不了了。"

**删了什么**（一条方向必须删干净，否则会留下"能点但必然失败"的入口）：

| 层 | 内容 |
|---|---|
| Rust 后端 | `main.rs` 的从机模块（~1170 行）+ `mod ble_periph_tests`（~580 行，含那 3 条 `#[ignore]`）+ 9 个 `#[tauri::command]` + `BlePeripheralState` 托管状态 + 退出时的"停止广播"清理 + `bridge.rs` 超时档里的 `periphStart`/`periphStop` |
| MCP | 3 个工具（`ble_periph_status/start/stop`）的定义 / 分派 / 契约表 / 调用情况用例 / 假前端分支，以及 `WRITE_TOOLS` 与 **`DANGER_TOOLS`** 里的条目 |
| 前端 | 从机模式 UI（模式切换器 / 表单 / 预设 / 多套配置 / 事件轮询 / 写入弹窗的两态分支）、配置键 `mode`/`periph`/`periphSaved`、只属于从机的 CSS（`.ble-pf-*`、`.ble-mode-*`）、`30-mcp.js` 的三个 action 与 domId 映射 |
| 依赖 | `windows` 里只它用到的三个 feature（`GenericAttributeProfile` / `Storage_Streams` / `Radios`）+ `windows-future` 依赖 |
| 文档/断言 | `BLE_PERIPHERAL.md` 加**归档抬头**（证据保留：它是"为什么不行"的唯一记录）、`BLE_VERIFICATION` / `README` / `TODO`（V5 结案）/ `HANDOVER` / `FRONTEND_LAYOUT` / `MCP.md` / `AGENTS` 同步；工具数 **56 → 53**；断言集删掉从机检查 |

**旧客户端怎么办**：工具定义**编译在 exe 里**，客户端要重连才会重读 `tools/list`，所以配置里很可能还留着
旧名字。三个旧工具名调过来会得到一句"**已删除 + 现在有什么**（主机方向那一串）"的 `-32602`，
而不是含糊的"未知工具"（后者会让 AI 反复试同一个名字）；由
`ble_peripheral_tools_are_gone_and_the_old_names_point_somewhere` 一路钉到错误码与文案。

**顺手修的顺序依赖**：`adb_shell_read_reads_the_loghub_channel_incrementally` 把 seq 写死成 1/2 ——
而 `hub.clear()` **只清内容、不重置 `next_seq`**，于是新增一个也用 `adb:rx` 的用例就会让它随执行顺序
随机失败（本批新增用例时暴露）。现在改成"由第一条的 seq 推出后一条"，钉的是**连续**。

**验证**：`cargo test` **232 通过 + 1 ignored**（3 条从机 ignore 用例随模块删除）、`cargo build` **0 警告**；
前端断言集 **1566 通过**（原 1730，减 164 条全是从机断言）；`doc/MCP_TOOLS.md` 重生成
（**53** 个工具 = 19 通用 + 16 串口语义 + 12 蓝牙语义 + 6 ADB 语义）。

**发布**：版本号 5 处同步 → **0.5.10**（`Cargo.toml` / `tauri.conf.json` / `installer.iss` / `package.json` / `Cargo.lock`），
由 CI 打安装包并发布 Release。

### 2026-09-17 · 检索档铺到 `adb_shell_read` / `ble_get_output`（顺带修掉一个**从来没生效过**的参数 + 补 `pattern` 上限） ✅

**接着上一批**（`log_search{mode}` 三档）做：用户批准"把 mode 也加到 `ble_get_output` / `adb_shell_read`"。
两个数据源**形状不同**，处理方式也不同：

- `adb_shell_read` 读的是日志中心的 `adb:rx` 通道 → 直接复用同一套整理逻辑；
- `ble_get_output` 读的是**蓝牙面板自己那份会话缓冲**（在前端），
  ⚠️ **不能**改用 `ble:rx` 通道（那是跨会话的另一份数据，混用会让"给不给 pattern"返回两套来源）。

**做法：把匹配语义抽成一份 `LogMatcher`**（`loghub.rs`），三个工具共用 ——
`log_search` 与这两个工具对同一个图案必须给出**同样的答案**，各写一遍迟早漂移
（"count 说 3 次、matches 说 2 处"这种最难查）。两档仍是上一批那条纪律：
只要布尔（lines）时字面量走 `contains`（memchr 级），要区间/处数（matches/count）才编译 regex。
顺手把 `count` 说清成两个数：`total`=命中**行/条目**数（`rg -c`）、
`totalMatches`=命中**处**数（`rg --count-matches`）—— "出现几次"原来是含糊的。

**顺手抓到一个真 bug（`ble_get_output` 的 `limit`/`sinceSeq` 从来没生效）**：
schema 里声明了两个参数，但分派写的是 `ble_call(core, "getOutput", args, json!({}))`
—— `ble_call` 只注入 `pane`，**参数根本没到前端**；前端 `parseInt(payload.limit)` 永远是 `NaN`
→ 每次返回全量（`limit` 形同不存在）。这正是 AGENTS #11 ② 说的"只校验不转发"。
调用测试原来只写 `calls: vec![("ble", json!({"action":"getOutput"}))]`（子集比较），
**恰好漏掉了它**；现在期望里必须带 `limit`，并由注释写明原因。
另外：检索档**故意不转发 `limit`**（要让"数一数出现几次"扫整份缓冲，转发会变成"数最后 N 条"），
`scanned` 会把真实扫过的条数报出来。

**补上一个该有的上限**：`pattern` 过去**没有长度限制** —— 请求体上限是 1 MiB，
而图案会被编译成正则，一条几十万字符的图案足以让这次调用卡住。
新增 `MAX_SEARCH_PATTERN_CHARS = 512`（`check_search_pattern` 在**碰主程序之前**拦，
报错里指路 `mcp_limits.maxSearchPatternChars`），三个工具共用；
`adb`/`ble` 的校验发生在**碰界面/设备之前**（测试里没有 GUI 也拿到 -32602 而不是 -32006）。

**顺手修了一个测试的顺序依赖**：`adb_shell_read_reads_the_loghub_channel_incrementally`
把 seq 写死成 1/2 —— 而 `hub.clear()` 只清内容、**不重置 `next_seq`**，
于是新增一个也用 `adb:rx` 的用例就会让它随执行顺序随机失败。现在改成"由第一条的 seq 推出后一条"，
钉的是**连续**（那才是它真正关心的性质）。

**没做**：这两个工具**不给 `context`** —— 条目是输出块/通知，不是按行切好的日志，
"块的前后几块"对调试没有意义。要上下文就用返回里的通道名去 `log_tail{format:"text"}`（文档里写明了）。

**验证**：`cargo test` **248 通过 + 4 ignored**（+3：adb 检索档（块里多次命中也数得对）、
ble 转发+过滤（含"text 为空时按 hex 搜"）、三方共用的图案上限；另修 1 条顺序依赖）；
前端断言集 **1751 通过**（+4 条源级断言：共用匹配器、ble 真转发、图案上限、三条测试在）；
`doc/MCP_TOOLS.md` 重生成。

### 2026-09-17 · **删掉 `log_export`**：唯一能把"全量日志"塞进返回体的工具 ✅

**起因**：用户一句"全量 log 的工具需要删除"。指的就是 `log_export` —— 我在评估 token 成本时点过它：
省略 `channels` 时它把**全部通道**（最多 64）× 每通道最多 **20000 行**按时间归并成一段文本，
而**返回体没有任何大小上限**（`MAX_BODY_BYTES` 只管请求体，`transport.rs` 的响应侧没闸）。
一次调用就可能拼出几十 MB：撑爆 AI 的上下文，客户端解析也会打摆。它也没有任何落盘能力
（实现里只回文本 `"本轮只返回文本，不写文件"`），所以它对普通用户唯一的价值就是"看全量"，
而那件事有不炸上下文的正确做法。

**怎么删的**（连引用一起清干净，避免"工具没了但断言/文档还当它在"）：

- `protocol.rs`：工具定义、分派分支、**契约表条目**、两处测试里的工具名清单、
  `log_tools_work_without_gui` 里那段实调、以及两处提到它名字的注释。
- `loghub.rs`：`LogHub::export()`（只被这个工具用）+ 它的单测（否则就是死代码警告）。
  ⚠️ `CallLog::export()` **不能删** —— 那是 `mcp_calls{format:"md"}` 在用的另一回事。
- `.walkthrough`：文档生成器的 META/GROUPS、断言集里的工具名清单；
  另加两条**守着"别顺手加回来"**的断言（源码里不许再出现 `"name": "log_export"`，
  且必须存在"旧名字能指路"的实现与测试）。
- 文档与计数：`doc/MCP.md`（工具表 + 一段"它为什么被删了、现在用什么"）、`README.md`
  （顺手修掉两处早就过期的"33 个工具"）、`AGENTS.md` / `doc/HANDOVER.md` 的工具数 57 → **56**、
  `doc/MCP_TOOLS.md` 重生成。

**旧客户端怎么办**：工具定义**编译在 exe 里**，客户端要重连才会重读 `tools/list`，
所以配置里很可能还留着这个名字。因此没有让它掉进通用的"未知工具"分支（只回
`未知工具: log_export` 会让 AI 反复试同一个名字），而是专门一条分支回：

> `log_export 已删除：…（为什么）…要读日志用 log_tail{format:"text"}（配合 sinceSeq 增量跟进）
> 或 serial_get_output{format:"text"}；只想知道"出现几次"用 log_search{mode:"count"}。`

由 `log_export_is_gone_and_the_old_name_points_somewhere` 一路测到错误码与文案（要求含"已删除"
且提到替代工具）。

**没做（留给以后）**：如果确实需要"导出文件"，正确的形状是**写文件**（用户可见的原生框选路径，
与 `quick_cmds_*` / `save_log` 同一套纪律）+ 硬上限，而不是把字节倒进对话里。

**验证**：`cargo test` **245 通过 + 4 ignored**；前端断言集 **1747 通过**；
`doc/MCP_TOOLS.md` 重生成（**56 个**工具，页内计数由生成器写死取自实际清单）。

### 2026-09-17 · 评估"日志改用 ripgrep" → **不集成**；改成给 `log_search` 加三档返回 + 修掉自己引入的回归 ✅

**起因**：用户在上一批（`format:"text"`）之后问："log 采用 ripgrep 可不可行，是不是会更省，又不会影响 AI 查看"。

**先把搜索本身量了**（`loghub::search`，1820 行/通道的同一批数据）：

| 任务 | 我们的内存实现 | ripgrep 15.1.0 子进程 |
|---|---|---|
| 纯进程启动 | — | **20.28 ms** |
| 单通道字面量未命中 | **0.42~0.50 ms** | 20.78 / 24.59 ms |
| 单通道正则 | 1.38~2.23 ms | 22.64 ms |
| 全通道（4.7 MB 正文 / 58,240 行） | **13.0~15.7 ms**（冷缓存 23.2 ms） | 29.52 / 32.09 ms |

**结论：不集成**，四条理由（写进这里免得下次再评估一遍）：

1. **数据在内存里**，要交给 rg 就得先落盘 —— 等于在串口收发热路径旁边再造一套"独立线程 + 有界队列
   + 轮转 + 丢弃记账"，还把"退出即消失"的日志永久留在用户磁盘上；
2. **要随安装包分发 `rg.exe`**（用户机器上通常没有，本机有是我的环境）；
3. **进程启动 20 ms 就打不过 0.56 ms** —— 单通道场景慢 ~40 倍，全量场景只是打平；
4. **rg 的强项用不上**：mmap、并行遍历目录树、ignore 规则都不存在；而"字面量预过滤"我们**本来就有**
   （`regex 1.12.3` 的依赖树里已经带着 `aho-corasick 1.1.4` 与 `memchr 2.8.1`）。

**该抄的是它的"少输出"**（省 token 的关键是回多少文本，不是搜得多快），于是给 `log_search` 加了三档：

- `mode:"count"`（`rg -c`）：只回 `total` + 每个有命中的通道各几次。**必须扫完**才能给出正确数字，
  所以这一档故意**不受 `limit` 影响**（有单测钉着：300 行 / limit=5 仍报 100）。
- `mode:"matches"`（`rg -o`）：每条命中只回 `match` 片段（一行多处算多条），
  长行日志（HEX dump、一行几十 KB 的 JSON）用它比回整行省得多；零长匹配跳过（否则 `a*` 会塞满 limit）。
- `mode:"lines"`（默认，行为不变）+ 新增 `context` 0~5：命中行前后各带几行，省掉"再 tail 一次"的往返；
  配在非 `lines` 档上是 **-32602**（静默忽略会让调用方以为上下文已经给了）。

三档的 token 量级差一个数量级（单测直接比 `structuredContent` 体积：`count` < `matches` < `lines`，
且 `count * 10 < lines`）。

**过程中自己踩了一个坑，值得记**：为了给 `matches` 拿到原文里的**字节区间**，
第一版把**所有**搜索都改成"编译 regex"（子串先 `escape`）—— 结果 1820 行的未命中扫描从 0.56 ms
涨到 **1.27 ms**。旧实现走 `contains`（memchr 级）才是对的。现在只有"要正则"或"要区间（matches）"
时才编译 regex，`lines`/`count` 的字面量继续走 `contains`（回到 0.42 ms），
并由 `literal_search_treats_metacharacters_as_plain_text` 钉住"字面量按字面量处理"。

**另一个"量完就撤"的改动**：我原本判断"搜索每次克隆整个通道（每行一次 malloc）比匹配还贵"，
于是把 `LogLine::text` 从 `Box<str>` 换成 `Arc<str>`。隔离实测（1820 行/次快照 ×20）：

- 克隆 `Vec<LogLine>`（Arc 版）1.686 ms → **84 µs/次**
- 等价的独占字符串克隆 1.901 ms → **95 µs/次**

差 ~11 µs ≈ 搜索时间的 **2.6%**；而 `Arc<str>` 每行多 16 字节引用计数头，
同样内存预算下**少存约 11% 的日志**。**换回来了**（`LogLine::text` 仍是 `Box<str>`）。
真正的成本在**逐行子串匹配的固定开销**（~186 ns/行，`contains` 的 TwoWay 短 haystack 起步价），
而 0.4 ms/通道、全局上限 ~13 ms 对一次工具调用本来就不是瓶颈 —— **不值得为它动内存账**。

**验证**：`cargo test` **245 通过 + 4 ignored**（+3 `log_search` 契约/行为：三档体积与精确计数、
`context` 边界、参数误用四种；+2 loghub：`count` 精确、`matches` 片段与零长跳过；+1 字面量不当正则）；
前端断言集 **1747 通过**（+8 条源级断言：三档存在、白名单、`contains` 快路径、零长跳过、
`context` 校验、以及"text 是独占字符串"这条反向守护）；`doc/MCP_TOOLS.md` 重生成（57 个工具）、
`doc/MCP.md` 加了「找东西时先选对要多少信息」。

**留给以后**：真要再快，只有换数据布局（连续 arena）这一条路，收益也不值得；
真要搜"跨会话历史"就去读 `%APPDATA%\seahi-serial\log-cache\session-*.log`
（用户自己 `rg` 即可，或者将来做一个进程内读文件的工具）。

### 2026-09-17 · 读日志加一档 `format:"text"`：省 token，但**不许少看一行** ✅

**起因**：用户两连问 —— ① "串口运行的日志在 MCP 中会截断吗？"；② "如果所有 log 都给 AI 读，
是不是很消耗 Token？"。把账算出来之后，答案是**非常耗，而且"全给"物理上不可能**：
`log_tail` 每行都带 `seq/ts/t/level/dir/bytes/text` 六个字段，**每行固定烧掉 ~100 字节**
（实测 200 条短行 **101 字节/行**，包装比正文长十几倍）；而 `serial:` 通道上限 512 KiB，
短行能存 ~6200 行 → **一个分栏的完整日志就是几十万 token，超过 200k 上下文**；
顶到全局 16 MiB 就是百万级。串口调试恰恰**全是短行**（`OK`、`AT+GMR`），
是 token 效率最差的一类输入。

**做成什么样**（`log_tail` 与 `serial_get_output` 共用一套）：

- 新增参数 `format`：`json`（默认，行为完全不变）/ `text`（一行一条纯文本）。
  取值不认识 → `-32602` 并把可选值写出来；**绝不静默退回 json**（静默会让"我想省 token"悄悄失效）。
- text 编码的写法：**头部一行元信息** + 一行一条 `[HH:MM:SS.mmm] [级别] 正文`
  （`serial_get_output` 用 `[时刻] [rx|tx] 正文` —— 那边两个方向是归并在一起的，不标就分不清谁说的）。
  **实测 200 条短行：json 101 字节/行 → text 29 字节/行（省 3.5 倍）**；
  行越长省得越少（长行只剩 ~30%，因为包装是固定的、正文是变长的）——
  所以"省多少"取决于日志形状，别把它当固定折扣。
- **正文搬进 `content[].text`，`structuredContent` 只留元信息**（`take_rendered_text`）。
  这一条是这个功能的**关键**，两个理由：
  ① 很多客户端只把 `content[].text` 给模型看，而通用摘要把整段日志压成 600 字 ——
     那正好把"省 token 的编码"变成"AI 看不到日志"；
  ② 两个渠道都会发给客户端，**同一段日志写两遍等于把省下的 token 又花回去**。
  搬运发生在 `calllog.record` **之后**，所以 `ai-calls.jsonl` 里仍然有全文。
  新增同类工具必须登记进 `TEXT_PAYLOAD_TOOLS`（`text_format_tools_are_all_in_the_text_payload_list`
  从 `inputSchema` 反查，漏登记就 fail）。
- **两种编码的数据与丢弃账完全一致**：`returned`/`seqFrom`/`seqTo`/`missed`/`dropped`/
  `mayBeIncomplete`/`truncated`/`nextSinceSeq`。还顺手补了两个原来缺的信号：
  - `missed`：给了 `sinceSeq` 时"这段窗口里存在过但没给你"的行数（seq 逐条连续，所以减法精确）。
    旧实现一次拉不完时会**静默跳行**，而 `truncated` 的旧口径要求 `dropped>0`，于是"取满 2000 行
    但没丢过"会**谎报 false** —— 现在 `truncated` 只表示"被行数顶住"，漏多少看 `missed`。
  - `nextSinceSeq`：下次该带的 `sinceSeq`。**推进到它才不会漏**（直接跳到 `seqTo` 会把没拿到的行永远跳过）。
- 正文里的 CR/LF 转义成字面量 `\r`/`\n`（转义规则**只有一处** `push_text_line`/`push_escaped`）：
  日志必须"一行一条"，否则 ADB 那种多行块会撑破页面结构、甚至**伪造出头部行**。
- 上限一个字没动：还是 2000 行、8 KiB/行、每通道 128 KiB~1 MiB、全局 16 MiB、64 通道 ——
  **编码只改写法，不改能拿多少**。

**顺带修掉一个记录在案的测试隐式依赖**：`every_tool_has_a_tested_return_contract` 单跑必失败
（`log_tail` 要的 `app` 通道还没被别的用例建出来）。现在用例开头 `ensure_channel("app")`
（不写内容、也不要求 hub 处于启用态）。

**验证**：`cargo test` **239 通过 + 4 ignored**（+3 loghub 编码/转义/漏读，+2 loghub 的 `missed`/`truncated`，
+4 契约与"真的更省"，+1 文本页头部）；前端断言集 **1739 通过**（+9 条源级断言：编码档、转义、
头部丢弃账、登记表、以及"有测试守着它"）；`doc/MCP_TOOLS.md` 重生成（57 个工具）、
`doc/MCP.md` 加了一节「读日志怎么才不烧 token」。

**没做（留给以后）**：`adb_shell_read` / `ble_get_output` 也还是纯 JSON，同一个模式可以照着套；
真要再省，下一步是"服务端先归并"（把 6000 行 `AT+GMR` 压成模板 + 计数），而不是继续砍写法。

### 2026-09-17 · 快速指令加「跳转」两列（分支与循环，不引入新语法）✅

**起因**：用户问"快捷指令的条件发送既然是文件驱动的，能不能更全面一点，比如支持文档里的 mermaid 流程图来执行发送循环？"。
评估的结论是：**mermaid 不适合当可执行格式**（它是渲染 DSL，没有超时/重试/失败策略这些执行语义槽；
`mermaid.parse()` 不吐 AST，真执行得自己写解析器；而引入渲染库与"单文件零依赖"冲突；更关键的是会变成**第三套**执行引擎）。
真正要的是"分支 + 循环"，而这些**两列表就能表达**。

**做成什么样**（口径与用户逐条对齐后才动手）：

- 两个**表头驱动**的列：`成功跳转` / `失败跳转`，面板上没有入口（与「期望」「重试」同一套做法：
  值只从文件读、只写回文件；可发现性靠"超时格描淡边 + 悬停列出内容 + 导入时提示一次"）。
- 取值只有三种：留空/`下一条`（缺省，行为与以前完全一致 → **老文件零影响**）、**数字 = 顺序号**、`结束`。
  为什么按顺序号而不是"第几行"：顺序号本来就是"参不参与、按什么次序发"的口径，跨组也能跳。
- 触发：收到 OK 走「成功跳转」；**ERROR 用尽或超时**都走「失败跳转」——
  超时也算失败是有意的（配网失败多半是超时，只认 ERROR 这功能就没用）。
- 两条护栏：**连续跳转上限 200**（中间只要顺序走一步就清零，抓的是"只在几条之间打转"的死循环）；
  **目标不存在时降级**（成功→下一条 / 失败→终止）并把原因写进输出区，绝不静默乱跳。
  导入时另有一次校验提示（`qcmdGotoWarnings` 把"指向不存在顺序号"的列出来）。
- 执行仍然只有**一个**状态机：`qcmdLoopStep` 在拿到结论后按跳转列**改写下一个位置**
  （`_qcmdLoopPos`），并重新取一遍计划再定位（与"每步重取计划"同一纪律）。
- MCP：`serial_quick_cmd` 的列表项与 `add`/`update` 都带上 `okGoto`/`errGoto`，
  并且**真的放进 payload**（只校验不转发=前端永远收不到）；取值白名单在 Rust 侧也拦一道。

**关于"以后要不要上 DSL/图"**：因为 ① 已经把"分支 + 循环"做成了数据，**DSL 就只是"另一种写这张表的方式"** ——
将来若真要做，加载方式是"同文件里的 ```qcmd 围栏块（复用现成的块序列机制）→ 编译成这张表 → 跑同一个状态机"，
不新增执行引擎；但有个必须一起定的约束：**DSL 块只读**（面板是表格视图，两边可编辑就会掉进"双视图同步"的坑）。

### 2026-09-17 · 工作流规则接进 MCP（`serial_workflow` / `serial_workflow_run`）✅

**起因**：用户问"串口监视器的规则功能，MCP 服务器有没有支持？"。查完的结论是：**读得到、写不了**——
`ui_get_state{section:"serial"}` 里每个监视器都带着完整的 `workflows[]`（`collectConfigForMonitor` 原样深拷贝），
但没有任何专用工具；靠通用桥去点那些控件时，规则卡片与它的控件**都没有 id**，注册表只能给
"面板+标签名+文档序"的兜底路径（`serial.ui.input_12`），规则一增删路径就漂，而 AI 看到那种路径
**也不知道它是哪条规则的哪个按钮** —— 误点那颗"运行"就等于让规则开始自动往设备发数据。
另外规则触发过的 `[Auto]` 消息只进 `reader.events`（前端轮询显示），**没进日志中心**，AI 查不到。

**做成什么样**：

- 一条工具管规则本身（`serial_workflow`，`action` = `list`（省略即它）/ `add` / `update` / `remove`），
  启停**单独一条**（`serial_workflow_run`）—— 因为"危险"只发生在跑起来那一刻，把整条工具塞进
  `DANGER_TOOLS` 会让"列出规则"也要 confirm（把确认门用歪了）。`is_write_call` 按 action 判：
  `list` 是读，其余是写（只读模式下读得到、改不了）。
- **新规则一律 `running:false`**；`update` 里 `running` 只接受 `false`（停一条正在跑的），
  传 `true` 直接 `-32602` 并告诉你该走哪条工具 —— 想启动必须过 `serial_workflow_run` 的 `confirm` 门。
- 前端分支（`mcpSerialOp` 的 `wfList/wfAdd/wfUpdate/wfRemove/wfToggle`）**直接改 `monitor.workflows`
  再 `renderWorkflowList` + `saveWorkflowConfig`** —— 与面板改的同一条路，不另写一套。
- 上限（规则 50 / 条件 8 / 动作 8 / 名称 64 / 条件值 512 / 动作数据 4096）进 `mcp_limits`，
  并且**在碰界面之前被执行**（`check_workflow_args`，前端 `mcpWfValidate` 同口径）。
- **给工作流卡片的关键控件补了稳定 id**（`{mid}-wf-{ruleId}-name|enabled|run|fold|del|c{i}|a{i}|ad{i}`，
  统一由 `mcpWfElId` 生成）：注册表从此按 id 认门，`ui_list` 里看到的是
  `serial.adv.wf-xxx-run [运行]` 而不是 `input_37`。
- `[Auto] …` 同一行也推给日志中心的 **`workflow` 通道**（`LogHub::push`，非阻塞），
  AI 用 `log_tail{channel:"workflow"}` 就能查"这条规则到底跑没跑过"。

**顺带修掉一个既有 bug**：`WorkflowAction.delay_before` 只认 snake_case，而前端与 `config.json` 里
一直写的是驼峰 `delayBefore` → serde 落到 `default` = 0，**面板上填的「延时(ms)」从来没生效过**
（静默失效）。现在加了 `#[serde(alias = "delayBefore")]`，两个名字都认。

**测试**：Rust 仍 **229 passed / 0 failed**（新工具并进了既有的"返回值契约表"与"界面工具 op/参数序列"
两张表，所以条数不变）；前端断言集 **1703 passed / 0 failed**（新增 24 条：wfList/wfAdd/wfUpdate/
wfRemove/wfToggle 的真函数行为、六类非法入参 → `invalidParams`、控件 id 的形状与"必须由 mcpWfElId 生成"、
以及延时两种字段名都认）。

### 2026-09-17 · 快速指令改成"发一条、等它回话"（循环发送的闭环）✅

**起因**：用户提出"指令按序号一条一条跑；回复有 busy / OK / ERROR 三种 —— busy 就继续等、ERROR 重发本条、
OK 下一条；把延时改成超时，超时还没等到 OK 就终止工作"。

**最终形态**（经过一轮"太复杂了"的返工，砍掉了模式开关与展开式参数面板）：

- 时长那一格从「延时」变成**超时**（这条发出去最多等多久）。旧列名 `延时`/`delay` **照读**
  （`qcmdItemTimeout` 兜底旧字段），导入时提示一次 —— 语义变了就明说，不做静默变更。
  填 `0` = 这条不等响应（连续 HEX 帧）。
- 规则：`busy` 继续等（不重发、也不算结论）/ `OK` 下一条 / `ERROR` 重发本条（缺省 3 次，可配）/
  等满超时 → **终止整条链**（toast 写明哪一组第几条、等了多久）。
- **判定只在 Rust 做一份**：`QcmdHs` + 四个命令 `qcmd_hs_arm / _state / _feed / _stop`。
  普通串口由 `PortReader` 读线程直接喂（同一块数据、不复制）；WSL 没有读线程 → 前端把
  `read_wsl_serial` 拉到的块喂给 `qcmd_hs_feed`。**绝不在 JS 里再写一套匹配**（两套必然漂移）。
- 三处最容易做错、都写进了注释与断言：① **arm 必须早于 send**，否则设备的回话会赶在 arm 之前到达、
  被当成"上一条的迟到数据"丢掉 → 这一条必然白等到超时；② **跨块的行拼装**（`OK\r\n` 可能被拆成
  `O` + `K\r\n`）；③ **busy 不是结论**，且 `ERROR` 优先于 `OK`（`+CME ERROR` 也算失败）。
- 超时由前端轮询 `qcmd_hs_state` 时**结算**（不另起定时器）→ 没有"定时器忘了清"的悬挂状态；
  `stopQcmdLoop` 一次清干净定时器 / 轮询 / 重入闸，并调 `qcmd_hs_stop`。
- **面板零新增控件**：自定义条件（`期望` / `重试`）写在文件表头声明的列里（与「名称」列同一套先例），
  面板上的可发现性靠"超时格描淡边 + 悬停列出内容 + 导入时提示一次"；导出（自包含副本）一定写这两列。
- MCP：`serial_quick_cmd` 的列表项换成 `timeoutMs`/`expect`/`retry`，`add`/`update` 收这三个
  （`delayMs` 作为**旧拼写**继续认并转发），并且**真的放进 payload** —— `serial_call` 只转发 `extra`，
  "只校验不转发"就等于"工具回了 ok、参数却没生效"（batch 4 漏过一次）。三个上限进 `mcp_limits`
  且**被执行**（`check_quick_cmd_item_params`，在碰界面之前）。
- 断言：前端 `.walkthrough/gen_ble_preview.js` 1675 条（新增的循环状态机段用**真 Promise** 收口在文件末尾，
  跑完才 `process.exit`；`extractFunction` 顺带修了"丢掉 `async` 前缀"的老 bug）；
  Rust 12 条 `qcmd_hs_tests`（跨块 / busy / ERROR 优先 / 自定义词 / 超时结算 / arm 重置 / 缓冲上限）。

### 2026-09-16 · 「把 COM7 映射到 WSL」整条链路打通 ✅（读得到设备表 / 点得准那一行 / 不再假成功）

**起因**：用户问"如果我对 AI 说：帮我打开 WSL 端口映射，然后把 COM7 映射到 WSL 当中，然后打开该串口监视器，
打开串口然后抓 log —— MCP 的真实调用应该是什么样的？"。**先照着这条链路实测，再看代码**，结果第 2 步是断的。

#### 实测证据（对着正在跑的应用，用一次性探针，只读为主）

```
ui_click {"path":"global.ui.wslToggleBtn"} → -32007（只读模式开着）
ui_get_state {"section":"wslDevices"}      → -32602 没有这个区段（可用：serial / wsl / ble / bleDevices / theme / window / monitors）
ui_list {"panel":"wsl"}                    → total = 0
ui_list {} （全量）                        → total = 155，其中 74 个的 label 是 input_N / div_N 这种兜底命名
```

#### 四个根因

| # | 缺口 | 为什么是"断"而不是"不好用" |
|---|---|---|
| 1 | **读不到设备表**：`ui_get_state` 没有 `wslDevices` 区段，`serial_list_ports` 只列 Windows COM 口 | AI 不知道哪台设备是 COM7、busid 是多少、映射没映射。**没有任何工具能枚举 WSL 侧的 USB 设备** |
| 2 | **点不准那一行**：设备行是动态 `innerHTML`，行里的「映射」复选框**连 id 都没有** | `mcpEntryFor` 对无 id 元素走"标签名_全局序号"兜底 → `wsl.misc.input_127`，label 也是 `input_127`。**没有任何设备身份**，AI 只能盲点 |
| 3 | **点了会假成功**：`mcpWriteEl` 对 checkbox 是 `el.click()` 后**同步**返回 `!!el.checked`，而 `toggleWslMapping` 是 async（`await attach_port_to_wsl`，60s 超时；需要提权时还弹模态框等用户在机器上点「授权并映射」） | 回执立刻回 `value:true`，**而设备根本没映射上**。AI 会以为成功然后去开串口，然后拿到一个莫名其妙的下一个错 |
| 4 | **可能映射错设备**：设备表每 5 秒 `innerHTML` 重画，节点总数不变时 `mcpEnsureRegistry` **不重建**（它只比数量），且行内 `onchange` 带的是**下标** | 注册表里留着**已脱离 DOM 的旧元素 + 旧下标**：`el.click()` 照样跑 inline handler，用旧下标调 `toggleWslMapping` → **映射到另一台设备**。把错的 USB 设备挂进 WSL 是有副作用的 |

**这不是新问题**：BLE 早就踩过同一类（`ui_get_state` 里那段注释写着"设备卡片是动态生成的 div、
不在控件注册表里，所以面板上明明扫到了、AI 却读不到"，于是有了 `section:"bleDevices"`）。
**WSL 只是没跟着做** —— 缺的正是它那一份。

#### 交付物

| 层 | 改动 |
|---|---|
| `src/index.html` | ① `ui_get_state` 加 `wslDevices` 区段（`mcpWslDevicesState`）；② 设备行三个控件给稳定 id + `aria-label` 身份（`wslRow-<busid>` / `wslMap-<busid>` / `wslAutoMap-<busid>`）；③ `toggleWslMapping(mid, idx, checked)` → `toggleWslMapping(busid, checked)`（**按 busid 寻址**，顺带删掉已无用的 `mid`）；④ `mcpWslMapOutcome` + 界面桥把结果挂进回执（`mapRequest`）；⑤ `mcpEnsureRegistry` 增加"元素还在不在 DOM 里"的探测；⑥ `mcpSerialPortOptions` + `serial_get_state.portOptions` |
| `src-tauri/src/mcp/protocol.rs` | `pub const PANE_DESC`（13 处重复的 `pane` 描述**只写一处**，并补上 `wsl`）——原先只有 `main / extra-1 / …`，AI 压根不知道能用 `pane:"wsl"`；`ui_get_state` 的 enum/描述加 `wslDevices` 与 `mapControlPath`；`summarize_wsl_devices`（+ 按载荷形状分派）；`serial_select_port` / `serial_list_ports` 的描述改成不再误导（原文写"值必须是 `serial_list_ports` 返回的端口名"，对 WSL 分栏是**错的**） |
| `.walkthrough` | `gen_ble_preview.js` +28 条（含**行为**断言：注册表脱离 DOM 必重建、`mcpWslControlPath` 与真实注册表路径一致、`mapRequest` 三态、`portOptions`）；`gen_mcp_tools_doc.js` 支持 schema 里的 Rust 常量引用 |
| `doc/MCP.md` | 新增「把 USB 串口映射进 WSL（一条完整的链路）」四步表 |

#### 两条"设计上刻意如此"

1. **不给 WSL 单开一套工具**（用户明确的原则：两边功能完全一样，做两套必然漂移）。
   仍然是同一套 `serial_*` + `pane`，只在**数据来源**上分流；映射本身就是界面上的一个动作，
   所以走通用桥（`ui_set` + `mapControlPath`），不新增语义工具 —— 工具数仍是 **55**。
2. **回执不等待**。映射那条路最长要几十秒、还可能挂在一个等用户点确认的授权框上，而界面桥的预算是
   **5 秒**（`bridge.rs::UI_TIMEOUT_MS`）。判据用 `_wslBusy[busid]` —— `toggleWslMapping` 在**第一个
   `await` 之前**就把它置起来了，所以 `el.click()` 一返回就能确定"到底跑起来没有"，
   **不用等、不用轮询、不会撞预算**。`settled=false` + `note` 如实说"已发起但没完成，别重试，
   去 `wslDevices` 看 status"。这与 `ble_connect` 那次"桥超时给 AI 一个假失败"的教训同源：
   **宁可说"还没好"，也不要说错**。

#### 同日补记：AI 动手时界面会不会切页？—— **写切、读不切**，并顺手治了"懒创建分栏"

用户接着问"AI 在控制 WSL 面板时，前端不会跳转到 WSL 面板吗？"。查下来答案是**分两条路，而且不一致**：

| 走哪条 | 原先会不会切页 | 依据 |
|---|---|---|
| 通用桥 `ui_set` / `ui_click`（含上面第 3 步的映射） | **会** | `mcpHandleUiCmd` 在写之前先调 `mcpRevealPaneFor(ent.panel)` |
| `ble_*` 语义工具 | 写会、**只读不会** | `mcpBleOp` 顶部那段判断（注释写明理由："客户端一 poll 就把用户从别的页面拽走，比看不见更烦人"） |
| `adb_*` 语义工具 | **会** | `adbEnsurePaneVisible`：除了"看得见"，还因为面板隐藏时 `syncAdbTermSize` 会主动跳过（容器尺寸为 0 → PTY 被压成 2×2） |
| **`serial_*` 语义工具** | **一处都没有** | `mcpSerialOp` 里没有任何切页调用 —— 与 BLE/ADB 不一致 |

于是 AI 在读着串口页的时候操作 WSL 分栏的串口，**界面一动不动**，用户看不见 AI 在动哪一栏 ——
正是当初加 `mcpRevealPaneFor` 要解决的"看不见 AI 在干什么"。

**而且查这件事时撞出第二个更硬的问题**：`serial_*{pane:"wsl"}` 在 **WSL 面板从没打开过**时直接回
"没有这个分栏"。真机实测：

```
serial_get_state{}            → panes = ["main"]
serial_get_state{pane:"wsl"}  → -32602 没有这个分栏: wsl；可用分栏: main
ui_get_state{}                → monitors 里有 ["main","wsl"]
```

根因：`monitors['wsl']` 是 `openWslMapping()` → `initWslMonitor('wsl')` **懒创建**的，在那之前运行时
根本没有这一栏。而**配置里却有**（`ui_get_state.monitors`），所以 AI 会觉得"工具自相矛盾"。

**两个问题其实是同一个修法**：切页那一步恰好就是创建它的那一步。所以：

1. `mcpSerialOp` 里加 `MCP_SERIAL_WRITE_ACTIONS` 分类表 + `mcpSerialRevealForPane(payload.pane)`，
   **在解析 pane 之前**切页 —— 写动作因此既让用户看得见，又**冷启动也能直接成功**（不用 AI 先手动开面板）。
   判据抄 BLE 那条纪律：**写切、读不切**（读动作是 `panes` / `state` / `history` / `quickList`）。
2. `mcpSerialMissingPaneHint(pane)`：分栏"不存在"有两种 —— ① 名字写错；② **还没被创建出来**。
   第 ② 种明确说破并给下一步（`ui_click global.ui.wslToggleBtn` / `addMonitorBtn`），
   并注明"**写操作会自动打开它**，只有只读工具才会碰到这个提示"；名字真写错时**不套**这段提示（免得成噪音）。
3. `PANE_DESC` 补上这两条（13 个工具共用），省得 AI 以为"页面自己乱跳"。

**跨端断言**：`protocol.rs` 发给 `serial` 面板的每个 action 都必须被分成写/读两类 ——
否则以后加一个写动作会**静默地不切页**（两端各自的测试都绿，只有用户觉得"看不见 AI 在干啥"）。

验证（本条补记）：`cargo test` **213 passed / 0 failed / 4 ignored**（不变）、断言集
**1651 passed / 0 failed**（这条补记 +6：写动作切页并建出懒创建的分栏 / 只读一个页面都不切 /
"懒创建"的报错给出下一步 / 名字真写错时不套那段提示 / `extra-N` 指向"加监视器" /
每个 serial action 都被分类）。

#### 仍未做（记录在案）

| 编号 | 缺口 | 若修的思路 |
|---|---|---|
| R8 | 授权框（`#wsl-map-approval-overlay`，60 秒自动取消）**AI 点不到也看不见** —— 它只知道"还在进行中" | 要么把"正在等授权"作为 `mapRequest.pendingApproval` 报出来（AI 就能提示用户去点），要么明确"这个框必须人来点"并写进文档（当前是后者：`note` 里说了要用户确认）。⚠️ **不要让 AI 自动点那个框** —— 那是提权授权，等同把 UAC 交给模型 |
| R9 | 端口下拉被别的分栏占用时 `inUse:true`，但工具**没有**"释放/抢占"的入口 | 复用界面的占用检查逻辑，给一条明确的错误而不是静默失败 |
| R10 | `_wslDevices` 里 `port` 为 `-` 的设备（没识别到 COM 名，如网卡/键盘）也会出现在 `wslDevices` 里 | 前端已在 `mapControlPath` 上保持一致；若 AI 误映射非串口设备，考虑在描述里提示"优先选 `hasCom:true` 的" |

验证：`cargo test` **213 passed / 0 failed / 4 ignored**（新增
`ui_get_state_advertises_the_wsl_device_section`、`ui_get_state_wsl_devices_text_carries_busid_and_com`；
假前端的 `getState` 改成**按 section 回不同形状** —— 原来固定回 `{theme}`，那两个 `ui_get_state` 用例的
`keys` 因此是摆设）、断言集 **1645 passed / 0 failed**（其中一条是把 `index.html` 的每个内联
`<script>` **整段**编译一次 —— 按名字抽函数的断言盖不到"没被抽到的那个函数有语法错"）、
npm 自测 **94 passed / 0 failed**。（随后同日的"界面切页"补记又把它加到 **1651**，见上。）

### 2026-09-16 · WSL 分栏上的 `serial_*` 被"本机没有可用串口"挡死 ✅（P0）

**起因**：用户提问"WSL 端口映射也有串口监视器，MCP 的串口操作工具，有没有和主页的串口监视器做区分？
如果没有，是不是可以通过监视器 ID 来区分"。

**先答设计问题**：**本来就区分** —— 语义工具用 `pane` = 监视器 ID 寻址（`main` / `extra-N` 是 Windows 分栏，
`wsl` / `wsl-xN` 是 WSL 分栏），BLE 那个内嵌监视器由前端 `monitors[mid].bleEmbedded` 标记并排除在
`mcpSerialPanes()` 之外。用户随后明确了原则：
**不做两套工具**（两边功能完全一样，做两套必然漂移），**只按 `pane` 区分数据来源**
（Windows 侧 `list_ports` / `open_port` / `send_data`，WSL 侧 `get_wsl_serial_devices` / `open_wsl_serial` /
`send_wsl_serial`）。这条原则与 MCP 约定 #3（工具改界面走合成 DOM 事件、不给 AI 另写一套）是同一条。

**真刀真枪查下来抓到两条**（用户选了"先修两条 P0"）：

| 编号 | 问题 | 严重度 | 修法 |
|---|---|---|---|
| P0-a | `serial_open` 开头那条"一个串口都没有就别去点按钮"的前置检查（为省 6 秒轮询超时加的）**一律**拿 `crate::list_ports()`（Windows COM 口）判定 —— 于是 `serial_open(pane:"wsl")` 在"没有任何 COM 口"时立刻回 `-32006 本机没有可用串口`，而界面上点得通（WSL 那颗按钮走 `toggleWslConnection` → `open_wsl_serial`，跟本机有没有 COM 口无关） | **高**：触发条件正是 WSL 用户的**正常用法** —— USB 串口 `usbipd bind` 进 WSL 之后，Windows 侧本来就看不到那个口了。现象是"工具说不行、界面说行"，AI 只会去反复重试或改参数 | 新增 `fn pane_is_wsl(args)`（`p == "wsl" \|\| p.starts_with("wsl-")`，`trim` + 转小写），把前置检查包进 `if !pane_is_wsl(args) { … }` —— WSL 分栏跳过，交给前端自己报"WSL 里没有设备"。⚠️ 不能只按 `starts_with("wsl")` 匹配：`wslx` 这种不是分栏 id（回归测试 `pane_is_wsl_matches_only_wsl_panes` 守着，含 `main` / `extra-1` / 省略 `pane` / `wslx` / `not-wsl`） |
| P0-b | MCP 串口分派的 `refreshPorts` 分支两条分栏混着走 `MCP_SERIAL_FUNCS.refreshPorts(mid)`（Windows 那条），会把 WSL 分栏的端口下拉填成 Windows 的 COM 列表 | 中（**潜在**，见下） | 改成 `if (m.isWsl) refreshWslMonPorts(mid); else MCP_SERIAL_FUNCS.refreshPorts(mid);` |

**P0-b 的自我纠正**：这条同一个坑在"设备变更"那条路径上**已经踩过一次并修过**（`src/index.html`
里的 device-changed 注释就写着"此前统一用 refreshPorts，会导致…把 WSL 监视器端口填成 Windows COM 列表"），
当时漏了 `refreshPorts` 这个 action。但复查时发现：**当前没有任何工具会发出 `refreshPorts` 这个 action**
（`protocol.rs` 里没有对应的 match 分支；界面上那颗"刷新端口"按钮走的是它自己的 onclick）——
所以它是**尚未被触发过的雷**，不是线上正在发生的故障。这一点必须如实说明，不能把它记成"修好了一个正在发作的 bug"。
代码里留了注释说明"目前没有工具发这个 action"，免得后来人以为它是热路径。

**顺带确认（不是改动，是记录）**：`serial_open` / `serial_close` 在 WSL 分栏上**本来就路由正确** ——
它们点的是面板上那颗 `start` 按钮，而 WSL 面板的按钮是 `onclick="toggleWslConnection('wsl')"`，
所以只要 P0-a 不再提前拦截，这条路是通的（合成 DOM 事件复用的就是它）。

**当时仍未做（P1）—— 已在同日随后一并修掉**，见本文件更靠上的
「2026-09-16 · 「把 COM7 映射到 WSL」整条链路打通」：

| 编号 | 缺口 | 当时的修法设想 |
|---|---|---|
| P1-a | 工具 schema 的 `pane` 描述只写了 `main / extra-1 / extra-2 …`，**没有 `wsl`** —— AI 看工具定义时不知道 WSL 分栏能这么寻址 | 把这段描述抽成**一个常量**再用（`protocol.rs` 里有 13 处 `"pane"` 参数重复这段文字，改一处漏一处） |
| P1-b | **没有任何 MCP 工具能列出 WSL 侧的串口设备**（`serial_list_ports` 只列 Windows COM 口） | `serial_get_state` 的返回加 `portOptions`，让 AI 自己枚举 |

> 这两条只是"读不到 / 不知道"的缺口。随后按整条链路实测才发现**真正致命的是另一层**：
> 就算 AI 知道 `pane:"wsl"`、也能枚举端口，它**仍然映射不了设备** —— 那张 USB 设备表根本没有读的入口，
> 行里的复选框也没有 id，而且点下去的回执是**假成功**。详见上面那条记录的四点根因。

验证：`cargo test` **211 passed / 0 failed / 4 ignored**（新增 `pane_is_wsl_matches_only_wsl_panes`；
原有那条"没有串口设备时 `serial_open` 立刻失败"的测试跟着加强 —— 现在除了断言 `no_serial_port_hint`，
还要求它前面真有 `if !pane_is_wsl(args) {`）、断言集 **1616 passed / 0 failed**。断言集这一侧分两类：
① **源码断言** —— `pane_is_wsl` 存在、`serial_open` 的前置检查真的被它分流、没有 `wsl_serial_*` 这套
平行工具、以及那条老测试被加强了（正则要求 `serial_open` 分支里 `if !pane_is_wsl(args) {` 出现在
`no_serial_port_hint` 之前）；
② **行为断言** —— 把 `mcpSerialOp` 丢进假 DOM 真调一遍：`refreshPorts` 在 WSL 分栏上走
`refreshWslMonPorts`、在 Windows 分栏上走 `refreshPorts`，且分栏列表里能同时看到 `wsl` 与 `main`。

### 2026-09-16 · Streamable HTTP 落地：`POST/GET/DELETE /mcp` ✅（第 1+2 期一起做）

**起因**：用户提问"除了 SSE，是不是可以加一个 streamable-http 的连接类型"。核对下来是**设计有、代码无**：
§4.1 早就把 Streamable HTTP 规划成"同端口附带、薄封装、复用同一 SessionRegistry"、`aiConfig` 里还写了
`streamableHttp: true`，但 §17 的 S0~S3 记录里明确写着"本轮**未**实现 `POST /mcp`"。而现实是主流客户端
（VS Code / Cline / 新版 Cursor / Claude Code）**默认只走 Streamable HTTP**，只支持 SSE 的客户端越来越少。

**结论**：可以加，而且我们这种"一问一答"的工具集正好落在规范里最省事的那条路径上 ——
`POST /mcp` **直接回 `application/json`**，不必实现"POST 返回 SSE 流"（规范允许服务器二选一）。

#### 设计选择（每条都有代价，写下来免得后面被"优化"掉）

| 决策 | 为什么 |
|---|---|
| **POST 直接回 JSON，不做 SSE 流** | 我们的工具没有进度通知、没有中途消息，一条响应就是全部内容。走 SSE 只是多一层分帧、多一处能出错的地方 |
| **两类会话共用一张表**（`Session.tx: Option<Sender>`） | 上限 / 空闲回收 / 限流只有一套口径。另开一张 `http_sessions` 表就是两处实现，迟早漂移 |
| **表满时淘汰最久未活动的 HTTP 会话**（而不是 429） | ① 不能淘汰 SSE 会话：它的长连接已经建立，删表项只会把那条流变成收不到东西的僵尸；② 更不能回 429：客户端拿到 429 无从下手，只能干等 30 分钟空闲回收（会话泄漏那次就是这么炸的）；③ HTTP 会话被淘汰是**干净可恢复**的 —— 下次请求得 404，按规范重新 `initialize` |
| **`GET /mcp` 的流断开只摘通道、不删会话**（`keep_session_on_drop`） | 那个会话还要继续给 POST 用。`/sse` 的语义（流断开 = 会话结束）不能照搬 |
| **`Origin` 校验只加在 `/mcp`** | `/sse` + `/messages` 是既有路径，客户端本来就不发 Origin；为合规去赌"某个客户端带了个奇怪的 Origin"不划算 |
| **`MCP-Protocol-Version` 不认识就 400，但把支持列表写进响应体** | 规范要求 400；但光一个 400 调用方只能靠猜，所以把 `2025-06-18 / 2025-03-26 / 2024-11-05` 一起回过去 |
| **`streamableHttp` 默认开** | 多一个路由的运行时成本≈0；关掉的代价是用户看到"新版客户端连不上"却不知道为什么。要关随时在弹窗里点 |
| **npm 安装器默认仍是 `--transport sse`** | 已配过的用户重跑不会把配置改坏、只支持 SSE 的老客户端也不会突然被换成它不认的形态。要新形态显式 `--transport http` |

#### 交付物

| 层 | 改动 |
|---|---|
| `mcp/transport.rs` | 路由加 `POST/GET/DELETE /mcp`；`Session.tx` 变 `Option`；`open_sse` 拆出 `attach_outbound`（`/sse` 与 `GET /mcp` 共用）；新增 `resolve_http_session`（含淘汰策略）、`post_mcp` / `get_mcp` / `delete_mcp`、`origin_allowed`、`protocol_version_problem`、`read_body_limited`、`rate_limited_body`；`SseBody` 加 `keep_session` |
| `mcp/aiconfig.rs` | `ServerCfg.streamableHttp`（`#[serde(default)]` 默认开）、`Endpoint.urlStreamable`、`http_url()`、`host_in_url()` |
| `mcp/mod.rs` | `streamable_http()` 读取；`status_json` 增加 `streamableHttp` / `streamableUrl`（**两条 URL 都打码**）；`mcp_client_config` 输出两种传输的片段 + `streamableHttp` 别名片段；新增 `mcp_set_streamable` 命令；`mcp_config_set` 接受 `server.streamableHttp` |
| `src/index.html` | 弹窗拆成「Streamable HTTP / 遗留 SSE」两块（各含地址 + 客户端配置 + 复制）；`Streamable HTTP` 开关（独立 `_mcpStreamableBusy`）；关掉时隐藏那一块 |
| `npm/seahi-serial-mcp` | `--transport sse\|http`、`pickUrl()`、`desiredEntry(url, transport)`、幂等判断**同时比 type 与 url**、`status` 分辨两种传输、缺 `urlStreamable` 时给可操作提示 |
| `.walkthrough` | `gen_ble_preview.js` 新增/改写 74 条；`gen_mcp_tools_doc.js` 端点表与 curl 示例；`mcp_smoke.js` 支持 http 模式（`--transport`） |

#### 顺手修掉的两个既有问题

1. **`sse_url` 生成的 IPv6 地址是语法无效的**：`server.host` 允许 `::1`，但 `http://::1:7777/sse` 里的
   `::1:7777` 根本解析不出来 —— 选 `::1` 的用户拿到的两条 URL 全是打不开的。新增的 `host_in_url()` 统一加方括号，两个 URL 生成函数共用。
2. **心跳任务会漏**：`/sse` 的会话从表里删掉之后，心跳任务因为自己还持着一个 `tx` clone，`try_send` 照样成功，
   于是一直转到队列写满为止（15s × 256 ≈ **1 小时**）——每断开一次漏一个后台任务。现在心跳每跳检查会话是否还在表里，
   不在就退出（`DELETE /mcp` 也因此能干净收尾）。

另外两处"必须共用一份"的抽取：`read_body_limited`（`/messages` 与 `/mcp` 共用，**新入口不能绕过 1 MiB 上限**）、
`rate_limited_body`（两个传输给 AI 的"请放慢"文案不许漂移）。

#### 验证证据

- `cargo test --manifest-path src-tauri/Cargo.toml`：**205 passed / 0 failed / 4 ignored**
  （新增 7 条端到端：完整握手 + 202 + 404 + DELETE、开关关掉后 `/mcp` 404 而 `/sse` 照常、
  鉴权/Origin/协议版本三道门、body 上限、`GET /mcp` 收通知且流断开后会话仍在、
  表满时优先淘汰 HTTP 会话并保住 SSE 会话的广播，另有 4 条纯函数单测）
- `node .walkthrough/gen_ble_preview.js`：**1569 passed / 0 failed**（较上次 +75）
- `node npm/seahi-serial-mcp/test/self-test.js`：**84 passed / 0 failed**（较上次 +22）
- **跨进程真调**（`mcp_serve_for_manual_check` 起真服务，另起进程当客户端）：
  `node .walkthrough/mcp_smoke.js --url http://127.0.0.1:7799/mcp?token=testtoken`
  → **Streamable HTTP / 55 个工具有结果 / 0 个硬失败**；同一脚本对正在跑的应用走 SSE 也是 55 / 0。
  两条传输各跑一遍，才算"两边都是真的"。

#### 本轮**未**做（都记在 §4.6 / §9 里，不是遗漏）

`POST /mcp` 返回 SSE 流（规范允许二选一，我们选了 JSON）、`Last-Event-ID` 断线续传、
`resources/subscribe` 的资源推送、危险工具的二次确认。

#### 需要你在本机验证

**拿一个真实客户端连一次**（推荐顺序）：在弹窗里复制「Streamable HTTP」那块的配置 → 粘进
VS Code / Cline / Claude Code → 重启客户端 → 看它能不能列出 55 个工具。
我这里只能用自己写的客户端脚本跨进程验证，**它们证明不了"某个真实客户端的会话头/类型名处理"**——
而那正是这条链路唯一还可能出问题的地方。

#### 同日追加：传输改成**三档**，界面按需选择（用户看了截图后提的）

用户看到落地后的弹窗截图，指出"SSE 和 http 不应该同时支持吧，是不是可以按需选择"。

先把事实摆清：**后端同时提供两个端点本身没问题**（老客户端只认 `/sse`、新客户端只认 `/mcp`，
两个端点共用一套工具与状态；很多 MCP 服务器都这么挂）。真正乱的是**界面**——一屏同时摆两套地址 +
两份客户端配置，用户不知道该复制哪份。所以改的是"选择"与"展示"，不是"能不能同时服务"。

**方案（三档，而不是两档）**：把原来的 `streamableHttp: bool` 升级成 `server.transport`：

| 档位 | 含义 |
|---|---|
| `both`（**默认**） | 两条都提供（兼容性最好） |
| `http` | 只服务 `/mcp`；`/sse` + `/messages` 立刻 404 |
| `sse` | 只服务遗留 SSE；`/mcp` 立刻 404 |

为什么不做成"只 HTTP / 只 SSE"两档：那会让**升级本身**成为一次事故 —— 已经用 SSE 配好客户端的用户，
升级后客户端会立刻连不上，而他们并没有做任何选择。三档把"排掉另一种"变成**用户主动的动作**，
代价（谁会连不上）写在按钮的悬停说明里。

**界面**：弹窗最上面**一行四个控件**——`启用/关闭 MCP 服务器` + **传输下拉框**（`HTTP` / `SSE` / `All`，
值对应 `http` / `sse` / `both`）+ `只读模式` +（右端）`重置令牌`。
**只展示当前档确实提供的连接方式**，单档时另一块直接隐藏（展示一个只会 404 的地址等于让人白配一遍）。
切换立即生效（路由每次请求都读配置），不用重启服务器。

> 这一块界面被用户来回调整了五轮，最终形态就是上面这个（记下来免得下次又"优化"回去）：
> ① 一开始是"两种传输各一块，并列展示" → 用户指出"不应该同时支持，要按需选择"；
> ② 改成三档按钮组 + 一句灰字说明 → 用户要求删掉灰字（"写操作全被拒（-32007）""两条都在跑…"）；
> ③ 又要求**用下拉框替代按钮组**（`HTTP|SSE|All`）放到开关按钮右侧，"传输"那行整个删除；
> ④ 再把**只读模式也搬到同一行**，并把它固定成「只读模式」四个字 —— 开/关状态不写在按钮上；
> ⑤ 最后是**悬停提示本身**：用户截图指出原生 `title` ①"鼠标一扫就弹"、划过一排按钮**一闪一闪**，
>    ②一行铺开**横跨整个窗口**。于是说明改走 `data-mcp-tip`，由 `mcpTipBind()` **停顿 450ms** 才显示在
>    弹窗里那块**常驻说明区**（`#mcpTipRow` + `.mcp-tip`：`min-height` 占位不跳动、`pre-line` 能换行）；
>    控件名交给简短的 `aria-label` —— **删了 title 必须补它**，因为控件注册表的 label 取的是
>    `title || aria-label`（`mcpMakeEntry`），不补就会退化成元素 id，AI 那边等于失去这个控件的说明。
>    实现上顺手扩了断言集的假 DOM（`getAttribute`/`setAttribute`/`addEventListener`/`fire`），
>    并用**假定时器手动推进**验证"到点之前一个字都不显示"。
>
> 五条经验：**(a)** 后果说明（谁会连不上、只读是开是关）不占界面行数；
> **(b)** 但信息不能丢 —— 断言集里有断言钉住"下拉框的说明必须讲清三个选项各自的后果"
> 和"只读按钮的说明必须以「只读模式：开 —— AI 只能看」/「只读模式：关 —— 」开头"；
> **(c)** 下拉框在途要禁用、失败要把选中值**拨回真实状态**（否则界面停在一个没生效的值上，
> 比"报错"更让人困惑）；
> **(d)** 按钮文案固定之后，**在途反馈也得有地方去**（这里是把说明置为「处理中…」）——
> 否则点了没反应的观感会回来；
> **(e)** 只要说明一长，就一定会撞上"原生 `title` 不能用来承载长说明"这件事：它闪、不换行、
> 还会污染 AI 看到的控件 label。自己做一个**延迟出现的说明区**，代价只是那块要占一点高度。
> 断言集里共 30+ 条钉着这一行的布局与交互（控件顺序、只读不再单独成行、文字固定、选项值、
> 选中态跟随、隐显、解禁、失败回滚、选当前项不发 IPC、旧按钮组与两处灰字不许回来、
> 四个控件不许再有 title、说明区延迟/清空/focus 直显、长说明必须带换行）。

**升级路径（这里踩到一个真问题）**：老配置里只有 `streamableHttp` 这个 bool，迁移规则是
`false → sse`、`缺失/true → both`。第一版把 `transport` 设计成 `Option<TransportMode>`、只在读的时候
`unwrap_or` 推断 —— 结果是 `false` 那条配置**写回一轮后就变成 `both`**：`transport` 是 `None`，
序列化成 `"transport": null`，而老的 `streamableHttp` 字段是 `skip_serializing`，信息整个丢了
（用户当年主动关掉 `/mcp` 的意愿，在一次读写之间被静默抹掉）。修法是在**读入口 `load_in` 里做规范化**：
把推断结果落成 `transport` 的实际值并清掉兼容字段 —— 只有读入口同时看得到两个字段。
回归测试 `old_config_migrates_transport_mode` 覆盖"读进来是 sse → 写回 → **再读还是 sse**"。

**连带改动**：端点发现文件加 `transport` 字段，且**不提供的那条 URL 写空串**（不是留个连不上的地址）；
npm 安装器的 `readEndpoint` 因此不能再强求 `url` 存在（只提供 `/mcp` 时它就是空的），
`pickUrl` 要把"应用只提供另一种"讲清楚并给出两条出路（换 `--transport`，或去弹窗改档位）。

验证：`cargo test` **208 passed / 0 failed / 4 ignored**（迁移与三档各有回归测试）、
断言集 **1579 passed / 0 failed**（三档的选中态/隐显/解禁/失败回滚）、npm 自测 **94 passed / 0 failed**。

#### 同日：SSE + HTTP 同时连接的风险自查 —— 实测抓出并修掉一个**高危** ✅

用户问"SSE 和 HTTP 同时连接时该怎么办"。**先实测，不靠推断**：写了个一次性探针（4 个 HTTP 客户端
各自按规范挂上 `GET /mcp` 推送流，然后看第 5 个客户端会怎样），输出是：

```
PROBE: 总数=4 / tx.is_some()=4（淘汰候选 = tx.is_none() 的数量 = 0）
PROBE: 第 5 个客户端 → HTTP/1.1 429 Too Many Requests
```

**根因**：表满时的淘汰判据写的是 `filter(|(_, s)| s.tx.is_none())` —— 想表达"这是 HTTP 会话"，
但 `tx` 表达的其实是"**有没有推送通道**"。而 HTTP 会话按规范挂上 `GET /mcp` 流之后也有 `tx`，
于是这一类客户端**全部变成不可淘汰**，淘汰候选 = 0 → 第 5 个客户端吃 429 ——
正是本文件与代码注释里都写着"绝不能回 429"的那条路（客户端无从下手，只能干等 30 分钟空闲回收）。

**危险之处在于触发条件就是推荐用法**：客户端越规范（挂 GET 流），越容易撞上；而且现象是"新客户端
连不上"，排查时很容易怀疑到 token/端口上。这也说明"用某个字段顺带表达身份"的写法有多脆 ——
`tx` 的有无被赋予了第二重含义（会话类型），而它随时会因功能变化（这里就是新增 `GET /mcp`）而失效。

**修法**（P0，用户确认后落地）：
1. `Session` 加**显式** `kind: SessionKind`（`Sse` / `Http`），淘汰只看 `kind == Http`；
2. `DELETE /mcp` 只许删 HTTP 会话，目标是 SSE 会话时回 **404**（403 等于告诉对方"这个 sid 存在，
   只是不归你"——那是个免费探测信号）；
3. 两条回归测试：`http_sessions_with_a_get_stream_are_still_evictable`（4 个挂了流的 HTTP 会话 +
   第 5 个客户端 → 必须 200 且淘汰掉一个）、`delete_mcp_refuses_to_remove_an_sse_session`。

**同次评估里发现但本轮未修**（用户选了"只修 P0"，这些留着）：

| 编号 | 风险 | 现状 | 若修的思路 |
|---|---|---|---|
| R2 | SSE 会话只要流挂着就占坑且不可淘汰，"挂着不用"是常态 → 4 个老客户端就能占满 | 未修 | `MAX_SESSIONS` 4 → 8 |
| R3 | 淘汰按 `last_seen` 挑，而 `ble_connect` 最长 130s 期间它不更新 → 正在跑长任务的客户端最容易被踢（当次响应不受影响，但下一次请求会 404 → 重新握手） | 未修 | 加"最小空闲门槛"（如 < 30s 不淘汰，宁可 429 + `Retry-After`） |
| R4 | All 档下弹窗给两份配置，同一个客户端都粘上会看到 55×2 个相同工具 → 模型选错、副作用可能翻倍 | 未修 | 弹窗加一句"同一个客户端只配一条" |
| R5 | `mcp_status.sessions` 是总数，界面看不出"谁占着坑" | 未修 | status 加 `sseSessions` / `httpSessions` |
| R6 | 挂机 30 分钟的 SSE 会话会被后来者顺手 `retain` 掉（客户端一般自动重连） | 未修 | 可接受，仅记录 |
| R7 | 限流是每会话 60/分，但界面桥的在途上限 32 是**全局**的 → 两个客户端猛刷时会互相挤（`-32005`） | 未修 | 若真成问题，再考虑按会话配额 |

验证：`cargo test` **210 passed / 0 failed / 4 ignored**、断言集 **1592 passed / 0 failed**
（新增两条守着"判据必须是 kind""两个回归测试必须在"）。

### 2026-09-15 · 「只读模式开了之后无法关闭」—— 那颗按钮被永久置灰 ✅

用户截图报障：打开只读模式后，弹窗里那颗开关**再也点不动**（当时按钮一直显示"只读模式：开（AI 只能看）"
—— 这个"把状态写进按钮文字"的写法后来按用户要求改掉了，现在文案固定为「只读模式」、状态只进悬停说明，
见本日更靠上的"传输改成三档"那条的 ④），
而它是**关掉只读的唯一入口**（只读下 AI 连 `mcp_config_set` 都会被拒，这是 2026-09-14 那条故意的不对称）。

根因在界面这一段，一行之差：

```js
// mcpToggleReadOnly()（改前）
var btn = document.getElementById('mcpReadOnlyBtn');
if (btn) { btn.disabled = true; btn.textContent = '只读模式：处理中…'; }   // 置灰挡连点
```

`renderMcpStatus()` 随后只重写 `textContent` / `title`，**从来没有 `ro.disabled = false`** ——
状态回来以后文案是对的、按钮却仍是禁用态。`.ble-modal-btn:disabled` 只有 `opacity:.45`，
肉眼看不出多少差别，用户只会觉得"点了没反应"。此后只能重启应用（或手改 `ai-config.json`）恢复。

修法与 `mcpToggleEnabled` 的 `_mcpBusy` 同一套口径：新增独立的 `_mcpReadOnlyBusy`，**禁用态只认它**，
由 `renderMcpStatus` 统一给出（在途 = 置灰 + "处理中…"，回来 = 解禁）；`mcpToggleReadOnly` 开头
`if (_mcpReadOnlyBusy) return;`，`then` 与 `catch` **两条路**都把标志放下（失败同样要解禁 ——
一次后端抖动不能把这颗按钮永久锁死）。

为什么断言集没守住：当时只有两条**源码扫描**（"按钮存在"、"文案跟着状态"），恰好没测"还点不点得动"；
加上 2026-09-14 那条"故意没在真机上打开它"，这条路径从来没被真正走过。这次补的是**行为断言**
（真函数 + 假 DOM + 假 `invoke` 丢进 vm 连点两次）：开完必须解禁、再点真的关掉、在途期间推来的状态
不会提前解禁、命令失败也解禁，另有 3 条源码扫描。

验证：`node .walkthrough/gen_ble_preview.js` → **1457 passed / 0 failed**（+17 条）。

### 2026-09-15 · 工具自检 + 三个"只有真跑才看得见"的 bug ✅

用户连着报了三条现象：**"新建的工具客户端没看到"**、**"AI 在操控 BLE，但前端没切到 BLE 页"**、
**"扫描结果没有返回给 MCP 客户端"**。三条都不是"工具没写"，而是**跑起来才暴露**的问题 ——
所以这一轮的重点不是加工具，而是**把"跑起来"这件事变成可复现的检查**。

**① 新增 `node .walkthrough/mcp_smoke.js`（工具自检，用户要求"每个工具都要测调用结果"）**

连上**正在运行的应用**，`tools/list` 后把 49 个内置工具**逐个真调**并打印结果，然后单独跑一遍
"开扫 → 等 → 读列表 → 停"的扫描链路。安全模式（默认）的分级：
只读工具真调；写工具用**"必填缺失 → 应报 -32602"**探针；危险工具用**"不带 confirm → 应报 -32006"**探针；
其余有副作用的（`serial_open` / `ble_connect` / `log_clear`…）**跳过并标注**（绝不关用户的串口、断用户的设备）。
它开头就会对"源码里的工具清单 vs 应用里的清单"报差异 —— 这直接回答了第一个问题：
**当时运行的是装好的 v0.5.3（33 个工具、0 个 `ble_*`）**，AI 只能退回去用通用 `ui_*` 桥（调用记录里
确实全是 `ui_click ble.ui.bleScanBtn` / `ui_set bleScanSecs`），而 `ble_list_devices` 这类工具
**在那个 exe 里根本不存在**（`ok:false`）。

> ⚠️ 自检脚本第一版自己有两个 bug，都当场暴露并被修掉：`DANGER_TOOLS` 的元素类型是
> `&[(&str, &str)]`（不是 `&[&str]`），导致读写分类整个失效 —— 于是"安全模式"真的去调了
> `serial_open` / `ui_set`。教训：**探针脚本自己的分类也要能被验证**，所以现在解析失败会直接退出。

**② 回执那一跳没等 Promise → 客户端只看到"前端执行失败"**

`mcp-ui-cmd` 的 listener 里直接读 `res.ok`，但 `mcpHandleUiCmd` 有不少分支**返回 Promise**
（连设备 / 读写特征 / 从机启停 / 读 RSSI…）→ Promise 上没有 `ok` → 回执成了 `ok:false` + `error:null`
→ `unwrap_ui_result` 的兜底文案就是那句没头没尾的 **"前端执行失败"**。真机实测 `ble_periph_status`
正是如此（真实原因是"从机模式没开"，AI 却什么都拿不到）。
修法：抽成 `mcpUiCmdReply(cmd, ackFn)`，用 `Promise.resolve(res).then(send, fail)`；
断言集补 7 条（同步返回 / Promise / 同步抛 / Promise 被拒 / `notFound`+`invalidParams` 回传 /
listener 与生产同一条路）。修完后同一个工具在真机上返回了真字段（`advertising=false` 等）。

**③ 扫描结果读的是面板缓存**

`ble_list_devices` 原先只读 `_bleDevices`，而它由面板**每 2 秒的轮询**刷新 —— "AI 刚开完扫描就来问"
完全可能落在两次轮询之间，读到空列表再得出"没搜到设备"的错误结论。
修法：`refreshBleDevices()` 返回它的 promise（面板自己 fire-and-forget 不受影响），
新增 `bleRefreshDevicesNow()`，`ble_list_devices` **先现问一次后端再读**；空列表时的 `note` 也写清了
下一步（含"设备不广播就只能 `ble_connect` + addr 直连"）。
真机自检：`ble_start_scan` 之后 `ble_list_devices` 拿到 **37 台设备**（含 MAC/RSSI）。

**④ AI 动哪个面板，就把那个面板显示出来**

`ui_set` / `ui_click` 原先能在**隐藏的**面板上操作控件 —— 用户看到的是"AI 在操控蓝牙页，
界面上却还停在串口页"。现在写操作前先 `mcpRevealPaneFor(ent.panel)`：走用户自己的入口按钮切页
（BLE / WSL / ADB 各一颗；回串口页 = 点"当前打开那个面板"的按钮），**已经在目标页时一个点都不发**
（那几颗按钮都是开关，盲点会把用户踢回串口页）。`ble_*` 语义工具同理：动手类 action 先切页，
纯读状态（`state`/`listDevices`/`getOutput`…）**不切**（客户端一 poll 就把用户从别的页面拽走更烦人）。

**⑤ 顺手清掉 6 条 dead_code 警告**（用户要求）
`calllog::in_dir` / `loghub::handle` / `protocol::handle_raw` / `registry::replace` → `#[cfg(test)]`
（都确实是单测专用，生产各有对应入口）；`MAX_TOOL_NAME_LEN` → 用它推导 `NAME_BUDGET`
（"名字不会超上限"由常量保证，而不是两处各写一个数字）；`report::guard` → **真的用起来**：
`exposed_tools` 生成控件工具定义时兜住 panic（那段是"外部数据进到我们自己的生成逻辑"，
跑在应答 `tools/list` 的任务上，panic 一次就会把连接打死）—— 出问题就只给内置工具 + 上报。

**验证**：`cargo test` **171** 通过（+1 扫描结果文本断言；并给调用情况表的**每个**工具加了
"文本摘要里必须出现至少一个真实取值"的断言）；前端 **1424** 通过（+30 条：切页 8、惰性展开 3、
写入/连接/断开 15、回执 7、listDevices 3）；npm 62 通过；
`node .walkthrough/mcp_smoke.js` 对真机实例：**49/49 工具都有结果，0 硬失败**，扫描拿到 37 台设备。

**⑥ 扫描结果：结构里有、文本里只有数量、通用桥完全读不到**（用户连问三次："MCP 没有返回扫描结果列表"
→ "只有设备数量吗？没有设备名称列表？包含 MAC 地址的" → "有结构，但是有没有传输给 MCP 客户端？"）

三层都要修，缺一层用户就还是看不到：

1. **通用桥没有入口**：设备卡片是动态 div，不在控件注册表里（注册表只收
   `button/input/select/textarea/[onclick]`），所以只有 `ui_*` 的客户端**没有任何**读扫描结果的路。
   → `ui_get_state` 新增 `section:"bleDevices"`（全量），`ble` 段里另带一份前 10 台的 `scanResult`；
   两者与语义工具 `ble_list_devices` 读的是**同一份** `_bleDevices`（`mcpBleScanResult(limit)` 一个纯函数出）。
2. **文本摘要只有数量**：通用渲染对数组只展开 3 个元素，45 台设备在文本里成了
   `[3 台] …共 45 项` —— 看起来就像"只回了数量"。→ 两处改：通用数组展开改成**按字数预算**
   （预算内尽量多列，最多 12 个）；设备表按**载荷形状**识别（`devices[]` 里有 `mac`）改用紧凑格式，
   `共 51 台（扫描中）：5F:90:… -80dBm | …`，同样 600 字预算里放得下十几台。
3. **到底传没传出去**：用**原始报文**验证（不解析，直接数 SSE 上的字节）：
   `ble_list_devices` 的 SSE 帧 5087 字节、`"mac":` 出现 **51 次** = 51 台全在报文里；
   `structuredContent` 4381 字、文本摘要 575 字。`ui_get_state{bleDevices}` 同理（4959 字节 / 51 次）。

**⑦ 没有分页、文本还装不下全量**（用户："MCP 返回的文本在约 400 字符处被截断，所以我只能看到前 17 台；
`ble_list_devices` 的 limit 只能设上限，没有分页/offset，没法一页页翻完剩下的 88 台"）

- `ble_list_devices`（与通用桥的 `bleDevices`）新增 **`offset`**：返回 `{offset, limit, returned,
  hasMore, nextOffset, devices}`，`nextOffset` 直接当下一页的 offset；页大小上限
  `MAX_BLE_DEVICE_PAGE = 200`（超了 -32602），省略 limit 仍是一次全给。
- 文本摘要改成**说清页码与下一页**：`共 105 台（第 21-40 台）：…（下一页 offset=40）`；
  一页里列不完的写"本页还有 N 台没列出"，翻到底就不提下一页。
- 语义工具与通用桥两条路都支持分页（`ui_get_state{section:"bleDevices", limit, offset}`）。

**验证**：`cargo test` **178** 通过（+1：页码/下一页文案、最后一页不提翻页；
另加一条"通用桥的 limit/offset 必须真的转发到前端"的调用情况用例 —— 真机上第一次就踩到了：
Rust 只转 `section`，前端收不到 offset，`offset=15` 却回了全量 47 台，与 batch 4 的 `char` 同一类漏法）；
前端 **1437** 通过（+6：offset 真的换页、最后一页 hasMore=false、offset 越界如实说清、
note 给下一页 offset、通用桥分页、offset 的 schema+payload+上限）。

真机实测（`ble_list_devices` limit=15 一页页翻）：47 台 → 4 页翻完、47 个不同 MAC、末页 `nextOffset=null`；
`limit=9999` → `-32602 最多 200 台一页`；通用桥 `ui_get_state{section:"bleDevices",limit:15,offset:15}`
→ `returned=15 hasMore=true nextOffset=30`。
⚠️ 顺带发现一个**口径事实**（已写进文档）：扫描进行中列表仍在增长，按 offset 翻页可能重复/漏掉个别设备
（实测 45 台翻 3 页去重后 43 个 MAC）——要稳定完整的名单得等 `scanning=false` 再翻。

⚠️ 仍未验证：`ble_write` / `ble_subscribe` / `ble_read` 的**真机**结果（自检里需要先连设备；
真机上请用 `--full` 或让 AI 连一台再跑）。

### 2026-09-14 · BLE 语义工具第五批（写入 / 连接 / 断开）✅ —— 顺手逮到上一批的真 bug

按 §16.6.1 收尾主机方向：`ble_write`、`ble_connect`、`ble_disconnect`（46 → 49 个工具）。

**改动**

- **`ble_write`**：没有绕开界面直接调后端，而是**点开面板那个写入窗、填进去、点「发送」** ——
  HEX/文本解析、行尾、写响应/无响应全部复用弹窗自己那套（`bleReadWriteModalInput` + `sendBleWriteCore`）。
  顺带把 `sendBleWrite()` 拆成 `sendBleWriteCore()`：**返回真实成败**（`{ok,hex,bytes,writeType}`
  或 `{ok:false,error}`），按钮入口忽略返回值，MCP 靠它给 AI 真实结论 —— 写失败绝不谎报成功。
  默认 `lineEnding=none`（AI 写的多是协议帧，擅自补 CRLF 会写坏数据）；`writeType` 给了但特征不支持时
  **报错并把可选值列出来**，不静默换一种写。
- **`ble_connect`**：给 MAC 时先在扫描列表里找 —— **找到就点它的卡片再走「连接设备」**，
  **找不到就走「按 MAC 直连」**（`ble_connect_direct`，不依赖广播；这正是"设备被配对过/被别的主机连走
  就不再广播"的唯一出路，见 AGENTS 的 BLE 主机三条约定）；不给 MAC 就用面板选中的那台。
  **等 `bleOnConnected` 把服务树拉完才返回**（和 `serial_open` 一样不做乐观返回）。
  为此把 `toggleBleConnect` 里那段内联编排抽成 `bleConnectTo(address,label)`（门闩 + 显式超时 +
  "只有确实需要配对才配对再重连"），按钮与 MCP 共用；`connectBleDirect` 也改成可传地址并回报结果。
- **`ble_disconnect`**：抽成 `bleDisconnect()`，与那颗「断开设备」按钮完全同一条路
  （服务树/订阅/本次会话日志一起清）；本来就没连时幂等返回，不打后端。

**逮到的真 bug（上一批的）**：`ble_call(core, action, args, extra)` **只把 `pane` 转进 payload**，
所以第四批的 `ble_read`/`ble_subscribe` 虽然 `require_str(args,"char")` 校验通过，
**`char` 根本没到前端** —— 真机上这两个工具会一直回"要给 char"。两端各自的测试都是绿的：
Rust 侧的假前端不看参数内容（只钉 op 序列），前端侧当时只有源码断言。
修法与加固：① 需要的字段一律显式放进 `extra`；② Rust 的假前端把期望参数钉进调用序列
（`{"action":"read","char":"0x2a00"}`，`json_subset` 会比对），`ble_write`/`ble_connect` 同理；
③ `.walkthrough` 补了 **27 条真 handler 行为断言** —— 用真实 `renderCharRow` 产出特征行、
把 onclick 原样搬进假 DOM，再跑 `mcpBleOp`：读/订阅/写/连接/断开各条路都验到"点了哪颗按钮、
发出什么字节、失败是不是真的回失败"。

另一个小坑：`ble_subscribe` 判断"已经订阅了吗"用的是 `_bleSubs[<uuid>::<prop>]`，
而 `_bleSubs` 的键取自**服务树里的 UUID 写法**。原先用调用方传来的 UUID（可能大小写不同）去查，
会查不到 —— 那会把"已订阅"误判成"未订阅"，**退订请求于是静默不生效**。现在统一用按钮 onclick 里的
真实 UUID（`bleBtnUuid`），顺带回执里的 `uuid` 也是服务树那个写法（可直接回喂给下一个工具）。

还有个必须处理的界面事实：**特征行只在该服务展开时才在 DOM 里**（面板一次只展开一个服务，收起即移除）。
所以"按 UUID 找那颗图标"找不到时不能直接判"不支持"，而是先让拥有这个特征的服务展开
（`bleFindCharBtn`：查 `_bleServices` 找所属服务 → 点它的抬头行 → 再找一次）——
否则 AI 得先让用户手点展开才能读写，否则得到一堆假的"特征不支持"。

上限：新增 `MAX_BLE_WRITE_CHARS = 4096`（进 `mcp_limits.maxBleWriteChars`）——
BLE 单次写受 MTU 限制，无界字符串等于让 AI 灌爆 WebView（AGENTS #10）。

**验证**：`cargo test` 170 通过（+4 契约行 +6 调用情况用例 +1 上限断言）；前端 **1401** 通过
（46 → 49 工具、+3 op 分支、+3 跨端对、+32 行为断言，含"服务未展开也能操作"这条）；
npm 安装器 62 通过；`doc/MCP_TOOLS.md` 重生成（49 个工具）；`doc/MCP.md` 的 BLE 表补到 14 行。

⚠️ 真机验证仍待办（沙箱里没有蓝牙）：写入/读通知/连接都要在真设备上跑一遍
（见 `doc/BLE_VERIFICATION.md` 的清单）。

**下一批**：`ble_pair`（危险：会写进 Windows 的配对表 → 进 `DANGER_TOOLS`，且要用户在那颗配对弹窗上确认）、
`ble_periph_respond_write`（从机手动应答，从机模式当前默认关闭）→ 之后转 ADB/WSL（§16.6.2）与全局/应用（§16.6.3）。

### 2026-09-14 · BLE 语义工具第四批（特征读 / 订阅通知）✅ —— 不改面板结构也能做

上一批我说"读写要按 UUID 寻址、得先抽函数"。看了实现发现**不用抽**：特征行上的读/订阅按钮
是 `<span class="ble-ch-action" onclick="bleCharAction(this,'<uuid>::<prop>')">`，
所以 MCP 侧只要**按 UUID 找到那颗按钮并 `.click()`** —— 这正是"与用户点击同一条路"（AGENTS #3），
日志、图标状态、`_bleSubs` 全都会跟着变，一行面板代码都不用动。

- `ble_read`（读）：找到该特征的 read 按钮点一下；没有 read 属性时直接说清（不静默）
- `ble_subscribe`（写）：找 notify/indicate 按钮；**状态已经是目标值时不会重复点**
  （`changed:false`）—— 否则会把用户刚打开的订阅又关掉
- 两个工具都**在 Rust 侧先校验必填 `char`**（AGENTS #10：校验要先于"碰主程序"，
  缺参要报 `-32602`「改参数重试」而不是拖到最后变成 `-32006`「没有界面」）——
  这条是契约测试逼出来的：它专门断言"声明了 required 却没报 -32602"是违约

**验证**：`cargo test` 170 通过（+2 契约 +2 调用情况）；前端 1359 通过（+2 op/跨端断言）；
`doc/MCP_TOOLS.md` 重生成（46 个工具）；`doc/MCP.md` 的 BLE 表补到 11 行。

⚠️ **更正（第五批发现）**：本批的 `ble_read`/`ble_subscribe` 有个真 bug —— `ble_call` 只把 `pane`
转进 payload，`char` 根本没到前端（Rust/前端两侧测试当时都是绿的）。详见上面第五批的记录。

⚠️ **顺带发现一个既有问题（本批没改）**：`every_tool_has_a_tested_return_contract` **单跑必失败**
（`log_tail` 要的 `app` 通道还没被建出来），整套跑时别的用例会先建出这个通道才过 ——
即测试之间有隐式依赖。不影响 CI（CI 跑整套），但"单跑一个用例"会误报。
修法：那条 log_tail 用例自己在前面推一条 `app` 通道的日志，或让 LogHub 在启动时就建好默认通道。

> **已修（2026-09，读日志的文本编码那一批）**：改成用例开头调 `loghub::hub().ensure_channel("app")`
> —— 预建通道不写内容、也不要求 hub 处于启用态，单跑不再误报。

**下一批**：连接/断开（把内联 connect 流程抽成 `connectBleDevice(addr)`，与 `ble_connect_direct` 并成一条路）、
特征写入（`ble_write`：面板那颗写按钮会弹一个小窗填数据，要复用那个弹窗的提交路径）、
配对（**危险**：系统弹窗 → 进 `DANGER_TOOLS`）。

### 2026-09-14 · BLE 语义工具第三批（读通知日志 / 刷新 RSSI）✅

继续按 §16.6.1 走，挑"不用先改面板结构"的两个：

- `ble_get_output`（读）：面板**本次会话**的数据日志（收到的通知/读回的内容、发出的写）。
  与串口那条路**故意不同**并写明了原因：串口读的是 LogHub 通道（跨会话），而 BLE 这块面板
  本来就在切设备/断开时清空缓冲；要跨会话历史就把返回里的 `channels.rx`（`ble:rx`）交给 `log_tail`
  —— 两条路都给出来，而不是让 AI 以为"只有这么多"
- `ble_refresh_rssi`（读）：只问一次射频、不改状态；没连设备时直接说"先连上"（而不是返回 null 让它猜）

**验证**：`cargo test` 170 通过（+2 契约 +2 调用情况）；前端 1357 通过（+2 op/跨端断言）；
`doc/MCP_TOOLS.md` 重生成（44 个工具）；`doc/MCP.md` 的 BLE 表补齐（共 9 行）。

**下一批**（都要先动面板结构）：连接/断开（把内联 connect 流程抽成 `connectBleDevice(addr)`，
与 `ble_connect_direct` 并成一条路）、特征读写（按 UUID 寻址）、订阅通知、
配对（**危险**：系统弹窗 → 进 `DANGER_TOOLS`）。

### 2026-09-14 · BLE 语义工具第二批（扫描 / 设备列表 / 服务树）✅

接着上一批做 §16.6.1 里"不用改面板结构就能做"的那几个（连接/读写/订阅要按特征 UUID 寻址，
面板那几条路目前写在内联 onclick 里，得先把它们抽成函数 —— 留到下一批）：

- `ble_list_devices`（读）：已扫到的设备（MAC/名称/RSSI/是否配对/是否选中）；
  空列表时 `note` 直接说该先调什么（"还没扫到设备：先 ble_start_scan"）——
  让 AI 少一轮往返，这是 §16.4"第一次就做对"那条原则
- `ble_start_scan` / `ble_stop_scan`（写）：**复用面板那颗「开始/停止扫描」按钮的函数**
  `toggleBleScan()`（它内部按 `_bleScanning` 分流，所以"想开就开、想关就关"都走同一条路）
- `ble_get_services`（读）：**取面板已经拉到的那份服务树**（不重新去问设备 ——
  那会有副作用：某些设备被反复读服务会断连），服务 → 特征（UUID/props/描述符数）
- 扫描两个进了 `WRITE_TOOLS`（占用射频、会让附近设备应答；只读模式下不该开）；
  取服务树**不进**危险表（读操作），但面板已有的 `ble_periph_respond_write` 将来要进

**验证**：`cargo test` 170 通过（+4 工具契约 +4 调用情况）；前端 1355 通过（+4 条 op/跨端断言）；
`doc/MCP_TOOLS.md` 重生成（42 个工具）；`doc/MCP.md` 的 BLE 表补齐 4 行。

**下一批**：连接/断开（要把内联的 connect 流程抽成 `connectBleDevice(addr)`）、
特征读写（`ble_read`/`ble_write`，按 UUID 寻址）、订阅通知 + `ble_get_output`（复用 LogHub 的 `ble:rx`）、
刷新 RSSI、配对（**危险**：系统弹窗，进 `DANGER_TOOLS`）。

### 2026-09-14 · §16.6 开工：**危险动作二次确认**落地 + BLE 语义工具第一批（4 个）✅

按 §16.6.5 的顺序做的第一步（**机制先于工具**：危险确认与 BLE 第一批同一次落地，
否则要么漏确认、要么回头补）。

**危险动作二次确认（§16.6.4）**

- `DANGER_TOOLS`（protocol.rs）：名字 → 一句后果。判定口径只有一条：**会对外产生不可撤销影响**
  （串口收发不算 —— 它是本职，加确认只会让人关掉确认）
- 门放在 `call_tool` 里、**只读门之后**：没带 `confirm:true` → `-32006`（前置条件类，
  Agent 该做的是"确认后再来"而不是改参数重试），且**不执行**（连工具调用计数都不加 ——
  "没执行"要有证据）；只读模式下连确认也不给过（先返回 `-32007`）
- 新增只读工具 `mcp_danger`：AI 可以先问"有哪些危险动作、各自什么后果"再决定
- 四条断言一起守：表里每项都必须是真工具且 schema 有 `confirm`、有后果说明；不带 confirm 必被拦
  且计数为 0；带了 confirm 必须放行（错误里不能再出现"危险动作"）；普通工具不得要求 confirm

**BLE 语义工具第一批（§16.6.1 里最靠前的一批）**

- 前端新增 `mcpBleOp`（与 `mcpSerialOp` 同构），`ui_call` 的 `ble` 面板接上它；
  `state` / `periphStatus` 只读；`periphStart` / `periphStop` **复用面板的
  `startBlePeriph()` / `stopBlePeriph()`**（顺手让这两个函数 return 自己的 promise，MCP 才能等它完成再读状态）
- Rust：`ble_get_state`、`ble_periph_status`、`ble_periph_start`、`ble_periph_stop` + `mcp_danger`，
  共 5 个新工具（总数 33 → **38**）；`ble_call` 与 `serial_call` 同构；启停进 `WRITE_TOOLS`
- 假前端加了 `ble` 分支并把 5 个工具都接进"调用情况"表（那张表与契约表必须覆盖同一批界面工具，
  漏一个就 fail —— 这次就是它逼着我把 BLE 四个补进 want 列表的）

**验证**：`cargo test` 170 通过（+1 危险门测试、+4 工具契约、+4 调用情况）；
`node .walkthrough/gen_ble_preview.js` 1351 通过（+13 条 BLE/危险门断言）；
`doc/MCP_TOOLS.md` 重生成（38 个工具，新增"蓝牙语义工具"与"安全与策略"两组）。

**下一步**：BLE 第二批（扫描/连接/服务树/读写/订阅通知/读通知内容/刷新 RSSI/配对）——
清单与契约见 §16.6.1；危险机制已就位，`ble_pair`/`ble_periph_respond_write` 直接进 `DANGER_TOOLS` 即可。

### 2026-09-14 · 「报得出来的开关就得设得了」—— 补上 `advOpen` 的"看得到改不了" ✅

用户问的是**自动滚动**有没有对应工具。答案：**有** —— `serial_set_display { autoScroll: true|false }`，
读它用 `serial_get_state.autoScroll`（真机实测翻转 + 恢复都成功，`applied: [{from:true,to:false,ok:true}]`）。

查证过程中顺手发现一个**不对称**：`serial_get_state` 会把 `advOpen`（"更多设置"栏是否展开）报出来，
但 `serial_set_display` 的字段名单里没有它 —— 设它会回「至少要给一个：viewMode / …」，
而**那条错误信息本身就是旧名单**（连 `advOpen` 都没提），所以调用方既改不了、也看不出为什么。

处置：

- 把 `advOpen` 补进 `serial_set_display`（字段名单 + schema + 工具描述 + 错误提示）；
- 加一条**通用守卫**（断言集）：拿前端 `MCP_SERIAL_TOGGLES` 的 7 个开关逐个去对
  `serial_set_display` 的字段名单，少一个就 fail。这类"看得到改不了"的漏项，以前只能靠人眼比对，
  而且很容易在新加开关时重犯。

真机验证：`advOpen` true → 设 false（`ok:true`）→ 读回 false → 改回 true ✔。

测试：Rust 161、前端 **1002**（+2）。

### 2026-09-14 · 只读（沙箱）模式：AI 能自由探索，但**一个字都改不到用户的东西** ✅

动机（承接上一问）：Agent 在探索期会反复试错，而 `ui_set` 之后前端会 `scheduleConfigSave()`
**真的落盘** —— 试错会污染用户配置。设计里的 D3（"AI 改动是否持久化 / 可切沙箱模式"）一直没做。

实现分四层：

| 层 | 内容 |
|---|---|
| 配置 | `expose.readOnly`，默认**关**（默认拒绝一切写会让"开箱即用"变成"怎么都改不动"）；`#[serde(default)]` 让老配置文件直接升级 |
| 判定 | `WRITE_TOOLS`（13 个）为**唯一来源** + `is_write_call(name, args)`：`ctl_*` 一律算写；**`serial_quick_cmd` 按调用判**（不带 `index` 是"列举"，带 `index` 才是"真的发出去"）|
| 拦截 | `call_tool` **最前面**（连工具计数、日志都不写之前）→ 独立错误码 `E_POLICY_DENIED = -32007`，消息写明"没有执行 / 改参数重试也没用 / 请用户去弹窗关掉" |
| 可见性 | `mcp_status.readOnly` + `mcp_config_get.expose.readOnly` + `initialize.instructions` 第 8 条（Agent 一开始就知道，不必撞墙）|
| 界面 | 弹窗新增开关（新命令 `mcp_set_read_only`）。**故意的不对称**：`mcp_config_set` 自己也是写工具，所以 **AI 只能打开它、关不掉它** —— 要关必须由用户点按钮，否则"让 AI 别改东西"就是摆设 |

测试里最关键的一条**不是**"返回了错误"，而是**假前端一次都没被调用**：14 个写调用（含
`mcp_config_set` 试图自己解锁）全部断言"界面与配置零改动"。另外把 `doc/MCP_TOOLS.md` 的
「读/写」列与 `WRITE_TOOLS` 做了**交叉核对**（那列以前是手写的，没人核过）。

测试：Rust **161**（+2）、前端 **1000**（+11，含交叉核对）、npm 62。

> 真机只验证了 `mcp_status.readOnly` 存在且为 `false`；**故意没有在真机上打开它** ——
> 按设计打开后 AI 关不掉、只能靠用户点按钮或重启，我不想把你的应用留在只读状态。

### 2026-09-14 · 「怎么保证 Agent 的调用快捷性」—— 补上三处"让它第一次就做对 / 别白等" ✅

用户问：**"MCP 服务器有了，怎么保证 Agent 的调用快捷性？比如沙箱中反复调用失败这种"**。
先把**已有**的机制盘出来（这些不是新做的，是本来就该起作用的）：

- 错误信息**直接给出下一步**：`可选值只有: COM1`、`没有这个分栏: extra-99；可用分栏: main`、
  `先用 log_channels 看有哪些` —— Agent 不用试；
- **错误码分流**：`-32602`=改参数重试 vs `isError`+`-32006`=先做前置操作，Agent 可以分支处理；
- `mcp_limits` 把**所有上限**公开（200 条 / 64K / 60 次每分…），不用撞墙才知道；
- 工具只有 **33 个**（`autoControlTools` 默认关：几百个工具会显著拖低选工具准确率）；
- 单目标写失败 = 整次调用失败（不会"假装成功"让 Agent 误判）；`serial_open/close` **幂等**
  （已在监控中就说"无需重复打开"，不会点了又断）；`log_tail` 可 `sinceSeq` 增量拉。

然后补掉三处真缺口：

| 缺口 | 后果 | 处置 |
|---|---|---|
| `initialize` **没有 `instructions`** | Agent 拿不到"该怎么用我"，只能靠撞墙学；每次撞墙 = 一轮往返 + 一次失败 | 新增 `SERVER_INSTRUCTIONS`（600 字符 / 7 条：先看状态 → 串口主流程 → 照错误做 → 错误码语义 → 写语义 → 上限 → 日志增量），握手时**一次性**下发 |
| **限流回包的 `id` 是 `null`** | 客户端发的 id 是 X，回来一条 `id:null` 的 error → **配不上号 → 那次调用一路挂到超时** → Agent 以为失败又重试 → 越限流越糟。这就是"反复调用失败"的真实成因。而原注释还写着"让客户端能把它对应到某个请求"，**与实现相反** | 从请求体解析真实 `id` 回填；消息改成"本次调用被拒（**没有执行**）+ 怎么放慢（sinceSeq 增量、减少轮询）" |
| 没有设备时 `serial_open` 照样点按钮 | 白等 **6 秒**轮询超时、拿到含糊原因，而且很可能再试一次（沙箱/裸机场景必踩） | `no_serial_port_hint()`：`serial_list_ports` 为空 → **立刻** `-32006` 并说明"插上设备后再试"；有串口则不拦（原来那条 6 秒轮询仍然保留给"设备在但打不开"的真故障） |

**一个反面教材（我自己的测试）**：限流那条测试第一版 POST 没带 `Connection: close`，于是每次
`read_to_end` 都等到 2 秒超时 → 61 次耗时 **127 秒** → **直接把 60 秒的限流窗口拖过去**，
于是永远触发不了限流、测试失败。教训：**测试自己慢，也会让被测逻辑失效**。

测试：Rust **159**（+3）、前端 **989**（+3）、npm 62。真机验证：官方 SDK 客户端
`initialize` 收到 600 字符指引（内容与源码一致）。

### 2026-09-13 · 「客户端连上了，界面一直显示 0 会话」——会话增减从不推状态 ✅

用户报的现象。查下来**服务器侧一直是对的**（`mcp_status.sessions = 1`，真机实测），错在**没人
告诉界面**：`mcp-status-changed` 只在「启动 / 启停 / 重置令牌」三处推，**会话增减一处也没推**。
而弹窗只在**打开那一瞬间**拉一次状态 —— 先开着弹窗再连客户端，那个数字就永远停在 0。

根因是**能力摆错了层**：会话是在 `transport.rs` 里增删的（连上一条 SSE / 断开回收），那里只有
`Arc<McpCore>`、拿不到 `AppHandle`，而推送函数签名是 `emit_status(app, core)` ——
于是"能推的地方不知道会话变了，知道会话变了的地方推不了"。

修法：
1. 把推送实现挪到 `McpCore::emit_status()`（它自己持有 `Option<AppHandle>`），`transport` 的
   **会话建立**与 **`SseBody::Drop` 回收**两处各推一次；`mod.rs` 的三个调用点改为 `core.emit_status()`。
2. **把推送次数暴露成 `mcp_status.statusEmits`** —— 这个 bug 之所以活了这么久，是因为它
   **完全不可观测**（服务器侧全对、界面侧只是"不刷新"）。有了它就能从线上直接判断
   "会话增减到底推没推"。
3. 前端断言补两条：事件必须用 `ev.payload` 更新缓存再重画（不能拿旧 `_mcpStatus` 重画 = 等于没更新）；
   打开弹窗时主动拉一次（推送漏了也能纠正）。

测试：Rust 新增 `session_add_and_remove_push_status_to_the_ui`（连上推一次、断开再推一次）→ **156**；
前端 **986**。真机实测：`statusEmits` 随每次连接/断开各 +1（`2 → 4 → 6`），改前启动后**永远不变**。

### 2026-09-13 · 「端口查询没返回端口名」+「每个工具的返回值都要测」—— 补上**工具契约与调用测试** ✅

用户两句话，指出了同一件事的两个面：

**① 「端口查询工具没有返回端口名？」** —— 查下来是三个叠在一起的问题：

| 问题 | 真相 | 处置 |
|---|---|---|
| 文本里没有端口名 | `summarize_for_text` 遇到数组只写 **`ports=1 项`**，数据全被吞掉。而**很多客户端只把 `content[].text` 给模型看**，人也是先看这行 → 看起来就像"这个工具不返回端口名" | 重写摘要：数组真的展开内容（有界：3 元素 × 8 字段 + 总长 600 字符上限，超了截断并指向 `structuredContent`）|
| 字段名是 `port_name` | 它来自 `PortInfo`（**前端也在用**，`index.html` 里 6 处 `p.port_name`），serde 默认蛇形 → 与其余工具的驼峰不一致，模型按惯例取 `portName` 就是 `undefined` | 在 **MCP 边界**转成 `portName/friendlyName/productName`（工具的对外契约由工具自己负责，不动前端那份 IPC 契约）|
| 四个参数也是蛇形 | `since_seq` / `case_sensitive` / `max_lines_per_channel` / `ok_only` | 改成驼峰为准，**旧拼写继续认**（`opt_alias`）——直接改名会让按旧写法调用的人**静默失效**（多传的键被忽略，AI 拿到"看起来正常、语义却不对"的结果），那比报错危险得多 |

**② 「每一个工具的返回值都应该需要测试啊，不然预期的结果怎么确定是否已经完成？」** —— 说得对，
这是方法论漏洞：之前 33 个工具里，只有 11 个纯后端工具的返回形状被零散测过；**19 个界面工具
只被调到"没有界面上下文（-32006）"就结束，真正调用路径一次都没跑**，2 个写工具甚至没被调用。
补上三条（三条一起才叫测过）：

| 测试 | 覆盖 |
|---|---|
| `every_tool_has_a_tested_return_contract` | **33 个工具逐个在表里交代**：纯后端断言顶层字段（多一个少一个都要改契约）、界面工具断言 `isError`+`-32006`、有副作用的注明谁在管它。**表里漏一个工具就 fail** → 新增工具时必须一起想清契约 |
| `every_ui_tool_sends_the_expected_op_and_returns_expected_shape` | 19 个界面工具用单测专用假前端（`McpCore::test_ui`）**真的调一遍**：钉住**发给前端的 op/参数序列**与**拿到回执后的返回**（含 `serial_open/close` 的幂等分支、"点完轮询确认"那段）|
| 断言集里的跨边界检查 | 扫 `protocol.rs` 发出的每个 `op`/`action`，要求 `index.html` 真有对应分支（19 条）——"后端发了、前端没有"会**静默失败**，而两边各自测自己那一半时全是绿的 |

三条**全局不变量**对所有工具生效，不靠人记：`structuredContent` 必须是对象、键必须 camelCase、
**文本摘要必须真的把数据说出来**（就是 ① 那个坑）。

**这套测试当场就抓到 4 件事**（说明它们不是摆设）：
1. `mcp_status` 在"服务器没跑"时没有 `urlMasked` → 契约表改成"必需字段 + 可选字段"；
2. `serial_open` 的**幂等分支**（已在监控中就不该再点一次）我原本写错了期望 → 补测两条分支；
3. 假前端把点击写成"设为 true"，但真界面上「开始/停止监控」是**同一个按钮 toggle** → `serial_close` 永远等不到断开（3 秒超时）；
4. **一个既有的偶发测试**：`log_search {pattern:"boom"}` 断言"恰好 1 条命中"，而 `report.rs`
   的用例拿 `panic!("boom …")` 造夹具写进 error 通道，它持有的是 `TEST_LOCK` 而不是 `hub_lock`
   → 两者并行时命中 2~3 条，**5 次里偶发 1 次**。修法是夹具串改成全测试集唯一
   （教训：**别拿大众词当搜索夹具**）。

顺带修掉一个**让断言集空转**的坑：`.walkthrough` 里 `mcpProd`（"生产代码"）原按"第一个
`#[cfg(test)]`"截断，而 `protocol.rs`/`mod.rs` 都有**条目级**的 `#[cfg(test)]`（`test_panic` 工具、
`test_ui` 字段）→ 切片过早截断，那些"生产代码"断言其实只看了一小段。现在只按真正的测试模块
（`#[cfg(test)]` 紧跟 `mod tests`）切。

测试：Rust **155**（+4）、前端 **984**（+23）、文档 33 个工具。真机复测：端口名出现在文本里、
字段是驼峰、`sinceSeq` 与 `since_seq` **都被采纳**（用超界值验证"认了"而不是"忽略了"）。

### 2026-09-13 · 补上"读串口监控数据" + 按"**不得影响主程序**"做了一遍资源审计 ✅

用户两问：①「log 串口监控数据的查看没有吗？」②「MCP 服务器的运行不能影响主程序」。

**① 读串口数据：机制有，但只是半成品。** 设计本来就是走日志中心（AI 发指令 → 后端写串口 →
`LogHub channel="serial:main:rx"` → `log_tail` 拿回显），可实测发现两个缺口：

| 缺口 | 现状（真机实测）| 处置 |
|---|---|---|
| 要读内容得先**知道通道名** | `serial:<分栏>:rx` 是拼出来的，而 `serial_get_state` **只给行数/字节数、不给内容** —— AI 只能猜 | 前端把命名规则收成一处 `mcpSerialLogChannels()`（`bufferPush` 写、`state` 读共用），`serial_get_state` 带出 `logChannels` |
| 没数据流过时通道**还不存在** | `log_tail("serial:main:rx")` 直接报 `-32602 没有这个通道` → AI 会得出"**不支持**读串口数据"这种错结论，而事实只是"还没收到数据" | 新增第 33 个工具 **`serial_get_output`**：按分栏语义读（不用知道通道名），收+发**按时间归并**（两通道 seq 各自独立），**没数据 = 空列表 + note，不是错误** |

`serial_get_output` **不新增存储**：读的就是日志中心那一份（AGENTS.md #6），只是把"通道名从哪来"
和"没数据算不算错"这两件事包掉。

**② 资源审计**：把"不得影响主程序"当成验收条件逐条查，而不是口头答应。

| 环节 | 结论 |
|---|---|
| 串口收发热路径 | ✔ 只有一次非阻塞旁路 `LogHub::push`（`try_lock`，拿不到锁丢一条并计数）；全局回收也是 `try_lock` + 单次 ≤4 通道 |
| 错误上报 | ✔ LogHub → 本地日志 → Sentry（SDK 自带缓冲）→ 自建服务走**独立上报线程的 channel** |
| SSE 出站 | ✔ 有界队列 + `try_send`，**生产者绝不 `await`/阻塞**；慢消费者直接断开并计数 |
| 界面命令 | ✔ 在途上限 32 · 5s 超时，超时/繁忙各有明确错误码 |
| 请求体 / 会话 / 限流 | ✔ 1 MiB · 4 · 60 次每分 |
| **`ui_set.items`** | ❌ **曾无条数上限**：请求体虽有 1 MiB，但一条 item 才 40 多字节 → 能塞**两万多条**，而这条链路最终**逐个跑在 WebView 主线程**上 = "AI 一句请求把界面冻住几秒"。→ ✅ `MAX_UI_SET_ITEMS = 200`，**在下发到界面之前**就报 `-32602` 并提示分批 |
| **`serial_send.data`** | ❌ **曾无长度上限**：1 MiB 在 115200 波特下要发**一分半钟**，期间一直压着串口写队列。→ ✅ `MAX_SEND_CHARS = 64K` |
| 工具 panic | ✔ `catch_unwind` 兜住（见约定 #2），绝不 `panic = "abort"` |

两条新上限都进了 `mcp_limits`（客户端能提前查到，而不是撞墙才知道），并在 AGENTS.md 新增**第 10 条约定**
把它钉住 —— 核心是那句话：**"加新工具时先问一句：它的输入有上限吗？"**

测试：Rust **153**（+2）、前端 **964**（+6）、文档 32 → **33 个工具**。
真机复测：`mcp_limits` 已公开两条上限；`ui_set` 201 条 / `serial_send` 64K+1 **都在碰主程序之前被拒**；
`serial_get_output` 没数据时返回空 + note（**不是**报错）。

> ⛔ **仍未验证，且当前受阻：缺串口设备**（2026-09-13 用户确认"现在还没有串口设备"）。
>
> 待验证的是 **真实数据是否真的流进 `serial:<分栏>:rx`**（条数/速率与界面行数是否量级一致）。
> 链路上有两段：后端读线程 → 前端 `bufferPush`（所有输出行的唯一漏斗）→ 回灌 LogHub；
> **没数据时该通道根本不存在**，所以用夹具只能验证"语义"、验证不了这条链。
> 同样受阻的还有：`serial_open` 真连上（否则只会等到 6 秒超时）、`serial_send` 真发出去、
> `serial_get_output` 拿到真实收发行、帧格式/流控在设备侧真的生效、多分栏的 `serial:<extra-1>:rx`。
>
> **设备到位后的顺序**：① 先在界面上点「开始监控」确认能收到数据；② 再让我用 MCP 复跑（先只读
> `serial_get_state`（看 `logChannels`）与 `serial_get_output` / `log_channels` 对账条数）；
> ③ 最后动写操作（`serial_open` → `serial_send` → 看设备回显是否出现在 `serial:main:rx`）。
>
> 记录位置：代码评估文档的「真机验证待办」与「⛔ 阻塞：缺串口设备」两节。

### 2026-09-13 · 真机一致性检查抓到**一个贯穿全链路的断点**：`notFound` 在回执时被丢掉 ✅

用官方 Python MCP SDK 对**真实运行的应用**（debug 构建，32 个工具）逐个实调，发现
`ui_get` / `ui_describe` / `ui_get_state` / `serial_select_port` / `serial_open` 这几类
"控件路径或取值不存在"全部返回 **`-32006`**，而不是文档与单测都写明的 **`-32602`**。

根因不在任何一端，而在**中间那一段没人管**：

| 环节 | 状态 |
|---|---|
| 前端 `mcpHandleUiCmd` 返回 `{ok:false, notFound:true, error}` | ✅ 有断言守着（"后端据此返回协议级 -32602"）|
| 后端 `bridge::unwrap_ui_result`：`notFound` → `-32602`，否则 `-32006` | ✅ 有单测守着 |
| **前端 `mcp_ui_ack` 回执**（`index.html`）| ❌ 只回传了 `ok/value/error/disabledReason`，**`notFound` 被丢**|

于是 `unwrap_ui_result` 里那条 `-32602` 分支在真机上**从未被执行过**：所有"路径/取值不存在"
都落到 `-32006`（= "设备未就绪 / 没有界面上下文"）。对 AI 的实际后果是**误判方向** ——
它会以为"应用没有界面"而反复重试，而正确动作是"重新 `ui_list` 挑一个存在的路径"。

**修复**（三处，缺一不可）：

1. `mcp_ui_ack` 增加 `not_found` 入参，并抽成纯函数 `ui_ack_payload()`；
2. 前端回执补 `notFound: !!(res && res.notFound)`；
3. **单目标失败 = 整次调用失败**：`ui_click` / `ui_set{path}` 只给一个目标时，
   顶层还回 `ok:true`（把失败藏在 `results[0].ok=false` 里）同样是在骗调用方 ——
   现在单目标失败直接 `ok:false`，多目标（`items:[…]`）才保留"逐条回报"的批量语义。
   顺带：`mcpSerialApply` 整批失败时把**已经生效的字段点名**写进错误信息
   （逐项校验意味着前面的项可能已经改掉了，只说"失败"会让 AI 重复下发）。

**测试**（这是本次真正的收获）：新增 `ui_ack_reply_shape_is_complete` 把
**"ack 入参 → 桥解析 → 错误码"整条链**一次测穿，而不是两端各测一半 ——
这正是 `serial_list_ports` 那次（`structuredContent` 形状错、单测却锁着错的形状）同一类
"单测绿、真机废"的漏洞。断言集同时新增 4 条（单/多目标语义、回执字段、部分成功点名），
前端 951 → **955**，Rust 150 → **151**。

> 教训：**跨进程/跨语言的那一跳必须各有一条端到端断言**。两端各自的单测再齐，
> 中间那一段（这里是 Tauri 的 `invoke` 回执）没有断言就永远是盲区。

**同一次检查还暴露了第二个更细的分流问题**：前端修好 `notFound` 之后，真机上仍有
`serial_select_port(COM99)` 返回 `-32006`。原因是串口语义层里"**参数取值非法**"
（端口不在下拉里、字段名不认识、`data` 为空、`index` 越界、`mode` 不是 text/hex）
既没有 `notFound`，也没有任何标记 —— 它对 AI 的后果与上一个 bug 一样：
`-32006` 的含义是"先做前置操作"，而这里 AI 该做的是"**改参数重试**"。

处置：新增 `invalidParams` 标记（**不硬套 `notFound`**，因为"取值非法"和"路径不存在"
是两件事），并在 `bridge::unwrap_ui_result` 里与 `notFound` 一并归到 `-32602`。
同时把不属于参数问题的分支**去掉**标记，让它们回到 `-32006` 的正确定位：
"界面里找不到控件"（界面结构变了，改参数没用）、"还没开监控就发数据"（前置状态）、
"写进去又被控件拒绝"（值不被设备接受）。分流后的对应关系：

| 场景 | 标记 | 结果 | AI 该做什么 |
|---|---|---|---|
| 控件路径不存在 / 取值不在可选集里 / 字段名不认识 / 必填缺失 | `notFound` 或 `invalidParams` | 协议级 **-32602** | 改参数（照错误信息里的可选值重试）|
| 控件被禁用 / 前置状态没满足 / 界面结构不符 / 值被设备拒绝 | 无标记 | `isError` + **-32006** | 先做前置操作、或检查界面/设备 |

**真机复测**（同一实例，官方 SDK）：**59 项全通过、0 失败**，含
`serial_select_port(COM99) → -32602 msg=可选值只有: COM1`。

> 顺带纠正一个我之前的误判：本机调试实例是 **`npm run dev`（tauri dev）** 起的，
> `frontendDist: "../src"` —— 改前端/后端源码会**自动重编译并重启**，
> 所以"改完必须让用户手动重启才验证得了"这个前提不成立；验证前先看
> `mcp-endpoint.json` 里的 `pid` 与 exe 时间戳是否已更新，能省一轮来回。

### 2026-09-13 · S12 第一批：串口语义工具（12 个）✅ —— 补上"通用控件桥没有业务语义"这个根本缺口

用户评估后指出：20 个工具里**只有 4 个是业务语义**，而"选串口 / 设波特率 / 开监控"这些**主流程没有专门工具**，
只能靠 `ui_set`/`ui_click` 拼控件路径；ADB shell、BLE 设备列表与广播解析这类甚至**绕都绕不到**。
重评后的方案是分四批补 ~58 个语义工具，**第一批 = 串口 12 个**。

| 工具 | 作用 |
|---|---|
| `serial_get_state` | 一个分栏的完整状态：端口/波特率/帧格式/行尾/DTR-RTS/各显示开关/**是否在监控中**/输出行数与字节数/历史条数/全部分栏名 |
| `serial_select_port`、`serial_set_baud`、`serial_set_frame`、`serial_set_lines`、`serial_set_display` | 选端口 / 波特率 / 帧格式 / DTR-RTS / 显示与行为开关 |
| `serial_open`、`serial_close` | 开 / 停监控，**会轮询确认状态**（最多 6s / 3s），失败给可操作原因 |
| `serial_send` | 发数据（`mode=hex` 按十六进制解析；`lineEnding` 可覆盖行尾） |
| `serial_clear` | 清空输出区（**只清界面**，不动磁盘会话缓存） |
| `serial_get_history` | 发送历史（最新在前） |
| `serial_quick_cmd` | 快速指令：不带 `index` 列出、带 `index` 执行 |

**两条关键设计**：

1. **不写第二套逻辑**（守约定 #3）：前端只新增一个 `serial` 语义 op，它只做"**寻址 + 组装**"——
   改值走 `mcpWriteEl`（与 `ui_set` **同一个函数**）、点按钮走 `el.click()`、
   没有 id 的按钮（如"清除内容"）调用**它 onclick 里那个函数**（白名单 `clearLog`/`refreshPorts`/`copyOutput`/`sendQcmdItem`）。
   所以界面必然跟着变，不存在"AI 改了但界面没动"。
2. **`pane` 参数**：按分栏名（`main` / `extra-1` / …）寻址，绕开"多分栏路径撞名（`_2` 后缀、AI 分不清哪个分栏）"
   这个已知缺陷；前端用应用自己的 id 约定 `<mid>-<控件后缀>` 定位控件。

**动作必须确认结果**：`serial_open` 不是"点完就返回 true"，而是点完**轮询 `isConnected`**（150ms × 40 次）直到真连上；
超时用 `E_DEVICE_NOT_READY`（按协议变成 result + `isError: true`，不是 JSON-RPC 错误）并给出常见原因
（端口被占用 / 设备被拔出 / 驱动异常），指向 `log_tail(channel="error")`。

**验证**：`cargo test` **150 过 / 0 失败**；前端断言 **951 过 / 0 失败**（本轮新增 43 条）——
其中最有价值的是把 `mcpSerial*` **真实函数丢进 vm + 假 DOM 跑行为断言**：分栏过滤（排除蓝牙内嵌监视器）、
默认 main、未知分栏、状态读取（含开关取自 `on` class）、选端口的 `from/to`、**端口给错要回列真实可选值**、
波特率越界、未知字段列出可用字段、**开关幂等（同值不点）**、按钮 `disabled` 时拒绝、
未开监控时拒绝发数据、发数据=写发送框+点发送按钮、历史最新在前、
快速指令（列出/空内容拒绝/执行走 `sendQcmdItem`）、清空走 `clearLog`、发送模式切换点是**真实下拉项**。
`doc/MCP_TOOLS.md` 已重新生成（20 → **32 个工具**，含每条的入参与实测返回结构）。

**还没做**：BLE（第二批）、ADB/WSL（第三批）、全局（第四批），以及**危险动作的二次确认**（设计 §9 仍未实现）
—— 这四块 2026-09-14 已补成**施工级计划：见 §16.6**（每个工具的入参/返回契约、读写与危险分级、共用前置、顺序与"做完的标准"）。

### 2026-09-13 · **用官方 Python SDK 当独立客户端做一致性检查 → 抓出 3 个真问题** ✅（这是回答"要不要装 mcp-bench"之后该做的事）

**做法**：不装 mcp-bench（原因见下一条记录），改用 **Anthropic 官方 Python SDK**（`mcp` 2.2.0）
当第三方客户端，连本程序的 SSE 端点跑一遍 42 项检查。**工具在仓库外**（`%TEMP%`，用户要求测试工具不进程序），
只依赖标准库 + SDK。检查项：HTTP 边界（`/healthz` 只回 ok、`/status` 401/打码、`/sse` 401、未知路径 404）→
`initialize` 协商 → `tools/list` 与 `protocol.rs` **逐字对齐** → 每个工具的 description/inputSchema →
**20 个工具逐个真调用**（只读的用真参数；会改状态的 `ui_set`/`ui_click`/`log_clear`/`mcp_config_set`
一律用**非法参数**走错误路径，绝不碰用户状态）→ 错误码语义 → 断开后会话回收。

**结果：42 项里 37 通过、5 失败 —— 其中 3 个是真的，2 个是测试脚本自己的 bug。**

| # | 问题 | 性质 | 处理 |
|---|---|---|---|
| 1 | **`serial_list_ports` 返回数组当 `structuredContent`** | **真 bug，且是硬伤**：规范要求 `structuredContent` 是**对象**，官方 SDK 走 pydantic 校验直接 `Input should be a valid dictionary` **把整条结果判为非法** → 这个工具在任何标准客户端里等于废的 | 改成 `{"count": n, "ports": [...]}`；并在 `tool_result_ok` 加**兜底**（非对象自动包成 `{"value": …}` 并上报），新增**规范级单测** `every_tool_result_structured_content_is_an_object` 遍历 10 个工具逐个检查 |
| 2 | **`log_clear` 对"通道名打错"静默返回成功** | 真问题：`clearedChannels: 0` 让调用方以为清干净了；而 `log_tail` 对同样的输入报 -32602，两者**不一致** | 改成报 `E_INVALID_PARAMS`（与 `log_tail` 同款提示），新增单测 `clearing_an_unknown_channel_is_an_error_like_tailing_one` |
| 3 | **客户端断开后会话不回收** | **真 bug，用户可感**：会话表只存 `tx`，SSE 接收端被 hyper 丢掉时没人知道 → 要等**空闲 30 分钟**才回收。`MAX_SESSIONS = 4`，客户端重启/重连 **4 次就把坑占满**，之后所有连接吃 429 且半小时不恢复 | SSE 响应体包一层 `SseBody`，`Drop` 时立刻从会话表移除；新增回归测试 `session_is_reclaimed_as_soon_as_the_client_disconnects`（连断 6 次、每次都要回收，最后还要能重连） |
| 4 | **协议版本协商回错了版本** | 规范细节：对端要的版本我们不认识时，规范要求回**自己支持的最新版**（preferably its latest），我们回的是 `PROTOCOL_FALLBACK`（**最旧**那版）。SDK 2.x 默认要一个比我们新的版本，于是被我们降到 2024-11-05 使用 | 改成回 `PROTOCOL_VERSION`；同步改断言 |
| 5 | 脚本自身 2 处 bug | `mcp` 2.x 的 pydantic 模型是 **snake_case**（`server_info` / `input_schema` / `is_error`），而规范与 JSON 是 camelCase —— 第一版直接 AttributeError 挂掉；`list_tools(cursor=…)` 在 2.x 不接受该关键字 | 加了 `pick(o, *names)` 两种名字都认；分页改成自适应（先无参调，有 nextCursor 再试两种写法） |

**为什么这轮值得做**：上面 4 个问题，**150 条 Rust 单测 + 906 条前端断言一个都没抓到**。原因不神秘 ——
单测是我按自己的理解写的（甚至有一条 `serial_list_ports` 的老测试**断言的就是"structuredContent 是数组"**，
把违规行为锁死了），而参考实现是按**规范**写的。这就是"换个实现来对答案"的价值。

**验证**：修完后重跑同一套检查 → **0 失败**（另 2 项因目标是联调服务器、无 GUI 而按预期跳过）。
Rust **150 过 / 0 失败**（新增 3 条），前端 **906 过 / 0 失败**，npm 安装器 **62 过**。

**给用户的提醒**：正在运行的那个实例是**改动之前**的构建，它身上有：4 个泄漏的会话坑位（重启即清，
或等 30 分钟空闲回收）、`serial_list_ports` 的数组问题、`log_clear` 的静默成功。重新构建后这些都没有了。

### 2026-09-13 · S11：MCP 运行期错误 → 错误上报（数据库）+ 补上**文档声称存在、实际不存在**的 panic 兜底 ✅

用户要求："MCP 服务器的运行中的错误也要上报数据库的"。查代码时先发现一个**必须坦白的问题**：

> **`AGENTS.md` 与本文档都写着"工具分派边界有 `catch_unwind` 兜底"—— 这句是假的。**
> 全 crate 搜过：`catch_unwind` 一次都没出现（`grep -r catch_unwind src-tauri/src` 零命中）。
> 当时的真实行为是：任何一次工具 panic 会把这条 SSE 连接的任务直接打死，客户端拿不到
> 任何响应（只能等超时），我们也完全不知情。两处文档都按它改了。

| 产出 | 说明 |
|---|---|
| `mcp/report.rs`（新） | 运行期错误的**唯一出口**：`report(kind, detail)` → 去重 → 打码 → `crate::report_error`。带 7 条单测 |
| `handle_raw_guarded`（新） | 分派入口的 panic 兜底：`futures::FutureExt::catch_unwind` + `AssertUnwindSafe`，panic → `E_INTERNAL` JSON-RPC 错误（消息里写明"已上报"）+ 一次上报。传输层只调它 |
| 12 个上报点 | `start_failed` / `start_timeout` / `config_save_failed` / `endpoint_write_failed` / `accept_failed` / `unauthorized` / `sse_endpoint_queue_full` / `session_slow_consumer_dropped` / `rate_limited` / `ui_bridge_timeout` / `calllog_write_failed` / `dispatch_panic` |
| `status.errorReports` | 状态里能看到 `reported` / `deduped` / 去重窗口 / 上报通道是否配置 —— 用户报障时第一眼看这个 |

**为什么必须自己去重，而不是只靠服务端**：`server/error-server.js` 有按签名去重，但那是最后一道闸。
一个 token 配错的客户端会**每几秒重试一次**，`unauthorized` 这类错误分分钟几百条 ——
客户端不挡，就是把用户的网络和错误库一起打爆。所以 `report` 自己按 `kind + detail` 做了
**5 分钟窗口**的去重，并统计被挡掉的次数。表本身也有上限（64 条），错误消息里带变量时不会无限增长。

**打码**：端点的自述 URL 里就带着 token（`/sse?token=…`），一个手滑就会把用户的令牌写进错误库。
`sanitize()` 会把 `token=…` 抹成 `token=****`，启动时还会把当前令牌登记进敏感串表
（`remember_secret`），连"裸 token"也一并抹掉。有断言守着。

**上报通道是"复用"不是"新建"**：走程序既有的 `report_error` —— 它一次做四件事：
LogHub 的 `error` 通道（AI 能查到）→ 本地 `%TEMP%\seahi-serial-debug.log` → Sentry（若配 DSN）→
自建服务 `POST {ERROR_SERVER_URL}/report`（`server/error-server.js` 落 SQLite）。
**注意**：Debug 构建沿用既有策略 —— 没设 `ERROR_SERVER_URL` 就不外发（隐私默认），
只在 LogHub + 本地日志里留痕；Release 构建配了就会上报。

**验证**：`cargo test` **147 过 / 0 失败 / 4 ignored / 0 warnings**（新增 8 条：去重命中一次、
不同细节分开报、`token=` 打码、登记串裸 token 也打码、多字节文本不被切坏、`guard` 把 panic
转成 Err 并计数、去重表有界、**工具 panic 变成 JSON-RPC 错误而不是打死连接**）；
前端断言 **901 过 / 0 失败**（新增 27 条：模块与函数存在、`catch_unwind` 真的在、传输层走带兜底的入口、
12 个上报点逐条核对、`init_error_reporter()` 被调用、状态里能看上报统计）。

**这一轮的教训**：`catch_unwind` 这件事说明**文档承诺必须能被一条命令验证**。
"有兜底"写在文档里三年也不会有人去查，但一行 `grep` 就能否掉它。已经把这个不变式
（`std::panic::catch_unwind(f)` 必须存在、传输层必须走 `handle_raw_guarded`）写进断言集，
以后谁把它删了，测试当场红。

### 2026-09-13 · 评估 `Accenture/mcp-bench` 是否适合评测本服务器 → **结论：不适合，不安装** ❌

用户要求安装 `https://github.com/Accenture/mcp-bench` 来"测试服务器的准确"。**读了它的源码后判定接不上**，理由如下（全部有代码依据，非猜测）：

| 事实 | 证据 |
|---|---|
| 它测的是**模型**，不是服务器 | 分数来自 LLM 裁判（README 明说"Must use o4-mini as judge model **hard-coded** in `benchmark/runner.py`"）；指标是"任务完成/工具选择/规划"，即"模型会不会用这套工具" |
| 它的接入口**只有 stdio** | `mcp_servers/commands.json` 的条目只有 `{cmd, env, cwd}`；`mcp_modules/server_manager.py` 用 `stdio_client` + `StdioServerParameters` |
| `transport: "http"` **不是"连一个已存在的 URL"** | `mcp_modules/connector.py:96` 的 `start_http_server()` 内部是 `subprocess.Popen(...)`（第 137 行）—— 它是**把那条 stdio 命令自己拉起来**再包一层本地 HTTP，而不是去连别人的 SSE 端点。骨架里所有 `url=`/`base_url=` 命中都是 LLM provider（OpenRouter），没有"服务器 URL"这个配置项 |
| 跑通还需要一堆外部条件 | OpenRouter + Azure OpenAI key、`mcp_servers/install.sh`（**bash**，装 28 个第三方服务器）、外加 5 个第三方 API key（NPS/NASA/HF/Google Maps/NCI） |

**关键矛盾**：本服务器是**进程内、仅 SSE、不能作为子进程启动**的（§3.4 / §3.5 的决定）。mcp-bench 的设计前提是"服务器由我拉起"，两者结构上对不上。要接就得写一个 **stdio↔SSE 适配器** —— 而这正是 §3.5 明确决定不做的东西。所以：**装了也用不上**，只会白占一份依赖。

**那"评测服务器"该用什么**（本仓库已有的 + 建议补的）：

| 手段 | 测什么 | 现状 |
|---|---|---|
| `cargo test` 里的 SSE 端到端（真实回环端口） | 握手 / `initialize` / `tools/list` / `tools/call` / 鉴权 | ✅ 已有 |
| 跨进程手工联调（`mcp_serve_for_manual_check` + 原始 HTTP/SSE） | 真实 socket 上的帧格式、`/healthz`、401、`/status` 打码 | ✅ 已有 |
| 前端无头断言 | 控件注册表、日志中心、弹窗交互、AI 配置隔离 | ✅ 已有 |
| **官方 MCP SDK 作为第三方客户端**（Python `mcp` 或 Node `@modelcontextprotocol/sdk`） | 用**参考实现**连一次：能不能 `initialize`、`tools/list` 与线路一致、逐个工具调用的返回/错误码是否符合规范、schema 是否合法 | ⏳ **建议补**（这才是"评测服务器本体"的仪器；Node 能出网，可装 SDK） |
| 慢消费者浸泡（RSS） | 内存边界 | ⏳ 只能真机跑（见上一条记录） |

> 沙箱网络环境备注（省得以后再试一遍）：**git 与 cargo 出不了网** —— 走 Windows schannel，报 `SEC_E_NO_CREDENTIALS`；但 **Node 的 fetch 能出网**（自带 OpenSSL），`pip` 也能**下载**（只是默认临时目录不可写，需把 `TEMP` 指到工作区内）。所以"下载一个仓库"在这台机器上的可行做法是 Node fetch + `tar.exe` 解包，而不是 `git clone`。

### 2026-09-13 · MCP 弹窗按用户真机反馈再改三处 ✅

| 改动 | 说明 |
|---|---|
| **两个按钮 → 一个切换按钮** | 点一下开、再点一下关（`mcpToggleEnabled()`）。按钮文案写的是"**点了会发生什么**"：关着时"启用 MCP 服务器"、开着时"关闭 MCP 服务器"，所以不用先看状态点就知道当前在哪一端。切换判断以 `_mcpStatus.running` 为准（不信界面）；命令发出期间 `_mcpBusy=true` → 按钮禁用 + 旁边显示"处理中…"，**挡住连点发出两条相反的 IPC** |
| **删掉底部那行元信息** | `版本 · 工具 · 请求 · 丢弃 · 发现文件` 整行移除（用户要求）。这些数字仍有排查价值（尤其"丢了多少条"），所以挪进状态文案 `#mcpStateText` 的 `title` 悬停提示，界面不再占一行 |
| **图标颜色与「风格」图标对齐** | 给 `#mcpBtn` 显式写 `color:var(--text)`（与 `.sel` 同一个 token）。**但同色 ≠ 同观感**：用户真机反馈"当前显得更亮、不是灰色的感觉" —— 原因是**字形墨量不同**：新图标是螺旋带（实心面积约 27%），「风格」的调色板是细环 + 小圆点（约 21%），同一个 `--text` 下前者就是更亮。故再压一档亮度：`#mcpBtn > svg { opacity:.8 }`（21/27 ≈ 0.78，取整到 .8）。**必须挂在 `svg` 上而不是 `#mcpBtn` 上** —— 挂父节点会把右下角的状态点（绿/蓝/红）一起压暗，那是状态指示，不能失真。用 opacity 而不是换 `--text-d`：12 套主题都按比例变，不会在低对比主题里直接糊掉 |
| **标题改成上下结构** | 用户："左右显示太丑了，比如 URL 下方"。原来 `.mcp-row` 是 `flex` + `.mcp-label { min-width:62px }`，标题吃掉左边 62px，长 URL / 长 JSON 只能在剩下的窄条里横向滚动。改成 `.mcp-field`（块级）+ 标题单独一行 + 内容占满整行。**副产物**：URL 现在整条显示得下，横向滚动条自己就没了。两个坑：① `.mcp-url` 是 `<span>`，以前靠"是 flex 子项"被块级化，脱离 flex 后必须补 `display:block`（否则 padding/overflow 都不按预期生效）；② 弹窗变高，给 `.ble-modal-body` 补了 `overflow-y:auto`（窗口太矮时不会把内容裁掉），并把弹窗主体也并入统一滚动条规则 |
| **复制按钮挪进内容框** | 用户："放在内容框的右上角"。第一版是放在标题行右端，仍占一行；现在改成 `.mcp-box { position:relative }` + `.mcp-copy-btn { position:absolute; top:3px; right:4px }`，按钮压在框内右上角，标题行整个省掉。配套三处细节：① 内容右侧 `padding-right:64px` 留位 —— **按点击后变宽的"已复制"（3 个字）算，不是按"复制"**，按钮右对齐、变宽时往左长，留少了会盖住内容；② 单行内容的 URL 框**整体下移一行**（`padding-top:26px ≥ 按钮底边 3+20=23px`）—— 内容只有一行时它正好落在按钮那一行上会撞在一起（用户第二轮反馈），`min-height:49px = 26+18 行高+5` 与之对齐；③ `.mcp-url` 的 `flex:1; min-width:0` 已无意义，去掉。代码框（多行）**不做**这个下移：首行右边的内容很短（`{` / 提示词首行），按钮只压住右上角一小块，整体下移会白白浪费一大截高度 |

| **顶栏间距统一** | 用户对着截图："按钮间距没有统一"。查下来确实：图标按钮 `margin-left:12px`、「提交issue/更新」`margin-left:8px`、主题开关 `margin-left:10px`、「加监视器」0（靠 `.app-info` 的 `margin-right:10px`）、MCP 两侧 12px —— 相邻间距在 **8/10/12** 之间跳。改为 `.global-bar { gap:8px }` 一处定义，把上述 6 处 margin 全删（含 3 个 toggle 按钮的内联 `style="margin-left:12px"`）。**先试过 12px**（三种里的最大值），整条栏比原先松，用户反馈"这么宽的距离不符合原先的审美设计"—— 已改回 **8px**（原先右侧那一组本来就是 8px）。要调间距现在只改一个数 |
| **悬停说明补齐** | 用户："鼠标悬停的内容简短说明该功能的主要作用"。顶栏 5 个图标原来只有名字（"ADB 调试"），补成"这个功能是干什么的"（"ADB 设备调试：设备列表、shell 命令、文件传输"）；MCP 弹窗里 **3 个复制按钮原本一个 `title` 都没有**，现补上各自复制的是什么；3 个区块标题也补了说明（讲清"这块是干什么用的"）；底部「关闭」补了最容易被误解的一句 —— **只关窗口，不影响服务器**；左上角应用图标由 JS 动态写 title，改为"版本号 + 点击回到串口主界面" |
| **滚动条交汇处不再是白方块** | 用户圈出截图里内容框右下角的白方块。原因是上一版只覆盖了 `::-webkit-scrollbar` / `-track` / `-thumb`，**漏了 `-corner`**（横竖两条滚动条交汇的那一小块，不写就用 Chromium 默认的白底）。补上 `{ background:transparent }`，并把**六个**可滚动区（3 从机 + 2 MCP 内容框 + 弹窗主体）一起覆盖 —— 同一个毛病不能只修看得见的那一处 |

**验证**：前端断言 **874 过 / 0 失败**（比上一轮新增 corner 3 条：MCP 侧生效、从机侧一并覆盖、六个可滚动区都写了 corner；连同之前的切换按钮、弹窗布局几何断言、顶栏 `gap` 统一、悬停说明逐条覆盖等）。Rust **139 过**、npm 安装器 **62 过** 不受影响。

> 写"顶栏不再自带 margin"这条断言时踩了个坑：切片结束标记写成 `win-ctrl`，而它第一次出现是在**前面的 CSS** 里（位置比顶栏还靠前），`slice` 直接返回空串 —— 空切片让断言变成了空转。已改成 `'<div class="win-ctrl"'` 并**额外断言切片长度 > 500**。教训：凡是"取一段再检查"的断言，都要先证明取到了东西，否则它只是个永远为真的装饰。

> 这次把"按钮会不会压住内容"写成了**几何断言**而不是只钉字符串：从 CSS 里取出 `padding-top`、`top`、`height`、`line-height`、`min-height` 做算术比较（`26 ≥ 3+20`、`49 = 26+18+5`）。以后再调这些数字，只要改出重叠或高度对不上，测试立刻红 —— 光钉 `padding:26px` 这种字符串是守不住的。

> 顺带把断言写法改稳了一点：原来"统一滚动条"那条断言是**把整段选择器文本钉死**的，这次往规则里加了 `#mcpModal .ble-modal-body` 就挂了。已改成「取出这条规则的选择器列表，再检查成员是否在里面」—— 以后往里加选择器不用再动断言。

**这次改动的教训**：原来断言里那条 `check(!/id="mcpToggleBtn"/... , '不是一个切换按钮')` 是**跟着用户当时的决定**写的 —— 用户改主意后它立刻变成"守着错东西"的断言。需求性断言要带日期与理由（这次已把来龙去脉写进 §10.2），否则半年后没人知道为什么"不能是切换按钮"。

### 2026-09-13 · MCP 弹窗的三处界面问题（真机截图发现）✅

用户在真机上打开了弹窗并截图，对照代码查出三处**只能靠看界面发现**的问题：

| 问题 | 原因 | 处理 |
|---|---|---|
| 运行中「启用 MCP 服务器」看起来仍像个可点的按钮 | `.ble-modal-btn` **没有 `:disabled` 样式**，禁用只靠 JS 写内联 `opacity`；`cursor:pointer` 仍然生效（点下去没反应，但看着能点） | 加统一的 `.ble-modal-btn:disabled { cursor:default; opacity:.45; }` 与 `:disabled:hover`（边框不变亮、primary 不提亮），删掉 JS 里那份内联 opacity；并给两个按钮加 `title` 说明"为什么点不了" |
| 连接 URL / 客户端配置 / 安装提示词是 Chromium 默认的白底宽滚动条 | 项目早已有一套"统一细灰条"的规则，但只挂在 `.ble-log`/`.ble-pf-left`/`.ble-pf-chars` 三个从机面板选择器上 | 把 `.mcp-url`/`.mcp-code` 并进同一份规则；**顺带补 `height:10px`** —— 原来只设了 `width`，横向滚动条（URL 那行）依旧是默认粗白条 |
| 标题栏图标换成用户新给的那份 | —— | 内联进 `#mcpBtn`（保持 `fill="currentColor"`，不抄源文件里的 `#bfbfbf`），同时把留档的那份图形源也换成同一份（该文件 2026-09 已删除），断言钉住新图形的起点 `M895.67 256.204` |

**验证**：前端断言 **829 过 / 0 失败**（新增 8 条：禁用态 CSS 两条、置灰按钮的 title、"JS 里不再有内联 opacity"、滚动条并入同一规则、`height` 已补、新图标图形源一致）。Rust **139 过**、npm 安装器 **62 过** 未受影响。

> 教训（第 N 次了）：**`:disabled` 不写样式就等于没禁用**。只设 `disabled = true` + 内联 opacity，用户看到的仍是一个高亮的蓝色主按钮 —— 这类问题单测抓不到（断言只能证明属性被设了），必须真机看一眼。

### 2026-09-13 · MCP S10 落地：加固与对外收口 ✅（并随 v0.5.0 一并发布）

**范围**：§16 的 **S10**，把"能用"变成"能给别人用"：补一个**对外可查询的状态端点**、让工具列表变化**主动通知客户端**、把 token/URL 从对外回显里彻底摘掉、**把 §4.7 承诺的内存上限真正执行起来**，并给 npm 包补上前端断言。

| 产出 | 说明 |
|---|---|
| `aiconfig::mask_url` | 统一的 URL 打码（只留端口与 token 末 4 位），配置写盘与对外回显**共用同一份口径** |
| `registry::replace_and_diff` | 上报注册表时顺带算出"**工具名集合是否变了**"；没变就不打扰客户端 |
| `transport::broadcast` + `GET /status` | 新增详情端点：**需要 token**，回 `status_json_public()`；`broadcast` 用 `try_send`，队列满/已断开的会话直接清掉，**绝不阻塞任何生产者** |
| `mod.rs` 的广播点 | `mcp_report_registry` 在 `tools_changed && running` 时向所有会话推 `notifications/tools/list_changed`，返回值里带 `toolsChanged` / `notified`（便于排查"客户端没刷新"） |
| `mcp_status` 工具 | 改为回**对外版**状态（工具是给 AI 看的，没必要回显 token） |
| `loghub` 的全局兜底 | `TOTAL_CAP_BYTES`（16 MiB）与 `MAX_CHANNELS`（64）**从"报告值"变成"被执行"**：超预算时按"裁最大的通道"尽力回收（`try_lock` + 单次最多 4 个通道），通道数到顶后新通道不再创建；新增 `channelSkips` / `reclaims` / `reclaimedBytes` 三个可见计数，并写进 `mcp_limits` |

**为什么要有 `/status` 而不是让客户端解析 `/healthz`**：`/healthz` 是唯一免鉴权端点，按约定**只回 `{"ok":true}`** —— 泄露版本号等于给本机任意进程一个免费的信息泄露点。要看详情必须持 token，且**即使持 token 也不回显 token 与完整 URL**（调用方本来就知道 token，回显只会让它多一个落盘/进上下文的机会）。

**顺带抓出的一个真 bug（S10 验收门逼出来的）**：写"**启停 50 次幂等**"这条单测时，第 1 圈就红了 ——
`serve()` 自己**不复位** `core.shutdown`，只有 `start()` 复位。生产路径下 `start()` 先复位再 spawn，所以用户看不到问题；
但"启动成功却连不上"这种故障一旦出现极难定位（`running=true`、端口在听、循环却立刻退出）。
已把复位点收敛到 `serve()`（绑端口之前）并加断言守住"**只有一处复位点**"，避免两处口径漂移。

**跨进程查 `/status` 时又发现两处对外回显/边界问题**：

1. 调用记录尚未写过任何一条时，`callLog.fileBytes` 会把内部哨兵值 `u64::MAX - 1`（**18446744073709551614**）
   原样吐给客户端 —— "未知"被表达成了一个看起来像"文件巨大"的数字。现在未 stat 过时回 **`null`**，并补了断言。
2. **§4.7 的"LogHub 合计 16 MiB 硬上限"当时只是报告值，没有任何代码在执行它。** 每通道各自有上限，
   但通道名是**动态的**（`serial:<面板>:<方向>`、`ui:<面板>`：开 N 个监视器就多 2N 个通道），
   所以光靠"每通道限流"总量其实没有上界，`log_stats` 里的 `totalCapBytes` 是一句**空头承诺**。
   现在真的执行了：`push` 记账后若超 16 MiB，就按当前字节数挑最大的几个通道裁到一半
   （`try_lock`，拿不到就跳过；单次最多 4 个通道 —— 回收必须是**有界代价**的，不能因为"超预算了"就在写入路径上遍历全部通道）；
   通道数超过 64 后不再新建通道，丢弃并计入 `channelSkips`。

**验证证据：**

- `cargo test --manifest-path src-tauri/Cargo.toml` → **139 passed / 0 failed / 4 ignored / 0 warnings**（S10 新增 8 条：`mask_url` 打码、`replace_and_diff` 的"变了才通知"、`/status` 需鉴权且不回显 token、广播能让已连接的 SSE 会话收到 `tools/list_changed`、**启停 50 圈逐圈验端口释放**、**全局预算真的被执行**、**通道数封顶并计数**、**回收路径不阻塞生产者**；另修 `stats` 的 `fileBytes` 哨兵值并加断言）。
- `node .walkthrough/gen_ble_preview.js` → **821 passed / 0 failed**（S10 新增 **36** 条：`/status` 路由与鉴权分支、`status_json_public` 的三处摘除、`/healthz` 未被放宽、`replace_and_diff` → `broadcast` → `list_changed` 的完整链路、**停机标志只有 `serve()` 一个复位点**、**两个内存上限常量＋回收路径＋三条兜底单测都在**，以及 npm 包的 8 条硬约束 —— 零依赖 / 无 `install`·`postinstall` / `os: win32` / `bin` 入口 / 只发布必要文件 / 支持 `--dry-run` / 改前备份 / **不调用任何子进程**）。
- **真实端口端到端**（`cargo test --offline mcp_serve_for_manual_check -- --ignored --nocapture` 起真服务，另一个进程用原始 HTTP/SSE 说话）：`/healthz` → `200 {"ok":true}`；`/status` 不带 token → **401**；错 token → **401**；对 token → **200 且响应体里既没有 `token` 也没有 `url` 字段**；未写过记录时 `callLog.fileBytes` 为 **null**；`/sse` 首帧是 `event: endpoint` + `/messages?sessionId=…&token=…`。

**顺带一起发**：v0.5.0 = §15 的三项内存/磁盘热修 + 本次 MCP 全套。版本号已同步 5 处（CI 会校验）。

**必须你在本机确认的事**（我无法代劳）：
1. 在 AI 客户端里连一次，确认 `tools/list` 有 20 个内置工具、调用 `ui_click` 时**界面真的动了**（这一步只能在真机上看）。
2. 开启 `expose.autoControlTools` 后，确认扫描出的 `ctl_*` 数量与界面控件数大体吻合（路径是靠启动时注入的 `data-mcp` 属性做锚点的，覆盖度只有真机能验）。
3. `npx seahi-serial-mcp install` 的真实写入我**仍未执行**（只跑过 `--dry-run`）；要实装请说一声。
4. **S10 验收门里的「慢消费者浸泡：RSS 增幅 < 10 MiB 且主界面不受影响」我没做**（真机才能跑，且要盯任务管理器读数）：能做的是把上限变成**被执行**的（见上：全局 16 MiB 回收 + 通道数封顶 + 每通道上限 + 单条 8 KiB 截断 + `try_lock` 不阻塞 + 全通道 `drop_all`），但"进程 RSS 到底涨不涨"只有真机能测。要做就按 §4.9 的办法：开一个慢客户端连上但故意不读，同时让串口以 115200 连续吐数据，观察 `log_stats` 的 `dropped`/`lockSkips`/`reclaims` 与进程 RSS。

### 2026-09-13 · MCP S9 落地：npm 客户端配置安装器 ✅（A 方案）

**范围**：§16 的 **S9**，即 §3.5 定下的 **A 方案**（用户已确认"就 A 吧"）。新增 `npm/seahi-serial-mcp/`。

**它不是 MCP 服务器**（服务器在应用进程内，见 §3.4），只做一件事：把应用已经暴露的端点写进 AI 客户端的配置。

| 文件 | 内容 |
|---|---|
| `cli.js` | 全部实现（~430 行，**零运行时依赖**，只用 `fs`/`os`/`path`/`http`） |
| `package.json` | `bin` 指向 `cli.js`；**无 dependencies、无 postinstall**；`engines.node >= 18`；`os: ["win32"]` |
| `test/self-test.js` | **62 条无依赖自测**：临时目录 + 自带本地 `/healthz` 服务；**不用子进程**（沙箱会拦管道的 stdio），直接 `require` 内部函数 |
| `README.md` | 用法、候选路径表（标注"需按本机核实"）、安全约定、排错表 |

**命令**：`install`（默认）/ `status` / `uninstall`，选项 `--client a,b`、`--url`、`--dry-run`、`--json`。
退出码：`0` 成功 · `1` 参数错 · `2` 应用没在跑 · `3` 没找到客户端 · `4` 有文件被拒绝写入。

**七条安全约定（全部有断言）**：

1. **写前探活**：读发现文件 → 确认 pid 存活 → `GET /healthz` 必须 200 且 `{"ok":true}`；否则**拒绝写入**（不往客户端塞连不上的地址）。
2. **只动自己那把键** `mcpServers["seahi-serial"]`；其它 MCP server 条目与文件里其它键**原样保留**。
3. **先备份、再原子写**：备份 `<文件>.seahi-bak-<时间戳>`，每文件最多 **5** 份；写入用临时文件 + `rename`。
4. **JSONC 绝不硬改**：解析不了（含注释）就打印可粘贴片段并以 **4** 退出，原文件逐字节不变。
5. **幂等**：已是目标 URL 就说"无需修改"，连 mtime 都不动。
6. **默认只挑"已经装了"的客户端**（配置文件存在）；VS Code 是工作区作用域，**不显式指定就不写**。
7. **token 打码**：打印的 URL 只留末 4 位。

**验证证据：**

- `node npm/seahi-serial-mcp/test/self-test.js` → **62 passed / 0 failed**。覆盖：路径与参数解析、token 打码、pid 存活判断、**没有发现文件/探活失败时都拒绝**、正常安装（其它键与其它 MCP 条目保留）、**幂等不写盘（内容逐字节比对）**、端口回退后重跑能修正并给出"原值"、备份份数上限、`--dry-run` 不写盘、**JSONC 被拒且原文件不变**、`uninstall` 只删自己那条、默认挑选逻辑（有/无已装客户端两种）、`status` 各状态、包本身约束（零依赖/无 postinstall/bin/engines/os）。
- **真实场景（对正在运行的应用）**：`cli.js status` 正确识别 —— 应用在运行、端点 `http://127.0.0.1:7777/sse?token=…574e`、pid 存活、应用版本 `0.4.2`；并**发现本机装了 Claude Code**（`D:\Users\Seahi\.claude.json` 存在），如实报告"未配置"，同时报告 Claude Desktop / Cursor / VS Code 的配置**不存在**。`install --dry-run` 正确地**只挑中 Claude Code** 并显示"将写入"，全程未写盘。

**过程中修掉的问题**：`--dry-run` 的结论行原本把 `would-install` 算进了"无需改动"，于是明明要写却报"1 个无需改动"。已按模式分别输出"将被修改/被修改"，并补了断言。

**必须你在本机确认的事**：
1. **候选人客户端路径需要你核实**（我无法核对各客户端版本的实际路径）：`status` 已经把候选路径逐个打出来了，请确认识别对不对。
2. **真正的写入我还没做**：本机确实有 `~/.claude.json`，我**没有**替你改它（只跑了 `--dry-run`）。要实装请说一声，或自己跑：
   `node npm/seahi-serial-mcp/cli.js install --client claudecode`
3. 装完在客户端里连一次，确认端到端可用（这一步只能在真机上做）。

### 2026-09-13 · MCP S6 落地：全量控件工具（`ctl_*`）✅

**范围**：§16 的 **S6**，把"**所有可操控控件都做成 MCP 工具**"这条原始要求真正落地。

**为什么要多一层**：MCP 客户端要先 `tools/list` 才知道有哪些工具，而工具列表只能由**服务端**给出；但控件注册表的真源在**界面**（只有它知道当前有哪些面板、哪些控件可用）。所以：

```
前端 mcpBuildRegistry() → mcpReportRegistry()（300ms 合并 + 签名去重）
        ↓ invoke('mcp_report_registry')
后端 RegistryCache（路径 → 工具名、按类型派生 schema）
        ↓
tools/list 里出现 ctl_* ；调用时按名字解析回控件路径，走**同一条界面桥**（ui_call "set"）
```

| 层 | 内容 |
|---|---|
| `mcp/registry.rs` | `RegistryEntry`（path/kind/label/panel/group/enabled/disabledReason/options）+ `tool_name_for()`（纯函数）+ `schema_for()`（按类型派生入参）+ 缓存（**清洗后撞名自动加序号保证唯一**）+ 命名空间过滤 + 分页 |
| 命名规则 | `ctl_` + 路径里非字母数字换 `_`、连续下划线归一、结尾不留 `_`、**≤64 字符**（留 58 的预算给序号） |
| schema 派生 | 按钮/开关 → 布尔（可省略）；勾选 → 布尔（必填）；数字/滑块 → number；**下拉 → 带 `enum` 的字符串**（选项从界面的 `.sel-opt` 采上来，AI 不用猜）；其余 → 字符串 |
| 顺序无关的可读描述 | 描述里带标签 + 面板·分组 + 类型；**不可用时把原因也写进描述**（AI 才不会盲试） |
| 门控（D2） | `expose.autoControlTools` **默认关**；`expose.namespaces` 可只暴露指定面板。默认关的理由：一次性几百个工具会明显拖累模型选工具的准确率（§5.6 的取舍） |
| 上限 | 单次最多生成 **400** 个 `ctl_*`（工具列表要进模型上下文，必须有上限） |
| 顺带补齐 | `ui_get_state`（复用界面的 `collectConfig()`，与"随用户配置持久化"是同一份真源；支持 `section` 取子树：serial/wsl/ble/theme/window/monitors） |

**验证证据：**

- `cargo test --offline` → **131 passed / 0 failed / 4 ignored、0 warning**（新增 17：工具名客户端安全与截断、撞名加序号且路径都能找回、schema 按类型派生、禁用原因进描述、命名空间过滤与分页不重复、路径↔工具名往返、空注册表、面板计数、前端 JSON 缺字段走默认值、**默认不暴露 `ctl_*`**、打开后出现、分页、命名空间限制、无界面时 `ctl_*` 与 `ui_get_state` 的可读失败、未知 `ctl_*` 走 `-32602`、面板名打错字被拒、状态里的工具数与注册表概览）。
- `node .walkthrough/gen_ble_preview.js` → **785 passed / 0 failed**（新增 29，含**行为断言**：上报走合并窗口、下拉选项被采成 enum、不可用状态与原因一起上报、内容没变不重报、状态变了要重报）。
- **跨进程 8/8**：`tools/list` 第一页出现 3 个 `ctl_*`（与命名规则推导的 `ctl_serial_conn_portselect` / `ctl_serial_toolbar_btnsend` / `ctl_global_ui_themeswitch` 完全吻合）；下拉选项作为 `enum` 暴露；分页正常；调用 `ctl_*` 与 `ui_get_state` 在没有界面时都给出"界面上下文"这条可读原因；未知 `ctl_*` 名返回 `-32602`；**真实 `ai-config.json` 未被这次验证改动**。线路上的完整工具清单为 **20 个内置 + 3 个 `ctl_*`**。

**这一轮的经验（我连续踩了三次同一个坑）**：我三次用 `edit` 时把**紧随其后的测试函数签名**当成了 `old_string` 的一部分替换掉，留下孤立的函数体。正确做法是把"要插入的位置之后的那一行"完整包进 `old_string`/`new_string`，或者改用一个唯一的锚点。另外断言集里 `mcpFiles` **第三次漏掉新增文件**（这次是 `registry.rs`）——已在断言里加注释提醒。

**必须你在本机验证**：在 DevTools 里看 `mcp_report_registry` 的入参条目数是否与 `mcpBuildRegistry()` 的返回值一致（真实 DOM 下才有的数字）；以及打开 `expose.autoControlTools` 后 `tools/list` 的真实工具数（我这边只有 3 个注入的假控件，真机可能是几十上百个）。

### 2026-09-13 · MCP S8 落地：AI 调用记录 + 配置隔离 ✅

**范围**：§16 的 **S8**，把"**操作记录不计入用户配置文件，而是写 AI 配置文件**"这条要求真正落地。

| 文件 | 谁写 | 内容 |
|---|---|---|
| `config.json` | **只有用户操作** | 界面/设备设置 —— MCP 模块**绝不碰它** |
| `ai-config.json` | MCP 子系统 | 服务器开关/端口/token + 新增 `callLog` 记录设置 |
| `ai-calls.jsonl` | MCP 子系统 | **每次工具调用一行**（追加写，崩溃不损坏已有记录；外部 `grep`/`jq` 直接可读） |

| 层 | 内容 |
|---|---|
| `mcp/calllog.rs` | 追加写 + **按大小轮转**（纯 rename，不把 32MB 文件读进内存）+ 超长入参截断（留 `_truncated`/`_chars`/`preview` 标记）+ 内存累计统计 + 查询（**只读文件尾部窗口** `READ_TAIL_BYTES`，并丢掉切进来的半行） |
| 记录字段 | `seq / ts / session / tool / args / ok / error / durationMs / effects`；`result` 默认**不记**（可能很大或含敏感内容） |
| 挂载点 | `handle_raw_with_session` 的 `tools/call` 分支 —— **成功、工具失败、协议级失败全记**；`ui_set`/`ui_click` 的 `effects`（前后值差异）单独提出来，事后能回答"AI 到底把哪个控件从什么改成了什么" |
| 4 个工具 | `mcp_calls`（可按工具/成败过滤，支持 md 表格）、`mcp_stats`、`mcp_config_get`（**token 只回打码值**）、`mcp_config_set`（只接受 `server`/`callLog`，未知键报错） |

**三条安全约定（都在代码里强制，不是靠自觉）**：

1. **不接受通过工具改 token** —— 必须由用户在界面点「重置令牌」；
2. **`server.host` 只允许回环**（`127.0.0.1`/`::1`/`localhost`）—— 不允许 AI 把服务器暴露到局域网；
3. 改 `server.*` **只保存、不当场重启** —— 否则会掐断正在回话的这次调用；只回报 `needRestart` 并说明怎么让它生效。

**默认禁用**：`CallLog` 的 `path` 默认是 `None`，只有 `McpState`/`start()` 才装上真实路径 —— 所以**单测绝不会往用户的 `%APPDATA%` 里写东西**（这一点是被刻意设计进类型的）。

**验证证据：**

- `cargo test --offline` → **114 passed / 0 failed / 4 ignored、0 warning**（新增 18：禁用时连文件都不建、一次调用一行且字段齐全、超长入参截断、返回值默认不记/按需记、轮转保留份数有界、统计与时间范围、按工具/成败过滤、尾部窗口半行容错、**写失败只计数不 panic**、**记录不碰同目录的 config.json（内容 + mtime 双断言）**、工具调用留痕、会话 id 落盘、`mcp_config_get` 打码、危险/未知配置项被拒、写盘走注入闭包、改端口只提示不重启）。
- `node .walkthrough/gen_ble_preview.js` → **756 passed / 0 failed**（新增 25）。
- **跨进程 + 真实文件（本轮最硬的证据）**：客户端独立进程调用 5 个工具后，`%APPDATA%\seahi-serial\config.json` 的 **SHA-256 与 mtime 逐字节未变**；`mcp_calls` 指向独立的 `ai-calls.jsonl`；`mcp_stats` 统计到当时已完成的 3 次调用（`mcp_stats` 自己还在飞行中，不计自己是正确行为）；`mcp_config_get` 只回打码 token。

**过程中修掉的问题：**

1. **配置键名不一致（真 bug）**：`CallLogCfg` 没有 serde 重命名，文件里存 `max_file_mib`，而工具入参收 `maxFileMiB` —— AI 从 `mcp_config_get` 看到的名字拿去 `mcp_config_set` 会被当成"不支持的配置项"拒掉。加 `rename_all = "camelCase"`。
2. **同一个坑的第二层**：serde 的 `camelCase` 会把 `max_file_mib` 转成 `maxFileMib`（小写 b），仍与入参的 `maxFileMiB` 不符 → 再加显式 `#[serde(rename = "maxFileMiB")]`。这个 bug 只有在写出去再读回来的测试里才会暴露。
3. `mcp_config_set` 原本直接调 `aiconfig::save` → 测试一跑就会覆盖用户真实配置。把写盘动作参数化成 `apply_config_patch_with(core, patch, save)`。
4. 断言集 `mcpFiles` 又漏了新增的 `calllog.rs`；另有 3 条老断言被"注释里的字面词""测试数据里的 `"0.0.0.0"`""`ai-config.json` 含 `config.json` 子串"误伤 —— 分别改成只看非注释代码行、只拦真的 bind、加前缀排除。

**必须你在本机验证**：真实用一段时间后打开 `%APPDATA%\seahi-serial\ai-calls.jsonl`，确认记录内容符合预期（尤其是 `effects` 能不能回答"那次操作改了什么"）；以及确认 `ai-config.json` 里多出 `callLog` 段后，旧配置仍能正常加载。

### 2026-09-13 · MCP S7 落地：日志中心 ✅（里程碑 M3）

**范围**：§16 的 **S7**，达成"**AI 能读日志并诊断**"。

| 层 | 文件 | 内容 |
|---|---|---|
| 日志中心 | `src/mcp/loghub.rs` | 通道 + 环形缓冲 + 每通道独立锁 + 字节上限 + `seq` + 丢弃计数；**写入用 `try_lock`**（拿不到锁就丢一条并记 `lockSkips`，**绝不阻塞生产者**）；单条截断 8 KiB；每行固定开销按 64 字节估算（否则上限形同虚设）；`clear` 清空但**保留通道**，`drop_all` 才真正释放 |
| 生产端旁路 | `main.rs` | `dbg_log` → `app`（**与调试文件开关无关**）；`report_error` → `error`；`ble_notify_loop` → `ble:rx`（**在生产处复制**，不去 drain 前端轮询的队列） |
| 界面回灌 | `index.html` | `bufferPush` 是**所有输出行的唯一漏斗**，从那里批量回灌（200ms / 单批 200 / 队列 2000 双上限）：串口·WSL 收发 → `serial:<mid>:rx|tx`、`wsl:<mid>:rx|tx`，界面提示 → `ui:sys` / `ui:err` |
| 工具 | `protocol.rs` | `log_channels` / `log_tail`（支持 `since_seq` 增量）/ `log_search`（子串或正则、可跨通道）/ `log_stats`（含 `linesPerSec`）/ `log_clear` / `log_export`（按时间归并成文本） |
| 命令 | `mod.rs` | `log_push_batch`（前端回灌入口，单次上限 500 条） |

**六条设计约束都真的落实了**（不是写在文档里就算）：

1. 非阻塞：`try_lock` + `lockSkips` 计数（有单测：持锁时连写 1000 条必须立刻返回）
2. 每通道独立锁：串口与 `ui` 互不影响（有单测）
3. 一切有上限：单条截断 + 每通道字节上限 + 总量上限（有单测：反复灌入后字节数不超过 cap，且 `dropped` 递增）
4. HEX 不在存储期生成：只记原始字节数
5. 关闭即零成本：默认 `enabled = false`，`start()` 才打开，`stop()` 调 `drop_all()` 真正释放（有单测）
6. 丢弃必须可见：`mayBeIncomplete` / `dropped` / `lockSkips` 都暴露给 AI —— 不让它以为日志是完整的

**错误语义**：未知通道、非法正则属于**参数非法** → 协议级 `-32602`（与"控件路径不存在"同一套规则），并给出可执行的下一步（"先用 `log_channels` 看有哪些"）。

**验证证据：**

- `cargo test --offline` → **96 passed / 0 failed / 4 ignored、0 warning**。新增 15 条：停用是零操作、`seq` 往返、`since_seq` 增量、长行截断、字节上限与丢弃计数、通道互不影响、**持锁时写入不阻塞**、子串/正则检索、跨通道检索、清空保留通道、`drop_all` 释放、未知通道的可执行报错、导出按时间归并、统计含级别计数。
- `node .walkthrough/gen_ble_preview.js` → **731 passed / 0 failed**（新增 30）：生产端三处旁路、回灌的双上限与节流、通道命名规则、6 个工具已定义、上限表/`try_lock`/截断/开销估算/`drop_all`/默认关闭等硬约束；**行为断言**：未到窗口不发送 → 到点一次性发出 → 队列上限 2000 → 单批上限 200 且丢最旧留最新。
- **跨进程**（真实 SSE、客户端独立进程）**5/5**：`log_channels` 列出 `app` + `mcp`；`log_search` 命中；`log_tail` 返回 `mayBeIncomplete` 且样例行就是真实内容（含 `mcp: 会话 … 已建立`）；`log_stats` 带速率；**清空后 `log_tail` 返回 0 行而不是报"通道不存在"**。

**过程中修掉的问题（都是我自己写出来的）：**

1. `push` 最初每次写日志都**遍历所有通道求和**来更新总量 —— 等于每写一条就把所有通道锁一遍，直接违背"生产者非阻塞"。改为**纯原子增减**。
2. `clear` 最初把通道从表里**删掉**，于是紧接着 `log_tail` 报"没有这个通道"（AI 会以为通道名写错）。改为**清空但保留通道**，新增 `drop_all` 承担真正的释放。
3. 单测**并行**共享全局日志中心，互相 `set_enabled(false)` 把通道清掉 → 随机失败。给碰全局 hub 的用例加了一把静态锁串行化。
4. 断言集里 `mcpFiles` 漏了新增的 `bridge.rs` / `loghub.rs`，导致一批源码断言找不到文件而失败。
5. 联调用的 `mcp_serve_for_manual_check` 直接调 `serve()` 而没走 `start()`，**日志中心没被打开** → 跨进程检查误报失败（生产路径是对的）。夹具已补上启用。

**与 §7.0 的一处偏差（要说清楚）**：串口收发**不是**在后端读线程旁路，而是从**界面**回灌。原因：`PortReader` 不持有监视器 id（它的 `port` 字段是串口句柄），要在读线程旁路就得改 `PortReader::new` 的签名与三个线程的捕获，改动面偏大。实际影响很小 —— 只要端口连着，界面就在轮询（窗口不可见时降到 500ms），所以串口行仍会进 LogHub；但**界面彻底不轮询时串口数据不会进日志**。这一点作为后续改进项记录。

**必须你在本机验证**：真实跑一段串口数据后调 `log_channels` / `log_stats`，看 `serial:<mid>:rx` 的条数与速率是否与界面上的行数**量级一致**（我这里没有真串口，只能用夹具验证语义）。

### 2026-09-13 · MCP S4/S5 落地：控件注册表 + 界面桥 ✅（里程碑 M1）

**范围**：§16 的 **S4**（控件注册表）与 **S5**（前端桥），达成"**AI 能操作界面**"的最小闭环。

| 层 | 文件 | 内容 |
|---|---|---|
| 注册表 | `src/index.html` | `MCP_SELECTOR` + `mcpBuildRegistry()`：boot 时给每个控件**注入 `data-mcp`** 当唯一锚点；路径 `<panel>.<group>.<name>`；面板归属靠**沿 parentNode 上溯**判定（刻意不用 `closest()`，便于无头测试）；字段→分组用一张显式表；没有 id 的控件用「面板 + 标签名 + 文档序」兜底 |
| 读写 | `src/index.html` | `mcpReadEl` / `mcpWriteEl`：**一律走合成 DOM 事件**（按钮 `click()`、输入 set + `input` + `change`、自定义下拉点中 `.sel-opt`、toggle 差量点击——值没变就不点）；**写后回读真实值**再返回 |
| 桥 | `src/mcp/bridge.rs` | `UiBridge`：oneshot 关联表 + 5s 超时**必回收** + 在途上限 32（饱和立刻 `-32005`，**不排队**） |
| 工具 | `src/mcp/protocol.rs` | `ui_list`（面板/类型/关键字过滤 + 分页）、`ui_describe`（带输入 schema，**下拉的可选值直接作为 enum 给出来**）、`ui_get`、`ui_set`（支持批量）、`ui_click` |
| 命令 | `mod.rs` / `main.rs` | `mcp_ui_ack`（前端回执）、`mcp_notify_state`（状态变更通知，带 `origin` 供回声抑制） |

**错误语义（按 MCP 规范分清 —— 弄混会让客户端把工具错误当成连接故障）**：

| 情况 | 返回 |
|---|---|
| 未知工具 / 参数缺失或非法 | JSON-RPC error **`-32602`**（请求本身有问题） |
| 控件路径不存在 | **`-32602`**（前端回 `notFound`） |
| 控件被禁用 / 执行失败 | 正常 result + **`isError: true`**，并带上 `disabledReason` |
| 前端 5s 未回执 / 桥饱和 / 无 GUI 上下文 | `-32004` / `-32005` / `-32006` |

> 顺带纠正了上一轮的一处偏差：**未知工具**原先返回 `-32601`，已改为 **`-32602`**（规范把"未知工具"归在 Invalid params；`-32601 Method not found` 留给未知的 JSON-RPC 方法）。

**验证证据：**

- `cargo test --offline` → **77 passed / 0 failed / 4 ignored、0 warning**。新增覆盖：桥的「回执解挂 / 超时回收 / 饱和拒绝 / 下发失败回收」四条真往返（把"下发"抽象成闭包，所以不需要真 AppHandle）；`-32602` 与 `isError` 的分流；无 GUI 时必须给出可读原因而不是假装成功。
- `node .walkthrough/gen_ble_preview.js` → **701 passed / 0 failed**（新增 52 条）：路径派生、类型识别、读写往返（含"值没变就不重复点"）、`data-mcp` 注入与路径唯一性、无 id 控件的兜底路径、`ui_list` 的过滤与分页、`ui_describe` 的 enum、`ui_set` 的 effects 与写后真实值、禁用控件明确失败、批量逐条返回成败。
- **跨进程**（真实 SSE 会话、客户端是独立进程）：`tools/list` 返回 **9 个工具**（`app_info / mcp_status / mcp_limits / serial_list_ports / ui_list / ui_describe / ui_get / ui_set / ui_click`）；`ui_list` 在无界面上下文时返回 `isError` 且**不挂起**；`ui_set` 缺参数返回 `-32602`。

**必须你在本机验证（我这边没有真 DOM / GUI）**：

1. 在应用 DevTools 控制台跑一次 `mcpBuildRegistry()`，看返回的控件数量与 `Object.keys(MCP_REGISTRY).length` —— 确认真实 DOM 下**路径没有意外碰撞**（我这边只能用假 DOM 验证派生逻辑是否自洽）。
2. 用真实客户端调 `ui_list` / `ui_get` / `ui_set`，确认**界面确实跟着变**（这是 S5 的核心断言，只能在真机上验）。
3. `ui_set` 改值后确认已落盘，且 `config.json` 里**没有**任何 AI 痕迹（只有配置值本身）。

**一处产品决策（已按此实现）**：`viewMode`（文本/HEX）归 **`serial.conn`** 而不是 `send` —— 因为它在实际界面里就和「端口 | 波特率 | 行尾」在同一行。

**本轮未做**：`ui_get_state` / `ui_apply_state` / `ui_watch` / `ui_wait`（复用它俩已具备的能力，但属于 S6 的完备性工作）；`ctl_*` 全量自动工具（S6）；日志（S7）；`ai-calls.jsonl`（S8）。

### 2026-09-13 · MCP S0~S3 落地：**连接已可用** ✅

**范围**：只做到"独立进程的客户端能连上、能握手、能调工具"，即 §16 的 **S0~S3**（不含注册表/日志/AI 记录）。

#### 交付物

| 层 | 文件 | 内容 |
|---|---|---|
| 依赖 | `src-tauri/Cargo.toml` | `hyper` + `hyper-util` + `http-body-util` + `bytes`；tokio 补 `rt/net/sync/io-util`（**不开 macros**） |
| 配置 | `src/mcp/aiconfig.rs` | `ai-config.json`（开关/主机/端口/token）+ `mcp-endpoint.json`（发现文件）；**临时文件 + rename 原子写**；所有函数都有 `_in(dir)` 变体以便在临时目录里测 |
| 协议 | `src/mcp/protocol.rs` | JSON-RPC 2.0 编解码、标准 + 自定义错误码、`initialize`/`ping`/`tools/list`(分页)/`tools/call`/`resources/list`/`logging.setLevel`、**工具失败返回 `isError` 而不是 JSON-RPC error** |
| 传输 | `src/mcp/transport.rs` | hyper 服务器；`/healthz`(无 token、零信息)、`/sse`(首帧 endpoint)、`/messages`(202 + 结果走 SSE)；token 定长比较；会话上限/队列上限/限流/空闲回收/心跳；**慢消费者丢弃并计数** |
| 状态 | `src/mcp/mod.rs` | `McpCore`（**不依赖 Tauri**，故可单测）+ `McpState` + 启停/自愈 + 4 个 Tauri 命令 |
| 接入 | `src/main.rs` | `mod mcp;`、`.manage(McpState::default())`、`setup()` 里 `mcp::autostart()`、`CloseRequested` 里 `mcp::shutdown_on_exit()` |
| 界面 | `src/index.html` | 标题栏 MCP 图标（**内联 SVG + currentColor**，在「风格」左边、**与风格图标同色**，带状态点）+ 弹窗（**一个切换按钮**（点一下开、再点一下关）+ URL/客户端配置/安装提示词 + 三个一键复制）；`writeClipboard()` 抽出供日志复制与弹窗共用 |

**本轮实现的工具（4 个）**：`app_info`、`mcp_status`、`mcp_limits`、`serial_list_ports`（后两个都无需前端桥，所以本轮不需要 AppHandle 参与工具执行 —— 这是可测性的关键）。

#### 验证证据

**① 单元/集成测试：`cargo test --offline` → 66 passed / 0 failed / 4 ignored**（原 32 + 新增 34），**0 warning**。
其中含**真实回环端口**的端到端测试 `end_to_end_sse_handshake_and_tool_call`：建 SSE → endpoint 帧 → POST `initialize` → 从 SSE 读回 `serverInfo` → `tools/list` 看到工具 → `tools/call app_info` → 坏 sessionId 得 404。

**② 跨进程验证（服务端与客户端是两个独立进程）**，用原始 HTTP 手写完成一次完整 MCP 会话：

| # | 检查 | 结果 |
|---|---|---|
| ① | 服务在独立 `cargo test` 进程里监听 `127.0.0.1:7799` | OK |
| ② | `/healthz` → `HTTP/1.1 200 OK {"ok":true}` | OK |
| ③ | 探活端点不泄露 version/session/token/tool 任何一项 | OK |
| ④ | 错误 token → `401 Unauthorized` | OK |
| ⑤ | 正确 token → SSE 握手，首帧 `event: endpoint`（拿到 sessionId） | OK |
| ⑥ | `POST /messages` → `202 Accepted` | OK |
| ⑦ | `initialize` 结果经 SSE 返回：`"serverInfo":{"name":"seahi-serial","version":"0.4.2"}` | OK |
| ⑧ | `tools/call app_info` 返回 `structuredContent` | OK |

**③ 前端无头断言：`node .walkthrough/gen_ble_preview.js` → 649 passed / 0 failed**（原 594 + 新增 55）。
其中包含几条**结构性不变量**：MCP 模块源码里不出现 `config.json`、不调用 `save_config/load_config`（R5 的硬约束）；不存在 `"0.0.0.0"` 字面量；`Cargo.toml` 没有 `panic="abort"`（工具 panic 不能杀进程）。

#### 过程中修掉的问题（都是自己写出来的，不是猜的）

1. `StreamBody` 同时实现了 `Body` 与 `Stream` → `.boxed()` 有歧义；且 SSE body 包着 `mpsc::Receiver`（不是 `Sync`）。改用 `UnsyncBoxBody` + `boxed_unsync()`。
2. `McpState::default()` 最初用内置默认值 → **从不读磁盘上的 `ai-config.json`**：会导致每次启动重生成 token（用户粘过的客户端配置全失效）且"停用"不生效。改为从磁盘读。
3. `tauri::State` 自己有个私有字段 `0`，直接写 `state.0` 会命中它而不是解引用 → 加 `McpState::core()` 方法。
4. 绑定端口 0 时没有回报系统实际分配的端口（跨进程测试与非默认端口都靠它）。
5. 测试断言自身写错 4 处：掩码用 `len()`（字节）而非 `chars().count()`；`mask_token("tok9")` 实际走 `****` 分支；`fn mcp_*` 定义在 `mcp/mod.rs` 却去 `main.rs` 里找；`0.0.0.0` 是**注释**里提到"绝不监听"被误判。

#### 本轮**未**做（按 §16 顺序在后续轮次）

S4 控件注册表、S5 `ui_*` 前端桥、S6 全量/语义工具、S7 日志中心、S8 AI 调用记录（`ai-calls.jsonl`）、S9 npm 安装器、S10 收紧。
另外本轮**未**实现：`POST /mcp`（Streamable HTTP）、`/status`（带 token 的详情端点）、`resources/subscribe`、危险工具确认。
（**后续更新**：`/status` 见 S10，Streamable HTTP 见 §17 的 2026-09-16 一条；`resources/subscribe` 与危险确认仍未做。）

#### 需要在你本机验证（我这里做不到）

1. **GUI 能否正常跑起来**：`npm run dev`，确认标题栏出现 MCP 图标、点开弹窗能启用/关闭、URL 与提示词能复制（要注意：MCP 默认随程序启动，所以图标一开始就是绿的）。
2. **真实 MCP 客户端联调**：把弹窗里复制出的配置贴进 Claude Desktop / Cursor 试连（我这边的 `version 0.4.2` 与 `serverInfo` 都是测试桩，真机才是最终验收）。
3. **端口冲突场景**：故意让 7777 被占用（比如先跑 `node -e "require('http').createServer().listen(7777)"`），确认能自动回退到 7778 并在弹窗里显示实际端口。

### 2026-09-13 · P0.5 三项既有问题热修（v0.4.2）✅

代码全部落地并通过验证，**与 MCP 无关、可独立发布**。

| 项 | 落地内容 | 涉及位置 |
|---|---|---|
| **L3a** | `DEBUG_LOG_MAX_BYTES = 4 MiB` + `debug_log_rotate()`（旧 `.1` 覆盖）+ `SEAHI_DEBUG_LOG=0` 开关 + `AtomicI64` 大小缓存（首次 stat 初始化，避免每次系统调用）+ `Mutex` 串行化；保留原「每次开/写/关」的崩溃安全模式 | `main.rs` 顶部 |
| **M28** | `LOG_CACHE_MAX_BYTES = 8 MiB`、`LOG_CACHE_MAX_TOTAL_BYTES = 64 MiB`；`LogCacheSession` 加 `bytes`/`capped`；触顶写终止标记 + `emit("log-cache-capped")`（前端 Toast + sys 行）；`enforce_log_cache_limit_in()` 新增 `active` 集合，**不删正在写入的文件** | `main.rs` 日志缓存段 + `index.html` 事件监听 |
| **M29** | 紧凑缓冲改 `_textDataMaxBytes = 8 MiB` 字节预算（`bufferTrimToBytes` 二分找裁点、`bufferCompactCapacity` 容量收缩到 ≥1 MiB 的 2 的幂、`bufferEnforceBudget` 统一入口，`bufferPush` 与 `bufferUpdateLineText` 都接）；DOM 裁剪收敛为单一 `trimOutputDom(mid, el, force)`：正常 15000→10000、受保护时只裁到 60000 并滚动补偿、`selectionchange` 补裁；三处调用点（逐行追加 / `flushBatch` / `cleanupExtraLines` force）统一 | `index.html` |

**实测偏差与取舍（与 §15 计划的差异）：**

1. **DOM 裁剪逻辑实际有两份、不是一份**（`4304` 的逐行追加路径与 `4336` 的 `flushBatch`），加上 `cleanupExtraLines` 共三处。计划里只写了 4304 一处 —— 已统一收敛到一个 `trimOutputDom`，否则会留下第四份不一致。
2. **受保护时的裁剪目标定为 `hardLimit` 本身**（只移除超出的部分、通常 1 行），而不是像正常路径那样一次裁到 10000。理由：用户在顶部读历史时，一次裁掉 5 万行会造成巨大视觉跳动；逐行最小干预既保住内存上限（6 万行）又不打扰用户。
3. **`_textData` / 索引数组的初始容量没有调小**（计划 §15 M29-d 的"顺带调小"）。原为 1 MB + 3×10 万槽位 ≈ 1.7 MB/监视器；因为**无法在此环境实测**收益，且属独立的性能取舍，留待有真实内存曲线后再定。
4. **容量收缩保留 1 MiB 下限**（不是收缩到刚好够用）：避免高频申请/释放造成抖动与碎片。
5. **已知未做**：目录总预算在执行时若「所有文件都在写入」则无法继续删（已用 `active` 集合显式跳过）。此时靠**单文件 8 MiB 上限**兜底 —— 最坏 10 × 8 = 80 MiB，仍然有界。

**验证：**

- `cargo test`：**32 passed / 0 failed**（原 27 + 新增 5：日志轮转判定、轮转覆盖旧备份、缓存按个数/按字节清理、活跃文件不被删）；3 条 `#[ignore]` 真机测试跳过。
- `node .walkthrough/gen_ble_preview.js`：**584 passed / 0 failed**（原 555 + 新增 29，含行为断言：字节预算裁剪保尾部、容量收缩、DOM 三档上限、顶部/选区保护、`selectionchange` 补裁、`force` 忽略保护）。
- `cargo check`：**0 warning / 0 error**。
- ⏳ **仍待真机/真实使用验证**（见下方清单）：内存是否真的收敛到平台期、日志文件是否按预期轮转。

### 2026-09-13 · M29-d 补充（依据 Chrome 堆快照）

用户提供了 DevTools 堆快照：总计 **10,799 kB**，其中「Typed arrays」**3,502 kB**、其它非 JS 对象（HTML/CSS）5,356 kB。
3,502 kB ≈ **2 × 1,707 kB**，而 1,707 kB 正好是一个监视器的预分配量（1 MiB + 400 KB + 100 KB + 200 KB）——说明这份内存**几乎全是预留未用**。据此把 §15 里"以实测为准、先不动"的 **M29-d** 做了。

| 项 | 落地 |
|---|---|
| 起步值 | `TEXT_BUF_INIT = 64 KB`、`TEXT_IDX_INIT = 4096` 槽位；**三条**创建路径（`createMonitorPane` / `addWslMonitor` / `initWslMonitor`）统一使用 |
| 收缩下限 | `bufferCompactCapacity` 的下限由 1 MiB / 10 万 改为这两个常量 |
| 新回收时机 | 「清空输出」（`clearLog`）时调用 `bufferCompactCapacity` —— 用户明确表达"不要了"的时刻，把容量收回起步值 |
| 顺带修 **B1** | `bufferPush` 扩容索引数组时补上 `set()` 拷贝；数据缓冲扩容改 `Math.max(翻倍, 实际需要)` |
| 顺带修 **B2** | 两条 WSL 创建路径补 `_textDataMaxBytes`；`bufferEnforceBudget` 增加"字段非法则回退默认 8 MiB"的防御 |

**预期收益**：每个空闲监视器 1,707 kB → **92 kB**；两个监视器约省 **3.2 MB**（总堆 ~10.8 MB → ~7.6 MB）。
⚠️ 这是**按字节数推算的预期值，不是实测值** —— 需要再抓一次堆快照对比确认。

**验证**：`node .walkthrough/gen_ble_preview.js` → **594 passed / 0 failed**（较上一轮 +10；含"跨 4096 扩容边界旧偏移不丢"、"漏设预算不裁空"、"空闲容量可回收"）。

**这一轮的教训**：`M29` 第一次改动只覆盖了 `createMonitorPane` 一条创建路径，靠 `grep` 全部 `new Uint8Array(` 才翻出另外两条 WSL 路径。
断言里因此加了一条**结构不变量**：`_textData:` 的出现次数必须等于 `_textDataMaxBytes:` 的出现次数 —— 以后新增监视器类型忘了设字段会直接红灯。

### 2026-09-13 · 遗留待定项与已知取舍（本轮**未**改动代码，仅记录）

> 决定："就这样吧，先记录下来"。以下都是**已知但未决**的事，供后续排期时定。

#### 1) 初始容量与裁剪上限是两个独立数字，后果不同级

| 改动 | 性质 | 后果 |
|---|---|---|
| 初始容量 1 MB → 64 KB、10 万 → 4096 槽位（M29-d） | 只影响**扩容次数** | 见第 3 条，几乎无后果 |
| 裁剪上限 100 万行 → **8 MiB 字节预算**（M29，**不是** M29-d） | 影响**能保留多少历史** | ⚠️ 有用户可见后果，见第 2 条 |

#### 2) ⚠️ 8 MiB 上限改变了"导出 / 复制全部"的语义（待决策 → §13 D14）

历史考证：紧凑存储由 `4ba545a`（**v0.2.5「内存优化」**）引入，该提交自己的注释写着
`// 优先从紧凑存储读取（保留完整日志，不受 DOM maxLines 限制）` —— **它存在的意义就是提供"完整日志"**。
M29 把上限从 100 万行收紧到 8 MiB（按 40 字节/行 ≈ 20 万行），**紧约 5 倍**，长行更紧。

而两处缓存的截断方向**相反**：

| 位置 | 保留 | 上限 |
|---|---|---|
| 内存紧凑存储 | **结尾**（裁最旧） | 8 MiB |
| 磁盘 `log-cache\session-*.log` | **开头**（写满即停） | 8 MiB / 文件 |

⇒ **文本超过 ~8 MiB 的会话，中段两边都没有。** 这是 M29 设计时未讲清的取舍。

#### 3) 初始容量调小的后果（已评估，无功能影响）

| 项 | 说明 |
|---|---|
| 扩容路径变成热路径 | 4096 行即触发扩容（原 10 万行）。**好处**是隐藏 bug 早暴露（B1 正是被它逼出来的）；**代价**是被踩频率高约 25 倍。已有断言锁住（跨 4096 边界旧偏移不丢） |
| 扩容次数 | 一次运行内 3 次 → 7 次翻倍才到 8 MB，多拷约 1 MB。可忽略 |
| 「清空输出即回收容量」 | 若用户高频清空会反复扩容（几毫秒级）。见 §13 D16 |
| **无数据正确性风险** | 已核对：`_textData.length` / `_textOffsets.length`（**容量**）只在扩容与收缩两处被读；所有读取路径（保存 / 复制 / 历史加载 / HEX 切换）都走 `_textOffsets`，与容量无关 |

#### 4) 两个"本来就有、现在更容易踩到"的点

- **"8 MiB"不是内存占用上限**：扩容发生在预算检查**之前**，容量会在 4→8→16 MB 之后裁回，**峰值容量可达预算的 2 倍**。该特性在 M29 之前就存在，但不应把 8 MiB 当作内存上限来引用。
- **B1（索引扩容不拷贝旧数据）自 v0.2.5 就存在**，不是本轮引入（在 `4ba545a` 的 diff 里能看到当时的原始代码）。但把初始容量调小会让它从"10 万行"提前到"4096 行"触发，所以必须先修 —— 已修 + 已有断言。

#### 5) 没有实测、只能推断的部分（最大不确定性）

| 事项 | 现状 | 怎么验 |
|---|---|---|
| **RSS 是否真的下降** | 只按字节数推算"两个监视器省 3.2 MB"（1,707 → 92 KB/个）。**V8 的 ArrayBuffer 分配器不保证把内存还给 OS** | 跑起来对比 ① 任务管理器内存 ② Chrome 堆快照（改前 / 改后）。**若 RSS 不降，本次调整的意义需重新评估** |
| 扩容 / 收缩的实际开销 | 未测（估算为微秒级 memcpy） | 921600 波特持续收数据时看是否掉帧 |
| 折中值是否更合适 | `TEXT_BUF_INIT = 256 KB` / `TEXT_IDX_INIT = 16384`：92 KB → 约 300 KB（仍省 82%）、扩容次数 7→5 | 见 §13 D15 |

**建议的验收顺序**：先抓一次**改后**的堆快照 + 任务管理器读数（对照本文件前面记录的 **10,799 kB 总计 / Typed arrays 3,502 kB**），再决定 D14 / D15 / D16。
