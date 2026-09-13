# MCP 工具参考

> 本页的工具名 / 描述 / 入参**逐字取自** `src-tauri/src/mcp/protocol.rs` 的 `tool_defs()`；
> 「返回」列是对着**真实运行的服务**实调一遍抓下来的 `structuredContent` 结构，不是照记忆写的。
> 上手步骤见 [MCP.md](./MCP.md)，设计与取舍见 [MCP_DESIGN.md](./MCP_DESIGN.md)。

⚠️ 返回结构里**没有**的字段就是真的没有（例如串口项只有 `port_name / friendly_name / product_name`，没有 VID/PID）。

## 1. 怎么连

| | |
|---|---|
| 传输 | **只有 SSE**（HTTP+SSE）。没有 Streamable HTTP，因此只支持 Streamable HTTP 的客户端连不上 |
| 端点 | `GET /sse`（建立会话，首帧下发 `event: endpoint`）→ `POST /messages?sessionId=…`（发 JSON-RPC，结果从 SSE 流回）|
| 鉴权 | 每个请求都要带 token：`?token=…` 或 `Authorization: Bearer …`；`GET /healthz` 是唯一免鉴权端点，只回 `{"ok":true}` |
| 监听 | **只监听回环**（`127.0.0.1` / `::1` / `localhost`），不对外网/局域网开放 |
| 握手顺序 | 客户端必须先 `GET /sse` 拿到 endpoint，再 `POST` `initialize` → `notifications/initialized` → `tools/list` |
| 地址从哪来 | 程序弹窗里的「连接 URL」，或 `%APPDATA%\seahi-serial\mcp-endpoint.json` |

## 2. 怎么拿工具列表

- 运行时：`tools/list`（分页，每页 50，用 `nextCursor` 翻页）——这是**权威来源**，本页只是它的可读版本。
- `mcp_limits` / `mcp_status` 里的 `toolCount` / `builtinToolCount` 能看到数量。
- 内置工具 **33 个**；另有可选的 `ctl_*`（见 §4）。

## 3. 一页速查

