//! MCP（Model Context Protocol）服务器：随程序启动、**只用 SSE**、只监听回环地址。
//!
//! 设计文档：`doc/MCP_DESIGN.md`（§4 传输与运行时、§16 开发执行计划）。
//!
//! 分层（每层都能单独测）：
//! - [`aiconfig`]：`ai-config.json` / `mcp-endpoint.json`（原子写，与用户配置严格隔离）
//! - [`protocol`]：JSON-RPC 2.0 + 错误码 + 方法分派 + 工具实现（**不碰 Socket、不碰 Tauri**）
//! - [`transport`]：hyper 服务器 + SSE + 会话 + 鉴权 + 限流
//! - [`report`]：运行期错误 → 程序既有的错误上报通道（LogHub + 本地日志 + Sentry + 自建服务/SQLite）
//! - 本模块：[`McpCore`] 状态 + 启停 + Tauri 命令
//!
//! 硬性约束（§4.7）：服务器起不来**绝不能影响主功能**；任何失败都只落到 `last_error` 与日志。

pub mod aiconfig;
pub mod bridge;
pub mod calllog;
pub mod loghub;
pub mod protocol;
pub mod registry;
pub mod report;
pub mod transport;

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

// ===== 硬性上限（单一来源，便于审计；§4.8）=====
/// 最大同时会话数
pub const MAX_SESSIONS: usize = 4;
/// 每会话出站队列深度
pub const SESSION_QUEUE: usize = 256;
/// SSE 心跳间隔（秒）
pub const HEARTBEAT_SECS: u64 = 15;
/// 请求体上限
pub const MAX_BODY_BYTES: usize = 1024 * 1024;
/// `tools/list` 每页条数
pub const TOOLS_PAGE: usize = 50;
/// 会话空闲回收（秒）
pub const IDLE_TIMEOUT_SECS: u64 = 30 * 60;
/// 每会话每分钟请求上限
pub const RATE_LIMIT_PER_MIN: u32 = 60;

/// 与 Tauri 无关的核心状态（因此可以在单测里直接构造，不需要 AppHandle）
pub struct McpCore {
    pub cfg: Mutex<aiconfig::AiConfig>,
    pub running: AtomicBool,
    pub port: Mutex<Option<u16>>,
    pub last_error: Mutex<Option<String>>,
    pub started_at: Mutex<Option<Instant>>,
    pub sessions: transport::Sessions,
    pub shutdown: AtomicBool,
    /// 收到的 JSON-RPC 报文数
    pub requests: AtomicU64,
    /// 因慢消费者被丢弃的 SSE 报文数
    pub dropped: AtomicU64,
    /// 往前端推过多少次状态。单测用它断言"会话增减真的推了"（推不动时也要计数，
    /// 否则测试得有 AppHandle 才能验证）。
    pub status_emits: AtomicU64,
    /// 各工具被调用次数
    pub tool_calls: Mutex<std::collections::HashMap<String, u64>>,
    /// 前端 AppHandle：只有在 Tauri 里启动时才有（单测里为 None，所以本类型仍可脱离 Tauri 构造）
    pub app: Mutex<Option<tauri::AppHandle>>,
    /// 前后端桥（ui_* 工具靠它驱动界面）
    pub bridge: bridge::UiBridge,
    /// 前端报来的状态变更次数
    pub state_changes: AtomicU64,
    /// 最近一次状态变更（S7 会用它推 MCP 资源更新）
    pub last_change: Mutex<Option<Value>>,
    /// AI 调用记录（`ai-calls.jsonl`）。默认 `path=None`（禁用）：
    /// 只有真实运行时才装路径，单测绝不会写用户目录。
    pub calllog: calllog::CallLog,
    /// 前端上报的控件注册表（S6）：据此生成 `ctl_*` 工具
    pub registry: registry::RegistryCache,
    /// **单测专用**：假的"前端"。
    ///
    /// 装进去之后 `ui_call` 就不再要求 `AppHandle`，而是直接把 `(op, payload)` 交给它、
    /// 拿回一个"前端回执"。这样每个界面工具都能被**真的调用一遍**：参数怎么构造、
    /// 回执怎么解析、最终返回什么 —— 而不是只调到"没有界面上下文"就结束
    /// （那等于这 19 个工具一次都没被测过，用户就是这么指出的）。
    ///
    /// ⚠️ 它只覆盖 **Rust 这一半**。前端那一半（真实 handler 的行为）由
    /// `.walkthrough/gen_ble_preview.js` 把 `mcpHandleUiCmd` / `mcpSerialOp` 丢进假 DOM 里跑。
    /// **两边必须成对**：只测一边就是假的安心。
    #[cfg(test)]
    pub test_ui: Mutex<Option<Box<dyn Fn(&str, &Value) -> Value + Send + Sync>>>,
}

impl McpCore {
    pub fn new() -> Self {
        Self {
            cfg: Mutex::new(aiconfig::AiConfig::default()),
            running: AtomicBool::new(false),
            port: Mutex::new(None),
            last_error: Mutex::new(None),
            started_at: Mutex::new(None),
            sessions: transport::Sessions::default(),
            shutdown: AtomicBool::new(false),
            requests: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            status_emits: AtomicU64::new(0),
            tool_calls: Mutex::new(std::collections::HashMap::new()),
            app: Mutex::new(None),
            bridge: bridge::UiBridge::default(),
            state_changes: AtomicU64::new(0),
            last_change: Mutex::new(None),
            calllog: calllog::CallLog::default(),
            registry: registry::RegistryCache::default(),
            #[cfg(test)]
            test_ui: Mutex::new(None),
        }
    }

    pub fn from_cfg(cfg: aiconfig::AiConfig) -> Self {
        let c = Self::new();
        *c.cfg.lock().unwrap_or_else(|e| e.into_inner()) = cfg;
        c
    }

    pub fn token(&self) -> String {
        self.cfg
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .server
            .token
            .clone()
    }

    /// 是否处于**只读（沙箱）模式**：所有写操作会被拒（`E_POLICY_DENIED`）。
    /// 每次调用都读一次配置（一把锁 + 一个 bool），比缓存一份状态再同步更不容易出错。
    pub fn read_only(&self) -> bool {
        self.cfg
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .expose
            .read_only
    }

