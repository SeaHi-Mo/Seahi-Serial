# Quick commands

The quick command panel is located on the right side of the output area and is collapsed by default. Click to expand it; drag the tab to the left to adjust the width, with a minimum of 300px, a maximum of 60% of the pane and 160px always reserved for the output area. The panel executes a sequence of commands that require interaction, such as network configuration, calibration or batch parameter writes.

<GuideMedia
  src="/img/guide/qcmd.mp4"
  poster="/img/guide/qcmd.png"
  caption="Expanding the quick command panel and collapsing or expanding groups. Table data comes from the application configuration."
/>

The left side of the header contains the Loop sending switch; the right side contains + New loop group, Import and Export. After a file is imported, a source row appears below the header with the file name, Reload and Disconnect. Without an associated file, the list is stored in the local configuration. With a file, the file serves as storage, the configuration keeps a cache, and the cache is used when the file cannot be read.

## Groups

Commands are managed in loop groups. Each group is an independent table containing a group header, a column header row and data rows, matching the one-table-per-group structure in the file.

- Click a group name to edit it. When a file is associated, the operation rewrites the `## group name` heading in the file. For an old file without headings, only the panel is changed and no heading is added to the file.
- Hold the dotted grip on the left of the group header and drag it up or down to reorder groups. The topmost group is the loop start, and the table order in the file changes accordingly.
- The fold arrow only collapses the display and does not affect loop sending.
- The slider switch on the group header controls whether the group participates in loop sending. When it is turned off, the whole group is skipped and sequence numbers remain unchanged; turning it back on restores participation. The switch and fold states are stored in the local configuration; the external file has no group-level switch column.
- The group header shows the number of commands in the group. The × at the far right deletes the whole group and its commands. When only one group remains, deletion is rejected and commands can be deleted individually.
- + Add at the far right of the column header row appends an empty command to the end of the group. A new group is appended at the end with the default name "循环 N" and one empty command. When a file is associated, the group heading, table header and data row are added to the end of the file.

## Command fields

| Field | Description |
|---|---|
| Sequence | Up to 4 digits. `0` means the command does not participate in the loop; values greater than `0` are sent in ascending numeric order within the group, with ties handled by row order |
| Command | Sent as written; escape sequences such as `\r\n` and `\t` take effect; pressing Enter in the input is equivalent to clicking the send button of the command |
| Timeout (ms) | Time occupied by the command, default 3000, maximum 600000 (10 minutes); see the next section for details |
| HEX | The command is parsed and sent as hexadecimal, independent of the current text/HEX mode of the main send bar |
| Send / Delete | Send the command once (unavailable while disconnected) or delete it |

The panel does not provide a name field: the name column in the file is preserved as-is and export copies omit it. Expected, Retry, Success jump and Failure jump are configured only in the file. When these settings are present, the timeout cell displays a light border and the content can be viewed on hover; the import operation also reports once.

## Timeout and Expected

The interpretation of Timeout depends on whether Expected is empty:

- When Expected is non-empty and the timeout is greater than 0, the timeout is the maximum wait for a reply after sending. A success word moves the loop to the next command early; reaching the timeout enters the failure branch.
- When Expected is empty, the command does not check replies and the timeout is the interval before the next command. For example, 3000 sends one command every 3 seconds.
- When the timeout is 0, the command does not wait for a reply (even if Expected is set) and sends continuously at the minimum interval of 20ms.
- Clearing the timeout input restores the default value 3000 and does not set it to 0.

A command waits for a reply only when the file header declares an Expected column and the cell is non-empty. Without a success word there is no basis for a success decision, and the built-in OK is not used as a default criterion. To wait for the built-in OK, write `OK` in the Expected column.

## Reply judgement

Replies are judged line by line in the backend. The frontend sends commands, waits for the result and proceeds according to the verdict.

- A reply must contain a line ending (`\r` or `\n`) to be split into lines. A partial line split across read operations is joined; data without a line ending is waited on until the timeout.
- The line contains `busy`: continue waiting. No verdict is produced, the command is not resent, and the timeout is not extended.
- The line contains `error`: judged as a failure and the command is resent. A line that also contains `busy` is treated as busy and waiting continues.
- The line is exactly `OK`, or ends with ` OK` (for example `SEND OK`): judged as success.
- The line exactly equals any success word in Expected: judged as success. Separate multiple success words with `|`, for example `WIFI GOT IP|OK`. Comparison trims leading and trailing whitespace and ignores case; it uses whole-line equality and does not support substring matching.
- Unrecognised lines produce no verdict and waiting continues.

