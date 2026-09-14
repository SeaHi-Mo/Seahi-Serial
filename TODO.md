# SeaHi Serial — 待办清单（TODO）

> **本文件已纳入版本库**（2026-09-14 从 `.gitignore` 移出）。
> 技术细节的权威记录在 `doc/MCP_DESIGN.md` §17「实施记录」；这里只放**要做什么 / 卡在哪 / 已完成**。
> 本文按**当前运行实例的实测结果**写（抓取方式见文末），不是靠回忆。
>
> 【2026-09-14】本文件此前是本地台账（未入库），在一次脚本改写中被误删开头与部分记录、原文已无法恢复。
> 现按当前状态整体重写并入库，以免再出现"改坏了没得救"。

---

## 一、当前 MCP 服务器状态（实测快照）

实例：**0.5.0** · pid 43044 · `http://127.0.0.1:7777` · 随程序自启 · `hasUi: true`

| 项 | 实测值 |
|---|---|
| 工具数 | **33 个**（20 通用 + 13 串口语义）；`expose.autoControlTools` **关闭**（默认，故意） |
| 界面控件 | 注册表 **182 个**（serial 101 / ble 31 / global 23 / dialog 19 / mcp 8）；`ui_list` 默认每页 100 + `nextCursor` |
| 会话 | **1 / 上限 4**（客户端断开立刻回收）；累计请求 54 · 丢弃 0 · 状态推送 10 |
| 日志中心 | 3 通道 · 119 KB / 16 MiB；每通道 128 KiB～1 MiB · 单条 8 KiB · 最多 64 通道 |
| 输入上限 | 请求体 1 MiB · 60 次/分 · 桥回执 5 s · 桥在途 32 · `ui_set` 200 条 · `serial_send` 64K 字符 · 工具列表每页 50 |
| 协议 | `2025-06-18`（回退 `2024-11-05`）；传输**只有 SSE**（无 Streamable HTTP） |
| 错误上报 | 已上报 1 · 去重挡掉 2 · `sinkConfigured: false`（debug 未配 Sentry/自建服务） |

**自动化测试**：Rust **156** 过（另 4 条 `#[ignore]` 真机/诊断）/ 前端无头断言 **986** 过 /
npm 安装器 **62** 过。

**真机一致性检查**（官方 Python MCP SDK，打的就是上面这个实例）：**59 项全通过 / 0 失败** ——
覆盖 HTTP 层（`/healthz` 免鉴权且只回 `{"ok":true}`、`/status` 鉴权与打码、未知路径 404）、
SDK 握手与协议版本、33 个工具与 `protocol.rs` 完全一致、每个工具 schema 可被模型理解、
只读工具实调、非法参数一律协议级 `-32602`、会话断开立刻回收。

---

## 二、待办：语义工具四批（S12~S15）

背景：通用控件桥（`ui_*` + `ctl_*`）用的是**控件坐标语言**，多分栏还会撞名；而 ADB shell、
BLE 设备列表/广播解析、WSL 映射状态这类**连绕都绕不到**（数据只在内存与 DOM 里）。

| 批次 | 内容 | 状态 |
|---|---|---|
| **1 串口（13 个）** | `serial_get_state`、`serial_list_ports`、`serial_select_port`、`serial_set_baud`、`serial_set_frame`、`serial_set_lines`、`serial_set_display`、`serial_open`、`serial_close`、`serial_send`、`serial_clear`、`serial_get_history`、`serial_get_output`、`serial_quick_cmd` | ✅ **已落地**；只读部分真机验证过，**收发链路受阻于缺设备**（见第三节）|
| **2 BLE（主机，~16 个）** | `ble_scan_start`/`stop`、`ble_list_devices`（名称 / RSSI / 类型 / **广播原始字节解析**）、`ble_connect`、`ble_connect_direct`（按 MAC）、`ble_disconnect`、`ble_pair`/`unpair`、`ble_get_services`、`ble_read_char`/`write_char`、`ble_read_desc`/`write_desc`、`ble_subscribe`/`unsubscribe`、`ble_refresh_rssi` | ⏳ 未开始 —— **需要新增后端结构化返回值**（设备/服务/特征目前只在内存与 DOM 里）|
| **3 ADB / WSL（~16 个）** | `adb_status`、`adb_list_devices`、`adb_select_device`、`adb_start`/`stop_session`、**`adb_shell`、`adb_exec`**（界面根本没有，纯新增能力）、`adb_push`/`pull`、`adb_tool_status`；`wsl_status`、`wsl_list_mappings`、`wsl_map`、`wsl_unmap`、`wsl_start`/`stop_monitor` | ⏳ 未开始 —— `adb_*` 有 5 个后端命令前端从未调用，属"白捡" |
| **4 全局 / 收尾（~7 + 1 机制）** | `app_set_theme`、`app_set_theme_style`、`app_switch_panel`、`app_add_monitor`、`app_check_update`、**`log_cache_list` / `log_cache_clear`**（清磁盘会话日志缓存，目前没有对应界面入口）、**危险动作二次确认**（发数据 / 连设备 / adb shell 先弹确认、AI 等用户点；设计 §9 一直未实现）| ⏳ 未开始 |

