# Terminal mode

The terminal button in the toolbar switches the output area to an xterm.js canvas. Cursor movement, screen clearing, colours and full-screen programs are handled by xterm, so programs such as `vim` and `top` on the other end of the serial link display and operate normally.

<GuideMedia
  src="/img/landing/terminal.mp4"
  poster="/img/landing/feature-terminal.png"
  caption="Typing commands in terminal mode; output is rendered with ANSI colours."
/>

## When to use terminal mode

Terminal mode applies to the following cases:

- The other end of the serial link is a Linux console or shell that requires readline editing, completion and full-screen programs.
- The program controls the cursor position, clears the screen or switches to the alternate screen, as `vim`, `top` and `less` do.

The normal output area strips cursor and erase control sequences and shows text line by line, so these screens can only be reproduced in terminal mode. When the task is limited to reading logs, saving logs or adding line numbers and timestamps, the normal output view is sufficient.

## Entering and leaving

Clicking the terminal icon in the toolbar enters terminal mode; the normal output area and the bottom send bar are hidden and keystrokes are sent directly to the terminal canvas. To use the send input box, leave terminal mode first.

Each pane owns an independent xterm instance; switching panes or pages reuses the instance, and closing the pane disposes it. Terminal mode is not restored after a restart, the canvas starts empty, and terminal history is not saved.

Clear output clears the canvas, the normal output buffer and the disk session cache at the same time. `Ctrl+Shift+C` copies the selected text; `Ctrl+C` is not a copy shortcut and is sent to the device as `0x03`.

The canvas scrolls upward and xterm keeps the last 5000 lines; new data scrolls to the bottom automatically. On entering terminal mode, if the port is connected, the app sends one carriage return (`CR`) and the device prints a fresh prompt; the app does not replay old log lines from the normal output area and does not show a local notice.

## Keyboard and canvas

The canvas takes focus automatically after terminal mode is entered and accepts input directly; if focus moves elsewhere, clicking the canvas restores it.

The mouse wheel and scrollbar act on xterm's own scrollback and do not affect the normal output area's scroll position. A selection is created by dragging with the mouse, and copying uses `Ctrl+Shift+C`.

Full-screen programs rely on xterm to enter and restore the alternate screen, and the previous screen returns when the program exits. The app does not implement local Tab completion; the Tab key is sent to the device and completion is handled by the shell on the device.

## Size and layout

The canvas recalculates its columns and rows when the pane width or window size changes, and adapts after page switches or pane width adjustments.

Serial ports have no PTY line discipline, so this size only determines the canvas layout. The device is not notified of window size changes, and full-screen programs draw at default or preset sizes.

## Direct send and line buffering

The Line buffering button in the toolbar determines how keystrokes are sent. It is on by default for serial panes and off for WSL panes; toggling it clears input that has not been submitted.

| | Direct (buffer off) | Line buffer (buffer on) |
|---|---|---|
| Typing | Each key is sent immediately | Keys are collected into a line locally |
| Enter | Sends `CR (0x0D)` only | Sends the whole line plus the toolbar line ending |
| Backspace | Sends `0x7F` | Erases locally and is not sent |
| Arrow keys | Sends `ESC[A/B/C/D` as-is | Edits the current line locally; up/down browse history |
| Echo | Handled by the device tty | Echoed once locally |
| Tab | Sends `HT (0x09)` | Sends `HT (0x09)` |
| Best for | Linux consoles, shells, full-screen TUIs | AT commands and serial protocols |

## Direct send

- Keys are sent to the device unchanged: Enter is `0x0D`, Tab is `0x09`, arrow keys are sequences such as `ESC[A`, and Ctrl combinations are also sent unchanged.
- No line ending is appended and no key is intercepted; full-screen programs and the shell readline depend on this mode.
- Pasted content is sent as-is, including line breaks.

## Line buffering

