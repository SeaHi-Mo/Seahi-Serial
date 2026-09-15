//! MCP 服务器**运行期错误**的统一上报（S11）。
//!
//! 为什么需要它：MCP 出问题以前只写 `dbg_log`（本地文件）和 LogHub（内存环形缓冲，
//! 关掉 MCP 就没了）。用户报障时我们既看不到、也不知道发生过多少次。现在把运行期错误
//! 接进程序**既有的**上报通道 `crate::report_error` —— 它会做四件事：
//! LogHub 的 `error` 通道 → 本地 `%TEMP%\seahi-serial-debug.log` → Sentry（若配置）→
//! 自建服务 `POST {ERROR_SERVER_URL}/report`（`server/error-server.js` 落 SQLite）。
//!
//! 三条纪律（在写入路径上被调用，必须守住）：
//!
//! 1. **不刷屏**：同一个 `kind` + 同一段 `detail` 在 `DEDUP_WINDOW_SECS` 内只上报一次。
//!    服务端也有按签名去重，但那是最后一道闸 —— 不能让一个每秒重试的客户端
//!    把网络和数据库打爆。被挡掉的次数会计数，`mcp_stats` 里看得到。
//! 2. **不泄密**：`detail` 里的 `token=...` 一律打码（端点 URL 里就带着 token，
//!    一个手滑就会把用户的令牌写进错误库）。
//! 3. **不阻塞、不 panic**：复用既有的 mpsc 上报线程；本模块只做一次加锁 + 一次入队。
//!    锁中毒时用 `into_inner()` 继续走，绝不在错误上报路径上再制造一个错误。
//!
//! 测试可注入 `sink`（见 `report_with`），以免单测真的往网络/文件里写东西。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 同一类错误的去重窗口（秒）
pub const DEDUP_WINDOW_SECS: u64 = 300;
/// 去重表最多记多少类（防止错误消息里带变量导致表无限增长）
pub const MAX_TRACKED: usize = 64;

static LAST_SEEN: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
static REPORTED: AtomicU64 = AtomicU64::new(0);
static DEDUPED: AtomicU64 = AtomicU64::new(0);
/// 打码时额外屏蔽的字面量（启动时把当前 token 塞进来，连"裸 token"也不漏）
static SECRET: OnceLock<Mutex<Vec<String>>> = OnceLock::new();

fn last_seen() -> &'static Mutex<HashMap<String, Instant>> {
    LAST_SEEN.get_or_init(|| Mutex::new(HashMap::new()))
}

fn secrets() -> &'static Mutex<Vec<String>> {
    SECRET.get_or_init(|| Mutex::new(Vec::new()))
}

/// 把一个字面量登记为敏感串（当前 token）：上报前会被替换成 `****`。
/// 只登记长度 ≥ 8 的串，太短的会把正常文本也打掉。
pub fn remember_secret(s: &str) {
    if s.len() < 8 {
        return;
    }
    let mut v = secrets().lock().unwrap_or_else(|e| e.into_inner());
    if !v.iter().any(|x| x == s) {
        v.push(s.to_string());
    }
}

/// 打码：`token=xxx`、`?token=xxx&`、以及登记过的敏感串
pub fn sanitize(detail: &str) -> String {
    let mut out = String::with_capacity(detail.len());
    let bytes = detail.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        // 命中 "token="，把后面的值吃掉换成 ****
        if detail[i..].starts_with("token=") {
            out.push_str("token=****");
            i += "token=".len();
            while i < bytes.len() {
                let c = bytes[i] as char;
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    i += 1;
                } else {
                    break;
                }
            }
            continue;
        }
        // 逐字节推进，靠 from_utf8 保住多字节字符不被切坏
        let mut end = i + 1;
        while end < bytes.len() && !detail.is_char_boundary(end) {
            end += 1;
        }
        out.push_str(&detail[i..end]);
        i = end;
    }
    // 登记过的敏感串（例如裸 token）也一并抹掉
    let list = secrets().lock().unwrap_or_else(|e| e.into_inner()).clone();
    for s in list {
        if out.contains(&s) {
            out = out.replace(&s, "****");
        }
    }
    out
}