For commands that wait for replies, the built-in `OK`, `error` and `busy` criteria are always active; Expected adds success words on top of them and cannot disable the built-in criteria. It is therefore not possible to accept only `WIFI GOT IP` and reject `OK`. When substring matching or regular-expression matching is required, use a workflow rule (More settings → Workflows; condition types include string contains, regular expression and exact bytes).

After ERROR, the command is resent after 300ms. The default is 3 resends (up to 4 attempts), the maximum is 10, and `0` means no resend. Reaching the timeout is also judged as a failure. A failure enters the failure jump; when no failure jump is configured, the whole chain is terminated. The termination dialog reports the group, command and waiting time; when retries are exhausted it shows "连续 N 次收到 ERROR".

The frontend queries the backend for a verdict every 60ms. The backend settles the timeout when queried, and the frontend adds a 400ms grace period to avoid an early verdict.

## Loop sending

Two conditions are checked before starting: the monitor is connected, and at least one command with a sequence number greater than 0 exists in a participating group. If either condition is not met, startup is rejected with a reason; the switch is never left on while nothing is being sent.

- The loop order is groups from top to bottom, then sequence numbers in ascending order within a group; after the last group, the loop returns to the topmost group. Sequence number `0` is skipped and occupies no position.
- The execution plan is rebuilt on every step. Changes to sequence numbers, group order, commands, timeout, Expected or jumps made while the loop is running take effect on the next step without a restart.
- A success jump is executed after a success word; a failure jump is executed after a timeout or after ERROR retries are exhausted. Empty or "next" means sequential execution, a number means jumping to the corresponding sequence number (including across groups), and "end" means stop. An empty failure jump terminates the whole chain by default.
- A "next group" jump is not supported; crossing groups is performed through sequence numbers. Jumps are resolved by sequence number; when different groups use the same sequence number, the first matching command in the execution plan is selected.
- When a target sequence number does not exist, a message is shown once at import. If execution reaches that step, a success jump falls back to "next" and a failure jump falls back to "stop", with the reason written to the console.
- Unrecognised values in a jump column are treated as "next" and reported once at import.
- More than 200 consecutive jumps stop the loop automatically (one sequential step resets the count), preventing repeated circulation among a small number of commands.

### Command sending and failure handling

Clicking a command's send button or pressing Enter in the command input sends only that command, without starting the loop or waiting for a reply. The operation uses the same send path as loop sending: the command's HEX switch determines text or hexadecimal sending; text appends the panel line ending and HEX does not; empty content is not sent. When a manual send fails, an error line is written to the output area.

Loop sending handles the following cases separately:

- Empty command: the command is skipped and execution continues. When the number of consecutive skips reaches the number of commands in a full round, the chain has no content to send, and the loop stops with a message.
- Disconnected, device write failure or invalid HEX content: the send failed, the whole chain stops immediately, and no other command is jumped to.
- Normal finish (success jump set to "end"): the loop stops silently without a message.

While the loop is running, no loop status information is written to the output area, including sent, OK received, busy, resend, jump, normal finish and skip. The visible state is limited to the Loop sending switch on the panel and the blinking status dot on the collapsed tab; whether a command waits for a reply can be confirmed through the hover text of its timeout cell.

The loop stops automatically in the following situations: connection loss (including three consecutive WSL read polling failures), send failure (disconnection, device write error, invalid HEX format), a full round with no content to send, no commands with sequence numbers greater than 0, a jump loop, ERROR retries exhausted and a wait timeout. A single dialog is displayed on stop, the dialog contains the stop reason, and exception details are written to the console. Manually turning off the switch shows no message; closing the monitor terminates the related timers.

The Loop sending switch state is not saved, so the application does not start sending automatically after launch. The quick command panel also remains collapsed each time it is opened.

## External files

Import opens a native file selection dialog. After a file is selected, additions, edits and deletions in the pane are written back to the file (600ms debounce), and the file becomes the storage. Supported extensions are md, markdown, txt, tsv and csv; the format is determined by content and is unrelated to the extension.

- Only paths selected in the native file selection dialog are accepted. The backend maintains an allow-list of the 50 most recent paths; an arbitrary path passed by the frontend is rejected.
- The same file cannot be associated with two monitors at the same time. A second Import is rejected and identifies the pane where Disconnect must be performed first. If the same path appears twice when restoring configuration, the later monitor keeps its cached list but does not restore the file association, and a message is shown once.
- Reload on the source row re-reads the file. When reloading fails, the current list is retained with a message instead of being cleared. On the next launch the file is read again automatically; when reading fails, the cached configuration is used.
- Before the window closes, a write-back still waiting in the 600ms debounce is executed immediately.

