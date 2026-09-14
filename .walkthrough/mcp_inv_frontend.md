# Seahi Serial 前端交互控件全量盘点（给架构师）

- 目标文件：`src/index.html`（10,610 行；`<style>` 1–2101，body HTML 2105–2276，`<script>` 2277–10608）
- 分析方式：**逐段通读全文**（1–10610 行），再用脚本对全文做标签级/属性级统计。统计同时覆盖「静态 HTML」与「JS 拼出来的 HTML 字符串」，因此动态渲染的控件也在册。
- 统计脚本（本次新增，可复跑）：
  - `.walkthrough/_tmp_scan.js` → 控件分类/属性统计
  - `.walkthrough/_tmp_scan2.js` → id 字面量 vs 模板、事件站点行号、createElement
  - `.walkthrough/_tmp_scan3.js` → 选择器强度分级
- 通用术语：`{mid}` ∈ `{main, extra-1..N, wsl, wsl-x1..N, ble-mon}`（`monitors` 的 key，见 `createMonitorPane` 2491 / `addWslMonitor` 4021 / `toggleBleMonitor` 3991）。
- 性质图例：**读**=只读状态/枚举设备；**改**=只改前端状态（含持久化）；**副作用**=连设备 / 发数据 / 写文件 / 提权。

---

## 1. 页面（面板）结构与切换机制

### 1.1 顶层面板：4 个常驻 DOM 的兄弟容器

| 面板 | 容器 | 初始 | 首次打开时构建 DOM 的标记 |
|---|---|---|---|
| 串口（主） | `#paneContainer`（`.pane-container`） | `display:flex` | 启动即由 `createMonitorPane('main',…)` 建 `#pane-main`（10297） |
| WSL | `#wsl-pane` | `display:none` | `wslPane._initialized`（6037） |
| ADB | `#adb-pane` | `display:none` | `adbPane._initialized`（9392） |
| 蓝牙 | `#ble-pane` | `display:none` | `blePane._initialized`（7562） |

这 4 行就是全部「页面」。`#paneContainer` 内部再放多个 `.monitor-pane`：`#pane-main`、`#pane-extra-N`、`#pane-wsl`、`#pane-wsl-xN`、`#pane-ble-mon`（后者创建后被 `appendChild` 搬进蓝牙页右侧，4004–4008）。

### 1.2 切换函数与切换时做了什么

| 切换动作 | 函数（行号） | 做了什么 |
|---|---|---|
| 串口 → WSL | `openWslMapping()` 5987 | 4 个容器 `style.display` 互斥设置；`refreshMonitorPollRates()`；**重绑顶栏 4 个按钮的 `title`/`onclick`/`active`**；建 5s 设备列表定时器；首次构建 WSL 面板 HTML（含 `initWslMonitor`、`initWslMonResize`）；另起 `invoke('load_config')` 恢复 WSL 段配置；注册 `wsl-status-changed` 监听 |
| WSL → 串口 | `restoreMonitorPane()` 6736 | 注销 `wsl-status-changed`、清设备列表定时器；**`snapshotWslSettings(wmid)` 快照每个 WSL 监视器**并 `stopReading`；切 display；`refreshMonitorPollRates()`；恢复顶栏按钮 |
| 串口 → ADB | `openAdb()` 9357 | 切 display；`refreshMonitorPollRates()`；重绑顶栏按钮；首次构建 ADB 面板 HTML；`refreshAdbDevices()`；`setAllAdbPollRate(120)`；5s 设备轮询；**禁用 `#addMonitorBtn`** |
| ADB → 串口 | `closeAdb()` 9421 | 切 display；`setAllAdbPollRate(2000)`；清轮询；恢复 `#addMonitorBtn` |
| 串口 → 蓝牙 | `openBle()` 7541 | 切 display；`refreshMonitorPollRates()`；重绑顶栏按钮；`updateBleMonBtn()`；首次构建蓝牙面板 HTML（主机+从机两套）；恢复过滤框/扫描时长/内嵌监视器；`renderBlePfForm()`+`setBleMode()`；`ble_get_adapters` → `syncBleConnection()` → `refreshBleDevices()` |
| 蓝牙 → 串口 | `closeBle()` 8098 | 切 display；`refreshMonitorPollRates()`；恢复 `#addMonitorBtn`；`stopBlePeriphPoll()`（**不断开 BLE 连接、不停广播**） |
| 任意页 → 串口（点应用图标） | `goMain()` 9445 | 按 `style.display` 判断当前页，分派到上面 3 个 close/restore |

**关键结论：没有任何路由/状态变量记录"当前在哪一页"** —— 当前页只能从 `#xxx-pane` 的 `style.display` 反推。监视器的"可见性"同理，由 `monitorHostId(mid)`（3696）映射到宿主容器 id，再 `monitorVisible()`（3702）/`monitorPollMs()`（3709）/`refreshMonitorPollRates()`（3713）按可见性把读轮询从 25ms 降到 500ms。**页面本身不记录到配置文件**（`collectConfig` 不存当前页）。

### 1.3 全部可切换"视图"（含子视图/抽屉/模态框）

| 类别 | 视图 | 容器 / 选择器 | 切换函数（行号） | 是否落状态 |
|---|---|---|---|---|
| 顶层 | 串口面板 | `#paneContainer` | `restoreMonitorPane`/`closeAdb`/`closeBle`/`goMain` | ❌ |
| 顶层 | WSL 面板 | `#wsl-pane` | `openWslMapping` / `restoreMonitorPane` | ❌ |
| 顶层 | ADB 面板 | `#adb-pane` | `openAdb` / `closeAdb` | ❌ |
| 顶层 | 蓝牙面板 | `#ble-pane` | `openBle` / `closeBle` | ❌ |
| 子视图 | 高级设置行 | `#{mid}-advRow.vis` | `toggleAdv(mid)` 3045 | ✅ `advOpen` |
| 子视图 | 自动化工作流面板 | `#{mid}-advWf.vis` + `.has-rules` | 跟随 advRow；`renderWorkflowList` 5066 | ✅（规则本体） |
| 子视图 | 工具栏折叠 | `#{mid}-tbWrap.collapsed` | `toggleToolbarCollapse(mid)` 3058 | ❌ |
| 子视图 | 终端模式 | `#{mid}-termCurrent.show`（+隐藏 `#{mid}-sendBar`） | `toggleTerminalMode(btn,mid)` 3487 | ❌（`btnSendLE` 被强制复位，5581） |
| 子视图 | 内嵌串口监视器（蓝牙页右侧） | `#ble-monitorArea.active` | `toggleBleMonitor()` 3991 / `closeMonitor` | ✅ `ble.monitor` |
| 子视图 | BLE 主机 / 从机模式 | `#bleBody` vs `#blePeriph.active` | `setBleMode(mode)` 8827 | ✅ `ble.mode` |
| 子视图 | WSL 设备区/监视器区高度 | `#main-wslMonResize` 拖拽 | `initWslMonResize` 6575 | ✅ `panelHeight` |
| 子视图 | 蓝牙内嵌监视器宽度 | `#ble-monResize` 拖拽 | `initBleMonResize` 3883 | ✅ `monitorWidth` |
| 抽屉/下拉 | 通用下拉 | `.sel-drop.open` | `toggleSelDrop` 2855 / 全局 document click 关闭 2831 | ❌ |
| 抽屉 | 波特率下拉 | `.baud-dropdown.open` | `toggleBaudDropdown` 2778 | ❌ |
| 抽屉 | 发送历史 | `.send-hist.open` | `showSendHistory` 4140 | ❌ |
| 抽屉 | 文本/HEX | `.send-as-drop.open` | `toggleSendAsDrop` 2894 | ❌ |
| 分栏 | 快速指令分栏（只占输出区高度） | `.qcmd-side.open`（默认折叠） | `toggleQcmdSide` 6093 / `setQcmdSideOpen` 6084 | ❌（不持久化，每次折叠开始） |
| 抽屉 | 主题风格 | `#themeStyleDrop.open` | `toggleThemeStyleDrop` 5709 | ❌ |
| 抽屉 | 终端 TAB 补全 | `.term-comp.open` | `completeTermTab` 3387 / `showTermComp` 3437 / `hideTermComp` 3468 | ❌ |
| 抽屉 | 设备过滤区 | `#ble-filterBody`（display 切换） | `toggleBleFilter` 8084 | ✅ `filterOpen` |
| 抽屉 | 广播内容展开体 | `.ble-adv-body` | `toggleBleAdv` 8485 | ✅ `advOpen` |
| 抽屉 | GATT 服务特征展开 | `.ble-charGroup`（动态插入） | `toggleBleService` 8496 | ✅ `openSvcs` |
| 模态 | BLE 写入弹窗 | `#bleWriteModal.show` | `openBleWriteModal` 7227 / `closeBleWriteModal` 7291 | ❌ |
| 模态 | BLE 配对弹窗 | `#blePairModal.show` | `showBlePairDialog` 7326 / `submitBlePair` 7350 | ❌ |
| 模态 | WSL 提权授权窗 | `#wsl-map-approval-overlay`（运行时建） | `showWslMapApproval` 9975 | ❌ |
| 模态 | 首次引导 + 导航条 | `#onboarding-overlay.show` + `#onboard-nav` | `showOnboarding` 10473 / `goStep` 10495 / `nextStep` 10572 / `closeOnboarding` 10580 | ✅ 只落 `localStorage.onboarding_done` |
| 模态 | 启动兜底页 | `#bootError`（display） | `showFatalError` 2327 / 隐藏于 10299 | ❌ |
| 浮层 | Toast | `.toast.show` | `showToast` 2471 | ❌ |
| 浮层 | 自定义 tooltip | `.custom-tip.show` | IIFE 内 `mouseover`/`mouseout` 10244/10281 | ❌ |

