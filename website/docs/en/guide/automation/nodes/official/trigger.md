# trigger

## Purpose

Sends a message a while after the first one arrives, optionally restarting the wait when another arrives. It covers debouncing, timeout fallbacks and delayed actions.

## Properties

| Option | How to set it |
|---|---|
| Delay | How long to wait before emitting |
| Extend | Whether a new message restarts the timer |
| Second message on timeout | Emit a fallback message if the wait completes |
| Reset | Cancel a pending timer with another message |

## Typical uses

| Scenario | Approach |
|---|---|
| Debounce | Handle only the last of several rapid messages |
| Timeout fallback | If no reply arrives, raise an alert or resend |
| Delayed action | Wait a few seconds after a reset before sending |

## Notes

Combining "extend" with "second message on timeout" can push the fallback back indefinitely if messages keep arriving; confirm the device's actual send rate first.
