# MCP 使用说明

> 面向使用者。设计与实现细节见 `MCP_DESIGN.md`；本文只讲"怎么用 / 出问题怎么办"。

## 1. 它是什么

SeaHi Serial 内置一个 **MCP（Model Context Protocol）服务器**，让 Claude Desktop / Claude Code / Cursor / VS Code 这类 AI 客户端可以直接：

- **读日志**（应用日志、错误、蓝牙通知、串口收发、界面提示）
- **枚举串口**、查应用与服务器状态
- **操控界面**（选端口、改波特率、切主题、点按钮……与你自己点效果完全一样）
- 回看**自己做过什么**（调用记录）

服务器**跑在应用进程内**，所以它能同时看到后端能力（串口/蓝牙）和界面状态 —— 这是外部独立进程做不到的。

## 2. 怎么开

**默认就开着。** 标题栏「风格」左边有个 MCP 图标：

| 状态点 | 含义 |
|---|---|
| 灰 | 未启用 |
| 绿 | 监听中（没有客户端连着） |
| 蓝 | 有客户端连着 |
| 红 | 启动失败（弹窗里会写原因） |

点图标打开弹窗：

- **一个切换按钮**：点一下开启，再点一下关闭（按钮文案会跟着变：关着时写"启用 MCP 服务器"、开着时写"关闭 MCP 服务器"）
- **连接 URL**：`http://127.0.0.1:7777/sse?token=…`（一键复制）
- **客户端配置**：可直接粘进客户端的 JSON 片段（一键复制）
- **安装提示词**：一段自然语言，粘给 AI 让它自己接上（一键复制）
- **重置令牌**：旧令牌立即失效，已粘贴的配置需要重新复制

> 只监听 `127.0.0.1`。默认端口 7777 被占用时会自动向后找（最多 20 个），**实际端口看弹窗**。

## 3. 怎么接到客户端

### 方式一：npm 安装器（推荐）

```bash
npx seahi-serial-mcp            # 写进"已经装了"的客户端配置
npx seahi-serial-mcp status     # 看应用在不在跑、各客户端配没配
npx seahi-serial-mcp uninstall  # 只移除它写的那一条
```

选项：`--client claude,claudecode,cursor,vscode`、`--url <url>`、`--dry-run`、`--json`。

**端口回退导致 URL 变了之后，重跑一次 `install` 就全修好了** —— 这是它比手工粘贴强的地方。

### 方式二：手工粘贴

把弹窗里的「客户端配置」粘进对应文件，或按下面自己写：

```json
{
  "mcpServers": {
    "seahi-serial": {
      "type": "sse",
      "url": "http://127.0.0.1:7777/sse?token=<弹窗里复制的完整 URL>"
    }
  }
}
```

常见位置（**以你本机实际为准**，`status` 会把候选路径打出来）：

| 客户端 | 位置 |
|---|---|
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Code | `~/.claude.json` |
| Cursor（全局） | `~/.cursor/mcp.json` |
| VS Code（工作区） | `<项目>/.vscode/mcp.json` |

改完**重启客户端**。

## 4. 有哪些工具

| 类别 | 工具 |
|---|---|
| **串口语义（推荐优先用这些）** | `serial_get_state`、`serial_select_port`、`serial_set_baud`、`serial_set_frame`、`serial_set_lines`、`serial_set_display`、`serial_open`、`serial_close`、`serial_send`、`serial_clear`、`serial_get_history`、`serial_quick_cmd` |
| 应用/服务器 | `app_info`、`mcp_status`、`mcp_limits`、`serial_list_ports` |
| 界面操作 | `ui_list`、`ui_describe`、`ui_get`、`ui_set`、`ui_click`、`ui_get_state` |
| 日志 | `log_channels`、`log_tail`、`log_search`、`log_stats`、`log_clear`、`log_export` |
| 记录与配置 | `mcp_calls`、`mcp_stats`、`mcp_config_get`、`mcp_config_set` |

**串口语义工具与通用界面桥的区别**：前者用"**分栏 + 语义字段**"寻址（`pane` = `main` / `extra-1` / …），
后者用"控件路径"。多开监视器时控件路径会撞名，所以**能用语义工具就别拼控件路径**。
推荐顺序：`serial_get_state` 看现状 → `serial_select_port` / `serial_set_baud` / `serial_set_frame` 设参数 →
`serial_open` 开始监控（会确认真的连上）→ `serial_send` 发数据 → `serial_get_history` / `log_tail` 回看。

