# xml

## Purpose

Converts between XML text and objects, for devices or services that exchange XML messages.

## Properties

| Option | How to set it |
|---|---|
| Direction | XML to object, or object to XML |
| Attributes | How element attributes are represented, for example under `$` |
| Root element | Name of the root when generating XML |
| Output | Overwrite the field or write to another |

## Typical uses

| Scenario | Approach |
|---|---|
| Parse a device reply | Convert to an object, then read fields with `switch` |
| Build an outgoing message | Assemble an object first, then convert to XML text |

## Notes

Depending on the document, a converted field may be an array or a single value. Check the actual shape with `debug` before reading it.
