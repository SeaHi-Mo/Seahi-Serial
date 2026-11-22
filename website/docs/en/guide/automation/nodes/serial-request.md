# serial request

## Purpose

Performs one complete request and reply transaction in a fixed order: clear any data left in the receive queue, write the command, then collect the reply window. The window closes when a result condition matches, when the line goes quiet, or when the maximum wait expires; the message is then routed to the matching output.

## Properties

Double-click the node on the canvas to open its dialog.

| Option | How to set it |
|---|---|
| Name | Label shown on the canvas; cosmetic only. Left empty it shows `serial request` |
| Send format | `文本` or `HEX`; HEX sends bytes without a line ending |
| Reply format | `文本` / `HEX` / `Buffer`; determines the type of `payload` |
| Line ending | Text mode: `CRLF` / `CR` / `LF` / none |
| Maximum wait | Upper bound from the moment the command is written, 1000 ms by default |
| Quiet window | Close the reply after this long without new data, 80 ms by default |
| Result branches | One condition per row, each with its own output; defaults to `OK` and `ERROR` |

Result branches support contains, equals, regular expression, and a fallback for unmatched or timed-out replies. Conditions are evaluated top to bottom and the first match wins; the fallback is only used when no other condition matched.

When no fallback is configured, an unmatched reply is discarded and the node marks the result, rather than treating it as success.

## Output

The matched branch emits one message with the following fields in addition to `payload`.

| Field | Meaning |
|---|---|
| `raw` | Original received bytes |
| `cmd` | Text that was sent |
| `bytes` | Number of bytes received |
| `elapsedMs` | Time from sending to closing the window |
| `matched` / `matchedIndex` / `matchedType` | Matched condition, its index and its type |
| `timedOut` | Whether the maximum wait expired |
| `reason` | Why the window closed: `rule` / `timeout` / `quiet` |

## Typical uses

| Scenario | Approach |
|---|---|
| Confirm a command succeeded | Route `OK` and `ERROR` to different branches and handle each |
| Power-on self check | Reset the device, send `AT`, continue only after `OK` |
| Bounded retry | On the `ERROR` branch add `delay` and resend |

Requests inside one node are serialised, up to 32 queued, so replies never mix between rounds.

## Notes

When the device echoes commands (`ATE1`), the sent command comes back and may match a condition too early. Send `ATE0` first to disable echo.

The node reads the receive queue itself, so do not place `serial rxd` on the same port; they would split the data blocks.
