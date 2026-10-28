# Quick start

## Requirements

| Item | Notes |
|---|---|
| OS | **Windows 10 / 11** — this tool is Windows-only |
| WebView2 | Usually preinstalled; the installer guides you if it is missing |
| Driver | USB-serial adapters (CH340 / CP210x / FTDI…) need their driver installed |

::: tip Animations are real recordings
The moving images on this page are screen recordings of the actual app, not mockups.
:::

## Install

1. Open [Releases](https://github.com/SeaHi-Mo/Seahi-Serial/releases/latest) and download the `.msi` or `Seahi-Serial-Setup-*.exe`.
2. The installer is **unsigned**: SmartScreen → *More info* → *Run anyway*.
3. Launch it from the Start menu.

## Connect your first port

1. Plug the device in.
2. Pick the COM port in the toolbar (the list refreshes on plug/unplug).
3. Baud rate defaults to `115200`; typing a custom value works too.
4. Click **Start monitoring**. The button turns into *Stop monitoring* and output starts scrolling.

<GuideMedia
  src="/img/guide/serial.mp4"
  poster="/img/guide/serial.png"
  caption="Real app: pick the COM port, click Start monitoring, then type a command and press Enter."
/>

## Send something and read the answer

Type in the input box and press `Enter`:

- Text mode by default; switch to HEX to send raw bytes.
- **Line ending** is chosen in the toolbar — `\r\n` or `\r` for AT commands.
- The last 50 sent lines are kept per pane; use `↑` / `↓`.

Nothing comes back? Check the baud rate, the line ending, and whether another program already holds that COM port.

## Logs are kept automatically

Every session with traffic is cached to disk (the last 10 are kept):

```
%APPDATA%\seahi-serial\log-cache\session-<timestamp>-<port>.log
```

Use **Save log** when you need a permanent copy.

## Next

- Terminal mode, quick commands, BLE and ADB are documented in Chinese for now — start from [快速开始](/guide/quick-start).

For MCP access, see [MCP overview](/en/mcp/).
