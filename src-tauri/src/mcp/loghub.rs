//! MCP 日志中心（S7）：把散落各处的日志收成**有上限、可检索、可按 seq 增量拉取**的通道。
//!
//! 设计约束（`doc/MCP_DESIGN.md` §4.7 / §7）：
//!
//! 1. **生产者绝不阻塞、绝不等待**：写日志的可能是串口读线程（延迟敏感，可见时 25ms 轮询），
//!    所以 `push` 用 `try_lock`，拿不到锁就丢一条并计数，**绝不让日志拖慢产品本身**。
//! 2. **每通道独立锁**：串口 92KB/s 与 ADB 数十 MB/s 不能互相争锁；外层那把锁只用于取通道句柄。
//! 3. **一切都有上限**：单条日志截断 + 每通道字节上限（超了从最旧开始丢，丢多少记账）。
//! 4. **HEX 不在存储期生成**：只记原始字节数，避免再来一份 3 倍体积的表示。
//! 5. **关闭即零成本**：MCP 停用时 `push` 直接返回（一个原子读），不建通道、不占内存。
//!
//! 通道命名：`app` / `error` / `mcp` / `serial:<mid>:rx|tx` / `ble:rx` / `wsl:<mid>:rx` / `adb` / `ui:sys|ui:err`

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{json, Value};

/// 单条日志的最大存储长度（防止一行把整个通道吃掉）
pub const MAX_LINE_BYTES: usize = 8 * 1024;
/// 每行的固定开销估算（Box<str> + 结构体 + VecDeque 槽位）。
/// 这是**估算**：目的是让"字节上限"反映真实内存量级，而不是只算 payload。
pub const OVERHEAD_PER_LINE: usize = 64;
/// **所有通道的字节之和**上限（真·兜底，写满就尽力回收）。
///
/// 为什么必须有它：通道名是**动态的**（`serial:<面板>:<方向>`、`ui:<面板>`），
/// 开 N 个监视器就有 2N 个通道，每通道各自有上限 —— 只按通道限流的话，
/// "总内存"其实没有上界。这个常量以前只被**报告**、没有被**执行**，
/// 于是 `log_stats` 里的 `totalCapBytes` 是一句空头承诺。
pub const TOTAL_CAP_BYTES: usize = 16 * 1024 * 1024;
/// 通道数上限：到顶后**新通道不再创建**（丢弃并计数），避免通道表本身无限增长。
pub const MAX_CHANNELS: usize = 64;
/// 一次全局回收最多动几个通道。回收必须是**有界代价**的：不能因为"超预算了"
/// 就在写入路径上遍历/锁住全部通道，那等于把串口读线程拖垮。
const MAX_RECLAIM_PER_CALL: usize = 4;

/// 日志级别
pub const LEVEL_DEBUG: u8 = 0;
pub const LEVEL_INFO: u8 = 1;
pub const LEVEL_WARN: u8 = 2;
pub const LEVEL_ERROR: u8 = 3;

/// 方向
pub const DIR_NONE: u8 = 0;
pub const DIR_RX: u8 = 1;
pub const DIR_TX: u8 = 2;

/// 按通道名前缀取字节上限（§4.8 的预算表）
pub fn cap_for(name: &str) -> usize {
    if name.starts_with("serial:") {
        512 * 1024
    } else if name.starts_with("wsl:") {
        256 * 1024
    } else if name == "adb" || name.starts_with("adb:") {
        1024 * 1024
    } else if name.starts_with("ble") {
        256 * 1024
    } else if name == "app" || name == "error" || name == "mcp" {
        128 * 1024
    } else {
        // ui / workflow / 其它
        64 * 1024
    }
}

fn level_name(l: u8) -> &'static str {
    match l {
        LEVEL_DEBUG => "debug",
        LEVEL_INFO => "info",
        LEVEL_WARN => "warn",
        LEVEL_ERROR => "error",
        _ => "info",
    }
}

fn dir_name(d: u8) -> &'static str {
    match d {
        DIR_RX => "rx",
        DIR_TX => "tx",
        _ => "none",
    }
}

/// 一条日志。
/// 刻意用 `i64` 毫秒而不是 RFC3339 字符串（每条省 ~35 字节 + 一次分配），
/// 只在读取时才格式化成字符串。
#[derive(Debug, Clone)]
pub struct LogLine {
    pub seq: u64,
    pub ts_ms: i64,
    pub level: u8,
    pub dir: u8,
    text: Box<str>,
    /// 原始字节数（HEX 场景下 payload 文本比原始长约 3 倍，所以单独记）
    pub raw_bytes: u32,
}

impl LogLine {
    pub fn text(&self) -> &str {
        &self.text
    }

    /// 单条占用的估算字节数
    fn cost(&self) -> usize {
        self.text.len() + OVERHEAD_PER_LINE
    }

