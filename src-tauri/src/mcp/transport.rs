//! MCP 传输层：hyper 服务器 + `/healthz` + `/sse` + `/messages` + `/mcp`。
//!
//! 两种传输并存、共用同一套工具与同一张会话表：
//! - **遗留 SSE**（2024-11-05 规范）：`GET /sse` 建会话并下发 `event: endpoint` →
//!   `POST /messages?sessionId=…` 收报文，结果从 SSE 流回。
//! - **Streamable HTTP**（2025-03-26+ 规范，本项目实现于 2026-09）：单端点 `/mcp` ——
//!   `POST /mcp`（直接回 `application/json`）、`GET /mcp`（挂 SSE 流收服务端通知）、
//!   `DELETE /mcp`（终止会话）。规矩见 `post_mcp` / `get_mcp` / `delete_mcp` 的注释。
//!
//! 只监听回环地址。token 同时支持**查询串**（`?token=`，遗留 SSE 客户端不一定能带自定义 Header）
//! 与 `Authorization: Bearer`。
//!
//! SSE 用「有界 channel + try_send」实现：**生产者绝不 await、绝不阻塞**，
//! 队列满就丢并计数（§4.7 铁律 3），慢消费者最终会被断开而不是把内存吃光。

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures::channel::mpsc;
use futures::StreamExt;
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::header::HeaderMap;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;

use super::{aiconfig, McpCore};

/// Streamable HTTP 的会话头（客户端在 `initialize` 之后必须带回来）
pub const MCP_SESSION_HEADER: &str = "mcp-session-id";
/// Streamable HTTP 的协议版本头（2025-06-18 规范要求客户端带上）
pub const MCP_VERSION_HEADER: &str = "mcp-protocol-version";
/// Streamable HTTP 的"前身"版本：它定义了这个传输形态，客户端带它来我们也照服务
pub const STREAMABLE_ORIGIN_VERSION: &str = "2025-03-26";

/// 统一的响应体类型。
/// 用 `UnsyncBoxBody` 而不是 `BoxBody`：SSE 的 body 包着 `mpsc::Receiver`，它不是 `Sync`；
/// 而且 `StreamBody` 同时实现了 `Body` 与 `Stream`，`.boxed()` 会有歧义，`boxed_unsync()` 唯一。
pub type RespBody = UnsyncBoxBody<Bytes, std::io::Error>;

fn map_infallible(e: Infallible) -> std::io::Error {
    match e {}
}

fn empty_body() -> RespBody {
    Full::new(Bytes::new())
        .map_err(map_infallible as fn(Infallible) -> std::io::Error)
        .boxed_unsync()
}

fn json_resp(status: StatusCode, v: serde_json::Value) -> Response<RespBody> {
    let bytes = Bytes::from(v.to_string());
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(
            Full::new(bytes)
                .map_err(map_infallible as fn(Infallible) -> std::io::Error)
                .boxed_unsync(),
        )
        .unwrap_or_else(|_| Response::new(empty_body()))
}

/// 会话属于哪条传输。
///
/// ⚠️ **淘汰策略必须看它，不能看 `tx`**：`tx` 只表示"有没有推送通道"，而 HTTP 会话一挂上
/// `GET /mcp` 流也有 `tx`。用 `tx` 当判据的后果（2026-09 实测证实）：4 个**按规范挂了推送流**的
/// HTTP 客户端把坑占满后，淘汰候选变成 0 → 第 5 个客户端直接吃 429，只能干等 30 分钟空闲回收 ——
/// 而挂 `GET /mcp` 恰恰是推荐用法，所以这不是理论风险。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionKind {
    /// 遗留 SSE（`/sse` + `/messages`）：会话就是那条长连接
    Sse,
    /// Streamable HTTP（`/mcp`）：会话由 `Mcp-Session-Id` 标识，可以另外挂 `GET /mcp` 流
    Http,
}

/// 一个已建立的会话
pub struct Session {
    /// 属于哪条传输（**淘汰策略只看它**，详见 `SessionKind` 的注释）
    pub kind: SessionKind,
    /// 出站通道。`None` = 当前没有推送通道：HTTP 会话平时是 `None`，
    /// 客户端挂了 `GET /mcp` 流之后才变成 `Some`；SSE 会话建好流就是 `Some`。
    pub tx: Option<mpsc::Sender<String>>,
    pub created: Instant,
    pub last_seen: Instant,
    /// 本分钟窗口内的请求数（限流）
    pub count: u32,
    pub window_start: Instant,
}

impl Session {
    /// 这条会话是否**已经不可用**（超过空闲 TTL，且没有挂活的推送流）。
    ///
    /// 判据必须是「没有推送流 **且** 超过 TTL」：
    /// ① `last_seen` 只在**协议请求**时刷新，挂机不动的 SSE 客户端照样连着 —— 只看 `last_seen`
    ///    会把"在用但没说话"的客户端当死会话顺手清掉（2026-11 评审 M2，客户端下一次请求拿到
    ///    一句没头没尾的 404）；
    /// ② 本服务**只监听回环**：对端进程一死，OS 立刻发 FIN，`SseBody::drop` 当场回收，所以
    ///    「`tx` 还在」在本机就是「连接还活着」，不需要拿 TTL 兜底（半开连接是网络的产物，
    ///    回环上基本不存在）。
    fn stale(&self, now: Instant) -> bool {
        self.tx.is_none()
            && now.duration_since(self.last_seen) >= Duration::from_secs(super::IDLE_TIMEOUT_SECS)
    }

    fn rate_ok(&mut self, now: Instant) -> bool {
        if now.duration_since(self.window_start) >= Duration::from_secs(60) {
            self.window_start = now;
            self.count = 0;
        }
        self.count += 1;
        self.count <= super::RATE_LIMIT_PER_MIN
    }
}

/// 会话注册表
#[derive(Default)]
pub struct Sessions {
    pub map: Mutex<HashMap<String, Session>>,
}

impl Sessions {
    /// 表里的**条目数**（含已过期但还没被回收的）。只给测试用：对外展示一律用
    /// `active_len` —— 直接拿它当「在线会话数」就会把死客户端的表项算进去。
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// 仍然**可服务**的会话数（不含已过期、只是还没被顺手清掉的表项）。
    ///
    /// 界面上的「N 个会话」与 `mcp_status.sessions` 都用它。用 `map.len()` 会把死客户端的
    /// 表项算成「在线」：回收是惰性的（只有新会话建立/使用时才 `retain`），所以没有新客户端
    /// 来的时候，读数可以在旧值上停**任意久**（2026-11 评审 M1：状态点假 live）。
    pub fn active_len(&self) -> usize {
        let now = Instant::now();
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|s| !s.stale(now))
            .count()
    }

    pub fn clear(&self) {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }

    /// 逐会话快照（只含**仍可服务**的会话），给界面 / `mcp_status` 用。
    ///
    /// 为什么需要它：`sessions` 只是个总数，界面分不出「有活跃推送流的客户端」和「只是一条
    /// 可能已经没人用的表项」—— 前者是真在线，后者可能几十分钟后就被回收（2026-11 评审 M5）。
    /// 只暴露 sid 前 8 位：足够人/模型对照，不把完整 `Mcp-Session-Id` 递出去。
    pub fn detail(&self) -> Vec<serde_json::Value> {
        let now = Instant::now();
        let map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let mut out: Vec<serde_json::Value> = map
            .iter()
            .filter(|(_, s)| !s.stale(now))
            .map(|(sid, s)| {
                serde_json::json!({
                    "id": &sid[..8.min(sid.len())],
                    "kind": match s.kind {
                        SessionKind::Http => "http",
                        SessionKind::Sse => "sse",
                    },
                    "idleSecs": now.duration_since(s.last_seen).as_secs(),
                    // 有推送流 = 连接本身还在（SSE 长连接 / HTTP 的 GET /mcp 流）
                    "hasStream": s.tx.is_some(),
                })
            })
            .collect();
        // 活跃的在前：界面挑"有没有活跃流"时不用先自己排序
        out.sort_by_key(|v| v["idleSecs"].as_u64().unwrap_or(u64::MAX));
        out
    }
}

