# delay

## Purpose

Holds a message for a while before releasing it, or limits how many messages pass in a time window. It controls pacing so a device is not flooded.

## Properties

| Option | How to set it |
|---|---|
| Delay | A fixed duration, or a random one within a range |
| Rate limit | One message per N, or a fixed rate per interval |
| Allow override | Release the pending message early when a new one arrives |

## Typical uses

| Scenario | Approach |
|---|---|
| Space out commands | Place after a send so the device has time to respond |
| Rate limit | Cap messages per second during bulk sends |
| Coalesce bursts | With override enabled, keep only the latest message |

## Notes

Messages are buffered while delayed, which consumes memory in high-volume flows. For long waits prefer [trigger](/en/guide/automation/nodes/official/trigger) or an `inject` schedule.
