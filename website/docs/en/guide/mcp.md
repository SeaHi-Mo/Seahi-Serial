# MCP setup

The app includes an MCP server. Once a client such as Claude Code, Claude Desktop, Cursor, VS Code or Cline connects, the model can read serial ports, send data, inspect BLE notifications and run workflows. The server runs inside the app process, and tool calls use the same code paths as the UI.

<GuideMedia
  poster="/img/guide/mcp.png"
  caption="The MCP server window: server toggle, transport, read-only mode and token reset at the top; connection URLs, client configs and the install prompt below (the access token is masked in this screenshot)."
/>

## Open the MCP server window

Click the MCP icon in the title bar (its dot shows the server state). The window title is **MCP 服务器**.

The status on the right side of the title is either:

- `监听中 · 127.0.0.1:7777 · N 个会话`
- `已关闭`

Hover the status text to see the version, tool count, request count, dropped count and endpoint file. **关闭** at the bottom closes only this window; it does **not** stop the server.

## Controls in the window

| Control | What it does |
|---|---|
| `启用 MCP 服务器` / `关闭 MCP 服务器` | The same button. Its label says what clicking it will do, not the current state |
| Transport dropdown: `HTTP` / `SSE` / `All` | Takes effect immediately. HTTP serves only `/mcp`; SSE serves only `/sse` and `/messages`; All serves both. In a single-transport mode the other endpoint returns 404 |
| `只读模式` (read-only) | The label is fixed; state and consequences are in the hover hint. While enabled every write tool returns `-32007`, and only the UI can turn it off |
| `重置令牌` (reset token) | Generates a new token. The old token stops working immediately; client configs that were already pasted must be copied again |
| `Streamable HTTP（新版客户端用这个）` | Connection URL + copy button, then the client config JSON + copy button. Use `type: "http"` normally; Cline and some clients need `streamableHttp` |
| `遗留 SSE（老客户端用这个）` | Connection URL + copy button; the config JSON uses `type: "sse"` |
| `安装提示词` (install prompt) | A prepared message for an AI client. Copy it and send it to the client so it configures itself |
| `关闭` | Closes the window only; the server keeps running |

The window shows only the section for the selected transport:

- `HTTP`: Streamable HTTP only
- `SSE`: legacy SSE only
- `All`: both

The URLs contain a `token`. Treat it as a password; do not share it or paste it into a public page.

## Installation guide

Installation starts from the MCP window: use **安装提示词** (install prompt). There is no need to assemble JSON by hand.

1. Pick a transport in the window: `HTTP` for newer clients, `SSE` for older clients, or keep `All` if unsure.
2. Click **复制** next to **安装提示词**.
3. Send the copied text to the AI client you are using, for example Claude Code, Cursor, VS Code or Cline. The prompt already contains the current URL, an `mcpServers` config snippet, the current tool list, and the instruction to call `mcp_status` first.
4. After the client writes the config and connects, go back to the window and check the status on the right of the title: the session count starts increasing from 0.
5. If the client does not write the config automatically, paste the URL or config snippet from the prompt in the format that client expects. For HTTP, `type` is usually `http`; use `streamableHttp` for Cline and similar clients.
6. After **重置令牌** (reset token), the old prompt no longer contains a valid URL; copy it again.

The prompt in the window is structured like this; the URL, config and tool list are generated from the current state:

```text
请把下面这个 MCP 服务器加入你的 MCP 配置并连接。它有两条传输，**任选一条**：
① Streamable HTTP（推荐，新版客户端默认走这个）：
  URL: http://127.0.0.1:7777/mcp?token=<token>
  配置片段：{ "mcpServers": { "seahi-serial": { "type": "http", "url": "..." } } }
  （若你的客户端不认 "type":"http"，就把它写成 "type":"streamableHttp"，Cline 等属于这种）
② 遗留 SSE（只支持 SSE 的老客户端）：
  URL: http://127.0.0.1:7777/sse?token=<token>
它是本机 "SeaHi Serial" 串口/蓝牙调试器暴露的工具集，当前可用工具：……
连上后**先调 mcp_status**，它的 nextSteps 会按当前状态告诉你下一步该调什么。
```

The `token` in the prompt is a password; do not share it or paste it into a public page. Use the text copied from the window as the source of truth.

## Common tools

A typical serial call sequence:

```
serial_get_state → serial_select_port → serial_set_baud → serial_open
  → serial_send → serial_get_output → serial_close
```

Other frequently used tools:

- Bluetooth: `ble_start_scan`, `ble_connect`, `ble_get_services`, `ble_read`, `ble_subscribe`, `ble_cts_time`
- ADB: `adb_list_devices`, `adb_open_shell`, `adb_shell_write`, `adb_shell_read`
- UI and logs: `ui_list`, `ui_set`, `ui_click`, `log_channels`, `log_tail`, `log_search`

See the [MCP tool reference](/mcp/tools) (currently generated in Chinese) for arguments and return shapes. Tool descriptions and scenarios are part of the protocol so the model can read them directly.

## Read-only mode and dangerous actions

With read-only mode enabled, every write tool returns `-32007` and neither the UI nor the configuration is changed. Only the user can turn this mode off in the MCP window.

Actions with irreversible external effects, such as opening an ADB shell, writing ADB commands or running workflows, require `confirm:true`. Without it the tool returns `-32006` and explains the consequences.

## Troubleshooting

**An error line appears in the window**: `上次错误：…` shows why the last start or transport switch failed. Fix that first.

**New tools are missing**: tool definitions are compiled into the app. After upgrading, reconnect the client so it reads the tool list again.

**Connection fails**: make sure the app is running and the MCP window says `监听中`. `/healthz` does not require authentication and is useful for checking that the port is reachable.

**Transport mismatch**: newer clients use HTTP and older clients use SSE. Choose the matching transport in the dropdown; in a single-transport mode the other endpoint returns 404.

**Cannot connect after resetting the token**: the old token is invalid. Copy the URL or client config from the window again.

Settings are stored in `%APPDATA%\seahi-serial\ai-config.json`, separately from the serial configuration.

For more details see the [MCP overview](/en/mcp/).