    /// 需要界面的操作都从这里拿 AppHandle（没有就是没有 GUI 上下文）
    pub fn app_handle(&self) -> Option<tauri::AppHandle> {
        self.app.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// 经前端桥执行一次界面操作（S5）。超时/繁忙/无 GUI 都返回明确的错误码。
    pub async fn ui_call(
        &self,
        op: &str,
        payload: Value,
    ) -> Result<Value, protocol::RpcError> {
        // 单测：装了假前端就直接问它（否则"每个界面工具的调用"根本到不了）
        #[cfg(test)]
        {
            let g = self.test_ui.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(fake) = g.as_ref() {
                let reply = fake(op, &payload);
                drop(g);
                return bridge::unwrap_ui_result(reply);
            }
        }
        let app = self.app_handle().ok_or_else(|| {
            protocol::RpcError::new(
                protocol::E_DEVICE_NOT_READY,
                "MCP 服务器没有界面上下文（应用未以 GUI 方式运行）",
            )
        })?;
        let v = self.bridge.call(&app, op, payload).await?;
        bridge::unwrap_ui_result(v)
    }

    /// 把状态推给前端（标题栏状态点 + 弹窗里的会话数都用它）。
    ///
    /// 为什么要有这个方法（而不是只在 `mod.rs` 里留个带 `AppHandle` 的自由函数）：
    /// **会话是在 `transport` 里增删的**（连上一条 SSE / 断开时回收），那里只有 `Arc<McpCore>`、
    /// 拿不到 `AppHandle`。以前只有"启动 / 启停 / 重置令牌"会推状态，于是**客户端明明连上了，
    /// 界面还一直显示「0 个会话」**（用户 2026-09-13 报的）—— 而弹窗只在**打开那一瞬间**拉一次，
    /// 先开着弹窗再连客户端就永远看不到变化。`status_emits` 让单测能断言"真的推了"。
    pub fn emit_status(&self) {
        self.status_emits.fetch_add(1, Ordering::Relaxed);
        let Some(app) = self.app_handle() else {
            return; // 单测 / 无界面：只计数，不推
        };
        use tauri::Emitter;
        // 推失败（比如窗口已关）不该影响任何东西
        let _ = app.emit("mcp-status-changed", self.status_json());
    }

    /// 前端报来的界面状态变更
    pub fn notify_state(&self, paths: &[String], origin: &str) -> Value {
        self.state_changes.fetch_add(1, Ordering::Relaxed);
        let v = json!({
            "paths": paths,
            "origin": origin,
            "ts": chrono::Utc::now().to_rfc3339(),
        });
        *self.last_change.lock().unwrap_or_else(|e| e.into_inner()) = Some(v.clone());
        v
    }

    pub fn uptime_secs(&self) -> u64 {
        self.started_at
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .map(|t| t.elapsed().as_secs())
            .unwrap_or(0)
    }

    /// 供界面与 `mcp_status` 工具共用的状态快照
    pub fn status_json(&self) -> Value {
        let cfg = self.cfg.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let running = self.running.load(Ordering::Relaxed);
        let port = *self.port.lock().unwrap_or_else(|e| e.into_inner());
        let last_error = self.last_error.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let tool_calls: serde_json::Map<String, Value> = self
            .tool_calls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(k, v)| (k.clone(), json!(*v)))
            .collect();
        // 只有真正在跑时才给 URL：否则界面会展示一个连不上的地址
        let url = if running && !cfg.server.token.is_empty() {
            port.map(|p| aiconfig::sse_url(&cfg.server.host, p, &cfg.server.token))
        } else {
            None
        };
        json!({
            "enabled": cfg.server.enabled,
            "running": running,
            "host": cfg.server.host,
            "port": port,
            "url": url,
            "token": cfg.server.token,
            "tokenMasked": aiconfig::mask_token(&cfg.server.token),
            "sessions": self.sessions.len(),
            // 往前端推过多少次状态。**故意暴露出来**：'客户端连上了界面还显示 0 会话'
            // 这种 bug 以前完全不可观测（服务器侧一直是对的），有了它就能从线上直接判断
            // "会话增减到底推没推"。
            "statusEmits": self.status_emits.load(Ordering::Relaxed),
            "maxSessions": MAX_SESSIONS,
            "requests": self.requests.load(Ordering::Relaxed),
            "dropped": self.dropped.load(Ordering::Relaxed),
            "uiInFlight": self.bridge.in_flight(),
            "stateChanges": self.state_changes.load(Ordering::Relaxed),
            "hasUi": self.app.lock().unwrap_or_else(|e| e.into_inner()).is_some(),
            "logHub": {
                "enabled": loghub::hub().is_enabled(),
                "channels": loghub::hub().channel_count(),
                "bytes": loghub::hub().total_bytes(),
                "lockSkips": loghub::hub().lock_skips(),
                "totalCapBytes": loghub::TOTAL_CAP_BYTES,
            },
            "toolCalls": tool_calls,
            // 运行期错误上报情况：报了多少条、被去重挡掉多少次（用户/我们自己排查时先看这个）
            "errorReports": {
                "reported": report::stats().0,
                "deduped": report::stats().1,
                "dedupWindowSecs": report::DEDUP_WINDOW_SECS,
                "sinkConfigured": std::env::var("ERROR_SERVER_URL").map(|s| !s.trim().is_empty()).unwrap_or(false),
            },
            "toolCount": protocol::exposed_tools(self).len(),
            "builtinToolCount": protocol::tool_defs().len(),
            "registry": {
                "controls": self.registry.len(),
                "panelCounts": self.registry.panel_counts(),
                "updatedAt": self.registry.updated_at(),
                "autoControlTools": cfg.expose.auto_control_tools,
                "namespaces": cfg.expose.namespaces,
            },
            "version": env!("CARGO_PKG_VERSION"),
            // 只读（沙箱）模式：**Agent 必须先看这个**，否则它会一路撞墙（写操作全被 -32007 拒）
            "readOnly": cfg.expose.read_only,
            "lastError": last_error,
            "uptimeSecs": self.uptime_secs(),
            "callLog": self.calllog.stats(),
            "configFile": aiconfig::ai_config_path().map(|p| p.to_string_lossy().into_owned()),
            "endpointFile": aiconfig::endpoint_path().map(|p| p.to_string_lossy().into_owned()),
            "limits": protocol::limits_json(),
        })
    }

    fn set_error(&self, msg: Option<String>) {
        *self.last_error.lock().unwrap_or_else(|e| e.into_inner()) = msg;
    }

    /// 对外（`/status` 端点与 `mcp_status` **工具**）用的状态：**token 与 URL 都打码**。
    /// 界面的 `mcp_status` **命令**用的是完整版（复制按钮需要带 token 的 URL）。
    pub fn status_json_public(&self) -> Value {
        let mut v = self.status_json();
        if let Some(o) = v.as_object_mut() {
            o.remove("token");
            if let Some(u) = o.get("url").and_then(|x| x.as_str()) {
                let masked = aiconfig::mask_url(u);
                o.insert("urlMasked".into(), json!(masked));
            }
            o.remove("url");
        }
        v
    }
}

impl Default for McpCore {
    fn default() -> Self {
        Self::new()
    }
}

/// Tauri 托管的 MCP 状态
pub struct McpState(pub Arc<McpCore>);

impl McpState {
    /// 取核心状态（用方法而不是 `state.0`：`tauri::State` 自己也有个私有字段 `0`，
    /// 直接写 `state.0` 会命中它而不是解引用到本类型）
    pub fn core(&self) -> Arc<McpCore> {
        self.0.clone()
    }
}

/// 注意：默认值必须**从磁盘读** `ai-config.json`。若用内置默认值会有两个 bug：
/// 每次启动重新生成 token（用户粘过的客户端配置下次全失效），且"停用"不生效。
impl Default for McpState {
    fn default() -> Self {
        let cfg = aiconfig::load();
        let log_cfg = cfg.call_log.clone();
        let core = McpCore::from_cfg(cfg);
        // 只有真实运行时才装上记录文件路径：单测里 `McpCore::new()` 的 calllog 是禁用的，
        // 绝不会往用户的 %APPDATA% 里写东西。
        if let Some(dir) = aiconfig::config_dir() {
            core.calllog.set_path(Some(dir.join(calllog::CALL_LOG_FILE)));
        }
        core.calllog.set_cfg(log_cfg);
        Self(Arc::new(core))
    }
}

/// 应用 AI 配置补丁（`mcp_config_set` 工具用）。
///
/// 约定：
/// - **只接受明确列出的键**（`server` / `callLog`），未知键直接报错，避免"以为改了其实没改"；
/// - **不接受 token**（那要走界面的「重置令牌」，免得 AI 顺手把凭证改掉）；
/// - `host` 只允许回环 —— 这是安全底线，不允许通过工具把服务器暴露到局域网；
/// - 改了 `server.*` **不会**当场重启（否则会掐断正在回话的这次调用），只回报 `needRestart`。
pub fn apply_config_patch(core: &Arc<McpCore>, patch: &Value) -> Result<Value, String> {
    apply_config_patch_with(core, patch, aiconfig::save)
}