通用的界面操作仍然留着兜长尾：`ui_list` 看有哪些控件 → `ui_describe` 看某个控件怎么填 → `ui_set`/`ui_click` 操作。
每个工具的完整入参与返回结构见 [`MCP_TOOLS.md`](./MCP_TOOLS.md)。

### `serial_quick_cmd`：快速指令（列表 / 执行 / 循环 / 增删改）

界面右侧那条"快速指令"分栏里的东西，都能从这里操作。列表**按循环组分段，一组一张表**；
每个动作都复用面板上那颗按钮走的**同一条代码路径**（不给 AI 另开一套）。

| 用法 | 传参 | 说明 |
|---|---|---|
| **列出来** | 什么都不传 | 每条含 `index`（按"组→组内"摊平的下标）、`group`/`groupIndex`/`itemIndex`、`value`、`seq`/`delayMs`/`hex`，以及可直接交给 `ui_set` 的 `domIds`；另给 `groups[]`（组名/条数/`on` 是否参与循环/`folded`）与 `loop`{on, planLength} |
| **执行一条** | `index` | 按**该条自己的 `hex`** 决定发文本还是 HEX（与主发送栏的模式无关） |
| **开关循环** | `action: "loop"`，`on` 可省（省=取反） | 循环顺序 = **组从上到下 → 组内顺序号**；没连串口、或整条链上没有 `seq>0` 的条目就**拒绝**并说明原因 |
| **加一条** | `action: "add"`，`group`（组序号/组名，可省=最后那组）、`value`、`seq`、`delayMs`、`hex` | 加完报告它落在 `index`、所属组与 `applied` |
| **改一条** | `action: "update"`，`index` + 要改的字段 | 至少给一个字段；`applied` 列出真正改动的项 |
| **删一条** | `action: "remove"`，`index` | 返回被删那条的组/内容/顺序号与剩余条数 |
| **组操作** | `action: "group"`，`op: "add"｜"remove"｜"rename"｜"move"｜"on"｜"fold"` | `group` 指定哪一组（序号/组名/组 id）；`rename` 给 `name`；`move` 给 `toIndex`（**组的上下顺序就是循环顺序**）；`on`/`fold` 给 `on` |

改列表会**同时写回它挂载的外部文件**（"文件即存储"）—— 文件格式（列名/别名、`## 组名` 抬头、注释、
写回规则、上限）见 [`QUICK_CMDS.md`](./QUICK_CMDS.md)。

### BLE 语义工具（`ble_*`，第一批）

蓝牙分栏那条链路也能从 MCP 走。与 `serial_*` 同构：**每个动作都复用面板那颗按钮的代码路径**。

| 工具 | 干什么 | 读/写 |
|---|---|---|
| `ble_get_state` | 是否在扫描、扫到几台、选中/已连哪台、服务树几个服务、订阅了几路、内嵌监视器开着没 | 读 |
| `ble_list_devices` | 已扫到的设备列表（MAC / 名称 / RSSI / 是否配对 / 是否选中） | 读 |
| `ble_start_scan` / `ble_stop_scan` | 开始 / 停止扫描（面板那颗按钮的同一条路径） | 写 |
| `ble_get_services` | 已连设备的 GATT 服务树（服务 → 特征 + 属性 props + 描述符数） | 读 |
| `ble_read` | 读一个特征的值（按 UUID 寻址，点的是面板那颗读按钮；结果进 `ble_get_output`） | 读 |
| `ble_write` | 往一个特征写数据（**打开面板那个写入窗并点「发送」**：HEX/文本、行尾、写响应/无响应全用面板那套；默认不补行尾） | 写 |
| `ble_subscribe` | 开/关某个特征的通知订阅（**状态已经对时不会重复点**） | 写 |
| `ble_connect` | 连接一台设备：给 MAC 时**列表里有就点卡片连、没有就按 MAC 直连**（不依赖广播）；不给就用面板选中的那台。**等真连上才返回** | 写 |
| `ble_disconnect` | 断开当前设备（服务树/订阅/本次会话日志一并清空，与那颗按钮完全一样） | 写 |
| `ble_get_output` | **本次会话**的蓝牙数据日志（收到的通知/读回的内容、发出的写）；要跨会话历史用 `channels.rx` 去 `log_tail` | 读 |
| `ble_refresh_rssi` | 已连设备的信号强度（只问一次射频，不改状态） | 读 |
| `ble_periph_status` | **从机**（本机当外设）状态：是否真的在对外广播、服务 UUID、特征数、可发现/可连接、手动应答、后端告警 | 读 |
| `ble_periph_start` | 按面板上已配置的服务/特征**对外广播** | **写 ⚠️ 危险** |
| `ble_periph_stop` | 停掉对外广播 | **写 ⚠️ 危险** |

