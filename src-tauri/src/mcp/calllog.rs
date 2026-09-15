//! AI 调用记录（S8）：`ai-calls.jsonl`。
//!
//! 这是"**操作记录不计入用户配置文件**"这条要求的落地点：
//!
//! | 文件 | 谁写 | 内容 |
//! |---|---|---|
//! | `config.json` | **只有用户操作** | 界面/设备设置（本模块**绝不碰它**） |
//! | `ai-config.json` | MCP 子系统 | 服务器开关/端口/token/记录设置 |
//! | `ai-calls.jsonl` | MCP 子系统 | 每次工具调用一行（追加写，崩溃不损坏已有记录） |
//!
//! 为什么用 JSONL 追加而不是写进 JSON 数组：高频追加不必重写整个文件、崩溃不损坏已有记录、
//! 外部 `grep`/`jq` 直接可读。
//!
//! **默认 `path = None`（禁用）**：单测与未启用 MCP 时绝不写用户的真实目录——
//! 只有 `McpState`/`start()` 才会把真实路径装上。

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// 记录文件名
pub const CALL_LOG_FILE: &str = "ai-calls.jsonl";
/// 读取尾部时最多回溯多少字节（避免为了查几条记录把整个文件读进来）
pub const READ_TAIL_BYTES: u64 = 2 * 1024 * 1024;
/// 单次查询/导出的最大条数
pub const MAX_QUERY_LIMIT: usize = 2000;

/// 记录设置（存在 `ai-config.json` 里）。
/// ⚠️ 必须 `rename_all = "camelCase"`：整个 JSON 表面（配置、工具入参、状态）都是 camelCase，
/// 若这里用默认的 snake_case，AI 从 `mcp_config_get` 看到 `max_file_mib` 再拿去 `mcp_config_set`
/// 就会被当成"不支持的配置项"拒掉 —— 这个坑已被测试抓到过一次。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallLogCfg {
    pub enabled: bool,
    /// 是否记录入参
    pub include_args: bool,
    /// 是否记录返回值（默认关：返回值可能很大或含敏感内容）
    pub include_results: bool,
    /// 单个入参/返回值最多记多少字符
    pub max_payload_chars: usize,
    /// 单文件上限（MB），超过即轮转。
    /// ⚠️ 显式 rename：serde 的 camelCase 会把 `max_file_mib` 变成 `maxFileMib`（小写 b），
    /// 而工具入参用的是常规写法 `maxFileMiB`；不显式指定就会"写出去的名字读不回来"。
    #[serde(rename = "maxFileMiB")]
    pub max_file_mib: u64,
    /// 轮转保留几份
    pub rotate_keep: u32,
}

impl Default for CallLogCfg {
    fn default() -> Self {
        Self {
            enabled: true,
            include_args: true,
            include_results: false,
            max_payload_chars: 2048,
            max_file_mib: 32,
            rotate_keep: 3,
        }
    }
}

impl CallLogCfg {
    fn max_bytes(&self) -> u64 {
        self.max_file_mib.max(1) * 1024 * 1024
    }
}

/// 超长时不要把整段塞进去，也不要把类型改掉：
/// 用一个带标记的对象包起来，读者一眼能看出"被截断了"。
fn fit(v: &Value, max_chars: usize) -> Value {
    let s = match serde_json::to_string(v) {
        Ok(s) => s,
        Err(_) => return json!({ "_unserializable": true }),
    };
    if s.chars().count() <= max_chars {
        return v.clone();
    }
    let mut end = max_chars.min(s.len());
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    json!({
        "_truncated": true,
        "_chars": s.chars().count(),
        "preview": &s[..end],
    })
}

/// 调用记录器
pub struct CallLog {
    /// None = 禁用（不写任何文件）
    path: Mutex<Option<PathBuf>>,
    cfg: Mutex<CallLogCfg>,
    seq: AtomicU64,
    /// 当前文件已写字节（首次用时从文件真实大小初始化）
    bytes: AtomicU64,
    written: AtomicU64,
    /// 写失败或超限被丢弃的条数
    dropped: AtomicU64,
    by_tool: Mutex<HashMap<String, u64>>,
    first_at: Mutex<Option<String>>,
    last_at: Mutex<Option<String>>,
}

