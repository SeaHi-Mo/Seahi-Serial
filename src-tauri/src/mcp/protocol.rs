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
8) 若 mcp_status 的 readOnly 为 true，说明用户开了**只读（沙箱）模式**：所有写操作会被拒（错误码 -32007，且**没有执行**）。这不是参数问题，别重试、也别绕路，直接告诉用户「请到 MCP 弹窗里关掉只读模式」即可。";

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
];

/// 判断**这一次调用**算不算写操作。
///
/// 为什么不能只看工具名：`serial_quick_cmd` 不带 `index` 是"列出快速指令"（只读），
/// 带 `index` 就是"真的把那条指令发出去"（写）。**只读模式必须按调用判，不能按工具判** ——
/// 否则要么漏放一个真写操作进来，要么把只读的列举也一起禁掉。
pub fn is_write_call(name: &str, args: &Value) -> bool {
    if name.starts_with("ctl_") {
        return true; // 每个 ctl_* 都是"改某个控件"
    }
    if name == "serial_quick_cmd" {
        return args.get("index").is_some();
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
            "description": "枚举本机可用串口（端口名 / 友好名称 / 产品名）。只读，不会打开端口。返回 {count, ports:[…]}。",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        // ===== 串口语义工具（S12）=====
        // 为什么要有它们：通用控件桥（ui_*）用"控件路径"寻址，多分栏时会撞名、也读不懂意图；
        // 而 AI 真正要表达的是"选 COM3 / 波特率 115200 / 开始监控 / 发这一帧"。
        // 实现上**不另写一套逻辑**：改值走前端 mcpWriteEl（与 ui_set 同一函数）、点按钮走 el.click()，
        // 所以界面必然跟着变。分栏用 pane（main / extra-1 / …）指定，省略即 main。
        json!({
            "name": "serial_get_state",
            "description": "读某个串口分栏的完整状态：端口、波特率、帧格式(数据位/停止位/校验)、行尾、DTR/RTS、查看模式、行号/时间戳/回显/自动滚动/自动重连/终端模式、**是否正在监控**、输出行数与字节数、发送历史条数、以及全部分栏名。省略 pane 默认 main。**操作串口前先调它**。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pane": { "type": "string", "description": "分栏名：main / extra-1 / extra-2 …；省略=main" }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "serial_select_port",
            "description": "选串口分栏要用的端口（等价于在「端口」下拉里选一项）。值必须是 serial_list_ports 返回的端口名；给错会回列可选值。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "port": { "type": "string", "description": "端口名，如 COM3" },
                    "pane": { "type": "string", "description": "分栏名，省略=main" }
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
                    "pane": { "type": "string", "description": "分栏名，省略=main" }
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
                    "pane": { "type": "string", "description": "分栏名，省略=main" }
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
                    "pane": { "type": "string", "description": "分栏名，省略=main" }
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
                    "pane": { "type": "string", "description": "分栏名，省略=main" }
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
                    "pane": { "type": "string", "description": "分栏名，省略=main" }
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
                    "pane": { "type": "string", "description": "分栏名，省略=main" }
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
                    "pane": { "type": "string", "description": "分栏名，省略=main" }
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
                    "pane": { "type": "string", "description": "分栏名，省略=main" }
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
                    "pane": { "type": "string", "description": "分栏名，省略=main" }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "serial_get_output",
            "description": "读该分栏**实际收发的内容**（串口监视器的核心：设备刚才回了什么）。默认收+发都返回，按时间归并；每条带 dir 区分。数据取自日志中心，与 log_tail 是同一份存储；本工具额外的好处是**不需要你知道通道名**，且「还没收到数据」会返回空列表而不是报错。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pane": { "type": "string", "description": "分栏名，省略=main" },
                    "direction": { "type": "string", "enum": ["rx", "tx", "both"], "description": "只要收(rx)/只要发(tx)/都要(both，默认)" },
                    "lines": { "type": "number", "description": "最多返回多少行，默认 50，上限 2000" }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "serial_quick_cmd",
            "description": "快速指令（监控输出区最右侧那条可折叠分栏，默认折叠）：不带 index 就**列出全部**（每条含 index/label/value 与它自己的发送参数 seq 顺序号、delayMs 延时、hex 是否按 HEX 发；以及列表是否来自外部文件）；给了 index 就**执行**第 index 条（按该条自己的 hex 决定文本还是 HEX）。顺序号 > 0 的条目会被面板上的「循环发送」按序号依次发出。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "index": { "type": "number", "description": "要执行的快速指令下标（从 0 开始）；省略=只列不执行" },
                    "pane": { "type": "string", "description": "分栏名，省略=main" }
                },
                "additionalProperties": false
            }
        }),
        // ===== 通用界面桥（S5）：保证"没有任何控件够不到" =====
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
            "description": "设置控件值。执行走的是与用户点击完全相同的路径，所以界面会同步变化。返回的是**写后的真实值**（控件可能规范化输入）。可用 items 一次设置多个。",
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
                        "description": "serial / wsl / ble / theme / window / monitors；省略=全部",
                        "enum": ["serial", "wsl", "ble", "theme", "window", "monitors"]
                    }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "ui_click",
            "description": "点一个按钮/开关（等价于 ui_set 传 true，但语义更清楚）。",
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
            "description": "取某个通道的尾部若干行。给了 sinceSeq 就只取它之后的（增量拉取：不重复也不丢）。返回里 mayBeIncomplete=true 表示这个通道曾丢掉过最旧的行。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "channel": { "type": "string", "description": "通道名，如 app / error / mcp / serial:main:rx / ble:rx / ui:sys" },
                    "lines": { "type": "number", "description": "最多返回多少行，默认 100，上限 2000" },
                    "sinceSeq": { "type": "number", "description": "只取 seq 大于它的行（用于增量跟进）；也接受旧拼写 since_seq" }
                },
                "required": ["channel"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "log_search",
            "description": "在日志里检索（子串或正则）。不给 channel 就搜所有通道。返回命中行及其 channel/seq，便于继续 log_tail。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pattern": { "type": "string" },
                    "channel": { "type": "string", "description": "限定通道；省略=全部" },
                    "regex": { "type": "boolean", "description": "true 时 pattern 按正则解释，默认 false" },
                    "caseSensitive": { "type": "boolean", "default": false, "description": "区分大小写；也接受旧拼写 case_sensitive" },
                    "limit": { "type": "number", "description": "最多命中数，默认 100，上限 500" }
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
        json!({
            "name": "log_export",
            "description": "把若干通道的日志按时间归并成一段纯文本（带时间戳/通道/级别前缀）。本轮只返回文本，不写文件。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "channels": { "type": "array", "items": { "type": "string" }, "description": "要导出的通道名；省略=全部通道" },
                    "maxLinesPerChannel": { "type": "number", "description": "每个通道最多取多少行，默认 2000，上限 20000；也接受旧拼写 max_lines_per_channel" }
                },
                "additionalProperties": false
            }
        }),
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

