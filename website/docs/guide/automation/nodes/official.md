# 官方节点

除四个串口节点外，调色板里还有 Node-RED 自带的节点，按用途分为通用、功能、序列、解析四类。它们的行为与官方版本一致，这一页只做索引，每个节点的作用、属性与常见用途见各自的页面。

随安装包分发时已裁掉「网络」与「存储」两类节点，画布上不会出现 HTTP、MQTT、文件读写等功能。

## 通用

处理消息的触发、显示、事件与流程组织。

| 节点 | 作用 |
|---|---|
| [inject](/guide/automation/nodes/official/inject) | 生成一条消息，可手动、定时或启动时触发 |
| [debug](/guide/automation/nodes/official/debug) | 把消息显示在调试面板 |
| [complete](/guide/automation/nodes/official/complete) | 某个节点处理完成时触发 |
| [catch](/guide/automation/nodes/official/catch) | 捕获流程内节点抛出的错误 |
| [status](/guide/automation/nodes/official/status) | 把节点的状态消息变成消息 |
| [link in](/guide/automation/nodes/official/link-in) | 接收同名 `link out` 投递的消息 |
| [link out](/guide/automation/nodes/official/link-out) | 把消息投递给同名 `link in` |
| [link call](/guide/automation/nodes/official/link-call) | 调用另一处流程并取回结果 |
| [comment](/guide/automation/nodes/official/comment) | 画布注释，不参与运行 |
| [global-config](/guide/automation/nodes/official/global-config) | 全局配置节点 |

## 功能

处理消息内容与控制执行节奏。

| 节点 | 作用 |
|---|---|
| [function](/guide/automation/nodes/official/function) | 用 JavaScript 处理消息 |
| [switch](/guide/automation/nodes/official/switch) | 按属性值分流到多个输出 |
| [change](/guide/automation/nodes/official/change) | 修改、删除或移动消息属性 |
| [range](/guide/automation/nodes/official/range) | 把数值映射到另一区间 |
| [template](/guide/automation/nodes/official/template) | 用模板生成文本 |
| [delay](/guide/automation/nodes/official/delay) | 延迟发送或限制速率 |
| [trigger](/guide/automation/nodes/official/trigger) | 延时发出或等条件满足再发 |
| [exec](/guide/automation/nodes/official/exec) | 运行系统命令并输出结果 |
| [rbe](/guide/automation/nodes/official/rbe) | 值变化时才通过 |

## 序列

处理一批消息，而不是单条。

| 节点 | 作用 |
|---|---|
| [split](/guide/automation/nodes/official/split) | 把一条消息拆成多条 |
| [join](/guide/automation/nodes/official/join) | 把多条消息合并成一条 |
| [sort](/guide/automation/nodes/official/sort) | 按属性排序消息序列 |
| [batch](/guide/automation/nodes/official/batch) | 按条数或时间窗分组 |

## 解析

在文本与数据结构之间转换。

| 节点 | 作用 |
|---|---|
| [csv](/guide/automation/nodes/official/csv) | 解析或生成 CSV |
| [json](/guide/automation/nodes/official/json) | JSON 字符串与对象互转 |
| [xml](/guide/automation/nodes/official/xml) | XML 与对象互转 |
| [yaml](/guide/automation/nodes/official/yaml) | YAML 与对象互转 |
| [html](/guide/automation/nodes/official/html) | 提取或生成 HTML |

## 选择建议

1. 只是按间隔或手动发一次，用 `inject`；
2. 要按内容走不同分支，用 `switch`，需要改写内容再加 `change`；
3. 收到的内容需要拼接或计算，用 `function` 或 `template`。

需要"发一条并确认回复"时不用组合 `inject` 与 `debug`，直接用串口节点里的 [serial request](/guide/automation/nodes/serial-request)。
