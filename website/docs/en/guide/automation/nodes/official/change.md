# change

## Purpose

Sets, replaces, deletes or moves message properties, reshaping a message without writing code.

## Properties

| Option | How to set it |
|---|---|
| Rules | Each rule performs one action: set, change, delete or move |
| Target | Dotted paths address nested fields, for example `msg.payload.temp` |
| Value | A literal, another property, or a JSONata expression |

Rules run in order, and later rules see the results of earlier ones.

## Typical uses

| Scenario | Approach |
|---|---|
| Rewrite outgoing content | Turn a received value into the command to send |
| Tag the source | Set `msg.topic` so downstream nodes can tell messages apart |
| Trim a message | Delete large fields that do not need to travel further |

## Notes

Deleting a missing field is not an error. Check the target path before renaming, otherwise the value is written somewhere unintended.
