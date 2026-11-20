# Node-RED 自动化

程序内嵌了 Node-RED 编辑器，用画布编排串口的收发流程：收到某段数据后判断、再自动发出下一条指令，或按固定节奏循环发送。

编辑器是随程序分发的完整 Node-RED，画布保存为流程文件，部署后由后台引擎执行。

<!--
==================================================================
截图位统一写法（把整段注释去掉即可显示）：

<GuideMedia
  poster="/img/guide/<文件名>.png"
  caption="<一句话说明，写清画面里该看到什么>"
/>

素材放在 website/docs/public/img/guide/，文件名用 automation-<用途>.png。
拍摄口径：只截功能本身，不要带上与内容无关的区域；敏感信息（MAC、令牌、内网地址）打码。
==================================================================
-->

## 打开画布

点击监视器工具栏上的自动化图标，画布会显示在监视器下方，不打开新窗口。

<!-- 截图位 1｜automation-open.png
     画面：顶栏/工具栏上的自动化图标，以及打开后的画布（左侧调色板 + 中间空白画布）
     要点：能看出"嵌在监视器下方"，不是独立窗口

<GuideMedia
  poster="/img/guide/automation-open.png"
  caption="监视器下方的自动化画布：左侧是节点调色板，中间是编辑区。"
/>
-->

使用前需要先在串口面板打开端口。自动化节点不自行打开串口，端口由程序独占，节点通过内部通道读取和写入。

关闭画布不影响流程运行，只有退出程序才会停止。

## 可用节点

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

三个发送类节点的「端口」下拉列出当前已打开的端口，显示为 `COM3 · 115200`。列表中未打开的端口会标注「该端口当前未打开」。

<!-- 截图位 3｜automation-port.png
     画面：serial txd 的属性对话框，重点拍「端口」下拉展开后的样子
     要点：下拉里是 COM3 · 115200 这样的端口名；没有可用端口时显示灰色提示

<GuideMedia
  poster="/img/guide/automation-port.png"
  caption="端口下拉列出当前已打开的端口，显示端口名与波特率。"
/>
-->

`serial request` 的输出口由结果分支决定，默认包含「包含 OK」与「包含 ERROR」两个连接点，可以继续添加「等于」「正则」以及兜底的「未匹配或超时」。

<!-- 截图位 4｜automation-request.png
     画面：serial request 的属性对话框，拍结果分支编辑器（两个默认条件 + 添加条件按钮）
     要点：能看出"一个条件一个输出口"

<GuideMedia
  poster="/img/guide/automation-request.png"
  caption="serial request 的结果分支：每个条件对应一个输出连接点。"
/>
-->

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
     画面：连好的三个节点（inject → serial txd），能看清连线与节点上的端口标签

<GuideMedia
  poster="/img/guide/automation-flow-send.png"
  caption="最基本的发送流程：一个定时触发节点连接到一个发送节点。"
/>
-->

<!-- 截图位 7｜automation-deploy.png
     画面：右上角「部署」按钮，以及部署成功后的提示条

<GuideMedia
  poster="/img/guide/automation-deploy.png"
  caption="部署后流程立即生效，编辑器右上角显示部署结果。"
/>
-->

<!-- 截图位 8｜automation-running.png
     画面：运行中的 serial txd 节点状态（绿色小圆点 + 「已发 N B」文字）

<GuideMedia
  poster="/img/guide/automation-running.png"
  caption="节点下方的状态文字显示最近一次发送结果。"
/>
-->

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

`serial rxd` 输出的 `payload` 是原始字节，节点格式选「文本」时会直接作为字符串输出，便于与关键字比较。

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

`cmd list` 发送的内容来自快捷指令面板，节点中只保存条目的标识。在面板中修改指令内容后，已部署的流程会自动使用新内容，不需要重新配置节点。

列表为空或条目已被删除时，节点按保存时的文本发送，并在状态栏标注该条目已失效。

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

## 部署与运行

| 项目 | 说明 |
|---|---|
| 生效时机 | 点击「部署」后立即运行；未部署的修改只在编辑器中可见 |
| 运行位置 | 后台引擎，关闭画布后继续运行 |
| 停止时机 | 退出程序 |
| 流程文件 | `%APPDATA%\com.seahi.seahi-serial\node-red\flows.json` |

卸载程序不会删除该目录，升级后流程保留。

## 注意事项

- 端口由程序独占。自动化节点与其他串口功能共用同一个端口，不需要也不能自行打开。
- 同一端口上只放置一个 `serial rxd` 或 `serial request`。内部接收队列由两者共用，多个节点会互相分走数据块；需要在多处使用时，接一个节点后再向下游分叉。
- 行尾必须与设备要求一致。设备不识别换行时不会应答，表现为只发不收。
- 设备开启回显（`ATE1`）时，发出的指令会被原样返回，可能提前命中 `serial request` 的结果分支。建议先发送 `ATE0` 关闭回显。
- 接收使用轮询方式获取数据，默认间隔 100 毫秒，接收延迟处于该量级。
- 流程中引用的节点类型被移除或改名后，画布上会显示为未知节点，需要重新拖入并连线。

<!-- 截图位 14｜automation-noport.png
     画面：端口未打开时节点下方的红色状态文字（「COM17 没有打开」或「没有可用的串口」）

<GuideMedia
  poster="/img/guide/automation-noport.png"
  caption="端口未打开时节点给出具体原因，而不是静默失败。"
/>
-->
