# FAQ

## Why is the installer unsigned?

This is a personal project without an OV/EV code-signing certificate. An unsigned program triggers the SmartScreen “unknown publisher” warning on Windows. That is the default system behaviour and does not mean the program is unsafe.

You can verify the download:

- Download only from [GitHub Releases](https://github.com/SeaHi-Mo/Seahi-Serial/releases/latest).
- Check the file hash against `SHA256SUMS.txt` on the release page.
- The CI workflow signs `SHA256SUMS.txt` with cosign (keyless) and publishes a `.sigstore.json` bundle that proves the files were built in this repository.

See [Code signing and installation](https://github.com/SeaHi-Mo/Seahi-Serial/blob/main/doc/SIGNING.md) for the full steps.

## Does it support macOS or Linux?

No, and there are no short-term plans to add support. Serial port enumeration uses Win32 SetupAPI, and many window, WSL and ADB behaviours depend on Windows.

## Where are the configuration files?

```
%APPDATA%\seahi-serial\
├── config.json          # UI and serial settings
├── window.json          # window position and size
├── ai-config.json       # MCP settings (toggle, port, token)
├── ai-calls.jsonl       # AI tool call log
└── log-cache\           # cached session logs, up to 10
```

MCP settings and call records are stored separately; `config.json` does not contain AI data.

## Does the app lose window geometry after it closes?

No. Position and size are stored in `window.json`: outer position for the window and the content-area size. Minimised or maximised windows do not overwrite the normal geometry. When upgrading from an older version, the size is migrated once from `config.json`.

## The device is plugged in but the port list is empty

Check these in order:

1. Does the COM port appear in Device Manager? If not, it is a driver problem.
2. Is another program using the port? A serial port can only be opened by one program at a time.
3. Try another cable. Some cables provide power only and cannot transfer data.

Bluetooth devices behave differently: a device that is not advertising does not appear in the scan list. Use **Connect by MAC**; see [Bluetooth](/en/guide/ble).

## The AI client does not show new tools, or cannot connect

Missing tools: tool definitions are compiled into the executable. After upgrading the app, the client must reconnect before it reads `tools/list` again. Also make sure the client is launching the new build.

Unable to connect: check that the app is running and the MCP server is enabled. `/healthz` is the only endpoint that does not require authentication and is useful for checking that the port is reachable.

A common cause is the transport setting. Newer clients use Streamable HTTP (`POST /mcp`); older clients use legacy SSE. The MCP dialog can switch between **HTTP only**, **SSE only** and **Both**; with a single transport selected, the other endpoint returns 404.

See [MCP setup](/en/mcp/) for details.

## How do I report a problem?

Open an issue on [GitHub Issues](https://github.com/SeaHi-Mo/Seahi-Serial/issues). Include the version number, Windows version, steps to reproduce and relevant log excerpts.

The connection URL in the MCP dialog contains an access token. Remove the token before posting.
