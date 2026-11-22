# serial rxd

## Purpose

Polls the port and turns received data into messages. With the text format `payload` is a string, which compares directly against reply keywords; with HEX or Buffer the output is byte-oriented and `msg.raw` keeps the original bytes.

## Properties

Double-click the node on the canvas to open its dialog.

| Option | How to set it |
|---|---|
| Name | Label shown on the canvas; cosmetic only. Left empty it shows `serial rxd` |
| Port | Dropdown of the currently open ports |
| Format | `文本` / `HEX` / `Buffer`; text suits keyword matching such as `OK` or `ERROR` |
| Poll interval | How often the receive queue is read, 100 ms by default, 20 ms minimum |

In text mode a reply may arrive as several messages, so line-based handling needs buffering downstream.

## Typical uses

| Scenario | Approach |
|---|---|
| Capture boot logs | Connect `debug` and watch the output after power-on |
| Act on a keyword | Branch with `switch` and reply through `serial txd` when it matches |
| Record device output | Connect `debug` or a file node for long-running observation |

## Notes

Place only one `serial rxd` per port. The node consumes the receive queue, so two nodes split the data blocks between them; when the data is needed in several places, branch downstream from a single node.

The port is owned by the program and the node never opens it. When no port is open in the serial panel, the node status reports that no port is available.