> 实现约定：**读**类可直接调后端命令拿 JSON（不改界面、零副作用）；**动作**类必须走合成 DOM 事件，
> 保证界面同步。每批完成后：重跑 `node .walkthrough/gen_mcp_tools_doc.js` 更新 `doc/MCP_TOOLS.md`、
> 补行为断言并把新工具加进**返回值契约表**（不加测试会 fail）、commit（**不打 tag**）。

---

## 三、⛔ 阻塞：**缺串口设备**（2026-09-14 确认"现在还没有串口设备"）

下面这些必须有真实串口 + 真设备在收发数据才做得了。**没有设备之前它们不是"忘了做"，是做不了。**

| # | 事项 | 为什么绕不过去 |
|---|---|---|
| H1 | `serial_open` 真的连上（拿到 `connected:true`，而不是 6 秒轮询超时）| 要占用一个真实存在的串口 |
| H2 | `serial_send` 真的发出去（发 `AT` 看设备回显）| 要有设备应答才能判定"确实发出去了" |
| H3 | **真实数据是否真的流进 `serial:<分栏>:rx`**（条数/速率与界面行数是否量级一致）| **最关键的一条**。链路上有两段：后端读线程 → 前端 `bufferPush`（唯一漏斗）→ 回灌 LogHub。没数据时通道**根本不存在** |
| H4 | `serial_get_output` 拿到真实收发行（`dir` 区分、按时间归并、截断标记）| 依赖 H3 |
| H5 | 帧格式 / 流控真的生效（dataBits・stopBits・parity、DTR/RTS 复位目标板）| 要在设备侧观察现象 |
| H6 | 真实故障的错误上报（端口被占用、设备被拔出）进错误库 | 要制造真实的打开失败 |
| H7 | 多分栏（`extra-1`）的 `pane` 寻址与 `serial:<extra-1>:rx` 通道 | 要开第二个监视器且都有数据 |

**设备到位后的顺序**（先人后机，免得白折腾）：
1. 先在**界面上**点「开始监控」，确认能收到数据、界面行数在涨；
2. 再用 MCP **只读**复跑：`serial_get_state`（看 `logChannels`）→ `serial_get_output` /
   `log_channels` / `log_stats` 对账条数；
3. 最后动**写**操作：`serial_open` → `serial_send` → 看设备回显是否出现在 `serial:main:rx`。

---

## 四、其它待验证（不依赖串口设备）

| # | 事项 | 现状 |
|---|---|---|
| V1 | `npx seahi-serial-mcp install` 的**真实写入**（改各客户端的 MCP 配置）| ⏳ 只跑过 `--dry-run`，等你授权 |
| V2 | 慢消费者浸泡：RSS 增幅 < 10 MiB | ⏳ 只能看任务管理器（堆快照降 ≠ RSS 降）|
| V3 | 真实 AI 客户端里连一次：`tools/list` 应有 **33** 个工具、`ui_click` 界面真的动 | ⏳ 需要客户端 |
| V4 | 满负荷下的界面流畅度（几百次 `ui_list`/`ui_set` 连打）| ⏳ 需要你看着界面点，我这边打请求 |
| V5 | BLE 从机"真的在对外广播吗" | ⏳ 需蓝牙硬件；见 `doc/BLE_PERIPHERAL.md` 第 5 节（该 `#[ignore]` 用例当前失败）|

---

## 五、已知问题与技术债（范围明确的小事）

| # | 事项 | 说明 |
|---|---|---|
| T1 | `cargo build`（不带 `cfg(test)`）有 **6 条死代码警告** | `calllog::in_dir`、`loghub::handle`、`protocol::handle_raw`、`registry::MAX_TOOL_NAME_LEN`、`registry::replace`、`report::guard` —— 全部只被 `#[cfg(test)]` 引用。既有、非本轮引入（AGENTS.md 说的"0 警告"指 `cargo test`）。修法：加 `#[cfg(test)]` 或 `#[allow(dead_code)]` |
| T2 | `log_export` **没有总长上限** | 最多 64 通道 × 每通道 20000 行，一次可能拼出几十 MB 的字符串（有界但过大）。可加整体字符上限 + `truncated` |
| T3 | 桥会丢弃 `detail` / `results` | `unwrap_ui_result` 只往外传 `error`，多目标批量失败时 AI 只看到**第一条**错误（单目标语义已修好）。可把逐项结果附进错误文本 |
| T4 | **Streamable HTTP（`POST /mcp`）未实现** | 现在只支持 SSE，而我们广告的是 `2025-06-18`。见第六节 D2/D3 |
| T5 | 一致性检查脚本**不在仓库里** | 这是明确要求（测试工具不入库）。所以把"怎么复现"写在文末，别让它失传 |

