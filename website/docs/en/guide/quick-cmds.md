# Quick commands

The quick command panel sits on the right side of the output area and starts collapsed. Click to expand it, then drag the tab left to widen it: at least 300px, at most 60% of the pane, always leaving 160px for the output area. It is meant for sequences that need a request and a response, such as network setup, calibration or writing parameter blocks.

<GuideMedia
  src="/img/guide/qcmd.mp4"
  poster="/img/guide/qcmd.png"
  caption="Expanding the quick command panel and collapsing a group."
/>

The header has the Loop sending switch on the left and + New loop group, Import and Export on the right. After importing a file, a source row appears under the header with the file name, Reload and Disconnect. Without a file, the list is stored in the local config. Once a file is attached, the file is the storage; the config keeps a cache that is used when the file cannot be read.

## Groups

Commands are organised into loop groups. Each group is its own table: group header, column header row, then data rows, matching the "one table per group" shape of the file.

- Rename a group directly in its header. When a file is attached, this line rewrites the `## group name` heading in the file. For an old file without headings, the rename only affects the panel; no heading is added to the file.
- Drag the dotted grip on the left of the header up or down to reorder groups. The topmost group is the loop start, and the table order in the file follows.
- The fold arrow only hides rows; it does not affect the loop.
- The slider switch on the header controls whether the group takes part in the loop. Turn it off to skip the whole group without changing sequence numbers; turn it back on to restore it. The switch and fold states live in the local config, not in an external file: there is no group-level switch column.
- The header shows the number of commands in the group. The × at the far right deletes the group and its commands. The last remaining group cannot be deleted; delete its commands instead.
- + Add is at the far right of the column header row and appends an empty command to that group. A new group is added at the bottom, named "循环 N" by default, and starts with one empty command. With a file attached, the group's heading, table header and first row are also appended to the file.

## Fields

| Field | Description |
|---|---|
| Sequence | Up to 4 digits. `0` means the command is not part of the loop; values greater than `0` are sent in ascending order inside the group, ties by row order |
| Command | Sent as written; escapes such as `\r\n` and `\t` work. Pressing Enter in the input is the same as clicking this row's send button |
| Timeout (ms) | Time occupied by this command, default 3000, maximum 600000 (10 minutes); see the next section |
| HEX | Send this command as hexadecimal, independent of the current text/HEX mode of the main send bar |
| Send / Delete | Send this row once (disabled while disconnected), or delete it |

There is no name field in the panel: a name column in the file is preserved as-is, but export copies omit it. Expected, Retry and the two jumps are also file-only. When they are present, the timeout cell gets a faint outline; hover it to see the values, and the import shows a message once.

## Timeout and Expected

The Timeout value works in two ways, decided by whether Expected has a value:

- Expected non-empty and timeout greater than 0: the timeout is the maximum wait for a reply. A success word moves on early; running out of time takes the failure branch.
- Expected empty: the command does not check replies, and the timeout is the interval before the next command. 3000 sends one command every 3 seconds.
- Timeout 0: no waiting (even with Expected set), send with the 20ms minimum interval.
- Clearing the timeout input resets it to 3000, not 0.

A row only waits for a reply when the file header declares an Expected column and that cell has a value. Without a success word there is nothing to match, and the built-in OK is not used as a fallback. To wait for the built-in OK, write `OK` in the Expected column.

## How replies are judged

Replies are judged line by line in the backend. The frontend only sends, waits, and follows the verdict:

- A reply must contain a line ending (`\r` or `\n`) to be split into lines. A partial line split across reads is joined; data with no line ending at all waits until the timeout.
- The line contains `busy`: keep waiting. It is not a verdict, does not resend, and does not extend the timeout.
- The line contains `error`: failure, resend this command. A line that also contains `busy` is treated as busy and keeps waiting.
- The line is exactly `OK`, or ends with ` OK` (such as `SEND OK`): success.
- The line exactly equals one of the words in Expected: success. Separate multiple words with `|`, for example `WIFI GOT IP|OK`. Comparison trims whitespace at both ends and ignores case, but it is whole-line equality, not contains.
- Lines that match nothing produce no verdict; the app keeps waiting.

