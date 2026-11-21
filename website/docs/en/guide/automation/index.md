# Node-RED automation

The application ships with an embedded Node-RED editor. Flows are built on the canvas to orchestrate serial traffic: inspect the data received from a device, decide what to send next, or send commands on a fixed schedule.

The editor is the full Node-RED distribution bundled with the program. Flows are stored as flow files and executed by the background engine after deployment. Flows are suited to fixed send/receive sequences, reply handling and scheduled tasks.

This section contains three pages:

- This page: opening the canvas, deployment and execution
- [Nodes and ports](/en/guide/automation/nodes): the four serial nodes, port selection, reply branches
- [Common flows](/en/guide/automation/flows): scheduled sends, request/reply, receive branching, quick commands

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

## Deployment and execution

<!-- Slot 7 / automation-deploy.png
     Frame: the Deploy button and the deployment confirmation.

<GuideMedia
  poster="/img/guide/automation-deploy.png"
  caption="Deployment takes effect immediately and the result is shown in the editor."
/>
-->

| Item | Description |
|---|---|
| Activation | Runs immediately after Deploy; uncommitted edits stay in the editor |
| Execution | Background engine, continues after the canvas is closed |
| Stop condition | Program exit |
| Flow file | `%APPDATA%\com.seahi.seahi-serial\node-red\flows.json` |

Uninstalling the program does not remove this directory, so flows survive an upgrade. Deleting a flow tab or changing wiring is written to the flow file only after Deploy; closing the canvas does not write them, while the edit state remains when the canvas is reopened.

## Notes

- The port is owned by the program. Automation nodes share it with the other serial features and neither need nor attempt to open it themselves.
- Place only one `serial rxd` or `serial request` per port. Both consume the same internal receive queue, so multiple nodes split the data blocks between them. To use the data in several places, branch downstream from a single node.
- The line ending must match what the device expects. A device that does not recognize the terminator stays silent, which appears as sending without receiving.
- When the device echoes commands (`ATE1`), the sent command is returned and may match a result branch too early. Send `ATE0` first to disable echo.
- Received data is polled, with a default interval of 100 milliseconds, so receive latency is in that range.
- If a node type referenced by a flow is removed or renamed, the flow shows an unknown node on the canvas and the node must be replaced and rewired.
