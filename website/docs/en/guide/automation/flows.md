# Common flows

The flows below start from an empty canvas. Drag nodes from the palette, connect them, then click Deploy in the upper right corner.

## Sending on a schedule

<!-- Slot 5 / automation-inject.png
     Frame: the inject dialog with payload and repeat filled in.

<GuideMedia
  poster="/img/guide/automation-inject.png"
  caption="The inject node defines both the payload and the repeat interval."
/>
-->

1. Drag `serial txd` from the serial group onto the canvas.
2. Drag `inject` from the common group to its left.
3. Connect the output of `inject` to the input of `serial txd`.
4. Open `inject`, set `payload` to the command text and `repeat` to the interval.
5. Open `serial txd`, select the port and the line ending.
6. Click Deploy in the upper right corner.
7. Observe the result in the serial panel.

The flow starts running immediately after deployment and the inject node fires at the configured interval.

<!-- Slot 6 / automation-flow-send.png
     Frame: the wired inject to serial txd pair, showing the connection and the node label.

<GuideMedia
  poster="/img/guide/automation-flow-send.png"
  caption="The minimal sending flow: a timer wired to a sending node."
/>
-->

<!-- Slot 8 / automation-running.png
     Frame: a running serial txd node with its green status dot and sent byte count.

<GuideMedia
  poster="/img/guide/automation-running.png"
  caption="Node status reports the result of the most recent send."
/>
-->

## Request and reply

Use `serial request` when a single command needs a reply and the reply must select a branch. The node runs a fixed sequence: clear stale data, write the command, collect the reply.

1. Drag `inject` from the common group and `serial request` from the serial group.
2. Connect `inject` to `serial request`.
3. Open `inject`, set `payload` to the command to send; set `repeat` if the request must run on a schedule.
4. Open `serial request`, select the port, the send and reply formats and the line ending, then set the maximum wait and quiet window.
5. Keep the default `OK` / `ERROR` result branches, or add exact-value and regular-expression conditions. Add the fallback condition when timeouts and unmatched replies need handling.
6. Connect each result output to a `debug` node, the next `serial txd`, or another processing node.
7. Click Deploy, trigger `inject`, then read the result in the Debug sidebar.

A `serial request` message carries `payload`, `raw`, `cmd`, `bytes`, `elapsedMs`, `matched`, `matchedIndex`, `matchedType`, `timedOut` and `reason`. Requests are queued inside the node, so multiple inputs do not use the port at the same time.

Additional constraints:

- Place only one `serial rxd` or `serial request` per port; both share the internal receive queue.
- With device echo enabled, the sent command may match a condition first; send `ATE0` first.
- Without a fallback condition, unmatched results are discarded and the node reports this in its status line.

## Receiving and branching

<!-- Slot 9 / automation-rxd.png
     Frame: the serial rxd dialog with port, format and poll interval.

<GuideMedia
  poster="/img/guide/automation-rxd.png"
  caption="The receive node selects the port and data format; text format compares directly against keywords."
/>
-->

1. Drag `serial rxd` onto the canvas and add a `switch` node.
2. Connect the output of `serial rxd` to the input of `switch`.
3. Open `switch`, set `property` to `payload`, add a rule that matches the reply keyword.
4. Connect the two outputs of `switch` to different `serial txd` or `debug` nodes.
5. Deploy.

The `payload` of `serial rxd` follows the node format; text format emits a string that can be compared against keywords directly. For byte-level checks, select HEX or Buffer and read the original bytes from `msg.raw`.

<!-- Slot 10 / automation-switch.png
     Frame: the switch dialog with property set to payload and a keyword rule.

<GuideMedia
  poster="/img/guide/automation-switch.png"
  caption="The switch node branches on the received payload."
/>
-->

<!-- Slot 11 / automation-flow-recv.png
     Frame: the full serial rxd to switch to two serial txd wiring.

<GuideMedia
  poster="/img/guide/automation-flow-recv.png"
  caption="Replies are branched by content, and each branch sends a different command."
/>
-->

## Using quick commands

`cmd list` is intended for commands already maintained in the quick commands panel. The node stores only the entry identifier, and edits in the panel propagate to deployed flows.

Place `cmd list` in the flow, select the port, command and line ending, then trigger it from an upstream node after deployment. When the entry has been removed or the list is empty, the node sends the captured text and marks the entry as stale.
