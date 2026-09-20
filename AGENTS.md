# AGENTS.md

## 项目简介

基于 Tauri 2 的串口/蓝牙调试桌面工具，仅支持 Windows。前端为纯 HTML/CSS/JS（**无框架、无构建步骤**；
2026-09 从单文件拆成 `src/index.html` 骨架 + `src/css/*.css` + `src/js/*.js`，见 `doc/FRONTEND_LAYOUT.md`）；
后端为 Rust（`main.rs` 主逻辑 + `src/mcp/` 模块，见下）。

## 常用命令

```bash
npm install        # 安装前端依赖 (@tauri-apps/cli)
npm run dev        # 开发模式（热重载）
npm run build      # 发布构建 → src-tauri/target/release/seahi-serial.exe
cargo test --manifest-path src-tauri/Cargo.toml   # 后端单测（广播解析/设备类型/busid 白名单/MCP 协议与日志中心）
```

无 lint 与类型检查；后端有单测（`main.rs` + `src/mcp/` 里的 `#[cfg(test)]` 模块，**272 条 + 1 条 `#[ignore]`**：
那条 ignore 是手工联调用的 `mcp_serve_for_manual_check`，要跑 60 秒）。

> ⛔ **BLE 从机（外设）方向已于 2026-09 整条删除**（用户确认"实现不了了"）：本机适配器自报支持
> 外设角色，但实测**广播起不来**（`Aborted`）。原来那三条 `#[ignore]` 真机/诊断用例
> （`ble_periph_diagnose` / `ble_periph_builds` / `ble_periph_starts_advertising`）随之删除，
> 证据与结论留在 `doc/BLE_PERIPHERAL.md`（已标归档）。**别再往这个方向加功能** ——
> 先在真机上把广播跑起来再说。本应用现在的 BLE 能力只有**主机方向**。

前端**有**无头断言集 `.walkthrough/gen_ble_preview.js`（当前 1744 条，随代码演进增补；MCP 的 npm 安装器另有
`npm/seahi-serial-mcp/test/self-test.js`，94 条）：抽取前端真实函数/对象丢进 `vm` 沙箱断言（既有源码正则，
也有把渲染函数丢进假 DOM 跑行为断言）。前端 2026-09 已从单文件拆成
`src/index.html`（骨架）+ `src/css/*.css` + `src/js/*.js`，**布局与加载顺序见 `doc/FRONTEND_LAYOUT.md`**；
断言集里的 `readFrontendSource()` 会按标签顺序把 css/js **内联回一个"逻辑单文件"**再跑断言，
所以"跨 CSS/JS 的源码正则"照旧有效，加新前端文件不用改断言集（只要标签写进 `index.html`）。改前端后应先跑
`node .walkthrough/gen_ble_preview.js`。`.walkthrough/` 已纳入版本库（仅忽略 `__pycache__`）。
改了 MCP 工具定义后，顺手重跑 `node .walkthrough/gen_mcp_tools_doc.js` 重新生成 `doc/MCP_TOOLS.md`（断言集里有一条守着"文档必须列出全部内置工具"）。

**改了 MCP 工具/前端桥之后，还要对"正在跑的那个应用"跑一遍工具自检**（用户的要求：
"每个工具你都需要测试工具调用结果"）：

```bash
node .walkthrough/mcp_smoke.js          # 连上运行中的应用，把 54 个内置工具逐个真调一遍并打印结果
node .walkthrough/mcp_smoke.js --full   # 连有副作用的写工具也真调（会动界面/发数据，自己确认）
node .walkthrough/mcp_smoke.js --transport http   # 走 Streamable HTTP（POST /mcp）；默认有 /mcp 就走它
```

它会先对"源码里的工具清单 vs 应用里 `tools/list` 的清单"报差异 —— **客户端看不到新工具时，
十有八九是运行的是旧构建**（工具定义编译在 exe 里，不重新编译/重启就永远是旧的；客户端还要重连
才会重读 `tools/list`）。安全模式下：只读工具真调；写工具用"必填缺失 → -32602"探针；
危险工具用"不带 confirm → -32006"探针；其余有副作用的跳过并标注（绝不关用户的串口 / 断用户的设备）。

## BLE 主机方向的八条关键约定（别改回去）

1. **设备不广播就搜不到**：从机一旦被 Windows 配对过、或被别的手机连走，往往就不再广播，
   于是永远进不了扫描列表。唯一出路是 `ble_connect_direct`（btleplug `add_peripheral`，
   按 MAC 直连）。改连接逻辑时别把这个入口去掉。
2. **状态里存的是 `adapters`（列表）而不是单个 adapter**：只留第一个会让"插在第二个适配器上的
   设备永远搜不到"。`ble_get_devices` / `ble_find_peripheral` / `ble_refresh_rssi` 都必须遍历全部。
3. 后端连接有 **10 秒显式超时**（`BLE_CONNECT_TIMEOUT_MS`，比前端的 15s 略短），超时会主动
   `disconnect` —— 为的是不让"前端放弃了、后端稍后才连上"造成长期状态错位。
4. **UUID 名称表是生成文件，别手写回去**：`src/js/81-ble-uuids.js` 由
   `node .walkthrough/gen_ble_uuids.js` 从 SIG 官方 assigned numbers 生成（78 服务 / 512 特征；
   手写的那版只有 9 条特征，用户 2026-09 问"这个表足够完整吗"之后改成生成）。
   要加 SIG 表里没有的条目就加生成器的 `SVC_EXTRA`（带出处），**别改产物**（会被覆盖）；
   生成物必须一起提交（前端无构建步骤）。**"查不到就标 `Custom Service`"那条兜底不许动**
   （用户明确要求），所以也别往表里塞 `FF00` 这类泛化号码。
5. **扫描与连接是互斥的：连上设备就同步停扫描**（用户 2026-09 提的修复）。三条别改回去：
   ① 停扫描只有**一个出口** `stopBleScan()`（手动 / 到点 / 连接成功共用）——
   漏掉清 `_bleDevTimer`/`_bleScanStopTimer` 就会出现"按钮写着开始扫描、后台每 2 秒还在刷列表"；
   ② `stopBleScanOnConnect()` 必须在 `bleOnConnected()` 的**第一行**（它是所有连接路径的唯一出口：
   列表点卡片 / 按 MAC 直连 / MCP `ble_connect` / 配对后重连），而且要挡住**迟到的
   `ble_start_scan` 回执**（回执回来时若已不在扫，就补一条 `ble_stop_scan` 并直接返回）；
   ③ 只在**确实在扫**时才 `invoke('ble_stop_scan')`（连接多数发生在没扫的时候）。
   ⚠️ **不拦"连着设备时再扫描"**（找下一台设备是正常需求）；MCP 侧 `ble_start_scan`/`ble_connect`
   的描述里已写明"连上会自动停扫描、`scanning` 会是 false"。
6. **CTS 的字段定义按 SIG 的 GATT Specification Supplement，别凭印象改**：`0x2A0F` 的
   **DST 偏移是 15 分钟单位**（`2`=+0.5h / `4`=+1h / `8`=+2h，`255`=未给出）、
   Time Zone 的 **`-128` 是"未给出时区"**（不是 -32:00）；`0x2A14` 的 **Time Accuracy 是
   1/8 秒（125ms）步长**（`254`=比量程还差、`255`=未知）。2026-09 这里整体错了一档
   （见 `doc/MCP_DESIGN.md` §17），而且**测试是照着错的实现写的**，一起错。
   三条纪律：**"没给出/超量程/保留值"一律回 `null`**（`0` 也是结论，不能拿它冒充"不知道"）；
   **按长度认字段**（`2A2B`=10 / `2A0F`=2 / `2A14`=4，对不上就不猜）；三处一起改
   （`ble_cts_decode` / 前端 `BLE_CTS_CHARS` / `attach_cts_decodes`），
   改了必须同时核对 `gss/org.bluetooth.characteristic.{dst_offset,time_zone,time_source,time_accuracy,reference_time_information}.yaml`。