/// 去重判定：返回 true 表示这次**该上报**。纯逻辑，便于单测。
fn should_report(key: &str, window: Duration, now: Instant) -> bool {
    let mut m = last_seen().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(prev) = m.get(key) {
        if now.duration_since(*prev) < window {
            return false;
        }
    }
    if m.len() >= MAX_TRACKED {
        // 表满：先清掉已过窗口的条目；**还满就只淘汰最旧的那一条**（LRU）。
        //
        // 原来是"还满就整表 clear()"（注释写着"宁可多报一次"）—— 代价是**所有其它 kind 的
        // 去重状态一起失效**：一次 64 种不同 key 的噪声就能把 `rate_limited`、`start_failed`
        // 这些重要错误的 5 分钟窗口全部归零，等于给"错误上报洪水"开了一道口子
        // （2026-09 审计发现；去重是网络与错误库的最后一道闸，见 AGENTS #8）。
        let w = window;
        m.retain(|_, t| now.duration_since(*t) < w);
        if m.len() >= MAX_TRACKED {
            if let Some(oldest) = m.iter().min_by_key(|(_, t)| **t).map(|(k, _)| k.clone()) {
                m.remove(&oldest);
            }
        }
    }
    m.insert(key.to_string(), now);
    true
}

/// 上报一条 MCP 运行期错误（自动去重 + 打码）。
///
/// `kind` 用稳定的短标识（如 `start_failed` / `accept_failed` / `tool_panic`），
/// `detail` 放具体信息。两者都会进错误库的 error/context 字段。
pub fn report(kind: &str, detail: &str) {
    report_with(kind, detail, &|k, d| {
        crate::report_error(&format!("mcp/{}: {}", k, d), "mcp");
    });
}

/// 可注入版本（单测用；生产走 `report`）
pub fn report_with(kind: &str, detail: &str, sink: &dyn Fn(&str, &str)) {
    let clean = sanitize(detail);
    let key = format!("{}|{}", kind, clean);
    if !should_report(&key, Duration::from_secs(DEDUP_WINDOW_SECS), Instant::now()) {
        DEDUPED.fetch_add(1, Ordering::Relaxed);
        return;
    }
    REPORTED.fetch_add(1, Ordering::Relaxed);
    sink(kind, &clean);
}

/// 上报统计：`(已上报条数, 被去重挡掉的次数)`
pub fn stats() -> (u64, u64) {
    (
        REPORTED.load(Ordering::Relaxed),
        DEDUPED.load(Ordering::Relaxed),
    )
}

/// 把可能 panic 的代码包起来，返回 `Err(消息)` 而不是让 panic 逃出去。
///
/// 为什么需要：`panic = "abort"` 绝不能加（会杀掉用户的串口会话），所以 panic 能 unwind；
/// 但**没有任何守卫的话**，一次工具 panic 会把这条 SSE 连接的任务直接打死 ——
/// 客户端拿不到任何响应（只能等超时），我们也完全不知道发生过。这里兜住它，
/// 转成一个 JSON-RPC 错误返回，并计入错误上报。
pub fn guard<R>(what: &str, f: impl FnOnce() -> R + std::panic::UnwindSafe) -> Result<R, String> {
    match std::panic::catch_unwind(f) {
        Ok(v) => Ok(v),
        Err(payload) => {
            let msg = panic_message(&payload);
            report("tool_panic", &format!("{} panic: {}", what, msg));
            Err(msg)
        }
    }
}

