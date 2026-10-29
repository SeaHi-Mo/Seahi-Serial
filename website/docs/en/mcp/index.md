# MCP: let an AI client drive the app

SeaHi Serial ships a [Model Context Protocol](https://modelcontextprotocol.io/) server **inside the app process**. Once a client (Claude Code, Cursor, VS Code, Cline…) connects, the model can open ports, send data, read BLE notifications and run workflows — **through the same code paths as the UI**, not a separate side channel.

## How it runs

| | |
|---|---|
| Process | In-process with the app, started with it |
| Transports | **Streamable HTTP** (`POST /mcp`) and **legacy SSE** (`GET /sse` + `POST /messages`), same tools and sessions |
| Binding | **Loopback only** (`127.0.0.1` / `::1` / `localhost`) |
| Auth | Token on every request (`?token=` or `Authorization: Bearer`); `/healthz` is the only unauthenticated endpoint and returns `{"ok":true}` |
| Toggle | MCP icon in the title bar; on/off in the **MCP 服务器** window; state lives in `ai-config.json` |

## Installation guide

Open the **MCP 服务器** window from the title bar, make sure the server is enabled, then:

1. Pick a transport: `HTTP` (newer clients) / `SSE` (older clients) / `All` (when unsure)
2. Copy **安装提示词** (install prompt)
3. Send the whole prompt to the AI client you are using

The prompt already contains the connection URL, an `mcpServers` config snippet, the current tool list and the instruction to call `mcp_status` first. After resetting the token, copy it again. See [MCP setup](/en/guide/mcp) for a control-by-control description of the window.

## Safety model

- **Read-only mode**: every write tool is rejected with `-32007`; UI and config stay untouched. Only the user can turn it off.
- **Dangerous actions** need `confirm:true`, otherwise the tool returns `-32006` with the consequences spelled out.
- **Limits**: sessions, queue length, request body (1 MiB) and call rate are all bounded; input array/string parameters are checked before the app is touched.

## Tools

54 built-in tools in five families: app info, serial semantics, BLE (central), ADB, and UI/log access. The serial happy path:

```
serial_get_state → serial_select_port → serial_set_baud → serial_open
  → serial_send → serial_get_output → serial_close
```

The full per-tool reference (arguments and return shapes) is generated from the source:
[MCP_TOOLS.md](https://github.com/SeaHi-Mo/Seahi-Serial/blob/main/doc/MCP_TOOLS.md) (Chinese).