7. **BLE OTA 分两阶段落地：阶段 0 = 选固件 + 校验 + 读设备版本对比；阶段 1 = 真传输引擎。**
   ⛔ **但整条功能当前是「隐藏」状态**（用户 2026-09："OTA 的功能先隐藏起来吧"）：
   `src/js/84-ble-ota.js` 顶部的 **`var BLE_OTA_UI_ENABLED = false;`** 是唯一总开关 ——
   设备详情页不再渲染「固件升级」按钮，`openBleOtaModal()` 自己也直接 `return`（只藏按钮的话，
   一句手动调用就能把整条流程喊出来）。**为什么用开关而不是删代码**：阶段 0/1 的引擎、协议档、
   二次确认、危险登记与断言全都是好的，真正卡住的只有**真机协议里 `crc16()` 的参数**
   （实现在泰凌的预编译库 `liblt_8258.a` 里，见 `doc/BLE_OTA_TELINK.md` §6）——
   核对完把那一行改成 `true`，整条就回来。**别把按钮删掉**：那样再打开时没人记得还有哪些配套
   （`data-mcp-skip` / `MCP_SKIP_NO_TOOL` / 三份文档 / 断言）。断言里有四条守着这件事
   （开关是 false、关的理由写明、按钮真受开关控制、`openBleOtaModal` 自己也拒绝）。
   ⚠️ 顺带一句**已经查清的真机协议**：目标设备（TB 系列 = **泰凌微 TLSR8250**，不是 PHY/奉加微）
   走的是 **Telink OTA**，UUID 与帧格式都在 `doc/BLE_OTA_TELINK.md` 里（20 字节定长包 /
   `0xFF01` 开始 / `0xFF02` 结束 / 不等 ACK）。
   落地在 `src/js/84-ble-ota.js` + `main.rs` 的 `ota_pick_firmware` / `ota_inspect_firmware` /
   `ota_list_firmwares`（阶段 0）与 `ota_start` / `ota_status` / `ota_abort` + `ota_task_body`
   （阶段 1）；评估、协议选型与分期见 `doc/BLE_OTA_EVALUATION.md`。五条别改回去：
   ① **前端（`84-ble-ota.js`）里不许出现任何写入/断链调用**（`ble_write` / `ble_write_descriptor` /
   `ble_subscribe` / `ble_disconnect`）—— `.walkthrough` 里有一条断言专门扫这件事。理由不是洁癖：
   **半成品的固件写入 = 变砖**，而变砖的兜底只能在设备侧（双 bank / rollback），上位机做不到；
   阶段 1 的写入**全在 Rust 引擎里**，前端只有 `ota_start`/`ota_status`/`ota_abort` 三条命令；
   ② **固件路径只认用户在原生框里亲手选过的**（后端 `ota-firmwares.json`，LRU 20；前端传任意路径一律拒）
   —— 与快速指令同一套纪律；**固件字节从不进 IPC**（前端拿到的是校验结果，不是数据）；
   ③ **大小上限在读文件之前判**（`ota_check_size(meta.len())`，8 MB）—— 别等读完 2 GB 才发现太大；
   ④ **`md5_match` 的 `null` 与 `false` 是两件事**：认不出包头时是 `null`（"没有这个字段可校"），
   校验失败才是 `false`。混成一个就是界面对用户说谎。
   ⑤ **GATT 特征的 UUID 必须先归一化（`shortUuid`）再比，别拿完整 128 位字符串硬比** ——
   2026-09 真机事故（用户截图）：ai-thinker 设备的 `0x180A` 明明在服务树里，界面却报
   「设备未提供 0x180A」。而且**"找不到"必须分三态说清**（服务树是空的 / 确实没有 180A /
   **有** 180A 但没有版本类特征 —— 后者要把该服务下**实际有哪些特征**列出来，用户要知道该补什么），
   三件事报成一句话就是在说假话。判定抽成纯函数 `bleOtaReadBlockReason` 以便无头断言。
   ⚠️ **阶段 1（真传输）已落地，但它同样是"参数全部外置"的**：`main.rs` 的 `ota_start` /
   `ota_status` / `ota_abort` + `ota_task_body` 就是引擎。四条别改回去：
   · **协议档（`OtaProfile`）里一个 UUID / 分包 / 帧格式都不许预填** ——
     设备侧是自研私有协议，服务与特征 UUID、分包大小、ACK 方式、结束与重启语义**至今没给**；
     缺哪一项就**拒启动并说清缺哪一项**（`ota_profile_check`），别拿一个"像那么回事"的默认值去写设备。
   · **写入只发生在 Rust 侧**：前端只调 `ota_start` / `ota_status` / `ota_abort`，
     `84-ble-ota.js` 里**依然**不许出现 `ble_write` / `ble_write_descriptor` / `ble_subscribe` /
     `ble_disconnect`（断言扫这个文件）—— 一次 invoke 传不了 8 MB，而且"谁在写设备"必须只有一个答案。
   · **设备 ACK 走独立出口 `OtaAckSink`**（`BleState.ota_ack`）：通知循环在**产生处**多投一份，
     引擎按 `sink.pop()` 取 —— **绝不去 drain 前端轮询的 `notify_buf`**（单消费者队列，抢走就是
     "界面偶发丢通知"）。而且**写之前先 `drain_stale()` 清过期 ACK 并记进 `ack_stale`**：
     上一片多出来的通知若被当成这一片的 ACK，就会把"丢片"读成"成功"。
   · **只有单片 `ack_timeout_ms`，绝不设整体超时**（分钟级任务被整体超时会白写一遍）——
     `there_is_no_overall_timeout_constant` 那条 Rust 单测守着，别加全局 deadline。
   ⚠️ **`ack_mode: notify` 时"任何一条通知都算这一片的 ACK"是明处的取舍**（设备 ACK 格式没给，
   **不编匹配规则** —— 编错就是把丢片读成成功）。原文记进 `recentAcks` 显示在日志里，
   协议到位后再补匹配。同理：**结束帧没配就只是不发**，传完只如实说"设备多半不会生效"，
   绝不报「升级成功」。
   ⚠️ **人工二次确认是硬要求**：第一次点「开始升级」只把按钮改成「确认升级」+ 写一行日志，
   第二次才真的调 `ota_start`；**改协议档会收回这个状态**（`bleOtaProfileChanged` → `bleOtaDisarm`）。
   传输中锁住 关闭 / 换固件 / 改协议档（关了就没进度可看，而后端还在写），
   「中止」的文案必须写明**中止 ≠ 回滚**。
   ⚠️ **危险动作的登记是"三张表"，别只记两张**：界面上的危险按钮带 `data-mcp-skip`
   （`mcpBuildRegistry` 靠 `closest('[data-mcp-skip]')` 跳过 → AI 的 `ui_click` 点不到），
   而它登记在哪张表取决于**后端有没有对应工具**：
   · 有 → `MCP_DANGER_CONTROLS`（key 必须与 Rust `DANGER_TOOLS` 一一对应）；
   · 没有 → **`MCP_SKIP_NO_TOOL`**，并且**必须写明理由**（当前唯一一项就是 OTA 的
     「开始升级」：阶段 1 起它真的会写固件，而 MCP 的 `ota_start` 属阶段 3）。
   把没有工具的按钮塞进 `MCP_DANGER_CONTROLS` 会让"不漏也不虚"的对账断言当场 fail（虚报）。
   ⚠️ **弹窗布局与文案（都是用户 2026-09 的明确要求，断言守着）**：
   ① 弹窗里**不摆常驻说明文字**，也**不设结果提示区**（`#bleOtaNotice` 已删）——
   所有提示（选固件的结果、读版本的结果、为什么还不能开始）**统一走日志窗口** `bleOtaLog()`，
   它同时把同一份写进 BLE 面板的数据日志（MCP 的 `ble_get_output` 靠那份）。
   两块提示区并存必然漂移，所以只留一处；边界与阶段说明一律写进 `doc/BLE_OTA_EVALUATION.md`。
   ② **标题栏是三段**：左「固件升级（OTA）」、中**设备名 + MAC**、右**「读取版本」按钮**
   （`.ble-ota-verbtn { justify-self:end }`）。中间那列靠 grid `minmax(0,1fr) auto minmax(0,1fr)`
   才相对**整个标题栏**居中 —— 换成 flex + `text-align:center` 会变成"在标题右侧的剩余区域里居中"。
   设备名**不带「目标设备」前缀**（要求删）、未连接时才写「未连接设备」，内容区不再单占一行。
   ③ **名称与 MAC 是两个 span、MAC 用灰色（`--text-d`）当提示信息** —— 渲染走
   `bleOtaTargetParts()`（返回 `{name, mac}`），不是一个拼好的字符串；**长名称可省略、MAC 永远完整**
   （名字 `min-width:0` 可收缩，MAC `flex:0 0 auto`）—— MAC 被截掉就等于失去了"我在写哪台设备"的凭据。
   ④ **变砖风险提示放在内容区最前面、单行（≤42 字）**：
   `⚠️ 有变砖风险（设备需支持双分区/回滚）：勿断开设备、关闭程序或让设备走远。`
   —— 压在底部等于没写；**单行是刻意的**（超了会折行、再超只能截断，而安全提示被截断比折行更糟）。
   ⑤ **内容区顺序 = 风险提示 → 固件文件 → 协议档 → 更新进度 → 日志**（用户要求删掉原来那块
   「设备版本」、下方换成"更新进度 + 日志"；协议档是阶段 1 加的，默认收起、只占一行状态摘要）：
   `#bleOtaDevInfo` / `#bleOtaVerdict` 两个显示区**已删**，
   读到的版本按行写进日志（连带一行"固件 ↔ 设备版本"对照结论）；进度条（`#bleOtaBar` +
   `#bleOtaStage`）阶段 0 恒为 0% / 「未开始」，**阶段 1 起由 `ota_status` 轮询填数值**；
   ⚠️ **「未开始」这类阶段文字跟在「更新进度」标题右边**（用户 2026-09 要求：`<div
   class="ble-ota-sec-title">更新进度<span class="ble-ota-stage" id="bleOtaStage">…`）——
   单占一行会跟下面那条轨道脱开；而且它**必须显式写 `font-weight:400`**（标题是 600，
   不覆盖就跟着变粗、抢成第二重点）。
   日志窗口 `#bleOtaLog` **固定 132px 高、自己滚**（弹窗高度不跟着跳），上限 200 行且
   **丢弃记账**（`_bleOtaLogDropped`：超了丢最旧，并在窗口里说明省掉多少条）。
