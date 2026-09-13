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
| 应用/服务器 | `app_info`、`mcp_status`、`mcp_limits`、`serial_list_ports` |
| 界面操作 | `ui_list`、`ui_describe`、`ui_get`、`ui_set`、`ui_click`、`ui_get_state` |
| 日志 | `log_channels`、`log_tail`、`log_search`、`log_stats`、`log_clear`、`log_export` |
| 记录与配置 | `mcp_calls`、`mcp_stats`、`mcp_config_get`、`mcp_config_set` |

推荐让 AI 的工作顺序是：`ui_list` 看有哪些控件 → `ui_describe` 看某个控件怎么填 → `ui_set`/`ui_click` 操作 → `log_tail` 看结果。

### 想让"每个控件都是一个工具"？

默认关闭。打开后界面上每个按钮/输入框/下拉都会生成一个独立工具（名字形如 `ctl_serial_conn_portselect`）：

```json
// 让 AI 调 mcp_config_set：
{ "patch": { "expose": { "autoControlTools": true } } }
```

也可以只暴露某个面板：`{"expose":{"autoControlTools":true,"namespaces":["serial"]}}`。

> 默认关闭的原因：工具列表要进 AI 的上下文，几百个工具会明显拖累它选工具的准确率。

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
