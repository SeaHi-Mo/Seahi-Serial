# Node reference

The serial nodes live in the «串口» (serial) group of the palette. There are four: one for sending, one for receiving, one that performs a request/reply transaction, and one that sends entries from the quick commands panel.

| Node | Purpose |
|---|---|
| [serial txd](/en/guide/automation/nodes/serial-txd) | Sends data to the port |
| [serial rxd](/en/guide/automation/nodes/serial-rxd) | Receives data from the port |
| [serial request](/en/guide/automation/nodes/serial-request) | Sends one command and collects the reply |
| [cmd list](/en/guide/automation/nodes/cmd-list) | Sends an entry from the quick commands panel |

The palette also contains the nodes that ship with Node-RED. They are listed by category in [Built-in nodes](/en/guide/automation/nodes/official) and are what you combine with the serial nodes for branching, rewriting and timing.

Double-click a node to open its properties. The four dialogs share the same layout: name and port at the top, data format and line ending in the middle, node-specific options below.

The port dropdown lists only the ports that are currently open, shown as `COM3 · 115200`. A new node selects the first available port; when the port is closed the node status explains why.
