# rbe

## Purpose

Passes a message only when a value changes and drops repeats of the same value. It suppresses redundant updates.

## Properties

| Option | How to set it |
|---|---|
| Property | The field to watch, `payload` by default |
| Mode | On change, or on change to a non-empty value |
| Start value | An initial value that is also filtered out on first match |

## Typical uses

| Scenario | Approach |
|---|---|
| Suppress steady readings | Slow-changing values only continue when they change |
| Filter status chatter | Handle status messages only when the state really changes |
| Reduce log volume | Record stable flows only on change |

## Notes

`rbe` compares consecutive messages. A value that changes and returns within two messages still passes once, which is expected.
