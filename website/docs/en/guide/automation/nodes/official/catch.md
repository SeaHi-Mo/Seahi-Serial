# catch

## Purpose

Catches errors thrown by nodes in the same flow and emits them as messages. Without it an error only appears in the debug panel and the chain stops silently.

## Properties

| Option | How to set it |
|---|---|
| Scope | This flow, all flows, or selected nodes |
| Selected nodes | Restrict catching to specific nodes |

The output carries `error.message` and `error.source`.

## Typical uses

| Scenario | Approach |
|---|---|
| Single error outlet | Feed an alert or a log write so failures leave a record |
| Recover from an error | Combine `delay` and `serial txd` to resend or reset the device |
| Avoid silent stops | Attach at least one `catch` to critical branches |

## Notes

`catch` handles errors thrown by nodes, not `ERROR` replies from the device. Device-level failure detection belongs to [serial request](/en/guide/automation/nodes/serial-request) result branches.
