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
        json!({
            "name": "ui_set",
            "description": "设置控件值。执行走的是与用户点击完全相同的路径，所以界面会同步变化。返回的是**写后的真实值**（控件可能规范化输入）。可用 items 一次设置多个。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "value": { "description": "新值：文本/数字/布尔；下拉传选项的 data-val" },
                    "items": {
                        "type": "array",
                        "description": "批量设置：[{path, value}, …]",
                        "items": { "type": "object", "properties": { "path": { "type": "string" }, "value": {} }, "required": ["path"] }
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
            "description": "取某个通道的尾部若干行。给了 since_seq 就只取它之后的（增量拉取：不重复也不丢）。返回里 mayBeIncomplete=true 表示这个通道曾丢掉过最旧的行。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "channel": { "type": "string", "description": "通道名，如 app / error / mcp / serial:main:rx / ble:rx / ui:sys" },
                    "lines": { "type": "number", "description": "最多返回多少行，默认 100，上限 2000" },
                    "since_seq": { "type": "number", "description": "只取 seq 大于它的行（用于增量跟进）" }
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
                    "case_sensitive": { "type": "boolean", "default": false },
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
                    "max_lines_per_channel": { "type": "number", "description": "每个通道最多取多少行，默认 2000，上限 20000" }
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
                    "ok_only": { "type": "boolean", "description": "true 只看成功，false 只看失败" },
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

/// 执行一个工具。参数是 MCP 传来的 `arguments` 对象。
///
/// 注意：这里的工具都必须是**非阻塞**或自身已 `spawn_blocking` 的；
/// 后续接入 `open_port` 一类会阻塞的命令时，一律走 `spawn_blocking` + 超时（§4.7 铁律 2）。
pub async fn call_tool(core: &Arc<McpCore>, name: &str, args: &Value) -> Result<Value, RpcError> {
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
            let arr = serde_json::to_value(ports)
                .map_err(|e| RpcError::new(E_INTERNAL, format!("序列化串口列表失败: {}", e)))?;
            // **必须是对象**：MCP 规范要求 `structuredContent` 是 object，给数组会被
            // 严格客户端整条拒收 —— 官方 Python SDK 就是 pydantic 校验直接报
            // `Input should be a valid dictionary`，`serial_list_ports` 这个工具
            // 在标准客户端里等于废的（2026-09 由独立一致性检查发现，148 条单测没抓到）。
            Ok(json!({
                "count": arr.as_array().map(|a| a.len()).unwrap_or(0),
                "ports": arr,
            }))
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
                Some(items) if items.is_array() => json!({ "items": items }),
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
                .tail(&channel, opt_u64(args, "since_seq"), lines)
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
                    opt_bool(args, "case_sensitive", false),
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
            let max = opt_u64(args, "max_lines_per_channel").unwrap_or(2000) as usize;
            Ok(super::loghub::hub().export(&channels, max))
        }
        // ===== AI 调用记录与配置（S8）=====
        "mcp_calls" => {
            let limit = opt_u64(args, "limit").unwrap_or(50) as usize;
            let tool = opt_str(args, "tool");
            let ok_only = args.get("ok_only").and_then(|v| v.as_bool());
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
pub fn limits_json() -> Value {
    json!({
        "maxSessions": super::MAX_SESSIONS,
        "sessionQueue": super::SESSION_QUEUE,
        "heartbeatSecs": super::HEARTBEAT_SECS,
        "maxBodyBytes": super::MAX_BODY_BYTES,
        "toolsPage": super::TOOLS_PAGE,
        "idleTimeoutSecs": super::IDLE_TIMEOUT_SECS,
        "rateLimitPerMin": super::RATE_LIMIT_PER_MIN,
        // 日志中心的内存边界（这几个数**是被执行的**，不只是报告值）
        "logMaxLineBytes": loghub::MAX_LINE_BYTES,
        "logTotalCapBytes": loghub::TOTAL_CAP_BYTES,
        "logMaxChannels": loghub::MAX_CHANNELS,
        "protocolVersion": PROTOCOL_VERSION,
        "protocolFallback": PROTOCOL_FALLBACK,
    })
}

// ===== 分派 =====

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

/// 给只会读文本的客户端准备一句人话摘要
fn summarize_for_text(v: &Value) -> String {
    match v {
        Value::Object(m) => {
            let mut parts: Vec<String> = Vec::new();
            for (k, val) in m.iter().take(8) {
                let s = match val {
                    Value::String(s) => s.clone(),
                    Value::Array(a) => format!("{} 项", a.len()),
                    other => other.to_string(),
                };
                parts.push(format!("{}={}", k, s));
            }
            parts.join(", ")
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
                }
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
        }
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

    #[test]
    fn serial_list_ports_tool_runs_without_opening_a_port() {
        block_on(async {
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
            hub.push("app", crate::mcp::loghub::LEVEL_INFO, 0, "hello-log-tool", 0);
            hub.push("ui:sys", crate::mcp::loghub::LEVEL_ERROR, 0, "boom", 0);

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

            // log_search（跨通道 + 级别）
            let s = call(
                &c,
                r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"log_search","arguments":{"pattern":"boom"}}}"#,
            )
            .await;
            assert_eq!(s["result"]["structuredContent"]["hits"].as_array().unwrap().len(), 1);
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
            assert!(text.contains("boom"), "导出应包含各通道内容: {}", text);
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
