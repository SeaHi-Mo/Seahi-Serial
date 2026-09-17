# MCP 工具参考

> 本页的工具名 / 描述 / 入参**逐字取自** `src-tauri/src/mcp/protocol.rs` 的 `tool_defs()`；
> 「返回」列是对着**真实运行的服务**实调一遍抓下来的 `structuredContent` 结构，不是照记忆写的。
> 上手步骤见 [MCP.md](./MCP.md)，设计与取舍见 [MCP_DESIGN.md](./MCP_DESIGN.md)。

> **字段命名**：参数与返回**一律 camelCase**（`portName` / `sinceSeq` / `maxLinesPerChannel`）。
> 有四个参数历史上写成了蛇形，**旧拼写仍然认**（`since_seq` / `case_sensitive` / `max_lines_per_channel` / `ok_only`）——
> 直接改名会让按旧写法调用的人**静默失效**，那比报错更危险。

⚠️ 返回结构里**没有**的字段就是真的没有（例如串口项只有 `portName / friendlyName / productName`，没有 VID/PID）。
⚠️ 很多客户端只把 `content[].text` 给模型看，所以**摘要必须把数据说出来**（`serial_list_ports` 的文本里就带着端口名）。

💡 **读日志优先用 `format:"text"`**（`log_tail` / `serial_get_output`）：一行一条纯文本，同样内容比默认 json 省一半以上 token。实测（200 条短行）：**json 101 字节/行 → text 29 字节/行，省 3.5 倍**；行越长省得越少（长行只剩 ~30%）。text 编码的正文放在 `content[].text`（**只有一份**），`structuredContent` 只给元信息，所以"省 token"不会变成"看不到日志"。

💡 **要"有没有 / 几次"就别拉命中行**：`log_search{mode:"count"}` 只回计数（几十 token），`mode:"matches"` 只回片段，`mode:"lines"`（默认）才回整行。三档的数据是同一份，差的只是**回多少**。

## 1. 怎么连

| | |
|---|---|
| 传输 | **两种并存**（默认）：① **Streamable HTTP**（`POST /mcp`，2025-03-26+ 规范，新版客户端默认走它）；② **遗留 SSE**（`GET /sse` + `POST /messages`，只支持 SSE 的老客户端）。也可以在弹窗里选「仅 /mcp」或「仅 SSE」—— 那时另一条端点返回 404 |
| 端点（推荐，新客户端）| `POST /mcp?token=…` 发 JSON-RPC，**结果直接从这次 HTTP 响应回来**（`Content-Type: application/json`）；`initialize` 的响应头带 `Mcp-Session-Id`，后续请求用同名请求头带回来；`GET /mcp` 可另挂一条 SSE 流收服务端通知；`DELETE /mcp` 主动结束会话 |
| 端点（老客户端）| `GET /sse`（建立会话，首帧下发 `event: endpoint`）→ `POST /messages?sessionId=…`（发 JSON-RPC，结果从 SSE 流回）|
| 鉴权 | 每个请求都要带 token：`?token=…` 或 `Authorization: Bearer …`；`GET /healthz` 是唯一免鉴权端点，只回 `{"ok":true}` |
| 监听 | **只监听回环**（`127.0.0.1` / `::1` / `localhost`），不对外网/局域网开放 |
| 握手顺序（Streamable HTTP）| `POST /mcp` `initialize`（不带会话头）→ 从响应头拿 `Mcp-Session-Id` → 后续请求都带上它 → `notifications/initialized`（回 202）→ `tools/list` |
| 握手顺序（遗留 SSE）| 客户端必须先 `GET /sse` 拿到 endpoint，再 `POST` `initialize` → `notifications/initialized` → `tools/list` |
| 地址从哪来 | 程序弹窗里的「Streamable HTTP / 遗留 SSE」两块地址，或 `%APPDATA%\seahi-serial\mcp-endpoint.json`（`url` 与 `urlStreamable` 两个字段）|
| 传输档位 | 弹窗里的「传输」三档：**两种都提供**（默认，兼容性最好）/ **仅 /mcp** / **仅 SSE**。配置键是 `server.transport`（老的 `server.streamableHttp` 布尔写法仍然认）。选单档时**另一条端点立刻返回 404**（切换立即生效，不用重启服务器）|

## 2. 怎么拿工具列表

- 运行时：`tools/list`（分页，每页 50，用 `nextCursor` 翻页）——这是**权威来源**，本页只是它的可读版本。
- `mcp_limits` / `mcp_status` 里的 `toolCount` / `builtinToolCount` 能看到数量。
- 内置工具 **53 个**；另有可选的 `ctl_*`（见 §4）。

## 3. 一页速查