8. **设备名有两个来源（广播名 vs 系统名），只认广播名**：btleplug 的 winrt 后端在 `connect()`
   成功后拿 **Windows 的系统名覆盖 `local_name`**
   （`vendor/btleplug/src/winrtble/peripheral.rs` 里 "Query the system-cached device name" 那段，
   **不是**我们那 4 处补丁之一；那个名字就是 WinRT 的 `BluetoothLEDevice.Name`，
   见 `ble/device.rs` 的 `fn name()`），而 `advertisement_name` 仍是广播里的名字。三条别改回去：
   ① **展示名一律 `advertisement_name || local_name`（广播名优先）** —— 用 local_name 优先会让
   名字在**连上那一瞬间跳变**，而且"卡片名"与"广播内容 → 广播名"两行会互相矛盾
   （2026-09 用户报的"左侧设备名出错了"就是这个：列表写 `tSample`、广播名写 `ai-thinker`）。
   断言守着优先级，写反就 fail；
   ② **那个系统名不进界面**：用户 2026-09 直接判定「`tSample` 是误识别」—— 它不是我们从报文里
   解出来的（我们只解析 AD 段），而是 Windows 那一侧的名字投射/缓存，**可能是设备从来没叫过的名字**。
   所以既不当主名、也不单列展示（曾经加过一行「系统名」，已删）；只在设备**根本没广播名字**时
   才拿它兜底，否则界面上只剩"未知设备"。要确认设备自称什么，读 `0x1800` 下的 `0x2A00` Device Name
   —— 那才是权威值；
   ③ ⚠️ **别去改 vendor 让系统名不覆盖**：那是上游语义，在展示层定优先级就够了 ——
   动 vendor 要再加一处补丁、还要同步 `VENDOR.md`，成本不值。

## 窗口几何记忆的三条约定（别改回去）

窗口位置/尺寸/最大化由 **Rust 端** `%APPDATA%\seahi-serial\window.json` 统一管（`SavedWindowState`），
详见 `doc/ARCHITECTURE.md` §6.10。三条踩过的坑：

1. **`tauri.conf.json` 的主窗口是 `visible:false`，所以"把窗口显示出来"是一等公民**：任何让初始化
   走不到"页面就绪"的路径都必须能露出窗口 —— 前端 `revealMainWindow()`（`reveal_main_window` 命令）
   在成功、`catch`、`showFatalError` 三处都要调，Rust 端另有 4 秒兜底 `show()`。
   少一处就是"应用启动了但用户看不到窗口"，而且**报错页自己也看不见**。
2. **`config.json` 的 `windowWidth`/`windowHeight` 仍然要写**（`collectConfig`）：MCP 的
   `ui_get_state` 的 `window` 分支读它，同时它是老版本升级上来的迁移兜底
   （`legacy_window_state_from_config_json`，只取尺寸不取位置）。删了就两个功能一起坏。
3. **位置存 `outer_position()`、尺寸存 `inner_size()`**，且非强制的自动保存只在窗口可见时执行、
   最小化/最大化状态下不改写普通几何 —— 这三条各自对应一类真实故障：窗口每次开关往右下漂移、
   启动期隐藏窗口的瞬时尺寸（2068×2060）被写进记录、`-32000` 哨兵坐标污染位置。

## MCP 的十二条关键约定（别改回去）

1. **MCP 服务器必须在应用进程内**：它要拿 `AppHandle` 才能访问托管状态、还要 `emit` 驱动 WebView 的 DOM。
   外部独立进程（含"做成 npm 包"）两样都做不到 —— 详见 `doc/MCP_DESIGN.md` §3.4。
2. **绝不加 `panic = "abort"`**：工具里任何一次 panic 都会杀掉整个进程（用户的串口会话就没了）。
   分派边界**真的有** `catch_unwind`（`handle_raw_guarded`，2026-09 补上 —— 在那之前文档一直
   声称有、实际全 crate 都没有），panic 会转成一条 JSON-RPC 错误 + 一次错误上报。
3. **工具改界面一律走"合成 DOM 事件"**（`el.click()` / 派发 `input`+`change`），复用既有 inline handler。
   不要为 AI 单写一套逻辑，否则两套必然漂移。
4. **AI 记录只写 `ai-config.json` / `ai-calls.jsonl`**，`config.json` 里绝不能出现 AI 痕迹
   （断言集里有专门守这条的检查）。AI 配置一律原子写（临时文件 + rename，别重犯 M7）。
