# AGENTS.md

## 项目简介

基于 Tauri 2 的串口/蓝牙调试桌面工具，**仅支持 Windows**。前端纯 HTML/CSS/JS（无框架、无构建步骤；
2026-09 拆成 `src/index.html` 骨架 + `src/css/*.css` + `src/js/*.js`，见 `doc/FRONTEND_LAYOUT.md`）；
后端 Rust（`src-tauri/src/main.rs` 主逻辑 + `src/mcp/` 模块）。

## 常用命令

```bash
npm install                                       # 前端依赖 (@tauri-apps/cli)
npm run dev                                       # 开发模式（热重载）
npm run build                                     # 发布构建 → src-tauri/target/release/seahi-serial.exe
cargo test --manifest-path src-tauri/Cargo.toml   # 后端单测（272 条 + 1 条 #[ignore] 手工联调用例）
node .walkthrough/gen_ble_preview.js              # 前端无头断言集（改前端后必跑）
node .walkthrough/mcp_smoke.js                    # 对**正在跑的应用**逐个真调工具（改 MCP 后必跑）

# 文档站（website/，VitePress；依赖只装在 website/ 里，别在根目录装）
# 以下在**仓库根目录**执行。`--prefix website` 是相对当前目录的 ——
# 在 website/ 里再写一次就变成 website/website（npm ENOENT 最常见的来源）
npm run docs:dev                                  # 本地预览 http://localhost:5173
npm run docs:build                                # 产物 → website/docs/.vitepress/dist
npm --prefix website install                      # 首次装依赖（等价 cd website && npm install）
```

无 lint / 类型检查。

> ⚠️ **`npm run dev` 跑完没窗口 → 先确认编译是否失败**（错误混在一屏日志里最像"还在编译"），
> 再走 [`skills/win-build-access-denied/SKILL.md`](./skills/win-build-access-denied/SKILL.md)（含本项目对照：
> 产物路径、进程名 `seahi-serial`、**主窗口 `visible:false` 是设计、4 秒兜底没显示才算故障**）。
> 铁律：**别急着改代码** —— 同一份代码换台机器就好，几乎必然是环境差异（NTFS 完整性标签 / 目录描述符被沙箱污染）。

- ⛔ **BLE 从机（外设）方向 2026-09 整条删除**（用户："实现不了了"）：适配器自报支持外设角色，实测**广播起不来**
  （`Aborted`）。别再往这个方向加功能；证据见 `doc/BLE_PERIPHERAL.md`（已归档）。BLE 只剩**主机方向**。
- 前端断言集 `.walkthrough/gen_ble_preview.js`（**1991 条**，随代码增补）：`vm` 沙箱抽真函数断言（源码正则 +
  假 DOM 行为断言）；`readFrontendSource()` 按标签顺序把 css/js **内联回"逻辑单文件"**再跑，所以跨 CSS/JS 的正则
  照旧有效，加新前端文件不用改断言集（只要标签写进 `index.html`）。改了 MCP 工具定义后重跑
  `node .walkthrough/gen_mcp_tools_doc.js` 生成 `doc/MCP_TOOLS.md`（断言守着"文档必须列出全部内置工具"）。
  npm 安装器另有 `npm/seahi-serial-mcp/test/self-test.js`（94 条）。
- **MCP 改动必须对"正在跑的应用"自检**（用户："每个工具你都需要测试工具调用结果"）：
  `node .walkthrough/mcp_smoke.js [--full] [--transport http]`。它先报"源码工具清单 vs 应用 `tools/list`"的差异 ——
  **客户端看不到新工具，十有八九是跑着旧构建**（工具定义编译进 exe，客户端还要重连才重读 `tools/list`）。
  安全模式：只读工具真调；写工具用"必填缺失 → -32602"探针；危险工具用"不带 confirm → -32006"探针；
  其余有副作用的跳过（绝不关用户的串口 / 断用户的设备）。

## BLE 主机方向的八条关键约定（别改回去）

1. **设备不广播就搜不到**：被 Windows 配对过 / 被别的手机连走后就往往不再广播，永远进不了扫描列表。唯一出路是
   `ble_connect_direct`（btleplug `add_peripheral` 按 MAC 直连），别去掉这个入口。
2. **状态里存 `adapters`（列表）不是单个 adapter**：只留第一个会让"插在第二个适配器上的设备永远搜不到"。
   `ble_get_devices` / `ble_find_peripheral` / `ble_refresh_rssi` 都必须遍历全部。
3. 后端连接有 **10 秒显式超时**（`BLE_CONNECT_TIMEOUT_MS`，比前端 15s 略短），超时主动 `disconnect` ——
   不让"前端放弃了、后端稍后才连上"造成长期状态错位。
4. **UUID 名称表是生成文件**：`src/js/81-ble-uuids.js` 由 `node .walkthrough/gen_ble_uuids.js` 生成
   （78 服务 / 512 特征；手写那版只有 9 条）。要加 SIG 表外的条目就加生成器的 `SVC_EXTRA`（带出处），**别改产物**
   （会被覆盖）；生成物必须一起提交（前端无构建步骤）。**"查不到就标 `Custom Service`"那条兜底不许动**
   （用户明确要求），所以也别塞 `FF00` 这类泛化号码。
5. **扫描与连接互斥：连上设备就同步停扫描**（用户 2026-09 提的修复）。三条别改回去：① 停扫描只有**一个出口**
   `stopBleScan()`（手动 / 到点 / 连接成功共用）—— 漏清 `_bleDevTimer`/`_bleScanStopTimer` 就会出现"按钮写着开始扫描、
   后台每 2 秒还在刷列表"；② `stopBleScanOnConnect()` 必须在 `bleOnConnected()` **第一行**（所有连接路径的唯一出口：
   列表点卡片 / 按 MAC 直连 / MCP `ble_connect` / 配对后重连），并挡住**迟到的 `ble_start_scan` 回执**（回来时若已不在扫，
   补一条 `ble_stop_scan` 并直接返回）；③ 只在**确实在扫**时才 `invoke('ble_stop_scan')`（连接多数发生在没扫的时候）。
   ⚠️ **不拦"连着设备时再扫描"**（找下一台是正常需求）；MCP 侧描述已写明"连上会自动停扫描、`scanning` 会是 false"。
6. **CTS 字段按 SIG 的 GATT Specification Supplement**：`0x2A0F` 的 **DST 偏移是 15 分钟单位**
   （`2`=+0.5h / `4`=+1h / `8`=+2h，`255`=未给出）、Time Zone 的 **`-128` = "未给出时区"**（不是 -32:00）、
   `0x2A14` 的 **Time Accuracy 是 1/8 秒（125ms）步长**（`254`=超量程、`255`=未知）。2026-09 这里整体错了一档
   （`doc/MCP_DESIGN.md` §17），而且**测试是照着错实现写的**。三条纪律：**"没给出/超量程/保留值"一律回 `null`**
   （`0` 也是结论，不能拿它冒充"不知道"）；**按长度认字段**（`2A2B`=10 / `2A0F`=2 / `2A14`=4，对不上不猜）；
   三处一起改（`ble_cts_decode` / 前端 `BLE_CTS_CHARS` / `attach_cts_decodes`），并核对
   `gss/org.bluetooth.characteristic.{dst_offset,time_zone,time_source,time_accuracy,reference_time_information}.yaml`。