| 工具 | 读/写 | 作用 |
|---|---|---|
| [`serial_get_state`](#serial-get-state) | 读 | 读某个串口分栏的完整状态：端口、波特率、帧格式(数据位/停止位/校验)、行尾、DTR/RTS、查看模式、行号/时间戳/回显/自动滚动/自动重连/终端模式、**是否正在监控**、输出行数与字节数、发送历史条数、以及全部分栏名（`panes`）。还给出 `portOptions` —— **这个分栏**当前能选哪些端口（Windows 分栏是 COM 名，WSL 分栏是 `/dev/...` 路径；`inUse` 表示被别的分栏占着）。省略 pane 默认 main。**操作串口前先调它**。 |
| [`serial_select_port`](#serial-select-port) | **写** | 选串口分栏要用的端口（等价于在「端口」下拉里选一项）。值必须是**该分栏**端口下拉里的一个 —— 也就是 serial_get_state 的 `portOptions` 里的 `value`；给错会回列可选值。⚠️ **别拿 serial_list_ports 当依据**：它只列 Windows 的 COM 口，而 WSL 分栏要的是 `/dev/ttyUSB0` 这类 WSL 内部路径（把 USB 串口 usbipd bind 进 WSL 之后，Windows 侧本来就看不到那个口）。 |
| [`serial_set_baud`](#serial-set-baud) | **写** | 设置波特率（110..4000000）。等价于在「波特率」输入框里填值。 |
| [`serial_set_frame`](#serial-set-frame) | **写** | 设置串口帧格式：dataBits(5|6|7|8) / stopBits(1|2) / parity(none|odd|even)。至少给一个（在「更多设置」里）。**改帧格式只在未连接时有意义**，连接中请先 serial_close。 |
| [`serial_set_lines`](#serial-set-lines) | **写** | 设置 DTR / RTS 电平（布尔）。常用于让目标板复位（DTR 拉低）或进入下载模式。 |
| [`serial_set_display`](#serial-set-display) | **写** | 设置显示与行为开关：viewMode(text|hex)、lineEnding(crlf|lf|cr|none)、echo(消息回显)、lineNum(行号)、timestamp(时间戳)、autoScroll(自动滚动)、autoReconnect(自动重连)、terminalMode(终端模式)、advOpen(更多设置栏展开)。至少给一个。**serial_get_state 报出来的每个开关这里都能设**。 |
| [`serial_open`](#serial-open) | **写** | **开始监控**（等价于点「开始监控」按钮）。可以同时给 port/baud 一次设定，省两次调用。返回前会**确认真的连上**（最多等 6 秒）；失败会说明可能原因（端口被占用/设备拔出/驱动异常）。 |
| [`serial_close`](#serial-close) | **写** | 停止监控（等价于点「停止监控」），返回前确认已断开。 |
| [`serial_send`](#serial-send) | **写** | 往串口发数据。mode=hex 时 data 按十六进制字节解析（如 "01 03 00 00 00 02"），否则按文本发。lineEnding 可临时覆盖该分栏的行尾设置。需要该分栏已在监控中。 |
| [`serial_clear`](#serial-clear) | **写** | 清空该分栏的输出区内容（等价于点「清除内容」）。**只清界面显示，不动磁盘上的会话日志缓存文件。** |
| [`serial_get_history`](#serial-get-history) | 读 | 读该分栏的发送历史（最近的在前）。用来回看刚才发过什么，或复用上一条指令。 |
| [`serial_get_output`](#serial-get-output) | 读 | 读该分栏**实际收发的内容**（串口监视器的核心：设备刚才回了什么）。默认收+发都返回，按时间归并；每条带 dir 区分。数据取自日志中心，与 log_tail 是同一份存储；本工具额外的好处是**不需要你知道通道名**，且「还没收到数据」会返回空列表而不是报错。**读内容优先用 `format:"text"`**（一行一条 `[时刻] [rx|tx] 正文`，比默认 json 省一半以上 token）；要逐行结构化字段时才用 json。text 格式的正文在 content 文本里，structuredContent 只给元信息。 |
| [`serial_quick_cmd`](#serial-quick-cmd) | 读 | 快速指令（监控输出区最右侧那条可折叠分栏，默认折叠）—— 列表按**循环组**分段，一组一张表。四种用法：①**不带参数**=列出全部（每条含 index/所属组/值/label 与它自己的发送参数 seq 顺序号、timeoutMs 超时、expect 追加的成功词、retry 重试次数、hex 是否按 HEX 发，以及可直接交给 ui_set 的 domIds；另给 groups[]（组名/条数/on 是否参与循环/folded）与 loop{on,planLength}，以及列表是否来自外部文件）；②**给 index**=执行第 index 条（按该条自己的 hex 决定文本还是 HEX）；③**action=loop**=开/关整条循环链（组从上到下 → 组内顺序号；每发一条**等它的回应**：busy 继续等 / OK 下一条 / ERROR 重发本条 / 等满超时终止整链；on 省略=取反；没连串口或没有可发条目时会拒绝并说明原因）；④**action=add|update|remove|group**=改列表（加一条/改一条/删一条/组操作 op=add|remove|rename|move|on|fold）。改列表会同时写回它挂载的外部文件（文件即存储）。 |
| [`serial_workflow`](#serial-workflow) | 读 | 串口/WSL 分栏的**自动化工作流规则**（面板「更多设置 → 工作流」那一块）：收到匹配的数据就自动执行动作（发数据 / 切 DTR-RTS / 存日志）。用法：①**省略 action**=列出该分栏的全部规则（id / name / enabled / running / 条件 / 动作）；②**action=add**=加一条（可给 name / conditions / actions / enabled；**新规则一律 running=false**）；③**action=update**=按 rule 改（给哪个字段改哪个；running 只接受 false，用来停一条正在跑的）；④**action=remove**=按 rule 删（正在跑的会一起停）。⚠️ 规则一旦 running，**收到匹配数据就会自动往设备发数据** —— 要启动请用 serial_workflow_run（要 confirm），**不要**用 ui_click 点面板上那颗运行按钮绕开确认。改规则会立刻写进配置（与面板上改同一条路）。 |
| [`serial_workflow_run`](#serial-workflow-run) | **写** ⚠️ | 开始/停止一条工作流规则的**运行**（running）。⚠️ 危险动作：开始之后，这条规则一收到匹配的数据就会**自动往设备发数据**（动作里可能还有存日志文件），必须带 confirm:true；不带时**不会执行**并返回 -32006 说明后果。停止（on=false）同样需要 confirm —— 它属于同一条工具。 |
| [`ble_get_state`](#ble-get-state) | 读 | 蓝牙分栏的当前状态：是否在扫描、扫到几台设备、选中/已连的是哪台、GATT 服务树有几个服务、订阅了几路通知、内嵌监视器是否打开。只读，无副作用。 |
| [`ble_list_devices`](#ble-list-devices) | 读 | 读蓝牙扫描结果（不触发扫描）：MAC、名称、信号强度 RSSI、是否已配对、是否当前选中，以及扫描是否在进行中。**支持分页**：`limit` 每页几台、`offset` 从第几台开始（返回里给 `hasMore` / `nextOffset`，拿它接着翻）。⚠️ 扫描还在进行时列表仍在增长，翻页可能重复/漏掉个别设备；要稳定完整的名单就等 `scanning=false` 再翻，或一次给个大 `limit`。**每次都会现问一次后端**（不是只读面板那个 2 秒轮询的缓存），所以刚 ble_start_scan 完立刻问也拿得到；一台都没有时会说明下一步 —— 设备不广播（被 Windows 配对过 / 被别的主机连走）时扫描永远为空，得用 ble_connect + addr 按 MAC 直连。只读。 |
| [`ble_start_scan`](#ble-start-scan) | **写** | 开始扫描蓝牙设备（面板那颗「开始/停止扫描」按钮的同一条路径）。默认按面板上设的时长自动停止；扫完用 ble_list_devices 取结果。写操作（会占用射频）。 |
| [`ble_stop_scan`](#ble-stop-scan) | **写** | 停止蓝牙扫描（复用同一颗按钮的路径）。写操作。 |
| [`ble_connect`](#ble-connect) | **写** | 连接一台 BLE 设备。给 addr 时：**扫描列表里有它**就点它的卡片再走「连接设备」（同一条路）；**列表里没有**就走「按 MAC 直连」（不依赖广播 —— 被 Windows 配对过、或被别的主机连走因而不广播的设备，只有这条路连得上）。不给 addr 就用面板当前选中的那台。**等连接真的成功才返回**（会带上服务数）。写操作。 |
| [`ble_disconnect`](#ble-disconnect) | **写** | 断开当前已连接的设备（面板那颗「断开设备」按钮的同一条路）。断开后服务树、订阅状态、本次会话的数据日志一并清空。写操作。 |
| [`ble_get_services`](#ble-get-services) | 读 | 当前已连接设备的 GATT 服务树（服务 UUID / 名称，每个服务下的特征 UUID、属性 props、描述符个数）。只读，取的是面板已经拉到的那份，不会重新去问设备。 |
| [`ble_read`](#ble-read) | 读 | 读一个特征的值（按 UUID 寻址）——**点的是面板上那颗读按钮**，结果随后出现在 ble_get_output 里。需要设备已连接、且该特征有 read 属性（用 ble_get_services 看）。 |
| [`ble_write`](#ble-write) | **写** | 往一个特征写数据（按 UUID 寻址）——**打开的就是面板那个写入窗并点「发送」**，HEX/文本解析、行尾、写响应/无响应全用面板那套（写入窗会留在界面上，数据日志里也能看到这一条）。需要设备已连接、且该特征有 write 属性（见 ble_get_services）。写操作。 |
| [`ble_subscribe`](#ble-subscribe) | **写** | 开/关某个特征的通知订阅（notify / indicate）——点的是面板上那颗订阅按钮，数据随后出现在 ble_get_output 里。**状态已经在目标值时不会重复点**（不会把用户刚打开的订阅关掉）。 |
| [`ble_get_output`](#ble-get-output) | 读 | 读蓝牙面板**本次会话**的数据日志（连上之后收到的通知/读到的内容、发出的写，按时间排列；切设备或断开会清空）。要跨会话的完整历史就用返回里的 `channels.rx` 去 log_tail。**要"这条 ERROR 出现几次"别拉条目**：给 `pattern` + `mode`（与 `log_search` 同一套词汇）—— `count` 只回计数、`matches` 只回片段、`lines`（默认）回条目。匹配的文本取 `text`，`text` 为空时取 `hex`（HEX 通知也能搜）。只读。 |
| [`ble_refresh_rssi`](#ble-refresh-rssi) | 读 | 读当前已连接设备的信号强度（RSSI，负数，越接近 0 越强）。只问一次射频、不改状态；还没连设备时会直接说明。 |
| [`adb_list_devices`](#adb-list-devices) | 读 | 列出 `adb devices -l` 看到的设备（序列号 / 状态 / 型号）。只读，不会开 shell。**只有 state=device 的那台才可用**；unauthorized 表示还没在设备上点「允许 USB 调试」。 |
| [`adb_open_shell`](#adb-open-shell) | **写** ⚠️ | 在设备上开一个交互式 shell 会话（等价于点面板上那台设备的卡片：建 xterm + PTY）。开之前先确认设备在且 state=device；**等 PTY 真的建出来才返回**（最长 10 秒）。⚠️ 危险动作（之后能在设备上执行任意命令），必须带 confirm:true；不带时不会执行并返回 -32006。开完用 adb_shell_write 发命令、adb_shell_read 读输出。 |
| [`adb_shell_write`](#adb-shell-write) | **写** ⚠️ | 往已打开的 ADB shell 写入内容（与在面板终端里敲键盘同一条路：字节会进设备 shell 的 stdin）。**命令要自己带上 \n**，不带就只是填在命令行上不会执行。⚠️ 危险动作（写进去的内容会被设备真的执行），必须带 confirm:true。单次最多 4096 字符（mcp_limits.maxAdbWriteChars），超了报 -32602。 |
| [`adb_shell_read`](#adb-shell-read) | 读 | 读 ADB shell 已经产生的输出（日志中心 adb:rx 通道：PTY 读线程在生产端旁路的一份副本，**不会抢走界面终端要显示的队列**）。**items 是 PTY 的输出块、不是按行切好的文本**（终端输出本来就没有行边界，ANSI 光标序列会跨块）。用 sinceSeq 增量跟进：下一次传返回 items 里最后一条的 seq。**`logcat` 刷屏时先别拉条目**：给 `pattern` + `mode`（与 `log_search` 同一套词汇）—— `mode:"count"` 只回"命中多少条/多少处"，`mode:"matches"` 只回命中片段，`mode:"lines"`（默认）回条目本身（给了 pattern 就只回命中的）。只读，不需要界面。 |
| [`adb_shell_resize`](#adb-shell-resize) | **写** | 调整已打开 ADB shell 会话的 PTY 尺寸（与面板跟着容器尺寸自动推的是同一个后端命令）。cols/rows 都是 2~1000（mcp_limits.maxAdbCols / maxAdbRows）。注意：面板自己的尺寸同步（窗口/容器变化时）可能随后把它改回真实容器尺寸。写操作。 |
| [`adb_close_shell`](#adb-close-shell) | **写** | 关掉当前 ADB shell 会话（等价于点面板上会话的关闭：杀掉 adb shell 子进程 + 移除终端）。本来就没开会话时是幂等的（closed:false + note），不是错误。写操作。 |
| [`mcp_danger`](#mcp-danger) | 读 | 列出**需要二次确认**的危险工具（会对外产生不可撤销影响的那些）与各自的后果。调用它们时必须带 confirm:true，否则不会执行。只读。 |
| [`app_info`](#app-info) | 读 | 本机 SeaHi Serial 应用的基本信息（版本、平台、进程、运行时长）。只读，无副作用。 |
| [`mcp_status`](#mcp-status) | 读 | MCP 服务器自身状态：是否运行、监听端点、会话数、请求数与限流/丢弃计数。只读。 |
| [`mcp_limits`](#mcp-limits) | 读 | MCP 服务器的硬性上限（会话数、队列深度、心跳、限流、超时等）。只读，用于判断会不会被限流。 |
| [`serial_list_ports`](#serial-list-ports) | 读 | 枚举本机可用串口（端口名 / 友好名称 / 产品名）。只读，不会打开端口。⚠️ **只有 Windows 侧的 COM 口** —— WSL 分栏的端口是 WSL 内部的 `/dev/...`，不在这里（用 serial_get_state 的 `portOptions` 看那个分栏能选什么）。返回 {count, ports:[…]}。 |
| [`ui_list`](#ui-list) | 读 | 列出界面上的可操控控件（按钮/输入框/下拉/开关）。每条给出 path、类型、面板、当前值、是否可用与不可用的原因。建议先用它枚举，再决定操作哪个。 |
| [`ui_describe`](#ui-describe) | 读 | 看某个控件的完整信息与它的输入格式（inputSchema）：可选值有哪些、要传数字还是布尔。 |
| [`ui_get`](#ui-get) | 读 | 读某个控件的当前值（实时从界面读，不是缓存的配置）。 |
| [`ui_set`](#ui-set) | **写** | 设置控件值。执行走的是与用户点击完全相同的路径，所以界面会同步变化。返回的是**写后的真实值**（控件可能规范化输入）。可用 items 一次设置多个。⚠️ 少数动作是「点了才开始跑」的 —— 典型是 WSL 端口映射那个复选框（要过 usbipd，可能要用户在机器上点授权框）：结果里会带 `mapRequest.settled=false` 与 `note`，**那时不要重试**，稍后用 ui_get_state{section:"wslDevices"} 看 status 是否变成 mapped。 |
| [`ui_click`](#ui-click) | **写** | 点一个按钮/开关（等价于 ui_set 传 true，但语义更清楚）。⚠️ 同 ui_set：WSL 端口映射那种「点了才开始跑」的控件会在结果里带 `mapRequest.settled=false`，别重试，去 ui_get_state{section:"wslDevices"} 复查。 |
| [`ui_get_state`](#ui-get-state) | 读 | 读整个界面状态的快照（就是随用户配置持久化的那份：各监视器的端口/波特率/行尾/显示模式/开关、主题、蓝牙选中项等）。可用 section 只取子树。 |
| [`log_channels`](#log-channels) | 读 | 列出所有日志通道（条数 / 字节 / seq 区间 / 被丢弃条数 / 最后一条时间）。不确定去哪找日志时先调它。 |
| [`log_tail`](#log-tail) | 读 | 取某个通道的尾部若干行。**读日志优先用 `format:"text"`** —— 一行一条纯文本，同样内容比默认的 json 省一半以上 token（实测短行日志 3.5 倍：101 字节/行 → 29 字节/行，短行的开销几乎全在每行的 JSON 包装上）；要逐行的结构化字段（seq/时间戳/字节数/方向）时才用 json。给了 `sinceSeq` 就是增量拉取：返回里的 `nextSinceSeq` 是**下次该带的值**（推进到它就不会漏也不会重复；直接跳到 `seqTo` 会把没拿到的行永远跳过），`missed>0` 表示这一段还有行没给你，`mayBeIncomplete=true` 表示该通道丢过最旧的行（别把日志当完整证据）。text 格式的日志正文在 content 文本里，structuredContent 只给元信息。 |
| [`log_search`](#log-search) | 读 | 在日志里检索（子串或正则）。不给 channel 就搜所有通道。**先想清楚要多少信息再选 `mode`**：`count` 只回计数（`total` + 有命中的通道各几次，几十 token —— 问"ERROR 出现过几次""到底有没有超时"就用它）；`matches` 只回匹配片段（一行里每处命中一条，只有 `match` 字段，长行日志用它比回整行省得多）；`lines`（默认）回命中行本身，另可用 `context` 带前后几行。每条命中都带 channel/seq，便于接着 log_tail 看上下文。⚠️ 要成段读某个通道就用 `log_tail{format:"text"}`，别把本工具当"读全部"用。 |
| [`log_stats`](#log-stats) | 读 | 各通道的概览：条数、字节、被丢弃条数、告警/错误数、时间跨度与平均行/秒。用来判断"是不是在刷屏"。 |
| [`log_clear`](#log-clear) | **写** | 清空某个通道，或省略 channel 清空全部。 |
| [`mcp_calls`](#mcp-calls) | 读 | 查最近的工具调用记录（谁在什么时候调了什么、成没成、耗时多久、改动了哪些控件）。记录写在独立的 ai-calls.jsonl，不碰用户配置。 |
| [`mcp_stats`](#mcp-stats) | 读 | 调用统计：总次数、按工具分布、时间范围、记录文件大小与丢弃数。 |
| [`mcp_config_get`](#mcp-config-get) | 读 | 读 MCP 自己的配置（服务器开关/端口/记录设置等）。token 只回打码值。 |
| [`mcp_config_set`](#mcp-config-set) | **写** | 改 MCP 自己的配置。只支持 server 与 callLog 两类键（未知键会报错）。改 server.* 只保存、不立刻重启（需在界面里关闭再启用才生效）；不接受改 token。 |

> 「写」= 会改变程序状态（界面 / 日志缓存 / AI 配置）。AI 调用这些工具时请先确认意图。
> **只读（沙箱）模式**：用户在弹窗里打开后，上表所有「写」工具一律被拒（错误码 `-32007`，且**没有执行** —— 界面与配置文件一个字都不变）。
> 注意这个不对称是故意的：`mcp_config_set` 自己也是写工具，所以 **AI 只能打开只读模式、关不掉它**，要关必须由用户在弹窗里点。

## 4. 逐个工具

### 串口语义工具（**优先用这些**，比 ui_* 通用桥更准）

#### `serial_get_state`

- **作用**：读某个串口分栏的完整状态：端口、波特率、帧格式(数据位/停止位/校验)、行尾、DTR/RTS、查看模式、行号/时间戳/回显/自动滚动/自动重连/终端模式、**是否正在监控**、输出行数与字节数、发送历史条数、以及全部分栏名（`panes`）。还给出 `portOptions` —— **这个分栏**当前能选哪些端口（Windows 分栏是 COM 名，WSL 分栏是 `/dev/...` 路径；`inUse` 表示被别的分栏占着）。省略 pane 默认 main。**操作串口前先调它**。
- **读/写**：只读，无副作用
- **返回**：{pane, isConnected, portName, port, baud, viewMode, lineEnding, sendAs, dataBits, stopBits, parity, dtr, rts, autoScroll, autoReconnect, lineNum, timestamp, echo, terminalMode, advOpen, outputLines, outputBytes, historyCount, panes, portOptions:[{value,label,inUse}], logChannels:{rx,tx}}
- **注意**：**操作串口前先调它**；省略 pane 默认 main；`logChannels` 是"收发内容去哪读"的通道名；`portOptions` 是**这个分栏**当前能选的端口（Windows 分栏是 COM 名，WSL 分栏是 `/dev/...` 路径）——选端口前先看它

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `pane` | string | 否 | 分栏名：main / extra-N（Windows），wsl / wsl-xN（WSL）；省略=main。写操作会自动把该分栏的面板切到前台（用户要看得见）；WSL 分栏是懒创建的，写操作会顺带把它建出来 |

#### `serial_select_port`

- **作用**：选串口分栏要用的端口（等价于在「端口」下拉里选一项）。值必须是**该分栏**端口下拉里的一个 —— 也就是 serial_get_state 的 `portOptions` 里的 `value`；给错会回列可选值。⚠️ **别拿 serial_list_ports 当依据**：它只列 Windows 的 COM 口，而 WSL 分栏要的是 `/dev/ttyUSB0` 这类 WSL 内部路径（把 USB 串口 usbipd bind 进 WSL 之后，Windows 侧本来就看不到那个口）。
- **读/写**：**写**（会改状态）
- **返回**：{pane, applied:[{name,ok,from,to}]}
- **注意**：值必须是**该分栏**端口下拉里的一个（就是 `serial_get_state` 的 `portOptions[].value`）；给错 → 协议级 `-32602` 并**回列真实可选值**，照着改就行。⚠️ 别拿 `serial_list_ports` 当依据：它只有 Windows 的 COM 口，WSL 分栏要的是 `/dev/ttyUSB0` 这类 WSL 内部路径

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `port` | string | **是** | 端口名：Windows 分栏如 COM3；WSL 分栏如 /dev/ttyUSB0 |
| `pane` | string | 否 | 分栏名：main / extra-N（Windows），wsl / wsl-xN（WSL）；省略=main。写操作会自动把该分栏的面板切到前台（用户要看得见）；WSL 分栏是懒创建的，写操作会顺带把它建出来 |

#### `serial_set_baud`

- **作用**：设置波特率（110..4000000）。等价于在「波特率」输入框里填值。
- **读/写**：**写**（会改状态）
- **返回**：同上
- **注意**：110..4000000；越界报 -32602

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `baud` | number | **是** | 波特率，如 115200 |
| `pane` | string | 否 | 分栏名：main / extra-N（Windows），wsl / wsl-xN（WSL）；省略=main。写操作会自动把该分栏的面板切到前台（用户要看得见）；WSL 分栏是懒创建的，写操作会顺带把它建出来 |

#### `serial_set_frame`

- **作用**：设置串口帧格式：dataBits(5|6|7|8) / stopBits(1|2) / parity(none|odd|even)。至少给一个（在「更多设置」里）。**改帧格式只在未连接时有意义**，连接中请先 serial_close。
- **读/写**：**写**（会改状态）
- **返回**：同上
- **注意**：dataBits/stopBits/parity 至少给一个；**连接中改帧格式无效**，先 serial_close

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `dataBits` | string | 否 | 枚举：`5` / `6` / `7` / `8` |
| `stopBits` | string | 否 | 枚举：`1` / `2` |
| `parity` | string | 否 | 枚举：`none` / `odd` / `even` |
| `pane` | string | 否 | 分栏名：main / extra-N（Windows），wsl / wsl-xN（WSL）；省略=main。写操作会自动把该分栏的面板切到前台（用户要看得见）；WSL 分栏是懒创建的，写操作会顺带把它建出来 |

#### `serial_set_lines`

- **作用**：设置 DTR / RTS 电平（布尔）。常用于让目标板复位（DTR 拉低）或进入下载模式。
- **读/写**：**写**（会改状态）
- **返回**：同上
- **注意**：dtr/rts 布尔；常用于让目标板复位或进下载模式

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `dtr` | boolean | 否 |  |
| `rts` | boolean | 否 |  |
| `pane` | string | 否 | 分栏名：main / extra-N（Windows），wsl / wsl-xN（WSL）；省略=main。写操作会自动把该分栏的面板切到前台（用户要看得见）；WSL 分栏是懒创建的，写操作会顺带把它建出来 |

#### `serial_set_display`

- **作用**：设置显示与行为开关：viewMode(text|hex)、lineEnding(crlf|lf|cr|none)、echo(消息回显)、lineNum(行号)、timestamp(时间戳)、autoScroll(自动滚动)、autoReconnect(自动重连)、terminalMode(终端模式)、advOpen(更多设置栏展开)。至少给一个。**serial_get_state 报出来的每个开关这里都能设**。
- **读/写**：**写**（会改状态）
- **返回**：同上
- **注意**：viewMode/lineEnding/echo/lineNum/timestamp/**autoScroll(自动滚动)**/autoReconnect/terminalMode/advOpen；**serial_get_state 报出来的每个开关这里都能设**（断言集里有一条守着这条对称性）

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `viewMode` | string | 否 | 枚举：`text` / `hex` |
| `lineEnding` | string | 否 | 枚举：`crlf` / `lf` / `cr` / `none` |
| `echo` | boolean | 否 |  |
| `lineNum` | boolean | 否 |  |
| `timestamp` | boolean | 否 |  |
| `autoScroll` | boolean | 否 |  |
| `autoReconnect` | boolean | 否 |  |
| `terminalMode` | boolean | 否 |  |
| `advOpen` | boolean | 否 | 「更多设置」栏是否展开（真串口面板才有） |
| `pane` | string | 否 | 分栏名：main / extra-N（Windows），wsl / wsl-xN（WSL）；省略=main。写操作会自动把该分栏的面板切到前台（用户要看得见）；WSL 分栏是懒创建的，写操作会顺带把它建出来 |

#### `serial_open`

- **作用**：**开始监控**（等价于点「开始监控」按钮）。可以同时给 port/baud 一次设定，省两次调用。返回前会**确认真的连上**（最多等 6 秒）；失败会说明可能原因（端口被占用/设备拔出/驱动异常）。
- **读/写**：**写**（会改状态）
- **返回**：{pane, connected:true, state:{…}}
- **注意**：**会等最多 6 秒确认真连上**；失败 → isError:true（-32006）并给出可能原因，不是乐观返回

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `port` | string | 否 | 可选：先选端口再打开 |
| `baud` | number | 否 | 可选：先设波特率再打开 |
| `pane` | string | 否 | 分栏名：main / extra-N（Windows），wsl / wsl-xN（WSL）；省略=main。写操作会自动把该分栏的面板切到前台（用户要看得见）；WSL 分栏是懒创建的，写操作会顺带把它建出来 |

#### `serial_close`

- **作用**：停止监控（等价于点「停止监控」），返回前确认已断开。
- **读/写**：**写**（会改状态）
- **返回**：{pane, connected:false, state:{…}}
- **注意**：会等最多 3 秒确认已断开

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `pane` | string | 否 | 分栏名：main / extra-N（Windows），wsl / wsl-xN（WSL）；省略=main。写操作会自动把该分栏的面板切到前台（用户要看得见）；WSL 分栏是懒创建的，写操作会顺带把它建出来 |

#### `serial_send`

- **作用**：往串口发数据。mode=hex 时 data 按十六进制字节解析（如 "01 03 00 00 00 02"），否则按文本发。lineEnding 可临时覆盖该分栏的行尾设置。需要该分栏已在监控中。
- **读/写**：**写**（会改状态）
- **返回**：{pane, sent:true, mode, bytes, data}
- **注意**：需要该分栏已在监控中；mode=hex 时 data 按十六进制解析；lineEnding 会**留在界面上**（不是临时覆盖）

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `data` | string | **是** | 要发送的内容（文本或 HEX 串）；单次最多 64K 字符，大块数据请分批 |
| `mode` | string | 否 | 枚举：`text` / `hex` 发送模式，默认沿用界面当前设置 |
| `lineEnding` | string | 否 | 枚举：`crlf` / `lf` / `cr` / `none` 临时改行尾（改完会留在界面上） |
| `pane` | string | 否 | 分栏名：main / extra-N（Windows），wsl / wsl-xN（WSL）；省略=main。写操作会自动把该分栏的面板切到前台（用户要看得见）；WSL 分栏是懒创建的，写操作会顺带把它建出来 |

#### `serial_clear`

- **作用**：清空该分栏的输出区内容（等价于点「清除内容」）。**只清界面显示，不动磁盘上的会话日志缓存文件。**
- **读/写**：**写**（会改状态）
- **返回**：{pane, cleared:true, outputLines}
- **注意**：**只清界面**，不动磁盘会话日志缓存

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `pane` | string | 否 | 分栏名：main / extra-N（Windows），wsl / wsl-xN（WSL）；省略=main。写操作会自动把该分栏的面板切到前台（用户要看得见）；WSL 分栏是懒创建的，写操作会顺带把它建出来 |

#### `serial_get_history`

- **作用**：读该分栏的发送历史（最近的在前）。用来回看刚才发过什么，或复用上一条指令。
- **读/写**：只读，无副作用
- **返回**：{pane, total, items:[…]}
- **注意**：最近的在前

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `limit` | number | 否 | 最多返回多少条，默认 20，上限 200 |
| `pane` | string | 否 | 分栏名：main / extra-N（Windows），wsl / wsl-xN（WSL）；省略=main。写操作会自动把该分栏的面板切到前台（用户要看得见）；WSL 分栏是懒创建的，写操作会顺带把它建出来 |

#### `serial_get_output`

- **作用**：读该分栏**实际收发的内容**（串口监视器的核心：设备刚才回了什么）。默认收+发都返回，按时间归并；每条带 dir 区分。数据取自日志中心，与 log_tail 是同一份存储；本工具额外的好处是**不需要你知道通道名**，且「还没收到数据」会返回空列表而不是报错。**读内容优先用 `format:"text"`**（一行一条 `[时刻] [rx|tx] 正文`，比默认 json 省一半以上 token）；要逐行结构化字段时才用 json。text 格式的正文在 content 文本里，structuredContent 只给元信息。
- **读/写**：只读，无副作用
- **返回**：{pane, direction, format, isConnected, channels:{rx,tx}, count, items:[{seq,ts,dir,text,bytes}], truncated, note?}（`format:"text"` 时改为 `{…, text}`，**没有再给 items**）
- **注意**：**串口监视器的核心：读设备回了什么**。默认收+发按时间归并；数据与 `log_tail` 同一份存储，但**不需要你知道通道名**，且"还没收到数据"返回空列表 + note 而不是报错。**优先用 `format:"text"`**（一行一条 `[时刻] [rx|tx] 正文`，比 json 省一半以上 token；头部那行带着两通道各自的 dropped/mayBeIncomplete，正文在 content 文本里）

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `pane` | string | 否 | 分栏名：main / extra-N（Windows），wsl / wsl-xN（WSL）；省略=main。写操作会自动把该分栏的面板切到前台（用户要看得见）；WSL 分栏是懒创建的，写操作会顺带把它建出来 |
| `direction` | string | 否 | 枚举：`rx` / `tx` / `both` 只要收(rx)/只要发(tx)/都要(both，默认) |
| `lines` | number | 否 | 最多返回多少行，默认 50，上限 2000 |
| `format` | string | 否 | 枚举：`json` / `text` 输出编码：text=一行一条纯文本（推荐，省 token）；json=逐行结构化对象（默认） |

#### `serial_quick_cmd`

- **作用**：快速指令（监控输出区最右侧那条可折叠分栏，默认折叠）—— 列表按**循环组**分段，一组一张表。四种用法：①**不带参数**=列出全部（每条含 index/所属组/值/label 与它自己的发送参数 seq 顺序号、timeoutMs 超时、expect 追加的成功词、retry 重试次数、hex 是否按 HEX 发，以及可直接交给 ui_set 的 domIds；另给 groups[]（组名/条数/on 是否参与循环/folded）与 loop{on,planLength}，以及列表是否来自外部文件）；②**给 index**=执行第 index 条（按该条自己的 hex 决定文本还是 HEX）；③**action=loop**=开/关整条循环链（组从上到下 → 组内顺序号；每发一条**等它的回应**：busy 继续等 / OK 下一条 / ERROR 重发本条 / 等满超时终止整链；on 省略=取反；没连串口或没有可发条目时会拒绝并说明原因）；④**action=add|update|remove|group**=改列表（加一条/改一条/删一条/组操作 op=add|remove|rename|move|on|fold）。改列表会同时写回它挂载的外部文件（文件即存储）。
- **读/写**：只读，无副作用
- **返回**：{pane, items:[{index,label,value,seq,timeoutMs,expect,retry,okGoto,errGoto,hex}], usable, file, source}
- **注意**：不带 index 只列；带 index 才执行（→ {pane, ran, label, value, hex}）。`seq`/`timeoutMs`/`expect`/`retry`/`okGoto`/`errGoto`/`hex` 是**每条自己的等待参数**（顺序号 > 0 才进面板上的「循环发送」列表；`timeoutMs` = 这条发出去最多等多久、缺省 3000、**填 0 = 这条不等响应**；`expect` = 追加的成功词（`|` 分隔）、`retry` = 收到 ERROR 后重发几次、缺省 3；**`okGoto`/`errGoto` = 跳转**：收到 OK 走前者、ERROR 用尽**或超时**走后者，取值 `留空`/`下一条`（缺省）/ 数字=顺序号 / `结束` —— 这就是"分支与循环"）；除 `timeoutMs` 外这几项**面板上都没有入口**，写在指令文件的同名列里；add/update 也收 `delayMs`（**旧拼写**，与 `timeoutMs` 同值）；`source=file` 表示这个列表来自外部文件（面板里增删改会写回该文件），`file` 是它的路径；`source=config` 才是纯配置里的列表

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `index` | number | 否 | 要执行（不带 action 时）或要改（update/remove 时）的条目下标，从 0 开始，见 quickList 的 items[].index（按组→组内摊平） |
| `action` | string | 否 | 枚举：`loop` / `add` / `update` / `remove` / `group` 要做的动作：loop=开关循环发送；add=加一条；update=改一条；remove=删一条；group=组操作。省略=按 index 执行/只列举 |
| `on` | boolean | 否 | action=loop 时：true 开、false 关（省略=取反）；action=group 且 op=on/fold 时：该组是否参与循环 / 是否折叠 |
| `group` | any | 否 | action=add/group 时指定哪一组：组序号（0 起，见 quickList 的 groups[].index）、组名或组 id。add 省略时加到最后那组（这里用 anyOf 而不是 type 数组：数组型 type 的客户端兼容性差，官方 Inspector 会报） |
| `name` | string | 否 | action=group 且 op=rename 时的新组名 |
| `toIndex` | number | 否 | action=group 且 op=move 时的目标组序号（0 起；组的上下顺序就是循环顺序） |
| `value` | string | 否 | action=add/update 时的指令内容（原样发送，不按逗号切分） |
| `seq` | number | 否 | action=add/update 时的顺序号：0 = 不参与循环，>0 在**组内**按数字升序发 |
| `timeoutMs` | number | 否 | action=add/update 时的**超时**（毫秒）：这条发出去最多等多久 —— 等到 OK 发下一条、等到 ERROR 重发本条（见 retry）、等满这个时间还没等到 OK 就**终止整条循环**。缺省 3000，上限 600000。填 0 = 这条不等响应（连续 HEX 帧、设备本来就不回 OK 的指令） |
| `delayMs` | number | 否 | ⚠️ **旧拼写**：与 timeoutMs 同一个值（这一项的语义是「超时」，不是「发送间隔」）。新调用请用 timeoutMs —— 两个都给时以 timeoutMs 为准 |
| `expect` | string | 否 | action=add/update 时的**自定义成功词**，多个用 `|` 分隔（如 `WIFI GOT IP|OK`）。留空 = 只用内置的 OK / ERROR / busy。⚠️ 面板上没有它的入口（它写在指令文件的「期望」列里），通过这里改会同时落到模型与文件 |
| `retry` | number | 否 | action=add/update 时：收到 ERROR 后最多重发几次（缺省 3，上限 10；0 = 不重发，直接终止） |
| `hex` | boolean | 否 | action=add/update 时：这一条是否按 HEX 解析后发送（默认 false） |
| `pane` | string | 否 | 分栏名：main / extra-N（Windows），wsl / wsl-xN（WSL）；省略=main。写操作会自动把该分栏的面板切到前台（用户要看得见）；WSL 分栏是懒创建的，写操作会顺带把它建出来 |

#### `serial_workflow`

- **作用**：串口/WSL 分栏的**自动化工作流规则**（面板「更多设置 → 工作流」那一块）：收到匹配的数据就自动执行动作（发数据 / 切 DTR-RTS / 存日志）。用法：①**省略 action**=列出该分栏的全部规则（id / name / enabled / running / 条件 / 动作）；②**action=add**=加一条（可给 name / conditions / actions / enabled；**新规则一律 running=false**）；③**action=update**=按 rule 改（给哪个字段改哪个；running 只接受 false，用来停一条正在跑的）；④**action=remove**=按 rule 删（正在跑的会一起停）。⚠️ 规则一旦 running，**收到匹配数据就会自动往设备发数据** —— 要启动请用 serial_workflow_run（要 confirm），**不要**用 ui_click 点面板上那颗运行按钮绕开确认。改规则会立刻写进配置（与面板上改同一条路）。
- **读/写**：只读，无副作用
- **返回**：{pane, count, runningCount, rules:[{id,name,enabled,running,conditions,actions,domIds}], limits}
- **注意**：串口/WSL 分栏的**自动化工作流规则**（面板「更多设置 → 工作流」）：收到匹配数据就自动执行动作。省略 action = 列出；`action=add|update|remove` 改规则（走的就是面板改的同一条路，立刻写进配置）。⚠️ 新规则**一律 running=false**；`running:true` 这里会被拒（-32602）—— 让规则跑起来必须用 `serial_workflow_run`（带确认门）。规则一旦 running，**收到匹配数据就会自动往设备发数据**

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | string | 否 | 枚举：`list` / `add` / `update` / `remove` 要做的动作：list=列出（省略即 list）；add=加一条；update=改一条；remove=删一条 |
| `pane` | string | 否 | 分栏名：main / extra-N（Windows），wsl / wsl-xN（WSL）；省略=main。写操作会自动把该分栏的面板切到前台（用户要看得见）；WSL 分栏是懒创建的，写操作会顺带把它建出来 |
| `rule` | string | 否 | update/remove 时的规则 id（见 list 里 rules[].id） |
| `name` | string | 否 | add/update 时的规则名（最长 64 字符） |
| `enabled` | boolean | 否 | add/update 时这条规则是否**启用**（关掉的规则不参与匹配；注意它与 running 是两回事） |
| `running` | boolean | 否 | ⚠️ 这里**只接受 false**（用来停一条正在跑的规则）；想启动请用 serial_workflow_run。add 时给 true 会被强制成 false |
| `conditions` | array&lt;object&gt; | 否 | 匹配条件，**全部满足**才触发：[{"type":"string_contains|regex|exact_bytes","value":"…"}]，最多 8 条，不能是空数组 |
| `actions` | array&lt;object&gt; | 否 | 命中后**按顺序**执行：[{"type":"send_data|toggle_dtr_rts|save_log","data":"…","encoding":"text|hex","signal":"dtr|rts","level":true,"delayBefore":300}]，最多 8 条，不能是空数组 |

#### `serial_workflow_run`

- **作用**：开始/停止一条工作流规则的**运行**（running）。⚠️ 危险动作：开始之后，这条规则一收到匹配的数据就会**自动往设备发数据**（动作里可能还有存日志文件），必须带 confirm:true；不带时**不会执行**并返回 -32006 说明后果。停止（on=false）同样需要 confirm —— 它属于同一条工具。
- **读/写**：只读，无副作用
- **返回**：{pane, rule, running, changed}
- **注意**：开始/停止一条工作流规则的运行（`running`）。**危险动作**（开始之后规则会自动往设备发数据、动作里可能还有存日志文件），必须带 `confirm:true`，否则不执行并回 `-32006`。`rule` 是规则 id（见 `serial_workflow` 的 `rules[].id`），`on` 省略 = true

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `rule` | string | **是** | 规则 id（见 serial_workflow 的 rules[].id） |
| `on` | boolean | 否 | true = 开始跑，false = 停止（省略 = true） |
| `pane` | string | 否 | 分栏名：main / extra-N（Windows），wsl / wsl-xN（WSL）；省略=main。写操作会自动把该分栏的面板切到前台（用户要看得见）；WSL 分栏是懒创建的，写操作会顺带把它建出来 |
| `confirm` | boolean | 否 | 危险动作确认：必须为 true 才会执行（想清楚再传） |

### 蓝牙语义工具（BLE，**主机方向**）

#### `ble_get_state`

- **作用**：蓝牙分栏的当前状态：是否在扫描、扫到几台设备、选中/已连的是哪台、GATT 服务树有几个服务、订阅了几路通知、内嵌监视器是否打开。只读，无副作用。
- **读/写**：只读，无副作用
- **返回**：{scanning, deviceCount, selected, connected, addr, connName, serviceCount, notifySubs, logCount, monitorOpen}
- **注意**：**操作蓝牙前先调它**；只反映面板内存里的状态，不会去碰适配器

**入参**

无（不需要参数）

#### `ble_list_devices`

- **作用**：读蓝牙扫描结果（不触发扫描）：MAC、名称、信号强度 RSSI、是否已配对、是否当前选中，以及扫描是否在进行中。**支持分页**：`limit` 每页几台、`offset` 从第几台开始（返回里给 `hasMore` / `nextOffset`，拿它接着翻）。⚠️ 扫描还在进行时列表仍在增长，翻页可能重复/漏掉个别设备；要稳定完整的名单就等 `scanning=false` 再翻，或一次给个大 `limit`。**每次都会现问一次后端**（不是只读面板那个 2 秒轮询的缓存），所以刚 ble_start_scan 完立刻问也拿得到；一台都没有时会说明下一步 —— 设备不广播（被 Windows 配对过 / 被别的主机连走）时扫描永远为空，得用 ble_connect + addr 按 MAC 直连。只读。
- **读/写**：只读，无副作用
- **返回**：{scanning, total, offset, limit, returned, hasMore, nextOffset, devices:[{mac,name,rssi,paired,selected}], selected, note?}
- **注意**：**每调一次都会现问一次后端**（不是只读面板缓存）—— 刚 ble_start_scan 完立刻问也拿得到。**支持分页**：`limit` 每页几台（省略=全量）、`offset` 从第几台开始，返回里给 `hasMore`/`nextOffset` 接着翻。空列表时 `note` 会说下一步（含"设备不广播就只能按 MAC 直连"）；RSSI 是负数，越接近 0 越强

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `limit` | number | 否 | 每页最多几台（省略/0=不限，一次全给） |
| `offset` | number | 否 | 从第几台开始（0 起，默认 0）；翻页时用返回的 nextOffset |

#### `ble_start_scan`

- **作用**：开始扫描蓝牙设备（面板那颗「开始/停止扫描」按钮的同一条路径）。默认按面板上设的时长自动停止；扫完用 ble_list_devices 取结果。写操作（会占用射频）。
- **读/写**：**写**（会改状态）
- **返回**：{scanning, seconds, deviceCount}
- **注意**：走面板那颗「开始/停止扫描」按钮的同一路径；按面板上设的时长自动停止，扫完用 `ble_list_devices` 取结果

**入参**

无（不需要参数）

#### `ble_stop_scan`

- **作用**：停止蓝牙扫描（复用同一颗按钮的路径）。写操作。
- **读/写**：**写**（会改状态）
- **返回**：{scanning:false, deviceCount}
- **注意**：同上：复用同一颗按钮的路径

**入参**

无（不需要参数）

#### `ble_connect`

- **作用**：连接一台 BLE 设备。给 addr 时：**扫描列表里有它**就点它的卡片再走「连接设备」（同一条路）；**列表里没有**就走「按 MAC 直连」（不依赖广播 —— 被 Windows 配对过、或被别的主机连走因而不广播的设备，只有这条路连得上）。不给 addr 就用面板当前选中的那台。**等连接真的成功才返回**（会带上服务数）。写操作。
- **读/写**：**写**（会改状态）
- **返回**：{pane, connected, addr, name, via, serviceCount, paired?}
- **注意**：`via=list`（扫描列表里点卡片连）/ `direct`（列表里没有 → 按 MAC 直连，**不依赖广播**）/ `selected`（用面板已选中的那台）。**等连接真的成功才返回**；需要配对时会弹出配对窗等用户确认

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `addr` | string | 否 | 设备 MAC，如 A4:C1:38:11:14:2B（省略=用面板已选中的设备） |

#### `ble_disconnect`

- **作用**：断开当前已连接的设备（面板那颗「断开设备」按钮的同一条路）。断开后服务树、订阅状态、本次会话的数据日志一并清空。写操作。
- **读/写**：**写**（会改状态）
- **返回**：{pane, connected:false, addr, changed}
- **注意**：断开后面板的服务树、订阅状态、本次会话数据日志一并清空（与点那颗「断开设备」按钮完全一样）

**入参**

无（不需要参数）

#### `ble_get_services`

- **作用**：当前已连接设备的 GATT 服务树（服务 UUID / 名称，每个服务下的特征 UUID、属性 props、描述符个数）。只读，取的是面板已经拉到的那份，不会重新去问设备。
- **读/写**：只读，无副作用
- **返回**：{connected, addr, serviceCount, services:[{uuid,name,chars:[{uuid,props,descs}]}]}
- **注意**：**取的是面板已经拉到的那份服务树**（不会重新去问设备）；还没连设备时 `note` 会说明

**入参**

无（不需要参数）

#### `ble_read`

- **作用**：读一个特征的值（按 UUID 寻址）——**点的是面板上那颗读按钮**，结果随后出现在 ble_get_output 里。需要设备已连接、且该特征有 read 属性（用 ble_get_services 看）。
- **读/写**：只读，无副作用
- **返回**：{pane, uuid, action, note}
- **注意**：按特征 UUID 寻址，**点的是面板上那颗读按钮**；结果随后出现在 ble_get_output 里。特征没有 read 属性时直接说清

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `char` | string | **是** | 特征 UUID（见 ble_get_services 的 services[].chars[].uuid） |

#### `ble_write`

- **作用**：往一个特征写数据（按 UUID 寻址）——**打开的就是面板那个写入窗并点「发送」**，HEX/文本解析、行尾、写响应/无响应全用面板那套（写入窗会留在界面上，数据日志里也能看到这一条）。需要设备已连接、且该特征有 write 属性（见 ble_get_services）。写操作。
- **读/写**：**写**（会改状态）
- **返回**：{pane, uuid, hex, bytes, writeType, format, lineEnding}
- **注意**：**打开面板那个写入窗并点「发送」**：HEX/文本解析、行尾、写响应/无响应全用面板那套（写入窗会留在界面上）。单次最多 `maxBleWriteChars` 个字符；特征的写入方式不支持时要的错误里会把可选值列出来

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `char` | string | **是** | 特征 UUID（见 ble_get_services 的 services[].chars[].uuid） |
| `data` | string | **是** | 要写入的内容；format=hex 时是十六进制串（如 01A0FF 或 01 A0 FF） |
| `format` | string | 否 | 枚举：`text` / `hex` 内容格式（省略=text） |
| `lineEnding` | string | 否 | 枚举：`none` / `cr` / `lf` / `crlf` 文本模式追加的行尾（省略=none，即原样写入 —— 协议帧最不容易被写坏） |
| `writeType` | string | 否 | 枚举：`write` / `write_without_response` 写响应 / 无响应（省略=用该特征的第一种；给了但该特征不支持会报错并把可选值列出来） |

#### `ble_subscribe`

- **作用**：开/关某个特征的通知订阅（notify / indicate）——点的是面板上那颗订阅按钮，数据随后出现在 ble_get_output 里。**状态已经在目标值时不会重复点**（不会把用户刚打开的订阅关掉）。
- **读/写**：**写**（会改状态）
- **返回**：{pane, uuid, prop, on, changed}
- **注意**：开/关通知订阅（notify/indicate）。**状态已经是目标值时不会重复点**（`changed:false`）—— 否则会把用户刚打开的订阅关掉

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `char` | string | **是** | 特征 UUID（见 ble_get_services 的 services[].chars[].uuid） |
| `on` | boolean | 否 | true=订阅、false=退订（省略=true） |

#### `ble_get_output`

- **作用**：读蓝牙面板**本次会话**的数据日志（连上之后收到的通知/读到的内容、发出的写，按时间排列；切设备或断开会清空）。要跨会话的完整历史就用返回里的 `channels.rx` 去 log_tail。**要"这条 ERROR 出现几次"别拉条目**：给 `pattern` + `mode`（与 `log_search` 同一套词汇）—— `count` 只回计数、`matches` 只回片段、`lines`（默认）回条目。匹配的文本取 `text`，`text` 为空时取 `hex`（HEX 通知也能搜）。只读。
- **读/写**：只读，无副作用
- **返回**：{pane, count, scanned, mode, total, channels:{rx}, items:[{seq,ts,kind,hex,text,dim}]}；`mode:"matches"` 时是 `hits:[{seq,ts,kind,match}]`，`mode:"count"` 时是 `total`/`totalMatches`（**都没有 items**），后两档另外带 `pattern`/`regex`
- **注意**：**本次会话的蓝牙数据日志**（切设备/断开就清空）。要跨会话用 `channels.rx` 去 log_tail；`sinceSeq` 增量跟进。**要"这条 ERROR 出现几次"别拉条目**：给 `pattern` + `mode`（`count` 只回计数、`matches` 只回片段）；匹配的文本取 `text`，`text` 为空时取 `hex`（HEX 通知也搜得到）

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `limit` | number | 否 | 只要最后 N 条（省略=全部） |
| `sinceSeq` | number | 否 | 增量：只要 seq 大于它的（与返回的 items[].seq 对齐） |
| `pattern` | string | 否 | 要检索的内容（字符串按**字面量**处理，regex=true 才是正则）。上限 512 字符 |
| `mode` | string | 否 | 枚举：`lines` / `matches` / `count` count=只回计数（最省）/ matches=只回匹配片段 / lines=条目本身（默认）。后两档**必须**给 pattern |
| `regex` | boolean | 否 | true 时 pattern 按正则解释，默认 false |
| `caseSensitive` | boolean | 否 | 默认 `false` 区分大小写；也接受旧拼写 case_sensitive |

#### `ble_refresh_rssi`

- **作用**：读当前已连接设备的信号强度（RSSI，负数，越接近 0 越强）。只问一次射频、不改状态；还没连设备时会直接说明。
- **读/写**：只读，无副作用
- **返回**：{addr, rssi, raw}
- **注意**：只问一次射频、不改状态；没连设备时直接报"先连上"

**入参**

无（不需要参数）

### ADB 语义工具（ADB shell）

#### `adb_list_devices`

- **作用**：列出 `adb devices -l` 看到的设备（序列号 / 状态 / 型号）。只读，不会开 shell。**只有 state=device 的那台才可用**；unauthorized 表示还没在设备上点「允许 USB 调试」。
- **读/写**：只读，无副作用
- **返回**：{total, ready, devices:[{serial,state,model,product}], note?}
- **注意**：**只有 `state=device` 的那台可用**（`unauthorized` 表示设备上还没点「允许 USB 调试」）。读的是 `adb devices -l` 的实时结果（与面板那颗「刷新」同一个命令），不吃面板 5 秒轮询的空窗

**入参**

无（不需要参数）

#### `adb_open_shell`

- **作用**：在设备上开一个交互式 shell 会话（等价于点面板上那台设备的卡片：建 xterm + PTY）。开之前先确认设备在且 state=device；**等 PTY 真的建出来才返回**（最长 10 秒）。⚠️ 危险动作（之后能在设备上执行任意命令），必须带 confirm:true；不带时不会执行并返回 -32006。开完用 adb_shell_write 发命令、adb_shell_read 读输出。
- **读/写**：只读，无副作用
- **返回**：{serial, opened, cols, rows, note?}
- **注意**：**危险动作**（开出来之后就能在设备上执行任意命令），必须带 `confirm:true`，否则不执行并回 `-32006`。开之前先确认设备 `state=device`（`serial` 省略=用第一台可用的）；**等 PTY 真的建出来才返回**（最长 10 秒），失败会如实说清是"这台机器没有可用设备"还是"serial 不存在"

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `serial` | string | 否 | 设备序列号（见 adb_list_devices；省略=用第一台 state=device 的设备） |
| `confirm` | boolean | 否 | 危险动作确认：必须为 true 才会执行 |

#### `adb_shell_write`

- **作用**：往已打开的 ADB shell 写入内容（与在面板终端里敲键盘同一条路：字节会进设备 shell 的 stdin）。**命令要自己带上 \n**，不带就只是填在命令行上不会执行。⚠️ 危险动作（写进去的内容会被设备真的执行），必须带 confirm:true。单次最多 4096 字符（mcp_limits.maxAdbWriteChars），超了报 -32602。
- **读/写**：只读，无副作用
- **返回**：{serial, written, bytes, data}
- **注意**：**危险动作**（写进去的内容会被设备真的执行），必须带 `confirm:true`。命令要自己带 `\n`，不带只是填在命令行上；单次最多 `maxAdbWriteChars` 个字符（超了 -32602）。走的就是面板终端敲键盘那条命令

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `data` | string | **是** | 要写入 shell 的内容，如 "ls -l\n" |
| `confirm` | boolean | 否 | 危险动作确认：必须为 true 才会执行 |

#### `adb_shell_read`

- **作用**：读 ADB shell 已经产生的输出（日志中心 adb:rx 通道：PTY 读线程在生产端旁路的一份副本，**不会抢走界面终端要显示的队列**）。**items 是 PTY 的输出块、不是按行切好的文本**（终端输出本来就没有行边界，ANSI 光标序列会跨块）。用 sinceSeq 增量跟进：下一次传返回 items 里最后一条的 seq。**`logcat` 刷屏时先别拉条目**：给 `pattern` + `mode`（与 `log_search` 同一套词汇）—— `mode:"count"` 只回"命中多少条/多少处"，`mode:"matches"` 只回命中片段，`mode:"lines"`（默认）回条目本身（给了 pattern 就只回命中的）。只读，不需要界面。
- **读/写**：只读，无副作用
- **返回**：{serial, channel, count, scanned, mode, items:[{seq,ts,level,dir,bytes,text}], truncated, dropped, mayBeIncomplete, note?}；`mode:"matches"` 时是 `hits:[{seq,ts,level,dir,match}]`，`mode:"count"` 时是 `total`/`totalMatches`（**都没有 items**），后两档另外带 `pattern`/`regex`
- **注意**：读日志中心 `adb:rx` —— PTY 读线程在**生产端**旁路的一份副本（**不会抢走界面终端要显示的队列**）。`items` 是 PTY 的**输出块**、不是按行切好的文本；`truncated=true` 表示凑满了一页（还有更多，用 `sinceSeq` 接着拉）；`mayBeIncomplete=true` 表示通道丢过最旧的行。**`logcat` 刷屏时先给 `pattern` + `mode`**：`count` 只回"命中多少块/多少处"（几十 token），`matches` 只回片段。**纯后端工具，没有界面也能用**

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `sinceSeq` | number | 否 | 只要 seq 大于它的行（增量跟进；省略=取尾部 limit 行） |
| `limit` | number | 否 | 最多回多少行，默认 200，上限 2000（mcp_limits.maxAdbReadLines） |
| `pattern` | string | 否 | 要检索的内容（字符串按**字面量**处理，regex=true 才是正则）。上限 512 字符 |
| `mode` | string | 否 | 枚举：`lines` / `matches` / `count` count=只回计数（最省）/ matches=只回匹配片段 / lines=条目本身（默认）。后两档**必须**给 pattern |
| `regex` | boolean | 否 | true 时 pattern 按正则解释，默认 false |
| `caseSensitive` | boolean | 否 | 默认 `false` 区分大小写；也接受旧拼写 case_sensitive |

#### `adb_shell_resize`

- **作用**：调整已打开 ADB shell 会话的 PTY 尺寸（与面板跟着容器尺寸自动推的是同一个后端命令）。cols/rows 都是 2~1000（mcp_limits.maxAdbCols / maxAdbRows）。注意：面板自己的尺寸同步（窗口/容器变化时）可能随后把它改回真实容器尺寸。写操作。
- **读/写**：**写**（会改状态）
- **返回**：{serial, cols, rows, note?}
- **注意**：`cols` / `rows` 都是 **2~1000**（`maxAdbCols` / `maxAdbRows`），越界或 0/1 → -32602。注意面板自己的尺寸同步（窗口/容器变化时）可能随后把 PTY 改回真实容器尺寸

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `cols` | number | **是** | 列数（2~1000） |
| `rows` | number | **是** | 行数（2~1000） |

#### `adb_close_shell`

- **作用**：关掉当前 ADB shell 会话（等价于点面板上会话的关闭：杀掉 adb shell 子进程 + 移除终端）。本来就没开会话时是幂等的（closed:false + note），不是错误。写操作。
- **读/写**：**写**（会改状态）
- **返回**：{serial, opened:false, closed, note?}
- **注意**：关掉当前会话（kill `adb shell` 子进程 + 移除终端）；本来就没开会话时是幂等的（`closed:false` + `note`），不是错误

**入参**

无（不需要参数）

### 安全与策略

#### `mcp_danger`

- **作用**：列出**需要二次确认**的危险工具（会对外产生不可撤销影响的那些）与各自的后果。调用它们时必须带 confirm:true，否则不会执行。只读。
- **读/写**：只读，无副作用
- **返回**：{tools:[{name, consequence, confirm}], total, note}
- **注意**：危险工具清单（会对外产生不可撤销影响的那些）。**先问后果再确认**：不带 confirm 调用它们不会执行

**入参**

无（不需要参数）

### 应用与服务器

#### `app_info`

- **作用**：本机 SeaHi Serial 应用的基本信息（版本、平台、进程、运行时长）。只读，无副作用。
- **读/写**：只读，无副作用
- **返回**：`{name, version, profile, os, arch, pid, uptimeSecs}`

**入参**

无（不需要参数）

#### `mcp_status`

- **作用**：MCP 服务器自身状态：是否运行、监听端点、会话数、请求数与限流/丢弃计数。只读。
- **读/写**：只读，无副作用
- **返回**：打码后的服务器状态：`running/enabled/host/port/streamableHttp/tokenMasked/sessions/statusEmits/readOnly/requests/dropped/toolCalls/registry/logHub/errorReports/callLog/limits/version/uptimeSecs`
- **注意**：**不含 token 与完整 URL**（`urlMasked` 与 `streamableUrlMasked` 只在服务器通过界面启动、确实绑定了端口时出现；**两条 URL 都打码**）；`streamableHttp` 为 false 时 `/mcp` 返回 404、只剩遗留 SSE；`statusEmits` 是"往前端推过多少次状态"，用来判断界面上的会话数是不是在更新；**`readOnly` 必须先看** —— 为 true 时所有写操作会被拒（-32007）

**入参**

无（不需要参数）

#### `mcp_limits`

- **作用**：MCP 服务器的硬性上限（会话数、队列深度、心跳、限流、超时等）。只读，用于判断会不会被限流。
- **读/写**：只读，无副作用
- **返回**：`{maxSessions, sessionQueue, heartbeatSecs, maxBodyBytes, maxUiSetItems, maxSendChars, toolsPage, idleTimeoutSecs, rateLimitPerMin, protocolVersion, protocolFallback, logMaxLineBytes, logTotalCapBytes, logMaxChannels, maxQuickCmdItems, maxQuickCmdLabelChars, maxQuickCmdValueChars, maxQuickCmdFileBytes, maxQuickCmdTimeoutMs, maxQuickCmdRetry, maxQuickCmdExpectChars, maxBleWriteChars, maxAdbWriteChars, maxAdbCols, maxAdbRows, maxAdbReadLines}`
- **注意**：用来判断会不会被限流/丢弃；**加新工具时这里也该有对应的一条上限**。注意"报出来"≠"被执行"：这几个数各自都有代码里真的拦一道（快速指令的 `maxQuickCmdTimeoutMs`/`maxQuickCmdRetry`/`maxQuickCmdExpectChars` 就是在碰界面之前校验的）

**入参**

无（不需要参数）

#### `serial_list_ports`

- **作用**：枚举本机可用串口（端口名 / 友好名称 / 产品名）。只读，不会打开端口。⚠️ **只有 Windows 侧的 COM 口** —— WSL 分栏的端口是 WSL 内部的 `/dev/...`，不在这里（用 serial_get_state 的 `portOptions` 看那个分栏能选什么）。返回 {count, ports:[…]}。
- **读/写**：只读，无副作用
- **返回**：`{count, ports:[{portName, friendlyName, productName}]}`
- **注意**：不会打开端口；**端口名在 `portName`**（字段一律驼峰，别去猜 `port_name`）。⚠️ **只列 Windows 侧的 COM 口** —— WSL 分栏的端口是 WSL 内部的 `/dev/...`，不在这里（用 `serial_get_state` 的 `portOptions`）

**入参**

无（不需要参数）

### 界面操作（走合成 DOM 事件，和用户点击同一条路径）

#### `ui_list`

- **作用**：列出界面上的可操控控件（按钮/输入框/下拉/开关）。每条给出 path、类型、面板、当前值、是否可用与不可用的原因。建议先用它枚举，再决定操作哪个。
- **读/写**：只读，无副作用
- **返回**：`{total, controls:[{path, kind, panel, group, label, enabled, disabledReason, value?, options?}], nextCursor?}`
- **注意**：`enabled=false` 时 `disabledReason` 会说明原因（如"串口未连接"）；建议先枚举再操作

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `panel` | string | 否 | 只看某个面板：serial / wsl / adb / ble / global / mcp / dialog |
| `kind` | string | 否 | 只看某种类型：button / toggle / select / text / number / checkbox / range |
| `query` | string | 否 | 按 path 或标签做子串匹配 |
| `cursor` | string | 否 | 分页游标（上一次返回的 nextCursor） |
| `limit` | number | 否 | 每页条数，默认 100，最大 500 |

#### `ui_describe`

- **作用**：看某个控件的完整信息与它的输入格式（inputSchema）：可选值有哪些、要传数字还是布尔。
- **读/写**：只读，无副作用
- **返回**：`{…控件公开字段…, description, inputSchema}`
- **注意**：等于"这个控件怎么用"的说明书

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | **是** | 控件路径，如 serial.conn.portSelect |

#### `ui_get`

- **作用**：读某个控件的当前值（实时从界面读，不是缓存的配置）。
- **读/写**：只读，无副作用
- **返回**：`{path, value, enabled, disabledReason}`

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | **是** |  |

#### `ui_set`

- **作用**：设置控件值。执行走的是与用户点击完全相同的路径，所以界面会同步变化。返回的是**写后的真实值**（控件可能规范化输入）。可用 items 一次设置多个。⚠️ 少数动作是「点了才开始跑」的 —— 典型是 WSL 端口映射那个复选框（要过 usbipd，可能要用户在机器上点授权框）：结果里会带 `mapRequest.settled=false` 与 `note`，**那时不要重试**，稍后用 ui_get_state{section:"wslDevices"} 看 status 是否变成 mapped。
- **读/写**：**写**（会改状态）
- **返回**：`{results:[{path, ok, notFound?, error?, from?, to?, mapRequest?}], effects:[{path, from, to}]}`（**单目标失败时不会有这个结构**：整个调用直接失败）
- **注意**：**会真的改界面**；支持批量 `items:[{path,value}]`（整批一次回执）；只给一个 `path`/`value` 时按**单目标语义**——失败即整次调用失败（路径不存在 → `-32602`；控件被禁用 → `isError`+`-32006`）。⚠️ 少数动作**点了才开始跑**（典型：WSL 端口映射那个复选框要过 usbipd、还可能弹授权框等用户点）—— 那时结果里会带 `mapRequest.settled=false` + `note`：**别重试**，稍后用 `ui_get_state{section:"wslDevices"}` 看 status 是否变成 `mapped`

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | 否 |  |
| `value` | any | 否 | 新值：文本/数字/布尔；下拉传选项的 data-val |
| `items` | array&lt;object&gt; | 否 | 批量设置：[{path, value}, …]（**一次最多 200 个**，这是硬上限：这条链路跑在界面主线程上，超了会报 -32602，请分批） |

#### `ui_click`

- **作用**：点一个按钮/开关（等价于 ui_set 传 true，但语义更清楚）。⚠️ 同 ui_set：WSL 端口映射那种「点了才开始跑」的控件会在结果里带 `mapRequest.settled=false`，别重试，去 ui_get_state{section:"wslDevices"} 复查。
- **读/写**：**写**（会改状态）
- **返回**：`{results:[{path, ok, notFound?, error?, mapRequest?}], effects:[…]}`（**单目标失败时不会有这个结构**：整个调用直接失败）
- **注意**：**会真的点下去**（例如"开始监控"）；用于 setter 够不到的动作；点击不存在/不可用的控件 → `-32602` / `isError`+`-32006`，**不会**假装成功。⚠️ 同 `ui_set`：WSL 端口映射那种"点了才开始跑"的动作会带 `mapRequest.settled=false`，**别重试**

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | **是** |  |

#### `ui_get_state`

- **作用**：读整个界面状态的快照（就是随用户配置持久化的那份：各监视器的端口/波特率/行尾/显示模式/开关、主题、蓝牙选中项等）。可用 section 只取子树。
- **读/写**：只读，无副作用
- **返回**：当前会话配置快照（与界面「保存配置」同一份真源）；**两张"运行时设备表"都要从它读**：`section:"bleDevices"` = 蓝牙扫描结果全量、`section:"wslDevices"` = WSL 端口映射的 USB 设备表（`{wslRunning, targetDistro, panelOpened, count, mapped, devices:[{busid, port, name, vidpid, hasCom, status, wslPath, wslSerial, busy, mapControlPath, autoMapControlPath}], note, mapUnavailableReason}`）—— 两处的行都是**动态 div、不在控件注册表里**，只有通用桥的客户端只能从这里读；`ble` 段里另带一份前 10 台的 `scanResult`

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `section` | string | 否 | 枚举：`serial` / `wsl` / `ble` / `bleDevices` / `wslDevices` / `theme` / `window` / `monitors` serial / wsl / ble / bleDevices / wslDevices / theme / window / monitors；省略=全部。**运行时设备表**（不是配置）：蓝牙扫描结果读 `bleDevices`（全量）或 `ble.scanResult`（前 10 台）；WSL 端口映射的 USB 设备表读 `wslDevices` —— 两处的行都是**动态 div、不在控件注册表里**，所以只有通用桥的客户端必须从这里读。`wslDevices` 每条还带 `mapControlPath`（可直接交给 ui_set 的控件路径），要映射某台设备就先用它把 COM 名对上 busid。 |

### 日志中心

#### `log_channels`

- **作用**：列出所有日志通道（条数 / 字节 / seq 区间 / 被丢弃条数 / 最后一条时间）。不确定去哪找日志时先调它。
- **读/写**：只读，无副作用
- **返回**：`{enabled, channelCount, channels:[{channel, lines, bytes, capBytes, seqFrom, seqTo, dropped, lastTs}], totalBytes, totalCapBytes, maxChannels, lockSkips, channelSkips, reclaims, reclaimedBytes}`
- **注意**：不确定去哪找日志时先调它

**入参**

无（不需要参数）

#### `log_tail`

- **作用**：取某个通道的尾部若干行。**读日志优先用 `format:"text"`** —— 一行一条纯文本，同样内容比默认的 json 省一半以上 token（实测短行日志 3.5 倍：101 字节/行 → 29 字节/行，短行的开销几乎全在每行的 JSON 包装上）；要逐行的结构化字段（seq/时间戳/字节数/方向）时才用 json。给了 `sinceSeq` 就是增量拉取：返回里的 `nextSinceSeq` 是**下次该带的值**（推进到它就不会漏也不会重复；直接跳到 `seqTo` 会把没拿到的行永远跳过），`missed>0` 表示这一段还有行没给你，`mayBeIncomplete=true` 表示该通道丢过最旧的行（别把日志当完整证据）。text 格式的日志正文在 content 文本里，structuredContent 只给元信息。
- **读/写**：只读，无副作用
- **返回**：`{channel, format, lines:[{seq, ts, level, dir, text, rawBytes}], returned, dropped, seqFrom, seqTo, missed, nextSinceSeq, mayBeIncomplete, truncated}`（`format:"text"` 时是 `{…, text}`，**没有再给 lines**）
- **注意**：**读日志优先用 `format:"text"`**：一行一条纯文本（头部一行元信息 + `[时刻] [级别] 正文`），同样数据比 json 省一半以上 token —— 实测 200 条短行 **101 字节/行 → 29 字节/行（3.5 倍）**，行越长省得越少。增量跟进用 `sinceSeq`，并把**返回里的 `nextSinceSeq`** 当下次的入参（**别直接跳到 `seqTo`**，那会跳过 `missed` 那些行）；`missed>0` = 这一段还有行没给你（含已被裁掉的），`mayBeIncomplete=true` = 该通道丢过最旧的行。text 格式的**正文在 content 文本里**，structuredContent 只给元信息（要逐行字段就用默认 json）。渠道名见 `log_channels`

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `channel` | string | **是** | 通道名，如 app / error / mcp / serial:main:rx / ble:rx / ui:sys |
| `lines` | number | 否 | 最多返回多少行，默认 100，上限 2000 |
| `sinceSeq` | number | 否 | 只取 seq 大于它的行（用于增量跟进）；也接受旧拼写 since_seq |
| `format` | string | 否 | 枚举：`json` / `text` 输出编码：text=一行一条纯文本（推荐，省 token）；json=逐行结构化对象（默认） |

#### `log_search`

- **作用**：在日志里检索（子串或正则）。不给 channel 就搜所有通道。**先想清楚要多少信息再选 `mode`**：`count` 只回计数（`total` + 有命中的通道各几次，几十 token —— 问"ERROR 出现过几次""到底有没有超时"就用它）；`matches` 只回匹配片段（一行里每处命中一条，只有 `match` 字段，长行日志用它比回整行省得多）；`lines`（默认）回命中行本身，另可用 `context` 带前后几行。每条命中都带 channel/seq，便于接着 log_tail 看上下文。⚠️ 要成段读某个通道就用 `log_tail{format:"text"}`，别把本工具当"读全部"用。
- **读/写**：只读，无副作用
- **返回**：`{pattern, regex, mode, hits:[{channel, seq, ts, level, dir, text, before?, after?}], scanned, truncated}`；`mode:"matches"` 时 `hits[]` 里是 `{channel, seq, ts, level, dir, match}`（**没有整行 text**）；`mode:"count"` 时是 `{pattern, regex, mode, total, channels:[{channel, count, scanned}], scanned, scannedChannels, truncated:false}`（**没有 hits**）
- **注意**：**三档按需要的信息量选**：`count` 只回计数（几十 token —— "ERROR 出现过几次""到底有没有超时"就用它）；`matches` 只回匹配片段（一行多处算多条，长行日志用它比回整行省得多）；`lines`（默认）回命中行，可配 `context` 0~5 带前后几行。不给 `channel` 就搜所有通道；`matches`/`count` 的图案同样按字面量处理（`+`/`(` 不用转义）

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `pattern` | string | **是** | 要找的内容（不能为空串；regex=true 时按正则解释） |
| `channel` | string | 否 | 限定通道；省略=全部 |
| `regex` | boolean | 否 | true 时 pattern 按正则解释，默认 false |
| `caseSensitive` | boolean | 否 | 默认 `false` 区分大小写；也接受旧拼写 case_sensitive |
| `limit` | number | 否 | 最多回多少条（matches 模式是**匹配处数**，一行多处算多条），默认 100，上限 500 |
| `mode` | string | 否 | 枚举：`lines` / `matches` / `count` 返回什么：count=只回计数（最省）/ matches=只回匹配片段（rg -o 那种）/ lines=命中行（默认） |
| `context` | number | 否 | 命中行前后各带几行（0~5，默认 0；**只对 mode:"lines" 有意义**） |

#### `log_stats`

- **作用**：各通道的概览：条数、字节、被丢弃条数、告警/错误数、时间跨度与平均行/秒。用来判断"是不是在刷屏"。
- **读/写**：只读，无副作用
- **返回**：`{enabled, channels:[{channel, lines, bytes, dropped, warnOrError, spanSecs, linesPerSec}], totalBytes, totalCapBytes, maxChannels, lockSkips, channelSkips, reclaims, reclaimedBytes}`
- **注意**：用来判断"是不是在刷屏"

**入参**

无（不需要参数）

#### `log_clear`

- **作用**：清空某个通道，或省略 channel 清空全部。
- **读/写**：**写**（会改状态）
- **返回**：`{clearedChannels, channel}`
- **注意**：省略 `channel` 清全部；**通道名不存在会报 -32602**（不静默成功）；清空后通道仍在，`log_tail` 返回 0 行而不是报错

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `channel` | string | 否 |  |

### 调用记录与配置

#### `mcp_calls`

- **作用**：查最近的工具调用记录（谁在什么时候调了什么、成没成、耗时多久、改动了哪些控件）。记录写在独立的 ai-calls.jsonl，不碰用户配置。
- **读/写**：只读，无副作用
- **返回**：`{calls:[{seq, ts, session, tool, args, ok, error, durationMs, effects}], returned, scanned, tailOnly, file, enabled, note}`
- **注意**：返回值默认不记（`includeResults` 打开才记）；只读文件尾部窗口 —— `tailOnly=true` 表示更早的记录**没被扫到**，`returned` 小于 `limit` 时别当成"历史上就这么多"（用 export 或直接读文件）

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `limit` | number | 否 | 最多返回多少条，默认 50，上限 2000 |
| `tool` | string | 否 | 只看某个工具 |
| `okOnly` | boolean | 否 | true 只看成功，false 只看失败；也接受旧拼写 ok_only |
| `format` | string | 否 | 枚举：`jsonl` / `md` jsonl（默认）或 md 表格 |

#### `mcp_stats`

- **作用**：调用统计：总次数、按工具分布、时间范围、记录文件大小与丢弃数。
- **读/写**：只读，无副作用
- **返回**：`{callLog:{totalCalls, seq, dropped, byTool, firstAt, lastAt, settings, enabled, file, fileBytes}, sessionToolCalls:{工具名: 次数}}`

**入参**

无（不需要参数）

#### `mcp_config_get`

- **作用**：读 MCP 自己的配置（服务器开关/端口/记录设置等）。token 只回打码值。
- **读/写**：只读，无副作用
- **返回**：`{server:{host, port, tokenMasked, …}, callLog:{…}, expose:{autoControlTools, namespaces, readOnly}, version}`
- **注意**：token 打码；`expose.readOnly` 是只读（沙箱）模式的开关状态

**入参**

无（不需要参数）

#### `mcp_config_set`

- **作用**：改 MCP 自己的配置。只支持 server 与 callLog 两类键（未知键会报错）。改 server.* 只保存、不立刻重启（需在界面里关闭再启用才生效）；不接受改 token。
- **读/写**：**写**（会改状态）
- **返回**：`{applied:[生效的键路径], needRestart:bool}`
- **注意**：只接受 `server` / `callLog` 两类键；**不接受改 token**；`host` 只允许回环；改 `server.*` 只保存，需在界面关闭再启用才生效

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `patch` | object | **是** | 例：{"callLog":{"includeResults":true}} 或 {"server":{"port":7778}} |

## 5. `ctl_*`：把每个界面控件都变成一个工具（可选）

默认**关闭**。打开 `expose.autoControlTools` 后，程序启动时会扫描界面上所有按钮 / 输入框 / 下拉框，
为每个控件生成一个 `ctl_*` 工具：

| | |
|---|---|
| 命名 | `ctl_` + 控件路径清洗（非字母数字转 `_`），总长 ≤ 64 字符，撞名加序号 |
| 路径 | `<面板>.<分组>.<控件名>`，如 `serial.conn.portSelect`；面板 ∈ `serial` / `wsl` / `adb` / `ble` / `global` |
| 入参 | 按控件类型派生：开关→`boolean`、数字输入→`number`、下拉→`enum`（**选项就是下拉里的真实选项**）|
| 不可用 | 控件当前不可用时，**原因写进工具描述**（如"串口未连接"），AI 不用盲试 |
| 上限 | 单次最多 400 个 `ctl_*`；`namespaces` 可只暴露某些面板 |
| 工具列表变化 | 控件增减时会推 `notifications/tools/list_changed`，客户端不必重连 |

> 为什么默认关闭：几百个工具会明显拖累模型选工具的准确率（见 `MCP_DESIGN.md` §5.6 D2）。
> 想按需使用：平时用 `ui_list` / `ui_get` / `ui_set`（按路径操作，只有 6 个工具），需要"每个控件一个工具"时再打开。

## 6. 错误语义

| 情况 | 表现 |
|---|---|
| 参数错误（缺必填 / 类型错 / 不存在的控件路径 / **取值不在可选集里**（如端口名给错）/ 不存在的日志通道 / 非法正则 / 未知工具名） | JSON-RPC `error.code = -32602`（`E_INVALID_PARAMS`）|
| 工具执行失败（控件被禁用、**前置状态没满足**（如没开监控就发数据）、写盘失败…） | 正常 `result` + `isError: true`，原因在文本内容里（**不是** JSON-RPC error）|
| 没有界面上下文（服务器脱离 GUI 跑，只有开发/测试会遇到） | `isError: true`，文本为 `错误 -32006: MCP 服务器没有界面上下文` |
| 前端桥超时（界面动作 5 秒没回执） | `-32004`（`E_UI_TIMEOUT`）|
| 前端桥在途请求过多 | `-32005`（`E_UI_BUSY`）|
| 超过 60 次/分 | `-32000`（`E_RATE_LIMITED`）|
| 工具内部 panic | `-32603`，消息里写明"已上报"；连接**不会**被打死，且会上报错误库 |
| `POST /mcp` 带的 `Mcp-Session-Id` 不认识（过期/被表满淘汰/伪造） | HTTP 404 + `session not found`（**不是** JSON-RPC 错误）；规范里客户端拿到 404 应当重新 `initialize` |
| `POST /mcp` 的 `MCP-Protocol-Version` 不认识 | HTTP 400，响应体里列出我们支持的版本（缺失该头按 2025-03-26 放行）|
| `POST /mcp` 带了非回环的 `Origin`（`http://evil.com` / `https://…` / `null`） | HTTP 403（防 DNS rebinding；不带 Origin 的 SDK/curl 不受影响）|
| token 不对 / 缺失 | HTTP 401（不是 JSON-RPC 层）|

## 7. 上限与安全边界

| 项 | 值 |
|---|---|
| 同时会话数 | 4，**两种传输共用一张表**：SSE 会话在流断开时立刻回收；HTTP 会话没有断连信号可依赖，靠 30 分钟空闲回收 + 客户端 `DELETE /mcp` |
| 表满时（HTTP 新建会话）| **淘汰最久未活动的 HTTP 会话**（客户端下次请求得 404 并重新 `initialize`，可恢复）；只有剩下的全是 SSE 会话时才回 429 —— 淘汰 SSE 会话会把它那条长连接变成收不到东西的僵尸 |
| 每会话出站队列 / 心跳 / 空闲回收 / 限流 | 256 条丢最旧 · 15s · 30 分钟 · 60 次/分 |
| 请求体上限 | 1 MiB |
| `ui_set` 单次 items | **200**（超了 -32602；这条链路跑在界面主线程上）|
| `ui_set` 单条 `value` | **8192 字符**（超了 -32602；只挡条数挡不住"一条巨型字符串"）|
| 快速指令 `value` / 组名 / 条目数 | 4096 / 64 字符 · 500 条（超长 -32602；**条目满了是 -32006**，先删几条）|
| `serial_send` 单次字符数 | **64K**（超了 -32602；串口写是排队的）|
| `ble_write` 单次字符数 | **4096**（超了 -32602；BLE 单次写受 MTU 限制）|
| `adb_shell_write` 单次字符数 | **4096**（超了 -32602；这一头是**设备的 shell**）|
| `adb_shell_resize` 的 `cols` / `rows` | **2~1000**（越界 / 0 / 1 都是 -32602）|
| `adb_shell_read` 一次行数 | 默认 200，上限 **2000** |
| 工具列表每页 | 50 |
| `ctl_*` 上限 | 400 |
| 日志单条 / 每通道 / 总量 / 通道数 | 8 KiB 截断 · 128 KiB~1 MiB · 16 MiB（超了裁最大通道）· 64 个 |
| 读日志的编码（`log_tail` / `serial_get_output`） | 默认 `json`（逐行 `seq/ts/t/level/dir/bytes/text`）；`format:"text"` 一行一条纯文本（头部一行元信息 + `[时刻] [级别/方向] 正文`）。**两种编码的数据与丢弃账完全一致**：`returned` / `seqFrom` / `seqTo` / `missed` / `dropped` / `mayBeIncomplete` / `truncated` / `nextSinceSeq` |
| 一次日志读取的行数 | `log_tail` 默认 100 · `serial_get_output` 默认 50 · `adb_shell_read` 默认 200，三者上限都是 **2000**（text 编码只改写法，不改这个上限） |
| `log_search` 的 `limit` / `context` | `limit` 默认 100、上限 **500**（`matches` 档算的是**匹配处数**，一行多处算多条）；`context` **0~5**，超了或配在非 `lines` 档上都是 -32602 |
| 检索图案 `pattern` 的长度 | **512 字符**（`maxSearchPatternChars`；`log_search` / `adb_shell_read` / `ble_get_output` 共用）—— 图案要被编译成正则，1 MiB 的请求体塞得进一条巨型正则，所以**在碰主程序之前**就拦 |
| 桥回执超时 / 在途上限 | **界面动作 5 秒**、设备动作 30 秒、`ble_connect` 130 秒 · 32 |
| `ble_list_devices` / `ui_get_state(bleDevices)` 每页 | 200 台（`limit` 只能是 **1~200**，0 与超限都是 -32602；要全量就**不给** limit，或用 `offset` 翻页）|

安全边界：

1. **只监听回环**，`server.host` 只接受 `127.0.0.1`/`::1`/`localhost`；
2. 必须带 token；`/healthz` 是唯一免鉴权端点且只回 `{"ok":true}`；`/status` 需 token 且**两条 URL 都打码**（`urlMasked` / `streamableUrlMasked`），绝不回显 token 与完整 URL；`/mcp` 另外校验 `Origin`（只放行回环）；
3. **工具不能改 token**（必须在界面点「重置令牌」）；
4. AI 记录写独立的 `ai-calls.jsonl`，**用户配置 `config.json` 里不会出现任何 AI 痕迹**；
5. 运行期错误走程序既有的错误上报（LogHub → 本地日志 → Sentry/自建服务），**上报前 token 打码**，同类错误 5 分钟只报一次；
6. **MCP 的运行不得拖慢主程序**：串口收发热路径上只有一次非阻塞的日志旁路（`try_lock`，拿不到锁就丢并计数），上报走独立线程的 channel，SSE 出站是「有界队列 + `try_send`」（生产者绝不阻塞，慢客户端直接断开），界面命令有在途上限（32）与**分档超时**（界面动作 5s、设备动作 30s、连接 130s —— 连接要等用户点配对弹窗，按 5s 算必然假失败），**所有外部输入都有上限**（见上表）。

## 8. 手测示例（curl）

**Streamable HTTP（推荐，新版客户端走这条）**

```bash
# 1) initialize：不带会话头，从**响应头**里拿 Mcp-Session-Id（-i 才会打印响应头）
curl.exe -i -X POST "http://127.0.0.1:7777/mcp?token=<TOKEN>" \
  -H "Content-Type: application/json" \
  -H "MCP-Protocol-Version: 2025-06-18" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"curl"}}}'
#   期望 HTTP 200 + content-type: application/json + 响应头 mcp-session-id: <SID>
#   ⚠️ 结果**就在这个响应体里**（不必像 SSE 那样另开一条流等）

# 2) 后续请求带上会话头（结果同样直接从响应回来）
curl.exe -i -X POST "http://127.0.0.1:7777/mcp?token=<TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: <SID>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"app_info"}}'

# 3) 通知：回 202 + 空体（规范要求，不是 200 加空 JSON）
curl.exe -i -X POST "http://127.0.0.1:7777/mcp?token=<TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: <SID>" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 4) 用完主动结束会话（立刻释放一个会话名额）
curl.exe -i -X DELETE "http://127.0.0.1:7777/mcp?token=<TOKEN>" -H "Mcp-Session-Id: <SID>"
#   期望 HTTP 204
```

**遗留 SSE（只支持 SSE 的老客户端走这条）**

```bash
# 0) 探活（不需要 token）
curl.exe -i http://127.0.0.1:7777/healthz

# 1) 建 SSE 会话，看首帧 endpoint（-N 关缓冲；这个连接要一直挂着）
curl.exe -N "http://127.0.0.1:7777/sse?token=<TOKEN>"
#   event: endpoint
#   data: /messages?sessionId=<SID>&token=<TOKEN>

# 2) 另开一个窗口，往上面那个 SID 发 JSON-RPC
curl.exe -i -X POST "http://127.0.0.1:7777/messages?sessionId=<SID>&token=<TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"curl"}}}'
#   期望 HTTP 202；结果从第 1 步的 SSE 流里出来

# 3) 列工具（同样 202，结果从 SSE 流回）
curl.exe -i -X POST "http://127.0.0.1:7777/messages?sessionId=<SID>&token=<TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 4) 调一个只读工具
curl.exe -i -X POST "http://127.0.0.1:7777/messages?sessionId=<SID>&token=<TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"app_info"}}'
```

## 9. 本页怎么校对

页面里的工具清单可以直接和运行中的服务器对账：

```bash
# 起一个自带 3 个假控件、固定 token=testtoken 的联调服务器（127.0.0.1:7799）
cargo test --manifest-path src-tauri/Cargo.toml mcp_serve_for_manual_check -- --ignored --nocapture

# 另开窗口，用任意 MCP 客户端（SDK / curl）列一下 tools/list，与本页 §4 逐个核对
```

本文档由 `node .walkthrough/gen_mcp_tools_doc.js` 生成（工具名/描述/入参直接读 `protocol.rs`，
所以改了工具定义后重跑一次就不会漂）。断言集里有一条守着"本页必须列出全部内置工具名"。
