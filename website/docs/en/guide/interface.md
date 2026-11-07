# App interface and settings

The app uses a frameless window, and the bar at the top is a self-drawn title bar: window controls, page entries, themes and feedback all live on this row. This page walks through it from left to right, then covers onboarding, the MCP dialog, themes, the startup fallback page, window memory, the data directory, shortcuts and error reporting.

<GuideMedia
  poster="/img/landing/hero.png"
  caption="Real main window: the top row has the app icon, +, WSL / ADB / Bluetooth entries, MCP, theme style, Submit issue, Update (when a new version exists), the light/dark switch and the window controls."
/>

## Title bar

| Entry | Behaviour |
|---|---|
| App icon | Returns to the serial main view (from the WSL / ADB / Bluetooth page); hover shows the version and commit |
| + | Adds a pane: on the serial page, an extra monitor (copies the main pane config and widens the window); on the WSL page, a WSL monitor; on the Bluetooth page, toggles the embedded serial monitor on the right; disabled on the ADB page |
| WSL | Opens the WSL port mapping page; click again to return to the serial main view |
| ADB | Opens the ADB debugging page; click again to return |
| Bluetooth | Opens the Bluetooth debugging page; click again to return |
| MCP | Opens the MCP server dialog; the dot at the lower right of the icon shows server status |
| Theme style | Dropdown with 6 colour styles, see [Themes](/en/guide/theme) |
| Submit issue | Opens the [GitHub new issue page](https://github.com/SeaHi-Mo/Seahi-Serial/issues/new) in the system browser |
| Update | Appears only when a new version is found |
| Light/dark switch | Switches between dark and light |
| Minimize / Maximize / Close | Window controls; the maximize button toggles back to restored |

Page switching replaces the whole page: WSL / ADB / Bluetooth are separate full pages, the matching title-bar button is highlighted and clicking it again returns to the serial main view. The app icon does the same.

### Update button

The update button is hidden by default. The app checks once about 2 seconds after startup and then every 10 minutes; when a newer version is found the button appears with the text "更新" followed by the latest version.

Clicking it changes the text to "正在下载...", then to "正在安装...", and then starts the installer and exits the app (configuration is saved before exit). The download is verified with the SHA-256 or file size provided by GitHub; a failed check aborts the install. A download or install failure shows "更新失败: …" and makes the button clickable again; a routine check failure is silent and only goes to the log and error reporting.

### Window controls and dragging

- The three buttons at the far right of the title bar are Minimize, Maximize/Restore and Close.
- Hold a blank part of the title bar to drag the window; pressing on buttons, dropdowns or inputs does not start dragging.
- Closing the window saves the configuration and window geometry first, then releases serial ports, stops background threads and exits.

## First-run onboarding

On the first launch (when this machine has no onboarding-complete marker), nine steps appear about 600ms after the interface is ready:

1. Global bar: extra pane and WSL on the left; theme, feedback and light/dark on the right.
2. Choose a serial port: pick a port from the dropdown; the list refreshes when devices are plugged in.
3. Set the baud rate: type or select a baud rate, default 115200.
4. Start monitoring: connect the serial port after checking the port and baud rate.
5. Toolbar buttons: clear, auto-scroll, auto-reconnect, terminal mode, line numbers, timestamps, echo and more settings.
6. Send data: Text / HEX modes and send history.
7. Quick commands: the collapsed strip on the right of the output area.
8. Advanced settings: data bits, stop bits, parity, DTR/RTS control and log saving under the gear icon.
9. Get started: finish the tour.

- Next advances; on the last step the button becomes "开始使用".
- Skip, or clicking a blank part of the overlay, closes the tour immediately.
- Completing or skipping stores a marker so the tour does not appear again on later launches.

## MCP server dialog

Click the MCP icon in the title bar. The dot at the lower right of the icon shows server status:

- Grey: not enabled, or the status has not been read yet.
- Green: enabled with no client sessions.
- Accent colour (usually blue): enabled with at least one client connected.
- Red: not enabled and the last run had an error (the "last error" line in the dialog says what).

The dialog can enable or disable the server, toggle read-only mode, pick the transport (HTTP / SSE / All), copy both connection addresses and the matching client configs, copy the install prompt, reset the access token, and show status and the last error. See [MCP setup](/en/guide/mcp) for connecting a client.

## Theme style and light/dark

The theme style dropdown offers 6 styles: Default, Ukiyo-e, Poetic East, Ink Wash, Peach Blossom and Golden Wind. Each has a light and a dark variant, for 12 themes in total.

- The dropdown switches the colour style; the light/dark switch toggles between light and dark.
- Switching updates the output area, terminal, sidebar and buttons together, and the title-bar background changes as well.
- The choice is written to config.json and restored on the next launch; on the first launch (no saved choice yet) the app follows the system light/dark setting.
- If the system light/dark setting changes while the app is running, the app follows it too.

See [Themes](/en/guide/theme) for the full description.

## Startup fallback page

During initialisation the page first shows "正在初始化界面…" and hides it once the main pane is created. These cases switch to the fallback page:

- Initialisation fails and the main pane was never created: the title becomes "界面初始化失败" and the error detail is shown below.
- The main pane is still missing after 8 seconds: the title becomes "界面初始化超时" with a suggestion to reload.

The fallback page has two buttons: "重新加载" reloads the page and "退出应用" closes the app. Errors that reach this point also go to error reporting.

The main window is hidden at startup (to avoid flashing the default size) and is shown after the page is ready; every fallback path reveals the window first, and the backend also forces it to show after 4 seconds so the app never runs with no visible window.

## Window position and size memory

The window position, size and maximised state are stored in `window.json` and restored on the next launch:

- Moving or resizing saves after about 400ms of debounce; closing the window saves immediately.
- While maximised the last normal geometry is kept, so restoring returns to that size.
- The window stays hidden at startup and is shown once with the restored geometry, so it does not appear at the default size first and then jump.
- If the saved position is not visible on any monitor (for example after unplugging a second screen), the position is ignored and the window stays centred.
- The minimum window size is 838×650.
- When upgrading from an older version that has no `window.json`, the old size fields in `config.json` are used once.

## Configuration and data directory

The data directory is `%APPDATA%\seahi-serial`. Press `Win + R`, type `%APPDATA%` and open `seahi-serial`.

| File | Purpose |
|---|---|
| config.json | Interface and device settings: theme, monitors, quick commands, workflows, log directory, WSL auto-mapping, Bluetooth page state, OTA profile and more. Changes are written after about 500ms of debounce and forced on close or exit; when the config schema version is unrecognised the old file is backed up as config.json.bak |
| window.json | Window position, size and maximised state; written by the backend on move/resize (about 400ms debounce) and on close |
| ai-config.json | MCP server settings: enabled, host, port, access token, read-only mode, transport, call-log settings; written atomically and kept strictly separate from config.json |
| ai-calls.jsonl | AI tool-call records, one JSON line per call, appended and rotated by file count; the record switch is in the MCP settings |
| log-cache | Invisible session log cache (`session-*.log`), written automatically once a session has traffic, no manual save needed; at most 10 files, 8 MiB per file and about 64 MiB in total |

## Common shortcuts

| Where | Keys | Action |
|---|---|---|
| Send input | Enter | Sends the current content; when the history dropdown is open with a selected item, fills that item first (this press does not send) |
| Send input | ↑ | Fills in the previous send-history entry; moves up instead when the history dropdown is open |
| Send input | ↓ | Opens the send-history dropdown; moves down when it is already open |
| Send input | Esc | Closes the history dropdown and resets the history position |
| Terminal (line buffer) | ↑ / ↓ | Browses the local command history |
| Terminal (line buffer) | ← / →, Home / End, Delete, Backspace | Edits the current line locally, nothing is sent to the device |
| Terminal (line buffer) | Ctrl+C | Discards the half line and sends interrupt 0x03 |
| Terminal (line buffer) | Ctrl+U | Clears the current line |
| Terminal (line buffer) | Enter / Tab | Enter sends the whole line with the line ending; Tab sends 0x09 |
| Terminal (any mode) | Ctrl+Shift+C | Copies selected text in the terminal |
| Terminal (direct) | Any key | Sent as-is, including arrow keys and Ctrl combinations |

The "命令行缓冲" switch in the toolbar selects between these two input modes; see [Terminal mode](/en/guide/terminal) for the full behaviour.

## Error reporting

There is no separate report button: frontend uncaught script errors, unhandled Promise rejections and errors already shown in the UI go through one reporting entry, and backend runtime errors are reported too. The same kind of error is reported at most once every 5 minutes; a failed report only leaves one line in the local log and does not affect use. Disable reporting with the `SEAHI_ERROR_REPORT=0` environment variable; the local debug log is `%TEMP%\seahi-serial-debug.log`.

See [Error reporting](/en/guide/error-reporting) for fields, timing, destination and how to disable it.
