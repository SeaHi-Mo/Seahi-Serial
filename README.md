# SeaHi Serial

一款基于 **Tauri 2 + Rust** 的轻量级串口调试桌面工具，VS Code Serial Monitor 风格界面。

![Tauri](https://img.shields.io/badge/Tauri-2-blue?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-2021-orange?logo=rust&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-Windows-blue?logo=windows&logoColor=white)

<div align="center">
<img src="./doc/IMG/SeahiSerial_main.png" width="30%">
<img src="./doc/IMG/SeahiSerial_wsl.png" width="30%">
</div>

## 功能特性

- **多串口同时连接** — 同窗口分栏显示，每个分栏独立操作互不干扰
- **完整串口配置** — 波特率（支持自定义输入）、数据位、停止位、校验位
- **DTR / RTS 实时切换** — 一键切换高低电平，适配不同硬件复位需求
- **发送历史记录** — 每栏独立保存最近 50 条发送记录，支持上下键快速回填
- **快速指令** — 自定义常用命令一键发送；支持**循环组**、**发一条等它回话**（超时 / 重试 / 成功与失败跳转）、
  可挂到外部文件上双向写回（见下文「快速指令」）
- **自动化工作流** — 「收到匹配数据 → 自动执行动作（发数据 / 切 DTR·RTS / 存日志）」，规则可启停，命中会写进独立日志通道
- **ANSI 颜色解析** — 自动解析转义序列，以对应颜色显示
- **终端模式** — 输出区模拟终端交互
- **自动重连** — 串口断开后自动尝试重新连接
- **原生日志导出** — 通过系统文件对话框选择日志保存路径
- **日志隐形缓存** — 每次打开串口后如有收发内容，自动缓存本次会话日志，最多保留 10 个文件、新建时自动淘汰最旧的
- **12 种主题** — 6 种风格（默认、浮世绘彩、诗意东方、水墨丹青、桃之夭夭、金风玉露）× 深浅色
- **WSL 端口映射** — 通过 usbipd-win 将 USB 串口映射到 WSL 环境（含自动映射与授权窗口）
- **WSL 串口监控** — 在 WSL 内直接调试串口设备
- **蓝牙调试（主机方向）** — 扫描周边 BLE 设备（含原始广播字节解析、设备类型识别、RSSI），
  连接后浏览 GATT 服务树并读写特征 / 描述符、订阅通知与指示、WinRT 配对；
  **服务名与特征名来自 Bluetooth SIG 官方 UUID 表**（78 个服务 + 512 个特征）；
  **CTS（Current Time Service）时间会就地翻成人话**：`2A2B` 时间本身 / `2A0F` 时区与夏令时 /
  `2A14` 这个参考时间可不可信（时间源、精度、距上次对时）
- **ADB 调试** — 设备列表与状态（`device` / `unauthorized`）、打开设备终端（xterm）、命令输入与 PTY 输出、
  改尺寸、关闭会话；被 ADB 占用的 `platform-tools` 由安装器在升级前自动停服
- **USB 设备插拔检测** — 设备插拔自动刷新列表
- **MCP 服务器（AI 控制接口）** — 程序内置 Model Context Protocol 服务器
  （**Streamable HTTP `POST /mcp` + 遗留 SSE 两种并存**，仅监听回环），把串口、蓝牙、ADB、日志、
  界面控件暴露成 **54 个内置工具**供 AI 客户端调用；工具操作**与前端界面实时同步**，
  调用记录写在独立的 `ai-calls.jsonl`，绝不污染用户配置
- **首次使用引导** — 9 步聚光灯引导，快速上手
- **自动更新** — 启动时检测 GitHub 最新版本

## 环境依赖

| 依赖 | 说明 |
|------|------|
| **Rust** | https://rustup.rs/ |
| **Node.js 18+** | https://nodejs.org/ |
| **Visual Studio Build Tools 2022** | 需勾选 "C++ 桌面开发" |
| **WebView2** | Windows 10/11 通常已预装 |

## 快速开始

```bash
# 克隆仓库
git clone git@github.com:SeaHi-Mo/Seahi-Serial.git
cd SeaHi-Serial

# 安装依赖
npm install

# 开发模式（热重载）
npm run dev

# 构建发布版 .exe
npm run build
```

构建产物位于 `src-tauri/target/release/seahi-serial.exe`

## 项目结构

```
serial-debugger-tauri/
├── src/
│   ├── index.html                # 前端骨架（head + body + 4 个 <link> + 15 个 <script src>）
│   ├── css/                      # 4 块样式（无打包器，按顺序 <link> 加载）
│   ├── js/                       # 15 块逻辑（普通脚本、共享全局作用域；见 doc/FRONTEND_LAYOUT.md）
│   │                             #   其中 81-ble-uuids.js 是**生成文件**（SIG 官方 UUID 名称表）
│   └── vendor/xterm/             # 终端模式用的 xterm（外部依赖，原样引入）
├── src-tauri/
│   ├── Cargo.toml                # Rust 依赖
│   ├── tauri.conf.json           # Tauri 应用配置
│   ├── capabilities/
│   │   └── default.json          # ACL 权限配置
│   ├── vendor/btleplug/          # btleplug 的 vendored fork（4 处本地补丁）
│   ├── wsl-daemon/               # WSL bridge 脚本（base64 编码）
│   └── src/
│       ├── main.rs               # Rust 后端（~7600 行）
│       └── mcp/                  # MCP 服务器（transport / protocol / bridge / registry /
│                                 #   loghub / calllog / aiconfig / report / mod）
├── npm/
│   └── seahi-serial-mcp/         # MCP 客户端配置安装器（零依赖 CLI）
├── skills/
│   └── seahi-serial-dev/
│       └── SKILL.md              # AI 开发技能指南
├── .walkthrough/                 # 无头断言集（gen_ble_preview.js）+ MCP 工具自检 + 两个生成器
├── doc/                          # 项目文档（MCP.md / MCP_TOOLS.md / MCP_DESIGN.md / QUICK_CMDS.md / FRONTEND_LAYOUT.md …）
├── RELEASE_NOTES.md              # 每个版本的发布说明（CI 按 tag 取对应段落作为 Release 正文）
├── installer.iss                 # Inno Setup 安装脚本
└── TEST_CASES.md                 # 测试用例
```

## MCP（AI 控制接口）

程序内置一个 **MCP（Model Context Protocol）服务器**，让 Claude Code / Claude Desktop / Cursor 等 AI 客户端直接操作本程序。

### 设计要点

| 项 | 说明 |
|------|------|
| **运行方式** | 与程序同进程（开箱即用，无需额外启动任何服务）；随程序启动自动监听 |
| **传输协议** | **两种并存**：① **Streamable HTTP**（`POST /mcp`，2025-03-26+ 规范，新版客户端默认走它）；② **遗留 SSE**（`GET /sse` 建立会话，`POST /messages` 发请求）。弹窗里还能选「仅 /mcp」或「仅 SSE」，选单档时另一条端点直接返回 404（立即生效，不用重启）。**只监听回环地址** |
| **鉴权** | 每次请求必须携带 token（`?token=` 或 `Authorization: Bearer`）；`/healthz` 是唯一免鉴权端点，且只回 `{"ok":true}` |
| **显隐** | 顶栏 MCP 图标 → 弹窗内「启用 / 关闭」一键切换；开关状态保存到 `ai-config.json` |
| **配置隔离** | 用户配置 `config.json` **完全不受影响**；AI 相关设置与调用记录单独存放（见下） |
| **AI 调用效率** | 握手时通过 `initialize.instructions` 一次性下发工作方式（先看状态→串口主流程→错误码语义→上限），让 Agent 第一次就做对；错误信息里直接给出可选值/下一步工具；**没有设备或界面时立刻失败**（不白等轮询超时）；限流回包带请求 id（客户端能对上号，不会挂到超时） |
| **读日志省 token** | `log_tail` / `serial_get_output` 支持 `format:"text"`（一行一条纯文本，同样内容比默认 JSON 省一半以上 token，正文在 `content[].text` 里、**一条都不会少看**）；`log_search` / `adb_shell_read` / `ble_get_output` 支持三档 `mode`：`count`（只回计数）/ `matches`（只回片段）/ `lines`（默认，回整行） |
| **只读（沙箱）模式** | 弹窗里一键打开后，AI **只能读、不能改**：所有写操作（`ui_set`/`ui_click`/`serial_open`/`serial_send`/`log_clear`/`mcp_config_set`…）一律被拒并返回 `-32007`，**界面与配置文件一个字都不变**。适合"先让 AI 自由探索、确认无误再放开"。⚠️ 这个开关**只能由用户在界面上关**（`mcp_config_set` 自己也是写工具，AI 打开后就关不掉了） |
| **危险动作二次确认** | 开 adb shell、写 adb 命令、运行工作流这类"会对外产生不可撤销影响"的工具，必须带 `confirm:true` 才执行（否则回 `-32006` 并说明后果）；界面上对应按钮对通用点击工具**不可见也点不动**，绕不过去 |
| **稳定性** | 会话数 / 队列长度 / 请求体大小 / 调用频率均有限额，空闲会话自动回收，日志中心按通道环形缓冲并有总量上限 |

### 内置工具（**54 个**：19 通用 + 16 串口语义 + 13 蓝牙语义 + 6 ADB）

| 分类 | 工具 |
|------|------|
| 应用信息 | `app_info`、`mcp_status`、`mcp_limits`、`serial_list_ports` |
| 串口语义（**优先用这些**，比按控件路径操作更准）| `serial_get_state`、`serial_select_port`、`serial_set_baud`、`serial_set_frame`、`serial_set_lines`、`serial_set_display`、`serial_open`、`serial_close`、`serial_send`、`serial_clear`、`serial_get_history`、`serial_get_output`、`serial_quick_cmd`、`serial_workflow`、`serial_workflow_run`（后者**危险**，要 `confirm`）|
| 蓝牙语义（主机方向）| `ble_get_state`、`ble_list_devices`、`ble_start_scan`、`ble_stop_scan`、`ble_connect`、`ble_disconnect`、`ble_get_services`、`ble_read`、`ble_write`、`ble_subscribe`、`ble_get_output`、`ble_refresh_rssi`、`ble_cts_time`（**纯后端**：把 CTS 的字节翻成人话）|
| ADB（shell）| `adb_list_devices`、`adb_open_shell`⚠️、`adb_shell_write`⚠️、`adb_shell_read`、`adb_shell_resize`、`adb_close_shell` |
| 界面控件 | `ui_list`、`ui_describe`、`ui_get`、`ui_set`、`ui_click`、`ui_get_state` |
| 日志中心 | `log_channels`、`log_tail`、`log_search`、`log_stats`、`log_clear` |
| MCP 自身 | `mcp_calls`、`mcp_stats`、`mcp_config_get`、`mcp_config_set`、`mcp_danger`（危险工具清单） |

典型的串口主流程：`serial_get_state` → `serial_select_port` → `serial_set_baud` → `serial_open` → `serial_send` → `serial_get_output`（看设备回了什么）→ `serial_close`。

蓝牙：`ble_get_state` → `ble_start_scan` → `ble_list_devices` → `ble_connect`（列表里没有就按 MAC 直连）→ `ble_get_services` → `ble_read` / `ble_subscribe` → `ble_get_output`（**CTS 的时间会自动翻成人话**）。
⚠️ **连上设备会同步停止扫描**（不用再调 `ble_stop_scan`，`ble_get_state.scanning` 会是 false）。

此外可选开启 `expose.autoControlTools`：程序启动时会扫描界面上的按钮 / 输入框 / 下拉框，按控件生成 `ctl_*` 工具（**默认关闭**——几百个工具会显著拖累模型选工具的准确率）。

### 文件位置

| 文件 | 内容 |
|------|------|
| `%APPDATA%\seahi-serial\ai-config.json` | MCP 服务器设置（开关、端口、token、暴露策略） |
| `%APPDATA%\seahi-serial\ai-calls.jsonl` | AI 工具调用记录（追加写，按大小轮转；默认不落盘，可在弹窗里开启） |
| `%APPDATA%\seahi-serial\mcp-endpoint.json` | 当前监听地址与 token（供安装器自动探测） |

### 客户端接入

```bash
# 一键写入客户端 MCP 配置（自动探测本机正在运行的程序实例）
npx seahi-serial-mcp install

# 只预览将要改动的内容，不落盘
npx seahi-serial-mcp install --dry-run

# 查看当前状态 / 卸载
npx seahi-serial-mcp status
npx seahi-serial-mcp uninstall
```

也可以在程序顶栏点击 MCP 图标，弹窗内直接复制「连接地址」与「安装提示词」手动配置。

> 详细使用说明见 [`doc/MCP.md`](./doc/MCP.md)；**54 个工具的完整参考（入参 + 返回结构）见 [`doc/MCP_TOOLS.md`](./doc/MCP_TOOLS.md)**；架构与设计取舍见 [`doc/MCP_DESIGN.md`](./doc/MCP_DESIGN.md)。

## 当前规模与测试

**这一版（v0.5.11）的实际规模**：**54 个内置工具**（19 通用 + 16 串口 + 13 蓝牙 + 6 ADB）、
传输为 **Streamable HTTP + 遗留 SSE 两种并存**、四批语义工具**全部落地**、
BLE **从机（外设）方向已整条删除**（实测本机广播起不来，证据留在 `doc/BLE_PERIPHERAL.md`）。

想知道**跑起来的这个实例**的实时状态，直接问程序（不用翻文档）：

```
mcp_status     # 工具数、会话、限流、日志中心、错误上报
mcp_limits     # 各项上限（请求体 / 每条指令长度 / 写入上限…）
ui_list        # 界面控件注册表（含面板 / 分组 / 是否禁用）
```

三套自动化测试都可以本地跑：`cargo test`（243 条 + 1 ignored）、`node .walkthrough/gen_ble_preview.js`（1612 条）、
`node npm/seahi-serial-mcp/test/self-test.js`（94 条）；对**正在运行的程序**跑工具自检用
`node .walkthrough/mcp_smoke.js`（54 个工具逐个真调）。

> 逐次的技术细节（改了什么、为什么、怎么验证的）记在 [`doc/MCP_DESIGN.md`](./doc/MCP_DESIGN.md) §17「实施记录」；
> 每个版本面向用户的说明在 [`RELEASE_NOTES.md`](./RELEASE_NOTES.md)。

## 技术栈

- **前端**：原生 HTML/CSS/JavaScript（**无框架、无打包器、无构建步骤**；已按功能拆成 4 个 CSS + 15 个 JS，见 `doc/FRONTEND_LAYOUT.md`）
- **后端**：Rust + `serialport 3.3` + `winapi 0.3` + `windows-sys 0.59`
- **桌面框架**：Tauri 2
- **原生对话框**：`rfd 0.15`
- **WSL 桥接**：Python bridge 脚本 + `usbipd-win`
- **蓝牙**：`btleplug 0.13`（主机，vendored fork）+ `windows 0.62`（配对）
- **ADB**：内置 `platform-tools` + 伪终端（`xterm.js` 只做显示）
- **MCP 服务器**：`hyper 1` + `hyper-util` + `http-body-util`（**Streamable HTTP `/mcp` + 遗留 SSE**，均随 `reqwest` 进入依赖树，无新增下载）

## 自动构建（GitHub Actions）

项目已配置 GitHub Actions 自动构建，推送版本 tag 后自动编译并创建 GitHub Release。

### 工作流配置

工作流文件位于 `.github/workflows/build.yml`，包含以下功能：

- **触发方式**：推送 `v*` 格式的 tag 时自动触发，也支持手动触发
- **运行环境**：`windows-latest`
- **缓存优化**：Rust 编译缓存，加速后续构建
- **自动发布**：构建完成后**直接发布正式 Release（latest）**，附带 MSI 与 exe 安装包
- **版本校验**：构建前先校验 tag 与 5 处版本号一致（不一致即失败，防止发出"版本号对不上"的包）

### 如何使用

```bash
# 1. 修改版本号（5 处必须一致，CI 会校验）
#    - src-tauri/Cargo.toml      中的 version
#    - src-tauri/tauri.conf.json 中的 version
#    - installer.iss              中的 MyAppVersion
#    - package.json               中的 version
#    - src-tauri/Cargo.lock       中 seahi-serial 条目的 version

# 2. 提交并推送代码
git add -A
git commit -m "v0.x.x: 更新说明"
git push origin main

# 3. 创建并推送版本 tag
git tag v0.x.x
git push origin v0.x.x

# 4. GitHub Actions 自动开始构建，完成后**直接发布为正式 Release（latest）**
#    无需手动操作（releaseDraft/prerelease/draft 均为 false）
```

### 手动触发构建

进入 GitHub 仓库 → **Actions** → **Build Release** → **Run workflow**，无需创建 tag 即可手动触发构建。

## 使用教程

### 界面总览

<div align="center">
<img src="./doc/IMG/SeahiSerial_main.png" width="30%" title="主界面">
<img src="./doc/IMG/SeahiSerial_wsl.png" width="30%" title="WSL端口映射界面">
</div>

界面分为以下区域：

| 区域 | 说明 |
|------|------|
| **全局操作栏** | 最顶部：**＋ 打开额外监视器**、**WSL 端口映射**、**ADB 调试**、**蓝牙调试**（四个面板入口）、主题风格选择、MCP 开关、提交 issue 和深浅色切换 |
| **工具栏** | 串口配置区：查看模式、端口选择、波特率、行尾、开始/停止监控，以及图标按钮组 |
| **输出区** | 中间大面积区域，显示接收到的串口数据 |
| **发送栏** | 底部输入框，支持文本/HEX 模式、发送历史、快速指令 |

### 快速上手

#### 第一步：选择串口并连接

1. 插入串口设备（如 USB 转串口线）
2. 点击工具栏的 **端口** 下拉框，选择目标端口
3. 根据设备需求配置波特率（默认 115200）
4. 点击 **▶ 开始监控** 按钮

#### 第二步：接收数据

连接成功后，输出区会实时显示设备发来的数据。可切换查看模式（文本/HEX）、显示行号、时间戳。

#### 第三步：发送数据

在底部输入框输入内容，按 Enter 或点击发送按钮。支持文本和 HEX 两种发送模式。

#### 第四步：高级设置

点击齿轮按钮展开高级设置：数据位、停止位、校验位、DTR/RTS 控制、日志保存。

### 进阶功能

#### 多串口同时监控

点击 **＋ 打开额外监视器** 可添加新分栏，每个分栏独立配置、独立连接。

#### 快速指令

监控输出区最右侧那条窄条就是快速指令分栏（默认折叠，点一下展开，拖动可调宽）。
指令按**循环组**分段：**一组一张表**（抬头 → 列标题 → 数据行）。

| 抬头上的东西 | 说明 |
|------|------|
| 参与开关 | 滑动开关，默认开。**关掉 = 这一组整组跳过**（顺序号原样保留，点回来即恢复） |
| 拖动握把 | 按住上下拖调组的顺序 —— **组的上下顺序就是循环顺序**，拖到最上面那组就是循环起点 |
| 组名 | 点一下改名（也可以改文件里那行 `## 抬头`） |
| 折叠箭头 | 收起这一组（列标题与数据行一起收，只留抬头） |
| 条数 / 删组 | 这一组有几条 / 删掉整组（最后一组删不掉） |

每组表头行最右还有一个 **`＋ 添加`**（往这一组加一条）。

每条指令一行六格：

| 格子 | 说明 |
|------|------|
| 顺序号 | 方形小框，默认 `0`。`0` = 不参与循环发送；大于 `0` 的**组内**按数字**从小到大**依次发送（参与的那几条**方框蓝底**标出来） |
| 指令内容 | 要发的内容，回车即发（文本模式；转义符如 `\r\n` 生效） |
| **超时(ms)** | 这条发出去后**最多等它回话多久**，默认 `3000`。**填 `0` = 这条不等回话**（发完就发下一条）。⚠️ 这一格以前叫「延时」、含义是"发完隔多久发下一条"，**已经变了**（老文件里叫「延时」也能用，按超时解读，导入时提示一次） |
| HEX | 本条的 HEX 使能，默认关闭。开启后本条按 HEX 解析发送（与主发送栏的文本/HEX 无关，可一条文本一条 HEX 混着跑） |
| 发送 / 删除 | 单独发这一条 / 删掉这一条 |

标题行左侧的 **「循环发送」** 开关点一下打开、再点一下关闭。它是**发一条、等它回话**的闭环：

| 收到的回话 | 下一步 |
|---|---|
| `busy` | 继续等（不算结论） |
| `OK` | 走**成功跳转**（默认下一条） |
| `ERROR` | **重发本条**（默认 3 次，可在文件里改）；重试用尽走**失败跳转** |
| 等满「超时」 | 也算失败，走**失败跳转**（配网失败多半是超时而不是 `ERROR`，只认 `ERROR` 这功能就没用） |

- 顺序：**组从上到下 → 组内顺序号从小到大**，一轮发完回到最上面那组。
- **分支与跳转**：文件里可以写两列 `成功跳转` / `失败跳转` —— 留空 = 下一条；数字 = 跳到那个顺序号；
  `结束` = 收尾停下。跳转目标不存在时**降级按「下一条」走**并说明原因（绝不静默乱跳）；
  连续跳转超过 200 次会自愈停止（防死循环）。
- **「期望」「重试」写在文件里**（面板上没有格子）：`期望` 是追加的成功词（`|` 分隔），
  `重试` 是收到 `ERROR` 后重发几次。超时那一格会描一道淡边、悬停能看到内容，免得"填了不生效"。
- 没连串口、或整条链上没有任何顺序号大于 0 的指令时会**拒绝开启**并说明原因；
  跑的过程中掉线、关掉分栏、或链上再没有可发的指令，都会**自动停止**并提示。
- 把分栏折叠起来循环**不会停**，折叠条底部会点一颗一闪一闪的小点提醒你。
  （循环发送的开关状态不随配置保存 —— 开机自动发指令太危险。）

指令列表还可以**挂到一个外部文件**上（标题行的「导入」）：挂上之后增删改都写回那个文件，
`#` 注释、表头、额外列都原样保留。**表格的表头写了哪几列就管哪几列**：
`| 名称 | 指令 | 顺序号 | 超时(ms) | 期望 | 重试 | 成功跳转 | 失败跳转 | HEX |` ——
没写这些列的文件按老规矩读（第 3 列起是你的备注，原样保留，绝不会被当成顺序号改写）。
文件里**每个 `## 组名` 抬头 + 下面那张表 = 一个循环组**；没有抬头的老文件就是一组（一字不动）。
「导出」得到的是一份**自包含副本**：一律带上这几列（纯指令行文件放不下时会升级成 Markdown 表格），
拿它换台机器导入，循环配置一项不丢。

> 文件格式的完整说明（列名/别名、分组抬头、注释与文件头、写回规则、上限、FAQ）
> 见 [`doc/QUICK_CMDS.md`](./doc/QUICK_CMDS.md)。

#### 蓝牙调试

顶栏切到蓝牙面板：点「开始扫描」搜索周边设备（列表里能看到名称、MAC、RSSI、设备类型与 iBeacon / Mesh 标记），
点设备卡片连接，连上后右侧展开 GATT 服务树 —— 服务与特征显示的是**官方名称**（来自 SIG 的 UUID 表），
可以读 / 写特征与描述符、订阅通知与指示。

- 连上设备后**扫描会自动停止**（不用手动关）。
- **设备不在列表里也能连**：被 Windows 配对过、或被别的主机连走的设备往往不再广播，
  用「按 MAC 直连」直接连（不依赖广播）。
- 服务树里认得出 **CTS（Current Time Service）**：读到 / 收到 `2A2B`（时间）、`2A0F`（时区与夏令时）、
  `2A14`（时间源 / 精度 / 距上次对时）时，数据日志里会紧跟原始 HEX 补一行**人话**
  （例如 `→ 2026-12-17T15:45:58.500Z（周四） · 设备时钟比本机快 …`），订阅后能直接看着设备时钟走。

#### ADB 调试

切到 ADB 面板：刷新设备列表（**只有 `device` 状态可用**；显示 `unauthorized` 表示设备上还没点「允许 USB 调试」），
选中设备打开终端（xterm），直接敲命令、看输出、改终端尺寸、关闭会话。

#### 自动化工作流

「更多设置 → 工作流」：**收到匹配的数据 → 自动执行动作**（发数据 / 切 DTR·RTS / 存日志）。
规则可启停；命中时会写进独立的 `workflow` 日志通道，事后能回查"刚才自动发了什么、什么时候发的"。
⚠️ 让规则跑起来是**危险动作**（会自动往设备发数据），面板上要点确认，AI 侧必须带 `confirm:true`。

#### 终端模式

点击终端模式按钮，输出区变为可编辑状态，直接打字发送。

#### WSL 端口映射

点击 **WSL 端口映射** 将 USB 串口映射到 WSL 环境，支持自动映射和手动映射。

#### 主题切换

支持 6 种风格 × 深浅色 = 12 种主题，点击全局栏的主题风格下拉和深浅色开关切换。

#### 日志隐形缓存

每次打开串口，只要产生收发内容，程序都会**自动**把本次会话的日志缓存到磁盘（无需手动保存），一个会话对应一个缓存文件。

- **缓存位置**：`%APPDATA%\seahi-serial\log-cache`（即 `C:\Users\<用户名>\AppData\Roaming\seahi-serial\log-cache`）
- **文件命名**：`session-<时间戳>-<端口>.log`
- **保留数量**：最多 **10 个**文件，超出后新建文件时自动删除最旧的，始终保留最近 10 个
- **触发时机**：打开串口后有收发数据时才生成文件；整个会话无任何收发内容则不产生文件
- **内容范围**：缓存的是接收与发送的日志内容（不含系统提示/错误提示等界面消息）

在资源管理器地址栏粘贴上述路径即可查看缓存文件。

### 键盘快捷键

| 按键 | 功能 |
|------|------|
| `Enter` | 发送输入框内容 |
| `↑` / `↓` | 浏览发送历史 |
| `Escape` | 关闭历史下拉列表 |

## License

MIT