/// 回收已过期的会话；**真清掉了就推一次状态**（界面上的数字才会回落）。
///
/// 回收是惰性的 —— 只在有人来建会话 / 用会话时发生（没有后台巡检任务）。所以推送也挂在这里，
/// 宁可多推一次，也不要让界面停在「3 个会话」而其实一个都没有。
pub(crate) fn sweep_idle(core: &Arc<McpCore>) -> usize {
    let now = Instant::now();
    let removed = {
        let mut map = core.sessions.map.lock().unwrap_or_else(|e| e.into_inner());
        let before = map.len();
        map.retain(|_, s| !s.stale(now));
        before - map.len()
    };
    // 锁必须已经释放：`emit_status` 内部要读 `sessions.active_len()`，持锁调它会死锁
    if removed > 0 {
        core.emit_status();
    }
    removed
}

/// 表满时腾一个位置：淘汰**最久未活动的 HTTP 会话**（返回被淘汰的 sid）。
///
/// 不碰 SSE 会话：那条长连接已经建立，删表项只会让它变成收不到东西的僵尸。全表都是 SSE 时
/// 返回 `None`（调用方再决定回 429 还是 NoCapacity）。
fn evict_idle_http(map: &mut HashMap<String, Session>) -> Option<String> {
    let victim = map
        .iter()
        .filter(|(_, s)| s.kind == SessionKind::Http)
        .min_by_key(|(_, s)| s.last_seen)
        .map(|(k, _)| k.clone())?;
    map.remove(&victim);
    Some(victim)
}

/// 会话表满且腾不出位置时的统一回包（429 + `Retry-After`）。
///
/// 光给一个 429，客户端只能干等：`Retry-After` 至少让它知道"退避多久再来"，`hint` 说清
/// 成因（多半是几个老客户端占着、等空闲回收）。
fn too_many_sessions() -> Response<RespBody> {
    let mut resp = json_resp(
        StatusCode::TOO_MANY_REQUESTS,
        serde_json::json!({
            "error": "too many sessions",
            "max": super::MAX_SESSIONS,
            "hint": "会话表已满且都是 SSE 长连接：关掉一个客户端，或等空闲会话回收（最多 30 分钟）后重连。"
        }),
    );
    if let Ok(v) = hyper::header::HeaderValue::from_str("60") {
        resp.headers_mut().insert(hyper::header::RETRY_AFTER, v);
    }
    resp
}

// ===== 绑定 =====

/// 绑定回环端口，被占用则按 `PORT_FALLBACK_RANGE` 向后尝试。
/// `AddrInUse` 会短暂重试：关闭服务器后立刻再开时，上一次的 listener 可能还没释放。
pub async fn bind(host: &str, port: u16) -> Result<(TcpListener, u16), String> {
    let mut last = String::from("未尝试任何端口");
    for offset in 0..=aiconfig::PORT_FALLBACK_RANGE {
        let p = port.saturating_add(offset);
        let addr = format!("{}:{}", host, p);
        for attempt in 0..5u32 {
            match TcpListener::bind(&addr).await {
                Ok(l) => {
                    // 端口传 0 时由系统分配，必须回报真实端口（测试与非默认端口场景都依赖这点）
                    let actual = l.local_addr().map(|a| a.port()).unwrap_or(p);
                    return Ok((l, actual));
                }
                Err(e) => {
                    last = format!("绑定 {} 失败: {}", addr, e);
                    if e.kind() == std::io::ErrorKind::AddrInUse && attempt < 4 {
                        tokio::time::sleep(Duration::from_millis(120)).await;
                        continue;
                    }
                    break;
                }
            }
        }
    }
    Err(format!(
        "{}（已尝试 {} 个端口）",
        last,
        aiconfig::PORT_FALLBACK_RANGE + 1
    ))
}