/// 从 panic payload 里取人话（`&str` / `String` / 其它）
pub fn panic_message(payload: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "非字符串 panic payload".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 这些用例共用**全局**去重表与计数器，而 cargo 默认并行跑测试 ——
    /// 不串行的话，"表满清空"那个用例会把别的用例刚插的记录冲掉，
    /// 于是 dedup 用例偶发失败（第一版就是这么红的）。锁住整段。
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn lock() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn hit(kind: &str, detail: &str, seen: &Mutex<Vec<String>>) {
        report_with(kind, detail, &|k, d| {
            seen.lock().unwrap().push(format!("{}|{}", k, d));
        });
    }

    #[test]
    fn same_error_is_reported_only_once_within_window() {
        let _g = lock();
        let seen = Mutex::new(Vec::new());
        let kind = "dedup_probe";
        for _ in 0..50 {
            hit(kind, "同一个错误", &seen);
        }
        let v = seen.lock().unwrap();
        assert_eq!(v.len(), 1, "窗口内同类同文只该上报一次: {:?}", *v);
        assert!(stats().1 > 0, "被挡掉的次数要计数");
    }

    #[test]
    fn different_detail_of_same_kind_is_reported() {
        let _g = lock();
        let seen = Mutex::new(Vec::new());
        hit("varied", "第一种", &seen);
        hit("varied", "第二种", &seen);
        assert_eq!(seen.lock().unwrap().len(), 2, "细节不同就该分开报");
    }

    #[test]
    fn token_is_masked() {
        let _g = lock();
        let s = sanitize("连 http://127.0.0.1:7777/sse?token=deadbeefdeadbeef0123 失败");
        assert!(s.contains("token=****"), "{}", s);
        assert!(!s.contains("deadbeef"), "token 值必须被抹掉: {}", s);
        assert!(s.contains("127.0.0.1:7777"), "其余信息要保留: {}", s);
    }

    #[test]
    fn registered_secret_is_masked_even_bare() {
        let _g = lock();
        remember_secret("abcdef0123456789");
        let s = sanitize("客户端发了 abcdef0123456789 这个令牌");
        assert!(!s.contains("abcdef0123456789"), "{}", s);
        assert!(s.contains("****"), "{}", s);
    }

    #[test]
    fn sanitize_keeps_multibyte_text_intact() {
        let _g = lock();
        let s = sanitize("会话 中文 emoji 🚀 出错");
        assert_eq!(s, "会话 中文 emoji 🚀 出错");
    }

    #[test]
    fn guard_turns_panic_into_err_and_reports_it() {
        let _g = lock();
        let before = stats().0;
        let r = guard("测试工具", || panic!("boom 内部炸了"));
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("boom"));
        assert!(stats().0 > before, "panic 必须计入上报");
        // 正常路径原样返回
        assert_eq!(guard("正常", || 42).unwrap(), 42);
    }

    #[test]
    fn dedup_table_does_not_grow_without_bound() {
        let _g = lock();
        let seen = Mutex::new(Vec::new());
        for i in 0..(MAX_TRACKED * 3) {
            hit("flood", &format!("第 {} 种", i), &seen);
        }
        let n = last_seen().lock().unwrap().len();
        assert!(n <= MAX_TRACKED, "去重表必须有界，实际 {}", n);
    }

    /// 表满时只淘汰**最旧的一条**（LRU），而不是整表清空。
    ///
    /// 为什么重要：去重是网络与错误库的最后一道闸（AGENTS #8），整表清空意味着"一次 64 种
    /// 不同 key 的噪声洪水"就能把 `rate_limited` / `start_failed` 这些重要错误的 5 分钟窗口
    /// 一起归零。2026-09 审计发现（原注释写的是"宁可多报一次"）。
    #[test]
    fn full_dedup_table_evicts_only_the_oldest() {
        let _g = lock();
        let seen = Mutex::new(Vec::new());
        const OLD: (&str, &str) = ("最旧的错误", "它会被挤掉");
        const RECENT: (&str, &str) = ("近期的错误", "它必须留下");

        hit(OLD.0, OLD.1, &seen);
        hit(RECENT.0, RECENT.1, &seen);
        // 刚好填满，再多插一条就触发一次淘汰
        for i in 0..(MAX_TRACKED - 2) {
            hit("噪声", &format!("第 {} 种", i), &seen);
        }
        hit("噪声", "再挤一条", &seen);

        // ① 最近报过的那条仍在表里 → 必须继续被挡住（整表清空会把它一起冲掉，于是这里会放行）
        let before = seen.lock().unwrap().len();
        hit(RECENT.0, RECENT.1, &seen);
        assert_eq!(
            seen.lock().unwrap().len(),
            before,
            "最近报过的 kind 必须继续去重（整表清空会把它冲掉）"
        );

        // ② 最旧的那条已被淘汰 → 允许再报一次（LRU 的预期代价）
        hit(OLD.0, OLD.1, &seen);
        let times = seen
            .lock()
            .unwrap()
            .iter()
            .filter(|s| s.as_str() == format!("{}|{}", OLD.0, OLD.1))
            .count();
        assert_eq!(times, 2, "被淘汰的条目应能重新上报一次");

        // ③ 表仍然有界
        assert!(last_seen().lock().unwrap().len() <= MAX_TRACKED);
    }
}
