# link in

## Purpose

Receives messages delivered by a `link out` with the same link name and acts as the input of that part of the flow. The node never creates messages.

## Properties

| Option | How to set it |
|---|---|
| Link name | The same name used by the source `link out` |
| Scope | Keep it consistent with the source |

## Typical uses

| Scenario | Approach |
|---|---|
| Receive across the canvas | Place it at the start of another part of the flow |
| Reuse one data path | Several `link in` nodes with the same name each handle the message separately |

## Notes

A misspelt name raises no error; the message simply goes nowhere. Rename both ends together.

Related: [link out](/en/guide/automation/nodes/official/link-out), [link call](/en/guide/automation/nodes/official/link-call)