For rows that wait, the built-in `OK` / `error` / `busy` are always active; Expected adds to them and cannot disable them. So "accept WIFI GOT IP but not OK" is not possible. When you need a contains match or a regex, use a workflow rule (More settings → Workflows, where the condition types include string contains, regex and exact bytes).

Retry: after ERROR, resend after 300ms. The default is 3 resends (up to 4 attempts in total), the maximum is 10, and `0` means no resend. Running out of time also counts as a failure. A failure follows the failure jump; without one, the whole chain stops. The stop message names the group and command and how long it waited; when retries run out it says "N consecutive ERROR replies".

The frontend asks the backend for a verdict every 60ms. The backend settles the timeout when queried, and the frontend adds a 400ms grace period so it does not answer ahead of the backend.

## Loop sending

Starting the loop checks two things: the monitor is connected, and at least one command with a sequence number greater than 0 exists in a participating group. If not, the app refuses and explains why; it never leaves the switch on while sending nothing.

- The order is groups top to bottom, then sequence numbers inside a group. After the last group the loop returns to the top group. Sequence `0` is skipped and takes no slot.
- The plan is rebuilt on every step: changing sequence numbers, dragging groups, adding or removing commands, or editing timeout/expected/jumps applies to the next step without restarting.
- A success jump runs after a success word; a failure jump runs after a timeout or after retries are exhausted. Empty or `next` means sequential order, a number jumps to that sequence number (across groups too), and `end` stops. An empty failure jump stops the whole chain.
- There is no "next group" jump; crossing groups is done with sequence numbers. Jumps look up sequence numbers, so if two groups use the same number, the first match in the plan wins.
- A jump target that does not exist is reported once at import. If the loop reaches that point, a success jump falls back to "next" and a failure jump to "stop", with the reason written to the console.
- Unrecognised jump values are treated as "next" and reported at import.
- More than 200 consecutive jumps stop the loop automatically (one sequential step resets the count). This guards against a loop that only circles between a few commands.

### Single sends and failures

Clicking a row's send button, or pressing Enter in the command input, sends that one command without starting the loop or waiting for a reply. It uses the same send path as the loop: the row's HEX switch chooses text or hexadecimal, text appends the panel's line ending, HEX does not, and an empty command is not sent. A failed manual send writes an error line to the output area.

The loop handles these cases separately:

- Empty command: skip it and continue. Skipping a full round's worth of commands means the chain has nothing to send, so the loop stops with a message.
- Disconnected, device write failure, or invalid HEX content: the send failed, so the whole chain stops immediately instead of jumping to another command.
- Normal finish (success jump set to "end"): stops silently, with no message.

While the loop runs, the output area gets nothing: sent, received OK, busy, resends, jumps, normal finish and skips are all omitted. Visibility is the panel only: the lit Loop sending switch and the blinking dot on the collapsed panel tab. To see whether a row waits for a reply, hover its timeout cell.

The loop stops itself on: disconnect (including three consecutive WSL read failures), send failure (disconnected, device write error, invalid HEX), a whole round with nothing to send, no commands with sequence greater than 0, a jump loop, retries exhausted, or a timeout. These stops show one message; the reason is in the message and details go to the console. Turning the switch off yourself shows nothing; closing the monitor just tears down the timers.

The Loop sending switch state is not saved, so the app never starts sending on launch. The quick command panel also always starts collapsed.

## External files

Import opens a native file picker and attaches the list to a file. After that, every add, edit and delete is written back (debounced 600ms); the file is the storage. Allowed extensions are md, markdown, txt, tsv and csv, but the format is detected from the content, not the extension.

- Only paths you picked in the native file dialog are accepted: the backend keeps its own allow-list (the 50 most recent), so the frontend cannot pass an arbitrary path.
- The same file cannot be mounted by two monitors. A second Import is rejected and tells you which pane to Disconnect first.
- Reload on the source row re-reads the file. A failed reload keeps the current list and shows a message instead of clearing it. On the next launch the file is re-read automatically; if it cannot be read, the cached config is kept.
- Before the window closes, a write-back still inside the 600ms debounce is flushed immediately.

### File format

