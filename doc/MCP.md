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

- **最上面一行挤着三个控件**（从左到右）：
  1. **开关按钮**：点一下开启，再点一下关闭（文案跟着状态变：关着时"启用 MCP 服务器"、开着时"关闭 MCP 服务器"）；
  2. **传输下拉框**：`HTTP` / `SSE` / `All`（详见下面一条）；
  3. **只读模式按钮**：文案**始终是「只读模式」**，当前是开是关**不写在按钮上** —— 见下面的说明区。
     打开后 AI 只能读、不能改（见 §8）。

  最右边是**重置令牌**。
- **说明区（就在这一行下面那块）**：把鼠标**停在**上面任一控件上约半秒，它的说明就显示在这块里；
  移开即消失。说明会**按行排开**（长内容分几行显示），所以不会像系统默认的悬停提示那样一条横跨整个窗口。
  "鼠标只是划过"时什么都不会弹 —— 这是有意的（否则鼠标扫过一排按钮会一闪一闪）。
  只读模式当前是开是关，也是在这里看（"只读模式：开 —— AI 只能看……" / "只读模式：关 —— ……"）。
- **传输选择（就是那颗下拉框）**：`HTTP` / `SSE` / `All`
  - **All**（默认）：两条都提供 —— 老客户端走 `/sse`、新客户端走 `/mcp`，兼容性最好；
  - **HTTP**：只服务 Streamable HTTP，`/sse` 与 `/messages` 立刻变成 404（只支持 SSE 的老客户端会连不上）；
  - **SSE**：只服务遗留 SSE，`/mcp` 立刻变成 404（只认 Streamable HTTP 的新版客户端会连不上）。

  切换**立即生效**（不用重启服务器）。三个选项各自的后果写在上面那块**说明区**里（界面上不再摆灰字提示），
  切换成功/失败各有一条 toast 说明结果。地址与客户端配置只展示**当前选中的那一种**。
  升级上来的配置默认是"两种都提供"—— **不会因为升级把任何一类客户端挡在门外**。
- **连接地址与客户端配置**：只展示**当前档位确实提供**的那些（单档时只有一块），各带一键复制：
  - **Streamable HTTP**：`http://127.0.0.1:7777/mcp?token=…` ← 新版客户端用这个（VS Code / Cline / 新版 Cursor / Claude Code）
  - **遗留 SSE**：`http://127.0.0.1:7777/sse?token=…` ← 只支持 SSE 的老客户端用这个
- **安装提示词**：可直接粘给 AI 的 JSON 片段 / 一段自然语言（各自一键复制）
- **重置令牌**：旧令牌立即失效，已粘贴的配置需要重新复制

> 只监听 `127.0.0.1`。默认端口 7777 被占用时会自动向后找（最多 20 个），**实际端口看弹窗**。

> 两种传输**共用同一套工具与同一张会话表**（上限 4 个），所以"用哪个连"不会改变 AI 能做什么。

## 3. 怎么接到客户端

### 方式一：npm 安装器（推荐）

```bash
npx seahi-serial-mcp            # 写进"已经装了"的客户端配置
npx seahi-serial-mcp status     # 看应用在不在跑、各客户端配没配
npx seahi-serial-mcp uninstall  # 只移除它写的那一条
```

选项：`--client claude,claudecode,cursor,vscode`、`--url <url>`、`--transport sse|http`、`--dry-run`、`--json`。

> **传输怎么选**：默认 `--transport sse`（不改既有行为）。新版客户端默认只走 Streamable HTTP，
> 它们连不上时加 `--transport http`；这条会用发现文件里的 `urlStreamable` 并写成 `"type": "http"`。
> 少数客户端（**Cline 等**）认的字段是 `"type": "streamableHttp"`，那种情况手工改一下 type 即可。

**端口回退导致 URL 变了之后，重跑一次 `install` 就全修好了** —— 这是它比手工粘贴强的地方。

### 方式二：手工粘贴

把弹窗里的「客户端配置」粘进对应文件，或按下面自己写。

