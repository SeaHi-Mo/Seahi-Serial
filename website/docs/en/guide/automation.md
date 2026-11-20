# Node-RED automation

The application ships with an embedded Node-RED editor. Flows are built on the canvas to orchestrate serial traffic: inspect the data received from a device, decide what to send next, or send commands on a fixed schedule.

The editor is the full Node-RED distribution bundled with the program. Flows are stored as flow files and executed by the background engine after deployment.

## Opening the canvas

Click the automation icon in the monitor toolbar. The canvas appears below the monitor instead of opening a new window.

A serial port must be open in the serial panel before the nodes can be used. Automation nodes do not open the port themselves; the port is owned by the program and the nodes read and write through an internal channel.

Closing the canvas does not stop the flows. They stop when the program exits.

## Available nodes

Serial nodes are grouped under «串口» (serial) in the palette.

| Node | Purpose | Main options |
|---|---|---|
| `serial rxd` | Receives port data | Port, format (text / HEX / Buffer), poll interval |
| `serial txd` | Sends data | Port, format (text / HEX), line ending |
| `serial request` | Sends one command and collects the reply | Port, send and reply formats, line ending, maximum wait, quiet window, result branches |
| `cmd list` | Sends an entry from the quick commands panel | Port, command, line ending |

The Port dropdown of every sending node lists the ports that are currently open, shown as `COM3 · 115200`. A saved port that is no longer open is marked as not open.

The output of `serial request` is selected by its result branches. Two connection points are provided by default, one matching `OK` and one matching `ERROR`. Additional branches can match exact values, regular expressions, or act as the fallback for unmatched and timed-out replies.

## Sending on a schedule

1. Drag `serial txd` from the serial group onto the canvas.
2. Drag `inject` from the common group to its left.
3. Connect the output of `inject` to the input of `serial txd`.
4. Open `inject`, set `payload` to the command text and `repeat` to the interval.
5. Open `serial txd`, select the port and the line ending.
6. Click Deploy in the upper right corner.
7. Observe the result in the serial panel.

The flow starts running immediately after deployment and the inject node fires at the configured interval.

## Receiving and branching

1. Drag `serial rxd` onto the canvas and add a `switch` node.
2. Connect the output of `serial rxd` to the input of `switch`.
3. Open `switch`, set `property` to `payload`, add a rule that matches the reply keyword.
4. Connect the two outputs of `switch` to different `serial txd` or `debug` nodes.
5. Deploy.

The `payload` emitted by `serial rxd` is emitted as text when the node format is set to text, so it can be compared against keywords directly.

## Using quick commands

`cmd list` sends the content of an entry from the quick commands panel; the node stores only the entry identifier. Changing the command text in the panel is picked up by deployed flows without editing the node.

When the entry has been removed or the list is empty, the node sends the text captured when it was configured and marks the entry as stale in its status.

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
