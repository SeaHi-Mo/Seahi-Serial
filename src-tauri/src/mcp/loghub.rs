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

/// 读日志时的**输出编码**。两种编码里的**数据完全一样**，只是写法不同：
///
/// - `Json`（默认）：一行一个对象（`seq/ts/t/level/dir/bytes/text`），适合程序化处理；
///   代价是**每行固定 ~100 字节**——短行（串口调试的主体：`OK`、`AT+GMR`）正文只有
///   几字节，包装却比正文长十几倍。实测 200 条短行：**101 字节/行**。
/// - `Text`：头部一行元信息 + 一行一条纯文本，同样那 200 条是 **29 字节/行**（省 3.5 倍）。
///
/// 为什么要多这一档（2026-09 用户要求"既要省 token，又不能影响 AI 查看 log"）：
/// 串口日志的量级按 512 KiB/通道算，全用 JSON 读一遍就是几十万 token —— 上下文根本装不下。
/// ⚠️ 编码**不影响可见性**：`returned`/`seqFrom`/`seqTo`/`missed`/`dropped`/
/// `mayBeIncomplete`/`truncated`/`nextSinceSeq` 两种编码下**一模一样**，
/// 更不会改变"通道丢过最旧的行"这件事（AGENTS #6：丢弃必须能被读出来）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogFormat {
    Json,
    Text,
}

impl LogFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            LogFormat::Json => "json",
            LogFormat::Text => "text",
        }
    }
}

/// 一次检索返回什么（对应 ripgrep 的三个开关）。
///
/// 三档的 token 量级差着三个数量级，所以让调用方**显式选**，而不是一律回命中行：
/// 先 `Count` 判断"有没有、多少次"，要定位再 `Matches`（只回片段），
/// 真要看上下文才 `Lines`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchMode {
    /// 命中行（默认；`rg` 的默认行为）
    Lines,
    /// 只回匹配片段（`rg -o`）
    Matches,
    /// 只回计数（`rg -c`）
    Count,
}

impl SearchMode {
    pub fn as_str(self) -> &'static str {
        match self {
            SearchMode::Lines => "lines",
            SearchMode::Matches => "matches",
            SearchMode::Count => "count",
        }
    }
}

/// 一次检索的全部入参（用结构体而不是七个位置参数：加"模式/上下文"时不会把调用点写错）
pub struct SearchOpts<'a> {
    pub channel: Option<&'a str>,
    pub pattern: &'a str,
    pub use_regex: bool,
    pub case_sensitive: bool,
    pub limit: usize,
    pub mode: SearchMode,
    /// 命中行前后各带多少行（只对 [`SearchMode::Lines`] 有意义）
    pub context: usize,
}

/// 上下文行数上限（`context` 的实际封顶；工具层另有一道校验）
pub const MAX_SEARCH_CONTEXT: usize = 5;

/// 检索图案的长度上限（字符）。
///
/// 为什么必须有：请求体上限是 1 MiB，而 `pattern` 会被**编译成正则** ——
/// 一条几十万字符的图案足以让 regex 编译把这次工具调用卡住（AGENTS #10：
/// "任何接受外部字符串的参数都要有上限，且校验要发生在碰主程序之前"）。
/// 512 个字符足够表达真实调试里的检索需求（要更复杂的就分几次搜）。
pub const MAX_SEARCH_PATTERN_CHARS: usize = 512;

/// 一套可复用的**匹配语义**（字面量/正则 + 大小写），三个"读日志"工具共用。
///
/// 为什么要有它：`log_search` / `adb_shell_read` / `ble_get_output` 必须对同一个图案给出
/// **同样的答案** —— 各写一遍迟早漂移（"count 说 3 次、matches 说 2 处"这种最难查）。
/// 两个档，按需要选：
/// - 只要"命中与否"（lines）：字面量走 `contains`（memchr 级快路径），**不编译正则**；
/// - 要区间或处数（matches / count）：才编译 regex（字面量先 `regex::escape`，
///   让 `AT+CGMR`、`([` 这类图案按字面量处理）。
///
/// ⚠️ [`Self::fragments`] / [`Self::count`] 依赖编译好的 regex ——
/// 用它们就必须 `need_ranges = true`，否则只会拿到空结果。
pub struct LogMatcher {
    re: Option<regex::Regex>,
    needle_lc: Option<String>,
    literal: String,
}