| 工具 | 读/写 | 作用 |
|---|---|---|
| [`serial_get_state`](#serial-get-state) | 读 | 读某个串口分栏的完整状态：端口、波特率、帧格式(数据位/停止位/校验)、行尾、DTR/RTS、查看模式、行号/时间戳/回显/自动滚动/自动重连/终端模式、**是否正在监控**、输出行数与字节数、发送历史条数、以及全部分栏名。省略 pane 默认 main。**操作串口前先调它**。 |
| [`serial_select_port`](#serial-select-port) | **写** | 选串口分栏要用的端口（等价于在「端口」下拉里选一项）。值必须是 serial_list_ports 返回的端口名；给错会回列可选值。 |
| [`serial_set_baud`](#serial-set-baud) | **写** | 设置波特率（110..4000000）。等价于在「波特率」输入框里填值。 |
| [`serial_set_frame`](#serial-set-frame) | **写** | 设置串口帧格式：dataBits(5|6|7|8) / stopBits(1|2) / parity(none|odd|even)。至少给一个（在「更多设置」里）。**改帧格式只在未连接时有意义**，连接中请先 serial_close。 |
| [`serial_set_lines`](#serial-set-lines) | **写** | 设置 DTR / RTS 电平（布尔）。常用于让目标板复位（DTR 拉低）或进入下载模式。 |
| [`serial_set_display`](#serial-set-display) | **写** | 设置显示与行为开关：viewMode(text|hex)、lineEnding(crlf|lf|cr|none)、echo(消息回显)、lineNum(行号)、timestamp(时间戳)、autoScroll(自动滚动)、autoReconnect(自动重连)、terminalMode(终端模式)。至少给一个。 |
| [`serial_open`](#serial-open) | **写** | **开始监控**（等价于点「开始监控」按钮）。可以同时给 port/baud 一次设定，省两次调用。返回前会**确认真的连上**（最多等 6 秒）；失败会说明可能原因（端口被占用/设备拔出/驱动异常）。 |
| [`serial_close`](#serial-close) | **写** | 停止监控（等价于点「停止监控」），返回前确认已断开。 |
| [`serial_send`](#serial-send) | **写** | 往串口发数据。mode=hex 时 data 按十六进制字节解析（如 "01 03 00 00 00 02"），否则按文本发。lineEnding 可临时覆盖该分栏的行尾设置。需要该分栏已在监控中。 |
| [`serial_clear`](#serial-clear) | **写** | 清空该分栏的输出区内容（等价于点「清除内容」）。**只清界面显示，不动磁盘上的会话日志缓存文件。** |
| [`serial_get_history`](#serial-get-history) | 读 | 读该分栏的发送历史（最近的在前）。用来回看刚才发过什么，或复用上一条指令。 |
| [`serial_get_output`](#serial-get-output) | 读 | 读该分栏**实际收发的内容**（串口监视器的核心：设备刚才回了什么）。默认收+发都返回，按时间归并；每条带 dir 区分。数据取自日志中心，与 log_tail 是同一份存储；本工具额外的好处是**不需要你知道通道名**，且「还没收到数据」会返回空列表而不是报错。 |
| [`serial_quick_cmd`](#serial-quick-cmd) | 读 | 快速指令（发送栏右侧那个下拉）：不带 index 就**列出全部**（含每条是否已配内容）；给了 index 就**执行**第 index 条。 |
| [`app_info`](#app-info) | 读 | 本机 SeaHi Serial 应用的基本信息（版本、平台、进程、运行时长）。只读，无副作用。 |
| [`mcp_status`](#mcp-status) | 读 | MCP 服务器自身状态：是否运行、监听端点、会话数、请求数与限流/丢弃计数。只读。 |
| [`mcp_limits`](#mcp-limits) | 读 | MCP 服务器的硬性上限（会话数、队列深度、心跳、限流、超时等）。只读，用于判断会不会被限流。 |
| [`serial_list_ports`](#serial-list-ports) | 读 | 枚举本机可用串口（端口名 / 友好名称 / 产品名）。只读，不会打开端口。返回 {count, ports:[…]}。 |
| [`ui_list`](#ui-list) | 读 | 列出界面上的可操控控件（按钮/输入框/下拉/开关）。每条给出 path、类型、面板、当前值、是否可用与不可用的原因。建议先用它枚举，再决定操作哪个。 |
| [`ui_describe`](#ui-describe) | 读 | 看某个控件的完整信息与它的输入格式（inputSchema）：可选值有哪些、要传数字还是布尔。 |
| [`ui_get`](#ui-get) | 读 | 读某个控件的当前值（实时从界面读，不是缓存的配置）。 |
| [`ui_set`](#ui-set) | **写** | 设置控件值。执行走的是与用户点击完全相同的路径，所以界面会同步变化。返回的是**写后的真实值**（控件可能规范化输入）。可用 items 一次设置多个。 |
| [`ui_click`](#ui-click) | **写** | 点一个按钮/开关（等价于 ui_set 传 true，但语义更清楚）。 |
| [`ui_get_state`](#ui-get-state) | 读 | 读整个界面状态的快照（就是随用户配置持久化的那份：各监视器的端口/波特率/行尾/显示模式/开关、主题、蓝牙选中项等）。可用 section 只取子树。 |
| [`log_channels`](#log-channels) | 读 | 列出所有日志通道（条数 / 字节 / seq 区间 / 被丢弃条数 / 最后一条时间）。不确定去哪找日志时先调它。 |
| [`log_tail`](#log-tail) | 读 | 取某个通道的尾部若干行。给了 since_seq 就只取它之后的（增量拉取：不重复也不丢）。返回里 mayBeIncomplete=true 表示这个通道曾丢掉过最旧的行。 |
| [`log_search`](#log-search) | 读 | 在日志里检索（子串或正则）。不给 channel 就搜所有通道。返回命中行及其 channel/seq，便于继续 log_tail。 |
| [`log_stats`](#log-stats) | 读 | 各通道的概览：条数、字节、被丢弃条数、告警/错误数、时间跨度与平均行/秒。用来判断"是不是在刷屏"。 |
| [`log_clear`](#log-clear) | **写** | 清空某个通道，或省略 channel 清空全部。 |
| [`log_export`](#log-export) | 读 | 把若干通道的日志按时间归并成一段纯文本（带时间戳/通道/级别前缀）。本轮只返回文本，不写文件。 |
| [`mcp_calls`](#mcp-calls) | 读 | 查最近的工具调用记录（谁在什么时候调了什么、成没成、耗时多久、改动了哪些控件）。记录写在独立的 ai-calls.jsonl，不碰用户配置。 |
| [`mcp_stats`](#mcp-stats) | 读 | 调用统计：总次数、按工具分布、时间范围、记录文件大小与丢弃数。 |
| [`mcp_config_get`](#mcp-config-get) | 读 | 读 MCP 自己的配置（服务器开关/端口/记录设置等）。token 只回打码值。 |
| [`mcp_config_set`](#mcp-config-set) | **写** | 改 MCP 自己的配置。只支持 server 与 callLog 两类键（未知键会报错）。改 server.* 只保存、不立刻重启（需在界面里关闭再启用才生效）；不接受改 token。 |

> 「写」= 会改变程序状态（界面 / 日志缓存 / AI 配置）。AI 调用这些工具时请先确认意图。

## 4. 逐个工具

### 串口语义工具（**优先用这些**，比 ui_* 通用桥更准）

#### `serial_get_state`

- **作用**：读某个串口分栏的完整状态：端口、波特率、帧格式(数据位/停止位/校验)、行尾、DTR/RTS、查看模式、行号/时间戳/回显/自动滚动/自动重连/终端模式、**是否正在监控**、输出行数与字节数、发送历史条数、以及全部分栏名。省略 pane 默认 main。**操作串口前先调它**。
- **读/写**：只读，无副作用
- **返回**：{pane, isConnected, portName, port, baud, viewMode, lineEnding, sendAs, dataBits, stopBits, parity, dtr, rts, autoScroll, autoReconnect, lineNum, timestamp, echo, terminalMode, advOpen, outputLines, outputBytes, historyCount, panes}
- **注意**：**操作串口前先调它**；省略 pane 默认 main

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `pane` | string | 否 | 分栏名：main / extra-1 / extra-2 …；省略=main |

#### `serial_select_port`

- **作用**：选串口分栏要用的端口（等价于在「端口」下拉里选一项）。值必须是 serial_list_ports 返回的端口名；给错会回列可选值。
- **读/写**：**写**（会改状态）
- **返回**：{pane, applied:[{name,ok,from,to}]}
- **注意**：值必须是 serial_list_ports 里的端口名；给错 → 协议级 `-32602` 并**回列真实可选值**（来自界面下拉的选项），照着改就行

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `port` | string | **是** | 端口名，如 COM3 |
| `pane` | string | 否 | 分栏名，省略=main |

#### `serial_set_baud`

- **作用**：设置波特率（110..4000000）。等价于在「波特率」输入框里填值。
- **读/写**：**写**（会改状态）
- **返回**：同上
- **注意**：110..4000000；越界报 -32602

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `baud` | number | **是** | 波特率，如 115200 |
| `pane` | string | 否 | 分栏名，省略=main |

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
| `pane` | string | 否 | 分栏名，省略=main |

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
| `pane` | string | 否 | 分栏名，省略=main |

#### `serial_set_display`

- **作用**：设置显示与行为开关：viewMode(text|hex)、lineEnding(crlf|lf|cr|none)、echo(消息回显)、lineNum(行号)、timestamp(时间戳)、autoScroll(自动滚动)、autoReconnect(自动重连)、terminalMode(终端模式)。至少给一个。
- **读/写**：**写**（会改状态）
- **返回**：同上
- **注意**：viewMode/lineEnding/echo/lineNum/timestamp/autoScroll/autoReconnect/terminalMode

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
| `pane` | string | 否 | 分栏名，省略=main |

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
| `pane` | string | 否 | 分栏名，省略=main |

#### `serial_close`

- **作用**：停止监控（等价于点「停止监控」），返回前确认已断开。
- **读/写**：**写**（会改状态）
- **返回**：{pane, connected:false, state:{…}}
- **注意**：会等最多 3 秒确认已断开

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `pane` | string | 否 | 分栏名，省略=main |

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
| `pane` | string | 否 | 分栏名，省略=main |

#### `serial_clear`

- **作用**：清空该分栏的输出区内容（等价于点「清除内容」）。**只清界面显示，不动磁盘上的会话日志缓存文件。**
- **读/写**：**写**（会改状态）
- **返回**：{pane, cleared:true, outputLines}
- **注意**：**只清界面**，不动磁盘会话日志缓存

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `pane` | string | 否 | 分栏名，省略=main |

#### `serial_get_history`

- **作用**：读该分栏的发送历史（最近的在前）。用来回看刚才发过什么，或复用上一条指令。
- **读/写**：只读，无副作用
- **返回**：{pane, total, items:[…]}
- **注意**：最近的在前

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `limit` | number | 否 | 最多返回多少条，默认 20，上限 200 |
| `pane` | string | 否 | 分栏名，省略=main |

#### `serial_get_output`

- **作用**：读该分栏**实际收发的内容**（串口监视器的核心：设备刚才回了什么）。默认收+发都返回，按时间归并；每条带 dir 区分。数据取自日志中心，与 log_tail 是同一份存储；本工具额外的好处是**不需要你知道通道名**，且「还没收到数据」会返回空列表而不是报错。
- **读/写**：只读，无副作用
- **返回**：{pane, direction, isConnected, channels:{rx,tx}, count, items:[{seq,ts,dir,text,bytes}], truncated, note?}
- **注意**：**串口监视器的核心：读设备回了什么**。默认收+发按时间归并；数据与 `log_tail` 同一份存储，但**不需要你知道通道名**，且"还没收到数据"返回空列表 + note 而不是报错

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `pane` | string | 否 | 分栏名，省略=main |
| `direction` | string | 否 | 枚举：`rx` / `tx` / `both` 只要收(rx)/只要发(tx)/都要(both，默认) |
| `lines` | number | 否 | 最多返回多少行，默认 50，上限 2000 |

#### `serial_quick_cmd`

- **作用**：快速指令（发送栏右侧那个下拉）：不带 index 就**列出全部**（含每条是否已配内容）；给了 index 就**执行**第 index 条。
- **读/写**：只读，无副作用
- **返回**：{pane, items:[{index,label,value}], usable}
- **注意**：不带 index 只列；带 index 才执行（→ {pane, ran, label, value}）

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `index` | number | 否 | 要执行的快速指令下标（从 0 开始）；省略=只列不执行 |
| `pane` | string | 否 | 分栏名，省略=main |

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
- **返回**：打码后的服务器状态：`running/enabled/host/port/tokenMasked/sessions/requests/dropped/toolCalls/registry/logHub/errorReports/callLog/limits/version/uptimeSecs`
- **注意**：**不含 token 与完整 URL**（`urlMasked` 只在服务器通过界面启动、确实绑定了端口时出现）

**入参**

无（不需要参数）

#### `mcp_limits`

- **作用**：MCP 服务器的硬性上限（会话数、队列深度、心跳、限流、超时等）。只读，用于判断会不会被限流。
- **读/写**：只读，无副作用
- **返回**：`{maxSessions, sessionQueue, heartbeatSecs, maxBodyBytes, maxUiSetItems, maxSendChars, toolsPage, idleTimeoutSecs, rateLimitPerMin, protocolVersion, protocolFallback, logMaxLineBytes, logTotalCapBytes, logMaxChannels}`
- **注意**：用来判断会不会被限流/丢弃；**加新工具时这里也该有对应的一条上限**

**入参**

无（不需要参数）

#### `serial_list_ports`

- **作用**：枚举本机可用串口（端口名 / 友好名称 / 产品名）。只读，不会打开端口。返回 {count, ports:[…]}。
- **读/写**：只读，无副作用
- **返回**：`{count, ports:[{port_name, friendly_name, product_name}]}`
- **注意**：不会打开端口

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

- **作用**：设置控件值。执行走的是与用户点击完全相同的路径，所以界面会同步变化。返回的是**写后的真实值**（控件可能规范化输入）。可用 items 一次设置多个。
- **读/写**：**写**（会改状态）
- **返回**：`{results:[{path, ok, notFound?, error?, from?, to?}], effects:[{path, from, to}]}`（**单目标失败时不会有这个结构**：整个调用直接失败）
- **注意**：**会真的改界面**；支持批量 `items:[{path,value}]`（整批一次回执）；只给一个 `path`/`value` 时按**单目标语义**——失败即整次调用失败（路径不存在 → `-32602`；控件被禁用 → `isError`+`-32006`）

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | 否 |  |
| `value` | any | 否 | 新值：文本/数字/布尔；下拉传选项的 data-val |
| `items` | array&lt;object&gt; | 否 | 批量设置：[{path, value}, …]（**一次最多 200 个**，这是硬上限：这条链路跑在界面主线程上，超了会报 -32602，请分批） |

#### `ui_click`

- **作用**：点一个按钮/开关（等价于 ui_set 传 true，但语义更清楚）。
- **读/写**：**写**（会改状态）
- **返回**：`{results:[{path, ok, notFound?, error?}], effects:[…]}`（**单目标失败时不会有这个结构**：整个调用直接失败）
- **注意**：**会真的点下去**（例如"开始监控"）；用于 setter 够不到的动作；点击不存在/不可用的控件 → `-32602` / `isError`+`-32006`，**不会**假装成功

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | **是** |  |

#### `ui_get_state`

- **作用**：读整个界面状态的快照（就是随用户配置持久化的那份：各监视器的端口/波特率/行尾/显示模式/开关、主题、蓝牙选中项等）。可用 section 只取子树。
- **读/写**：只读，无副作用
- **返回**：当前会话配置快照（与界面「保存配置」同一份真源）

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `section` | string | 否 | 枚举：`serial` / `wsl` / `ble` / `theme` / `window` / `monitors` serial / wsl / ble / theme / window / monitors；省略=全部 |

### 日志中心

#### `log_channels`

- **作用**：列出所有日志通道（条数 / 字节 / seq 区间 / 被丢弃条数 / 最后一条时间）。不确定去哪找日志时先调它。
- **读/写**：只读，无副作用
- **返回**：`{enabled, channelCount, channels:[{channel, lines, bytes, capBytes, seqFrom, seqTo, dropped, lastTs}], totalBytes, totalCapBytes, maxChannels, lockSkips, channelSkips, reclaims, reclaimedBytes}`
- **注意**：不确定去哪找日志时先调它

**入参**

无（不需要参数）

#### `log_tail`

- **作用**：取某个通道的尾部若干行。给了 since_seq 就只取它之后的（增量拉取：不重复也不丢）。返回里 mayBeIncomplete=true 表示这个通道曾丢掉过最旧的行。
- **读/写**：只读，无副作用
- **返回**：`{channel, lines:[{seq, ts, level, dir, text, rawBytes}], returned, dropped, seqTo, mayBeIncomplete, truncated}`
- **注意**：给了 `since_seq` 就是增量拉取；`mayBeIncomplete=true` 表示该通道丢过最旧的行

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `channel` | string | **是** | 通道名，如 app / error / mcp / serial:main:rx / ble:rx / ui:sys |
| `lines` | number | 否 | 最多返回多少行，默认 100，上限 2000 |
| `since_seq` | number | 否 | 只取 seq 大于它的行（用于增量跟进） |

#### `log_search`

- **作用**：在日志里检索（子串或正则）。不给 channel 就搜所有通道。返回命中行及其 channel/seq，便于继续 log_tail。
- **读/写**：只读，无副作用
- **返回**：`{pattern, regex, scanned, hits:[{channel, seq, ts, level, text}], truncated}`
- **注意**：不给 `channel` 就搜所有通道

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `pattern` | string | **是** |  |
| `channel` | string | 否 | 限定通道；省略=全部 |
| `regex` | boolean | 否 | true 时 pattern 按正则解释，默认 false |
| `case_sensitive` | boolean | 否 | 默认 `false` |
| `limit` | number | 否 | 最多命中数，默认 100，上限 500 |

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

#### `log_export`

- **作用**：把若干通道的日志按时间归并成一段纯文本（带时间戳/通道/级别前缀）。本轮只返回文本，不写文件。
- **读/写**：只读，无副作用
- **返回**：`{channels, lines, text, truncated}`
- **注意**：只返回文本，不写文件

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `channels` | array&lt;string&gt; | 否 | 要导出的通道名；省略=全部通道 |
| `max_lines_per_channel` | number | 否 | 每个通道最多取多少行，默认 2000，上限 20000 |

### 调用记录与配置

#### `mcp_calls`

- **作用**：查最近的工具调用记录（谁在什么时候调了什么、成没成、耗时多久、改动了哪些控件）。记录写在独立的 ai-calls.jsonl，不碰用户配置。
- **读/写**：只读，无副作用
- **返回**：`{calls:[{seq, ts, session, tool, args, ok, error, durationMs, effects}], returned, file, enabled, note}`
- **注意**：返回值默认不记（`includeResults` 打开才记）；只读文件尾部窗口

**入参**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `limit` | number | 否 | 最多返回多少条，默认 50，上限 2000 |
| `tool` | string | 否 | 只看某个工具 |
| `ok_only` | boolean | 否 | true 只看成功，false 只看失败 |
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
- **返回**：`{server:{host, port, tokenMasked, …}, callLog:{…}, expose:{autoControlTools, namespaces}, version}`
- **注意**：token 打码

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
| 前端桥超时（界面 5 秒没回执） | `-32004`（`E_UI_TIMEOUT`）|
| 前端桥在途请求过多 | `-32005`（`E_UI_BUSY`）|
| 超过 60 次/分 | `-32000`（`E_RATE_LIMITED`）|
| 工具内部 panic | `-32603`，消息里写明"已上报"；连接**不会**被打死，且会上报错误库 |
| token 不对 / 缺失 | HTTP 401（不是 JSON-RPC 层）|

## 7. 上限与安全边界

| 项 | 值 |
|---|---|
| 同时会话数 | 4（客户端断开**立刻**回收，不等空闲超时）|
| 每会话出站队列 / 心跳 / 空闲回收 / 限流 | 256 条丢最旧 · 15s · 30 分钟 · 60 次/分 |
| 请求体上限 | 1 MiB |
| `ui_set` 单次 items | **200**（超了 -32602；这条链路跑在界面主线程上）|
| `serial_send` 单次字符数 | **64K**（超了 -32602；串口写是排队的）|
| 工具列表每页 | 50 |
| `ctl_*` 上限 | 400 |
| 日志单条 / 每通道 / 总量 / 通道数 | 8 KiB 截断 · 128 KiB~1 MiB · 16 MiB（超了裁最大通道）· 64 个 |
| 桥回执超时 / 在途上限 | 5 秒 · 32 |

安全边界：

1. **只监听回环**，`server.host` 只接受 `127.0.0.1`/`::1`/`localhost`；
2. 必须带 token；`/healthz` 是唯一免鉴权端点且只回 `{"ok":true}`；`/status` 需 token 且**不回显 token 与完整 URL**；
3. **工具不能改 token**（必须在界面点「重置令牌」）；
4. AI 记录写独立的 `ai-calls.jsonl`，**用户配置 `config.json` 里不会出现任何 AI 痕迹**；
5. 运行期错误走程序既有的错误上报（LogHub → 本地日志 → Sentry/自建服务），**上报前 token 打码**，同类错误 5 分钟只报一次；
6. **MCP 的运行不得拖慢主程序**：串口收发热路径上只有一次非阻塞的日志旁路（`try_lock`，拿不到锁就丢并计数），上报走独立线程的 channel，SSE 出站是「有界队列 + `try_send`」（生产者绝不阻塞，慢客户端直接断开），界面命令有在途上限（32）与超时（5s），**所有外部输入都有上限**（见上表）。

## 8. 手测示例（curl）

```bash
# 1) 探活（不需要 token）
curl.exe -i http://127.0.0.1:7777/healthz

# 2) 建 SSE 会话，看首帧 endpoint（-N 关缓冲；这个连接要一直挂着）
curl.exe -N "http://127.0.0.1:7777/sse?token=<TOKEN>"
#   event: endpoint
#   data: /messages?sessionId=<SID>&token=<TOKEN>

# 3) 另开一个窗口，往上面那个 SID 发 JSON-RPC
curl.exe -i -X POST "http://127.0.0.1:7777/messages?sessionId=<SID>&token=<TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"curl"}}}'
#   期望 HTTP 202；结果从第 2 步的 SSE 流里出来

# 4) 列工具（同样 202，结果从 SSE 流回）
curl.exe -i -X POST "http://127.0.0.1:7777/messages?sessionId=<SID>&token=<TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 5) 调一个只读工具
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
