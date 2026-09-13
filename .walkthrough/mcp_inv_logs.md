# Seahi Serial Debugger — 日志与输出通道全量盘点

- 盘点对象：`src-tauri/src/main.rs`（7045 行）、`src/index.html`（10610 行）
- 盘点方式：只读静态分析（grep + 逐段阅读），未运行应用
- 生成时间：本次盘点会话
- 行号均为 **当前工作区文件的实际行号**

---

## 0. 结论摘要

| 结论 | 说明 |
|---|---|
| 通道总数 | **13 条**：串口收发、WSL 串口收发、ADB PTY、BLE 主机通知、BLE 从机事件、工作流 `[Auto]`、监视器系统/错误行、Toast、启动兜底页、后端调试日志、错误上报、缓存文件、手动导出 |
| 后端日志框架 | **无**。没有 `log`/`tracing`/`env_logger` 的初始化与调用；无级别、无开关、无调用栈（`sentry` 仅为可选 feature） |
| 调试日志 | `dbg_log()`（`main.rs:16`）→ `%TEMP%\seahi-serial-debug.log`，**无上限、无轮转、无开关**，58 处调用点 + 全部 `report_error` 都会写入 |
| 唯一持久化的用户日志 | 隐形缓存 `session-*.log`（`%APPDATA%\seahi-serial\log-cache`，最多 10 个文件）+ 手动 `save_log` + 工作流 `workflow_log.txt` |
| 无上限增长点 | ① `seahi-serial-debug.log` 文件；② 单个 `session-*.log` 文件（只限文件数，不限大小）；③ 前端紧凑缓冲最多 **100 万行**（内存） |
| 有上限的通道 | 串口后端缓冲 256 KB、工作流事件 200、BLE 通知 2000、BLE 从机事件 400、ADB PTY 通道 ~4 MB、前端 DOM 1 万/软限 1.5 万行、BLE 前端日志 400 条 |
| 已实现但**前端零调用** | `list_log_cache`（`main.rs:3233`，已注册 `main.rs:6899`）；`testErrorReport()`（`index.html:10600`，无 onclick 绑定） |
| CI 未启用 sentry | `.github/workflows/build.yml` 中无 `sentry`/`features` 字样，CI 构建不带该 feature |

---

## 1. 通道清单（总表）