    fn to_json(&self) -> Value {
        json!({
            "seq": self.seq,
            "ts": crate::mcp::loghub::fmt_ts(self.ts_ms),
            "t": self.ts_ms,
            "level": level_name(self.level),
            "dir": dir_name(self.dir),
            "bytes": self.raw_bytes,
            "text": &*self.text,
        })
    }
}

/// 一个通道
pub struct Channel {
    pub lines: VecDeque<LogLine>,
    pub bytes: usize,
    pub cap: usize,
    pub next_seq: u64,
    pub dropped: u64,
}

impl Channel {
    fn new(name: &str) -> Self {
        Self {
            lines: VecDeque::new(),
            bytes: 0,
            cap: cap_for(name),
            next_seq: 1,
            dropped: 0,
        }
    }

    fn last_ts(&self) -> Option<i64> {
        self.lines.back().map(|l| l.ts_ms)
    }

    fn first_ts(&self) -> Option<i64> {
        self.lines.front().map(|l| l.ts_ms)
    }
}

/// 日志中心
pub struct LogHub {
    /// 外层锁只用来取/建通道句柄，**不**在持锁期间做任何重活
    channels: Mutex<HashMap<String, Arc<Mutex<Channel>>>>,
    total_bytes: AtomicUsize,
    /// 因锁竞争被跳过的写入次数（可见的生产压力指标）
    lock_skips: AtomicU64,
    /// 因**通道数到顶**被丢弃的写入次数（另一个必须可见的丢数原因）
    channel_skips: AtomicU64,
    /// 全局回收触发次数与回收掉的字节数（内存兜底是否真的在工作，要能看见）
    reclaims: AtomicU64,
    reclaimed_bytes: AtomicU64,
    enabled: AtomicBool,
}

impl Default for LogHub {
    fn default() -> Self {
        Self {
            channels: Mutex::new(HashMap::new()),
            total_bytes: AtomicUsize::new(0),
            lock_skips: AtomicU64::new(0),
            channel_skips: AtomicU64::new(0),
            reclaims: AtomicU64::new(0),
            reclaimed_bytes: AtomicU64::new(0),
            // 默认关闭：MCP 停用时不占任何内存（start() 时才打开）
            enabled: AtomicBool::new(false),
        }
    }
}

/// 全局单例：`dbg_log` 这样的自由函数也要能写进来，所以不能挂在 McpCore 上。
static HUB: OnceLock<LogHub> = OnceLock::new();

pub fn hub() -> &'static LogHub {
    HUB.get_or_init(LogHub::default)
}

/// 毫秒时间戳 → `HH:MM:SS.mmm`（本地时区）
pub fn fmt_ts(ms: i64) -> String {
    use chrono::{Local, TimeZone};
    match Local.timestamp_millis_opt(ms).single() {
        Some(t) => t.format("%H:%M:%S%.3f").to_string(),
        None => String::new(),
    }
}