/// 接受循环。`core.shutdown` 置真后最多 200ms 退出，并清空会话（SSE 流随之结束）。
pub async fn run(core: Arc<McpCore>, listener: TcpListener, port: u16) {
    while !core.shutdown.load(Ordering::Relaxed) {
        match tokio::time::timeout(Duration::from_millis(200), listener.accept()).await {
            Ok(Ok((stream, _peer))) => {
                let c = core.clone();
                tokio::spawn(async move {
                    let io = TokioIo::new(stream);
                    let svc = service_fn(move |req: Request<Incoming>| {
                        let c2 = c.clone();
                        async move { handle(req, c2, port).await }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(io, svc)
                        .await;
                });
            }
            Ok(Err(e)) => {
                // accept 出错：短暂休眠避免空转烧 CPU。也要上报 —— 这条路径平时一声不吭，
                // 真出问题时（比如网卡/句柄被耗尽）用户只会看到"客户端连不上"。
                super::report::report("accept_failed", &e.to_string());
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(_) => { /* 超时：回到循环顶部检查 shutdown */ }
        }
    }
    core.sessions.clear();
    drop(listener);
}

// ===== 路由 =====

async fn handle(
    req: Request<Incoming>,
    core: Arc<McpCore>,
    port: u16,
) -> Result<Response<RespBody>, Infallible> {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();
    let headers = req.headers().clone();
    // 传输形态（单档：http / sse）。每次请求都读一次配置 —— 所以改它是**立即生效**的，
    // 不需要重启服务器；没被选中的那条传输落进 `_` 分支回 404（"这个端点不存在"）。
    let mode = core.transport_mode();
    let resp = match (method, path.as_str()) {
        // 探活：无需 token，且**不返回任何信息**（否则等于给本机任意进程一个免费的信息泄露点）
        (Method::GET, "/healthz") => json_resp(StatusCode::OK, serde_json::json!({ "ok": true })),
        // 详情：需要 token；**token 与 URL 都打码**（调用方本来就知道 token，但没必要回显）
        (Method::GET, "/status") => {
            let given = token_from(&query, &headers).unwrap_or_default();
            if !constant_time_eq(&given, &core.token()) {
                unauthorized(&core, "/status")
            } else {
                json_resp(StatusCode::OK, core.status_json_public())
            }
        }
        // ===== 遗留 SSE（2024-11-05 规范）=====
        (Method::GET, "/sse") if mode.serves_sse() => open_sse(&core, &query, port),
        (Method::POST, "/messages") if mode.serves_sse() => post_message(req, &core, &query).await,
        // ===== Streamable HTTP（2025-03-26+ 规范）：单端点三动词 =====
        (Method::POST, "/mcp") if mode.serves_http() => post_mcp(req, &core, &query).await,
        (Method::GET, "/mcp") if mode.serves_http() => get_mcp(&core, &query, &headers),
        (Method::DELETE, "/mcp") if mode.serves_http() => delete_mcp(&core, &query, &headers),
        _ => {
            // 端点**存在但当前档位没开** → 仍然 404（规范），但要说清原因并记账：
            // "升级后老客户端突然连不上 / 时不时断"最常见的成因就是客户端还配着另一条传输的地址。
            let requested = match path.as_str() {
                "/sse" | "/messages" if !mode.serves_sse() => Some("sse"),
                "/mcp" if !mode.serves_http() => Some("http"),
                _ => None,
            };
            match requested {
                Some(want) => {
                    let current = if want == "sse" { "http" } else { "sse" };
                    core.note_rejection(
                        "transport_disabled",
                        &path,
                        &format!("请求 {}，当前只提供 {}", want, current),
                    );
                    json_resp(
                        StatusCode::NOT_FOUND,
                        serde_json::json!({
                            "error": "transport disabled",
                            "requested": want,
                            "current": current,
                            "hint": format!(
                                "程序当前只提供 {}。要用 {}，请在程序弹窗里把「传输」切到 {}。",
                                current.to_uppercase(),
                                want,
                                want.to_uppercase()
                            ),
                        }),
                    )
                }
                None => json_resp(
                    StatusCode::NOT_FOUND,
                    serde_json::json!({ "error": "not found" }),
                ),
            }
        }
    };
    Ok(resp)
}

/// 给所有会话推一条**通知**（没有 id 的 JSON-RPC 报文）。
/// 非阻塞：队列满/已断开的会话直接清掉并计数 —— 不能让广播卡住任何人。
///
/// Streamable HTTP 会话如果没有挂 `GET /mcp` 流（`tx == None`）就**跳过**：
/// 它没有推送通道，这不是"死会话"，不能顺手把它从表里删掉。
pub fn broadcast(core: &Arc<McpCore>, payload: serde_json::Value) -> usize {
    let msg = format!("event: message\ndata: {}\n\n", payload);
    let (sent, removed) = {
        let mut map = core.sessions.map.lock().unwrap_or_else(|e| e.into_inner());
        let mut dead: Vec<String> = Vec::new();
        let mut sent = 0usize;
        for (sid, s) in map.iter_mut() {
            let Some(mut tx) = s.tx.clone() else {
                continue;
            };
            match tx.try_send(msg.clone()) {
                Ok(()) => sent += 1,
                Err(_) => dead.push(sid.clone()),
            }
        }
        let mut removed = 0usize;
        for sid in dead {
            if map.remove(&sid).is_some() {
                removed += 1;
            }
            core.dropped.fetch_add(1, Ordering::Relaxed);
        }
        (sent, removed)
    };
    // 广播顺手删掉的死会话也要**推一次状态**（与其它删除路径同一口径）：
    // 否则界面上的会话数只增不减，用户会以为那个客户端还连着。
    if removed > 0 {
        core.emit_status();
    }
    sent
}

fn query_param(query: &str, key: &str) -> Option<String> {
    let prefix = format!("{}=", key);
    query
        .split('&')
        .find_map(|pair| pair.strip_prefix(&prefix))
        // token 与 sessionId 都是十六进制/无特殊字符，不需要 URL 解码
        .map(|v| v.to_string())
}

fn token_from(query: &str, headers: &HeaderMap) -> Option<String> {
    if let Some(t) = query_param(query, "token") {
        return Some(t);
    }
    headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .map(|s| s.trim().to_string())
}

/// 定长比较（避免按字节提前返回；本机场景下不强求，但成本几乎为零）
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

fn unauthorized(core: &Arc<McpCore>, path: &str) -> Response<RespBody> {
    // 鉴权失败既要回 401，也要留下痕迹：客户端配置里的 token 过期/粘错是最常见的
    // "连不上"原因，光看界面是看不出来的。已按 kind+detail 去重（5 分钟一条），
    // 不会因为客户端每秒重试而刷爆错误库。
    core.note_rejection("unauthorized", path, "token 不匹配");
    super::report::report("unauthorized", "收到 token 不匹配的请求（客户端配置可能过期，需重新复制连接地址）");
    json_resp(
        StatusCode::UNAUTHORIZED,
        serde_json::json!({ "error": "unauthorized" }),
    )
}

// ===== Streamable HTTP 的几个公共零件 =====

fn header_str(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn forbidden(core: &Arc<McpCore>, path: &str) -> Response<RespBody> {
    core.note_rejection("origin_forbidden", path, "Origin 不是回环来源");
    json_resp(
        StatusCode::FORBIDDEN,
        serde_json::json!({ "error": "origin not allowed" }),
    )
}

/// 会话不认识的统一回包。**必须是 404**：规范里客户端拿到 404 才会重新 `initialize`；
/// 回 400/401 它只会一路失败（这正是"连不上但不知道为什么"的典型来源）。
///
/// 同时记一笔 `session_not_found`：客户端"时不时断"若能在这里看到记录，说明是会话被回收/
/// 淘汰之后它**没有重新 initialize** 就直接又发了请求。
fn session_not_found(core: &Arc<McpCore>, path: &str) -> Response<RespBody> {
    core.note_rejection("session_not_found", path, "会话 id 不在表里（过期 / 被淘汰 / 服务器重启过）");
    json_resp(
        StatusCode::NOT_FOUND,
        serde_json::json!({
            "error": "session not found",
            "hint": "Mcp-Session-Id 过期或被回收了，请重新 initialize 取一个新的"
        }),
    )
}

/// Streamable HTTP 的 `Origin` 校验（规范要求，防 DNS rebinding）。
///
/// **只在 `/mcp` 上生效**：`/sse` + `/messages` 是既有路径，不动它 —— 那些客户端本来就不发
/// Origin，为合规去赌"某个客户端带了个奇怪的 Origin"不划算（改动风险 > 收益）。
/// 没有 Origin 头 = 非浏览器客户端（curl / SDK / 桌面应用）→ 放行。
fn origin_allowed(headers: &HeaderMap) -> bool {
    match header_str(headers, "origin") {
        None => true,
        Some(o) => origin_host_is_loopback(&o),
    }
}

fn origin_host_is_loopback(origin: &str) -> bool {
    let o = origin.trim().to_ascii_lowercase();
    // 不接受 https://：我们自己是 http 服务，浏览器从 https 页面打过来是 mixed content，
    // 会被浏览器先拦掉；真出现这种 Origin 只可能是别人（DNS rebinding 的场景）。
    let Some(rest) = o.strip_prefix("http://") else {
        return false;
    };
    let host = if let Some(h) = rest.strip_prefix('[') {
        h.split(']').next().unwrap_or("") // IPv6：http://[::1]:7777
    } else {
        rest.split(['/', ':']).next().unwrap_or("")
    };
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

/// `MCP-Protocol-Version` 校验：返回 `Some(不认识的版本)` 就该回 400。
///
/// 规范：`initialize` 之后的请求都必须带这个头；服务器收到**不支持**的值必须回 400。
/// 缺失时按规范假定 `2025-03-26` 放行（不带这个头的老实现照样能用）。
fn protocol_version_problem(headers: &HeaderMap) -> Option<String> {
    let v = header_str(headers, MCP_VERSION_HEADER)?;
    let known = v == super::protocol::PROTOCOL_VERSION
        || v == super::protocol::PROTOCOL_FALLBACK
        || v == STREAMABLE_ORIGIN_VERSION;
    if known {
        None
    } else {
        Some(v)
    }
}

fn bad_protocol_version(core: &Arc<McpCore>, path: &str, v: &str) -> Response<RespBody> {
    core.note_rejection("bad_protocol_version", path, &format!("不支持的版本 {}", v));
    // 把"我们支持哪些"写进错误消息：否则调用方只看到一句 400，只能靠猜
    json_resp(
        StatusCode::BAD_REQUEST,
        serde_json::json!({
            "error": format!("不支持的 MCP-Protocol-Version: {}", v),
            "supported": [
                super::protocol::PROTOCOL_VERSION,
                STREAMABLE_ORIGIN_VERSION,
                super::protocol::PROTOCOL_FALLBACK
            ],
        }),
    )
}

/// 给响应挂上 `Mcp-Session-Id`（只在新会话时挂：客户端拿到后必须回带）
fn with_session_header(mut resp: Response<RespBody>, sid: &str, is_new: bool) -> Response<RespBody> {
    if is_new {
        if let Ok(v) = hyper::header::HeaderValue::from_str(sid) {
            resp.headers_mut().insert(
                hyper::header::HeaderName::from_static(MCP_SESSION_HEADER),
                v,
            );
        }
    }
    resp
}

fn open_sse(core: &Arc<McpCore>, query: &str, _port: u16) -> Response<RespBody> {
    let given = query_param(query, "token").unwrap_or_default();
    if !constant_time_eq(&given, &core.token()) {
        return unauthorized(core, "/sse");
    }

    let now = Instant::now();
    // 回收空闲会话（防"客户端崩了没发 RST"长期占位）。放在锁外：它自己会推状态。
    // ⚠️ 判据是 `Session::stale`（没有推送流 **且** 超过 TTL）—— 挂着长连接的会话
    // 不按"请求空闲"回收。
    let _ = sweep_idle(core);
    let mut evicted: Option<String> = None;
    let id = {
        let mut map = core.sessions.map.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() >= super::MAX_SESSIONS {
            // 先腾位置：**只淘汰最久未活动的 HTTP 会话**（它被淘汰是干净可恢复的：客户端下次
            // 请求得 404、重新 initialize）。绝不淘汰 SSE 会话 —— 那条长连接已经建立，删表项
            // 只会让它变成"再也收不到东西"的僵尸连接。
            // 一个都腾不出来（表里全是 SSE 长连接）才回 429；客户端至少能按 Retry-After 退避，
            // 不至于完全无从下手。
            match evict_idle_http(&mut map) {
                Some(v) => evicted = Some(v),
                None => return too_many_sessions(),
            }
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        // 先以"没有通道"的形态落表，随后由 attach_outbound 挂上长连接。
        // `kind` 是**显式**标出来的：上限/回收/限流共用一套口径，但淘汰策略必须按它区分两类会话。
        map.insert(
            id.clone(),
            Session {
                kind: SessionKind::Sse,
                tx: None,
                created: now,
                last_seen: now,
                count: 0,
                window_start: now,
            },
        );
        id
    };
    if let Some(v) = evicted {
        crate::dbg_log(&format!(
            "mcp: 会话数已达上限 {}，为新建的 SSE 会话淘汰了最久未活动的 HTTP 会话 {}",
            super::MAX_SESSIONS,
            &v[..8.min(v.len())]
        ));
        super::report::report(
            "http_session_evicted",
            &format!(
                "SSE 客户端接入时表已满，淘汰了最久未活动的 HTTP 会话（客户端会在下次请求得到 404 并重新 initialize；上限 {}）",
                super::MAX_SESSIONS
            ),
        );
    }
    crate::dbg_log(&format!("mcp: 会话 {} 已建立", &id[..8.min(id.len())]));
    // 会话数变了要**立刻告诉界面**，否则弹窗里的"会话"数字会一直停在打开弹窗那一刻的值
    core.emit_status();
    // 第一条必须是 endpoint 事件，告诉客户端往哪 POST
    let endpoint = format!(
        "event: endpoint\ndata: /messages?sessionId={}&token={}\n\n",
        id,
        core.token()
    );
    attach_outbound(core, &id, Some(endpoint), false)
}

/// 建一条出站通道挂到会话上，返回 SSE 响应体。两个调用方共用：
/// - `/sse`：新建会话 + 首帧 `endpoint`，**流断开 = 会话结束**（`keep_session_on_drop = false`）；
/// - `GET /mcp`：复用已有会话，流断开**只摘通道**（`true`）—— 会话还要继续给 `POST /mcp` 用。
fn attach_outbound(
    core: &Arc<McpCore>,
    sid: &str,
    first_frame: Option<String>,
    keep_session_on_drop: bool,
) -> Response<RespBody> {
    let (mut tx, rx) = mpsc::channel::<String>(super::SESSION_QUEUE);
    if let Some(f) = first_frame {
        if tx.try_send(f).is_err() {
            // 队列刚建就满 = 配置/运行时出了异常，值得上报（正常永远不该发生）
            super::report::report(
                "sse_endpoint_queue_full",
                &format!("新建会话的队列立即满了（队列深度 {}）", super::SESSION_QUEUE),
            );
            return json_resp(
                StatusCode::SERVICE_UNAVAILABLE,
                serde_json::json!({ "error": "queue full" }),
            );
        }
    }
    {
        let mut map = core.sessions.map.lock().unwrap_or_else(|e| e.into_inner());
        match map.get_mut(sid) {
            Some(s) => s.tx = Some(tx.clone()),
            None => return session_not_found(core, "/sse"),
        }
    }

    // 心跳：注释帧，防中间层/NAT 断流，同时探测客户端是否还在
    let mut hb = tx.clone();
    let core_hb = core.clone();
    let sid_hb = sid.to_string();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(super::HEARTBEAT_SECS)).await;
            if hb.try_send(": ping\n\n".to_string()).is_err() {
                break; // 队列满 / 接收端已断开
            }
            // 会话已经不在表里（`DELETE /mcp`、或 `/sse` 流断开后被回收）→ 这个心跳再转下去
            // 也没人收。**以前没有这一步**：会话被删掉后心跳会一直转到队列写满为止
            // （15s × 256 ≈ 1 小时），等于每断开一次就漏一个后台任务。
            //
            // 同时**刷新 `last_seen`**：ping 能塞进队列 = 对端 `rx` 还在 = 这条连接活着。
            // 不刷的话"挂着长连接但一直没发请求"的会话会显示成一小时没活动，回收/展示两头都误解。
            let alive = {
                let mut map = core_hb
                    .sessions
                    .map
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                match map.get_mut(&sid_hb) {
                    Some(s) => {
                        s.last_seen = Instant::now();
                        true
                    }
                    None => false,
                }
            };
            if !alive {
                break;
            }
        }
    });

    sse_response(core.clone(), sid.to_string(), rx, keep_session_on_drop)
}

/// SSE 响应体：**流被丢弃时立刻处理会话**。
///
/// 为什么需要它（2026-09 由官方 SDK 一致性检查发现）：会话表里只存了 `tx`，而 SSE 响应的
/// 接收端 `rx` 在客户端断开时会被 hyper 丢掉 —— 但**没有任何人**注意到这件事：
/// 心跳的 `try_send` 仍然成功（队列没满），`deliver` 也不会被调用，于是这个会话
/// 要一直挂到**空闲 30 分钟回收**为止。后果很严重：`MAX_SESSIONS = 4`，
/// 客户端重启/重连 4 次就会把坑占满，之后所有连接直接吃 429 "too many sessions"，
/// 而且要等半小时才能恢复。独立客户端跑一遍就撞上了（4 个坑全是它自己崩掉的连接）。
///
/// `keep_session`（Streamable HTTP 的 `GET /mcp` 用）：流断了**只摘通道、不删会话** ——
/// 那个会话是给 `POST /mcp` 复用的，删掉它等于把客户端踢下线。
struct SseBody {
    inner: futures::stream::BoxStream<'static, Result<Frame<Bytes>, std::io::Error>>,
    core: Arc<McpCore>,
    sid: String,
    keep_session: bool,
}

impl futures::Stream for SseBody {
    type Item = Result<Frame<Bytes>, std::io::Error>;
    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        self.inner.as_mut().poll_next(cx)
    }
}

impl Drop for SseBody {
    fn drop(&mut self) {
        if self.keep_session {
            // 会话留着（还要给 POST 用），只把这条推送通道摘掉。会话数没变 → 不推状态。
            if let Some(s) = self
                .core
                .sessions
                .map
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get_mut(&self.sid)
            {
                s.tx = None;
            }
            return;
        }
        let removed = self
            .core
            .sessions
            .map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.sid)
            .is_some();
        if removed {
            crate::dbg_log(&format!(
                "mcp: 会话 {} 已断开（立刻回收，不等空闲超时）",
                &self.sid[..8.min(self.sid.len())]
            ));
            // 同理：会话少了也要推一次，界面上的数字/状态点才会回落
            self.core.emit_status();
        }
    }
}

