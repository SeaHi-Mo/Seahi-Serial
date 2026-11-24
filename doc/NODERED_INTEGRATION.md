# Node-RED 集成（自动化画布）

> 状态：**可用，但真机串口收发尚未验证**（2026-11）。
> 本文是给下一个接手的人/另一台机器用的：架构、构建、已经踩过的坑、待办，都在这里。

## 1. 为什么是内嵌 Node-RED

需求是"用户自己编排自动化流程"（串口收数据 → 判断 → 自动发下一条 → 循环）。
自己画一套画布等于重造 Node-RED，且没有执行语义；所以**直接内嵌 Node-RED 本体**（Apache-2.0，可商用）。

早期写过一版自绘节点画布（`85-nodeflow.js` 的第一版），**已全部删除**——它只有画布、没有引擎。
现在 `85-nodeflow.js` 只是一个启动器：调后端要地址、开编辑器窗口（2026-11 起是**独立窗口**；更早是分栏里的 iframe 覆盖层，已删除）。

## 2. 架构

```
主窗口（WebView2）                       Node-RED 编辑器窗口（独立 WebView2，自绘标题栏）
 ├── 工具栏 Node-RED 图标 ──► invoke('nodered_open_window')
 │                              └─ Rust：已开着就 show + focus（绝不第二个编辑器）
 │                                 没开 → 拉起侧车 → 新建窗口加载 **node-red-window.html**
 │                                 （外壳页：自绘标题栏 + iframe → http://127.0.0.1:<port>/）
 │                                 几何存 %APPDATA%\seahi-serial\nodered-window.json
 │
 └── Rust 宿主进程（独占 COM 口）
      ├── 侧车：node.exe + node_modules/node-red + settings.js（随安装包分发）
      ├── 桥：回环 TCP，换行分隔 JSON，一次性令牌
      │      node 侧发 {"op":"send","monitor":"main","hex":"…"} → 写串口
      │      节点轮询 {"op":"read",…} → 取走读线程复制的字节
      └── 用户数据：%APPDATA%\com.seahi.seahi-serial\node-red\（flows.json 等）
```

**为什么要外壳页（自绘标题栏）**：窗口若是 `decorations(true)`，就是系统标题栏（系统字体/系统按钮/不同高度），
和主窗口（`decorations:false` + `#globalBar` 自绘）摆一起像两套软件（用户 2026-11 报的"风格都不一样"）。
所以窗口改为 `decorations:false`、加载仓库内的 `node-red-window.html`：标题栏**照抄主窗口**那一套
（36px / `var(--toolbar-bg)` / 46×36 按钮 / 关闭 hover `#e81123`），中间一个 **永不移动**的 iframe 指到编辑器。
iframe 在这里是安全用法 —— 它从生到死都在同一个位置，不 reparent，所以不会触发"搬 iframe → 编辑器整页重载"。

**为什么是独立窗口**（2026-11 用户定的方向）：Node-RED 是**全局**工作台 —— 一套流程服务所有分栏，
塞进某个分栏的正文区就等于"编辑器跟着分栏走"，而且只能吃监视窗口那一块。独立窗口可以并排/分屏，
同时满足"编辑流程"和"看串口数据"；也能整块拖到第二块屏。

**关键约束：串口由 Rust 独占。** 节点绝不自己 open COM 口（会和监视器、DTR/RTS、WSL 映射抢），
只通过桥跟宿主说话。

## 2.1 嵌入 / 脱离：一个编辑器，两种形态（2026-11）

用户要的共存方式：**默认贴在程序里（位置就是原来的监视器正文区），能拖出来变成独立窗口**。

实现上只有一条路能同时满足"默认内嵌"和"拖出不丢草稿"：编辑器**始终是那一个 WebView**，
嵌入 = 用 Win32 `SetParent` 把它挂成主窗口的子窗口（视觉上就是内嵌），脱离 = 解除父子关系。
换成"内嵌用 iframe、独立用窗口"的写法必须重建 WebView，编辑器整页重载、未部署的修改全丢。