#### 扫描结果怎么读（三条路，读的是同一份数据）

| 你是哪种客户端 | 怎么读 | 拿到什么 |
|---|---|---|
| 有 BLE 语义工具 | `ble_list_devices` | `structuredContent.devices[]`：**每台都有 MAC / 名称 / RSSI / 是否配对 / 是否选中**（全量或按页） |
| 只有通用桥（`ui_*`） | `ui_get_state` + `{"section":"bleDevices"}` | 同上（全量）；`{"section":"ble"}` 里另有一份前 10 台的 `scanResult` |
| 只想看文本 | 任意一条的 `content[].text` | **一行一台**：`共 105 台（第 1-20 台，扫描中）：5F:90:0F:46:28:28 -80dBm \| …（下一页 offset=20）` |

**设备多的时候要分页翻**（几十上百台别指望一次全塞进文本）：

```json
// 第 1 页（每页 20 台）
{"name": "ble_list_devices", "arguments": {"limit": 20, "offset": 0}}
// 返回里带 hasMore / nextOffset —— 直接拿 nextOffset 当下一页的 offset
{"name": "ble_list_devices", "arguments": {"limit": 20, "offset": 20}}
// 通用桥同理（只有 ui_* 的客户端也能翻页）
{"name": "ui_get_state", "arguments": {"section": "bleDevices", "limit": 20, "offset": 20}}
```

> 一页最多 200 台（超了报 `-32602`）；省略 `limit` 就是一次全给（响应体可能十几 KB）。
> 文本摘要只有 600 字预算、客户端可能还要再截一刀，所以**翻页看全**才是正路。
>
> ⚠️ **扫描还在进行时翻页会对不齐**：列表每 2 秒还在长，`offset` 是按"当前这份列表"数的，
> 所以可能重复或漏掉个别设备（真机实测：45 台翻 3 页，去重后 43 个不同 MAC）。
> 要一份稳定完整的名单，就先等扫描结束（`ble_get_state.scanning=false`）再翻页，或一次给个大 `limit`。

> ⚠️ 为什么要有第二条路：面板上的设备卡片是**动态生成的 div**，不在控件注册表里
> （注册表只收 button/input/select/textarea/`[onclick]`），所以一个**只有通用桥**的客户端
> 原先没有任何入口能读到扫描结果 —— 只能靠 `ui_list` 满面板找，然后得到"读不到"的结论。
>
> `ble_list_devices` 每次都会**现问一次后端**（不是读面板那个 2 秒轮询的缓存），
> 所以刚开完扫描立刻问也拿得到。

### 危险动作要二次确认（`confirm:true`）

有些动作**撤不回来**：对外广播（附近设备都能看到并连上来）、在别人的设备上执行命令、
动宿主机的硬件挂载。这些工具**不带 `confirm:true` 就不会执行**，返回 `-32006` 并说明后果：

```json
// 先问清有哪些危险动作与各自的后果
{"name": "mcp_danger"}
// 想清楚再动手（不带 confirm 的调用什么都不会发生）
{"name": "ble_periph_start", "arguments": {"confirm": true}}
```

- 普通工具**不需要** `confirm`（传了也会被忽略）—— 别把"确认"当成万能钥匙
- **只读模式优先**：用户开了只读（沙箱）时，危险工具连确认也不给过（`-32007`）

### 想让"每个控件都是一个工具"？

默认关闭。打开后界面上每个按钮/输入框/下拉都会生成一个独立工具（名字形如 `ctl_serial_conn_portselect`）：