| # | 名称 | 产生位置（前端 / 后端，函数+行号） | 前端显示容器 / 渲染函数 | 上限 | 清空 / 复制 / 导出 | 磁盘持久化 |
|---|---|---|---|---|---|---|
| 1 | **串口接收数据** | 后端读线程 `PortReader::new` 闭包 `main.rs:392-428`（缓冲 `main.rs:403-416`）→ 前端轮询 `startReading` `index.html:3727` / `read_data` 调用 `index.html:3731` → `appendRecvText` `index.html:4396` / `appendOutput` `index.html:4242` | `#<mid>-output`（`.output`，`index.html:2589`）；每行 `.ol.recv` + `.ln` + `.lc` | 后端 262144 B（超限 drain 到 131072，`main.rs:408-415`）；前端 DOM 10000 行 / 软限 15000（`index.html:4305-4306`）；紧凑缓冲 100 万行（`index.html:4582`） | 清空 `clearLog` `index.html:4475`；复制 `copyOutput` `4185` / `fallbackCopy` `4197`；导出 `chooseLogDir` `4166` + `saveLogToFile` `4177` | ✅ 隐形缓存 `append_log_cache` `main.rs:3174`（`bufferPush` 触发 `index.html:4587-4591`）；✅ workflow `save_log` 动作 |
| 2 | **串口发送/回显** | 前端 `sendData` `index.html:4108`（回显 `4123`，失败 `4136`）；后端 `send_data` `main.rs:1289` | 同上，`.ol.send`（气泡样式） | 同 #1 | 同 #1 | ✅ 同 #1（`type==='send'` 也入缓存） |
| 3 | **WSL 串口收发** | 后端 `read_wsl_serial` `main.rs:2368`（bridge `read` 命令，`main.rs:2375`）/ `send_wsl_serial` `main.rs:2391`；前端 `startWslReading` `index.html:6377`（`read_wsl_serial` `6385`）→ `appendRecvText` `6402` | `#wsl-xN-output`（WSL 页内嵌监视器，`index.html:6165` 初始化）；渲染同 #1 | 后端：bridge 单次 `max:4096`，无累积缓冲（`main.rs:2375`）；前端同 #1 | 同 #1（WSL 工具栏 `index.html:5903` 清空 / `5943-5944` 选目录+保存） | ✅ `logCacheStart` `index.html:6295` |
| 4 | **ADB 命令输出（PTY）** | 后端 `adb_open_shell` `main.rs:3898` 读线程 `main.rs:3925-3948`（`ADB_PTY_QUEUE_MAX=512`，`main.rs:3929`）→ 前端轮询 `adbPtyPoll` `index.html:9672`（`adb_shell_read` `9676`） | `#adb-session-N-termBox` 内 **xterm.js** 实例（`index.html:9613-9620`）；无自研渲染函数 | 后端 crossbeam 通道 512 块 × 8 KB ≈ **4 MB**（超限丢块 + `eprintln!` `main.rs:3939`）；xterm `scrollback: 1000`（`index.html:9618`） | 无复制/导出按钮；关闭会话 `closeAdbSession` `index.html:9684`（销毁终端） | ❌ 不落盘 |
| 5 | **BLE 主机通知（数据日志）** | 后端 `ble_notify_loop` `main.rs:6249`（`NOTIFY_BUF_MAX=2000`，`main.rs:6259`）→ 前端 `startBleNotifyPoll` `index.html:7190`（`ble_poll_notifications` `7196`，250 ms）→ `logBle` `7103` / `logBleDim` `7110` | `#ble-log`（`index.html:8350`）；渲染 `renderBleLog` `index.html:7127`（HTML 由纯函数 `bleLogToHtml` `7118` 生成） | 后端 2000 条（`main.rs:6259`）；前端 `_bleLogMax = 400`（`index.html:6783`，`_bleLog` 定义 `6782`） | 仅清空 `clearBleLog` `index.html:7134`；**无复制/导出** | ❌ 不落盘 |
| 6 | **BLE 从机事件日志** | 后端 `ble_periph_emit` `main.rs:4421`（`BLE_PERIPH_EVENT_MAX=400`，`main.rs:4417`）→ 前端 `pollBlePeriphEvents` `index.html:9261`（500 ms 定时器 `9252`）→ `pushBlePeriphLog` `9287` | `#blePfLog`（`index.html:7679`）；渲染 `renderBlePeriphLog` `index.html:9293`；文案 `blePeriphFmtEvent` `8762` | 后端 400 条；前端 `_blePeriphLogMax = 400`（`index.html:8685`，`_blePeriphLog` 定义 `8684`） | 仅清空 `clearBlePeriphLog` `index.html:9306`；**无复制/导出** | ❌ 不落盘 |
| 7 | **工作流 `[Auto]` 事件** | 后端 `execute_workflow_actions_bg` `main.rs:853-860`（`WF_EVENTS_MAX=200`，`main.rs:856`）→ 前端 `read_workflow_events` `index.html:3762` → `appendOutput(...,'send', ...)` `index.html:3764` | `#<mid>-output`，`.ol.send` | 后端 200 条（`main.rs:856`） | 同 #1 | ✅ 动作 `save_log` 直接写 `<logDir>\workflow_log.txt`（后台版 `main.rs:839-847`，同步版 `911-921`） |
| 8 | **监视器状态/错误行（sys/err）** | 前端 45 处 `appendOutput` 调用，如缓冲丢弃提示 `index.html:3735`、自动重连 `3786`、重连失败 `3805`、日志目录 `4172`、保存/复制结果 `4191/4205` | 同 #1，`.ol.sys`（灰）/ `.ol.err`（橙） | 同 #1 | 同 #1 | 仅 `recv`/`send` 入缓存，**sys/err 不落盘**（`index.html:4587` 条件） |
| 9 | **Toast 状态提示** | 前端 `showToast` `index.html:2471`；**67 处调用** | `body > .toast.toast-{info\|error\|success}`（CSS `index.html:1802-1813`） | 无上限，自动 3 s（info/success）/ 5 s（error）后 `remove()`（`index.html:2483-2487`） | 仅点击关闭（error 型，`2480`） | ❌ 不落盘 |
| 10 | **启动兜底页（致命错误）** | 前端 `showFatalError` `index.html:2327` | `#bootError` / `#bootErrorTitle` / `#bootErrorDetail`（`index.html:2108-2113`） | 单例覆盖显示 | 无 | ❌ 但同时 invoke `report_js_error`（`index.html:2336`）→ 落 `dbg_log` |
| 11 | **后端调试日志** | 后端 `dbg_log` `main.rs:16-26`；**58 处调用点** | 无 UI | **无上限**（纯 append） | 无（用户需手动删 `%TEMP%` 文件） | ✅ `%TEMP%\seahi-serial-debug.log`（`main.rs:24`） |
| 12 | **错误上报（Sentry / 自建服务）** | 后端 `report_error` `main.rs:107`；前端 `reportError` `index.html:2318`、`window 'error'` `2290`、`unhandledrejection` `2308` → `report_js_error` `main.rs:3874` | 无专属 UI（仅间接：`#bootError`、Toast、`.ol.err`） | 上报线程 mpsc 无界通道（`main.rs:39`）；HTTP 超时 5 s（`main.rs:42`） | 无 | 本地落 `dbg_log`（`main.rs:109`）；远端落 SQLite / D1 |
| 13 | **隐形日志缓存文件** | 后端 `start_log_cache` `main.rs:3162` / `append_log_cache` `main.rs:3174` / `end_log_cache` `main.rs:3217` | 无 UI（`list_log_cache` `main.rs:3233` 已实现但前端零调用） | **10 个文件**（`LOG_CACHE_MAX_COUNT` `main.rs:3069`），单文件**无上限** | 无清空/复制入口；FIFO 自动删旧（`enforce_log_cache_limit` `main.rs:3136`） | ✅ `%APPDATA%\seahi-serial\log-cache\session-*.log` |

---

## 2. 逐通道详情

### 2.1 串口接收（面板 main / extra-N）

**数据产生（后端）**

- `PortReader::new`（`main.rs:361-457`）创建 3 条线程：
  - 读取线程 `main.rs:392-428`：`p.read(&mut tmp)`，`tmp = [0u8; 4096]`（`main.rs:393`）；无数据时 `sleep(2ms)`（`main.rs:421`）。
  - 工作流线程 `main.rs:443-450`；动作线程 `main.rs:433-437`。
- 缓冲：`buffer: Arc<Mutex<Vec<u8>>>`（`main.rs:362`，初始容量 8192）。
  - **上限保护**：`if buf.len() > 262144 { let drain = buf.len() - 131072; buf.drain(..drain); }`（`main.rs:408-415`），并 `dropped.fetch_add`，首次超限写 `dbg_log`（`main.rs:413`）。
- `read_all()`（`main.rs:525-529`）`mem::take` 一次性取空；`take_dropped()`（`main.rs:532-534`）取走并清零丢弃计数。

**数据结构**

| 层 | 结构 |
|---|---|
| 后端命令返回 | `ReadDataResult { bytes: Vec<u8>, dropped: u64 }`（`main.rs:1229-1233`），命令 `read_data` `main.rs:1236` |
| 前端紧凑缓冲 | `{ type: 'recv'\|'send'\|'sys'\|'err', ts: string, text: string }`，由 `bufferPush`（`index.html:4546`）编码进 `_textData`(Uint8Array) + `_textOffsets`(Uint32Array) + `_textTypes`(Uint8Array) + `_textTsLens`(Uint16Array)；解码见 `bufferGetLine` `index.html:4650` |
| DOM 行 | `div.ol.<type>[.hex-view][.empty-line]` > `span.ln`（行号，`contenteditable=false`）+ `span.lc`（内容） |

**渲染函数**