7. **BLE OTA（阶段 0 = 选固件 + 校验 + 读版本；阶段 1 = 真传输，引擎在 Rust 侧）—— 但整条当前被
   `var BLE_OTA_UI_ENABLED = false;`（`src/js/84-ble-ota.js` 顶部，唯一总开关）隐藏着**（用户 2026-09："先隐藏起来吧"）：
   设备详情页不渲染「固件升级」按钮，`openBleOtaModal()` 自己也 `return`（只藏按钮挡不住一句手动调用）。
   **用开关而不是删代码**：引擎 / 协议档 / 二次确认 / 危险登记 / 断言都是好的，卡住的只有真机协议里 `crc16()` 的参数
   （在泰凌预编译库 `liblt_8258.a`，见 `doc/BLE_OTA_TELINK.md` §6）—— 核对该行后改成 `true` 整条就回来。
   **别删按钮**（那样没人记得配套：`data-mcp-skip` / `MCP_SKIP_NO_TOOL` / 三份文档 / 四条断言）。
   ⚠️ 真机协议已查清：目标设备（TB 系列 = **泰凌微 TLSR8250**，不是 PHY/奉加微）走 **Telink OTA**：20 字节定长包 /
   `0xFF01` 开始 / `0xFF02` 结束 / 不等 ACK。落地：`main.rs` 的 `ota_pick_firmware` / `ota_inspect_firmware` /
   `ota_list_firmwares`（阶段 0）与 `ota_start` / `ota_status` / `ota_abort` + `ota_task_body`（阶段 1）；
   评估与分期见 `doc/BLE_OTA_EVALUATION.md`。**以下都别改回去**：
   ① **前端 `84-ble-ota.js` 里不许出现 `ble_write` / `ble_write_descriptor` / `ble_subscribe` / `ble_disconnect`**
   （断言扫这个文件）—— 理由不是洁癖：**半成品固件写入 = 变砖**，而兜底只能在设备侧（双 bank / rollback）；
   阶段 1 的写入**全在 Rust 引擎**，前端只有 `ota_start`/`ota_status`/`ota_abort` 三条命令。
   ② **固件路径只认用户在原生框里亲手选过的**（后端 `ota-firmwares.json`，LRU 20；前端传任意路径一律拒）；
   **固件字节从不进 IPC**（前端拿到的是校验结果）。③ **大小上限在读文件之前判**（`ota_check_size(meta.len())`，8 MB）。
   ④ **`md5_match` 的 `null` 与 `false` 是两件事**：认不出包头是 `null`（"没有这个字段可校"），校验失败才是 `false`；
   混成一个就是界面对用户说谎。⑤ **GATT 特征 UUID 必须先 `shortUuid` 归一化再比**，别拿完整 128 位硬比
   （2026-09 真机：设备明明有 `0x180A`，界面却报「设备未提供 0x180A」）；**"找不到"必须分三态说清**（服务树为空 /
   确实没有 180A / **有** 180A 但没有版本类特征 —— 后者要把该服务下**实际有哪些特征**列出来）。判定抽成纯函数
   `bleOtaReadBlockReason` 以便无头断言。
   ⑥ **协议档（`OtaProfile`）里一个 UUID / 分包 / 帧格式都不许预填**：设备侧是自研私有协议，缺哪一项就**拒启动并
   说清缺哪一项**（`ota_profile_check`），别拿一个"像那么回事"的默认值去写设备。
   ⑦ **设备 ACK 走独立出口 `OtaAckSink`**（`BleState.ota_ack`）：通知循环在**产生处**多投一份，引擎按 `sink.pop()` 取
   —— **绝不去 drain 前端轮询的 `notify_buf`**（单消费者队列，抢走就是"界面偶发丢通知"）；**写之前先 `drain_stale()`
   清过期 ACK 并记进 `ack_stale`**（上一片多出来的通知被当成这一片的 ACK，就会把"丢片"读成"成功"）。
   ⑧ **只有单片 `ack_timeout_ms`，绝不设整体超时**（分钟级任务被整体超时会白写一遍）——
   `there_is_no_overall_timeout_constant` 那条 Rust 单测守着。`ack_mode: notify` 时"任何一条通知都算这一片的 ACK"是
   **明处的取舍**（设备 ACK 格式没给，**不编匹配规则** —— 编错就是把丢片读成成功）；原文记进 `recentAcks`；
   **结束帧没配就只是不发**，传完只如实说"设备多半不会生效"，绝不报「升级成功」。
   ⑨ **人工二次确认是硬要求**：第一次点「开始升级」只把按钮改成「确认升级」+ 写一行日志，第二次才真调 `ota_start`；
   **改协议档会收回该状态**（`bleOtaProfileChanged` → `bleOtaDisarm`）。传输中锁住 关闭 / 换固件 / 改协议档
   （关了就没进度可看，而后端还在写）；「中止」的文案必须写明**中止 ≠ 回滚**。
   ⑩ **危险动作登记是"三张表"，别只记两张**：危险按钮带 `data-mcp-skip`（`mcpBuildRegistry` 靠
   `closest('[data-mcp-skip]')` 跳过 → AI 的 `ui_click` 点不到），登记位置取决于后端有没有对应工具：
   有 → `MCP_DANGER_CONTROLS`（key 必须与 Rust `DANGER_TOOLS` 一一对应）；没有 → **`MCP_SKIP_NO_TOOL`** 且**必须
   写明理由**（当前唯一一项：OTA 的「开始升级」—— 阶段 1 起它真会写固件，而 MCP 的 `ota_start` 属阶段 3）。
   把没有工具的按钮塞进 `MCP_DANGER_CONTROLS` 会让"不漏也不虚"的对账断言当场 fail（虚报）。
   ⑪ **弹窗布局与文案（用户 2026-09 明确要求，断言守着）**：**不摆常驻说明文字、不设结果提示区**
   （`#bleOtaNotice` 已删）—— 所有提示统一走日志窗口 `bleOtaLog()`（同时写进 BLE 面板数据日志，MCP 的
   `ble_get_output` 靠那份；两块提示区并存必然漂移）。标题栏三段：左「固件升级（OTA）」、中**设备名 + MAC**、
   右「读取版本」按钮（`.ble-ota-verbtn { justify-self:end }`；中列靠 grid `minmax(0,1fr) auto minmax(0,1fr)`
   才相对**整个标题栏**居中，换 flex + `text-align:center` 会变成"在标题右侧剩余区域里居中"）。名称与 MAC 是两个
   span、**MAC 用灰色（`--text-d`）当提示**、**MAC 永远完整**（名字 `min-width:0` 可收缩）—— MAC 被截掉就等于失去
   "我在写哪台设备"的凭据。**变砖风险提示放内容区最前、单行 ≤42 字**：
   `⚠️ 有变砖风险（设备需支持双分区/回滚）：勿断开设备、关闭程序或让设备走远。`（单行是刻意的：超了会折行、
   再超只能截断）。内容区顺序 = 风险提示 → 固件文件 → 协议档 → 更新进度 → 日志（`#bleOtaDevInfo` / `#bleOtaVerdict`
   两个显示区已删；进度 `#bleOtaBar` + `#bleOtaStage` 阶段 0 恒 0% /「未开始」，阶段 1 起由 `ota_status` 轮询填）。
   ⚠️「未开始」跟在「更新进度」标题右边且**必须显式 `font-weight:400`**（标题是 600，不覆盖就抢成第二重点）。
   日志窗口 `#bleOtaLog` **固定 132px 高、自己滚**（弹窗高度不跟着跳），上限 200 行且**丢弃记账**
   （`_bleOtaLogDropped`：超了丢最旧，并在窗口里说明省掉多少条）。
8. **设备名只认广播名**：btleplug 的 winrt 后端在 `connect()` 成功后拿 **Windows 系统名覆盖 `local_name`**
   （`vendor/btleplug/src/winrtble/peripheral.rs` 的 "Query the system-cached device name" 段，**不是**我们那 4 处
   补丁之一；那个名字就是 WinRT 的 `BluetoothLEDevice.Name`，见 `ble/device.rs` 的 `fn name()`），
   而 `advertisement_name` 仍是广播里的名字。① **展示名一律 `advertisement_name || local_name`**（断言守着）：
   用 local_name 优先会让名字在**连上那一瞬间跳变**，而且"卡片名"与"广播名"两行互相矛盾（2026-09 用户报的
   "左侧设备名出错了"：列表写 `tSample`、广播名写 `ai-thinker`）。② **那个系统名不进界面**（用户判定
   「`tSample` 是误识别」：它不是我们解出来的，是 Windows 那一侧的名字投射/缓存，**可能是设备从来没叫过的名字**）
   —— 既不当主名也不单列展示（曾加过的「系统名」行已删），只在设备**根本没广播名字**时才拿它兜底。要确认设备
   自称什么，读 `0x1800` 下的 `0x2A00` Device Name（权威值）。③ **别改 vendor 让系统名不覆盖**：那是上游语义，
   在展示层定优先级就够了 —— 动 vendor 要再加一处补丁 + 同步 `VENDOR.md`，不值。

## 窗口几何记忆的三条约定（别改回去）

窗口位置/尺寸/最大化由 **Rust 端** `%APPDATA%\seahi-serial\window.json` 统一管（`SavedWindowState`，
见 `doc/ARCHITECTURE.md` §6.10）：

1. **主窗口是 `visible:false`，所以"把窗口显示出来"是一等公民**：任何让初始化走不到"页面就绪"的路径都必须能露出
   窗口 —— 前端 `revealMainWindow()`（`reveal_main_window` 命令）要在成功、`catch`、`showFatalError` **三处**都调，
   Rust 端另有 4 秒兜底 `show()`。少一处就是"应用启动了但用户看不到窗口"，而且**报错页自己也看不见**。
2. **`config.json` 的 `windowWidth`/`windowHeight` 仍然要写**（`collectConfig`）：MCP 的 `ui_get_state` 的 `window`
   分支读它，同时它是老版本升级上来的迁移兜底（`legacy_window_state_from_config_json`，只取尺寸不取位置）。
   删了就两个功能一起坏。