fn sse_response(
    core: Arc<McpCore>,
    sid: String,
    rx: mpsc::Receiver<String>,
    keep_session: bool,
) -> Response<RespBody> {
    let stream = rx.map(|s| Ok::<_, std::io::Error>(Frame::data(Bytes::from(s))));
    let body = SseBody {
        inner: stream.boxed(),
        core,
        sid,
        keep_session,
    };
    let body = StreamBody::new(body).boxed_unsync();
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-cache")
        .header("connection", "keep-alive")
        .body(body)
        .unwrap_or_else(|_| Response::new(empty_body()))
}

async fn post_message(
    req: Request<Incoming>,
    core: &Arc<McpCore>,
    query: &str,
) -> Response<RespBody> {
    let headers = req.headers().clone();
    let given = token_from(query, &headers).unwrap_or_default();
    if !constant_time_eq(&given, &core.token()) {
        return unauthorized(core, "/messages");
    }
    let sid = match query_param(query, "sessionId") {
        Some(s) => s,
        None => {
            return json_resp(
                StatusCode::BAD_REQUEST,
                serde_json::json!({ "error": "missing sessionId" }),
            )
        }
    };

    // 读取请求体（带上限）。逻辑抽到 `read_body_limited`：`/messages` 与 `/mcp` 共用同一份，
    // 免得两条链路各写一遍、再漂移出"新端点没有上限"这种事。
    let body = match read_body_limited(req).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    // 限流回包必须带上**这次请求的 id**：原实现写的是 `id: null`（注释却写着"让客户端能把它对应到
    // 某个请求"），而客户端发的 id 是 X —— 配不上号的那条 error 会被丢掉，**那次调用一路挂到超时**，
    // 客户端以为失败又重试，越限流越糟。这就是"反复调用失败"的一个真实成因。
    let req_id = serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("id").cloned())
        .filter(|v| !v.is_null())
        .unwrap_or(serde_json::Value::Null);

    // 限流 + 查找会话
    let now = Instant::now();
    let resp_json = {
        let mut map = core.sessions.map.lock().unwrap_or_else(|e| e.into_inner());
        match map.get_mut(&sid) {
            None => {
                return json_resp(
                    StatusCode::NOT_FOUND,
                    serde_json::json!({ "error": "unknown session (SSE 可能已断开)" }),
                )
            }
            Some(s) => {
                s.last_seen = now;
                if !s.rate_ok(now) {
                    // 被限流说明有个客户端在猛刷：进错误库（去重后最多 5 分钟一条）
                    super::report::report(
                        "rate_limited",
                        &format!("某会话超过 {}/分 的请求上限，已按限流处理", super::RATE_LIMIT_PER_MIN),
                    );
                    // 文案与 `POST /mcp` 共用一份（`rate_limited_body`）：两个传输给 AI 的
                    // 解释不许漂移，否则同一个"放慢点"在一边说得清、另一边只有一句错误码
                    Some(rate_limited_body(req_id))
                } else {
                    None
                }
            }
        }
    };

    if let Some(limited) = resp_json {
        // 限流错误也走 SSE 回包，让客户端能把它对应到某个请求
        deliver(core, &sid, limited);
        return json_resp(StatusCode::ACCEPTED, serde_json::json!({ "accepted": true }));
    }

    let text = String::from_utf8_lossy(&body).to_string();
    // 分发（协议层完全不知道 Socket 的存在；带上 sid 以便调用记录能标清是哪个会话）
    // 走 handle_raw_guarded：内部 panic 会变成一条 JSON-RPC 错误 + 一次错误上报，
    // 而不是把这条连接的任务打死、让客户端干等到超时。
    if let Some(resp) = super::protocol::handle_raw_guarded(core, &text, &sid).await {
        deliver(core, &sid, resp);
    }
    json_resp(StatusCode::ACCEPTED, serde_json::json!({ "accepted": true }))
}

