//! MCP 传输层：hyper 服务器 + `/healthz` + `/sse` + `/messages`。
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

/// 一个已建立的 SSE 会话
pub struct Session {
    pub tx: mpsc::Sender<String>,
    pub created: Instant,
    pub last_seen: Instant,
    /// 本分钟窗口内的请求数（限流）
    pub count: u32,
    pub window_start: Instant,
}

impl Session {
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
    pub fn len(&self) -> usize {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    pub fn clear(&self) {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
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
    let resp = match (method, path.as_str()) {
        // 探活：无需 token，且**不返回任何信息**（否则等于给本机任意进程一个免费的信息泄露点）
        (Method::GET, "/healthz") => json_resp(StatusCode::OK, serde_json::json!({ "ok": true })),
        // 详情：需要 token；**token 与 URL 都打码**（调用方本来就知道 token，但没必要回显）
        (Method::GET, "/status") => {
            let given = token_from(&query, &headers).unwrap_or_default();
            if !constant_time_eq(&given, &core.token()) {
                unauthorized()
            } else {
                json_resp(StatusCode::OK, core.status_json_public())
            }
        }
        (Method::GET, "/sse") => open_sse(&core, &query, port),
        (Method::POST, "/messages") => post_message(req, &core, &query).await,
        _ => json_resp(
            StatusCode::NOT_FOUND,
            serde_json::json!({ "error": "not found" }),
        ),
    };
    Ok(resp)
}

/// 给所有会话推一条**通知**（没有 id 的 JSON-RPC 报文）。
/// 非阻塞：队列满/已断开的会话直接清掉并计数 —— 不能让广播卡住任何人。
pub fn broadcast(core: &Arc<McpCore>, payload: serde_json::Value) -> usize {
    let msg = format!("event: message\ndata: {}\n\n", payload);
    let mut map = core.sessions.map.lock().unwrap_or_else(|e| e.into_inner());
    let mut dead: Vec<String> = Vec::new();
    let mut sent = 0usize;
    for (sid, s) in map.iter_mut() {
        let mut tx = s.tx.clone();
        match tx.try_send(msg.clone()) {
            Ok(()) => sent += 1,
            Err(_) => dead.push(sid.clone()),
        }
    }
    for sid in dead {
        map.remove(&sid);
        core.dropped.fetch_add(1, Ordering::Relaxed);
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

fn unauthorized() -> Response<RespBody> {
    // 鉴权失败既要回 401，也要留下痕迹：客户端配置里的 token 过期/粘错是最常见的
    // "连不上"原因，光看界面是看不出来的。已按 kind+detail 去重（5 分钟一条），
    // 不会因为客户端每秒重试而刷爆错误库。
    super::report::report("unauthorized", "收到 token 不匹配的请求（客户端配置可能过期，需重新复制连接地址）");
    json_resp(
        StatusCode::UNAUTHORIZED,
        serde_json::json!({ "error": "unauthorized" }),
    )
}

fn open_sse(core: &Arc<McpCore>, query: &str, _port: u16) -> Response<RespBody> {
    let given = query_param(query, "token").unwrap_or_default();
    if !constant_time_eq(&given, &core.token()) {
        return unauthorized();
    }

    let mut map = core.sessions.map.lock().unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    // 回收空闲会话（防"客户端崩了没发 RST"长期占位）
    let idle = Duration::from_secs(super::IDLE_TIMEOUT_SECS);
    map.retain(|_, s| now.duration_since(s.last_seen) < idle);
    if map.len() >= super::MAX_SESSIONS {
        return json_resp(
            StatusCode::TOO_MANY_REQUESTS,
            serde_json::json!({ "error": "too many sessions", "max": super::MAX_SESSIONS }),
        );
    }

    let id = uuid::Uuid::new_v4().simple().to_string();
    let (mut tx, rx) = mpsc::channel::<String>(super::SESSION_QUEUE);
    let token = core.token();
    // 第一条必须是 endpoint 事件，告诉客户端往哪 POST
    let endpoint = format!(
        "event: endpoint\ndata: /messages?sessionId={}&token={}\n\n",
        id, token
    );
    if tx.try_send(endpoint).is_err() {
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

    // 心跳：注释帧，防中间层/NAT 断流，同时探测客户端是否还在
    let mut hb = tx.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(super::HEARTBEAT_SECS)).await;
            if hb.try_send(": ping\n\n".to_string()).is_err() {
                break; // 会话已结束或队列满/断开
            }
        }
    });

    map.insert(
        id.clone(),
        Session {
            tx,
            created: now,
            last_seen: now,
            count: 0,
            window_start: now,
        },
    );
    drop(map);
    crate::dbg_log(&format!("mcp: 会话 {} 已建立", &id[..8.min(id.len())]));
    // 会话数变了要**立刻告诉界面**，否则弹窗里的"会话"数字会一直停在打开弹窗那一刻的值
    core.emit_status();
    sse_response(core.clone(), id.clone(), rx)
}

/// SSE 响应体：**流被丢弃时立刻回收会话**。
///
/// 为什么需要它（2026-09 由官方 SDK 一致性检查发现）：会话表里只存了 `tx`，而 SSE 响应的
/// 接收端 `rx` 在客户端断开时会被 hyper 丢掉 —— 但**没有任何人**注意到这件事：
/// 心跳的 `try_send` 仍然成功（队列没满），`deliver` 也不会被调用，于是这个会话
/// 要一直挂到**空闲 30 分钟回收**为止。后果很严重：`MAX_SESSIONS = 4`，
/// 客户端重启/重连 4 次就会把坑占满，之后所有连接直接吃 429 "too many sessions"，
/// 而且要等半小时才能恢复。独立客户端跑一遍就撞上了（4 个坑全是它自己崩掉的连接）。
struct SseBody {
    inner: futures::stream::BoxStream<'static, Result<Frame<Bytes>, std::io::Error>>,
    core: Arc<McpCore>,
    sid: String,
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

fn sse_response(core: Arc<McpCore>, sid: String, rx: mpsc::Receiver<String>) -> Response<RespBody> {
    let stream = rx.map(|s| Ok::<_, std::io::Error>(Frame::data(Bytes::from(s))));
    let body = SseBody {
        inner: stream.boxed(),
        core,
        sid,
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
        return unauthorized();
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

    // 读取请求体（带上限）
    let body = match req.into_body().collect().await {
        Ok(c) => c.to_bytes(),
        Err(e) => {
            return json_resp(
                StatusCode::BAD_REQUEST,
                serde_json::json!({ "error": format!("读取请求体失败: {}", e) }),
            )
        }
    };
    if body.len() > super::MAX_BODY_BYTES {
        return json_resp(
            StatusCode::PAYLOAD_TOO_LARGE,
            serde_json::json!({ "error": "body too large", "max": super::MAX_BODY_BYTES }),
        );
    }

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
                    Some(
                        serde_json::json!({
                            "jsonrpc": "2.0", "id": serde_json::Value::Null,
                            "error": { "code": super::protocol::E_RATE_LIMITED,
                                       "message": format!("超过 {} 次/分 的限流", super::RATE_LIMIT_PER_MIN) }
                        })
                        .to_string(),
                    )
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
    let mut map = core.sessions.map.lock().unwrap_or_else(|e| e.into_inner());
    let mut drop_session = false;
    if let Some(s) = map.get_mut(sid) {
        let mut sender = s.tx.clone();
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
        map.remove(sid);
    }
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
            tx: mpsc::channel(1).0,
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
}