impl LogHub {
    pub fn set_enabled(&self, on: bool) {
        self.enabled.store(on, Ordering::Relaxed);
        if !on {
            // 停用 = 真正释放内存（不只是清空内容）
            self.drop_all();
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    pub fn lock_skips(&self) -> u64 {
        self.lock_skips.load(Ordering::Relaxed)
    }

    /// 因通道数到顶而被丢弃的写入次数
    pub fn channel_skips(&self) -> u64 {
        self.channel_skips.load(Ordering::Relaxed)
    }

    /// 全局回收统计：`(触发次数, 回收字节数)`
    pub fn reclaim_stats(&self) -> (u64, u64) {
        (
            self.reclaims.load(Ordering::Relaxed),
            self.reclaimed_bytes.load(Ordering::Relaxed),
        )
    }

    pub fn total_bytes(&self) -> usize {
        self.total_bytes.load(Ordering::Relaxed)
    }

    pub fn channel_count(&self) -> usize {
        self.channels.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    fn handle(&self, name: &str) -> Arc<Mutex<Channel>> {
        let mut map = self.channels.lock().unwrap_or_else(|e| e.into_inner());
        map.entry(name.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(Channel::new(name))))
            .clone()
    }

    /// 取通道句柄，但**尊重通道数上限**：已有通道照常返回，新通道到顶就不再建。
    /// 返回 `None` 表示"这次写入因通道数上限被丢弃"。
    fn handle_capped(&self, name: &str) -> Option<Arc<Mutex<Channel>>> {
        let mut map = self.channels.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(c) = map.get(name) {
            return Some(c.clone());
        }
        if map.len() >= MAX_CHANNELS {
            return None;
        }
        Some(
            map.entry(name.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(Channel::new(name))))
                .clone(),
        )
    }

    /// 全局预算兜底：**尽力**回收，绝不阻塞、绝不遍历全部通道。
    ///
    /// 代价有界：先按"当前字节数"挑出最大的几个通道（需要短暂锁一下通道，用 `try_lock`，
    /// 拿不到就跳过），最多动 `MAX_RECLAIM_PER_CALL` 个，每个都裁到自身上限的一半。
    /// 本轮没收够也没关系 —— 下一条日志会再触发一次，慢慢收敛，而不是在这里死等。
    fn reclaim(&self, skip: &str) {
        // 1) 快照通道句柄（只锁通道表，不碰日志内容）
        let cands: Vec<(String, Arc<Mutex<Channel>>)> = {
            let map = self.channels.lock().unwrap_or_else(|e| e.into_inner());
            map.iter()
                .filter(|(n, _)| n.as_str() != skip)
                .map(|(n, c)| (n.clone(), c.clone()))
                .collect()
        };
        // 2) 按字节数从大到小（try_lock 失败的按 0 处理：这次不动它）
        let mut sized: Vec<(usize, Arc<Mutex<Channel>>)> = cands
            .into_iter()
            .filter_map(|(_, c)| match c.try_lock() {
                Ok(g) => Some((g.bytes, c.clone())),
                Err(_) => None,
            })
            .collect();
        sized.sort_by(|a, b| b.0.cmp(&a.0));

        let mut freed = 0usize;
        for (bytes, c) in sized.into_iter().take(MAX_RECLAIM_PER_CALL) {
            if bytes == 0 {
                break;
            }
            // 目标：砍到自身上限的一半（与单通道的滞回策略一致，不做反复微裁）
            let target = {
                let g = match c.try_lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };
                (g.cap / 2).min(bytes / 2)
            };
            let mut g = match c.try_lock() {
                Ok(g) => g,
                Err(_) => continue,
            };
            while g.bytes > target {
                match g.lines.pop_front() {
                    Some(old) => {
                        let cost = old.cost();
                        g.bytes = g.bytes.saturating_sub(cost);
                        g.dropped += 1;
                        freed += cost;
                    }
                    None => break,
                }
            }
        }
        if freed > 0 {
            self.total_bytes.fetch_sub(freed.min(self.total_bytes()), Ordering::Relaxed);
            self.reclaimed_bytes
                .fetch_add(freed as u64, Ordering::Relaxed);
        }
        self.reclaims.fetch_add(1, Ordering::Relaxed);
    }

    /// 单测专用：写入一条**指定时间戳**的日志。
    ///
    /// 生产路径只用 [`Self::push`]（时间戳取 `now()`）。但"按时间归并 rx/tx"这类逻辑
    /// 在同一毫秒内写入时无法构造确定的顺序，所以给测试留一个能钉住 ts 的接缝。
    #[cfg(test)]
    pub fn push_at(&self, name: &str, level: u8, dir: u8, ts_ms: i64, text: &str, raw_bytes: u32) {
        self.push(name, level, dir, text, raw_bytes);
        let ch = self.handle(name);
        {
            // 注意作用域：guard 必须在 ch 之前析构，否则借用活得比 ch 长（E0597）
            let mut c = ch.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(last) = c.lines.back_mut() {
                last.ts_ms = ts_ms;
            }
        }
    }

    /// 写一条日志。**绝不阻塞**：拿不到通道锁就丢一条并计数。
    pub fn push(&self, name: &str, level: u8, dir: u8, text: &str, raw_bytes: u32) {
        // 关闭状态：一次原子读就返回（MCP 停用时零成本）
        if !self.enabled.load(Ordering::Relaxed) {
            return;
        }
        let ch = match self.handle_capped(name) {
            Some(c) => c,
            None => {
                // 通道数到顶：丢弃并计数（宁可丢日志，也不能让通道表无限长）
                self.channel_skips.fetch_add(1, Ordering::Relaxed);
                return;
            }
        };
        let mut c = match ch.try_lock() {
            Ok(g) => g,
            Err(std::sync::TryLockError::WouldBlock) => {
                self.lock_skips.fetch_add(1, Ordering::Relaxed);
                return;
            }
            Err(std::sync::TryLockError::Poisoned(p)) => p.into_inner(),
        };

        // 单条截断
        let body = if text.len() > MAX_LINE_BYTES {
            // 按字符边界截，避免把 UTF-8 切坏
            let mut end = MAX_LINE_BYTES;
            while end > 0 && !text.is_char_boundary(end) {
                end -= 1;
            }
            format!("{}…（本条被截断，原始 {} 字节）", &text[..end], text.len())
        } else {
            text.to_string()
        };

        let line = LogLine {
            seq: c.next_seq,
            ts_ms: chrono::Utc::now().timestamp_millis(),
            level,
            dir,
            text: body.into_boxed_str(),
            raw_bytes,
        };
        let mut removed = 0usize;
        let added = line.cost();
        c.next_seq += 1;
        c.bytes += added;
        c.lines.push_back(line);

        // 超上限：从最旧开始丢到一半（滞回，避免每条都裁）
        if c.bytes > c.cap {
            let target = c.cap / 2;
            while c.bytes > target {
                match c.lines.pop_front() {
                    Some(old) => {
                        let cost = old.cost();
                        c.bytes = c.bytes.saturating_sub(cost);
                        removed += cost;
                        c.dropped += 1;
                    }
                    None => break,
                }
            }
        }
        drop(c);
        // 增量维护总量：**只做原子加减**，绝不在写入路径上再锁别的通道
        // （曾经写成"遍历所有通道求和"——那等于每写一条日志就把所有通道锁一遍，
        //  直接违背"生产者非阻塞"这条铁律）
        self.total_bytes.fetch_add(added, Ordering::Relaxed);
        if removed > 0 {
            self.total_bytes.fetch_sub(removed, Ordering::Relaxed);
        }
        // 全局预算：超了就**尽力**回收（有界代价 + try_lock，收不动就等下一条再收）
        if self.total_bytes.load(Ordering::Relaxed) > TOTAL_CAP_BYTES {
            self.reclaim(name);
        }
    }