5. **只监听回环**，`server.host` 只接受 `127.0.0.1`/`::1`/`localhost`；`/healthz` 是唯一免鉴权端点，
   且**只回 `{"ok":true}`**（泄露版本号等于给本机任意进程一个信息泄露点）。
6. **日志旁路必须挂"生产端"且非阻塞**：写日志的可能是串口读线程（25ms 轮询，延迟敏感），
   所以 `LogHub::push` 用 `try_lock`，拿不到锁就丢一条并计数。**绝不去 drain 前端轮询的队列**
   （那是单消费者队列，抢走会让界面丢数据）。另外**内存上限必须是被执行的、不只是被报告的**：
   通道名是动态的（`serial:<面板>:<方向>`，开 N 个监视器就多 2N 个通道），所以除了每通道上限，
   还必须有**全局** `TOTAL_CAP_BYTES`（超了按"裁最大的通道"尽力回收，`try_lock` + 单次最多 4 个通道）
   与 `MAX_CHANNELS`（到顶不建新通道，丢弃计入 `channelSkips`）。
   ⚠️ **丢弃必须记账，而且要能被读出来**（这条已经踩过四次）：串口缓冲丢的字节（`ReadDataResult.dropped`）、
   BLE 通知丢的条数（`{items, dropped}`）、ADB PTY 丢的块数（`{bytes, dropped}`）、
   前端待发队列丢的条数（`log_push_batch` 的 `droppedByChannel` → 各通道 `dropped`）——
   四路都要传回界面/工具并提示一行。只有 LogHub 内部的 `channelSkips`/`lockSkips` 是纯内部计数。
   不做这件事的后果不是"少几条日志"，而是**工具明确告诉调用方"日志是完整的"**（`mayBeIncomplete:false`），
   于是 AI 拿被截断的证据下结论（2026-09 审计在 ADB 与前端回灌两路上都发现了）。
   ⚠️ **每条日志还带一个「来源」`src`**（2026-09 用户提的："AI 发送的数据在日志里要和接收的区分开"）：
   `ai` = AI 通过 MCP 触发、`ui` = 用户手动、`none` = 未标记。因为 MCP 发送与用户点按钮
   **走的是同一条路**（`serial_send` 就是"填进输入框 + 点发送按钮"，见 #3），光看内容分不出是谁发的。
   三条别改回去：① **前端三处必须成对** —— `mcpSerialOp` 的 send 分支先挂 `_mcpAiSend` 标记
   （**必须早于 `click()`**：click 是同步派发，反了 sendData 已经跑完、认领不到）→ `bufferPush`
   认领它（认领到就把那条标 `ai`）→ **没被认领就补记一条**（echo 关着 / 输出区没渲染时那次发送
   本来完全不进日志中心；补记是为了"AI 干了什么一定可追溯"，不是可有可无的装饰）；
   ② **这一跳不许丢字段**：前端 push → `log_push_batch` 入参 → `push_batch_into` → `LogHub::push_src`，
   少解析一次功能就静默失效、而两端单测各自全绿（AGENTS #9 的老教训，已有测试守着）；
   ③ **text 编码里必须把它写出来** —— `dir` 能从通道名推（`serial:<分栏>:rx|tx`），`src` 推不出来。
   BLE 的写日志也回灌到 `ble:tx` 通道了（**只回灌 tx**：rx 那边 Rust 侧已在推 `ble:rx`，再推一遍就是逐条重复）。
7. **`expose.autoControlTools` 默认关闭**：几百个 `ctl_*` 工具会明显拖累模型选工具的准确率。
   要打开就打开，但别改成默认开。
8. **运行期错误必须进错误上报**（不只是写本地日志）：MCP 出问题以前只写 `dbg_log`，用户报障时
   既看不到也数不清。现在统一走 `mcp::report::report(kind, detail)` → 程序既有的 `report_error`
   （LogHub 的 `error` 通道 + 本地日志 + Sentry + 自建服务/SQLite）。三条纪律：
   ① **同类错误 5 分钟内只报一次**（`DEDUP_WINDOW_SECS`）—— 服务端去重是最后一道闸，
   不能让一个每秒重试的客户端把网络和库打爆；② **上报前把 token 打码**（`remember_secret`
   在启动时登记当前令牌）；③ **上报路径自己不阻塞、不 panic**。
9. **回执那一跳（`mcp_ui_ack`）不许丢字段**：前端的 `notFound` / `invalidParams` 是后端判定
   `-32602`（"参数/路径有问题 → 改参数重试"）还是 `-32006`（"工具跑了但没成 → 先做前置操作"）
   的**唯一依据**。丢一个字段 = 一整类错误码变成错的，而且**两端各自的单测都会是绿的**
   （2026-09 真机检查：`notFound` 就是这么丢的，`unwrap_ui_result` 里那条 `-32602` 分支
   在真机上从未生效）。加字段时三处必须一起改：前端 ack → `mcp_ui_ack` 入参 → `ui_ack_payload`，
   并由 `ui_ack_reply_shape_is_complete` 从 ack 入参**一路测到错误码**。
   ⚠️ **而且这一跳必须能等 Promise**：`mcpHandleUiCmd` 有不少分支返回 Promise（连设备 / 读写特征 /
   从机启停 / 读 RSSI…），直接读 `res.ok` 会永远是 `undefined` → 回执变成 `ok:false` + `error:null`
   → 客户端只看到一句没头没尾的**"前端执行失败"**（2026-09 真机实测 `ble_periph_status` 就是这样：
   真实原因是"从机模式没开"，AI 却什么都不知道）。现在统一走 `mcpUiCmdReply(cmd, ackFn)`
   （`Promise.resolve(res).then(send, …)`），断言集里 7 条守着它（同步/异步/抛错/被拒/字段回传）。
10. **MCP 的运行不得影响主程序**（用户明确要求的硬约束，不是"尽量"）。落实到代码是这几条：
    ① 串口收发热路径上只有一次**非阻塞**日志旁路（`LogHub::push` 用 `try_lock`，拿不到锁就丢一条并计数；
    全局回收也是 `try_lock` + 单次最多 4 个通道，收不动就等下一条）；② 错误上报走**独立上报线程的
    channel**（`ERROR_SENDER`），Sentry SDK 自己缓冲；③ SSE 出站是「**有界队列 + `try_send`**」——
    生产者绝不 `await`、绝不阻塞，慢客户端直接断开；④ 界面命令有在途上限（32）与**分档超时**
    （界面动作 5s、要过设备的 BLE 动作 30s、`ble_connect` 130s）。**别把桥超时改回一律 5s**：
    前端的连接路径是"首连 15s + 配对 75s（**等用户在 Windows 配对框上点确认**）+ 重连 15s"，
    桥按 5s 算必然给 AI 一个假失败（`-32004` + 误导性的"界面可能正忙"），而操作其实还在正常进行。
    分档在 `bridge.rs::timeout_for`，`.walkthrough` 里有跨端断言守着这三者的相对关系；
    ⑤ 工具 panic 由 `catch_unwind` 兜住（见 #2）。
    ⚠️ **加新工具时先问一句"它的输入有上限吗"**：任何接受外部数组/字符串的参数都必须在
    `mcp_limits` 里有对应上限，且校验要发生在**碰主程序之前**。`MAX_UI_SET_ITEMS` 就是教训 ——
    `ui_set` 最终跑在 **WebView 主线程**上，请求体虽有 1 MiB 上限，但一条 item 才 40 多字节，
    1 MiB 能塞两万多条，等于"AI 一句请求把界面冻住几秒"。
    ⚠️ **而且"在 `mcp_limits` 里报出来"≠"被执行"**：`MAX_QUICK_CMD_*`（500 条 / 64 / 4096 字符）
    曾经只在 `limits_json` 与文档里出现、代码里一次都没校验过（2026-09 审计发现）—— 超长的指令内容
    会一路写进 WebView 的输入框，还会撞上 256 KB 的写回上限：工具已回 ok，改动却没落盘。
    另外**单条数据的长度也要有上限**：只挡条数挡不住"一条 100 万字符的字符串"
    （`MAX_UI_SET_VALUE_CHARS` 就是补的这一块）。校验只在**写入口**做是不够的 —— 同一个上限
    要同时出现在读入端与写入口，否则"内存里有、写回时被截断"会让用户数据不可逆丢失。