---

## 2. 控件全量清单（按面板分组）

> 说明：
> - 「选择器」列给出**当前源码里可用的最稳定选择器**。`{mid}` 需替换为 `main` / `extra-N` / `wsl` / `wsl-xN` / `ble-mon`。
> - 同一模板在 5 类监视器里复用（串口/WSL/蓝牙内嵌），此时只列一次并标注「模板」。
> - 行号指该控件被创建/绑定的位置。

### 2.1 全局标题栏（`#globalBar`，静态 HTML 2118–2169）

| # | 类型 | 选择器 | 用途 | 触发 | 性质 | disabled 条件 |
|---|---|---|---|---|---|---|
| G1 | span(div 式) | `#appInfoWrap` | 回主界面（点图标） | `goMain()` 9445 | 改 | 无 |
| G2 | span | `#addMonitorBtn` | 打开额外监视器／蓝牙页为"开关"语义 | `addMonitor()` 3842 | 副作用（新建面板、可能改窗口宽） | 由各页设 `pointerEvents:none`+`opacity .4`（ADB 页 9414、WSL 未运行 6030） |
| G3 | span | `#wslToggleBtn` | 进/出 WSL 页（`onclick` 被换绑） | `openWslMapping()` / `restoreMonitorPane()` | 改 | 无 |
| G4 | span | `#adbToggleBtn` | 进/出 ADB 页（`onclick` 被换绑） | `openAdb()` / `closeAdb()` | 改 | 无 |
| G5 | span | `#bleToggleBtn` | 进/出蓝牙页（`onclick` 被换绑） | `openBle()` / `closeBle()` | 改 | 无 |
| G6 | span.sel | `#themeStyleWrap` | 展开主题风格下拉 | `toggleThemeStyleDrop(event)` 5709 | 改 | 无 |
| G7 | div.sel-opt ×6 | `#themeStyleDrop .sel-opt[data-style="…"]` | 选 6 种风格 | `selectThemeStyle(style)` 5715 | 改+持久化 | 无 |
| G8 | span.issue-btn | `.issue-btn`（无 id） | 打开 GitHub issue | 内联 `invoke('open_url',…)` 2150 | 副作用（开浏览器） | 无 |
| G9 | span.update-btn | `#updateBtn` | 下载并安装更新 | `downloadAndInstallUpdate()` 5316 | 副作用（下载/装机） | 显示由 `checkForUpdate` 控制；下载中加 `.disabled` 类（5319） |
| G10 | span.theme-switch | `#themeSwitch` | 深/浅色切换 | `toggleTheme()` 5704 | 改+持久化 | 无 |
| G11 | button.win-ctrl-btn | `.win-ctrl` > `button:nth-child(1)`（无 id） | 最小化 | `winMinimize()` 10215 | 副作用（窗口） | 无 |
| G12 | button | `#winMaxBtn` | 最大化/还原 | `winToggleMaximize()` 10216 | 副作用 | 无 |
| G13 | button.win-ctrl-btn.close | `.win-ctrl-btn.close`（无 id） | 关闭应用 | `winClose()` 10217 | 副作用 | 无 |

### 2.2 启动兜底页（`#bootError`，2108–2115）

| # | 类型 | 选择器 | 用途 | 触发 | 性质 | disabled |
|---|---|---|---|---|---|---|
| B1 | button | `#bootError .boot-error-btn`（第 1 个，无 id） | 重新加载 | 内联 `location.reload()` | 副作用 | 无 |
| B2 | button | `#bootError .boot-error-btn-danger`（无 id） | 退出应用 | `bootErrorExit()` 2344 | 副作用 | 无 |

### 2.3 串口监视器面板（`createMonitorPane` 2491–2775 模板；WSL 监视器 `getWslMonitorHtml` 5862 同构）

