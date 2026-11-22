# batch

## Purpose

Groups consecutive messages by count or time window and hands them downstream as one message.

## Properties

| Option | How to set it |
|---|---|
| Mode | By count, by interval, or by group key |
| Count | Emit after this many messages |
| Interval | Emit whatever has been collected after this long |
| Output format | An array, or a sequence organised in `msg.parts` |

## Typical uses

| Scenario | Approach |
|---|---|
| Bulk writes | Accumulate records and write them in one go |
| Reduce downstream load | Merge high-frequency data before a slow node |
| Window statistics | Emit one batch per interval for summarising |

## Notes

When the interval expires the batch is emitted even if it is below the count, so downstream must handle partial batches.
