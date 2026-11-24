# 快速开始

在几分钟内让一条 AT 指令从 Node-RED 画布发送到串口。<br>
开始前先在串口面板打开端口。自动化节点不自行打开串口，端口由程序独占。

## 1. 打开画布

点击顶部工具栏的 Node-RED 图标，程序打开独立的编辑器窗口。首次打开需要等待内置 Node-RED 启动，通常为 2–5 秒。

<GuideMedia
  poster="/gif/guider/openNodeRed.gif"
  width="700"
/>

## 2. 流程配置

### 2.1 重命名流程

双击流程的名字可以调出流程属性面板，在面板中修改流程名字即可。

<GuideMedia
  poster="/gif/guider/setFlow.gif"
  width="700"
/>

### 2.2 添加和删除流程

可以添加很多个流程，来实现不同的功能测试。

::: tip 注意
新的流程需要部署之后才会保存下来。
:::

#### 添加流程

点击 `部署` 旁边的“+” 按钮以添加流程。

#### 删除流程

选中流程之后，鼠标右键展开操作栏，再点击 `删除` 即可。

#### 演示

<GuideMedia
  poster="/gif/guider/addFlow.gif"
  width="700"
/>

### 2.3 禁用和启用流程

新的流程部署之后默认启用。需要保留流程而让其不运行的话，可以禁用流程。

- 定位到左侧的流程列表
- 选择对应的流程
- 点击禁用按钮/再次点击可以启用

#### 演示

<GuideMedia
  poster="/gif/guider/bandFlow.gif"
  width="700"
/>

::: warning 注意
重启流程后，需要再次部署才会生效。
:::

## 3. 节点使用

### 3.1 串口发送测试

本教程将使用 AT 指令做串口测试，以测试一个串口发送的流程该有哪些节点。实现一个完整的串口发送功能。

#### 步骤如下

::: steps

- icon: "①"
  title: 重命名流程
  text: 双击流程名称，修改流程名。

- icon: "②"
  title: 添加 injet 节点
  text: `injet` 节点可以手动触发一个指令输出，需要选择文本方式输出。

- icon: "③"
  title: 添加 serial txd 节点
  text: `serial txd` 节点是让输入的指令通过串口发送出去，需要在属性里设置对应的 COM 口，和发送格式。

- icon: "④"
  title: 添加 debug 节点
  text: `debug` 节点，是用来查看调试信息，用于在调试台中显示上一个节点输出的数据。

- icon: "⑤"
  title: 连接三个节点
  text: 把三个节点连接起来，组成一个基础的流程。

- icon: "⑥"
  title: 部署流程
  text: 点击 `部署` 流程，让自动化流程运行起来。
:::

#### 演示

<GuideMedia
  poster="/gif/guider/testTLLTXD.gif"
  width="700"
/>

### 3.2 监控串口回复

除了手动触发发送 AT 指令之外，还能通过抓取串口 AT 指令的回复，做出下一步控制。比如识别启动信息自动发送 “AT”。

#### 步骤如下

::: steps

- icon: "①"
  title: 添加 serial rxd 节点
  text: `serial rxd` 节点会监控串口接收到的所有数据，然后输出。

- icon: "②"
  title: 添加第一个 debug 节点
  text: 用来查看 `serial rxd` 节点的输出是否正常。

- icon: "③"
  title: 添加 switch 节点
  text: `switch` 节点，用于对输入的内容进行条件选择，比如识别是否包含 “ready” 内容。

- icon: "④"
  title: 添加 change 节点
  text: `change` 节点，用于重新改写上一个节点输出的内容，比如把 `switch` 节点输出的 `“ready”` 改成 `“AT”`。

- icon: "⑤"
  title: 添加 serial txd 节点
  text: 用于发送数据。

- icon: "⑥"
  title: 添加第二个 debug 节点
  text: 用于监控串口发送。

- icon: "⑦"
  title: 部署流程
  text: 点击 `部署` 流程，让自动化流程运行起来。

- icon: "⑧"
  title: 测试流程
  text: 复位模组，查看是否能够自动发送 `AT`。
:::

#### 演示

<GuideMedia
  poster="/gif/guider/testTTLRxd.gif"
  width="700"
/>

### 3.3 串口发送识别

AT 指令场景下，通常需要识别发送的指令是否成功，`serial request` 节点就是为了解决这一场景而生。它能监控上一个节点发送的指令回复，然后输出结果。例如识别指令 “AT” 指令是否发送成功。

#### 步骤如下

::: steps

- icon: "①"
  title: 添加 injet 节点
  text: 用于手动发送 “AT”。

- icon: "③"
  title: 添加 serial txd 节点
  text: 发送数据。

- icon: "③"
  title: 添加 serial request 节点
  text: 监控指令回复是否正确。

- icon: "⑥"
  title: 添加第一个 debug 节点
  text: 用于监控指令回复 `“OK”` 的状态。

- icon: "⑥"
  title: 添加第二个 debug 节点
  text: 用于监控指令回复 `“ERROR”` 的状态。

- icon: "⑦"
  title: 部署流程
  text: 点击 `部署` 流程，让自动化流程运行起来。
:::

#### 演示

<GuideMedia
  poster="/gif/guider/checkAT.gif"
  width="700"
/>