| # | 类型 | 选择器 | 用途 | 触发 | 性质 | disabled 条件 |
|---|---|---|---|---|---|---|
| M1 | button.pane-close | `#pane-{mid} .pane-header .pane-close`（无 id，仅 `closable` 时存在） | 关闭该监视器 | `closeMonitor(mid)` 4078 | 副作用（释放串口） | 无 |
| M2 | div.sel | `#{mid}-viewMode` | 展开 文本/HEX 选择 | `toggleSelDrop(this)` 2855 | 改 | 无 |
| M3 | div.sel-opt ×2 | `#{mid}-viewMode .sel-opt[data-val="text"|"hex"]` | 选视图模式 | `setSel(this,val,event)` 2872 | 改+持久化 | 无 |
| M4 | div.sel | `#{mid}-portSelect` | 展开端口列表 | `toggleSelDrop(this)` | 改 | 连接中/等待接入 `ps.disabled=true`（3647/3653） |
| M5 | div.sel-opt（动态） | `#{mid}-portDrop .sel-opt[data-val="COM3"]` | 选端口 | `opt.onclick`→`setPortSel(mid,port,el)` 2944 | **副作用**（已连接时切端口=断开重连，`switchMonitorPort` 3007） | 被占用端口 `pointerEvents:none`+`opacity .45`（2941） |
| M6 | button.btn-ref | `#pane-{mid} .toolbar .btn-ref`（无 id） | 刷新端口列表 | `refreshPorts(mid)` 2909 | 读（枚举 COM） | 无 |
| M7 | input[number] | `#{mid}-baudRate` | 波特率 | `change`→`scheduleConfigSave()` 2764 | 改+持久化 | 无 |
| M8 | button.baud-arrow | `#pane-{mid} .baud-arrow`（无 id） | 展开波特率下拉 | `toggleBaudDropdown(event,mid)` 2778 | 改 | 无 |
| M9 | div.baud-opt ×33 | `#{mid}-baudDropdown .baud-opt` | 选波特率（50…4000000） | `setBaud(mid,v)` 2782 | **副作用**（已连接时自动重连） | 无 |
| M10 | div.sel | `#{mid}-lineEnding` | 展开行尾选择 | `toggleSelDrop` | 改 | 无 |
| M11 | div.sel-opt ×4 | `#{mid}-lineEnding .sel-opt[data-val=crlf/lf/cr/none]` | 行尾 | `setSel` 2872 → 已连接时额外 `invoke('update_workflow_line_ending')` 2888 | 改+小副作用 | 无 |
| M12 | button.btn-main | `#{mid}-btnStart` | 开始/停止监控 | `toggleConnection(mid)` 3569 | **副作用**（开/关串口） | 连接中/断开中/切换中 `disabled=true`（2799/3013/3584/3618）；等待接入时 disabled（3651） |
| M13 | button.ibtn | `#pane-{mid} .ibtn-group` 第 1 个（**无 id**） | 清除输出 | `clearLog(mid)` 4475 | 改 | 无 |
| M14 | button.ibtn | `#{mid}-btnScroll` | 自动滚动开关 | `toggleIbtn(this)` 3100 | 改+持久化 | 无 |
| M15 | button.ibtn | `#{mid}-btnAutoReconnect` | 自动重连开关 | `toggleIbtn(this)` | 改+持久化 | 无 |
| M16 | button.ibtn | `#{mid}-btnSendLE` | 终端模式 | `toggleTerminalMode(this,mid)` 3487 | 改 | 无 |
| M17 | button.ibtn | `#{mid}-btnLineNum` | 行号 | `toggleLineNum(this,mid)` 3103 | 改+持久化 | 无 |
| M18 | button.ibtn | `#{mid}-btnTs` | 时间戳 | `toggleIbtn(this)` | 改+持久化 | 无 |
| M19 | button.ibtn | `#{mid}-btnEcho` | 启动消息回显 | `toggleIbtn(this)` | 改+持久化 | 无 |
| M20 | button.ibtn | `#{mid}-btnAdv` | 更多设置 | `toggleAdv(mid)` 3045 | 改+持久化 | 无 |
| M21 | div.sel | `#{mid}-dataBits` + 4 `.sel-opt[data-val=5/6/7/8]` | 数据位 | `toggleSelDrop`/`setSel` | 改（下次连接生效） | 无 |
| M22 | div.sel | `#{mid}-stopBits` + 2 opts | 停止位 | 同上 | 改 | 无 |
| M23 | div.sel | `#{mid}-parity` + 3 opts | 校验位 | 同上 | 改 | 无 |
| M24 | input[checkbox] | `#{mid}-chkDTR` | DTR 电平 | `toggleDTR(mid,checked)` 3528 | **副作用**（下发后端，100ms 防抖） | 无 `disabled`；未连接时函数内 `return`（3529） |
| M25 | input[checkbox] | `#{mid}-chkRTS` | RTS 电平 | `toggleRTS(mid,checked)` 3537 | **副作用**（同上） | 同上 |
| M26 | button.btn-logdir | `#pane-{mid} .btn-logdir`（无 id） | 选择日志目录 | `chooseLogDir(mid)` 4166 | **副作用**（原生目录对话框） | 无 |
| M27 | button.ibtn | adv-row 内 `saveLogToFile`（**无 id**） | 保存日志到文件 | `saveLogToFile(mid)` 4177 | **副作用**（写文件） | 无 |
| M28 | button.ibtn | adv-row 内 `copyOutput`（**无 id**） | 复制全部 | `copyOutput(mid)` 4185 | 读（写剪贴板） | 无 |
| M29 | button.ibtn | `#{mid}-btnCollapseTb` | 折叠工具栏 | `toggleToolbarCollapse(mid)` 3058 | 改（含 mouseenter/leave 自动展开） | 无 |
| M30 | button.wf-add-btn | `#pane-{mid} .adv-row .wf-add-btn`（无 id） | 新增工作流规则 | `addWorkflowRule(mid)` 4930 | 改+持久化 | 无 |
| M31 | div[contenteditable] | `#{mid}-output` | 日志区，可编辑/选中 | 无 onclick；`focus/blur/mouseleave/mousedown/mouseup/scroll` 监听 2643–2696 | 改（手工编辑日志） | 无 |
| M32 | input.term-in（JS 建） | `#{mid}-termInput`（3153） | 终端输入行 | `keydown` 3175：Enter 发送、Tab 补全、Esc | **副作用**（`send_data`/`send_wsl_serial`） | 仅终端模式可见 |
| M33 | div.term-comp-item（动态） | `#{mid}-termComp .term-comp-item` | TAB 补全候选 | `mousedown` 3448 | 改 | 无 |
| M34 | input.send-inp | `#{mid}-sendInput` | 发送内容 | `keydown` 2707：Enter→`sendData`；↑↓ 历史；Esc | **副作用**（发送） | 无 |
| M35 | div.send-hist-item（动态） | `#{mid}-sendHist .send-hist-item` | 历史填充 | `click` 4149 | 改 | 无 |
| M36 | div.send-as | `#{mid}-sendAs` | 展开 文本/HEX | `toggleSendAsDrop(mid)` 2894 | 改 | 无 |
| M37 | div.send-as-opt ×2 | `#{mid}-sendAsDrop .send-as-opt[data-val=text/hex]` | 选发送格式 | `setSendAs(mid,val,this,event)` 2897 | 改+持久化 | 无 |
| M38 | button.btn-send | `#{mid}-btnSend` | 发送 | `sendData(mid)` 4108 | **副作用**（发送） | 模板里写死 `disabled`，由 `updateMonitorUI` 3637 切换 |
| M39 | button.qcmd-side-tab | `#{mid}-btnQcmdSide` | 展开/收起快速指令分栏；**展开后**拖动它调宽（折叠态不启用拖动，光标 pointer；展开态 col-resize）。循环发送进行中时这里会点一颗一闪一闪的小点（`.qcmd-side-tab.loop`） | `toggleQcmdSide(mid)` / `startQcmdSideDrag`+`onQcmdSideDragMove`+`endQcmdSideDrag` | 改+持久化（宽度 `qcmdSideWidth`；展开态本身不持久化） | 无 |
| M40 | button.qcmd-dh-add | `#{mid}-qcmdSide .qcmd-dh-add`（无 id） | 添加指令行 | `addQcmdItem(mid)` | 改+持久化 | 无 |
| M41 | button.qcmd-dh-loop | `#{mid}-btnQcmdLoop` | **开/关循环发送**（按顺序号从小到大依次发，发完一条等它自己的延时再发下一条） | `toggleQcmdLoop(mid)` → `setQcmdLoop` / `stopQcmdLoop` | **副作用**（会持续发数据）+改 | 未连串口 / 没有顺序号 > 0 的条目时函数内拒绝并 toast；掉线或列表空了则自愈停止 |
| M41a | input.qcmd-item-seq（JS 建） | `#{mid}-qcmdi-{i}-seq` | **循环发送顺序号**：0 = 不参与；>0 参与，按数字升序发 | `input`（只收数字，去前导零） | 改+持久化 | 无 |
| M41b | input.qcmd-item-delay（JS 建） | `#{mid}-qcmdi-{i}-delay` | **延时发送时间(ms)**：本条发完到下发一条的间隔，默认 1000 | `input`（只收数字）+ `change`（规范化：空→1000，超 600000 夹住） | 改+持久化 | 无 |
| M41c | button.qcmd-item-hex（JS 建） | `#{mid}-qcmdi-{i}-hex` | **本条的 HEX 使能**（默认关，与主发送栏的文本/HEX 无关） | `click` | 改+持久化 | 无 |
| M42 | input.qcmd-item-val（JS 建） | `#{mid}-qcmdi-{i} .qcmd-item-val` | 指令内容 | `input`；`keydown` Enter→发送 | **副作用**（Enter 即发）；发送格式取本条自己的 HEX 开关 | 无 |
| M43 | button.qcmd-item-send（JS 建） | `#{mid}-qcmdList [data-qsend]` | 发送该指令 | `click` 4830→`sendQcmdItem` 4890 | **副作用** | `!isConnected` → `disabled`（4828、`updateQcmdSendBtns` 4918） |
| M44 | button.qcmd-item-del（JS 建） | `#{mid}-qcmdList .qcmd-item-del` | 删除指令 | `click`→`removeQcmdItem` | 改+持久化 | 无 |

