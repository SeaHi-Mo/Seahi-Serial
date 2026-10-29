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

## Connect a client

The recommended way is the installer:

```bash
npx seahi-serial-mcp install          # detect the running app and write the client config
npx seahi-serial-mcp install --dry-run
npx seahi-serial-mcp status
npx seahi-serial-mcp uninstall
```

You can also copy from the window:

- Newer clients: copy the Streamable HTTP URL or client config JSON
- Older SSE-only clients: copy the legacy SSE URL or config JSON
- If you do not want to edit client files by hand: copy the install prompt and send it to the AI

The `type` value for HTTP is not consistent across clients: VS Code uses `http`, Cline uses `streamableHttp`. The Streamable HTTP config in the window includes a note about this, and the installer provides both forms.

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
