# complete

## Purpose

Fires when a chosen node finishes handling a message, whether it succeeded or failed. It is used to attach follow-up work to the end of an action.

## Properties

| Option | How to set it |
|---|---|
| Target nodes | One or more nodes, by default within the same flow |
| Scope | This flow or all flows |

The output carries `msg.complete`, identifying which node finished.

## Typical uses

| Scenario | Approach |
|---|---|
| Chain the next step | Trigger the next command after a send finishes |
| Track execution | Count or log each completion |
| Pair with `catch` | `complete` handles normal endings, `catch` handles failures |

The difference from `catch`: `complete` fires regardless of outcome, `catch` only on errors.
