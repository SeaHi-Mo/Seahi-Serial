# serial txd

## Purpose

Writes the incoming message to the open serial port. In text mode the payload is encoded as UTF-8 and an optional line ending is appended; in HEX mode the payload is parsed as hexadecimal bytes and written unchanged.

## Properties

Double-click the node on the canvas to open its dialog.

| Option | How to set it |
|---|---|
| Name | Label shown on the canvas; cosmetic only. Left empty it shows `serial txd` |
| Port | Dropdown of the currently open ports, shown as `COM3 · 115200`; a new node selects the first available port |
| Format | `文本` sends `msg.payload` as a string; `HEX` parses a hexadecimal string into bytes |
| Line ending | Text mode only: `CRLF` / `CR` / `LF` / none |

The dropdown lists open ports only. When the port is closed the node reports `COM17 没有打开`; when no port is open it reports `没有可用的串口`.

In HEX mode the payload must be an even-length hexadecimal string, otherwise the node reports an error and sends nothing, so invalid bytes never reach the device.

## Typical uses

| Scenario | Approach |
|---|---|
| Periodic heartbeat | `inject` fires on the interval and the node writes to the port |
| Manual single command | Trigger `inject` once and watch the result in the serial panel |
| Send a computed value | Place it after `function`, `change` or `switch`; `payload` is what gets sent |

Sent data also appears in the serial monitor window, using the same path as manual sends; it is hidden when message echo is turned off.