### File format

A `## group name` heading separates loop groups (two or more `#`). A single `#` and `//` still denote comments; comments, blank lines and table headers keep their original positions. An old file without headings is read as one group: no heading is added on read, and write-back does not change the table structure. The carrier is detected from content (a `##` heading means Markdown processing), and write-back uses the detected carrier:

| Carrier | Form |
|---|---|
| Markdown table | Contains `\|`; recommended. Columns and groups are expressed through the header row and `##` headings |
| TSV | Tab-separated, for example pasted directly from Excel |
| Plain command lines | One command per line |

Line endings are written as CRLF. Parsing does not split on commas: `AT+CWJAP="ssid","pwd"` is sent as one complete command, and a file with the .csv extension is not split into multiple columns.

A column is treated as a parameter only when the header declares its name; undeclared columns are notes and are preserved as-is. Column names are case-insensitive and ignore spaces and annotations such as `(ms)`:

- Name: 名称, 名字, 标签, 指令名, name, label, title
- Command: 指令, 命令, 内容, 指令内容, 发送内容, cmd, command, value, data
- Sequence: 顺序号, 顺序, 序号, 次序, 序, order, seq, sequence
- Timeout: 超时, 超时时间, 超时毫秒, 等待, 等待时间, timeout, wait
- Expected: 期望, 期望值, 响应词, 成功词, expect
- Retry: 重试, 重试次数, retry, retries
- Success jump: 成功跳转, 成功后, 成功, ok跳转, okgoto, success, onsuccess
- Failure jump: 失败跳转, 失败后, 失败, err跳转, errgoto, fail, onfail, ongoto
- HEX: hex, hex开关, 十六进制, 格式, format, mode

Column names such as `编号`, `no`, `num` and `index` are not recognised, which prevents an ID column from being read as a sequence number and rewritten to `0`. The old column name 延时 is parsed as Timeout: the value is unchanged, the meaning differs, and a message is shown once at import. When both columns exist, Timeout takes precedence.

An old file without a header row is read as follows: column 1 is the name, column 2 is the command, and column 3 onward are notes; parameters are never mapped by column position.

When the file starts with `---` (YAML) or `+++` (TOML), the block through the matching closing line is preserved as-is and is not interpreted by this version (YAML closing lines are `---` or `...`; TOML uses `+++`). Keys such as `baud`, `mode`, `lineEnding`, `delay`, `expect`, `timeout` and `hex` trigger the "not applied yet" message: per-command parameters must be written in declared columns (Timeout / Expected / Retry / HEX), while baud rate and line ending are configured in the panel. A missing closing line produces a message and is handled as "only the first line is front matter"; the rest of the content is parsed normally.

### Import messages

A successful import shows no message by default; the list and source row already reflect the result. The following cases each show one message to avoid silently changing semantics:

- Skipped rows: more than 500 commands, or an over-long name or command; the first line number and reason are shown.
- The front matter contains the unsupported keys described above, or the front matter has no matching closing line.
- The old column name 延时 is used.
- The file contains Expected or Retry (the panel does not display these fields; the file must be edited directly).
- The file contains Success jump or Failure jump, or a jump column contains an unrecognised value.
- A jump points to a non-existent sequence number: a success jump is handled as "next" and a failure jump as "stop".
- The header recognises columns but omits Sequence, Timeout or HEX: these fields are stored only in the local configuration.
- The file contains multiple tables and is read as multiple loop groups.

### Write-back rules

- Comments, headers, separator rows and extra columns keep their original positions; only cells belonging to commands are rewritten.
- Unmodified parameter cells are written back with their original text: `0`, `是` or blank remains unchanged; only modified values, rows created in the panel and export copies are normalised to `0 / 3000 / true|false`. Cells that were originally empty remain empty and are not filled with defaults.
- Columns are not added automatically: when the header does not contain Sequence, Timeout or HEX, write-back adds no columns and these three fields are stored only in the local configuration (a message is shown at import). Use Export when a self-contained file is required.
- With one group, write-back does not add a `##` heading (an existing heading in the file is preserved). Dragging, renaming or deleting groups modifies the corresponding table in the file.
- A row that is empty in all cells is not written back. In a file whose header declares Sequence, Timeout or HEX, a row without a command but with parameter values is retained so that the number of commands in the panel and the file remains consistent.
- The content hash is compared before writing: if the file has been modified by another editor, a conflict is reported and the file is not overwritten. Only an associated file that has been read successfully once and has a known hash is allowed to be written back.
- Writing uses an atomic temporary-file and rename operation. The encoding from the read operation is retained: UTF-8 (including BOM) takes precedence, GBK is used as a fallback, and characters that GBK cannot encode fall back to UTF-8.

