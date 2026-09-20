# BLE OTA（固件远程升级）功能评估

> **问题**：BLE 界面要支持「选择固件 → 对已连接的 BLE 设备远程升级」。
> 本文回答「能不能做、要做哪些、风险在哪」，并记录**阶段 0 的落地**（§5.1）。
> 纪律沿用 `doc/BLE_VERIFICATION.md`：**只写实际查过的代码 / 实际做过的验证**，
> 未验证的一律显式标注，不做推断。所有「现状」结论都带 `文件:行号` 便于复核。
>
> 评估日期：2026-09（v0.4.0 开发会话）｜基线：`node .walkthrough/gen_ble_preview.js` = **1631 passed / 0 failed**
> 阶段 0 落地后：**1669 passed / 0 failed**，`cargo test` **259 passed / 0 failed**

---

## 0. 一句话结论

**能做，但不能做成「通用 OTA」。** BLE 链路上**没有标准 OTA 协议** —— 升级流程是
**设备侧固件与上位机之间的私有约定**（服务/特征 UUID、命令字、分包、ACK、结束与重启语义全部由设备侧定）。
所以这个功能的上限由「目标设备用哪套协议」决定，不由本应用决定。

应用现有的 BLE 底座（连接 / 服务发现 / MTU / 通知订阅）**够用**，但缺三块硬骨头：

| # | 缺什么 | 后果 |
|---|---|---|
| 1 | **分包传输引擎**（当前是单次写，无分包 / 无流控 / 无重传） | 现在这条写入通路**连一个 1 KB 的固件块都发不出去** |
| 2 | **固件通路**（选择 + 头解析 + 校验 + 元信息） | ✅ **阶段 0 已补上**（见 §5.1） |
| 3 | **分钟级任务不阻塞主程序的会话管理** | Tauri command 挂着不动 / MCP 一问一答 130 s 上限必然假失败 |

**已做「阶段 0」**：选固件 + 解析固件头 + 本地校验 + 读设备版本对比，
**一个字节都不写设备**。零风险、可独立验收、立刻有用；真正的传输引擎等目标设备协议确认后再动手
（见 §5、§6）。

---

## 1. 现状盘点（代码事实）

### 1.1 已有的、可复用的底座

| 能力 | 实现位置 | OTA 需要它做什么 |
|---|---|---|
| 连接 / **按 MAC 直连** | `ble_connect` `main.rs:7065` ／ `ble_connect_direct` `main.rs:7107` | 设备刷完重启后常常不再广播，重连只能靠直连（AGENTS「BLE 六条约定」#1） |
| GATT 服务 / 特征树 | `ble_get_services` `main.rs:7285`、`ble_find_char` `main.rs:6745` | 定位 OTA 的**写特征**与**通知特征** |
| **协商后的 MTU** | `ble_get_mtu` `main.rs:7225` → WinRT `MaxPduSize`（`vendor/btleplug/src/winrtble/peripheral.rs:490`、`ble/device.rs:80`） | 分片大小 = `MTU - 3`（ATT 写操作码 1B + 句柄 2B） |
| 通知订阅 | `ble_subscribe` `main.rs:7333` + `ble_notify_loop` `main.rs:6767` | 接收设备 ACK / 进度回执 |
| 单包写入 | `ble_write` `main.rs:7301` | 分片循环里的原语 |
| 原生文件框 + **路径白名单** | `quick_cmds_pick_file` `main.rs:3689`、登记表 `quick-cmds-files.json` `main.rs:3485` | 固件选择照抄这一套（**绝不接受前端传任意路径**） |
| 日志中心 | `mcp/loghub.rs`（BLE 写已回灌 `ble:tx`） | 每次片写可追溯 |
| 前台日志缓冲 | `logBle` `src/js/81-ble.js:390` | 阶段与进度写进「数据日志」 |

### 1.2 缺的（逐条，带证据）

1. **没有任何分包能力，且当前写通路超 MTU 必然失败。**
   `ble_write` 一次一包；vendor 的 `write_value` 直接调 WinRT
   `WriteValueWithOptionAsync`（`vendor/btleplug/src/winrtble/ble/characteristic.rs:67`）——
   **WinRT 不会替我们分包**。`doc/BLE_VERIFICATION.md:54`（未覆盖项 E）已明确
   「未测超过 MTU 的分包写入」。
   ⚠️ 所以「把固件切块逐包发」这件事在仓库里**一行都没有**。

