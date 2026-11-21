# 快速开始

目标：在几分钟内让一条 AT 指令从 Node-RED 画布发送到串口。

开始前先在串口面板打开端口。自动化节点不自行打开串口，端口由程序独占。

## 1. 打开画布

点击监视器工具栏上的自动化图标，画布显示在监视器下方。

<GuideMedia
  poster="/img/guide/automation-open.png"
  caption="打开后的自动化画布：顶部是串口工具栏，左侧是节点调色板，中间是编辑区。"
/>

首次打开需要等待内置 Node-RED 启动，通常为 2–5 秒。

## 2. 导入示例流程

复制下面的 JSON，在画布右上角菜单中选择「导入」，粘贴后确认。

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

导入后会得到两个节点：`inject` 在部署时触发一次，`serial txd` 负责写入串口。

## 3. 选择端口

双击 `serial txd`，在属性面板中把「端口」改为当前打开的端口，并确认行尾与设备要求一致。

<GuideMedia
  poster="/img/guide/automation-port.png"
  caption="serial txd 的属性面板：在「端口」字段选择已打开的端口，在右侧确认格式和行尾。"
/>

`monitor` 中的 `main` 是分栏 id。使用额外分栏或 WSL 分栏时，需要按实际分栏修改 JSON 中的值。

## 4. 部署并观察

点击画布右上角「部署」。示例流程会在部署后约 0.5 秒发送一次 `AT`。

<GuideMedia
  poster="/img/guide/automation-deploy.png"
  caption="画布右上角的「部署」按钮。部署后流程立即运行。"
/>

串口监视窗口会出现发送记录，`serial txd` 节点下方显示已发送的字节数。

<GuideMedia
  poster="/img/guide/automation-running.png"
  caption="运行中的 serial txd：节点状态显示最近一次发送结果。"
/>

## 下一步

- 改成周期发送：双击 `inject`，取消「立即执行」，在「重复」中选择周期性执行并填写间隔。
- 等待设备回复：参考[请求与应答](/guide/automation/flows#请求与应答)，用 `serial request` 按 `OK` / `ERROR` 分支。
- 查看节点参数：参考[节点与端口](/guide/automation/nodes)。

## 常见问题

**导入后串口节点显示端口未打开**：先在串口面板打开端口，再双击节点重新选择。端口关闭后节点无法写入。

**监视窗口有发送记录，但设备没有反应**：检查行尾。设备通常要求 CRLF 或 CR，行尾不匹配时不会应答。

**看不到画布**：内置 Node-RED 还在启动，等待 2–5 秒；仍无内容时重新点击工具栏图标。