impl Default for CallLog {
    fn default() -> Self {
        Self {
            path: Mutex::new(None),
            cfg: Mutex::new(CallLogCfg::default()),
            seq: AtomicU64::new(0),
            bytes: AtomicU64::new(u64::MAX), // MAX = 尚未初始化（下次写入前 stat 一次）
            written: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            by_tool: Mutex::new(HashMap::new()),
            first_at: Mutex::new(None),
            last_at: Mutex::new(None),
        }
    }
}

impl CallLog {
    /// 指向某个目录下的 `ai-calls.jsonl`（**单测专用**：生产走 `set_path`，
    /// 路径由程序按 `%APPDATA%\seahi-serial` 给出）。
    #[cfg(test)]
    pub fn in_dir(dir: &Path) -> Self {
        let s = Self::default();
        *s.path.lock().unwrap_or_else(|e| e.into_inner()) = Some(dir.join(CALL_LOG_FILE));
        s
    }

    pub fn set_path(&self, p: Option<PathBuf>) {
        *self.path.lock().unwrap_or_else(|e| e.into_inner()) = p;
        self.bytes.store(u64::MAX, Ordering::Relaxed);
    }

    pub fn set_cfg(&self, c: CallLogCfg) {
        *self.cfg.lock().unwrap_or_else(|e| e.into_inner()) = c;
    }

    pub fn cfg(&self) -> CallLogCfg {
        self.cfg.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn enabled(&self) -> bool {
        self.cfg().enabled && self.path.lock().unwrap_or_else(|e| e.into_inner()).is_some()
    }

    pub fn path_string(&self) -> Option<String> {
        self.path
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned())
    }

    /// 记一条工具调用。**失败只计数，绝不 panic**（记录日志不该影响工具本身）。
    #[allow(clippy::too_many_arguments)]
    pub fn record(
        &self,
        session: &str,
        tool: &str,
        args: &Value,
        ok: bool,
        error: Option<&str>,
        duration_ms: u64,
        effects: Option<&Value>,
        result: Option<&Value>,
    ) {
        if !self.enabled() {
            return;
        }
        let cfg = self.cfg();
        let mut rec = json!({
            "seq": self.seq.load(Ordering::Relaxed) + 1,
            "ts": chrono::Utc::now().to_rfc3339(),
            "session": session,
            "tool": tool,
            "ok": ok,
            "durationMs": duration_ms,
        });
        if cfg.include_args {
            rec["args"] = fit(args, cfg.max_payload_chars);
        }
        if let Some(e) = error {
            rec["error"] = json!(e);
        }
        if let Some(fx) = effects {
            rec["effects"] = fx.clone();
        }
        if cfg.include_results {
            if let Some(r) = result {
                rec["result"] = fit(r, cfg.max_payload_chars);
            }
        }
        let line = match serde_json::to_string(&rec) {
            Ok(s) => s,
            Err(_) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                return;
            }
        };