3. **位置存 `outer_position()`、尺寸存 `inner_size()`**，且非强制的自动保存只在窗口可见时执行、最小化/最大化状态下
   不改写普通几何 —— 这三条各自对应一类真实故障：窗口每次开关往右下漂移、启动期隐藏窗口的瞬时尺寸（2068×2060）
   被写进记录、`-32000` 哨兵坐标污染位置。

## MCP 的十二条关键约定（别改回去）

1. **MCP 服务器必须在应用进程内**：它要拿 `AppHandle` 才能访问托管状态、还要 `emit` 驱动 WebView 的 DOM；外部
   独立进程（含"做成 npm 包"）两样都做不到（`doc/MCP_DESIGN.md` §3.4）。
2. **绝不加 `panic = "abort"`**：一次 panic 会杀掉整个进程（用户的串口会话就没了）。分派边界**真的有**
   `catch_unwind`（`handle_raw_guarded`；2026-09 之前文档一直声称有、实际全 crate 都没有），panic 会转成一条
   JSON-RPC 错误 + 一次错误上报。
3. **工具改界面一律走"合成 DOM 事件"**（`el.click()` / 派发 `input`+`change`），复用既有 inline handler；别为 AI
   单写一套逻辑，两套必然漂移。
4. **AI 记录只写 `ai-config.json` / `ai-calls.jsonl`**，`config.json` 里绝不能出现 AI 痕迹（断言集里有专门检查）；
   AI 配置一律原子写（临时文件 + rename，别重犯 M7）。
5. **只监听回环**：`server.host` 只接受 `127.0.0.1`/`::1`/`localhost`；`/healthz` 是唯一免鉴权端点且**只回
   `{"ok":true}`**（泄露版本号 = 给本机任意进程一个信息泄露点）。
6. **日志旁路必须挂"生产端"且非阻塞**：`LogHub::push` 用 `try_lock`（拿不到锁就丢一条并计数）—— 写日志的可能是
   串口读线程（25ms 轮询，延迟敏感）；**绝不去 drain 前端轮询的队列**（那是单消费者队列，抢走会让界面丢数据）。
   内存上限**必须是被执行的**：通道名是动态的（`serial:<面板>:<方向>`，开 N 个监视器就多 2N 个通道），所以除了每通道
   上限，还要有**全局** `TOTAL_CAP_BYTES`（超了按"裁最大的通道"尽力回收，`try_lock` + 单次最多 4 个通道）与
   `MAX_CHANNELS`（到顶不建新通道，丢弃计入 `channelSkips`）。⚠️ **丢弃必须记账，而且要能被读出来**（已踩四次）：
   串口缓冲丢的字节（`ReadDataResult.dropped`）、BLE 通知丢的条数（`{items, dropped}`）、ADB PTY 丢的块数
   （`{bytes, dropped}`）、前端待发队列丢的条数（`log_push_batch` 的 `droppedByChannel` → 各通道 `dropped`）——
   四路都要传回界面/工具并提示一行（只有 LogHub 内部的 `channelSkips`/`lockSkips` 是纯内部计数）。不做的后果不是
   "少几条日志"，而是**工具明确告诉调用方"日志是完整的"**（`mayBeIncomplete:false`），于是 AI 拿被截断的证据下结论。
   ⚠️ **每条日志还带一个「来源」`src`**（用户 2026-09："AI 发送的数据在日志里要和接收的区分开"）：`ai` = AI 通过 MCP
   触发、`ui` = 用户手动、`none` = 未标记。因为 MCP 发送与用户点按钮**走的是同一条路**（`serial_send` 就是"填进输入框 +
   点发送按钮"，见 #3），光看内容分不出是谁发的。三条别改回去：① **前端三处必须成对** —— `mcpSerialOp` 的 send 分支先挂
   `_mcpAiSend` 标记（**必须早于 `click()`**：click 是同步派发，反了 sendData 已经跑完、认领不到）→ `bufferPush` 认领它
   （认领到就把那条标 `ai`）→ **没被认领就补记一条**（echo 关着 / 输出区没渲染时那次发送本来完全不进日志中心；
   补记是为了"AI 干了什么一定可追溯"）；② **这一跳不许丢字段**：前端 push → `log_push_batch` 入参 → `push_batch_into`
   → `LogHub::push_src`，少解析一次功能就静默失效、而两端单测各自全绿；③ **text 编码里必须把它写出来** —— `dir` 能从
   通道名推（`serial:<分栏>:rx|tx`），`src` 推不出来。BLE 的写日志也回灌到 `ble:tx` 通道（**只回灌 tx**：rx 那边 Rust
   侧已在推 `ble:rx`，再推一遍就是逐条重复）。
7. **`expose.autoControlTools` 默认关闭**：几百个 `ctl_*` 工具会明显拖累模型选工具的准确率；要打开就打开，但别改成
   默认开。
8. **运行期错误必须进错误上报**（不只是写本地日志）：统一走 `mcp::report::report(kind, detail)` → 程序既有的
   `report_error`（LogHub 的 `error` 通道 + 本地日志 + Sentry + 自建服务/SQLite）。三条纪律：① **同类错误 5 分钟内只报
   一次**（`DEDUP_WINDOW_SECS`，服务端去重是最后一道闸，不能让每秒重试的客户端把网络和库打爆）；② **上报前把 token
   打码**（`remember_secret` 在启动时登记当前令牌）；③ **上报路径自己不阻塞、不 panic**。
9. **回执那一跳（`mcp_ui_ack`）不许丢字段**：前端的 `notFound` / `invalidParams` 是后端判定 `-32602`（"参数/路径有问题
   → 改参数重试"）还是 `-32006`（"工具跑了但没成 → 先做前置操作"）的**唯一依据**；丢一个字段 = 一整类错误码变成错的，
   而且**两端各自的单测都会是绿的**（2026-09 真机检查：`notFound` 就是这么丢的，`unwrap_ui_result` 里那条 `-32602`
   分支在真机上从未生效）。加字段时三处必须一起改：前端 ack → `mcp_ui_ack` 入参 → `ui_ack_payload`，并由
   `ui_ack_reply_shape_is_complete` 从 ack 入参**一路测到错误码**。
   ⚠️ **而且这一跳必须能等 Promise**：`mcpHandleUiCmd` 有不少分支返回 Promise（连设备 / 读写特征 / 从机启停 / 读 RSSI…），
   直接读 `res.ok` 会永远是 `undefined` → 回执变成 `ok:false` + `error:null` → 客户端只看到一句没头没尾的**"前端执行
   失败"**（2026-09 真机实测 `ble_periph_status` 就是这样：真实原因是"从机模式没开"，AI 却什么都不知道）。现在统一走
   `mcpUiCmdReply(cmd, ackFn)`（`Promise.resolve(res).then(send, …)`），断言集里 7 条守着它。
10. **MCP 的运行不得影响主程序**（用户明确要求的硬约束，不是"尽量"）：① 串口收发热路径上只有一次**非阻塞**日志旁路；
    ② 错误上报走**独立上报线程的 channel**（`ERROR_SENDER`），Sentry SDK 自己缓冲；③ SSE 出站是「**有界队列 +
    `try_send`**」（生产者绝不 `await`、绝不阻塞，慢客户端直接断开）；④ 界面命令有在途上限（32）与**分档超时**
    （界面动作 5s / 要过设备的 BLE 动作 30s / `ble_connect` 130s）—— **别把桥超时改回一律 5s**：前端的连接路径是
    "首连 15s + 配对 75s（**等用户在 Windows 配对框上点确认**）+ 重连 15s"，桥按 5s 算必然给 AI 一个假失败
    （`-32004` + 误导性的"界面可能正忙"），而操作其实还在正常进行（分档在 `bridge.rs::timeout_for`，`.walkthrough`
    里有跨端断言守着这三者的相对关系）；⑤ 工具 panic 由 `catch_unwind` 兜住（见 #2）。
    ⚠️ **加新工具时先问一句"它的输入有上限吗"**：任何接受外部数组/字符串的参数都必须在 `mcp_limits` 里有对应上限，
    且校验要发生在**碰主程序之前**。`MAX_UI_SET_ITEMS` 就是教训 —— `ui_set` 最终跑在 **WebView 主线程**上，请求体虽有
    1 MiB 上限，但一条 item 才 40 多字节，1 MiB 能塞两万多条，等于"AI 一句请求把界面冻住几秒"。
    ⚠️ **而且"在 `mcp_limits` 里报出来"≠"被执行"**：`MAX_QUICK_CMD_*`（500 条 / 64 / 4096 字符）曾经只在 `limits_json`
    与文档里出现、代码里一次都没校验过（2026-09 审计发现）—— 超长的指令内容会一路写进 WebView 的输入框，还会撞上
    256 KB 的写回上限：工具已回 ok，改动却没落盘。另外**单条数据的长度也要有上限**（`MAX_UI_SET_VALUE_CHARS`）：只挡
    条数挡不住"一条 100 万字符的字符串"。**同一个上限要同时出现在读入端与写入口**，否则"内存里有、写回时被截断"会让
    用户数据不可逆丢失。