| 环节 | 做法 |
|---|---|
| 打开 | `openNodeRed()` → `nodered_open_window`（**返回"要不要停靠"**）→ 要停靠时前端量**所有可见分栏正文区的并集**（`.mon-body` union）→ `nodered_dock{rect}`。三种情形：没开 → 新建并停靠；已开且嵌着 → 只重贴一次；已开且浮着 → **只抬到前面，绝不拽回分栏** |
| 跟随 | 前端每 250ms `nodered_dock_sync{rect}`；宿主发现矩形没变就直接返回（不重复 `MoveWindow`）。⚠️ 矩形是**并集**：只贴第一个分栏的话，多分栏时编辑器会被分栏边界切开（用户 2026-11："编辑器被分栏了，不应该分栏的"） |
| 外观 | 嵌入态外壳页把标题栏收成 24px 细拖条（左「Node-RED」+ 右「脱离」），窗口按钮隐藏 |
| 脱离 | 点「脱离」，或抓住细拖条左侧的把手 `⋮⋮`（整条拖条都能拖）往外拖 —— 先 `nodered_dock{rect:null}` 再 `startDragging()`，松手就停在鼠标处 |
| 归位 | **把浮动窗口拖回主窗口上方松手**（中心进入主窗口、且这次浮动期间到过窗口外）→ 宿主发 `nodered-dock-request` → 前端报矩形 → 重新贴进去；独立态标题栏另有「停靠」按钮，等价 |
| 开关（顶栏按钮） | 点开 → 窗口显示且**按钮背景用主题色**（`.add-btn.icon-btn.active`）；**再点一次是 `hide`**（不是关闭，编辑器与未部署的修改都留着），再点又原样回来（同一个 WebView，实测 HWND 不变）。宿主用 `nodered-state`（open/hidden/closed）事件 + `nodered_window_state` 让按钮自己校正 |
| 关闭 | 嵌入态用细拖条右端的「✕」，独立态用标题栏的关闭按钮 —— 都只关编辑器窗口，**侧车继续跑**；嵌入态关窗不写几何（见坑 #12） |
| 点图标 | 浮动窗口被缩得很小或挪出屏幕时，先 `nodered_ensure_on_screen` 拉回可见区域再 `set_focus`（否则"点了没反应"） |
| 尺寸 | **停靠态不可缩放**（用户 2026-11："编辑区左右不可拖动，始终和主程序窗口保持一致"）：贴进主窗口时用 `SetWindowLongW` 摘掉 `WS_THICKFRAME`/`WS_MAXIMIZEBOX`，宽度/高度都恒等于正文区；脱离时按记住的原样式加回去。⚠️ `set_resizable(false)` 对 `SetParent` 之后的子窗口**不生效**（实测样式没变），只能改窗口样式。<br>⚠️ **上边沿拖动试过两轮、已撤回**：① 页面里自算高度（`#nrTopGrip` + pointer capture）——那条 5px 窄带实测收不到 mousedown（日志零调用）；② 恢复 `WS_THICKFRAME` 走原生缩放 —— 子窗口上抓不稳，且会让 Node-RED 在边缘状态下布局错乱。要再做请先解决"子窗口缩放手柄"（`WM_NCHITTEST` 子类化返回 `HTTOP`）。 |
| 蒙版 | 拖动中中心一旦进入主窗口，分栏正文区亮出**蓝色虚线框 + 「松开鼠标：把编辑器停靠到这里」**（`nodered-drag-hover` 事件 → `#nfDockHint`；`pointer-events:none`，文字贴顶部否则会被浮动的编辑器挡住） |
| 退出 | 主窗口关闭时先 `SetParent(null)` 再关编辑器窗口（否则子窗口跟着父窗口销毁，几何存不下来） |

⚠️ **三个实测坑，别改回去**：
① `WebviewWindow::hwnd()` 在本项目返回 `the underlying handle is not available`（窗口明明在），
   所以句柄改用 `EnumWindows` 枚举本进程顶层窗口按标题匹配（`nodered_hwnd_of`）；