**新版客户端（推荐）—— Streamable HTTP：**

```json
{
  "mcpServers": {
    "seahi-serial": {
      "type": "http",
      "url": "http://127.0.0.1:7777/mcp?token=<弹窗里复制的完整 URL>"
    }
  }
}
```

**只支持 SSE 的老客户端：**

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

⚠️ 各家客户端对 http 传输的 `type` 写法不一致（`http` / `streamableHttp`）。**写错的典型表现是客户端
静默按遗留 SSE 去解析**，然后给你一句没头没尾的"连不上" —— 拿不准就看弹窗里那句提示。
token 放在 URL 里是为了兼容"只会填 url、不会填 headers"的客户端；`Authorization: Bearer` 同样认。

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
| **串口语义（推荐优先用这些）** | `serial_get_state`、`serial_select_port`、`serial_set_baud`、`serial_set_frame`、`serial_set_lines`、`serial_set_display`、`serial_open`、`serial_close`、`serial_send`、`serial_clear`、`serial_get_history`、`serial_quick_cmd`、`serial_workflow`、`serial_workflow_run` |
| **蓝牙语义** | `ble_get_state`、`ble_list_devices`、`ble_start_scan`、`ble_stop_scan`、`ble_connect`、`ble_disconnect`、`ble_get_services`、`ble_read`、`ble_write`、`ble_subscribe`、`ble_get_output`、`ble_refresh_rssi`、`ble_cts_time` |
| **ADB 语义** | `adb_list_devices`、`adb_open_shell`、`adb_shell_write`、`adb_shell_read`、`adb_shell_resize`、`adb_close_shell` |
| 应用/服务器 | `app_info`、`mcp_status`、`mcp_limits`、`serial_list_ports` |
| 界面操作 | `ui_list`、`ui_describe`、`ui_get`、`ui_set`、`ui_click`、`ui_get_state` |
| 日志 | `log_channels`、`log_tail`、`log_search`、`log_stats`、`log_clear` |
| 记录与配置 | `mcp_calls`、`mcp_stats`、`mcp_config_get`、`mcp_config_set` |

**串口语义工具与通用界面桥的区别**：前者用"**分栏 + 语义字段**"寻址（`pane` = `main` / `extra-N` 为 Windows 分栏，
`wsl` / `wsl-xN` 为 WSL 分栏；省略 `pane` 即 `main`），后者用"控件路径"。多开监视器时控件路径会撞名，
所以**能用语义工具就别拼控件路径**。

**Windows 分栏与 WSL 分栏共用同一套 `serial_*` 工具**（这是刻意的：两边功能完全一样，没有 `wsl_serial_*`），
靠 `pane` 区分 —— 差异只在数据来源：Windows 侧是本机 COM 口（`list_ports` / `open_port`），
WSL 侧是 WSL 里的设备（`get_wsl_serial_devices` / `open_wsl_serial`）。所以 `serial_open` 在 WSL 分栏上
**不会**拿"本机有没有 COM 口"卡你：把 USB 串口 `usbipd bind` 进 WSL 之后 Windows 侧本来就没有那个口，
那是 WSL 用户的常态。

**选端口前先看 `portOptions`**：`serial_get_state` 会带回**这个分栏**当前能选的端口
（Windows 分栏是 `COM3` 这样的名字，WSL 分栏是 `/dev/ttyUSB0` 这样的 WSL 内部路径；`inUse` 表示被别的分栏占着）。
**别拿 `serial_list_ports` 当依据** —— 它只列 Windows 的 COM 口，对 WSL 分栏是误导。

推荐顺序：`serial_get_state` 看现状（含 `portOptions`）→ `serial_select_port` / `serial_set_baud` / `serial_set_frame`
设参数 → `serial_open` 开始监控（会确认真的连上）→ `serial_send` 发数据 → `serial_get_history` / `log_tail` 回看。