11. **每个工具都必须有"返回值契约"和"调用情况"测试**（用户："不然预期的结果怎么确定是否已经完成？"）。四条一起才叫
    测过：① **返回值契约**（`every_tool_has_a_tested_return_contract`）：54 个工具每个都要在表里交代清楚 —— 纯后端工具
    断言**顶层字段**（多一个少一个都要改契约），界面工具断言无界面时必须是 `isError` + `-32006`，有副作用的注明谁在管它；
    表里漏一个就 fail，所以**新增工具时必须一起想清契约**。三条全局不变量：`structuredContent` 必须是对象、键必须
    camelCase、**文本摘要必须真的把数据说出来**（只写"N 项"就等于把数据藏起来 —— `serial_list_ports` 的端口名就这么
    消失过）。② **调用情况**（`every_ui_tool_sends_the_expected_op_and_returns_expected_shape`）：界面工具靠单测专用
    假前端（`McpCore::test_ui`）真调一遍，钉住**发给前端的 op/参数序列**与**拿到回执后的返回**（包括 `serial_open/close`
    的幂等分支与"点完轮询确认"那段）。③ **跨边界**：扫 protocol.rs 发出的每个 `op`/`action`，要求 index.html 真有对应
    分支 —— "后端发了、前端没有"会静默失败，而两边各自测自己那一半时全是绿的。⚠️ 假前端只证明 Rust 那一半；前端那一半
    必须由 `.walkthrough` 用**真实 handler** 跑。④ **端到端**：`mcp_smoke.js` 对着**正在跑的应用**把每个工具真调一遍。
    Rust 侧另有两条守着"结果真的说出来了"：每个工具的文本摘要里必须出现 structuredContent 里的至少一个真实取值
    （`leaf_scalars`），以及 `ble_list_devices` 的摘要里必须有设备 MAC 与名称。
    ⑤ **"AI 怎么知道该用哪个工具"也要守**：AI 只认协议里传过去的四个通道 —— `initialize.instructions`、`tools/list`
    的 `description` 与字段描述、以及运行时的错误码；**`doc/` 下的文档它一个字都看不到**（那是对人写的）。
    **`instructions` 放"场景任务链"**（哪个面板走哪条链、"读内容该选哪个"这种最容易选错的一组工具要摆在一起对比），
    参数细节与坑点留在工具自己的 `description` 里（抄一份必然漂移）；**`description` 首句说"什么时候用它"**（首句是最不
    容易被截断的位置）；**`annotations` 的"只读"必须来自显式登记的 `READ_ONLY_TOOLS`**、破坏性来自 `DANGER_TOOLS`
    （`annotations_for` + `annotate_tools` 在 `tool_defs()` / `exposed_tools()` 返回前统一注入）。
    ⚠️ **绝不能用"不在 `WRITE_TOOLS` 里就当只读"** —— 名字判断不出读写，那等于"漏登记时**主动说错话**"（客户端被告知
    "它只读"、只读模式也不会拦它，两边一起错；2026-09 第一版被自己的断言当场抓出来）；也不许给 `SOMETIMES_WRITE_TOOLS`
    标 `readOnlyHint`。它是**提示不是约束**：不替代只读模式的 `-32007`，也不替代 `confirm:true`。三条断言守着：
    `descriptions_only_reference_real_tools`（描述里点到的工具名必须真实存在，否则 AI 会照着**幽灵工具**调）、
    `annotations_agree_with_write_and_danger_tables`、`every_tool_is_explicitly_classified`（**每个工具都必须被显式
    分类**为读 / 写 / 按调用变，三张表不重、不漏、不过期 —— 新增工具忘登记会 fail，不会静默落到只读那一侧）。
    ⚠️ **2026-10 补：那四个通道里有一个不可靠，另有四条兜底**（`initialize.instructions` 在规范里只是 **SHOULD**，
    不少客户端不把它交给模型，全押在它身上等于交给客户端实现）：① **`prompts` 是唯一"用户和 AI 双方都能发现"的通道**
    （客户端列成斜杠命令）：`SERVER_PROMPTS` 四条（Windows 串口 / 蓝牙通知 / ADB / 跨通道找日志），`capabilities.prompts`
    必须宣布，`prompts/get` 认不出名字回 `-32602` **并列出可选值**；正文里的工具名**已进**
    `descriptions_only_reference_real_tools` 的语料，也**不许写 `serial_` 这类通配写法**（会被当成不存在的工具名 fail）。
    ② **`mcp_status` 必须带 `nextSteps`**（按"有没有界面 / 是不是只读"分档）—— instructions 被吞时的重入点；⚠️ 它还
    必须在**文本摘要**里出现（通用渲染按字母序铺键，600 字预算在它之前就花完，只读 `content[].text` 的客户端一个字都
    看不到）。③ **内置工具必须在 `tools/list` 第一页给全**（2026-10 实测 54 > `TOOLS_PAGE` 50，切走的正好是最能自我
    描述的那四个）。④ **每个工具都要有 `title`**（`TOOL_TITLES` 一张表 + `annotate_tools` 注入；控件工具的由
    `registry.rs` 用控件标签给，已有就不覆盖），否则用户面对 54 个裸工具名只能"全部允许"。⑤ ⛔ **别在弹窗里再摆
    "可复制的工作指引"**（曾有「用法说明」，2026-10 当天删）：让用户贴进客户端「自定义指令 / Rules」是三条路里**最贵**
    的一条 —— 那段文字**每次请求**都进上下文，而 `instructions` 只在握手发一次、`prompts` 按需取、客户端不显示 prompts
    时还有 `mcp_status.nextSteps` 让模型自己问到。`.walkthrough` 里有一条地雷守着"别再摆回来"。