11. **每个工具都必须有"返回值契约"和"调用情况"测试**（用户的要求："不然预期的结果怎么确定
    是否已经完成？"）。三条一起才叫测过：
    ① **返回值契约**（`every_tool_has_a_tested_return_contract`）：54 个工具每个都要在表里交代
    清楚 —— 纯后端工具断言**顶层字段**（多一个少一个都要改契约），界面工具断言无界面时
    必须是 `isError` + `-32006`，有副作用的注明谁在管它。表里漏一个工具就 fail，
    所以**新增工具时必须一起想清契约**。三条全局不变量对所有工具生效：
    `structuredContent` 必须是对象、键必须 camelCase、**文本摘要必须真的把数据说出来**
    （只写"N 项"就等于把数据藏起来 —— `serial_list_ports` 的端口名就是这么消失的）。
    ② **调用情况**（`every_ui_tool_sends_the_expected_op_and_returns_expected_shape`）：
    界面工具靠单测专用的假前端（`McpCore::test_ui`）真的调一遍，钉住**发给前端的 op/参数序列**
    与**拿到回执后的返回**（包括 `serial_open/close` 的幂等分支与"点完轮询确认"那段）。
    ③ **跨边界**：断言集里扫 protocol.rs 发出的每个 `op`/`action`，要求 index.html 真有对应分支 ——
    "后端发了、前端没有"会静默失败，而两边各自测自己那一半时全是绿的。
    ⚠️ 假前端只证明 Rust 这一半；前端那一半必须由 `.walkthrough` 用**真实 handler** 跑。两边成对，缺一边就是假的安心。
    ④ **端到端**：`node .walkthrough/mcp_smoke.js` 对着**正在跑的应用**把每个工具真调一遍并打印结果
    （安全模式下写工具用"必填缺失/无 confirm"探针，不产生副作用）。它还能一眼看出"客户端为什么看不到
    新工具"——**运行的是旧构建**。Rust 侧另有两条守着"结果真的说出来了"：每个工具的文本摘要里必须
    出现 structuredContent 里的至少一个真实取值（`leaf_scalars`），以及 `ble_list_devices` 的摘要里
    必须有设备 MAC 与名称。
    ⑤ **"AI 怎么知道该用哪个工具"也要守**（2026-09 补）：AI 只认协议里传过去的四个通道 ——
    `initialize.instructions`、`tools/list` 的 `description` 与字段描述、以及运行时的错误码；
    **`doc/` 下的文档它一个字都看不到**（那是对人写的）。三条别改回去：
    · **`instructions` 放"场景任务链"**（哪个面板走哪条链、"读内容该选哪个"这种最容易选错的
      一组工具要摆在一起对比），而工具自己的参数细节与坑点留在它自己的 `description` 里 ——
      抄一份必然漂移；
    · **`description` 首句要说"什么时候用它"**（首句是最不容易被截断的位置）；
    · **`annotations` 的"只读"必须来自显式登记的 `READ_ONLY_TOOLS`**，破坏性来自 `DANGER_TOOLS`；
      `annotations_for` + `annotate_tools` 在 `tool_defs()` / `exposed_tools()` 返回前统一注入。
      ⚠️ **绝不能用"不在 `WRITE_TOOLS` 里就当只读"** —— 名字判断不出读写，那等于"漏登记时
      **主动说错话**"：客户端被告知"它只读"、只读模式也不会拦它，两边一起错（2026-09 第一版
      就是这么写的，被自己的断言当场抓出来）。也不许给 `SOMETIMES_WRITE_TOOLS`（性质随调用变的
      那两个）标 `readOnlyHint`。它是**提示不是约束**：不替代只读模式的 `-32007`，也不替代 `confirm:true`。
    三条断言守着：`descriptions_only_reference_real_tools`（描述里点到的工具名必须真实存在，
    否则 AI 会照着**幽灵工具**调，而两端单测都是绿的）、
    `annotations_agree_with_write_and_danger_tables`（标注必须与真正的拦截逻辑一致），
    以及 `every_tool_is_explicitly_classified`（**每个工具都必须被显式分类**为读 / 写 / 按调用变，
    三张表不重、不漏、不过期 —— 新增工具忘了登记会 fail，不会静默落到只读那一侧）。
12. **两种 MCP 传输并存，别拿一个换掉另一个**：`/mcp`（**Streamable HTTP**，2025-03-26+ 规范，新版客户端
    VS Code / Cline / 新版 Cursor / Claude Code 默认走它）与 `/sse` + `/messages`（遗留 SSE，只支持 SSE 的
    老客户端）**共用同一套工具、同一张会话表与同一份上限**。落地记录见 `doc/MCP_DESIGN.md` §17 的
    2026-09-16 一条。四条别改回去：
    ① **`POST /mcp` 直接回 `application/json`** —— 我们的工具是一问一答（没有进度通知、没有中途消息），
    规范允许服务器在 JSON 与 SSE 之间二选一；别为了"更像规范"去实现"POST 返回 SSE 流"，
    那只是多一层分帧、多一处能出错的地方；
    ② **表满时只淘汰最久未活动的 HTTP 会话**：SSE 会话的长连接已经建立，把表项删掉只会让它变成
    收不到东西的僵尸；也**不能**直接回 429（客户端拿到 429 无从下手，只能干等 30 分钟空闲回收 ——
    会话泄漏那次就是这么炸的）。HTTP 会话被淘汰是干净可恢复的：下次请求得 404，按规范重新 `initialize`。
    ⚠️ **判据是 `Session::kind`，不是 `tx`**：`tx` 只表示"有没有推送通道"，而 HTTP 会话按规范挂上
    `GET /mcp` 流之后也有 `tx` —— 用它当判据会让这类客户端**全部变成"不可淘汰"**，4 个占满后第 5 个
    直接吃 429（2026-09 实测证实：淘汰候选 = 0 → `HTTP/1.1 429`；回归测试
    `http_sessions_with_a_get_stream_are_still_evictable` 守着）。同理 **`DELETE /mcp` 只许删 HTTP 会话**，
    目标是 SSE 会话时回 404（403 等于告诉对方"这个 sid 存在，只是不归你"）；
    ③ **`GET /mcp` 的流断开只摘通道、不删会话**（`SseBody::keep_session`）—— 那个会话还要继续给 POST 用；
    ④ **新入口必须共用** `read_body_limited`（1 MiB 上限：先看 `Content-Length`，再用 `Limited` 兜住 chunked）
    与 `handle_raw_guarded`（panic 兜底）—— 断言集里有两条专门数这两处的调用次数，少一处就 fail。
    另外 `/mcp` 是唯一做 `Origin` 校验的路径（只放行回环，防 DNS rebinding；不带 Origin 的 SDK/curl 不受影响），
    `MCP-Protocol-Version` 不认识的值回 400 **并把支持列表写进响应体**（光一个 400，调用方只能靠猜）。
    客户端配置里 http 传输的 `type` 写法**各家不统一**（VS Code 用 `http`、Cline 认 `streamableHttp`），
    所以弹窗与 npm 安装器两种都给 —— 写错的典型表现是客户端**静默**按遗留 SSE 解析，然后一句没头没尾的"连不上"。
    ⑤ **传输是三档的**（`server.transport`：`both` 默认 / `http` / `sse`），不是"两种都必须开着"：
    选单档时另一条端点返回 404（**立即生效**，路由每次请求都读配置，不用重启）；界面只展示当前档的连接方式。
    界面上它是一个**下拉框**（`HTTP` / `SSE` / `All`），与「启用/关闭 MCP 服务器」「只读模式」挤在**同一行**
    （从左到右：开关按钮 → 下拉框 → 只读模式 → 右端重置令牌）。三个选项的后果、以及只读模式的**开/关状态**
    都写在**悬停说明**里 —— 用户明确要求界面不摆灰字提示、按钮文案也不带状态（"只读模式：开（AI 只能看）"
    改成固定的「只读模式」，状态只进悬停说明；"写操作全被拒（-32007）""两条都在跑…"也删了，**都别再加回来**）。
    ⚠️ **这些说明不能再用原生 `title` 承载**（用户看界面后提的两条意见，都是 title 的固有毛病）：
    ① 它"鼠标一扫就弹"，划过一排按钮会**一闪一闪**；② 它一行铺开不换行，长说明**横跨整个窗口**；
    ③ 它还会被控件注册表当成 label 抄给 AI（`mcpMakeEntry` 读的是 `title || aria-label`），
    于是 AI 在 `ui_list` 里看到的"控件名"是一整句话。所以：说明走 **`data-mcp-tip`**（文案里的换行用 `&#10;`），
    由 `mcpTipBind()` **停顿 450ms** 才显示在弹窗里那块**常驻说明区**（`#mcpTipRow` + `.mcp-tip`，
    `min-height` 占位不跳动、`pre-line` 能换行）；控件名交给简短的 **`aria-label`** ——
    **删了 title 必须补 aria-label**，否则 label 会退化成元素 id（AI 那边等于失去了这个控件的说明）。
    按钮文案固定之后，**在途反馈也要留个出口**（这里是把说明置为「处理中…」），否则"点了没反应"的观感会回来。
    改这块时守住两条纪律（下拉框那一层还有一条：在途要禁用、**失败要把选中值拨回真实值** ——
    否则界面停在一个没生效的值上，比报错更让人困惑）：
    **其一，默认必须是 `both`** —— 不能让"升级"本身把某类客户端弄断（用户没做任何选择）；
    **其二，迁移必须在 `load_in` 里做规范化**（老配置只有 `streamableHttp` 这个 bool）：只在序列化端处理的话，
    `transport` 会是 `null`、老字段被 `skip_serializing` 丢掉，于是"只 SSE"的意愿**在写回一轮后就变成 both**
    （有回归测试 `old_config_migrates_transport_mode` 守着"读进来 sse → 写回 → 再读还是 sse"）。
    端点发现文件里**不提供的那条 URL 写空串**，别留一个必然 404 的地址；npm 安装器的 `readEndpoint`
    也因此不能强求 `url` 存在（只提供 `/mcp` 时它就是空的）。