- Printable characters first enter a local buffer and are echoed; Enter sends the whole line plus the line ending in one pass, and Enter on an empty line sends only the line ending.
- Backspace (`0x7F` / `0x08`) deletes characters locally and is not sent to the device.
- Left and right arrows move the cursor, Home and End move to the start or end of the line, Delete removes the character at the cursor, and up/down browse local command history; these keys are not sent to the device.
- History holds at most 200 entries, and consecutive duplicates are stored once; history exists only in the current pane and is cleared when the pane closes or the app exits.
- `Ctrl+C` clears the unsubmitted input first and then sends `0x03`; `Ctrl+U` clears the current line without sending anything to the device.
- Tab and other control keys are sent directly, and function keys such as F1 to F12, PgUp and PgDn are sent to the device unchanged.
- A single line is limited to 8192 characters; at the limit the app sends the buffer directly without a line ending, and the content does not enter history. Long data should be sent in several parts.
- Local echo counts one column per character, so wide characters such as CJK and emoji misalign; line buffering targets ASCII content such as AT commands, and direct send should be used when wide characters must display correctly.

Line buffering suits AT commands. Sending key by key, sending only `\r` on Enter, and sending backspace as `0x7F` all prevent modules from parsing AT commands correctly. Line buffering caches the whole line and appends the line ending, which modules recognize correctly.

When the device enables echo (`ATE1`), input appears twice; this is expected, and disabling device echo (`ATE0`) resolves it.

## Paste and command logging

Terminal mode records command-level operations only, because per-character logging makes the log difficult to read:

- One entry is recorded when a line is submitted with Enter, and one entry per line when text is pasted; entries are written to the `serial:<pane>:tx` channel with the source marked `ui`.
- Multiple printable characters in one input are treated as a paste; pure escape sequences such as arrow keys are not recorded, and `[A` is not treated as user input.
- Commands recalled from the device-side readline history with `↑` were not received by the app, so they are not recorded.
- On a send failure, the canvas displays a red `[Send failed]` line and the detailed reason is written to the developer console.
- A line submitted with Enter in line buffering and the key stream in direct send use the same send command, with a timeout of 5 seconds.

## Terminal mode in WSL panes

WSL panes use the same terminal button and xterm canvas with different defaults:

- Line buffering is off by default, keys are sent one by one, and the Linux shell's readline, completion and arrow keys are preserved.
- Line buffering can be enabled manually when sending AT-style whole-line commands.
- The normal output area is hidden in the same way, and the WSL pane's log and log hub continue to work.

## Terminal mode and the normal output area

The normal output area is only hidden in terminal mode; log lines are still generated and line numbers and timestamps are still computed, and the full history is visible after leaving terminal mode.

Session cache, log hub and MCP `serial_get_output` all read the normal output area's text, and the terminal canvas is not written to disk separately.

Clear output clears the canvas, the output buffer and the disk cache file together. Leaving terminal mode does not replay canvas content into the output area; the canvas and the output area maintain their own display content.

## Controls in terminal mode

| Control | Behavior in terminal mode |
|---|---|
| Clear output | Clears the canvas, the normal output buffer and the current session cache |
| Line numbers / timestamps / message echo | Greyed out; they apply only to the normal output view |
| Line buffering | Available; determines whether keys are sent directly or as whole lines |
| Send input | Hidden; keys are entered directly on the canvas |
| Save log / copy all | Unchanged; they operate on the full text of the normal output area |
| More settings (log directory, workflows) | Available as usual |

## Colours

- The 16 ANSI colours follow the current theme and share the normal output area's colour definitions; all 12 themes have their own set.
- Background and foreground come from the output area's actual colours; the cursor and selection use the theme accent colour, and the selection is translucent.
- Switching theme or light/dark mode rebuilds the palette immediately, so colours are current when terminal mode is re-entered.

## Colour in the normal output view

The normal output view parses only the 16-colour ANSI escapes carried by the log (30–37, 90–97 and bold); 256-colour and true-colour output is displayed as plain text, and colour support is provided in terminal mode only.

## Greyed-out controls

Line numbers, timestamps and message echo apply only to the normal output view; they are greyed out in terminal mode and a hover tooltip explains the reason.

Greying out changes appearance only and does not modify the existing switch states, which continue to apply after leaving terminal mode. Conversely, line buffering applies only to terminal mode and is greyed out while terminal mode is off.