12. **两种 MCP 传输并存，别拿一个换掉另一个**：`/mcp`（**Streamable HTTP**，2025-03-26+ 规范，新版客户端 VS Code /
    Cline / 新版 Cursor / Claude Code 默认走它）与 `/sse` + `/messages`（遗留 SSE，只支持 SSE 的老客户端）**共用同一套
    工具、同一张会话表与同一份上限**（落地记录见 `doc/MCP_DESIGN.md` §17 的 2026-09-16 一条）。五条别改回去：
    ① **`POST /mcp` 直接回 `application/json`** —— 我们的工具是一问一答（没有进度通知、没有中途消息），规范允许服务器
    在 JSON 与 SSE 之间二选一；别为了"更像规范"去实现"POST 返回 SSE 流"（只是多一层分帧、多一处能出错的地方）。
    ② **表满时只淘汰最久未活动的 HTTP 会话**：SSE 会话的长连接已经建立，把表项删掉只会让它变成收不到东西的僵尸；也
    **不能**直接回 429（客户端拿到 429 无从下手，只能干等 30 分钟空闲回收 —— 会话泄漏那次就是这么炸的）。HTTP 会话被
    淘汰是干净可恢复的：下次请求得 404，按规范重新 `initialize`。⚠️ **判据是 `Session::kind`，不是 `tx`**：`tx` 只表示
    "有没有推送通道"，而 HTTP 会话按规范挂上 `GET /mcp` 流之后也有 `tx` —— 用它当判据会让这类客户端**全部变成"不可
    淘汰"**，4 个占满后第 5 个直接吃 429（2026-09 实测：淘汰候选 = 0 → `HTTP/1.1 429`；回归测试
    `http_sessions_with_a_get_stream_are_still_evictable` 守着）。同理 **`DELETE /mcp` 只许删 HTTP 会话**，目标是
    SSE 会话时回 404（403 等于告诉对方"这个 sid 存在，只是不归你"）。
    ③ **`GET /mcp` 的流断开只摘通道、不删会话**（`SseBody::keep_session`）—— 那个会话还要继续给 POST 用。
    ④ **新入口必须共用** `read_body_limited`（1 MiB 上限：先看 `Content-Length`，再用 `Limited` 兜住 chunked）与
    `handle_raw_guarded`（panic 兜底）—— 断言集里有两条专门数这两处的调用次数，少一处就 fail。另外 `/mcp` 是唯一做
    `Origin` 校验的路径（只放行回环，防 DNS rebinding；不带 Origin 的 SDK/curl 不受影响）；`MCP-Protocol-Version`
    不认识的值回 400 **并把支持列表写进响应体**（光一个 400，调用方只能靠猜）。客户端配置里 http 传输的 `type` 写法
    **各家不统一**（VS Code 用 `http`、Cline 认 `streamableHttp`），所以弹窗与 npm 安装器两种都给 —— 写错的典型表现是
    客户端**静默**按遗留 SSE 解析，然后一句没头没尾的"连不上"。
    ⑤ **传输是三档的**（`server.transport`：`both` 默认 / `http` / `sse`）：选单档时另一条端点返回 404（**立即生效**，
    路由每次请求都读配置，不用重启）；界面只展示当前档的连接方式。界面上它是一个下拉框（`HTTP` / `SSE` / `All`），与
    「启用/关闭 MCP 服务器」「只读模式」挤在**同一行**（从左到右：开关按钮 → 下拉框 → 只读模式 → 右端重置令牌）。
    三个选项的后果、以及只读模式的**开/关状态**都写在**悬停说明**里 —— 用户明确要求界面不摆灰字提示、按钮文案也不带
    状态（"只读模式：开（AI 只能看）"改成固定的「只读模式」，状态只进悬停说明；"写操作全被拒（-32007）""两条都在跑…"
    也删了，**都别再加回来**）。⚠️ **这些说明不能再用原生 `title` 承载**（它的三个固有毛病：鼠标一扫就弹、划过一排
    按钮会**一闪一闪**；一行铺开不换行、长说明**横跨整个窗口**；还会被控件注册表当成 label 抄给 AI —— `mcpMakeEntry`
    读的是 `title || aria-label`，于是 AI 在 `ui_list` 里看到的"控件名"是一整句话）：说明走 **`data-mcp-tip`**（文案里的
    换行用 `&#10;`），由 `mcpTipBind()` **停顿 450ms** 才显示在弹窗里那块**常驻说明区**（`#mcpTipRow` + `.mcp-tip`，
    `min-height` 占位不跳动、`pre-line` 能换行）；控件名交给简短的 **`aria-label`** —— **删了 title 必须补 aria-label**，
    否则 label 会退化成元素 id。按钮文案固定之后，**在途反馈也要留个出口**（这里是把说明置为「处理中…」）；下拉框那一层
    还有一条：在途要禁用、**失败要把选中值拨回真实值**（否则界面停在一个没生效的值上，比报错更让人困惑）。
    改这块时守住两条纪律：**其一，默认必须是 `both`**（不能让"升级"本身把某类客户端弄断）；**其二，迁移必须在
    `load_in` 里做规范化**（老配置只有 `streamableHttp` 这个 bool）—— 只在序列化端处理的话，`transport` 会是 `null`、
    老字段被 `skip_serializing` 丢掉，于是"只 SSE"的意愿**在写回一轮后就变成 both**（有回归测试
    `old_config_migrates_transport_mode` 守着"读进来 sse → 写回 → 再读还是 sse"）。端点发现文件里**不提供的那条 URL
    写空串**，别留一个必然 404 的地址；npm 安装器的 `readEndpoint` 也因此不能强求 `url` 存在。

## 项目结构

- `src/index.html` + `src/css/*.css` + `src/js/*.js` — **整个前端**（无框架 / 无打包器 / 无构建步骤；4 个 CSS +
  16 个 JS + 272 行骨架，含 12 套主题变量；串口 / WSL / ADB / 蓝牙 四个面板）。`src/js/81-ble-uuids.js` 是**生成文件**
  （见 BLE #4）；`src/js/84-ble-ota.js` 是 OTA 面板（阶段 0 + 1 已落地，界面入口被 `BLE_OTA_UI_ENABLED = false` 隐藏，
  见 BLE #7）。⚠️ **只用普通 `<script src>`，绝不用 `type="module"`**；目录结构、加载顺序、原 index.html 行号映射
  全在 `doc/FRONTEND_LAYOUT.md`（改前端前先看）。
- `src-tauri/src/mcp/` — **MCP 服务器**（约 6300 行）：`transport.rs`（hyper + **Streamable HTTP `/mcp`** + 遗留 SSE
  `/sse` + 会话/鉴权/限流/广播）、`protocol.rs`（JSON-RPC + 工具定义与分派）、`bridge.rs`（前端桥：emit + 回执 + 超时
  回收）、`registry.rs`（控件注册表 → `ctl_*` 工具）、`loghub.rs`（日志中心）、`calllog.rs`、`aiconfig.rs`、
  `report.rs`、`mod.rs`（启停/生命周期 + 10 个命令）。
- `src-tauri/src/main.rs` — 整个 Rust 后端（约 8360 行，94 个 `#[tauri::command]`）：串口枚举（SetupAPI）、多串口
  连接/断开、DTR/RTS、收发数据、WSL 端口映射、USB 设备、ADB 会话、**快速指令外部文件（`quick_cmds_*`）**、
  **BLE 主机 + OTA 阶段 0/1（`ota_*`）**。⚠️ BLE 的类型别名与 `BleState` **在模块级**、既有 BLE 命令**在 `fn main()`
  内** —— 加新 BLE 代码先确认自己在哪一层（模块级看不到 `fn main()` 里的东西）。
- `npm/seahi-serial-mcp/` — MCP 客户端配置安装器（零依赖 CLI + 94 条自测；`npx seahi-serial-mcp install`，
  `--transport sse|http`）。
- `website/` — **文档站**（VitePress，独立 `package.json` + lockfile，**vitepress 不进根 package.json**）：
  **中文在根路径、英文在 `/en/`**；所有界面文案 / nav / sidebar 都在 `docs/.vitepress/locales/*`（新增语言 = 加一个
  语言包 + 在 `locales/index.ts` 登记 + 建 `docs/<前缀>/` 目录），`config.mts` 只留 base/head/全站 themeConfig。
  **首页是 `layout: false` + `components/landing/LandingHome.vue`**（复刻 deepseek.com/harness 的版式，配色换成软件
  默认主题的 `#1c1e22 / #2e3138 / #4a7ab5`；文案在 `landing/copy.ts`）。
  ⚠️ **首页的产品窗口与功能卡片一律用真实程序截图**（`docs/public/img/landing/*.png`，由 release 构建 + 真实设备
  截取），**不许再照着源码用 DOM 临摹界面**（2026-10 用户明确要求：页面展示的必须是程序真实渲染；
  `AppWindow.vue` / `FeatureCards.vue` 里只放 `<img>`，不再有 UI 图标生成器）。换界面后按 `AppWindow.vue`
  顶部注释的步骤重新截图；「真终端」卡片配的是真实 Linux 串口设备的终端画面（ADB 无真机时不放 ADB 卡片）。
  自有组件放 `docs/.vitepress/theme/components/`，样式变量在 `docs/.vitepress/theme/styles/vars.css`（换风格先改它），
  落地页样式在 `styles/landing*.css`（类名统一 `lp-` 前缀，别和默认主题的 `.card/.nav` 撞）。
  `docs/mcp/tools.md` 由 `scripts/sync-mcp-tools.mjs` 从 `doc/MCP_TOOLS.md` 生成（生成物，不入库），`predev`/`prebuild`
  自动跑。`doc/` 仍是开发者内部文档，**不整目录发布**；部署见 `doc/DEPLOY_CLOUDFLARE.md`
  （Cloudflare Pages，**只有打 tag 才发布**）。
- `doc/`：`MCP.md`（使用说明）｜`MCP_TOOLS.md`（**54 个工具手册**，由 `gen_mcp_tools_doc.js` 从 `protocol.rs` 生成）｜
  `MCP_DESIGN.md`（设计 + 每步实施记录）｜`QUICK_CMDS.md`（快速指令文件格式）｜`FRONTEND_LAYOUT.md`｜`ARCHITECTURE.md`｜
  `CODE_REVIEW_FULL_2026-09.md`｜`BLE_VERIFICATION.md`（主机方向真机验证）｜`BLE_PERIPHERAL.md`（已归档）｜
  `SIGNING.md`（**安装/签名说明**：未签名现状、SHA-256 与 cosign 校验、个人可行签名路线）。
- `src-tauri/vendor/btleplug/` — **vendored fork**（4 处本地补丁；**升级依赖必须按 `VENDOR.md` 重新打**）。
- `src-tauri/tauri.conf.json` — **不要擅自设 CSP**：Tauri 会注入 nonce，按规范 `'unsafe-inline'` 即失效，而本应用的
  行内 `style="…"`（HTML 里 51 处 + JS 模板串里 151 处）与行内 `onclick` 会被全拦（界面掉样式、按钮点了没反应）。
  2026-09 拆分已把内联 `<style>` / `<script>` 块外置，但**行内 onclick 与 style 属性仍在**，所以"设 CSP"仍不能顺手做。