- `appendOutput(mid, type, text, opts)` `index.html:4242-4324`（opts: `{hex, fragment, open}`）
- `appendRecvText(mid, decoded, frag)` `index.html:4396-4453` — 跨轮询分块合并未结束行，`\r\n`/`\r` 归一化为 `\n`
- `openRecvRow` `4368`、`updateOpenRowText` `4374`、`closeRecvPartial` `4359`、`decodeRecv` `4456`（流式 `TextDecoder`）、`resetRecvStream` `4464`
- 批量插入 `flushBatch` `index.html:4326-4353`
- 历史回填 `loadMoreHistory` `index.html:4685-4740`（每次 1000 行）、`cleanupExtraLines` `4743`
- 行号 `updateLineNumbers` `index.html:3114`

**轮询与频率**

- `MON_READ_MS_VISIBLE = 25`（40 Hz）、`MON_READ_MS_HIDDEN = 500`（2 Hz）（`index.html:3692-3693`）
- `monitorHostId` `3696` / `monitorVisible` `3702` / `monitorPollMs` `3709` / `refreshMonitorPollRates` `3713`
- `invokeTimeout('read_data', ..., 3000)` `index.html:3731`

**缓冲区**

| 层 | 上限 | 行为 |
|---|---|---|
| 后端字节缓冲 | 262144 B | 超限丢最旧到 131072 B，记 `dropped` |
| 后端工作流事件 | 200 | `while evts.len() >= 200 { remove(0) }`（`main.rs:856-859`） |
| 后端 tail（正则跨块匹配） | 2048 B | `TAIL_CAP`（`main.rs:488-492`） |
| 前端 DOM | 软限 15000 / 硬保留 10000 | 顶部或选中时跳过清理（`index.html:4305-4319`） |
| 前端紧凑缓冲 | 100 万行 → 砍 50 万行 | `bufferTrimOld`（`index.html:4582-4584`、`4595-4611`） |
| 初始分配 | `_textData` 1 MB、`_textOffsets`/`_textTypes`/`_textTsLens` 各 10 万（`index.html:2627-2632`） | 按需翻倍 |

**时间戳**

- 格式 `[HH:MM:SS.mmm] `（`now.toTimeString().slice(0,8)` + 3 位毫秒，`index.html:4248`），本地时区，**毫秒精度**
- 由工具栏按钮 `#<mid>-btnTs` 控制（`index.html:2543`、读取 `4245-4246`）；**关闭时 `ts = ''`**，此时写盘文件也没有时间戳

**HEX**

- HEX 显示模式由 `#<mid>-viewMode` 下拉（`index.html:2504-2510`）控制
- 整块 `bytesToHex`（`4781`）后按 **192 字符**切行，首行 `HEX: `、续行 5 空格（`index.html:3744-3750`），加 `.hex-view` 类（`4251`）→ 灰色（CSS `index.html:1588`）
- 发送侧 HEX：`sendData` `index.html:4113-4123`

**着色**

| 类 | 颜色 | 行号 |
|---|---|---|
| `.ol.recv` | `var(--text)` | CSS `1587` |
| `.ol.recv.hex-view .lc` | `var(--text-d)`（灰） | CSS `1588` |
| `.ol.send` | 气泡：`var(--send-bubble-bg)` / `--send-bubble-text` | CSS `1589-1591` |
| `.ol.err` | `var(--accent-orange)` | CSS `1592` |
| `.ol.sys` | `var(--text-soft)` | CSS `1593` |
| ANSI | `parseAnsi` 渲染设备输出里的 ANSI 颜色（`index.html:4275`、`4714`） | — |

**清空 / 复制 / 导出**

| 能力 | 函数 | 行号 | 备注 |
|---|---|---|---|
| 清空 | `clearLog(mid)` | `4475-4494` | 同时清 DOM 与紧凑缓冲 |
| 复制 | `copyOutput(mid)` | `4185-4196` | 优先 `navigator.clipboard` |
| 复制（降级） | `fallbackCopy(mid, text)` | `4197-4208` | `textarea + execCommand` |
| 取全文 | `getOutputText(mid)` | `4209-4222` | 优先紧凑缓冲（`bufferGetAllText` `4674`，会剥离 ANSI）；无则读 DOM |
| 选目录 | `chooseLogDir(mid)` | `4166-4176` | → `choose_log_directory` `main.rs:1497` |
| 保存 | `saveLogToFile(mid)` | `4177-4184` | → `save_log` `main.rs:3005` |
| 隐形缓存 | `logCacheStart/Flush/End` | `4519/4509/4529` | 300 ms 节流（`_logCacheFlushMs` `4500`） |

**持久化**

1. **隐形缓存**（自动）：`bufferPush` 内 `if (m.isConnected && (type==='recv' || type==='send'))` 累积 `_logCachePending += ts + text + '\n'`（`index.html:4587-4591`）→ 300 ms 后 `append_log_cache`。
   - 文件：`%APPDATA%\seahi-serial\log-cache\session-<YYYYMMDD-HHMMSSmmm>-<port>.log`（`log_cache_dir` `main.rs:3087-3093`、`dirs_config_path` `main.rs:2990-3002`、命名 `main.rs:3191-3197`）
   - 上限 **10 个文件**，FIFO 删最旧（`enforce_log_cache_limit` `main.rs:3136-3158`）
   - 空文件在 `end_log_cache` 时删除（`main.rs:3219-3227`）
   - 时间戳：文件名用 `GetLocalTime` 到毫秒（`log_cache_time_stamp` `main.rs:3096-3115`）
2. **手动导出**：`save_log`（`main.rs:3005-3057`）→ `<选定目录>\Serial Debug YYYY-MM-DD HHMMSS.txt`（`main.rs:3041`）。**安全约束**：`path` 必须等于最近一次 `choose_log_directory` 的目录（`LAST_LOG_DIR` `main.rs:36`、校验 `3014-3031`）。
3. **工作流触发**：`save_log` 动作写 `<logDir>\workflow_log.txt`（追加），无大小上限（`main.rs:839-847`、`911-921`）。

---

### 2.2 WSL 串口