## 项目结构

- `src/index.html` + `src/css/*.css` + `src/js/*.js` — **整个前端**（无框架、无打包器、无构建步骤；2026-09 从单文件拆成 4 个 CSS + 16 个 JS + 272 行骨架，含 12 套主题变量；串口 / WSL / ADB / 蓝牙 四个面板）。其中 `src/js/81-ble-uuids.js` 是**生成文件**（SIG 官方 UUID 名称表，见下）；`src/js/84-ble-ota.js` 是**拆分后新增**的 BLE 固件升级（OTA）面板，**阶段 0 + 阶段 1 都已落地**（真传输的引擎在 Rust 侧，见 `doc/BLE_OTA_EVALUATION.md` §5.1/§5.2），但**界面入口当前被 `BLE_OTA_UI_ENABLED = false` 隐藏着**（见第 7 条）
  **目录结构、加载顺序、"原 index.html 行号 ↔ 新文件"映射、以及拆分时逐字符校验的记录，全在 `doc/FRONTEND_LAYOUT.md`** —— 改前端前先看它（尤其"只用普通 `<script src>`、绝不用 `type="module"`"这一条）
- `src-tauri/src/mcp/` — **MCP 服务器**（模块级，约 6300 行）：`transport.rs`（hyper 服务器 + **Streamable HTTP `/mcp`** + 遗留 SSE `/sse` + 会话/鉴权/限流/广播）、`protocol.rs`（JSON-RPC + 工具定义与分派）、`bridge.rs`（前端桥：emit + 回执 + 超时回收）、`registry.rs`（控件注册表 → `ctl_*` 工具）、`loghub.rs`（日志中心）、`calllog.rs`（`ai-calls.jsonl`）、`aiconfig.rs`（`ai-config.json`）、`report.rs`（运行期错误 → 程序既有的错误上报通道）、`mod.rs`（启停/生命周期 + 10 个命令）
- `npm/seahi-serial-mcp/` — **MCP 客户端配置安装器**（零依赖 CLI + 94 条自测；`npx seahi-serial-mcp install`，`--transport sse|http`）
- `doc/MCP.md` — MCP 使用说明（面向使用者）｜`doc/MCP_TOOLS.md` — **54 个工具的参考手册**（工具名/描述/入参由 `.walkthrough/gen_mcp_tools_doc.js` 从 `protocol.rs` 生成，返回结构是实调抓的）｜`doc/MCP_DESIGN.md` — MCP 设计文档（含每步的实施记录）
- `src-tauri/src/main.rs` — 整个 Rust 后端（约 8360 行，94 个 `#[tauri::command]`）：串口枚举（SetupAPI）、多串口连接/断开、DTR/RTS 切换、收发数据、WSL 端口映射、USB 设备管理、ADB 会话、**快速指令外部文件（导入/导出/写回，见 `quick_cmds_*`）**、**BLE 主机（btleplug；原「BLE 从机」方向已于 2026-09 删除）+ BLE OTA 阶段 0/1（`ota_*`）**。⚠️ BLE 的类型别名与 `BleState` **在模块级**（阶段 1 的引擎要能被无盘单测覆盖），**既有 BLE 命令仍在 `fn main()` 内** —— 加新 BLE 代码时先确认自己在哪一层（模块级看不到 `fn main()` 里的东西）
- `src-tauri/Cargo.toml` — Rust 依赖（serialport 3.3, rfd 0.15, winapi 0.3, windows-sys 0.59, **windows 0.62 + windows-future 0.3（BLE 配对用 WinRT）**, **tokio（`time::timeout` + MCP 的 `rt/net/sync/io-util`，刻意不开 `macros`）**, reqwest 0.12, base64 0.22, btleplug 0.13, **hyper 1 + hyper-util + http-body-util + bytes（MCP 的 SSE 服务器；都已由 reqwest 带入依赖树，无新增下载）**）
- `src-tauri/vendor/btleplug/` — **btleplug 的 vendored fork**（`[patch.crates-io]` 指向此处），共 4 处本地补丁；**升级依赖时必须按 `vendor/btleplug/VENDOR.md` 重新打**
- `src-tauri/tauri.conf.json` — Tauri 窗口配置，CSP 设为 `null`；**不要擅自设 CSP**：Tauri 会注入 nonce，按规范 `'unsafe-inline'` 即失效，本应用的行内 `style="…"` 属性与行内 `onclick`（拆分时 HTML 里 51 处 + JS 模板串里 151 处）会全被拦（界面掉样式、按钮点了没反应）。要设 CSP 必须先做「事件委托化 + 行内样式外置」重构。
  ⚠️ 2026-09 拆分已把**内联 `<style>` 块与内联 `<script>` 块**外置成 `src/css/*` `src/js/*`（这一步做掉了），但**行内 `onclick` 与 `style="…"` 属性仍在**，所以"设 CSP"仍然是不能顺手做的一件事