/// 把一条 SSE 报文投递给会话。**非阻塞**：队列满就丢并计数，断开则回收会话。
fn deliver(core: &Arc<McpCore>, sid: &str, payload: String) {
    let mut removed = false;
    {
        let mut map = core.sessions.map.lock().unwrap_or_else(|e| e.into_inner());
        let mut drop_session = false;
        if let Some(s) = map.get_mut(sid) {
            // Streamable HTTP 会话如果没挂 `GET /mcp` 流（`tx == None`），就没有可投递的地方：
            // 直接返回。**不能**把它当"死会话"删掉 —— 那个会话还要继续给 POST 用。
            let Some(mut sender) = s.tx.clone() else {
                return;
            };
            match sender.try_send(format!("event: message\ndata: {}\n\n", payload)) {
                Ok(()) => {}
                Err(e) if e.is_disconnected() => drop_session = true,
                Err(_) => {
                    // 队列满 = 慢消费者。丢这一条并计数；响应也丢说明连接不可用，直接断开会话。
                    core.dropped.fetch_add(1, Ordering::Relaxed);
                    drop_session = true;
                    let age = s.created.elapsed().as_secs(); // 注意：不能再借用 map（s 还在借）
                    crate::dbg_log(&format!(
                        "mcp: 会话 {} 队列满（慢消费者，存活 {}s），已断开",
                        &sid[..8.min(sid.len())],
                        age
                    ));
                    // 慢消费者被断开是真实的运行期故障（客户端卡住/网络中断），进错误库
                    super::report::report(
                        "session_slow_consumer_dropped",
                        &format!(
                            "会话队列满（深度 {}），已断开该会话；存活 {}s",
                            super::SESSION_QUEUE,
                            age
                        ),
                    );
                }
            }
        }
        if drop_session {
            removed = map.remove(sid).is_some();
        }
    }
    // 删了会话就**必须**推一次状态（与 `SseBody::drop` / `resolve_http_session` 同一口径）：
    // 否则界面会一直显示这条已经不存在的会话，直到下一次别的会话事件（2026-11 评审 M3）。
    // 锁已经释放 —— `emit_status` 内部要读会话数，持锁调它会死锁。
    if removed {
        core.emit_status();
    }
}

/// 读取请求体并**在读取过程中**执行上限（两道：先看 `Content-Length`，再用 `Limited` 兜住 chunked）。
///
/// ⚠️ 不能"先全收进内存再判大小"：老实现是 `req.into_body().collect()` 之后再比
/// `body.len() > MAX_BODY_BYTES`，于是一次 1 GB 的 POST 会先在进程里分配 1 GB ——
/// 那个 1 MiB 的上限等于没写（2026-09 审计发现）。现在 `/messages` 与 `/mcp` **共用这一份**，
/// 免得两条链路各写一遍、再漂移出"新端点没有上限"这种事。
async fn read_body_limited(req: Request<Incoming>) -> Result<Bytes, Response<RespBody>> {
    // ① 一上来就报大数的最常见情形：连读都不读
    if let Some(len) = req
        .headers()
        .get(hyper::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
    {
        if len > super::MAX_BODY_BYTES as u64 {
            return Err(body_too_large());
        }
    }
    // ② 没给长度、或长度撒谎的 chunked 请求：在超出的那一刻断开
    match http_body_util::Limited::new(req.into_body(), super::MAX_BODY_BYTES)
        .collect()
        .await
    {
        Ok(c) => {
            let b = c.to_bytes();
            if b.len() > super::MAX_BODY_BYTES {
                return Err(body_too_large());
            }
            Ok(b)
        }
        // 超过上限与"读取出错"要分开说：前者是调用方的问题（少发点），后者是链路问题
        Err(e) => {
            if e.is::<http_body_util::LengthLimitError>() {
                Err(body_too_large())
            } else {
                Err(json_resp(
                    StatusCode::BAD_REQUEST,
                    serde_json::json!({
                        "error": format!("读取请求体失败: {}", e),
                        "max": super::MAX_BODY_BYTES,
                    }),
                ))
            }
        }
    }
}

fn body_too_large() -> Response<RespBody> {
    json_resp(
        StatusCode::PAYLOAD_TOO_LARGE,
        serde_json::json!({ "error": "body too large", "max": super::MAX_BODY_BYTES }),
    )
}

/// 把一条**已经是 JSON 文本**的报文直接当响应体回。
/// `/mcp` 用：协议层交出来的本来就是字符串，不必再 parse 一遍、再序列化一遍。
fn raw_json_resp(status: StatusCode, body: String) -> Response<RespBody> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(
            Full::new(Bytes::from(body))
                .map_err(map_infallible as fn(Infallible) -> std::io::Error)
                .boxed_unsync(),
        )
        .unwrap_or_else(|_| Response::new(empty_body()))
}