- 后端：`read_wsl_serial` `main.rs:2368-2387`（`bridge_command` 发 `{"cmd":"read","max":4096}`，base64 解码）；`send_wsl_serial` `2391-2409`；`close_wsl_serial` `2351`；`open_wsl_serial`（`2340` 附近错误上报）。
- WSL bridge 本体（`wsl_shell_exec`，`main.rs:279-336`）用 `___SEAHI_START___` / `___SEAHI_END___` 标记切分输出，**只在超时时写一条 `dbg_log`**（`main.rs:332`），不流式透出到 UI。
- 前端：`startWslReading` `index.html:6377-6433`，渲染完全复用 #1 的 `appendOutput` / `appendRecvText` / `flushBatch`（`6398`/`6402`/`6404`）。
- 容器：`#wsl-xN-output`；WSL 页监视器初始化 `initWslMonitor` `index.html:6165-6175`（独立 `monitors` 条目，`isWsl: true`，同样的 1 MB / 10 万行初始分配 `6172-6174`）。
- 工具栏：`index.html:5885-5944`（清空 `5903`、时间戳 `5908`、选日志目录 `5943`、保存 `5944`）。
- 缓存：`logCacheStart(mid, devicePath)` `index.html:6295`；断开 `6316`。
- 事件：后端 `app.emit("wsl-status-changed", running)`（`main.rs:1878`）→ 前端 `index.html:6136` 监听；`dbg_log` 记录状态变化（`main.rs:1877`）。

---

### 2.3 ADB

- 后端会话：`adb_open_shell` `main.rs:3898-3964`
  - PTY 尺寸 40×120（`main.rs:3914`），`TERM=xterm-256color`（`3911`）
  - 读线程 → `crossbeam_channel::unbounded::<Vec<u8>>()`（`main.rs:3924`），**用 `tx.len()` 手工限流**：
    - `ADB_PTY_QUEUE_MAX = 512`（`main.rs:3929`），读块 `[0u8; 8192]`（`3930`）
    - 超限时 `dropped += 1; continue`（`3936-3942`），并 `eprintln!` 每 1 条 / 每 200 条提示一次（`3938-3940`）
    - ⇒ 实际内存上限约 **512 × 8 KB ≈ 4 MB**（有界）
- 取数据：`adb_shell_read` `main.rs:3988-4002`（`try_recv` 循环 drain 到单个 `Vec<u8>`）
- 写入 / 关闭 / 改尺寸：`adb_shell_write` `3968`、`adb_shell_close` `4006`、`adb_shell_resize` `4028`（内含 `println!("[ADB-PTY] resized -> {}x{}")` `4046`）
- 前端：
  - `openAdb` `index.html:9357`、`closeAdb` `9421`、`refreshAdbDevices` `9469`（5 s 轮询 `9410`）
  - `openAdbSession` `9580-9653`：`new Terminal({ ..., scrollback: 1000 })`（`9613-9619`），`term.open(#sid-termBox)`（`9620`）
  - `syncAdbTermSize` `9528-9569`（尺寸同步，`ResizeObserver` `9627`）
  - `setAdbPollRate` `9656-9660`（可见 120 ms `9407` / 隐藏 2000 ms `9427`）
  - `adbPtyPoll` `9672-9682`：`term.write(new Uint8Array(bytes))`（`9678`）
  - `closeAdbSession` `9684-9696`（`term.dispose()`）
- **无自研日志缓冲**：显示完全交给 xterm.js 的 `scrollback: 1000`；不落盘、无导出。
- 控制台输出：`console.log` 见 `9358`、`9422`、`9470`、`9563`、`9581`、`9642`；`console.error` `9650`。

---

### 2.4 BLE 主机（主机模式）

- 后端：
  - `ble_notify_loop` `main.rs:6249-6276`：`peripheral.notifications()` 流；每条构造 `{ "uuid", "service_uuid", "value_hex" }`（`6262-6266`）
  - `NOTIFY_BUF_MAX = 2000`（`main.rs:6259`），超限 `pop_front` + `dropped.fetch_add(1)`（`6268-6271`）
  - `ble_poll_notifications` `main.rs:6833-6841` → `{ "items": [...], "dropped": n }`
  - 状态 `BleState.notify_buf` / `notify_dropped`（`main.rs:6075-6077`），在连接 / 断开 / 复位处 `clear()` + `dropped.store(0)`（`6523/6524`、`6605`、`6639`、`6728`）
- 前端：
  - `startBleNotifyPoll` `index.html:7190-7219`，**250 ms** 轮询（`7195`、`7218`）
  - 每条渲染：`from = bleSvcLabel(service_uuid) + ' · 0x' + shortUuid(uuid)`（`7204`），文本可读 → `logBleDim`（`7208`），否则 `logBle`（`7210`）
  - 溢出提示 `'[通知] ⚠ 缓冲溢出丢弃了 N 条'`（`7215`）
  - 缓冲 `_bleLog`（`6782`）+ `_bleLogMax = 400`（`6783`），`splice(0, len - 400)`（`7105`、`7112`）
  - 渲染 `renderBleLog` `7127-7133` → `#ble-log`（`index.html:8350`）；`bleLogToHtml` `7118-7126` 全量 `escapeHtml`（防设备侧注入）
  - `ble-log-dim` 灰显（CSS `index.html:1188`）
  - **无时间戳字段**（`_bleLog` 条目只有 `{text, dim}`）
  - HEX：`bleBytesToHex` `7138`（空格分隔大写）、`bleFmtBytes` `7157`（能当 UTF-8 文本就读文本，否则 HEX）、`bleFmtHex` `7165`、`bleCanShowAsText` `7143`
  - 清空 `clearBleLog` `7134`；**无复制/导出/落盘**
  - 连接切换/断开时清空（见 `7100` 注释与 `renderBleDeviceList` / `toggleBleConnect`）
- 配对事件：`app.emit("ble-pair-request", {address, kind, pin})`（`main.rs:6380`）→ 前端 `index.html:10314` → `showBlePairDialog` `7326`；配对过程 `dbg_log`（`main.rs:6417-6463`）。

---

### 2.5 BLE 从机（外设模式）