/// `serial_send` 单次最多发多少**字符**（HEX 模式下两个字符=一个字节）。
///
/// **为什么必须有**：串口写是排队的，1 MiB 数据在 115200 波特下要发一分半钟，
/// 期间写队列一直压着 —— 那是直接干扰用户的串口会话。要发大块数据应当分批。
pub const MAX_SEND_CHARS: usize = 64 * 1024;

/// 实际暴露的工具列表 = 内置工具 + （可选的）全量控件工具。
/// `tools/list`、`mcp_status.toolCount`、客户端的配置提示词都用它，保证三处一致。
pub fn exposed_tools(core: &McpCore) -> Vec<Value> {
    let mut v = tool_defs();
    let cfg = core.cfg.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if cfg.expose.auto_control_tools && !core.registry.is_empty() {
        let (tools, _, _) = core
            .registry
            .tools(&cfg.expose.namespaces, 0, MAX_CTL_TOOLS);
        v.extend(tools);
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
            let ports = crate::list_ports().await;
            if let Some(msg) = no_serial_port_hint(ports.len()) {
                return Err(RpcError::new(E_DEVICE_NOT_READY, msg));
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
            match args.get("index") {
                Some(i) => serial_call(core, "quickRun", args, json!({ "index": i })).await,
                None => serial_call(core, "quickList", args, json!({})).await,
            }
        }
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
            core.ui_call("getState", json!({ "section": section })).await
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
            super::loghub::hub()
                .tail(&channel, opt_u64_alias(args, "sinceSeq", "since_seq"), lines)
                .map_err(|e| RpcError::new(E_INVALID_PARAMS, e))
        }
        "log_search" => {
            let pattern = require_str(args, "pattern")?;
            let ch = opt_str(args, "channel");
            super::loghub::hub()
                .search(
                    ch.as_deref(),
                    &pattern,
                    opt_bool(args, "regex", false),
                    opt_bool_alias(args, "caseSensitive", "case_sensitive", false),
                    opt_u64(args, "limit").unwrap_or(100) as usize,
                )
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
        "log_export" => {
            let channels: Vec<String> = match args.get("channels") {
                Some(v) if v.is_array() => v
                    .as_array()
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default(),
                Some(_) => return Err(RpcError::new(E_INVALID_PARAMS, "channels 必须是字符串数组")),
                None => {
                    // 省略 = 全部通道（先问 hub 有哪些）
                    super::loghub::hub().channels()["channels"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(|c| c["channel"].as_str().map(|s| s.to_string()))
                                .collect()
                        })
                        .unwrap_or_default()
                }
            };
            let max = opt_u64_alias(args, "maxLinesPerChannel", "max_lines_per_channel").unwrap_or(2000) as usize;
            Ok(super::loghub::hub().export(&channels, max))
        }
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

/// 这里的每一项都是"**别让 MCP 伤到主程序**"的具体手段：限制外部输入的大小/频率，
/// 而不是靠"客户端应该守规矩"。新增任何接受外部数组/字符串的工具时，都该在这里有一条。
pub fn limits_json() -> Value {
    json!({
        "maxSessions": super::MAX_SESSIONS,
        "sessionQueue": super::SESSION_QUEUE,
        "heartbeatSecs": super::HEARTBEAT_SECS,
        "maxBodyBytes": super::MAX_BODY_BYTES,
        "maxUiSetItems": MAX_UI_SET_ITEMS,
        "maxSendChars": MAX_SEND_CHARS,
        "toolsPage": super::TOOLS_PAGE,
        "idleTimeoutSecs": super::IDLE_TIMEOUT_SECS,
        "rateLimitPerMin": super::RATE_LIMIT_PER_MIN,
        // 快速指令外部文件：文件字节数在 Rust 侧拦，条目/名称/内容长度在解析时截断
        "maxQuickCmdItems": MAX_QUICK_CMD_ITEMS,
        "maxQuickCmdLabelChars": MAX_QUICK_CMD_LABEL_CHARS,
        "maxQuickCmdValueChars": MAX_QUICK_CMD_VALUE_CHARS,
        "maxQuickCmdFileBytes": MAX_QUICK_CMD_FILE_BYTES,
        // 日志中心的内存边界（这几个数**是被执行的**，不只是报告值）
        "logMaxLineBytes": loghub::MAX_LINE_BYTES,
        "logTotalCapBytes": loghub::TOTAL_CAP_BYTES,
        "logMaxChannels": loghub::MAX_CHANNELS,
        "protocolVersion": PROTOCOL_VERSION,
        "protocolFallback": PROTOCOL_FALLBACK,
    })
}

// ===== 分派 =====

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

/// 批量改字段/开关（前端按"字段表 / 开关表"决定是写值还是切 class）
async fn serial_apply(core: &Arc<McpCore>, args: &Value, items: Value) -> Result<Value, RpcError> {
    serial_call(core, "apply", args, json!({ "items": items })).await
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
    let want = opt_u64(args, "lines").unwrap_or(50).clamp(1, 2000) as usize;

    // 顺带完成分栏名校验（分栏不存在 → 前端回 notFound → 协议级 -32602）
    let st = serial_call(core, "state", args, json!({})).await?;
    let pane = st["pane"].as_str().unwrap_or("main").to_string();
    let chans = st.get("logChannels").cloned().unwrap_or_else(|| json!({}));
    let connected = st["isConnected"].as_bool().unwrap_or(false);

    let (per_dir, items, truncated) = collect_serial_output(&chans, &direction, want);
    let empty_dirs: Vec<&str> = ["rx", "tx"]
        .into_iter()
        .filter(|d| direction == "both" || direction == *d)
        .filter(|d| per_dir.get(*d).map(|v| v["count"].as_u64() == Some(0)).unwrap_or(false))
        .collect();

    let mut out = json!({
        "pane": pane,
        "direction": direction,
        "isConnected": connected,
        "channels": per_dir,
        "count": items.len(),
        "items": items,
        "truncated": truncated,
    });
    if empty_dirs.len() == 2 {
        out["note"] = json!("这个分栏还没有收发任何数据。若期望有数据：先用 serial_get_state 看 isConnected，未连接就 serial_open。");
    } else if empty_dirs.len() == 1 {
        out["note"] = json!(format!(
            "{} 方向还没有数据。",
            if empty_dirs[0] == "rx" { "接收" } else { "发送" }
        ));
    }
    Ok(out)
}

/// 从日志中心取某个分栏的 rx/tx 内容并按时间归并（纯函数，便于单测）。
///
/// 返回 `(每个方向的元信息, 归并后的行, 是否被截断)`。**通道不存在在这里不是错误** —— 那只是
/// "这个方向还没有数据"（对 AI 来说，这和"读不到数据"是完全不同的两件事）。
fn collect_serial_output(chans: &Value, direction: &str, want: usize) -> (Value, Vec<Value>, bool) {
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
    (Value::Object(per_dir), picked, truncated)
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

/// 工具执行失败必须返回**正常 result** + `isError: true`（MCP 规范要求），
/// 只有协议级错误才用 JSON-RPC error —— 弄混会让客户端把工具错误当成连接故障。
fn tool_result_ok(value: Value) -> Value {
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
    json!({
        "content": [{ "type": "text", "text": summarize_for_text(&structured) }],
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
            let shown: Vec<String> = a.iter().take(3).map(|x| render_brief(x, depth + 1)).collect();
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

/// 处理一条原始 JSON-RPC 报文。
/// 返回 `None` 表示这是**通知**（notification，无 id），按规范不应回包。
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
            let end = (cursor + page).min(all.len());
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
                Ok(v) => Ok(tool_result_ok(v)),
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
            let r = call(&c, r#"{"jsonrpc":"2.0","id":4,"method":"tools/list"}"#).await;
            let names: Vec<String> = r["result"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| t["name"].as_str().unwrap().to_string())
                .collect();
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
                "log_export",
            ] {
                assert!(names.contains(&want.to_string()), "缺少工具 {} 于 {:?}", want, names);
            }
            assert!(r["result"]["nextCursor"].is_null(), "本轮工具数不足一页");
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
                "log_export",
                "mcp_calls",
                "mcp_stats",
                "mcp_config_get",
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
        let (per_dir, items, truncated) = collect_serial_output(&chans, "both", 50);
        assert!(items.is_empty(), "没数据就该是空列表: {}", items.len());
        assert!(!truncated);
        assert_eq!(per_dir["rx"]["count"], 0);
        assert!(
            per_dir["rx"]["note"].as_str().unwrap().contains("还没有数据"),
            "要说清是'还没数据'而不是'读不到': {}",
            per_dir["rx"]
        );

        // ② 两个方向按时间归并（seq 各自独立，只能靠 ts 排序；push_at 是为了钉住时间戳）
        hub.push_at("serial:t1:rx", crate::mcp::loghub::LEVEL_INFO, crate::mcp::loghub::DIR_RX, 2000, "OK", 2);
        hub.push_at("serial:t1:tx", crate::mcp::loghub::LEVEL_INFO, crate::mcp::loghub::DIR_TX, 1000, "AT", 2);
        hub.push_at("serial:t1:rx", crate::mcp::loghub::LEVEL_INFO, crate::mcp::loghub::DIR_RX, 3000, "OK2", 3);
        let (per_dir, items, _) = collect_serial_output(&chans, "both", 50);
        let order: Vec<&str> = items.iter().map(|l| l["text"].as_str().unwrap()).collect();
        assert_eq!(order, vec!["AT", "OK", "OK2"], "必须按时间归并，不是按通道拼接");
        let dirs: Vec<&str> = items.iter().map(|l| l["dir"].as_str().unwrap()).collect();
        assert_eq!(dirs, vec!["tx", "rx", "rx"]);
        assert_eq!(per_dir["rx"]["count"], 2);
        assert_eq!(per_dir["tx"]["count"], 1);

        // ③ 只要一个方向
        let (per_dir, items, _) = collect_serial_output(&chans, "rx", 50);
        assert_eq!(items.len(), 2);
        assert!(per_dir.get("tx").is_none(), "只要 rx 时不该返回 tx: {}", per_dir);

        // ④ 截断：留最近的，并明确标记
        let (_, items, truncated) = collect_serial_output(&chans, "both", 2);
        assert!(truncated, "3 行只要 2 行必须标记 truncated");
        let order: Vec<&str> = items.iter().map(|l| l["text"].as_str().unwrap()).collect();
        assert_eq!(order, vec!["OK", "OK2"], "截断要留**最近**的: {:?}", order);

        hub.clear(Some("serial:t1:rx"));
        hub.clear(Some("serial:t1:tx"));
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
                    "logTotalCapBytes", "maxBodyBytes", "maxSendChars", "maxSessions",
                    "maxUiSetItems", "protocolFallback", "protocolVersion", "rateLimitPerMin",
                    "sessionQueue", "toolsPage",
                    // 快速指令外部文件的上限（加字段就要一起改这里，契约测试会拦）
                    "maxQuickCmdItems", "maxQuickCmdLabelChars", "maxQuickCmdValueChars",
                    "maxQuickCmdFileBytes",
                ], &[])),
                ("mcp_status", json!({}), Backend(&[
                    "builtinToolCount", "callLog", "configFile", "dropped", "enabled", "endpointFile",
                    "errorReports", "hasUi", "host", "lastError", "limits", "logHub", "maxSessions",
                    "port", "readOnly", "registry", "requests", "running", "sessions", "stateChanges",
                    "statusEmits", "tokenMasked", "toolCalls", "toolCount", "uiInFlight",
                    "uptimeSecs", "version",
                ], &["urlMasked"])),
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
                    "channel", "dropped", "lines", "mayBeIncomplete", "returned", "seqTo", "truncated",
                ], &[])),
                ("log_search", json!({ "pattern": "mcp" }), Backend(&[
                    "hits", "pattern", "regex", "scanned", "truncated",
                ], &[])),
                ("log_export", json!({ "maxLinesPerChannel": 3 }), Backend(&[
                    "channels", "lines", "text", "truncated",
                ], &[])),
                ("mcp_calls", json!({ "limit": 2 }), Backend(&["calls", "enabled", "file", "note", "returned"], &[])),
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
                let r = call(&c, &raw_call(name, &json!({}))).await;
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
                                "setSendAs" => json!({ "ok": true, "value": { "pane": "main", "sendAs": "hex" } }),
                                _ => json!({ "ok": false, "error": format!("假前端不认识 action: {}", action) }),
                            }
                        }
                        "list" => json!({ "ok": true, "value": { "controls": [], "total": 0 } }),
                        "describe" | "get" => json!({ "ok": true, "value": { "path": "serial.conn.portSelect", "value": "COM1" } }),
                        "getState" => json!({ "ok": true, "value": { "theme": "dark" } }),
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
                Case { tool: "serial_quick_cmd", args: json!({}),
                    pre_connected: None,
                    calls: vec![("serial", json!({ "action": "quickList" }))],
                    keys: &["pane", "items", "usable"] },
                Case { tool: "serial_quick_cmd", args: json!({ "index": 0 }),
                    pre_connected: None,
                    calls: vec![("serial", json!({ "action": "quickRun", "index": 0 }))],
                    keys: &["pane", "ran", "label", "value"] },
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
                    keys: &["theme"] },
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
                seen.push(case.tool);
            }

            // 这两张表必须覆盖同一批界面工具（漏一个就等于没测）
            seen.sort_unstable();
            seen.dedup();
            let mut want = vec![
                "serial_clear", "serial_close", "serial_get_history", "serial_get_state",
                "serial_open", "serial_quick_cmd", "serial_select_port", "serial_send",
                "serial_set_baud", "serial_set_display", "serial_set_frame", "serial_set_lines",
                "ui_click", "ui_describe", "ui_get", "ui_get_state", "ui_list", "ui_set",
            ];
            // serial_get_output 只读日志中心，但**先要过前端拿分栏名与通道名**，所以也算界面工具
            want.push("serial_get_output");
            want.sort_unstable();
            assert_eq!(seen, want, "界面工具的调用测试列表与契约表不一致");
        });
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
        assert!(!is_write_call("serial_quick_cmd", &json!({})), "不带 index = 只列举");
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

            // log_export（省略 channels = 全部）
            let ex = call(
                &c,
                r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"log_export","arguments":{}}}"#,
            )
            .await;
            let text = ex["result"]["structuredContent"]["text"].as_str().unwrap();
            assert!(text.contains(MARK), "导出应包含各通道内容: {}", text);
            assert!(text.contains("[app]"), "要标出通道名: {}", text);

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

            let r = call(&c, r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#).await;
            assert!(
                !list_names(&r).iter().any(|n| n.starts_with("ctl_")),
                "默认不该暴露 ctl_*：几百个工具会明显拖累模型选工具的准确率"
            );

            c.cfg.lock().unwrap().expose.auto_control_tools = true;
            let r2 = call(&c, r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#).await;
            assert!(
                list_names(&r2).contains(&"ctl_serial_conn_portselect".to_string()),
                "{:?}",
                list_names(&r2)
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
            let names = list_names(&call(&c, r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#).await);
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
