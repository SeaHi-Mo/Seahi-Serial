# html

## Purpose

Extracts elements from HTML text, or renders data into an HTML fragment. It is used for page-like content or readable reports.

## Properties

| Option | How to set it |
|---|---|
| Action | Extract elements, or generate HTML |
| Selector | CSS selector such as `table tr` or `.value` |
| Output | Text only, keep tags, or output attribute values |
| Template | Template used when generating |

## Typical uses

| Scenario | Approach |
|---|---|
| Pull fields from a page | Select values from HTML-structured logs |
| Build a report fragment | Render results into a table and write it out |

## Notes

A wrong selector does not raise an error; it simply outputs nothing. Inspect the raw HTML with `debug` before extracting.
