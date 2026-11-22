# Built-in nodes

Besides the four serial nodes, the palette contains the nodes that ship with Node-RED, grouped into common, function, sequence and parser categories. Their behaviour matches the official release. This page is an index; each node page covers what it does, how its properties are set and where it is used.

The network and storage categories are removed from the bundled runtime, so HTTP, MQTT and file read/write nodes do not appear on the canvas.

## Common

Triggering, displaying, eventing and organising flows.

| Node | Purpose |
|---|---|
| [inject](/en/guide/automation/nodes/official/inject) | Emits a message, manually, on a schedule or at startup |
| [debug](/en/guide/automation/nodes/official/debug) | Shows a message in the debug panel |
| [complete](/en/guide/automation/nodes/official/complete) | Fires when a node finishes handling a message |
| [catch](/en/guide/automation/nodes/official/catch) | Catches errors thrown by nodes in the flow |
| [status](/en/guide/automation/nodes/official/status) | Turns node status messages into messages |
| [link in](/en/guide/automation/nodes/official/link-in) | Receives messages sent by a `link out` with the same name |
| [link out](/en/guide/automation/nodes/official/link-out) | Sends messages to a `link in` with the same name |
| [link call](/en/guide/automation/nodes/official/link-call) | Calls another part of the flow and returns its result |
| [comment](/en/guide/automation/nodes/official/comment) | Canvas annotation that never runs |
| [global-config](/en/guide/automation/nodes/official/global-config) | Shared configuration node |

## Function

Handling message content and controlling timing.

| Node | Purpose |
|---|---|
| [function](/en/guide/automation/nodes/official/function) | Processes a message with JavaScript |
| [switch](/en/guide/automation/nodes/official/switch) | Routes to several outputs by property value |
| [change](/en/guide/automation/nodes/official/change) | Sets, changes, deletes or moves properties |
| [range](/en/guide/automation/nodes/official/range) | Scales a number to another range |
| [template](/en/guide/automation/nodes/official/template) | Renders text from a template |
| [delay](/en/guide/automation/nodes/official/delay) | Delays or rate-limits messages |
| [trigger](/en/guide/automation/nodes/official/trigger) | Sends after a delay or when a condition is met |
| [exec](/en/guide/automation/nodes/official/exec) | Runs a system command and returns its output |
| [rbe](/en/guide/automation/nodes/official/rbe) | Passes a value only when it changes |

## Sequence

Works on a batch of messages rather than a single one.

| Node | Purpose |
|---|---|
| [split](/en/guide/automation/nodes/official/split) | Splits one message into several |
| [join](/en/guide/automation/nodes/official/join) | Merges several messages into one |
| [sort](/en/guide/automation/nodes/official/sort) | Sorts a sequence of messages |
| [batch](/en/guide/automation/nodes/official/batch) | Groups messages by count or time window |

## Parser

Converts between text and structured data.

| Node | Purpose |
|---|---|
| [csv](/en/guide/automation/nodes/official/csv) | Parses or generates CSV |
| [json](/en/guide/automation/nodes/official/json) | Converts between JSON strings and objects |
| [xml](/en/guide/automation/nodes/official/xml) | Converts between XML and objects |
| [yaml](/en/guide/automation/nodes/official/yaml) | Converts between YAML and objects |
| [html](/en/guide/automation/nodes/official/html) | Extracts or generates HTML |

## Choosing a node

1. Send once on a schedule or by hand: `inject`.
2. Branch on content: `switch`, and `change` when the content must be rewritten first.
3. Assemble or compute content: `function` or `template`.

When the requirement is "send a command and confirm the reply", do not build it from `inject` and `debug`; use [serial request](/en/guide/automation/nodes/serial-request).