- 后端事件：
  - `ble_periph_emit(events, item)` `main.rs:4421-4433`：自动补 `"ts" = chrono::Utc::now().timestamp_millis()`（`4426`）
  - 队列 `BLE_PERIPH_EVENT_MAX = 400`（`main.rs:4417`），`while q.len() >= 400 { pop_front() }`（`4429-4431`）——**静默丢弃，无 dropped 计数**
  - `ble_periph_poll_events` `main.rs:5401-5406`（`drain(..)` 全量取走）
  - 事件载荷：`{ ts, kind, uuid, value_hex, len, peer, note }`（`ble_periph_data_event` `main.rs:4436-4445`），另有 `status` / `subscribed` / `max_notify` / `pending_id`
- 前端：
  - `pollBlePeriphEvents` `index.html:9261-9285`，**500 ms**（`9252`）；失败静默（`catch(function() {})` `9284`）
  - 文案 `blePeriphFmtEvent` `8762-8794`（`start`/`stop`/`adv`/`write`/`write_reply`/`notice`/`read`/`subscribe`/`notify`）
  - 时间戳 `blePeriphTime` `8796-8802` → `HH:MM:SS.mmm`（本地时区），拼在行首（`9270`）
  - 本地事件也进同一缓冲：启动 `9109`、启动失败 `9131`、特征写入 `9337`、写入失败 `9349`
  - 缓冲 `_blePeriphLog`（`8684`）+ `_blePeriphLogMax = 400`（`8685`）
  - 渲染 `renderBlePeriphLog` `9293-9304` → `#blePfLog`（`index.html:7679`）
  - 清空 `clearBlePeriphLog` `9306`；**无复制/导出/落盘**

---

### 2.6 程序运行日志与状态提示

| 子通道 | 位置 | 特征 |
|---|---|---|
| 监视器 sys/err 行 | `appendOutput` 45 处调用 | 进 DOM 与紧凑缓冲；**不入 log-cache** |
| Toast | `showToast` `index.html:2471-2488`，67 处调用 | 无上限、自动消失、不落盘 |
| 启动兜底页 | `showFatalError` `index.html:2327`；`#bootError` `2108` | 单例；同时上报 |
| `console.*` | `console.log` 19 处、`console.warn` 35 处、`console.error` 15 处（共 69 处） | **只进 WebView 开发者控制台**，Release 用户看不到、不落盘 |
| 后端 `println!` | 生产代码 6 处：`main.rs:3905/3915/3920/3934/3945/4046`（全部 `[ADB-PTY]`） | Release 下 `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`（`main.rs:2`）→ **无控制台，输出丢弃** |
| 后端 `eprintln!` | 生产代码 7 处：`main.rs:815/820/836/892/904/905`（`[Workflow]`）、`3939`（`[ADB-PTY]` 丢块） | 同上，Release 丢弃 |
| 后端 `println!`（测试） | `main.rs:5785-6016` 等 21 处 | 均在 `#[cfg(test)]` 模块内（`5447`、`5589`/`5604`... 及 `#[ignore]` 诊断测试 `5778/5878/5990`），不进生产二进制 |
| Tauri 事件 | `device-changed`（`main.rs:170`）、`wsl-status-changed`（`1878`）、`save-before-exit`（`3808`、`6987`）、`ble-pair-request`（`6380`） | 前端监听：`10320`、`6136`、`10353`、`10314` |

---

## 3. 后端调试日志 `%TEMP%\seahi-serial-debug.log`

### 3.1 谁写、写什么

```rust
// main.rs:16-26
fn dbg_log(msg: &str) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let line = format!("[{}ms] {}\n", now, msg);
    let _ = std::fs::OpenOptions::new()
        .create(true).append(true)
        .open(std::env::temp_dir().join("seahi-serial-debug.log"))
        .and_then(|mut f| f.write_all(line.as_bytes()));
}
```

| 项目 | 结论 |
|---|---|
| 路径 | `std::env::temp_dir().join("seahi-serial-debug.log")`（`main.rs:24`）＝ `%TEMP%\seahi-serial-debug.log` |
| 格式 | `[<unix 毫秒时间戳>ms] <msg>\n`，**仅两段**：时间戳 + 自由文本 |
| 时间戳 | UNIX epoch 毫秒（`as_millis`），UTC 基准、数字形式；无本地时间 / 日期 |
| 写入方式 | `OpenOptions::create(true).append(true)`，每次调用**开→写→关**（无长驻句柄），错误静默 `let _ =` |
| 级别 | **无** |
| 开关 | **无**（无环境变量、无 feature、无运行时配置） |
| 调用栈 | **无**（panic 时由 `set_panic_hook` 手工拼 `file:line:col`，见 #4） |
| 大小上限 / 轮转 | **无** —— 无限追加 |
| 调用点 | **58 处**（含函数定义本身）；覆盖设备插拔、WSL 状态、usbipd 提权、更新校验、标题栏颜色、BLE 配对/连接/RSSI、关窗清理、接收缓冲超限、`list_ports` 计时等 |
| 间接来源 | `report_error` 每条错误都写一行（`main.rs:109`）；`report_to_self_hosted` 在 Debug 且未配 `ERROR_SERVER_URL` 时写 `[SKIP]`（`main.rs:95`） |

**代表性调用点**

