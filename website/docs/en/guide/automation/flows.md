# Common flows

The flows below start from an empty canvas. Drag nodes from the palette, double-click a node to set its options, connect the nodes, then click Deploy in the upper right corner.

## Importing a flow

A copyable JSON block follows each flow. To import one, open the menu in the upper right corner of the canvas, choose Import and paste the JSON. After importing, double-click each serial node, set Port to the open port, then click Deploy.

`monitor` in the JSON is the pane id and defaults to `main`. For extra panes or WSL panes, change it to the actual pane. Node names are display labels and can be renamed.

Place only one `serial rxd` or `serial request` per port. Do not deploy the request/reply and receive branch flows on the same port at the same time.

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

Flow code:

```json
[
  {
    "id": "flow_send_tab",
    "type": "tab",
    "label": "定时发送 AT",
    "disabled": false,
    "info": ""
  },
  {
    "id": "flow_send_inject",
    "type": "inject",
    "z": "flow_send_tab",
    "name": "每 5 秒发送",
    "props": [{ "p": "payload" }],
    "repeat": "5",
    "crontab": "",
    "once": false,
    "onceDelay": 0.1,
    "topic": "",
    "payload": "AT",
    "payloadType": "str",
    "x": 160,
    "y": 120,
    "wires": [["flow_send_txd"]]
  },
  {
    "id": "flow_send_txd",
    "type": "serial txd",
    "z": "flow_send_tab",
    "name": "发送 AT",
    "monitor": "main",
    "format": "text",
    "eol": "crlf",
    "x": 400,
    "y": 120,
    "wires": [[]]
  }
]
```

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

Flow code:

```json
[
  {
    "id": "flow_rq_tab",
    "type": "tab",
    "label": "请求应答 AT+CSQ",
    "disabled": false,
    "info": ""
  },
  {
    "id": "flow_rq_inject",
    "type": "inject",
    "z": "flow_rq_tab",
    "name": "查询信号",
    "props": [{ "p": "payload" }],
    "repeat": "",
    "crontab": "",
    "once": false,
    "onceDelay": 0.1,
    "topic": "",
    "payload": "AT+CSQ",
    "payloadType": "str",
    "x": 140,
    "y": 140,
    "wires": [["flow_rq_request"]]
  },
  {
    "id": "flow_rq_request",
    "type": "serial request",
    "z": "flow_rq_tab",
    "name": "查询信号",
    "monitor": "main",
    "sendFormat": "text",
    "recvFormat": "text",
    "eol": "crlf",
    "timeoutMs": 1000,
    "quietMs": 80,
    "rules": [
      { "t": "cont", "v": "OK" },
      { "t": "cont", "v": "ERROR" },
      { "t": "timeout", "v": "" }
    ],
    "outputs": 3,
    "x": 390,
    "y": 140,
    "wires": [["flow_rq_ok"], ["flow_rq_err"], ["flow_rq_to"]]
  },
  {
    "id": "flow_rq_ok",
    "type": "debug",
    "z": "flow_rq_tab",
    "name": "OK 分支",
    "active": true,
    "tosidebar": true,
    "console": false,
    "tostatus": true,
    "complete": "payload",
    "targetType": "msg",
    "statusVal": "payload",
    "statusType": "auto",
    "x": 660,
    "y": 100,
    "wires": []
  },
  {
    "id": "flow_rq_err",
    "type": "debug",
    "z": "flow_rq_tab",
    "name": "ERROR 分支",
    "active": true,
    "tosidebar": true,
    "console": false,
    "tostatus": true,
    "complete": "payload",
    "targetType": "msg",
    "statusVal": "payload",
    "statusType": "auto",
    "x": 670,
    "y": 160,
    "wires": []
  },
  {
    "id": "flow_rq_to",
    "type": "debug",
    "z": "flow_rq_tab",
    "name": "超时 / 未匹配",
    "active": true,
    "tosidebar": true,
    "console": false,
    "tostatus": true,
    "complete": "payload",
    "targetType": "msg",
    "statusVal": "timedOut",
    "statusType": "auto",
    "x": 690,
    "y": 220,
    "wires": []
  }
]
```

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

