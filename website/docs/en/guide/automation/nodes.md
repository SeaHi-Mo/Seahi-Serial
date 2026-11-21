# Nodes and ports

Serial nodes are grouped under «串口» (serial) in the palette.

<GuideMedia
  poster="/img/guide/automation-palette.png"
  caption="The serial group in the palette: serial txd, serial rxd, serial request and cmd list."
/>

| Node | Purpose | Main options |
|---|---|---|
| `serial txd` | Sends data to the port | Port, format (text / HEX), line ending |
| `serial rxd` | Receives port data | Port, format (text / HEX / Buffer), poll interval |
| `serial request` | Sends one command and collects the reply | Port, send and reply formats, line ending, maximum wait, quiet window, result branches |
| `cmd list` | Sends an entry from the quick commands panel | Port, command, line ending |

Double-click a node to open its properties. All four panels share the same layout: name and port at the top, data format and line ending in the middle, node-specific options below.

## serial txd: sending data

`serial txd` writes the incoming message to the port. In text format the payload is encoded as UTF-8 and the line ending is appended. HEX format sends the hexadecimal bytes without a line ending.

<GuideMedia
  poster="/img/guide/automation-port.png"
  caption="serial txd properties: the port dropdown shows open ports with name and baud rate; format and line ending are set on the right."
/>

| Option | How to set it |
|---|---|
| Name | Label shown on the canvas; it does not affect behaviour |
| Port | Select an open port from the dropdown, shown as `COM3 · 115200`. A closed port is reported in the list |
| Format | Text sends the payload as a string; HEX converts a hexadecimal string to bytes |
| Line ending | Appended in text format: CRLF, CR, LF or none; ignored in HEX format |

## serial rxd: receiving data

`serial rxd` polls the port and converts received data into a message. In text format `payload` is a string, which compares directly against reply keywords. HEX or Buffer format emits bytes and keeps the original data in `msg.raw`.

<GuideMedia
  poster="/img/guide/automation-rxd.png"
  caption="serial rxd properties: port, data format and poll interval."
/>

| Option | How to set it |
|---|---|
| Port | Select an open port from the dropdown |
| Format | Text, HEX or Buffer; text is suitable for matching `OK`, `ERROR` and similar keywords |
| Poll ms | Interval for reading the queue, 100 milliseconds by default; a smaller value reduces latency and reads more often |

Place only one `serial rxd` per port. To use the data in several places, branch downstream from its output.

## serial request: sending and waiting for a reply

`serial request` performs a complete request/reply transaction: clear stale data, send the command, collect the reply, then select a result branch.

<GuideMedia
  poster="/img/guide/automation-request.png"
  caption="serial request properties: send and reply formats, maximum wait, quiet window and the result branch editor."
/>

| Option | How to set it |
|---|---|
| Port | Select an open port from the dropdown |
| Send / reply | Select text or HEX for each direction; HEX sends without a line ending |
| Line ending | Appended in text format: CRLF, CR, LF or none |
| Maximum ms | Total wait limit measured from the send |
| Quiet ms | After bytes arrive, the reply is closed when no new data arrives for this duration |
| Result branches | One condition per row; each match selects its connection point. `OK` and `ERROR` are provided by default |

Result branches support contains, equals, regular expression and the unmatched/timeout fallback. Conditions are evaluated from top to bottom and the first match wins. Without a fallback condition, unmatched replies are discarded and the node reports this in its status line.

## cmd list: sending quick commands

`cmd list` sends an entry maintained in the quick commands panel. The node stores only the entry identifier, so edits in the panel propagate to deployed flows.

<GuideMedia
  poster="/img/guide/automation-cmdlist.png"
  caption="cmd list properties: the command dropdown lists quick commands by group; the line ending is set separately."
/>

| Option | How to set it |
|---|---|
| Port | Select an open port from the dropdown |
| Command | Select an entry from the quick commands panel; group headers are separators and cannot be selected |
| Line ending | Appended when sending: CRLF, CR, LF or none |

When the entry has been removed or the list is empty, the node sends the captured text and marks the entry as stale in its status.