② **一旦成为子窗口，`EnumWindows` 就再也枚举不到它** —— 脱离必须用 `NODERED_HWND` 里记住的句柄；
③ 前端 250ms 报一次矩形，宿主必须**去重**（`NODERED_RECT`），否则每 250ms 重设一次窗口位置，画面会抖；
④ **刚脱离的 2 秒内同步请求一律忽略**（`NODERED_UNDOCK_AT`）：否则一个正在路上的同步请求会在脱离之后把窗口又贴回去（"拖出去又被吸回来"）；
⑤ **自动归位要两条判据**：中心点落在主窗口里 **且** 这次浮动期间到过窗口外（`NODERED_WAS_OUTSIDE`）—— 少了后者，刚拖出来那一刻中心还在主窗口里，会被立刻吸回去（实测踩到）。⑥ **归位必须等"松手"**（`GetAsyncKeyState(VK_LBUTTON)` 轮询）：只看"移动停下 N 毫秒"会在用户还按着鼠标时就把窗口拽进去（实测踩到），拖动期间只亮蒙版。
⑥ **停靠态靠"摘样式"锁死尺寸，不靠"拖了再纠正"**：`set_resizable(false)` 对子窗口无效（实测 `WS_THICKFRAME` 还在），要 `SetWindowLongW` 摘掉它；脱离时把原样式写回。一旦允许拖，就必须在 250ms 内回弹 —— 那既抖又和"拖拽时不贴窗"的闸打架，2026-11 反复踩过三次。
⑦ 拖动手势**不能用 `data-tauri-drag-region`**：它会把嵌入态的拖动变成"在父窗口里挪子窗口"，永远拖不出去 —— 两种形态的拖动都由 `86-node-red-window.js` 接管。

## 3. 文件清单

| 路径 | 作用 |
|---|---|
| `src/js/85-nodeflow.js` | 前端薄启动器：`openNodeRed()` 调 `nodered_open_window`、在途闸、失败原因展示；外加 `nfOnSent`（把自动化发出的数据回显到监视窗口） |
| `src/node-red-window.html` | **编辑器窗口的外壳页**（不进 index.html）：自绘标题栏 + iframe |
| `src/css/05-node-red-window.css` | 外壳页样式：标题栏/按钮**照抄**主窗口 `#globalBar` + `.win-ctrl-btn`（数值要对账，见断言） |
| `src/js/86-node-red-window.js` | 外壳页脚本：窗口按钮（最小化/最大化/关闭）、取 `nodered_url` 填 iframe、地址变了才换 src |
| `src-tauri/src/main.rs` | `nodered_open` / **`nodered_open_window`** / **`nodered_url`** / `nodered_stop`、编辑器窗口几何、侧车启停、桥服务器、节点投递（搜 `nodered_` / `bridge_`） |
| `src-tauri/src/main.rs` | `nodered_open/stop`、侧车启停、桥服务器、节点投递（搜 `nodered_` / `bridge_`） |
| `src-tauri/resources/node-red/settings.js` | 离线固化配置（见下） |
| `src-tauri/resources/node-red/package.json` | 运行时依赖清单（只有 `node-red@5.0.10`） |
| `src-tauri/resources/node-red/local-nodes/seahi-serial.{js,html}` | **唯一的自研节点包**：`serial rxd` / `serial txd` / `serial request` |
| `scripts/prepare-nodered.mjs` | 生成运行时：npm install → 裁分类 → 拷 node.exe → 可选 npm 桩 |
| `installer.iss` | Inno 安装器追加拷贝 `{app}\resources\node-red` |

## 4. 构建与运行

```bash
npm run prep:nodered -- --slim   # 一次性：装 node-red 依赖 + 拷当前 node.exe（约 172 MB / 9600 个文件）
npm run dev                      # 之后正常开发
```

- **必须**先跑 `prep:nodered`，否则打开画布会报「缺少 node.exe」
- CI（`.github/workflows/build.yml`）在 `Build Tauri app` 之前也会跑 `npm run prep:nodered -- --slim`。
  **别删这一步**：运行时目录不入库，少了它 Tauri 的 MSI 会静默不带 `resources`，Inno 会被
  `installer.iss` 的 `#ifexist` 守卫拦下（v0.6.0 首次构建就是这么失败的）。
- `--slim` 把 `node_modules/npm` 换成百字节桩（省 11.7 MB）。安全性：`allowInstall=false` 时
  Node-RED 只用它算 CLI 路径，永不执行
- 打包：`npm run build`，产物里 `resources/node-red` 会被带上；Inno 那条 Source 从
  `src-tauri\resources\node-red\*` 直接取

## 4.1 seahi-serial 节点参数（2026-11）