- `src-tauri/capabilities/default.json` — 窗口/Webview 的 ACL 权限（仅 `core:*`，无 shell/fs/http 插件权限）
- `src-tauri/wsl-daemon/` — WSL bridge 脚本（base64 编码嵌入）
- `installer.iss` — Inno Setup 安装脚本（包含 usbipd-win.msi 打包）
- `doc/FRONTEND_LAYOUT.md` — **前端目录结构**（4 个 CSS + 16 个 JS + 骨架的加载顺序、生成文件 `81-ble-uuids.js` 的来源与纪律、拆分后新增的 `84-ble-ota.js`、原单文件行号映射、拆分校验记录）
- `doc/` — 架构、交接、代码评估（`CODE_REVIEW_FULL_2026-09.md`）、BLE 真机验证（`BLE_VERIFICATION.md`，主机方向）、**BLE 从机（`BLE_PERIPHERAL.md`，已归档：确认做不出来、代码已删）** 等
- `skills/seahi-serial-dev/SKILL.md` — AI 开发技能指南

## 版本号同步

发布时版本号必须**同时更新 4 个文件 + 锁文件**（漏改会导致"装着 0.3.6 却提示 0.3.7"这类更新异常）：
1. `src-tauri/Cargo.toml` → `version`（运行时版本来源：`env!("CARGO_PKG_VERSION")`）
2. `src-tauri/tauri.conf.json` → `version`（安装包 / MSI 版本来源）
3. `installer.iss` → `MyAppVersion`
4. `package.json` → `version`（曾漂移成 0.3.0，已修正）
5. `src-tauri/Cargo.lock` → `seahi-serial` 条目的 `version`

> CI 已在构建前**自动校验版本一致性**（`.github/workflows/build.yml` 的 `Verify version consistency` 步骤）：
> 上述 5 处必须完全一致；tag 触发时还要求 tag == `v{版本号}`，否则构建直接失败。
> 详见 `doc/CODE_REVIEW_FULL_2026-09.md` M25（状态：✅ 已修，v0.4.0 落地）。

> ⚠️ **改完版本号必须重新编译发布产物**：主程序版本来自 `env!("CARGO_PKG_VERSION")`，是**编译期烘焙**进
> exe 的 —— 只改文件、不重编，`src-tauri/target/release/seahi-serial.exe` 里仍是旧版本号（2026-09 真实
> 事故：安装包文件名/产品版本 0.5.0，装出来的应用却是 0.4.0）。本地打安装包前先 `npm run build`
> （或 `cargo build --release --manifest-path src-tauri/Cargo.toml`）；`installer.iss` 顶部已有 ISPP
> 编译期守卫（主程序 exe 版本 ≠ `MyAppVersion` 直接 `#error`），并会用 `#pragma message` 打印实际版本。

## 关键约定

- Release 构建通过 `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` 隐藏控制台窗口
- 串口友好名称直接调用 Win32 SetupAPI（UTF-16），避免 `serialport` crate 读取中文设备名时乱码（U+FFFD）
- 前端通过 `withGlobalTauri: true` 与 Rust 通信，无 npm 桥接包
- CSP 设为 `null`，无内容安全限制
- **每个"会滚动"的区域都必须有滚动条样式**（2026-09 用户要求"确认所有的滚动条都已经做了美化"）。
  改 CSS 时新加 `overflow:auto/scroll` 就得同时写 `::-webkit-scrollbar` 那一套
  （尺寸 + track + **corner** + thumb + thumb:hover）；`corner` 最容易漏，漏一个就是横竖交汇处
  的一个白方块（深色主题下尤其刺眼）。**有意隐藏**滚动条的（`.sel-drop` / `.no-scrollbar` / xterm）
  也必须有规则，写 `display:none` / `scrollbar-width:none`。`.walkthrough` 里有**两条对账断言**守着：
  "所有 `overflow:auto/scroll` 的选择器 ⊆ 所有 `::-webkit-scrollbar` 的选择器"、
  "所有设了尺寸的滚动条规则都有同名 corner" —— 漏一处就 fail，不必靠人眼看界面（有些区域要先展开、
  要连上设备、或只在特定主题下才看得见）。2026-09 这次就是靠它对账查出**6 处漏美化 + 3 处漏 corner**。
  ⚠️ 另：别再写"corner 规则数量 === 4"这类断言 —— 一加滚动区就得改数字，而那正是最容易漏 corner 的时刻
  （原断言就是这么当场 fail 的，已改成按选择器集合对账）。
