# range

## Purpose

Scales a number from one interval to another, for example turning a 0–1023 reading into a 0–100 percentage.

## Properties

| Option | How to set it |
|---|---|
| Input range | Minimum and maximum of the incoming value |
| Output range | Minimum and maximum of the result |
| Rounding and clamping | Optionally round, and clamp values outside the range to the endpoints |
| Input property | `msg.payload` by default, or another field |

## Typical uses

| Scenario | Approach |
|---|---|
| Convert readings | Turn raw ADC values into volts, degrees or percent |
| Scale parameters | Convert a physical value into the register value a device expects |

## Notes

Without clamping, out-of-range inputs produce out-of-range outputs. Clamp before sending to a device so parameters stay valid.