        let path = match self.path.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            Some(p) => p,
            None => return,
        };
        if self.append_line(&path, &line, &cfg).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            // 调用记录写不进去（磁盘满/无权限）是真实故障：AI 审计链断了要让用户知道
            super::report::report(
                "calllog_write_failed",
                &format!("写调用记录失败（文件 {}）", super::aiconfig::mask_url(&path.to_string_lossy())),
            );
            return;
        }
        self.seq.fetch_add(1, Ordering::Relaxed);
        self.written.fetch_add(1, Ordering::Relaxed);
        let ts = rec["ts"].as_str().unwrap_or("").to_string();
        {
            let mut m = self.by_tool.lock().unwrap_or_else(|e| e.into_inner());
            *m.entry(tool.to_string()).or_insert(0) += 1;
        }
        let mut f = self.first_at.lock().unwrap_or_else(|e| e.into_inner());
        if f.is_none() {
            *f = Some(ts.clone());
        }
        *self.last_at.lock().unwrap_or_else(|e| e.into_inner()) = Some(ts);
    }

    fn append_line(&self, path: &Path, line: &str, cfg: &CallLogCfg) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        // 已写字节：未知时先 stat 一次（避免每次调用都做系统调用）
        let cur = match self.bytes.load(Ordering::Relaxed) {
            u64::MAX => {
                let n = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
                self.bytes.store(n, Ordering::Relaxed);
                n
            }
            n => n,
        };
        let add = line.len() as u64 + 1;
        if cur > 0 && cur + add > cfg.max_bytes() {
            rotate(path, cfg.rotate_keep);
            self.bytes.store(0, Ordering::Relaxed);
        }
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
        f.write_all(line.as_bytes())?;
        f.write_all(b"\n")?;
        let _ = f.flush();
        let prev = self.bytes.load(Ordering::Relaxed);
        self.bytes.store(prev.saturating_add(add), Ordering::Relaxed);
        Ok(())
    }

    /// 读尾部若干行（从文件末尾回溯有限字节，避免把整个文件读进来）。
    ///
    /// 返回 `(行, 是否只读到了尾部窗口)`：后者为 true 表示**文件开头那段没被扫到**
    /// （字节窗口或行数窗口被切过）。调用方要据此说明"结果可能不全" ——
    /// 别让 `returned` 被当成"历史上就这么多"（2026-09 审计发现）。
    fn read_tail_lines(&self, max_bytes: u64, max_lines: usize) -> (Vec<Value>, bool) {
        let path = match self.path.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            Some(p) => p,
            None => return (Vec::new(), false),
        };
        let mut f = match std::fs::File::open(&path) {
            Ok(f) => f,
            Err(_) => return (Vec::new(), false),
        };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        let start = len.saturating_sub(max_bytes);
        let byte_cut = start > 0;
        if byte_cut {
            let _ = f.seek(SeekFrom::Start(start));
        }
        let mut buf = String::new();
        if f.read_to_string(&mut buf).is_err() {
            return (Vec::new(), false);
        }
        let mut lines: Vec<&str> = buf.lines().filter(|l| !l.trim().is_empty()).collect();
        // 从中间切进来的第一行可能是半行，丢掉
        if byte_cut && !lines.is_empty() {
            lines.remove(0);
        }
        let line_cut = lines.len() > max_lines;
        let skip = lines.len().saturating_sub(max_lines);
        let out = lines
            .into_iter()
            .skip(skip)
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .collect();
        (out, byte_cut || line_cut)
    }

    /// 查最近的调用记录（可按工具/成败过滤）
    pub fn recent(&self, limit: usize, tool: Option<&str>, ok_only: Option<bool>) -> Value {
        let limit = limit.clamp(1, MAX_QUERY_LIMIT);
        // 过滤后再取 limit 条：先多读一些（按工具/成败筛时可能大半不匹配）
        let (raw, tail_only) = self.read_tail_lines(READ_TAIL_BYTES, limit * 8);
        let scanned = raw.len();
        let filtered: Vec<Value> = raw
            .into_iter()
            .filter(|r| match tool {
                Some(t) => r["tool"].as_str() == Some(t),
                None => true,
            })
            .filter(|r| match ok_only {
                Some(true) => r["ok"].as_bool() == Some(true),
                Some(false) => r["ok"].as_bool() == Some(false),
                None => true,
            })
            .collect();
        let skip = filtered.len().saturating_sub(limit);
        let out: Vec<Value> = filtered.into_iter().skip(skip).collect();
        // `returned < limit` **不等于**"历史上就这么多"：窗口外可能还有匹配。
        // 老实说出来，否则调用方会拿一个被截断的结果当全量（2026-09 审计发现）。
        let note = if tail_only && out.len() < limit {
            format!(
                "只扫了文件尾部的 {} 条（按工具/成败筛过），符合的比 limit 少 —— 更早的记录里可能还有；\
                 要看全量请用 export 或直接读文件",
                scanned
            )
        } else {
            "只读文件尾部窗口；更长历史请用 export 或直接读文件".to_string()
        };
        json!({
            "calls": out,
            "returned": out.len(),
            "scanned": scanned,
            "tailOnly": tail_only,
            "file": self.path_string(),
            "enabled": self.enabled(),
            "note": note,
        })
    }

    /// 统计（内存累计，不读文件）
    pub fn stats(&self) -> Value {
        let by_tool: serde_json::Map<String, Value> = self
            .by_tool
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(k, v)| (k.clone(), json!(*v)))
            .collect();
        let cfg = self.cfg();
        // 字节数还没 stat 过时给 **null**（"未知"），不要给 u64::MAX 那种哨兵值：
        // 18446744073709551614 这种数字到了 AI 客户端那里既看不懂、又会被当成"文件巨大"。
        let raw = self.bytes.load(Ordering::Relaxed);
        let file_bytes = if raw == u64::MAX {
            Value::Null
        } else {
            json!(raw)
        };
        json!({
            "enabled": self.enabled(),
            "file": self.path_string(),
            "fileBytes": file_bytes,
            "totalCalls": self.written.load(Ordering::Relaxed),
            "seq": self.seq.load(Ordering::Relaxed),
            "dropped": self.dropped.load(Ordering::Relaxed),
            "byTool": by_tool,
            "firstAt": self.first_at.lock().unwrap_or_else(|e| e.into_inner()).clone(),
            "lastAt": self.last_at.lock().unwrap_or_else(|e| e.into_inner()).clone(),
            "settings": {
                "enabled": cfg.enabled,
                "includeArgs": cfg.include_args,
                "includeResults": cfg.include_results,
                "maxPayloadChars": cfg.max_payload_chars,
                "maxFileMiB": cfg.max_file_mib,
                "rotateKeep": cfg.rotate_keep,
            },
        })
    }

    /// 导出为纯文本（`jsonl` 原文 / `md` 表格）
    pub fn export(&self, format: &str, limit: usize) -> Value {
        let limit = limit.clamp(1, MAX_QUERY_LIMIT);
        let (raw, _tail_only) = self.read_tail_lines(READ_TAIL_BYTES, limit);
        let mut out = String::new();
        match format {
            "md" => {
                out.push_str("| 时间 | 工具 | 结果 | 耗时ms | 参数 |\n|---|---|---|---|---|\n");
                for r in &raw {
                    out.push_str(&format!(
                        "| {} | {} | {} | {} | {} |\n",
                        r["ts"].as_str().unwrap_or(""),
                        r["tool"].as_str().unwrap_or(""),
                        if r["ok"].as_bool() == Some(true) { "OK" } else { "FAIL" },
                        r["durationMs"].as_u64().unwrap_or(0),
                        r["args"]
                            .as_str()
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| r["args"].to_string())
                            .replace('|', "\\|")
                    ));
                }
            }
            _ => {
                for r in &raw {
                    out.push_str(&serde_json::to_string(r).unwrap_or_default());
                    out.push('\n');
                }
            }
        }
        json!({
            "format": format,
            "calls": raw.len(),
            "text": out,
            "truncated": raw.len() >= limit,
        })
    }
}