- `src-tauri/capabilities/default.json`（ACL 仅 `core:*`）｜`src-tauri/wsl-daemon/`（bridge 脚本，base64 嵌入）｜
  `installer.iss`（Inno Setup，含 usbipd-win.msi）｜`skills/seahi-serial-dev/SKILL.md`｜
  `skills/win-build-access-denied/SKILL.md`。

## 版本号同步

发布时版本号必须**同时更新 4 个文件 + 锁文件**（漏改会导致"装着 0.3.6 却提示 0.3.7"这类更新异常）：
`src-tauri/Cargo.toml` 的 `version`（运行时版本来源 `env!("CARGO_PKG_VERSION")`）、`src-tauri/tauri.conf.json`
的 `version`（安装包 / MSI）、`installer.iss` 的 `MyAppVersion`、`package.json` 的 `version`（曾漂移成 0.3.0）、
`src-tauri/Cargo.lock` 里 `seahi-serial` 条目的 `version`。

> CI 构建前**自动校验这 5 处一致**（`.github/workflows/build.yml` 的 `Verify version consistency`），tag 触发时还要
> 求 tag == `v{版本号}`，否则直接失败（见 `doc/CODE_REVIEW_FULL_2026-09.md` M25）。
> ⚠️ **改完必须重新编译发布产物**：主程序版本是**编译期烘焙**进 exe 的 —— 只改文件不重编，`seahi-serial.exe` 里仍是
> 旧号（2026-09 事故：安装包文件名/产品版本 0.5.0，装出来的应用却是 0.4.0）。本地打包前先 `npm run build`；
> `installer.iss` 顶部已有 ISPP 守卫（主程序 exe 版本 ≠ `MyAppVersion` 直接 `#error`）。

## 关键约定

- Release 用 `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` 隐藏控制台；磁盘程序名
  `seahi-serial.exe`（连字符），Rust 包名 `seahi_serial`（下划线）。串口友好名称直接调 Win32 SetupAPI（UTF-16），
  避免 `serialport` crate 读中文设备名乱码（U+FFFD）。前端通过 `withGlobalTauri: true` 与 Rust 通信，无 npm 桥接包；
  CSP 为 `null`。设备插拔检测用 `CM_Register_Notification`（windows-sys），触发 `device-changed` 事件。
- ⚠️ **沙箱里跑的子进程可能是 Low 完整性 → 写不了这个仓库（Medium）**（2026-10 实测，别误判成"文件坏了"）：
  `whoami /groups` 显示 `Mandatory Label\Low Mandatory Level`，而仓库目录是 `Medium Mandatory Level:(NW)`；Windows 的
  **no-write-up** 规则下，**`pwsh`/`npm`/`node` 在本仓库建目录、建文件、写回一律 `Access to the path '…' is denied.`**，
  而 `icacls` 上看 ACL 完全正常。**判别方法**：进程 Low + 目录 Medium = 这个进程被沙箱降级了 —— 该改的是沙箱/提权方式，
  **不是**去 `icacls /setintegritylevel L`（那是把整个项目往下拉，正是 `win-build-access-denied` 要治的病）。这种情况
  文件改动走**编辑/写入工具**（它们不经那个被降级的子进程），**别反复重试同一条 shell 命令**。
- **每个"会滚动"的区域都必须有滚动条样式**（用户 2026-09："确认所有的滚动条都已经做了美化"）：新加
  `overflow:auto/scroll` 就得同时写 `::-webkit-scrollbar` 那一套（尺寸 + track + **corner** + thumb + thumb:hover）；
  `corner` 最容易漏，漏一个就是横竖交汇处的白方块。**有意隐藏**滚动条的（`.sel-drop` / `.no-scrollbar` / xterm）
  也必须有规则（`display:none` / `scrollbar-width:none`）。`.walkthrough` 有**两条对账断言**守着："所有
  `overflow:auto/scroll` 的选择器 ⊆ 所有 `::-webkit-scrollbar` 的选择器"、"所有设了尺寸的滚动条规则都有同名 corner"
  （2026-09 靠它查出 6 处漏美化 + 3 处漏 corner）。⚠️ 别再写"corner 规则数量 === 4"这类断言 —— 一加滚动区就得改数字，
  而那正是最容易漏 corner 的时刻。
- **release 构建不带 DevTools**（用户要求）：真正的开关是 **tauri 的 `devtools` cargo feature 必须保持关闭**
  （`tauri-runtime-wry` 里 `with_devtools(..)` 被 `#[cfg(any(debug_assertions, feature = "devtools"))]` 整个门控，
  release 下根本不编译，落到 wry 自己的默认值 `false`）；**debug 构建仍然有 DevTools**。⚠️ `tauri.conf.json` 里的
  `devtools` 字段是**死配置**（tauri 2.11.2 / codegen / build 里没有任何代码读它），写了不生效只会让人误判，**别加回去**
  （断言集里两条守着）。
- **`platform-tools` 会被自家 adb 服务器锁住，安装器必须先停掉服务器**：`adb` 启动的服务是常驻后台进程（应用退出后
  依然活着，直到 `adb kill-server` 或注销），它把 `{app}\platform-tools` 下的 `adb.exe`、`AdbWinApi.dll`、
  `AdbWinUsbApi.dll` 全部映射住 —— 运行中的 .exe 无法就地覆写，已加载的 DLL 连删除都不允许，所以重复安装/升级会重试
  4 次后弹「尝试复制下列文件时出错」，同 AppId 升级时旧版卸载器也删不掉 `{app}`。`installer.iss` 的 `StopAdbServer`
  在 `PrepareToInstall` / `ssInstall` / `usUninstall` 三处**只结束镜像路径位于本应用 `platform-tools` 下**的 adb
  （别误伤 Android Studio 等其它来源）；`[Files]` 用 `replacesameversion`（不是 `ignoreversion`）+ `restartreplace` /
  `uninsrestartdelete` 兜底。注意 `adb.exe`/`fastboot.exe` **没有版本信息**，按 Inno 规则每次安装仍会覆写它们，
  靠的就是先停服务器。
- **快速指令的外部文件：路径只认"用户在原生框里亲手选过"的**（`save_log`、OTA 固件同一套纪律）：
  `quick_cmds_pick_file` / `quick_cmds_export_file` 弹原生框并把路径记进**后端自己的**
  `%APPDATA%\seahi-serial\quick-cmds-files.json`（LRU 上限 50，前端碰不到这张表）；`quick_cmds_read_file` /
  `quick_cmds_write_file` **只接受表里的路径** —— 绝不能让前端传任意路径进来，那等于给本机任意进程一个文件读写原语
  （MCP 工具也不接受路径，只操作界面）。另三条同样别改回去：**写回是原子的**（临时文件 + rename）、**写回前比对内容
  哈希**（文件被别的编辑器改过就报冲突，不静默覆盖；**只有成功读过一次、手里有哈希的挂载才允许写回** —— 没有基线就
  拒写，两端各拦一道）、**沿用读入时的编码**（UTF-8/BOM → 失败回退 GBK）。前端一侧：文件即存储，增删改都写回
  （去抖 600ms）；解析**绝不按逗号切分**（AT 指令里逗号是常态）；注释与额外列按原位置保留（块序列），别用"读进列表
  再重新生成一份"的做法；**文件头（YAML `---` / TOML `+++` front matter）原样保留但不解释** —— 不识别它的话
  `baud: 115200` 会被当成一条指令读进来、写回时还会被转成表格行；`baud`/`mode`/`lineEnding`/`delay`/`expect`/
  `timeout`/`hex` 这些 key 要提示"暂不生效"，别做静默 no-op。另有两条：**每条指令的 `seq`/`timeout`/`expect`/`retry`/
  `hex` 只认"表头声明了列名"的列**（表头写了 `顺序号 / 超时(ms) / 期望 / 重试 / HEX` 才读进来、才写回同一列；**旧列名
  「延时」按「超时」解读**、导入时提示一次；「期望」「重试」面板上没有入口，可发现性靠"超时格描淡边 + 悬停列出内容 +
  导入时提示一次"，导出一定写这两列）；**没有这些列的文件一律按老规矩**（第 3 列起是用户的备注，原样保留），绝不按
  列号硬塞（那会把用户写在第 3 列的「备注甲」读成顺序号、再改写成 `0`，真丢数据）。**写回挂载文件不擅自补列**；需要
  自包含的快照走「导出」（一律补全这几列；纯指令行载体放不下就升级成 Markdown 表格并提示；**不带「名称」列**；默认名
  按监视器区分：`main` 是 `quick-cmds.md`，WSL/额外分栏/蓝牙内嵌各带自己的 mid，免得连点两次导出盖掉前一份；导出是
  直接写文件、**不走写回的哈希冲突检测**，所以盖到别人挂载的文件上时会当场提示）。以及**整行都空的条目不写回文件**
  （写进去也活不过一次重载），但表头声明了 顺序号/超时/HEX 的文件里"还没填内容、参数格有值"的行**必须留着** —— 跳掉
  它，导出/写回的条数就跟面板对不上了；用户没填过的参数格写回时**保持空格**（别把缺省值硬写进他的表）。
  ⚠️ **改了文件格式/列名/上限/写回规则，必须同步 `doc/QUICK_CMDS.md`**（断言里有 7 条守着它别烂掉）。