> 快速指令一栏的近期变更（与 `.walkthrough/gen_ble_preview.js` 的断言一一对应）：
> ① 指令名称输入框 `input.qcmd-item-label` **已删除** —— `label` 字段仍在数据与外部文件里原样保留/写回，
>    只是界面上不再有入口；② 标题文字「快速指令」（`.qcmd-hd-title`）已删除，标题行只剩控件；
> ③ 每条现在是**一行六格**：顺序号 · 内容 · 延时 · HEX · 发送 · 删除；④ 新增「循环发送」开关
>    （`#{mid}-btnQcmdLoop`，在「＋ 添加」左侧）。以上四项都随 `config.json` 的 `quickCmds` 持久化，
>    **循环发送的开关状态不持久化**（开机自动发指令太危险）。
| M45 | input[checkbox] | `#{mid}-wfList input[name="wf-enabled"]` | 启用/禁用规则 | `onchange`→`toggleWorkflowEnabled` 4958 | 改+持久化 | 无 |
| M46 | input[text] | `#{mid}-wfList input[name="wf-rule-name"]` | 规则重命名 | `onchange`→`renameWorkflowRule` 4963 | 改+持久化 | 无 |
| M47 | button.wf-run-btn | `#{mid}-wfRule-{ruleId} .wf-run-btn` | 运行/停止规则 | `toggleWorkflowRun` 5033 | **副作用**（后端跑规则） | 无 |
| M48 | button.wf-rule-arrow | `.wf-rule-arrow` | 折叠规则卡 | `toggleWfRuleCollapse` 4968 | 改+持久化 | 无 |
| M49 | button.wf-rule-btn.del | `.wf-rule-btn.del` | 删除规则 | `deleteWorkflowRule` 4951 | 改+持久化 | 无 |
| M50 | div.sel + 3 opts | 条件行 `.sel`（无 id） | 条件类型（字符串包含/正则/精确字节） | `setWfCondType` 5192 | 改+持久化 | 无 |
| M51 | input[text] | `input[name="wf-cond-value"]` | 条件值 | `oninput`→`updateWfCondition` 4984 | 改+持久化 | 无 |
| M52 | button.wf-row-btn | 条件行 `+` / `×`（无 id） | 加/删条件 | `addWfCondition` 4989 / `removeWfCondition` 4997 | 改+持久化 | 删到只剩 1 条时函数内拒绝（4999） |
| M53 | div.sel + 3 opts | 动作行 `.sel` | 动作类型（发送数据/切换信号/保存日志） | `setWfActType` 5202 | 改+持久化 | 无 |
| M54 | div.sel ×2 | 动作行（send_data 的编码 / toggle_dtr_rts 的信号与电平） | 编码/信号/电平 | `setWfActEnc` 5217 / `setWfActSig` 5223 / `setWfActLvl` 5229 | 改+持久化 | 无 |
| M55 | input[text] | `input[name="wf-act-data"]` | 动作数据 | `oninput`→`updateWfAction` 5005 | 改+持久化 | 无 |
| M56 | input[number] | `input[name="wf-act-delay"]` | 动作前延时(ms) | `oninput`→`updateWfAction` | 改+持久化 | 无 |
| M57 | button.wf-row-btn / .wf-row-btn.del | 动作行 `+ 添加动作` / `×`（无 id） | 加/删动作 | `addWfAction` 5010 / `removeWfAction` 5018 | 改+持久化 | 删到只剩 1 条时拒绝（5020） |
| M58 | button.qcmd-dh-add（导入） | `#{mid}-btnQcmdImport` | 从文件加载指令列表（原生文件框；**加载后增删改都写回该文件**） | `qcmdImportFile(mid)` | 改+挂载 | 无（文件框需人工选） |
| M59 | button.qcmd-dh-add（导出） | `#{mid}-btnQcmdExport` | 把当前列表另存为一份文件（对话框；不改变当前挂载目标） | `qcmdExportFile(mid)` | 只写副本 | 无（文件框需人工选） |
| M60 | button.qcmd-dh-add（重载） | `#{mid}-btnQcmdReload`（来源行，仅挂载后存在） | 从文件重新读取（文件被外部改过时用） | `qcmdReloadFile(mid,false)` | 改 | 仅挂载后存在 |
| M61 | button.qcmd-dh-add（断开） | `#{mid}-btnQcmdUnmount`（来源行，仅挂载后存在） | 不再写回文件（列表留在配置里） | `qcmdUnmountFile(mid)` | 改 | 仅挂载后存在 |

> **无 id 的高频重复控件**：M13（clearLog）、M6（刷新端口）、M8（波特率箭头）、M26/M27/M28、M30、M40、M50/M52/M53/M54/M57 —— 在每个监视器窗格里都出现一次，只能靠 `#pane-{mid} ` 前缀 + class/序号 定位。

### 2.4 WSL 面板（`#wsl-pane`）

| # | 类型 | 选择器 | 用途 | 触发 | 性质 | disabled |
|---|---|---|---|---|---|---|
| W1 | select | `#main-wslTargetDist` | 选映射目标发行版 | `onchange`→`setWslTargetDist(this.value)` 5840 | 改 | 无 |
| W2 | button（裸标签） | `#main-wslDistroList button:nth-child(1)`（**无 id/class**） | 打开 WSL 终端 | `openWslTerminal(name)` 6703 | **副作用**（启动发行版） | 未运行时带 `disabled` + `opacity .35`（6677） |
| W3 | button（裸标签） | `#main-wslDistroList button:nth-child(2)`（**无 id/class**） | 启动/关闭发行版 | `wslDistAction('launch_wsl'\|'shutdown_wsl', name)` 9699 | **副作用**（启停发行版） | 点击瞬间 disabled+转圈（9703） |
| W4 | div 拖拽条 | `#main-wslMonResize` | 调设备区/监视器区高度 | `mousedown`→`initWslMonResize('main')` 6575 | 改+持久化 | 无 |
| W5 | div 行 | `.wsl-device-row`（`[onclick="selectWslRow(...)"]`，无 id） | 选中设备行 | `selectWslRow(busid,event)` 9951 | 改 | 无 |
| W6 | input[checkbox] | `input[name="wsl-auto-map"]` | 自动映射开关（按 VID:PID） | `onchange`→`toggleAutoMap(vidpid,port,checked)` 10111 | 改+持久化 | 该设备 busy 时 `disabled`（9907/9931） |
| W7 | input[checkbox].wsl-checkbox | `input[name="wsl-map"]` | 映射/取消映射到 WSL | `onchange`→`toggleWslMapping(mid,idx,checked)` 10014 | **副作用**（usbipd attach/detach，可能提权） | busy 或 WSL 未运行 → `disabled`（9934） |
| W8 | button | `#wsl-map-approval-ok` | 授权并映射 | `settle(true)` 10008 | **副作用**（UAC 提权） | 60s 自动取消（10007） |
| W9 | button | `#wsl-map-approval-cancel` | 取消授权 | `settle(false)` 10009 | 改 | 无 |
| W10 | 监视器窗格 | `#pane-wsl` / `#pane-wsl-xN` | 同 2.3 全部模板控件（`{mid}`=`wsl`/`wsl-xN`） | 见 2.3 | — | 未运行 WSL 时整块 `.wsl-mon-disabled`（`pointer-events:none`）6508 |

> W2/W3 是**运行时拼出来的裸 `<button>`，既无 id 也无 class**，只能用 `#main-wslDistroList button` + 序号/文案定位。

### 2.5 ADB 面板（`#adb-pane`）

| # | 类型 | 选择器 | 用途 | 触发 | 性质 | disabled |
|---|---|---|---|---|---|---|
| A1 | button | `#adbRefreshDevBtn` | 重新扫描 ADB 设备 | `refreshAdbDevices()` 9469 | 读（`adb_devices`） | 无 |
| A2 | div 卡片 | `.adb-dev-card[data-serial="…"]` | 选设备并开会话 | `click` 9501 → `openAdbSession(serial)` 9580 | **副作用**（建 PTY shell） | 无 |
| A3 | xterm 终端 | `#adb-session-N-termBox`（xterm 自建字符层） | 键盘输入到 PTY | `term.onData` 9630 → `invoke('adb_shell_write')` | **副作用**（发 shell 命令） | 无 |

### 2.6 蓝牙面板 · 主机模式（`#bleBody`）

| # | 类型 | 选择器 | 用途 | 触发 | 性质 | disabled |
|---|---|---|---|---|---|---|
| L1 | button | `#bleScanBtn` | 开始/停止扫描 | `toggleBleScan()` 8113 | **副作用**（开无线电扫描） | 无（无适配器时提示不兼容 7717） |
| L2 | select | `#bleScanSecs` | 扫描自动停止时长 5/15/30/60/持续 | `onchange`→`onBleScanSecsChange()` 7753 | 改+持久化 | 无 |
| L3 | input[text] | `#bleDirectAddr` | 输入 MAC | `onkeydown` Enter → `connectBleDirect()` | **副作用**（直连） | 无 |
| L4 | button | `#bleDirectBtn` | 按 MAC 直连 | `connectBleDirect()` 7768 | **副作用**（连接设备） | 连接中 `disabled=true`（7778/7783） |
| L5 | span | `.ble-filter-toggle`（无 id） | 展开/收起过滤区 | `toggleBleFilter(this)` 8084 | 改+持久化 | 无 |
| L6 | input[text] | `#bleFilterText` | 过滤关键字（名称/MAC） | `oninput`→`applyBleFilter()` 8091 | 改+持久化 | 无 |
| L7 | div 卡片 | `.ble-dev-card[data-addr="…"]` | 选设备 | `click` 8304 | 改（清日志/关写入窗） | 无 |
| L8 | button | `#ble-detail .ble-connect-btn`（class 复合，无 id） | 连接/断开设备 | `toggleBleConnect()` 8614 | **副作用**（连接/断开，可能触发配对） | 连接中门闩 `_bleConnecting`（函数内 return） |
| L9 | div | `#ble-detail .ble-adv-toggle`（无 id） | 展开广播内容 | `toggleBleAdv(this)` 8485 | 改+持久化 | 无 |
| L10 | div | `#ble-detail .ble-svc[data-uuid="…"]` | 展开该服务的特征 | `toggleBleService(this)` 8496 | 改+持久化 | 无 |
| L11 | span | `.ble-ch-action[data-modes]`（无 id） | 特征 读/写/订阅 图标 | `bleCharAction(this,'uuid::prop')` 7058 | **副作用**（读/写/订阅） | 未连接时函数内 `return`（7060） |
| L12 | span | `.ble-desc-act`（无 id） | 描述符读/写 | `bleDescAction(event,charUuid,descUuid,op)` 7017 | **副作用** | 未连接时提示（7020） |
| L13 | span | `#ble-detail .ble-log-clear`（无 id） | 清空数据日志 | `clearBleLog()` 7134 | 改 | 无 |
| L14 | div 拖拽条 | `#ble-monResize` | 调内嵌监视器宽度 | `initBleMonResize()` 3883 | 改+持久化 | 无 |
| L15 | 内嵌监视器 | `#pane-ble-mon` | 同 2.3 全部模板控件（`{mid}`=`ble-mon`） | 见 2.3 | — | — |