/// 同上，但把"写盘"抽出来 —— 单测传一个写临时目录的闭包，
/// **绝不碰用户真实的 `%APPDATA%\seahi-serial\ai-config.json`**。
pub fn apply_config_patch_with(
    core: &Arc<McpCore>,
    patch: &Value,
    save: impl Fn(&aiconfig::AiConfig) -> Result<(), String>,
) -> Result<Value, String> {
    let obj = patch
        .as_object()
        .ok_or_else(|| "patch 必须是一个对象".to_string())?;
    let mut cfg = core.cfg.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let mut applied: Vec<String> = Vec::new();
    let mut need_restart = false;

    for (k, v) in obj {
        match k.as_str() {
            "server" => {
                let o = v.as_object().ok_or_else(|| "server 必须是对象".to_string())?;
                for (sk, sv) in o {
                    match sk.as_str() {
                        "enabled" => {
                            cfg.server.enabled = sv
                                .as_bool()
                                .ok_or_else(|| "server.enabled 必须是布尔".to_string())?;
                            need_restart = true;
                        }
                        "port" => {
                            let p = sv
                                .as_u64()
                                .ok_or_else(|| "server.port 必须是整数".to_string())?;
                            if p == 0 || p > 65535 {
                                return Err("server.port 必须在 1..65535".to_string());
                            }
                            if p as u16 != cfg.server.port {
                                cfg.server.port = p as u16;
                                need_restart = true;
                            }
                        }
                        "host" => {
                            let h = sv
                                .as_str()
                                .ok_or_else(|| "server.host 必须是字符串".to_string())?;
                            if !matches!(h, "127.0.0.1" | "::1" | "localhost") {
                                return Err(
                                    "只允许监听回环地址（127.0.0.1 / ::1 / localhost）".to_string()
                                );
                            }
                            cfg.server.host = h.to_string();
                        }
                        "token" => {
                            return Err(
                                "不接受通过工具修改 token；请在界面弹窗里点「重置令牌」".to_string()
                            )
                        }
                        other => return Err(format!("不支持的 server 配置项: {}", other)),
                    }
                    applied.push(format!("server.{}", sk));
                }
            }
            "callLog" => {
                let o = v
                    .as_object()
                    .ok_or_else(|| "callLog 必须是对象".to_string())?;
                for (ck, cv) in o {
                    let b = || format!("callLog.{} 必须是布尔", ck);
                    let n = || format!("callLog.{} 必须是非负整数", ck);
                    match ck.as_str() {
                        "enabled" => cfg.call_log.enabled = cv.as_bool().ok_or_else(b)?,
                        "includeArgs" => cfg.call_log.include_args = cv.as_bool().ok_or_else(b)?,
                        "includeResults" => {
                            cfg.call_log.include_results = cv.as_bool().ok_or_else(b)?
                        }
                        "maxPayloadChars" => {
                            cfg.call_log.max_payload_chars =
                                cv.as_u64().ok_or_else(n)?.clamp(32, 1_000_000) as usize
                        }
                        "maxFileMiB" => {
                            cfg.call_log.max_file_mib = cv.as_u64().ok_or_else(n)?.clamp(1, 1024)
                        }
                        "rotateKeep" => {
                            cfg.call_log.rotate_keep = cv.as_u64().ok_or_else(n)?.min(50) as u32
                        }
                        other => return Err(format!("不支持的 callLog 配置项: {}", other)),
                    }
                    applied.push(format!("callLog.{}", ck));
                }
            }
            "expose" => {
                let o = v
                    .as_object()
                    .ok_or_else(|| "expose 必须是对象".to_string())?;
                for (ek, ev) in o {
                    match ek.as_str() {
                        "autoControlTools" => {
                            cfg.expose.auto_control_tools = ev
                                .as_bool()
                                .ok_or_else(|| "expose.autoControlTools 必须是布尔".to_string())?;
                        }
                        // 只读（沙箱）模式。注意：这个工具本身是**写**工具，所以在只读模式下
                        // 它会被拒 —— 也就是 **AI 只能把它打开、打不开它**（想关必须由用户在弹窗里操作）。
                        // 这个不对称是故意的：否则"让 AI 别改东西"就成了摆设。
                        "readOnly" => {
                            cfg.expose.read_only = ev
                                .as_bool()
                                .ok_or_else(|| "expose.readOnly 必须是布尔".to_string())?;
                        }
                        "namespaces" => {
                            let arr = ev
                                .as_array()
                                .ok_or_else(|| "expose.namespaces 必须是字符串数组".to_string())?;
                            let mut ns: Vec<String> = Vec::new();
                            for x in arr {
                                let s = x.as_str().ok_or_else(|| {
                                    "expose.namespaces 的每一项都必须是字符串".to_string()
                                })?;
                                // 只接受已知面板名，避免打错字后"工具全没了"却不知道为什么
                                if !matches!(
                                    s,
                                    "serial" | "wsl" | "adb" | "ble" | "global" | "mcp" | "dialog"
                                ) {
                                    return Err(format!(
                                        "未知面板名: {}（可用：serial/wsl/adb/ble/global/mcp/dialog）",
                                        s
                                    ));
                                }
                                ns.push(s.to_string());
                            }
                            cfg.expose.namespaces = ns;
                        }
                        other => return Err(format!("不支持的 expose 配置项: {}", other)),
                    }
                    applied.push(format!("expose.{}", ek));
                }
            }
            other => {
                return Err(format!(
                    "不支持的顶层配置项: {}（目前只支持 server / callLog / expose）",
                    other
                ))
            }
        }
    }

    save(&cfg)?;
    *core.cfg.lock().unwrap_or_else(|e| e.into_inner()) = cfg.clone();
    core.calllog.set_cfg(cfg.call_log.clone());

    Ok(json!({
        "applied": applied,
        "needRestart": need_restart,
        "note": if need_restart {
            "server.* 已保存；改动需要重新启用 MCP 服务器才生效（在界面弹窗里关闭再启用）"
        } else {
            "已立即生效"
        },
        "config": config_summary(&cfg),
    }))
}

/// 给 AI 看的配置摘要（**token 打码**：别把凭证顺手抄进对话记录里）
pub fn config_summary(cfg: &aiconfig::AiConfig) -> Value {
    json!({
        "version": cfg.version,
        "server": {
            "enabled": cfg.server.enabled,
            "host": cfg.server.host,
            "port": cfg.server.port,
            "hasToken": !cfg.server.token.is_empty(),
            "tokenMasked": aiconfig::mask_token(&cfg.server.token),
        },
        "callLog": cfg.call_log,
        "expose": cfg.expose,
    })
}