通用的界面操作仍然留着兜长尾：`ui_list` 看有哪些控件 → `ui_describe` 看某个控件怎么填 → `ui_set`/`ui_click` 操作。
每个工具的完整入参与返回结构见 [`MCP_TOOLS.md`](./MCP_TOOLS.md)。

### 把 USB 串口映射进 WSL（一条完整的链路）

"打开 WSL 端口映射 → 把 COM7 映射进去 → 开那个分栏的串口 → 抓 log"整条链路可以全交给 AI，四步：

| 步 | 调用 | 说明 |
|---|---|---|
| 1 | `ui_click{"path":"global.ui.wslToggleBtn"}` | 打开 WSL 端口映射面板（**设备表是懒加载的**，不打开就还没去问 `usbipd`） |
| 2 | `ui_get_state{"section":"wslDevices"}` | 读 USB 设备表：`{busid, port, name, vidpid, hasCom, status, wslPath, wslSerial, busy, mapControlPath, autoMapControlPath}`。**`port` 就是 Windows 侧的 COM 名**（用户嘴里的"把 COM7 映射进去"靠它对上号），`mapControlPath` 是可直接交给 `ui_set` 的控件路径 —— 不用自己算 |
| 3 | `ui_set{"path":<mapControlPath>,"value":true}` | 映射/取消映射（`value:false` 取消）。⚠️ **这是"点了才开始跑"的动作**：要过 `usbipd`（几十秒），需要管理员权限时还会弹出授权框**等用户在机器上点确认**。所以回执里带的是 `mapRequest.settled=false` + `note` —— **别重试**，回到第 2 步看 `status` 是否变成 `mapped` |
| 4 | `serial_get_state{"pane":"wsl"}` → `serial_select_port` → `serial_open{"pane":"wsl"}` → `serial_get_output{"pane":"wsl"}` | 映射完成后 WSL 分栏的端口里才会出现 `/dev/ttyUSB0`；`serial_open` 在 WSL 分栏上**不受"本机有没有 COM 口"影响** |

`section:"wslDevices"` 还带 `wslRunning`（WSL 没运行的话映射复选框是灰的，`ui_set` 会拒绝并说明原因）
与 `panelOpened`（面板没打开过时设备表是空的，`note` 会说下一步 —— 别误判成"这台机器没有 USB 设备"）。

> 与蓝牙那边是同一个套路：设备行都是**动态 DOM、不在控件注册表里**，所以都有专门的
> `section`（`bleDevices` / `wslDevices`）让只配了通用桥的客户端也读得到。

### AI 动手时界面会自己切页（写切、读不切）

用户要**看得见 AI 在干什么**，所以规则是：

| 调用 | 界面 |
|---|---|
| 通用桥 `ui_set` / `ui_click`（含上面第 3 步的映射） | **先切到目标面板**，再改控件 |
| 语义工具 `serial_*` 的**写**动作（`serial_select_port`/`serial_set_*`/`serial_open`/`serial_send`/`serial_clear`/`serial_quick_cmd` 的改列表与执行…） | **先切到该 `pane` 所在的面板** |
| 语义工具 `serial_*` / `ble_*` 的**只读**动作（`serial_get_state`/`serial_get_output`/`ble_list_devices`…） | **一个页面都不切** |

只读不切是故意的：客户端一轮询就把用户从当前页面拽走，比"看不见"更烦人。

**顺带解决一件 AI 会困惑的事**：WSL 分栏（和额外监视器）是**懒创建**的 —— WSL 分栏要等端口映射面板
第一次打开才存在。所以在面板没打开过时：

- **写操作会自动把它建出来**（切页这一步就是创建它的那一步），所以 `serial_open{"pane":"wsl"}` 冷启动也能直接成功；
- **只读操作不切页**，于是会回一句 `没有这个分栏: wsl`，并在错误里明确指出
  「WSL 分栏是懒创建的，先 `ui_click{"path":"global.ui.wslToggleBtn"}`（写操作不用你手动开）」。
  注意 `ui_get_state` 的 `monitors` 里**有** `wsl`（那是配置），而 `serial_get_state` 的 `panes` 里没有
  （那是运行时）—— 两者不一致时以 `panes` 为准，别以为工具坏了。