### 2.7 蓝牙面板 · 从机模式（`#blePeriph`）⚠️ **当前不可达**

`BLE_PERIPH_MODE_ENABLED = false`（8680）→ `bleModeSegHtml()`（8819）返回空串 → **模式切换按钮不渲染**，`setBleMode('periph')` 会被折回 `'host'`（8830）。面板 DOM 仍在（`openBle` 的 innerHTML 无条件包含 `#blePeriph`），但**无法从 UI 进入**；下列控件当前是"死 UI"（除非把常量改成 `true`）。

| # | 类型 | 选择器 | 用途 | 触发 | 性质 | disabled |
|---|---|---|---|---|---|---|
| P0 | button ×2 | `.ble-mode-btn[data-ble-mode=host\|periph]` | 主机/从机切换 | `setBleMode(mode)` 8827 | 改+持久化 | **当前不渲染** |
| P1 | select | `#blePfPreset` | 内置预设（NUS/FFE0/自定义） | `blePfApplyPreset(this.value)` 8994 | 改+持久化 | 无 |
| P2 | button | `#blePfImportBtn` | 从 CSV/Markdown 表格导入 | `blePfImportTable()` 8040 | **副作用**（原生文件框+读文件） | 处理中 `disabled=true`（8042/8044） |
| P3 | button | `#blePfExportBtn` | 导出为 CSV | `blePfExportTable()` 8062 | **副作用**（写文件） | 同上（8064/8067） |
| P4 | select | `#blePfSaved` | 载入已保存配置 | `blePfLoadSaved(this.value)` 7932 | 改 | 无 |
| P5 | button | `#blePfSaved` 同级 `删除`（无 id） | 删除选中配置 | `blePfDeleteSaved()` 7941 | 改+持久化 | 无 |
| P6 | input[text] | `#blePfSavedName` | 配置名 | 无监听（读取于 `blePfSaveAs`） | 改 | 无 |
| P7 | button | `#blePfSavedName` 同级 `保存`（无 id） | 存为我的配置 | `blePfSaveAs()` 7918 | 改+持久化 | 无 |
| P8 | input[text] | `#blePfService` | 服务 UUID | `oninput`→`blePfSyncService(v)` 9006 | 改+持久化 | 无 |
| P9 | input[text] ×3/行 | `#blePfCharEditor input[data-ci][data-field=uuid\|value\|desc]` | 特征 UUID / 初值 / 描述符 | 容器委托 `input`→`blePfEditorInput` 8945 | 改+持久化 | 无 |
| P10 | span | `#blePfCharEditor .ble-pf-prop[data-ci][data-prop=…]` | 勾选特征属性（读/写/无响应写/通知/指示） | 容器委托 `click`→`blePfEditorClick` 8956 | 改+持久化 | 无 |
| P11 | button | `#blePfCharEditor [data-del="i"]` | 删除该特征 | 容器委托 `click`→`blePfEditorClick` | 改+持久化 | 无 |
| P12 | button | `.ble-pf-add`（`+ 添加特征`，无 id） | 添加特征 | `blePfAddChar()` 8984 | 改+持久化 | 达 16 个上限时函数内拒绝（8985） |
| P13 | input[checkbox] | `#blePfDiscoverable` | 可被发现 | 无监听（`blePfCollectOptions` 9012） | 改+持久化 | 无 |
| P14 | input[checkbox] | `#blePfConnectable` | 可连接 | 同上 | 改+持久化 | 无 |
| P15 | input[checkbox] | `#blePfManualReply` | 写入需手动应答 | 同上 | 改+持久化 | 无 |
| P16 | input[checkbox] | `#blePfAdvData` | 启用广播服务数据 | `onchange`→`blePfCollectOptions();renderBlePfAdvLen()` | 改+持久化 | 无 |
| P17 | input[text] | `#blePfAdvDataHex` | 广播服务数据 HEX | `oninput`→同上 | 改+持久化 | 无 |
| P18 | button | `#blePfStartBtn` | 开始/重新广播 | `startBlePeriph()` 9103 | **副作用**（建 GATT 服务+广播） | 启动中 `disabled=true`（9108/9138） |
| P19 | button | `#blePfStopBtn` | 停止广播 | `stopBlePeriph()` 9142 | **副作用** | 未运行时 `disabled`（9216，模板里初始 `disabled`） |
| P20 | span | `#blePfChars [data-act=set\|notify]` | 设值 / 下发通知 | 容器委托 `click` 8932→`blePeriphCharAction(uuid,kind)` 9312 | **副作用** | 不可读不生成 set；无订阅时不生成 notify（9233/9234） |
| P21 | button | `#blePfPending [data-reply][data-accept]` | 接受/拒绝挂起写请求 | 容器委托 `click`→`onBlePfPendingClick` 7897 | **副作用**（回协议应答） | 无 |
| P22 | span | `.ble-log-clear`（无 id） | 清空事件日志 | `clearBlePeriphLog()` 9306 | 改 | 无 |

### 2.8 模态框 / 引导（静态 DOM）

| # | 类型 | 选择器 | 用途 | 触发 | 性质 | disabled |
|---|---|---|---|---|---|---|
| D1 | div 遮罩 | `#bleWriteModal` | 点遮罩关闭 | `mousedown`→`bleWriteMaskPress` 7301；`click`→`bleWriteMaskClick` 7304 | 改 | 无 |
| D2 | textarea | `#bleWriteValue` | 写入内容 | `keydown` 7265：Enter 发送、Esc 关闭 | **副作用**（写 GATT） | 无 |
| D3 | div.send-as | `#bleWriteModeWrap` | 展开写入方式 | `toggleBleWriteMode()` 7273 | 改 | 由 `openBleWriteModal` 设整行 `display:none`（7256，仅一种模式时） |
| D4 | div.send-as-opt ×2 | `#bleWriteModeDrop [data-val=write\|write_without_response]` | 写响应/无响应 | `setBleWriteMode(val,this,event)` 7277 | 改 | 无 |
| D5 | div.send-as | `#bleWriteModal` 内"格式"（无 id） | 展开 文本/HEX | `toggleBleWriteAs()` 7366 | 改 | 无 |
| D6 | div.send-as-opt ×2 | `#bleWriteAsDrop [data-val=text\|hex]` | 选格式 | `setBleWriteAs(val,this,event)` 7370 | 改 | 无 |
| D7 | div.sel | `#bleWriteLineEnd` | 行尾 | `toggleSelDrop(this)` | 改 | 无 |
| D8 | div.sel-opt ×4 | `#bleWriteLineEnd .sel-opt[data-val=crlf\|lf\|cr\|none]` | 行尾取值 | `setSel(this,val,event)` | 改 | 无 |
| D9 | button.ble-modal-btn | `#bleWriteModal .ble-modal-foot button:nth-child(1)`（无 id） | 关闭 | `closeBleWriteModal()` 7291 | 改 | 无 |
| D10 | button.ble-modal-btn.primary | `#bleWriteSendBtn` | 发送 | `sendBleWrite()` 7422 | **副作用**（写特征/描述符/从机设值·下发） | 无 |
| D11 | input[text] | `#blePairInput` | 输入配对码（provide 类型） | 无监听（读于 `submitBlePair`） | 改 | provide 之外 `display:none`（7340） |
| D12 | button.ble-modal-btn | `#blePairModal .ble-modal-foot button:nth-child(1)`（无 id） | 取消配对 | `submitBlePair(false)` 7350 | **副作用**（回传后端） | 无 |
| D13 | button | `#blePairOk` | 确认配对 | `submitBlePair(true)` | **副作用** | 无 |
| D14 | span.onboard-skip | `.onboard-skip`（无 id） | 跳过引导 | `closeOnboarding()` 10580 | 改（写 localStorage） | 无 |
| D15 | button | `#onboard-next` | 下一步/开始使用 | `nextStep()` 10572 | 改 | 无 |
| D16 | div 遮罩 | `#onboarding-overlay` | 点空白关闭引导 | `overlay.onclick` 10487（JS 赋值） | 改 | 无 |

### 2.9 JS 运行时生成、源码里不是标签的控件