| 行号 | 内容 |
|---|---|
| `main.rs:95` | `[SKIP] Debug 模式未设置 ERROR_SERVER_URL，跳过上报` |
| `main.rs:109` | `[ERROR] <context>: <error>` |
| `main.rs:168` | `device_callback: action=…` |
| `main.rs:188/202/204/210` | `CM_NOTIFY_FILTER size=` / 注册成功 / 失败 / `device_watcher: stopped` |
| `main.rs:332` | `wsl_shell_exec: timeout after …ms` |
| `main.rs:413` | `serial reader: 接收缓冲超限，开始丢弃最旧数据（本次 N 字节）` |
| `main.rs:1083` | `list_ports: N ports, <elapsed>` |
| `main.rs:1600` | `usbipd list 失败/超时，尝试提权执行` |
| `main.rs:1877/1881` | `wsl_watcher: status changed, …` / `stopped` |
| `main.rs:1907-1968` | `launch_wsl: dist=…` / 路径转换 / `spawned pid=…` |
| `main.rs:2455/2464` | `get_wsl_serial_devices: …` |
| `main.rs:2644-2808` | usbipd bind / attach / 提权 / 结果文件读取（10 条） |
| `main.rs:2856/2895/2929` | usbipd detach 失败/非法 busid/提权结果 |
| `main.rs:3739/3751` | `download_update: SHA-256 / 大小校验通过` |
| `main.rs:4190/4221/4225` | `set_title_bar_color: r=… g=… b=…` / `DWMWA_CAPTION_COLOR hr=…` / 不支持 |
| `main.rs:6417-6748` | BLE 配对、连接复用、补扫描、RSSI、链路断开清理（约 10 条） |
| `main.rs:6985-7040` | `CloseRequested: cleaning up resources` / BLE disconnect / 停止广播 / `cleanup done` |

### 3.2 `log` / `tracing` / `env_logger`

- `src-tauri/Cargo.toml` **直接依赖里没有** `log`、`tracing`、`env_logger`、`fern`、`simplelog`（`Cargo.toml:19-55`）。
- `Cargo.lock` 中 `log`（行 2378）、`tracing`（行 5003）、`sentry`（行 3746）均为**传递依赖**。
- `main.rs` 全文**没有任何 `log::` / `tracing::` 宏调用**（grep 命中 0），也没有任何 logger 初始化/subscriber。
- ⇒ 传递依赖里各库自己打的 `log`/`tracing` 记录**全部被丢弃**，不会进 `seahi-serial-debug.log`，也不会出现在任何 UI。
- 结论：**项目没有使用结构化日志框架，只有 `dbg_log` + `println!/eprintln!` 两套裸机制。**

---

## 4. 错误与 panic 上报

### 4.1 后端

| 环节 | 函数 | 行号 | 说明 |
|---|---|---|---|
| 统一入口 | `report_error(error, context)` | `main.rs:107-121` | ① 总是 `dbg_log("[ERROR] ctx: err")`；② 有 `SENTRY_DSN` 且启用 feature → Sentry；③ 总是走自建服务分支 |
| Sentry 上报 | `report_error_to_sentry` | `main.rs:74-87` | `#[cfg(feature = "sentry")]`；`scope.set_tag("component","seahi-serial")`、`set_extra(context/app_version/os)`，`capture_message(.., Level::Error)` |
| 自建服务上报 | `report_to_self_hosted` | `main.rs:90-104` | Debug 且无 `ERROR_SERVER_URL` → 打 `[SKIP]` 并 return；否则把 `(error, context)` 投进全局 mpsc |
| 上报线程 | `init_error_reporter` | `main.rs:38-71` | 单线程常驻消费 `ERROR_SENDER`（`std::sync::mpsc::channel`，无界）；`reqwest::blocking` 超时 5 s；POST `{server_url}/report`，可选 `X-API-Key` |
| Payload | — | `main.rs:55-61` | `{ app_version: env!("CARGO_PKG_VERSION"), os, error, context, timestamp: chrono::Utc::now().to_rfc3339() }` |
| panic hook | `set_panic_hook` | `main.rs:124-148` | `take_hook` 后包装：取线程名、payload（`&str`/`String`/`Box<dyn Any>`）、`info.location()` → `"Panic in thread '{t}': {payload} at {file}:{line}:{col}"` → `report_error(msg, "panic_handler")` → 再调原始 hook（stderr） |
| 前端错误入口 | `report_js_error` | `main.rs:3874-3876` | `report_error(&error, &context)` |
| 自测入口 | `test_error_report` | `main.rs:3863-3870` | 上报固定测试错误 |
| 启动装配 | `main` | `main.rs:6026-6031` | `init_error_reporter()` → `set_panic_hook()` |
| Sentry 初始化 | `main` | `main.rs:6034-6051` | `#[cfg(feature="sentry")]` **且 `cfg!(not(debug_assertions))`**，即仅 Release；DSN 取自 `SENTRY_DSN`，空则 `None`；`release = sentry::release_name!()`，`environment = "production"` |
| 关闭路径 | — | `main.rs:6985-7040` | `CloseRequested` 清理并 `dbg_log` |

**触发点举例（`report_error` 调用）**：`read_data` 设备断开（`main.rs:1242`）、`send_data` 未连接/发送失败（`1295`/`1303`）、`open_wsl_serial` 失败（`2340`）等。

### 4.2 前端

| 环节 | 函数 | 行号 |
|---|---|---|
| `window 'error'` 监听 | 匿名回调 → `report_js_error` | `index.html:2290-2307`（含堆栈 + `filename:line:col` + 已连接监视器快照 `2297-2303`） |
| `unhandledrejection` 监听 | 匿名回调 → `report_js_error` | `index.html:2308-2315`（`context: 'promise'`） |
| 统一入口 | `reportError(errMsg, ctx)` | `index.html:2318-2324`（**18 处调用**） |
| 启动兜底 | `showFatalError` | `index.html:2327-2341`（`context: 'fatal-boot'`） |
| 桥接安全 | `_safeInvoke` / `invoke` | `index.html:2279-2287` |
| 自测 | `testErrorReport()` | `index.html:10600-10607`（**无 UI 绑定 onclick，死入口**） |

### 4.3 收集服务

| 服务 | 文件 | 端点 | 存储 |
|---|---|---|---|
| 自建（Node） | `server/error-server.js` | `POST /report`（`error-server.js:663-664`）；`GET /` 列表页 | SQLite：`errors`（`error_hash` UNIQUE，`28-53`）、`error_details`（`41`）；去重 `ON CONFLICT(error_hash) DO UPDATE SET count = count + 1, last_seen = CURRENT_TIMESTAMP`（`170-172`）；`handleReport` 定义 `154`；监听 `682` |
| Cloudflare Workers | `cloudflare-worker/worker.js` + `schema.sql` | `POST /report`（`worker.js:40`）、`GET /api/errors`（`51`）、`/api/errors/:id`（`53`）、`/api/filters`（`56`）、`/api/stats`（`58`）、`GET /`（`60`） | D1：`INSERT INTO errors`（`91`）、`error_details`（`103`） |
| Sentry → GitHub | `server/sentry-webhook.js` | — | Webhook 建 Issue |