### `serial_quick_cmd`：快速指令（列表 / 执行 / 循环 / 增删改）

界面右侧那条"快速指令"分栏里的东西，都能从这里操作。列表**按循环组分段，一组一张表**；
每个动作都复用面板上那颗按钮走的**同一条代码路径**（不给 AI 另开一套）。

| 用法 | 传参 | 说明 |
|---|---|---|
| **列出来** | 什么都不传 | 每条含 `index`（按"组→组内"摊平的下标）、`group`/`groupIndex`/`itemIndex`、`value`、`seq`/`timeoutMs`/`expect`/`retry`/`hex`，以及可直接交给 `ui_set` 的 `domIds`；另给 `groups[]`（组名/条数/`on` 是否参与循环/`folded`）与 `loop`{on, planLength} |
| **执行一条** | `index` | 按**该条自己的 `hex`** 决定发文本还是 HEX（与主发送栏的模式无关） |
| **开关循环** | `action: "loop"`，`on` 可省（省=取反） | 循环顺序 = **组从上到下 → 组内顺序号**；**发一条等它回话**（busy 继续等 / OK 下一条 / ERROR 重发 / 等满超时终止整链）；没连串口、或整条链上没有 `seq>0` 的条目就**拒绝**并说明原因 |
| **加一条** | `action: "add"`，`group`（组序号/组名，可省=最后那组）、`value`、`seq`、`timeoutMs`、`expect`、`retry`、`okGoto`、`errGoto`、`hex` | 加完报告它落在 `index`、所属组与 `applied`。`delayMs` 是**旧拼写**（与 `timeoutMs` 同值）；`expect`/`retry`/`okGoto`/`errGoto` 面板上没有入口（写在文件的同名列里）；`okGoto`/`errGoto` = 跳到哪个**顺序号**（留空 = 下一条、`结束` = 收尾） |
| **改一条** | `action: "update"`，`index` + 要改的字段 | 至少给一个字段；`applied` 列出真正改动的项 |
| **删一条** | `action: "remove"`，`index` | 返回被删那条的组/内容/顺序号与剩余条数 |
| **组操作** | `action: "group"`，`op: "add"｜"remove"｜"rename"｜"move"｜"on"｜"fold"` | `group` 指定哪一组（序号/组名/组 id）；`rename` 给 `name`；`move` 给 `toIndex`（**组的上下顺序就是循环顺序**）；`on`/`fold` 给 `on` |

改列表会**同时写回它挂载的外部文件**（"文件即存储"）—— 文件格式（列名/别名、`## 组名` 抬头、注释、
写回规则、上限）见 [`QUICK_CMDS.md`](./QUICK_CMDS.md)。

### `serial_workflow` / `serial_workflow_run`：自动化工作流规则

面板「更多设置 → 工作流」那一块（**收到匹配的数据就自动执行动作**：发数据 / 切 DTR-RTS / 存日志）。
改规则走的就是面板改的同一条路（立刻写进配置）。

| 用法 | 传参 | 说明 |
|---|---|---|
| **列出来** | 什么都不传（或 `action: "list"`） | 每条含 `id`/`name`/`enabled`/`running`/`conditions[]`/`actions[]`（动作里的延时是 `delayBefore`）与稳定 `domIds`；另给 `limits` |
| **加一条** | `action: "add"`，`name`、`conditions`、`actions`、`enabled` | 最多 8 条条件 / 8 个动作；条件 `type` ∈ `string_contains｜regex｜exact_bytes`，动作 `type` ∈ `send_data｜toggle_dtr_rts｜save_log`。⚠️ **新规则一律 `running:false`** |
| **改一条** | `action: "update"`，`rule` + 要改的字段 | `running` 这里**只接受 `false`**（停一条正在跑的）；传 `true` 会被拒（`-32602`）并告诉你该走哪条工具 |
| **删一条** | `action: "remove"`，`rule` | 正在跑的会先被停掉，再删 |
| **启动 / 停止** | **`serial_workflow_run`**：`rule` + `on` + `confirm: true` | ⚠️ **危险动作**（跑起来之后规则会自动往设备发数据）→ 不带 `confirm` 不执行、回 `-32006`。**别用 `ui_click` 点面板上那颗运行按钮绕开确认门** |