A `## group name` heading starts a loop group (two or more `#`). A single `#` and `//` still start comments; comments, blank lines and table headers keep their original positions. An old file without headings is read as one group: no heading is added on read, and write-back does not change your table structure. The carrier is detected from the content (a `##` heading means Markdown is used), and write-back uses the detected one:

| Carrier | Looks like |
|---|---|
| Markdown table | Contains `\|`; recommended. Columns and groups are expressed with the header row and `##` headings |
| TSV | Tab-separated, for example pasted from Excel |
| Plain command lines | One command per line |

Line endings are written as CRLF. Parsing never splits on commas: `AT+CWJAP="ssid","pwd"` is one complete send, even if the file is named .csv.

A column is treated as a parameter only when the header declares it; undeclared columns are notes and are preserved as-is. Column names ignore case and strip spaces and annotations such as `(ms)`:

- Name: 名称, 名字, 标签, 指令名, name, label, title
- Command: 指令, 命令, 内容, 指令内容, 发送内容, cmd, command, value, data
- Sequence: 顺序号, 顺序, 序号, 次序, 序, order, seq, sequence
- Timeout: 超时, 超时时间, 超时毫秒, 等待, 等待时间, timeout, wait
- Expected: 期望, 期望值, 响应词, 成功词, expect
- Retry: 重试, 重试次数, retry, retries
- Success jump: 成功跳转, 成功后, 成功, ok跳转, okgoto, success, onsuccess
- Failure jump: 失败跳转, 失败后, 失败, err跳转, errgoto, fail, onfail, ongoto
- HEX: hex, hex开关, 十六进制, 格式, format, mode

Names such as `编号`, `no`, `num` and `index` are deliberately not recognised, so your ID column is not read as a sequence number and rewritten to `0`. The old column name 延时 is read as Timeout: the number stays, the meaning changes, and import says so once. When both columns exist, Timeout wins.

An old file without a header row: column 1 is the name, column 2 the command, and column 3 onward are notes. Columns are never mapped by position.

When the file starts with `---` (YAML) or `+++` (TOML), everything up to the matching closing line is kept as-is but is not interpreted by this version (YAML closing lines are `---` or `...`, TOML uses `+++`). The keys `baud`, `mode`, `lineEnding`, `delay`, `expect`, `timeout` and `hex` produce a "not applied yet" message: per-command parameters belong in declared columns (Timeout / Expected / Retry / HEX), while baud rate and line ending are set in the panel. A missing closing line is reported and the first line alone is treated as front matter; the rest is parsed normally.

### What import reports

A successful import shows no message (the list is visible and the source row shows the file name). These cases are reported once so nothing changes silently:

- Skipped rows: over 500 commands, or an over-long name or command. The first line number and reason are shown.
- Front matter keys that do not take effect, or front matter with no closing line.
- The old column name 延时.
- Expected / Retry values in the file (the panel does not show these fields; edit the file to change them).
- Success jump / failure jump values, or unrecognised jump values.
- Jumps pointing at sequence numbers that do not exist: success jumps fall back to "next", failure jumps to "stop".
- A header that recognises columns but omits some of Sequence / Timeout / HEX: those fields live only in the local config.
- Several tables in the file, read as several loop groups.

### Write-back rules

- Comments, headers, separator rows and extra columns keep their positions; only the command cells are rewritten.
- Untouched parameter cells are echoed as written: `0`, `是` or blank stays as it was. Only changed values, rows created in the panel and export copies are normalised to `0 / 3000 / true|false`. Cells that were empty stay empty; defaults are not filled in.
- Columns are never added: if the header has no Sequence / Timeout / HEX, nothing is added and those three live only in the local config (reported at import). Use Export for a self-contained file.
- With one group, write-back does not add a `##` heading (an existing heading is preserved as-is). Dragging, renaming or deleting groups edits the matching section in the file.
- A completely empty row is not written. In a file whose header declares Sequence / Timeout / HEX, a row with no command but with parameter values is kept; otherwise the panel and the file would disagree on the count.
- Before writing, the content hash is compared. If another editor changed the file, write-back reports a conflict instead of overwriting. Only a mount that has been read successfully once, with a known hash, is allowed to write.
- Writing is atomic (temporary file plus rename). The encoding from the read is kept: UTF-8 (including BOM) first, GBK as a fallback, and characters GBK cannot encode fall back to UTF-8.

