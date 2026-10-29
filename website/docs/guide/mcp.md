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

## 连接客户端

推荐用安装器：

```bash
npx seahi-serial-mcp install          # 探测正在运行的程序并写入客户端配置
npx seahi-serial-mcp install --dry-run
npx seahi-serial-mcp status
npx seahi-serial-mcp uninstall
```

也可以直接从窗口复制：

- 新版客户端：复制「Streamable HTTP」下的地址或客户端配置 JSON
- 只支持 SSE 的旧客户端：复制「遗留 SSE」下的地址或配置 JSON
- 不想手动找配置文件：复制「安装提示词」发给 AI

HTTP 传输的 `type` 写法不统一：VS Code 用 `http`，Cline 用 `streamableHttp`。窗口里的 Streamable HTTP 配置下面有一行提示，安装器也会给出两种写法。

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
