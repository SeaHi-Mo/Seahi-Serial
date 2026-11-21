# 常用流程

以下流程都从空白画布开始。节点从左侧调色板拖入，双击节点设置参数，连线后点击右上角「部署」。

## 定时发送

目标：每隔固定时间向端口发送一条指令。

<GuideMedia
  poster="/img/guide/automation-inject.png"
  caption="inject 的属性面板：payload 填指令内容，「重复」选择周期性执行并填写间隔。"
/>

1. 从「串口」分组拖出 `serial txd`，从「通用」分组拖出 `inject`。
2. 连接 `inject` 的输出点到 `serial txd` 的输入点。
3. 双击 `inject`，在 `payload` 中填写指令，在「重复」中选择「周期性执行」，填写间隔。
4. 双击 `serial txd`，选择端口、文本格式与行尾。
5. 点击「部署」，在串口面板观察发送结果。

<GuideMedia
  poster="/img/guide/automation-flow-send.png"
  caption="定时发送流程：inject 按间隔触发，serial txd 显示最近一次发送的字节数。"
/>

<GuideMedia
  poster="/img/guide/automation-running.png"
  caption="运行中的 serial txd：节点下方的状态文字显示发送结果。"
/>

## 请求与应答

目标：发送一条 AT 指令，等待设备回复，并按 `OK` / `ERROR` 分支处理。

<GuideMedia
  poster="/img/guide/automation-flow-request.png"
  caption="请求应答流程：inject 触发 serial request，三个结果连接点分别接 OK、ERROR 与超时分支。"
/>

1. 拖出 `inject` 与 `serial request`，连接 `inject` 到 `serial request`。
2. 双击 `inject`，在 `payload` 中填写要发送的指令。
3. 双击 `serial request`，选择端口、发送与回复格式、行尾。
4. 设置「最长 ms」与「静默 ms」。前者是总等待上限，后者是收到字节后连续无新数据的收口时间。
5. 在结果分支中保留默认的 `OK` / `ERROR`，或添加「等于」「正则」条件；需要处理超时与未匹配时，添加「未匹配/超时」条件。
6. 将各结果连接点接到 `debug`、下一条 `serial txd` 或其他处理节点。
7. 点击「部署」，触发 `inject` 后在 Debug 侧栏查看结果。

`serial request` 每次请求按「清空旧数据 → 发送 → 收集回复」执行，消息中包含 `payload`、`raw`、`cmd`、`bytes`、`elapsedMs`、`matched`、`matchedIndex`、`matchedType`、`timedOut` 和 `reason`。请求在节点内串行排队，多条输入不会同时占用端口。

同一端口只放一个 `serial rxd` 或 `serial request`；设备回显未关闭时先发送 `ATE0`。

## 接收与分支

目标：接收设备主动上报的数据，按内容执行不同动作。

<GuideMedia
  poster="/img/guide/automation-rxd.png"
  caption="serial rxd 的属性面板：选择端口和文本格式，便于直接比较回复中的关键字。"
/>

<GuideMedia
  poster="/img/guide/automation-switch.png"
  caption="switch 的属性面板：property 设为 msg.payload，规则分别匹配 OK 与 ERROR。"
/>

1. 拖出 `serial rxd` 与 `switch`，连接 `serial rxd` 的输出到 `switch` 的输入。
2. 双击 `serial rxd`，选择端口、文本格式与轮询间隔。
3. 双击 `switch`，将 property 设为 `msg.payload`，添加「包含」规则并填写设备回复中的关键字。
4. 将 `switch` 的输出分别接到不同的 `serial txd`、`debug` 或其他处理节点。
5. 点击「部署」。

<GuideMedia
  poster="/img/guide/automation-flow-recv.png"
  caption="接收分支流程：serial rxd 收到数据后交给 switch，两个分支分别发送不同指令。"
/>

`serial rxd` 格式选文本时 `payload` 直接作为字符串；需要按字节核对时选 HEX 或 Buffer，并读取 `msg.raw`。

## 使用快捷指令

`cmd list` 适合发送已经在快捷指令面板中维护的指令。节点只保存条目标识，面板中修改内容后，已部署的流程会自动跟随。

在流程中放置 `cmd list`，双击选择端口、指令与行尾，连接上游触发节点后部署。条目被删除或列表为空时，节点按保存时的文本发送，并在状态栏标注条目已失效。