| 节点 | 字段 | 默认 | 说明 |
|---|---|---|---|
| `serial rxd` | 端口 | 第一个已打开的 | **下拉**：宿主里当前已打开的串口，显示 `COM17 · 115200`；value 仍是分栏 id（桥按 id 取数），带「刷新」 |
| | 格式 | `文本` | `文本` / `HEX` / `Buffer`；见下 |
| | 轮询 ms | `100` | 最小 20 |
| `serial txd` | 端口 | 第一个已打开的 | 同上（显示端口，value 是该分栏的 id） |
| | 格式 | `文本` | `文本` / `HEX` |
| | 行尾 | `CRLF` | 只在文本模式生效 |
| `cmd list` | 端口 | 第一个已打开的 | 同上 |
| | 指令 | 列表第一条 | **下拉**：宿主「快捷指令」面板里的条目（按组分组）；value 是宿主生成的 `key`，运行期按它现查，所以在面板里改了指令、流程会跟着变 |
| | 行尾 | `CRLF` | 该条目标了 HEX 时按字节发、不加行尾 |
| `serial request` | 端口 | 第一个已打开的 | 同上 |
| | 发送 / 回复格式 | `文本` / `文本` | 发：`文本`/`HEX`；收：`文本`/`HEX`/`Buffer` |
| | 行尾 | `CRLF` | 只在文本发送模式生效 |
| | 最长 ms / 静默 ms | `1000` / `80` | 窗口上限；收到字节后连续静默多久收口 |
| | 结果分支 | `OK` / `ERROR` | **一个条件一个连接点**（包含/等于/正则/未匹配超时），可添加 |

- **`cmd list` 与「快捷指令」的同步链路（2026-11）**：前端 → `nodered_set_quickcmds`（Rust 只做**缓存中转**）
  → 桥 `{"op":"quickcmds"}` → 侧车管理路由 `GET /seahi-serial/quickcmds` → 编辑器下拉。
  三点别改回去：① 权威数据在**前端**（面板里可能还有没写回文件的改动），Rust 不自己读指令文件 ——
  那些文件的路径只认用户在原生框里亲手选过的（见 AGENTS「快速指令的外部文件」）；
  ② 节点里存的是宿主生成的 **`key`**（`monitor + gid + 下标`）而不是指令文本，运行期现查，
  所以面板里改了指令、流程跟着变；③ 查不到（条目被删）时按保存时的文本兜底发送，
  并置 `msg.stale = true` + `node.warn` —— 不能假装同步成功。
- **`serial request` 的语义（2026-11）**：一条输入 = 一次事务，内部顺序固定为
  **清空旧数据（bridge read 丢弃）→ 写串口 → 收窗口**。窗口在「命中任一结果分支 / 静默 / 最长」
  中任一条件满足时收口，只输出一条消息：`payload`（按回复格式）、`raw`、`cmd`、`bytes`、
  `elapsedMs`、`matched`、`matchedIndex`、`matchedType`、`timedOut`、`reason`（`rule`/`timeout`/`quiet`）。
  **结果分支是动态输出口**（与 switch 同一套用法）：默认 `OK` / `ERROR` 两个连接点，每个条件一个口，
  点「添加条件」就多一个连接点；条件类型有 `包含` / `等于` / `正则` / `未匹配或超时`（兜底，只有前面都没命中才走）。
  没配兜底条件时，未匹配/超时的结果会被丢弃（状态标黄 + `node.warn`），不会假装成功。
  同一节点内请求串行排队（上限 32 条），所以两段回复不会混在一起。
  ⚠️ 它自己会读桥的接收队列，**同一个端口（分栏）上不要再放 `serial rxd`**（单消费者，会互相分走数据）。
  ⚠️ 设备开着回显（ATE1）时命令会被原样回显，可能提前命中条件 —— 建议 `ATE0`。
- **「端口」下拉的数据来源**（2026-11）：编辑器是另一个 origin、拿不到宿主桥的令牌，所以由侧车
  注册一条 Node-RED 管理路由 `GET /seahi-serial/monitors`，它再用桥的新 op `{"op":"monitors"}`
  问宿主。宿主列**两类**分栏：① 串口分栏 `main` / `extra-N`（Rust 侧 reader，端口名/波特率用
  `try_lock` 取，读线程正卡在 `read()` 上时只回 id，不堵串口）；② WSL 分栏 `wsl` / `wsl-xN`
  （会话在 `WslSerialState`，端口名是它打开的 `/dev/ttyUSB0`，展示成 `/dev/ttyUSB0 · 115200`）。
  顺序固定：主分栏 → 额外分栏（按数字）→ WSL 分栏（按数字）→ 其它（`bridge_monitor_sort_key`）。
- 已保存但当前没打开的分栏会标「当前未打开」并保留原值；侧车还是旧版时显示
  「读取失败，保留原值」，点「刷新」重试 —— **一次打开对话框不会悄悄改掉配置**。
