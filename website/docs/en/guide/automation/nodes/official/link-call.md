# link call

## Purpose

Calls the part of the flow that starts with the named `link in`, waits for it to finish, then continues with the returned message. It turns a shared sequence into a reusable subroutine.

## Properties

| Option | How to set it |
|---|---|
| Link name | The `link in` to call |
| Timeout | How long to wait for a result before failing |

The called part of the flow must return a result through a `link out` with the same name.

## Typical uses

| Scenario | Approach |
|---|---|
| Reuse command assembly | Keep one copy of the format used in several places |
| Shared validation | Put checks in one flow and call it from several branches |

## Notes

`link call` blocks that message until a result arrives or the timeout expires. Do not create a cycle, or every call waits for the timeout.

Related: [link in](/en/guide/automation/nodes/official/link-in), [link out](/en/guide/automation/nodes/official/link-out)
