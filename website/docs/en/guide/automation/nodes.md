# Nodes and ports

Serial nodes are grouped under «串口» (serial) in the palette.

<!-- Slot 2 / automation-palette.png
     Frame: the serial group expanded, all four nodes visible.

<GuideMedia
  poster="/img/guide/automation-palette.png"
  caption="The serial group contains receive, send, request and quick command nodes."
/>
-->

| Node | Purpose | Main options |
|---|---|---|
| `serial rxd` | Receives port data | Port, format (text / HEX / Buffer), poll interval |
| `serial txd` | Sends data | Port, format (text / HEX), line ending |
| `serial request` | Sends one command and collects the reply | Port, send and reply formats, line ending, maximum wait, quiet window, result branches |
| `cmd list` | Sends an entry from the quick commands panel | Port, command, line ending |

## Port selection

The Port dropdown of every sending node lists the ports that are currently open, shown as `COM3 · 115200`. A saved port that is no longer open is marked as not open.

<!-- Slot 3 / automation-port.png
     Frame: the serial txd dialog with the port dropdown expanded.

<GuideMedia
  poster="/img/guide/automation-port.png"
  caption="The port dropdown lists open ports with port name and baud rate."
/>
-->

The serial panel opens the port; the nodes themselves do not open or close it. When the port is closed, the node reports the specific reason in its status line.

<!-- Slot 14 / automation-noport.png
     Frame: the red status text shown when the port is not open.

<GuideMedia
  poster="/img/guide/automation-noport.png"
  caption="A closed port produces a specific message instead of a silent failure."
/>
-->

## Reply branches

The output of `serial request` is selected by its result branches. Two connection points are provided by default, one matching `OK` and one matching `ERROR`. Additional branches can match exact values, regular expressions, or act as the fallback for unmatched and timed-out replies.

<!-- Slot 4 / automation-request.png
     Frame: the serial request dialog, focused on the result branch editor.

<GuideMedia
  poster="/img/guide/automation-request.png"
  caption="Each result condition owns one output connection point."
/>
-->

Conditions are evaluated from top to bottom and the first match selects the output. Without a fallback condition, replies that match no condition are discarded and the node reports this in its status line.

## Quick command node

`cmd list` sends the content of an entry from the quick commands panel; the node stores only the entry identifier. Changing the command text in the panel is picked up by deployed flows without editing the node.

<!-- Slot 12 / automation-cmdlist.png
     Frame: the cmd list dialog with the command dropdown expanded, group headers visible.

<GuideMedia
  poster="/img/guide/automation-cmdlist.png"
  caption="Commands are listed by group; grey headers separate groups and cannot be selected."
/>
-->

<!-- Slot 13 / automation-quickcmds.png
     Frame: the quick commands side panel in the serial view.

<GuideMedia
  poster="/img/guide/automation-quickcmds.png"
  caption="The quick commands panel is the source for cmd list; edits propagate to running flows."
/>
-->

When the entry has been removed or the list is empty, the node sends the text captured when it was configured and marks the entry as stale in its status.