/// 限流回包体。`/messages`（走 SSE）与 `POST /mcp`（直接回 JSON）共用一份文案 ——
/// 否则同一个"请放慢"在两个传输里迟早说得不一样。
///
/// 必须带上**这次请求的 id**：原实现写的是 `id: null`（注释却写着"让客户端能把它对应到某个请求"），
/// 而客户端发的 id 是 X —— 配不上号的那条 error 会被丢掉，**那次调用一路挂到超时**，
/// 客户端以为失败又重试，越限流越糟。这就是"反复调用失败"的一个真实成因。
fn rate_limited_body(req_id: serde_json::Value) -> String {
    serde_json::json!({
        "jsonrpc": "2.0", "id": req_id,
        "error": {
            "code": super::protocol::E_RATE_LIMITED,
            // 说清"这次没执行"+怎么放慢，别让 Agent 以为是工具坏了而重试
            "message": format!(
                "超过 {}/分 的请求上限，本次调用被拒（没有执行）。请放慢：日志用 log_tail 的 sinceSeq 增量拉取、减少轮询频率，几秒后重试即可。",
                super::RATE_LIMIT_PER_MIN
            )
        }
    })
    .to_string()
}

// ===== Streamable HTTP（2025-03-26+ 规范）：单端点 /mcp =====

/// `resolve_http_session` 的结论。
enum HttpSession {
    /// 可用（`bool` = 这次是不是**新建**的，决定要不要下发 `Mcp-Session-Id`）
    Ready(String, bool),
    /// 超限：仍然要回包（带上 id），只是这次不执行
    RateLimited(String, bool),
    /// 客户端带了一个我们不认识的会话 id → 404，让它重新 initialize
    Unknown,
    /// 表满了且腾不出位置（剩下的全是 SSE 会话）
    NoCapacity,
}

/// 取会话：带 `Mcp-Session-Id` 就查表，没带就按"新客户端"建一个。
///
/// **两类会话共用一张表**（`MAX_SESSIONS` / 空闲回收 / 限流只有一套口径），
/// 区别只在 `tx`：SSE 会话有一条出站长连接，HTTP 会话平时没有。
fn resolve_http_session(core: &Arc<McpCore>, headers: &HeaderMap) -> HttpSession {
    let now = Instant::now();
    let mut evicted: Option<String> = None;
    // 会话数**只要变了就得推一次状态**：新建、淘汰、空闲回收这三件事都会改数字。
    // 2026-09 用户报的"MCP 服务区的会话监控没有实时刷新"就是这里 —— SSE 那条路建会话时推了
    // （`open_sse` → `emit_status`），HTTP 这条路**除淘汰外一处都没推**，于是走 `/mcp` 的
    // 新版客户端（VS Code / Cline / Claude Code 默认）连上了，界面上的「N 个会话」
    // 也永远停在打开弹窗那一刻的值。
    let mut count_changed = false;
    // 顺手回收空闲会话（HTTP 会话**没有**"连接断开"这个信号可依赖，客户端进程没了也不会
    // 通知我们）。放在锁外：`sweep_idle` 清掉了会话就会自己推一次状态 —— 这一步也顺手修掉了
    // 以前"带过期 sid 的请求会 early-return，于是回收了却不推"的那条路。
    let _ = sweep_idle(core);
    let out = {
        let mut map = core.sessions.map.lock().unwrap_or_else(|e| e.into_inner());

        if let Some(sid) = header_str(headers, MCP_SESSION_HEADER) {
            match map.get_mut(&sid) {
                // 规范：不认识的会话 id → 404，客户端据此**重新 initialize**
                None => HttpSession::Unknown,
                Some(s) => {
                    s.last_seen = now;
                    if s.rate_ok(now) {
                        HttpSession::Ready(sid, false)
                    } else {
                        HttpSession::RateLimited(sid, false)
                    }
                }
            }
        } else {
            // 没有会话头 = 新客户端（正常情况下就是 initialize 那一发）。
            // 表满时**只淘汰 HTTP 会话**（最久未活动的那个），三条理由：
            //   ① 不能淘汰 SSE 会话 —— 它的长连接已经建立，把表项删掉只会让那条流变成
            //      一条再也收不到东西的僵尸连接；
            //   ② 更不能直接回 429 —— 客户端拿到 429 无从下手，只能干等空闲回收（30 分钟），
            //      这个坑本项目已经踩过一次（会话泄漏 → 429 → 半小时不能连）；
            //   ③ HTTP 会话被淘汰是**干净可恢复**的：下次请求得 404 → 重新 initialize。
            //
            // ⚠️ 判据是 `kind`，**不是 `tx`**：`tx` 只表示"有没有推送通道"，而 HTTP 会话按规范
            // 挂上 `GET /mcp` 流之后也有 `tx` —— 用 `tx` 判断会让这一类客户端**全部变得不可淘汰**，
            // 4 个占满后第 5 个直接吃 429（2026-09 实测证实；回归测试
            // `http_sessions_with_a_get_stream_are_still_evictable` 守着）。
            if map.len() >= super::MAX_SESSIONS {
                match evict_idle_http(&mut map) {
                    Some(v) => {
                        evicted = Some(v);
                        // 计数变化统一由下面"新建"那一步收口（淘汰后一定会插入新会话），
                        // 这里不再重复置位 —— 否则编译器会报"赋值后没读过"。
                    }
                    None => return HttpSession::NoCapacity,
                }
            }
            let id = uuid::Uuid::new_v4().simple().to_string();
            map.insert(
                id.clone(),
                Session {
                    kind: SessionKind::Http,
                    tx: None,
                    created: now,
                    last_seen: now,
                    // 这次请求本身就占一次配额（与 /sse 建会话不同：那个不算一次调用）
                    count: 1,
                    window_start: now,
                },
            );
            count_changed = true;
            HttpSession::Ready(id, true)
        }
    };
    if let Some(v) = evicted {
        crate::dbg_log(&format!(
            "mcp: 会话数已达上限 {}，淘汰最久未活动的 HTTP 会话 {}",
            super::MAX_SESSIONS,
            &v[..8.min(v.len())]
        ));
        // 淘汰是我们的策略选择，但"会话被挤掉"对调用方是真实事件，值得留痕（5 分钟去重）
        super::report::report(
            "http_session_evicted",
            &format!(
                "HTTP 会话数达上限 {}，淘汰了最久未活动的一个（客户端会在下次请求得到 404 并重新 initialize）",
                super::MAX_SESSIONS
            ),
        );
    }
    // 锁**已经释放**才推：`emit_status()` 内部要读 `sessions.active_len()`，持锁调它会死锁
    // （同 `delete_mcp` 那条注释）。上面三种"会话数变了"的情况在这里统一收口，
    // 免得以后再加一条增删路径时又漏掉推送。
    if count_changed {
        core.emit_status();
    }
    out
}

