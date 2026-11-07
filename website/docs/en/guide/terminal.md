# Terminal mode

The terminal button in the toolbar switches the output area to an xterm.js canvas. Cursor movement, screen clearing, colours and full-screen programs are handled by xterm, so `vim` and `top` work normally over the serial connection.

<GuideMedia
  src="/img/landing/terminal.mp4"
  poster="/img/landing/feature-terminal.png"
  caption="Typing commands in terminal mode; output is rendered with ANSI colours."
/>

## When to use terminal mode

- The other end of the serial link is a Linux console or shell, and you need readline editing, completion and full-screen programs.
- The program moves the cursor, clears the screen or switches to the alternate screen, as `vim`, `top` and `less` do.
- The normal output view strips cursor and erase sequences and shows text line by line, so these screens only render correctly in terminal mode.

For reading logs, saving them, or adding line numbers and timestamps, the normal output view is the better fit.

## Entering and leaving

- Click the terminal icon in the toolbar. The normal output area and the bottom send bar are hidden and keystrokes go straight to the canvas; leave terminal mode to use the send input again.
- Each pane owns one xterm instance. Switching away and back reuses it; closing the pane disposes it. Terminal mode is not restored on restart, and the canvas starts empty: terminal history is not saved.
- **Clear output** also clears the canvas, the normal output buffer and the session cache on disk.
- `Ctrl+Shift+C` copies the selected text. `Ctrl+C` does not copy; it is sent to the device as `0x03`.
- The canvas scrolls up, and xterm keeps the last 5000 lines. New data scrolls to the bottom automatically.
- Entering terminal mode sends one carriage return (`CR`) to the device, so it prints a fresh prompt and the canvas has something to show immediately. Nothing is sent when the port is disconnected, and old output from the normal view is not replayed. No local notice is shown either.

## Keyboard and canvas

- The canvas takes focus automatically when terminal mode is entered, so you can start typing; click it again if focus moved elsewhere.
- The mouse wheel and scrollbar act on xterm's own scrollback and do not move the normal output area.
- Selection is made by dragging with the mouse; copying uses `Ctrl+Shift+C` only.
- Full-screen programs work: entering and leaving the alternate screen is handled by xterm, and the previous screen returns when the program exits.

## Size and layout

- The canvas recalculates its columns and rows when the pane or window is resized, so it adapts after switching pages or widening a pane.
- Serial ports have no PTY line discipline, so this size only decides how the canvas is laid out. The device is not told that the window size changed, so full-screen programs draw at defaults or at sizes they assume.

## Direct send and line buffering

The **Line buffering** button in the toolbar controls how keystrokes are sent. It is on by default for serial panes and off for WSL panes. Toggling it clears any half-typed line.

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

- Keys go to the device unchanged: Enter is `0x0D`, Tab is `0x09`, arrow keys are `ESC[A` sequences, and Ctrl combinations are sent as they are.
- No line ending is appended and no key is intercepted. This is what full-screen programs such as `vi` and `top`, and a shell's readline, expect.
- Pasted text is sent as-is, including any line breaks it contains.

## Line buffering

- Printable characters go into a local buffer and are echoed; Enter sends the whole line plus the line ending in one go. Pressing Enter on an empty line sends only the line ending.
- Backspace (`0x7F` / `0x08`) deletes locally and is not sent.
- Left and right arrows move the cursor, Home and End jump to the start or end of the line, Delete removes the character at the cursor, and up/down browse local command history. None of these keys are sent.
- History holds up to 200 entries; identical consecutive commands are stored once. It belongs to this pane only and is cleared when the pane closes or the app exits.
- `Ctrl+C` flushes the half-typed line first and then sends `0x03`; `Ctrl+U` erases the line without sending anything.
- Tab and other control keys are still sent directly, and function keys such as F1–F12, PgUp and PgDn are forwarded unchanged.
- A single line is capped at 8192 characters. At the cap the buffer is sent without a line ending and does not enter history. Split long data into several sends instead.
- Local echo counts one column per character, so wide characters such as CJK or emoji will misalign. Line buffering targets ASCII content such as AT commands; use direct send when wide characters must display correctly.

Line buffering suits AT commands. Sending key by key, pressing Enter with only `\r`, and sending backspace as `0x7F` can all break AT command input. Line buffering collects the full line and appends the configured line ending, which is what modules expect.

If the device has echo enabled (`ATE1`), typed text appears twice. This is expected; use `ATE0` to disable echo on the device.

## Paste and command logging

Logging every keystroke would flood the log, so terminal mode records commands only:

- One entry when a line is submitted with Enter, and one entry per line when text is pasted. Both go to the `serial:<pane>:tx` channel with the source set to `ui`.
- A burst of several printable characters is treated as a paste. Pure escape sequences such as arrow keys are not recorded, so `[A` is never mistaken for typed text.
- Commands recalled from the device-side readline history with `↑` were never received by the app, so they are not recorded. Missing an entry is better than inventing one.
- If sending fails, a red `[Send failed]` line appears in the canvas; details stay in the developer console.
- A line submitted with Enter in line buffering, and the key stream in direct send, both use the same send command as the normal send bar, with a 5 second timeout.

## Terminal mode in WSL panes

WSL panes use the same terminal button and xterm canvas, with different defaults:

- Line buffering starts off, so keys go out one by one and the Linux shell keeps readline, completion and arrow keys.
- Turn line buffering on manually when sending AT-style whole-line commands.
- The normal output area is hidden in the same way, and the WSL pane's log and log hub keep working.

## Terminal mode and the normal output area

- The normal output area is only hidden in terminal mode. Log lines are still generated and line numbers and timestamps are still computed; they are just not visible, and leaving terminal mode shows the full history.
- The session cache, the log hub and MCP `serial_get_output` read the text from the normal output area. The terminal canvas is not written to disk separately.
- **Clear output** clears both: the canvas, the output buffer and the session cache file.
- Leaving terminal mode does not replay the canvas into the output area. Each side keeps its own display history.

## Controls in terminal mode

| Control | Behaviour in terminal mode |
|---|---|
| Clear output | Clears the canvas, the normal output buffer and the current session cache |
| Line numbers / timestamps / message echo | Greyed out; they apply only to the normal output view |
| Line buffering | Available; decides whether keys are sent one by one or as whole lines |
| Send input | Hidden; type directly on the canvas |
| Save log / copy all | Unchanged; they still use the full text from the normal output area |
| More settings (log directory, workflows) | Still available |

## Colours

- The 16 ANSI colours follow the current theme and share the normal output area's colour definitions; all 12 themes have their own set.
- Background and foreground come from the actual output area colours; the cursor and selection use the theme accent colour, with a translucent selection.
- Switching theme or light/dark rebuilds the palette immediately, so the terminal already has the right colours when you switch back.

## Colour in the normal output view

The normal output view only parses 16-colour ANSI escapes (30–37, 90–97, bold). 256-colour and true-colour escapes are shown as plain text. Full colour support is available only in terminal mode.

## Greyed-out controls

**Line numbers**, **timestamps** and **message echo** apply only to the normal output view, so they are greyed out in terminal mode; hovering over them explains why.

Greying out changes appearance only. Your previous switch states are kept and take effect again when you leave terminal mode.

The reverse also holds: **Line buffering** only matters in terminal mode and is greyed out while terminal mode is off.