Flow code:

```json
[
  {
    "id": "flow_rx_tab",
    "type": "tab",
    "label": "接收并分支",
    "disabled": false,
    "info": ""
  },
  {
    "id": "flow_rx_rxd",
    "type": "serial rxd",
    "z": "flow_rx_tab",
    "name": "接收应答",
    "monitor": "main",
    "format": "text",
    "pollMs": 100,
    "x": 140,
    "y": 140,
    "wires": [["flow_rx_switch"]]
  },
  {
    "id": "flow_rx_switch",
    "type": "switch",
    "z": "flow_rx_tab",
    "name": "OK / ERROR",
    "property": "payload",
    "propertyType": "msg",
    "rules": [
      { "t": "cont", "v": "OK", "vt": "str" },
      { "t": "cont", "v": "ERROR", "vt": "str" }
    ],
    "checkall": "false",
    "repair": false,
    "outputs": 2,
    "x": 370,
    "y": 140,
    "wires": [["flow_rx_set_ok"], ["flow_rx_set_err"]]
  },
  {
    "id": "flow_rx_set_ok",
    "type": "change",
    "z": "flow_rx_tab",
    "name": "成功：发下一条",
    "rules": [
      { "t": "set", "p": "payload", "pt": "msg", "to": "AT+NEXT", "tot": "str" }
    ],
    "action": "",
    "property": "",
    "from": "",
    "to": "",
    "reg": false,
    "x": 600,
    "y": 100,
    "wires": [["flow_rx_txd_ok"]]
  },
  {
    "id": "flow_rx_set_err",
    "type": "change",
    "z": "flow_rx_tab",
    "name": "失败：重发",
    "rules": [
      { "t": "set", "p": "payload", "pt": "msg", "to": "AT+RETRY", "tot": "str" }
    ],
    "action": "",
    "property": "",
    "from": "",
    "to": "",
    "reg": false,
    "x": 590,
    "y": 180,
    "wires": [["flow_rx_txd_err"]]
  },
  {
    "id": "flow_rx_txd_ok",
    "type": "serial txd",
    "z": "flow_rx_tab",
    "name": "发送下一条",
    "monitor": "main",
    "format": "text",
    "eol": "crlf",
    "x": 820,
    "y": 100,
    "wires": [[]]
  },
  {
    "id": "flow_rx_txd_err",
    "type": "serial txd",
    "z": "flow_rx_tab",
    "name": "重发",
    "monitor": "main",
    "format": "text",
    "eol": "crlf",
    "x": 810,
    "y": 180,
    "wires": [[]]
  }
]
```

## Using quick commands

`cmd list` is intended for commands already maintained in the quick commands panel. The node stores only the entry identifier, and edits in the panel propagate to deployed flows.

Place `cmd list` in the flow, double-click it to select the port, command and line ending, connect an upstream trigger and deploy. When the entry has been removed or the list is empty, the node sends the captured text and marks the entry as stale.

Flow code:

```json
[
  {
    "id": "flow_cmd_tab",
    "type": "tab",
    "label": "发送快捷指令",
    "disabled": false,
    "info": ""
  },
  {
    "id": "flow_cmd_inject",
    "type": "inject",
    "z": "flow_cmd_tab",
    "name": "触发",
    "props": [{ "p": "payload" }],
    "repeat": "",
    "crontab": "",
    "once": false,
    "onceDelay": 0.1,
    "topic": "",
    "payload": "1",
    "payloadType": "str",
    "x": 140,
    "y": 120,
    "wires": [["flow_cmd_list"]]
  },
  {
    "id": "flow_cmd_list",
    "type": "cmd list",
    "z": "flow_cmd_tab",
    "name": "发送快捷指令",
    "monitor": "main",
    "cmdKey": "",
    "cmdText": "AT",
    "eol": "crlf",
    "x": 390,
    "y": 120,
    "wires": [[]]
  }
]
```
