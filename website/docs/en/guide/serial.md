# Serial debugging

The serial page is the first page you see. Each pane is one serial monitor; you can put several side by side and give each its own port, baud rate and line ending.

<GuideMedia
  poster="/img/landing/feature-panes.png"
  caption="Two panes connected to COM9 and COM17, each with its own port and settings."
/>

## Panes

The **+** button at the left of the top bar adds a pane. On the WSL page it adds a WSL pane, and on the Bluetooth page it toggles the embedded serial monitor on the right; what it does follows the current page.

- A new pane inherits the main pane's baud rate, line ending, display switches and quick commands. You can pick a different port in its own toolbar; the send history starts empty.
- There is no limit on the number of panes. When a pane is added and the window is too narrow, the window is widened automatically (about 419 px per pane); below that the pane container scrolls horizontally.
- Extra panes have an **✕** at the top right. Closing one releases its serial port (waiting up to 3 seconds), disposes the terminal canvas and stops any quick command loop. The main pane has no close button.
- Panes are independent. A port already open in one pane is marked as in use in every other pane's port list and cannot be selected there.

The app icon in the top bar returns to the serial page; the WSL, ADB and Bluetooth icons open their pages. Switching pages does not disconnect anything: the receive poll drops from 25 ms to 500 ms while a pane is hidden and returns to normal when it is visible again.

## Toolbar

| Control | Purpose |
|---|---|
| View | Display output as text or HEX. This changes display only, not how data is sent |
| Port | Choose the COM port; the refresh button reloads the list, and plugging or unplugging a device refreshes it automatically |
| Baud rate | 33 common values (50–4000000), or type a value directly (110–4000000). Defaults to 115200 |
| Line ending | CRLF, LF, CR or none. Defaults to CRLF |
| Start / Stop monitoring | Open or close the port; stopping releases it |
| Icon buttons | Clear output, auto-scroll, auto-reconnect, terminal mode, line buffering, line numbers, timestamps, message echo, more settings |
| More settings | Data bits, stop bits, parity, DTR/RTS, log directory, workflows and so on |

Changing the baud rate while connected reconnects automatically: the old connection is closed and the port is reopened with the new rate.

Changing the port while monitoring works the same way: the old port is released, the new one is opened, and the output area shows a line about the switch. A port that another pane already owns is not switched to.

## Icon buttons

