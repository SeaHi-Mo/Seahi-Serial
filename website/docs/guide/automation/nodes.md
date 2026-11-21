# 节点与端口

串口相关的节点位于调色板的「串口」分组。

<!-- 截图位 2｜automation-palette.png
     画面：调色板展开「串口」分组，四个节点图标和名字都可见
     要点：能看清 serial rxd / serial txd / serial request / cmd list 四个条目

<GuideMedia
  poster="/img/guide/automation-palette.png"
  caption="调色板的「串口」分组，包含接收、发送、应答与快捷指令四类节点。"
/>
-->

| 节点 | 作用 | 主要参数 |
|---|---|---|
| `serial rxd` | 接收端口数据 | 端口、格式（文本 / HEX / Buffer）、轮询间隔 |
| `serial txd` | 发送数据 | 端口、格式（文本 / HEX）、行尾 |
| `serial request` | 发送一条并收取应答 | 端口、发送与回复格式、行尾、最长等待、静默收口、结果分支 |
| `cmd list` | 发送快捷指令面板中的条目 | 端口、指令、行尾 |

## 端口选择

三个发送类节点的「端口」下拉列出当前已打开的端口，显示为 `COM3 · 115200`。列表中未打开的端口会标注「该端口当前未打开」。

<!-- 截图位 3｜automation-port.png
     画面：serial txd 的属性对话框，重点拍「端口」下拉展开后的样子
     要点：下拉里是 COM3 · 115200 这样的端口名；没有可用端口时显示灰色提示

<GuideMedia
  poster="/img/guide/automation-port.png"
  caption="端口下拉列出当前已打开的端口，显示端口名与波特率。"
/>
-->

端口由串口面板负责打开，节点本身不执行打开或关闭操作。端口关闭后，节点在状态栏给出具体原因。

<!-- 截图位 14｜automation-noport.png
     画面：端口未打开时节点下方的红色状态文字（「COM17 没有打开」或「没有可用的串口」）
     要点：说明节点会指出具体原因，而不是静默失败

<GuideMedia
  poster="/img/guide/automation-noport.png"
  caption="端口未打开时节点给出具体原因，而不是静默失败。"
/>
-->

## 应答结果分支

`serial request` 的输出口由结果分支决定，默认包含「包含 OK」与「包含 ERROR」两个连接点，可以继续添加「等于」「正则」以及兜底的「未匹配或超时」。

<!-- 截图位 4｜automation-request.png
     画面：serial request 的属性对话框，拍结果分支编辑器（两个默认条件 + 添加条件按钮）
     要点：能看出"一个条件一个输出口"

<GuideMedia
  poster="/img/guide/automation-request.png"
  caption="serial request 的结果分支：每个条件对应一个输出连接点。"
/>
-->

条件按从上到下的顺序匹配，命中后从对应连接点输出。未配置「未匹配或超时」条件时，没有命中的应答会被丢弃，并在节点状态栏给出提示。

## 快捷指令节点

`cmd list` 发送的内容来自快捷指令面板，节点中只保存条目的标识。在面板中修改指令内容后，已部署的流程会自动使用新内容，不需要重新配置节点。

<!-- 截图位 12｜automation-cmdlist.png
     画面：cmd list 的属性对话框，「指令」下拉展开，能看到灰色分组标题与下面的条目

<GuideMedia
  poster="/img/guide/automation-cmdlist.png"
  caption="指令下拉按组列出快捷指令，灰色标题只作分隔、不可选中。"
/>
-->

<!-- 截图位 13｜automation-quickcmds.png
     画面：串口面板的快捷指令侧栏（数据来源），能看出组名与指令内容

<GuideMedia
  poster="/img/guide/automation-quickcmds.png"
  caption="快捷指令面板是 cmd list 的数据来源，修改后流程自动跟随。"
/>
-->

列表为空或条目已被删除时，节点按保存时的文本发送，并在状态栏标注该条目已失效。
