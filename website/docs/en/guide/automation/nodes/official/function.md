# function

## Purpose

Processes messages with JavaScript. It can read and change `msg`, and return an array to emit several messages at once, making it the most flexible node in the palette.

## Properties

| Option | How to set it |
|---|---|
| Code | Edit `msg` and `return msg;`; returning `null` drops the message |
| Outputs | For several outputs, return an array positioned per output |
| Timeout | Per-message limit so a runaway loop cannot stall the flow |
| Modules | Optional npm modules from an allow list |

## Typical uses

| Scenario | Approach |
|---|---|
| Assemble a command | Build a parameterised AT command from variables |
| Compute a checksum | CRC, unit conversion, packet assembly |
| Complex branching | Use code when `switch` becomes unwieldy |

## Notes

Code runs in the background engine. A thrown error interrupts that message and is passed to `catch`. Place a `debug` before and after while developing.
