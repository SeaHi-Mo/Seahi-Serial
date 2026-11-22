# switch

## Purpose

Routes messages to different outputs based on the value of a property, the conditional branch of a flow.

## Properties

| Option | How to set it |
|---|---|
| `property` | The field to test, usually `payload` or `topic` |
| Rules | One per output: equals, not equals, contains, regex, numeric comparison, JSONata, otherwise |
| Value | The value to compare against, for example `OK` |

Rules are evaluated in output order and the first match wins; "otherwise" matches any remaining message.

## Typical uses

| Scenario | Approach |
|---|---|
| Branch on a reply | Send `OK` and `ERROR` replies down different paths |
| Separate sources | Use `topic` to tell replies to several commands apart |
| Numeric ranges | Bucket readings with numeric comparisons |

## Notes

Text matching is case sensitive, and a "contains" test also matches longer strings that include the value. Use equals or a regular expression when a whole line must match.