- 环境变量：`ERROR_SERVER_URL`、`ERROR_API_KEY`、`SENTRY_DSN`、`GITHUB_TOKEN`、`GITHUB_REPO`（`.env.example:4-22`）。
- **上报在 UI 上没有任何专属展示**：用户能看到的只是同一条错误被写进 `dbg_log`、可能进 `#bootError`、或已由 `appendOutput(...,'err')` 显示在监视器里。
- **CI 未启用 `sentry` feature**（`.github/workflows/build.yml` 无 `features`/`sentry` 匹配，构建参数只有 `--bundles msi`，`build.yml:93`）⇒ 官方发布的安装包走的是**自建服务**分支，Sentry 需要自行 `--features sentry` 构建。

---

## 5. 日志量级估计与内存风险

### 5.1 轮询频率总表（前端）

| 定时器 | 周期 | 位置 |
|---|---|---|
| 串口/WSL 读轮询（可见） | 25 ms（40 Hz） | `index.html:3692`、`3727`、`6381` |
| 串口/WSL 读轮询（隐藏） | 500 ms（2 Hz） | `index.html:3693` |
| ADB PTY 轮询（可见） | 120 ms（≈8.3 Hz） | `index.html:9407`、`9659` |
| ADB PTY 轮询（隐藏） | 2000 ms | `index.html:9427` |
| BLE 通知轮询 | 250 ms（4 Hz） | `index.html:7195` |
| BLE 从机事件轮询 | 500 ms（2 Hz） | `index.html:9252` |
| BLE 从机状态轮询 | 2000 ms | `index.html:9253` |
| BLE RSSI | `BLE_RSSI_INTERVAL` | `index.html:7481` |
| BLE 设备扫描刷新 | 2000 ms | `index.html:8124` |
| ADB 设备列表 | 5000 ms | `index.html:9410` |
| WSL 设备列表 | 5000 ms | `index.html:6015` |
| WSL 自动映射检查 | 15000 ms | `index.html:10131` |
| 端口刷新（未连接） | 10000 ms | `index.html:10301` |
| 更新检查 | 600000 ms | `index.html:10309` |
| 标题栏动画 | — | `index.html:5686` |
| WSL uptime | — | `index.html:9760` |

### 5.2 高频流与理论上限

| 流 | 理论频率上限 | 瓶颈 / 掉落行为 |
|---|---|---|
| **串口接收** | 读线程无 sleep，每次最多 4096 B，能到 MB/s 级；`921600 8N1` ≈ **92 KB/s** | 后端 256 KB 缓冲 ⇒ 约 **2.8 s** 灌满（`main.rs:408`）；隐藏面板 500 ms 轮询时若 >512 KB/s 会丢（`dropped` 提示 `index.html:3735`） |
| **WSL 串口接收** | 单次 `max:4096`，前端 25 ms 轮询 ⇒ ≈ **164 KB/s** 可消化 | bridge 无累积缓冲；HTTP/IPC 往返是瓶颈 |
| **ADB PTY**（`logcat`/`top`） | 读线程 8 KB/次 无节流，可到数十 MB/s | 通道 512 块 → 前端 120 ms 必须取走 ~4 MB；否则丢块（`main.rs:3936-3942`），**只打 stderr（Release 不可见）** |
| **BLE 通知** | 后端上限 2000 条 / 前端 250 ms ⇒ 消化 **8000 条/s**；100 Hz 从机 ≈ 100 条/s，余量充足 | 超 8000 条/s 丢最旧 + `dropped` 提示（`main.rs:6268`、`index.html:7215`） |
| **BLE 从机事件** | 400 条 / 500 ms ⇒ 消化 **800 事件/s** | 超限**静默**丢最旧（`main.rs:4429-4431`），**无 dropped 计数**（缺陷） |
| **工作流 `[Auto]`** | 200 条 / 轮询一次 | 超限丢最旧（`main.rs:858`），无提示 |
| **`dbg_log`** | 每次串口缓冲超限只记首次（`prev == 0` 判断，`main.rs:412`）；其余为低频事件 | **无上限** |

### 5.3 会无限增长的点（重点）

| 优先级 | 位置 | 增长对象 | 现状 | 风险 |
|---|---|---|---|---|
| 🔴 高 | `dbg_log` `main.rs:16-26` | `%TEMP%\seahi-serial-debug.log` | **无大小上限、无轮转、无开关**；每次调用 `open/append/close` | 长期使用 / 反复插拔 USB 串口，文件可持续增长到 GB 级；`%TEMP%` 不会自动清理（Windows 磁盘清理才管） |
| 🔴 高 | `append_log_cache` `main.rs:3174-3213` | 单个 `session-*.log` | 只限**文件数 10**（`main.rs:3069`），**不限单文件大小**；300 ms flush，`f.flush()` 每次都刷（`3210`） | 一个长时间高速会话（如 92 KB/s × 1 h ≈ 330 MB）就能把磁盘吃满；10 个文件最坏可到 GB 级 |
| 🟠 中 | 前端紧凑缓冲 `bufferPush` `index.html:4546-4592` | `_textData` (Uint8Array) + 3 个索引数组 | 100 万行才裁剪到 50 万（`4582-4584`）；数据缓冲按需翻倍 | 纯文本每行 ~40 B ⇒ ~40 MB；**HEX 视图每行 200 B（192 字符切块）⇒ ~200 MB**，接近 Electron/WebView2 内存上限 |
| 🟡 低-有界 | 后端串口缓冲 | `Vec<u8>` ≤ 256 KB | 有界（`main.rs:408`） | — |
| 🟡 低-有界 | ADB PTY 通道 | ≤ 512 × 8 KB ≈ 4 MB | 有界（`main.rs:3929-3942`） | 丢块只写 stderr，Release 用户**无从得知**（可观测性缺口） |
| 🟡 低-有界 | BLE 通知缓冲 | ≤ 2000 条 JSON | 有界 + dropped 可见 | — |
| 🟡 低-有界 | BLE 从机事件队列 | ≤ 400 条 | 有界但**静默丢** | 缺 dropped 计数 |
| 🟡 低-有界 | 前端 DOM | 1 万 / 软限 1.5 万行 | 有界 | 顶部浏览或存在选区时**跳过清理**（`4308-4310`），长时间停留顶部会突破软限 |
| 🟡 低-有界 | `_bleLog` / `_blePeriphLog` | 各 400 条 | 有界 | BLE 高频通知下 400 条 ≈ 100 s 历史（@100 Hz） |
| 🟢 无上限但瞬时 | Toast | DOM 节点 | 自动移除（3/5 s） | 短时间大量 toast 会堆叠 |
| 🟢 无上限 | 错误上报 mpsc 通道 | `std::sync::mpsc::channel`（无界，`main.rs:39`） | 消费端是单线程 + 5 s HTTP 超时 | 服务不可达时错误批量产生会堆积内存（量级小） |

