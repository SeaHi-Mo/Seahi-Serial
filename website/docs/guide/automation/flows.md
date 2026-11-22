# 常用流程

以下流程都从空白画布开始。节点从左侧调色板拖入，双击节点设置参数，连线后点击右上角「部署」。

## 导入流程

每个流程末尾都附有可复制的 JSON。导入方式：在画布右上角菜单中选择「导入」，粘贴 JSON 内容后确认。导入后双击串口节点，把「端口」改为当前打开的端口，再点击「部署」。

JSON 中的 `monitor` 是分栏 id，默认 `main`。使用额外分栏或 WSL 分栏时，需要按实际分栏修改。导入的节点名称只作显示，可以按需重命名。

同一端口只放一个 `serial rxd` 或 `serial request`；不要把「请求与应答」和「接收与分支」同时部署在同一个端口上。

## 定时发送

目标：每隔固定时间向端口发送一条指令。

<GuideMedia
  poster="/img/guide/automation-inject.png"
/>

1. 从「串口」分组拖出 `serial txd`，从「通用」分组拖出 `inject`。
2. 连接 `inject` 的输出点到 `serial txd` 的输入点。
3. 双击 `inject`，在 `payload` 中填写指令，在「重复」中选择「周期性执行」，填写间隔。
4. 双击 `serial txd`，选择端口、文本格式与行尾。
5. 点击「部署」，在串口面板观察发送结果。

<GuideMedia
  poster="/img/guide/automation-flow-send.png"
/>

<GuideMedia
  poster="/img/guide/automation-running.png"
/>

流程代码：

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

## 请求与应答

目标：发送一条 AT 指令，等待设备回复，并按 `OK` / `ERROR` 分支处理。

<GuideMedia
  poster="/img/guide/automation-flow-request.png"
/>

1. 拖出 `inject` 与 `serial request`，连接 `inject` 到 `serial request`。
2. 双击 `inject`，在 `payload` 中填写要发送的指令。
3. 双击 `serial request`，选择端口、发送与回复格式、行尾。
4. 设置「最长 ms」与「静默 ms」。前者是总等待上限，后者是收到字节后连续无新数据的收口时间。
5. 在结果分支中保留默认的 `OK` / `ERROR`，或添加「等于」「正则」条件；需要处理超时与未匹配时，添加「未匹配/超时」条件。
6. 将各结果连接点接到 `debug`、下一条 `serial txd` 或其他处理节点。
7. 点击「部署」，触发 `inject` 后在 Debug 侧栏查看结果。

`serial request` 每次请求按「清空旧数据 → 发送 → 收集回复」执行，消息中包含 `payload`、`raw`、`cmd`、`bytes`、`elapsedMs`、`matched`、`matchedIndex`、`matchedType`、`timedOut` 和 `reason`。请求在节点内串行排队，多条输入不会同时占用端口。

流程代码：

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

## 接收与分支

目标：接收设备主动上报的数据，按内容执行不同动作。

<GuideMedia
  poster="/img/guide/automation-rxd.png"
/>

<GuideMedia
  poster="/img/guide/automation-switch.png"
/>

1. 拖出 `serial rxd` 与 `switch`，连接 `serial rxd` 的输出到 `switch` 的输入。
2. 双击 `serial rxd`，选择端口、文本格式与轮询间隔。
3. 双击 `switch`，将 property 设为 `msg.payload`，添加「包含」规则并填写设备回复中的关键字。
4. 将 `switch` 的输出分别接到不同的 `serial txd`、`debug` 或其他处理节点。
5. 点击「部署」。

<GuideMedia
  poster="/img/guide/automation-flow-recv.png"
/>

`serial rxd` 格式选文本时 `payload` 直接作为字符串；需要按字节核对时选 HEX 或 Buffer，并读取 `msg.raw`。

流程代码：

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

## 使用快捷指令

`cmd list` 适合发送已经在快捷指令面板中维护的指令。节点只保存条目标识，面板中修改内容后，已部署的流程会自动跟随。

在流程中放置 `cmd list`，双击选择端口、指令与行尾，连接上游触发节点后部署。条目被删除或列表为空时，节点按保存时的文本发送，并在状态栏标注条目已失效。

流程代码：

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
