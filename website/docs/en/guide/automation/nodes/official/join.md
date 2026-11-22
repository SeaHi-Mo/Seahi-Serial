# join

## Purpose

Merges several messages into one. It is the counterpart of `split` and reassembles a reply that arrived in fragments.

## Properties

| Option | How to set it |
|---|---|
| Mode | Array, string, or keyed aggregation |
| Separator | Connector used when merging into a string |
| Count or timeout | Merge after N messages, or after a time with whatever arrived |

## Typical uses

| Scenario | Approach |
|---|---|
| Rebuild a fragmented reply | Place after `split` to restore one message |
| Aggregate batch results | Collect several results into an array before logging |
| Timeout fallback | Release partial content when the device reply is incomplete |

## Notes

A timeout merge also emits incomplete results. When completeness matters, check the content with `switch` after joining.
