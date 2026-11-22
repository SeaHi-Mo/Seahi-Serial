# exec

## Purpose

Runs a system command on the machine hosting the flow and turns its output into a message. It is used to call external tools for conversion or batch work.

## Properties

| Option | How to set it |
|---|---|
| Command | Program or script, with arguments optionally taken from the message |
| Timeout | Limit for the run; the process is stopped and an error raised afterwards |
| Output | Whole output at once, or one message per line |
| Include stderr | Whether error output is returned as well |

## Typical uses

| Scenario | Approach |
|---|---|
| Call an external tool | Use an existing CLI for validation, conversion or packaging |
| Bridge to a local script | Hand data to a script and take the result back |

## Notes

Command text comes from the flow configuration; confirm its origin before deploying and never concatenate unvalidated external input, which would allow command injection. Commands run as the same user as the application.