- Clear output: clears the output area, the terminal canvas and the in-memory buffer, and truncates the session cache file on disk.
- Auto-scroll: on by default. The output area stays pinned to the bottom; clicking into it to edit pauses scrolling until the mouse leaves or the area loses focus.
- Auto-reconnect: off by default. See [Reconnecting](#reconnecting).
- Terminal mode: replaces the output area with an xterm canvas. See [Terminal mode](/en/guide/terminal).
- Line buffering: only available in terminal mode; on by default for serial panes.
- Line numbers: numbers output lines; empty lines are not numbered.
- Timestamps: prefixes each line with `[hour:minute:second.millisecond]`.
- Message echo: when sending, the content is first shown in the output area as a `send` line; in HEX mode it appears as `HEX: AA 55`. With echo off, only device output appears.
- More settings: expands or collapses the advanced row below the toolbar. New panes start with it expanded.

## More settings

- Data bits: 5, 6, 7 or 8. Defaults to 8.
- Stop bits: 1 or 2. Defaults to 1.
- Parity: none, odd or even. Defaults to none.
- DTR is off by default and RTS is on by default. They only take effect while connected; repeated clicks are debounced by 100 ms, so only the final state is sent.
- Choose log directory: opens the system folder picker. The **Save log** button and the workflow **Save log** action both write into this directory.
- Save log: saves the current output as `Serial Debug YYYY-MM-DD HHMMSS.txt`. It is not a Save As dialog; the file is written straight into the directory chosen above. Without a chosen directory the app reports **No log directory set**.
- Copy all: copies the complete in-memory log to the clipboard, including lines already scrolled out of view.
- Collapse toolbar: shrinks the toolbar to a thin strip; hover over it to expand temporarily, or click again to keep it open.
- **+ Add rule**: creates a workflow rule. See [Workflows](#workflows).

## Sending

Press Enter in the input box or click **Send**. The send button stays disabled until the port is open.

The **Text / HEX** selector at the right of the input box is independent of the toolbar **View** setting. You can view text and send HEX, or the other way round.

Text mode:

- Data is sent as UTF-8.
- `\r`, `\n`, `\t` and `\\` are decoded as escapes.
- The selected line ending is appended before sending. Escapes and the line ending are separate: the line ending is always appended as well.

HEX mode:

- Whitespace and a `0x` prefix are ignored and bytes are read in pairs, for example `AA 55 0x01`.
- An odd number of hex digits reports **Hex length must be even**; a non-hex character reports **Invalid hex: xx**. The error is written to the output area and nothing is sent.
- HEX sends do not append a line ending.

Send history:

- Each pane keeps the last 50 entries; consecutive duplicates are stored once.
- `↑` fills the previous entry into the input box; `↓` opens the history list with the newest entry selected, and further `↓` presses move down. Enter inserts the selected entry and `Esc` closes the list.
- The last 20 entries are saved in the configuration and survive a restart.

<GuideMedia
  src="/img/guide/serial.mp4"
  poster="/img/guide/serial.png"
  caption="Sending a command and viewing the device response in the output area."
/>

## Output area

- Text mode decodes UTF-8 as a stream, so a multi-byte character split across polling chunks is not garbled.
- A new line starts only on a real line break: `\r\n`, `\n` and a lone `\r` all count. Polling chunk boundaries never create fake line breaks.
- HEX mode shows bytes; each line holds at most 192 hex characters and the first line carries the `HEX:` prefix.
- Scrolling to the top loads older buffer content 1000 lines at a time. The output area has a line limit of its own; the full log lives in the in-memory buffer (8 MiB budget, trimmed to half when exceeded), and **Save log** and **Copy all** read from that buffer.
- If the UI cannot keep up (a pane hidden for a long time, or a device sending very fast), the backend receive buffer drops the oldest data once it reaches 256 KiB and reports **N bytes were dropped** in the output area.

## Logs and cache

**Clear output** is not just a screen clear: it empties the output area, the terminal canvas and the in-memory buffer, and truncates the current session's cache file on disk. A session that has not written anything yet does nothing and reports no error.

While a serial port is open, any traffic is cached to disk: one file per session, written in batches every 300 ms:

```
%APPDATA%\seahi-serial\log-cache\session-<date-time-ms>-<port>.log
```

- At most 10 files are kept; the oldest is removed before a new file is created.
- A single file stops at 8 MiB, gets a final marker line, and the UI reports it once. A file currently being written is never deleted.
- When the directory reaches 64 MiB in total, files are removed starting with the oldest.
- Auto-reconnect keeps using the same cache file, so the log stays continuous. An empty file is removed when the session ends.

Use **More settings → Save log** to keep a copy. The app never deletes files you saved manually.

## Reconnecting

Auto-reconnect is off by default. When it is on and a read fails, the app does this:

1. Closes the port and changes the button to **Waiting for connection**; the port list and send button are disabled.
2. Retries up to 10 times, with a delay of 2 seconds × attempt number, capped at 20 seconds.
3. On success the button returns to **Stop monitoring**. After 10 failures it returns to **Start monitoring** and the session cache is closed.

Clicking **Stop monitoring** yourself does not trigger auto-reconnect. Clicking **Start monitoring** after auto-reconnect gives up is a manual reconnect.

Nothing is written to the log during reconnecting: the output area only ever contains device data. Progress is visible in the button text and the port status dot.

## Workflows

Workflow rules live under **More settings**. Click **+ Add rule** to create one; the rule list appears below the toolbar.

A rule has:

- A name, an enable checkbox, a run/stop button, a collapse toggle and a delete button.
- Conditions: string contains, regular expression, or exact bytes (HEX). A rule can have several conditions and fires only when all of them match. Matches also work across polling chunk boundaries.
- Actions: send data (text or HEX; text gets the current line ending), toggle a signal (DTR or RTS, high or low), save log (appends received data to `workflow_log.txt` in the chosen log directory). Actions run in order and each can have a delay in milliseconds.

Rules are checked only while monitoring. When a rule fires, a `[Auto] ...` line appears in the output area, and the same line is written to the `workflow` channel of the log hub.

Limits: 50 rules per pane, 8 conditions and 8 actions per rule, 64 characters for the name, 512 for a condition value and 4096 for action data.

Clicking run on the panel starts the rule immediately. Through MCP, rules are always created stopped and must be started with `serial_workflow_run` plus `confirm:true`.
