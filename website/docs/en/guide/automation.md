# Node-RED automation

The application ships with an embedded Node-RED editor. Flows are built on the canvas to orchestrate serial traffic: inspect the data received from a device, decide what to send next, or send commands on a fixed schedule.

The editor is the full Node-RED distribution bundled with the program. Flows are stored as flow files and executed by the background engine after deployment.

<!--
==================================================================
Screenshot slots. To publish one, remove the surrounding comment:

<GuideMedia
  poster="/img/guide/<file>.png"
  caption="<one sentence describing what the image shows>"
/>

Assets live in website/docs/public/img/guide/; name them automation-<purpose>.png.
Capture only the part of the window that matters, and mask MAC addresses, tokens and internal hosts.
==================================================================
-->

## Opening the canvas

Click the automation icon in the monitor toolbar. The canvas appears below the monitor instead of opening a new window.

<!-- Slot 1 / automation-open.png
     Frame: the toolbar icon and the opened canvas with the palette on the left.

<GuideMedia
  poster="/img/guide/automation-open.png"
  caption="The automation canvas sits below the monitor, with the palette on the left."
/>
-->

A serial port must be open in the serial panel before the nodes can be used. Automation nodes do not open the port themselves; the port is owned by the program and the nodes read and write through an internal channel.

Closing the canvas does not stop the flows. They stop when the program exits.

## Available nodes

Serial nodes are grouped under «串口» (serial) in the palette.

<!-- Slot 2 / automation-palette.png
     Frame: the serial group expanded, all four nodes visible.

<GuideMedia
  poster="/img/guide/automation-palette.png"
  caption="The serial group contains receive, send, request and quick command nodes."
/>
-->

| Node | Purpose | Main options |
|---|---|---|
| `serial rxd` | Receives port data | Port, format (text / HEX / Buffer), poll interval |
| `serial txd` | Sends data | Port, format (text / HEX), line ending |
| `serial request` | Sends one command and collects the reply | Port, send and reply formats, line ending, maximum wait, quiet window, result branches |
| `cmd list` | Sends an entry from the quick commands panel | Port, command, line ending |

The Port dropdown of every sending node lists the ports that are currently open, shown as `COM3 · 115200`. A saved port that is no longer open is marked as not open.

<!-- Slot 3 / automation-port.png
     Frame: the serial txd dialog with the port dropdown expanded.

<GuideMedia
  poster="/img/guide/automation-port.png"
  caption="The port dropdown lists open ports with port name and baud rate."
/>
-->

The output of `serial request` is selected by its result branches. Two connection points are provided by default, one matching `OK` and one matching `ERROR`. Additional branches can match exact values, regular expressions, or act as the fallback for unmatched and timed-out replies.

<!-- Slot 4 / automation-request.png
     Frame: the serial request dialog, focused on the result branch editor.

<GuideMedia
  poster="/img/guide/automation-request.png"
  caption="Each result condition owns one output connection point."
/>
-->

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

<!-- Slot 7 / automation-deploy.png
     Frame: the Deploy button and the deployment confirmation.

<GuideMedia
  poster="/img/guide/automation-deploy.png"
  caption="Deployment takes effect immediately and the result is shown in the editor."
/>
-->

<!-- Slot 8 / automation-running.png
     Frame: a running serial txd node with its green status dot and sent byte count.

<GuideMedia
  poster="/img/guide/automation-running.png"
  caption="Node status reports the result of the most recent send."
/>
-->

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

The `payload` emitted by `serial rxd` is emitted as text when the node format is set to text, so it can be compared against keywords directly.

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

`cmd list` sends the content of an entry from the quick commands panel; the node stores only the entry identifier. Changing the command text in the panel is picked up by deployed flows without editing the node.

When the entry has been removed or the list is empty, the node sends the text captured when it was configured and marks the entry as stale in its status.

<!-- Slot 12 / automation-cmdlist.png
     Frame: the cmd list dialog with the command dropdown expanded, group headers visible.

<GuideMedia
  poster="/img/guide/automation-cmdlist.png"
  caption="Commands are listed by group; grey headers separate groups and cannot be selected."
/>
-->

<!-- Slot 13 / automation-quickcmds.png
     Frame: the quick commands side panel in the serial view.

<GuideMedia
  poster="/img/guide/automation-quickcmds.png"
  caption="The quick commands panel is the source for cmd list; edits propagate to running flows."
/>
-->

## Deployment and execution

| Item | Description |
|---|---|
| Activation | Runs immediately after Deploy; uncommitted edits stay in the editor |
| Execution | Background engine, continues after the canvas is closed |
| Stop condition | Program exit |
| Flow file | `%APPDATA%\com.seahi.seahi-serial\node-red\flows.json` |

Uninstalling the program does not remove this directory, so flows survive an upgrade.

## Notes

- The port is owned by the program. Automation nodes share it with the other serial features and neither need nor attempt to open it themselves.
- Place only one `serial rxd` or `serial request` per port. Both consume the same internal receive queue, so multiple nodes split the data blocks between them. To use the data in several places, branch downstream from a single node.
- The line ending must match what the device expects. A device that does not recognize the terminator stays silent, which appears as sending without receiving.
- When the device echoes commands (`ATE1`), the sent command is returned and may match a result branch too early. Send `ATE0` first to disable echo.
- Received data is polled, with a default interval of 100 milliseconds, so receive latency is in that range.
- If a node type referenced by a flow is removed or renamed, the flow shows an unknown node on the canvas and the node must be replaced and rewired.

<!-- Slot 14 / automation-noport.png
     Frame: the red status text shown when the port is not open.

<GuideMedia
  poster="/img/guide/automation-noport.png"
  caption="A closed port produces a specific message instead of a silent failure."
/>
-->
