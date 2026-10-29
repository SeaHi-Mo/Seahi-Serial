# MCP 接入

程序内置一个 MCP 服务器。Claude Code、Claude Desktop、Cursor、VS Code、Cline 等客户端连上后，AI 可以直接读串口、发数据、查看蓝牙通知、执行工作流。服务器运行在程序进程内，工具调用走的是界面上的同一套逻辑。

<GuideMedia
  poster="/img/guide/mcp.png"
  caption="MCP 服务器窗口：顶部是服务器开关、传输档、只读模式和重置令牌；下方按当前传输显示连接地址、客户端配置和安装提示词（图中访问令牌已打码）。"
/>

## 打开 MCP 服务器窗口

点顶栏的 MCP 图标（按钮上的圆点表示服务器状态），打开标题为「MCP 服务器」的窗口。

标题右侧是当前状态：

- `监听中 · 127.0.0.1:7777 · N 个会话`
- `已关闭`

鼠标停在状态文字上，可以看版本、工具数、请求数、丢弃数和发现文件路径。窗口底部的「关闭」只关闭这个窗口，**不会停止服务器**。

## 窗口里的控件

| 控件 | 作用 |
|---|---|
| 启用 MCP 服务器 / 关闭 MCP 服务器 | 同一个按钮。文案写的是点击后会发生什么，不是当前状态 |
| 传输下拉：HTTP / SSE / All | 切换立即生效。HTTP 只提供 `/mcp`，SSE 只提供 `/sse` 和 `/messages`，All 两条都提供；选单档时另一条会直接返回 404 |
| 只读模式 | 文案固定。开关状态和后果写在悬停说明里；打开后所有写操作返回 `-32007`，而且只能在界面上关掉 |
| 重置令牌 | 重新生成访问令牌。旧令牌立即失效，已经粘贴到客户端的配置需要重新复制 |
| Streamable HTTP（新版客户端用这个） | 连接地址 + 复制按钮；下面是客户端配置 JSON + 复制按钮。`type` 一般是 `http`；Cline 等不认时改成 `streamableHttp` |
| 遗留 SSE（老客户端用这个） | 连接地址 + 复制按钮；配置 JSON 的 `type` 是 `sse` |
| 安装提示词 | 一段写给 AI 客户端的说明，复制后直接发过去，让它自己完成配置 |
| 关闭 | 只关闭窗口，服务器继续运行 |

窗口只显示当前传输档对应的区域：

- 选 `HTTP`：只显示 Streamable HTTP
- 选 `SSE`：只显示遗留 SSE
- 选 `All`：两套都显示

地址里带 `token`，等同于密码，不要发给别人或贴到公开页面。

## 安装指南

安装入口就在 MCP 窗口里，用「安装提示词」完成，不需要手动拼 JSON。

1. 在窗口里选择传输档：新版客户端选 `HTTP`，只支持旧协议的选择 `SSE`，不确定就保持 `All`。
2. 点「安装提示词」右侧的「复制」。
3. 把复制到的整段内容发给你正在使用的 AI 客户端，例如 Claude Code、Cursor、VS Code 或 Cline。这段提示词已经包含当前传输的地址、`mcpServers` 配置片段、当前工具列表，以及连上后先调 `mcp_status` 的说明。
4. 客户端按提示词写入配置并连接后，回到窗口看标题右侧的状态：会话数会从 0 开始增加。
5. 如果客户端没有自动写配置，就把提示词里的 URL 或配置片段按它的格式贴进去。HTTP 的 `type` 一般写 `http`，Cline 等不认时改成 `streamableHttp`。
6. 点过「重置令牌」后，旧提示词里的地址已经失效，需要重新复制一次。

窗口里的安装提示词结构如下，地址、配置和工具列表由程序按当前状态生成：

```text
请把下面这个 MCP 服务器加入你的 MCP 配置并连接。它有两条传输，**任选一条**：
① Streamable HTTP（推荐，新版客户端默认走这个）：
  URL: http://127.0.0.1:7777/mcp?token=<访问令牌>
  配置片段：{ "mcpServers": { "seahi-serial": { "type": "http", "url": "..." } } }
  （若你的客户端不认 "type":"http"，就把它写成 "type":"streamableHttp"，Cline 等属于这种）
② 遗留 SSE（只支持 SSE 的老客户端）：
  URL: http://127.0.0.1:7777/sse?token=<访问令牌>
它是本机 "SeaHi Serial" 串口/蓝牙调试器暴露的工具集，当前可用工具：……
连上后**先调 mcp_status**，它的 nextSteps 会按当前状态告诉你下一步该调什么。
```

提示词里的 `token` 等同于密码，不要发给别人或贴到公开页面。实际内容以窗口里复制出来的为准。

## 常用工具

串口的典型调用顺序：

```
serial_get_state → serial_select_port → serial_set_baud → serial_open
  → serial_send → serial_get_output → serial_close
```

其它常用工具：

- 蓝牙：`ble_start_scan`、`ble_connect`、`ble_get_services`、`ble_read`、`ble_subscribe`、`ble_cts_time`
- ADB：`adb_list_devices`、`adb_open_shell`、`adb_shell_write`、`adb_shell_read`
- 界面与日志：`ui_list`、`ui_set`、`ui_click`、`log_channels`、`log_tail`、`log_search`

完整的参数和返回值见 [MCP 工具参考](/mcp/tools)，工具说明和场景写在协议里，AI 可以直接读取。

## 只读模式与危险操作

只读模式打开后，所有写操作返回 `-32007`，界面和配置文件都不会改变。这个开关只能由用户在 MCP 窗口里关闭。

会产生不可撤销影响的操作，例如打开 ADB shell、写入 ADB 命令或运行工作流，需要带 `confirm:true`。不带时工具返回 `-32006` 并说明后果。

## 排错

**窗口里出现「上次错误：…」**：这是服务器最近一次启动/切换失败的原因，先按这一行处理。

**看不到新工具**：工具定义编译在程序里，升级程序后需要让客户端重新连接，才会重新读取工具列表。

**连接失败**：确认程序正在运行、MCP 窗口状态是「监听中」。`/healthz` 不需要鉴权，可以先访问它确认端口是否可用。

**传输方式不匹配**：新客户端使用 HTTP，旧客户端使用 SSE。在窗口的传输下拉里切到对应档；切到单档后，另一条传输会返回 404。

**重置令牌后连不上**：旧令牌已经失效，回到窗口重新复制地址或客户端配置。

设置保存在 `%APPDATA%\seahi-serial\ai-config.json`，和串口配置分开。

更多细节见 [MCP 总览](/mcp/)。