| 家族 | 生成处 | 选择器 | 绑定方式 |
|---|---|---|---|
| `.send-hist-item` | `showSendHistory` 4146 | `#{mid}-sendHist .send-hist-item` | `addEventListener('click')` 4149 |
| `.term-comp-item` | `showTermComp` 3445 | `#{mid}-termComp .term-comp-item` | `addEventListener('mousedown')` 3448 |
| `.ble-dev-card` | `renderBleDeviceList` 8277 | `.ble-dev-card[data-addr]` | `addEventListener('click')` 8304 |
| `.adb-dev-card` | `refreshAdbDevices` 9496 | `.adb-dev-card[data-serial]` | `addEventListener('click')` 9501 |
| `.sel-opt`（端口） | `refreshPorts` 2932 / `refreshWslMonPorts` 6548 | `#{mid}-portDrop .sel-opt` | 前者 `el.onclick=`（2944），后者 `addEventListener('click')`（6559） |
| `.toast`（error） | `showToast` 2476 | `.toast.toast-error` | `addEventListener('click')` 2480（仅 error 可点关闭） |
| WSL 发行版卡片内 2 按钮 | `renderWslDistroCards` 6695/6696 | `#main-wslDistroList button` | 内联 `onclick`（拼字符串）+ `onmousedown/up/leave` 做按压动画 |

---

## 3. 统计数字（必须口径明确）

### 3.1 控件总量与分类（源码中可交互标签 = 230 个）

| 类别 | 总数 | 有 `id=` | 无 `id=` | 备注 |
|---|---|---|---|---|
| `button` | **78** | 35 | 43 | 73 个带内联 `onclick` |
| `input[type=text]` | **16** | 8 | 8 | |
| `input[type=number]` | **4** | 2 | 2 | 仅波特率 + 工作流延时 |
| `input[type=checkbox]` | **10** | 8 | 2 | DTR/RTS、工作流启用、WSL 两个开关、BLE 从机 4 个 |
| `input[type=radio]` | **0** | 0 | 0 | **不存在** |
| `input[type=range]` | **0** | 0 | 0 | **不存在** |
| `input[type=file]` | **0** | 0 | 0 | **不存在**（文件选择全走后端 `rfd`） |
| `input[type=color]` | **0** | 0 | 0 | **不存在** |
| `select` | **4** | 4 | 0 | `#main-wslTargetDist`/`#bleScanSecs`/`#blePfPreset`/`#blePfSaved` |
| `textarea` | **1** | 1 | 0 | `#bleWriteValue` |
| `div[onclick]`（可点卡片/选项） | **102** | 17 | 85 | 绝大多数是 `.sel-opt` / `.send-as-opt` / `.baud-opt` |
| `span[onclick]` | **15** | 8 | 7 | 顶栏按钮、BLE 动作图标、清空日志 |
| **合计** | **230** | **83** | **147** | |

补充：`<option>` 11 个（`#bleScanSecs` 5 + `#main-wslTargetDist` 动态 + 预设动态）；JS 另用 `document.createElement` 造控件：`input`×3、`button`×2、`textarea`×1（`fallbackCopy` 的临时离屏元素，非 UI）、`div`×28、`span`×7、`option`×1。

### 3.2 有 `id` vs 没有 `id`

| 口径 | 数量 | 占比 |
|---|---|---|
| 有 `id=` | **83 / 230** | 36.1% |
| ├ 全局唯一字面量 id | **39** | 17.0% |
| └ `{mid}-` / `{wmid}-` 模板 id（实例化后仍可预测） | **44** | 19.1% |
| 无 `id=` | **147 / 230** | 63.9% |

**选择器强度分级（230 个控件的定位能力）**

| 可用定位手段 | 数量 | 占比 | 说明 |
|---|---|---|---|
| 字面量 `id` | 39 | 17.0% | 最稳，如 `#bleScanBtn` |
| 模板 `id`（`#{mid}-…`） | 44 | 19.1% | 需知道 mid；mid 集合确定 → 等价稳定 |
| 仅 `name` | 8 | 3.5% | `wf-enabled`/`wf-rule-name`/`wf-cond-value`/`wf-act-data`/`wf-act-delay`/`wsl-map`/`wsl-auto-map` |
| 仅 `data-*` | 60 | 26.1% | `data-val`/`data-style`/`data-ci`/`data-field`/`data-prop`/`data-del`/`data-act`/`data-reply`/`data-addr`/`data-uuid`/`data-qsend`/`data-modes`/`data-serial` |
| 仅 `class` | 77 | 33.5% | **不可唯一**：`.ibtn`、`.wf-row-btn`、`.wf-rule-btn`、`.btn-ref`、`.pane-close`、`.win-ctrl-btn`、`.ble-pf-btn`、`.sel-opt` 等在同一容器重复多次 |
| 裸标签（无任何属性） | 2 | 0.9% | WSL 发行版卡片的"打开终端"和"启动/关闭" |

### 3.3 绑定方式：内联 `on*=` vs `addEventListener`

| 绑定方式 | 出现次数 |
|---|---|
| 内联 `onclick=` | **196** |
| 内联 `onchange=` | **13** |
| 内联 `oninput=` | **8** |
| 内联 `onkeydown=` | **1** |
| 内联 `onmousedown=` | **2** |
| 内联 `onmouseup=` | **1** |
| 内联 `onmouseleave=` | **5** |
| 内联 `onmouseenter=` | **4** |
| **内联 `on*=` 合计** | **230** |
| `addEventListener(` 调用 | **59**（其中 `click` 16、`keydown` 7、`input` 6、`change` 3，其余为 focus/blur/scroll/mouse*/DOMContentLoaded/error 等） |
| `window.__TAURI__.event.listen(` | **4**（`wsl-status-changed`、`ble-pair-request`、`device-changed`、`save-before-exit`） |
| `el.onclick = fn` 直接赋值 | **6**（`overlay.onclick` 10487、`wrap.onmouseenter/onmouseleave` 3095–3097、`header.onmouseenter/leave` 3097、端口项 `opt.onclick` 2944） |
| `setAttribute('onclick', …)` 运行时换绑 | **13** |

> 结论比例：**内联 230 : addEventListener 59 ≈ 3.9 : 1**，内联是绝对主流。

---

## 4. 事件绑定约定（决定"能否自动生成控件注册表"）

### 片段 1 —— 渲染函数拼字符串 + 内联 `onclick`（主流，占 196/230 个 onclick）

```js
2492:    const closeBtn = closable ? '<button class="pane-close" onclick="closeMonitor(\'' + mid + '\')" title="关闭">\u2715</button>' : '';
2516:            '<button class="btn-ref" onclick="refreshPorts(\'' + mid + '\')" title="刷新端口">' + ICONS.refresh + '</button>' +
2533:            '<button class="btn-main start" id="' + mid + '-btnStart" onclick="toggleConnection(\'' + mid + '\')">' +
2604:            '<button class="btn-send" id="' + mid + '-btnSend" onclick="sendData(\'' + mid + '\')" disabled>' +
2621:    document.getElementById('paneContainer').appendChild(pane);
```
整个窗格的 DOM（含所有控件的 id 与 onclick 字符串）都在 `createMonitorPane` 一个 `innerHTML` 里拼出来 → **控件元数据只以字符串形式存在，没有 JS 侧注册表**。

### 片段 2 —— 列表/规则行也用字符串拼内联事件（动态渲染）

```js
5087:            '<input type="checkbox" name="wf-enabled"' + (rule.enabled ? ' checked' : '') + ' onchange="toggleWorkflowEnabled(\'' + mid + '\',\'' + rule.id + '\',this.checked)">' +
5089:            '<button class="wf-rule-btn wf-run-btn' + (isRunning ? ' wf-running' : '') + '" onclick="toggleWorkflowRun(\'' + mid + '\',\'' + rule.id + '\')" ...
9931:        html += '<label class="wsl-auto-toggle"><input type="checkbox" name="wsl-auto-map" ' + ... + ' onchange="toggleAutoMap(...)"><span class="wsl-auto-slider"></span></label>';
9936:        html += '<input type="checkbox" name="wsl-map" class="wsl-checkbox" ' + (isMapped ? 'checked' : '') + ' ' + (mapDisabled ? 'disabled' : '') + ' onchange="toggleWslMapping(\'' + mid + '\', ' + idx + ', this.checked)">';
```
控件数量随数据变化（工作流规则数、设备数），**同名控件会重复出现**（多个 `[name=wf-enabled]`）。

### 片段 3 —— 全局事件委托（唯一关闭下拉/弹窗的机制）

