# debug

## Purpose

Shows message content in the editor's debug panel so the actual data at a point in the flow can be inspected. The node does not modify the message or affect routing.

## Properties

| Option | How to set it |
|---|---|
| Output | `msg.payload`, the whole message object, or a specific property |
| Name | Label shown in the debug panel; name it after the stage it observes |
| Target | Debug panel, runtime log, or both |

## Typical uses

| Scenario | Approach |
|---|---|
| Inspect a node's output | Attach it after the node and check the content after deployment |
| Confirm branching | Attach one per branch to see which one was taken |
| Examine JSON structure | Output the whole message and expand the fields |

Debug nodes left in a long-running flow add overhead; remove them or enable them only when needed.
