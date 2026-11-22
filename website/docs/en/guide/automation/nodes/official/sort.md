# sort

## Purpose

Sorts a sequence of messages by a field and emits them in order. It works on a batch, so a single message never triggers it.

## Properties

| Option | How to set it |
|---|---|
| Sort key | Field used for ordering, `payload` by default |
| Order | Ascending or descending |
| Count | How many messages to buffer before emitting |
| Group key | Optional grouping so each group is sorted separately |

## Typical uses

| Scenario | Approach |
|---|---|
| Order collected records | Sort by time or index before output |
| Fix out-of-order arrivals | Restore sequence when several sources report |
| Keep top values | Combine with a count limit to keep only the first few |

## Notes

Messages are buffered until the count is reached or the group changes; with too few messages nothing is emitted. For uncertain volumes, pair with `batch` or `join` timeouts.