```js
2831: document.addEventListener('click', function(e) {
2832:     document.querySelectorAll('.baud-dropdown.open').forEach(function(dd) { ... dd.classList.remove('open'); });
2844:     document.querySelectorAll('.sel-drop.open').forEach(...);          // 关通用下拉
2848:     // （快速指令不再走下拉开合：已改为监控区最右侧的可折叠分栏，与全局 click 无关）
2852: });
5730: document.addEventListener('click', ...)     // 关主题风格下拉
7361: document.addEventListener('keydown', function(e) { if (e.key !== 'Escape') return; ... });  // Esc 关 BLE 写入弹窗
10244/10281: document.addEventListener('mouseover' / 'mouseout', ...)  // 自定义无延迟 tooltip
```

### 片段 4 —— 容器级委托 + `data-*`（**全项目唯一"数据驱动"写法**，值得作为重构范本）

```js
8885: // 表单里的特征行（可编辑）。行内不用内联 onclick：UUID 走 data-* + 事件委托，
8886: // 免得"用户填的 UUID"进到 HTML 属性里（同类隐患见 TODO M13/L13）
8922: function initBlePfForm() {
8924:     if (box && !box._bound) { box._bound = true;
8926:         box.addEventListener('input', blePfEditorInput);   // e.target.dataset.ci / .field
8927:         box.addEventListener('click', blePfEditorClick);   // [data-del] / .ble-pf-prop[data-ci][data-prop]
8932:     charsBox.addEventListener('click', ... el.getAttribute('data-act') / 'data-uuid' ...);
8941:     pendBox.addEventListener('click', onBlePfPendingClick);  // [data-reply][data-accept]
```
配套标记：`data-ci`/`data-field`/`data-del`/`data-prop`/`data-act`/`data-uuid`/`data-reply`/`data-accept`。

### 片段 5 —— JS 造元素后逐个 `addEventListener`（下拉项/卡片/终端/快速指令每一条）

```js
function makeQcmdItem(mid, idx, label, value) {
    var seqInp = document.createElement('input');     seqInp.className = 'qcmd-item-seq';
    seqInp.addEventListener('input', function() { /* 只收数字 → quickCmds[idx].seq，>0 时点亮 */ });
    var delayInp = document.createElement('input');   delayInp.className = 'qcmd-item-delay';
    delayInp.addEventListener('change', function() { /* 空→1000，超 600000 夹住 */ });
    var hexBtn = document.createElement('button');    hexBtn.className = 'qcmd-item-hex';
    hexBtn.addEventListener('click', function() { /* 翻转 quickCmds[idx].hex */ });
    var sendBtn = document.createElement('button');    sendBtn.className = 'qcmd-item-send';
    sendBtn.setAttribute('data-qsend', '1');
    sendBtn.addEventListener('click', function(e) { e.stopPropagation(); sendQcmdItem(mid, idx); });
```
（名称输入框 `qcmd-item-label` 已删除；这一行的顺序号/延时/HEX 是 `.walkthrough` 里**真触发处理器**断言过的，
不是只扫源码正则。）

```js
    var card = document.createElement('div');          card.className = 'ble-dev-card';
    card.setAttribute('data-addr', dev.address);
    card.addEventListener('click', function() { ... });
```

### 片段 6（补充）—— 运行时换绑：同一个 DOM 按钮在不同页面是不同功能

```js
7555:  if (btn) { btn.setAttribute('title', '返回到串口调试器'); btn.setAttribute('onclick', 'closeBle()'); btn.classList.add('active'); }
9368:  wBtn.setAttribute('onclick', 'openWslMapping()');
9385:  btn.setAttribute('onclick', 'closeAdb()');
6257:  btnStart.setAttribute('onclick', "toggleWslConnection('" + wmid + "')");
```
共 13 处 —— **静态扫描一次源码得到的 `onclick` 不等于运行时的 `onclick`**，顶栏 4 个按钮与 WSL 监视器的开始按钮都会被改写。

### 「能否自动生成控件注册表」的判定

可以，但**必须用"源码静态提取 + 运行时补全"两步，且只能信任 id/data-***：

1. 静态可提取（约 83 个）：`id="…"` 与 `id="' + mid + '-…"` 两种模式；`{mid}` 取值集合是枚举的（`main`、`extra-1..N`、`wsl`、`wsl-x1..N`、`ble-mon`）。
2. 半静态可提取（约 68 个）：`name=`（8）+ `data-*` 键控（60），其中 `data-ci`/`data-del`/`data-reply` 的取值由数据决定，需要运行时遍历。
3. **无法静态唯一化（77 个 class-only + 2 个裸标签）**：同一容器里同类按钮多次出现（`createMonitorPane` 的 `.ibtn-group` 里 5 个 `.ibtn` 只有 4 个带 id，`clearLog` 那个没有；工作流行里 4 个 `.wf-row-btn` 完全同构）。
4. 动态渲染的控件（工作流行、WSL 设备行、BLE 设备卡、端口项、补全项）**在对应面板首次打开前不存在于 DOM**，注册表必须带上"前置条件（哪个面板、哪个 mid）"。

---

## 5. 主题 / 界面风格

### 5.1 12 套主题（6 风格 × 深浅）

| 风格 key | 浅色 `data-theme` | 深色 `data-theme` | 名称 | 标题栏色（`_TITLE_BAR_COLORS` 5626） |
|---|---|---|---|---|
| `default` | `default-light` | **（不设属性，走 `:root`）** | 默认 | light `#EDF0F2` / dark `#1C1E22` |
| `japanese` | `japanese-light` | `japanese` | 浮世绘彩 | light `#F4F0E8` / dark `#141620` |
| `poetic` | `poetic` | `poetic-dark` | 诗意东方 | light `#E8E2F0` / dark `#121014` |
| `ink` | `ink` | `ink-dark` | 水墨丹青 | light `#F4F0E8` / dark `#141618` |
| `peach` | `peach` | `peach-dark` | 桃之夭夭 | light `#F6F0F2` / dark `#181014` |
| `autumn` | `autumn` | `autumn-dark` | 金风玉露 | light `#F2EBE0` / dark `#141008` |

⚠️ 命名**不对称**（重构时注意）：`default`/`japanese` 用 `-light` 后缀表示浅色（深色是无后缀/无属性），而 `poetic`/`ink`/`peach`/`autumn` 用 `-dark` 后缀表示深色（无后缀 = 浅色）。这层映射硬编码在 `getThemeDataAttr()`：

```js
5639: function getThemeDataAttr() {
5640:     if (_currentThemeStyle === 'default')  return _currentTheme === 'light' ? 'default-light'  : 'default';
5641:     if (_currentThemeStyle === 'japanese') return _currentTheme === 'light' ? 'japanese-light' : 'japanese';
5642:     if (_currentThemeStyle === 'poetic')   return _currentTheme === 'light' ? 'poetic'         : 'poetic-dark';
5643:     if (_currentThemeStyle === 'ink')      return _currentTheme === 'light' ? 'ink'            : 'ink-dark';
5644:     if (_currentThemeStyle === 'peach')    return _currentTheme === 'light' ? 'peach'          : 'peach-dark';
5645:     if (_currentThemeStyle === 'autumn')   return _currentTheme === 'light' ? 'autumn'         : 'autumn-dark';
5646:     return 'default';
5647: }
```
另：源码里只声明了 **11 个 `[data-theme="…"]` 块**，第 12 套是 `:root`（默认深色）——即 `applyTheme` 给 `documentElement` 设 `data-theme="default"` 时不匹配任何块，实际用 `:root`。

### 5.2 主题切换函数

| 函数 | 行号 | 作用 |
|---|---|---|
| `getSystemTheme()` | 5635 | 读 `prefers-color-scheme` |
| `getThemeDataAttr()` | 5639 | 风格+深浅 → `data-theme` 值 |
| `syncThemeUI()` | 5649 | 同步开关 `.on`、下拉 `.active`、`title` 文案 |
| `applyTheme(theme)` | 5666 | 写 `_currentTheme`、加 `html.transitioning`、设 `data-theme`、动画标题栏 |
| `animateTitleBar(target,duration)` | 5682 | 16ms 步进 `invoke('set_title_bar_color')` |
| `syncTitleBarColor(theme)` | 5699 | 立即套用标题栏色 |
| `toggleTheme()` | 5704 | 深↔浅 + `scheduleConfigSave()` |
| `toggleThemeStyleDrop(e)` | 5709 | 展开风格下拉 |
| `selectThemeStyle(style)` | 5715 | 切风格 + 持久化 |
| `matchMedia(...).addEventListener('change')` | 5737 | 跟随系统深浅 |
| 启动时 | 5745 / 5752 / 5753 | 初始 `applyTheme(getSystemTheme())`，500ms/1500ms 再补两次标题栏色 |

### 5.3 CSS 变量命名规律（`:root` 共 **35** 个）

