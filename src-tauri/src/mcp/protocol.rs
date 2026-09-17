//! MCP 协议层：JSON-RPC 2.0 编解码 + 错误码 + 方法分派 + 工具实现。
//!
//! 这一层**完全不碰 Socket 也不碰 Tauri**（只依赖 `McpCore`），所以可以直接单测：
//! 传一段原始 JSON-RPC 字符串进去，断言返回的响应字符串。

use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;

use super::loghub;
use super::McpCore;

/// 优先协商的协议版本
pub const PROTOCOL_VERSION: &str = "2025-06-18";
/// 对端不认时回退的版本
pub const PROTOCOL_FALLBACK: &str = "2024-11-05";
/// serverInfo.name
pub const SERVER_NAME: &str = "seahi-serial";

// ===== JSON-RPC 标准错误码 =====
pub const E_PARSE: i64 = -32700;
pub const E_INVALID_REQUEST: i64 = -32600;
pub const E_METHOD_NOT_FOUND: i64 = -32601;
pub const E_INVALID_PARAMS: i64 = -32602;
pub const E_INTERNAL: i64 = -32603;
// ===== 本项目自定义错误码（见 doc/MCP_DESIGN.md §4.6）=====
// 这些码是**协议契约的一部分**：客户端/AI 依赖它们区分"该退避"还是"该问用户"。
// 部分尚未在本轮落地的方法里用到（危险工具确认、前端桥超时、设备未就绪等），
// 但保持定义与编号稳定，避免以后改号造成客户端行为错乱。
#[allow(dead_code)]
pub const E_RATE_LIMITED: i64 = -32000;
#[allow(dead_code)]
pub const E_UNAUTHORIZED: i64 = -32001;
#[allow(dead_code)]
pub const E_TOOL_DISABLED: i64 = -32002;
#[allow(dead_code)]
pub const E_USER_DENIED: i64 = -32003;
#[allow(dead_code)]
pub const E_UI_TIMEOUT: i64 = -32004;
#[allow(dead_code)]
pub const E_UI_BUSY: i64 = -32005;
#[allow(dead_code)]
pub const E_DEVICE_NOT_READY: i64 = -32006;
/// 被**策略**拒绝（只读/沙箱模式）。刻意与"参数错误""执行失败"分开：
/// 它既不是调用方参数的问题（改参数也没用），也不是工具跑了失败（根本没跑），
/// 所以不能混进 -32602 / -32006 —— Agent 该做的是**别再重试**，而是告诉用户去关掉只读模式。
pub const E_POLICY_DENIED: i64 = -32007;

/// JSON-RPC 错误
#[derive(Debug, Clone)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

// ===== 工具定义 =====

/// `initialize` 回给客户端的**工作指引**（MCP 规范里的可选字段 `instructions`）。
///
/// 为什么值得专门写：Agent 的效率基本取决于"**第一次就做对**"。没有这段说明，它只能靠撞墙去发现
/// —— 本机没有界面时所有 `ui_*` 都会失败、串口要先 `serial_open` 才能发数据、错误信息里其实已经
/// 给了可选值、单目标写失败就是整次失败……每一次撞墙都是一轮往返 + 一次失败，而这段文字是
/// **一次性**告诉它（只在握手时传一次，代价几乎为零）。
///
/// 内容只写"能直接省掉一次失败"的东西，不写自我介绍。
pub const SERVER_INSTRUCTIONS: &str = "\
SeaHi Serial 的串口/蓝牙调试接口。按下面的顺序工作能省掉大部分来回：
1) 先看状态再动手：mcp_status 看有没有界面（hasUi）与工具数；串口操作前先 serial_get_state 看端口、波特率、是否正在监控。
2) 串口主流程：serial_get_state → serial_select_port → serial_set_baud → serial_open → serial_send → serial_get_output（读设备回了什么）→ serial_close。多分栏用 pane 参数（如 extra-1）。
3) 出错就照错误信息做：它通常已经给出可选值（例如「可选值只有: COM1」）或下一个该调的工具，不要盲试。
4) 错误码语义：-32602 表示参数或取值不对（改参数重试）；isError 且文本含 -32006 表示前置条件没满足（先做前置操作，例如 serial_open），或者本机没有界面/没有设备。
5) 写操作只给一个目标时，失败即整次调用失败（不会假装成功）；给多个目标才会逐条回报。
6) 上限先查 mcp_limits：例如 ui_set 一次最多 200 条、serial_send 单次最多 64K 字符；请求限流 60 次/分。
7) 日志不要重复拉全量：log_tail 用 sinceSeq 增量跟进。
8) 若 mcp_status 的 readOnly 为 true，说明用户开了**只读（沙箱）模式**：所有写操作会被拒（错误码 -32007，且**没有执行**）。这不是参数问题，别重试、也别绕路，直接告诉用户「请到 MCP 弹窗里关掉只读模式」即可。
9) ADB 语义：adb_list_devices 看设备（只有 state=device 那台能用）→ adb_open_shell（**危险，要 confirm:true**；会等 PTY 真的建出来才返回）→ adb_shell_write（**危险，要 confirm:true**；命令要自带换行才会执行）→ adb_shell_read（用 sinceSeq 增量跟进，**不需要界面**）→ adb_close_shell。";

/// 会被**只读（沙箱）模式**拦下的写工具。
///
/// 这里是**唯一来源** —— `.walkthrough` 里有一条断言拿它去和 `doc/MCP_TOOLS.md` 的「读/写」列
/// 对账（那一列以前是手写的，没人核过）。
pub const WRITE_TOOLS: &[&str] = &[
    "serial_select_port",
    "serial_set_baud",
    "serial_set_frame",
    "serial_set_lines",
    "serial_set_display",
    "serial_open",
    "serial_close",
    "serial_send",
    "serial_clear",
    "ui_set",
    "ui_click",
    "log_clear",
    "mcp_config_set",
    // （原来还有 `ble_periph_start` / `ble_periph_stop`：BLE 从机方向已于 2026-09 删除 ——
    //   本机适配器自报支持外设角色，但实测广播起不来，功能无法交付。）
    // 扫描占用射频、会让附近设备应答 —— 算写（只读模式下不该开）
    "ble_start_scan",
    "ble_stop_scan",
    "ble_subscribe",
    // 连接/断开/写特征都会改设备侧或界面状态
    "ble_connect",
    "ble_disconnect",
    "ble_write",
    // ADB：在**别人的设备上**开 shell / 真的执行命令（前两个同时是危险动作，见 DANGER_TOOLS）
    "adb_open_shell",
    "adb_shell_write",
    // 改 PTY 尺寸与关会话都会动界面（终端布局 / 会话消失）
    "adb_shell_resize",
    "adb_close_shell",
    // 工作流规则的启停：写 + **危险**（规则跑起来就会自动往设备发数据，见 DANGER_TOOLS）
    "serial_workflow_run",
];

/// 判断**这一次调用**算不算写操作。
///
/// **危险动作表**（设计 §9 / §16.6.4）：名字 → 一句"后果"。
///
/// 判定口径**只有一条**：会对外产生**不可撤销**影响的操作（对外广播、放行外部写入、
/// 在别人的设备上执行、动宿主机的硬件挂载、系统弹窗配对）。
/// 串口收发**不算** —— 它是这个工具的本职，天天要按，加确认只会让人关掉确认。
///
/// 表里的每个工具调用时都必须带 `confirm: true`，否则**不执行**并回 `-32006`
/// （"前置条件没满足"那一类：Agent 该做的是"确认后再来"，不是改参数重试）。
pub const DANGER_TOOLS: &[(&str, &str)] = &[
    // ⚠️ `ble_periph_start` / `ble_periph_stop`（对外广播 BLE 外设）曾在这张表里，
    // 已随 BLE 从机方向一起删除（2026-09）：本机实测广播起不来，功能无法交付。
    (
        "adb_open_shell",
        "在**别人的设备上**开一个交互式 shell（开出来之后就能在上面执行任意命令）",
    ),
    (
        "adb_shell_write",
        "把内容写进设备的 shell —— 内容里带换行就是在**设备上真的执行**它",
    ),
    (
        "serial_workflow_run",
        "让一条工作流规则**跑起来**：之后它一收到匹配的数据就会自动往设备发数据（还可能写日志文件）",
    ),
];

/// 这个工具要不要二次确认；要的话返回它的后果说明
pub fn danger_note(name: &str) -> Option<&'static str> {
    DANGER_TOOLS.iter().find(|(n, _)| *n == name).map(|(_, why)| *why)
}

/// 为什么不能只看工具名：`serial_quick_cmd` 不带 `index`/`action` 是"列出快速指令"（只读），
/// 带 `index` 就是"真的把那条指令发出去"、带 `action` 就是"改列表/开关循环"（都是写）。
/// **只读模式必须按调用判，不能按工具判** —— 否则要么漏放一个真写操作进来，
/// 要么把只读的列举也一起禁掉。
pub fn is_write_call(name: &str, args: &Value) -> bool {
    if name.starts_with("ctl_") {
        return true; // 每个 ctl_* 都是"改某个控件"
    }
    if name == "serial_quick_cmd" {
        return args.get("index").is_some() || args.get("action").is_some();
    }
    // 工作流同理：`list`（或什么都不给）是只读，改规则是写；启停是**危险**的那个（单独一个工具）
    if name == "serial_workflow" {
        let act = args.get("action").and_then(|v| v.as_str()).unwrap_or("list");
        return act != "list";
    }
    WRITE_TOOLS.contains(&name)
}

/// `serial_open` 的前置检查：本机一个串口都没有时**直接失败**。
///
/// 没有原来这么做的代价：没设备时（沙箱、或机器上还没插设备）会"点开始监控 → 轮询 6 秒 → 报超时"，
/// Agent 白等 6 秒、拿到一个含糊原因，而且很可能再试一次。提前判定能把它变成一次**立刻的、可行动**的失败。
fn no_serial_port_hint(port_count: usize) -> Option<String> {
    if port_count == 0 {
        Some(
            "本机没有可用串口（serial_list_ports 为空）：插上设备、装好驱动后再试。\
             已跳过「开始监控」，不会再去等轮询超时。"
                .to_string(),
        )
    } else {
        None
    }
}

/// 本轮已实现的工具（后续按 §16 的 S6/S7 增补语义工具与 `ctl_*` 全量工具）
pub fn tool_defs() -> Vec<Value> {
    vec![
        json!({
            "name": "app_info",
            "description": "本机 SeaHi Serial 应用的基本信息（版本、平台、进程、运行时长）。只读，无副作用。",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "mcp_status",
            "description": "MCP 服务器自身状态：是否运行、监听端点、会话数、请求数与限流/丢弃计数。只读。",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "mcp_limits",
            "description": "MCP 服务器的硬性上限（会话数、队列深度、心跳、限流、超时等）。只读，用于判断会不会被限流。",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "serial_list_ports",
            "description": "枚举本机可用串口（端口名 / 友好名称 / 产品名）。只读，不会打开端口。⚠️ **只有 Windows 侧的 COM 口** —— WSL 分栏的端口是 WSL 内部的 `/dev/...`，不在这里（用 serial_get_state 的 `portOptions` 看那个分栏能选什么）。返回 {count, ports:[…]}。",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        // ===== 串口语义工具（S12）=====
        // 为什么要有它们：通用控件桥（ui_*）用"控件路径"寻址，多分栏时会撞名、也读不懂意图；
        // 而 AI 真正要表达的是"选 COM3 / 波特率 115200 / 开始监控 / 发这一帧"。
        // 实现上**不另写一套逻辑**：改值走前端 mcpWriteEl（与 ui_set 同一函数）、点按钮走 el.click()，
        // 所以界面必然跟着变。分栏用 pane（main / extra-1 / …）指定，省略即 main。
        json!({
            "name": "serial_get_state",
            "description": "读某个串口分栏的完整状态：端口、波特率、帧格式(数据位/停止位/校验)、行尾、DTR/RTS、查看模式、行号/时间戳/回显/自动滚动/自动重连/终端模式、**是否正在监控**、输出行数与字节数、发送历史条数、以及全部分栏名（`panes`）。还给出 `portOptions` —— **这个分栏**当前能选哪些端口（Windows 分栏是 COM 名，WSL 分栏是 `/dev/...` 路径；`inUse` 表示被别的分栏占着）。省略 pane 默认 main。**操作串口前先调它**。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pane": { "type": "string", "description": PANE_DESC }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "serial_select_port",
            "description": "选串口分栏要用的端口（等价于在「端口」下拉里选一项）。值必须是**该分栏**端口下拉里的一个 —— 也就是 serial_get_state 的 `portOptions` 里的 `value`；给错会回列可选值。⚠️ **别拿 serial_list_ports 当依据**：它只列 Windows 的 COM 口，而 WSL 分栏要的是 `/dev/ttyUSB0` 这类 WSL 内部路径（把 USB 串口 usbipd bind 进 WSL 之后，Windows 侧本来就看不到那个口）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "port": { "type": "string", "description": "端口名：Windows 分栏如 COM3；WSL 分栏如 /dev/ttyUSB0" },
                    "pane": { "type": "string", "description": PANE_DESC }
                },
                "required": ["port"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "serial_set_baud",
            "description": "设置波特率（110..4000000）。等价于在「波特率」输入框里填值。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "baud": { "type": "number", "description": "波特率，如 115200" },
                    "pane": { "type": "string", "description": PANE_DESC }
                },
                "required": ["baud"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "serial_set_frame",
            "description": "设置串口帧格式：dataBits(5|6|7|8) / stopBits(1|2) / parity(none|odd|even)。至少给一个（在「更多设置」里）。**改帧格式只在未连接时有意义**，连接中请先 serial_close。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "dataBits": { "type": "string", "enum": ["5", "6", "7", "8"] },
                    "stopBits": { "type": "string", "enum": ["1", "2"] },
                    "parity": { "type": "string", "enum": ["none", "odd", "even"] },
                    "pane": { "type": "string", "description": PANE_DESC }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "serial_set_lines",
            "description": "设置 DTR / RTS 电平（布尔）。常用于让目标板复位（DTR 拉低）或进入下载模式。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "dtr": { "type": "boolean" },
                    "rts": { "type": "boolean" },
                    "pane": { "type": "string", "description": PANE_DESC }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "serial_set_display",
            "description": "设置显示与行为开关：viewMode(text|hex)、lineEnding(crlf|lf|cr|none)、echo(消息回显)、lineNum(行号)、timestamp(时间戳)、autoScroll(自动滚动)、autoReconnect(自动重连)、terminalMode(终端模式)、advOpen(更多设置栏展开)。至少给一个。**serial_get_state 报出来的每个开关这里都能设**。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "viewMode": { "type": "string", "enum": ["text", "hex"] },
                    "lineEnding": { "type": "string", "enum": ["crlf", "lf", "cr", "none"] },
                    "echo": { "type": "boolean" },
                    "lineNum": { "type": "boolean" },
                    "timestamp": { "type": "boolean" },
                    "autoScroll": { "type": "boolean" },
                    "autoReconnect": { "type": "boolean" },
                    "terminalMode": { "type": "boolean" },
                    "advOpen": { "type": "boolean", "description": "「更多设置」栏是否展开（真串口面板才有）" },
                    "pane": { "type": "string", "description": PANE_DESC }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "serial_open",
            "description": "**开始监控**（等价于点「开始监控」按钮）。可以同时给 port/baud 一次设定，省两次调用。返回前会**确认真的连上**（最多等 6 秒）；失败会说明可能原因（端口被占用/设备拔出/驱动异常）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "port": { "type": "string", "description": "可选：先选端口再打开" },
                    "baud": { "type": "number", "description": "可选：先设波特率再打开" },
                    "pane": { "type": "string", "description": PANE_DESC }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "serial_close",
            "description": "停止监控（等价于点「停止监控」），返回前确认已断开。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pane": { "type": "string", "description": PANE_DESC }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "serial_send",
            "description": "往串口发数据。mode=hex 时 data 按十六进制字节解析（如 \"01 03 00 00 00 02\"），否则按文本发。lineEnding 可临时覆盖该分栏的行尾设置。需要该分栏已在监控中。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "data": { "type": "string", "description": "要发送的内容（文本或 HEX 串）；单次最多 64K 字符，大块数据请分批" },
                    "mode": { "type": "string", "enum": ["text", "hex"], "description": "发送模式，默认沿用界面当前设置" },
                    "lineEnding": { "type": "string", "enum": ["crlf", "lf", "cr", "none"], "description": "临时改行尾（改完会留在界面上）" },
                    "pane": { "type": "string", "description": PANE_DESC }
                },
                "required": ["data"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "serial_clear",
            "description": "清空该分栏的输出区内容（等价于点「清除内容」）。**只清界面显示，不动磁盘上的会话日志缓存文件。**",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pane": { "type": "string", "description": PANE_DESC }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "serial_get_history",
            "description": "读该分栏的发送历史（最近的在前）。用来回看刚才发过什么，或复用上一条指令。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "limit": { "type": "number", "description": "最多返回多少条，默认 20，上限 200" },
                    "pane": { "type": "string", "description": PANE_DESC }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "serial_get_output",
            "description": "读该分栏**实际收发的内容**（串口监视器的核心：设备刚才回了什么）。默认收+发都返回，按时间归并；每条带 dir 区分。数据取自日志中心，与 log_tail 是同一份存储；本工具额外的好处是**不需要你知道通道名**，且「还没收到数据」会返回空列表而不是报错。**读内容优先用 `format:\"text\"`**（一行一条 `[时刻] [rx|tx] 正文`，比默认 json 省一半以上 token）；要逐行结构化字段时才用 json。text 格式的正文在 content 文本里，structuredContent 只给元信息。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pane": { "type": "string", "description": PANE_DESC },
                    "direction": { "type": "string", "enum": ["rx", "tx", "both"], "description": "只要收(rx)/只要发(tx)/都要(both，默认)" },
                    "lines": { "type": "number", "description": "最多返回多少行，默认 50，上限 2000" },
                    "format": { "type": "string", "enum": ["json", "text"], "description": "输出编码：text=一行一条纯文本（推荐，省 token）；json=逐行结构化对象（默认）" }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "serial_quick_cmd",
            "description": "快速指令（监控输出区最右侧那条可折叠分栏，默认折叠）—— 列表按**循环组**分段，一组一张表。四种用法：①**不带参数**=列出全部（每条含 index/所属组/值/label 与它自己的发送参数 seq 顺序号、timeoutMs 超时、expect 追加的成功词、retry 重试次数、hex 是否按 HEX 发，以及可直接交给 ui_set 的 domIds；另给 groups[]（组名/条数/on 是否参与循环/folded）与 loop{on,planLength}，以及列表是否来自外部文件）；②**给 index**=执行第 index 条（按该条自己的 hex 决定文本还是 HEX）；③**action=loop**=开/关整条循环链（组从上到下 → 组内顺序号；每发一条**等它的回应**：busy 继续等 / OK 下一条 / ERROR 重发本条 / 等满超时终止整链；on 省略=取反；没连串口或没有可发条目时会拒绝并说明原因）；④**action=add|update|remove|group**=改列表（加一条/改一条/删一条/组操作 op=add|remove|rename|move|on|fold）。改列表会同时写回它挂载的外部文件（文件即存储）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "index": { "type": "number", "description": "要执行（不带 action 时）或要改（update/remove 时）的条目下标，从 0 开始，见 quickList 的 items[].index（按组→组内摊平）" },
                    "action": { "type": "string", "enum": ["loop", "add", "update", "remove", "group"], "description": "要做的动作：loop=开关循环发送；add=加一条；update=改一条；remove=删一条；group=组操作。省略=按 index 执行/只列举" },
                    "on": { "type": "boolean", "description": "action=loop 时：true 开、false 关（省略=取反）；action=group 且 op=on/fold 时：该组是否参与循环 / 是否折叠" },
                    "group": {
                        "anyOf": [ { "type": "number" }, { "type": "string" } ],
                        "description": "action=add/group 时指定哪一组：组序号（0 起，见 quickList 的 groups[].index）、组名或组 id。add 省略时加到最后那组（这里用 anyOf 而不是 type 数组：数组型 type 的客户端兼容性差，官方 Inspector 会报）"
                    },
                    "name": { "type": "string", "description": "action=group 且 op=rename 时的新组名" },
                    "toIndex": { "type": "number", "description": "action=group 且 op=move 时的目标组序号（0 起；组的上下顺序就是循环顺序）" },
                    "value": { "type": "string", "description": "action=add/update 时的指令内容（原样发送，不按逗号切分）" },
                    "seq": { "type": "number", "description": "action=add/update 时的顺序号：0 = 不参与循环，>0 在**组内**按数字升序发" },
                    "timeoutMs": { "type": "number", "description": "action=add/update 时的**超时**（毫秒）：这条发出去最多等多久 —— 等到 OK 发下一条、等到 ERROR 重发本条（见 retry）、等满这个时间还没等到 OK 就**终止整条循环**。缺省 3000，上限 600000。填 0 = 这条不等响应（连续 HEX 帧、设备本来就不回 OK 的指令）" },
                    "delayMs": { "type": "number", "description": "⚠️ **旧拼写**：与 timeoutMs 同一个值（这一项的语义是「超时」，不是「发送间隔」）。新调用请用 timeoutMs —— 两个都给时以 timeoutMs 为准" },
                    "expect": { "type": "string", "description": "action=add/update 时的**自定义成功词**，多个用 `|` 分隔（如 `WIFI GOT IP|OK`）。留空 = 只用内置的 OK / ERROR / busy。⚠️ 面板上没有它的入口（它写在指令文件的「期望」列里），通过这里改会同时落到模型与文件" },
                    "retry": { "type": "number", "description": "action=add/update 时：收到 ERROR 后最多重发几次（缺省 3，上限 10；0 = 不重发，直接终止）" },
                    "hex": { "type": "boolean", "description": "action=add/update 时：这一条是否按 HEX 解析后发送（默认 false）" },
                    "pane": { "type": "string", "description": PANE_DESC }
                },
                "additionalProperties": false
            }
        }),
        // ===== 工作流规则（自动化：收到匹配的数据就自动执行动作）=====
        // 启停**单独一个工具**，因为"危险"只发生在那一刻（规则跑起来才会自动发数据）；
        // 若把整条工具塞进 DANGER_TOOLS，连"列出规则"都要 confirm —— 那是把确认门用歪了。
        json!({
            "name": "serial_workflow",
            "description": "串口/WSL 分栏的**自动化工作流规则**（面板「更多设置 → 工作流」那一块）：收到匹配的数据就自动执行动作（发数据 / 切 DTR-RTS / 存日志）。用法：①**省略 action**=列出该分栏的全部规则（id / name / enabled / running / 条件 / 动作）；②**action=add**=加一条（可给 name / conditions / actions / enabled；**新规则一律 running=false**）；③**action=update**=按 rule 改（给哪个字段改哪个；running 只接受 false，用来停一条正在跑的）；④**action=remove**=按 rule 删（正在跑的会一起停）。⚠️ 规则一旦 running，**收到匹配数据就会自动往设备发数据** —— 要启动请用 serial_workflow_run（要 confirm），**不要**用 ui_click 点面板上那颗运行按钮绕开确认。改规则会立刻写进配置（与面板上改同一条路）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "add", "update", "remove"], "description": "要做的动作：list=列出（省略即 list）；add=加一条；update=改一条；remove=删一条" },
                    "pane": { "type": "string", "description": PANE_DESC },
                    "rule": { "type": "string", "description": "update/remove 时的规则 id（见 list 里 rules[].id）" },
                    "name": { "type": "string", "description": "add/update 时的规则名（最长 64 字符）" },
                    "enabled": { "type": "boolean", "description": "add/update 时这条规则是否**启用**（关掉的规则不参与匹配；注意它与 running 是两回事）" },
                    "running": { "type": "boolean", "description": "⚠️ 这里**只接受 false**（用来停一条正在跑的规则）；想启动请用 serial_workflow_run。add 时给 true 会被强制成 false" },
                    "conditions": {
                        "type": "array",
                        "description": "匹配条件，**全部满足**才触发：[{\"type\":\"string_contains|regex|exact_bytes\",\"value\":\"…\"}]，最多 8 条，不能是空数组",
                        "items": { "type": "object" }
                    },
                    "actions": {
                        "type": "array",
                        "description": "命中后**按顺序**执行：[{\"type\":\"send_data|toggle_dtr_rts|save_log\",\"data\":\"…\",\"encoding\":\"text|hex\",\"signal\":\"dtr|rts\",\"level\":true,\"delayBefore\":300}]，最多 8 条，不能是空数组",
                        "items": { "type": "object" }
                    }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "serial_workflow_run",
            "description": "开始/停止一条工作流规则的**运行**（running）。⚠️ 危险动作：开始之后，这条规则一收到匹配的数据就会**自动往设备发数据**（动作里可能还有存日志文件），必须带 confirm:true；不带时**不会执行**并返回 -32006 说明后果。停止（on=false）同样需要 confirm —— 它属于同一条工具。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "rule": { "type": "string", "description": "规则 id（见 serial_workflow 的 rules[].id）" },
                    "on": { "type": "boolean", "description": "true = 开始跑，false = 停止（省略 = true）" },
                    "pane": { "type": "string", "description": PANE_DESC },
                    "confirm": { "type": "boolean", "description": "危险动作确认：必须为 true 才会执行（想清楚再传）" }
                },
                "required": ["rule"],
                "additionalProperties": false
            }
        }),
        // ===== BLE 语义工具（§16.6.1 第一批；从机那批已于 2026-09 删除）=====
        // 与 serial_* 同构：工具名 → 前端 `mcpBleOp` 的 action；读写分类见 is_write_call。
        json!({
            "name": "ble_get_state",
            "description": "蓝牙分栏的当前状态：是否在扫描、扫到几台设备、选中/已连的是哪台、GATT 服务树有几个服务、订阅了几路通知、内嵌监视器是否打开。只读，无副作用。",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "ble_list_devices",
            "description": "读蓝牙扫描结果（不触发扫描）：MAC、名称、信号强度 RSSI、是否已配对、是否当前选中，以及扫描是否在进行中。**支持分页**：`limit` 每页几台、`offset` 从第几台开始（返回里给 `hasMore` / `nextOffset`，拿它接着翻）。⚠️ 扫描还在进行时列表仍在增长，翻页可能重复/漏掉个别设备；要稳定完整的名单就等 `scanning=false` 再翻，或一次给个大 `limit`。**每次都会现问一次后端**（不是只读面板那个 2 秒轮询的缓存），所以刚 ble_start_scan 完立刻问也拿得到；一台都没有时会说明下一步 —— 设备不广播（被 Windows 配对过 / 被别的主机连走）时扫描永远为空，得用 ble_connect + addr 按 MAC 直连。只读。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "limit": { "type": "number", "description": "每页最多几台（省略/0=不限，一次全给）" },
                    "offset": { "type": "number", "description": "从第几台开始（0 起，默认 0）；翻页时用返回的 nextOffset" }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "ble_start_scan",
            "description": "开始扫描蓝牙设备（面板那颗「开始/停止扫描」按钮的同一条路径）。默认按面板上设的时长自动停止；扫完用 ble_list_devices 取结果。写操作（会占用射频）。",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "ble_stop_scan",
            "description": "停止蓝牙扫描（复用同一颗按钮的路径）。写操作。",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "ble_read",
            "description": "读一个特征的值（按 UUID 寻址）——**点的是面板上那颗读按钮**，结果随后出现在 ble_get_output 里。需要设备已连接、且该特征有 read 属性（用 ble_get_services 看）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "char": { "type": "string", "description": "特征 UUID（见 ble_get_services 的 services[].chars[].uuid）" }
                },
                "required": ["char"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "ble_subscribe",
            "description": "开/关某个特征的通知订阅（notify / indicate）——点的是面板上那颗订阅按钮，数据随后出现在 ble_get_output 里。**状态已经在目标值时不会重复点**（不会把用户刚打开的订阅关掉）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "char": { "type": "string", "description": "特征 UUID（见 ble_get_services 的 services[].chars[].uuid）" },
                    "on": { "type": "boolean", "description": "true=订阅、false=退订（省略=true）" }
                },
                "required": ["char"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "ble_write",
            "description": "往一个特征写数据（按 UUID 寻址）——**打开的就是面板那个写入窗并点「发送」**，HEX/文本解析、行尾、写响应/无响应全用面板那套（写入窗会留在界面上，数据日志里也能看到这一条）。需要设备已连接、且该特征有 write 属性（见 ble_get_services）。写操作。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "char": { "type": "string", "description": "特征 UUID（见 ble_get_services 的 services[].chars[].uuid）" },
                    "data": { "type": "string", "description": "要写入的内容；format=hex 时是十六进制串（如 01A0FF 或 01 A0 FF）" },
                    "format": { "type": "string", "enum": ["text", "hex"], "description": "内容格式（省略=text）" },
                    "lineEnding": { "type": "string", "enum": ["none", "cr", "lf", "crlf"], "description": "文本模式追加的行尾（省略=none，即原样写入 —— 协议帧最不容易被写坏）" },
                    "writeType": { "type": "string", "enum": ["write", "write_without_response"], "description": "写响应 / 无响应（省略=用该特征的第一种；给了但该特征不支持会报错并把可选值列出来）" }
                },
                "required": ["char", "data"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "ble_connect",
            "description": "连接一台 BLE 设备。给 addr 时：**扫描列表里有它**就点它的卡片再走「连接设备」（同一条路）；**列表里没有**就走「按 MAC 直连」（不依赖广播 —— 被 Windows 配对过、或被别的主机连走因而不广播的设备，只有这条路连得上）。不给 addr 就用面板当前选中的那台。**等连接真的成功才返回**（会带上服务数）。写操作。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "addr": { "type": "string", "description": "设备 MAC，如 A4:C1:38:11:14:2B（省略=用面板已选中的设备）" }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "ble_disconnect",
            "description": "断开当前已连接的设备（面板那颗「断开设备」按钮的同一条路）。断开后服务树、订阅状态、本次会话的数据日志一并清空。写操作。",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "ble_get_output",
            "description": "读蓝牙面板**本次会话**的数据日志（连上之后收到的通知/读到的内容、发出的写，按时间排列；切设备或断开会清空）。要跨会话的完整历史就用返回里的 `channels.rx` 去 log_tail。**要\"这条 ERROR 出现几次\"别拉条目**：给 `pattern` + `mode`（与 `log_search` 同一套词汇）—— `count` 只回计数、`matches` 只回片段、`lines`（默认）回条目。匹配的文本取 `text`，`text` 为空时取 `hex`（HEX 通知也能搜）。只读。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "limit": { "type": "number", "description": "只要最后 N 条（省略=全部）" },
                    "sinceSeq": { "type": "number", "description": "增量：只要 seq 大于它的（与返回的 items[].seq 对齐）" },
                    "pattern": { "type": "string", "description": "要检索的内容（字符串按**字面量**处理，regex=true 才是正则）。上限 512 字符" },
                    "mode": { "type": "string", "enum": ["lines", "matches", "count"], "description": "count=只回计数（最省）/ matches=只回匹配片段 / lines=条目本身（默认）。后两档**必须**给 pattern" },
                    "regex": { "type": "boolean", "description": "true 时 pattern 按正则解释，默认 false" },
                    "caseSensitive": { "type": "boolean", "default": false, "description": "区分大小写；也接受旧拼写 case_sensitive" }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "ble_refresh_rssi",
            "description": "读当前已连接设备的信号强度（RSSI，负数，越接近 0 越强）。只问一次射频、不改状态；还没连设备时会直接说明。",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "ble_get_services",
            "description": "当前已连接设备的 GATT 服务树（服务 UUID / 名称，每个服务下的特征 UUID、属性 props、描述符个数）。只读，取的是面板已经拉到的那份，不会重新去问设备。",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        // ⚠️ 这里原来还有三个 BLE **从机**工具（`ble_periph_status` / `ble_periph_start` /
        // `ble_periph_stop`：把本机当外设对外广播）。2026-09 **整条方向删除**：
        // 本机适配器自报支持外设角色，但实测广播起不来（`ble_periph_starts_advertising`
        // 一直是失败的那个，见 doc/BLE_PERIPHERAL.md）—— 交付不了的功能不该留在工具表里。
        // 客户端拿着旧名字调过来会得到一句"已删除 + 现在有什么"的 -32602（见分派那一处）。
        // ===== ADB 语义工具（§16.6.2 第三批的 ADB 部分；前端 mcpAdbOp）=====
        // 与 serial_*/ble_* 同构：工具名 → 前端 action，每个 action 都走面板那条真实路径。
        // ADB 面板是**单会话**模型（一次只有一台设备开着 shell），所以除 open 之外的动作
        // 都作用于"当前那个会话"，不再重复要 serial。
        json!({
            "name": "adb_list_devices",
            "description": "列出 `adb devices -l` 看到的设备（序列号 / 状态 / 型号）。只读，不会开 shell。**只有 state=device 的那台才可用**；unauthorized 表示还没在设备上点「允许 USB 调试」。",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "adb_open_shell",
            "description": "在设备上开一个交互式 shell 会话（等价于点面板上那台设备的卡片：建 xterm + PTY）。开之前先确认设备在且 state=device；**等 PTY 真的建出来才返回**（最长 10 秒）。⚠️ 危险动作（之后能在设备上执行任意命令），必须带 confirm:true；不带时不会执行并返回 -32006。开完用 adb_shell_write 发命令、adb_shell_read 读输出。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "serial": { "type": "string", "description": "设备序列号（见 adb_list_devices；省略=用第一台 state=device 的设备）" },
                    "confirm": { "type": "boolean", "description": "危险动作确认：必须为 true 才会执行" }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "adb_shell_write",
            "description": "往已打开的 ADB shell 写入内容（与在面板终端里敲键盘同一条路：字节会进设备 shell 的 stdin）。**命令要自己带上 \\n**，不带就只是填在命令行上不会执行。⚠️ 危险动作（写进去的内容会被设备真的执行），必须带 confirm:true。单次最多 4096 字符（mcp_limits.maxAdbWriteChars），超了报 -32602。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "data": { "type": "string", "description": "要写入 shell 的内容，如 \"ls -l\\n\"" },
                    "confirm": { "type": "boolean", "description": "危险动作确认：必须为 true 才会执行" }
                },
                "required": ["data"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "adb_shell_read",
            "description": "读 ADB shell 已经产生的输出（日志中心 adb:rx 通道：PTY 读线程在生产端旁路的一份副本，**不会抢走界面终端要显示的队列**）。**items 是 PTY 的输出块、不是按行切好的文本**（终端输出本来就没有行边界，ANSI 光标序列会跨块）。用 sinceSeq 增量跟进：下一次传返回 items 里最后一条的 seq。**`logcat` 刷屏时先别拉条目**：给 `pattern` + `mode`（与 `log_search` 同一套词汇）—— `mode:\"count\"` 只回\"命中多少条/多少处\"，`mode:\"matches\"` 只回命中片段，`mode:\"lines\"`（默认）回条目本身（给了 pattern 就只回命中的）。只读，不需要界面。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sinceSeq": { "type": "number", "description": "只要 seq 大于它的行（增量跟进；省略=取尾部 limit 行）" },
                    "limit": { "type": "number", "description": "最多回多少行，默认 200，上限 2000（mcp_limits.maxAdbReadLines）" },
                    "pattern": { "type": "string", "description": "要检索的内容（字符串按**字面量**处理，regex=true 才是正则）。上限 512 字符" },
                    "mode": { "type": "string", "enum": ["lines", "matches", "count"], "description": "count=只回计数（最省）/ matches=只回匹配片段 / lines=条目本身（默认）。后两档**必须**给 pattern" },
                    "regex": { "type": "boolean", "description": "true 时 pattern 按正则解释，默认 false" },
                    "caseSensitive": { "type": "boolean", "default": false, "description": "区分大小写；也接受旧拼写 case_sensitive" }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "adb_shell_resize",
            "description": "调整已打开 ADB shell 会话的 PTY 尺寸（与面板跟着容器尺寸自动推的是同一个后端命令）。cols/rows 都是 2~1000（mcp_limits.maxAdbCols / maxAdbRows）。注意：面板自己的尺寸同步（窗口/容器变化时）可能随后把它改回真实容器尺寸。写操作。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "cols": { "type": "number", "description": "列数（2~1000）" },
                    "rows": { "type": "number", "description": "行数（2~1000）" }
                },
                "required": ["cols", "rows"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "adb_close_shell",
            "description": "关掉当前 ADB shell 会话（等价于点面板上会话的关闭：杀掉 adb shell 子进程 + 移除终端）。本来就没开会话时是幂等的（closed:false + note），不是错误。写操作。",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "mcp_danger",
            "description": "列出**需要二次确认**的危险工具（会对外产生不可撤销影响的那些）与各自的后果。调用它们时必须带 confirm:true，否则不会执行。只读。",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),        // ===== 通用界面桥（S5）：保证"没有任何控件够不到" =====
        json!({
            "name": "ui_list",
            "description": "列出界面上的可操控控件（按钮/输入框/下拉/开关）。每条给出 path、类型、面板、当前值、是否可用与不可用的原因。建议先用它枚举，再决定操作哪个。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "panel": { "type": "string", "description": "只看某个面板：serial / wsl / adb / ble / global / mcp / dialog" },
                    "kind": { "type": "string", "description": "只看某种类型：button / toggle / select / text / number / checkbox / range" },
                    "query": { "type": "string", "description": "按 path 或标签做子串匹配" },
                    "cursor": { "type": "string", "description": "分页游标（上一次返回的 nextCursor）" },
                    "limit": { "type": "number", "description": "每页条数，默认 100，最大 500" }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "ui_describe",
            "description": "看某个控件的完整信息与它的输入格式（inputSchema）：可选值有哪些、要传数字还是布尔。",
            "inputSchema": {
                "type": "object",
                "properties": { "path": { "type": "string", "description": "控件路径，如 serial.conn.portSelect" } },
                "required": ["path"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "ui_get",
            "description": "读某个控件的当前值（实时从界面读，不是缓存的配置）。",
            "inputSchema": {
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"],
                "additionalProperties": false
            }
        }),
        // ⚠️ 这个 json! 字面量里**不能写 // 注释**：`.walkthrough/gen_mcp_tools_doc.js`
        // 会把整段 `{…}` 抠出来 `JSON.parse`，JSON 不允许注释（踩过：加注释直接把文档生成器打挂）。
        // 关于下面那个 anyOf：不用 `"type": ["string","number","boolean"]` 是因为 type 数组虽然
        // 合法，但**不少 MCP 客户端把 type 当单个字符串读**（官方 Inspector 的 portability 检查
        // 会报出来）→ 要么拒收工具、要么丢掉约束。
        json!({
            "name": "ui_set",
            "description": "设置控件值。执行走的是与用户点击完全相同的路径，所以界面会同步变化。返回的是**写后的真实值**（控件可能规范化输入）。可用 items 一次设置多个。⚠️ 少数动作是「点了才开始跑」的 —— 典型是 WSL 端口映射那个复选框（要过 usbipd，可能要用户在机器上点授权框）：结果里会带 `mapRequest.settled=false` 与 `note`，**那时不要重试**，稍后用 ui_get_state{section:\"wslDevices\"} 看 status 是否变成 mapped。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "value": { "anyOf": [{ "type": "string" }, { "type": "number" }, { "type": "boolean" }], "description": "新值：文本/数字/布尔；下拉传选项的 data-val" },
                    "items": {
                        "type": "array",
                        "description": "批量设置：[{path, value}, …]（**一次最多 200 个**，这是硬上限：这条链路跑在界面主线程上，超了会报 -32602，请分批）",
                        "items": { "type": "object", "properties": { "path": { "type": "string" }, "value": { "anyOf": [{ "type": "string" }, { "type": "number" }, { "type": "boolean" }] } }, "required": ["path"] }
                    }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "ui_get_state",
            "description": "读整个界面状态的快照（就是随用户配置持久化的那份：各监视器的端口/波特率/行尾/显示模式/开关、主题、蓝牙选中项等）。可用 section 只取子树。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "section": {
                        "type": "string",
                        "description": "serial / wsl / ble / bleDevices / wslDevices / theme / window / monitors；省略=全部。**运行时设备表**（不是配置）：蓝牙扫描结果读 `bleDevices`（全量）或 `ble.scanResult`（前 10 台）；WSL 端口映射的 USB 设备表读 `wslDevices` —— 两处的行都是**动态 div、不在控件注册表里**，所以只有通用桥的客户端必须从这里读。`wslDevices` 每条还带 `mapControlPath`（可直接交给 ui_set 的控件路径），要映射某台设备就先用它把 COM 名对上 busid。",
                        "enum": ["serial", "wsl", "ble", "bleDevices", "wslDevices", "theme", "window", "monitors"]
                    }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "ui_click",
            "description": "点一个按钮/开关（等价于 ui_set 传 true，但语义更清楚）。⚠️ 同 ui_set：WSL 端口映射那种「点了才开始跑」的控件会在结果里带 `mapRequest.settled=false`，别重试，去 ui_get_state{section:\"wslDevices\"} 复查。",
            "inputSchema": {
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"],
                "additionalProperties": false
            }
        }),
        // ===== 日志中心（S7）=====
        json!({
            "name": "log_channels",
            "description": "列出所有日志通道（条数 / 字节 / seq 区间 / 被丢弃条数 / 最后一条时间）。不确定去哪找日志时先调它。",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "log_tail",
            "description": "取某个通道的尾部若干行。**读日志优先用 `format:\"text\"`** —— 一行一条纯文本，同样内容比默认的 json 省一半以上 token（实测短行日志 3.5 倍：101 字节/行 → 29 字节/行，短行的开销几乎全在每行的 JSON 包装上）；要逐行的结构化字段（seq/时间戳/字节数/方向）时才用 json。给了 `sinceSeq` 就是增量拉取：返回里的 `nextSinceSeq` 是**下次该带的值**（推进到它就不会漏也不会重复；直接跳到 `seqTo` 会把没拿到的行永远跳过），`missed>0` 表示这一段还有行没给你，`mayBeIncomplete=true` 表示该通道丢过最旧的行（别把日志当完整证据）。text 格式的日志正文在 content 文本里，structuredContent 只给元信息。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "channel": { "type": "string", "description": "通道名，如 app / error / mcp / serial:main:rx / ble:rx / ui:sys" },
                    "lines": { "type": "number", "description": "最多返回多少行，默认 100，上限 2000" },
                    "sinceSeq": { "type": "number", "description": "只取 seq 大于它的行（用于增量跟进）；也接受旧拼写 since_seq" },
                    "format": { "type": "string", "enum": ["json", "text"], "description": "输出编码：text=一行一条纯文本（推荐，省 token）；json=逐行结构化对象（默认）" }
                },
                "required": ["channel"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "log_search",
            "description": "在日志里检索（子串或正则）。不给 channel 就搜所有通道。**先想清楚要多少信息再选 `mode`**：`count` 只回计数（`total` + 有命中的通道各几次，几十 token —— 问\"ERROR 出现过几次\"\"到底有没有超时\"就用它）；`matches` 只回匹配片段（一行里每处命中一条，只有 `match` 字段，长行日志用它比回整行省得多）；`lines`（默认）回命中行本身，另可用 `context` 带前后几行。每条命中都带 channel/seq，便于接着 log_tail 看上下文。⚠️ 要成段读某个通道就用 `log_tail{format:\"text\"}`，别把本工具当\"读全部\"用。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "要找的内容（不能为空串；regex=true 时按正则解释）" },
                    "channel": { "type": "string", "description": "限定通道；省略=全部" },
                    "regex": { "type": "boolean", "description": "true 时 pattern 按正则解释，默认 false" },
                    "caseSensitive": { "type": "boolean", "default": false, "description": "区分大小写；也接受旧拼写 case_sensitive" },
                    "limit": { "type": "number", "description": "最多回多少条（matches 模式是**匹配处数**，一行多处算多条），默认 100，上限 500" },
                    "mode": { "type": "string", "enum": ["lines", "matches", "count"], "description": "返回什么：count=只回计数（最省）/ matches=只回匹配片段（rg -o 那种）/ lines=命中行（默认）" },
                    "context": { "type": "number", "description": "命中行前后各带几行（0~5，默认 0；**只对 mode:\"lines\" 有意义**）" }
                },
                "required": ["pattern"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "log_stats",
            "description": "各通道的概览：条数、字节、被丢弃条数、告警/错误数、时间跨度与平均行/秒。用来判断\"是不是在刷屏\"。",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "log_clear",
            "description": "清空某个通道，或省略 channel 清空全部。",
            "inputSchema": {
                "type": "object",
                "properties": { "channel": { "type": "string" } },
                "additionalProperties": false
            }
        }),
        // ⚠️ 这里原来有个 `log_export`（把全部通道按时间归并成一段纯文本）。
        // 2026-09 **删掉了**：它是唯一能把"全量日志"一次性塞进返回体的工具
        // （省略 channels = 全部通道 × 默认 2000 行/通道、上限 20000），
        // 而返回体**没有大小上限**（`MAX_BODY_BYTES` 只管请求），
        // 于是一次调用就可能拼出几十 MB —— 既撑爆 AI 的上下文，也让客户端解析打摆。
        // 它也没有普通用户会用到的落盘能力（实现里只回文本）。
        // 要看全量：用 log_tail{format:"text"} 增量跟进，或让用户直接看
        // `%APPDATA%\seahi-serial\log-cache\`。真需要"导出文件"就重做一个
        // **用户可见路径 + 硬上限**的写文件工具，而不是把字节倒进对话里。
        // ===== AI 调用记录与配置（S8）=====
        json!({
            "name": "mcp_calls",
            "description": "查最近的工具调用记录（谁在什么时候调了什么、成没成、耗时多久、改动了哪些控件）。记录写在独立的 ai-calls.jsonl，不碰用户配置。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "limit": { "type": "number", "description": "最多返回多少条，默认 50，上限 2000" },
                    "tool": { "type": "string", "description": "只看某个工具" },
                    "okOnly": { "type": "boolean", "description": "true 只看成功，false 只看失败；也接受旧拼写 ok_only" },
                    "format": { "type": "string", "description": "jsonl（默认）或 md 表格", "enum": ["jsonl", "md"] }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "mcp_stats",
            "description": "调用统计：总次数、按工具分布、时间范围、记录文件大小与丢弃数。",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "mcp_config_get",
            "description": "读 MCP 自己的配置（服务器开关/端口/记录设置等）。token 只回打码值。",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "mcp_config_set",
            "description": "改 MCP 自己的配置。只支持 server 与 callLog 两类键（未知键会报错）。改 server.* 只保存、不立刻重启（需在界面里关闭再启用才生效）；不接受改 token。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "patch": {
                        "type": "object",
                        "description": "例：{\"callLog\":{\"includeResults\":true}} 或 {\"server\":{\"port\":7778}}"
                    }
                },
                "required": ["patch"],
                "additionalProperties": false
            }
        }),
    ]
}

/// 串口语义工具里那个 `pane` 参数的说明 —— **只写这一处**。
///
/// 为什么抽出来：13 个工具各抄一遍的下场是"改一处漏十二处"，而漏掉的恰好是一整类分栏 ——
/// 原先只写了 `main / extra-1 / extra-2 …`，**一个字都没提 WSL**，于是 AI 看工具定义时
/// 根本不知道还能用 `pane:"wsl"` 去操作 WSL 面板里的串口监视器（2026-09 用户问
/// "WSL 端口映射也有串口监视器，MCP 的串口工具怎么区分"时暴露的）。
/// 太长会白占模型上下文（13 份），所以这句话要短 —— 细节放在 `serial_get_state` 的返回值里
/// （`panes` 报出全部分栏、`portOptions` 报出该分栏能选哪些端口）。
///
/// 后半句两条都是 2026-09 补的、AI 真的会撞上的事：
/// ① **写操作会把该分栏的面板切到前台**（用户得看得见 AI 在动哪一栏；只读工具不切，
///    否则客户端一 poll 就把用户从别的页面拽走）；② **WSL / 额外分栏是懒创建的**，
///    面板没打开过时它还不存在 —— 写操作会顺带把它建出来，只读工具则会提示"先打开面板"。
pub const PANE_DESC: &str =
    "分栏名：main / extra-N（Windows），wsl / wsl-xN（WSL）；省略=main。写操作会自动把该分栏的面板切到前台（用户要看得见）；WSL 分栏是懒创建的，写操作会顺带把它建出来";

/// 一次性最多生成多少个 `ctl_*` 工具。
/// 不做上限的话，一个有多面板 + 多个监视器的界面能轻松生成几百个工具，
/// 而工具列表是要塞进模型上下文的 —— 上限是保护，不是偷懒。
pub const MAX_CTL_TOOLS: usize = 400;

/// `ui_set` 一次最多改多少个控件。
///
/// **为什么必须有**：前端的 `set` 分支是在 **WebView 主线程**上逐个 `ent.read()/write()` +
/// 派发 `input`/`change` 的。请求体本身有 1 MiB 上限，但一条 `{"path":…,"value":…}` 才 40 多字节，
/// 1 MiB 能塞进**两万多个** items —— 那就是"AI 一句请求把界面冻住几秒"。
/// 上限按"批量操作"的实际需要给（远大于人类会手写的量），超了就报 -32602 让调用方分批。
pub const MAX_UI_SET_ITEMS: usize = 200;

/// `ui_set` **单条** item 的 `value` 最多多少字符。
///
/// **为什么必须有**：`MAX_UI_SET_ITEMS` 只挡住了"条数"，单条 `value` 却是无界的 ——
/// 1 MiB 的请求体可以塞进**一条** 100 万字符的字符串，而它最终会被写进 WebView 主线程上的
/// 输入框（`el.value = String(v)`）并触发一次配置落盘。上限按"人要往输入框里填多少"给足余量。
pub const MAX_UI_SET_VALUE_CHARS: usize = 8192;

/// `serial_send` 单次最多发多少**字符**（HEX 模式下两个字符=一个字节）。
///
/// **为什么必须有**：串口写是排队的，1 MiB 数据在 115200 波特下要发一分半钟，
/// 期间写队列一直压着 —— 那是直接干扰用户的串口会话。要发大块数据应当分批。
pub const MAX_SEND_CHARS: usize = 64 * 1024;

/// `ble_write` 单次最多写多少**字符**（HEX 模式下两个字符=一个字节）。
///
/// **为什么必须有**：BLE 单次写受 MTU 限制（典型载荷 20~512 字节，长写要分段），
/// 一次几百 KB 既写不进去、又会让 WebView 主线程先卡住（AGENTS #10）。
pub const MAX_BLE_WRITE_CHARS: usize = 4096;

/// `ble_list_devices` 一页最多多少台。
///
/// **为什么要有**：一次全量（几十上百台）会让响应体冲到十几 KB，客户端那边既显示不完、
/// 也没法"接着翻"（2026-09 用户："limit 只能设上限，没有分页/offset，没法一页页翻完剩下的 88 台"）。
/// 现在有了 `offset`/`nextOffset`，但页大小仍要有界（AGENTS #10：接受外部数值的参数必须有上限）。
pub const MAX_BLE_DEVICE_PAGE: u64 = 200;

/// `limit` 的合法区间：**1..=MAX_BLE_DEVICE_PAGE**。
///
/// 为什么连 0 也要拒：前端的 `mcpBleScanResult` 把 `limit=0` 当成"不限"（`ble` 段那个精简口径
/// 也走同一条路），所以客户端只要传 `limit: 0` 就能**绕过"每页最多 200 台"的上限**、一次把
/// 全部设备拉走 —— 而 schema 与文档的写法都是"要全量就不给 limit"（2026-09 审计发现）。
fn check_page_limit(lim: u64) -> Result<(), RpcError> {
    if lim == 0 || lim > MAX_BLE_DEVICE_PAGE {
        return Err(RpcError::new(
            E_INVALID_PARAMS,
            format!(
                "limit 只能是 1~{}（收到 {}）。要看全部就**不给 limit**，或按 offset 翻页 —— \
                 0 在界面侧的含义是「不限」，会绕过每页上限。",
                MAX_BLE_DEVICE_PAGE, lim
            ),
        ));
    }
    Ok(())
}

/// `adb_shell_write` 单次最多写多少**字符**。
///
/// **为什么必须有**：这一头是设备的 PTY（shell），写进去的会被**真的执行**；
/// 而这条链路要先过 WebView 与 IPC（AGENTS #10）。1 MiB 的请求体足够塞进几十万字符，
/// 上限按"一条命令行 / 一小段脚本"给足余量 —— 要灌大文件请用 adb push（那是面板外的事）。
pub const MAX_ADB_WRITE_CHARS: usize = 4096;

/// `adb_shell_resize` 的列/行上限（下限都是 2，与面板 `syncAdbTermSize` 的
/// `Math.max(2, …)` 一致：0/1 会让远端 shell 的光标寻址与多列布局崩掉）。
///
/// **为什么必须有**：这两个数字会被原样交给 `portable_pty::PtySize`。超大值
/// （比如 65535×65535）让远端按这个尺寸重排/清屏，实际是把会话搞坏，而调用方看不出原因。
pub const MAX_ADB_COLS: u64 = 1000;
pub const MAX_ADB_ROWS: u64 = 1000;
/// ADB 终端尺寸的下限（与前端 `Math.max(2, …)` 同一个数）
pub const MIN_ADB_DIM: u64 = 2;

/// `adb_shell_read` 一次最多回多少行（与 `log_tail` 的 1..=2000 同一口径）
pub const MAX_ADB_READ_LINES: u64 = 2000;

/// 终端尺寸的闸门：`2..=max`。0/1 与超上限都在**碰界面之前**报 `-32602`。
fn check_adb_dim(key: &str, v: u64, max: u64) -> Result<(), RpcError> {
    if !(MIN_ADB_DIM..=max).contains(&v) {
        return Err(RpcError::new(
            E_INVALID_PARAMS,
            format!(
                "{} 只能是 {}~{}（收到 {}）—— 面板自己算尺寸时的下限也是 {}，\
                 比它小的值会让远端 shell 的布局崩掉。",
                key, MIN_ADB_DIM, max, v, MIN_ADB_DIM
            ),
        ));
    }
    Ok(())
}

/// 实际暴露的工具列表 = 内置工具 + （可选的）全量控件工具。
/// `tools/list`、`mcp_status.toolCount`、客户端的配置提示词都用它，保证三处一致。
pub fn exposed_tools(core: &McpCore) -> Vec<Value> {
    let mut v = tool_defs();
    let cfg = core.cfg.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if cfg.expose.auto_control_tools && !core.registry.is_empty() {
        // 这一段是**由前端上报的注册表**生成工具定义（名字清洗/去重/截断），
        // 也就是"外部数据进到我们自己的生成逻辑里"。它跑在应答 `tools/list` 的那条任务上，
        // 一旦 panic 就会把这条连接打死（AGENTS #2 / #10：MCP 绝不能被一次异常拖垮）。
        // 用 report::guard 兜住：出问题时**只给内置工具**并上报，而不是静默死掉。
        let built = super::report::guard("exposed_tools.registry", std::panic::AssertUnwindSafe(|| {
            core.registry.tools(&cfg.expose.namespaces, 0, MAX_CTL_TOOLS)
        }));
        match built {
            Ok((tools, _, _)) => v.extend(tools),
            Err(e) => {
                // 已经在 guard 里上报过一次；这里再写一条本地日志，便于对着界面排查
                eprintln!("[mcp] 生成控件工具定义失败，本次只暴露内置工具: {}", e);
            }
        }
    }
    v
}

/// 取一个必填的非空字符串参数
fn require_str(args: &Value, key: &str) -> Result<String, RpcError> {
    args.get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| RpcError::new(E_INVALID_PARAMS, format!("缺少 {} 参数（需非空字符串）", key)))
}

fn opt_u64(args: &Value, key: &str) -> Option<u64> {
    args.get(key).and_then(|v| v.as_u64())
}

/// 取一个必填的整数参数（缺失 / 不是非负整数 → `-32602`，让调用方改参数重试）
fn require_u64(args: &Value, key: &str) -> Result<u64, RpcError> {
    args.get(key)
        .and_then(|v| v.as_u64())
        .ok_or_else(|| RpcError::new(E_INVALID_PARAMS, format!("缺少 {} 参数（需非负整数）", key)))
}

fn opt_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn opt_bool(args: &Value, key: &str, default: bool) -> bool {
    args.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
}

/// 取一个参数，**同时接受驼峰与蛇形两种拼写**（驼峰优先）。
///
/// 为什么需要：MCP 对外一律 camelCase（与其余工具一致），但有四个参数历史上写成了蛇形
/// （`since_seq` / `case_sensitive` / `max_lines_per_channel` / `ok_only`）。
/// **直接改名比不改名更危险**：多传/错拼的键会被静默忽略，AI 会拿到一个"看起来正常、
/// 语义却不对"的结果（比如以为做了增量拉取，其实拉的是尾部 N 行）。所以新名字为准，
/// 旧拼写继续认 —— 两边都不会静默失效。
fn opt_alias<'a>(args: &'a Value, camel: &str, snake: &str) -> Option<&'a Value> {
    args.get(camel).or_else(|| args.get(snake))
}

fn opt_u64_alias(args: &Value, camel: &str, snake: &str) -> Option<u64> {
    opt_alias(args, camel, snake).and_then(|v| v.as_u64())
}

fn opt_bool_alias(args: &Value, camel: &str, snake: &str, default: bool) -> bool {
    opt_alias(args, camel, snake)
        .and_then(|v| v.as_bool())
        .unwrap_or(default)
}

/// 执行一个工具。参数是 MCP 传来的 `arguments` 对象。
///
/// 注意：这里的工具都必须是**非阻塞**或自身已 `spawn_blocking` 的；
/// 后续接入 `open_port` 一类会阻塞的命令时，一律走 `spawn_blocking` + 超时（§4.7 铁律 2）。
pub async fn call_tool(core: &Arc<McpCore>, name: &str, args: &Value) -> Result<Value, RpcError> {
    // 只读（沙箱）模式：**在碰任何东西之前**拦下写操作。
    // 这里刻意放在最前面（连计数器/日志都不写之前就返回错误）——"一个字都没改"要包括
    // "没去动界面、没去动串口、没去写配置文件"，而不是"改完再回滚"。
    if core.read_only() && is_write_call(name, args) {
        return Err(RpcError::new(
            E_POLICY_DENIED,
            format!(
                "只读模式（沙箱）已开启：「{}」这次调用**没有执行**，界面与配置一个字都没改。\
                 这不是参数问题，改参数重试也没用 —— 要么只做只读操作（如 serial_get_state / ui_get / log_tail），\
                 要么请用户在弹窗里关掉「只读模式」。",
                name
            ),
        ));
    }
    // 危险动作的二次确认（设计 §9）：**放在只读门之后** —— 只读模式下连确认也不给过
    // （先返回 -32007"策略拒绝"，比"你没确认"更准确：确认了也没用）。
    if let Some(note) = danger_note(name) {
        let confirmed = args.get("confirm").and_then(|v| v.as_bool()).unwrap_or(false);
        if !confirmed {
            return Err(RpcError::new(
                E_DEVICE_NOT_READY,
                format!(
                    "「{}」是危险动作：{}。\n这一步**没有执行**。确认要这么做就带 confirm:true 再调一次\
                     （例如 {{\"confirm\": true}}）；不想做就别重试 —— 改参数重试没用。",
                    name, note
                ),
            ));
        }
    }
    {
        let mut calls = core.tool_calls.lock().unwrap_or_else(|e| e.into_inner());
        *calls.entry(name.to_string()).or_insert(0) += 1;
    }
    // 记进日志中心的 mcp 通道：AI 能回看自己做过什么
    super::loghub::hub().push(
        "mcp",
        super::loghub::LEVEL_INFO,
        super::loghub::DIR_NONE,
        &format!("工具调用 {}", name),
        0,
    );
    match name {
        // 仅供测试：验证 panic 兜底真的把 panic 变成一个 JSON-RPC 错误（而不是把连接打死）。
        // 故意不出现在 tool_defs() 里 —— 真实客户端看不到它，也就调不到。
        #[cfg(test)]
        "test_panic" => panic!("故意的 panic（用于验证 handle_raw_guarded）"),
        "app_info" => Ok(json!({
            "name": SERVER_NAME,
            "version": env!("CARGO_PKG_VERSION"),
            "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "pid": std::process::id(),
            "uptimeSecs": core.uptime_secs(),
        })),
        // 给 AI 的是**打码版**：它本来就带着 token 连上来的，没必要把凭证回显进对话记录
        "mcp_status" => Ok(core.status_json_public()),
        "mcp_limits" => Ok(limits_json()),
        "serial_list_ports" => {
            let ports = crate::list_ports().await;
            // ⚠️ 字段名在**这里**转成 camelCase，而不是去改 `PortInfo`：
            // 那个结构同时被前端用（`index.html` 里 6 处 `p.port_name` / `friendly_name` /
            // `product_name`），给它加 `rename_all` 会把界面弄坏。
            // 工具的对外契约由工具自己负责 —— 而 MCP 的对外字段一律 camelCase。
            let items: Vec<Value> = ports
                .iter()
                .map(|p| {
                    json!({
                        "portName": p.port_name,
                        "friendlyName": p.friendly_name,
                        "productName": p.product_name,
                    })
                })
                .collect();
            // **必须是对象**：MCP 规范要求 `structuredContent` 是 object，给数组会被
            // 严格客户端整条拒收 —— 官方 Python SDK 就是 pydantic 校验直接报
            // `Input should be a valid dictionary`，`serial_list_ports` 这个工具
            // 在标准客户端里等于废的（2026-09 由独立一致性检查发现，148 条单测没抓到）。
            Ok(json!({
                "count": items.len(),
                "ports": items,
            }))
        }
        // ===== 串口语义工具（S12）=====
        // 校验在后端做（报文级），真正的取控件与"改/点"在前端，走的还是 ui_set/ui_click 那条路。
        "serial_get_state" => serial_call(core, "state", args, json!({})).await,
        "serial_select_port" => {
            let port = require_str(args, "port")?;
            serial_apply(core, args, json!([{ "name": "port", "value": port }])).await
        }
        "serial_set_baud" => {
            let baud = args
                .get("baud")
                .and_then(|v| v.as_u64())
                .ok_or_else(|| RpcError::new(E_INVALID_PARAMS, "baud 必须是整数（110..4000000）"))?;
            if !(110..=4_000_000).contains(&baud) {
                return Err(RpcError::new(
                    E_INVALID_PARAMS,
                    format!("波特率 {} 超出范围（110..4000000）", baud),
                ));
            }
            serial_apply(core, args, json!([{ "name": "baud", "value": baud }])).await
        }
        "serial_set_frame" => {
            let mut items: Vec<Value> = Vec::new();
            for k in ["dataBits", "stopBits", "parity"] {
                if let Some(v) = args.get(k) {
                    items.push(json!({ "name": k, "value": v }));
                }
            }
            if items.is_empty() {
                return Err(RpcError::new(
                    E_INVALID_PARAMS,
                    "至少要给一个：dataBits / stopBits / parity",
                ));
            }
            serial_apply(core, args, json!(items)).await
        }
        "serial_set_lines" => {
            let mut items: Vec<Value> = Vec::new();
            for k in ["dtr", "rts"] {
                if let Some(v) = args.get(k) {
                    if !v.is_boolean() {
                        return Err(RpcError::new(E_INVALID_PARAMS, format!("{} 必须是布尔值", k)));
                    }
                    items.push(json!({ "name": k, "value": v }));
                }
            }
            if items.is_empty() {
                return Err(RpcError::new(E_INVALID_PARAMS, "至少要给一个：dtr / rts"));
            }
            serial_apply(core, args, json!(items)).await
        }
        "serial_set_display" => {
            // ⚠️ 这份名单必须覆盖 `serial_get_state` 报出来的**每一个开关**：
            // "报得出来的开关就该设得了"。`advOpen`（更多设置栏是否展开）曾经只报不设 ——
            // 真机实测：状态里 `advOpen: true`，但设它会回「至少要给一个：…」，
            // 因为那个错误信息本身就是旧名单（连提示都没提到它）。
            let mut items: Vec<Value> = Vec::new();
            for k in [
                "viewMode", "lineEnding", "echo", "lineNum", "timestamp",
                "autoScroll", "autoReconnect", "terminalMode", "advOpen",
            ] {
                if let Some(v) = args.get(k) {
                    items.push(json!({ "name": k, "value": v }));
                }
            }
            if items.is_empty() {
                return Err(RpcError::new(
                    E_INVALID_PARAMS,
                    "至少要给一个：viewMode / lineEnding / echo / lineNum / timestamp / autoScroll / autoReconnect / terminalMode / advOpen",
                ));
            }
            serial_apply(core, args, json!(items)).await
        }
        "serial_open" => {
            // 一个串口都没有就别去点按钮：否则要白等 6 秒轮询超时（Agent 还可能再试一次）
            //
            // ⚠️ 但这个判据只对 **Windows 分栏**成立：WSL 分栏要开的是 WSL 侧的设备
            // （前端那颗按钮走 `toggleWslConnection` → `open_wsl_serial`），跟本机有没有 COM 口无关。
            // 而"Windows 侧没有 COM 口"恰恰是 WSL 用户的常态 —— 把 USB 串口用 usbipd bind 进 WSL
            // 之后，Windows 就看不到那个口了。以前一律拿 `list_ports` 判定，于是 AI 操作 WSL 分栏
            // 会得到"本机没有可用串口"（-32006），而界面上点得通 —— 工具说不行、界面说行。
            // 工具仍然只有这一套（`serial_*` + pane），只是**取数据的来源按分栏分**。
            if !pane_is_wsl(args) {
                let ports = crate::list_ports().await;
                if let Some(msg) = no_serial_port_hint(ports.len()) {
                    return Err(RpcError::new(E_DEVICE_NOT_READY, msg));
                }
            }
            // 先落可选的 port/baud（不合法会被 apply 那套挡住并回列可选值）
            let mut pre: Vec<Value> = Vec::new();
            if let Some(p) = args.get("port") {
                pre.push(json!({ "name": "port", "value": p }));
            }
            if let Some(b) = args.get("baud") {
                pre.push(json!({ "name": "baud", "value": b }));
            }
            if !pre.is_empty() {
                serial_apply(core, args, json!(pre)).await?;
            }
            serial_set_connected(core, args, true).await
        }
        "serial_close" => serial_set_connected(core, args, false).await,
        "serial_send" => {
            let data = require_str(args, "data")?;
            // 单次发送量上限：串口写是排队的，一次灌几百 KB 会长时间压住写队列，
            // 直接干扰用户自己的串口会话（详见 MAX_SEND_CHARS 的注释）。
            if data.chars().count() > MAX_SEND_CHARS {
                return Err(RpcError::new(
                    E_INVALID_PARAMS,
                    format!(
                        "单次最多发 {} 个字符（收到 {} 个）。请分批发送。",
                        MAX_SEND_CHARS,
                        data.chars().count()
                    ),
                ));
            }
            // mode / lineEnding 给了就先落到界面（与用户在界面上改是同一条路）
            let mut pre: Vec<Value> = Vec::new();
            if let Some(m) = opt_str(args, "mode") {
                let m = m.to_ascii_lowercase();
                if m != "text" && m != "hex" {
                    return Err(RpcError::new(E_INVALID_PARAMS, "mode 只能是 text 或 hex"));
                }
                pre.push(json!({ "name": "sendAs", "value": m }));
            }
            if let Some(le) = opt_str(args, "lineEnding") {
                pre.push(json!({ "name": "lineEnding", "value": le }));
            }
            if !pre.is_empty() {
                // sendAs 不在"字段表"里（它是发送栏那个自定义控件），单独走一次点击式设置
                for item in &pre {
                    if item["name"] == "sendAs" {
                        let mode = item["value"].as_str().unwrap_or("text");
                        let mut p = json!({ "action": "setSendAs", "mode": mode });
                        if let Some(pane) = opt_str(args, "pane") {
                            p["pane"] = json!(pane);
                        }
                        core.ui_call("serial", p).await?;
                    } else {
                        serial_apply(core, args, json!([item.clone()])).await?;
                    }
                }
            }
            serial_call(core, "send", args, json!({ "data": data })).await
        }
        "serial_clear" => serial_call(core, "clear", args, json!({})).await,
        "serial_get_history" => {
            serial_call(core, "history", args, json!({ "limit": args.get("limit").cloned().unwrap_or(json!(20)) })).await
        }
        // 读"设备刚才回了什么"。**不新增存储**：读的就是日志中心的 serial:<分栏>:rx|tx
        // （AGENTS.md #6：同一份内容只在生产端旁路一份，别重复存）。
        // 为什么还要一个专门工具：`log_tail` 要求调用方先知道通道名，而通道名是拼出来的
        // （serial:main:rx），没数据流过时通道**还不存在** → log_tail 直接报"没有这个通道"，
        // 于是 AI 会得出"不支持读串口数据"这种错结论，而事实只是"还没收到数据"。
        "serial_get_output" => serial_get_output(core, args).await,
        "serial_quick_cmd" => {
            // `action` 走"改列表/开关循环"，不带 action 时：给了 index = 执行那一条，
            // 什么都没给 = 只列举。每个 action 都映射到前端**用户点按钮走的那条路**。
            match args.get("action").and_then(|a| a.as_str()) {
                Some("loop") => {
                    let on = args.get("on").cloned().unwrap_or(json!(true));
                    serial_call(core, "quickLoop", args, json!({ "on": on })).await
                }
                Some("add") => {
                    check_text_len(args, "value", MAX_QUICK_CMD_VALUE_CHARS, "指令内容")?;
                    check_quick_cmd_item_params(args)?;
                    // 条数上限由**前端**把关（列表归它所有）：满了会回一条明确的失败，
                    // 后端翻成 -32006「先做前置操作（删几条）」。这里不做前置探测 ——
                    // 多问一次列表既多一个来回、又挡不住并发。
                    let extra = quick_cmd_item_payload(args);
                    serial_call(core, "quickAdd", args, extra).await
                }
                Some("update") => {
                    check_text_len(args, "value", MAX_QUICK_CMD_VALUE_CHARS, "指令内容")?;
                    check_quick_cmd_item_params(args)?;
                    let extra = quick_cmd_item_payload(args);
                    serial_call(core, "quickUpdate", args, extra).await
                }
                Some("remove") => serial_call(core, "quickRemove", args, json!({})).await,
                Some("group") => {
                    check_text_len(args, "name", MAX_QUICK_CMD_LABEL_CHARS, "组名")?;
                    serial_call(core, "quickGroup", args, json!({})).await
                }
                Some(other) => Err(RpcError::new(E_INVALID_PARAMS, format!(
                    "不认识的 action「{other}」：可用 loop / add / update / remove / group；\
                     想执行某一条就传 index，想列出来就两个都不传"
                ))),
                None => match args.get("index") {
                    Some(i) => serial_call(core, "quickRun", args, json!({ "index": i })).await,
                    None => serial_call(core, "quickList", args, json!({})).await,
                },
            }
        }
        // ===== 工作流规则（前端 `mcpSerialOp` 的 wf* 动作）=====
        "serial_workflow" => {
            let act = args.get("action").and_then(|a| a.as_str()).unwrap_or("list");
            match act {
                "list" => serial_call(core, "wfList", args, json!({})).await,
                "add" | "update" | "remove" => {
                    // `rule` 只有 update/remove 需要（add 时前端会造一条新的）
                    if act != "add" && args.get("rule").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
                        return Err(RpcError::new(E_INVALID_PARAMS,
                            format!("action={act} 要带 rule：规则 id 见 serial_workflow 的 rules[].id")));
                    }
                    check_workflow_args(args)?;
                    let extra = workflow_payload(args);
                    let op = match act { "add" => "wfAdd", "update" => "wfUpdate", _ => "wfRemove" };
                    serial_call(core, op, args, extra).await
                }
                other => Err(RpcError::new(E_INVALID_PARAMS, format!(
                    "不认识的 action「{other}」：可用 list / add / update / remove\
                     （想启停规则请用 serial_workflow_run）"
                ))),
            }
        }
        "serial_workflow_run" => {
            let rule = require_str(args, "rule")?;
            serial_call(core, "wfToggle", args, json!({ "rule": rule, "on": args.get("on").cloned().unwrap_or(json!(true)) })).await
        }
        // ===== BLE 语义工具（前端 mcpBleOp；与 serial_* 同构）=====
        "ble_get_state" => ble_call(core, "state", args, json!({})).await,
        "ble_list_devices" => {
            // limit / offset **必须真的放进 payload**（batch 4 的教训：只校验不转发 = 前端收不到）
            let mut extra = json!({});
            if let Some(lim) = opt_u64(args, "limit") {
                check_page_limit(lim)?;
                extra["limit"] = json!(lim);
            }
            if let Some(off) = opt_u64(args, "offset") {
                extra["offset"] = json!(off);
            }
            ble_call(core, "listDevices", args, extra).await
        }
        "ble_start_scan" => ble_call(core, "startScan", args, json!({})).await,
        "ble_stop_scan" => ble_call(core, "stopScan", args, json!({})).await,
        // 必填入参**在碰界面之前**校验（AGENTS #10：校验要先于"碰主程序"，
        // 缺参要报 -32602「改参数重试」而不是拖到最后变成 -32006「没有界面」）。
        // ⚠️ `ble_call` 只把 `pane` 转进 payload，所以**要用的字段必须显式放进 extra** ——
        // 光过校验不算数，不放进 payload 等于前端永远收不到它（batch 4 就这么漏过一次）。
        "ble_read" => {
            let ch = require_str(args, "char")?;
            ble_call(core, "read", args, json!({ "char": ch })).await
        }
        "ble_subscribe" => {
            let ch = require_str(args, "char")?;
            let mut extra = json!({ "char": ch });
            if let Some(on) = args.get("on").and_then(|v| v.as_bool()) {
                extra["on"] = json!(on);
            }
            ble_call(core, "subscribe", args, extra).await
        }
        "ble_connect" => {
            let mut extra = json!({});
            if let Some(a) = opt_str(args, "addr") {
                extra["addr"] = json!(a.to_uppercase());
            }
            ble_call(core, "connect", args, extra).await
        }
        "ble_disconnect" => ble_call(core, "disconnect", args, json!({})).await,
        "ble_write" => {
            let ch = require_str(args, "char")?;
            let data = require_str(args, "data")?;
            // 单次写入量上限：BLE 单次写最多 MTU-3 字节（典型 20~512），这里留足余量但仍必须有界
            // —— 1 MiB 的请求体足够塞进几十万字符，那条链路会先卡在 WebView 上。
            if data.chars().count() > MAX_BLE_WRITE_CHARS {
                return Err(RpcError::new(
                    E_INVALID_PARAMS,
                    format!(
                        "单次最多写 {} 个字符（收到 {} 个）。BLE 单次写受 MTU 限制，长数据请分段。",
                        MAX_BLE_WRITE_CHARS,
                        data.chars().count()
                    ),
                ));
            }
            let mut extra = json!({ "char": ch, "data": data });
            if let Some(f) = opt_str(args, "format") {
                let f = f.to_ascii_lowercase();
                if f != "text" && f != "hex" {
                    return Err(RpcError::new(E_INVALID_PARAMS, "format 只能是 text 或 hex"));
                }
                extra["format"] = json!(f);
            }
            if let Some(le) = opt_str(args, "lineEnding") {
                let le = le.to_ascii_lowercase();
                if !matches!(le.as_str(), "none" | "cr" | "lf" | "crlf") {
                    return Err(RpcError::new(
                        E_INVALID_PARAMS,
                        "lineEnding 只能是 none / cr / lf / crlf",
                    ));
                }
                extra["lineEnding"] = json!(le);
            }
            if let Some(wt) = opt_str(args, "writeType") {
                let wt = wt.to_ascii_lowercase();
                if wt != "write" && wt != "write_without_response" {
                    return Err(RpcError::new(
                        E_INVALID_PARAMS,
                        "writeType 只能是 write 或 write_without_response",
                    ));
                }
                extra["writeType"] = json!(wt);
            }
            ble_call(core, "write", args, extra).await
        }
        "ble_get_output" => ble_get_output(core, args).await,
        "ble_refresh_rssi" => ble_call(core, "refreshRssi", args, json!({})).await,
        "ble_get_services" => ble_call(core, "getServices", args, json!({})).await,
        // BLE 从机三个工具已删除（理由见 `tool_defs()` 那段注释）。这里同样专门留一条分支
        // 指路，而不是掉进"未知工具"：工具定义编译在 exe 里，客户端要重连才会重读 tools/list。
        "ble_periph_status" | "ble_periph_start" | "ble_periph_stop" => Err(RpcError::new(
            E_INVALID_PARAMS,
            "ble_periph_status / ble_periph_start / ble_periph_stop 已删除：\
             BLE **从机（对外广播）**方向做不出来 —— 本机适配器自报支持外设角色，\
             但实测广播起不来（Aborted），所以整条方向下线了。本应用现在的 BLE 能力是**主机方向**：\
             ble_start_scan / ble_list_devices / ble_connect（含按 MAC 直连）/ ble_get_services / \
             ble_read / ble_write / ble_subscribe / ble_get_output。"
                .to_string(),
        )),
        // ===== ADB 语义工具（前端 mcpAdbOp；与 serial_*/ble_* 同构）=====
        "adb_list_devices" => adb_call(core, "listDevices", json!({})).await,
        "adb_open_shell" => {
            // serial 省略 = 前端用"第一台 state=device 的设备"（它自己会先问 adb_devices 确认）
            let mut extra = json!({});
            if let Some(s) = opt_str(args, "serial") {
                extra["serial"] = json!(s);
            }
            adb_call(core, "openShell", extra).await
        }
        "adb_shell_write" => {
            let data = require_str(args, "data")?;
            // 长度闸门在**碰界面之前**（AGENTS #10）：没界面时超长入参也必须先拿到 -32602
            // （"改参数重试"），而不是含糊的 -32006（"没有界面"）。边界值正好等于上限要放行。
            if data.chars().count() > MAX_ADB_WRITE_CHARS {
                return Err(RpcError::new(
                    E_INVALID_PARAMS,
                    format!(
                        "单次最多写 {} 个字符（收到 {} 个）。ADB 那一头是设备的 shell，\
                         要灌大块数据请用面板外的 adb push，或拆成多条命令。",
                        MAX_ADB_WRITE_CHARS,
                        data.chars().count()
                    ),
                ));
            }
            adb_call(core, "shellWrite", json!({ "data": data })).await
        }
        // 纯后端：读日志中心的 adb:rx（**不去 drain 面板轮询的那个 crossbeam 队列**，
        // 见 adb_shell_read 的注释），所以没有界面时也能用。
        "adb_shell_read" => adb_shell_read(core, args),
        "adb_shell_resize" => {
            let cols = require_u64(args, "cols")?;
            let rows = require_u64(args, "rows")?;
            check_adb_dim("cols", cols, MAX_ADB_COLS)?;
            check_adb_dim("rows", rows, MAX_ADB_ROWS)?;
            adb_call(core, "shellResize", json!({ "cols": cols, "rows": rows })).await
        }
        "adb_close_shell" => adb_call(core, "closeShell", json!({})).await,
        "mcp_danger" => Ok(json!({
            "tools": DANGER_TOOLS
                .iter()
                .map(|(n, why)| json!({ "name": n, "consequence": why, "confirm": "调用时必须带 confirm:true" }))
                .collect::<Vec<_>>(),
            "total": DANGER_TOOLS.len(),
            "note": "没带 confirm 时这些工具**不会执行**，会返回 -32006 并说明后果；\
                     普通工具不需要 confirm（传了也会被忽略）。",
        })),
        // ===== 界面桥：全部经 core.ui_call → 前端执行 → 回执 =====
        "ui_list" => core.ui_call("list", args.clone()).await,
        "ui_describe" => {
            let path = require_str(args, "path")?;
            core.ui_call("describe", json!({ "path": path })).await
        }
        "ui_get" => {
            let path = require_str(args, "path")?;
            core.ui_call("get", json!({ "path": path })).await
        }
        "ui_set" => {
            let payload = match args.get("items") {
                Some(items) if items.is_array() => {
                    // 上限校验必须在**下发到界面之前**：这条链路最终跑在 WebView 主线程上，
                    // 放两万条进去就是把界面冻住（详见 MAX_UI_SET_ITEMS 的注释）。
                    let n = items.as_array().map(|a| a.len()).unwrap_or(0);
                    if n > MAX_UI_SET_ITEMS {
                        return Err(RpcError::new(
                            E_INVALID_PARAMS,
                            format!(
                                "items 一次最多 {} 个（收到 {} 个）。请分批调用 —— 这条链路跑在界面主线程上，一次给太多会把界面卡住。",
                                MAX_UI_SET_ITEMS, n
                            ),
                        ));
                    }
                    // 单条 value 的长度同样要有界：只挡条数挡不住"一条巨型字符串"
                    // （写进输入框的是 WebView 主线程，见 MAX_UI_SET_VALUE_CHARS 的注释）
                    for it in items.as_array().into_iter().flatten() {
                        check_text_len(it, "value", MAX_UI_SET_VALUE_CHARS, "ui_set 的 value")?;
                    }
                    json!({ "items": items })
                }
                Some(_) => {
                    return Err(RpcError::new(E_INVALID_PARAMS, "items 必须是数组"));
                }
                None => {
                    let path = require_str(args, "path")?;
                    json!({ "path": path, "value": args.get("value").cloned().unwrap_or(Value::Null) })
                }
            };
            core.ui_call("set", payload).await
        }
        "ui_click" => {
            let path = require_str(args, "path")?;
            core.ui_call("click", json!({ "path": path })).await
        }
        "ui_get_state" => {
            let section = opt_str(args, "section");
            let mut payload = json!({ "section": section });
            // `section:"bleDevices"` 时这两个才起作用，但**必须转发**：不转发 = 前端收不到，
            // 分页就静默失效（真机上第一次就踩到了：通用桥 offset=15 却回了全量 47 台）。
            if let Some(lim) = opt_u64(args, "limit") {
                check_page_limit(lim)?;
                payload["limit"] = json!(lim);
            }
            if let Some(off) = opt_u64(args, "offset") {
                payload["offset"] = json!(off);
            }
            core.ui_call("getState", payload).await
        }
        // ===== 全量控件工具（S6）：一个控件一个工具，走同一条界面桥 =====
        n if n.starts_with("ctl_") => match core.registry.path_for_tool(n) {
            Some(path) => {
                // 按钮/开关省略 value 时按"点击"处理
                let value = args
                    .get("value")
                    .cloned()
                    .unwrap_or(Value::Bool(true));
                core.ui_call("set", json!({ "path": path, "value": value })).await
            }
            None => Err(RpcError::new(
                E_INVALID_PARAMS,
                format!(
                    "没有这个控件工具: {}（界面可能已经变了；先用 ui_list 或 tools/list 重新看有哪些）",
                    n
                ),
            )),
        },
        // ===== 日志中心（S7）：纯后端，不需要界面，所以没有 GUI 时也能用 =====
        "log_channels" => Ok(super::loghub::hub().channels()),
        "log_tail" => {
            let channel = require_str(args, "channel")?;
            let lines = opt_u64(args, "lines").unwrap_or(100) as usize;
            let fmt = log_format_arg(args)?;
            super::loghub::hub()
                .tail_fmt(&channel, opt_u64_alias(args, "sinceSeq", "since_seq"), lines, fmt)
                .map_err(|e| RpcError::new(E_INVALID_PARAMS, e))
        }
        "log_search" => {
            // `require_str` 已经拒了空串 —— 这里必须拒的理由不只是"参数没意义"：
            // 子串模式会先 `regex::escape`，空图案转义后是"匹配每一行"的正则，
            // `count` 还会给出每行都中（含行尾空匹配）的假数字。
            let pattern = require_str(args, "pattern")?;
            check_search_pattern(args)?;
            let ch = opt_str(args, "channel");
            let mode = search_mode_arg(args)?;
            let context = opt_u64(args, "context").unwrap_or(0) as usize;
            // 上下文只对"回命中行"那一档有意义：另两档根本不知道命中在哪一行上。
            // 静默忽略会比报错更糟 —— 调用方会以为上下文已经给了
            if context > 0 && mode != super::loghub::SearchMode::Lines {
                return Err(RpcError::new(
                    E_INVALID_PARAMS,
                    format!(
                        "context 只对 mode:\"lines\" 有意义（当前 mode={}）；要么改成 lines，要么先 matches 定位再用 log_tail 看上下文",
                        mode.as_str()
                    ),
                ));
            }
            if context > super::loghub::MAX_SEARCH_CONTEXT {
                return Err(RpcError::new(
                    E_INVALID_PARAMS,
                    format!(
                        "context 最大 {} 行（收到 {}）",
                        super::loghub::MAX_SEARCH_CONTEXT,
                        context
                    ),
                ));
            }
            super::loghub::hub()
                .search_with(super::loghub::SearchOpts {
                    channel: ch.as_deref(),
                    pattern: &pattern,
                    use_regex: opt_bool(args, "regex", false),
                    case_sensitive: opt_bool_alias(args, "caseSensitive", "case_sensitive", false),
                    limit: opt_u64(args, "limit").unwrap_or(100) as usize,
                    mode,
                    context,
                })
                .map_err(|e| RpcError::new(E_INVALID_PARAMS, e))
        }
        "log_stats" => Ok(super::loghub::hub().stats()),
        "log_clear" => {
            let ch = opt_str(args, "channel");
            // 给了通道名但它不存在就报错，**不要**当"没什么可清的"静默返回 0：
            // 通道名打错一个字（`ui:sys ` 带个空格）时会返回 clearedChannels:0，
            // 调用方以为清干净了 —— 而 `log_tail` 对同样的输入是报错的，两者不一致。
            // （2026-09 由独立一致性检查发现：同一个错通道名，log_tail 报 -32602、log_clear 报成功。）
            if let Some(name) = ch.as_deref() {
                let exists = super::loghub::hub().channels()["channels"]
                    .as_array()
                    .map(|a| a.iter().any(|c| c["channel"].as_str() == Some(name)))
                    .unwrap_or(false);
                if !exists {
                    return Err(RpcError::new(
                        E_INVALID_PARAMS,
                        format!("没有这个通道: {}（先用 log_channels 看有哪些）", name),
                    ));
                }
            }
            let n = super::loghub::hub().clear(ch.as_deref());
            Ok(json!({ "clearedChannels": n, "channel": ch }))
        }
        // `log_export` 已删除（理由见 `tool_defs()` 里那段注释）。
        // ⚠️ 这里专门留一条分支而不是让它掉进"未知工具"：工具定义**编译在 exe 里**，
        // 客户端配置里很可能还留着旧工具名（要重连才会刷新 tools/list），
        // 只回"未知工具: log_export"会让 AI 反复试同一个名字。
        // 所以直接告诉它"为什么没了 + 现在该用什么"。
        "log_export" => Err(RpcError::new(
            E_INVALID_PARAMS,
            "log_export 已删除：它是唯一能把全部通道的日志一次塞进返回体的工具，\
             而返回体没有大小上限（省略 channels 时一次可能几十 MB，撑爆上下文、客户端也会解析打摆）。\
             要读日志用 log_tail{format:\"text\"}（配合 sinceSeq 增量跟进）或 serial_get_output{format:\"text\"}；\
             只想知道\"出现几次\"用 log_search{mode:\"count\"}。",
        )),
        // ===== AI 调用记录与配置（S8）=====
        "mcp_calls" => {
            let limit = opt_u64(args, "limit").unwrap_or(50) as usize;
            let tool = opt_str(args, "tool");
            let ok_only = opt_alias(args, "okOnly", "ok_only").and_then(|v| v.as_bool());
            let format = opt_str(args, "format").unwrap_or_else(|| "jsonl".to_string());
            if format == "md" {
                Ok(core.calllog.export(&format, limit))
            } else {
                Ok(core.calllog.recent(limit, tool.as_deref(), ok_only))
            }
        }
        "mcp_stats" => {
            let calls: serde_json::Map<String, Value> = core
                .tool_calls
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .iter()
                .map(|(k, v)| (k.clone(), json!(*v)))
                .collect();
            Ok(json!({
                "callLog": core.calllog.stats(),
                "sessionToolCalls": calls,
            }))
        }
        "mcp_config_get" => {
            let cfg = core.cfg.lock().unwrap_or_else(|e| e.into_inner()).clone();
            Ok(super::config_summary(&cfg))
        }
        "mcp_config_set" => {
            let patch = args
                .get("patch")
                .cloned()
                .ok_or_else(|| RpcError::new(E_INVALID_PARAMS, "缺少 patch 参数（对象）"))?;
            // 配置非法 → 参数问题（协议级）；写盘失败 → 执行失败（isError）
            super::apply_config_patch(core, &patch)
                .map_err(|e| RpcError::new(E_INVALID_PARAMS, e))
        }
        other => Err(RpcError::new(
            // 规范把「未知工具」归到 -32602 Invalid params；
            // -32601 Method not found 留给未知的 JSON-RPC 方法（如 tools/nope）。
            E_INVALID_PARAMS,
            format!("未知工具: {}", other),
        )),
    }
}

/// 硬性上限（单一来源，便于审计；`doc/MCP_DESIGN.md` §4.8）
///
/// 快速指令外部文件的相关上限（值必须与前端 `QCMD_FILE_*`、`main.rs` 的
/// `QUICK_CMD_FILE_MAX_BYTES` 一致 —— 断言集里有跨端一致性检查守着）。
pub const MAX_QUICK_CMD_ITEMS: usize = 500;
pub const MAX_QUICK_CMD_LABEL_CHARS: usize = 64;
pub const MAX_QUICK_CMD_VALUE_CHARS: usize = 4096;
pub const MAX_QUICK_CMD_FILE_BYTES: u64 = 256 * 1024;
/// 每条指令的等待参数（与前端 `QCMD_TIMEOUT_MAX` / `QCMD_RETRY_MAX` / `QCMD_EXPECT_MAX` 一致）
pub const MAX_QUICK_CMD_TIMEOUT_MS: u64 = 600_000;
pub const MAX_QUICK_CMD_RETRY: u64 = 10;
pub const MAX_QUICK_CMD_EXPECT_CHARS: usize = 64;

/// 工作流规则的上限（前端 `WF_*` 常量与它对齐；`mcp_limits` 里报出去，**并且真的被执行**）
pub const MAX_WORKFLOW_RULES: usize = 50;
pub const MAX_WORKFLOW_CONDITIONS: usize = 8;
pub const MAX_WORKFLOW_ACTIONS: usize = 8;
pub const MAX_WORKFLOW_NAME_CHARS: usize = 64;
pub const MAX_WORKFLOW_COND_VALUE_CHARS: usize = 512;
pub const MAX_WORKFLOW_ACTION_DATA_CHARS: usize = 4096;

/// 合法取值（前端下拉里给的也是这几个；这里**在碰界面之前**再拦一道）
const WF_COND_TYPES: &[&str] = &["string_contains", "regex", "exact_bytes"];
const WF_ACTION_TYPES: &[&str] = &["send_data", "toggle_dtr_rts", "save_log"];

/// `serial_workflow` / `serial_workflow_run` 的字段转发。
/// 与 `quick_cmd_item_payload` 同一条纪律：`serial_call` 只转发 `extra`，
/// 光校验不转发 = 前端永远收不到。
fn workflow_payload(args: &Value) -> Value {
    let mut p = json!({});
    for k in ["rule", "name", "enabled", "running", "conditions", "actions", "on"] {
        if let Some(v) = args.get(k) { p[k] = v.clone(); }
    }
    p
}

/// 工作流入参的范围与取值校验（碰界面之前；超范围/取值非法 = 请求的问题 → -32602）。
///
/// 为什么值得单独写一段：规则**一旦跑起来就会自动往设备发数据**，所以"条数/长度/类型"这三样
/// 都不能靠前端兜 —— 前端会截断，而截断意味着用户（或 AI）以为设好了、实际没设上。
fn check_workflow_args(args: &Value) -> Result<(), RpcError> {
    check_text_len(args, "name", MAX_WORKFLOW_NAME_CHARS, "规则名")?;
    // `running=true` 要走危险门那条工具 —— 在这里挡住，让 AI 一眼看到"你走错门了"
    if args.get("running").and_then(|v| v.as_bool()) == Some(true) {
        return Err(RpcError::new(E_INVALID_PARAMS,
            "这里不能把 running 设成 true：让规则跑起来要用 serial_workflow_run（它带 confirm 确认门）。\
             本工具只接受 running=false（停一条正在跑的规则）。".to_string()));
    }
    if let Some(cs) = args.get("conditions") {
        let arr = cs.as_array().ok_or_else(|| RpcError::new(
            E_INVALID_PARAMS, "conditions 要是数组：[{type, value}]".to_string()))?;
        if arr.is_empty() {
            return Err(RpcError::new(E_INVALID_PARAMS,
                "conditions 不能是空数组：一条条件都没有的规则永远不触发（要删规则请用 action=remove）".to_string()));
        }
        if arr.len() > MAX_WORKFLOW_CONDITIONS {
            return Err(RpcError::new(E_INVALID_PARAMS,
                format!("conditions 最多 {MAX_WORKFLOW_CONDITIONS} 条")));
        }
        for c in arr {
            let t = c.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if !WF_COND_TYPES.contains(&t) {
                return Err(RpcError::new(E_INVALID_PARAMS,
                    format!("条件 type「{t}」不认得：可用 {}", WF_COND_TYPES.join(" / "))));
            }
            if let Some(v) = c.get("value") {
                let s = v.as_str().unwrap_or("");
                if s.chars().count() > MAX_WORKFLOW_COND_VALUE_CHARS {
                    return Err(RpcError::new(E_INVALID_PARAMS,
                        format!("条件 value 最长 {MAX_WORKFLOW_COND_VALUE_CHARS} 字符")));
                }
            }
        }
    }
    if let Some(as_) = args.get("actions") {
        let arr = as_.as_array().ok_or_else(|| RpcError::new(
            E_INVALID_PARAMS, "actions 要是数组：[{type, data, …}]".to_string()))?;
        if arr.is_empty() {
            return Err(RpcError::new(E_INVALID_PARAMS,
                "actions 不能是空数组：这样的规则命中了也什么都不做".to_string()));
        }
        if arr.len() > MAX_WORKFLOW_ACTIONS {
            return Err(RpcError::new(E_INVALID_PARAMS,
                format!("actions 最多 {MAX_WORKFLOW_ACTIONS} 条")));
        }
        for a in arr {
            let t = a.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if !WF_ACTION_TYPES.contains(&t) {
                return Err(RpcError::new(E_INVALID_PARAMS,
                    format!("动作 type「{t}」不认得：可用 {}", WF_ACTION_TYPES.join(" / "))));
            }
            if let Some(v) = a.get("data") {
                let s = v.as_str().unwrap_or("");
                if s.chars().count() > MAX_WORKFLOW_ACTION_DATA_CHARS {
                    return Err(RpcError::new(E_INVALID_PARAMS,
                        format!("动作 data 最长 {MAX_WORKFLOW_ACTION_DATA_CHARS} 字符")));
                }
            }
        }
    }
    Ok(())
}

/// add/update 那几个"每条自己的参数"：**必须显式放进 payload**。
/// `serial_call` 只转发 `extra` —— 光校验不转发，前端就永远收不到（batch 4 这么漏过一次，
/// 表现是"工具回了 ok、参数却没生效"，比报错更坑）。
fn quick_cmd_item_payload(args: &Value) -> Value {
    let mut p = json!({});
    for k in ["value", "seq", "timeoutMs", "delayMs", "expect", "retry", "okGoto", "errGoto", "hex"] {
        if let Some(v) = args.get(k) { p[k] = v.clone(); }
    }
    p
}

/// 快速指令的等待参数范围校验。**发生在碰界面之前**（AGENTS #10）：
/// 超范围是"请求本身的问题" → -32602（改参数重试），而不是含糊的 -32006。
fn check_quick_cmd_item_params(args: &Value) -> Result<(), RpcError> {
    if let Some(v) = args.get("timeoutMs").or_else(|| args.get("delayMs")) {
        let n = v.as_u64().ok_or_else(|| RpcError::new(
            E_INVALID_PARAMS, "timeoutMs 要是 0 或正整数（毫秒；0 = 这条不等响应）".to_string()))?;
        if n > MAX_QUICK_CMD_TIMEOUT_MS {
            return Err(RpcError::new(E_INVALID_PARAMS, format!(
                "timeoutMs 超出上限 {MAX_QUICK_CMD_TIMEOUT_MS} 毫秒（10 分钟）")));
        }
    }
    if let Some(v) = args.get("retry") {
        let n = v.as_u64().ok_or_else(|| RpcError::new(
            E_INVALID_PARAMS, "retry 要是 0 或正整数（0 = 不重发）".to_string()))?;
        if n > MAX_QUICK_CMD_RETRY {
            return Err(RpcError::new(E_INVALID_PARAMS, format!(
                "retry 超出上限 {MAX_QUICK_CMD_RETRY}（再高就是\"设备一直报错、循环永远停不下来\"）")));
        }
    }
    check_text_len(args, "expect", MAX_QUICK_CMD_EXPECT_CHARS, "期望词")?;
    // 跳转两列：只认 留空 / `下一条` / `end`（结束）/ 顺序号（1..=9999）。
    // 别让"随便写点什么"进去 —— 前端会把它归一成"下一条"，那等于用户以为配了跳转、实际没配（静默失效）。
    for key in ["okGoto", "errGoto"] {
        if let Some(v) = args.get(key) {
            let s = v.as_str().ok_or_else(|| RpcError::new(
                E_INVALID_PARAMS,
                format!("{key} 要是字符串：留空/下一条 = 顺序走、数字 = 跳到的顺序号、结束 = 收尾")))?;
            let t = s.trim();
            if t.is_empty() { continue; }
            let low = t.to_lowercase();
            let is_end = matches!(low.as_str(), "end" | "stop" | "结束" | "终止");
            let is_next = matches!(low.as_str(), "next" | "-" | "下一条" | "继续");
            let is_seq = t.parse::<u32>().map(|n| n >= 1 && n <= 9999).unwrap_or(false);
            if !(is_end || is_next || is_seq) {
                return Err(RpcError::new(E_INVALID_PARAMS, format!(
                    "{key}「{t}」认不出来：只认 留空/下一条、数字 = 顺序号、结束")));
            }
        }
    }
    Ok(())
}

/// 某个字符串入参的长度闸门：超了报 `-32602`（**请求**的问题 → 改参数重试）。
///
/// 为什么要有它：`MAX_QUICK_CMD_*` 这三个常量一直在 `mcp_limits` 里报给客户端，
/// 却**从来没有被执行过**（2026-09 审计发现）—— 超长的指令内容会一路写到 WebView 主线程上的
/// 输入框里（与 `MAX_UI_SET_ITEMS` 同类问题），更糟的是写回文件时会撞上 256 KB 的文件上限：
/// 工具已经回了 ok，改动却没落盘（前端只弹一个 toast，调用方完全不知道）。
///
/// 校验发生在**碰界面之前**（AGENTS #10 的硬要求）：没界面时超长入参也必须先得到 -32602，
/// 而不是含糊的"没有界面"。
fn check_text_len(args: &Value, key: &str, max: usize, what: &str) -> Result<(), RpcError> {
    let Some(v) = args.get(key) else { return Ok(()) };
    // 非字符串（数字/布尔/数组）交给后端与前端各自按原样处理，这里只管字符串长度
    let Some(s) = v.as_str() else { return Ok(()) };
    let n = s.chars().count();
    if n > max {
        return Err(RpcError::new(
            E_INVALID_PARAMS,
            format!(
                "{what}太长：{n} 个字符，上限 {max} 个。外部文件也按这个上限读回，\
                 超出的部分重载时会被截断 —— 请拆成多条。"
            ),
        ));
    }
    Ok(())
}

/// 这里的每一项都是"**别让 MCP 伤到主程序**"的具体手段：限制外部输入的大小/频率，
/// 而不是靠"客户端应该守规矩"。新增任何接受外部数组/字符串的工具时，都该在这里有一条。
pub fn limits_json() -> Value {
    json!({
        "maxSessions": super::MAX_SESSIONS,
        "sessionQueue": super::SESSION_QUEUE,
        "heartbeatSecs": super::HEARTBEAT_SECS,
        "maxBodyBytes": super::MAX_BODY_BYTES,
        "maxUiSetItems": MAX_UI_SET_ITEMS,
        "maxUiSetValueChars": MAX_UI_SET_VALUE_CHARS,
        "maxSendChars": MAX_SEND_CHARS,
        "maxBleWriteChars": MAX_BLE_WRITE_CHARS,
        // ADB：写进设备 shell 的单次字符数、PTY 尺寸、一次最多读多少行
        "maxAdbWriteChars": MAX_ADB_WRITE_CHARS,
        "maxAdbCols": MAX_ADB_COLS,
        "maxAdbRows": MAX_ADB_ROWS,
        "maxAdbReadLines": MAX_ADB_READ_LINES,
        "toolsPage": super::TOOLS_PAGE,
        "idleTimeoutSecs": super::IDLE_TIMEOUT_SECS,
        "rateLimitPerMin": super::RATE_LIMIT_PER_MIN,
        // 快速指令外部文件：文件字节数在 Rust 侧拦，条目/名称/内容长度在解析时截断
        "maxQuickCmdItems": MAX_QUICK_CMD_ITEMS,
        "maxQuickCmdLabelChars": MAX_QUICK_CMD_LABEL_CHARS,
        "maxQuickCmdValueChars": MAX_QUICK_CMD_VALUE_CHARS,
        "maxQuickCmdFileBytes": MAX_QUICK_CMD_FILE_BYTES,
        // 每条指令的等待参数（这三个数**是被执行的**：check_quick_cmd_item_params）
        "maxQuickCmdTimeoutMs": MAX_QUICK_CMD_TIMEOUT_MS,
        "maxQuickCmdRetry": MAX_QUICK_CMD_RETRY,
        "maxQuickCmdExpectChars": MAX_QUICK_CMD_EXPECT_CHARS,
        // 工作流规则（同样是**被执行**的：check_workflow_args）
        "maxWorkflowRules": MAX_WORKFLOW_RULES,
        "maxWorkflowConditions": MAX_WORKFLOW_CONDITIONS,
        "maxWorkflowActions": MAX_WORKFLOW_ACTIONS,
        "maxWorkflowNameChars": MAX_WORKFLOW_NAME_CHARS,
        "maxWorkflowCondValueChars": MAX_WORKFLOW_COND_VALUE_CHARS,
        "maxWorkflowActionDataChars": MAX_WORKFLOW_ACTION_DATA_CHARS,
        // 日志中心的内存边界（这几个数**是被执行的**，不只是报告值）
        "logMaxLineBytes": loghub::MAX_LINE_BYTES,
        "logTotalCapBytes": loghub::TOTAL_CAP_BYTES,
        "logMaxChannels": loghub::MAX_CHANNELS,
        // 检索图案的上限（`log_search` / `adb_shell_read` / `ble_get_output` 共用；**被执行**：
        // `check_search_pattern` 在碰主程序之前就拦，因为图案要被编译成正则）
        "maxSearchPatternChars": loghub::MAX_SEARCH_PATTERN_CHARS,
        "maxSearchContextLines": loghub::MAX_SEARCH_CONTEXT,
        "protocolVersion": PROTOCOL_VERSION,
        "protocolFallback": PROTOCOL_FALLBACK,
    })
}

// ===== 分派 =====

/// 解析"读日志"类工具共用的 `format` 参数：`json`（默认，逐行结构化）或 `text`（省 token）。
///
/// 取值不认识时**报 -32602 并把可选值写出来**，绝不静默退回 json ——
/// 静默退回会让"我想省 token"这件事悄悄失效，而调用方以为拿到的是 text
/// （`ble_write` 的 `format` 是另一回事：那边是 `text`/`hex` 的**载荷**格式）。
fn log_format_arg(args: &Value) -> Result<super::loghub::LogFormat, RpcError> {
    match opt_str(args, "format").as_deref() {
        None | Some("json") => Ok(super::loghub::LogFormat::Json),
        Some("text") => Ok(super::loghub::LogFormat::Text),
        Some(other) => Err(RpcError::new(
            E_INVALID_PARAMS,
            format!(
                "format 只能是 json（默认，逐行结构化）或 text（一行一条纯文本，省 token）；收到 {:?}",
                other
            ),
        )),
    }
}

/// 解析 `log_search` 的 `mode`：`lines`（默认，命中行）/ `matches`（只回片段）/ `count`（只回计数）。
///
/// 取值不认识时报 -32602 并列出可选值 —— 静默退回 `lines` 会把"我只想要个计数"
/// 变成一次几千 token 的返回（正好和这个参数的用途相反）。
fn search_mode_arg(args: &Value) -> Result<super::loghub::SearchMode, RpcError> {
    use super::loghub::SearchMode;
    match opt_str(args, "mode").as_deref() {
        None | Some("lines") => Ok(SearchMode::Lines),
        Some("matches") => Ok(SearchMode::Matches),
        Some("count") => Ok(SearchMode::Count),
        Some(other) => Err(RpcError::new(
            E_INVALID_PARAMS,
            format!(
                "mode 只能是 lines（默认，回命中行）/ matches（只回匹配片段）/ count（只回计数）；收到 {:?}",
                other
            ),
        )),
    }
}

/// 这个 `pane` 是 WSL 分栏吗？
///
/// 为什么需要它：**两种分栏的串口来源是不同的两套实现** ——
/// Windows 分栏走 `list_ports` / `open_port` / `send_data`，读的是本机 COM 口；
/// WSL 分栏走 `get_wsl_serial_devices` / `open_wsl_serial` / `send_wsl_serial`，读的是
/// WSL 里的设备（前端分栏 id 就是 `wsl` / `wsl-x1` / …，见 `mcpSerialLogChannels` 的 `wsl:` 前缀）。
///
/// 所以任何"拿 Windows 端口说事"的前置判断都必须先问一句是不是 WSL 分栏
/// ——`serial_open` 里那个"一个串口都没有就别白等 6 秒"的检查就是例子。
///
/// 判据写成 `wsl` / `wsl-` 前缀（而不是 `starts_with("wsl")`）：前者不会把
/// 将来可能出现的 `wslx` 之类误判成 WSL 分栏。
fn pane_is_wsl(args: &Value) -> bool {
    match opt_str(args, "pane") {
        Some(p) => {
            let p = p.trim().to_ascii_lowercase();
            p == "wsl" || p.starts_with("wsl-")
        }
        None => false, // 省略 pane = main（Windows 分栏）
    }
}

/// 组装一次串口语义调用（把 pane 透传下去）
async fn serial_call(
    core: &Arc<McpCore>,
    action: &str,
    args: &Value,
    extra: Value,
) -> Result<Value, RpcError> {
    let mut payload = extra;
    payload["action"] = json!(action);
    if let Some(pane) = opt_str(args, "pane") {
        payload["pane"] = json!(pane);
    }
    core.ui_call("serial", payload).await
}

/// BLE 语义工具的转发（与 `serial_call` 同构，只是面板换成 `ble`）
async fn ble_call(
    core: &Arc<McpCore>,
    action: &str,
    args: &Value,
    extra: Value,
) -> Result<Value, RpcError> {
    let mut payload = extra;
    payload["action"] = json!(action);
    // BLE 只有"蓝牙页"这一块面板，没有多分栏；`pane` 仅为与 serial_* 保持一致的入参习惯
    if let Some(pane) = opt_str(args, "pane") {
        payload["pane"] = json!(pane);
    }
    core.ui_call("ble", payload).await
}

/// 批量改字段/开关（前端按"字段表 / 开关表"决定是写值还是切 class）
async fn serial_apply(core: &Arc<McpCore>, args: &Value, items: Value) -> Result<Value, RpcError> {
    serial_call(core, "apply", args, json!({ "items": items })).await
}

/// ADB 语义工具的转发（与 `serial_call`/`ble_call` 同构，面板换成 `adb`）。
///
/// 为什么没有 `args`/`pane` 参数：ADB 面板是单会话模型、也没有多分栏，
/// 会话由 `serial` 标识 —— 硬塞一个用不上的 pane 只会让调用方以为它能开多个 ADB 会话。
/// 每个工具要用的字段由各自的调用点放进 `extra`（光校验不转发 = 前端永远收不到）。
async fn adb_call(core: &Arc<McpCore>, action: &str, extra: Value) -> Result<Value, RpcError> {
    let mut payload = extra;
    payload["action"] = json!(action);
    core.ui_call("adb", payload).await
}

/// `pattern` 的**长度上限**校验（`log_search` / `adb_shell_read` / `ble_get_output` 共用）。
///
/// 为什么必须有：请求体上限是 1 MiB，而 `pattern` 会被编译成**正则** ——
/// 一条几十万字符的图案足以让这次调用卡住（AGENTS #10："任何接受外部字符串的参数都要有上限，
/// 且校验要发生在碰主程序之前"）。上限本身报在 `mcp_limits.maxSearchPatternChars` 里。
fn check_search_pattern(args: &Value) -> Result<(), RpcError> {
    let Some(p) = args.get("pattern").and_then(|v| v.as_str()) else {
        return Ok(());
    };
    let n = p.chars().count();
    if n > super::loghub::MAX_SEARCH_PATTERN_CHARS {
        return Err(RpcError::new(
            E_INVALID_PARAMS,
            format!(
                "pattern 太长：{n} 个字符，上限 {}（见 mcp_limits.maxSearchPatternChars）—— 要更复杂的检索就分几次搜",
                super::loghub::MAX_SEARCH_PATTERN_CHARS
            ),
        ));
    }
    Ok(())
}

/// 解析"读输出"类工具（`adb_shell_read` / `ble_get_output`）共用的检索参数。
///
/// 键名与语义**故意和 `log_search` 一致**（`pattern` / `mode` / `regex` / `caseSensitive` / `limit`），
/// 匹配也走同一份 [`super::loghub::LogMatcher`] —— 三个工具对同一个图案必须给同样的答案。
struct OutputQuery {
    pattern: Option<String>,
    mode: super::loghub::SearchMode,
    regex: bool,
    case_sensitive: bool,
    limit: usize,
}

/// 解析并校验"读输出"类工具的检索参数（**在碰界面/设备之前**）。
///
/// ⚠️ `limit` 在这两个工具里**同时**是两件事：① 各工具自己的"这一页回多少条"
/// （adb = 页大小、ble = 最后 N 条，默认值各自不同，由工具自己再从 `args` 取一次）；
/// ② `matches` 档最多回多少条命中。这里给的是 ② 的封顶（默认 100、上限 2000）。
fn parse_output_query(args: &Value) -> Result<OutputQuery, RpcError> {
    check_search_pattern(args)?;
    let mode = search_mode_arg(args)?;
    let pattern = opt_str(args, "pattern");
    // `matches` / `count` 就是"检索"本身：没有图案无从谈起（要"有多少条输出"看 `count` 字段，
    // 那是分页用的条目数，不是搜索结果）
    if pattern.is_none() && mode != super::loghub::SearchMode::Lines {
        return Err(RpcError::new(
            E_INVALID_PARAMS,
            format!(
                "mode={} 必须同时给 pattern：这两档就是检索（{}）",
                mode.as_str(),
                if mode == super::loghub::SearchMode::Count {
                    "count=这一批输出里命中多少次"
                } else {
                    "matches=命中片段是哪几段"
                }
            ),
        ));
    }
    Ok(OutputQuery {
        pattern,
        mode,
        regex: opt_bool(args, "regex", false),
        case_sensitive: opt_bool_alias(args, "caseSensitive", "case_sensitive", false),
        limit: opt_u64(args, "limit").unwrap_or(100).clamp(1, 2000) as usize,
    })
}

/// 一条"输出条目"的规范化视图：**匹配用的文本**与**原条目**分开，
/// 这样 `adb`（PTY 块）与 `ble`（通知条目）能共用同一套整理逻辑。
struct OutItem<'a> {
    seq: u64,
    ts: String,
    /// 拿去匹配的文本（adb 是块正文；ble 是 text，text 为空时用 hex）
    hay: String,
    /// 命中条目里额外要带的字段（ble 带 `kind`）
    extra: Value,
    raw: &'a Value,
}

/// 读蓝牙面板**本次会话**的数据日志（面板自己那份缓冲，不是 LogHub 通道）。
///
/// ⚠️ 修了一个**从来没生效过**的参数（2026-09）：`limit` / `sinceSeq` 声明在 schema 里，
/// 但分派那边过去写的是 `ble_call(core, "getOutput", args, json!({}))` —— 只转发 `action`/`pane`，
/// 两个参数**根本没到前端**（前端 `parseInt(payload.limit)` 永远是 NaN → 每次返回全量）。
/// 现在显式放进 `extra`，并由调用测试要求"发给前端的 payload 必须带 limit"。
///
/// `pattern` / `mode`（与 `adb_shell_read` 同一套词汇）：条目形状是
/// `{seq, ts, kind, hex, text, dim}`，匹配的文本取 `text`，**`text` 为空时取 `hex`**
/// （HEX 通知在面板上就是那个样子；只看 text 的话十六进制数据永远搜不到）。
async fn ble_get_output(core: &Arc<McpCore>, args: &Value) -> Result<Value, RpcError> {
    let q = parse_output_query(args)?;
    let mut extra = json!({});
    // 显式转发：参数在 schema 里声明了就必须真的传下去（AGENTS #11 ②）。
    // ⚠️ `limit` **只在 lines 档**转发：检索档（matches/count）要扫的是**整份面板缓冲**，
    // 转发"最后 N 条"会让"数一数出现几次"悄悄变成"数最后 N 条里出现几次"
    //（`scanned` 会把真实扫过的条数报出来）。
    if q.mode == super::loghub::SearchMode::Lines {
        if let Some(n) = opt_u64(args, "limit") {
            extra["limit"] = json!(n);
        }
    }
    if let Some(n) = opt_u64_alias(args, "sinceSeq", "since_seq") {
        extra["sinceSeq"] = json!(n);
    }
    let v = ble_call(core, "getOutput", args, extra).await?;

    let all: Vec<Value> = v["items"].as_array().cloned().unwrap_or_default();
    let items: Vec<OutItem<'_>> = all
        .iter()
        .map(|l| {
            let text = l["text"].as_str().unwrap_or("");
            let hex = l["hex"].as_str().unwrap_or("");
            OutItem {
                seq: l["seq"].as_u64().unwrap_or(0),
                ts: l["ts"].as_str().unwrap_or("").to_string(),
                // 面板上"这条长什么样"就按什么匹配：有文本用文本，否则用 HEX
                hay: if text.is_empty() { hex.to_string() } else { text.to_string() },
                extra: json!({ "kind": l["kind"].as_str().unwrap_or("") }),
                raw: l,
            }
        })
        .collect();
    let shaped = shape_output_items(items, &q);
    let count = if q.mode == super::loghub::SearchMode::Lines {
        shaped["items"].as_array().map(|a| a.len()).unwrap_or(0)
    } else {
        all.len()
    };

    // 面板自己的元信息原样带出（`count`/`items` 由上面的模式决定，其余照抄前端回执）
    let mut out = json!({
        "pane": v["pane"].clone(),
        "count": count,
        "scanned": all.len(),
        "total": v["total"].clone(),
        "channels": v["channels"].clone(),
    });
    if let Some(o) = shaped.as_object() {
        let obj = out.as_object_mut().expect("上面刚构造的对象");
        for (k, val) in o {
            obj.insert(k.clone(), val.clone());
        }
    }
    if let Some(p) = &q.pattern {
        out["pattern"] = json!(p);
        out["regex"] = json!(q.regex);
    }
    Ok(out)
}

/// 把一批输出条目整理成某个 `mode` 要的形状。返回要**并进工具自己的响应对象**的那些字段。
///
/// - `lines`：`items`（`pattern` 给了就只留命中的条目），保持工具原本的形状；
/// - `matches`：`hits`（一处命中一条：`seq`/`ts`/`match` + 条目自己的额外字段）；
/// - `count`：`total`（命中**条目**数）+ `totalMatches`（命中**处**数）。
///
/// 三种模式都会给 `mode`，让调用方一眼知道拿到的是哪种形状。
fn shape_output_items(items: Vec<OutItem<'_>>, q: &OutputQuery) -> Value {
    use super::loghub::SearchMode;
    let matcher = match super::loghub::LogMatcher::new(
        q.pattern.as_deref().unwrap_or(""),
        q.regex,
        q.case_sensitive,
        q.mode != SearchMode::Lines,
    ) {
        Ok(m) => m,
        // 图案不合法（正则写错）在 `parse_output_query` 之后才可能发生 ——
        // 让 `is_match`/`count` 退化成"不命中"比 panic 好，但这条路径实际到不了
        // （`log_search` 已先把非法正则报成 -32602；这里只做兜底）
        Err(_) => super::loghub::LogMatcher::new("", false, true, false).expect("空图案必成功"),
    };
    let scanned = items.len();
    match q.mode {
        SearchMode::Lines => {
            let kept: Vec<Value> = match &q.pattern {
                Some(_) => items
                    .iter()
                    .filter(|it| matcher.is_match(&it.hay))
                    .map(|it| it.raw.clone())
                    .collect(),
                None => items.iter().map(|it| it.raw.clone()).collect(),
            };
            json!({ "mode": "lines", "items": kept })
        }
        SearchMode::Matches => {
            let mut hits: Vec<Value> = Vec::new();
            'outer: for it in &items {
                for frag in matcher.fragments(&it.hay, q.limit - hits.len()) {
                    let mut h = json!({ "seq": it.seq, "ts": it.ts, "match": frag });
                    if let Some(o) = it.extra.as_object() {
                        for (k, v) in o {
                            h[k] = v.clone();
                        }
                    }
                    hits.push(h);
                    if hits.len() >= q.limit {
                        break 'outer;
                    }
                }
            }
            json!({
                "mode": "matches",
                "hits": hits,
                "scanned": scanned,
                "truncated": hits.len() >= q.limit,
            })
        }
        SearchMode::Count => {
            let mut total = 0u64;
            let mut total_matches = 0u64;
            for it in &items {
                if matcher.is_match(&it.hay) {
                    total += 1;
                    total_matches += matcher.count(&it.hay);
                }
            }
            json!({
                "mode": "count",
                "total": total,
                "totalMatches": total_matches,
                "scanned": scanned,
                "truncated": false,
            })
        }
    }
}

/// 读 ADB shell 已经产生的输出（**纯后端**，没有界面时也能用）。
///
/// 数据来源是日志中心的 `adb:rx` 通道，**不是面板轮询的那个 crossbeam 队列** ——
/// 后者是单消费者队列：前端每 120ms 就 drain 一次写进 xterm，工具跑去 drain 会把界面
/// 要显示的输出抢走（AGENTS #6 明令禁止"去 drain 前端轮询的队列"）。所以 ADB 的 PTY
/// 读线程在**生产端**多推了一份到 LogHub（`main.rs` 的 `adb_open_shell` 读线程），这里只读副本。
///
/// **通道不存在不算错误**：那只是"还没有任何 shell 输出"。`log_tail` 对同样的输入会报
/// `-32602`「没有这个通道」，而 AI 会据此得出"不支持读 ADB 输出"这种错结论。
///
/// `pattern`/`mode`（2026-09 加）：PTY 的条目是**输出块**（不是按行切好的文本），
/// 所以这一层没有 `context` —— "块的前后几块"对调试没有意义。要按行看就先用
/// `adb_shell_read{mode:"matches"}` 定位，再 `log_tail{channel:"adb:rx", format:"text"}` 看整段。
fn adb_shell_read(core: &Arc<McpCore>, args: &Value) -> Result<Value, RpcError> {
    const CHANNEL: &str = "adb:rx";
    let q = parse_output_query(args)?;
    // 扫多少块：
    // - `lines` 档：`limit` 就是页大小（默认 200、上限 2000），给了 pattern 就在这一页里过滤；
    // - `matches` / `count` 档：`limit` 改指"最多回多少条命中"，所以**扫满允许的窗口**
    //   （最近 MAX_ADB_READ_LINES 块）—— 否则"数一数有多少 ERROR"会变成"数最近 200 块里有多少"，
    //   而 `scanned` 会把真实扫过的块数报出来。
    let want = if q.mode == super::loghub::SearchMode::Lines {
        opt_u64(args, "limit").unwrap_or(MAX_ADB_READ_LINES).clamp(1, MAX_ADB_READ_LINES) as usize
    } else {
        MAX_ADB_READ_LINES as usize
    };
    let since = opt_u64_alias(args, "sinceSeq", "since_seq");
    // serial 取**后端自己那份会话状态**（不是镜像界面）：面板是单会话模型，
    // 0 个或切换设备的瞬间有多个时如实回 null，而不是猜一台。
    let serial = core.adb_active_serial();
    let (all_items, dropped, may_be_incomplete) = match super::loghub::hub().tail(CHANNEL, since, want) {
        Ok(v) => (
            v["lines"].as_array().cloned().unwrap_or_default(),
            v["dropped"].as_u64().unwrap_or(0),
            v["mayBeIncomplete"].as_bool().unwrap_or(false),
        ),
        // 通道还不存在 = 还没有数据（**不是**错误，理由见上面的注释）
        Err(_) => (Vec::new(), 0, false),
    };
    // `truncated` 的口径与 `log_search` 一致：凑满一页就说明"后面可能还有"。
    let truncated = all_items.len() >= want;

    // 条目是 PTY 输出块：匹配用块正文（`text`），额外带上级别/方向（serde_json 的键是**有序**的，
    // 这里显式取字段，不靠 Map 顺序）
    let items: Vec<OutItem<'_>> = all_items
        .iter()
        .map(|l| OutItem {
            seq: l["seq"].as_u64().unwrap_or(0),
            ts: l["ts"].as_str().unwrap_or("").to_string(),
            hay: l["text"].as_str().unwrap_or("").to_string(),
            extra: json!({
                "level": l["level"].as_str().unwrap_or("info"),
                "dir": l["dir"].as_str().unwrap_or("none"),
            }),
            raw: l,
        })
        .collect();
    let shaped = shape_output_items(items, &q);
    // `count` 老口径 = "回了多少条"（lines 档就是过滤后的条目数，与 `items.len()` 一致）；
    // 另给 `scanned` = 这次**扫过**多少条目 —— 两者不等就说明 pattern 滤掉了一部分。
    let count = if q.mode == super::loghub::SearchMode::Lines {
        shaped["items"].as_array().map(|a| a.len()).unwrap_or(0)
    } else {
        all_items.len()
    };

    let mut notes: Vec<String> = Vec::new();
    if all_items.is_empty() {
        notes.push(
            "adb:rx 还没有数据：先 adb_open_shell 开一个会话，再用 adb_shell_write 发命令（命令要带 \\n）。"
                .to_string(),
        );
    }
    if serial.is_none() {
        notes.push(format!(
            "serial 未知（当前没有 ADB PTY 会话，或正在切换设备）：这些输出来自共用通道 {}。",
            CHANNEL
        ));
    }
    let mut out = json!({
        "serial": serial,
        "channel": CHANNEL,
        "count": count,
        "scanned": all_items.len(),
        "truncated": truncated,
        // 丢弃要能读出来（AGENTS #6）：通道被裁过时 mayBeIncomplete=true，
        // 否则调用方会以为"设备就输出了这么多"。
        "dropped": dropped,
        "mayBeIncomplete": may_be_incomplete,
    });
    // 模式专属字段并进来（lines 档给 items，matches 给 hits，count 给 total）
    if let Some(o) = shaped.as_object() {
        let obj = out.as_object_mut().expect("上面刚构造的对象");
        for (k, v) in o {
            obj.insert(k.clone(), v.clone());
        }
    }
    // 给了图案才回 `pattern`/`regex`（没给就别占字段）
    if let Some(p) = &q.pattern {
        out["pattern"] = json!(p);
        out["regex"] = json!(q.regex);
    }
    if !notes.is_empty() {
        out["note"] = json!(notes.join(" "));
    }
    Ok(out)
}

/// 读某个分栏**实际收发的内容**（串口监视器的核心）。
///
/// 两个细节值得留神：
/// 1. **通道名不在 Rust 侧拼** —— 规则（`serial:` / `wsl:` 前缀、`:rx` / `:tx` 后缀）由前端的
///    `mcpSerialLogChannels` 定义一处，`bufferPush`（写）与这里（读）共用一份，避免"写进去的名字"
///    和"读出来的名字"各写一遍然后漂移。所以先问一次 `state` 拿 `logChannels`。
/// 2. **通道不存在不是错误**：那只是"这个方向还没有数据"。这里返回空列表 + note，
///    因为对 AI 来说"还没收到数据"和"读不到数据"是完全不同的两件事。
async fn serial_get_output(core: &Arc<McpCore>, args: &Value) -> Result<Value, RpcError> {
    let direction = opt_str(args, "direction").unwrap_or_else(|| "both".to_string());
    if !matches!(direction.as_str(), "rx" | "tx" | "both") {
        return Err(RpcError::new(
            E_INVALID_PARAMS,
            "direction 只能是 rx / tx / both",
        ));
    }
    // 编码先校验（参数问题要在碰主程序之前报掉）
    let fmt = log_format_arg(args)?;
    let want = opt_u64(args, "lines").unwrap_or(50).clamp(1, 2000) as usize;

    // 顺带完成分栏名校验（分栏不存在 → 前端回 notFound → 协议级 -32602）
    let st = serial_call(core, "state", args, json!({})).await?;
    let pane = st["pane"].as_str().unwrap_or("main").to_string();
    let chans = st.get("logChannels").cloned().unwrap_or_else(|| json!({}));
    let connected = st["isConnected"].as_bool().unwrap_or(false);

    let page = collect_serial_output(&chans, &direction, want, fmt);
    let empty_dirs: Vec<&str> = ["rx", "tx"]
        .into_iter()
        .filter(|d| direction == "both" || direction == *d)
        .filter(|d| page.per_dir.get(*d).map(|v| v["count"].as_u64() == Some(0)).unwrap_or(false))
        .collect();

    let note = if empty_dirs.len() == 2 {
        Some("这个分栏还没有收发任何数据。若期望有数据：先用 serial_get_state 看 isConnected，未连接就 serial_open。".to_string())
    } else if empty_dirs.len() == 1 {
        Some(format!(
            "{} 方向还没有数据。",
            if empty_dirs[0] == "rx" { "接收" } else { "发送" }
        ))
    } else {
        None
    };

    let mut out = json!({
        "pane": pane,
        "direction": direction,
        "format": fmt.as_str(),
        "isConnected": connected,
        "channels": page.per_dir,
        "count": page.count,
        "truncated": page.truncated,
    });
    match fmt {
        super::loghub::LogFormat::Json => out["items"] = json!(page.items),
        super::loghub::LogFormat::Text => {
            // 文本页：头部一行元信息（含**每个方向自己的丢弃账**，AGENTS #6）+
            // 一行一条 `[时刻] [rx|tx] 正文`。方向必须留：这里是归并后的结果。
            let mut text = serial_text_header(&out, &page);
            if let Some(n) = &note {
                text.push_str("# note: ");
                text.push_str(n);
                text.push('\n');
            }
            text.push_str(&page.text);
            out["text"] = json!(text);
        }
    }
    if let Some(n) = note {
        out["note"] = json!(n);
    }
    Ok(out)
}

/// 文本编码的头部：一行说清"这一页是什么、有多少、有没有被截、每个方向丢过没有"。
///
/// 为什么值得花这几十个 token：`log_tail` 那边头部是每个通道一行，这里是**归并**后的结果，
/// 分栏/方向/两个通道各自的 `dropped`/`mayBeIncomplete` 都没有别的出口
/// （正文里只有时刻、方向和内容）。省 token 不能省掉"日志可能不完整"这件事。
fn serial_text_header(out: &Value, page: &SerialOutputPage) -> String {
    let mut s = String::new();
    s.push_str("# pane=");
    s.push_str(out["pane"].as_str().unwrap_or("main"));
    s.push_str(" direction=");
    s.push_str(out["direction"].as_str().unwrap_or("both"));
    s.push_str(" count=");
    s.push_str(&page.count.to_string());
    s.push_str(" truncated=");
    s.push_str(if page.truncated { "true" } else { "false" });
    for dir in ["rx", "tx"] {
        let Some(d) = page.per_dir.get(dir).and_then(|v| v.as_object()) else {
            continue;
        };
        s.push_str(" | ");
        s.push_str(dir);
        s.push_str(" count=");
        s.push_str(&d.get("count").and_then(|v| v.as_u64()).unwrap_or(0).to_string());
        s.push_str(" dropped=");
        s.push_str(&d.get("dropped").and_then(|v| v.as_u64()).unwrap_or(0).to_string());
        s.push_str(" mayBeIncomplete=");
        s.push_str(if d.get("mayBeIncomplete").and_then(|v| v.as_bool()).unwrap_or(false) {
            "true"
        } else {
            "false"
        });
    }
    s.push('\n');
    s
}

/// 一页"分栏收发内容"：json 给 `items`，text 给 `text`，**元信息两边必须一致**。
struct SerialOutputPage {
    /// 每个方向的元信息（`channel`/`count`/`dropped`/`mayBeIncomplete`）
    per_dir: Value,
    /// 归并后的行（仅 json 编码）
    items: Vec<Value>,
    /// 文本页（仅 text 编码）
    text: String,
    /// 归并后的行数（两种编码下同一个数）
    count: usize,
    truncated: bool,
}

/// 从日志中心取某个分栏的 rx/tx 内容并按时间归并（纯函数，便于单测）。
///
/// `**通道不存在在这里不是错误**` —— 那只是"这个方向还没有数据"
/// （对 AI 来说，这和"读不到数据"是完全不同的两件事）。
///
/// 两种编码共用**同一次选取**（同一批行、同一个 `count`/`truncated`）——
/// 换编码只换写法，不许换数据。
fn collect_serial_output(
    chans: &Value,
    direction: &str,
    want: usize,
    fmt: super::loghub::LogFormat,
) -> SerialOutputPage {
    use super::loghub::LogFormat;
    let hub = super::loghub::hub();
    let mut per_dir = serde_json::Map::new();
    let mut picked: Vec<Value> = Vec::new();
    for dir in ["rx", "tx"] {
        if direction != "both" && direction != dir {
            continue;
        }
        let Some(name) = chans.get(dir).and_then(|v| v.as_str()) else {
            continue;
        };
        match hub.tail(name, None, want) {
            Ok(v) => {
                if let Some(arr) = v["lines"].as_array() {
                    picked.extend(arr.iter().cloned());
                }
                per_dir.insert(
                    dir.to_string(),
                    json!({
                        "channel": name,
                        "count": v["returned"],
                        "dropped": v["dropped"],
                        "mayBeIncomplete": v["mayBeIncomplete"],
                    }),
                );
            }
            Err(_) => {
                per_dir.insert(
                    dir.to_string(),
                    json!({ "channel": name, "count": 0, "note": "还没有数据" }),
                );
            }
        }
    }
    // 两个通道各自有独立 seq，所以只能按时间归并（t 是毫秒时间戳）
    picked.sort_by_key(|l| l["t"].as_i64().unwrap_or(0));
    let total = picked.len();
    let truncated = total > want;
    if truncated {
        picked.drain(0..total - want);
    }
    let count = picked.len();
    let (items, text) = match fmt {
        LogFormat::Json => (picked, String::new()),
        LogFormat::Text => {
            let mut s = String::with_capacity(count * 32);
            for l in &picked {
                // 方向必须标：rx/tx 是归并在一起的，不标就分不清是谁说的
                super::loghub::push_text_line(
                    &mut s,
                    l["t"].as_i64().unwrap_or(0),
                    l["dir"].as_str().unwrap_or("none"),
                    l["text"].as_str().unwrap_or(""),
                );
            }
            (Vec::new(), s)
        }
    };
    SerialOutputPage {
        per_dir: Value::Object(per_dir),
        items,
        text,
        count,
        truncated,
    }
}

/// 开/关监控：点按钮 → **轮询确认状态** → 返回真实状态。
///
/// 为什么不能点完就返回：串口打开是异步的，点下去只代表"按钮被按下"。
/// 让工具自己等状态变化，调用方（AI）拿到的才是事实，而不是一个乐观的猜测。
/// 失败用 `E_DEVICE_NOT_READY`（按协议会变成 result + `isError: true`，不是 JSON-RPC 错误）。
async fn serial_set_connected(
    core: &Arc<McpCore>,
    args: &Value,
    open: bool,
) -> Result<Value, RpcError> {
    let st = serial_call(core, "state", args, json!({})).await?;
    let connected = st["isConnected"].as_bool().unwrap_or(false);
    let pane = st["pane"].as_str().unwrap_or("main").to_string();
    if connected == open {
        return Ok(json!({
            "pane": pane,
            "connected": connected,
            "note": if open { "本来就在监控中，无需重复打开" } else { "本来就没在监控" },
            "state": st,
        }));
    }

    let mut click = json!({ "action": "click", "name": "start" });
    if let Some(p) = opt_str(args, "pane") {
        click["pane"] = json!(p);
    }
    core.ui_call("serial", click).await?;

    let wait_ms = if open { 6000 } else { 3000 };
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(wait_ms);
    // 注意：`last` 每轮都会被赋值后才被读（超时分支与收尾都用的是本轮的值），
    // 所以不要用 `st` 预初始化 —— 那样编译器会报"赋了没读"。
    let mut last;
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        let now = serial_call(core, "state", args, json!({})).await?;
        let reached = now["isConnected"].as_bool().unwrap_or(false) == open;
        last = now;
        if reached {
            break;
        }
        if std::time::Instant::now() >= deadline {
            return Err(RpcError::new(
                E_DEVICE_NOT_READY,
                format!(
                    "点了「{}」，但 {} 秒内状态没变成 connected={}（当前 {}）。常见原因：端口被占用、设备被拔出、驱动异常、或波特率/流控不被设备接受。详情看界面报错或 log_tail(channel=\"error\")。",
                    if open { "开始监控" } else { "停止监控" },
                    wait_ms / 1000,
                    open,
                    if last["isConnected"].as_bool().unwrap_or(false) { "仍在监控中" } else { "仍未连接" }
                ),
            ));
        }
    }
    Ok(json!({ "pane": pane, "connected": open, "state": last }))
}

fn ok_response(id: Value, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

fn err_response(id: Value, err: &RpcError) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": err.code, "message": err.message }
    })
    .to_string()
}

/// **文本载荷搬运**：`{format:"text", text:"…"}` 这种形状的结果，把 `text` 从
/// structuredContent 里**搬**到 `content[].text`，成功返回它。
///
/// 为什么要有这一步（2026-09）：很多客户端只把 `content[].text` 交给模型，而通用摘要
/// （[`summarize_for_tool`]）会把整段日志压成 600 字 —— 那正好把"省 token 的编码"变成
/// "AI 看不到日志"，与这个功能的目的相反。搬过去之后：模型侧拿到**完整**日志（就一份），
/// `structuredContent` 只留元信息（**不再复制一份**，否则省下的 token 又花回去了）。
///
/// 注意调用点在 `calllog.record` **之后**，所以 `ai-calls.jsonl` 里仍然记着全文。
///
/// ⚠️ 新增"text 编码"的工具时必须把工具名加进 [`TEXT_PAYLOAD_TOOLS`]
/// （`text_format_tools_are_all_in_the_text_payload_list` 守着这条）。
fn take_rendered_text(tool: &str, value: &mut Value) -> Option<String> {
    if !TEXT_PAYLOAD_TOOLS.contains(&tool) {
        return None;
    }
    if value.get("format").and_then(|v| v.as_str()) != Some("text") {
        return None;
    }
    let text = value.get("text").and_then(|v| v.as_str())?.to_string();
    if text.is_empty() {
        return None;
    }
    value.as_object_mut()?.remove("text");
    Some(text)
}

/// 哪些工具的 text 编码结果是"载荷本身就是文本"（见 [`take_rendered_text`]）。
const TEXT_PAYLOAD_TOOLS: &[&str] = &["log_tail", "serial_get_output"];

/// 工具执行失败必须返回**正常 result** + `isError: true`（MCP 规范要求），
/// 只有协议级错误才用 JSON-RPC error —— 弄混会让客户端把工具错误当成连接故障。
fn tool_result_ok(tool: &str, value: Value) -> Value {
    let mut value = value;
    // 先看有没有"现成的文本载荷"（text 编码）：有就直接用它当 content 文本
    let rendered = take_rendered_text(tool, &mut value);
    // 规范要求 `structuredContent` 是**对象**。工具直接返回数组的话，严格客户端
    // （官方 Python SDK 走 pydantic）会把整条结果判为非法 —— 用户看到的是"这个工具坏了"。
    // 这里兜一层：不是对象就包成 `{"value": …}` 并上报，免得某天新加的工具再踩一次。
    let structured = if value.is_object() {
        value
    } else {
        super::report::report(
            "structured_content_not_object",
            &format!(
                "工具返回了非对象的 structuredContent（{}），已按规范包成 object",
                match &value {
                    Value::Array(a) => format!("array[{}]", a.len()),
                    Value::Null => "null".to_string(),
                    _ => "scalar".to_string(),
                }
            ),
        );
        json!({ "value": value })
    };
    let text = match rendered {
        Some(t) => t,
        None => summarize_for_tool(tool, &structured),
    };
    json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": structured,
        "isError": false
    })
}

fn tool_result_err(err: &RpcError) -> Value {
    json!({
        "content": [{ "type": "text", "text": format!("错误 {}: {}", err.code, err.message) }],
        "isError": true
    })
}

/// 给只会读文本的客户端（以及直接看输出的用户）准备一句人话摘要。
///
/// **这不是"可有可无的美化"**：很多客户端只把 `content[].text` 给模型看，人也是先看这行。
/// 原实现遇到数组只写 "N 项"，于是 `serial_list_ports` 的文本成了 `count=1, ports=1 项`
/// —— **端口名一个字都没有**，看起来就像"这个工具不返回端口名"（用户就是这么报的）。
/// 现在数组会真的展开内容（有界：最多 3 个元素 × 每个最多 4 个字段，整体限长），
/// 让"摘要"真能替代结构化数据被读懂。
fn summarize_for_text(v: &Value) -> String {
    let s = render_brief(v, 0);
    if s.chars().count() > TEXT_SUMMARY_MAX_CHARS {
        let cut: String = s.chars().take(TEXT_SUMMARY_MAX_CHARS).collect();
        format!("{}…（完整内容在 structuredContent）", cut)
    } else {
        s
    }
}

/// 工具感知的文本摘要：默认走通用渲染，少数"载荷就是一张表"的工具用紧凑格式。
///
/// 为什么要有这一层：通用渲染对数组只展开前几个元素（JSON 对象形式很占字数），
/// 于是 45 台设备的扫描结果在文本里成了 `[3 台] …共 45 项` ——
/// **看起来就像"这个工具只回了设备数量"**（用户 2026-09 原话：
/// "只有设备数量吗？没有设备名称列表？包含 MAC 地址的"）。设备列表改成一行一台，
/// 同样的 600 字预算里能放下十几台（MAC + 名称 + RSSI），结构化数据照旧全量在
/// `structuredContent` 里。
fn summarize_for_tool(tool: &str, v: &Value) -> String {
    // 按**载荷形状**判断而不是只按工具名：`ble_list_devices` 与通用桥的
    // `ui_get_state{section:"bleDevices"}` 返回的是同一张设备表，两条路都该看到设备名/MAC。
    let devices = v["devices"].as_array();
    let looks_like_device_list = devices
        .map(|a| a.iter().any(|d| d.get("mac").is_some()))
        .unwrap_or(false);
    if tool == "ble_list_devices" || looks_like_device_list {
        return summarize_ble_devices(v);
    }
    // WSL 端口映射设备表（`ui_get_state{section:"wslDevices"}`）同理：它没有 mac，靠 busid 认。
    // 不认出它的话，通用渲染只会展开前 3 台 —— "哪台是 COM7"很可能一个字都不在文本里。
    let looks_like_wsl_device_list = devices
        .map(|a| a.iter().any(|d| d.get("busid").is_some()))
        .unwrap_or(false);
    if looks_like_wsl_device_list {
        return summarize_wsl_devices(v);
    }
    summarize_for_text(v)
}

/// 蓝牙扫描结果的紧凑摘要：`共 105 台（第 1-20 台，扫描中）：MAC 名称 -79dBm | …`
///
/// 文本预算只有 600 字（客户端还可能自己再截），所以：
/// ① 一行一台、尽量多列；② **说清这是第几台到第几台、下一页的 offset 是多少** ——
/// 否则用户看到"只有前 17 台"就以为到头了（2026-09 用户原话：
/// "MCP 返回的文本在约 400 字符处被截断，所以我只能看到前 17 台"）。
fn summarize_ble_devices(v: &Value) -> String {
    let total = v["total"].as_u64().unwrap_or(0);
    let offset = v["offset"].as_u64().unwrap_or(0);
    let scanning = v["scanning"].as_bool().unwrap_or(false);
    let devices = v["devices"].as_array().cloned().unwrap_or_default();
    let head = if devices.is_empty() {
        format!("共 {} 台{}", total, if scanning { "（扫描中）" } else { "" })
    } else {
        format!(
            "共 {} 台（第 {}-{} 台{}）",
            total,
            offset + 1,
            offset + devices.len() as u64,
            if scanning { "，扫描中" } else { "" }
        )
    };
    let mut out = head;
    if devices.is_empty() {
        if let Some(n) = v["note"].as_str().filter(|s| !s.is_empty()) {
            out.push_str(" · ");
            out.push_str(n);
        }
        return out;
    }
    out.push_str("：");
    let mut shown = 0usize;
    for d in &devices {
        let mac = d["mac"].as_str().unwrap_or("?");
        let name = d["name"].as_str().filter(|s| !s.is_empty());
        let rssi = d["rssi"]
            .as_i64()
            .map(|r| format!("{}dBm", r))
            .unwrap_or_else(|| "—".to_string());
        let one = match name {
            Some(n) => format!("{} {} {}", mac, n, rssi),
            None => format!("{} {}", mac, rssi),
        };
        // 留 60 字给尾巴（"…本页还有 N 台；下一页 offset=…"）
        let used = out.chars().count() + one.chars().count() + 3;
        if used + 60 > TEXT_SUMMARY_MAX_CHARS {
            break;
        }
        if shown > 0 {
            out.push_str(" | ");
        }
        out.push_str(&one);
        shown += 1;
    }
    let hidden_in_page = devices.len() - shown;
    match (hidden_in_page, v["nextOffset"].as_u64()) {
        (0, Some(next)) => out.push_str(&format!("（下一页 offset={}）", next)),
        (n, Some(next)) => out.push_str(&format!(
            " …本页还有 {} 台没列出；下一页 offset={}（全量在 structuredContent.devices）",
            n, next
        )),
        (n, None) => out.push_str(&format!(
            " …本页还有 {} 台没列出（全量在 structuredContent.devices）",
            n
        )),
    }
    out
}

/// WSL 端口映射设备表的紧凑摘要：`共 3 台（已映射 1）：2-1 COM7 USB-SERIAL CH340 →/dev/ttyUSB0 | …`
///
/// 与 `summarize_ble_devices` 是**同一个教训**：通用渲染对数组只展开前 3 个元素，
/// 于是"到底哪台是 COM7、它的 busid 是多少"很可能一个字都不在文本里 —— 而这正是
/// 用户要 AI 做的第一件事（"把 COM7 映射到 WSL 当中"）。一行一台，把
/// **busid + COM 名 + 设备名 + 映射状态**都放进去。
fn summarize_wsl_devices(v: &Value) -> String {
    let devices = v["devices"].as_array().cloned().unwrap_or_default();
    let count = v["count"].as_u64().unwrap_or(devices.len() as u64);
    let running = v["wslRunning"].as_bool().unwrap_or(false);
    let mut out = format!(
        "共 {} 台设备（WSL {}，已映射 {}）",
        count,
        if running { "运行中" } else { "未运行" },
        v["mapped"].as_u64().unwrap_or(0)
    );
    if !running {
        if let Some(r) = v["mapUnavailableReason"].as_str().filter(|s| !s.is_empty()) {
            out.push_str(" · ");
            out.push_str(r);
        }
    }
    if devices.is_empty() {
        // 空表必须区分"这台机器没有 USB 设备"和"面板还没打开过、所以还没加载"
        if let Some(n) = v["note"].as_str().filter(|s| !s.is_empty()) {
            out.push_str(" · ");
            out.push_str(n);
        }
        return out;
    }
    out.push_str("：");
    let mut shown = 0usize;
    for d in &devices {
        let busid = d["busid"].as_str().unwrap_or("?");
        let port = d["port"].as_str().filter(|s| !s.is_empty() && *s != "-");
        let name = d["name"].as_str().filter(|s| !s.is_empty());
        let mapped = d["status"].as_str() == Some("mapped");
        let path = d["wslPath"].as_str().filter(|s| !s.is_empty());
        // busid 必须在前：它是稳定身份（COM 名和下标都会变）
        let mut one = String::from(busid);
        if let Some(p) = port {
            one.push(' ');
            one.push_str(p);
        }
        if let Some(n) = name {
            one.push(' ');
            one.push_str(n);
        }
        if d["busy"].as_bool().unwrap_or(false) {
            one.push_str(" [操作中]");
        } else if mapped {
            one.push_str(" [已映射");
            if let Some(p) = path {
                one.push_str("→");
                one.push_str(p);
            }
            one.push(']');
        }
        let used = out.chars().count() + one.chars().count() + 3;
        if used + 60 > TEXT_SUMMARY_MAX_CHARS {
            break;
        }
        if shown > 0 {
            out.push_str(" | ");
        }
        out.push_str(&one);
        shown += 1;
    }
    if shown < devices.len() {
        out.push_str(&format!(
            " …还有 {} 台没列出（全量在 structuredContent.devices，含 mapControlPath）",
            devices.len() - shown
        ));
    }
    out
}
/// 文本摘要的总长上限：它是**重复**信息（structuredContent 里都有），
/// 太长会白占模型上下文，所以宁可截断并指路。
const TEXT_SUMMARY_MAX_CHARS: usize = 600;

fn render_brief(v: &Value, depth: usize) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Object(m) => {
            let parts: Vec<String> = m
                .iter()
                .take(8)
                .map(|(k, val)| format!("{}={}", k, render_brief(val, depth + 1)))
                .collect();
            if depth == 0 {
                parts.join(", ")
            } else {
                format!("{{{}}}", parts.join(","))
            }
        }
        Value::Array(a) => {
            if a.is_empty() {
                return "[]".to_string();
            }
            // **按字数预算展开**，不是死板地只取 3 个：JSON 形态每个元素占几十字，
            // 硬性 3 个会让"有 40 项的列表"在文本里看着像"只回了 3 项"。
            // 预算之内尽量多列（最多 12 个），超出部分仍用"…共 N 项"指路。
            const ARRAY_BRIEF_BUDGET: usize = 420;
            let mut shown: Vec<String> = Vec::new();
            let mut used = 0usize;
            for x in a.iter().take(12) {
                let s = render_brief(x, depth + 1);
                if !shown.is_empty() && used + s.chars().count() + 3 > ARRAY_BRIEF_BUDGET {
                    break;
                }
                used += s.chars().count() + 3;
                shown.push(s);
            }
            let tail = if a.len() > shown.len() {
                format!(" …共 {} 项", a.len())
            } else {
                String::new()
            };
            let body = shown.join(" | ");
            format!("[{}]{}", body, tail)
        }
        other => other.to_string(),
    }
}

/// 处理一条原始 JSON-RPC 报文（**单测专用的简写**：生产入口是下面带 panic 兜底的
/// `handle_raw_guarded`，会话名由传输层给出）。
/// 返回 `None` 表示这是**通知**（notification，无 id），按规范不应回包。
#[cfg(test)]
pub async fn handle_raw(core: &Arc<McpCore>, raw: &str) -> Option<String> {
    handle_raw_with_session(core, raw, "unknown").await
}

/// **带 panic 兜底的对外入口**（传输层只该调这个）。
///
/// 以前这里没有兜底，而设计文档却写着"工具分派边界有 `catch_unwind` 兜底"——**那句是假的**
/// （2026-09 核对：全 crate 没有任何 `catch_unwind`）。当时的后果是：任何一次 panic
/// 会把这条 SSE 连接的任务直接打死，客户端拿不到任何响应（只能等超时），
/// 我们也完全不知情。现在 panic 会变成一条 JSON-RPC 错误 + 一次错误上报。
///
/// 为什么可以跨越 `.await` 做 `catch_unwind`：`AssertUnwindSafe` 明确承认了
/// "await 点之间可能留下不一致状态"这个风险。这里的取舍是：宁可让这一次请求
/// 拿到一个错误，也不要让连接静默死亡 —— 而且写入路径本身没有跨 await 的共享可变状态。
pub async fn handle_raw_guarded(core: &Arc<McpCore>, raw: &str, session: &str) -> Option<String> {
    let fut = std::panic::AssertUnwindSafe(handle_raw_with_session(core, raw, session));
    match futures::FutureExt::catch_unwind(fut).await {
        Ok(v) => v,
        Err(payload) => {
            let msg = super::report::panic_message(&payload);
            super::report::report("dispatch_panic", &format!("请求处理 panic: {}", msg));
            Some(err_response(
                Value::Null,
                &RpcError::new(E_INTERNAL, format!("服务器内部错误（已上报）: {}", msg)),
            ))
        }
    }
}

/// 带会话标识的版本：调用记录要记清"哪个会话调的"。
/// 传输层用这个，`handle_raw` 只是一个便于测试的简写。
pub async fn handle_raw_with_session(
    core: &Arc<McpCore>,
    raw: &str,
    session: &str,
) -> Option<String> {
    let parsed: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(e) => {
            return Some(err_response(
                Value::Null,
                &RpcError::new(E_PARSE, format!("JSON 解析失败: {}", e)),
            ))
        }
    };
    if !parsed.is_object() {
        return Some(err_response(
            Value::Null,
            &RpcError::new(E_INVALID_REQUEST, "请求必须是 JSON 对象"),
        ));
    }
    if parsed.get("jsonrpc").and_then(|v| v.as_str()) != Some("2.0") {
        return Some(err_response(
            parsed.get("id").cloned().unwrap_or(Value::Null),
            &RpcError::new(E_INVALID_REQUEST, "jsonrpc 字段必须是 \"2.0\""),
        ));
    }
    let method = match parsed.get("method").and_then(|v| v.as_str()) {
        Some(m) => m.to_string(),
        None => {
            return Some(err_response(
                parsed.get("id").cloned().unwrap_or(Value::Null),
                &RpcError::new(E_INVALID_REQUEST, "缺少 method 字段"),
            ))
        }
    };
    let id = parsed.get("id").cloned();
    let params = parsed.get("params").cloned().unwrap_or(Value::Null);
    let is_notification = id.is_none();

    core.requests.fetch_add(1, Ordering::Relaxed);

    let outcome: Result<Value, RpcError> = match method.as_str() {
        // 通知：握手完成，不需要回包
        "notifications/initialized" | "notifications/cancelled" => return None,
        "initialize" => {
            // 协商：对端给了我们支持的版本就照用，否则退回我们最低支持的版本
            let asked = params
                .get("protocolVersion")
                .and_then(|v| v.as_str())
                .unwrap_or(PROTOCOL_FALLBACK)
                .to_string();
            // 协商规则（MCP 规范）：对端要的版本我们支持 → 原样回；不支持 → 回**我们自己支持的最新版**
            // （规范原文："otherwise the server MUST respond with another protocol version it supports,
            //  preferably its latest"）。
            // 以前这里回的是 `PROTOCOL_FALLBACK`（**最旧**那版）—— 独立客户端一致性检查发现：
            // SDK 2.x 默认要一个比我们新的版本，于是我们把它降到 2024-11-05，
            // 客户端虽然接受，但会按旧版规范的语义来用我们（凭白降级）。
            let agreed = if asked == PROTOCOL_VERSION || asked == PROTOCOL_FALLBACK {
                asked
            } else {
                PROTOCOL_VERSION.to_string()
            };
            Ok(json!({
                "protocolVersion": agreed,
                "capabilities": {
                    "tools": { "listChanged": true },
                    "resources": { "subscribe": false, "listChanged": false },
                    "logging": {}
                },
                "serverInfo": {
                    "name": SERVER_NAME,
                    "version": env!("CARGO_PKG_VERSION")
                },
                // 一次性告诉 Agent 怎么用我（省掉它靠失败去猜的几轮往返）
                "instructions": SERVER_INSTRUCTIONS
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => {
            let all = exposed_tools(core);
            let cursor = params
                .get("cursor")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(0);
            let page = super::TOOLS_PAGE;
            // 游标**先夹后加**：`cursor` 是客户端给的字符串，可以是任意 usize。
            // 原来直接 `cursor + page`：debug 构建会 overflow panic（被 handle_raw_guarded 兜成错误），
            // release 会回绕成小数字 → `cursor >= all.len()` 成立 → 返回空工具表**且不给 nextCursor**，
            // 客户端据此认为"这个服务器没有工具"。夹到 all.len() 之后，"越界 = 空页"才是确定行为。
            let cursor = cursor.min(all.len());
            let end = cursor.saturating_add(page).min(all.len());
            let slice: Vec<Value> = if cursor >= all.len() {
                Vec::new()
            } else {
                all[cursor..end].to_vec()
            };
            let mut out = json!({ "tools": slice });
            if end < all.len() {
                out["nextCursor"] = json!(end.to_string());
            }
            Ok(out)
        }
        "tools/call" => {
            let started = std::time::Instant::now();
            let name = match params.get("name").and_then(|v| v.as_str()) {
                Some(n) => n.to_string(),
                None => {
                    core.calllog.record(
                        session,
                        "(missing-name)",
                        &params,
                        false,
                        Some("tools/call 需要 name 参数"),
                        started.elapsed().as_millis() as u64,
                        None,
                        None,
                    );
                    return Some(err_response(
                        id.unwrap_or(Value::Null),
                        &RpcError::new(E_INVALID_PARAMS, "tools/call 需要 name 参数"),
                    ));
                }
            };
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let outcome = call_tool(core, &name, &args).await;
            let dur = started.elapsed().as_millis() as u64;
            // 记录每一次工具调用：成功、工具失败、协议级失败都记（审计要完整）
            let (ok, err_msg, result_val) = match &outcome {
                Ok(v) => (true, None, Some(v.clone())),
                Err(e) => (false, Some(e.message.clone()), None),
            };
            // ui_set / ui_click 的返回值里带 effects —— 单独提出来，
            // 这样事后能回答"AI 到底改了哪些控件、从什么改成了什么"
            let effects = result_val.as_ref().and_then(|v| v.get("effects").cloned());
            core.calllog.record(
                session,
                &name,
                &args,
                ok,
                err_msg.as_deref(),
                dur,
                effects.as_ref(),
                result_val.as_ref(),
            );
            match outcome {
                Ok(v) => Ok(tool_result_ok(&name, v)),
                Err(e) if e.code == E_INVALID_PARAMS || e.code == E_METHOD_NOT_FOUND => Err(e),
                Err(e) => Ok(tool_result_err(&e)),
            }
        }
        "resources/list" => Ok(json!({ "resources": [] })),
        "logging/setLevel" => Ok(json!({})),
        other => Err(RpcError::new(
            E_METHOD_NOT_FOUND,
            format!("未实现的方法: {}", other),
        )),
    };

    if is_notification {
        return None;
    }
    let id = id.unwrap_or(Value::Null);
    Some(match outcome {
        Ok(result) => ok_response(id, result),
        Err(e) => err_response(id, &e),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::McpCore;

    fn core() -> Arc<McpCore> {
        Arc::new(McpCore::new())
    }

    async fn call(c: &Arc<McpCore>, raw: &str) -> Value {
        let s = handle_raw(c, raw).await.expect("应当有响应");
        serde_json::from_str(&s).expect("响应应是合法 JSON")
    }

    /// 翻完 `tools/list` 的**所有页**取工具名。
    ///
    /// 为什么需要：内置工具已经超过一页（`TOOLS_PAGE = 50`，2026-09 加上 ADB 后是 55 个），
    /// 而 `ctl_*` 排在它们**后面** —— 只读第一页的断言会以为"工具不见了"，实际上只是没翻页。
    async fn all_tool_names(c: &Arc<McpCore>) -> Vec<String> {
        let mut names: Vec<String> = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..10 {
            let raw = match &cursor {
                Some(x) => format!(
                    r#"{{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{{"cursor":"{}"}}}}"#,
                    x
                ),
                None => r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#.to_string(),
            };
            let r = call(c, &raw).await;
            names.extend(list_names(&r));
            cursor = r["result"]["nextCursor"].as_str().map(|s| s.to_string());
            if cursor.is_none() {
                break;
            }
        }
        names
    }

    // 不开 tokio 的 macros feature（tokio-macros 不在本地缓存里），
    // 所以测试用手搓的最小 current_thread 运行时 block_on，而不是 #[tokio::test]。
    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("建立测试运行时")
            .block_on(f)
    }

    #[test]
    fn initialize_negotiates_version_and_reports_server_info() {
        block_on(async {
            let c = core();
            let r = call(
                &c,
                r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"t"}}}"#,
            )
            .await;
            assert_eq!(r["jsonrpc"], "2.0");
            assert_eq!(r["id"], 1);
            assert_eq!(r["result"]["protocolVersion"], PROTOCOL_VERSION);
            assert_eq!(r["result"]["serverInfo"]["name"], SERVER_NAME);
            assert_eq!(r["result"]["serverInfo"]["version"], env!("CARGO_PKG_VERSION"));
            assert_eq!(r["result"]["capabilities"]["tools"]["listChanged"], true);
        });
    }

    #[test]
    fn initialize_falls_back_on_unknown_version() {
        block_on(async {
            let c = core();
            let r = call(
                &c,
                r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}"#,
            )
            .await;
            assert_eq!(
                r["result"]["protocolVersion"], PROTOCOL_VERSION,
                "不认识的版本要回**我们自己最新的**（规范要求；以前错误地回最旧的 PROTOCOL_FALLBACK）"
            );
        });
    }

    #[test]
    fn parse_error_and_invalid_request_are_distinguished() {
        block_on(async {
            let c = core();
            let r = call(&c, "{ 这不是 JSON").await;
            assert_eq!(r["error"]["code"], E_PARSE);
            assert_eq!(r["id"], Value::Null);

            let r = call(&c, r#"{"jsonrpc":"1.0","id":7,"method":"ping"}"#).await;
            assert_eq!(r["error"]["code"], E_INVALID_REQUEST);

            let r = call(&c, r#"{"jsonrpc":"2.0","id":7}"#).await;
            assert_eq!(r["error"]["code"], E_INVALID_REQUEST);
        });
    }

    #[test]
    fn unknown_method_is_method_not_found() {
        block_on(async {
            let c = core();
            let r = call(&c, r#"{"jsonrpc":"2.0","id":2,"method":"tools/nope"}"#).await;
            assert_eq!(r["error"]["code"], E_METHOD_NOT_FOUND);
        });
    }

    #[test]
    fn notifications_get_no_response() {
        block_on(async {
            let c = core();
            let out = handle_raw(&c, r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).await;
            assert!(out.is_none(), "通知不应回包");
        });
    }

    #[test]
    fn ping_returns_empty_object() {
        block_on(async {
            let c = core();
            let r = call(&c, r#"{"jsonrpc":"2.0","id":3,"method":"ping"}"#).await;
            assert_eq!(r["result"], json!({}));
        });
    }

    #[test]
    fn tools_list_exposes_expected_names() {
        block_on(async {
            let c = core();
            // 内置工具已经超过一页（TOOLS_PAGE=50），所以必须**顺着游标翻完**再断言 ——
            // 只看第一页会漏掉后半页的工具（ADB 那 6 个就全在后半页）。
            let names = all_tool_names(&c).await;
            assert_eq!(
                names.len(),
                tool_defs().len(),
                "翻完所有页应当不重不漏地拿到全部内置工具"
            );
            for want in [
                "app_info",
                "mcp_status",
                "mcp_limits",
                "serial_list_ports",
                "ui_list",
                "ui_describe",
                "ui_get",
                "ui_set",
                "ui_click",
                "log_channels",
                "log_tail",
                "log_search",
                "log_stats",
                "log_clear",
                // ADB（第三批）：排在后半页，正是"只看第一页会漏掉"的那批
                "adb_list_devices",
                "adb_open_shell",
                "adb_shell_write",
                "adb_shell_read",
                "adb_shell_resize",
                "adb_close_shell",
            ] {
                assert!(names.contains(&want.to_string()), "缺少工具 {} 于 {:?}", want, names);
            }
        });
    }

    #[test]
    fn every_tool_has_name_description_and_object_schema() {
        for t in tool_defs() {
            let name = t["name"].as_str().unwrap_or("");
            assert!(!name.is_empty());
            // MCP 客户端对工具名有字符集约束，且不能用点号
            assert!(
                name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'),
                "工具名含非法字符: {}",
                name
            );
            assert!(name.len() <= 64, "工具名超过 64 字符: {}", name);
            assert!(
                !t["description"].as_str().unwrap_or("").is_empty(),
                "{} 缺 description",
                name
            );
            assert_eq!(t["inputSchema"]["type"], "object", "{} 的 schema 必须是 object", name);
            // 每个属性都得**真的约束点什么**（type / enum / oneOf…）。
            // 空 schema `{}` 在 JSON Schema 里等价于 bare `true`：什么也不约束，
            // 模型拿不到任何类型提示 —— 2026-09 由**官方 MCP Inspector** 报出来的
            // （`Schema portability: 0 errors, 2 warnings across 1 tool`，两处都在 `ui_set`）。
            let bad = bare_schemas(&t["inputSchema"], "inputSchema");
            assert!(
                bad.is_empty(),
                "{} 的 schema 里有空约束（模型拿不到类型提示）: {:?}",
                name,
                bad
            );
        }
    }

    /// 找出**没有约束力**或**可移植性差**的子 schema。递归进 `properties` 与 `items`。
    ///
    /// 两条判据都来自**官方 MCP Inspector** 的 portability 检查（2026-09 实跑）：
    /// ① 空对象 `{}` 等价于 JSON Schema 的 bare `true`，什么也不约束 —— 模型拿不到类型提示；
    /// ② `type` 写成**数组**（`["string","number"]`）虽合法，但不少客户端按单个字符串读，
    ///    会拒收工具或悄悄丢掉约束。要表达多类型请用 `anyOf`。
    fn bare_schemas(v: &Value, path: &str) -> Vec<String> {
        let mut out = Vec::new();
        if let Some(props) = v.get("properties").and_then(|p| p.as_object()) {
            for (k, sub) in props {
                let here = format!("{}.properties.{}", path, k);
                if let Some(o) = sub.as_object() {
                    if o.is_empty() {
                        out.push(here.clone());
                    }
                    if o.get("type").map(|t| t.is_array()).unwrap_or(false) {
                        out.push(format!("{}（type 是数组，客户端兼容性差，请用 anyOf）", here));
                    }
                }
                out.extend(bare_schemas(sub, &here));
            }
        }
        if let Some(items) = v.get("items") {
            let here = format!("{}.items", path);
            if let Some(o) = items.as_object() {
                if o.is_empty() {
                    out.push(here.clone());
                }
                if o.get("type").map(|t| t.is_array()).unwrap_or(false) {
                    out.push(format!("{}（type 是数组，客户端兼容性差，请用 anyOf）", here));
                }
            }
            out.extend(bare_schemas(items, &here));
        }
        out
    }

    #[test]
    fn unknown_tool_is_invalid_params_not_a_tool_error() {
        block_on(async {
            let c = core();
            let r = call(
                &c,
                r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"nope"}}"#,
            )
            .await;
            // 规范把「未知工具」归到 -32602 Invalid params（属于请求本身有问题），
            // 而不是工具执行失败 —— 后者才用 result + isError。
            assert_eq!(r["error"]["code"], E_INVALID_PARAMS, "实际: {}", r);
        });
    }

    #[test]
    fn tools_call_missing_name_is_invalid_params() {
        block_on(async {
            let c = core();
            let r = call(&c, r#"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{}}"#).await;
            assert_eq!(r["error"]["code"], E_INVALID_PARAMS);
        });
    }

    #[test]
    fn tools_call_app_info_returns_structured_content() {
        block_on(async {
            let c = core();
            let r = call(
                &c,
                r#"{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"app_info"}}"#,
            )
            .await;
            assert_eq!(r["result"]["isError"], false);
            assert_eq!(
                r["result"]["structuredContent"]["version"],
                env!("CARGO_PKG_VERSION")
            );
            assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("version="));
        });
    }

    #[test]
    fn tools_call_mcp_limits_matches_real_constants() {
        block_on(async {
            let c = core();
            let r = call(
                &c,
                r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"mcp_limits"}}"#,
            )
            .await;
            let sc = &r["result"]["structuredContent"];
            assert_eq!(sc["maxSessions"], crate::mcp::MAX_SESSIONS);
            assert_eq!(sc["sessionQueue"], crate::mcp::SESSION_QUEUE);
            assert_eq!(sc["rateLimitPerMin"], crate::mcp::RATE_LIMIT_PER_MIN);
            // 快速指令外部文件的上限也要能被客户端查到（否则对方只能靠撞墙发现）
            assert_eq!(sc["maxQuickCmdItems"], MAX_QUICK_CMD_ITEMS);
            assert_eq!(sc["maxQuickCmdLabelChars"], MAX_QUICK_CMD_LABEL_CHARS);
            assert_eq!(sc["maxQuickCmdValueChars"], MAX_QUICK_CMD_VALUE_CHARS);
            assert_eq!(sc["maxQuickCmdFileBytes"], MAX_QUICK_CMD_FILE_BYTES);
            // 每条指令的等待参数上限（这三个是**被执行**的：check_quick_cmd_item_params）
            assert_eq!(sc["maxQuickCmdTimeoutMs"], MAX_QUICK_CMD_TIMEOUT_MS);
            assert_eq!(sc["maxQuickCmdRetry"], MAX_QUICK_CMD_RETRY);
            assert_eq!(sc["maxQuickCmdExpectChars"], MAX_QUICK_CMD_EXPECT_CHARS);
            // 工作流规则的上限同样是"报出来且被执行"
            assert_eq!(sc["maxWorkflowRules"], MAX_WORKFLOW_RULES);
            assert_eq!(sc["maxWorkflowConditions"], MAX_WORKFLOW_CONDITIONS);
            assert_eq!(sc["maxWorkflowActions"], MAX_WORKFLOW_ACTIONS);
            assert_eq!(sc["maxWorkflowNameChars"], MAX_WORKFLOW_NAME_CHARS);
            assert_eq!(sc["maxWorkflowCondValueChars"], MAX_WORKFLOW_COND_VALUE_CHARS);
            assert_eq!(sc["maxWorkflowActionDataChars"], MAX_WORKFLOW_ACTION_DATA_CHARS);
            // ble_write 的单次上限（BLE 写受 MTU 限制，没有上限就等于让 AI 灌爆 WebView）
            assert_eq!(sc["maxBleWriteChars"], MAX_BLE_WRITE_CHARS);
            // ADB 的三个上限（写进设备 shell 的字符数、PTY 尺寸、一次读多少行）
            assert_eq!(sc["maxAdbWriteChars"], MAX_ADB_WRITE_CHARS);
            assert_eq!(sc["maxAdbCols"], MAX_ADB_COLS);
            assert_eq!(sc["maxAdbRows"], MAX_ADB_ROWS);
            assert_eq!(sc["maxAdbReadLines"], MAX_ADB_READ_LINES);
        });
    }

    /// panic 兜底：工具里 panic 必须变成一条 JSON-RPC 错误 + 一条错误上报，
    /// **而不是**把这条连接的任务打死（那样客户端只能干等到超时，我们也毫不知情）。
    #[test]
    fn panicking_tool_returns_jsonrpc_error_instead_of_killing_the_connection() {
        let (before_reported, _) = crate::mcp::report::stats();
        block_on(async {
            let c = core();
            let raw = r#"{"jsonrpc":"2.0","id":77,"method":"tools/call","params":{"name":"test_panic"}}"#;
            let out = handle_raw_guarded(&c, raw, "testsession")
                .await
                .expect("必须有回包（panic 不该让连接静默死亡）");
            let v: Value = serde_json::from_str(&out).unwrap();
            assert_eq!(v["error"]["code"], E_INTERNAL, "{}", out);
            let msg = v["error"]["message"].as_str().unwrap_or("");
            assert!(msg.contains("故意的 panic"), "错误消息要带上 panic 原因: {}", msg);
            assert!(msg.contains("已上报"), "要告诉调用方「已上报」: {}", msg);
        });
        let (after_reported, _) = crate::mcp::report::stats();
        assert!(
            after_reported > before_reported,
            "panic 必须进错误上报（{} → {}）",
            before_reported,
            after_reported
        );
    }

    /// **规范级检查**：每个工具的 `structuredContent` 必须是**对象**。
    ///
    /// 这条正是官方 Python SDK 抓到的那个 bug（`serial_list_ports` 曾经直接返回数组，
    /// pydantic 校验 `Input should be a valid dictionary` 把整条结果判为非法）。
    /// 用它把"靠外部 SDK 才能发现"的东西变成 CI 里就能挡住的单测。
    #[test]
    fn every_tool_result_structured_content_is_an_object() {
        block_on(async {
            let c = core();
            // 只挑不依赖界面/设备、能在测试里真跑的工具；ui_* 与需要设备的另测
            let names = [
                "app_info",
                "mcp_status",
                "mcp_limits",
                "serial_list_ports",
                "log_channels",
                "log_stats",
                "mcp_calls",
                "mcp_stats",
                "mcp_config_get",
                // ADB 的读输出是**纯后端**（读日志中心的 adb:rx），没有界面也该是对象
                "adb_shell_read",
            ];
            for name in names {
                let raw = format!(
                    r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"{}"}}}}"#,
                    name
                );
                let out = handle_raw_guarded(&c, &raw, "t").await.expect("有回包");
                let v: Value = serde_json::from_str(&out).unwrap();
                let sc = &v["result"]["structuredContent"];
                assert!(
                    sc.is_object(),
                    "工具 {} 的 structuredContent 必须是对象（规范要求），实际是 {}: {}",
                    name,
                    if sc.is_array() { "数组" } else { "非对象" },
                    sc.to_string().chars().take(120).collect::<String>()
                );
            }
        });
    }

    #[test]
    fn tool_calls_are_counted_in_status() {
        block_on(async {
            let c = core();
            let _ = call(
                &c,
                r#"{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"app_info"}}"#,
            )
            .await;
            let st = c.status_json();
            assert_eq!(st["toolCalls"]["app_info"], 1);
            assert_eq!(st["requests"], 1);
        });
    }

    /// BLE **从机（外设）**方向的三个工具被**故意删除**（2026-09，用户确认"实现不了了"）：
    /// 本机适配器自报支持外设角色，但实测**广播起不来**（`ble_periph_starts_advertising`
    /// 一直是失败的那条，`doc/BLE_PERIPHERAL.md` §5）—— 交付不了的功能不该留在工具表里
    /// （工具表是 AI 的"我能做什么"清单，留着它等于让 AI 去点一个必然失败的功能）。
    ///
    /// 这条守着两件事：① 别哪天顺手又加回来（要加先把广播问题解决）；
    /// ② 旧客户端拿着旧名字调过来时，报错必须**指路**（工具定义编译在 exe 里，
    /// 客户端要重连才会重读 `tools/list`）。
    #[test]
    fn ble_peripheral_tools_are_gone_and_the_old_names_point_somewhere() {
        let names: Vec<String> = tool_defs()
            .iter()
            .filter_map(|t| t["name"].as_str().map(|s| s.to_string()))
            .collect();
        for gone in ["ble_periph_status", "ble_periph_start", "ble_periph_stop"] {
            assert!(!names.iter().any(|n| n == gone), "{} 已删除（理由见本测试注释）", gone);
            // 危险工具表里也不该再留着它们（否则只读模式的拦截表会指向不存在的工具）
            assert!(
                !DANGER_TOOLS.iter().any(|(n, _)| *n == gone),
                "{} 已删除，危险工具表里也要清掉",
                gone
            );
        }
        block_on(async {
            let c = core();
            for gone in ["ble_periph_status", "ble_periph_start", "ble_periph_stop"] {
                let r = call(&c, &raw_call(gone, &json!({ "confirm": true }))).await;
                assert_eq!(r["error"]["code"], E_INVALID_PARAMS, "{}: {}", gone, r);
                let msg = r["error"]["message"].as_str().unwrap_or("");
                assert!(msg.contains("已删除"), "{} 要说清它没了: {}", gone, msg);
                assert!(
                    msg.contains("ble_start_scan") && msg.contains("ble_connect"),
                    "{} 要给出仍可用的主机方向工具，否则 AI 只能反复试: {}",
                    gone,
                    msg
                );
            }
        });
    }

    /// `log_export` 被**故意删除**了（2026-09，用户要求）：它是唯一能把"全量日志"
    /// 一次塞进返回体的工具（省略 `channels` = 全部通道 × 上限 20000 行/通道），
    /// 而**返回体没有大小上限**（`MAX_BODY_BYTES` 只管请求体）—— 一次调用就可能拼出
    /// 几十 MB，撑爆 AI 的上下文、客户端解析也会打摆。
    ///
    /// 这条守着两件事：① 别哪天顺手又加回来（要加先给它响应体上限或落盘路径）；
    /// ② 旧客户端拿着 `log_export` 调过来时，报错必须**指路**（工具定义编译在 exe 里，
    /// 客户端要重连才会刷新 `tools/list`，光回"未知工具"会让 AI 反复试同一个名字）。
    #[test]
    fn log_export_is_gone_and_the_old_name_points_somewhere() {
        let names: Vec<String> = tool_defs()
            .iter()
            .filter_map(|t| t["name"].as_str().map(|s| s.to_string()))
            .collect();
        assert!(
            !names.iter().any(|n| n == "log_export"),
            "log_export 已被删除（理由见本测试注释）"
        );
        block_on(async {
            let c = core();
            let r = call(&c, &raw_call("log_export", &json!({}))).await;
            assert_eq!(r["error"]["code"], E_INVALID_PARAMS, "{}", r);
            let msg = r["error"]["message"].as_str().unwrap_or("");
            assert!(msg.contains("已删除"), "要说清它没了: {}", msg);
            assert!(
                msg.contains("log_tail") && msg.contains("log_search"),
                "要给替代方案，否则 AI 只能反复试同一个名字: {}",
                msg
            );
        });
    }

    /// `log_clear` 与 `log_tail` 对"通道名打错"必须**给出同样的答案**（都报 -32602）。
    /// 以前 log_clear 静默返回 clearedChannels:0，调用方会以为清干净了。
    #[test]
    fn clearing_an_unknown_channel_is_an_error_like_tailing_one() {
        let _g = hub_lock();
        block_on(async {
            let c = core();
            let hub = crate::mcp::loghub::hub();
            hub.set_enabled(true);
            hub.push("ui:sys", crate::mcp::loghub::LEVEL_INFO, 0, "x", 0);

            let bad = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"log_clear","arguments":{"channel":"no:such:a"}}}"#;
            let v = call(&c, bad).await;
            assert_eq!(
                v["error"]["code"], E_INVALID_PARAMS,
                "清不存在的通道应报 -32602 而不是假装成功: {}",
                v
            );
            // 存在的通道照常能清
            let good = r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"log_clear","arguments":{"channel":"ui:sys"}}}"#;
            let v = call(&c, good).await;
            assert_eq!(v["result"]["isError"], false, "{}", v);
            // 不带通道 = 清全部，必须仍然允许
            let all = r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"log_clear","arguments":{}}}"#;
            let v = call(&c, all).await;
            assert_eq!(v["result"]["isError"], false, "{}", v);
        });
    }

    /// 读串口收发内容（`serial_get_output` 的核心逻辑）。
    /// ① **没数据时不是错误** —— 这是它相对 `log_tail` 的关键差别（`log_tail` 对不存在的
    /// 通道报 -32602，AI 会误以为"不支持读串口数据"）；② 收/发两通道要**按时间归并**
    /// （seq 各自独立，不能按通道拼接）；③ direction 过滤；④ 截断留最近的并标记。
    #[test]
    fn serial_output_reads_rx_tx_and_treats_missing_channel_as_empty() {
        let _g = hub_lock();
        let hub = crate::mcp::loghub::hub();
        hub.set_enabled(true);
        let chans = json!({ "rx": "serial:t1:rx", "tx": "serial:t1:tx" });

        // ① 通道还不存在（一条数据都没流过）→ 空列表，不报错
        let p = collect_serial_output(&chans, "both", 50, crate::mcp::loghub::LogFormat::Json);
        assert!(p.items.is_empty(), "没数据就该是空列表: {}", p.items.len());
        assert!(!p.truncated);
        assert_eq!(p.per_dir["rx"]["count"], 0);
        assert!(
            p.per_dir["rx"]["note"].as_str().unwrap().contains("还没有数据"),
            "要说清是'还没数据'而不是'读不到': {}",
            p.per_dir["rx"]
        );

        // ② 两个方向按时间归并（seq 各自独立，只能靠 ts 排序；push_at 是为了钉住时间戳）
        hub.push_at("serial:t1:rx", crate::mcp::loghub::LEVEL_INFO, crate::mcp::loghub::DIR_RX, 2000, "OK", 2);
        hub.push_at("serial:t1:tx", crate::mcp::loghub::LEVEL_INFO, crate::mcp::loghub::DIR_TX, 1000, "AT", 2);
        hub.push_at("serial:t1:rx", crate::mcp::loghub::LEVEL_INFO, crate::mcp::loghub::DIR_RX, 3000, "OK2", 3);
        let p = collect_serial_output(&chans, "both", 50, crate::mcp::loghub::LogFormat::Json);
        let order: Vec<&str> = p.items.iter().map(|l| l["text"].as_str().unwrap()).collect();
        assert_eq!(order, vec!["AT", "OK", "OK2"], "必须按时间归并，不是按通道拼接");
        let dirs: Vec<&str> = p.items.iter().map(|l| l["dir"].as_str().unwrap()).collect();
        assert_eq!(dirs, vec!["tx", "rx", "rx"]);
        assert_eq!(p.per_dir["rx"]["count"], 2);
        assert_eq!(p.per_dir["tx"]["count"], 1);

        // ③ 只要一个方向
        let p = collect_serial_output(&chans, "rx", 50, crate::mcp::loghub::LogFormat::Json);
        assert_eq!(p.items.len(), 2);
        assert!(p.per_dir.get("tx").is_none(), "只要 rx 时不该返回 tx: {}", p.per_dir);

        // ④ 截断：留最近的，并明确标记
        let p = collect_serial_output(&chans, "both", 2, crate::mcp::loghub::LogFormat::Json);
        assert!(p.truncated, "3 行只要 2 行必须标记 truncated");
        let order: Vec<&str> = p.items.iter().map(|l| l["text"].as_str().unwrap()).collect();
        assert_eq!(order, vec!["OK", "OK2"], "截断要留**最近**的: {:?}", order);

        // ⑤ 文本编码：同一批数据换个写法 —— 行数/方向/时刻都得在，且**方向不能丢**
        let t = collect_serial_output(&chans, "both", 50, crate::mcp::loghub::LogFormat::Text);
        assert_eq!(t.count, 3, "两种编码的 count 必须一致");
        assert!(t.items.is_empty(), "text 编码不该再给逐行结构（等于计费两次）");
        assert_eq!(t.per_dir["rx"]["count"], 2, "元信息两种编码下一致");
        assert!(t.text.contains("AT") && t.text.contains("OK2"), "正文要在: {}", t.text);
        assert!(t.text.contains("[tx]") && t.text.contains("[rx]"), "方向要标出来: {}", t.text);
        assert_eq!(t.text.matches('\n').count(), 3, "一行一条: {:?}", t.text);

        hub.clear(Some("serial:t1:rx"));
        hub.clear(Some("serial:t1:tx"));
    }

    /// 文本页的头部是**唯一**交代"这一页多大、有没有被截、两个方向各丢过没有"的地方
    /// （正文里只有时刻/方向/内容）。省 token 不能省掉这些 —— 少了它，
    /// `format:"text"` 就等于让 AI 把被裁过的日志当成完整证据（AGENTS #6）。
    #[test]
    fn serial_text_header_carries_the_drop_accounting() {
        let page = SerialOutputPage {
            per_dir: json!({
                "rx": { "channel": "serial:main:rx", "count": 3, "dropped": 7, "mayBeIncomplete": true },
                "tx": { "channel": "serial:main:tx", "count": 0, "dropped": 0, "mayBeIncomplete": false },
            }),
            items: Vec::new(),
            text: String::new(),
            count: 3,
            truncated: true,
        };
        let head = serial_text_header(&json!({ "pane": "main", "direction": "both" }), &page);
        assert!(
            head.starts_with("# pane=main direction=both count=3 truncated=true"),
            "{}",
            head
        );
        assert!(head.contains("rx count=3 dropped=7 mayBeIncomplete=true"), "{}", head);
        assert!(head.contains("tx count=0 dropped=0 mayBeIncomplete=false"), "{}", head);
        assert_eq!(head.matches('\n').count(), 1, "头部只占一行: {:?}", head);
    }

    /// 「MCP 不能影响主程序」这条要求，落到代码上就是**外部输入必须有界**。
    /// 这里钉住两个曾经无界的入口：① `ui_set.items` 跑在 WebView 主线程上（1 MiB 请求体
    /// 能塞两万多条 → 界面冻住）；② `serial_send.data` 进的是串口写队列（1 MiB 在 115200
    /// 波特下要发一分半钟 → 压住用户的串口会话）。
    #[test]
    fn unbounded_inputs_are_rejected_before_touching_the_app() {
        block_on(async {
            let c = core();

            // ① ui_set.items 超上限 → 协议级 -32602（在**下发到界面之前**就被挡住）
            let many: Vec<Value> = (0..=MAX_UI_SET_ITEMS)
                .map(|i| json!({ "path": format!("x.y.z{}", i), "value": i }))
                .collect();
            let raw = json!({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": { "name": "ui_set", "arguments": { "items": many } }
            })
            .to_string();
            let r = call(&c, &raw).await;
            assert_eq!(r["error"]["code"], E_INVALID_PARAMS, "{}", r);
            let msg = r["error"]["message"].as_str().unwrap_or("");
            assert!(msg.contains("分批"), "要告诉 AI 怎么办: {}", msg);
            assert!(
                msg.contains(&MAX_UI_SET_ITEMS.to_string()),
                "要说清上限是多少: {}",
                msg
            );

            // 边界：刚好等于上限不该被判成参数错（这里没有 GUI，所以会走 -32006，但**不是** -32602）
            let ok: Vec<Value> = (0..MAX_UI_SET_ITEMS)
                .map(|i| json!({ "path": format!("x.y.z{}", i), "value": i }))
                .collect();
            let raw = json!({
                "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                "params": { "name": "ui_set", "arguments": { "items": ok } }
            })
            .to_string();
            let r = call(&c, &raw).await;
            assert_ne!(r["error"]["code"], E_INVALID_PARAMS, "刚好到上限不该被拒: {}", r);

            // ② serial_send 超量 → 协议级 -32602，且**没有碰过界面的发送框**
            let big = "A".repeat(MAX_SEND_CHARS + 1);
            let raw = json!({
                "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": { "name": "serial_send", "arguments": { "data": big } }
            })
            .to_string();
            let r = call(&c, &raw).await;
            assert_eq!(r["error"]["code"], E_INVALID_PARAMS, "{}", r);
            assert!(
                r["error"]["message"].as_str().unwrap_or("").contains("分批"),
                "{}",
                r
            );

            // 上限本身要能被客户端查到（mcp_limits），否则对方只能靠撞墙发现
            let lim = limits_json();
            assert_eq!(lim["maxUiSetItems"], json!(MAX_UI_SET_ITEMS));
            assert_eq!(lim["maxSendChars"], json!(MAX_SEND_CHARS));
        });
    }

    /// 组装一条 `tools/call` 报文
    fn raw_call(name: &str, args: &Value) -> String {
        json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": name, "arguments": args }
        })
        .to_string()
    }

    /// 递归找出返回里"像字段名却是蛇形"的键。
    ///
    /// 两类豁免（都不是我们的字段）：① 键正好是个工具名（`toolCalls.serial_send` 这类
    /// map 键）；② `args` 子树（那是**回显调用方原样传的参数**，不是我们定义的字段，
    /// 调用方用旧拼写也不该让契约测试红）。
    fn snake_keys_in(v: &Value, tool_names: &[String], in_args: bool) -> Vec<String> {
        let mut out = Vec::new();
        match v {
            Value::Object(m) => {
                for (k, val) in m {
                    let is_tool_name = tool_names.iter().any(|t| t == k);
                    if !in_args && !is_tool_name && k.contains('_') {
                        out.push(k.clone());
                    }
                    out.extend(snake_keys_in(val, tool_names, in_args || k == "args"));
                }
            }
            Value::Array(a) => {
                for x in a {
                    out.extend(snake_keys_in(x, tool_names, in_args));
                }
            }
            _ => {}
        }
        out
    }

    /// 文本摘要**必须把数据说出来**，不能只有 "N 项"。
    ///
    /// 这条就是为了钉住用户报的那个现象：`serial_list_ports` 的文本曾经是
    /// `count=1, ports=1 项` —— 端口名一个字都没有，只读文本的客户端等于没拿到数据。
    /// 做法：找第一个非空数组，取第一个元素的叶子值，要求它出现在文本里。
    fn assert_text_surfaces_data(tool: &str, sc: &Value, text: &str) {
        let Some(arr) = sc
            .as_object()
            .and_then(|m| m.values().find(|v| v.as_array().map(|a| !a.is_empty()).unwrap_or(false)))
            .and_then(|v| v.as_array())
        else {
            return; // 没有数组数据 → 这条不适用
        };
        let mut leaves: Vec<String> = Vec::new();
        let mut walk = |v: &Value| match v {
            Value::String(s) if s.chars().count() >= 2 => leaves.push(s.clone()),
            Value::Number(n) => leaves.push(n.to_string()),
            _ => {}
        };
        match &arr[0] {
            Value::Object(m) => m.values().for_each(&mut walk),
            other => walk(other),
        }
        assert!(
            leaves.iter().any(|l| text.contains(l.as_str())),
            "{} 的文本摘要没把数据说出来（数据里是 {:?}，文本却是 {:?}）—— \
             只读文本的客户端会以为这个工具不返回内容",
            tool,
            leaves,
            text
        );
    }

    /// 每个工具的**返回值契约**（表驱动，覆盖全部内置工具）。
    ///
    /// 起因是用户的一句话："每一个工具的返回值都应该需要测试啊，不然预期的结果怎么确定
    /// 是否已经完成？" —— 在这之前"返回结构"只写在文档里（手抄的），没有任何测试钉住。
    /// 代价是两个问题一直活到真机、靠人眼看输出才发现：
    ///   · `serial_list_ports` 的字段是 `port_name`（蛇形），而其余工具全是驼峰；
    ///   · 它的文本摘要把数组写成 `ports=1 项`，**端口名一个字都没有**。
    ///
    /// 三条**全局不变量**（对所有工具生效，不靠人记）：
    /// ① `structuredContent` 存在时**必须是对象**（规范要求；数组会被严格客户端整条拒收）；
    /// ② 返回的键必须是 **camelCase**；
    /// ③ 文本摘要必须真的把数据说出来（见 `assert_text_surfaces_data`）。
    #[test]
    fn every_tool_has_a_tested_return_contract() {
        let _g = hub_lock();
        block_on(async {
            let c = core();
            // 预建 `app` 通道：下面 `log_tail` 的契约用例要读它（json / text 两条），
            // 而 LogHub 是**进程级共享状态** —— 不预建的话"单跑这一个用例"会因为
            // 通道还没被别的用例建出来而报 -32602（2026-09 记录过的隐式依赖）。
            // `ensure_channel` 不写内容、也不要求 hub 处于启用态。
            crate::mcp::loghub::hub().ensure_channel("app");
            enum Expect {
                /// 纯后端工具：实调成功。第一个是**必需**字段，第二个是**可能缺席**的
                /// （例如 `urlMasked` 只在服务器跑起来、拿到端口与 token 后才出现）。
                /// 两个列表之外的字段一律算违约 —— 改了返回值就要来改这里。
                Backend(&'static [&'static str], &'static [&'static str]),
                /// 依赖界面：没有 GUI 时必须 result + `isError:true` + `-32006`
                NoGui,
                /// 不实调（有副作用），只走"缺必填 → -32602"；注明谁在管它
                NoCall(&'static str),
            }
            use Expect::*;
            let table: Vec<(&str, Value, Expect)> = vec![
                // ===== 纯后端（没有界面也该成功）=====
                ("app_info", json!({}), Backend(&["arch", "name", "os", "pid", "profile", "uptimeSecs", "version"], &[])),
                ("mcp_limits", json!({}), Backend(&[
                    "heartbeatSecs", "idleTimeoutSecs", "logMaxChannels", "logMaxLineBytes",
                    "logTotalCapBytes", "maxBodyBytes", "maxBleWriteChars", "maxSendChars", "maxSessions",
                    "maxUiSetItems", "maxUiSetValueChars", "protocolFallback", "protocolVersion", "rateLimitPerMin",
                    "sessionQueue", "toolsPage",
                    // 检索类参数的上限（三个"读日志"工具共用；**被执行**）
                    "maxSearchPatternChars", "maxSearchContextLines",
                    // ADB：写进设备 shell 的字符数 / PTY 尺寸 / 一次读多少行
                    "maxAdbWriteChars", "maxAdbCols", "maxAdbRows", "maxAdbReadLines",
                    // 快速指令外部文件的上限（加字段就要一起改这里，契约测试会拦）
                    "maxQuickCmdItems", "maxQuickCmdLabelChars", "maxQuickCmdValueChars",
                    "maxQuickCmdFileBytes",
                    // 每条指令的等待参数（**这三个是被执行的**：check_quick_cmd_item_params）
                    "maxQuickCmdTimeoutMs", "maxQuickCmdRetry", "maxQuickCmdExpectChars",
                    // 工作流规则（同样是**被执行**的：check_workflow_args）
                    "maxWorkflowRules", "maxWorkflowConditions", "maxWorkflowActions",
                    "maxWorkflowNameChars", "maxWorkflowCondValueChars", "maxWorkflowActionDataChars",
                ], &[])),
                ("mcp_status", json!({}), Backend(&[
                    "builtinToolCount", "callLog", "configFile", "dropped", "enabled", "endpointFile",
                    "errorReports", "hasUi", "host", "lastError", "limits", "logHub", "maxSessions",
                    "port", "readOnly", "registry", "requests", "running", "sessions", "stateChanges",
                    "statusEmits", "streamableHttp", "tokenMasked", "toolCalls", "toolCount", "transport",
                    "uiInFlight", "uptimeSecs", "version",
                ], &["urlMasked", "streamableUrlMasked"])),
                ("serial_list_ports", json!({}), Backend(&["count", "ports"], &[])),
                ("log_channels", json!({}), Backend(&[
                    "channelCount", "channelSkips", "channels", "enabled", "lockSkips",
                    "maxChannels", "reclaimedBytes", "reclaims", "totalBytes", "totalCapBytes",
                ], &[])),
                ("log_stats", json!({}), Backend(&[
                    "channelSkips", "channels", "enabled", "lockSkips", "maxChannels",
                    "reclaimedBytes", "reclaims", "totalBytes", "totalCapBytes",
                ], &[])),
                ("log_tail", json!({ "channel": "app", "lines": 3 }), Backend(&[
                    "channel", "dropped", "format", "lines", "mayBeIncomplete", "missed",
                    "nextSinceSeq", "returned", "seqFrom", "seqTo", "truncated",
                ], &[])),
                // text 编码：载荷搬到 content 文本里，structuredContent 只剩元信息
                // （`text` 这一项此时**故意**不存在；要日志正文就看 content 文本）
                ("log_tail", json!({ "channel": "app", "lines": 3, "format": "text" }), Backend(&[
                    "channel", "dropped", "format", "mayBeIncomplete", "missed",
                    "nextSinceSeq", "returned", "seqFrom", "seqTo", "truncated",
                ], &[])),
                ("log_search", json!({ "pattern": "mcp" }), Backend(&[
                    "hits", "mode", "pattern", "regex", "scanned", "truncated",
                ], &[])),
                // 三档模式各有自己的返回形状：`count` 连 hits 都不该有
                // （有的话调用方会以为"顺手给了命中行"，那份文本就是白花的 token）
                ("log_search", json!({ "pattern": "mcp", "mode": "count" }), Backend(&[
                    "channels", "mode", "pattern", "regex", "scanned", "scannedChannels",
                    "total", "totalMatches", "truncated",
                ], &[])),
                ("log_search", json!({ "pattern": "mcp", "mode": "matches" }), Backend(&[
                    "hits", "mode", "pattern", "regex", "scanned", "truncated",
                ], &[])),
                ("mcp_calls", json!({ "limit": 2 }), Backend(&["calls", "enabled", "file", "note", "returned", "scanned", "tailOnly"], &[])),
                ("mcp_stats", json!({}), Backend(&["callLog", "sessionToolCalls"], &[])),
                ("mcp_config_get", json!({}), Backend(&["callLog", "expose", "server", "version"], &[])),
                // ===== 依赖界面（单测里没有 AppHandle）=====
                ("serial_get_state", json!({}), NoGui),
                ("serial_select_port", json!({ "port": "COM1" }), NoGui),
                ("serial_set_baud", json!({ "baud": 115200 }), NoGui),
                ("serial_set_frame", json!({ "dataBits": 8 }), NoGui),
                ("serial_set_lines", json!({ "dtr": true }), NoGui),
                ("serial_set_display", json!({ "echo": true }), NoGui),
                ("serial_open", json!({}), NoGui),
                ("serial_close", json!({}), NoGui),
                ("serial_send", json!({ "data": "AT" }), NoGui),
                ("serial_clear", json!({}), NoGui),
                ("serial_get_history", json!({}), NoGui),
                ("serial_get_output", json!({}), NoGui),
                ("serial_quick_cmd", json!({}), NoGui),
                // 工作流：无界面时同样必须是 isError + -32006；启停那条还要过危险门（表里给了 confirm）
                ("serial_workflow", json!({}), NoGui),
                ("serial_workflow_run", json!({ "rule": "wf_x", "on": true, "confirm": true }), NoGui),
                // BLE 语义工具（第一批）：无界面时同样必须是 isError + -32006
                ("ble_get_state", json!({}), NoGui),
                ("ble_list_devices", json!({}), NoGui),
                ("ble_get_services", json!({}), NoGui),
                ("ble_read", json!({ "char": "0x2a00" }), NoGui),
                ("ble_subscribe", json!({ "char": "0x2a00", "on": true }), NoGui),
                ("ble_write", json!({ "char": "0000fff1-0000-1000-8000-00805f9b34fb", "data": "AT", "format": "text" }), NoGui),
                ("ble_connect", json!({ "addr": "AA:BB:CC:DD:EE:FF" }), NoGui),
                ("ble_disconnect", json!({}), NoGui),
                ("ble_get_output", json!({}), NoGui),
                ("ble_refresh_rssi", json!({}), NoGui),
                ("ble_start_scan", json!({}), NoGui),
                ("ble_stop_scan", json!({}), NoGui),
                // （BLE 从机三个工具已删除 → 见 `log_export_is_gone...` 旁边那条同类守护测试）
                // ADB 语义工具（§16.6.2 第三批）：读输出是纯后端，其余都经前端 mcpAdbOp
                // （两个危险动作照旧要求 confirm，没带就根本走不到界面那一步）
                ("adb_list_devices", json!({}), NoGui),
                ("adb_open_shell", json!({ "confirm": true }), NoGui),
                ("adb_shell_write", json!({ "data": "ls -l\n", "confirm": true }), NoGui),
                ("adb_shell_read", json!({ "limit": 5 }), Backend(&[
                    "serial", "channel", "count", "items", "mode", "scanned", "truncated",
                    "dropped", "mayBeIncomplete",
                ], &["note"])),
                // 检索档的形状（给了 pattern + mode）：count 不给条目、matches 只给片段
                ("adb_shell_read", json!({ "pattern": "x", "mode": "count" }), Backend(&[
                    "serial", "channel", "count", "scanned", "truncated", "dropped", "mayBeIncomplete",
                    "mode", "pattern", "regex", "total", "totalMatches",
                ], &["note"])),
                ("adb_shell_read", json!({ "pattern": "x", "mode": "matches" }), Backend(&[
                    "serial", "channel", "count", "scanned", "truncated", "dropped", "mayBeIncomplete",
                    "mode", "pattern", "regex", "hits",
                ], &["note"])),
                ("adb_shell_resize", json!({ "cols": 120, "rows": 40 }), NoGui),
                ("adb_close_shell", json!({}), NoGui),
                // 危险工具表本身是纯后端只读：不需要界面（"有哪些危险动作"不该依赖 GUI）
                ("mcp_danger", json!({}), Backend(&["tools", "total", "note"], &[])),
                ("ui_list", json!({}), NoGui),
                ("ui_describe", json!({ "path": "serial.conn.portSelect" }), NoGui),
                ("ui_get", json!({ "path": "serial.conn.portSelect" }), NoGui),
                ("ui_set", json!({ "path": "serial.conn.portSelect", "value": "COM1" }), NoGui),
                ("ui_get_state", json!({}), NoGui),
                ("ui_click", json!({ "path": "serial.toolbar.btnStart" }), NoGui),
                // ===== 有副作用，故意不实调 =====
                ("log_clear", json!({}), NoCall("会清空全局日志中心；由 clearing_an_unknown_channel_is_an_error_like_tailing_one 覆盖")),
                ("mcp_config_set", json!({}), NoCall("会写用户的 ai-config.json；由缺 patch / patch 非对象的用例覆盖")),
            ];

            // ① 表必须覆盖**全部**内置工具（新增工具时必须一起想清契约）
            let tool_names: Vec<String> = tool_defs()
                .iter()
                .filter_map(|t| t["name"].as_str().map(|s| s.to_string()))
                .collect();
            let listed: Vec<String> = table.iter().map(|(n, _, _)| n.to_string()).collect();
            for n in &tool_names {
                assert!(listed.contains(n), "工具 {} 没有返回值契约，请补进这张表", n);
            }
            for n in &listed {
                assert!(tool_names.contains(n), "契约表里的 {} 已经不是内置工具了", n);
            }

            // ② 声明了 required 的工具，缺参必须是协议级 -32602（顺带验证"每个 required 真的被校验"）
            for t in tool_defs() {
                let name = t["name"].as_str().unwrap_or("");
                let req = t["inputSchema"]["required"].as_array().cloned().unwrap_or_default();
                if req.is_empty() {
                    continue;
                }
                // 危险工具要先补一个 confirm：危险门故意排在 required 校验**之前**
                // （没确认就什么都别做），不给 confirm 就永远测不到"缺必填 → -32602"这一层。
                let mut args = json!({});
                if danger_note(name).is_some() {
                    args["confirm"] = json!(true);
                }
                let r = call(&c, &raw_call(name, &args)).await;
                assert_eq!(
                    r["error"]["code"], E_INVALID_PARAMS,
                    "{} 声明了 required{:?}，缺参却没报 -32602: {}",
                    name,
                    req.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>(),
                    r
                );
            }

            // ③ 逐个工具核对契约 + 三条全局不变量
            for (name, args, expect) in &table {
                match expect {
                    Backend(required_keys, optional_keys) => {
                        let r = call(&c, &raw_call(name, args)).await;
                        assert!(r.get("error").is_none(), "{} 不该是协议错误: {}", name, r);
                        assert_eq!(r["result"]["isError"], false, "{} 不该失败: {}", name, r);
                        let sc = &r["result"]["structuredContent"];
                        assert!(sc.is_object(), "{} 的 structuredContent 必须是对象: {}", name, sc);
                        let got: Vec<String> =
                            sc.as_object().unwrap().keys().cloned().collect();
                        for k in *required_keys {
                            assert!(got.iter().any(|g| g == k), "{} 少了字段 {}（实际: {:?}）", name, k, got);
                        }
                        for g in &got {
                            assert!(
                                required_keys.contains(&g.as_str())
                                    || optional_keys.contains(&g.as_str()),
                                "{} 多出未登记的字段 {}：改了返回值就更新契约表（实际: {:?}）",
                                name,
                                g,
                                got
                            );
                        }
                        let bad = snake_keys_in(sc, &tool_names, false);
                        assert!(bad.is_empty(), "{} 返回里混进了蛇形字段名 {:?}", name, bad);
                        let text = r["result"]["content"][0]["text"].as_str().unwrap_or("");
                        assert_text_surfaces_data(name, sc, text);
                    }
                    NoGui => {
                        let r = call(&c, &raw_call(name, args)).await;
                        assert!(r.get("error").is_none(), "{} 无界面时不该是协议错误: {}", name, r);
                        assert_eq!(r["result"]["isError"], true, "{} 无界面时应 isError:true: {}", name, r);
                        let text = r["result"]["content"][0]["text"].as_str().unwrap_or("");
                        assert!(
                            text.contains("-32006"),
                            "{} 要说清是「没有界面上下文」(-32006)，而不是含糊失败: {}",
                            name,
                            text
                        );
                    }
                    NoCall(_why) => {}
                }
            }
        });
    }

    /// `want` 是否是 `got` 的子集（对象按键递归、数组按位置递归）——
    /// 用来只断言"关心的那部分参数"，不必把整条 payload 抄一遍。
    fn json_subset(got: &Value, want: &Value) -> bool {
        match (got, want) {
            (Value::Object(g), Value::Object(w)) => w
                .iter()
                .all(|(k, wv)| g.get(k).map(|gv| json_subset(gv, wv)).unwrap_or(false)),
            (Value::Array(g), Value::Array(w)) => w
                .iter()
                .enumerate()
                .all(|(i, wv)| g.get(i).map(|gv| json_subset(gv, wv)).unwrap_or(false)),
            _ => got == want,
        }
    }

    /// **每个界面工具的调用情况**（表驱动）：不只是"能调通"，而是钉住
    /// **发给前端的 op / 参数** 与 **拿到回执后的最终返回**。
    ///
    /// 起因（用户两次追问）：在那之前这 19 个界面工具只被调到"没有界面上下文"（-32006）就结束，
    /// 等于**一次调用路径都没跑过** —— 参数拼错了、回执解析错了，测试全绿。
    /// 现在 `McpCore` 有单测专用的假前端（`test_ui`），这里把每个工具真的调一遍。
    ///
    /// ⚠️ 假前端只证明 **Rust 这一半**（参数构造 + 回执解析 + 返回值形状）。
    /// 前端那一半由 `.walkthrough/gen_ble_preview.js` 用**真实 handler**跑（同一个 op 名）——
    /// 只测一边就是假的安心。
    #[test]
    fn every_ui_tool_sends_the_expected_op_and_returns_expected_shape() {
        let _g = hub_lock(); // serial_get_output 会读全局日志中心，跟着其他用例串行
        block_on(async {
            use std::sync::atomic::{AtomicBool, Ordering};
            let c = core();
            let calls: std::sync::Arc<std::sync::Mutex<Vec<(String, Value)>>> =
                std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let connected = std::sync::Arc::new(AtomicBool::new(false));
            {
                let calls = calls.clone();
                let connected = connected.clone();
                let mut slot = c.test_ui.lock().unwrap_or_else(|e| e.into_inner());
                *slot = Some(Box::new(move |op: &str, payload: &Value| {
                    calls
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .push((op.to_string(), payload.clone()));
                    // 假前端只做"够驱动各工具解析路径"的最小仿真
                    match op {
                        "serial" => {
                            let action = payload["action"].as_str().unwrap_or("");
                            match action {
                                "state" => json!({ "ok": true, "value": {
                                    "pane": payload["pane"].as_str().unwrap_or("main"),
                                    "isConnected": connected.load(Ordering::Relaxed),
                                    // 通道名由前端给出（serial_get_output 靠它去读日志中心）
                                    "logChannels": { "rx": "serial:main:rx", "tx": "serial:main:tx" },
                                }}),
                                "apply" => {
                                    let items = payload["items"].as_array().cloned().unwrap_or_default();
                                    let applied: Vec<Value> = items
                                        .iter()
                                        .map(|it| json!({ "name": it["name"], "ok": true, "to": it["value"] }))
                                        .collect();
                                    json!({ "ok": true, "value": { "pane": "main", "applied": applied } })
                                }
                                "click" => {
                                    // 真界面上「开始/停止监控」是**同一个按钮**（点一次切换一次），
                                    // 所以这里必须 toggle 而不是"设为 true"——否则 close 永远等不到断开
                                    // （第一版就写错了，被这条用例抓出来）。
                                    let was = connected.load(Ordering::Relaxed);
                                    connected.store(!was, Ordering::Relaxed);
                                    json!({ "ok": true, "value": { "pane": "main", "clicked": payload["name"] } })
                                }
                                "send" => json!({ "ok": true, "value": {
                                    "pane": "main", "sent": true, "mode": "text", "bytes": 2, "data": "AT",
                                }}),
                                "clear" => json!({ "ok": true, "value": { "pane": "main", "cleared": true, "outputLines": 0 } }),
                                "history" => json!({ "ok": true, "value": { "pane": "main", "total": 1, "items": [{ "data": "AT" }] } }),
                                "quickList" => json!({ "ok": true, "value": {
                                    "pane": "main", "items": [{ "index": 0, "label": "AT", "value": "AT" }], "usable": 1,
                                }}),
                                "quickRun" => json!({ "ok": true, "value": { "pane": "main", "ran": 0, "label": "AT", "value": "AT" } }),
                                // 循环开关 / 改列表：这里只回"前端会回的那些字段"，用于钉住工具层的返回形状
                                "quickLoop" => json!({ "ok": true, "value": {
                                    "pane": "main", "loop": true, "planLength": 1, "changed": true,
                                }}),
                                "quickAdd" => json!({ "ok": true, "value": {
                                    "pane": "main", "index": 1, "group": "循环 1", "groupIndex": 0, "itemIndex": 1,
                                    "applied": ["value", "seq", "timeoutMs", "expect", "retry", "hex"],
                                }}),
                                "quickUpdate" => json!({ "ok": true, "value": {
                                    "pane": "main", "index": 0, "group": "循环 1", "itemIndex": 0, "applied": ["value", "seq"],
                                }}),
                                "quickRemove" => json!({ "ok": true, "value": {
                                    "pane": "main", "removed": 0, "group": "循环 1", "value": "AT", "seq": 1, "remaining": 0,
                                }}),
                                "quickGroup" => json!({ "ok": true, "value": {
                                    "pane": "main", "op": "rename", "groups": ["初始化"], "before": ["循环 1"],
                                    "loop": { "on": false, "planLength": 1 },
                                }}),
                                "setSendAs" => json!({ "ok": true, "value": { "pane": "main", "sendAs": "hex" } }),
                                // 工作流（wfList / wfToggle / wfAdd…）：钉住工具层的返回形状
                                "wfList" => json!({ "ok": true, "value": {
                                    "pane": "main", "count": 1, "runningCount": 0,
                                    "rules": [{ "id": "wf_1", "name": "自动回 OK", "enabled": true, "running": false }],
                                }}),
                                "wfAdd" => json!({ "ok": true, "value": {
                                    "pane": "main", "rule": "wf_2", "name": "新规则", "running": false,
                                    "count": 2, "conditions": 1, "actions": 1,
                                }}),
                                "wfUpdate" => json!({ "ok": true, "value": {
                                    "pane": "main", "rule": "wf_1", "applied": ["name"], "running": false, "enabled": true,
                                }}),
                                "wfRemove" => json!({ "ok": true, "value": {
                                    "pane": "main", "removed": "wf_1", "name": "自动回 OK", "wasRunning": false, "count": 0,
                                }}),
                                "wfToggle" => json!({ "ok": true, "value": {
                                    "pane": "main", "rule": "wf_1", "name": "自动回 OK", "running": true, "changed": true,
                                }}),
                                _ => json!({ "ok": false, "error": format!("假前端不认识 action: {}", action) }),
                            }
                        }
                        // BLE 语义层（mcpBleOp）：只做"够驱动 ble_* 工具解析路径"的最小仿真
                        "ble" => {
                            let action = payload["action"].as_str().unwrap_or("");
                            match action {
                                "state" => json!({ "ok": true, "value": {
                                    "scanning": false, "deviceCount": 2, "selected": null,
                                    "connected": connected.load(Ordering::Relaxed), "addr": null, "connName": null,
                                    "serviceCount": 0, "notifySubs": 0, "logCount": 0, "monitorOpen": false,
                                }}),
                                "listDevices" => json!({ "ok": true, "value": {
                                    "scanning": false, "total": 105,
                                    "offset": payload.get("offset").and_then(|v| v.as_u64()).unwrap_or(0),
                                    "limit": payload.get("limit").and_then(|v| v.as_u64()).unwrap_or(0),
                                    "returned": 2, "hasMore": false, "nextOffset": null, "truncated": false,
                                    "selected": null,
                                    "devices": [{ "mac": "AA:BB:CC:DD:EE:FF", "name": "Ai-WB2", "rssi": -55,
                                                  "paired": false, "selected": false }],
                                }}),
                                "startScan" => json!({ "ok": true, "value": {
                                    "scanning": true, "seconds": 15, "deviceCount": 2,
                                }}),
                                "stopScan" => json!({ "ok": true, "value": {
                                    "scanning": false, "deviceCount": 2,
                                }}),
                                "getServices" => json!({ "ok": true, "value": {
                                    "connected": true, "addr": "AA:BB:CC:DD:EE:FF", "serviceCount": 1,
                                    "services": [{ "uuid": "0000fff0-0000-1000-8000-00805f9b34fb", "name": null,
                                                   "chars": [{ "uuid": "0000fff1-0000-1000-8000-00805f9b34fb", "props": ["read","notify"], "descs": 1 }] }],
                                }}),
                                "read" => json!({ "ok": true, "value": {
                                    "pane": "ble", "uuid": payload["char"], "action": "read", "note": "已触发读取",
                                }}),
                                "subscribe" => json!({ "ok": true, "value": {
                                    "pane": "ble", "uuid": payload["char"], "prop": "notify",
                                    "on": payload.get("on").and_then(|v| v.as_bool()).unwrap_or(true),
                                    "changed": true,
                                }}),
                                // 写入：`char`/`data` 缺一个就报参数错 —— Rust 侧"校验了却没放进 payload"
                                // 是 batch 4 真出现过的漏法（read 的 char 就被吞了），这里必须能抓住
                                "write" => {
                                    if payload["char"].as_str().unwrap_or("").is_empty()
                                        || payload["data"].as_str().unwrap_or("").is_empty()
                                    {
                                        json!({ "ok": false, "invalidParams": true,
                                                "error": "假前端：write 少了 char 或 data" })
                                    } else {
                                        json!({ "ok": true, "value": {
                                            "pane": "ble", "uuid": payload["char"], "hex": "4154", "bytes": 2,
                                            "writeType": if payload["writeType"] == "write_without_response" {
                                                "without_response" } else { "with_response" },
                                            "format": payload.get("format").and_then(|v| v.as_str()).unwrap_or("text"),
                                            "lineEnding": payload.get("lineEnding").and_then(|v| v.as_str()).unwrap_or("none"),
                                        }})
                                    }
                                }
                                "connect" => json!({ "ok": true, "value": {
                                    "pane": "ble", "connected": true,
                                    "addr": payload.get("addr").and_then(|v| v.as_str())
                                        .unwrap_or("AA:BB:CC:DD:EE:FF"),
                                    "name": "Ai-WB2", "via": "list", "serviceCount": 1,
                                }}),
                                "disconnect" => json!({ "ok": true, "value": {
                                    "pane": "ble", "connected": false, "addr": "AA:BB:CC:DD:EE:FF",
                                    "changed": true,
                                }}),
                                "getOutput" => json!({ "ok": true, "value": {
                                    "pane": "ble", "count": 1, "total": 1, "channels": { "rx": "ble:rx" },
                                    "items": [{ "seq": 0, "ts": 1, "kind": "rx", "hex": "01 02", "text": "", "dim": "" }],
                                }}),
                                "refreshRssi" => json!({ "ok": true, "value": {
                                    "addr": "AA:BB:CC:DD:EE:FF", "rssi": -55, "raw": { "rssi": -55 },
                                }}),
                                "periphStatus" | "periphStart" | "periphStop" => json!({
                                    "ok": false,
                                    "error": "BLE 从机方向已删除：这些 action 不该再被发出".to_string(),
                                }),
                                _ => json!({ "ok": false, "error": format!("假前端不认识 action: {}", action) }),
                            }
                        }
                        // ADB 语义层（mcpAdbOp）：只做"够驱动 adb_* 工具解析路径"的最小仿真
                        "adb" => {
                            let action = payload["action"].as_str().unwrap_or("");
                            match action {
                                "listDevices" => json!({ "ok": true, "value": {
                                    "total": 2, "ready": 1,
                                    "devices": [
                                        { "serial": "emulator-5554", "state": "device",
                                          "model": "sdk_gphone64_x86_64", "product": "sdk" },
                                        { "serial": "0123456789ABCDEF", "state": "unauthorized",
                                          "model": "Pixel 7", "product": "panther" },
                                    ],
                                }}),
                                // 前端可能自己挑设备（serial 省略时用第一台 state=device 的）
                                "openShell" => json!({ "ok": true, "value": {
                                    "serial": payload.get("serial").and_then(|v| v.as_str())
                                        .unwrap_or("emulator-5554"),
                                    "opened": true, "cols": 120, "rows": 40,
                                }}),
                                // data 缺了要报参数错 —— Rust 侧"校验了却没放进 payload"是 batch 4
                                // 真出现过的漏法（ble_read 的 char 就被吞过），这里必须能抓住
                                "shellWrite" => {
                                    if payload["data"].as_str().unwrap_or("").is_empty() {
                                        json!({ "ok": false, "invalidParams": true,
                                                "error": "假前端：shellWrite 少了 data" })
                                    } else {
                                        let d = payload["data"].as_str().unwrap_or("");
                                        json!({ "ok": true, "value": {
                                            "serial": "emulator-5554", "written": true,
                                            "bytes": d.len(), "data": d,
                                        }})
                                    }
                                }
                                "shellResize" => json!({ "ok": true, "value": {
                                    "serial": "emulator-5554",
                                    "cols": payload.get("cols").and_then(|v| v.as_u64()).unwrap_or(0),
                                    "rows": payload.get("rows").and_then(|v| v.as_u64()).unwrap_or(0),
                                }}),
                                "closeShell" => json!({ "ok": true, "value": {
                                    "serial": "emulator-5554", "opened": false, "closed": true,
                                }}),
                                _ => json!({ "ok": false, "error": format!("假前端不认识 action: {}", action) }),
                            }
                        }
                        "list" => json!({ "ok": true, "value": { "controls": [], "total": 0 } }),                        "describe" | "get" => json!({ "ok": true, "value": { "path": "serial.conn.portSelect", "value": "COM1" } }),
                        // 按 section 回**不同形状**：只回一个固定 `{theme}` 的话，
                        // "区段转发到前端了没有""回来的形状对不对"两件事都测不到
                        // （下面那两个 `ui_get_state` 用例的 keys 就成了摆设）。
                        "getState" => {
                            let sec = payload["section"].as_str().unwrap_or("");
                            match sec {
                                "theme" => json!({ "ok": true, "value": { "theme": "dark", "themeStyle": "default" } }),
                                "bleDevices" => json!({ "ok": true, "value": {
                                    "total": 105, "offset": payload.get("offset").and_then(|v| v.as_u64()).unwrap_or(0),
                                    "limit": payload.get("limit").and_then(|v| v.as_u64()).unwrap_or(0),
                                    "returned": 1, "hasMore": true, "nextOffset": 60, "truncated": false,
                                    "scanning": false, "note": null,
                                    "devices": [{ "mac": "AA:BB:CC:DD:EE:FF", "name": "Ai-WB2", "rssi": -55 }],
                                }}),
                                "wslDevices" => json!({ "ok": true, "value": {
                                    "wslRunning": true, "targetDistro": "", "panelOpened": true,
                                    "count": 2, "mapped": 1, "note": null, "mapUnavailableReason": null,
                                    "devices": [
                                        { "busid": "2-1", "port": "COM7", "name": "USB-SERIAL CH340",
                                          "vidpid": "1A86:7523", "hasCom": true, "status": "unmapped",
                                          "wslPath": "", "wslSerial": "", "busy": false,
                                          "mapControlPath": "wsl.ui.wslMap_2_1",
                                          "autoMapControlPath": "wsl.ui.wslAutoMap_2_1" },
                                    ],
                                }}),
                                _ => json!({ "ok": true, "value": { "theme": "dark" } }),
                            }
                        }
                        "set" | "click" => json!({ "ok": true, "value": { "results": [], "effects": [] } }),
                        other => json!({ "ok": false, "error": format!("假前端不认识 op: {}", other) }),
                    }
                }));
            }

            // (工具, 调用参数, 调用前的连接状态, 期望发给前端的 (op, 参数子集) 序列, 期望返回的顶层字段)
            struct Case {
                tool: &'static str,
                args: Value,
                /// 调这个工具之前，假前端"本来"是连着的吗（`serial_open/close` 有幂等分支，
                /// 两条分支都要测到，所以必须显式给状态，不能靠上一条用例留下的残留）
                pre_connected: Option<bool>,
                calls: Vec<(&'static str, Value)>,
                keys: &'static [&'static str],
            }
            let cases = vec![
                Case { tool: "serial_get_state", args: json!({}),
                    pre_connected: None,
                    calls: vec![("serial", json!({ "action": "state" }))],
                    keys: &["pane", "isConnected"] },
                Case { tool: "serial_select_port", args: json!({ "port": "COM3" }),
                    pre_connected: None,
                    calls: vec![("serial", json!({ "action": "apply", "items": [{ "name": "port", "value": "COM3" }] }))],
                    keys: &["pane", "applied"] },
                Case { tool: "serial_set_baud", args: json!({ "baud": 57600 }),
                    pre_connected: None,
                    calls: vec![("serial", json!({ "action": "apply", "items": [{ "name": "baud", "value": 57600 }] }))],
                    keys: &["pane", "applied"] },
                Case { tool: "serial_set_frame", args: json!({ "dataBits": 7, "stopBits": 2, "parity": "even" }),
                    pre_connected: None,
                    calls: vec![("serial", json!({ "action": "apply", "items": [
                        { "name": "dataBits", "value": 7 }, { "name": "stopBits", "value": 2 }, { "name": "parity", "value": "even" },
                    ] }))],
                    keys: &["pane", "applied"] },
                Case { tool: "serial_set_lines", args: json!({ "dtr": true, "rts": false }),
                    pre_connected: None,
                    calls: vec![("serial", json!({ "action": "apply", "items": [
                        { "name": "dtr", "value": true }, { "name": "rts", "value": false },
                    ] }))],
                    keys: &["pane", "applied"] },
                Case { tool: "serial_set_display", args: json!({ "echo": false, "lineNum": true }),
                    pre_connected: None,
                    calls: vec![("serial", json!({ "action": "apply", "items": [
                        { "name": "echo", "value": false }, { "name": "lineNum", "value": true },
                    ] }))],
                    keys: &["pane", "applied"] },
                // 开监控：先落 port/baud → 读状态 → 点「开始监控」→ 轮询确认真连上
                Case { tool: "serial_open", args: json!({ "port": "COM3", "baud": 9600 }),
                    pre_connected: Some(false),
                    calls: vec![
                        ("serial", json!({ "action": "apply", "items": [
                            { "name": "port", "value": "COM3" }, { "name": "baud", "value": 9600 },
                        ] })),
                        ("serial", json!({ "action": "state" })),
                        ("serial", json!({ "action": "click", "name": "start" })),
                        ("serial", json!({ "action": "state" })),
                    ],
                    keys: &["pane", "connected", "state"] },
                // 已经在监控中 → 幂等，不该再点一次（点两次会先断后连）
                Case { tool: "serial_open", args: json!({}),
                    pre_connected: Some(true),
                    calls: vec![("serial", json!({ "action": "state" }))],
                    keys: &["pane", "connected", "note"] },
                // 停监控：读状态 → 点「停止监控」→ 轮询确认断开（点完不代表断开）
                Case { tool: "serial_close", args: json!({}),
                    pre_connected: Some(true),
                    calls: vec![
                        ("serial", json!({ "action": "state" })),
                        ("serial", json!({ "action": "click", "name": "start" })),
                        ("serial", json!({ "action": "state" })),
                    ],
                    keys: &["pane", "connected", "state"] },
                // 本来就没在监控 → 幂等
                Case { tool: "serial_close", args: json!({}),
                    pre_connected: Some(false),
                    calls: vec![("serial", json!({ "action": "state" }))],
                    keys: &["pane", "connected", "note"] },
                // 带 mode 发数据：先切成 HEX（走它自己的 onclick），再发
                Case { tool: "serial_send", args: json!({ "data": "01 03", "mode": "hex" }),
                    pre_connected: None,
                    calls: vec![
                        ("serial", json!({ "action": "setSendAs", "mode": "hex" })),
                        ("serial", json!({ "action": "send", "data": "01 03" })),
                    ],
                    keys: &["pane", "sent", "mode", "bytes", "data"] },
                Case { tool: "serial_clear", args: json!({}),
                    pre_connected: None,
                    calls: vec![("serial", json!({ "action": "clear" }))],
                    keys: &["pane", "cleared", "outputLines"] },
                Case { tool: "serial_get_history", args: json!({ "limit": 5 }),
                    pre_connected: None,
                    calls: vec![("serial", json!({ "action": "history", "limit": 5 }))],
                    keys: &["pane", "total", "items"] },
                // 读收发内容：先问前端要"分栏名 + 通道名"，再去日志中心取
                Case { tool: "serial_get_output", args: json!({ "direction": "rx" }),
                    pre_connected: None,
                    calls: vec![("serial", json!({ "action": "state" }))],
                    keys: &["pane", "direction", "isConnected", "channels", "count", "items", "truncated"] },
                // 同一个工具换 text 编码：正文走 content 文本，structuredContent 只剩元信息
                // （循环里有一条通用规则守着"text 编码不许再带 items"）
                Case { tool: "serial_get_output", args: json!({ "direction": "both", "format": "text" }),
                    pre_connected: None,
                    calls: vec![("serial", json!({ "action": "state" }))],
                    keys: &["pane", "direction", "format", "isConnected", "channels", "count", "truncated"] },
                Case { tool: "serial_quick_cmd", args: json!({}),
                    pre_connected: None,
                    calls: vec![("serial", json!({ "action": "quickList" }))],
                    keys: &["pane", "items", "usable"] },
                Case { tool: "serial_quick_cmd", args: json!({ "index": 0 }),
                    pre_connected: None,
                    calls: vec![("serial", json!({ "action": "quickRun", "index": 0 }))],
                    keys: &["pane", "ran", "label", "value"] },
                // 循环开关：只传 on 就开关（复用面板那颗开关的前置检查），返回值说明"计划多长"
                Case { tool: "serial_quick_cmd", args: json!({ "action": "loop", "on": true }),
                    pre_connected: None,
                    calls: vec![("serial", json!({ "action": "quickLoop", "on": true }))],
                    keys: &["pane", "loop", "planLength", "changed"] },
                // 加一条：group 给组序号/组名，其余字段是这一条自己的等待参数。
                // ⚠️ 期望里**必须列出这些字段** —— `serial_call` 只转发 extra，
                // 只校验不转发就是"工具回了 ok、参数却没生效"（batch 4 这么漏过一次）
                Case { tool: "serial_quick_cmd",
                    args: json!({ "action": "add", "group": 0, "value": "AT+GMR", "seq": 1,
                                  "timeoutMs": 500, "expect": "WIFI GOT IP|OK", "retry": 2, "hex": true }),
                    pre_connected: None,
                    calls: vec![("serial", json!({ "action": "quickAdd", "value": "AT+GMR", "seq": 1,
                                                   "timeoutMs": 500, "expect": "WIFI GOT IP|OK",
                                                   "retry": 2, "hex": true }))],
                    keys: &["pane", "index", "group", "groupIndex", "itemIndex", "applied"] },
                // 旧拼写 delayMs：仍然转发（语义是超时），免得按旧写法调用的人静默失效
                Case { tool: "serial_quick_cmd", args: json!({ "action": "update", "index": 0, "delayMs": 8000 }),
                    pre_connected: None,
                    calls: vec![("serial", json!({ "action": "quickUpdate", "delayMs": 8000 }))],
                    keys: &["pane", "index", "group", "itemIndex", "applied"] },
                // 跳转（分支与循环）：两列面板上没有入口，但必须**转发到前端**（只校验不转发=永远收不到）
                Case { tool: "serial_quick_cmd", args: json!({ "action": "update", "index": 0,
                        "okGoto": "2", "errGoto": "end" }),
                    pre_connected: None,
                    calls: vec![("serial", json!({ "action": "quickUpdate", "okGoto": "2", "errGoto": "end" }))],
                    keys: &["pane", "index", "group", "itemIndex", "applied"] },
                Case { tool: "serial_quick_cmd", args: json!({ "action": "update", "index": 0, "value": "AT+RST", "seq": 2 }),
                    pre_connected: None,
                    calls: vec![("serial", json!({ "action": "quickUpdate" }))],
                    keys: &["pane", "index", "group", "itemIndex", "applied"] },
                Case { tool: "serial_quick_cmd", args: json!({ "action": "remove", "index": 0 }),
                    pre_connected: None,
                    calls: vec![("serial", json!({ "action": "quickRemove" }))],
                    keys: &["pane", "removed", "group", "value", "seq", "remaining"] },
                Case { tool: "serial_quick_cmd", args: json!({ "action": "group", "op": "rename", "group": 0, "name": "初始化" }),
                    pre_connected: None,
                    calls: vec![("serial", json!({ "action": "quickGroup" }))],
                    keys: &["pane", "op", "groups", "before", "loop"] },
                // 工作流：省略 action = 列出（只读）；启停走单独那条（危险门在 Rust 侧）
                Case { tool: "serial_workflow", args: json!({}),
                    pre_connected: None,
                    calls: vec![("serial", json!({ "action": "wfList" }))],
                    keys: &["pane", "count", "rules", "runningCount"] },
                Case { tool: "serial_workflow", args: json!({ "action": "add", "name": "自动回 OK",
                        "conditions": [{ "type": "string_contains", "value": "PING" }],
                        "actions": [{ "type": "send_data", "data": "PONG", "delayBefore": 300 }] }),
                    pre_connected: None,
                    calls: vec![("serial", json!({ "action": "wfAdd", "name": "自动回 OK",
                                                   "conditions": [{ "type": "string_contains", "value": "PING" }] }))],
                    keys: &["pane", "rule", "name", "running", "count"] },
                Case { tool: "serial_workflow_run", args: json!({ "rule": "wf_1", "on": true, "confirm": true }),
                    pre_connected: None,
                    calls: vec![("serial", json!({ "action": "wfToggle", "rule": "wf_1", "on": true }))],
                    keys: &["pane", "rule", "running"] },
                // BLE 第一批（从机的三个已在 2026-09 随方向一起删除）：
                // 这一层只钉"发出去的 op 与返回形状"
                Case { tool: "ble_get_state", args: json!({}),
                    pre_connected: None,
                    calls: vec![("ble", json!({ "action": "state" }))],
                    keys: &["scanning", "deviceCount", "connected", "serviceCount", "notifySubs", "logCount"] },
                Case { tool: "ble_list_devices", args: json!({ "limit": 5, "offset": 10 }),
                    pre_connected: None,
                    calls: vec![("ble", json!({ "action": "listDevices", "limit": 5, "offset": 10 }))],
                    keys: &["scanning", "total", "offset", "limit", "returned", "hasMore", "devices", "selected"] },
                Case { tool: "ble_start_scan", args: json!({}),
                    pre_connected: None,
                    calls: vec![("ble", json!({ "action": "startScan" }))],
                    keys: &["scanning", "seconds", "deviceCount"] },
                Case { tool: "ble_stop_scan", args: json!({}),
                    pre_connected: None,
                    calls: vec![("ble", json!({ "action": "stopScan" }))],
                    keys: &["scanning", "deviceCount"] },
                Case { tool: "ble_get_services", args: json!({}),
                    pre_connected: None,
                    calls: vec![("ble", json!({ "action": "getServices" }))],
                    keys: &["connected", "serviceCount", "services"] },
                // 参数必须**真的到得了前端**：期望里钉住 char/on/data 这些字段，
                // 光在 Rust 侧 require_str 校验、却忘了放进 payload，是 batch 4 真实踩过的坑
                Case { tool: "ble_read", args: json!({ "char": "0x2a00" }),
                    pre_connected: None,
                    calls: vec![("ble", json!({ "action": "read", "char": "0x2a00" }))],
                    keys: &["pane", "uuid", "action", "note"] },
                Case { tool: "ble_subscribe", args: json!({ "char": "0x2a00", "on": true }),
                    pre_connected: None,
                    calls: vec![("ble", json!({ "action": "subscribe", "char": "0x2a00", "on": true }))],
                    keys: &["pane", "uuid", "prop", "on", "changed"] },
                // 写入：格式/行尾/写方式都给上，钉住这几个字段原样透传（含归一化成小写）
                Case { tool: "ble_write", args: json!({ "char": "0000FFF1-0000-1000-8000-00805F9B34FB",
                                                        "data": "01A0FF", "format": "HEX",
                                                        "lineEnding": "CRLF", "writeType": "write_without_response" }),
                    pre_connected: None,
                    calls: vec![("ble", json!({ "action": "write",
                                                "char": "0000FFF1-0000-1000-8000-00805F9B34FB",
                                                "data": "01A0FF", "format": "hex",
                                                "lineEnding": "crlf", "writeType": "write_without_response" }))],
                    keys: &["pane", "uuid", "hex", "bytes", "writeType", "format", "lineEnding"] },
                // 写入不给 format/lineEnding/writeType 时：前端拿到的 payload 里就不该有它们
                // （前端各自的默认值是 text / none / 特征支持的第一种）
                Case { tool: "ble_write", args: json!({ "char": "0000fff1-0000-1000-8000-00805f9b34fb", "data": "AT" }),
                    pre_connected: None,
                    calls: vec![("ble", json!({ "action": "write",
                                                "char": "0000fff1-0000-1000-8000-00805f9b34fb",
                                                "data": "AT" }))],
                    keys: &["pane", "uuid", "hex", "bytes", "writeType"] },
                // 连接：addr 透传（前端再决定走列表还是按 MAC 直连）
                Case { tool: "ble_connect", args: json!({ "addr": "aa:bb:cc:dd:ee:ff" }),
                    pre_connected: None,
                    calls: vec![("ble", json!({ "action": "connect", "addr": "AA:BB:CC:DD:EE:FF" }))],
                    keys: &["pane", "connected", "addr", "name", "via", "serviceCount"] },
                // 连接不给 addr：payload 里不能凭空多一个 addr（前端用面板选中的那台）
                Case { tool: "ble_connect", args: json!({}),
                    pre_connected: None,
                    calls: vec![("ble", json!({ "action": "connect" }))],
                    keys: &["pane", "connected", "addr", "via"] },
                Case { tool: "ble_disconnect", args: json!({}),
                    pre_connected: None,
                    calls: vec![("ble", json!({ "action": "disconnect" }))],
                    keys: &["pane", "connected", "addr", "changed"] },
                Case { tool: "ble_get_output", args: json!({ "limit": 20 }),
                    pre_connected: None,
                    // ⚠️ 期望里**必须**带 limit：参数声明了却只转发 action/pane 的话，
                    // 前端 `parseInt(payload.limit)` 永远是 NaN → 每次返回全量
                    //（2026-09 修的真实 bug：这条 Case 原来只写 action，所以没测出来）
                    calls: vec![("ble", json!({ "action": "getOutput", "limit": 20 }))],
                    keys: &["pane", "count", "total", "channels", "items", "mode", "scanned"] },
                Case { tool: "ble_refresh_rssi", args: json!({}),
                    pre_connected: None,
                    calls: vec![("ble", json!({ "action": "refreshRssi" }))],
                    keys: &["addr", "rssi", "raw"] },
                // ADB 第三批：每个动作都经前端 mcpAdbOp（危险门在 Rust 侧，这一层只钉
                // "发出去的 op/参数"与"拿到回执后的返回形状"）
                Case { tool: "adb_list_devices", args: json!({}),
                    pre_connected: None,
                    calls: vec![("adb", json!({ "action": "listDevices" }))],
                    keys: &["total", "ready", "devices"] },
                // 给了 serial：必须**原样进 payload**（前端靠它挑设备），且只在给了的时候出现
                Case { tool: "adb_open_shell", args: json!({ "serial": "emulator-5554", "confirm": true }),
                    pre_connected: None,
                    calls: vec![("adb", json!({ "action": "openShell", "serial": "emulator-5554" }))],
                    keys: &["serial", "opened", "cols", "rows"] },
                // 省略 serial：payload 里不许凭空多一个 serial（前端自己取第一台可用设备）
                Case { tool: "adb_open_shell", args: json!({ "confirm": true }),
                    pre_connected: None,
                    calls: vec![("adb", json!({ "action": "openShell" }))],
                    keys: &["serial", "opened"] },
                Case { tool: "adb_shell_write", args: json!({ "data": "ls -l\n", "confirm": true }),
                    pre_connected: None,
                    calls: vec![("adb", json!({ "action": "shellWrite", "data": "ls -l\n" }))],
                    keys: &["serial", "written", "bytes", "data"] },
                Case { tool: "adb_shell_resize", args: json!({ "cols": 100, "rows": 30 }),
                    pre_connected: None,
                    calls: vec![("adb", json!({ "action": "shellResize", "cols": 100, "rows": 30 }))],
                    keys: &["serial", "cols", "rows"] },
                Case { tool: "adb_close_shell", args: json!({}),
                    pre_connected: None,
                    calls: vec![("adb", json!({ "action": "closeShell" }))],
                    keys: &["serial", "opened", "closed"] },
                Case { tool: "ui_list", args: json!({ "limit": 3 }),
                    pre_connected: None,
                    calls: vec![("list", json!({ "limit": 3 }))],
                    keys: &["controls", "total"] },
                Case { tool: "ui_describe", args: json!({ "path": "serial.conn.portSelect" }),
                    pre_connected: None,
                    calls: vec![("describe", json!({ "path": "serial.conn.portSelect" }))],
                    keys: &["path", "value"] },
                Case { tool: "ui_get", args: json!({ "path": "serial.conn.portSelect" }),
                    pre_connected: None,
                    calls: vec![("get", json!({ "path": "serial.conn.portSelect" }))],
                    keys: &["path", "value"] },
                Case { tool: "ui_set", args: json!({ "path": "serial.conn.portSelect", "value": "COM3" }),
                    pre_connected: None,
                    calls: vec![("set", json!({ "path": "serial.conn.portSelect", "value": "COM3" }))],
                    keys: &["results", "effects"] },
                Case { tool: "ui_click", args: json!({ "path": "serial.toolbar.btnStart" }),
                    pre_connected: None,
                    calls: vec![("click", json!({ "path": "serial.toolbar.btnStart" }))],
                    keys: &["results", "effects"] },
                Case { tool: "ui_get_state", args: json!({ "section": "theme" }),
                    pre_connected: None,
                    calls: vec![("getState", json!({ "section": "theme" }))],
                    keys: &["theme", "themeStyle"] },
                // 分页参数必须**转发到前端**（不转发 = 通用桥的分页静默失效，真机上踩到过）
                Case { tool: "ui_get_state", args: json!({ "section": "bleDevices", "limit": 20, "offset": 40 }),
                    pre_connected: None,
                    calls: vec![("getState", json!({ "section": "bleDevices", "limit": 20, "offset": 40 }))],
                    keys: &["devices", "offset", "limit", "total"] },
                // WSL 端口映射设备表：行是动态 div、不在控件注册表里，只有这条通用桥的路能读到。
                // 断言 `mapControlPath` 是有意的 —— 它就是"哪台设备对应哪个 ui_set 路径"，
                // 少了它 AI 只能靠 busid 猜路径（2026-09 用户要的"把 COM7 映射到 WSL"卡在这）。
                Case { tool: "ui_get_state", args: json!({ "section": "wslDevices" }),
                    pre_connected: None,
                    calls: vec![("getState", json!({ "section": "wslDevices" }))],
                    keys: &["devices", "count", "mapped", "wslRunning", "mapUnavailableReason"] },
            ];

            let mut seen: Vec<&str> = Vec::new();
            for case in &cases {
                if let Some(pc) = case.pre_connected {
                    connected.store(pc, Ordering::Relaxed);
                }
                calls.lock().unwrap_or_else(|e| e.into_inner()).clear();
                let r = call(&c, &raw_call(case.tool, &case.args)).await;
                assert!(r.get("error").is_none(), "{} 不该是协议错误: {}", case.tool, r);
                assert_eq!(r["result"]["isError"], false, "{} 调用失败: {}", case.tool, r);

                // ① 发给前端的调用序列（op + 关键参数）
                let got = calls.lock().unwrap_or_else(|e| e.into_inner()).clone();
                let got_desc: Vec<String> = got
                    .iter()
                    .map(|(op, p)| format!("{}:{}", op, p["action"].as_str().unwrap_or("-")))
                    .collect();
                assert_eq!(
                    got.len(),
                    case.calls.len(),
                    "{} 发给前端的调用次数不对，实际: {:?}",
                    case.tool,
                    got_desc
                );
                for (i, (want_op, want_payload)) in case.calls.iter().enumerate() {
                    assert_eq!(&got[i].0, want_op, "{} 第 {} 次调用的 op 不对", case.tool, i + 1);
                    assert!(
                        json_subset(&got[i].1, want_payload),
                        "{} 第 {} 次调用的参数不对\n  实际: {}\n  期望包含: {}",
                        case.tool,
                        i + 1,
                        got[i].1,
                        want_payload
                    );
                }

                // ② 最终返回的形状
                let sc = &r["result"]["structuredContent"];
                assert!(sc.is_object(), "{} 的 structuredContent 必须是对象: {}", case.tool, sc);
                for k in case.keys {
                    assert!(sc.get(k).is_some(), "{} 返回里少了 {}（实际: {}）", case.tool, k, sc);
                }

                // ③ **文本摘要必须真的把数据说出来**（AGENTS #11）。
                // 很多客户端只把 `content[].text` 给模型看，人也是先看这一行；只写"N 项"
                // 就等于把数据藏起来（`serial_list_ports` 的端口名就是这么消失过一次的）。
                // 这里是**每个工具都测**：摘要里必须出现 structuredContent 里至少一个真实取值。
                let text = r["result"]["content"][0]["text"].as_str().unwrap_or("");
                assert!(!text.is_empty(), "{} 的文本摘要不能为空", case.tool);
                // text 编码：正文已经在 content 文本里了，structuredContent **不许**再放一份
                // （两个渠道都会发给客户端，重复 = 把省下的 token 又花回去）
                if case.args.get("format").and_then(|v| v.as_str()) == Some("text") {
                    assert!(
                        sc.get("items").is_none(),
                        "{} 的 text 编码不该再带逐行的 items: {}",
                        case.tool,
                        sc
                    );
                }
                let leaves = leaf_scalars(sc);
                if !leaves.is_empty() {
                    assert!(
                        leaves.iter().any(|v| text.contains(v.as_str())),
                        "{} 的文本摘要里看不到任何真实取值（只报了个空壳？）\n  文本: {}\n  数据: {}",
                        case.tool,
                        text,
                        sc
                    );
                }

                seen.push(case.tool);
            }

            // 这两张表必须覆盖同一批界面工具（漏一个就等于没测）
            seen.sort_unstable();
            seen.dedup();
            let mut want = vec![
                "serial_clear", "serial_close", "serial_get_history", "serial_get_state",
                "serial_open", "serial_quick_cmd", "serial_select_port", "serial_send",
                "serial_set_baud", "serial_set_display", "serial_set_frame", "serial_set_lines",
                // 工作流规则（都经前端 mcpSerialOp 的 wf* 动作）
                "serial_workflow", "serial_workflow_run",
                "ui_click", "ui_describe", "ui_get", "ui_get_state", "ui_list", "ui_set",
                // BLE 第一批（都经前端 mcpBleOp）；从机的三个已在 2026-09 随方向一起删除
                "ble_get_state",
                "ble_list_devices", "ble_start_scan", "ble_stop_scan", "ble_get_services",
                "ble_get_output", "ble_refresh_rssi", "ble_read", "ble_subscribe",
                "ble_write", "ble_connect", "ble_disconnect",
                // ADB 第三批（都经前端 mcpAdbOp；adb_shell_read 是纯后端，不在这张表里）
                "adb_list_devices", "adb_open_shell", "adb_shell_write",
                "adb_shell_resize", "adb_close_shell",
            ];
            // serial_get_output 只读日志中心，但**先要过前端拿分栏名与通道名**，所以也算界面工具
            want.push("serial_get_output");
            want.sort_unstable();
            assert_eq!(seen, want, "界面工具的调用测试列表与契约表不一致");
        });
    }

    /// 取出结构里的**叶子标量**（字符串/数字），用来验证"文本摘要真的把数据说出来了"。
    /// 只向下两层、最多 12 个：这是给断言用的，不是给渲染用的。
    fn leaf_scalars(v: &Value) -> Vec<String> {
        fn walk(v: &Value, depth: usize, out: &mut Vec<String>) {
            if out.len() >= 12 || depth > 3 {
                return;
            }
            match v {
                Value::String(s) => {
                    if s.chars().count() >= 2 {
                        out.push(s.clone());
                    }
                }
                Value::Number(n) => out.push(n.to_string()),
                Value::Bool(b) => out.push(b.to_string()),
                Value::Array(a) => a.iter().take(4).for_each(|x| walk(x, depth + 1, out)),
                Value::Object(m) => m.values().take(8).for_each(|x| walk(x, depth + 1, out)),
                Value::Null => {}
            }
        }
        let mut out = Vec::new();
        walk(v, 0, &mut out);
        out
    }

    /// 扫描结果**必须真的到客户端**：`ble_list_devices` 的文本摘要里要有设备 MAC 与名称。
    /// 2026-09 用户报"扫描结果没有返回给 MCP 客户端"。那条有三层原因，这条断言守最后一层：
    /// ① 当时运行的是没有 `ble_*` 的旧构建（`mcp_smoke.js` 用"源码工具清单 vs 应用里的清单"守）；
    /// ② 前端只读面板缓存、可能落在两次轮询之间（前端断言集守）；
    /// ③ 文本摘要很容易退化成"N 项" —— 那样即使 structuredContent 里有设备，模型和人也看不到。
    #[test]
    fn ble_list_devices_text_carries_mac_and_name() {
        block_on(async {
            let c = core();
            {
                let mut slot = c.test_ui.lock().unwrap_or_else(|e| e.into_inner());
                *slot = Some(Box::new(|op: &str, payload: &Value| {
                    assert_eq!(op, "ble", "ble_list_devices 该走 ble 面板");
                    assert_eq!(payload["action"], "listDevices");
                    json!({ "ok": true, "value": {
                        "scanning": false, "total": 1, "selected": null,
                        "devices": [{ "mac": "AA:BB:CC:DD:EE:FF", "name": "Ai-WB2", "rssi": -55,
                                      "paired": false, "selected": false }],
                        "note": null,
                    }})
                }));
            }
            let r = call(&c, &raw_call("ble_list_devices", &json!({}))).await;
            assert_eq!(r["result"]["isError"], false, "{}", r);
            let text = r["result"]["content"][0]["text"].as_str().unwrap_or("");
            assert!(text.contains("AA:BB:CC:DD:EE:FF"), "文本摘要里没有设备 MAC: {}", text);
            assert!(text.contains("Ai-WB2"), "文本摘要里没有设备名: {}", text);
            assert_eq!(
                r["result"]["structuredContent"]["devices"][0]["mac"],
                "AA:BB:CC:DD:EE:FF"
            );
        });
    }

    /// ADB 设备列表同理：**文本摘要里要有序列号与状态**。
    /// 与 `ble_list_devices` 那条是同一个教训（只报"N 项"等于把数据藏起来）——
    /// 这里不能只写 `devices=2 项`，否则只读文本的客户端拿不到"该连哪台"。
    #[test]
    fn adb_list_devices_text_carries_serial_state_and_model() {
        block_on(async {
            let c = core();
            {
                let mut slot = c.test_ui.lock().unwrap_or_else(|e| e.into_inner());
                *slot = Some(Box::new(|op: &str, payload: &Value| {
                    assert_eq!(op, "adb", "adb_list_devices 该走 adb 面板");
                    assert_eq!(payload["action"], "listDevices");
                    json!({ "ok": true, "value": {
                        "total": 1, "ready": 1,
                        "devices": [{ "serial": "emulator-5554", "state": "device",
                                      "model": "sdk_gphone64_x86_64", "product": "sdk" }],
                    }})
                }));
            }
            let r = call(&c, &raw_call("adb_list_devices", &json!({}))).await;
            assert_eq!(r["result"]["isError"], false, "{}", r);
            let text = r["result"]["content"][0]["text"].as_str().unwrap_or("");
            assert!(text.contains("emulator-5554"), "文本摘要里没有序列号: {}", text);
            assert!(text.contains("device"), "文本摘要里没有状态: {}", text);
            assert!(text.contains("sdk_gphone64_x86_64"), "文本摘要里没有型号: {}", text);
        });
    }

    /// `adb_shell_read` 是纯后端工具（读日志中心的 `adb:rx`），三个行为必须钉住：
    /// ① 通道还没建（一条输出都没有）时**不报错**（`log_tail` 对同样的输入会报 -32602，
    ///    AI 会据此得出"不支持读 ADB 输出"的错结论）；② `sinceSeq` 是增量；
    /// ③ 摘要里**真的有输出内容**，不是只报了个条数。
    #[test]
    fn adb_shell_read_reads_the_loghub_channel_incrementally() {
        let _g = hub_lock();
        let hub = crate::mcp::loghub::hub();
        hub.set_enabled(true);
        hub.clear(Some("adb:rx"));

        block_on(async {
            let c = core();
            // ① 通道还不存在 → 空列表 + note，不是错误
            let r = call(&c, &raw_call("adb_shell_read", &json!({}))).await;
            assert!(r.get("error").is_none(), "没数据不该是协议错误: {}", r);
            assert_eq!(r["result"]["isError"], false, "{}", r);
            assert_eq!(r["result"]["structuredContent"]["count"], 0);
            assert_eq!(r["result"]["structuredContent"]["channel"], "adb:rx");
            assert!(
                r["result"]["structuredContent"]["note"]
                    .as_str()
                    .unwrap_or("")
                    .contains("adb_open_shell"),
                "空的时候要说清下一步: {}",
                r["result"]["structuredContent"]["note"]
            );

            // ② 写入几条（模拟 PTY 读线程的旁路）→ 尾部读取 + sinceSeq 增量
            crate::mcp::loghub::hub().push(
                "adb:rx",
                crate::mcp::loghub::LEVEL_INFO,
                crate::mcp::loghub::DIR_RX,
                "total 12\n",
                9,
            );
            crate::mcp::loghub::hub().push(
                "adb:rx",
                crate::mcp::loghub::LEVEL_INFO,
                crate::mcp::loghub::DIR_RX,
                "drwxr-xr-x 4 root root 4096 /data\n",
                33,
            );
            let r = call(&c, &raw_call("adb_shell_read", &json!({ "limit": 10 }))).await;
            let sc = &r["result"]["structuredContent"];
            assert_eq!(sc["count"], 2);
            // ⚠️ seq **不能硬编码成 1**：`hub.clear()` 只清内容、不重置 `next_seq`
            //（别的用例可能已经往 `adb:rx` 写过东西）—— 要钉的是"**连续**"，不是"从 1 开始"。
            // 这条以前写死 1/2，于是新增一个也用 adb:rx 的用例就会让它随执行顺序随机失败。
            let s0 = sc["items"][0]["seq"].as_u64().expect("每条都要有 seq");
            assert_eq!(sc["items"][1]["seq"], json!(s0 + 1), "seq 必须连续: {}", sc["items"]);
            assert_eq!(sc["items"][1]["dir"], "rx");
            let text = r["result"]["content"][0]["text"].as_str().unwrap_or("");
            assert!(
                text.contains("/data") || text.contains("drwxr-xr-x"),
                "文本摘要里必须真的有输出内容（只报条数等于把数据藏起来）: {}",
                text
            );

            // sinceSeq 是**增量**：只拿比它新的
            let r = call(&c, &raw_call("adb_shell_read", &json!({ "sinceSeq": s0 }))).await;
            let sc = &r["result"]["structuredContent"];
            assert_eq!(sc["count"], 1, "sinceSeq=第一条时只该回第 2 条: {}", sc);
            assert_eq!(sc["items"][0]["seq"], json!(s0 + 1));

            // ③ 丢弃账要能读出来（AGENTS #6：不能让调用方以为日志是完整的）
            crate::mcp::loghub::hub().note_dropped("adb:rx", 3);
            let r = call(&c, &raw_call("adb_shell_read", &json!({}))).await;
            let sc = &r["result"]["structuredContent"];
            assert_eq!(sc["dropped"], 3, "{}", sc);
            assert_eq!(sc["mayBeIncomplete"], true, "有丢弃时必须明确告知: {}", sc);

            // ④ 没带 limit 时不应超上限（limit 是 clamp，不是拒绝）
            let r = call(
                &c,
                &raw_call("adb_shell_read", &json!({ "limit": MAX_ADB_READ_LINES + 999 })),
            )
            .await;
            assert_eq!(r["result"]["isError"], false, "{}", r);
            hub.clear(Some("adb:rx"));
        });
    }

    /// 45 台设备**不能只回一句"共 45 项"**。用户 2026-09 的原话：**"只有设备数量吗？
    /// 没有设备名称列表？包含 MAC 地址的"** —— 通用渲染只展开前几个元素，看着就像只回了数量。
    /// 现在设备列表一行一台（MAC + 名称 + RSSI），列不下的才用"还有 N 台"指路。
    #[test]
    fn ble_devices_summary_lists_devices_not_just_a_count() {
        let devices: Vec<Value> = (0..45u32)
            .map(|i| {
                json!({
                    "mac": format!("AA:BB:CC:DD:EE:{:02X}", i),
                    "name": if i % 3 == 0 { Value::Null } else { json!(format!("Dev{}", i)) },
                    "rssi": -50 - (i as i64), "paired": false, "selected": false
                })
            })
            .collect();
        let v = json!({ "scanning": true, "total": 45, "offset": 0, "limit": 0, "returned": 45,
                        "hasMore": false, "nextOffset": null, "truncated": false,
                        "devices": devices, "note": null });
        let s = summarize_for_tool("ble_list_devices", &v);
        assert!(s.starts_with("共 45 台（第 1-45 台，扫描中）："), "{}", s);
        let listed = (0..45u32)
            .filter(|i| s.contains(&format!("AA:BB:CC:DD:EE:{:02X}", i)))
            .count();
        assert!(listed >= 8, "文本摘要里该列出至少 8 台设备（实际 {} 台）：{}", listed, s);
        assert!(s.contains("Dev1"), "设备名要一起列出来：{}", s);
        assert!(s.contains("本页还有"), "列不下的要说清本页还剩几台：{}", s);
        assert!(
            s.chars().count() <= TEXT_SUMMARY_MAX_CHARS,
            "摘要不能超长（{} 字）：{}",
            s.chars().count(),
            s
        );
    }

    /// 分页：文本里必须**说清这是第几台到第几台、下一页 offset 是多少**。
    /// 用户 2026-09："MCP 返回的文本在约 400 字符处被截断，所以我只能看到前 17 台" ——
    /// 看不到"还有多少、怎么接着翻"就会以为到头了。
    #[test]
    fn ble_devices_summary_says_which_page_and_whats_next() {
        let devices: Vec<Value> = (0..20u32)
            .map(|i| json!({ "mac": format!("AA:BB:CC:DD:EE:{:02X}", i), "name": Value::Null,
                             "rssi": -50, "paired": false, "selected": false }))
            .collect();
        let v = json!({ "scanning": false, "total": 105, "offset": 20, "limit": 20, "returned": 20,
                        "hasMore": true, "nextOffset": 40, "truncated": true, "devices": devices, "note": null });
        let s = summarize_for_tool("ble_list_devices", &v);
        assert!(s.starts_with("共 105 台（第 21-40 台）"), "{}", s);
        assert!(s.contains("下一页 offset=40"), "翻页指令没给出来：{}", s);
        assert!(s.chars().count() <= TEXT_SUMMARY_MAX_CHARS, "{}", s.chars().count());

        // 最后一页：不该再提"下一页"
        let v2 = json!({ "scanning": false, "total": 21, "offset": 20, "limit": 20, "returned": 1,
                         "hasMore": false, "nextOffset": null, "truncated": false,
                         "devices": [devices[0].clone()], "note": null });
        let s2 = summarize_for_tool("ble_list_devices", &v2);
        assert!(s2.starts_with("共 21 台（第 21-21 台）"), "{}", s2);
        assert!(!s2.contains("下一页"), "已经翻到底了不该再说下一页：{}", s2);
    }

    /// 通用桥那条路（`ui_get_state{section:"bleDevices"}`）是同一张设备表 → 同样走紧凑格式。
    /// 按形状判断，所以将来再有工具返回设备表也自动受益。
    #[test]
    fn device_list_shape_gets_compact_summary_for_any_tool() {
        let v = json!({ "scanning": false, "total": 2, "offset": 0, "limit": 10, "returned": 2,
                        "hasMore": false, "nextOffset": null, "truncated": false,
                        "devices": [ { "mac": "AA:BB:CC:DD:EE:01", "name": "Ai-WB2", "rssi": -55,
                                       "paired": false, "selected": true },
                                     { "mac": "AA:BB:CC:DD:EE:02", "name": null, "rssi": -70,
                                       "paired": true, "selected": false } ],
                        "note": null });
        let s = summarize_for_tool("ui_get_state", &v);
        assert!(s.starts_with("共 2 台（第 1-2 台）："), "{}", s);
        assert!(s.contains("AA:BB:CC:DD:EE:01 Ai-WB2 -55dBm"), "{}", s);
        assert!(s.contains("AA:BB:CC:DD:EE:02 -70dBm"), "{}", s);
        assert!(!s.contains("下一页"), "两台都列得下、也没下一页，不该说翻页：{}", s);
    }

    #[test]
    fn ble_devices_summary_handles_empty_and_note() {
        let v = json!({ "scanning": false, "total": 0, "offset": 0, "limit": 0, "returned": 0,
                        "hasMore": false, "nextOffset": null, "devices": [],
                        "note": "还没扫到设备：先 ble_start_scan" });
        let s = summarize_for_tool("ble_list_devices", &v);
        assert!(s.contains("共 0 台") && s.contains("ble_start_scan"), "{}", s);
    }

    /// 通用数组展开也要按**字数预算**（原先死板只取 3 个，"有 20 项的列表"看着像只回了 3 项）
    #[test]
    fn array_brief_expands_within_budget() {
        let arr: Vec<Value> = (0..20).map(|i| json!(format!("item{:02}", i))).collect();
        let s = render_brief(&json!({ "items": arr }), 0);
        let shown = (0..20).filter(|i| s.contains(&format!("item{:02}", i))).count();
        assert!(shown >= 10, "预算内该尽量多列（实际 {} 个）：{}", shown, s);
        assert!(s.contains("共 20 项"), "{}", s);
        assert!(s.chars().count() <= TEXT_SUMMARY_MAX_CHARS, "{}", s.chars().count());
    }

    /// Agent 的效率取决于"第一次就做对"：`initialize.instructions` 一次性把工作方式告诉它，
    /// 省掉它靠失败去发现（每次撞墙都是一轮往返）。这里钉住"确实给了、且内容真的能省掉失败"。
    #[test]
    fn initialize_gives_the_agent_working_instructions() {
        block_on(async {
            let c = core();
            let r = call(
                &c,
                r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"t","version":"1"}}}"#,
            )
            .await;
            let ins = r["result"]["instructions"].as_str().unwrap_or("");
            assert!(!ins.is_empty(), "initialize 必须带上工作指引: {}", r);
            for key in [
                "serial_get_state",   // 串口操作前先看状态
                "serial_open",        // 发数据前必须先开监控
                "-32602",             // 错误码语义（改参数 vs 做前置操作）
                "-32006",
                "mcp_limits",         // 上限先查，别撞墙
                "sinceSeq",           // 日志增量拉取，别重复拉全量
            ] {
                assert!(ins.contains(key), "指引里应提到 {}: {}", key, ins);
            }
        });
    }

    /// 没有串口设备时**立刻**失败，而不是"点按钮 → 等 6 秒轮询超时"（Agent 会白等还拿到含糊原因）。
    #[test]
    fn serial_open_fails_fast_when_the_machine_has_no_port() {
        assert!(no_serial_port_hint(0).is_some(), "0 个串口要给出明确原因");
        let msg = no_serial_port_hint(0).unwrap();
        assert!(msg.contains("serial_list_ports"), "要告诉 Agent 下一步: {}", msg);
        assert!(no_serial_port_hint(1).is_none(), "有串口就不该拦");
    }

    /// 只读（沙箱）模式：写操作**一个字都不许改**。
    ///
    /// 关键断言不是"返回了错误"，而是**假前端一次都没被调用** —— 界面没动、串口没动、
    /// 配置文件没写。只回错误但偷偷改了东西，比不拦更糟。
    #[test]
    fn read_only_mode_blocks_writes_without_touching_anything() {
        block_on(async {
            use std::sync::atomic::Ordering;
            let c = core();
            let touched = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
            {
                let touched = touched.clone();
                let mut slot = c.test_ui.lock().unwrap_or_else(|e| e.into_inner());
                *slot = Some(Box::new(move |_op: &str, _p: &Value| {
                    touched.fetch_add(1, Ordering::Relaxed);
                    json!({ "ok": true, "value": {} })
                }));
            }

            // ① 只读工具照常能用（否则就等于"AI 什么都做不了"）
            let r = call(&c, &raw_call("ui_list", &json!({}))).await;
            assert_eq!(r["result"]["isError"], false, "只读工具不该被拦: {}", r);
            assert_eq!(touched.load(Ordering::Relaxed), 1, "只读工具应当真的走了界面桥");

            // ② 写工具：全部被 -32007 拦下，且**没有碰界面**
            c.cfg.lock().unwrap_or_else(|e| e.into_inner()).expose.read_only = true;
            let writes = [
                ("ui_set", json!({ "path": "x.y", "value": 1 })),
                ("ui_click", json!({ "path": "x.y" })),
                ("serial_open", json!({})),
                ("serial_close", json!({})),
                ("serial_send", json!({ "data": "AT" })),
                ("serial_set_baud", json!({ "baud": 115200 })),
                ("serial_select_port", json!({ "port": "COM1" })),
                ("serial_set_frame", json!({ "dataBits": 8 })),
                ("serial_set_lines", json!({ "dtr": true })),
                ("serial_set_display", json!({ "echo": true })),
                ("serial_clear", json!({})),
                ("log_clear", json!({ "channel": "app" })),
                ("mcp_config_set", json!({ "patch": { "expose": { "readOnly": false } } })),
                // ⚠️ 带 index 的快速指令是"真的发出去"，必须拦；不带 index 的列举是只读，不能拦
                ("serial_quick_cmd", json!({ "index": 0 })),
            ];
            let before = touched.load(Ordering::Relaxed);
            for (name, args) in &writes {
                let r = call(&c, &raw_call(name, args)).await;
                assert!(r.get("error").is_none(), "{} 应是 result+isError 而不是协议错误: {}", name, r);
                assert_eq!(r["result"]["isError"], true, "{} 在只读模式下必须失败: {}", name, r);
                let text = r["result"]["content"][0]["text"].as_str().unwrap_or("");
                assert!(
                    text.contains("-32007"),
                    "{} 要用 -32007 表明「被策略拒绝」: {}",
                    name,
                    text
                );
                assert!(text.contains("没有执行"), "{} 要说清没执行: {}", name, text);
            }
            assert_eq!(
                touched.load(Ordering::Relaxed),
                before,
                "写操作被拦时**不许碰界面**（变了东西就是假拦截）"
            );

            // ③ 只读模式下"能不能自己关掉它"：不能（mcp_config_set 已在上面的写列表里被拦）
            assert!(
                c.read_only(),
                "AI 不该有办法在只读模式下把自己放出来（必须由用户在弹窗里关）"
            );

            // ④ 关掉之后写操作立刻恢复
            c.cfg.lock().unwrap_or_else(|e| e.into_inner()).expose.read_only = false;
            let r = call(&c, &raw_call("ui_set", &json!({ "path": "x.y", "value": 1 }))).await;
            assert_eq!(r["result"]["isError"], false, "关掉只读后写操作应恢复: {}", r);
        });
    }

    /// `is_write_call` 的边界：同名工具按**调用**判定，而不是按工具名一刀切。
    #[test]
    fn write_classification_is_per_call() {
        assert!(is_write_call("serial_quick_cmd", &json!({ "index": 0 })), "带 index = 真的执行");
        assert!(!is_write_call("serial_quick_cmd", &json!({})), "不带 index/action = 只列举");
        // 带 action 的每一种（loop 开关循环、add/update/remove 改列表、group 改组）都算写：
        // 只读模式下必须整类拦下，漏一个就是"只读模式下界面被改了"
        for a in ["loop", "add", "update", "remove", "group"] {
            assert!(
                is_write_call("serial_quick_cmd", &json!({ "action": a })),
                "action={a} 也是写操作（只读模式要拦下）"
            );
        }
        assert!(is_write_call("ctl_serial_conn_portselect", &json!({})), "ctl_* 一律算写");
        assert!(is_write_call("ui_set", &json!({})) && !is_write_call("ui_get", &json!({})));
        // 写工具表里不能有"不存在的工具"这种笔误
        let names: Vec<String> = tool_defs()
            .iter()
            .filter_map(|t| t["name"].as_str().map(|s| s.to_string()))
            .collect();
        for w in WRITE_TOOLS {
            assert!(names.iter().any(|n| n == w), "WRITE_TOOLS 里的 {} 不是内置工具", w);
        }
    }

    /// 危险动作的二次确认（设计 §9 / §16.6.4）。四条一起才叫测过：
    /// ① 表里的每一项都是真工具、schema 里有 confirm、有一句后果；
    /// ② 没带 confirm → **拦下且没执行**（-32006，而不是走到界面那一步）；
    /// ③ 带了 confirm → 放行（这时才会走到界面/后端）；
    /// ④ 普通工具不要求 confirm（否则 Agent 会以为普通操作也能"确认了事"）。
    #[test]
    fn danger_tools_require_explicit_confirm() {
        let defs = tool_defs();
        assert!(!DANGER_TOOLS.is_empty(), "危险动作表空了？那这套机制就没被测到");
        for (name, why) in DANGER_TOOLS {
            let d = defs
                .iter()
                .find(|t| t["name"] == *name)
                .unwrap_or_else(|| panic!("危险工具 {name} 不在工具表里（笔误？）"));
            assert!(!why.is_empty(), "{name} 要写一句后果，AI 才知道自己在确认什么");
            assert!(
                d["inputSchema"]["properties"]["confirm"].is_object(),
                "{name} 的 schema 必须声明 confirm，否则客户端不会传"
            );
            assert!(
                d["description"].as_str().unwrap_or("").contains("confirm"),
                "{name} 的 description 要写明要确认，否则 Agent 只会看到一次 -32006"
            );
            assert!(is_write_call(name, &json!({})), "{name} 是写操作（只读模式也要拦）");
        }
        block_on(async {
            let c = core();
            // ② 没带 confirm：**每一个**危险工具都被危险门拦下 —— 错误里点明"危险动作"、
            // 且**没有走到界面/后端那一步**（工具调用计数里不该有它 = "没执行"的证据）。
            // 逐个查而不是只查第一个：表里新加的危险工具（ADB 这两个）
            // 如果忘了接上确认门，只测第一个就漏过去了。
            for (name, _why) in DANGER_TOOLS {
                let e = call_tool(&c, name, &json!({})).await.unwrap_err();
                assert_eq!(
                    e.code, E_DEVICE_NOT_READY,
                    "{} 没确认时该用 -32006（前置条件类）：{}",
                    name, e.message
                );
                assert!(
                    e.message.contains("危险动作") && e.message.contains("confirm"),
                    "{} 要说清这是危险动作、带 confirm 重试: {}",
                    name,
                    e.message
                );
                let called = c
                    .tool_calls
                    .lock()
                    .unwrap_or_else(|x| x.into_inner())
                    .get(*name)
                    .copied()
                    .unwrap_or(0);
                assert_eq!(called, 0, "{} 被危险门拦下的调用不能计入工具调用次数", name);
            }
            // ③ 带了 confirm：放行（没有 GUI，所以这里会变成"没有界面"那类错误，而不是危险门）
            for (name, _why) in DANGER_TOOLS {
                let e2 = call_tool(&c, name, &json!({ "confirm": true }))
                    .await
                    .unwrap_err();
                assert!(
                    !e2.message.contains("危险动作"),
                    "{} 带了 confirm 就不该再被危险门拦: {}",
                    name,
                    e2.message
                );
            }
            // ④ 普通工具不受影响
            assert!(
                call_tool(&c, "app_info", &json!({})).await.is_ok(),
                "普通工具不该要求 confirm"
            );
            assert!(
                call_tool(&c, "mcp_danger", &json!({})).await.is_ok(),
                "查询危险工具表本身不该要确认（否则 AI 没法先问清后果）"
            );
        });
    }

    /// `pane_is_wsl` 的判据 —— `serial_open` 靠它决定"要不要拿 Windows 端口数卡一下"。
    ///
    /// 判错哪个方向都有代价：判成 WSL → 该拦的不拦（Windows 分栏在没有 COM 口时会白等 6 秒轮询）；
    /// 判成 Windows → **WSL 分栏直接被拒**（"本机没有可用串口" -32006，而界面上点得通）。
    ///
    /// 注意整套工具仍然是**同一套** `serial_*`（靠 `pane` 区分分栏），没有为 WSL 单开工具 ——
    /// 这里只是"同一个工具内部按分栏选数据源"。
    #[test]
    fn pane_is_wsl_matches_only_wsl_panes() {
        assert!(pane_is_wsl(&json!({ "pane": "wsl" })));
        assert!(pane_is_wsl(&json!({ "pane": "wsl-x1" })), "WSL 面板多开的监视器是 wsl-xN");
        assert!(pane_is_wsl(&json!({ "pane": "  WSL  " })), "大小写与空格都不该影响判断");

        assert!(!pane_is_wsl(&json!({})), "省略 pane = main（Windows 分栏），该走端口检查");
        assert!(!pane_is_wsl(&json!({ "pane": "main" })));
        assert!(!pane_is_wsl(&json!({ "pane": "extra-1" })));
        assert!(!pane_is_wsl(&json!({ "pane": "wslx" })), "不能只按前缀误伤：wslx 不是分栏 id");
        assert!(!pane_is_wsl(&json!({ "pane": "not-wsl" })));
    }

    #[test]
    fn serial_list_ports_tool_runs_without_opening_a_port() {        block_on(async {
            let c = core();
            let r = call(
                &c,
                r#"{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"serial_list_ports"}}"#,
            )
            .await;
            assert_eq!(r["result"]["isError"], false, "枚举串口不该失败: {}", r);
            // 注意：这条以前断言的是 `structuredContent` **是数组** —— 照实现写测试，
            // 把违反规范的行为锁死了（规范要求 object，官方 SDK 会整条拒收）。
            // 现在断言的是规范形状：对象里装 ports 数组。
            let sc = &r["result"]["structuredContent"];
            assert!(sc.is_object(), "structuredContent 必须是对象: {}", sc);
            assert!(sc["ports"].is_array(), "ports 才是数组: {}", sc);
            assert_eq!(
                sc["count"].as_u64().unwrap() as usize,
                sc["ports"].as_array().unwrap().len(),
                "count 要与 ports 长度一致"
            );
        });
    }

    // ===== S5：界面桥（McpCore 没有 AppHandle 时）=====

    #[test]
    fn ui_tools_without_gui_report_a_clear_reason() {
        block_on(async {
            let c = core(); // 单测里没有 AppHandle
            for (name, args) in [
                ("ui_list", json!({})),
                ("ui_describe", json!({"path": "serial.conn.portSelect"})),
                ("ui_get", json!({"path": "serial.conn.portSelect"})),
                ("ui_set", json!({"path": "serial.conn.portSelect", "value": "COM3"})),
                ("ui_click", json!({"path": "serial.toolbar.btnSend"})),
            ] {
                let raw = json!({
                    "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                    "params": { "name": name, "arguments": args }
                })
                .to_string();
                let r = call(&c, &raw).await;
                // 没有界面 = 工具确实跑了但失败了 → isError（不是协议错误）
                assert!(r.get("error").is_none(), "{} 不该是协议错误: {}", name, r);
                assert_eq!(r["result"]["isError"], true, "{} 无 GUI 必须报错而不是假装成功", name);
                let text = r["result"]["content"][0]["text"].as_str().unwrap_or("");
                assert!(text.contains("界面上下文"), "{} 要说清原因: {}", name, text);
            }
        });
    }

    #[test]
    fn ui_tools_validate_required_args_first() {
        block_on(async {
            let c = core();
            // 参数缺失属于"请求本身有问题" → 协议级 -32602，而不是"没有界面"
            for name in ["ui_describe", "ui_get", "ui_click"] {
                let raw = json!({
                    "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                    "params": { "name": name, "arguments": {} }
                })
                .to_string();
                let r = call(&c, &raw).await;
                assert_eq!(r["error"]["code"], E_INVALID_PARAMS, "{} 缺 path: {}", name, r);
            }
            let r = call(
                &c,
                r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ui_set","arguments":{}}}"#,
            )
            .await;
            assert_eq!(r["error"]["code"], E_INVALID_PARAMS, "ui_set 既无 path 也无 items");

            let r = call(
                &c,
                r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ui_set","arguments":{"items":"nope"}}}"#,
            )
            .await;
            assert_eq!(r["error"]["code"], E_INVALID_PARAMS, "items 必须是数组");
        });
    }

    #[test]
    fn ui_list_advertises_its_filters() {
        let def = tool_defs()
            .into_iter()
            .find(|t| t["name"] == "ui_list")
            .expect("应有 ui_list");
        let props = &def["inputSchema"]["properties"];
        for k in ["panel", "kind", "query", "cursor", "limit"] {
            assert!(props.get(k).is_some(), "ui_list 缺少过滤参数 {}", k);
        }
        // 需要 path 的工具必须把 path 标成必填，否则 AI 很容易漏传
        for name in ["ui_describe", "ui_get", "ui_click"] {
            let d = tool_defs().into_iter().find(|t| t["name"] == name).expect(name);
            let req = d["inputSchema"]["required"].as_array().cloned().unwrap_or_default();
            assert!(req.iter().any(|v| v == "path"), "{} 必须把 path 标为必填", name);
        }
    }

    // ===== S7：日志中心（纯后端，没有界面也能用）=====

    /// 全局日志中心是**共享状态**：cargo 默认并行跑测试，一个用例的 `set_enabled(false)`
    /// 会把另一个用例刚写进去的通道清掉（曾因此出现随机失败）。碰它的用例必须串行。
    static HUB_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn hub_lock() -> std::sync::MutexGuard<'static, ()> {
        HUB_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn log_tools_work_without_gui() {
        let _g = hub_lock();
        block_on(async {
            let c = core();
            let hub = crate::mcp::loghub::hub();
            hub.set_enabled(true);
            // ⚠️ 夹具串必须是**全测试集唯一**的：搜索断言用的是"恰好命中 N 条"，
            // 而 `report.rs` 的用例会拿 `panic!("boom …")` 造夹具并写进 error 通道
            // （它持的是 TEST_LOCK，不是 hub_lock，所以两者会并行）—— 曾经这里用 "boom"，
            // 于是 5 次里偶发 1 次搜到 3 条 → 偶发失败。别再用大众词当搜索夹具。
            const MARK: &str = "boom-4f21-only-this-test";
            hub.push("app", crate::mcp::loghub::LEVEL_INFO, 0, "hello-log-tool", 0);
            hub.push("ui:sys", crate::mcp::loghub::LEVEL_ERROR, 0, MARK, 0);

            // log_channels
            let ch = call(
                &c,
                r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"log_channels"}}"#,
            )
            .await;
            assert_eq!(ch["result"]["isError"], false, "{}", ch);
            let names: Vec<String> = ch["result"]["structuredContent"]["channels"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| c["channel"].as_str().unwrap().to_string())
                .collect();
            assert!(names.contains(&"app".to_string()), "{:?}", names);

            // log_tail
            let t = call(
                &c,
                r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"log_tail","arguments":{"channel":"app","lines":10}}}"#,
            )
            .await;
            assert!(
                t["result"]["structuredContent"]["lines"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|l| l["text"] == "hello-log-tool"),
                "{}",
                t
            );

            // log_search（跨通道 + 级别）：用唯一夹具串，命中数才是确定的
            let s = call(
                &c,
                &format!(
                    r#"{{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{{"name":"log_search","arguments":{{"pattern":"{}"}}}}}}"#,
                    MARK
                ),
            )
            .await;
            assert_eq!(
                s["result"]["structuredContent"]["hits"].as_array().unwrap().len(),
                1,
                "唯一夹具串只该命中 1 条: {}",
                s
            );
            assert_eq!(s["result"]["structuredContent"]["hits"][0]["level"], "error");

            // log_stats
            let st = call(
                &c,
                r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"log_stats"}}"#,
            )
            .await;
            assert_eq!(st["result"]["isError"], false, "{}", st);

            // log_clear
            let cl = call(
                &c,
                r#"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"log_clear","arguments":{"channel":"app"}}}"#,
            )
            .await;
            assert_eq!(cl["result"]["structuredContent"]["clearedChannels"], 1);

            hub.set_enabled(false);
        });
    }

    #[test]
    fn log_tail_unknown_channel_tells_ai_what_to_do_next() {
        block_on(async {
            let c = core();
            let r = call(
                &c,
                r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"log_tail","arguments":{"channel":"nope"}}}"#,
            )
            .await;
            // 通道名是**参数值**非法 → 协议级 -32602（与"控件路径不存在"同一套规则）
            assert_eq!(r["error"]["code"], E_INVALID_PARAMS, "{}", r);
            let msg = r["error"]["message"].as_str().unwrap_or("");
            assert!(msg.contains("log_channels"), "要告诉 AI 下一步怎么做: {}", msg);
        });
    }

    /// 文本编码的核心保证：日志正文进 `content` 文本（模型侧看得到，**而且只有一份**），
    /// `structuredContent` 只留元信息。
    ///
    /// 为什么要测"只有一份"：`content` 和 `structuredContent` 都会发给客户端，
    /// 同一段日志写两遍就等于把省下的 token 又花回去 —— 那这个编码档就白加了。
    #[test]
    fn log_tail_text_format_puts_the_logs_in_the_content_text() {
        let _g = hub_lock();
        block_on(async {
            let c = core();
            let hub = crate::mcp::loghub::hub();
            hub.set_enabled(true);
            // 夹具用唯一通道名 + 唯一串：别的用例的通道/日志不许混进来
            const CH: &str = "serial:mcp-textfmt:rx";
            const MARK: &str = "AT+TXT-91c2-only-this-test";
            hub.clear(Some(CH));
            hub.push(CH, crate::mcp::loghub::LEVEL_INFO, crate::mcp::loghub::DIR_RX, MARK, 12);
            hub.push(CH, crate::mcp::loghub::LEVEL_WARN, crate::mcp::loghub::DIR_RX, "OK", 2);

            let r = call(&c, &raw_call("log_tail", &json!({ "channel": CH, "format": "text" }))).await;
            assert_eq!(r["result"]["isError"], false, "{}", r);
            let text = r["result"]["content"][0]["text"].as_str().unwrap_or("");
            assert!(text.contains("# channel="), "文本页要有头部元信息: {}", text);
            assert!(text.contains(MARK), "日志正文必须在 content 文本里: {}", text);
            assert!(text.contains("[warn]"), "级别要看得出来: {}", text);

            let sc = &r["result"]["structuredContent"];
            assert_eq!(sc["format"], "text");
            assert!(sc.get("text").is_none(), "正文已搬到 content，不该再复制一份: {}", sc);
            assert!(sc.get("lines").is_none(), "text 编码不该同时给逐行结构: {}", sc);
            assert_eq!(sc["returned"], 2);
            assert!(sc["nextSinceSeq"].as_u64().is_some(), "增量跟进的下一步要给出: {}", sc);
            assert!(sc["missed"].as_u64().is_some(), "{}", sc);

            let wire = serde_json::to_string(&r).unwrap();
            assert_eq!(wire.matches(MARK).count(), 1, "同一段日志被发了两次（token 白省）: {}", wire);

            hub.clear(Some(CH));
        });
    }

    /// `format` 写错**必须报错**，不能静默按 json 处理 ——
    /// 静默会让"我要省 token"悄悄失效，而调用方以为拿到了 text。
    #[test]
    fn log_tail_rejects_unknown_format_instead_of_silently_using_json() {
        block_on(async {
            let c = core();
            let r = call(
                &c,
                &raw_call("log_tail", &json!({ "channel": "app", "format": "plain" })),
            )
            .await;
            assert_eq!(r["error"]["code"], E_INVALID_PARAMS, "{}", r);
            let msg = r["error"]["message"].as_str().unwrap_or("");
            assert!(
                msg.contains("json") && msg.contains("text"),
                "要把可选值说出来，AI 才知道怎么改: {}",
                msg
            );
        });
    }

    /// 这个功能**存在的意义**就是省 token：同一条通道、同样的行数，
    /// text 编码的整条响应必须显著小于 json，否则这一档就不该存在。
    #[test]
    fn log_tail_text_format_is_cheaper_on_the_wire() {
        let _g = hub_lock();
        block_on(async {
            let c = core();
            let hub = crate::mcp::loghub::hub();
            hub.set_enabled(true);
            const CH: &str = "serial:mcp-cost:rx";
            hub.clear(Some(CH));
            for i in 0..60 {
                hub.push(
                    CH,
                    crate::mcp::loghub::LEVEL_INFO,
                    crate::mcp::loghub::DIR_RX,
                    &format!("OK {:04}", i),
                    8,
                );
            }
            let j = call(&c, &raw_call("log_tail", &json!({ "channel": CH, "lines": 2000 }))).await;
            let t = call(
                &c,
                &raw_call("log_tail", &json!({ "channel": CH, "lines": 2000, "format": "text" })),
            )
            .await;
            let jl = serde_json::to_string(&j).unwrap().len();
            let tl = serde_json::to_string(&t).unwrap().len();
            assert!(
                tl * 2 < jl,
                "text 必须明显更省（json={} 字节，text={} 字节）",
                jl,
                tl
            );
            // 省 token **不许**变成少给数据
            let (js, ts) = (&j["result"]["structuredContent"], &t["result"]["structuredContent"]);
            assert_eq!(js["returned"], ts["returned"], "行数不能变少");
            assert_eq!(js["seqFrom"], ts["seqFrom"]);
            assert_eq!(js["seqTo"], ts["seqTo"]);
            assert_eq!(js["mayBeIncomplete"], ts["mayBeIncomplete"]);
            assert_eq!(js["truncated"], ts["truncated"]);
            hub.clear(Some(CH));
        });
    }

    /// 三档 `mode` 是"用**信息量**换 token"的旋钮：同一批数据，三档的输出量
    /// 应该差一个数量级 —— 而且 `count` 的数字必须**精确**（不能被 limit 提前打断）。
    #[test]
    fn log_search_modes_trade_information_for_tokens() {
        let _g = hub_lock();
        block_on(async {
            let c = core();
            let hub = crate::mcp::loghub::hub();
            hub.set_enabled(true);
            const CH: &str = "serial:mcp-searchmodes:rx";
            hub.clear(Some(CH));
            let filler = "z".repeat(200); // 长行：正是"回整行"最亏的形状
            for i in 0..100 {
                let err = i % 5 == 0; // 20 条命中
                let text = format!("{} step {} {}", if err { "ERROR timeout" } else { "OK" }, i, filler);
                hub.push(
                    CH,
                    if err { crate::mcp::loghub::LEVEL_ERROR } else { crate::mcp::loghub::LEVEL_INFO },
                    crate::mcp::loghub::DIR_RX,
                    &text,
                    text.len() as u32,
                );
            }
            let lines = call(&c, &raw_call("log_search", &json!({ "channel": CH, "pattern": "ERROR", "limit": 500 }))).await;
            let matches = call(&c, &raw_call("log_search", &json!({ "channel": CH, "pattern": "ERROR", "limit": 500, "mode": "matches" }))).await;
            let count = call(&c, &raw_call("log_search", &json!({ "channel": CH, "pattern": "ERROR", "mode": "count" }))).await;

            // 计数必须精确，而且是"扫完才得出的"
            let cs = &count["result"]["structuredContent"];
            assert_eq!(cs["total"], 20, "{}", count);
            assert_eq!(cs["scanned"], 100, "{}", count);
            assert_eq!(cs["channels"][0]["count"], 20, "{}", count);
            assert!(cs.get("hits").is_none(), "count 不该回命中行: {}", cs);
            assert_eq!(cs["mode"], "count");

            // matches 只回片段（没有整行文本）
            let ms = &matches["result"]["structuredContent"];
            let mh = ms["hits"].as_array().unwrap();
            assert_eq!(mh.len(), 20, "{}", matches);
            assert_eq!(mh[0]["match"], "ERROR");
            assert!(mh[0].get("text").is_none(), "matches 只回片段: {}", mh[0]);
            assert_eq!(ms["mode"], "matches");

            // 三档的体积必须拉开（比 **structuredContent**，即数据本身；
            // 整条响应还含一段有界摘要，短结果里它的占比会盖过数据）
            let size = |v: &Value| serde_json::to_string(&v["result"]["structuredContent"]).unwrap().len();
            let (l, m, k) = (size(&lines), size(&matches), size(&count));
            assert!(k < m && m < l, "count 最省、matches 居中：lines={} matches={} count={}", l, m, k);
            assert!(k * 10 < l, "count 要比 lines 小一个数量级：lines={} count={}", l, k);
            // 整条响应同样必须是"越小信息越少"（含摘要那一份）
            let wire = |v: &Value| serde_json::to_string(v).unwrap().len();
            assert!(wire(&count) < wire(&matches) && wire(&matches) < wire(&lines), "整条响应也要拉开");
            hub.clear(Some(CH));
        });
    }

    /// `context`：命中行前后各带几行（省掉"再 tail 一次"的往返），
    /// 而且在通道两端要**夹住**（返回空数组），不是报错、也不是跨通道乱取。
    #[test]
    fn log_search_context_brings_neighbours_and_clamps_at_edges() {
        let _g = hub_lock();
        block_on(async {
            let c = core();
            let hub = crate::mcp::loghub::hub();
            hub.set_enabled(true);
            const CH: &str = "serial:mcp-ctx:rx";
            hub.clear(Some(CH));
            for t in ["a", "b", "c", "d", "e"] {
                hub.push(CH, crate::mcp::loghub::LEVEL_INFO, crate::mcp::loghub::DIR_RX, t, 1);
            }
            let mid = call(&c, &raw_call("log_search", &json!({ "channel": CH, "pattern": "c", "context": 2 }))).await;
            let h = &mid["result"]["structuredContent"]["hits"][0];
            assert_eq!(h["text"], "c");
            assert_eq!(h["before"], json!(["a", "b"]), "{}", mid);
            assert_eq!(h["after"], json!(["d", "e"]), "{}", mid);

            // 第一条：before 只能是空的（不能绕回去取到别的行）
            let first = call(&c, &raw_call("log_search", &json!({ "channel": CH, "pattern": "a", "context": 2 }))).await;
            let h = &first["result"]["structuredContent"]["hits"][0];
            assert_eq!(h["before"], json!([]), "{}", first);
            assert_eq!(h["after"], json!(["b", "c"]), "{}", first);

            // 不给 context 就不该冒出 before/after（默认行为不变）
            let plain = call(&c, &raw_call("log_search", &json!({ "channel": CH, "pattern": "c" }))).await;
            let h = &plain["result"]["structuredContent"]["hits"][0];
            assert!(h.get("before").is_none() && h.get("after").is_none(), "{}", h);
            hub.clear(Some(CH));
        });
    }

    /// 参数误用要**当场说清**，不能静默降级：`mode` 写错、`context` 配错档、
    /// `context` 超上限、`pattern` 给空串 —— 四种都必须是 -32602。
    /// （空串由通用 `require_str` 拦；这里顺带钉住"它确实被拦住了"，因为
    /// 空图案在子串模式下会变成"匹配每一行"的正则。）
    #[test]
    fn log_search_rejects_misuse_instead_of_silently_degrading() {
        block_on(async {
            let c = core();
            let cases = [
                (json!({ "pattern": "x", "mode": "grep" }), "lines"),
                (json!({ "pattern": "x", "mode": "count", "context": 3 }), "context"),
                (json!({ "pattern": "x", "context": 99 }), "context"),
                (json!({ "pattern": "" }), "非空"),
            ];
            for (args, want) in cases {
                let r = call(&c, &raw_call("log_search", &args)).await;
                assert_eq!(r["error"]["code"], E_INVALID_PARAMS, "{} 应是 -32602: {}", args, r);
                let msg = r["error"]["message"].as_str().unwrap_or("");
                assert!(
                    msg.contains(want) || msg.contains("mode") || msg.contains("match"),
                    "{} 的报错要指路（含 {:?}）: {}",
                    args,
                    want,
                    msg
                );
            }
        });
    }

    /// `adb_shell_read` 的检索档：PTY 的条目是**输出块**，所以 `count` 报的是
    /// "命中多少块 / 共多少处"，`matches` 只回片段，`lines` 给了 pattern 就只回命中的块
    /// （`scanned` 交代扫过多少块）。这也顺手证明"块里多次命中"数得对。
    #[test]
    fn adb_shell_read_modes_search_the_pty_blocks() {
        let _g = hub_lock();
        block_on(async {
            let c = core();
            let hub = crate::mcp::loghub::hub();
            hub.set_enabled(true);
            hub.clear(Some("adb:rx"));
            // 块里可以有多行、一处也可以有多次命中
            hub.push("adb:rx", crate::mcp::loghub::LEVEL_INFO, crate::mcp::loghub::DIR_RX, "I/logcat: ERROR one\nmore text", 30);
            hub.push("adb:rx", crate::mcp::loghub::LEVEL_INFO, crate::mcp::loghub::DIR_RX, "I/logcat: all good", 18);
            hub.push("adb:rx", crate::mcp::loghub::LEVEL_INFO, crate::mcp::loghub::DIR_RX, "E/logcat: ERROR two ERROR three", 31);

            let cnt = call(&c, &raw_call("adb_shell_read", &json!({ "pattern": "ERROR", "mode": "count" }))).await;
            let sc = &cnt["result"]["structuredContent"];
            assert_eq!(sc["total"], 2, "命中**块**数: {}", cnt);
            assert_eq!(sc["totalMatches"], 3, "命中**处**数（两块里一共三次）: {}", cnt);
            assert_eq!(sc["scanned"], 3);
            assert!(sc.get("items").is_none(), "count 不回条目: {}", sc);

            let m = call(&c, &raw_call("adb_shell_read", &json!({ "pattern": "ERROR", "mode": "matches" }))).await;
            let hits = m["result"]["structuredContent"]["hits"].as_array().unwrap();
            assert_eq!(hits.len(), 3, "三处各一条: {}", m);
            assert_eq!(hits[0]["match"], "ERROR");
            assert!(hits[0].get("text").is_none(), "只回片段: {}", hits[0]);
            assert!(hits[0]["seq"].as_u64().is_some(), "要能回溯到哪一块: {}", hits[0]);

            let l = call(&c, &raw_call("adb_shell_read", &json!({ "pattern": "all good" }))).await;
            let sc = &l["result"]["structuredContent"];
            assert_eq!(sc["items"].as_array().unwrap().len(), 1, "只留命中的块: {}", l);
            assert_eq!(sc["scanned"], 3, "扫过 3 块: {}", sc);
            assert_eq!(sc["mode"], "lines");
            assert_eq!(sc["count"], 1, "count = 回了几条（过滤后）");

            // 这两档就是"检索"：没给 pattern 无从计数
            let bad = call(&c, &raw_call("adb_shell_read", &json!({ "mode": "count" }))).await;
            assert_eq!(bad["error"]["code"], E_INVALID_PARAMS, "{}", bad);
            hub.clear(Some("adb:rx"));
        });
    }

    /// `ble_get_output`：① `limit`/`sinceSeq` 必须**真的转发**给前端
    /// （2026-09 修的真 bug：老实现只转发 action/pane，前端 `parseInt` 永远 NaN → 每次回全量）；
    /// ② 检索在前端那份条目上做，匹配文本 `text` 为空时取 `hex`（HEX 通知也要搜得到）。
    #[test]
    fn ble_get_output_forwards_paging_and_searches_the_items() {
        block_on(async {
            let c = core();
            let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<(String, Value)>::new()));
            {
                let seen = seen.clone();
                let mut slot = c.test_ui.lock().unwrap_or_else(|e| e.into_inner());
                *slot = Some(Box::new(move |op: &str, payload: &Value| {
                    seen.lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .push((op.to_string(), payload.clone()));
                    json!({ "ok": true, "value": {
                        "pane": "ble", "count": 3, "total": 3, "channels": { "rx": "ble:rx" },
                        "items": [
                            { "seq": 0, "ts": "t0", "kind": "rx", "hex": "01 02 FF", "text": "", "dim": "" },
                            { "seq": 1, "ts": "t1", "kind": "rx", "hex": "", "text": "ERROR timeout", "dim": "" },
                            { "seq": 2, "ts": "t2", "kind": "tx", "hex": "", "text": "AT+GMR", "dim": "" },
                        ],
                    }})
                }));
            }
            // ① 转发
            let r = call(&c, &raw_call("ble_get_output", &json!({ "limit": 2, "sinceSeq": 1 }))).await;
            assert_eq!(r["result"]["isError"], false, "{}", r);
            {
                let got = seen.lock().unwrap_or_else(|e| e.into_inner());
                assert_eq!(got.len(), 1, "{}", got.len());
                assert_eq!(got[0].1["limit"], json!(2), "limit 必须转发: {}", got[0].1);
                assert_eq!(got[0].1["sinceSeq"], json!(1), "sinceSeq 必须转发: {}", got[0].1);
            }
            // ② lines + pattern：文本搜得到；text 为空的那条按 hex 搜
            let l = call(&c, &raw_call("ble_get_output", &json!({ "pattern": "AT+GMR" }))).await;
            let sc = &l["result"]["structuredContent"];
            assert_eq!(sc["items"].as_array().unwrap().len(), 1, "{}", l);
            assert_eq!(sc["count"], 1);
            assert_eq!(sc["scanned"], 3, "扫过 3 条: {}", sc);
            let hx = call(&c, &raw_call("ble_get_output", &json!({ "pattern": "FF" }))).await;
            assert_eq!(
                hx["result"]["structuredContent"]["items"].as_array().unwrap().len(),
                1,
                "text 为空时匹配 hex: {}",
                hx
            );
            // ③ count / matches（命中里要带条目自己的 kind）
            let cnt = call(&c, &raw_call("ble_get_output", &json!({ "pattern": "ERROR", "mode": "count" }))).await;
            let sc = &cnt["result"]["structuredContent"];
            assert_eq!(sc["total"], 1, "{}", cnt);
            assert_eq!(sc["totalMatches"], 1);
            let m = call(&c, &raw_call("ble_get_output", &json!({ "pattern": "ERROR", "mode": "matches" }))).await;
            let h = &m["result"]["structuredContent"]["hits"][0];
            assert_eq!(h["match"], "ERROR", "{}", m);
            assert_eq!(h["kind"], "rx", "命中要带 kind: {}", h);
            // ④ 检索档**不**转发 limit：要扫的是整份缓冲（转发会变成"只数最后 N 条"）
            {
                let got = seen.lock().unwrap_or_else(|e| e.into_inner());
                let last = &got[got.len() - 1].1;
                assert!(last.get("limit").is_none(), "检索档不该转发 limit: {}", last);
            }
        });
    }

    /// `pattern` 的长度上限对**三个**工具都生效，而且要在**碰界面/设备之前**拦
    /// （1 MiB 的请求体塞得进一条巨型正则，编译它足以把这次调用卡住）。
    #[test]
    fn search_pattern_length_is_capped_across_the_three_tools() {
        block_on(async {
            let c = core();
            let long = "x".repeat(super::loghub::MAX_SEARCH_PATTERN_CHARS + 1);
            for tool in ["log_search", "adb_shell_read", "ble_get_output"] {
                let r = call(&c, &raw_call(tool, &json!({ "pattern": long }))).await;
                assert_eq!(r["error"]["code"], E_INVALID_PARAMS, "{} 要拦超长 pattern: {}", tool, r);
                let msg = r["error"]["message"].as_str().unwrap_or("");
                assert!(
                    msg.contains("pattern 太长") && msg.contains("maxSearchPatternChars"),
                    "{} 的报错要说清上限与去哪查: {}",
                    tool,
                    msg
                );
            }
            // 上限本身要能被客户端查到（"报出来"和"被执行"是两件事，两个都要有）
            let lim = call(&c, &raw_call("mcp_limits", &json!({}))).await;
            assert_eq!(
                lim["result"]["structuredContent"]["maxSearchPatternChars"],
                json!(super::loghub::MAX_SEARCH_PATTERN_CHARS)
            );
        });
    }

    /// 判据取自 `inputSchema`：`format` 的枚举里同时有 `text` 与 `json` 的工具就是"编码档"，
    /// 必须登记进 `TEXT_PAYLOAD_TOOLS` —— 漏登记的话 `content[].text` 会退回 600 字摘要，
    /// 只读文本的客户端等于看不到日志，而"数据确实在 structuredContent 里"让测试全绿。
    /// （`ble_write` 的 `text`/`hex` 是**载荷**格式，枚举里没有 `json`，不在此列。）
    #[test]
    fn text_format_tools_are_all_in_the_text_payload_list() {
        let mut checked = 0;
        for t in tool_defs() {
            let name = t["name"].as_str().unwrap_or("");
            let enums: Vec<String> = t["inputSchema"]["properties"]["format"]["enum"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
                .unwrap_or_default();
            if enums.iter().any(|e| e == "text") && enums.iter().any(|e| e == "json") {
                checked += 1;
                assert!(
                    TEXT_PAYLOAD_TOOLS.contains(&name),
                    "{} 有 text/json 编码档，但没登记进 TEXT_PAYLOAD_TOOLS（正文会被压成摘要）",
                    name
                );
            }
        }
        assert!(checked > 0, "判据失效了：一个编码档工具都没找到");
    }

    #[test]
    fn log_search_bad_regex_is_invalid_params_not_a_crash() {
        block_on(async {
            let c = core();
            let r = call(
                &c,
                r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"log_search","arguments":{"pattern":"([","regex":true}}}"#,
            )
            .await;
            // 非法正则同样是"参数非法"，但绝不能 panic
            assert_eq!(r["error"]["code"], E_INVALID_PARAMS, "{}", r);
            assert!(r["error"]["message"].as_str().unwrap().contains("正则"));
        });
    }

    #[test]
    fn log_clear_keeps_channel_so_followup_tail_works() {
        let _g = hub_lock();
        block_on(async {
            let c = core();
            let hub = crate::mcp::loghub::hub();
            hub.set_enabled(true);
            hub.push("ui:sys", crate::mcp::loghub::LEVEL_INFO, 0, "x", 0);
            let cl = call(
                &c,
                r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"log_clear","arguments":{"channel":"ui:sys"}}}"#,
            )
            .await;
            assert!(cl["result"]["structuredContent"]["clearedChannels"].as_u64().unwrap() >= 1);
            // 清空后紧接着 tail 必须成功（返回空），不能报"没有这个通道"
            let t = call(
                &c,
                r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"log_tail","arguments":{"channel":"ui:sys"}}}"#,
            )
            .await;
            assert_eq!(t["result"]["isError"], false, "清空后 tail 应正常: {}", t);
            assert_eq!(
                t["result"]["structuredContent"]["lines"].as_array().unwrap().len(),
                0
            );
            hub.set_enabled(false);
        });
    }

    // ===== S8：AI 调用记录与配置 =====

    /// 把记录文件指向临时目录（绝不写用户真实的 %APPDATA%）
    fn core_with_calllog(tag: &str) -> (Arc<McpCore>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("seahi-s8-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let c = McpCore::new();
        c.calllog
            .set_path(Some(dir.join(crate::mcp::calllog::CALL_LOG_FILE)));
        (Arc::new(c), dir)
    }

    #[test]
    fn tool_calls_are_recorded_to_the_ai_call_log() {
        block_on(async {
            let (c, dir) = core_with_calllog("record");
            let _ = call(
                &c,
                r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"app_info"}}"#,
            )
            .await;
            let _ = call(
                &c,
                r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"nope"}}"#,
            )
            .await;

            let raw = std::fs::read_to_string(dir.join(crate::mcp::calllog::CALL_LOG_FILE)).unwrap();
            let lines: Vec<&str> = raw.lines().collect();
            assert_eq!(lines.len(), 2, "成功与失败都要留痕:\n{}", raw);
            let a: Value = serde_json::from_str(lines[0]).unwrap();
            assert_eq!(a["tool"], "app_info");
            assert_eq!(a["ok"], true);
            assert_eq!(a["session"], "unknown", "handle_raw 简写用占位会话名");
            let b: Value = serde_json::from_str(lines[1]).unwrap();
            assert_eq!(b["tool"], "nope");
            assert_eq!(b["ok"], false, "协议级失败也要记（审计要完整）");
            let _ = std::fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn session_id_is_recorded_when_called_with_session() {
        block_on(async {
            let (c, dir) = core_with_calllog("session");
            let _ = handle_raw_with_session(
                &c,
                r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"app_info"}}"#,
                "abc123",
            )
            .await;
            let raw = std::fs::read_to_string(dir.join(crate::mcp::calllog::CALL_LOG_FILE)).unwrap();
            let a: Value = serde_json::from_str(raw.lines().next().unwrap()).unwrap();
            assert_eq!(a["session"], "abc123", "记录要能查出是哪个会话调的");
            let _ = std::fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn mcp_calls_and_stats_read_back_the_records() {
        block_on(async {
            let (c, dir) = core_with_calllog("query");
            for _ in 0..3 {
                let _ = call(
                    &c,
                    r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"app_info"}}"#,
                )
                .await;
            }
            let r = call(
                &c,
                r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"mcp_calls","arguments":{"limit":2}}}"#,
            )
            .await;
            let sc = &r["result"]["structuredContent"];
            assert_eq!(sc["returned"], 2, "limit 要生效: {}", sc);
            assert!(sc["file"].as_str().unwrap().ends_with("ai-calls.jsonl"));

            let f = call(
                &c,
                r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"mcp_calls","arguments":{"tool":"nope"}}}"#,
            )
            .await;
            assert_eq!(f["result"]["structuredContent"]["returned"], 0, "按工具过滤");

            let md = call(
                &c,
                r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"mcp_calls","arguments":{"format":"md"}}}"#,
            )
            .await;
            assert!(
                md["result"]["structuredContent"]["text"].as_str().unwrap().contains("| 时间 |"),
                "md 格式要可用"
            );

            let s = call(
                &c,
                r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"mcp_stats"}}"#,
            )
            .await;
            assert!(s["result"]["structuredContent"]["callLog"]["totalCalls"]
                .as_u64()
                .unwrap()
                >= 4);
            let _ = std::fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn mcp_config_get_masks_the_token() {
        block_on(async {
            let c = core();
            c.cfg.lock().unwrap().server.token = "supersecret1234".into();
            let r = call(
                &c,
                r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"mcp_config_get"}}"#,
            )
            .await;
            let sc = &r["result"]["structuredContent"];
            let text = serde_json::to_string(sc).unwrap();
            assert!(
                !text.contains("supersecret1234"),
                "绝不能把 token 原文回给 AI（会进对话记录）: {}",
                text
            );
            assert_eq!(sc["server"]["hasToken"], true);
            assert_eq!(sc["server"]["tokenMasked"], "…1234");
            assert!(sc["callLog"].is_object(), "配置摘要要含记录设置");
        });
    }

    #[test]
    fn mcp_config_set_rejects_dangerous_or_unknown_keys() {
        block_on(async {
            let c = core();
            // 这几条都在**写盘之前**就报错 → 不会碰用户真实配置
            for (patch_text, why) in [
                (r#"{"server":{"token":"hacked"}}"#, "想改 token"),
                (r#"{"server":{"host":"0.0.0.0"}}"#, "想监听非回环"),
                (r#"{"whatever":1}"#, "未知顶层键"),
                (r#"{"server":{"port":99999}}"#, "非法端口"),
                (r#"{"callLog":{"noSuchKey":1}}"#, "未知记录设置"),
            ] {
                let patch: Value = serde_json::from_str(patch_text).unwrap();
                let raw = json!({
                    "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                    "params": { "name": "mcp_config_set", "arguments": { "patch": patch } }
                })
                .to_string();
                let r = call(&c, &raw).await;
                assert_eq!(r["error"]["code"], E_INVALID_PARAMS, "{} 应被拒: {}", why, r);
            }
            // 缺 patch
            let r = call(
                &c,
                r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"mcp_config_set","arguments":{}}}"#,
            )
            .await;
            assert_eq!(r["error"]["code"], E_INVALID_PARAMS);
        });
    }

    /// 合法补丁必须走**注入的写盘函数**（测试里写内存/临时目录），不碰真实文件
    #[test]
    fn config_patch_goes_through_the_injected_writer_only() {
        let c = std::sync::Arc::new(McpCore::new());
        let saved: std::sync::Arc<std::sync::Mutex<Vec<String>>> = Default::default();
        let s2 = saved.clone();
        let r = crate::mcp::apply_config_patch_with(
            &c,
            &json!({"callLog": {"includeResults": true, "maxFileMiB": 5}}),
            move |cfg| {
                s2.lock()
                    .unwrap()
                    .push(serde_json::to_string(cfg).unwrap());
                Ok(())
            },
        )
        .expect("合法补丁应成功");

        assert_eq!(r["needRestart"], false, "callLog 改动不需要重启");
        assert_eq!(r["config"]["callLog"]["includeResults"], true);
        assert_eq!(r["config"]["callLog"]["maxFileMiB"], 5);
        assert_eq!(saved.lock().unwrap().len(), 1, "必须只走注入的写盘函数");
        assert!(c.calllog.cfg().include_results, "记录器要立即用上新设置");
        // 内存里的配置也要跟着变
        assert!(
            c.cfg.lock().unwrap().call_log.include_results,
            "core 里的配置要同步"
        );
    }

    #[test]
    fn server_patch_reports_need_restart_instead_of_restarting() {
        let c = std::sync::Arc::new(McpCore::new());
        let r = crate::mcp::apply_config_patch_with(&c, &json!({"server":{"port":7778}}), |_| Ok(()))
            .expect("应成功");
        assert_eq!(
            r["needRestart"], true,
            "改端口必须只提示、不当场重启（否则会掐断正在回话的这次调用）"
        );
        assert!(r["note"].as_str().unwrap().contains("重新启用"));
    }

    /// **这条是 S8 的核心断言**：跑一堆工具之后，同目录下的用户配置必须原封不动
    // ===== S6：全量控件工具 =====

    fn reg_entry(path: &str, kind: &str, panel: &str) -> crate::mcp::registry::RegistryEntry {
        crate::mcp::registry::RegistryEntry {
            path: path.into(),
            kind: kind.into(),
            label: format!("L:{}", path),
            panel: panel.into(),
            group: "conn".into(),
            enabled: true,
            disabled_reason: None,
            options: vec![],
        }
    }

    fn list_names(r: &Value) -> Vec<String> {
        r["result"]["tools"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|t| t["name"].as_str().unwrap_or("").to_string())
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn ctl_tools_are_hidden_until_enabled() {
        block_on(async {
            let c = core();
            c.registry
                .replace(vec![reg_entry("serial.conn.portSelect", "select", "serial")]);

            // 内置工具超过一页，`ctl_*` 排在它们后面 —— 必须翻完所有页再看
            let names = all_tool_names(&c).await;
            assert!(
                !names.iter().any(|n| n.starts_with("ctl_")),
                "默认不该暴露 ctl_*：几百个工具会明显拖累模型选工具的准确率"
            );

            c.cfg.lock().unwrap().expose.auto_control_tools = true;
            let names2 = all_tool_names(&c).await;
            assert!(
                names2.contains(&"ctl_serial_conn_portselect".to_string()),
                "{:?}",
                names2
            );
        });
    }

    #[test]
    fn tools_list_paginates_over_the_full_list() {
        block_on(async {
            let c = core();
            c.cfg.lock().unwrap().expose.auto_control_tools = true;
            let es: Vec<_> = (0..120)
                .map(|i| reg_entry(&format!("serial.conn.c{}", i), "button", "serial"))
                .collect();
            c.registry.replace(es);

            let r = call(&c, r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#).await;
            let page1 = r["result"]["tools"].as_array().unwrap();
            assert_eq!(page1.len(), crate::mcp::TOOLS_PAGE, "每页应为一页的容量");
            let cursor = r["result"]["nextCursor"]
                .as_str()
                .expect("还有下一页时必须给游标")
                .to_string();

            let raw = format!(
                r#"{{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{{"cursor":"{}"}}}}"#,
                cursor
            );
            let r2 = call(&c, &raw).await;
            let page2 = r2["result"]["tools"].as_array().unwrap();
            assert!(!page2.is_empty());
            assert_ne!(page1[0]["name"], page2[0]["name"], "第二页不能与第一页重复");
        });
    }

    /// 分页游标是客户端给的字符串，可以是任意 usize —— 夹取缺失会让 `cursor + page` 溢出。
    #[test]
    fn tools_list_tolerates_a_hostile_cursor() {
        block_on(async {
            let c = core();
            c.cfg.lock().unwrap().expose.auto_control_tools = true;
            c.registry
                .replace(vec![reg_entry("serial.conn.c0", "button", "serial")]);

            // 前两个会让 `cursor + page` 溢出：夹取缺失时 debug 直接 panic、
            // release 回绕成小数字 → 空工具表且不给 nextCursor（客户端会以为"服务器没有工具"）
            for bad in [
                "18446744073709551615", // usize::MAX
                "18446744073709551600", // usize::MAX - 15：加一页必溢出
                "99999999999999999999", // 超出 usize：parse 失败 → 当作 0
                "-5",                   // 负数：parse 失败 → 当作 0
                "abc",
            ] {
                let raw = format!(
                    r#"{{"jsonrpc":"2.0","id":9,"method":"tools/list","params":{{"cursor":"{}"}}}}"#,
                    bad
                );
                let r = call(&c, &raw).await;
                assert!(
                    r["result"]["tools"].is_array(),
                    "游标 {} 不能让 tools/list 出错（应为正常响应）：{}",
                    bad,
                    r
                );
            }

            // 越界游标 = 确定性的空页，而不是 panic、也不是把第一页再给一遍
            let raw =
                r#"{"jsonrpc":"2.0","id":9,"method":"tools/list","params":{"cursor":"100000"}}"#;
            let r = call(&c, &raw).await;
            assert_eq!(r["result"]["tools"].as_array().unwrap().len(), 0);
            assert!(r["result"]["nextCursor"].is_null(), "最后一页不该再给游标");
        });
    }

    /// 长度闸门必须发生在**碰界面之前**（AGENTS #10）：没有界面上下文时，超长入参也得先拿到
    /// `-32602`（"改参数重试"），而不是含糊的 `-32006`（"没有界面"）—— 后者会让调用方以为
    /// 是 GUI 的锅，从而去重试同一个超长请求。边界值（正好等于上限）必须放行。
    #[test]
    fn overlong_input_is_rejected_before_touching_the_ui() {
        block_on(async {
            let c = core(); // 没有界面上下文

            // ① 快速指令内容超长 → -32602
            let long_value = "A".repeat(MAX_QUICK_CMD_VALUE_CHARS + 1);
            let r = call(
                &c,
                &raw_call("serial_quick_cmd", &json!({ "action": "add", "value": long_value })),
            )
            .await;
            assert_eq!(
                r["error"]["code"], E_INVALID_PARAMS,
                "超长指令内容应先报 -32602：{}",
                r
            );
            assert!(
                r["error"]["message"].as_str().unwrap_or("").contains("上限"),
                "错误信息要说清上限：{}",
                r
            );

            // ② 组名超长 → -32602
            let long_name = "组".repeat(MAX_QUICK_CMD_LABEL_CHARS + 1);
            let r = call(
                &c,
                &raw_call(
                    "serial_quick_cmd",
                    &json!({ "action": "group", "op": "rename", "name": long_name }),
                ),
            )
            .await;
            assert_eq!(r["error"]["code"], E_INVALID_PARAMS, "超长组名应先报 -32602：{}", r);

            // ③ 正好等于上限：长度校验放行 → 这才轮到"没有界面"
            let just_ok = "A".repeat(MAX_QUICK_CMD_VALUE_CHARS);
            let r = call(
                &c,
                &raw_call("serial_quick_cmd", &json!({ "action": "add", "value": just_ok })),
            )
            .await;
            assert_eq!(r["result"]["isError"], true, "边界值应放行到界面层：{}", r);
            assert!(
                r["result"]["content"][0]["text"]
                    .as_str()
                    .unwrap_or("")
                    .contains("-32006"),
                "放行后应报「没有界面」：{}",
                r
            );

            // ③.5 每条指令的等待参数也要有上限（2026-09 教训：在 limits 里报出来 ≠ 被执行）
            for (bad, what) in [
                (json!({ "action": "update", "index": 0, "timeoutMs": MAX_QUICK_CMD_TIMEOUT_MS + 1 }), "timeoutMs 超限"),
                (json!({ "action": "update", "index": 0, "retry": MAX_QUICK_CMD_RETRY + 1 }), "retry 超限"),
                (json!({ "action": "update", "index": 0, "expect": "A".repeat(MAX_QUICK_CMD_EXPECT_CHARS + 1) }), "期望词超长"),
                (json!({ "action": "update", "index": 0, "delayMs": MAX_QUICK_CMD_TIMEOUT_MS + 1 }), "旧拼写 delayMs 同样受超时上限约束"),
            ] {
                let r = call(&c, &raw_call("serial_quick_cmd", &bad)).await;
                assert_eq!(
                    r["error"]["code"], E_INVALID_PARAMS,
                    "{what} 应先报 -32602（碰界面之前就拦下）：{r}"
                );
            }

            // ④ `ui_set` 单条 value 也要有界（只挡条数挡不住"一条巨型字符串"）
            let huge = "A".repeat(MAX_UI_SET_VALUE_CHARS + 1);
            let r = call(
                &c,
                &raw_call("ui_set", &json!({ "items": [{ "path": "a.b", "value": huge }] })),
            )
            .await;
            assert_eq!(
                r["error"]["code"], E_INVALID_PARAMS,
                "ui_set 单条 value 超长应先报 -32602：{}",
                r
            );
            let ui_ok = "A".repeat(MAX_UI_SET_VALUE_CHARS);
            let r = call(
                &c,
                &raw_call("ui_set", &json!({ "items": [{ "path": "a.b", "value": ui_ok }] })),
            )
            .await;
            assert_eq!(r["result"]["isError"], true, "ui_set 的边界值应放行：{}", r);

            // ⑤ 上限必须对客户端公开（别让人靠撞墙发现）
            let lim = call(&c, &raw_call("mcp_limits", &json!({}))).await;
            assert_eq!(
                lim["result"]["structuredContent"]["maxUiSetValueChars"],
                json!(MAX_UI_SET_VALUE_CHARS)
            );
            assert_eq!(
                lim["result"]["structuredContent"]["maxQuickCmdValueChars"],
                json!(MAX_QUICK_CMD_VALUE_CHARS)
            );

            // ⑥ ADB 写入量：这一头是**设备的 shell**，超限同样要在碰界面之前报 -32602
            let long_adb = "A".repeat(MAX_ADB_WRITE_CHARS + 1);
            let r = call(
                &c,
                &raw_call("adb_shell_write", &json!({ "data": long_adb, "confirm": true })),
            )
            .await;
            assert_eq!(
                r["error"]["code"], E_INVALID_PARAMS,
                "adb_shell_write 超长应先报 -32602：{}",
                r
            );
            assert!(
                r["error"]["message"].as_str().unwrap_or("").contains("上限")
                    || r["error"]["message"].as_str().unwrap_or("").contains("最多"),
                "错误信息要说清上限：{}",
                r
            );
            // 边界值（正好等于上限）放行 → 这才轮到"没有界面"
            let adb_ok = "A".repeat(MAX_ADB_WRITE_CHARS);
            let r = call(
                &c,
                &raw_call("adb_shell_write", &json!({ "data": adb_ok, "confirm": true })),
            )
            .await;
            assert_eq!(r["result"]["isError"], true, "边界值应放行到界面层：{}", r);
            assert!(
                r["result"]["content"][0]["text"].as_str().unwrap_or("").contains("-32006"),
                "放行后应报「没有界面」：{}",
                r
            );

            // ⑦ ADB 终端尺寸：0/1/超上限都是参数问题（面板自己的下限是 2）
            for bad in [0u64, 1, MAX_ADB_COLS + 1] {
                let r = call(&c, &raw_call("adb_shell_resize", &json!({ "cols": bad, "rows": 40 }))).await;
                assert_eq!(
                    r["error"]["code"], E_INVALID_PARAMS,
                    "adb_shell_resize cols={} 应先报 -32602：{}",
                    bad, r
                );
            }
            for bad in [0u64, MIN_ADB_DIM - 1, MAX_ADB_ROWS + 1] {
                let r = call(&c, &raw_call("adb_shell_resize", &json!({ "cols": 120, "rows": bad }))).await;
                assert_eq!(
                    r["error"]["code"], E_INVALID_PARAMS,
                    "adb_shell_resize rows={} 应先报 -32602：{}",
                    bad, r
                );
            }
            // 边界值放行（2 与 1000 都算合法）
            for (cols, rows) in [(MIN_ADB_DIM, MIN_ADB_DIM), (MAX_ADB_COLS, MAX_ADB_ROWS)] {
                let r = call(
                    &c,
                    &raw_call("adb_shell_resize", &json!({ "cols": cols, "rows": rows })),
                )
                .await;
                assert_eq!(
                    r["result"]["isError"], true,
                    "边界尺寸 {cols}x{rows} 应放行到界面层：{}",
                    r
                );
            }

            // ⑧ 新增的上限同样必须公开（AGENTS #10：报不出来就等于让人撞墙）
            let lim = call(&c, &raw_call("mcp_limits", &json!({}))).await;
            assert_eq!(
                lim["result"]["structuredContent"]["maxAdbWriteChars"],
                json!(MAX_ADB_WRITE_CHARS)
            );
            assert_eq!(lim["result"]["structuredContent"]["maxAdbCols"], json!(MAX_ADB_COLS));
            assert_eq!(lim["result"]["structuredContent"]["maxAdbRows"], json!(MAX_ADB_ROWS));
        });
    }

    /// 页大小必须严格落在 `1..=MAX_BLE_DEVICE_PAGE`。
    ///
    /// `limit: 0` 在界面侧的含义是"不限"（`mcpBleScanResult` 就这么实现的），放它过去就等于
    /// 客户端绕过"每页最多 200 台"、一次把全部拉走（2026-09 审计发现）。
    /// 校验同样要在**碰界面之前**：所以没界面时也必须是 -32602，而不是"没有界面"。
    #[test]
    fn device_page_limit_rejects_zero_and_too_large() {
        block_on(async {
            let c = core();
            for bad in [0u64, MAX_BLE_DEVICE_PAGE + 1] {
                let r = call(&c, &raw_call("ble_list_devices", &json!({ "limit": bad }))).await;
                assert_eq!(
                    r["error"]["code"], E_INVALID_PARAMS,
                    "ble_list_devices limit={} 应先报 -32602：{}",
                    bad, r
                );
                let r2 = call(
                    &c,
                    &raw_call("ui_get_state", &json!({ "section": "bleDevices", "limit": bad })),
                )
                .await;
                assert_eq!(
                    r2["error"]["code"], E_INVALID_PARAMS,
                    "ui_get_state limit={} 同样要拦：{}",
                    bad, r2
                );
            }
            // 边界值与"干脆不给 limit"都要放行（放行后才会走到"没有界面"那一层）
            let r = call(
                &c,
                &raw_call("ble_list_devices", &json!({ "limit": MAX_BLE_DEVICE_PAGE })),
            )
            .await;
            assert_eq!(r["result"]["isError"], true, "上限值应放行：{}", r);
            let r = call(&c, &raw_call("ble_list_devices", &json!({}))).await;
            assert_eq!(r["result"]["isError"], true, "不给 limit 也应放行：{}", r);
        });
    }

    /// `ui_get_state` 的区段清单里必须有 **WSL 设备表**，而且 schema 的 `enum` 与描述要一致。
    ///
    /// 为什么值得单独一条：这条链路的两端分别是"Rust 的 enum/描述"和"前端的 if-else 链"，
    /// 少写一边的表现是**静默**的 —— 客户端照描述传 `section:"wslDevices"`，前端回一句
    /// "没有这个区段"，而两端各自的单测都是绿的（与 2026-09 那次 `notFound` 丢字段同源）。
    /// 前端那一半由 `.walkthrough/gen_ble_preview.js` 扫源码守着（AGENTS #11③）。
    #[test]
    fn ui_get_state_advertises_the_wsl_device_section() {
        let def = tool_defs()
            .into_iter()
            .find(|t| t["name"] == "ui_get_state")
            .expect("ui_get_state 必须存在");
        let enums: Vec<String> = def["inputSchema"]["properties"]["section"]["enum"]
            .as_array()
            .expect("section 必须有 enum")
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect();
        let desc = def["inputSchema"]["properties"]["section"]["description"]
            .as_str()
            .unwrap_or("");
        for want in ["bleDevices", "wslDevices"] {
            assert!(
                enums.iter().any(|e| e == want),
                "section 的 enum 里少了 {}：{:?}",
                want,
                enums
            );
            assert!(
                desc.contains(want),
                "section 的描述里少了 {}（调用方只会照描述传）：{}",
                want,
                desc
            );
        }
        // `mapControlPath` 是这条路的**关键产出**：不说，AI 就只能靠 busid 猜控件路径
        assert!(
            desc.contains("mapControlPath"),
            "描述里必须点出 mapControlPath 的用法：{}",
            desc
        );
    }

    /// WSL 设备表的文本摘要必须**报出 busid 与 COM 名**。
    ///
    /// 与 `ble_list_devices_text_carries_mac_and_name` 是同一条纪律（AGENTS #11③）：
    /// 通用渲染对数组只展开前 3 个元素，设备一多，"哪台是 COM7"就一个字都不在文本里 ——
    /// 而只读文本的客户端（和人）看到的正是这一行。用户要 AI 做的第一件事就是
    /// "把 COM7 映射到 WSL"，所以 busid（稳定身份）+ COM 名（用户嘴里的名字）缺一不可。
    #[test]
    fn ui_get_state_wsl_devices_text_carries_busid_and_com() {
        block_on(async {
            let c = core();
            {
                let mut slot = c.test_ui.lock().unwrap_or_else(|e| e.into_inner());
                *slot = Some(Box::new(|op: &str, payload: &Value| {
                    assert_eq!(op, "getState", "wslDevices 该走通用桥的 getState");
                    assert_eq!(payload["section"], "wslDevices");
                    json!({ "ok": true, "value": {
                        "wslRunning": true, "targetDistro": "", "panelOpened": true,
                        "count": 1, "mapped": 0, "note": null, "mapUnavailableReason": null,
                        "devices": [{ "busid": "2-1", "port": "COM7", "name": "USB-SERIAL CH340",
                                      "vidpid": "1A86:7523", "hasCom": true, "status": "unmapped",
                                      "wslPath": "", "wslSerial": "", "busy": false,
                                      "mapControlPath": "wsl.ui.wslMap_2_1" }],
                    }})
                }));
            }
            let r = call(&c, &raw_call("ui_get_state", &json!({ "section": "wslDevices" }))).await;
            assert_eq!(r["result"]["isError"], false, "{}", r);
            let text = r["result"]["content"][0]["text"].as_str().unwrap_or("");
            assert!(text.contains("2-1"), "文本摘要里没有 busid: {}", text);
            assert!(text.contains("COM7"), "文本摘要里没有 COM 名: {}", text);
            assert_eq!(
                r["result"]["structuredContent"]["devices"][0]["mapControlPath"],
                "wsl.ui.wslMap_2_1",
                "设备条目必须带上可直接交给 ui_set 的控件路径"
            );
        });
    }

    #[test]
    fn namespaces_limit_which_controls_are_exposed() {
        block_on(async {
            let c = core();
            {
                let mut cfg = c.cfg.lock().unwrap();
                cfg.expose.auto_control_tools = true;
                cfg.expose.namespaces = vec!["ble".into()];
            }
            c.registry.replace(vec![
                reg_entry("serial.conn.a", "button", "serial"),
                reg_entry("ble.scan.b", "button", "ble"),
            ]);
            // ⚠️ 必须用 `all_tool_names`（翻完所有页）：内置工具已超过一页（TOOLS_PAGE=50，
            // 2026-09 加上 ADB 后是 55 个），而 `ctl_*` 排在它们后面 ——
            // 只读第一页会以为"控件工具不见了"，其实只是没翻页。
            let names = all_tool_names(&c).await;
            assert!(names.contains(&"ctl_ble_scan_b".to_string()));
            assert!(
                !names.contains(&"ctl_serial_conn_a".to_string()),
                "被命名空间过滤掉了: {:?}",
                names
            );
        });
    }

    #[test]
    fn calling_a_ctl_tool_without_gui_fails_clearly() {
        block_on(async {
            let c = core();
            c.cfg.lock().unwrap().expose.auto_control_tools = true;
            c.registry
                .replace(vec![reg_entry("serial.conn.portSelect", "select", "serial")]);

            let r = call(&c, r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ctl_serial_conn_portselect","arguments":{"value":"COM3"}}}"#).await;
            assert_eq!(r["result"]["isError"], true, "{}", r);
            assert!(r["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("界面上下文"));

            let r2 = call(
                &c,
                r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ctl_nope","arguments":{}}}"#,
            )
            .await;
            assert_eq!(r2["error"]["code"], E_INVALID_PARAMS, "{}", r2);
            assert!(
                r2["error"]["message"].as_str().unwrap().contains("ui_list"),
                "要告诉 AI 下一步怎么做: {}",
                r2["error"]["message"]
            );
        });
    }

    #[test]
    fn ui_get_state_without_gui_fails_clearly() {
        block_on(async {
            let c = core();
            let r = call(
                &c,
                r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ui_get_state","arguments":{}}}"#,
            )
            .await;
            assert_eq!(r["result"]["isError"], true, "{}", r);
            assert!(r["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("界面上下文"));
        });
    }

    #[test]
    fn expose_patch_validates_panel_names() {
        let c = std::sync::Arc::new(McpCore::new());
        // 打错字必须报错，否则会出现"工具全没了却不知道原因"
        let e = crate::mcp::apply_config_patch_with(
            &c,
            &json!({"expose":{"namespaces":["sersial"]}}),
            |_| Ok(()),
        );
        assert!(e.is_err());
        assert!(e.unwrap_err().contains("未知面板名"));

        let ok = crate::mcp::apply_config_patch_with(
            &c,
            &json!({"expose":{"autoControlTools":true,"namespaces":["serial","ble"]}}),
            |_| Ok(()),
        );
        assert!(ok.is_ok(), "{:?}", ok.err());
        assert!(c.cfg.lock().unwrap().expose.auto_control_tools);
    }

    #[test]
    fn status_reports_registry_and_tool_counts() {
        let c = core();
        let builtin = tool_defs().len() as u64;
        assert_eq!(
            c.status_json()["builtinToolCount"].as_u64().unwrap(),
            builtin
        );
        assert_eq!(
            c.status_json()["toolCount"].as_u64().unwrap(),
            builtin,
            "默认只暴露内置工具"
        );

        c.cfg.lock().unwrap().expose.auto_control_tools = true;
        c.registry
            .replace(vec![reg_entry("serial.conn.a", "button", "serial")]);
        let st = c.status_json();
        assert_eq!(st["toolCount"].as_u64().unwrap(), builtin + 1);
        assert_eq!(st["registry"]["controls"].as_u64().unwrap(), 1);
        assert_eq!(st["registry"]["panelCounts"]["serial"].as_u64().unwrap(), 1);
    }

    /// **这条是 S8 的核心断言**：跑一堆工具之后，同目录下的用户配置必须原封不动
    #[test]
    fn running_tools_never_touches_a_user_config_in_the_same_dir() {
        block_on(async {
            let (c, dir) = core_with_calllog("isolation");
            let cfg_path = dir.join("config.json");
            let body = r#"{"version":2,"theme":"dark","monitors":{"main":{"port":"COM1"}}}"#;
            std::fs::write(&cfg_path, body).unwrap();
            let before = std::fs::metadata(&cfg_path).unwrap().modified().unwrap();

            for i in 0..5 {
                let raw = json!({
                    "jsonrpc": "2.0", "id": i, "method": "tools/call",
                    "params": { "name": "app_info" }
                })
                .to_string();
                let _ = call(&c, &raw).await;
            }
            let _ = call(
                &c,
                r#"{"jsonrpc":"2.0","id":99,"method":"tools/call","params":{"name":"mcp_calls"}}"#,
            )
            .await;

            assert_eq!(std::fs::read_to_string(&cfg_path).unwrap(), body, "用户配置内容被改了！");
            assert_eq!(
                std::fs::metadata(&cfg_path).unwrap().modified().unwrap(),
                before,
                "用户配置的 mtime 变了 —— 说明有东西写过它"
            );
            assert!(
                dir.join(crate::mcp::calllog::CALL_LOG_FILE).exists(),
                "调用记录确实写在独立文件里"
            );
            let _ = std::fs::remove_dir_all(&dir);
        });
    }
}
