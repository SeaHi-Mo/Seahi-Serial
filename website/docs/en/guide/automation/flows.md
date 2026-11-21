# Common flows

The flows below start from an empty canvas. Drag nodes from the palette, double-click a node to set its options, connect the nodes, then click Deploy in the upper right corner.

## Flow code

Importable JSON is provided for all four flows:

- [Download scheduled send JSON](/flows/scheduled-send.json)
- [Download request and reply JSON](/flows/request-reply.json)
- [Download receive branch JSON](/flows/receive-branch.json)
- [Download quick command JSON](/flows/quick-command.json)

To import, open the menu in the upper right corner of the canvas, choose Import and paste the JSON. After importing, double-click each serial node, set Port to the open port, then click Deploy.

`monitor` in the JSON is the pane id and defaults to `main`. For extra panes or WSL panes, change it to the actual pane. Node names are display labels and can be renamed.

## Sending on a schedule

Goal: send a command to the port at a fixed interval.

<GuideMedia
  poster="/img/guide/automation-inject.png"
  caption="inject properties: payload holds the command, Repeat is set to interval and the interval is entered below."
/>

1. Drag `serial txd` from the serial group and `inject` from the common group onto the canvas.
2. Connect the output of `inject` to the input of `serial txd`.
3. Open `inject`, set `payload` to the command, select interval under Repeat and enter the interval.
4. Open `serial txd`, select the port, text format and line ending.
5. Click Deploy and observe the result in the serial panel.

<GuideMedia
  poster="/img/guide/automation-flow-send.png"
  caption="Scheduled send flow: inject fires on the interval and serial txd reports the number of bytes sent."
/>

<GuideMedia
  poster="/img/guide/automation-running.png"
  caption="A running serial txd node: the status line below the node reports the send result."
/>

Flow code: [Scheduled send JSON](/flows/scheduled-send.json)

## Request and reply

Goal: send an AT command, wait for the reply and handle `OK` and `ERROR` on separate branches.

<GuideMedia
  poster="/img/guide/automation-flow-request.png"
  caption="Request/reply flow: inject triggers serial request, whose three result outputs feed the OK, ERROR and timeout branches."
/>

1. Drag `inject` and `serial request` onto the canvas and connect `inject` to `serial request`.
2. Open `inject` and set `payload` to the command.
3. Open `serial request` and select the port, send and reply formats and the line ending.
4. Set Maximum ms and Quiet ms. The first is the total wait limit; the second closes the reply after a period without new data.
5. Keep the default `OK` / `ERROR` branches, or add equals and regular-expression conditions. Add the unmatched/timeout condition when timeouts and unmatched replies need handling.
6. Connect each result output to a `debug` node, the next `serial txd` or another processing node.
7. Click Deploy, trigger `inject` and read the result in the Debug sidebar.

Each request runs as clear stale data, send, collect reply. A `serial request` message carries `payload`, `raw`, `cmd`, `bytes`, `elapsedMs`, `matched`, `matchedIndex`, `matchedType`, `timedOut` and `reason`. Requests are queued inside the node, so multiple inputs do not use the port at the same time.

Place only one `serial rxd` or `serial request` per port. With device echo enabled, send `ATE0` first.

Flow code: [Request and reply JSON](/flows/request-reply.json)

## Receiving and branching

Goal: receive unsolicited data from the device and act on its content.

<GuideMedia
  poster="/img/guide/automation-rxd.png"
  caption="serial rxd properties: select the port and text format so replies can be compared against keywords."
/>

<GuideMedia
  poster="/img/guide/automation-switch.png"
  caption="switch properties: property is set to msg.payload and the rules match OK and ERROR."
/>

1. Drag `serial rxd` and `switch` onto the canvas and connect the output of `serial rxd` to the input of `switch`.
2. Open `serial rxd`, select the port, text format and poll interval.
3. Open `switch`, set property to `msg.payload`, add a contains rule and enter the keyword from the device reply.
4. Connect the switch outputs to different `serial txd`, `debug` or other processing nodes.
5. Click Deploy.

<GuideMedia
  poster="/img/guide/automation-flow-recv.png"
  caption="Receive branch flow: serial rxd passes data to switch, and each branch sends a different command."
/>

In text format, the `payload` of `serial rxd` is a string. For byte-level checks, select HEX or Buffer and read `msg.raw`.

Flow code: [Receive branch JSON](/flows/receive-branch.json)

## Using quick commands

`cmd list` is intended for commands already maintained in the quick commands panel. The node stores only the entry identifier, and edits in the panel propagate to deployed flows.

Place `cmd list` in the flow, double-click it to select the port, command and line ending, connect an upstream trigger and deploy. When the entry has been removed or the list is empty, the node sends the captured text and marks the entry as stale.

Flow code: [Quick command JSON](/flows/quick-command.json)

