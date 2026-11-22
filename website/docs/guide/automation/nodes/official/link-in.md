# link in

## 作用

接收同名 `link out` 投递过来的消息，作为该处流程的输入。节点本身不生成消息。

## 属性设置

| 参数 | 设置方法 |
|---|---|
| 链接名称 | 与来源 `link out` 填同一个名称 |
| 作用域 | 与来源保持一致 |

## 常见用途

| 场景 | 做法 |
|---|---|
| 接收跨屏消息 | 在另一处流程开头放一个，接上后续处理 |
| 多处复用同一路数据 | 同一名称放多个 `link in`，各自独立处理 |

## 注意

名称拼错不会报错，消息只是投递不到任何地方。改名时两端要一起改。

配套节点：[link out](/guide/automation/nodes/official/link-out)、[link call](/guide/automation/nodes/official/link-call)