---

## 六、待你拍板

| # | 决策 | 我的建议 |
|---|---|---|
| D1 | 危险工具默认 `confirm` 还是 `allow`（设计 §9 的二次确认）| `confirm`，但要有"本次会话内记住选择"，否则每次都弹，人会烦到直接关掉 MCP |
| D2 | 要不要补 **Streamable HTTP**（`POST /mcp`）| 看你的客户端：若客户端只支持 streamable，就必须做；否则保持"只有 SSE"更省事 |
| D3 | 协议版本：继续广告 `2025-06-18`，还是回退 `2024-11-05`（后者才是 SSE 的正统版本）| 先看 D2。只有 SSE 却广告新版本，严格客户端可能挑刺 |
| D4 | 那 6 条构建警告现在清掉吗（T1）| 建议清：独立小改动，能减少构建输出的噪声 |
| D5 | 批次 2/3/4 的先后 | 按 2→3→4（也可先把 4 里"清理磁盘日志缓存"这种独立小功能做掉）|

---

## 七、已完成（留档，别再重复怀疑）

**最近 6 次提交**：

| commit | 内容 |
|---|---|
| `c3c00d1` | 会话增减没推给界面 → 客户端连上了还显示 0 会话（新增 `mcp_status.statusEmits` 让它可观测）|
| `ae3893b` | 把"串口真机验证受阻于缺设备"记进设计文档 |
| `8d0418e` | 补齐工具"返回值契约 + 调用情况"测试；修掉端口名消失（摘要吞数组）与字段命名不一致 |
| `345ad7b` | `serial_get_output`（读串口监控数据）+ 按"不得影响主程序"补齐输入上限 |
| `dbb9561` | 修掉错误码分流在真机上失效的链路断点（`notFound` 丢在回执里）|
| `186e91d` | 串口语义工具 12 个（S12 第一批）|

**已真机验证过的（别再重复怀疑）**：33 个工具在线且与源码一致；`serial_get_state`（含 `logChannels`）、
`serial_list_ports`（驼峰 `portName`，**文本摘要里也带端口名**）、`serial_get_history`、
`serial_quick_cmd`、`serial_get_output`（没数据时返回空 + note 而非报错）；`ui_list` 182 个真实控件、
`ui_describe` / `ui_get` / `ui_get_state`；非法参数一律 `-32602`；`ui_set` 201 条与 `serial_send`
64K+1 **都在碰主程序之前**被拒；`sinceSeq` 与旧拼写 `since_seq` 都被采纳；会话断开立刻回收。

**十一条 MCP 关键约定**写在 `AGENTS.md`（改动时别破坏）：服务器必须在应用进程内 / 绝不
`panic="abort"`（分派边界真有 `catch_unwind`）/ 工具改界面一律走合成 DOM 事件 / 只监听回环且
`/healthz` 只回 `{"ok":true}` / AI 记录只写 `ai-config.json`・`ai-calls.jsonl` / 日志旁路非阻塞且上限
被执行 / `autoControlTools` 默认关 / 运行期错误进既有上报 / **回执那一跳不许丢字段** /
**MCP 不得影响主程序** / **每个工具都要有返回值契约与调用测试**。

---

## 附：怎么复现第一节那份快照

```bash
# 1) 当前状态（端点与 token 见 %APPDATA%\seahi-serial\mcp-endpoint.json）
curl -s "http://127.0.0.1:7777/status?token=<TOKEN>"
#    或直接用 MCP 工具：mcp_status / mcp_limits / log_channels / mcp_stats

# 2) 自动化测试
cargo test --manifest-path src-tauri/Cargo.toml
node .walkthrough/gen_ble_preview.js
node npm/seahi-serial-mcp/test/self-test.js

# 3) 真机一致性检查（官方 Python SDK）
#    脚本刻意不入库（要求：测试工具不能进仓库）。重建方法：
#    uv venv + pip install mcp → 连 <endpoint-url> → initialize / tools/list / 逐个 tools/call；
#    要检查的项见第一节"真机一致性检查"那段列出的范围。
```
