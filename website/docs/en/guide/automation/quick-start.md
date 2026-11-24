# Quick start

Goal: send one AT command from the Node-RED canvas to the serial port in a few minutes.

Open a serial port in the serial panel first. Automation nodes do not open the port themselves; the port is owned by the program.

## 1. Open the canvas

Click the Node-RED icon in the top toolbar. The program opens a separate editor window.

<GuideMedia
  poster="/img/guide/automation-open.png"
/>

The first open waits for the embedded Node-RED to start, usually 2–5 seconds.

## 2. Import the sample flow

Copy the JSON below, open the menu in the upper right corner of the canvas, choose Import and paste it.

```json
[
  {
    "id": "quick_tab",
    "type": "tab",
    "label": "快速开始",
    "disabled": false,
    "info": ""
  },
  {
    "id": "quick_inject",
    "type": "inject",
    "z": "quick_tab",
    "name": "发送 AT",
    "props": [{ "p": "payload" }],
    "repeat": "",
    "crontab": "",
    "once": true,
    "onceDelay": 0.5,
    "topic": "",
    "payload": "AT",
    "payloadType": "str",
    "x": 160,
    "y": 120,
    "wires": [["quick_txd"]]
  },
  {
    "id": "quick_txd",
    "type": "serial txd",
    "z": "quick_tab",
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

The imported flow has two nodes: `inject` fires once on deployment and `serial txd` writes to the port.

## 3. Select the port

Double-click `serial txd`, set Port to the open port and confirm the line ending matches the device.

<GuideMedia
  poster="/img/guide/automation-port.png"
/>

`main` in `monitor` is the pane id. For extra panes or WSL panes, change the value in the JSON to the actual pane.

## 4. Deploy and observe

Click Deploy in the upper right corner. The sample flow sends `AT` once, about 0.5 seconds after deployment.

<GuideMedia
  poster="/img/guide/automation-deploy.png"
/>

The serial monitor shows the send record and the `serial txd` node reports the number of bytes sent.

<GuideMedia
  poster="/img/guide/automation-running.png"
/>

## Next steps

- Send periodically: open `inject`, clear the one-time trigger, select interval under Repeat and enter the interval.
- Wait for a reply: see [Request and reply](/en/guide/automation/flows#request-and-reply) and use `serial request` with `OK` / `ERROR` branches.
- Review node options: see [Node reference](/en/guide/automation/nodes).

## Troubleshooting

**The serial node reports the port is not open**: open the port in the serial panel, then double-click the node and select it again. A closed port cannot be written.

**The monitor shows a send but the device does not respond**: check the line ending. Devices usually expect CRLF or CR and stay silent when the terminator does not match.

**The canvas is empty**: the embedded Node-RED is still starting; wait 2–5 seconds, then click the toolbar icon again if needed.
