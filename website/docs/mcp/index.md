# MCP：让 AI 直接操作本程序

程序内置一个 [Model Context Protocol](https://modelcontextprotocol.io/) 服务器。Claude Code / Claude Desktop / Cursor / VS Code / Cline 等客户端连上后，AI 就能直接读串口、发数据、看蓝牙通知、跑工作流——**和你在界面上点按钮走的是同一条路**，不是另开一套旁路。

## 它是怎么跑的

| 项 | 说明 |
|---|---|
| 运行方式 | **与程序同进程**，随程序启动自动监听，无需另外启动服务 |
| 传输 | **Streamable HTTP**（`POST /mcp`，新客户端默认）与**遗留 SSE**（`GET /sse` + `POST /messages`）并存，同一套工具、同一张会话表 |
| 监听地址 | **只监听回环**（`127.0.0.1` / `::1` / `localhost`），外网连不上 |
| 鉴权 | 每个请求都要带 token（`?token=` 或 `Authorization: Bearer`）；`/healthz` 是唯一免鉴权端点，只回 `{"ok":true}` |
| 开关 | 顶栏 MCP 图标 →「MCP 服务器」窗口内启用/关闭，状态存 `ai-config.json` |

## 安装指南

打开顶栏的「MCP 服务器」窗口，确认服务器已启用，然后：

1. 选传输档：`HTTP`（新版客户端）/ `SSE`（旧客户端）/ `All`（不确定时）
2. 复制「安装提示词」
3. 把整段提示词发给你正在使用的 AI 客户端

提示词里已经包含连接地址、`mcpServers` 配置片段、当前工具列表和「连上后先调 `mcp_status`」的说明；重置令牌后需要重新复制。窗口里每个控件的说明见 [MCP 接入](/guide/mcp)。http 传输的 `type` 各家写法不同（VS Code 写 `http`，Cline 认 `streamableHttp`），窗口里的配置片段已经带了提示。

## 安全模型

- **只读模式**：一键打开后 AI 只能读，所有写操作被拒（`-32007`），界面与配置文件一个字都不变。⚠️ 这个开关**只能由用户在界面上关**——`mcp_config_set` 本身也是写工具，AI 打开后关不掉。
- **危险动作二次确认**：开 adb shell、写 adb 命令、跑工作流这类「会对外产生不可撤销影响」的操作，必须带 `confirm:true` 才执行，否则返回 `-32006` 并说明后果。界面上对应按钮对通用点击工具不可见也点不动。
- **限额**：会话数、队列长度、请求体（1 MiB）、调用频率都有上限；任何接受外部数组/字符串的入参都有独立上限，且校验发生在碰主程序之前。

## 54 个工具，分五类

| 分类 | 例子 |
|---|---|
| 应用信息 | `app_info`、`mcp_status`、`mcp_limits`、`serial_list_ports` |
| 串口语义（优先用这些） | `serial_get_state`、`serial_select_port`、`serial_open`、`serial_send`、`serial_get_output`、`serial_quick_cmd` |
| 蓝牙（主机方向） | `ble_start_scan`、`ble_connect`、`ble_get_services`、`ble_read`、`ble_subscribe`、`ble_cts_time` |
| ADB | `adb_list_devices`、`adb_open_shell`⚠️、`adb_shell_write`⚠️、`adb_shell_read` |
| 界面与日志 | `ui_list`、`ui_set`、`ui_click`、`log_channels`、`log_tail`、`log_search` |

典型的串口主流程：

```
serial_get_state → serial_select_port → serial_set_baud → serial_open
  → serial_send → serial_get_output（看设备回了什么） → serial_close
```

完整的入参与返回结构见 [工具参考](/mcp/tools)（由 `doc/MCP_TOOLS.md` 自动同步，工具一改这里跟着变）。

## 为什么 AI 能选对工具

协议里有四个通道能把「该用哪个工具」讲清楚：`initialize.instructions`、每个工具的 `description` 与字段描述、错误码语义，以及 `prompts`（客户端会列成斜杠命令）。`doc/` 下的文档 AI 一个字都看不到——所以规则、坑点、场景链路都写在工具自己身上，不写在文档里。

调用记录写在 `ai-calls.jsonl`，绝不会污染你的 `config.json`。
