# cmd list

## Purpose

Sends an entry maintained in the quick commands panel. The node stores only the entry identifier, not the command text; it looks the entry up when the flow runs, so editing the command in the panel is picked up by deployed flows.

## Properties

Double-click the node on the canvas to open its dialog.

| Option | How to set it |
|---|---|
| Name | Label shown on the canvas; cosmetic only. Left empty it shows `cmd list` |
| Port | Dropdown of the currently open ports |
| Command | An entry from the quick commands panel, grouped by group; grey group headers separate groups and cannot be selected |
| Line ending | Appended when sending: `CRLF` / `CR` / `LF` / none; entries marked as HEX are sent as bytes without a line ending |

The dropdown reads the current list when the dialog opens. An empty list shows a placeholder, and entries must be added in the serial panel first.

## Typical uses

| Scenario | Approach |
|---|---|
| Reuse debug commands | Move a command tuned in the panel into a flow without maintaining two copies |
| Change a command once | Edit the panel entry and every flow that references it follows |
| Combine steps | Place several `cmd list` nodes in one flow, each with a different entry |

## Notes

When the entry is removed or the list is empty, the node sends the text captured when it was configured, and marks the entry as stale in its status and in `msg.stale`. It never silently substitutes another command.

Quick commands are added, edited and removed in the serial panel; the node does not edit them.