- **循环组（2026-09 加）**：**一组一张表、循环顺序 = 组的上下顺序 → 组内顺序号**，组的上下顺序**靠拖抬头调整**
  （拖到最上面的那组就是循环起点），组名可重命名、可折叠，首次启动默认 1 组、新建组默认 1 条空指令、**最后一组删不掉**；
  每条指令自己的配置（顺序号/超时/HEX）不变。文件里用 `## 组名` 抬头分隔各组（**两个及以上 `#`**；单个 `#` 仍是注释）；
  导出（副本）一定写抬头，写回挂载文件时只有一组不写（不擅自改用户结构）。面板里**每组自带一份列标题**（抬头 → 列标题
  → 数据行），共用一份会夹在抬头与数据行之间、读起来是断的。
  - 循环发送的开关状态**不持久化**（开机自动发指令太危险）；掉线 / 关监视器 / 列表里再无可发条目时必须**自愈停止**并提示。
  - **发一条等它回话**：`busy` 继续等（不算结论）/ OK 下一条 / ERROR 重发本条（默认 3 次）/ 等满「超时」就**终止整条链**
    （填 `0` = 这条不等响应）。⚠️ **等回话 ⇔ 超时 > 0 且「期望」非空**（判据集中在 `qcmdItemWaits`）—— 没写成功词就
    没有"什么算成功"，条目不校验回话（要等内置的 `OK` 就得把 `OK` 写进「期望」）。早先留空仍按内置 OK 判定 → 设备不回
    OK 的指令全被判超时 → 整条链停在第一条上（"只能发一次"）。
    ⚠️ **「超时」永远是这条的节奏**（别把它当成"只跟等回话有关"）：写了期望 = 等回话的上限，没写期望 = **发下一条前的
    间隔**（`3000` 就是每 3 秒一条），**填 0 才**落回 20ms 兜底（`QCMD_LOOP_MIN_GAP_MS` 只是个下限，**不是**不等回话条目
    的固定节奏 —— 第一版写死成 20ms，用户当场问"为什么是固定 20ms？不是通过超时来配置？"）。
  - **四条配套别改回去**：① 不等回话的条目**根本不 arm**（不摆 Rust 状态、不轮询 `qcmd_hs_state`）；
    ② **循环发送在监视窗口里一行都不写**（用户 2026-10 逐轮收紧：先"直接发送，不做任何提示" → 再"都需要删除"）：
    `qcmdLog` 已**整个删掉** —— 等回话流水（已发出 / 收到 OK / busy / 重发）、跳转、正常收尾、跳过与异常
    **全都不写**（断言扫 `qcmdLog(mid` 的调用，回来就 fail）。可见性只剩面板（亮着的开关 + 折叠条小点）；
    想知道某条等不等回话看超时那一格的悬停说明。**唯一例外是"自愈停止"**：`stopQcmdLoop` 的 reason 弹一次 toast
    （也不许写日志），异常与详情走 `console.warn` —— 那是**出错**，不是流水；③ 跨轮的那一拍必须作废
    （`m._qcmdLoopRun`，停/开都 +1），否则"关一下再开"会多打一拍、旧那一拍还会删掉新一轮的重入闸并替它做跳转；
    ④ "配了却不生效"的 期望/重试/跳转 在**导入时提示一次**（`deadWaitCount`）+ 超时那一格的悬停说明按条目写明
    "本条会等回话 / 这一格是间隔"（别做静默 no-op）。
  - ⑤ **发送失败 ≠ 内容为空**（用户 2026-10 报的 WSL 掉线刷屏）：`sendQcmdPayload` / `sendQcmdItem` 返回**四态**
    `'ok' | 'empty' | 'offline' | 'failed'`，**别退回 boolean** —— 混值时"写设备失败"会被当成"这条空、跳过"，
    `qcmdLoopStep` 立刻重排同一拍 → 0ms 间隔无限刷「发送失败: write failed: [Errno 5] Input/output error」+
    「第 …条没内容可发，已跳过」，循环永不停。口径：`offline`/`failed` → `'sendfail'` → **自愈停止整条链**；
    `empty` → `'skip'`，而**整轮全跳过**也要熔断（`m._qcmdSkipRun` ≥ 当拍 `plan.length`）。
    ⑥ **WSL 监视器的读轮询连续失败要判掉线**（同一事故的另一半）：`80-wsl.js` 的 catch **不能只 `console.error`** ——
    连续 `WSL_READ_FAIL_MAX`（3）次失败要置 `isConnected=false` + `updateMonitorUI(mid,false)`（循环发送的掉线自愈就挂在
    它上面），否则界面一直写着"已连接"、而实际早就发不出去了。⚠️ 这句收尾说明**只弹窗（`showToast`）、不写日志**
    （用户 2026-10：不要出现在日志窗口 —— 掉线说明混进输出区会被当成设备数据）；技术详情留 `console.error`。
    ⑤⑥ 都有断言（含"旧行为必然 fail"的反向自证）。
  - 判定**只在 Rust 做一份**（`QcmdHs` + `qcmd_hs_arm/state/feed/stop`：串口由读线程喂、WSL 由前端 `qcmd_hs_feed` 喂），
    而且 **arm 必须早于 send**（反了就会把回话当上一条的迟到数据丢掉、白等到超时）。MCP 侧对应 `serial_quick_cmd` 的
    `timeoutMs`/`expect`/`retry`（`delayMs` 是旧拼写，继续认）。
- WSL 串口转发通过 Python bridge 脚本实现，用持久化 shell 避免 fork 延迟。⚠️ **bridge 的启动方式别改回硬写
  `-e sg dialout`**：能**非交互**切组时才用 `sg`，否则直接跑 `python3` —— 没装 `sg` 的发行版会 `execvpe(sg) failed`
  （issue #21），不在 `dialout` 组里时 `sg` 会**卡在密码提示**上。三条细节（探测用"真试一次"而不是查 `id -nG`、
  拿不准时不用、提示里"没有 sg"要排在"切组失败"前面）见 `doc/ARCHITECTURE.md` §5.8。
