# inject

## Purpose

Generates a message as the starting point of a flow. It fires on a manual click, on a repeating interval, or once after the editor starts.

## Properties

| Option | How to set it |
|---|---|
| `payload` | Pick a type (string, number, boolean, JSON, timestamp) and enter the value |
| `topic` | Optional, written to `msg.topic` so downstream nodes can tell messages apart |
| Repeat | None, a fixed interval, or a cron expression |
| Once at start | Fires once after deployment, optionally after a delay |

The square button on the left of the node triggers it manually for debugging.

## Typical uses

| Scenario | Approach |
|---|---|
| Send a command by hand | Trigger once and watch the serial panel |
| Periodic heartbeat | Set the repeat interval to the send period |
| Run at a fixed time | Use a cron expression, for example a daily self check |

To send a command and confirm its reply, use [serial request](/en/guide/automation/nodes/serial-request) instead of repeated injects.
