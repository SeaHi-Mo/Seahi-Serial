# json

## Purpose

Converts between JSON text and JavaScript objects: parse a string to read fields, or serialise an object for sending.

## Properties

| Option | How to set it |
|---|---|
| Direction | Object to JSON string, or JSON string to object |
| Input property | `msg.payload` by default, or another field |
| Output | Overwrite the field, or write to a different one |

## Typical uses

| Scenario | Approach |
|---|---|
| Parse device JSON | Convert first, then read fields with `switch` |
| Build a request body | Serialise an assembled object for the sending node |
| Inspect structure | Pair with `debug` to see levels and field names |

## Notes

Invalid JSON raises an error that `catch` can handle. Check the raw text with `debug` first, especially for extra line breaks or prefixes.
