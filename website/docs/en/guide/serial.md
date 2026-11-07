# Serial debugging

The serial page is the default page after startup. Each pane corresponds to one serial monitor; multiple panes can run in parallel, each with its own port, baud rate and line ending.

<GuideMedia
  poster="/img/landing/feature-panes.png"
  caption="Two panes connected to COM9 and COM17, each with its own port and settings."
/>

## Panes

The + button at the left of the toolbar adds a pane. Its behavior follows the current page: on the WSL page it adds a WSL pane, and on the Bluetooth page it toggles the embedded serial monitor on the right.

A new pane inherits the main pane's baud rate, line ending, display switches and quick commands; the port can be selected separately in that pane's toolbar, and the send history starts empty. There is no limit on the number of panes. When a pane is added and the window is too narrow, the window is widened automatically at an estimated 419 px per pane; if that is still insufficient, the pane container scrolls horizontally.

Extra panes provide a ✕ button at the top right. Closing a pane releases its serial port, waiting up to 3 seconds, and disposes the terminal canvas and any quick command loop. The main pane has no close button.

Ports are occupied independently by panes. After a pane opens a port, other panes' port lists mark that entry as in use and it cannot be selected. The app icon in the title bar returns to the serial page; the WSL, ADB and Bluetooth icons open their pages. Switching pages keeps serial connections open: the receive polling interval changes from 25 ms to 500 ms and returns to normal on the serial page.

## Toolbar

| Control | Purpose |
|---|---|
| View | Display output as text or HEX; affects display only, not the send format |
| Port | Select a COM port; the Refresh button reloads the list, and plugging or unplugging a device refreshes it automatically |
| Baud rate | 33 common values (50–4000000), or a directly entered value (110–4000000); defaults to 115200 |
| Line ending | CRLF, LF, CR or none; defaults to CRLF |
| Start / Stop monitoring | Open or close the port; stopping releases the port |
| Icon buttons | Clear output, auto-scroll, auto-reconnect, terminal mode, line buffering, line numbers, timestamps, message echo, more settings |
| More settings | Data bits, stop bits, parity, DTR/RTS, log directory and workflows |

Changing the baud rate while connected triggers an automatic reconnect: the app closes the old connection and reopens the port with the new rate. Changing the port while monitoring releases the old port first, connects the new port, and writes a switch notice to the output area; a port occupied by another pane is not switched to.

## Icon buttons

The right side of the toolbar contains a group of icon buttons with the following defaults and functions:

- Clear output: clears the output area, the terminal canvas and the in-memory buffer, and truncates the current session's disk cache file.
- Auto-scroll: on by default. While on, the output area stays at the bottom; clicking into the output area to edit pauses scrolling until the mouse leaves or the area loses focus.
- Auto-reconnect: off by default; see Reconnecting.
- Terminal mode: replaces the output area with an xterm canvas; see [Terminal mode](/en/guide/terminal).
- Line buffering: available only in terminal mode; on by default for serial panes.
- Line numbers: adds line numbers to output lines; empty lines are not numbered.
- Timestamps: prefixes each line with `[hour:minute:second.millisecond]`.
- Message echo: writes the sent content to the output area as a `send` line before sending; in HEX mode it is shown as `HEX: AA 55`. With echo off, the output area shows only device output.
- More settings: expands or collapses the advanced settings row; new panes start expanded.

## More settings

| Setting | Description |
|---|---|
| Data bits | 5, 6, 7 or 8; defaults to 8 |
| Stop bits | 1 or 2; defaults to 1 |
| Parity | None, odd or even; defaults to none |
| DTR / RTS | DTR is off by default and RTS is on by default; effective only while connected; repeated clicks are debounced by 100 ms and only the final state is sent |
| Choose log directory | Opens the system folder picker; the Save log button and the workflow Save log action both write to this directory |
| Save log | Saves the current output as `Serial Debug YYYY-MM-DD HHMMSS.txt` directly into the chosen directory; without a chosen directory the app reports "No log directory set" |
| Copy all | Copies the complete in-memory log to the clipboard, including lines already scrolled out of view |
| Collapse toolbar | Collapses the toolbar to a thin strip and expands it temporarily on hover; clicking again keeps it open |
| + Add rule | Creates a workflow rule; see Workflows |

## Sending

Press Enter in the input box or click Send. The send button is unavailable until the port is connected. The send format is selected by the Text / HEX selector to the right of the input box and is independent of the toolbar View setting.