    fn with_channel<R>(&self, name: &str, f: impl FnOnce(&Channel) -> R) -> Option<R> {
        let ch = {
            let map = self.channels.lock().unwrap_or_else(|e| e.into_inner());
            map.get(name).cloned()
        }?;
        let c = ch.lock().unwrap_or_else(|e| e.into_inner());
        Some(f(&c))
    }

    /// 通道清单（AI 先看这个决定去哪找）
    pub fn channels(&self) -> Value {
        let handles: Vec<(String, Arc<Mutex<Channel>>)> = {
            let map = self.channels.lock().unwrap_or_else(|e| e.into_inner());
            map.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
        };
        let mut out: Vec<Value> = handles
            .into_iter()
            .map(|(name, ch)| {
                let c = ch.lock().unwrap_or_else(|e| e.into_inner());
                json!({
                    "channel": name,
                    "lines": c.lines.len(),
                    "bytes": c.bytes,
                    "capBytes": c.cap,
                    "seqFrom": c.lines.front().map(|l| l.seq),
                    "seqTo": c.lines.back().map(|l| l.seq),
                    "dropped": c.dropped,
                    "lastTs": c.last_ts().map(fmt_ts),
                })
            })
            .collect();
        out.sort_by(|a, b| a["channel"].as_str().cmp(&b["channel"].as_str()));
        let (reclaims, reclaimed) = self.reclaim_stats();
        json!({
            "channels": out,
            "totalBytes": self.total_bytes(),
            "totalCapBytes": TOTAL_CAP_BYTES,
            "maxChannels": MAX_CHANNELS,
            "channelCount": out.len(),
            "lockSkips": self.lock_skips(),
            "channelSkips": self.channel_skips(),
            "reclaims": reclaims,
            "reclaimedBytes": reclaimed,
            "enabled": self.is_enabled(),
        })
    }

    /// 取尾部若干行；给了 `since_seq` 就取它之后的（增量拉取，不重复不丢）
    pub fn tail(&self, name: &str, since_seq: Option<u64>, lines: usize) -> Result<Value, String> {
        let lines = lines.clamp(1, 2000);
        self.with_channel(name, |c| {
            let picked: Vec<&LogLine> = match since_seq {
                Some(s) => c.lines.iter().filter(|l| l.seq > s).collect(),
                None => {
                    let skip = c.lines.len().saturating_sub(lines);
                    c.lines.iter().skip(skip).collect()
                }
            };
            let picked: Vec<&LogLine> = if since_seq.is_some() {
                let skip = picked.len().saturating_sub(lines);
                picked.into_iter().skip(skip).collect()
            } else {
                picked
            };
            let truncated = picked.len() >= lines && c.dropped > 0;
            json!({
                "channel": name,
                "lines": picked.iter().map(|l| l.to_json()).collect::<Vec<_>>(),
                "returned": picked.len(),
                "dropped": c.dropped,
                "seqTo": c.lines.back().map(|l| l.seq),
                // 有丢弃时明确告知：别让 AI 以为日志是完整的
                "mayBeIncomplete": c.dropped > 0,
                "truncated": truncated,
            })
        })
        .ok_or_else(|| format!("没有这个通道: {}（先用 log_channels 看有哪些）", name))
    }