impl LogMatcher {
    pub fn new(
        pattern: &str,
        use_regex: bool,
        case_sensitive: bool,
        need_ranges: bool,
    ) -> Result<Self, String> {
        // 只有在**真的需要**时才编译 regex：
        // ① 用户要正则；② 要区间/处数（matches / count）。只要布尔时字面量走 `contains`。
        // 实测教训（1820 行通道，未命中扫描）：字面量也塞进 regex 是 1.27 ms，
        // 走 `contains` 是 0.42 ms —— 差了 3 倍，而 90% 的检索都是字面量。
        let re = if use_regex || need_ranges {
            let src = if use_regex {
                pattern.to_string()
            } else {
                regex::escape(pattern)
            };
            Some(
                regex::RegexBuilder::new(&src)
                    .case_insensitive(!case_sensitive)
                    .build()
                    .map_err(|e| format!("正则不合法: {}", e))?,
            )
        } else {
            None
        };
        Ok(Self {
            re,
            // 旧的 `to_lowercase().contains()` 在只需布尔值时继续沿用（不涉及偏移，安全）
            needle_lc: if !case_sensitive {
                Some(pattern.to_lowercase())
            } else {
                None
            },
            literal: pattern.to_string(),
        })
    }

    /// 这段文本里有没有命中
    pub fn is_match(&self, text: &str) -> bool {
        match &self.re {
            Some(r) => r.is_match(text),
            None => match &self.needle_lc {
                Some(n) => text.to_lowercase().contains(n.as_str()),
                None => text.contains(&self.literal),
            },
        }
    }

    /// 命中处的片段（按出现顺序），最多 `limit` 个。零长匹配跳过
    /// （否则 `a*` 之类会用空片段把 limit 塞满）。
    pub fn fragments(&self, text: &str, limit: usize) -> Vec<String> {
        match &self.re {
            Some(re) => re
                .find_iter(text)
                .filter(|m| !m.is_empty())
                .take(limit)
                .map(|m| m.as_str().to_string())
                .collect(),
            None => Vec::new(),
        }
    }

    /// 命中**处数**（不是命中行数；零长匹配不计）
    pub fn count(&self, text: &str) -> u64 {
        match &self.re {
            Some(re) => re.find_iter(text).filter(|m| !m.is_empty()).count() as u64,
            None => 0,
        }
    }
}

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

/// 一页日志的**纯文本编码**：头部一行元信息 + 一行一条日志（[`LogFormat::Text`]）。
///
/// 取舍（2026-09）：
/// 1. 不再逐行重复 `seq`/`t`/`ts`/`bytes`/`channel` —— 这些要么在头部给一次，
///    要么能用 `nextSinceSeq` 推出来；重复 2000 遍纯属烧 token
///    （实测：同样 200 条短行，JSON 101 字节/行 → 本编码 29 字节/行）；
/// 2. 每行固定 `[HH:MM:SS.mmm] [level] ` 前缀。**不带方向**：
///    通道名本身已经把方向说死了（`serial:<分栏>:rx|tx` 各自一个通道），再写一遍是浪费；
/// 3. 正文里的 CR/LF 转义成 `\r`/`\n`（见 [`push_escaped`]）：日志必须"一行一条"；
/// 4. 头部**必须**带上 `dropped`/`missed`/`mayBeIncomplete` —— 省 token 不能变成
///    "让 AI 以为日志是完整的"（AGENTS #6）。
fn render_text_page(meta: &Value, picked: &[&LogLine]) -> String {
    fn num(v: &Value) -> String {
        v.as_u64().map(|n| n.to_string()).unwrap_or_else(|| "-".to_string())
    }
    fn flag(v: &Value) -> &'static str {
        if v.as_bool().unwrap_or(false) { "true" } else { "false" }
    }
    let mut out = String::with_capacity(picked.iter().map(|l| l.text.len() + 40).sum::<usize>() + 200);
    out.push_str("# channel=");
    out.push_str(meta["channel"].as_str().unwrap_or(""));
    out.push_str(" returned=");
    out.push_str(&num(&meta["returned"]));
    out.push_str(" seqFrom=");
    out.push_str(&num(&meta["seqFrom"]));
    out.push_str(" seqTo=");
    out.push_str(&num(&meta["seqTo"]));
    out.push_str(" missed=");
    out.push_str(&num(&meta["missed"]));
    out.push_str(" dropped=");
    out.push_str(&num(&meta["dropped"]));
    out.push_str(" mayBeIncomplete=");
    out.push_str(flag(&meta["mayBeIncomplete"]));
    out.push_str(" truncated=");
    out.push_str(flag(&meta["truncated"]));
    out.push_str(" nextSinceSeq=");
    out.push_str(&num(&meta["nextSinceSeq"]));
    out.push('\n');
    for l in picked {
        push_text_line(&mut out, l.ts_ms, level_name(l.level), l.text());
    }
    out
}