/// `POST /mcp` —— Streamable HTTP 的请求入口。
///
/// 响应形态（规范允许服务器二选一，我们选**直接回 JSON**）：
/// - 有响应：`200` + `Content-Type: application/json` + 这一条的 JSON-RPC 报文；
/// - 只有通知（没有 `id`）：`202 Accepted` + 空体（规范要求，**不是** 200 加空 JSON）；
/// - 新建会话：响应头带 `Mcp-Session-Id`，客户端后续请求必须带回来；
/// - 会话不认识（过期 / 被淘汰 / 伪造）：`404`，客户端据此重新 `initialize`。
///
/// 为什么不返回 SSE 流：我们的工具全是"一问一答"（没有进度通知、没有中途消息），
/// 一条响应就是全部内容。走 SSE 只会多一层分帧、多一处能出错的地方。
async fn post_mcp(req: Request<Incoming>, core: &Arc<McpCore>, query: &str) -> Response<RespBody> {
    let headers = req.headers().clone();
    if !origin_allowed(&headers) {
        return forbidden(core, "/mcp");
    }
    if let Some(v) = protocol_version_problem(&headers) {
        return bad_protocol_version(core, "/mcp", &v);
    }
    let given = token_from(query, &headers).unwrap_or_default();
    if !constant_time_eq(&given, &core.token()) {
        return unauthorized(core, "/mcp");
    }
    let body = match read_body_limited(req).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let req_id = serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("id").cloned())
        .filter(|v| !v.is_null())
        .unwrap_or(serde_json::Value::Null);

    let (sid, is_new) = match resolve_http_session(core, &headers) {
        HttpSession::Ready(sid, is_new) => (sid, is_new),
        HttpSession::RateLimited(sid, is_new) => {
            // 被限流说明有个客户端在猛刷：进错误库（去重后最多 5 分钟一条）
            super::report::report(
                "rate_limited",
                &format!("某会话超过 {}/分 的请求上限，已按限流处理", super::RATE_LIMIT_PER_MIN),
            );
            let mut resp = raw_json_resp(StatusCode::OK, rate_limited_body(req_id));
            // 顺带给标准信号：会看 Retry-After 的客户端能自己放慢
            if let Ok(v) = hyper::header::HeaderValue::from_str("60") {
                resp.headers_mut().insert(hyper::header::RETRY_AFTER, v);
            }
            return with_session_header(resp, &sid, is_new);
        }
        HttpSession::Unknown => return session_not_found(core, "/mcp"),
        HttpSession::NoCapacity => return too_many_sessions(),
    };

    let text = String::from_utf8_lossy(&body).to_string();
    // 分发（协议层完全不知道 Socket 的存在；带上 sid 以便调用记录能标清是哪个会话）。
    // 走 handle_raw_guarded：内部 panic 会变成一条 JSON-RPC 错误 + 一次错误上报，
    // 而不是把这条连接的任务打死、让客户端干等到超时。
    let resp = match super::protocol::handle_raw_guarded(core, &text, &sid).await {
        // 通知（没有 id）：规范要求 202 + 空体
        None => Response::builder()
            .status(StatusCode::ACCEPTED)
            .body(empty_body())
            .unwrap_or_else(|_| Response::new(empty_body())),
        Some(json) => raw_json_resp(StatusCode::OK, json),
    };
    with_session_header(resp, &sid, is_new)
}

/// `GET /mcp` —— 挂一条 SSE 流，收服务端主动推的通知（`notifications/tools/list_changed`）。
///
/// 规范允许服务器**拒绝**它（405），但既然已经有现成的 SSE 出站通道，挂上去的成本很低：
/// 客户端不必重连就能知道工具列表变了（开了 `expose.autoControlTools` 时控件增减就会触发）。
///
/// 规矩：
/// - 必须带 `Mcp-Session-Id`（没有会话的 GET 无从挂起）；
/// - 一个会话最多一条流（再开一条 → 409：否则同一份通知会送两遍）；
/// - **流断开只摘通道、不删会话**（见 `SseBody::keep_session`），会话还要继续给 POST 用。
fn get_mcp(core: &Arc<McpCore>, query: &str, headers: &HeaderMap) -> Response<RespBody> {
    if !origin_allowed(headers) {
        return forbidden(core, "/mcp");
    }
    if let Some(v) = protocol_version_problem(headers) {
        return bad_protocol_version(core, "/mcp", &v);
    }
    let given = token_from(query, headers).unwrap_or_default();
    if !constant_time_eq(&given, &core.token()) {
        return unauthorized(core, "/mcp");
    }
    let Some(sid) = header_str(headers, MCP_SESSION_HEADER) else {
        return json_resp(
            StatusCode::BAD_REQUEST,
            serde_json::json!({
                "error": "missing Mcp-Session-Id",
                "hint": "GET /mcp 是给已初始化的会话收通知用的：先 POST initialize 拿到会话 id",
            }),
        );
    };
    let now = Instant::now();
    {
        let mut map = core.sessions.map.lock().unwrap_or_else(|e| e.into_inner());
        match map.get_mut(&sid) {
            None => return session_not_found(core, "/mcp"),
            Some(s) => {
                if s.tx.is_some() {
                    return json_resp(
                        StatusCode::CONFLICT,
                        serde_json::json!({ "error": "session already has a stream" }),
                    );
                }
                s.last_seen = now;
            }
        }
    }
    // 这条流**不占限流配额**：它是一次长连接，不是一次调用
    attach_outbound(core, &sid, None, true)
}