2. **MCP 的写上限不是传输上限。**
   `MAX_BLE_WRITE_CHARS = 4096`（`src-tauri/src/mcp/protocol.rs:1006`）是「AI 单次写一包」的语义，
   与 OTA 无关 —— 别拿它当固件大小上限，也别指望靠它做流控。

3. **ACK 通道目前被前端独占 —— 这是最容易踩的架构坑。**
   设备 ACK 走通知，而通知只有**一条共享队列**（`notify_buf`，上限 2000，`main.rs:6777`），
   由 `ble_poll_notifications`（`main.rs:7364`）**drain**，前端每 250 ms 也在 drain（`src/js/81-ble.js:481`）。
   OTA 引擎若去读同一个队列，**ACK 会被前端抢走**（表现为「偶发等不到 ACK」这种最难查的故障）。
   → 必须给 OTA 会话**单独一条出口**（在 `ble_notify_loop` 里旁路一份），
   **绝不许去 drain 前端那条队列**（与 MCP 关键约定 #6 同一条纪律）。

4. **与既有后台动作互斥。**
   已连接设备每 3 s 刷一次 RSSI（`src/js/81-ble.js:34`），而 `ble_refresh_rssi`
   每次要做一次 **800 ms 扫描脉冲**（`main.rs:7268`），且**链路一断就清连接状态**（`main.rs:7250`）。
   OTA 期间扫描 / 读 RSSI 会挤占链路、拖慢传输 → 必须暂停这两个轮询，
   并在 OTA 期间**锁死** 扫描 / 断开 / 切换设备 / 写特征。

5. **固件通路完全没有。**
   没有选固件的命令、没有固件路径登记表、没有固件头解析。
   ⚠️ `download_update` 那种「整个文件读进内存」（`main.rs:5133` `resp.bytes()`）**不能照抄** ——
   固件 1 MB+ 必须**流式分块读**，并设大小上限（防止前端/AI 塞一个 2 GB 文件打爆内存）。

6. **没有任何「长任务 + 进度 + 取消」的后端形态。**
   现有的窗口几何、更新下载、快速指令读写全是短任务；日志中心的队列是单消费者的。

### 1.3 MCP 侧的硬约束（决定接口形态，不是可选项）

- 桥的分档超时最大 `UI_TIMEOUT_CONNECT_MS = 130_000`（`src-tauri/src/mcp/bridge.rs:34`），
  且工具是**一问一答**（无进度通知）。OTA 动辄几分钟 → **绝不能**做成同步工具，
  只能 `ota_start`（立即返回）+ `ota_status`（轮询）+ `ota_abort`。
- 「加一个工具」的真实成本（MCP 约定 #11）：进 READ/WRITE/DANGER **三张表**、`mcp_limits` 上限、
  返回值契约表、`doc/MCP_TOOLS.md` 生成物、`.walkthrough` 跨边界断言、`mcp_smoke.js` 实测。
- OTA 必然进 `DANGER_TOOLS` + 要 `confirm:true`，只读模式下必须被 `-32007` 拦。
- 传入的路径/大小/分片参数一律要在 **`mcp_limits` 里有上限且校验发生在碰设备之前**（约定 #10）。

---

## 2. 为什么「通用 OTA」不存在（协议选择）

| 协议 | 服务/形态 | 复杂度 | 与本应用的关系 |
|---|---|---|---|
| **Nordic Secure DFU** | `0xFE59` | 最重：按钮式/无按钮式、init packet、CRC 校验、PRN 流控、select/abort 状态机 | 有公开规范，但必须做成**独立协议档**，塞不进「通用分片」模型 |
| **ESP BLE OTA**（Espressif） | 自定义服务 + 命令特征 / 数据特征 | 中：协议公开，但属 Espressif 私有 | 可作为内置档之一 |
| **安信可 / Bouffalo**（Ai-WB2 BL602、Ai-M62/M61 BL616） | 官方 OTA 是 **HTTP/HTTPS/TCP FOTA**（BL616 TCP 默认端口 3365、双分区 A/B + rollback）—— **不是 BLE** | —— | 芯片是否开放 BLE OTA 服务**取决于用户自己的固件**，不能想当然 |
| **私有透传协议** | 一个写特征收固件块 + 一个通知特征回 ACK，命令字自定义 | 低 | 国内模组最常见，正好落在「通用分片 + 可配置档」里 |

