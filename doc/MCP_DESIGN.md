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
| Streamable HTTP（2025-03-26 规范） | `POST /mcp`（返回 JSON 或 SSE 流）、`GET /mcp`、`DELETE /mcp` | 新版客户端默认走这个 | ✅ 同端口附带（薄封装，复用同一 SessionRegistry） |

理由：用户要求"只采用 SSE 模式"，但主流客户端在新版本里已经默认 Streamable HTTP；两者共用同一套工具与状态，附带实现的成本远低于"客户端连不上再返工"的成本。配置项 `streamableHttp: true` 可关。

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

**写入方式（不要重犯 M7）**：TODO 里的 M7 记录过一次真实事故——"配置非原子写 + `load_config` 把读取失败等同首次运行 → 半截 JSON 让配置静默全丢"。所以：

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

---

## 17. 实施记录

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

> ⚠️ 仍未验证：**真实串口数据是否真的流进了 `serial:<分栏>:rx`**（条数/速率与界面行数是否量级一致）。
> 这需要一台真设备真的在发数据 —— 见 `TODO.md`「真机验证待办」第 6 项。

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

**还没做**：BLE（第二批）、ADB/WSL（第三批）、全局（第四批），以及**危险动作的二次确认**（设计 §9 仍未实现）。

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