Text mode follows these rules:

- Data is sent as UTF-8.
- `\r`, `\n`, `\t` and `\\` are decoded as escapes.
- The toolbar line ending is appended before sending; escapes and the line ending are independent, and the line ending is always appended once.

HEX mode follows these rules:

- Whitespace and a `0x` prefix are ignored, and bytes are read in pairs, for example `AA 55 0x01`.
- An odd number of hex digits reports "Hex length must be even"; a non-hex character reports "Invalid hex: xx". Errors are written to the output area and no data is sent.
- HEX mode does not append a line ending.

Send history follows these rules:

- Each pane keeps the last 50 entries, and consecutive duplicates are stored once.
- `↑` fills the previous entry into the input box; `↓` opens the history list with the newest entry selected, and repeated `↓` moves down. Enter inserts the selected entry, and `Esc` closes the list.
- The last 20 entries are saved in the configuration and survive a restart.

<GuideMedia
  src="/img/guide/serial.mp4"
  poster="/img/guide/serial.png"
  caption="Sending a command and viewing the device response in the output area."
/>

## Output area

The output area processes device data according to the selected display mode. Text mode decodes UTF-8 as a stream, so a multi-byte character split across polling chunks is not garbled; chunk boundaries do not create line breaks, and a new line starts only on `\r\n`, `\n` or a lone `\r`. HEX mode shows bytes, with at most 192 hex characters per line and the `HEX:` prefix on the first line.

Scrolling to the top loads older buffer content 1000 lines at a time. The output area has a DOM line limit, and the full history is kept in the in-memory buffer with an 8 MiB budget; when exceeded, the buffer is trimmed to half. Both Save log and Copy all read from this buffer.

When the frontend cannot drain output in time, for example while the pane is hidden or the device sends very fast, the backend receive buffer drops the oldest data once it reaches 256 KiB and reports the number of dropped bytes in the output area.

## Logs and cache

Clear output empties the output area, the terminal canvas and the in-memory buffer, and truncates the current session's disk cache file. If the session has not written any content, the operation has no effect and reports no error.

While a serial port is open, any traffic is cached to disk with one file per session; content is written in batches every 300 ms:

```
%APPDATA%\seahi-serial\log-cache\session-<date-time-ms>-<port>.log
```

The cache directory follows these rules:

- At most 10 files are kept; the oldest file is removed before a new file is created.
- A single file stops at 8 MiB and keeps a final marker line; the UI reports this once, and a file currently being written is never deleted.
- When the directory reaches 64 MiB in total, files are removed starting with the oldest.
- Auto-reconnect keeps using the same cache file so the log stays continuous; an empty file is removed when the session ends.

Use More settings → Save log to keep a permanent copy; the app never deletes files saved manually.

## Reconnecting

Auto-reconnect is off by default. When it is on and a read fails, the app processes the failure in this order:

1. Closes the port and changes the button to Waiting for connection; the port list and send button are disabled.
2. Retries up to 10 times with a delay of 2 seconds multiplied by the attempt number, capped at 20 seconds.
3. On success the button returns to Stop monitoring; after 10 failures it returns to Start monitoring and the session cache is closed.

Clicking Stop monitoring manually does not trigger auto-reconnect. After auto-reconnect gives up, clicking Start monitoring performs a manual reconnect. Nothing is written to the log during reconnecting; the output area shows only device data, and progress is reflected by the button text and the port status dot.

## Workflows

Workflow rules are configured under More settings. Click + Add rule to create one; the rule list appears below the toolbar. Each rule contains the following settings:

- A name, an enable switch, run and stop buttons, a collapse button and a delete button.
- Conditions: string contains, regular expression or exact bytes (HEX); a rule can have several conditions and fires when all of them match, including matches across polling chunk boundaries.
- Actions: send data (text or HEX, with text appending the current line ending), toggle a signal (DTR or RTS, high or low) or save log (appends received data to `workflow_log.txt` in the chosen log directory); actions run in order and each action can have a delay in milliseconds.

Limits are 50 rules per pane, 8 conditions and 8 actions per rule, 64 characters for the name, 512 for a condition value and 4096 for action data.

Rules are checked only while monitoring. When a rule fires, a `[Auto] ...` line is written to the output area and to the `workflow` channel of the log hub. Clicking Run on the panel starts the rule; through MCP, rules are created stopped and must be started with `serial_workflow_run` plus `confirm:true`.