    /// 检索（子串或正则），返回命中行与位置
    pub fn search(
        &self,
        name: Option<&str>,
        pattern: &str,
        use_regex: bool,
        case_sensitive: bool,
        limit: usize,
    ) -> Result<Value, String> {
        let limit = limit.clamp(1, 500);
        let re = if use_regex {
            Some(
                regex::RegexBuilder::new(pattern)
                    .case_insensitive(!case_sensitive)
                    .build()
                    .map_err(|e| format!("正则不合法: {}", e))?,
            )
        } else {
            None
        };
        let needle = if case_sensitive {
            pattern.to_string()
        } else {
            pattern.to_lowercase()
        };
        let hits_match = |t: &str| -> bool {
            match &re {
                Some(r) => r.is_match(t),
                None => {
                    if case_sensitive {
                        t.contains(&needle)
                    } else {
                        t.to_lowercase().contains(&needle)
                    }
                }
            }
        };

        let names: Vec<String> = match name {
            Some(n) => vec![n.to_string()],
            None => {
                let map = self.channels.lock().unwrap_or_else(|e| e.into_inner());
                let mut v: Vec<String> = map.keys().cloned().collect();
                v.sort();
                v
            }
        };

        let mut hits: Vec<Value> = Vec::new();
        let mut scanned = 0usize;
        for n in names {
            let ch = match self.with_channel(&n, |c| c.lines.iter().cloned().collect::<Vec<_>>()) {
                Some(v) => v,
                None => continue,
            };
            for l in ch {
                scanned += 1;
                if hits_match(l.text()) {
                    hits.push(json!({
                        "channel": n,
                        "seq": l.seq,
                        "ts": fmt_ts(l.ts_ms),
                        "level": level_name(l.level),
                        "dir": dir_name(l.dir),
                        "text": l.text(),
                    }));
                    if hits.len() >= limit {
                        break;
                    }
                }
            }
            if hits.len() >= limit {
                break;
            }
        }
        Ok(json!({
            "pattern": pattern,
            "regex": use_regex,
            "hits": hits,
            "scanned": scanned,
            "truncated": hits.len() >= limit,
        }))
    }

    /// 概览统计
    pub fn stats(&self) -> Value {
        let snap: Vec<(String, usize, usize, u64, Option<i64>, Option<i64>, usize)> = {
            let map = self.channels.lock().unwrap_or_else(|e| e.into_inner());
            map.iter()
                .map(|(name, ch)| {
                    let c = ch.lock().unwrap_or_else(|e| e.into_inner());
                    (
                        name.clone(),
                        c.lines.len(),
                        c.bytes,
                        c.dropped,
                        c.first_ts(),
                        c.last_ts(),
                        c.lines.iter().filter(|l| l.level >= LEVEL_WARN).count(),
                    )
                })
                .collect()
        };
        let per: Vec<Value> = snap
            .iter()
            .map(|(name, lines, bytes, dropped, first, last, warn)| {
                let span_ms = match (first, last) {
                    (Some(a), Some(b)) => (b - a).max(0) as f64,
                    _ => 0.0,
                };
                json!({
                    "channel": name,
                    "lines": lines,
                    "bytes": bytes,
                    "dropped": dropped,
                    "warnOrError": warn,
                    "spanSecs": (span_ms / 1000.0).round(),
                    // 速率：有跨度才算，否则没有意义（避免给出假数字）
                    "linesPerSec": if span_ms > 0.0 { ((*lines as f64) / (span_ms / 1000.0) * 100.0).round() / 100.0 } else { 0.0 },
                })
            })
            .collect();
        let (reclaims, reclaimed) = self.reclaim_stats();
        json!({
            "channels": per,
            "totalBytes": self.total_bytes(),
            "totalCapBytes": TOTAL_CAP_BYTES,
            "maxChannels": MAX_CHANNELS,
            "lockSkips": self.lock_skips(),
            "channelSkips": self.channel_skips(),
            "reclaims": reclaims,
            "reclaimedBytes": reclaimed,
            "enabled": self.is_enabled(),
        })
    }

    /// 清空（`None` = 全部通道）。**保留通道本身** —— 清空之后 `log_tail` 应该返回 0 行，
    /// 而不是"没有这个通道"（那会让 AI 以为通道名写错了、白折腾一轮）。
    /// 返回被清空的通道数。
    pub fn clear(&self, name: Option<&str>) -> usize {
        let handles: Vec<Arc<Mutex<Channel>>> = {
            let map = self.channels.lock().unwrap_or_else(|e| e.into_inner());
            match name {
                Some(n) => map.get(n).cloned().into_iter().collect(),
                None => map.values().cloned().collect(),
            }
        };
        let n = handles.len();
        for ch in handles {
            let mut c = ch.lock().unwrap_or_else(|e| e.into_inner());
            c.lines.clear();
            c.bytes = 0;
        }
        self.total_bytes.store(0, Ordering::Relaxed);
        n
    }

    /// 彻底丢掉所有通道 —— 这才是真正释放内存（停用时用）
    pub fn drop_all(&self) {
        self.channels
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.total_bytes.store(0, Ordering::Relaxed);
        self.channel_skips.store(0, Ordering::Relaxed);
    }