/// 轮转：`ai-calls.jsonl` → `.1`，`.1` → `.2` …… 只保留 `keep` 份。
/// 完全用 rename，不读文件内容（32MB 的文件不该为了轮转被读进内存）。
fn rotate(path: &Path, keep: u32) {
    if keep == 0 {
        let _ = std::fs::remove_file(path);
        return;
    }
    let base = path.to_string_lossy().into_owned();
    // 先删最旧的一份
    let _ = std::fs::remove_file(format!("{}.{}", base, keep));
    for i in (1..keep).rev() {
        let from = format!("{}.{}", base, i);
        let to = format!("{}.{}", base, i + 1);
        if std::path::Path::new(&from).exists() {
            let _ = std::fs::rename(&from, &to);
        }
    }
    let _ = std::fs::rename(path, format!("{}.1", base));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("seahi-calllog-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn disabled_log_writes_nothing() {
        let dir = tmp("disabled");
        let log = CallLog::default(); // path = None
        log.record("s", "app_info", &json!({}), true, None, 1, None, None);
        assert!(!log.enabled());
        assert_eq!(log.stats()["totalCalls"], 0);
        assert!(!dir.join(CALL_LOG_FILE).exists());
        assert!(
            !std::fs::read_dir(&dir).unwrap().any(|e| e
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("ai-calls")),
            "禁用时连文件都不该建"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn records_one_json_line_per_call() {
        let dir = tmp("basic");
        let log = CallLog::in_dir(&dir);
        log.record("sess1", "app_info", &json!({"x": 1}), true, None, 7, None, None);
        log.record("sess1", "log_tail", &json!({"channel": "app"}), false, Some("boom"), 3, None, None);

        let raw = std::fs::read_to_string(dir.join(CALL_LOG_FILE)).unwrap();
        let lines: Vec<&str> = raw.lines().collect();
        assert_eq!(lines.len(), 2, "一次调用一行");
        let a: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(a["seq"], 1);
        assert_eq!(a["tool"], "app_info");
        assert_eq!(a["ok"], true);
        assert_eq!(a["session"], "sess1");
        assert_eq!(a["durationMs"], 7);
        assert!(a["ts"].as_str().unwrap().contains('T'), "要有 RFC3339 时间戳");
        assert_eq!(a["args"]["x"], 1);
        let b: Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(b["seq"], 2);
        assert_eq!(b["ok"], false);
        assert_eq!(b["error"], "boom");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn long_args_are_truncated_with_a_marker() {
        let dir = tmp("trunc");
        let log = CallLog::in_dir(&dir);
        log.set_cfg(CallLogCfg {
            max_payload_chars: 50,
            ..Default::default()
        });
        let big = json!({ "text": "x".repeat(500) });
        log.record("s", "ui_set", &big, true, None, 1, None, None);
        let raw = std::fs::read_to_string(dir.join(CALL_LOG_FILE)).unwrap();
        let r: Value = serde_json::from_str(raw.lines().next().unwrap()).unwrap();
        assert_eq!(r["args"]["_truncated"], true, "超长入参要标记截断: {}", r["args"]);
        assert!(r["args"]["preview"].as_str().unwrap().len() <= 50);
        assert!(r["args"]["_chars"].as_u64().unwrap() > 50, "要记住原始长度");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn results_are_excluded_by_default_and_included_when_asked() {
        let dir = tmp("results");
        let log = CallLog::in_dir(&dir);
        log.record("s", "app_info", &json!({}), true, None, 1, None, Some(&json!({"secret": 42})));
        let raw = std::fs::read_to_string(dir.join(CALL_LOG_FILE)).unwrap();
        let r: Value = serde_json::from_str(raw.lines().next().unwrap()).unwrap();
        assert!(r.get("result").is_none(), "默认不记返回值: {}", r);

        let log2 = CallLog::in_dir(&dir);
        log2.set_cfg(CallLogCfg {
            include_results: true,
            ..Default::default()
        });
        // 换个文件避免与上面那条混在一起
        let dir2 = tmp("results2");
        let log3 = CallLog::in_dir(&dir2);
        log3.set_cfg(CallLogCfg {
            include_results: true,
            ..Default::default()
        });
        log3.record("s", "app_info", &json!({}), true, None, 1, None, Some(&json!({"secret": 42})));
        let raw3 = std::fs::read_to_string(dir2.join(CALL_LOG_FILE)).unwrap();
        let r3: Value = serde_json::from_str(raw3.lines().next().unwrap()).unwrap();
        assert_eq!(r3["result"]["secret"], 42);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&dir2);
        let _ = log2;
    }

    #[test]
    fn rotation_keeps_n_backups_and_stays_bounded() {
        let dir = tmp("rotate");
        let log = CallLog::in_dir(&dir);
        // 上限 1MB 太大，这里直接调 rotate 验证语义
        log.record("s", "t", &json!({"pad": "y".repeat(100)}), true, None, 1, None, None);
        rotate(&dir.join(CALL_LOG_FILE), 2);
        assert!(dir.join(format!("{}.1", CALL_LOG_FILE)).exists(), "轮转出 .1");

        for _ in 0..5 {
            rotate(&dir.join(CALL_LOG_FILE), 2);
        }
        // 只保留 base + .1 + .2
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.len() <= 3, "轮转保留份数要有界: {:?}", names);
        assert!(!names.iter().any(|n| n.ends_with(".3")), "不该出现 .3: {:?}", names);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stats_counts_by_tool_and_tracks_time_range() {
        let dir = tmp("stats");
        let log = CallLog::in_dir(&dir);
        // 还没写过任何一条时，字节数是**未知**（null），不能把 u64::MAX 哨兵值泄露出去
        let fresh = log.stats();
        assert_eq!(fresh["totalCalls"], 0);
        assert!(fresh["fileBytes"].is_null(), "未 stat 过时报 null，而不是 18446744073709551614: {}", fresh["fileBytes"]);

        log.record("s", "app_info", &json!({}), true, None, 1, None, None);
        log.record("s", "app_info", &json!({}), true, None, 2, None, None);
        log.record("s", "log_tail", &json!({}), false, Some("e"), 3, None, None);
        let st = log.stats();
        assert_eq!(st["totalCalls"], 3);
        assert_eq!(st["byTool"]["app_info"], 2);
        assert_eq!(st["byTool"]["log_tail"], 1);
        assert!(st["firstAt"].as_str().is_some());
        assert!(st["lastAt"].as_str().is_some());
        assert!(st["fileBytes"].as_u64().unwrap() > 0, "字节数要跟上");
        assert_eq!(st["settings"]["includeResults"], false);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recent_filters_by_tool_and_ok_and_returns_newest_last() {
        let dir = tmp("recent");
        let log = CallLog::in_dir(&dir);
        for i in 0..5 {
            log.record("s", if i % 2 == 0 { "a" } else { "b" }, &json!({"i": i}), i != 3, None, 1, None, None);
        }
        let all = log.recent(10, None, None);
        assert_eq!(all["calls"].as_array().unwrap().len(), 5);

        let only_a = log.recent(10, Some("a"), None);
        assert_eq!(only_a["calls"].as_array().unwrap().len(), 3);
        assert!(only_a["calls"].as_array().unwrap().iter().all(|c| c["tool"] == "a"));

        let only_fail = log.recent(10, None, Some(false));
        assert_eq!(only_fail["calls"].as_array().unwrap().len(), 1, "只有 i=3 失败");

        // 取最新的 2 条：应是 i=3、i=4
        let last2 = log.recent(2, None, None);
        let v = last2["calls"].as_array().unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(v[0]["args"]["i"], 3);
        assert_eq!(v[1]["args"]["i"], 4);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recent_skips_partial_first_line_when_reading_from_the_tail() {
        let dir = tmp("partial");
        let log = CallLog::in_dir(&dir);
        log.record("s", "t", &json!({}), true, None, 1, None, None);
        // 极小的读窗口会从中间切进来，必须丢掉那半行而不是解析失败就崩
        let (raw, tail_only) = log.read_tail_lines(30, 10);
        // 不要求一定有结果，但绝不能 panic、也不能返回半个对象
        for r in &raw {
            assert!(r.is_object());
            assert!(r["tool"].as_str().is_some());
        }
        // 30 字节的窗口必然只读到尾部 → 标志必须为真（调用方据此说清"结果可能不全"）
        assert!(tail_only, "窗口被切过就要如实报出来");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **这条是本模块存在的意义**：写调用记录绝不能碰到同目录下的用户配置。
    #[test]
    fn recording_never_touches_the_user_config_file() {
        let dir = tmp("isolation");
        let cfg_path = dir.join("config.json");
        let cfg_body = r#"{"version":2,"theme":"dark","monitors":{"main":{"port":"COM1"}}}"#;
        std::fs::write(&cfg_path, cfg_body).unwrap();
        let before_meta = std::fs::metadata(&cfg_path).unwrap();
        let before_mtime = before_meta.modified().unwrap();

        let log = CallLog::in_dir(&dir);
        for i in 0..20 {
            log.record("s", "ui_set", &json!({"i": i}), true, None, 1, None, None);
        }
        log.stats();
        log.recent(5, None, None);
        log.export("md", 5);

        // 内容与 mtime 都必须没变
        assert_eq!(std::fs::read_to_string(&cfg_path).unwrap(), cfg_body, "用户配置内容被改了！");
        let after_mtime = std::fs::metadata(&cfg_path).unwrap().modified().unwrap();
        assert_eq!(before_mtime, after_mtime, "用户配置的 mtime 变了 —— 说明被写过");

        // 记录确实写进了 ai-calls.jsonl
        assert!(dir.join(CALL_LOG_FILE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_failure_is_counted_not_panicked() {
        let dir = tmp("fail");
        // 指向一个"父路径是文件"的位置 → create_dir_all 必然失败
        let blocker = dir.join("blocker");
        std::fs::write(&blocker, "x").unwrap();
        let log = CallLog::in_dir(&blocker.join("nested"));
        log.record("s", "t", &json!({}), true, None, 1, None, None);
        let st = log.stats();
        assert_eq!(st["dropped"], 1, "写失败要计数");
        assert_eq!(st["totalCalls"], 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