```json
// 让 AI 调 mcp_config_set：
{ "patch": { "expose": { "autoControlTools": true } } }
```

也可以只暴露某个面板：`{"expose":{"autoControlTools":true,"namespaces":["serial"]}}`。

> 默认关闭的原因：工具列表要进 AI 的上下文，几百个工具会明显拖累它选工具的准确率。

### 同一份数据的多条入口（该用哪条）

有几处**看着重复**，它们是故意的：语义工具与通用桥读同一份状态，便捷入口与日志中心读同一份存储。
照这张表挑，别挨个试：

| 数据 / 动作 | 入口 | 用哪条 |
|---|---|---|
| 串口分栏状态 | `serial_get_state` · `ui_get_state{section:"serial"}` | 有 `serial_*` 就用前者（字段名/默认分栏都更准） |
| 蓝牙状态 | `ble_get_state` · `ui_get_state{section:"ble"}` | 同上，优先 `ble_get_state` |
| **扫描结果（名称/MAC/RSSI）** | `ble_list_devices` · `ui_get_state{section:"bleDevices"}` | 有语义工具用前者；**工具列表还没刷新**的客户端用后者（两者都留着就是为了这个） |
| **实际收发内容** | `serial_get_output` / `ble_get_output` · `log_tail`（要通道名） | 先用前两个：不用知道通道名，且"还没收到数据"返回空列表而不是报错；要跨会话 / 更多行再 `log_tail` |
| 某个控件 | `ui_list` → `ui_describe` → `ui_get`/`ui_set`/`ui_click` | 枚举 → 看格式 → 操作 |
| 点按钮 / 开关 | `ui_click{path}` **≡** `ui_set{path, value:true}` | **真的是同一条实现**（`click` 只是把 value 强制成 true）。留两个是让模型选工具更少出错，挑一个用即可 |
| 日志通道概览 | `log_channels` · `log_stats` | `log_stats` 信息更全（速率/跨度/告警数）；两者都列通道 |
| 调用记录 | `mcp_calls`（明细）· `mcp_stats`（按工具统计）· `mcp_status.callLog`（计数） | 查"谁调了什么"用 `mcp_calls`，看趋势用 `mcp_stats` |

#### 看着像重复、其实不是（别搞混）

| A | B | 区别 |
|---|---|---|
| `serial_clear`（清**界面**输出区） | `log_clear`（清**日志中心**某通道的缓存） | 一个动屏幕，一个动缓存；`serial_clear` 动不了通道，`log_clear` 清不掉屏幕上的字 |
| `serial_get_history`（**自己发过**的指令，来自发送框历史） | `serial_get_output`（**链路上实际收发**了什么，含设备回包） | 前者"我发过什么"，后者"实际发生了什么" |
| `serial_quick_cmd{index}`（发**列表里存着**的那条，带它自己的 hex/延时/顺序号） | `serial_send`（发**临时**数据） | 前者参与循环、会写回外部文件；后者一次性 |
| `ble_get_state`（面板内存快照，便宜） | `ble_list_devices`（**现问后端**，最新） | 只要"扫没扫/连没连"用前者；要最新设备列表用后者 |

## 5. 日志与记录写在哪

| 文件 | 内容 |
|---|---|
| `%APPDATA%\seahi-serial\ai-config.json` | MCP 自己的设置（开关/端口/token/记录设置/暴露策略） |
| `%APPDATA%\seahi-serial\ai-calls.jsonl` | **每次工具调用一行**（含"改动了哪些控件"），按大小轮转 |
| `%APPDATA%\seahi-serial\mcp-endpoint.json` | 端点发现文件（应用在跑时才有） |
| `%APPDATA%\seahi-serial\config.json` | **你的设置**（与 MCP 完全无关，AI 不会往里写任何东西） |