- **Node-RED 发出去的数据会出现在串口监视窗口**（用户 2026-11 要求："除非关闭了消息回显"）：
  `bridge_write` 成功后宿主 `emit('nodered-sent', {monitor, hex})`，前端 `nfOnSent()` 走**与手动发送同一条**
  `appendOutput(mid,'send',…)` —— 行号、时间戳、日志中心 `serial:<分栏>:tx`、MCP 的 `serial_get_output` 全都有，
  来源标 `auto`。是否显示只看该分栏「消息回显」按钮（`#<mid>-btnEcho`）—— 关掉时窗口与日志中心都不写，
  与手动发送完全一致；含控制字节的二进制帧显示成 `HEX: …`，可打印文本原样显示。
- **默认文本**（用户 2026-11 明确要求）：`serial rxd` 的 `payload` 是 UTF-8 字符串，不再是 Buffer；
  跨数据块被切断的半个汉字由 `StringDecoder` 留到下一块拼接，不会变成 U+FFFD。
- `HEX`：收方向输出小写、无分隔符的十六进制串（`4f4b0d0a`）；发方向把 payload 当十六进制串解析，
  **不追加行尾**。
- `Buffer`（仅收）：保持原始字节，与官方串口节点一致，适合二进制协议。
- 任何格式下 `serial rxd` 都附带 `msg.raw`（原始 Buffer），按字节核对时不用切回 `Buffer` 模式。
- **兼容**：老流程里的 `asHex:true` 继续按 HEX 处理（构造函数在没有 `format` 时回退到它）；
  编辑器打开旧节点会自动把「格式」显示成 HEX。
- 断言：`node .walkthrough/nodered_nodes_test.js`（假桥 + 假 RED，74 条，覆盖三种格式、跨包 UTF-8、
  行尾、非法 HEX、老字段兼容、监视器下拉接口与 id 透传，以及 `serial request` 的清旧数据、
  默认两条分支 / 动态输出口 / 兜底分支 / 超时 / HEX 发送）。

## 4.2 WSL 分栏上的自动化（2026-11）

WSL 分栏与串口分栏在编辑器里是同一套节点、同一个「端口」下拉，但数据通路不同，别把两者混为一谈：

| 方向 | 串口分栏 | WSL 分栏 |
|---|---|---|
| 写 | `bridge_write` 直接写 `PortState` 里的端口 | `bridge_write` 回落到 `WslSerialState` 的会话，走 Python bridge 的 `{"cmd":"write"}` |
| 读 | 读线程每收一块就 `bridge_push_rx` 复制进桥队列 | **`read_wsl_serial` 把同一块字节复制进桥队列**（WSL 没有 Rust 侧读线程） |
| 数据产出点 | 常驻读线程（与界面无关） | 前端轮询（`wsl` 面板可见 25ms / 隐藏 500ms） |

四条别改回去：

1. **WSL 的读只有 `read_wsl_serial` 这一个产出点**：不在这里复制，`serial rxd` 在 WSL 分栏上
   永远收不到数据（而且现象是"什么都没发生"，没有任何报错）。
2. **回主界面时不再 `stopReading(wmid)`**（`restoreMonitorPane`）：停了就等于"用户一离开 WSL
   页面，在那上面编排的流程静默断流"。频率交给 `refreshMonitorPollRates()` 降到 500ms，
   与隐藏的串口分栏同一套口径。
3. **WSL 会话的命令必须串行**（`WslSerialSession.cmd`）：会话只有一条 stdout 响应通道，
   前端 25ms 轮询的 `read` 与桥的 `write` 并发时，`bridge_command` 会互相取走对方的回执。
4. **写入只有一份实现** `wsl_session_write`：前端「发送」和桥共用它，别各写一套。

代价：WSL 分栏上的收数据延迟受轮询档位限制（可见 25ms、隐藏 500ms），`serial request` 的
「静默 80ms」在隐藏档下要靠一次轮询就带回整段回复；要低延迟就把 WSL 页面留在前台。

## 5. settings.js 的关键项（都有实测依据）