| 分组 | 变量 |
|---|---|
| 背景/容器 | `--bg` `--editor-bg` `--toolbar-bg` `--input-bg` |
| 边框 | `--border` `--border-h`（hover）`--split-line` |
| 文本 | `--text` `--text-b`（bold/亮）`--text-d`（dim）`--text-soft` `--text-muted` `--text-placeholder` |
| 链接/主按钮 | `--link` `--btn-p` `--btn-ph`（hover）`--btn-pa`（active） |
| 表面层级 | `--surface-1` `--surface-2` `--surface-3` |
| 焦点/语义色 | `--accent-focus` `--accent-green` `--accent-red` `--accent-orange` `--accent-contrast` |
| 发送气泡 | `--send-bubble-bg` `--send-bubble-text` |
| 功能态 | `--mapped-bg` `--mapped-border` `--wsl-dist-border` `--wsl-dist-bg` `--wsl-dist-stop-bg` `--wsl-dist-start-bg` |
| 字体族 | `--font-ui` `--font-mono` |

命名规律：`--<域>-<修饰>`，修饰后缀固定为 `-b`(bold) / `-d`(dim) / `-h`(hover) / `-a`(active) / `-p`(primary)；层级用数字 `-1/-2/-3`；语义色统一 `--accent-*`。ANSI 配色不走变量，而是每套主题各写 16 条 `.ansi-N` 类（`--ansi-*` 变量**不存在**）。

### 5.4 是否有"字体大小 / 密度 / 缩放"风格项

**没有。** 全文检索 `fontSize|font-size|zoom|density|scale()` 只命中 1 处业务代码：

```js
9615:        fontSize: 13,          // xterm 的构造参数，硬编码
```

- `html, body { font-size:14px }`（1019）固定，无 UI 可调。
- 主题只切**颜色**，不切字号/行高/密度/缩放。
- **结论：可扩展点存在但没有实现**——若要加"字号/密度"，需新增变量（如 `--font-size`、`--density`）并改 1019、`--font-mono` 使用点、xterm 的 `fontSize`。

---

## 6. 已有的状态序列化逻辑（决定 MCP 工具如何回写界面）

### 6.1 出口（界面 → JSON → 后端）

| 函数 | 行号 | 作用 |
|---|---|---|
| `collectConfig()` | **5334** | 汇总全局配置对象 `cfg` |
| `collectConfigForMonitor(mid)` | **5412** | 单监视器配置（结构同 `cfg.monitors[mid]`，无 `panelHeight`） |
| `collectBleState(s)` | **3924** | 蓝牙页状态（纯数据，便于持久化） |
| `blePfCollectForm()` | **9026** | 从机表单 → 纯数据（内部先调 `blePfCollectOptions()` 9012 把勾选框读进状态） |
| `saveWorkflowConfig(mid)` | **5026** | 单独存工作流：`invoke('save_workflows',{monitorId, workflowsJson})` |
| `snapshotWslSettings(wmid)` | **6714** | WSL 监视器 DOM 即将被替换时快照到 `_savedSettings` |
| `scheduleConfigSave()` | **5610** | 500ms 防抖 → `collectConfig()` → `invoke('save_config',{configJson})` |
| `beforeunload` | **10384** | 关窗前强制 flush 保存 + `logCacheEnd` 全部会话 |
| Tauri 事件 `save-before-exit` | **10353** | 安装更新前强制保存（`process::exit` 会跳过 beforeunload） |

### 6.2 `cfg` 顶层字段（`collectConfig` 5340）

```
{ version: 2, extraCount, wslExtraCount,
  monitors: { [mid]: {...} },
  logDir, wslAutoMap, theme, themeStyle,
  windowWidth, windowHeight,
  ble: { monitor, monitorWidth, monitorCfg, openSvcs[], advOpen,
         filterText, filterOpen, selected, mode, periph, scanSecs, periphSaved[] } }
```

### 6.3 `cfg.monitors[mid]` 字段（5380–5402）

```
port, baud, lineEnding, viewMode, sendAs, dataBits, stopBits, parity,
dtr, rts, advOpen,
btnScroll, btnAutoReconnect, btnSendLE, btnTs, btnEcho, btnLineNum,
quickCmds[], sendHistory[≤20], panelHeight, workflows[]
```
注意：`btnSendLE`（终端模式）在恢复时被**强制置 false**（5581），即"终端模式不进配置文件"。

`cfg.ble.periph` 字段（`blePfCollectForm` 9028）：`presetId, service, chars[{uuid,props[],value,desc}], discoverable, connectable, advData, advDataHex, manualReply`。

### 6.4 入口（JSON → 界面）

| 函数 | 行号 | 作用 |
|---|---|---|
| `loadAndApplyConfig()` | **5756** | `invoke('load_config')` → 版本迁移（v1/无版本 → v2，先 `backup_config`）→ 恢复主题/日志目录/WSL 自动映射/窗口大小/蓝牙页 → `applyMonitorConfig` → 按 `extraCount` 重建 `extra-N` → `renderWorkflowList` → `invoke('init_workflows')` |
| `applyMonitorConfig(mid, mc)` | **5475** | 把 `mc` 写回 DOM（下拉 `data-val`+文案+`.active`、checkbox、按钮 `.on` 类、`quickCmds`/`sendHistory`/`workflows`、`_savedPort`） |
| `copyMonitorConfig(srcMid,dstMid,opts)` | **5452** | 深拷贝监视器配置（可 `skipPort`） |
| `restoreBleState(b)` | **3947** | 恢复蓝牙页纯内存状态；内嵌监视器延后到 `openBle` 消费 `_bleRestoreMon` |
| `restoreBlePeriphForm(p)` | **9043** | 恢复从机表单（形状不对则保留默认预设） |
| `restoreBlePeriphSaved(list)` | **3966** | 恢复"我的配置"列表（校验 name/form 形状） |
| `_wslSavedConfig` | 5811 / 5405 | WSL 面板懒加载期间缓存其配置，防止主监视器保存时丢失 |
| `localStorage` | 10379 读 / 10588 写 | **唯一** localStorage 项：`onboarding_done` |

### 6.5 其他后端持久化（非界面状态，但会被界面触发）

- 隐形日志缓存：`start_log_cache`（4519）/ `append_log_cache`（4515，300ms 节流）/ `end_log_cache`（4529）
- 窗口尺寸：`get_window_size`（10363）/ `set_window_size`（3867、5799）
- 工作流：`save_workflows`（5029）/ `init_workflows`（5829）
- **不存在**"把界面状态导出为 JSON 到剪贴板/文件"或"从剪贴板 JSON 恢复界面"的功能；也没有 `window.__dumpState()` 之类的调试钩子。

---

## 7. 给架构师的整体结论

1. **面板模型简单但无显式状态**：4 个容器 + `style.display` 互斥 + 3 个 `_initialized` 懒加载标记；当前页只能反查 DOM。要做 MCP 工具，建议先补一个 `getUiState()`/`setUiState()` 之类的门面，把"当前页/当前 mid/当前选择"显式化。
2. **控件规模 230（源码标签）+ ~9 个运行时生成的控件家族**，其中**只有 83 个（36.1%）带 `id`**；剩下 147 个必须靠 `name` / `data-*` / class（其中 77 个 class-only **无法唯一化**）。
3. **绑定以内联 `onclick` 为主（230 : 59）**，且 13 处会在运行时用 `setAttribute('onclick', …)` 改写 —— 静态分析得到的 handler 映射与运行时可能不一致；同时 `renderWorkflowList` / `renderWslDeviceList` / `renderBlePfPending` 会在字符串里拼 `onclick`，意味着**控件注册表只能在"面板已打开 + 数据已渲染"后采集**。
4. **唯一值得复用的"可自动化"范式**是 BLE 从机表单（`initBlePfForm` 8922 + `data-ci/data-field/data-prop/data-del/data-act`）——新增控件建议照此办理，能显著提高自动化可行性。
5. **主题/风格只切颜色**，12 套 = 6 风格 × 深浅（命名不对称，`getThemeDataAttr()` 是唯一真源），无字号/密度/缩放项。
6. **持久化已经很完整**：`collectConfig`/`applyMonitorConfig`/`scheduleConfigSave`/`loadAndApplyConfig` + `collectBleState`/`restoreBleState` + `blePfCollectForm`/`restoreBlePeriphForm` 覆盖了几乎所有可见状态，**MCP 回写界面应当直接复用 `applyMonitorConfig`、`restoreBleState`、`blePfLoadSaved`、`setBleMode` 这几个函数，而不是自己操作 DOM**；回写后调 `scheduleConfigSave()` 即可落盘。
7. ⚠️ **BLE 从机（外设）整套 UI 当前不可达**（`BLE_PERIPH_MODE_ENABLED=false`，8680）——自动化清单里应把它标记为"存在但入口关闭"，不要误判为可用功能。
