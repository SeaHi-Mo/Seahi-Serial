# Node-RED 集成（自动化画布）

> 状态：**可用，但真机串口收发尚未验证**（2026-11）。
> 本文是给下一个接手的人/另一台机器用的：架构、构建、已经踩过的坑、待办，都在这里。

## 1. 为什么是内嵌 Node-RED

需求是"用户自己编排自动化流程"（串口收数据 → 判断 → 自动发下一条 → 循环）。
自己画一套画布等于重造 Node-RED，且没有执行语义；所以**直接内嵌 Node-RED 本体**（Apache-2.0，可商用）。

早期写过一版自绘节点画布（`85-nodeflow.js` 的第一版），**已全部删除**——它只有画布、没有引擎。
现在 `85-nodeflow.js` 只是一个启动器：调后端拿地址，塞进 iframe。

## 2. 架构

```
Tauri 主窗口（WebView2）
 ├── 工具栏 Node-RED 图标 ──► openNodeFlow(mid)
 │                              ├─ invoke('nodered_open') → 返回 http://127.0.0.1:<port>/
 │                              └─ iframe.src = 该地址（挂在监视器工具栏下面）
 │
 └── Rust 宿主进程（独占 COM 口）
      ├── 侧车：node.exe + node_modules/node-red + settings.js（随安装包分发）
      ├── 桥：回环 TCP，换行分隔 JSON，一次性令牌
      │      node 侧发 {"op":"send","monitor":"main","hex":"…"} → 写串口
      │      节点轮询 {"op":"read",…} → 取走读线程复制的字节
      └── 用户数据：%APPDATA%\com.seahi.seahi-serial\node-red\（flows.json 等）
```

**关键约束：串口由 Rust 独占。** 节点绝不自己 open COM 口（会和监视器、DTR/RTS、WSL 映射抢），
只通过桥跟宿主说话。

## 3. 文件清单

| 路径 | 作用 |
|---|---|
| `src/js/85-nodeflow.js` | 前端启动器：调 `nodered_open`、设 iframe、防白闪、错误展示 |
| `src/css/05-nodeflow.css` | 只有容器 + 遮罩（没有标题栏/按钮，开关由工具栏图标负责） |
| `src-tauri/src/main.rs` | `nodered_open/stop`、侧车启停、桥服务器、节点投递（搜 `nodered_` / `bridge_`） |
| `src-tauri/resources/node-red/settings.js` | 离线固化配置（见下） |
| `src-tauri/resources/node-red/package.json` | 运行时依赖清单（只有 `node-red@5.0.10`） |
| `src-tauri/resources/node-red/local-nodes/seahi-serial.{js,html}` | **唯一的自研节点包**：`serial in` / `serial out` / `serial request` |
| `scripts/prepare-nodered.mjs` | 生成运行时：npm install → 裁分类 → 拷 node.exe → 可选 npm 桩 |
| `installer.iss` | Inno 安装器追加拷贝 `{app}\resources\node-red` |

## 4. 构建与运行

```bash
npm run prep:nodered -- --slim   # 一次性：装 node-red 依赖 + 拷当前 node.exe（约 172 MB / 9600 个文件）
npm run dev                      # 之后正常开发
```

- **必须**先跑 `prep:nodered`，否则打开画布会报「缺少 node.exe」
- `--slim` 把 `node_modules/npm` 换成百字节桩（省 11.7 MB）。安全性：`allowInstall=false` 时
  Node-RED 只用它算 CLI 路径，永不执行
- 打包：`npm run build`，产物里 `resources/node-red` 会被带上；Inno 那条 Source 从
  `src-tauri\resources\node-red\*` 直接取

## 4.1 seahi-serial 节点参数（2026-11）

| 节点 | 字段 | 默认 | 说明 |
|---|---|---|---|
| `serial in` | 端口 | 第一个已打开的 | **下拉**：宿主里当前已打开的串口，显示 `COM17 · 115200`；value 仍是分栏 id（桥按 id 取数），带「刷新」 |
| | 格式 | `文本` | `文本` / `HEX` / `Buffer`；见下 |
| | 轮询 ms | `100` | 最小 20 |
| `serial out` | 端口 | 第一个已打开的 | 同上（显示端口，value 是该分栏的 id） |
| | 格式 | `文本` | `文本` / `HEX` |
| | 行尾 | `CRLF` | 只在文本模式生效 |
| `serial request` | 端口 | 第一个已打开的 | 同上 |
| | 发送 / 回复格式 | `文本` / `文本` | 发：`文本`/`HEX`；收：`文本`/`HEX`/`Buffer` |
| | 行尾 | `CRLF` | 只在文本发送模式生效 |
| | 最长 ms / 静默 ms | `1000` / `80` | 窗口上限；收到字节后连续静默多久收口 |
| | 结果分支 | `OK` / `ERROR` | **一个条件一个连接点**（包含/等于/正则/未匹配超时），可添加 |

- **`serial request` 的语义（2026-11）**：一条输入 = 一次事务，内部顺序固定为
  **清空旧数据（bridge read 丢弃）→ 写串口 → 收窗口**。窗口在「命中任一结果分支 / 静默 / 最长」
  中任一条件满足时收口，只输出一条消息：`payload`（按回复格式）、`raw`、`cmd`、`bytes`、
  `elapsedMs`、`matched`、`matchedIndex`、`matchedType`、`timedOut`、`reason`（`rule`/`timeout`/`quiet`）。
  **结果分支是动态输出口**（与 switch 同一套用法）：默认 `OK` / `ERROR` 两个连接点，每个条件一个口，
  点「添加条件」就多一个连接点；条件类型有 `包含` / `等于` / `正则` / `未匹配或超时`（兜底，只有前面都没命中才走）。
  没配兜底条件时，未匹配/超时的结果会被丢弃（状态标黄 + `node.warn`），不会假装成功。
  同一节点内请求串行排队（上限 32 条），所以两段回复不会混在一起。
  ⚠️ 它自己会读桥的接收队列，**同一个端口（分栏）上不要再放 `serial in`**（单消费者，会互相分走数据）。
  ⚠️ 设备开着回显（ATE1）时命令会被原样回显，可能提前命中条件 —— 建议 `ATE0`。