### Export and write-back

| | Write-back to the associated file | Export copy |
|---|---|---|
| Columns | Per the file header; no columns are added | Filled in: Sequence / Command / Timeout (ms) / HEX / Expected / Retry / Success jump / Failure jump |
| Name column | Preserved as-is | Not written |
| Group headings | Not written with one group | Always written for Markdown / TSV copies; a plain-line single-group copy has no heading |
| Carrier | The original carrier | Markdown / TSV by default; a plain-line single-group copy remains one command per line, while multiple groups upgrade to a Markdown table with a message |
| Notes | The associated file is not modified | Markdown / TSV copies start with a `#` comment block containing usage notes and examples; plain-line copies do not |

The comment block at the start of a Markdown / TSV copy contains a table example, a DSL example with only the Command column, a HEX example and the meaning of each column, and can be used as a syntax reference. The comment block appears only in export copies; write-back adds nothing to the associated file.

Export writes the file directly and does not perform the hash conflict check used by write-back. If the target file is currently associated with another monitor, its content is replaced; the panel shows an immediate message, and Reload can be used in the corresponding pane or a different file name can be chosen.

Default file names differ by monitor to prevent a second export from overwriting the first: the main pane uses `quick-cmds.md` (`quick-cmds.tsv` for TSV), while the WSL pane, extra panes and the embedded Bluetooth monitor add their own identifiers (for example `quick-cmds-wsl.md` and `quick-cmds-extra-1.md`).

## Limits

| Item | Limit | Behaviour when exceeded |
|---|---|---|
| File size | 256 KB | Reads and writes are rejected by the backend with a message |
| Commands | 500 | Rows beyond the limit are skipped at import with a message; the panel rejects further additions and prompts to delete commands first |
| Name | 64 characters | Truncated at import with a message |
| Group name | 64 characters | Truncated directly |
| Command text | 4096 characters | The panel input enforces this length; longer values are truncated at import with a message; changes through MCP are rejected with a message |

## Common problems

A command is sent only once and then the loop stops: the command has Expected configured, but the device reply does not match the whole line `OK` or the configured success word. The wait timeout is judged as a failure, and the default failure jump terminates the whole chain. The resolution is to write the exact line returned by the device into Expected (separate multiple words with `|`), or to leave Expected empty so that the command is sent at the timeout interval without reply checking.

The loop needs to be stopped: click the Loop sending switch on the left side of the header. The loop also stops automatically on connection loss, monitor close, send failure or when there are no commands to send. The switch state is not saved, so the application does not start it automatically after a restart.

Panel changes are not written to the file: write-back requires a successful read baseline. When the file has not been read successfully (deleted, path changed, larger than 256 KB), the program does not write and does not rewrite the file from the in-memory list. In this case click Reload on the source row; if a conflict is reported, the file has been modified by another editor and can be edited again after reloading.

Commands are missing after import: rows that are empty in all cells are skipped. Rows without a command but with parameter values (for example sequence 0 and timeout 3000) are retained.

An export copy contains additional columns and `##` headings: a Markdown / TSV export is a self-contained copy; columns are filled in and headings are written. Write-back to the associated file does neither. A plain-line single-group export remains one command per line and contains only command content; to include parameters such as sequence and timeout, export with the Markdown or TSV carrier.

The front matter key `baud: 115200` has no effect: front matter is preserved as-is but is not interpreted. `baud`, `mode`, `lineEnding`, `delay`, `expect`, `timeout` and `hex` trigger the "not applied yet" message; baud rate and similar settings are configured in the panel, and per-command parameters are written in declared columns.

The old 延时 column is read as Timeout: with Expected configured it is the maximum wait for a reply; without Expected it is the interval before the next command. The value is unchanged and a message is shown once at import; renaming the column to 超时(ms) is recommended.

Expected does not match the device reply: Expected uses whole-line equality and does not support substring matching. When substring or regular-expression matching is required, use a workflow rule, or write the exact line returned by the device into Expected.

See [QUICK_CMDS.md](https://github.com/SeaHi-Mo/Seahi-Serial/blob/main/doc/QUICK_CMDS.md) for the complete column, front matter, write-back and limit reference.