### Export vs write-back

| | Write-back to the mounted file | Export copy |
|---|---|---|
| Columns | Your header only, never added | Filled in: Sequence / Command / Timeout (ms) / HEX / Expected / Retry / Success jump / Failure jump |
| Name column | Preserved as-is | Omitted |
| Group headings | Not written with one group | Always written for Markdown / TSV copies; a plain-line single-group copy has no heading |
| Carrier | The original carrier | Markdown / TSV by default; a plain-line single-group copy stays one command per line, while multiple groups upgrade to a Markdown table with a message |
| Notes | Your file is untouched | Markdown / TSV copies start with a `#` comment block of usage notes and examples; plain-line copies do not |

The comment block at the top of a Markdown / TSV copy includes a table example, a DSL example with only the Command column, a HEX example and the meaning of each column. It works as a self-documenting template when you export one and open it. Those notes appear only in export copies; write-back never adds a word to your mounted file.

Export writes the file directly and does not go through write-back's hash conflict check. If the target happens to be a file mounted by another monitor, that pane's content is replaced; the panel warns you, and you can Reload there or pick another file name.

Default file names differ per monitor so double-clicking Export twice does not overwrite the first copy: the main pane uses `quick-cmds.md` (`quick-cmds.tsv` for TSV), while the WSL pane, extra panes and the embedded Bluetooth monitor add their own suffix (for example `quick-cmds-wsl.md`, `quick-cmds-extra-1.md`).

## Limits

| Item | Limit | What happens past it |
|---|---|---|
| File size | 256 KB | Reads and writes are rejected by the backend |
| Commands | 500 | Extra rows are skipped at import with a message; the panel refuses to add more and asks you to delete some |
| Name | 64 characters | Truncated at import with a message |
| Group name | 64 characters | Truncated silently |
| Command text | 4096 characters | Truncated at import with a message; changes via MCP are rejected with a message |

## Common problems

**A command is sent only once and then the loop stops.**
It probably has Expected set, but the device does not reply with a whole line equal to `OK` or your success word. The timeout counts as a failure, and the default failure branch stops the chain. Either write the exact line the device sends into Expected (separate multiple words with `|`), or leave Expected empty so the row sends at the timeout interval without checking replies.

**The loop keeps sending; how do I stop it?**
Click the Loop sending switch on the left of the header. The loop also stops itself on disconnect, monitor close, send failure or when nothing is left to send. The switch state is not saved, so restarting the app never starts it again.

**I changed something in the panel but the file did not change.**
Write-back needs a successful read baseline. If the file was never read successfully (deleted, path changed, larger than 256 KB), the app refuses to write rather than rewriting your file from the in-memory list. Click Reload on the source row. A conflict on reload means another editor changed the file; reload and edit again.

**A command is missing after import.**
Rows that are entirely empty are skipped. A row with no command but with parameter values (for example sequence 0 and timeout 3000) is kept.

**Why did the export gain columns and `##` headings?**
A Markdown / TSV export is a self-contained copy: columns are filled in and headings are written. Write-back to the mounted file does neither. A plain-line single-group export stays one command per line and keeps only the command text; use a Markdown or TSV carrier to export the parameters.

**I put `baud: 115200` in the front matter and it had no effect.**
Front matter is preserved but not interpreted. `baud` / `mode` / `lineEnding` / `delay` / `expect` / `timeout` / `hex` produce a "not applied yet" message. Set baud rate and line ending in the panel, and put per-command parameters in declared columns.

**What does the old 延时 column mean now?**
It is read as Timeout: with Expected set it is the maximum wait for a reply; without Expected it is the interval before the next command. The numbers stay the same and import reports the change once. Rename it to 超时(ms) to avoid confusion.

**The device replies `+CWJAP:WIFI GOT IP` and Expected `WIFI GOT IP` does not match.**
Expected is whole-line equality, not contains. Use a workflow rule for a contains or regex match, or write the exact line the device replies into Expected.

See [QUICK_CMDS.md](https://github.com/SeaHi-Mo/Seahi-Serial/blob/main/doc/QUICK_CMDS.md) for the complete column, front matter, write-back and limit reference.
