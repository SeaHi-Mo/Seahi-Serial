# template

## Purpose

Renders text from a template, substituting message values into a fixed format. It is the usual way to build commands or payloads.

## Properties

| Option | How to set it |
|---|---|
| Template | Body with placeholders such as `{{payload}}` |
| Syntax | mustache (default) or plain text |
| Fields | Values taken from `msg` or `flow` |
| Output property | Written to `msg.payload` by default, or another field |

## Typical uses

| Scenario | Approach |
|---|---|
| Build a command | Fill a value into a template such as `AT+XXX={{payload}}` |
| Compose multi-line payloads | Write headers and line breaks directly in the template |
| Render HTML or log lines | Produce display-ready strings |

## Notes

Line breaks in the template are kept in the message. Check the line ending setting on the sending node to avoid duplicated breaks.
