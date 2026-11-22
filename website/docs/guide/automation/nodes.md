# 节点说明

串口相关的节点位于调色板的「串口」分组，共四个。发送、接收、请求应答各一个，另有一个读取快捷指令面板的节点。

| 节点 | 作用 |
|---|---|
| [serial txd](/guide/automation/nodes/serial-txd) | 向端口发送数据 |
| [serial rxd](/guide/automation/nodes/serial-rxd) | 接收端口数据 |
| [serial request](/guide/automation/nodes/serial-request) | 发送一条并收取应答 |
| [cmd list](/guide/automation/nodes/cmd-list) | 发送快捷指令面板中的条目 |

调色板里还有 Node-RED 自带的节点，按通用、功能、序列、解析四类列在[官方节点](/guide/automation/nodes/official)，用它们配合串口节点完成判断、改写与延时。

双击节点打开属性面板。四个节点的面板结构相同：上方是名称与端口，中间是数据格式与行尾，下方是节点自己的参数。

端口下拉只列出当前已打开的串口，显示为 `COM3 · 115200`。新节点默认选中第一个可用端口；端口关闭后节点状态会说明具体原因。