| 配置 | 为什么 |
|---|---|
| `uiHost: "127.0.0.1"` | 不设就会绑 0.0.0.0 → Windows 防火墙每次弹窗 + 局域网能打开这个无鉴权的编辑器 |
| `nodesExcludes: [...]` | 去掉「网络 / 存储」两个分类（按**文件名**过滤，同名 .html 一起跳过） |
| `externalModules.palette.allowInstall: false` | 不 spawn npm（也才敢把 npm 换成桩） |
| `telemetry.enabled: false` | 运行期不出网 |
| `lang: "zh-CN"` | 界面中文 |
| `editorTheme.palette.categories.order` | 把「串口」排最前，用户不用在 31 个节点里找 |
| `credentialSecret: false` | 换机器/重装后 flows 里的凭据还能读 |

## 6. 踩过的坑（按踩到的顺序）

1. **`\\?\` verbatim 路径**：Tauri 的 `BaseDirectory::Resource` 返回 `\\?\D:\...`，直接当 node 的入口脚本会报
   `EISDIR: illegal operation on a directory, lstat 'D:'`。用 `nodered_plain_path()` 剥前缀。
2. **同步命令阻塞 UI**：`nodered_open` 里 sleep 会卡住窗口。改成 `async` + `spawn_blocking`，
   并在等待时用 `child.try_wait()` 提前发现"起来就退出"。
3. **`nodesExcludes` 才是官方开关**：`@node-red/nodes/package.json` 在 5.x 里**没有** `node-red` 清单段，
   核心节点是扫目录加载的。直接删目录也行，但没必要。
4. **`nodesDir` 不管用**：它只用于按模块名查找，不参与启动时的调色板加载。自定义节点要投递到
   `<userDir>/nodes/`。
5. **只覆盖不清理**：删掉的节点会永远留在 `%APPDATA%\...\nodes\` → 调色板里"复活"。
   现在投递前先删除目标目录里源中已不存在的 `.js/.html`。
6. **dev 里的 stale 副本**：Tauri 只在构建时把 resources 拷进 `target\debug\resources`，删掉的文件不会消失。
   debug 构建现在**优先用 `CARGO_MANIFEST_DIR/resources`**。
7. **iframe 白闪（已不适用，留作历史）**：内嵌时 `.nf-stage` 用过白底 + 每次打开都重设 `src`（整页重载）。
   当时的解法是"底色跟主题 + 加载完成前 `opacity:0` + 已加载就不碰 `src`"。2026-11 换成独立窗口后，
   这两条实现随覆盖层一起删了；新窗口每次打开就是一次正常页面加载，不存在"白闪"。
8. **`spawn EINVAL`**：Windows 上 Node ≥18.20 不许不经 shell 执行 `.cmd`。npm 要用
   `process.execPath + npm_execpath` 跑，不能 `execFileSync('npm.cmd')`。
9. **防火弹窗**：见 `uiHost`。
10. **回执不带 `id` = 所有调用都超时**（2026-11-19 真机验证踩到）：node 侧 `bridgeCall` 按 `id`
   匹配回执，而 `bridge_serve` 最初只回 `{"ok":true,"written":N}`。握手是通的（hello 回执专门
   用 `ok && !ready` 识别），所以现象不是"连不上"，而是"串口也开着、每个 send/read 都等到超时"。
    修复在 `main.rs` 的 `bridge_attach_id()`，并由 `bridge_reply_echoes_request_id` 守着。
    假桥如果回执带 id、真宿主不带，两端单测都会绿 —— 这也是为什么 `.walkthrough/nodered_nodes_test.js`
    的假桥**刻意按真宿主的行为**（握手无 id、业务回执必须带 id）来写。
11. **编辑器改成独立窗口（2026-11，用户定的方向）**：用户的原话是"它属于一个全局的界面，不可能跟着分栏
    一次存在"，同时要求"编辑流程的同时还能查看窗口数据情况"。于是整条 `#nodeflow-pane` 覆盖层（`nfPlace` /
    `nfAttach` / `nfDetach` / `nfShowHost` / `#nodeflow-pane` 的 absolute 定位 / `05-nodeflow.css`）**整段删除**，
    改为：工具栏图标 → `openNodeRed()` → `nodered_open_window` → Rust 建窗口**直接加载** `http://127.0.0.1:<port>/`
    （不是 iframe，剪贴板/快捷键/DevTools 都正常）。三条口径：**已开就 show + focus**（两个编辑器改同一份
    `flows.json` 会互相覆盖，那文件没有冲突检测）；**关窗不杀引擎**（流程继续跑，杀侧车只有"退出应用"与
    `nodered_stop` 两个时机）；**关主窗口要一并关掉编辑器窗口**（否则应用不退出，只剩一个没有主界面的空壳）。
    顺带消失的两个旧坑：搬 iframe 会让编辑器重载（未部署的删除"复活"）、以及在 WSL 分栏点图标会被切回主界面。