- ⚠️ **WSL 发行版名只认 `wsl --list --verbose` 解出来的，`wt` 必须显式给命令行**（用户 2026-10-14 报"升级 WSL 3.0.3
  后快捷启动按钮打开的是 PowerShell"）：那次 `wsl -l -v` 回的是 WSL 自己的报错文本（`错误代码: 0` / `拒绝访问
  Wsl/E_ACCESSDENIED`），而老代码**逐行取第一个 token 当发行版名** → 界面多出一张「错误代码:」卡片 → 点「启动」→
  `wt -p 错误代码:` → **Windows Terminal 找不到同名 profile 时不报错，直接改用默认 profile（本机 = Windows
  PowerShell）**。三条别改回去：① `parse_wsl_list_verbose` **一行都解析不出来时必须 `Err`**（把 WSL 报错原文带回界面），
  绝不挑 token 当名字；行的判据是「STATE 是已知状态词 **或** 第三列 VERSION 是纯数字」；② `launch_wsl` 的名字必须经
  `resolve_launch_target` 在列表里核对过，**且必须给 `wt` 显式命令行**（`wt -p <发行版> … wsl.exe -d <发行版>`，
  `-p` 只管外观、`wsl.exe -d` 决定跑什么），另外**别再拿 `"Ubuntu-20.04"` 当兜底**；③ `get_or_start_wsl_distro` 走同一份
  解析（老实现会把 `错误代码:` 缓存进 `CACHED_DISTRO`，之后 WSL 串口全跟着错）。前端配套：读不到列表时把原文显示在面板里
  （不是清空），启动/关闭失败一律 `showToast`。
- **自动重连全程不写日志**（用户 2026-10："这些信息不应该出现在日志窗口"）：`reconnectPort` / `reconnectWslPort`
  与其触发点（断线处）**一行都不许写** —— 逐次的「正在重连 (N/10)」与失败原因既刷满输出区，又经 `bufferPush` 灌进
  MCP 日志中心（`ui:sys`/`ui:err`）。可见性只靠界面状态（按钮变「等待接入」+ 端口/WSL 状态点）；`.walkthrough` 里有
  3 条断言守着（两个 reconnect 函数体内不许出现 `appendOutput`、这些文案不许传给 `appendOutput`）。
- USB 设备映射到 WSL 依赖 `usbipd-win` 工具，需管理员权限。
- ⚠️ **跑外部命令（wsl/usbipd/adb）一律走 `run_output_timeout_checked`，别用裸 `Command::output()`**：
  ① 它**并发读 stdout/stderr** —— 子进程输出超过管道缓冲（Windows 约 64KB）时会阻塞在写端，只 `wait`
  不读就会"死等到超时再杀掉、输出全丢"；② 它把**启动失败 / 超时**分开返回（`RunCmdError::Spawn` /
  `Timeout`）—— `usbipd` 没装不能再被误报成"超时需要提权"去弹 UAC（评审 M3）。
  需要"只关心有没有结果"的地方用 `run_output_timeout` 包装（失败会写一条 dbg 日志）。
- **终端模式 = xterm.js 真终端**（2026-10 用户要求「交互要达到 Linux 终端那个层级」）：输出区换成 xterm 画布
  （与 ADB 面板同一套 `src/vendor/xterm/xterm.js`），普通输出区只是**隐藏**、日志/日志中心照旧。
  九条别改回去：① **输入有两种口径，别合成一条**（用户 2026-10 与 2026-10-27 先后提过相反的需求，各有场景）：
  **直发**（`btnLineBuf` 关，WSL 分栏默认）—— Enter=`\r`(0x0D)、Tab=`\t`(0x09)、方向键=`ESC[A…`、Ctrl 组合键原样，
  **不许拦截、不许追加行尾**（`termSendRaw` 里别出现 `leStr`）；**行缓冲**（`btnLineBuf` 开，串口分栏默认）——
  本地累积整行 + **本地回显** + 退格本地擦除，回车才「整行 + 行尾」一次发出（行尾取工具栏「行尾」下拉）。
  AT 指令必须走行缓冲：逐键发、Enter 只给 `\r`、退格 0x7F 被模组当垃圾丢掉，三条凑一起就是「AT 命令必错」；
  设备若也回显（ATE1）会看到两份，属预期，`ATE0` 关掉设备侧回显即可。
  ② **行缓冲里方向键在本地编辑这一行**（用户 2026-10-27 要求：上下左右要能编辑命令行）——ESC 序列既不进缓冲、
  **也不发给设备**（AT 模组收到 ESC 只会吐垃圾）；↑↓ 翻本地命令历史，Ctrl+C 先冲掉半行再发中断，Ctrl+U 清行；
  ③ **不做本地 Tab 补全**（交给设备 shell；旧的 `completeTermTab` / `.term-comp` / `term-current` 已整段删除，
  别加回来）；④ 每个分栏一个 xterm 实例、切走切回**复用**（历史不能清），关分栏 `disposeTerminal` 收掉
  ResizeObserver；主题/深浅色切换走 `refreshTermThemes`；⑤ 接收侧喂的是**原始字节**（`termWriteBytes`），
  别把 `parseAnsi` 处理过的文本再喂给它；⑥ **进入终端模式自动向设备发一个回车**（用户 2026-10 明确要求）：
  设备会重新打印提示符、画布立刻有内容可看；**不做本地提示、也不回放旧日志**；未连接时不发。
  ⑦ **终端按键的"命令级"日志**：逐字符记会刷屏，只在**回车提交 / 粘贴**时各记一条
  （`termLogSend` → `appendOutput('send',{src:'ui'})`，走紧凑缓冲 + 隐形缓存 + MCP `serial:<分栏>:tx`）；
  **不许把方向键等转义序列的尾巴（如 `[A`）当成用户敲的字符**；按 ↑ 从设备侧 readline 历史回填的命令本机看不到，
  宁可漏记也不编造。⑧ **终端配色跟界面主题走，别写死调色板**（用户 2026-10："考虑一下终端模式的颜色渲染风格"）：
  16 色 ANSI 由探针读当前主题的 `.ansi-30..37 / .ansi-90..97`（与普通输出区**同一份 CSS 定义**，12 套主题各一份），
  背景/前景取输出区实际配色，光标/选区取 `--accent-focus`（选区转 rgba 半透明）；按 `data-theme` 缓存，
  主题/深浅色切换由 `refreshTermThemes` 重建 —— 这样同一段彩色日志在普通视图与终端视图里颜色一致。
  `.walkthrough` 有对应断言（按键→字节、行缓冲的整行/退格/行尾、自动回车、回车/粘贴各记一条、主题调色板与切换、复用实例、旧实现不许残留）。
  ⑨ **终端模式下「显示行号 / 时间戳 / 消息回显」置灰**（用户 2026-10-27）：这三项只作用于**普通输出视图**
  （终端模式由 xterm 自己排版、回显由设备 tty 负责），由 `updateTermModeBtns` 加 `.ibtn-disabled` + 改 title；
  **只改外观、不动 `on` 状态**（退出终端模式后用户原来的开关照旧生效，别悄悄关掉）；
  ⚠️ **这几个按钮必须同时带一个固定的 `aria-label`**：控件注册表 `mcpMakeEntry` 的 label **优先读
  `aria-label`**、`title` 只当悬停说明（2026-10-27 改）。否则那句"为什么按不动"的 title 会被 AI 当成控件名，
  而且一开/关终端模式就变一次（AI 上一轮记住的控件名下一轮就没了）；
  **别用 `disabled` 属性** —— Chromium 不给 disabled 元素派发鼠标事件，title 提示就弹不出来，
  而这里正是要靠提示说明「为什么按不动」。点击拦截放在 `ibtnBlocked`（`toggleIbtn` / `toggleLineNum` / `toggleLineBuf`
  入口），MCP 的 `serial_set_display` 按 `.ibtn-disabled` 报「跳过」而不是失败。
  反过来「命令行缓冲」只对终端模式生效，终端模式关着时它置灰。
- **普通模式不主动上色（用户 2026-10 明确口径）**：只有日志自身携带的 **16 色 ANSI 转义**（30–37 / 90–97 / 粗体）
  才按主题颜色渲染；**256 色 / 真彩色（`38;5;n` / `38;2;r;g;b`）在普通模式不解析**、按纯文本显示 —— 颜色能力只属于
  终端模式（xterm，256/真彩色天然支持）。`.walkthrough` 有 3 条断言守着（256 色 / 真彩色 / 背景色都不产生颜色）。
  改 `parseAnsi` 时别顺手把 256 色加回来（用户明确说了不要）。

## CI/CD

`.github/workflows/build.yml`：推送 `v*` tag 触发 Windows 构建并**直接发布正式 Release（latest）**
（`releaseDraft: false` + `prerelease: false`，安装包由 `softprops/action-gh-release` 以 `draft: false` 上传，
**无需人工发布**）；也支持手动触发。

> ⚠️ **发布产物没有代码签名是现状**（个人开发者，无 OV/EV 证书）。Release 正文与 README 必须保留
> [`doc/SIGNING.md`](doc/SIGNING.md) 的链接与 SHA-256 校验指引；**不许写「已签名 / 绝对安全」**。
> 个人可行的签名路线（SignPath Foundation 开源免费签名 / Certum OSS）与 sigstore 校验说明都在那份文档里。
> **CI 已接入 sigstore**：构建后生成 `SHA256SUMS.txt` 并用 `cosign sign-blob`（keyless，GitHub OIDC）签名，
> `.sigstore.json` bundle 与校验和一起上传 Release。三条别改回去：① `permissions` 必须保留 `id-token: write`
> （删了签名步骤会失败）；② 上传资产列表必须带上 `SHA256SUMS.txt` + `.sigstore.json`（删了用户就没法验证）；
> ③ 校验和必须覆盖**全部**发布安装包（新增产物要加进 `Get-ChildItem` 列表）。
> 另：sigstore 只证明「产物由本仓库 CI 构建」，**不改变 Windows 的“未签名”判定**，SmartScreen 仍会提示。
> 另外 `RELEASE_NOTES.md` **只允许存在当前版本一个 `## vX.Y.Z` 段落**（CI 已强制校验）——
> 历史版本说明会让 GitHub Release 变成一堆旧版本，2026-10 已踩过一次。

## 错误上报系统

两条通道：**自建服务**（`server/error-server.js` + SQLite，推荐）与 **Sentry + GitHub Webhook**
（`server/sentry-webhook.js` → 自动建 GitHub Issue，带 `bug` / `auto-reported` 标签）；Cloudflare Workers 版在
`cloudflare-worker/`（免费全球部署）。环境变量 `ERROR_SERVER_URL` / `SENTRY_DSN`，部署步骤与字段说明见
`server/INSTALL.md` 与 `server/README.md`。特性：自动捕获 panic 与运行期错误、去重、详细上下文（堆栈/环境/操作记录）、
离线缓存后补报。
