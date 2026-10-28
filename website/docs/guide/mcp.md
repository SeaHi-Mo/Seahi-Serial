# MCP 接入

程序内置一个 MCP 服务器。Claude Code、Claude Desktop、Cursor、VS Code、Cline 等客户端连上后，AI 可以直接读串口、发数据、查看蓝牙通知、执行工作流。服务器运行在程序进程内，工具调用走的是界面上的同一套逻辑。

## 启用

点顶栏的 MCP 按钮打开设置窗。服务器只监听 `127.0.0.1:7777`，本机以外的设备无法连接。

窗口里可以完成这些设置：

- 启用或关闭服务器
- 选择传输方式：HTTP（Streamable HTTP，适合新客户端）、SSE（适合旧客户端）或两者
- 打开只读模式
- 重置访问令牌

设置保存在 `%APPDATA%\seahi-serial\ai-config.json`，和串口配置分开。

## 连接客户端

推荐使用安装器：

```bash
npx seahi-serial-mcp install          # 探测正在运行的程序并写入客户端配置
npx seahi-serial-mcp install --dry-run
npx seahi-serial-mcp status
npx seahi-serial-mcp uninstall
```

也可以在 MCP 弹窗里复制连接地址或客户端配置 JSON，手动粘贴到客户端。

HTTP 传输的 `type` 在不同客户端写法不同：VS Code 使用 `http`，Cline 使用 `streamableHttp`。弹窗和安装器都会给出两种写法。

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

只读模式打开后，所有写操作返回 `-32007`，界面和配置文件都不会改变。这个开关只能由用户在界面上关闭。

会产生不可撤销影响的操作，例如打开 ADB shell、写入 ADB 命令或运行工作流，需要带 `confirm:true`。不带时工具返回 `-32006` 并说明后果。

## 排错

看不到新工具：工具定义编译在程序里，升级程序后需要让客户端重新连接，才会重新读取工具列表。

连接失败：确认程序正在运行、MCP 服务器已启用。`/healthz` 不需要鉴权，可以先访问它确认端口是否可用。

传输方式不匹配：新客户端使用 HTTP，旧客户端使用 SSE，在 MCP 弹窗里切换到对应模式即可。

更多细节见 [MCP 总览](/mcp/)。
