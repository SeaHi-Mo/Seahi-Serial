# status

## Purpose

Subscribes to other nodes' status changes (connected, sending, done) and turns them into ordinary messages so they can take part in flow logic.

## Properties

| Option | How to set it |
|---|---|
| Target nodes | One or more nodes |
| Status type | Which statuses to forward; empty means all |

The output carries `msg.status` with fields such as `text` and `fill`.

## Typical uses

| Scenario | Approach |
|---|---|
| Turn status into an event | Act when a node goes from sending to done |
| Monitor the connection | Trigger a notice or reconnect flow when the port drops |
| Collect runtime state | Gather several nodes' statuses into a log |

## Notes

Status messages change frequently and will flood a `debug` node. Filter with `rbe` (pass on change only) or `switch`.