规则触发过的痕迹会写进日志中心的 **`workflow` 通道**（`[Auto] …`），用 `log_tail{channel:"workflow"}` 就能查"这条规则到底跑没跑过"。

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
| `ble_cts_time` | 把 **CTS（0x1805）** 的值翻成人话（UTC 时间 / 与本机差多少 / 星期几 / 调整原因 + 可疑处提示）。**纯后端**，只解字节 | 读 |

#### 读设备时间（CTS，`0x1805`）怎么用

从机的**时间**是最常见的调试点（RTC 没初始化 → 年份 2000；时区差 8 小时；星期几算错…），
而 CTS 的特征值本身是 **10 字节二进制**，人肉解很容易错。三步：

```
ble_get_services                                  # 1) 服务树里认「Current Time」(0x1805) 与「Current Time」(2A2B)
ble_read   { "char": "0x2a2b" }                   # 2) 点面板那颗读按钮 → 值进日志
ble_get_output                                    # 3) 拿到 { kind:"rx", hex:"EA 07 0C …" } 的 hex
ble_cts_time { "data": "EA 07 0C 11 0F 2D 3A 04 80 00" }   # 4) 翻成人话
```

返回里最有用的是三样：`utc`（时间本身）、**`skewSecs`**（与本机的差值 —— 正负和大小一眼看出时钟偏了多少）、
**`notes`**（主动指出可疑处：年份像 RTC 没初始化 / 星期几与日期对不上 / 时钟偏了 N 分钟 / 设备自报的调整原因）。
2 字节的值按 `Local Time Information`（`0x2A0F`）解，回时区（`utcOffset`）与 DST 名称。
`data` 收 HEX 字符串或字节数组；长度不是 10/2 字节会直接说清该读多少 —— 别截断特征值。

**界面上也会显示这一行**：面板在**读到 / 收到** `2A2B`·`2A0F` 时就地调后端解读，数据日志里紧跟原始 HEX
多一行 `  → 2026-12-17T15:45:58.500Z（周四） · 设备时钟比本机快 …`（订阅后能直接看着设备时钟走）。
界面与 AI 用的是**同一份 Rust 实现**（`ble_cts_decode` + `ble_cts_summary`），所以两边说法不会不一致；
不是 CTS 特征、或值长度对不上时**不猜** —— 宁可不说，也不给一句看着确定、其实错的解读。

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

### ADB 语义工具（`adb_*`，第三批的 ADB 部分）

ADB 面板（点顶栏「ADB 调试」）那条链路也能从 MCP 走。与 `serial_*` / `ble_*` 同构：
**每个动作都复用面板那条真实路径**（`openAdbSession` / `closeAdbSession` / 面板终端敲键盘走的那条
`adb_shell_write`），不给 AI 另写一套。ADB 面板是**单会话**模型（同时只有一台设备开着 shell）。

| 工具 | 干什么 | 读/写 |
|---|---|---|
| `adb_list_devices` | `adb devices -l` 的实时结果（序列号 / 状态 / 型号）。**只有 `state=device` 那台能用** | 读 |
| `adb_open_shell` | 在设备上开一个交互式 shell（= 点面板上的设备卡片）。**等 PTY 真的建出来才返回**（最长 10 秒） | **写 ⚠️ 危险** |
| `adb_shell_write` | 往已开的 shell 里写内容（= 在面板终端里敲键盘）。**命令要自带 `\n`** | **写 ⚠️ 危险** |
| `adb_shell_read` | 读 shell 已经产生的输出（日志中心的 `adb:rx`；`sinceSeq` 增量跟进）。**纯后端，不需要界面** | 读 |
| `adb_shell_resize` | 调整 PTY 尺寸（`cols`/`rows` 都是 2~1000） | 写 |
| `adb_close_shell` | 关掉当前会话（kill 子进程 + 移除终端）；没开时幂等 | 写 |