/// 一行日志的文本写法：`[HH:MM:SS.mmm] [<标签>] 正文` + 换行。
///
/// 标签由调用方决定：`log_tail` 用级别（`info`/`warn`…），`serial_get_output` 用方向
/// （`rx`/`tx` —— 那边两个方向是**归并在一起**的，不标就分不清谁说的）。
/// ⚠️ 转义规则必须有且只有这一处（见 [`push_escaped`]），否则"一行一条"两个工具就会漂移。
pub fn push_text_line(out: &mut String, ts_ms: i64, tag: &str, body: &str) {
    out.push('[');
    out.push_str(&fmt_ts(ts_ms));
    out.push_str("] [");
    out.push_str(tag);
    out.push_str("] ");
    push_escaped(out, body);
    out.push('\n');
}

/// 把一段日志正文写进文本页：CR/LF 转义成字面量 `\r`/`\n`。
///
/// 为什么不能原样写：`push` 收的是**一整块**数据（ADB 的 PTY 输出、串口一次读到的多行），
/// 原样拼进文本页会让"一条记录"跨好几行 —— 既破坏"一行一条"的约定，
/// 又能让日志内容**伪造出头部行**（`# channel=…`）。
/// 转义是可逆的（内容一个字节都没丢），只是换了个写法显示。
fn push_escaped(out: &mut String, text: &str) {
    for ch in text.chars() {
        match ch {
            '\r' => out.push_str("\\r"),
            '\n' => out.push_str("\\n"),
            c => out.push(c),
        }
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
    /// 正文（独占字符串）。
    ///
    /// ⚠️ 曾经为了"让搜索的快照克隆变便宜"把它换成过 `Arc<str>` —— **又换回来了**：
    /// 隔离实测（1820 行快照）克隆本身约 95 µs，其中文本分配只占 ~11 µs；
    /// `Arc` 只能省掉那一小块（≈搜索时间的 2.6%），代价是**每行多 16 字节引用计数头**
    /// —— 同样内存预算下少存约 11% 的日志。搜索本来就不是瓶颈（单通道 0.4 ms、
    /// 全局上限 ~13 ms），拿日志容量换这点时间不划算。
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

    /// 取通道句柄（**单测专用**：生产只用下面的 `handle_capped` —— 它会尊重通道数上限，
    /// 而 `handle` 会无条件建通道，正是 `MAX_CHANNELS` 要防的那件事）。
    #[cfg(test)]
    fn handle(&self, name: &str) -> Arc<Mutex<Channel>> {
        let mut map = self.channels.lock().unwrap_or_else(|e| e.into_inner());
        map.entry(name.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(Channel::new(name))))
            .clone()
    }

    /// 预建一个通道（不写内容）。用于**由事件驱动才写**的通道（如 `workflow`）：
    /// 不预建的话，"还没触发过"会表现成 `log_tail` 报「没有这个通道」，
    /// 调用方于是得出"不支持读这类日志"的错结论（`serial_get_output` 上踩过同一个坑）。
    /// 走 `handle_capped` —— 通道数到顶时**不建**（这正是 `MAX_CHANNELS` 要防的事）。
    pub fn ensure_channel(&self, name: &str) {
        let _ = self.handle_capped(name);
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

    /// 记一笔"**前端**因为自己的待发队列满而丢掉的日志"（按通道）。
    ///
    /// 为什么需要：前端的待发队列在定时器被节流时会丢最旧的，而 `log_tail` 的 `dropped` /
    /// `mayBeIncomplete` 读的是**这里**的计数。不记的话 AI 会被明确告知"日志是完整的"，
    /// 而实际可能丢了九成 —— 串口缓冲与 BLE 通知两路都记账，只有前端回灌这一路漏了
    /// （2026-09 审计发现）。
    ///
    /// 与 [`Self::push`] 同样的纪律：**非阻塞**，拿不到锁就跳过（丢的是一个计数，
    /// 绝不能让调用方在这里等）。
    pub fn note_dropped(&self, name: &str, n: u64) {
        if n == 0 || !self.enabled.load(Ordering::Relaxed) {
            return;
        }
        let ch = match self.handle_capped(name) {
            Some(c) => c,
            None => {
                self.channel_skips.fetch_add(n, Ordering::Relaxed);
                return;
            }
        };
        // 分号不能省：不留分号时 `Result<MutexGuard>` 这个临时量会活到**本块结束**，
        // 于是和 `ch` 的析构顺序冲突（E0597）。`push` 那边因为把 guard 绑进了变量所以没事。
        match ch.try_lock() {
            Ok(mut c) => c.dropped += n,
            Err(std::sync::TryLockError::WouldBlock) => {
                self.lock_skips.fetch_add(n, Ordering::Relaxed);
            }
            Err(std::sync::TryLockError::Poisoned(p)) => p.into_inner().dropped += n,
        };
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

    /// 取尾部若干行（JSON 编码）；给了 `since_seq` 就取它之后的。
    ///
    /// 这是给内部调用方（`serial_get_output` / `adb_shell_read`）保留的入口，
    /// 它们要的是逐行结构。工具层用 [`Self::tail_fmt`]。
    pub fn tail(&self, name: &str, since_seq: Option<u64>, lines: usize) -> Result<Value, String> {
        self.tail_fmt(name, since_seq, lines, LogFormat::Json)
    }

    /// 取尾部若干行；给了 `since_seq` 就取它之后的（增量拉取）。
    ///
    /// 两种编码共享**同一份元信息**，也共享同一套"漏了多少"的口径：
    ///
    /// - `returned`：本次真给了几行；
    /// - `seqFrom` / `seqTo`：本页在通道里的 seq 区间（`seqFrom` 可能为 `null` = 一行都没有）；
    /// - `missed`：**给了 `since_seq` 时**，`(seqTo - sinceSeq)` 这段窗口里
    ///   "存在过但没给你"的行数（含已被裁掉的）。seq 是**逐条连续**发出的
    ///   （`next_seq += 1` 后才 push），所以这个减法精确 —— 不用它的话，
    ///   一次拉不完（`lines` 到顶）会在**没有任何标记**的情况下静默跳行
    ///   （`truncated` 旧口径还要求 `dropped > 0`，于是"取满 2000 行但没丢过"会谎报 false）；
    /// - `nextSinceSeq`：下次该带的 `sinceSeq`（= 本次最后返回那行的 seq）。
    ///   **推进到它才不会漏**；直接跳到 `seqTo` 会把没拿到的行永远跳过；
    /// - `dropped` / `mayBeIncomplete`：通道丢过最旧的行（AGENTS #6）。
    /// - `truncated`：本页被 `lines` 顶住了（可能还有更早的行）——
    ///   口径与 `log_search`/`adb_shell_read` 一致，不再要求 `dropped > 0`。
    pub fn tail_fmt(
        &self,
        name: &str,
        since_seq: Option<u64>,
        lines: usize,
        fmt: LogFormat,
    ) -> Result<Value, String> {
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
            let returned = picked.len();
            let seq_to = c.lines.back().map(|l| l.seq);
            let seq_from = picked.first().map(|l| l.seq);
            // 没给 sinceSeq 就没有"窗口"，`missed` 不适用（`seqTo/seqFrom/returned` 足够表达）
            let missed = match since_seq {
                Some(s) => seq_to.unwrap_or(s).saturating_sub(s).saturating_sub(returned as u64),
                None => 0,
            };
            let next_since_seq = picked.last().map(|l| l.seq).or(since_seq).or(seq_to).unwrap_or(0);
            let mut out = json!({
                "channel": name,
                "format": fmt.as_str(),
                "returned": returned,
                "dropped": c.dropped,
                "seqFrom": seq_from,
                "seqTo": seq_to,
                "missed": missed,
                "nextSinceSeq": next_since_seq,
                // 有丢弃时明确告知：别让 AI 以为日志是完整的
                "mayBeIncomplete": c.dropped > 0,
                "truncated": returned >= lines,
            });
            match fmt {
                LogFormat::Json => {
                    out["lines"] = json!(picked.iter().map(|l| l.to_json()).collect::<Vec<_>>());
                }
                LogFormat::Text => {
                    out["text"] = json!(render_text_page(&out, &picked));
                }
            }
            out
        })
        .ok_or_else(|| format!("没有这个通道: {}（先用 log_channels 看有哪些）", name))
    }

    /// 检索（子串或正则），返回命中行与位置。
    ///
    /// `#[cfg(test)]`：只剩单测在用（工具层一律走 [`Self::search_with`] ——
    /// 它要传模式与上下文）。留着是为了让老单测读起来短，不是为了给生产代码用。
    #[cfg(test)]
    pub fn search(
        &self,
        name: Option<&str>,
        pattern: &str,
        use_regex: bool,
        case_sensitive: bool,
        limit: usize,
    ) -> Result<Value, String> {
        self.search_with(SearchOpts {
            channel: name,
            pattern,
            use_regex,
            case_sensitive,
            limit,
            mode: SearchMode::Lines,
            context: 0,
        })
    }

    /// 取某个通道的**快照**（把行整体克隆出来，之后在锁**外**匹配）。
    ///
    /// 为什么是"快照"而不是"在锁里搜完"：匹配可能花几十毫秒（全通道 + 复杂正则），
    /// 一直占着通道锁会让生产者的 `push` 全部撞 `try_lock` 失败 —— 那是**丢日志**
    /// （虽然计了数，AGENTS #6/#10 也不允许我们把收发热路径堵住）。
    ///
    /// 关于"克隆贵不贵"（2026-09 量过，别再凭直觉猜）：1820 行一次的克隆约 **95 µs**，
    /// 整条搜索（字面量、未命中）约 **423 µs** —— 克隆占 ~22%，其中"文本分配"只占 ~11 µs。
    /// 所以换 `Arc<str>`（省那 11 µs = 搜索时间的 2.6%）要多付每行 16 字节计数头
    /// （同样内存预算少存 ~11% 日志）—— 不值，已换回来。
    /// 真正的大头是**逐行子串匹配的固定开销**（这一批 `contains` 约 186 ns/行），
    /// 而 0.4 ms/通道、全局上限 ~13 ms 对一次工具调用来说本来就不是瓶颈。
    fn snapshot(&self, name: &str) -> Option<Vec<LogLine>> {
        self.with_channel(name, |c| c.lines.iter().cloned().collect::<Vec<_>>())
    }

    /// 检索（带**模式**与**上下文**）：
    /// `lines` 回命中行 / `matches` 只回匹配片段（`rg -o`）/ `count` 只回计数（`rg -c`）。
    ///
    /// 为什么要有这三档（2026-09 用户问"日志改用 ripgrep 会不会更省"之后定的）：
    /// 省 token 的关键**不是搜得多快**（实测全通道 8.4 MB 扫一遍 23 ms，比一次 MCP
    /// 往返还短），而是**回多少文本**。`rg -c` / `rg -o` 之所以省，省的就是输出 ——
    /// "ERROR 出现过几次"用 `count` 是几十 token，用命中行是几万 token。
    /// 三档全部在**内存里**做：数据本来就在内存，为了用 rg 而落盘只会更慢、还要分发 exe。
    ///
    /// ⚠️ 匹配一律走 `regex`（子串模式先 `regex::escape`），两个原因：
    /// ① `matches` 要的是**原文里的字节区间**，旧的 `to_lowercase().contains()` 拿不到偏移；
    /// ② 转义后的字面量仍然走 `regex` 的字面量预过滤（memchr），不比 `contains` 慢。
    pub fn search_with(&self, o: SearchOpts<'_>) -> Result<Value, String> {
        let limit = o.limit.clamp(1, 500);
        let context = o.context.min(MAX_SEARCH_CONTEXT);
        // `matches` 要区间、`count` 要处数 → 两者都需要编译好的 regex；
        // 只有 `lines` 的"命中与否"能走字面量快路径（理由见 `LogMatcher::new`）。
        let m = LogMatcher::new(
            o.pattern,
            o.use_regex,
            o.case_sensitive,
            o.mode != SearchMode::Lines,
        )?;

        let names: Vec<String> = match o.channel {
            Some(n) => vec![n.to_string()],
            None => {
                let map = self.channels.lock().unwrap_or_else(|e| e.into_inner());
                let mut v: Vec<String> = map.keys().cloned().collect();
                v.sort();
                v
            }
        };

        let mut scanned = 0usize;
        match o.mode {
            // `rg -c` / `rg --count-matches`：只回计数。**必须扫完**
            //（不能被 limit 提前打断，否则数字是错的）
            SearchMode::Count => {
                let mut total = 0u64; // 命中**行**数
                let mut total_matches = 0u64; // 命中**处**数（一行里出现多次就多算）
                let mut per: Vec<Value> = Vec::new();
                let mut scanned_channels = 0usize;
                for n in &names {
                    let Some(ch) = self.snapshot(n) else { continue };
                    scanned_channels += 1;
                    let mut c = 0u64;
                    let mut cm = 0u64;
                    for l in &ch {
                        let hit = m.is_match(l.text());
                        if hit {
                            c += 1;
                        }
                        // 只有命中行才值得数处数（省一次全行扫描）
                        if hit {
                            cm += m.count(l.text());
                        }
                    }
                    scanned += ch.len();
                    total += c;
                    total_matches += cm;
                    // 只列有命中的通道：没命中的通道数用 scannedChannels 交代，
                    // 免得 64 个通道各占一行（那是把省下的 token 又花回去）
                    if c > 0 {
                        per.push(json!({
                            "channel": n, "count": c, "matches": cm, "scanned": ch.len(),
                        }));
                    }
                }
                Ok(json!({
                    "pattern": o.pattern,
                    "regex": o.use_regex,
                    "mode": "count",
                    "total": total,
                    "totalMatches": total_matches,
                    "channels": per,
                    "scanned": scanned,
                    "scannedChannels": scanned_channels,
                    "truncated": false,
                }))
            }
            // `rg -o`：只回匹配片段（一行可以命中多处 → 每处一条）
            SearchMode::Matches => {
                let mut hits: Vec<Value> = Vec::new();
                'outer: for n in &names {
                    let Some(ch) = self.snapshot(n) else { continue };
                    for l in &ch {
                        scanned += 1;
                        for frag in m.fragments(l.text(), limit - hits.len()) {
                            hits.push(json!({
                                "channel": n,
                                "seq": l.seq,
                                "ts": fmt_ts(l.ts_ms),
                                "level": level_name(l.level),
                                "dir": dir_name(l.dir),
                                "match": frag,
                            }));
                            if hits.len() >= limit {
                                break 'outer;
                            }
                        }
                    }
                }
                Ok(json!({
                    "pattern": o.pattern,
                    "regex": o.use_regex,
                    "mode": "matches",
                    "hits": hits,
                    "scanned": scanned,
                    "truncated": hits.len() >= limit,
                }))
            }
            // 默认：命中行（可带上下文）
            SearchMode::Lines => {
                let mut hits: Vec<Value> = Vec::new();
                'outer: for n in &names {
                    let Some(ch) = self.snapshot(n) else { continue };
                    for (i, l) in ch.iter().enumerate() {
                        scanned += 1;
                        if !m.is_match(l.text()) {
                            continue;
                        }
                        let mut h = json!({
                            "channel": n,
                            "seq": l.seq,
                            "ts": fmt_ts(l.ts_ms),
                            "level": level_name(l.level),
                            "dir": dir_name(l.dir),
                            "text": l.text(),
                        });
                        if context > 0 {
                            let lo = i.saturating_sub(context);
                            let hi = (i + context + 1).min(ch.len());
                            h["before"] = json!(ch[lo..i].iter().map(|x| x.text()).collect::<Vec<_>>());
                            h["after"] = json!(ch[i + 1..hi].iter().map(|x| x.text()).collect::<Vec<_>>());
                        }
                        hits.push(h);
                        if hits.len() >= limit {
                            break 'outer;
                        }
                    }
                }
                Ok(json!({
                    "pattern": o.pattern,
                    "regex": o.use_regex,
                    "mode": "lines",
                    "hits": hits,
                    "scanned": scanned,
                    "truncated": hits.len() >= limit,
                }))
            }
        }
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
            // 丢弃计数也要归零：`log_tail` 用它算 `mayBeIncomplete`，而清空之后缓冲区是
            // **完整的空** —— 把"清空之前丢过"的旧账算到当前窗口头上，那个标志就永远为真、
            // 再也不传递任何信息（2026-09 审计发现）。
            c.dropped = 0;
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

    /// 文本编码是**为省 token 加的**，所以这条直接量字节数：
    /// 同样的数据，纯文本必须显著小于 JSON（否则这个功能没有存在意义）。
    #[test]
    fn text_format_is_much_cheaper_than_json() {
        let h = fresh();
        h.set_enabled(true);
        // 串口调试的真实形状：大量的**短行**
        for i in 0..200 {
            h.push("serial:main:rx", LEVEL_INFO, DIR_RX, &format!("OK {}", i), 6);
        }
        let j = h.tail("serial:main:rx", None, 2000).unwrap();
        let t = h.tail_fmt("serial:main:rx", None, 2000, LogFormat::Text).unwrap();
        let jl = serde_json::to_string(&j).unwrap().len();
        let tl = t["text"].as_str().unwrap().len();
        assert!(
            tl * 2 < jl,
            "文本编码必须明显更省（json={} 字节，text={} 字节）",
            jl,
            tl
        );
        // 两者**数据必须一致**：行数、seq 区间、丢弃账，一个字都不能差
        assert_eq!(j["returned"], t["returned"]);
        assert_eq!(j["seqFrom"], t["seqFrom"]);
        assert_eq!(j["seqTo"], t["seqTo"]);
        assert_eq!(j["missed"], t["missed"]);
        assert_eq!(j["dropped"], t["dropped"]);
        assert_eq!(j["mayBeIncomplete"], t["mayBeIncomplete"]);
        assert_eq!(j["truncated"], t["truncated"]);
        assert_eq!(j["nextSinceSeq"], t["nextSinceSeq"]);
        assert_eq!(t["format"], "text");
        assert_eq!(j["format"], "json");
    }

    /// 换编码**不许少给日志、也不许藏起"丢过"这件事**（这是本次改动的底线）。
    #[test]
    fn text_format_keeps_every_line_and_the_drop_accounting() {
        let h = fresh();
        h.set_enabled(true);
        h.push("serial:main:rx", LEVEL_INFO, DIR_RX, "AT+GMR", 6);
        h.push("serial:main:rx", LEVEL_WARN, DIR_RX, "busy", 4);
        h.note_dropped("serial:main:rx", 7);
        let t = h.tail_fmt("serial:main:rx", None, 10, LogFormat::Text).unwrap();
        let text = t["text"].as_str().unwrap();
        assert!(text.contains("AT+GMR"), "每一行都要在: {}", text);
        assert!(text.contains("busy"), "每一行都要在: {}", text);
        assert!(text.contains("[warn]"), "级别要看得出来: {}", text);
        assert!(text.contains("channel=serial:main:rx"), "头部要标通道: {}", text);
        assert!(
            text.contains("dropped=7") && text.contains("mayBeIncomplete=true"),
            "丢过就必须写在头部（省 token 不能变成'谎报完整'）: {}",
            text
        );
    }

    /// 一条记录跨多行会破坏"一行一条"，还能伪造头部行 —— 必须转义。
    #[test]
    fn text_format_escapes_newlines_so_one_record_per_line() {
        let h = fresh();
        h.set_enabled(true);
        h.push("adb:rx", LEVEL_INFO, DIR_RX, "line1\n# channel=伪造\nline2\r\n", 20);
        let t = h.tail_fmt("adb:rx", None, 10, LogFormat::Text).unwrap();
        let text = t["text"].as_str().unwrap();
        assert_eq!(
            text.matches('\n').count(),
            2,
            "头部 1 行 + 日志 1 行，多出来的换行说明没转义: {:?}",
            text
        );
        assert!(text.contains("line1\\n# channel=伪造\\nline2\\r\\n"), "内容要可逆地转义: {:?}", text);
    }

    /// 增量拉取必须有**可靠的"我漏了多少"**：一次拉不完时 `missed` 要报出来，
    /// 并给出下次该带的 `sinceSeq`（旧实现这里会**静默跳行**）。
    #[test]
    fn since_seq_reports_missed_and_next_since_seq() {
        let h = fresh();
        h.set_enabled(true);
        for i in 0..10 {
            h.push("app", LEVEL_INFO, DIR_NONE, &format!("n{}", i), 0);
        }
        // 从 0 开始只要 4 行 → 给的是最后 4 行（seq 7..10），前面 6 行没给
        let t = h.tail_fmt("app", Some(0), 4, LogFormat::Json).unwrap();
        assert_eq!(t["returned"], 4);
        assert_eq!(t["seqFrom"], 7);
        assert_eq!(t["seqTo"], 10);
        assert_eq!(t["missed"], 6, "没给到的 6 行必须报出来: {}", t);
        assert_eq!(t["nextSinceSeq"], 10, "下次该从最后拿到的那行继续");
        // 接着拉：window 内一行不剩 → missed 归零
        let t2 = h.tail_fmt("app", Some(6), 10, LogFormat::Json).unwrap();
        assert_eq!(t2["returned"], 4);
        assert_eq!(t2["missed"], 0);
        assert_eq!(t2["nextSinceSeq"], 10);
        // 已经追平：再拉一次是空的，但 nextSinceSeq 不许倒退（否则会重复读）
        let t3 = h.tail_fmt("app", Some(10), 10, LogFormat::Json).unwrap();
        assert_eq!(t3["returned"], 0);
        assert_eq!(t3["missed"], 0);
        assert_eq!(t3["nextSinceSeq"], 10);
        // 没有 sinceSeq 就没有"窗口"这回事
        assert_eq!(h.tail("app", None, 10).unwrap()["missed"], 0);
    }

    /// `truncated` 以前额外要求 `dropped > 0`，于是"取满一页但没丢过"会**谎报 false**。
    /// 现在口径与 log_search/adb_shell_read 一致：被 `lines` 顶住就是 true。
    #[test]
    fn truncated_marks_a_capped_page_even_without_drops() {
        let h = fresh();
        h.set_enabled(true);
        for i in 0..10 {
            h.push("app", LEVEL_INFO, DIR_NONE, &format!("n{}", i), 0);
        }
        let capped = h.tail("app", None, 5).unwrap();
        assert_eq!(capped["returned"], 5);
        assert_eq!(capped["truncated"], true, "被行数顶住要如实说: {}", capped);
        assert_eq!(capped["dropped"], 0);
        assert_eq!(capped["mayBeIncomplete"], false, "没丢过就不该说'可能不完整'");
        // 一页装得下 → 不截断
        assert_eq!(h.tail("app", None, 11).unwrap()["truncated"], false);
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

    /// `count` 模式：**必须扫完**（数字精确），且不受 `limit` 影响 ——
    /// 提前 break 会让"ERROR 有几次"这种回答变成错的。
    #[test]
    fn count_mode_scans_everything_and_is_exact() {
        let h = fresh();
        h.set_enabled(true);
        for i in 0..300 {
            let text = if i % 3 == 0 { "ERROR" } else { "OK" };
            h.push("app", LEVEL_INFO, DIR_NONE, text, 0);
        }
        let c = h
            .search_with(SearchOpts {
                channel: Some("app"),
                pattern: "ERROR",
                use_regex: false,
                case_sensitive: true,
                limit: 5, // 故意比命中数小：count 不该被它截断
                mode: SearchMode::Count,
                context: 0,
            })
            .unwrap();
        assert_eq!(c["total"], 100, "300 行里每 3 行一个 ERROR: {}", c);
        assert_eq!(c["scanned"], 300);
        assert_eq!(c["channels"][0]["count"], 100);
        assert!(c.get("hits").is_none(), "count 不回命中行: {}", c);
        assert_eq!(c["mode"], "count");
    }

    /// `matches` 模式：一行命中多处就回多条，且**只回片段**；
    /// 零长匹配要跳过（否则 `a*` 这种图案会用空片段把 limit 塞满）。
    #[test]
    fn matches_mode_returns_fragments_and_skips_zero_length() {
        let h = fresh();
        h.set_enabled(true);
        h.push("app", LEVEL_INFO, DIR_NONE, "err err err", 0);
        let opts = |mode, pat: &'static str| SearchOpts {
            channel: Some("app"),
            pattern: pat,
            use_regex: true,
            case_sensitive: true,
            limit: 10,
            mode,
            context: 0,
        };
        let m = h.search_with(opts(SearchMode::Matches, "err")).unwrap();
        let hits = m["hits"].as_array().unwrap();
        assert_eq!(hits.len(), 3, "一行三处命中要回三条: {}", m);
        assert!(hits.iter().all(|x| x["match"] == "err"), "只回片段: {}", m);
        assert!(hits[0].get("text").is_none(), "不整行返回: {}", hits[0]);
        assert_eq!(m["mode"], "matches");

        // `a*` 会到处匹配空串 —— 跳过之后一条都不该有（而不是塞满 limit 条空片段）
        let z = h.search_with(opts(SearchMode::Matches, "[0-9]*")).unwrap();
        assert_eq!(z["hits"].as_array().unwrap().len(), 0, "零长匹配要跳过: {}", z);
    }

    /// 字面量模式必须真的按**字面量**处理：`+` `(` 这些元字符不许被当成正则。
    ///
    /// 旧实现走 `contains`，天然如此；现在 `matches` 模式为了拿到**字节区间**会把字面量
    /// `regex::escape` 成正则 —— 这条守着"两种模式对同一个字面量给出同样的答案"，
    /// 也守着"字面量路径不再编译正则"这个快路径（它比正则快 3 倍，见 `search_with` 注释）。
    #[test]
    fn literal_search_treats_metacharacters_as_plain_text() {
        let h = fresh();
        h.set_enabled(true);
        h.push("app", LEVEL_INFO, DIR_NONE, "at AT+CGMR done", 0);
        let s = h.search(Some("app"), "AT+CGMR", false, true, 10).unwrap();
        assert_eq!(s["hits"].as_array().unwrap().len(), 1, "字面量要能搜到: {}", s);
        let m = h
            .search_with(SearchOpts {
                channel: Some("app"),
                pattern: "AT+CGMR",
                use_regex: false,
                case_sensitive: true,
                limit: 10,
                mode: SearchMode::Matches,
                context: 0,
            })
            .unwrap();
        assert_eq!(m["hits"][0]["match"], "AT+CGMR", "matches 模式同样按字面量: {}", m);

        // 元字符自己当字面量：`([` 不是"非法正则"
        h.push("app", LEVEL_INFO, DIR_NONE, "weird ([ pattern", 0);
        let s = h.search(Some("app"), "([", false, true, 10).unwrap();
        assert_eq!(s["hits"].as_array().unwrap().len(), 1, "`([` 当字面量应能搜到: {}", s);
        // 而明确要正则时它仍然是非法正则 → 可读报错（不是 panic）
        let bad = h.search(Some("app"), "([", true, true, 10).unwrap_err();
        assert!(bad.contains("正则"), "{}", bad);
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

    /// 清空要把"丢弃账"一起归零：否则 `mayBeIncomplete` 永远是 true，这个标志就废了。
    #[test]
    fn clear_resets_the_drop_counter_so_the_flag_means_something() {
        let h = fresh();
        h.set_enabled(true);
        h.push("app", LEVEL_INFO, DIR_NONE, "a", 0);
        h.note_dropped("app", 5);
        assert_eq!(h.tail("app", None, 10).unwrap()["dropped"], 5);
        assert_eq!(h.tail("app", None, 10).unwrap()["mayBeIncomplete"], true);

        h.clear(Some("app"));

        let t = h.tail("app", None, 10).unwrap();
        assert_eq!(t["dropped"], 0, "清空后旧账不该继续挂在通道上");
        assert_eq!(t["mayBeIncomplete"], false, "空缓冲是完整的空，不是'可能不完整'");
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