/// `DELETE /mcp` —— 客户端主动终止会话。
///
/// 规范里的可选动词，但值得实现：**"客户端关了却没回收会话"正是本项目踩过的那个坑**
/// （`MAX_SESSIONS = 4`，占满后所有连接吃 429，还要等 30 分钟空闲回收）。
fn delete_mcp(core: &Arc<McpCore>, query: &str, headers: &HeaderMap) -> Response<RespBody> {
    if !origin_allowed(headers) {
        return forbidden(core, "/mcp");
    }
    if let Some(v) = protocol_version_problem(headers) {
        return bad_protocol_version(core, "/mcp", &v);
    }
    let given = token_from(query, headers).unwrap_or_default();
    if !constant_time_eq(&given, &core.token()) {
        return unauthorized(core, "/mcp");
    }
    let Some(sid) = header_str(headers, MCP_SESSION_HEADER) else {
        return json_resp(
            StatusCode::BAD_REQUEST,
            serde_json::json!({ "error": "missing Mcp-Session-Id" }),
        );
    };
    // 锁必须在**这一句结束时**释放：`emit_status()` 内部要读 `sessions.active_len()`，持锁调它会死锁
    let removed = {
        let mut map = core.sessions.map.lock().unwrap_or_else(|e| e.into_inner());
        // **只允许删 HTTP 会话**：SSE 会话不是 HTTP 客户端该管的东西（它的 sid 只下发给建立它的
        // 那个 SSE 客户端，正常永远走不到这里）。删不掉时回 **404 而不是 403** ——
        // 403 等于告诉对方"这个 sid 确实存在，只是不归你"，那是一个免费的探测信号。
        let is_http = map
            .get(&sid)
            .map(|s| s.kind == SessionKind::Http)
            .unwrap_or(false);
        if is_http {
            map.remove(&sid).is_some()
        } else {
            false
        }
    };
    if !removed {
        return session_not_found(core, "/mcp");
    }
    crate::dbg_log(&format!(
        "mcp: 会话 {} 被客户端主动终止（DELETE /mcp）",
        &sid[..8.min(sid.len())]
    ));
    core.emit_status();
    Response::builder()
        .status(StatusCode::NO_CONTENT)
        .body(empty_body())
        .unwrap_or_else(|_| Response::new(empty_body()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_extracted_from_query_and_header() {
        let empty = HeaderMap::new();
        assert_eq!(
            token_from("sessionId=abc&token=deadbeef", &empty),
            Some("deadbeef".to_string())
        );
        assert_eq!(token_from("sessionId=abc", &empty), None);

        let mut h = HeaderMap::new();
        h.insert("authorization", "Bearer tok123".parse().unwrap());
        assert_eq!(token_from("", &h), Some("tok123".to_string()));
        // 查询串优先
        assert_eq!(token_from("token=q1", &h), Some("q1".to_string()));
    }

    #[test]
    fn query_param_does_not_confuse_prefixes() {
        // sessionId 与 token 都以 t/s 开头，容易写出错误的前缀匹配
        assert_eq!(query_param("token=abc", "sessionId"), None);
        assert_eq!(query_param("sessionId=abc", "token"), None);
        assert_eq!(query_param("a=1&sessionId=x&b=2", "sessionId"), Some("x".to_string()));
    }

    #[test]
    fn constant_time_eq_is_correct() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "ab"));
        assert!(constant_time_eq("", ""));
    }

    #[test]
    fn session_rate_limit_window_resets() {
        let now = Instant::now();
        let mut s = Session {
            kind: SessionKind::Http,
            tx: None,
            created: now,
            last_seen: now,
            count: 0,
            window_start: now,
        };
        for _ in 0..super::super::RATE_LIMIT_PER_MIN {
            assert!(s.rate_ok(now), "限流窗口内前 N 次应放行");
        }
        assert!(!s.rate_ok(now), "超过限流应被拒");
        // 窗口过期后恢复
        let later = now + Duration::from_secs(61);
        assert!(s.rate_ok(later), "新窗口应重新放行");
    }

    // ===== Streamable HTTP 的纯逻辑（端到端在 mod.rs 的测试里，那里有真实的回环端口）=====

    #[test]
    fn session_header_is_read_and_trimmed() {
        let mut h = HeaderMap::new();
        assert_eq!(header_str(&h, MCP_SESSION_HEADER), None, "没有就是没有");
        // 空串等于没有：有些客户端会写一个空头，不能因此当成"带了一个空会话 id"
        h.insert(MCP_SESSION_HEADER, "".parse().unwrap());
        assert_eq!(header_str(&h, MCP_SESSION_HEADER), None);
        h.insert(MCP_SESSION_HEADER, "  abc123  ".parse().unwrap());
        assert_eq!(header_str(&h, MCP_SESSION_HEADER), Some("abc123".to_string()));
    }

    /// 防 DNS rebinding：只放行回环来源；不带 Origin（SDK/curl/桌面客户端）一律放行
    #[test]
    fn origin_is_only_allowed_from_loopback() {
        let none = HeaderMap::new();
        assert!(origin_allowed(&none), "没有 Origin 头 = 非浏览器客户端，放行");

        let ok = |o: &str| {
            let mut h = HeaderMap::new();
            h.insert("origin", o.parse().unwrap());
            origin_allowed(&h)
        };
        assert!(ok("http://127.0.0.1:5173"));
        assert!(ok("http://localhost"));
        assert!(ok("http://[::1]:7777"));

        // 关键反例：前缀相同但主机不同 —— 用 starts_with("http://127.0.0.1") 的实现会在这里放行
        assert!(!ok("http://127.0.0.1.evil.com"), "前缀伪装必须被拒");
        assert!(!ok("http://evil.com"));
        assert!(!ok("https://127.0.0.1"), "https 来源不可能是我们的客户端");
        assert!(!ok("null"), "file:// 页面会发 Origin: null");
        assert!(!ok("http://localhost.evil.com"));
    }

    #[test]
    fn protocol_version_header_accepts_known_versions_only() {
        let h = HeaderMap::new();
        assert_eq!(protocol_version_problem(&h), None, "缺失 = 老实现，放行");

        for v in [
            super::super::protocol::PROTOCOL_VERSION,
            STREAMABLE_ORIGIN_VERSION,
            super::super::protocol::PROTOCOL_FALLBACK,
        ] {
            let mut h = HeaderMap::new();
            h.insert(MCP_VERSION_HEADER, v.parse().unwrap());
            assert_eq!(protocol_version_problem(&h), None, "{} 应当被接受", v);
        }

        let mut h = HeaderMap::new();
        h.insert(MCP_VERSION_HEADER, "1999-01-01".parse().unwrap());
        assert_eq!(
            protocol_version_problem(&h),
            Some("1999-01-01".to_string()),
            "不认识的版本要回 400"
        );
    }

    /// 限流回包必须带上这次请求的 id：id 配不上号的那条 error 会被客户端丢弃，
    /// 那次调用一路挂到超时（这是真实踩过的坑，两个传输都要守）
    #[test]
    fn rate_limited_body_keeps_the_request_id() {
        let body = rate_limited_body(serde_json::json!(42));
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["id"], 42);
        assert_eq!(
            v["error"]["code"],
            super::super::protocol::E_RATE_LIMITED
        );
        assert!(v["error"]["message"].as_str().unwrap().contains("放慢"));
    }

    /// 在 `deliver` / `broadcast` 里被删掉的会话**也要推状态**。
    ///
    /// 会话表的删除路径里，`open_sse` / `SseBody::drop` / `resolve_http_session` 都推了状态，
    /// 只有 `deliver`（队列满 / 对端已断开）与 `broadcast`（死会话）删了不吭声 —— 界面于是
    /// 继续显示一条已经不存在的会话，直到下一次别的会话事件（2026-11 评审 M3）。
    #[test]
    fn session_removal_in_deliver_and_broadcast_pushes_status() {
        let core = std::sync::Arc::new(McpCore::new());
        let now = Instant::now();
        // 建一个"对端已经断了"的会话：sender 还在表里，receiver 已被丢掉
        let mk_dead = || {
            let (tx, rx) = mpsc::channel::<String>(4);
            drop(rx);
            Session {
                kind: SessionKind::Sse,
                tx: Some(tx),
                created: now,
                last_seen: now,
                count: 0,
                window_start: now,
            }
        };

        // ① deliver：投递失败 → 断开该会话 → 必须推状态
        core.sessions
            .map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert("dead0001".to_string(), mk_dead());
        let before = core.status_emits.load(Ordering::Relaxed);
        deliver(&core, "dead0001", "too late".to_string());
        assert!(
            !core
                .sessions
                .map
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains_key("dead0001"),
            "投递不进去的会话应被断开"
        );
        assert!(
            core.status_emits.load(Ordering::Relaxed) > before,
            "`deliver` 删了会话就必须推一次状态（否则界面一直显示这条死会话）"
        );

        // ② broadcast：顺手清掉的死会话同样要推
        core.sessions
            .map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert("dead0002".to_string(), mk_dead());
        let before2 = core.status_emits.load(Ordering::Relaxed);
        let sent = broadcast(&core, serde_json::json!({ "jsonrpc": "2.0", "method": "x" }));
        assert_eq!(sent, 0, "死会话收不到广播");
        assert!(
            !core
                .sessions
                .map
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains_key("dead0002"),
            "死会话应被广播清理掉"
        );
        assert!(
            core.status_emits.load(Ordering::Relaxed) > before2,
            "`broadcast` 删了会话也必须推一次状态"
        );
    }
}
