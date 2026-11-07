# App interface and settings

The application uses a frameless window. The top row is a custom title bar containing window controls, page entries, theme and feedback entries. The following sections describe the title bar from left to right and then cover first-run onboarding, the MCP server dialog, themes, the startup fallback page, window position and size memory, the configuration and data directory, common shortcuts and error reporting.

<GuideMedia
  poster="/img/landing/hero.png"
  caption="Real main window: the top row contains the app icon, +, WSL / ADB / Bluetooth entries, MCP, theme style, Submit issue, Update (shown when a new version is detected), the light/dark switch and the window controls."
/>

## Title bar

| Entry | Behaviour |
|---|---|
| App icon | Returns to the serial main view (from the WSL / ADB / Bluetooth page); hover shows the version and commit |
| + | Adds a pane: on the serial page, an extra monitor (copies the main pane configuration and widens the window); on the WSL page, a WSL monitor; on the Bluetooth page, toggles the embedded serial monitor on the right; unavailable on the ADB page |
| WSL | Opens the WSL port mapping page; clicking the button again returns to the serial main view |
| ADB | Opens the ADB debugging page; clicking the button again returns |
| Bluetooth | Opens the Bluetooth debugging page; clicking the button again returns |
| MCP | Opens the MCP server dialog; the status dot at the lower right of the icon indicates server status |
| Theme style | Dropdown list of 6 colour styles; see [Themes](/en/guide/theme) |
| Submit issue | Opens the [GitHub new issue page](https://github.com/SeaHi-Mo/Seahi-Serial/issues/new) in the system browser |
| Update | Shown only when a new version is detected |
| Light/dark switch | Switches between dark and light |
| Minimize / Maximize / Close | Window controls; the maximize button toggles back to restored |

Page switching replaces the entire page: WSL, ADB and Bluetooth are separate pages, the corresponding title-bar button is highlighted, and clicking it again returns to the serial main view. The app icon performs the same operation.

### Update button

The update button is hidden by default. The application checks for updates about 2 seconds after startup and then every 10 minutes. When a new version is detected, the button is shown with the text "更新" followed by the latest version number.

Clicking the button changes its text to "正在下载...", then to "正在安装...", and then starts the installer and exits the application; the configuration is saved before exit. The download is verified using the SHA-256 or file size provided by GitHub, and a failed verification aborts the installation. A download or installation failure shows "更新失败: …" and restores the button to the available state. A routine check failure does not show a dialog; it only writes to the log and reports the error.

### Window controls and dragging

The far right of the title bar contains the Minimize, Maximize/Restore and Close buttons. Holding a blank area of the title bar allows the window to be dragged; pressing on interactive controls such as buttons, dropdowns and inputs does not start dragging. Closing the window first saves the configuration and window position/size, then releases serial ports, stops background threads and exits.

## First-run onboarding

On the first launch (when no onboarding-complete marker exists on this machine), a nine-step tour appears about 600ms after the interface is ready:

1. Global bar: the extra pane and WSL entries on the left; the theme, feedback and light/dark entries on the right.
2. Choose a serial port: select a port from the dropdown list; the list refreshes automatically when devices are plugged in or removed.
3. Set the baud rate: enter or select a baud rate; the default is 115200.
4. Start monitoring: connect the serial port after confirming the port and baud rate.
5. Toolbar buttons: clear, auto-scroll, auto-reconnect, terminal mode, line numbers, timestamps, echo and more settings.
6. Send data: Text / HEX send modes and send history.
7. Quick commands: the collapsed pane on the right side of the output area.
8. Advanced settings: data bits, stop bits, parity, DTR/RTS control and log saving in the gear menu.
9. Get started: finish the tour.

The Next button advances to the next step; on the last step its text becomes "开始使用". Clicking Skip or a blank area of the overlay closes the tour immediately. Completing or skipping stores a completion marker, and the tour is not shown automatically on later launches.

## MCP server dialog

Click the MCP icon in the title bar to open the dialog. The status dot at the lower right of the icon indicates server status:

| Status dot | Meaning |
|---|---|
| Grey | Not enabled, or the status has not been read |
| Green | Enabled with no client sessions |
| Theme accent colour | Enabled with at least one client connected |
| Red | Not enabled, and the last run encountered an error |

The dialog provides the following operations: enable or disable the server, toggle read-only mode, select the transport (HTTP / SSE / All), copy both connection addresses and the corresponding client configurations, copy the installation prompt, reset the access token, and view status and the last error. The error reason is displayed in the "last error" field. See [MCP setup](/en/guide/mcp) for connection and configuration steps.

## Theme style and light/dark

The theme style dropdown list provides 6 styles: Default, Ukiyo-e, Poetic East, Ink Wash, Peach Blossom and Golden Wind. Each style contains a light and a dark variant, for 12 themes in total.

The dropdown options switch the colour style, and the light/dark switch on the right toggles between light and dark. Switching updates the output area, terminal, sidebar and buttons at the same time, and the title-bar background colour changes accordingly. The selection is written to config.json and restored on the next launch; on the first launch with no saved selection, the system light/dark setting is used. Changes to the system setting while the application is running do not switch the theme, so a saved selection is never overwritten.

See [Themes](/en/guide/theme) for the full description.

## Startup fallback page

During interface initialisation, the page first shows "正在初始化界面…" and hides it after the main pane is created successfully. The fallback page is shown in the following cases:

- Initialisation fails and the main pane was not created: the title shows "界面初始化失败" and the error detail is displayed below.
- The main pane is still not created after 8 seconds: the title shows "界面初始化超时" and a reload prompt is displayed.

The fallback page provides two buttons: "重新加载" (reload the page) and "退出应用" (close the application). Errors that reach the fallback page are also reported to the error collection service.

The main window is hidden at startup to avoid displaying the default size before the geometry is restored, and is shown when the page is ready. All fallback paths reveal the window first, and the backend forces it to show again after 4 seconds so that the application never starts without a visible window.

## Window position and size memory

The window position, size and maximised state are recorded in `window.json` and restored on the next launch. Moving or resizing the window saves after approximately 400ms of debounce, and closing the window saves immediately.

While the window is maximised, the most recent normal size is retained and restored when the window is unmaximised. The window remains hidden at startup and is shown once after the geometry is restored, so the default size is not displayed first.

If the restored position is not visible on any monitor (for example, after a secondary display has been disconnected), the position is ignored and the window remains centred by default. The minimum window size is 838×650. When upgrading from an older version that has no `window.json`, the old size fields in `config.json` are used as a one-time fallback.

## Configuration and data directory

The data directory is `%APPDATA%\seahi-serial`. Enter `%APPDATA%` in `Win + R` and open the `seahi-serial` directory.

| File | Purpose |
|---|---|
| config.json | Interface and device settings: theme, monitors, quick commands, workflows, log directory, WSL auto-mapping, Bluetooth page state, OTA profile and other settings. Changes are written after approximately 500ms of debounce and forced on close or exit; when the configuration schema version is unrecognised, the file is backed up as config.json.bak |
| window.json | Window position, size and maximised state; written by the backend on move/resize (approximately 400ms debounce) and on close |
| ai-config.json | MCP server settings: enabled state, host, port, access token, read-only mode, transport and call-log settings; written atomically and kept strictly separate from config.json |
| ai-calls.jsonl | AI tool-call records, one JSON line per call, appended and rotated by file count; the record switch is located in the MCP settings |
| log-cache | Invisible session log cache (`session-*.log`), written automatically when a session has traffic and requiring no manual save; at most 10 files, 8 MiB per file and approximately 64 MiB in total |

## Common shortcuts

| Location | Keys | Action |
|---|---|---|
| Send input | Enter | Sends the current content; when the history dropdown is open with a selected item, fills that item first without sending |
| Send input | ↑ | Fills the previous send-history entry; moves up instead when the history dropdown is open |
| Send input | ↓ | Opens the send-history dropdown; moves down when the dropdown is already open |
| Send input | Esc | Closes the history dropdown and resets the history position |
| Terminal (line buffer) | ↑ / ↓ | Browses the local command history |
| Terminal (line buffer) | ← / →, Home / End, Delete, Backspace | Edits the current line locally without sending to the device |
| Terminal (line buffer) | Ctrl+C | Clears the current half line and sends interrupt 0x03 |
| Terminal (line buffer) | Ctrl+U | Clears the current line |
| Terminal (line buffer) | Enter / Tab | Enter sends the whole line with the line ending; Tab sends 0x09 |
| Terminal (any mode) | Ctrl+Shift+C | Copies selected text in the terminal |
| Terminal (direct) | Any key | Sent as-is, including arrow keys and Ctrl combinations |

The "命令行缓冲" switch in the toolbar selects between these two input modes; see [Terminal mode](/en/guide/terminal) for the full description.

## Error reporting

The application does not provide a separate report button. Frontend uncaught script errors, unhandled Promise rejections and errors already shown in the interface are reported through a unified entry, and backend runtime errors are also reported. The same type of error is reported at most once every 5 minutes; a failed report writes one line to the local log and does not affect use. Reporting is disabled by setting the `SEAHI_ERROR_REPORT=0` environment variable, and the local debug log is located at `%TEMP%\seahi-serial-debug.log`.

See [Error reporting](/en/guide/error-reporting) for report fields, timing, destination and the disabling procedure.