> 引用来源（本轮**只能看到标题/摘要**，正文抓取被网络策略拦下，**未逐字核对**）：
> [ESP BLE OTA Service 文档](https://docs.espressif.com/projects/esp-iot-solution/zh_CN/latest/bluetooth/ble_ota_svc.html)、
> [nRF5 SDK — DFU Transport BLE](https://infocenter.nordicsemi.com/topic/com.nordic.infocenter.sdk5.v14.2.0/lib_dfu_transport_ble.html)、
> [Ai-M6x（BL616/BL618）模组 OTA 升级机制](https://github.com/Ai-Thinker-Open/.github/discussions/33)、
> 本机 skill `coder-ai-m62-m61/references/fota.md`（512 B OTA header + SHA256 + A/B 回滚）。

**结论**：正确形态是「**协议档（profile）**」——
2~3 个内置档 + 一个**自定义档**（服务 UUID / 写特征 / 通知特征 / 分片大小 / 每片延时 /
ACK 策略 / 重传次数 / 结束命令 / 是否自动重启）。
Nordic DFU 这类「带状态机 + CRC」的作为**独立档**，不硬塞进通用档。

---

## 3. 前端改造点

| # | 位置 | 改什么 | 为什么 |
|---|---|---|---|
| 1 | `renderBleDetail` `src/js/81-ble.js:1325` | 现在是 广播内容 / GATT / 数据日志 三块 → 加第 4 块或**独立弹窗**（照 `#bleWriteModal`，`src/index.html:158`） | 升级是低频高危操作，弹窗比常驻区块更不容易误触 |
| 2 | 弹窗内容 | 选固件（原生框）→ 显示 文件名 / 大小 / 固件版本 / 芯片 / MD5 / **设备当前版本**（读 `0x2A26` Firmware Revision String，名称表已在 `src/js/81-ble-uuids.js:128`）→ 目标设备 MAC + **二次确认** → 开始 / 取消 + 进度条（字节 / 百分比 / **实测速率** / 已用与预估剩余 / 阶段）→ 结果。**已落地**（阶段 0/1）：标题栏 = 左标题 + 中设备名(灰 MAC) + 右「读取版本」；内容 = 风险提示(单行) → 固件文件 → **协议档** → 更新进度 → 日志；底部 = 关闭 / 中止 / 开始升级 | 没有版本对比 = 无法判断「到底升上去了没」 |
| 3 | 门闩 | OTA 期间禁用 开始扫描 / 断开设备 / 切换设备 / 写特征；**暂停 RSSI 轮询** | 见 §1.2 第 4 条 |
| 4 | 日志 | 复用 `logBle`（带 `src` 标记），阶段变化各写一行 | 与既有日志纪律一致 |
| 5 | 断言集 | 新函数要能被 `extractFunction` 抽到（**顶层 function、列首 `}` 收尾**）；新 JS 文件按 `index.html` 顺序加载（`.walkthrough/gen_ble_preview.js:28`）；新滚动区必须配 `::-webkit-scrollbar`（含 corner） | 否则断言集/滚动条对账当场 fail |

---

## 4. 安全与风险（评估重点）

1. ⚠️ **变砖（最大风险）**：单 bank 设备直接写运行分区，传输中断就可能再也起不来。
   上位机只能做到「**不主动中途取消 + 断链立即停 + 全程留日志**」；
   **兜底必须在设备侧**（双 bank / rollback）。这句话必须写进界面，不能只写进文档。
2. ⚠️ **耗时远超直觉**：BLE 实际吞吐由 MTU 与连接间隔决定。
   20 B/包、10~20 ms 一包 → 约 **1~2 KB/s**（1 MB 固件 ≈ 8~17 分钟）；
   MTU 247（244 B/包）好一个数量级。→ 必须显示实测速率，且**不设整体超时**
   （否则 UI 和 AI 都会误报失败 —— 与 `bridge.rs` 那三条分档超时同一类教训）。
3. ⚠️ **「假成功」**：协议猜错时可能**每包都写成功、设备却没升级**。
   → 必须有设备回执 + **升级后版本对比**才是验收。
   版本从哪来：优先读 `0x2A26` Firmware Revision String（Device Information Service `0x180A`），
   **但它只在设备实现了 DIS 时才存在** —— 很多透传模组没有，那时只能靠协议档自带的版本查询命令
   （或让设备侧约定一条 `AT+GMR` 风格的回执）。这条链路必须在真机上先探明。
4. ⚠️ **WinRT 行为差异**：`MaxPduSize` 可能报 23；`WriteWithoutResponse` 没有送达保证。
   → 默认 with-response，或依赖设备侧 ACK。
5. ⚠️ **不能后台自动升级**：无人在场时的固件写入是灾难 → 人工确认 + 二次确认，不做「一键全自动」。
6. ⚠️ **未验证项**：超过 MTU 的写在本项目**从未真机验证**（`doc/BLE_VERIFICATION.md:54`）；
   分片 / 流控 / 断链恢复全部是**新增的未验证路径**，不能只靠单测当结论。

---

## 5. 分期建议与工作量

| 阶段 | 内容 | 依赖 | 估算 | 状态 |
|---|---|---|---|---|
| **阶段 0**（零风险，可独立验收） | `ota_pick_firmware`（rfd + 路径 LRU 登记）+ 固件头解析（安信可 `ai_pack_head` **169 B**：`V1.0\0` 5B + 芯片 4B + MD5 32B + URL 128B；BL616 为 **512 B** header + SHA256 -- **未实现，见下**）+ 本地校验 + 读回设备 `0x2A26` 对比 | 无（**不写设备**） | 0.5~1 天 | ✅ **已落地**（见 §5.1） |
| **阶段 1** | Rust 分包传输引擎（`MTU-3` 切片、每片可选延时、ACK 等待超时、重传、取消、进度、速率）+ 自定义协议档 UI + 单测（分片边界 / 重传 / 取消 / 断链） | 阶段 0 | 2~3 天 | ✅ **已落地（未经真机）**，见 §5.2 |
| **阶段 2** | 内置协议档（按目标设备定，含 Nordic DFU 或 ESP BLE OTA 或私有协议） | **真机 + 协议文档** | 1~2 天 + 联调 | ⛔ 待协议 |
| **阶段 3** | MCP `ota_*` 三件套 + `doc/` + 断言集 + `mcp_smoke.js` | 阶段 1/2 | ~1 天 | ⛔ 未开始 |

**硬阻塞**：阶段 2 没有目标设备就无法验证。
前车之鉴见 `doc/BLE_PERIPHERAL.md` —— 「适配器自报支持外设角色，实测广播起不来」，
整条方向最后只能删除。**别在真机跑通之前先加功能。**

### 5.1 阶段 0 落地记录（2026-09）

| 项 | 落地位置 |
|---|---|
| 选固件（原生框 + 路径白名单 LRU 20） | `main.rs` `ota_pick_firmware` / `ota_inspect_firmware` / `ota_list_firmwares`，登记表 `%APPDATA%\seahi-serial\ota-firmwares.json` |
| 固件头解析与校验 | `main.rs` `ota_parse_firmware`（纯函数）+ `md5_hex`（**手写纯 Rust MD5**，理由同 `sha256_hex`：本机 cargo 无法联网下载新 crate） |
| 大小上限 8 MB、读前判定 | `ota_check_size` / `OTA_FIRMWARE_MAX_BYTES`（`ota_inspect_path` 先看 `metadata` 再读） |
| 前端面板 | `src/js/84-ble-ota.js` + `index.html` 的 `#bleOtaModal` + 设备详情页「固件升级」入口 + `02-global.css` 的 `.ble-ota-*`。弹窗结构（用户 2026-09 逐轮定的）：标题栏三段（左标题 / 中**设备名 + 灰色 MAC** / 右「读取版本」）→ 内容区 **风险提示（单行）→ 固件文件 → 更新进度 → 日志**；**没有**「设备版本」显示区（读到的版本按行走日志），提示一律走 `bleOtaLog()`（同一份进 BLE 面板数据日志） |
| 设备版本对比 | 前端走既有 `ble_read` 读 DIS（`0x180A`）的 `2A26/2A24/2A27/2A28/2A29`，**不新增后端命令** |
| 测试 | Rust **10 条**（`ota_firmware_tests`：RFC 1321 官方向量 / 包头识别 / MD5 不符 / 非 hex 字段 / 裸固件 / UNKN 提醒 / LRU 有界 / 上限 / 真文件往返 / 尺寸文案）；前端断言 **+40 条**（纯函数行为 + 「阶段 0 不许出现写入调用」+ id/命令跨边界对账 + 弹窗布局与文案） |

**明确没做的**（别以为已经做了）：传输引擎、协议档、MCP 工具、BL616 512 B 包头的解析
（布局未核对，按「未识别包头」处理 —— **不猜**）。

⚠️ **阶段 1 的第一件配套改动**：真传输一接上，「开始升级」就必须加 `data-mcp-skip` 并登记进
`MCP_DANGER_CONTROLS`（控件注册表 `MCP_SELECTOR = 'button, input, select, textarea, [onclick], [role="tab"]'`
**不按可见性过滤**，弹窗里的按钮照样会被收进去 → 变成 `ctl_*` 工具）。
阶段 0 故意**不加**：那颗按钮点了只弹一句说明、没有任何副作用，提前登记会让"不漏也不虚"的
对账断言失去意义。

**已知取舍**：包头第 `0x00` 起的 5 字节字段按原文显示为「包头版本」，
**不拿它判断版本新旧**（它到底是"格式版本"还是"固件版本"取决于生成工具，本项目未在真机核对）；
版本对照只给「一致 / 不一致 / 读不到」三种结论。

---

### 5.2 阶段 1 落地记录（2026-09）

**一句话**：真传输引擎 + 自定义协议档 + 人工二次确认都做完了，**但一次真机写入都还没做过**
（设备侧私有协议的四项 —— 服务/特征 UUID、分包、ACK 方式、结束与重启语义 —— 用户尚未提供，
所以协议档里一个 UUID 都不预填，缺项就拒启动）。

| 项 | 落地位置 |
|---|---|
| 协议档（全部可变参数） | `main.rs` `OtaProfile` + `ota_profile_check`（纯函数）+ 前端 `src/index.html` 的 `#bleOtaProfileForm` / `84-ble-ota.js` 的 `bleOtaProfileDefaults/Load/FromForm/Fill/Summary`；持久化在 `config.json` 的 `otaProfile` |
| 分包数学 | `ota_chunk_span` / `ota_chunk_count`（纯函数；自动值 = `MTU − 3`，显式值受 512 B 与"链路可写长度"双重约束） |
| 传输引擎 | `ota_start`（校验 → 起后台任务 → 立刻返回）→ `ota_task_body`：起始帧 → 逐片写（写失败/等 ACK 超时都按 `retry` 重传）→ 结束帧；`ota_status` 读快照；`ota_abort` 置取消标志 |
| ACK 独立出口 | `OtaAckSink`（`BleState.ota_ack`）：通知循环在**产生处**同时投一份进来，引擎按 `sink.pop()` 取 —— **绝不 drain 前端轮询的 `notify_buf`**（`ack_outlet_is_separate_from_the_frontend_queue` 守着） |
| 写之前清过期 ACK | `drain_stale()` + `ack_stale` 计数（上一片多出来的通知若被当成这一片的 ACK，就会把"丢片"读成"成功"） |
| 单片超时 / 无整体超时 | `ack_timeout_ms`（1~60 s）；**没有全局 deadline** —— `there_is_no_overall_timeout_constant` 守着 |
| 人工二次确认 | 第一次点「开始升级」只是把按钮改成「确认升级」并写一行日志，第二次才真的调 `ota_start`；改协议档会**收回**这个状态（`bleOtaProfileChanged` → `bleOtaDisarm`） |
| 危险动作登记 | 按钮带 `data-mcp-skip`（AI `ui_click` 点不到），并登记在 `30-mcp.js` 的 **`MCP_SKIP_NO_TOOL`**（"有入口、后端还没对应工具"那张表 —— MCP 的 `ota_start` 属阶段 3；不能登记进 `MCP_DANGER_CONTROLS`，那张表的 key 必须与 Rust `DANGER_TOOLS` 一一对应） |
| 进度 / 中止 / 日志 | 前端 400 ms 轮询 `ota_status`（只在跨 10% 档位时写日志，免得刷爆 200 行上限）；传输中锁住关闭/换固件/改协议档；「中止」文案写明**中止 ≠ 回滚** |
| 测试 | Rust **+13 条**（`ota_engine_tests`：分包边界与全覆盖 / 协议档校验各分支 / HEX 帧 / 重传额度边界 / 速率与 ETA 不除零 / ACK 出口有界与记账 / 状态快照诚实 / 无整体超时 / ACK 出口独立）；前端断言 **+38 条**（协议档字段与默认值 / `bleOtaStartBlockReason` 逐条 / 坏值收敛 / 阶段文字 / 结论行 / 摘要 / 危险登记三张表互斥 / 后端入口与命令注册） |

**本阶段已知的、写在明处的取舍**（不是漏洞，是"协议未知"的诚实处理）：

1. **`ack_mode: notify` 时，"任何一条来自通知特征的数据"都算这一片的 ACK** ——
   设备侧的 ACK 报文格式还没给，所以**不编一个匹配规则**（编错会把丢片读成成功）。
   原文会记进 `recentAcks`（前 3 条）并显示在日志里，用户能一眼看出设备到底回了什么；
   协议到位后再补真正的匹配。
2. **结束动作没配就只是不发**：传完会明说"设备多半不会生效"，绝不报「升级成功」。
3. **分片 / 流控 / 断链恢复全部未经真机验证**（§4 第 6 条）—— 单测只证明数学与状态机，
   不证明设备会认。

**下一阶段（阶段 2/3）仍缺的东西**：设备侧 OTA 的服务/特征 UUID、分包大小、
ACK 报文格式、结束与重启语义；以及 MCP 的 `ota_start` / `ota_status` / `ota_abort`
（分钟级任务，**绝不能做成同步工具**，且不设整体超时）。

> ⛔ **当前状态（2026-09 用户要求）**：**整条 OTA 功能的界面入口已隐藏** ——
> `src/js/84-ble-ota.js` 顶部的 `var BLE_OTA_UI_ENABLED = false;` 是唯一总开关
> （设备详情页不渲染「固件升级」按钮，`openBleOtaModal()` 自己也 `return`）。
> 代码、引擎、协议档、二次确认、危险登记、断言与三份文档**全部保留**，
> 唯一卡住的是**真机协议里 `crc16()` 的参数**（藏在泰凌的预编译库 `liblt_8258.a` 里）。
> 协议本身已经查清并写在 `doc/BLE_OTA_TELINK.md`（20 字节定长包 / `0xFF01` 开始 /
> `0xFF02` 结束 / 不等 ACK / 镜像头 +0x18 是长度），核对完 crc16 把开关改回 `true` 即可恢复。

---

## 6. 待确认（决定方案形态，需用户回答）

> **2026-09 进展（协议已拿到，见 `doc/BLE_OTA_TELINK.md`）**：目标设备（广播名 `ai-thinker`，固件
> `(3684) TB_ComboAT_常规固件_v3.0.8.bin`）的 GATT 里有
> `00010203-0405-0607-0809-0A0B0C0D1912` —— **泰凌微（Telink）OTA 服务**（另有 `55535343-…E455` SPP 透传服务）。
> 结合安信可官方文档（TB 系列 = **TLSR8250** = 泰凌微；PB 系列才是 PHY62xx = 奉加微）与
> "TB 的 BLE AT 固件正好有 V3.0.8 版"，**这台设备是 TB 系列（泰凌微）跑 Combo AT 固件，OTA 走 Telink OTA**。
>
> 协议已经从安信可镜像的 SDK 源码里**逐条读出来**（`Ai-Thinker-Open/Telink_825X_SDK`：
> `gatt_uuid.h` / `ble_ll_ota.h` / `example/8258_master_kma_dongle/blm_ota.c`），
> 包括：OTA 数据特征 `…2b12`、命令 `0xFF01/0xFF02`、**20 字节定长数据包（2B 索引 + 16B 数据 + 2B CRC16）**、
> 结束帧（最后一包索引 + 取反）、"不等 ACK、靠 TX FIFO 流控"、连接参数改 10 ms、
> 以及真机固件头 `+0x18` 就是镜像长度（实测 101140 = 文件长度 ✓）。
> **唯一还缺的一块是 `crc16()` 的参数**（实现藏在 `liblt_8258.a` 预编译库里）——
> 高置信度候选是 CRC-16/CCITT-FALSE（poly 0x1021 / init 0xFFFF），但**必须真机核对后才写进内置协议档**。
> 落地要改的引擎项（帧模式 `telink_ota`、动态结束帧、CRC16、镜像头解析、OTA 后验收）列在
> `doc/BLE_OTA_TELINK.md` §7。

1. **目标设备**是哪颗芯片 / 模组？（Ai-WB2 BL602 / Ai-M62·M61 BL616 / ESP32 / nRF52 / 自己的私有协议）
2. **设备侧是否已实现 BLE OTA 服务**？若有，请给 服务与特征 UUID + 协议说明
   （命令字 / 分片大小 / ACK 方式 / 结束与重启语义）；若没有，得先决定在设备侧实现哪套。
3. **固件形态**：裸 `.bin`？带 `ai_pack_head`（169 B）？BL616 512 B header？是否需要 App 侧校验 MD5/SHA256？
4. **是否需要 MCP（AI 触发）能力**，还是只人工点？（决定要不要做 `ota_*` 三件套与三张表登记）