- **release 构建不带 DevTools**（用户要求）。真正的开关是 **tauri 的 `devtools` cargo feature 必须保持关闭**：`tauri-runtime-wry` 里那段 `with_devtools(..)` 被 `#[cfg(any(debug_assertions, feature = "devtools"))]` 整个门控，所以 release（`debug_assertions` 关闭）只要不开这个 feature，那段代码根本不编译，落到 wry 自己的默认值 `false`。**debug 构建仍然有 DevTools**（内存分析要靠它）。⚠️ `tauri.conf.json` 里的 `devtools` 字段是**死配置** —— tauri 2.11.2 / codegen / build 里没有任何代码读它（逐个 crate 搜过），写了也不生效，只会让人误判，**别再加回去**（断言集里两条守着）
- 磁盘上的程序名为 `seahi-serial.exe`（带连字符）；Rust 包名为 `seahi_serial`（带下划线）
- **`platform-tools` 会被自家 adb 服务器锁住，安装器必须先停掉服务器**：`adb` 启动的服务是常驻后台进程（应用退出后依然活着，直到 `adb kill-server` 或注销），它把 `{app}\platform-tools` 下的 `adb.exe`、`AdbWinApi.dll`、`AdbWinUsbApi.dll` 全部映射住 —— 运行中的 .exe 无法就地覆写，已加载的 DLL 连删除都不允许。所以重复安装/升级会重试 4 次后弹「尝试复制下列文件时出错」，同 AppId 升级时旧版卸载器也删不掉 `{app}`。`installer.iss` 的 `StopAdbServer` 在 `PrepareToInstall` / `ssInstall` / `usUninstall` 三处**只结束镜像路径位于本应用 `platform-tools` 下**的 adb（别误伤 Android Studio 等其它来源）；`[Files]` 用 `replacesameversion`（不是 `ignoreversion`）+ `restartreplace`/`uninsrestartdelete` 兜底。注意 `adb.exe`/`fastboot.exe` **没有版本信息**，按 Inno 规则每次安装仍会覆写它们，靠的就是先停服务器
- 设备插拔检测使用 `CM_Register_Notification`（windows-sys crate），触发 `device-changed` 事件
- **快速指令的外部文件：路径只认"用户在原生框里亲手选过"的**（`save_log` / BLE 从机配置同一套纪律）。
  `quick_cmds_pick_file` / `quick_cmds_export_file` 弹原生框并把路径记进**后端自己的**
  `%APPDATA%\seahi-serial\quick-cmds-files.json`（LRU 上限 50，前端碰不到这张表）；`quick_cmds_read_file` /
  `quick_cmds_write_file` **只接受表里的路径** —— 绝不能让前端传任意路径进来，那等于给本机任意进程一个
  文件读写原语（MCP 工具也不接受路径，只操作界面）。另外三条同样别改回去：**写回是原子的**（临时文件 +
  rename）、**写回前比对内容哈希**（文件被别的编辑器改过就报冲突，不静默覆盖；**只有成功读过一次、
  手里有哈希的挂载才允许写回** —— 没有基线就拒写，两端各拦一道）、**沿用读入时的编码**
  （UTF-8/BOM → 失败回退 GBK，别把用户的 GBK 文件写成乱码）。前端一侧：文件即存储，增删改都写回
  （去抖 600ms）；解析**绝不按逗号切分**（AT 指令里逗号是常态）；注释与额外列按原位置保留（块序列），
  别用"读进列表再重新生成一份"的做法；**文件头（YAML `---` / TOML `+++` front matter）原样保留但不解释**
  —— 不识别它的话 `baud: 115200` 会被当成一条指令读进来、写回时还会被转成表格行（实测踩过）；
  `baud`/`mode`/`lineEnding`/`delay`/`expect`/`timeout`/`hex` 这些 key 要提示"暂不生效"，别做静默 no-op。
  另有两条同属"别改回去"：**每条指令的 `seq`/`timeout`/`expect`/`retry`/`hex`（顺序号/超时/期望/重试/HEX）
  只认"表头声明了列名"的列** —— 表头写了 `顺序号 / 超时(ms) / 期望 / 重试 / HEX` 才读进来、才写回同一列
  （**旧列名「延时」按「超时」解读**、导入时提示一次；那一格的含义已从"发完隔多久再发下一条"
  变成"最多等多久"）。「期望」「重试」**面板上没有入口**（写在文件里），可发现性靠"超时格描淡边 +
  悬停列出内容 + 导入时提示一次"，导出（自包含副本）一定写这两列；
  **没有这些列的文件一律按老规矩**
  （第 3 列起是用户的备注，原样保留），绝不按列号硬塞（那会把用户写在第 3 列的「备注甲」读成顺序号、
  再改写成 `0`，真丢数据）；**写回挂载文件不擅自补列**（用户的表结构由用户定），
  需要自包含的快照走「导出」——导出的是副本，一律补全这几列（纯指令行载体放不下就升级成
  Markdown 表格并提示；**导出物不带「名称」列**，面板里没有名称入口，文件就该与面板一一对应；
  导出**默认名按监视器区分**：`main` 是 `quick-cmds.md`，WSL/额外分栏/蓝牙内嵌各带自己的 mid，
  免得连点两次导出盖掉前一份；导出是直接写文件、**不走写回的哈希冲突检测**，所以盖到别人挂载的
  文件上时会当场提示）。
  以及**整行都空的条目不写回文件**（写进去也活不过一次重载：解析端把空行当结构行丢掉；
  但表头声明了 顺序号/超时/HEX 的文件里，"还没填内容、参数格有值"的行**必须留着** ——
  跳掉它，导出/写回的条数就跟面板对不上了）。用户没填过的参数格写回时**保持空格**
  （别把缺省值硬写进他的表）。
  另一个"别改回去"（2026-09 加的循环组）：**一组一张表、循环顺序 = 组的上下顺序 → 组内顺序号**，
  组的上下顺序**靠拖抬头调整**（拖到最上面的那组就是循环起点），组名可重命名、可折叠，
  首次启动默认 1 组、新建组默认 1 条空指令、**最后一组删不掉**；每条指令自己的配置（顺序号/超时/HEX）不变。
  文件里用 `## 组名` 抬头分隔各组（**两个及以上 `#`**；单个 `#` 仍是注释）；导出（副本）一定写抬头，
  写回挂载文件时只有一组不写（不擅自改用户结构）。面板里**每组自带一份列标题**（抬头 → 列标题 → 数据行），
  共用一份会夹在抬头与数据行之间、读起来是断的（用户 2026-09 指出的）。
  ⚠️ **改了文件格式/列名/上限/写回规则，必须同步 `doc/QUICK_CMDS.md`**（面向使用者的那份格式说明；断言里有 7 条守着它别烂掉）。
  循环发送的开关状态**不持久化**（开机自动发指令太危险），
  掉线/关监视器/列表里再无可发条目时必须**自愈停止**并提示。
  ⚠️ 循环发送自 2026-09 起是**发一条等它回话**：`busy` 继续等（不算结论）/ OK 下一条 /
  ERROR 重发本条（默认 3 次）/ 等满「超时」就**终止整条链**（填 `0` = 这条不等响应）。
  判定**只在 Rust 做一份**（`QcmdHs` + `qcmd_hs_arm/state/feed/stop`：串口由读线程喂、WSL 由前端
  `qcmd_hs_feed` 喂），而且**arm 必须早于 send**（反了就会把回话当上一条的迟到数据丢掉、白等到超时）。
  MCP 侧对应 `serial_quick_cmd` 的 `timeoutMs`/`expect`/`retry`（`delayMs` 是旧拼写，继续认）。
- WSL 串口转发通过 Python bridge 脚本实现，使用持久化 shell 避免 fork 延迟。⚠️ **bridge 的启动方式别改回硬写 `-e sg dialout`**：能**非交互**切组时才用 `sg`，否则直接跑 `python3` —— 没装 `sg` 的发行版会 `execvpe(sg) failed`（issue #21），不在 `dialout` 组里时 `sg` 会**卡在密码提示**上。三条细节（探测用"真试一次"而不是查 `id -nG`、拿不准时不用、提示里"没有 sg"要排在"切组失败"前面）见 `doc/ARCHITECTURE.md` §5.8
- USB 设备映射到 WSL 依赖 `usbipd-win` 工具，需管理员权限

## CI/CD

GitHub Actions 工作流位于 `.github/workflows/build.yml`：推送 `v*` tag 触发 Windows 构建并**直接发布正式 Release（latest）**（`releaseDraft: false` + `prerelease: false`，安装包由 `softprops/action-gh-release` 以 `draft: false` 上传，**无需人工发布**），也支持手动触发。

## 错误上报系统

项目支持两种错误上报方案：

### 方案 1：自建错误收集服务（推荐）
```
Tauri 应用 → 自建服务 (SQLite)
```

### 方案 2：Sentry + GitHub Webhook
```
Tauri 应用 → Sentry → Webhook 服务 → GitHub Issue
```

### 文件结构
- `server/error-server.js` — 自建错误收集服务（SQLite 存储）
- `server/sentry-webhook.js` — Sentry Webhook 服务
- `server/package.json` — 服务依赖配置
- `server/INSTALL.md` — 安装部署指南
- `cloudflare-worker/` — Cloudflare Workers 版本（推荐，免费全球部署）
- `.env.example` — 环境变量示例

### 自建服务配置（本地）
```bash
cd server
npm install
node error-server.js
```

访问 http://localhost:3000 查看错误列表

### Cloudflare Workers 部署（推荐）
```bash
cd cloudflare-worker
npm install -g wrangler
wrangler login
wrangler d1 create seahi-errors
# 更新 wrangler.toml 中的 database_id
wrangler d1 execute seahi-errors --file=./schema.sql
wrangler deploy
```

部署后访问 `https://seahi-error-server.xxx.workers.dev` 查看错误列表

### Sentry 配置（可选）
1. 创建 Sentry 账号（免费版，5,000 事件/月）
2. 获取 Sentry DSN
3. 创建 GitHub Personal Access Token
4. 部署 Webhook 服务
5. 在 Sentry 项目中配置 Webhook URL

### 使用方式
```bash
# 设置环境变量（自建服务）
set ERROR_SERVER_URL=http://localhost:3000

# 设置环境变量（Sentry）
set SENTRY_DSN=https://xxx@sentry.io/xxx

# 构建 Release 版本
cargo build --release

# 启动 Webhook 服务
cd server
node sentry-webhook.js
```

### 功能特性
- 自动捕获 Panic 和运行时错误
- 错误自动去重，避免重复创建 Issue
- 详细的错误上下文（堆栈、环境信息、操作记录）
- 自动添加 `bug`, `auto-reported` 标签
- 支持离线缓存，网络恢复后上报

详见 `server/README.md`。