日志是**内存里的环形缓冲**，有上限、会丢最旧的，并且会明确告诉你丢了多少（`log_channels` 里的 `dropped`）。要长期留存的会话内容看 `log-cache\` 目录或界面的日志缓存。

## 6. 上限（`mcp_limits` 也能查）

| 项 | 值 |
|---|---|
| 同时会话数 | 4 |
| 每会话出站队列 | 256 条（满了丢最旧并计数） |
| 心跳 | 15 秒 |
| 会话空闲回收 | 30 分钟 |
| 限流 | 60 次/分/会话 |
| 请求体上限 | 1 MiB |
| 工具列表每页 | 50 |
| `ctl_*` 工具上限 | 400 个 |
| 前端桥回执超时 | 5 秒（在途上限 32） |
| 日志单条上限 | 8 KiB（超过截断并留标记） |
| 日志每通道上限 | 128 KiB ~ 1 MiB（按通道类型） |
| **日志总量上限** | **16 MiB**（各通道另有更小的上限；超了会裁掉最大通道的旧日志，回收次数与回收字节数在 `log_stats` 里能看到） |
| 日志通道数上限 | 64（到顶后新通道不再创建，丢弃条数计入 `channelSkips`） |

## 7. 排错

| 现象 | 处理 |
|---|---|
| 客户端连不上 | 看弹窗状态点是不是绿的；`npx seahi-serial-mcp status` 看端点是否指向当前 URL（端口回退后要重跑 install） |
| 图标是红的 | 弹窗里会写失败原因（通常是端口全被占用） |
| 工具调用报"没有界面上下文" | 说明 MCP 是脱离 GUI 跑的（只有开发/测试会出现）；正常启动不会 |
| 工具调用报"控件不可用" | 那是真的不可用，`ui_list` / `ui_describe` 会给出原因（比如"串口未连接"） |
| 日志看不全 | 该通道丢过最旧的（`dropped` > 0）；`log_tail` 返回里 `mayBeIncomplete` 为 true 就是这种情况。另外 `log_stats` 里的 `reclaims`/`channelSkips` 分别代表"全局回收触发过几次""通道数到顶被丢了多少条" |
| 想彻底关掉 | 弹窗点「关闭 MCP 服务器」；它会同时释放端口并清空日志中心的内存 |
| 担心 AI 改坏我的设置 | AI 改的是设置**值**（和你自己改一样会持久化），但**"是谁改的、改了什么"记录在 `ai-calls.jsonl`**；`config.json` 里不会有 AI 痕迹 |
| 客户端里工具列表是旧的 | 控件增减时服务器会主动推 `notifications/tools/list_changed`；若你的客户端不支持这条通知，重新连一次即可 |

### 端点一览（自己排查时用）

| 端点 | 鉴权 | 用途 |
|---|---|---|
| `GET /healthz` | 不需要 | 探活，**只回 `{"ok":true}`**（不泄露版本等任何信息） |
| `GET /status` | **需要 token** | 服务器详情（运行状态、端口、会话数、工具数、丢弃统计……）。返回里 **token 与完整 URL 都会打码** |
| `GET /sse` | **需要 token** | 建立 SSE 会话，首帧下发 `event: endpoint`（后续请求的投递地址） |
| `POST /messages` | **需要 token** | 按 JSON-RPC 发请求，结果通过已建立的 SSE 流回传 |

token 可放在查询串（`?token=…`）或 `Authorization: Bearer …` 请求头里。`/healthz` 之外的任何端点缺 token 或 token 错误一律回 **401**。

## 8. 安全边界

1. **只监听回环地址**，不能配置成对外网/局域网开放（配置接口会拒绝非回环的 host）。
2. **必须带 token**；`/healthz` 是唯一不需要 token 的端点，且只回 `{"ok":true}`，不泄露任何信息；`/status` 虽然能看详情，但也**不回显 token 与完整 URL**。
3. **工具不能修改 token** —— 必须由你在界面点「重置令牌」。
4. **AI 记录与用户配置严格分文件**（`ai-calls.jsonl` 与 `config.json` 互不相干，有自动化断言守着）。
5. 危险工具（发数据、开串口、连蓝牙等）的**二次确认**尚未实现，属于后续工作（见 `MCP_DESIGN.md` §9）。
6. **运行期错误会上报到错误收集服务**（同一套错误上报通道：LogHub 的 `error` 通道 → 本地日志 → Sentry → 自建服务/SQLite）。上报内容**不含 token**（自动打码），同类错误 5 分钟内只报一次。Debug 构建沿用隐私默认：没设 `ERROR_SERVER_URL` 就只在本地留痕、不外发。状态里的 `errorReports` 能看到报了多少条、被去重挡了多少次。
