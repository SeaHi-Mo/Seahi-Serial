# csv

## Purpose

Converts between CSV text and arrays of objects: parse tabular text received from a device, or generate CSV rows from data.

## Properties

| Option | How to set it |
|---|---|
| Direction | Text to objects, or objects to text |
| Columns | Name and type of each column (string or number) |
| Delimiter | Comma by default; semicolon, tab and others are allowed |
| Header | Whether the output includes a header row |

## Typical uses

| Scenario | Approach |
|---|---|
| Parse a device report | Split comma-separated multi-column output into fields |
| Build bulk commands | Join values into CSV for an external tool or a log |

## Notes

The column count must match the definition, otherwise rows may be truncated. Values containing the delimiter need quoting per CSV rules.
