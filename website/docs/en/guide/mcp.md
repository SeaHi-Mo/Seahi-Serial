# MCP setup

The app includes an MCP server. Once a client such as Claude Code, Claude Desktop, Cursor, VS Code or Cline connects, the model can read serial ports, send data, inspect BLE notifications and run workflows. The server runs inside the app process, and tool calls use the same code paths as the UI.

## Enable the server

Click the MCP button in the title bar to open its settings. The server listens on `127.0.0.1:7777` only, so other machines cannot connect.

The dialog lets you:

- enable or disable the server
- choose the transport: HTTP (Streamable HTTP, for newer clients), SSE (for older clients) or both
- turn on read-only mode
- reset the access token

Settings are stored in `%APPDATA%\seahi-serial\ai-config.json`, separately from the serial configuration.

## Connect a client

The recommended way is the installer:

```bash
npx seahi-serial-mcp install          # detect the running app and write the client config
npx seahi-serial-mcp install --dry-run
npx seahi-serial-mcp status
npx seahi-serial-mcp uninstall
```

You can also copy the endpoint or the client configuration JSON from the MCP dialog and paste it into the client.

The `type` value for HTTP transport differs between clients: VS Code uses `http`, Cline uses `streamableHttp`. The dialog and the installer provide both forms.

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

With read-only mode enabled, every write tool returns `-32007` and neither the UI nor the configuration is changed. Only the user can turn this mode off in the app.

Actions with irreversible external effects, such as opening an ADB shell, writing ADB commands or running workflows, require `confirm:true`. Without it the tool returns `-32006` and explains the consequences.

## Troubleshooting

New tools are missing: tool definitions are compiled into the app. After upgrading, reconnect the client so it reads the tool list again.

Connection fails: make sure the app is running and the MCP server is enabled. `/healthz` does not require authentication and is useful for checking that the port is reachable.

Transport mismatch: newer clients use HTTP and older clients use SSE. Switch to the matching mode in the MCP dialog.

For more details see the [MCP overview](/en/mcp/).