12. ⚠️ **嵌入态不许写窗口几何**：子窗口的 `outer_position()` 是**相对父窗口客户区**的（实测写出 `{"x":0,"y":116,…}`），
    下次打开就会把编辑器摆到左上角、尺寸变成分栏正文区大小。`nodered_persist_geometry` 里第一句就是
    `if NODERED_DOCKED { return; }`，文件保留"最后一次独立窗口"的位置（`.walkthrough` 有断言钉着）。
13. **窗口几何单独一个文件**：`%APPDATA%\seahi-serial\nodered-window.json`（**别塞进主窗口的 `window.json`**，
    两个窗口会互相覆盖对方的几何）。首次打开摆主窗口右侧、放不下就偏右下并夹进当前屏幕；最小化时不写盘
    （系统会给 `-32000` 这类哨兵坐标，写进去下次就把窗口甩到屏幕外 —— 与主窗口同一套纪律）。
14. **编辑器窗口的框必须与主窗口同款（自绘标题栏）**（2026-11，用户："这两个窗口的风格都不一样"）：
    窗口 `decorations(false)` + `src/node-red-window.html`。三条别改回去：① 标题栏数值**照抄**主窗口
    （36px / `var(--toolbar-bg)` / 12px 左内边距 / 按钮 46×36 / hover 白 8% / 关闭 `#e81123`），
    改一边就要改另一边 —— `.walkthrough` 用两侧 CSS 对账（高度、按钮尺寸、关闭 hover 色）钉着；
    ② 拖动**由脚本接管**（`86-node-red-window.js` 的 `nrBindDragOut`：独立态调 `startDragging()`，
    嵌入态先脱离再拖）。⛔ **不要改回 `data-tauri-drag-region`** —— 嵌入态下它会把拖动变成
    "在父窗口里挪子窗口"，永远拖不出去（2026-11 实测）；双击标题栏最大化也要自己补（系统不再代劳）；
    ③ `capabilities/default.json` 的 `windows` **必须包含 `nodered`** —— 窗口按钮走 `core:window:*`，
    不在 capability 里的窗口会被 ACL 拦掉，表现是"按钮点了没反应、控制台一条 deny"。
    外壳页只做"标题栏 + iframe"，**不要在 iframe 里塞第二个界面**（那就变成自绘 Node-RED 了，早就否掉）。
15. ⚠️ **重开编辑器不能"先闪一个大窗口"**（用户 2026-11："点关闭按钮关掉编辑器，重新打开时会有另外的窗口闪烁"）：
    以前窗口按保存的几何居中创建、等前端算好矩形再 `SetParent`，中间那一两帧就是"另一个窗口"。现在的做法是
    **前端先把停靠矩形算出来传给 `nodered_open_window`**，Rust 直接按矩形建窗（`init_w/h/x/y`），
    建完**立刻** `nodered_dock`（不等前端第二跳）—— 窗口第一次绘制时已经是子窗口。实测重开 3 秒内
    "可见的顶层 Node-RED 窗口"采样 **0 次**。
16. ⚠️ **不能改成"隐藏创建（`visible(false)`）再显示"**：WebView2 在隐藏态收不到尺寸通知，直接 `show()` 出来
    是**一片空白**（Node-RED 只画了顶上一条、下面全黑 —— 用户 2026-11 截图报过）。要用隐藏创建就必须在
    `show()` 之后做一次**真·1px 尺寸抖动**（同尺寸 `set_size` 会被 wry 当 no-op 跳过，不会通知 WebView）。
    现在的实现两者都用了：隐藏创建 + 贴好 + `show()` + 1px 抖动，既没有闪窗、渲染也正常。
17. ⚠️ **`nodered_hwnd_of` 不能过滤不可见窗口**：它靠枚举本进程顶层窗口 + 标题匹配来拿 HWND
    （tao 的 `hwnd()` 对这个窗口给不出句柄）。窗口是隐藏创建时，"找句柄"恰好发生在 `show()` 之前 ——
    加了 `IsWindowVisible` 过滤就永远拿不到，日志是 `nodered_hwnd_of: 枚举不到窗口（标题=""）`，
    表现为"点了图标窗口不贴进正文区、1.5 秒后自己飘出来"。
