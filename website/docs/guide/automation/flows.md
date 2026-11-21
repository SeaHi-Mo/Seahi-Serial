# 常用流程

以下流程都从空白画布开始，节点从左侧调色板拖入，连线后点击右上角「部署」。

## 定时发送

<!-- 截图位 5｜automation-inject.png
     画面：inject 节点的属性对话框，payload 已填指令、repeat 已填间隔

<GuideMedia
  poster="/img/guide/automation-inject.png"
  caption="inject 节点同时决定发送内容与重复间隔。"
/>
-->

1. 从「串口」分组拖出 `serial txd` 到画布。
2. 从「通用」分组拖出 `inject` 放到它的左侧。
3. 连接 `inject` 右侧的输出点到 `serial txd` 左侧的输入点。
4. 双击 `inject`，将 `payload` 设为要发送的指令文本，`repeat` 设为发送间隔。
5. 双击 `serial txd`，选择端口与行尾。
6. 点击右上角的「部署」。
7. 在串口面板观察发送结果。

部署后流程立即开始运行，`inject` 按设定的间隔重复触发。

<!-- 截图位 6｜automation-flow-send.png
     画面：连好的两个节点（inject → serial txd），能看清连线与节点上的端口标签

<GuideMedia
  poster="/img/guide/automation-flow-send.png"
  caption="最基本的发送流程：一个定时触发节点连接到一个发送节点。"
/>
-->

<!-- 截图位 8｜automation-running.png
     画面：运行中的 serial txd 节点状态（绿色小圆点 + 「已发 N B」文字）

<GuideMedia
  poster="/img/guide/automation-running.png"
  caption="节点下方的状态文字显示最近一次发送结果。"
/>
-->

## 请求与应答

需要“发一条、等回复、再按回复分支”时，使用 `serial request`。节点内部按固定顺序执行：清空旧数据、写串口、收集回复。

1. 从「通用」分组拖出 `inject`，从「串口」分组拖出 `serial request`。
2. 连接 `inject` 到 `serial request`。
3. 双击 `inject`，`payload` 填入要发送的指令；需要重复请求时设置 `repeat`。
4. 双击 `serial request`，选择端口、发送与回复格式、行尾，设置最长等待与静默收口。
5. 在结果分支中保留默认的 `OK` / `ERROR`，或添加「等于」「正则」条件；需要处理超时与未匹配时，添加「未匹配或超时」条件。
6. 将各结果连接点接到 `debug`、下一条 `serial txd` 或其他处理节点。
7. 点击「部署」，触发 `inject` 后在 Debug 侧栏查看结果。

`serial request` 的消息包含 `payload`、`raw`、`cmd`、`bytes`、`elapsedMs`、`matched`、`matchedIndex`、`matchedType`、`timedOut` 和 `reason`。请求在节点内串行排队，同一节点的多条输入不会同时占用端口。

结果分支之外的注意事项：

- 同一端口只放一个 `serial rxd` 或 `serial request`，两者共用内部接收队列。
- 设备回显未关闭时，发出的指令可能先命中条件；先发送 `ATE0`。
- 没有配置「未匹配或超时」条件时，未命中的结果会被丢弃，节点状态栏会给出提示。

## 接收与分支

<!-- 截图位 9｜automation-rxd.png
     画面：serial rxd 的属性对话框（端口、格式、轮询间隔）

<GuideMedia
  poster="/img/guide/automation-rxd.png"
  caption="接收节点选择端口与数据格式，文本格式便于直接与关键字比较。"
/>
-->

1. 拖出 `serial rxd`，再拖出 `switch`。
2. 连接 `serial rxd` 的输出到 `switch` 的输入。
3. 双击 `switch`，`property` 设为 `payload`，第一条规则选择「包含」，值填入设备应答中的关键字。
4. 从 `switch` 的两个输出点分别连接到不同的 `serial txd` 或 `debug`。
5. 部署。

`serial rxd` 的 `payload` 按节点格式输出；格式选「文本」时直接作为字符串，便于与关键字比较。需要按字节核对时，格式选「HEX」或「Buffer」，并使用 `msg.raw` 读取原始数据。

<!-- 截图位 10｜automation-switch.png
     画面：switch 的属性对话框，property = payload，规则为「包含 OK」

<GuideMedia
  poster="/img/guide/automation-switch.png"
  caption="switch 按收到的内容分支，property 取 payload 即可匹配应答。"
/>
-->

<!-- 截图位 11｜automation-flow-recv.png
     画面：serial rxd → switch → 两个 serial txd 的完整连线

<GuideMedia
  poster="/img/guide/automation-flow-recv.png"
  caption="接收后按内容分支，两条分支分别发送不同的指令。"
/>
-->

## 使用快捷指令

`cmd list` 适合发送已经在快捷指令面板中维护的指令。节点只保存条目标识，面板中修改内容后，已部署的流程会自动跟随。

在流程中放置 `cmd list`，选择端口、指令与行尾，部署后由上游节点触发。条目被删除或列表为空时，节点按保存时的文本发送，并在状态栏标注条目已失效。