---

## 6. 已有的「生成报告 / 导出」功能盘点

**结论：没有把多路日志汇总成单一报告的代码。** 现有的"导出"都是**单通道、单格式**的。

| 功能 | 位置 | 导出内容 | 格式 | 覆盖通道 |
|---|---|---|---|---|
| 手动保存监视器日志 | `saveLogToFile` `index.html:4177` → `save_log` `main.rs:3005` | 当前 `mid` 的全部 `recv`/`send`/`sys`/`err`（`getOutputText` `index.html:4209` → `bufferGetAllText` `4674`） | 纯文本 `<dir>\Serial Debug YYYY-MM-DD HHMMSS.txt` | **仅 1 个监视器**（main / extra-N / wsl-xN） |
| 隐形会话缓存 | `logCacheStart/Flush/End` `index.html:4519/4509/4529` → `append_log_cache` `main.rs:3174` | 仅 `recv` + `send`（`index.html:4587`） | 纯文本 `session-<ts>-<port>.log` | 仅串口/WSL 串口 |
| 工作流触发落盘 | 动作 `save_log` `main.rs:839-847`、`911-921` | 触发时刻的原始字节 `received` | 追加到 `<logDir>\workflow_log.txt` | 仅串口原始流 |
| 缓存文件列表 | `list_log_cache` `main.rs:3233-3266` | 文件名 + 大小 + 修改时间 | JSON | **已实现且已注册（`main.rs:6899`），前端零调用 ⇒ 无 UI 入口** |
| BLE 从机配置导出 | `blePfExportTable` `index.html:8062-8075` → `ble_periph_save_config_file` | **广播配置表**（服务/特征），**不是日志** | CSV（可用 Excel 编辑） | 与日志无关 |
| 错误上报远端 | `report_error` `main.rs:107` | error + context | JSON → SQLite/D1，网页列表 | 仅错误，非运行日志 |
| `testErrorReport` | `index.html:10600` | — | — | 自测，**无 UI 绑定** |

**汇总导出缺失点（可作为后续改进候选）**

1. 没有任何入口能把「串口 + WSL + ADB + BLE 主机 + BLE 从机 + 后端 `dbg_log`」合并成一个诊断包（如 zip + 汇总 txt/md）。
2. ADB xterm 内容无法导出/复制为文件（仅能手动选中复制）。
3. BLE 主机 / BLE 从机日志只有"清空"，无复制、无保存。
4. `list_log_cache` 的能力没暴露；用户不知道 `%APPDATA%\seahi-serial\log-cache` 的存在。
5. `dbg_log` 的 `%TEMP%\seahi-serial-debug.log` 既不轮转也不在 UI 中可查/可导出，实际是"写死了但没人看"的通道。

---

## 7. 附：关键常量速查

| 常量 / 数字 | 值 | 位置 |
|---|---|---|
| 串口后端缓冲上限 / 保留量 | 262144 B / 131072 B | `main.rs:408-410` |
| 串口读取块大小 | 4096 B | `main.rs:393` |
| 空闲退避 | 2 ms | `main.rs:421` |
| 正则跨块 tail | 2048 B | `main.rs:488` |
| 工作流事件上限 | 200 | `main.rs:856` |
| BLE 通知缓冲上限 | 2000 | `main.rs:6259` |
| BLE 从机事件上限 | 400 | `main.rs:4417` |
| BLE 从机特征上限 | 16 | `main.rs:4419` |
| BLE 连接超时 | 10000 ms | `main.rs:6086` |
| ADB PTY 队列块数 / 块大小 | 512 / 8192 B | `main.rs:3929-3930` |
| ADB PTY 初始尺寸 | 40 行 × 120 列 | `main.rs:3914` |
| xterm scrollback | 1000 | `index.html:9618` |
| log-cache 文件数上限 | 10 | `main.rs:3069` |
| log-cache 前缀 / 后缀 | `session-` / `.log` | `main.rs:3065-3067` |
| 前端缓存 flush 节流 | 300 ms | `index.html:4500` |
| 前端紧凑缓冲裁剪阈值 | >1000000 行 → 删 500000 | `index.html:4582-4583` |
| 前端初始缓冲 | 1 MB / 10 万槽位 | `index.html:2627-2631` |
| DOM 行上限（硬 / 软） | 10000 / 15000 | `index.html:4305-4306` |
| 历史回填批量 | 1000 行 | `index.html:4689` |
| BLE 前端日志上限 | 400 | `index.html:6783`、`8685` |
| 串口轮询（可见 / 隐藏） | 25 / 500 ms | `index.html:3692-3693` |
| ADB 轮询（可见 / 隐藏） | 120 / 2000 ms | `index.html:9407`、`9427` |
| BLE 通知轮询 | 250 ms | `index.html:7218` |
| BLE 从机事件轮询 | 500 ms | `index.html:9252` |
| 发送历史上限 | 50 | `index.html:2360`（`MAX_SEND_HISTORY`） |
| 上报 HTTP 超时 | 5 s | `main.rs:42` |
