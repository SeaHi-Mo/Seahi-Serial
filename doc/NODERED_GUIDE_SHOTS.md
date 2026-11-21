# Node-RED 指南配图清单

`website/docs/guide/automation/` 下的三页与英文版已经使用 **14 张真实截图**（`website/docs/public/img/guide/automation-*.png`）。
本文记录每张图的取景口径，以及后续替换/补拍方式。

截图位分布：

| 页面 | 截图位 |
|---|---|
| `index.md`（概览 / 部署） | 1、7 |
| `nodes.md`（节点与端口） | 2、3、4、12、13 |
| `flows.md`（常用流程） | 5、6、8、9、10、11，以及请求应答流程图 |
| 可选补拍 | 14（端口未打开） |

## 怎么用

1. 截图存成 PNG，命名见下表，放到 `website/docs/public/img/guide/`。
2. 页面已经用 `<GuideMedia>` 引用了这些文件，**替换同名文件**即可更新，不需要改 Markdown。
3. 英文页引用同一批文件，替换后同时生效。
4. `npm run docs:dev` 预览，`npm run docs:build` 验证。

## 拍摄口径

- 只截**功能本身**，不要带无关的窗口边缘；画布截图保留节点与连线即可。
- 深色主题拍一套即可，不要混用深浅色（同一页出现两种背景很跳）。
- 打码：MAC、访问令牌、内网地址、真实设备序列号。
- 建议宽度 1200–1600 px，PNG，单张控制在 300 KB 以内（VitePress 不会压缩）。

## 清单

| # | 文件名 | 画面内容 | 说明要点 |
|---|---|---|---|
| 1 | `automation-entry.png` | 工具栏上的自动化图标（箭头所指） | 点它打开画布，位于监视器下方 |
| 1b | `automation-open.png` | 打开后的画布（左侧调色板、中间画布） | 应用窗口与串口工具栏保留，不是独立窗口 |
| 2 | `automation-palette.png` | 调色板「串口」分组展开 | 四个节点名都要看清：`serial rxd` / `serial txd` / `serial request` / `cmd list` |
| 3 | `automation-port.png` | `serial txd` 对话框，端口字段选中已打开的端口 | 显示 `COM3 · 115200` 这种端口名与波特率；下拉展开画面不易截，字段值即可 |
| 4 | `automation-request.png` | `serial request` 对话框的结果分支编辑器 | 体现「一个条件一个输出口」 |
| 5 | `automation-inject.png` | `inject` 对话框，`payload` 与 `repeat` 已填 | 一个节点同时决定内容与间隔 |
| 6 | `automation-flow-send.png` | `inject` → `serial txd` 连好的两个节点 | 连线清晰，节点上能看到端口标签 |
| 7 | `automation-deploy.png` | 右上角「部署」按钮与部署成功提示 | 顺带说明"没部署只在编辑器里可见" |
| 8 | `automation-running.png` | 运行中的 `serial txd` 节点状态 | 绿色小圆点 + 「已发 N B」 |
| 9 | `automation-rxd.png` | `serial rxd` 对话框 | 端口 / 格式 / 轮询间隔三项 |
| 10 | `automation-switch.png` | `switch` 对话框，`property = payload` + 包含规则 | 规则里填的是应答里的关键字 |
| 11 | `automation-flow-recv.png` | `serial rxd` → `switch` → 两个 `serial txd` | 完整的分支流程 |
| 12 | `automation-cmdlist.png` | `cmd list` 对话框，指令字段已选中条目 | 灰色分组标题 + 组内条目；下拉展开不易截，字段值即可 |
| 13 | `automation-quickcmds.png` | 串口面板的快捷指令侧栏 | 说明这是 `cmd list` 的数据来源 |
| 14 | `automation-noport.png` | 端口未打开时节点下方的红色状态 | 文案是「COM17 没有打开」或「没有可用的串口」 |

## 拍不出第 14 张时

端口没打开时节点状态只有一行小字，单独截很难看。可以改拍「端口下拉里显示灰色『当前没有已打开的串口』」——
那个画面信息量更大，也正好解释"为什么发不出去"。改图只动文档，不涉及程序代码。

## 补图之后

- 英文页的 `caption` 要跟着改（三页各一份，中英不是自动同步的）
- 新增或改名素材时，同步改本表
- 侧边栏已收录三页；新增自动化页面时要同步 `website/docs/.vitepress/locales/{zh-CN,en-US}.ts`