一条典型流程（**两个危险动作都要带 `confirm:true`**）：

```json
{"name": "adb_list_devices"}
{"name": "adb_open_shell", "arguments": {"serial": "emulator-5554", "confirm": true}}
{"name": "adb_shell_write", "arguments": {"data": "ls -l /sdcard\n", "confirm": true}}
// 等一会儿再读设备回了什么；下一次把最后一条的 seq 当 sinceSeq 传进来做增量
{"name": "adb_shell_read", "arguments": {"limit": 50}}
{"name": "adb_close_shell"}
```

> ⚠️ `adb_shell_write` 写的是**设备的 shell**：内容里带换行就是**在设备上真的执行**它。
> 这也是它必须二次确认的原因（与"对外广播"同一档）。
>
> ⚠️ `adb_shell_read` 返回的 `items` 是 PTY 的**输出块**，不是按行切好的文本 ——
> 终端输出本来就没有行边界（ANSI 光标序列会跨块）。要"人眼友好"的完整历史就用
> `log_tail{channel:"adb:rx"}`，两者读的是**同一份存储**（在 PTY 读线程的生产端旁路了一份，
> **不会抢走界面终端要显示的数据**）。
>
> 注意：ADB 那台**没有界面也能读**（`adb_shell_read` 是纯后端），但开/写/关都必须有界面
> （它们走的是面板同一条路径）。

### 危险动作要二次确认（`confirm:true`）
有些动作**撤不回来**：对外广播（附近设备都能看到并连上来）、在别人的设备上执行命令、
动宿主机的硬件挂载。这些工具**不带 `confirm:true` 就不会执行**，返回 `-32006` 并说明后果：

