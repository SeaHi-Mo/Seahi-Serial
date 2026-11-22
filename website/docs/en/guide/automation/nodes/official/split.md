# split

## Purpose

Splits one message into several: an array into elements, a string by length or delimiter, a buffer by bytes.

## Properties

| Option | How to set it |
|---|---|
| Source | `msg.payload` by default, or another field |
| Split by | Array elements, fixed length, delimiter, or bytes |
| Key | For arrays, optionally record the index in `msg.parts` for later joining |

## Typical uses

| Scenario | Approach |
|---|---|
| Handle multi-line text | Split on the newline and process each line |
| Send in chunks | Cut a long payload into fixed-length pieces |
| Iterate a list | Turn an array into separate messages |

## Notes

Each output message carries `msg.parts`, which `join` can use to reassemble. Whether empty fragments are kept depends on the delimiter settings.