- **「端口」下拉的数据来源**（2026-11）：编辑器是另一个 origin、拿不到宿主桥的令牌，所以由侧车
  注册一条 Node-RED 管理路由 `GET /seahi-serial/monitors`，它再用桥的新 op `{"op":"monitors"}`
  问宿主。宿主只回 **Rust 侧真有 reader 的串口分栏**（WSL 分栏的读在 Python 侧、桥也写不进去，
  列出来只会让人选到一个必然失败的 id）；端口名/波特率用 `try_lock` 取，读线程正卡在 `read()`
  上时只回 id，不堵串口。
- 已保存但当前没打开的分栏会标「当前未打开」并保留原值；侧车还是旧版时显示
  「读取失败，保留原值」，点「刷新」重试 —— **一次打开对话框不会悄悄改掉配置**。
- **Node-RED 发出去的数据会出现在串口监视窗口**（用户 2026-11 要求："除非关闭了消息回显"）：
  `bridge_write` 成功后宿主 `emit('nodered-sent', {monitor, hex})`，前端 `nfOnSent()` 走**与手动发送同一条**
  `appendOutput(mid,'send',…)` —— 行号、时间戳、日志中心 `serial:<分栏>:tx`、MCP 的 `serial_get_output` 全都有，
  来源标 `auto`。是否显示只看该分栏「消息回显」按钮（`#<mid>-btnEcho`）—— 关掉时窗口与日志中心都不写，
  与手动发送完全一致；含控制字节的二进制帧显示成 `HEX: …`，可打印文本原样显示。
- **默认文本**（用户 2026-11 明确要求）：`serial in` 的 `payload` 是 UTF-8 字符串，不再是 Buffer；
  跨数据块被切断的半个汉字由 `StringDecoder` 留到下一块拼接，不会变成 U+FFFD。
- `HEX`：收方向输出小写、无分隔符的十六进制串（`4f4b0d0a`）；发方向把 payload 当十六进制串解析，
  **不追加行尾**。
- `Buffer`（仅收）：保持原始字节，与官方串口节点一致，适合二进制协议。
- 任何格式下 `serial in` 都附带 `msg.raw`（原始 Buffer），按字节核对时不用切回 `Buffer` 模式。
- **兼容**：老流程里的 `asHex:true` 继续按 HEX 处理（构造函数在没有 `format` 时回退到它）；
  编辑器打开旧节点会自动把「格式」显示成 HEX。
- 断言：`node .walkthrough/nodered_nodes_test.js`（假桥 + 假 RED，59 条，覆盖三种格式、跨包 UTF-8、
  行尾、非法 HEX、老字段兼容、监视器下拉接口与 id 透传，以及 `serial request` 的清旧数据、
  默认两条分支 / 动态输出口 / 兜底分支 / 超时 / HEX 发送）。

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
7. **iframe 白闪**：`.nf-stage` 用过白底 + 每次打开都重设 `src`（整页重载）。现在：底色跟主题、
   加载完成前 `opacity:0`、已加载就不碰 `src`。
8. **`spawn EINVAL`**：Windows 上 Node ≥18.20 不许不经 shell 执行 `.cmd`。npm 要用
   `process.execPath + npm_execpath` 跑，不能 `execFileSync('npm.cmd')`。
9. **防火弹窗**：见 `uiHost`。
10. **回执不带 `id` = 所有调用都超时**（2026-11-19 真机验证踩到）：node 侧 `bridgeCall` 按 `id`
   匹配回执，而 `bridge_serve` 最初只回 `{"ok":true,"written":N}`。握手是通的（hello 回执专门
   用 `ok && !ready` 识别），所以现象不是"连不上"，而是"串口也开着、每个 send/read 都等到超时"。
    修复在 `main.rs` 的 `bridge_attach_id()`，并由 `bridge_reply_echoes_request_id` 守着。
    假桥如果回执带 id、真宿主不带，两端单测都会绿 —— 这也是为什么 `.walkthrough/nodered_nodes_test.js`
    的假桥**刻意按真宿主的行为**（握手无 id、业务回执必须带 id）来写。

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
- [ ] 预置一条示例流程（inject → serial out），让用户第一次打开就有东西可改
- [x] 把 `serial in` 的 Buffer → 字符串转换做成节点选项（2026-11：`格式` 三选一，默认文本）
- [ ] 许可证合规：随包分发 Node-RED（Apache-2.0）需要带 LICENSE/NOTICE，并扫描依赖树有没有 GPL

## 9. 已知限制

- 侧车随应用启动、关画布不停（自动化要一直跑）；代价是常驻约 80 MB + 一个回环端口
- 一个应用实例只能有一个 Node-RED（共用同一个用户目录）
- 卸载不清理 `%APPDATA%\com.seahi.seahi-serial\node-red`（有意：升级不丢流程）
- **同一个监视器只放一个 `serial in`（或 `serial request`）**：桥的接收队列是单消费者（`bridge_take_rx` 取走即清），
  两个节点监听同一个分栏会互相分走数据块。需要多处使用时，接一个节点再往下游分叉。