    /// 导出若干通道的纯文本（按 seq 归并）
    pub fn export(&self, names: &[String], max_lines_per_channel: usize) -> Value {
        let max = max_lines_per_channel.clamp(1, 20000);
        let mut all: Vec<(String, LogLine)> = Vec::new();
        for n in names {
            if let Some(v) = self.with_channel(n, |c| {
                let skip = c.lines.len().saturating_sub(max);
                c.lines.iter().skip(skip).cloned().collect::<Vec<_>>()
            }) {
                for l in v {
                    all.push((n.clone(), l));
                }
            }
        }
        all.sort_by_key(|(_, l)| l.ts_ms);
        let mut out = String::new();
        for (n, l) in &all {
            out.push_str(&format!(
                "[{}] [{}] [{}] {}\n",
                fmt_ts(l.ts_ms),
                n,
                level_name(l.level),
                l.text()
            ));
        }
        json!({
            "channels": names,
            "lines": all.len(),
            "text": out,
            "truncated": all.len() >= max * names.len().max(1),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> &'static LogHub {
        // 每个测试用独立实例（不要用全局 hub，避免相互影响）
        Box::leak(Box::new(LogHub::default()))
    }

    #[test]
    fn disabled_hub_is_a_noop() {
        let h = fresh();
        h.push("app", LEVEL_INFO, DIR_NONE, "不该被记录", 0);
        assert_eq!(h.channel_count(), 0, "关闭时连通道都不该建（零内存）");
        assert_eq!(h.total_bytes(), 0);
    }

    #[test]
    fn push_tail_roundtrip_with_seq() {
        let h = fresh();
        h.set_enabled(true);
        for i in 0..5 {
            h.push("app", LEVEL_INFO, DIR_NONE, &format!("line {}", i), 0);
        }
        let t = h.tail("app", None, 3).unwrap();
        let lines = t["lines"].as_array().unwrap();
        assert_eq!(lines.len(), 3, "取尾部 3 条");
        assert_eq!(lines[0]["text"], "line 2");
        assert_eq!(lines[2]["text"], "line 4");
        assert_eq!(lines[0]["seq"], 3, "seq 从 1 开始且连续");
        assert_eq!(t["seqTo"], 5);
    }

    #[test]
    fn since_seq_gives_incremental_reads() {
        let h = fresh();
        h.set_enabled(true);
        for i in 0..4 {
            h.push("app", LEVEL_INFO, DIR_NONE, &format!("m{}", i), 0);
        }
        let t = h.tail("app", Some(2), 100).unwrap();
        let lines = t["lines"].as_array().unwrap();
        assert_eq!(lines.len(), 2, "只拿 seq>2 的");
        assert_eq!(lines[0]["text"], "m2");
        assert_eq!(lines[0]["seq"], 3);
    }

    #[test]
    fn long_line_is_truncated_with_notice() {
        let h = fresh();
        h.set_enabled(true);
        let huge = "x".repeat(MAX_LINE_BYTES + 5000);
        h.push("app", LEVEL_INFO, DIR_NONE, &huge, 0);
        let t = h.tail("app", None, 1).unwrap();
        let text = t["lines"][0]["text"].as_str().unwrap();
        assert!(text.len() < huge.len(), "必须截断");
        assert!(text.contains("被截断"), "要说明被截断: {}", &text[text.len() - 40..]);
    }

    #[test]
    fn per_channel_byte_cap_drops_oldest_and_counts() {
        let h = fresh();
        h.set_enabled(true);
        // ui 通道上限 64KB；灌到远超
        let payload = "y".repeat(1000);
        for _ in 0..300 {
            h.push("ui:sys", LEVEL_INFO, DIR_NONE, &payload, 0);
        }
        let t = h.tail("ui:sys", None, 2000).unwrap();
        let bytes = t["lines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| l["text"].as_str().unwrap().len() + OVERHEAD_PER_LINE)
            .sum::<usize>();
        assert!(bytes <= cap_for("ui:sys"), "通道不能超过上限: {}", bytes);
        assert!(t["dropped"].as_u64().unwrap() > 0, "丢弃必须计数");
        assert_eq!(t["mayBeIncomplete"], true, "有丢弃时要明确告知，别让 AI 以为日志完整");
    }

    /// 全局兜底必须**真的被执行**：以前 `totalCapBytes` 只是报告值，超了没人管。
    #[test]
    fn global_budget_is_enforced_across_channels() {
        let h = fresh();
        h.set_enabled(true);
        // 每通道上限 512KB；只有把通道数堆起来（64 × 512KB = 32MB）才可能撞到 16MB 的全局上限。
        // 这正是"MCP 通道名是动态的"带来的真实风险：光靠每通道限流，总量没有上界。
        let payload = "g".repeat(8 * 1024);
        let names: Vec<String> = (0..MAX_CHANNELS).map(|i| format!("serial:m{}:rx", i)).collect();
        for _ in 0..100 {
            for n in &names {
                h.push(n, LEVEL_INFO, DIR_RX, &payload, 0);
            }
        }
        let total = h.total_bytes();
        assert!(
            total <= TOTAL_CAP_BYTES,
            "全局预算没被执行: {} > {}",
            total,
            TOTAL_CAP_BYTES
        );
        let (reclaims, reclaimed) = h.reclaim_stats();
        assert!(reclaims > 0, "超预算时必须发生过回收（total={}）", total);
        assert!(reclaimed > 0, "回收必须真的释放了字节: {}", reclaimed);
        // 回收也不该把某个通道清成空的（是"裁到一半"，不是"全丢"）
        let ch = h.channels();
        assert!(
            ch["channels"].as_array().unwrap().iter().any(|c| c["lines"].as_u64().unwrap() > 0),
            "回收把日志全丢了"
        );
        assert_eq!(ch["totalCapBytes"], TOTAL_CAP_BYTES as u64);
        assert_eq!(ch["maxChannels"], MAX_CHANNELS as u64);
    }

    /// 通道名是动态的（每个监视器 2 个通道），必须给通道表也设上限。
    #[test]
    fn channel_count_is_capped_and_skips_are_counted() {
        let h = fresh();
        h.set_enabled(true);
        for i in 0..(MAX_CHANNELS + 10) {
            h.push(&format!("dyn:{}", i), LEVEL_INFO, DIR_NONE, "x", 0);
        }
        assert_eq!(h.channel_count(), MAX_CHANNELS, "通道数必须封顶");
        assert_eq!(h.channel_skips(), 10, "被丢弃的写入必须计数");
        // 已有通道不受影响：还能继续写进去
        h.push("dyn:0", LEVEL_INFO, DIR_NONE, "还在", 0);
        let t = h.tail("dyn:0", None, 10).unwrap();
        assert!(t["lines"].as_array().unwrap().len() >= 2);
    }

    /// 回收路径同样**不许阻塞生产者**：别的通道被人持着锁时，push 只能放弃回收。
    #[test]
    fn reclaim_never_blocks_the_producer() {
        let h = fresh();
        h.set_enabled(true);
        let payload = "r".repeat(4 * 1024);
        // 先把其它通道灌满，制造"总量已超预算"的局面
        for i in 0..4 {
            for _ in 0..40 {
                h.push(&format!("serial:b{}:rx", i), LEVEL_INFO, DIR_RX, &payload, 0);
            }
        }
        // 持住其中一个通道的锁，模拟"正在被读"
        let ch = h.handle("serial:b0:rx");
        let guard = ch.lock().unwrap();
        h.total_bytes.store(TOTAL_CAP_BYTES + 1, Ordering::Relaxed);
        let t0 = std::time::Instant::now();
        for _ in 0..200 {
            h.push("app", LEVEL_INFO, DIR_NONE, &payload, 0);
        }
        assert!(
            t0.elapsed() < std::time::Duration::from_millis(800),
            "回收路径把生产者拖住了: {:?}",
            t0.elapsed()
        );
        drop(guard);
    }

    #[test]
    fn channels_are_independent() {
        let h = fresh();
        h.set_enabled(true);
        let payload = "z".repeat(1000);
        for _ in 0..300 {
            h.push("ui:sys", LEVEL_INFO, DIR_NONE, &payload, 0);
        }
        // 另一个通道不该被牵连
        h.push("app", LEVEL_WARN, DIR_NONE, "app 还在", 0);
        let t = h.tail("app", None, 10).unwrap();
        assert_eq!(t["lines"].as_array().unwrap().len(), 1);
        assert_eq!(t["lines"][0]["text"], "app 还在");
    }

    #[test]
    fn concurrent_writer_never_blocks() {
        // 持住通道锁，push 必须立刻返回（丢弃并计数），绝不等待
        let h = fresh();
        h.set_enabled(true);
        h.push("app", LEVEL_INFO, DIR_NONE, "建立通道", 0);
        let ch = h.handle("app");
        let guard = ch.lock().unwrap();
        let t0 = std::time::Instant::now();
        for _ in 0..1000 {
            h.push("app", LEVEL_INFO, DIR_NONE, "写不进去", 0);
        }
        let elapsed = t0.elapsed();
        assert!(
            elapsed < std::time::Duration::from_millis(500),
            "持锁时 push 必须丢弃而不是等待，实际耗时 {:?}",
            elapsed
        );
        assert_eq!(h.lock_skips(), 1000, "被跳过的写入要计数");
        drop(guard);
    }

    #[test]
    fn search_substring_and_regex() {
        let h = fresh();
        h.set_enabled(true);
        h.push("app", LEVEL_INFO, DIR_NONE, "AT+CGMR", 0);
        h.push("app", LEVEL_ERROR, DIR_NONE, "发送失败: timeout", 0);
        let s = h.search(Some("app"), "timeout", false, true, 10).unwrap();
        assert_eq!(s["hits"].as_array().unwrap().len(), 1);
        assert_eq!(s["hits"][0]["level"], "error");

        let r = h.search(None, r"AT\+[A-Z]+", true, true, 10).unwrap();
        assert_eq!(r["hits"].as_array().unwrap().len(), 1, "正则检索");
        assert_eq!(r["hits"][0]["text"], "AT+CGMR");

        // 非法正则要给出可读错误，而不是 panic
        let bad = h.search(Some("app"), "([", true, true, 10);
        assert!(bad.is_err());
        assert!(bad.unwrap_err().contains("正则"));
    }

    #[test]
    fn search_across_all_channels_when_no_channel_given() {
        let h = fresh();
        h.set_enabled(true);
        h.push("app", LEVEL_INFO, DIR_NONE, "needle-A", 0);
        h.push("ui:sys", LEVEL_INFO, DIR_NONE, "needle-B", 0);
        let s = h.search(None, "needle", false, true, 10).unwrap();
        assert_eq!(s["hits"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn clear_empties_but_keeps_the_channel() {
        let h = fresh();
        h.set_enabled(true);
        h.push("app", LEVEL_INFO, DIR_NONE, "a", 0);
        h.push("ui:sys", LEVEL_INFO, DIR_NONE, "b", 0);

        assert_eq!(h.clear(Some("app")), 1);
        // 关键：清空之后 tail 必须仍能工作（返回 0 行），而不是报"没有这个通道"
        let t = h.tail("app", None, 10).unwrap();
        assert_eq!(t["lines"].as_array().unwrap().len(), 0, "清空后应返回空列表");
        assert_eq!(
            h.tail("ui:sys", None, 10).unwrap()["lines"].as_array().unwrap().len(),
            1,
            "只清指定的那个通道"
        );

        assert_eq!(h.clear(None), 2, "全部清空：两个通道");
        assert_eq!(h.tail("app", None, 10).unwrap()["lines"].as_array().unwrap().len(), 0);
        assert_eq!(h.tail("ui:sys", None, 10).unwrap()["lines"].as_array().unwrap().len(), 0);
        assert_eq!(h.total_bytes(), 0);
    }

    #[test]
    fn drop_all_frees_channels() {
        let h = fresh();
        h.set_enabled(true);
        h.push("app", LEVEL_INFO, DIR_NONE, "a", 0);
        h.drop_all();
        assert_eq!(h.channel_count(), 0, "drop_all 才是真正释放");
        assert!(h.tail("app", None, 10).is_err(), "通道已不存在");
    }

    #[test]
    fn disabling_clears_everything() {
        let h = fresh();
        h.set_enabled(true);
        h.push("app", LEVEL_INFO, DIR_NONE, "x", 0);
        assert!(h.total_bytes() > 0);
        h.set_enabled(false);
        assert_eq!(h.channel_count(), 0, "停用后不该再占内存");
        assert_eq!(h.total_bytes(), 0);
    }

    #[test]
    fn tail_of_unknown_channel_gives_actionable_error() {
        let h = fresh();
        h.set_enabled(true);
        let e = h.tail("nope", None, 10).unwrap_err();
        assert!(e.contains("log_channels"), "错误要告诉 AI 下一步怎么做: {}", e);
    }

    #[test]
    fn export_merges_channels_in_time_order() {
        let h = fresh();
        h.set_enabled(true);
        h.push("app", LEVEL_INFO, DIR_NONE, "first", 0);
        h.push("ui:sys", LEVEL_INFO, DIR_NONE, "second", 0);
        let ex = h.export(&["app".into(), "ui:sys".into()], 100);
        let text = ex["text"].as_str().unwrap();
        assert!(text.contains("[app]") && text.contains("[ui:sys]"), "要标出通道: {}", text);
        assert!(text.find("first").unwrap() < text.find("second").unwrap(), "按时间归并");
    }

    #[test]
    fn stats_reports_levels_and_rates() {
        let h = fresh();
        h.set_enabled(true);
        h.push("app", LEVEL_INFO, DIR_NONE, "i", 0);
        h.push("app", LEVEL_ERROR, DIR_NONE, "e", 0);
        let st = h.stats();
        let ch = &st["channels"][0];
        assert_eq!(ch["lines"], 2);
        assert_eq!(ch["warnOrError"], 1, "错误数要能看出来");
        assert_eq!(st["enabled"], true);
    }
}