/// 前端上报控件注册表（S6）。界面是注册表的真源（只有它知道当前有哪些面板/控件），
/// 前端在注册表变化时调一次；后端据此生成 `ctl_*` 工具定义。
#[tauri::command]
pub fn mcp_report_registry(state: tauri::State<'_, McpState>, entries: Vec<Value>) -> Value {
    let core = state.core();
    let mut parsed: Vec<registry::RegistryEntry> = Vec::new();
    let mut bad = 0usize;
    for v in entries {
        match serde_json::from_value::<registry::RegistryEntry>(v) {
            Ok(e) => {
                if !e.path.is_empty() {
                    parsed.push(e)
                } else {
                    bad += 1
                }
            }
            Err(_) => bad += 1,
        }
    }
    let (n, tools_changed) = core.registry.replace_and_diff(parsed);
    // 前端报上来的条目解析不了 = 前后端对注册表结构的理解漂了。以前只把 `bad` 计数返回，
    // 没人看就等于没有 —— 上报一条（去重后 5 分钟一次），别让"工具莫名少了一批"无从查起。
    if bad > 0 {
        report::report(
            "registry_entry_invalid",
            &format!("{} 条控件注册项解析失败（前后端结构可能不一致）", bad),
        );
    }
    // 工具名集合变了要**主动告诉客户端**（规范里的 notifications/tools/list_changed）：
    // 否则客户端还拿着旧的工具列表 —— 这正是 S6 里"先有鸡还是先有蛋"的解药。
    let notified = if tools_changed && core.running.load(Ordering::Relaxed) {
        transport::broadcast(
            &core,
            json!({ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" }),
        )
    } else {
        0
    };
    let cfg = core.cfg.lock().unwrap_or_else(|e| e.into_inner()).clone();
    json!({
        "accepted": n,
        "rejected": bad,
        "toolsChanged": tools_changed,
        "notifiedSessions": notified,
        "autoControlTools": cfg.expose.auto_control_tools,
        "exposedTools": protocol::exposed_tools(&core).len(),
    })
}

// ===== 启停 =====

/// 绑定并起服务（在调用方的 tokio 上下文里执行）。返回实际监听端口。
pub async fn serve(core: Arc<McpCore>, host: &str, port: u16) -> Result<u16, String> {
    // 绑端口前先把"停机标志"清掉，否则上一轮 stop 留下的置位会让新循环**第一圈就退出**
    // （表现为"启动成功但连不上"）。放在这里而不是只放在 start()：serve 是真正的起服务入口，
    // 任何调用方都该拿到一个活着的服务器。
    core.shutdown.store(false, Ordering::Relaxed);
    let (listener, actual) = transport::bind(host, port).await?;
    let c = core.clone();
    tokio::spawn(async move {
        transport::run(c, listener, actual).await;
    });
    Ok(actual)
}

/// 启动并把结果同步给调用方（绑定在后台任务里做，避免在 setup 的同步上下文里嵌套运行时）
pub fn start(core: &Arc<McpCore>, app: Option<&tauri::AppHandle>) -> Result<Value, String> {
    if core.running.load(Ordering::Relaxed) {
        return Ok(core.status_json());
    }
    // 1) 确保 token 存在并落盘（原子写）
    let (host, port, token) = {
        let mut cfg = core.cfg.lock().unwrap_or_else(|e| e.into_inner());
        if cfg.server.token.is_empty() {
            cfg.server.token = aiconfig::new_token();
        }
        let host = cfg.server.host.clone();
        let port = cfg.server.port;
        let token = cfg.server.token.clone();
        let snapshot = cfg.clone();
        drop(cfg);
        // 把当前令牌登记为敏感串：错误上报前会把它抹掉（端点 URL 里就带着它）
        report::remember_secret(&token);
        if let Err(e) = aiconfig::save(&snapshot) {
            crate::dbg_log(&format!("mcp: ai-config.json 保存失败: {}", e));
            report::report("config_save_failed", &e);
        }
        (host, port, token)
    };

    // 停机标志由 serve() 在绑端口前清掉（见其注释）——不在这里重复置位，避免两处口径漂移

    // 2) 起服务；绑定结果通过 std channel 回传，避免 block_on 嵌套运行时
    let (tx, rx) = std::sync::mpsc::channel::<Result<u16, String>>();
    let core2 = core.clone();
    let host2 = host.clone();
    tauri::async_runtime::spawn(async move {
        match serve(core2, &host2, port).await {
            Ok(actual) => {
                let _ = tx.send(Ok(actual));
            }
            Err(e) => {
                let _ = tx.send(Err(e));
            }
        }
    });

    match rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(Ok(actual)) => {
            *core.port.lock().unwrap_or_else(|e| e.into_inner()) = Some(actual);
            core.running.store(true, Ordering::Relaxed);
            *core.started_at.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
            // 记下 AppHandle：ui_* 工具靠它经前端桥驱动界面
            *core.app.lock().unwrap_or_else(|e| e.into_inner()) = app.cloned();
            core.set_error(None);
            // 3) 写端点发现文件（npm 安装器/外部工具靠它找到我们）
            if let Err(e) = aiconfig::write_endpoint(&host, actual, &token) {
                crate::dbg_log(&format!("mcp: 写端点发现文件失败: {}", e));
                report::report("endpoint_write_failed", &e);
            }
            crate::dbg_log(&format!(
                "mcp: 已启动 http://{}:{}（token {}）",
                host,
                actual,
                aiconfig::mask_token(&token)
            ));
            // 打开日志中心（停用时它是零成本的空操作；打开后各通道按上限收日志）
            loghub::hub().set_enabled(true);
            loghub::hub().push(
                "mcp",
                loghub::LEVEL_INFO,
                loghub::DIR_NONE,
                &format!("MCP 服务器已启动 127.0.0.1:{}", actual),
                0,
            );
            Ok(core.status_json())
        }
        Ok(Err(e)) => {
            core.set_error(Some(e.clone()));
            core.running.store(false, Ordering::Relaxed);
            crate::dbg_log(&format!("mcp: 启动失败: {}", e));
            // 起不来是用户最可能遇到的故障（端口被占），必须进错误库，别只留在本地日志
            report::report("start_failed", &e);
            Err(e)
        }
        Err(_) => {
            let e = "启动超时（5 秒内未完成端口绑定）".to_string();
            core.set_error(Some(e.clone()));
            crate::dbg_log(&format!("mcp: {}", e));
            report::report("start_timeout", &e);
            Err(e)
        }
    }
}

/// 停止服务。会等一小会儿让 accept 循环退出并释放端口（否则立刻重开会撞 AddrInUse）。
pub fn stop(core: &Arc<McpCore>) {
    if !core.running.load(Ordering::Relaxed) && core.port.lock().unwrap_or_else(|e| e.into_inner()).is_none() {
        return;
    }
    core.shutdown.store(true, Ordering::Relaxed);
    // SSE 流立刻结束（丢掉 sender），不必等服务端反应
    core.sessions.clear();
    // 唤醒所有在等界面的调用，让它们立刻拿到"通道已关闭"而不是耗到 5s 超时
    core.bridge.clear();
    // accept 循环最多 200ms 感知；留一点余量确保 listener 已 drop、端口已释放
    std::thread::sleep(std::time::Duration::from_millis(260));
    core.running.store(false, Ordering::Relaxed);
    *core.port.lock().unwrap_or_else(|e| e.into_inner()) = None;
    *core.app.lock().unwrap_or_else(|e| e.into_inner()) = None;
    // 关掉日志中心：立即清空并停止收集（停用即零成本）
    loghub::hub().push(
        "mcp",
        loghub::LEVEL_INFO,
        loghub::DIR_NONE,
        "MCP 服务器已停止",
        0,
    );
    loghub::hub().set_enabled(false);
    aiconfig::remove_endpoint();
    crate::dbg_log("mcp: 已停止");
}

/// 随程序启动（在 Tauri `setup()` 里调用）。失败只记录，不影响主功能。
pub fn autostart(app: &tauri::AppHandle) {
    use tauri::Manager;
    let core = match app.try_state::<McpState>() {
        Some(s) => s.0.clone(),
        None => {
            crate::dbg_log("mcp: autostart 找不到 McpState，跳过");
            return;
        }
    };
    let enabled = core.cfg.lock().unwrap_or_else(|e| e.into_inner()).server.enabled;
    if !enabled {
        crate::dbg_log("mcp: 配置为不随程序启动，跳过");
        return;
    }
    match start(&core, Some(app)) {
        Ok(_) => {
            core.emit_status();
        }
        Err(e) => {
            // 硬性约束：MCP 起不来不能让应用出问题
            crate::dbg_log(&format!("mcp: autostart 失败（不影响主功能）: {}", e));
            core.emit_status();
        }
    }
}

/// 退出前清理
pub fn shutdown_on_exit(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(s) = app.try_state::<McpState>() {
        if s.0.running.load(Ordering::Relaxed) {
            stop(&s.0);
        }
    }
}

// ===== Tauri 命令 =====

/// 当前 MCP 状态（界面弹窗与图标都用它）
#[tauri::command]
pub fn mcp_status(state: tauri::State<'_, McpState>) -> Value {
    state.core().status_json()
}

/// 启用 / 停用 MCP 服务器（会持久化到 ai-config.json，不碰用户配置 config.json）
#[tauri::command]
pub fn mcp_set_enabled(
    app: tauri::AppHandle,
    state: tauri::State<'_, McpState>,
    enabled: bool,
) -> Value {
    let core = state.core();
    {
        let mut cfg = core.cfg.lock().unwrap_or_else(|e| e.into_inner());
        cfg.server.enabled = enabled;
        let snapshot = cfg.clone();
        drop(cfg);
        if let Err(e) = aiconfig::save(&snapshot) {
            core.set_error(Some(format!("保存 AI 配置失败: {}", e)));
        }
    }
    if enabled {
        if let Err(e) = start(&core, Some(&app)) {
            core.set_error(Some(e));
        }
    } else {
        stop(&core);
    }
    core.emit_status();
    core.status_json()
}

/// 开关**只读（沙箱）模式**：打开后所有写操作被拒（`-32007`），界面与配置一个字都不改。
///
/// 只给界面用。AI 侧通过 `mcp_config_set` **只能打开它、关不掉**（那个工具自己也是写操作，
/// 在只读模式下会被拒）—— 这个不对称是故意的，否则"让 AI 别改东西"就成了摆设。
#[tauri::command]
pub fn mcp_set_read_only(state: tauri::State<'_, McpState>, enabled: bool) -> Value {
    let core = state.core();
    {
        let mut cfg = core.cfg.lock().unwrap_or_else(|e| e.into_inner());
        cfg.expose.read_only = enabled;
        let snapshot = cfg.clone();
        drop(cfg);
        if let Err(e) = aiconfig::save(&snapshot) {
            core.set_error(Some(format!("保存 AI 配置失败: {}", e)));
        }
    }
    crate::dbg_log(&format!(
        "mcp: 只读（沙箱）模式{}",
        if enabled { "已开启" } else { "已关闭" }
    ));
    core.emit_status();
    core.status_json()
}

/// 重新生成访问令牌（旧 token 立即失效，所有会话被断开）
#[tauri::command]
pub fn mcp_reset_token(app: tauri::AppHandle, state: tauri::State<'_, McpState>) -> Value {
    let core = state.core();
    let was_running = core.running.load(Ordering::Relaxed);
    if was_running {
        stop(&core);
    }
    {
        let mut cfg = core.cfg.lock().unwrap_or_else(|e| e.into_inner());
        cfg.server.token = aiconfig::new_token();
        let snapshot = cfg.clone();
        drop(cfg);
        let _ = aiconfig::save(&snapshot);
    }
    if was_running {
        let _ = start(&core, Some(&app));
    }
    core.emit_status();
    core.status_json()
}

/// 前端回执 → 桥内部统一结构。
///
/// ⚠️ **每一个字段都必须原样带上**，尤其是 `notFound` / `invalidParams`：`bridge::unwrap_ui_result`
/// 靠它们把"控件路径不存在 / 参数取值非法"判成协议级 `-32602`（区分于"工具跑了但没成功"的 `-32006`）。
///
/// 2026-09 真机一致性检查发现：这条链路中间断了一节 —— 前端 ack 时只带了
/// `ok/value/error/disabledReason`，`notFound` 被丢掉，于是 `-32602` 那条映射
/// **在真机上从未生效**，所有"路径不存在"都退化成 `-32006`（AI 会误以为"没有界面"而去重试）。
/// 两端各自的单测都是绿的（前端断言 `mcpHandleUiCmd` 回了 notFound，后端断言
/// `unwrap_ui_result` 认 notFound）—— 所以这里额外用 `ui_ack_reply_shape_is_complete`
/// 把**两端接起来**测一次，别再让中间这段没人管。
fn ui_ack_payload(
    ok: bool,
    value: Option<Value>,
    error: Option<String>,
    not_found: Option<bool>,
    invalid_params: Option<bool>,
    disabled_reason: Option<String>,
) -> Value {
    json!({
        "ok": ok,
        "value": value,
        "error": error,
        "notFound": not_found.unwrap_or(false),
        "invalidParams": invalid_params.unwrap_or(false),
        "disabledReason": disabled_reason,
    })
}

/// 前端对 `mcp-ui-cmd` 的回执。返回是否命中一个在等的调用
/// （false = 已超时被回收，前端可以安全忽略）。
#[tauri::command]
pub fn mcp_ui_ack(
    state: tauri::State<'_, McpState>,
    cmd_id: u64,
    ok: bool,
    value: Option<Value>,
    error: Option<String>,
    not_found: Option<bool>,
    invalid_params: Option<bool>,
    disabled_reason: Option<String>,
) -> bool {
    state.core().bridge.ack(
        cmd_id,
        ui_ack_payload(ok, value, error, not_found, invalid_params, disabled_reason),
    )
}

/// 前端报来界面状态变化。`origin='mcp'` 表示这次变更由 AI 自己造成（回声抑制用）。
/// 本轮只记录；S7 会据此向 MCP 客户端推 `notifications/resources/updated`。
#[tauri::command]
pub fn mcp_notify_state(
    state: tauri::State<'_, McpState>,
    paths: Vec<String>,
    origin: Option<String>,
) -> Value {
    state
        .core()
        .notify_state(&paths, origin.as_deref().unwrap_or("user"))
}

/// 前端回灌日志（界面专有的行：sys/err/串口收发/toast 等）。
/// 前端按 200ms 批量调用，避免高频串口数据把 IPC 打爆；单次也有条数上限。
#[tauri::command]
pub fn log_push_batch(lines: Vec<Value>) -> usize {
    let hub = loghub::hub();
    if !hub.is_enabled() {
        return 0;
    }
    let mut n = 0usize;
    // 单次上限：一次灌太多说明前端节流失效，宁可丢弃也不要把写路径压垮
    for l in lines.iter().take(500) {
        let channel = l.get("channel").and_then(|v| v.as_str()).unwrap_or("ui");
        let text = l.get("text").and_then(|v| v.as_str()).unwrap_or("");
        if text.is_empty() {
            continue;
        }
        let level = match l.get("level").and_then(|v| v.as_str()) {
            Some("debug") => loghub::LEVEL_DEBUG,
            Some("warn") => loghub::LEVEL_WARN,
            Some("error") => loghub::LEVEL_ERROR,
            _ => loghub::LEVEL_INFO,
        };
        let dir = match l.get("dir").and_then(|v| v.as_str()) {
            Some("rx") => loghub::DIR_RX,
            Some("tx") => loghub::DIR_TX,
            _ => loghub::DIR_NONE,
        };
        let bytes = l.get("bytes").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        hub.push(channel, level, dir, text, bytes);
        n += 1;
    }
    n
}

/// 给界面用的"一键复制"内容：客户端配置 JSON + 自然语言安装提示词
#[tauri::command]
pub fn mcp_client_config(state: tauri::State<'_, McpState>) -> Value {
    let st = state.core().status_json();
    let url = st.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let running = st.get("running").and_then(|v| v.as_bool()).unwrap_or(false);
    if !running || url.is_empty() {
        return json!({ "ok": false, "reason": "服务器未启用" });
    }
    let client_json = serde_json::to_string_pretty(&json!({
        "mcpServers": {
            "seahi-serial": { "type": "sse", "url": url }
        }
    }))
    .unwrap_or_default();
    let prompt = format!(
        "请把下面这个 MCP 服务器（SSE 传输）加入你的 MCP 配置并连接：\n  URL: {}\n\
         它是本机 \"SeaHi Serial\" 串口/蓝牙调试器暴露的工具集，当前可用工具：{}。\n\
         连上后请先用 tools/list 看一眼可用工具再操作。",
        url,
        protocol::tool_defs()
            .iter()
            .filter_map(|t| t.get("name").and_then(|n| n.as_str()))
            .collect::<Vec<_>>()
            .join(" / ")
    );
    json!({ "ok": true, "url": url, "clientConfig": client_json, "installPrompt": prompt })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("建立测试运行时")
    }

    fn test_core() -> Arc<McpCore> {
        let mut cfg = aiconfig::AiConfig::default();
        cfg.server.token = "testtoken".to_string();
        Arc::new(McpCore::from_cfg(cfg))
    }

    struct Sse {
        stream: tokio::net::TcpStream,
        acc: String,
    }

    impl Sse {
        /// 增量读，直到出现 needle 或超时
        async fn read_until(&mut self, needle: &str, ms: u64) -> bool {
            let deadline = Instant::now() + std::time::Duration::from_millis(ms);
            let mut buf = [0u8; 8192];
            while Instant::now() < deadline {
                let left = deadline.saturating_duration_since(Instant::now());
                match tokio::time::timeout(left, self.stream.read(&mut buf)).await {
                    Ok(Ok(0)) => break,
                    Ok(Ok(n)) => {
                        self.acc.push_str(&String::from_utf8_lossy(&buf[..n]));
                        if self.acc.contains(needle) {
                            return true;
                        }
                    }
                    Ok(Err(_)) => break,
                    Err(_) => break,
                }
            }
            self.acc.contains(needle)
        }
    }

    async fn connect(port: u16) -> tokio::net::TcpStream {
        tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("连接回环端口")
    }

    /// 一次性的请求（读到 EOF 或超时），返回原始响应文本
    async fn one_shot(port: u16, req: &str) -> String {
        let mut s = connect(port).await;
        s.write_all(req.as_bytes()).await.unwrap();
        let mut buf = Vec::new();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), s.read_to_end(&mut buf)).await;
        String::from_utf8_lossy(&buf).to_string()
    }

    fn get_req(path: &str) -> String {
        format!("GET {} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n", path)
    }

    fn post_req(path: &str, body: &str) -> String {
        format!(
            "POST {} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            path,
            body.len(),
            body
        )
    }

    /// 从 SSE 首帧里抠出 sessionId
    fn session_id_of(sse_text: &str) -> String {
        let key = "sessionId=";
        let i = sse_text.find(key).expect("首帧应含 sessionId");
        let rest = &sse_text[i + key.len()..];
        let end = rest.find(|c: char| !c.is_ascii_alphanumeric()).unwrap_or(rest.len());
        rest[..end].to_string()
    }

    #[test]
    fn healthz_needs_no_token_and_leaks_nothing() {
        let rt = rt();
        let core = test_core();
        rt.block_on(async {
            let port = serve(core.clone(), "127.0.0.1", 0).await.expect("起服务");
            assert!(port > 0, "端口 0 应回报真实分配端口");

            let resp = one_shot(port, &get_req("/healthz")).await;
            assert!(resp.starts_with("HTTP/1.1 200 OK"), "响应: {}", resp);
            assert!(resp.contains(r#"{"ok":true}"#), "探活体应只有 ok: {}", resp);
            // 关键：无鉴权端点不能泄露版本/会话/工具等任何信息
            for leak in ["version", "session", "token", "tool"] {
                assert!(!resp.to_lowercase().contains(leak), "探活端点泄露了 {}: {}", leak, resp);
            }
            core.shutdown.store(true, Ordering::Relaxed);
        });
    }

    #[test]
    fn sse_rejects_wrong_or_missing_token() {
        let rt = rt();
        let core = test_core();
        rt.block_on(async {
            let port = serve(core.clone(), "127.0.0.1", 0).await.expect("起服务");
            let r1 = one_shot(port, &get_req("/sse?token=wrong")).await;
            assert!(r1.starts_with("HTTP/1.1 401"), "错 token 应 401: {}", r1);
            let r2 = one_shot(port, &get_req("/sse")).await;
            assert!(r2.starts_with("HTTP/1.1 401"), "缺 token 应 401: {}", r2);
            let r3 = one_shot(port, &post_req("/messages?sessionId=x&token=wrong", "{}")).await;
            assert!(r3.starts_with("HTTP/1.1 401"), "POST 错 token 应 401: {}", r3);
            core.shutdown.store(true, Ordering::Relaxed);
        });
    }

    #[test]
    fn unknown_route_is_404() {
        let rt = rt();
        let core = test_core();
        rt.block_on(async {
            let port = serve(core.clone(), "127.0.0.1", 0).await.expect("起服务");
            let r = one_shot(port, &get_req("/nope")).await;
            assert!(r.starts_with("HTTP/1.1 404"), "响应: {}", r);
            core.shutdown.store(true, Ordering::Relaxed);
        });
    }

    /// 端到端：真实回环端口上完成 SSE 握手 → initialize → tools/list → tools/call
    #[test]
    fn end_to_end_sse_handshake_and_tool_call() {
        let rt = rt();
        let core = test_core();
        rt.block_on(async {
            let port = serve(core.clone(), "127.0.0.1", 0).await.expect("起服务");

            // 1) 建立 SSE 会话，首帧必须是 endpoint 事件
            let mut sse = Sse {
                stream: connect(port).await,
                acc: String::new(),
            };
            sse.stream
                .write_all(get_req("/sse?token=testtoken").as_bytes())
                .await
                .unwrap();
            assert!(sse.read_until("event: endpoint", 3000).await, "未收到 endpoint 帧: {}", sse.acc);
            assert!(sse.acc.starts_with("HTTP/1.1 200 OK"), "SSE 响应: {}", sse.acc);
            assert!(sse.acc.contains("text/event-stream"), "缺 content-type: {}", sse.acc);
            let sid = session_id_of(&sse.acc);
            assert!(!sid.is_empty());
            assert_eq!(core.sessions.len(), 1, "会话应已注册");

            // 2) POST initialize，响应经 SSE 流回来
            let init = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"e2e"}}}"#;
            let mut poster = connect(port).await;
            poster
                .write_all(post_req(&format!("/messages?sessionId={}&token=testtoken", sid), init).as_bytes())
                .await
                .unwrap();
            let mut acc = String::new();
            let mut buf = [0u8; 4096];
            let n = tokio::time::timeout(std::time::Duration::from_secs(2), poster.read(&mut buf))
                .await
                .expect("POST 应有响应")
                .unwrap();
            acc.push_str(&String::from_utf8_lossy(&buf[..n]));
            assert!(acc.starts_with("HTTP/1.1 202 Accepted"), "POST 应 202: {}", acc);

            assert!(sse.read_until("\"serverInfo\"", 3000).await, "未收到 initialize 结果: {}", sse.acc);
            assert!(sse.acc.contains("seahi-serial"));
            assert!(sse.acc.contains(env!("CARGO_PKG_VERSION")));

            // 3) tools/list
            let before = sse.acc.len();
            let list = r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#;
            poster
                .write_all(post_req(&format!("/messages?sessionId={}&token=testtoken", sid), list).as_bytes())
                .await
                .unwrap();
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), async {
                let mut b = [0u8; 4096];
                let _ = poster.read(&mut b).await;
            })
            .await;
            assert!(
                sse.read_until("serial_list_ports", 3000).await,
                "tools/list 未回来: {}",
                &sse.acc[before.min(sse.acc.len())..]
            );

            // 4) tools/call（app_info）
            let call = r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"app_info"}}"#;
            poster
                .write_all(post_req(&format!("/messages?sessionId={}&token=testtoken", sid), call).as_bytes())
                .await
                .unwrap();
            assert!(
                sse.read_until("\"uptimeSecs\"", 3000).await,
                "tools/call 未回来: {}",
                sse.acc
            );
            assert_eq!(core.requests.load(Ordering::Relaxed), 3, "应统计到 3 条请求");

            // 5) 未实现的路径：坏 sessionId 应 404 而不是静默丢弃
            let bad = one_shot(port, &post_req("/messages?sessionId=nope&token=testtoken", "{}")).await;
            assert!(bad.starts_with("HTTP/1.1 404"), "未知会话应 404: {}", bad);

            core.shutdown.store(true, Ordering::Relaxed);
        });
    }

    /// 限流回包**必须带上这次请求的 id**：否则客户端配不上号 → 那次调用挂到超时 →
    /// Agent 以为失败又重试 → 越限流越糟。这就是"反复调用失败"的一个真实成因。
    #[test]
    fn rate_limited_reply_carries_the_request_id() {
        let rt = rt();
        let core = test_core();
        rt.block_on(async {
            let port = serve(core.clone(), "127.0.0.1", 0).await.expect("起服务");
            let mut sse = Sse {
                stream: connect(port).await,
                acc: String::new(),
            };
            sse.stream
                .write_all(get_req("/sse?token=testtoken").as_bytes())
                .await
                .unwrap();
            assert!(sse.read_until("event: endpoint", 3000).await, "没收到 endpoint 帧");
            let sid = session_id_of(&sse.acc);
            let path = format!("/messages?sessionId={}&token=testtoken", sid);

            // 连打超过限流上限的请求，最后一个必然被限流。
            // ⚠️ 必须带 `Connection: close`：否则 HTTP/1.1 保持连接，`read_to_end` 会一直等到超时，
            // 61 次就是两分钟 —— 直接把 60 秒的限流窗口拖过去，于是**永远触发不了限流**
            // （我第一版就是这么写的：测试跑 127 秒还失败）。
            let over = RATE_LIMIT_PER_MIN + 1;
            for i in 1..=over {
                let body = format!(r#"{{"jsonrpc":"2.0","id":{},"method":"ping"}}"#, i);
                let req = format!(
                    "POST {} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
                    path,
                    body.len(),
                    body
                );
                let mut s = connect(port).await;
                s.write_all(req.as_bytes()).await.unwrap();
                let mut buf = Vec::new();
                let _ = tokio::time::timeout(
                    std::time::Duration::from_millis(500),
                    s.read_to_end(&mut buf),
                )
                .await;
            }
            // SSE 流里应出现一条 -32000，且 id 是**我们发过的那个**（不是 null）
            assert!(
                sse.read_until("-32000", 5000).await,
                "被限流时应通过 SSE 回一条 -32000；实际累计: {}",
                &sse.acc[..sse.acc.len().min(600)]
            );
            let tail = sse.acc.clone();
            let mut hit = String::new();
            for chunk in tail.split("data: ") {
                if chunk.contains("-32000") {
                    hit = chunk.to_string();
                }
            }
            assert!(
                !hit.contains(r#""id":null"#),
                "限流回包的 id 不能是 null（客户端会配不上号而挂到超时）: {}",
                hit
            );
        });
    }

    /// **会话增减必须推状态给界面**。
    ///
    /// 用户报的现象："明明已经有个客户端连接上了，界面一直显示 0 会话。"
    /// 服务器侧是对的（`mcp_status.sessions` 确实是 1），错在**没人告诉界面**：
    /// 会话是在 `transport` 里增删的、只有 `Arc<McpCore>`，而当时的推送只发生在
    /// "启动/启停/重置令牌"三处 —— 弹窗又只在打开那一瞬间拉一次，先开着弹窗再连就永远是 0。
    /// 这里钉住"连上推一次、断开推一次"。
    #[test]
    fn session_add_and_remove_push_status_to_the_ui() {
        let rt = rt();
        let core = test_core();
        rt.block_on(async {
            let port = serve(core.clone(), "127.0.0.1", 0).await.expect("起服务");
            let before = core.status_emits.load(Ordering::Relaxed);
            {
                let mut sse = Sse {
                    stream: connect(port).await,
                    acc: String::new(),
                };
                sse.stream
                    .write_all(get_req("/sse?token=testtoken").as_bytes())
                    .await
                    .unwrap();
                assert!(sse.read_until("event: endpoint", 3000).await, "没收到 endpoint 帧");
                assert!(
                    core.status_emits.load(Ordering::Relaxed) > before,
                    "会话建立后必须推一次状态（否则界面永远显示 0 会话）"
                );
            }
            let after_connect = core.status_emits.load(Ordering::Relaxed);
            for _ in 0..40 {
                if core.sessions.len() == 0 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
            assert_eq!(core.sessions.len(), 0, "会话应已回收");
            assert!(
                core.status_emits.load(Ordering::Relaxed) > after_connect,
                "会话断开后也要推一次（否则界面上的会话数不会回落）"
            );
        });
    }

    /// 客户端断开后会话必须**立刻**回收，而不是干等 30 分钟空闲超时。
    ///
    /// 这是官方 SDK 一致性检查抓出来的真问题：会话表只存了 `tx`，SSE 的接收端被 hyper
    /// 丢掉时没人知道，于是 `MAX_SESSIONS = 4` 会被"连过又断开"的连接占满 ——
    /// 客户端重启/重连 4 次之后，所有新连接直接吃 429，而且半小时内不会恢复。
    #[test]
    fn session_is_reclaimed_as_soon_as_the_client_disconnects() {
        let rt = rt();
        let core = test_core();
        rt.block_on(async {
            let port = serve(core.clone(), "127.0.0.1", 0).await.expect("起服务");

            // 连着断开 6 次（比 MAX_SESSIONS 多），每次都验证会话被立刻回收
            for round in 1..=(MAX_SESSIONS + 2) {
                {
                    let mut sse = Sse {
                        stream: connect(port).await,
                        acc: String::new(),
                    };
                    sse.stream
                        .write_all(get_req("/sse?token=testtoken").as_bytes())
                        .await
                        .unwrap();
                    assert!(sse.read_until("event: endpoint", 3000).await, "第 {} 轮没收到 endpoint 帧", round);
                    assert_eq!(core.sessions.len(), 1, "第 {} 轮：会话应已注册", round);
                    // sse 在这里出作用域 → 连接关闭 → 服务端应立刻回收
                }

                let mut cleared = false;
                for _ in 0..40 {
                    if core.sessions.len() == 0 {
                        cleared = true;
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                }
                assert!(
                    cleared,
                    "第 {} 轮：断开后会话没被回收（仍为 {}）—— 4 个坑会被重连占满",
                    round,
                    core.sessions.len()
                );
            }

            // 收尾：连续重连之后仍能正常接入（这正是"坑被占满"时会失败的那一步）
            let mut sse = Sse {
                stream: connect(port).await,
                acc: String::new(),
            };
            sse.stream
                .write_all(get_req("/sse?token=testtoken").as_bytes())
                .await
                .unwrap();
            assert!(sse.read_until("event: endpoint", 3000).await, "重连被拒绝: {}", sse.acc);
            assert!(sse.acc.starts_with("HTTP/1.1 200 OK"), "重连应成功而不是 429: {}", sse.acc);

            core.shutdown.store(true, Ordering::Relaxed);
        });
    }

    #[test]
    fn sessions_are_capped_at_max() {
        let rt = rt();
        let core = test_core();
        rt.block_on(async {
            let port = serve(core.clone(), "127.0.0.1", 0).await.expect("起服务");
            let mut held = Vec::new();
            for i in 0..MAX_SESSIONS {
                let mut s = Sse {
                    stream: connect(port).await,
                    acc: String::new(),
                };
                s.stream
                    .write_all(get_req("/sse?token=testtoken").as_bytes())
                    .await
                    .unwrap();
                assert!(s.read_until("event: endpoint", 2000).await, "第 {} 个会话未建立", i);
                held.push(s);
            }
            assert_eq!(core.sessions.len(), MAX_SESSIONS);
            // 第 N+1 个应被拒（而不是无限接受，把内存吃光）
            let over = one_shot(port, &get_req("/sse?token=testtoken")).await;
            assert!(over.starts_with("HTTP/1.1 429"), "超过上限应 429: {}", over);
            core.shutdown.store(true, Ordering::Relaxed);
        });
    }

    #[test]
    fn stop_releases_port_so_it_can_be_reused() {
        let rt = rt();
        let core = test_core();
        rt.block_on(async {
            let port = serve(core.clone(), "127.0.0.1", 0).await.expect("起服务");
            core.shutdown.store(true, Ordering::Relaxed);
            // 等 accept 循环退出并 drop listener
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            // 同一个端口必须能重新绑定（幂等启停的前提）
            let again = tokio::net::TcpListener::bind(("127.0.0.1", port)).await;
            assert!(again.is_ok(), "端口未释放: {:?}", again.err());
        });
    }

    /// S10 的验收门之一：**启停 50 次幂等**。
    /// 每一圈都必须：拿回同一个端口 → `shutdown` 被重新清掉 → 停止后端口真的释放。
    /// 不直接 sleep（50 圈要 10 秒以上）：置位后主动连一下，让 `accept` 的超时等待立刻返回。
    #[test]
    fn start_stop_is_idempotent_over_many_cycles() {
        let rt = rt();
        let core = test_core();
        rt.block_on(async {
            let mut port = 0u16;
            for i in 0..50 {
                let p = serve(core.clone(), "127.0.0.1", port)
                    .await
                    .unwrap_or_else(|e| panic!("第 {} 次启动失败: {}", i, e));
                if port == 0 {
                    port = p; // 第 0 圈让系统分配，之后每一圈都必须拿回同一个端口
                }
                assert_eq!(p, port, "第 {} 圈端口漂移了", i);
                assert!(
                    !core.shutdown.load(Ordering::Relaxed),
                    "第 {} 圈启动后 shutdown 仍是置位状态（重启没生效）",
                    i
                );

                core.shutdown.store(true, Ordering::Relaxed);
                // 打断 accept 的 200ms 超时等待，让退出路径尽快走完
                let _ = tokio::net::TcpStream::connect(("127.0.0.1", port)).await;

                let mut freed = false;
                for _ in 0..100 {
                    if tokio::net::TcpListener::bind(("127.0.0.1", port))
                        .await
                        .is_ok()
                    {
                        freed = true;
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
                assert!(freed, "第 {} 次停止后端口 {} 没释放", i, port);
            }
        });
    }

    #[test]
    fn status_reports_url_and_masked_token() {
        let core = test_core();
        {
            let mut cfg = core.cfg.lock().unwrap();
            cfg.server.enabled = true;
            cfg.server.token = "tok9abc".into();
        }
        *core.port.lock().unwrap() = Some(7777);
        core.running.store(true, Ordering::Relaxed);
        let st = core.status_json();
        assert_eq!(st["running"], true);
        assert!(st["url"].as_str().unwrap().contains("token=tok9abc"));
        assert_eq!(st["tokenMasked"], "…9abc", "掩码应只留末 4 位");
        assert_eq!(st["maxSessions"], MAX_SESSIONS);
        assert_eq!(st["toolCount"], protocol::tool_defs().len());
    }

    #[test]
    fn very_short_token_is_fully_masked() {
        // 长度 ≤4 时不留任何字符（否则等于把整个 token 显示出来）
        let core = test_core();
        core.cfg.lock().unwrap().server.token = "tok9".into();
        assert_eq!(core.status_json()["tokenMasked"], "****");
    }

    #[test]
    fn stopped_server_has_no_url() {
        // 未运行时不能给出一个连不上的地址（界面会照抄它）
        let core = test_core();
        core.running.store(false, Ordering::Relaxed);
        *core.port.lock().unwrap() = Some(7777);
        assert!(core.status_json()["url"].is_null());
    }

    #[test]
    fn public_status_hides_token_and_full_url() {
        let core = test_core();
        core.cfg
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .server
            .token = "abcdef1234567890".to_string();
        *core.port.lock().unwrap_or_else(|e| e.into_inner()) = Some(7777);
        core.running.store(true, Ordering::Relaxed);

        let pub_st = core.status_json_public();
        let text = serde_json::to_string(&pub_st).unwrap();
        assert!(!text.contains("abcdef1234567890"), "不能回显 token: {}", text);
        assert!(pub_st["token"].is_null(), "token 字段应被移除");
        assert!(pub_st["url"].is_null(), "含 token 的完整 URL 应被移除");
        assert!(pub_st["urlMasked"].as_str().unwrap().contains("…7890"));
        assert_eq!(pub_st["tokenMasked"], "…7890");

        // 而完整版仍带着 —— 界面弹窗的复制按钮需要它
        assert!(core.status_json()["url"]
            .as_str()
            .unwrap()
            .contains("abcdef1234567890"));
    }

    #[test]
    fn status_endpoint_requires_token_and_never_echoes_it() {
        let rt = rt();
        let core = test_core();
        rt.block_on(async {
            let port = serve(core.clone(), "127.0.0.1", 0).await.expect("起服务");
            let no = one_shot(port, &get_req("/status")).await;
            assert!(no.starts_with("HTTP/1.1 401"), "无 token 应 401: {}", no);
            let bad = one_shot(port, &get_req("/status?token=wrong")).await;
            assert!(bad.starts_with("HTTP/1.1 401"), "错 token 应 401: {}", bad);

            let ok = one_shot(port, &get_req("/status?token=testtoken")).await;
            assert!(ok.starts_with("HTTP/1.1 200"), "带 token 应 200: {}", ok);
            assert!(ok.contains("tokenMasked"), "详情里应有打码 token: {}", ok);
            assert!(!ok.contains("testtoken"), "/status 不该回显 token: {}", ok);
            core.shutdown.store(true, Ordering::Relaxed);
        });
    }

    #[test]
    fn broadcast_reaches_live_sessions() {
        let rt = rt();
        let core = test_core();
        rt.block_on(async {
            let port = serve(core.clone(), "127.0.0.1", 0).await.expect("起服务");
            let mut sse = Sse {
                stream: connect(port).await,
                acc: String::new(),
            };
            sse.stream
                .write_all(get_req("/sse?token=testtoken").as_bytes())
                .await
                .unwrap();
            assert!(sse.read_until("event: endpoint", 3000).await, "{}", sse.acc);

            let sent = transport::broadcast(
                &core,
                json!({ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" }),
            );
            assert_eq!(sent, 1, "应送达 1 个会话");
            assert!(
                sse.read_until("tools/list_changed", 3000).await,
                "客户端没收到工具列表变化通知: {}",
                sse.acc
            );

            // 客户端断开后再广播：不能 panic，也该把死会话收掉
            drop(sse);
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            let _ = transport::broadcast(
                &core,
                json!({ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" }),
            );
            assert!(core.sessions.len() <= 1, "死会话应被清理");
            core.shutdown.store(true, Ordering::Relaxed);
        });
    }

    /// 手工联调用的服务端：在固定端口上起服务并保持存活，方便**用外部客户端**（curl / 真实 MCP 客户端）
    /// 连上来验证。默认 #[ignore]，因为要跑 25 秒。
    ///
    /// ```text
    /// cargo test --offline mcp_serve_for_manual_check -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore]
    fn mcp_serve_for_manual_check() {
        let rt = rt();
        let core = test_core();
        // 生产里是 start() 负责打开日志中心；这里直接 serve，所以要手动打开，
        // 否则 log_* 工具会看到"零通道"（曾经因此让跨进程检查误报失败）。
        loghub::hub().set_enabled(true);
        loghub::hub().push(
            "app",
            loghub::LEVEL_INFO,
            loghub::DIR_NONE,
            "手工联调服务已就绪（这条用于验证 log_* 工具能读到东西）",
            0,
        );
        // 调用记录也指到临时目录：联调时也绝不写用户的真实 %APPDATA%
        let log_dir = std::env::temp_dir().join(format!("seahi-manual-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&log_dir);
        core.calllog
            .set_path(Some(log_dir.join(calllog::CALL_LOG_FILE)));
        println!("MCP_CALLLOG_DIR={}", log_dir.to_string_lossy());
        // 注入一份**假的**控件注册表并打开全量控件工具（只在内存里，不写任何文件），
        // 这样跨进程检查能看到 ctl_* 工具、并验证"没有界面时"的行为。
        core.registry.replace(vec![
            registry::RegistryEntry {
                path: "serial.conn.portSelect".into(),
                kind: "select".into(),
                label: "端口".into(),
                panel: "serial".into(),
                group: "conn".into(),
                enabled: true,
                disabled_reason: None,
                options: vec!["COM1".into(), "COM3".into()],
            },
            registry::RegistryEntry {
                path: "serial.toolbar.btnSend".into(),
                kind: "button".into(),
                label: "发送".into(),
                panel: "serial".into(),
                group: "toolbar".into(),
                enabled: true,
                disabled_reason: None,
                options: vec![],
            },
            registry::RegistryEntry {
                path: "global.ui.themeSwitch".into(),
                kind: "button".into(),
                label: "主题".into(),
                panel: "global".into(),
                group: "ui".into(),
                enabled: false,
                disabled_reason: Some("联调用：故意置为不可用".into()),
                options: vec![],
            },
        ]);
        core.cfg
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .expose
            .auto_control_tools = true;
        println!("MCP_REGISTRY=3");
        rt.block_on(async {
            let port = serve(core.clone(), "127.0.0.1", 7799).await.expect("起服务");
            println!("MCP_HEALTHZ=http://127.0.0.1:{}/healthz", port);
            println!("MCP_SSE=http://127.0.0.1:{}/sse?token=testtoken", port);
            println!("MCP_READY=1");
            // 留出足够时间给外部客户端连接
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            core.shutdown.store(true, Ordering::Relaxed);
        });
    }

    /// 把"前端回执 → 桥解析"这**一整条链**接起来测。
    ///
    /// 起因（2026-09 真机检查）：前端断言 `mcpHandleUiCmd` 会回 `notFound`、后端断言
    /// `unwrap_ui_result` 认 `notFound`，两条都绿，但中间的 `mcp_ui_ack` 没带这个字段 ——
    /// 真机上所有"路径/取值不存在"都变成了 `-32006`。所以这里从 ack 的入参形态一路测到错误码。
    #[test]
    fn ui_ack_reply_shape_is_complete() {
        // ① 路径不存在：ack 必须把 notFound 带过去 → 桥必须判成协议级 -32602
        let not_found = ui_ack_payload(
            false,
            None,
            Some("未找到控件: no.such.control".to_string()),
            Some(true),
            None,
            None,
        );
        assert_eq!(
            not_found["notFound"],
            json!(true),
            "ack 丢了 notFound，-32602 的映射就是死代码: {}",
            not_found
        );
        let e = bridge::unwrap_ui_result(not_found).unwrap_err();
        assert_eq!(
            e.code,
            protocol::E_INVALID_PARAMS,
            "控件路径不存在必须是协议级 -32602（请求本身有问题）"
        );
        assert!(e.message.contains("未找到控件"));

        // ①b 参数**取值**非法（串口语义层）：同样是协议级 -32602 —— 也要走完整条链
        let bad_value = ui_ack_payload(
            false,
            None,
            Some("可选值只有: COM1".to_string()),
            None,
            Some(true),
            None,
        );
        assert_eq!(
            bad_value["invalidParams"],
            json!(true),
            "ack 丢了 invalidParams，串口的取值错误会退化成 -32006: {}",
            bad_value
        );
        let e1b = bridge::unwrap_ui_result(bad_value).unwrap_err();
        assert_eq!(e1b.code, protocol::E_INVALID_PARAMS);
        assert!(e1b.message.contains("可选值只有"));

        // ② 控件被禁用（确实跑了但没成功）：不能带 notFound → -32006 + isError
        let disabled = ui_ack_payload(
            false,
            None,
            Some("控件当前不可用".to_string()),
            None,
            None,
            Some("串口未连接".to_string()),
        );
        assert_eq!(disabled["notFound"], json!(false));
        assert_eq!(disabled["invalidParams"], json!(false));
        let e2 = bridge::unwrap_ui_result(disabled).unwrap_err();
        assert_eq!(e2.code, protocol::E_DEVICE_NOT_READY);
        assert!(e2.message.contains("串口未连接"), "原因要带给 AI: {}", e2.message);

        // ③ 成功：value 原样透出，两个标记都归一成 false（不是 null）
        let ok = ui_ack_payload(true, Some(json!({ "a": 1 })), None, None, None, None);
        assert_eq!(ok["value"]["a"], json!(1));
        assert_eq!(ok["notFound"], json!(false));
        assert_eq!(ok["invalidParams"], json!(false));
        assert_eq!(bridge::unwrap_ui_result(ok).unwrap()["a"], json!(1));
    }
}