```json
// 先问清有哪些危险动作与各自的后果
{"name": "mcp_danger"}
// 想清楚再动手（不带 confirm 的调用什么都不会发生）
{"name": "adb_open_shell", "arguments": {"confirm": true}}
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
| **ADB shell 的输出** | `adb_shell_read` · `log_tail{channel:"adb:rx"}` | 两者读的是**同一份存储**（PTY 读线程在生产端旁路进日志中心的那份）；`adb_shell_read` 不用知道通道名、没数据也不报错，`log_tail` 能翻更早的行 |
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

### 读日志怎么才不烧 token（`format:"text"`）

`log_tail` / `serial_get_output` 都有两档输出编码，**数据完全一样，只是写法不同**：

| 编码 | 长什么样 | 代价 |
|---|---|---|
| `json`（默认） | 一行一个对象：`{seq, ts, t, level, dir, bytes, text}` | 每行固定 ~100 字节。串口调试全是短行（`OK`、`AT+GMR`），**包装比正文长十几倍**（实测 101 字节/行） |
| `text`（推荐） | 头部一行元信息 + 一行一条：`[12:34:56.789] [info] AT+GMR`（`serial_get_output` 是 `[时刻] [rx\|tx] 正文`） | 同样那 200 条短行实测 **29 字节/行 → 省 3.5 倍**；行越长省得越少（长行约 30%） |

三条不会因为换编码而变的保证（**省 token 不等于少看日志**）：

1. **可见性**：`text` 编码的正文放在 `content[].text` 里（很多客户端只把这一份给模型看），`structuredContent` 只给元信息 —— 同一段日志**只发一份**，不会重复计费，也不会被压成 600 字摘要。
2. **完整性**：两种编码的 `returned` / `seqFrom` / `seqTo` / `missed` / `dropped` / `mayBeIncomplete` / `truncated` 一模一样，头部那行也把丢弃账写出来。
3. **行数上限**：还是 2000，编码只改写法，不改能拿多少。

配合增量拉取最省：先 `log_stats` 看哪个通道在刷，再用 `log_tail{channel, sinceSeq: nextSinceSeq, format:"text"}` 小步跟进 —— **把返回里的 `nextSinceSeq` 当下次的 `sinceSeq`**（别直接跳到 `seqTo`，那会跳过 `missed` 那些行）。要定位具体内容优先 `log_search`，别整段拉回来。

### 找东西时先选对"要多少信息"（`log_search` 三档）

`log_search` 的 `mode` 就是"用信息量换 token"的旋钮，三档查的是**同一批数据**：

| `mode` | 回什么 | 什么时候用 |
|---|---|---|
| `count`（最省） | 只有 `total` + 每个有命中的通道各几次 | "到底有没有超时""ERROR 出现几次" —— 几十 token 就够 |
| `matches` | 每条命中只回**匹配片段**（`match` 字段） | 长行日志定位（HEX dump、一行几十 KB 的 JSON），比回整行省得多 |
| `lines`（默认） | 命中行本身（可加 `context` 0~5 带前后几行） | 真的要读上下文；命中多时先别用这档 |

图案一律按**字面量**处理（`AT+CGMR`、`([` 都不用转义），除非显式 `regex:true`；不给 `channel` 就搜所有通道。`limit` 上限 500（`matches` 档算的是**匹配处数**）。

同一套 `pattern` + `mode` 也适用于**另外两个"读输出"入口**（同一个匹配器，答案一致）：

| 工具 | 数据 | 检索档扫什么 | 匹配哪段文本 |
|---|---|---|---|
| `adb_shell_read` | 日志中心 `adb:rx` 的 PTY **输出块** | 最近 2000 块 | 块正文 |
| `ble_get_output` | 蓝牙面板**本次会话**的条目 | 整份面板缓冲 | `text`，为空时用 `hex` |

`mode:"count"` / `mode:"matches"` 在这两个工具上**必须给 `pattern`**（这两档就是检索）；`count` 回 `total`（命中条目数）+`totalMatches`（命中处数），`matches` 只回片段 + 条目自己的 `kind`/`level`。注意它们**没有 `context`**：条目是输出块/通知，不是按行切好的日志 —— 要上下文就用返回里的 `channels.rx`（或 `channel`）去 `log_tail{format:"text"}`。

> ⚠️ **旧版有个 `log_export`（把若干通道的日志一次拼成一段文本）已被删除**：省略 `channels` 时它会把
> **全部通道**× 每通道最多 20000 行塞进一次返回，而返回体**没有大小上限** —— 一次调用就可能几十 MB，
> 撑爆上下文、客户端也会解析打摆。要看全量就用 `log_tail{format:"text"}` 配合 `sinceSeq` 增量跟进；
> 长期留存看 `%APPDATA%\seahi-serial\log-cache\`（用户自己 `rg` 搜都很方便）。
> 客户端若还留着旧工具名，调用时会得到一句"已删除 + 现在该用什么"的 `-32602`。

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
| 前端桥回执超时 | 5 秒（在途上限 32；`ble_connect` 130 秒、BLE 设备动作 30 秒、`adb_open_shell` 30 秒） |
| `serial_send` 单次字符数 | 64K（超了 -32602） |
| `ble_write` 单次字符数 | 4096（超了 -32602） |
| `adb_shell_write` 单次字符数 | 4096（超了 -32602；这一头是**设备的 shell**） |
| `adb_shell_resize` 的 `cols` / `rows` | 2~1000（越界 / 0 / 1 都是 -32602） |
| `adb_shell_read` 一次行数 | 默认 200，上限 2000 |
| 日志单条上限 | 8 KiB（超过截断并留标记） |
| 日志每通道上限 | 128 KiB ~ 1 MiB（按通道类型） |
| **日志总量上限** | **16 MiB**（各通道另有更小的上限；超了会裁掉最大通道的旧日志，回收次数与回收字节数在 `log_stats` 里能看到） |
| 日志通道数上限 | 64（到顶后新通道不再创建，丢弃条数计入 `channelSkips`） |
| 读日志的编码 | 默认 `json`；`format:"text"` 是一行一条纯文本（更省 token）。两种编码的数据与丢弃账完全一致，行数上限也都是 2000 |
| `log_search` 的 `limit` / `context` | `limit` 默认 100、上限 500（`matches` 档算**匹配处数**）；`context` 0~5，超了或配在非 `lines` 档上都是 -32602 |
| 检索图案 `pattern` 的长度 | **512 字符**（三个"读日志"工具共用）—— 图案要被编译成正则，所以**在碰主程序之前**就拦 |

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
| `GET /status` | **需要 token** | 服务器详情（运行状态、端口、会话数、工具数、丢弃统计……）。返回里 **token 与两条完整 URL 都会打码**（`urlMasked` / `streamableUrlMasked`） |
| `POST /mcp` | **需要 token** | **Streamable HTTP**（推荐）：发 JSON-RPC，**结果直接从这次响应体回来**；`initialize` 的响应头带 `Mcp-Session-Id`，后续请求用同名请求头带回来。通知回 **202 + 空体**；会话不认识回 **404**（客户端据此重新 `initialize`） |
| `GET /mcp` | **需要 token** | 给已初始化的会话挂一条 SSE 流，收服务端通知（如 `notifications/tools/list_changed`）。一个会话最多一条流（重复请求 → 409） |
| `DELETE /mcp` | **需要 token** | 主动结束会话（回 204），立刻释放一个会话名额 |
| `GET /sse` | **需要 token** | 遗留 SSE：建立会话，首帧下发 `event: endpoint`（后续请求的投递地址） |
| `POST /messages` | **需要 token** | 遗留 SSE：按 JSON-RPC 发请求，结果通过已建立的 SSE 流回传 |

token 可放在查询串（`?token=…`）或 `Authorization: Bearer …` 请求头里。`/healthz` 之外的任何端点缺 token 或 token 错误一律回 **401**。
`/mcp` 另外还校验 `MCP-Protocol-Version`（不认识的值 → 400，响应里列出支持的版本；缺失按 `2025-03-26` 放行）与 `Origin`（非回环 → 403，防 DNS rebinding；不带 Origin 的 SDK/curl 不受影响）。

> ⚠️ `/sse` + `/messages` 与 `/mcp` 这**三行是否真的存在，取决于弹窗里的传输档位**（见 §2）：
> 选「仅 /mcp」时前两行返回 404，选「仅 SSE」时 `/mcp` 那三行返回 404。
> 拿不准就先看 `GET /status` 的 `transport` 字段（`both` / `http` / `sse`）与两条 URL 哪个非 null。

## 8. 安全边界

1. **只监听回环地址**，不能配置成对外网/局域网开放（配置接口会拒绝非回环的 host）。
2. **必须带 token**；`/healthz` 是唯一不需要 token 的端点，且只回 `{"ok":true}`，不泄露任何信息；`/status` 虽然能看详情，但也**不回显 token 与完整 URL**（两条 URL 都打码）。`/mcp` 还额外做 `Origin` 校验（只放行回环来源）。
3. **工具不能修改 token** —— 必须由你在界面点「重置令牌」。
4. **AI 记录与用户配置严格分文件**（`ai-calls.jsonl` 与 `config.json` 互不相干，有自动化断言守着）。
5. 危险工具（发数据、开串口、连蓝牙等）的**二次确认**尚未实现，属于后续工作（见 `MCP_DESIGN.md` §9）。
6. **运行期错误会上报到错误收集服务**（同一套错误上报通道：LogHub 的 `error` 通道 → 本地日志 → Sentry → 自建服务/SQLite）。上报内容**不含 token**（自动打码），同类错误 5 分钟内只报一次。Debug 构建沿用隐私默认：没设 `ERROR_SERVER_URL` 就只在本地留痕、不外发。状态里的 `errorReports` 能看到报了多少条、被去重挡了多少次。