18. ⚠️ **删 HTML 行时核对 div 配平**：给外壳页加"上边沿拖拽条"又删掉时，脚本把标题栏的 `</div>` 一起删了，
    结果 `<iframe>` 被塞进 26px 的标题栏 flex 行 —— Node-RED 只画顶上一条、下面全黑（用户 2026-11
    "你改的这个界面完全就是不对的呀"）。`<div`/`</div>` 计数对账是这类事故最快的自查。
19. ⚠️ **脱离时不许"整份样式覆盖"**（用户 2026-11 截图报的「拖动脱离出现这个 bug」：窗口顶上是
    系统浅蓝标题栏、内容一片黑）：停靠时我们保存了一份 `NODERED_STYLE`，脱离时 `SetWindowLongW(GWL_STYLE, st)`
    整份写回去 —— 那份样式是**停靠态（子窗口）**时抓的，写回去会把 tao 给无边框顶层窗口设的其它位一起写脏，
    于是 Windows 把标题栏画了出来、WebView 的绘制也跟着坏掉。**正确做法是只加回被摘掉的那两个位**：
    `cur | WS_THICKFRAME | WS_MAXIMIZEBOX`，再 `SetWindowPos(… SWP_FRAMECHANGED)` 让非客户区重算。
    实测（截图核对）：脱离后是自绘标题栏 + Node-RED 完整渲染；拖回主窗口上方松手能正常吸附回停靠。



## 7. 快速指令的 DSL 已停用（与 Node-RED 无关，但同一时期改的）

「等回话 / 期望 / 重试 / 跳转」这套语义与 Node-RED 的自动化重叠，已按用户要求停用：

- 前端 `QCMD_DSL_UI_ENABLED = false`（`50-quickcmd.js` 顶部），`qcmdItemWaits()` 恒 false
- Rust 四个 `qcmd_hs_*` 命令的实现整段注释（签名保留，arm 恒 false / state 恒 idle）
- MCP `serial_quick_cmd` 撤下 `expect/retry/okGoto/errGoto`，传了显式 -32602
- **循环发送没动**：照旧按顺序号发，节奏由「超时」决定
- 文件里已有的这几列**照旧解析与写回**（不静默改写用户文件）
- 断言集里 22 条 DSL 用例改成 `checkDsl()`，开关打开就恢复执行

恢复方法：`QCMD_DSL_UI_ENABLED = true` + 取消 Rust/MCP 里的注释。

## 8. 待办

- [ ] **真机验证**：接收方向已在 COM17 上收到字节（2026-11-19）；发送方向的 id 回执修复后待复测
- [ ] 轮询 → 推送：现在是节点每 100 ms 拉一次，最坏延迟 100 ms；改成桥主动推可以做到零延迟
- [ ] 预置一条示例流程（inject → serial txd），让用户第一次打开就有东西可改
- [x] 把 `serial rxd` 的 Buffer → 字符串转换做成节点选项（2026-11：`格式` 三选一，默认文本）
- [ ] 许可证合规：随包分发 Node-RED（Apache-2.0）需要带 LICENSE/NOTICE，并扫描依赖树有没有 GPL

## 9. 已知限制

- 侧车随应用启动、**关编辑器窗口也不停**（自动化要一直跑）；代价是常驻约 80 MB + 一个回环端口
- 一个应用实例只能有一个 Node-RED（共用同一个用户目录），**也只能有一个编辑器窗口**（重复点图标只是把它切到前面）
- **未部署的修改在关窗时丢弃**：窗口一关 WebView 就销毁，与浏览器里关掉编辑器标签页一致（`flows.json` 里
  只有「已部署」的内容）。想保住草稿就别关窗口，或先「部署」
- 编辑器窗口是**独立顶层窗口**，不跟随主窗口最小化；主窗口关闭时它会一起关掉
- 卸载不清理 `%APPDATA%\com.seahi.seahi-serial\node-red`（有意：升级不丢流程）
- **WSL 分栏的数据产出点仍是前端轮询**（见 4.2）：隐藏时降到 500ms，所以后台流程拿到的数据
  最多晚半秒；`serial request` 这类"发一条等一段"的时序在隐藏档下会偏保守（靠一次轮询带回整段）。
- **同一个监视器只放一个 `serial rxd`（或 `serial request`）**：桥的接收队列是单消费者（`bridge_take_rx` 取走即清），
  两个节点监听同一个分栏会互相分走数据块。需要多处使用时，接一个节点再往下游分叉。
