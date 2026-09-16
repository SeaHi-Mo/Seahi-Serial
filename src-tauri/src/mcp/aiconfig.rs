//! MCP 的 AI 配置文件（与用户配置 `config.json` **严格隔离**）。
//!
//! | 文件 | 内容 |
//! |---|---|
//! | `%APPDATA%\seahi-serial\ai-config.json` | MCP 服务器设置（开关 / 主机 / 端口 / token） |
//! | `%APPDATA%\seahi-serial\mcp-endpoint.json` | 发现文件：供 npm 安装器与外部工具读取当前端点 |
//!
//! 写入一律「临时文件 + rename」**原子替换**：`config.json` 曾因非原子写 + "解析失败等同首次运行"
//! 把用户配置静默清空过（TODO M7），这里不重犯。
//!
//! 所有涉及路径的函数都提供 `_in(dir)` 变体，便于单测在临时目录里跑而**绝不碰真实用户目录**。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// AI 配置文件名
pub const AI_CONFIG_FILE: &str = "ai-config.json";
/// 端点发现文件名
pub const ENDPOINT_FILE: &str = "mcp-endpoint.json";
/// 默认端口（刻意避开 3000：两个 Node 错误服务默认端口；以及 19876）
pub const DEFAULT_PORT: u16 = 7777;
/// 端口被占用时向后尝试的次数
pub const PORT_FALLBACK_RANGE: u16 = 20;
/// AI 配置 schema 版本
pub const AI_CONFIG_VERSION: u32 = 1;
/// 端点发现文件 schema 版本
pub const ENDPOINT_VERSION: u32 = 1;

/// 传输形态。**三档**，因为"同时提供两种"和"只提供一种"是两个不同的诉求：
/// - `Both`：老客户端走 SSE、新客户端走 `/mcp`，兼容性最好（**默认**，升级上来的配置不受影响）；
/// - `Http`：只服务 `/mcp`（`/sse` + `/messages` 返回 404）；
/// - `Sse`：只服务遗留 SSE（`/mcp` 返回 404）。
///
/// 后两档是"我就要一种"时用的，代价是另一种客户端会连不上 —— 所以它必须是**用户主动选的**，
/// 不能是升级带来的副作用（这正是默认取 `Both` 的原因）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransportMode {
    Both,
    Http,
    Sse,
}

impl TransportMode {
    pub fn as_str(self) -> &'static str {
        match self {
            TransportMode::Both => "both",
            TransportMode::Http => "http",
            TransportMode::Sse => "sse",
        }
    }

    /// 是否提供 Streamable HTTP（`/mcp`）
    pub fn serves_http(self) -> bool {
        matches!(self, TransportMode::Both | TransportMode::Http)
    }

    /// 是否提供遗留 SSE（`/sse` + `/messages`）
    pub fn serves_sse(self) -> bool {
        matches!(self, TransportMode::Both | TransportMode::Sse)
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "both" => Some(TransportMode::Both),
            "http" => Some(TransportMode::Http),
            "sse" => Some(TransportMode::Sse),
            _ => None,
        }
    }
}

/// MCP 服务器设置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerCfg {
    /// 是否随程序启动（用户可在弹窗里关掉）
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    /// 访问令牌；为空时会自动生成
    pub token: String,
    /// 提供哪种传输（`both` / `http` / `sse`）。`None` 只可能出现在**老配置**里，
    /// 此时由 `legacy_streamable_http` 推断（见 `transport_mode()`）。
    #[serde(default)]
    pub transport: Option<TransportMode>,
    /// **兼容字段**：本项目 0.5.7 之前只有这个 bool（`true` = 提供 `/mcp`）。
    /// 只参与反序列化推断，**写出时不再产生**（`skip_serializing`），配置里只会留 `transport`。
    #[serde(default, rename = "streamableHttp", skip_serializing)]
    pub legacy_streamable_http: Option<bool>,
}

impl ServerCfg {
    /// 实际生效的传输形态。
    ///
    /// 迁移规则（升级上来的 `ai-config.json` 只有 `streamableHttp`）：
    /// - `false` → `Sse`（用户当年主动关过 `/mcp`，这个意愿要保留）；
    /// - `true` / 字段缺失 → `Both`（**不能**因为升级就把某类客户端挡在门外）。
    pub fn transport_mode(&self) -> TransportMode {
        self.transport.unwrap_or(match self.legacy_streamable_http {
            Some(false) => TransportMode::Sse,
            _ => TransportMode::Both,
        })
    }

    /// 设置传输形态，并清掉兼容字段（下次写盘就只有 `transport` 了）
    pub fn set_transport_mode(&mut self, m: TransportMode) {
        self.transport = Some(m);
        self.legacy_streamable_http = None;
    }
}

impl Default for ServerCfg {
    fn default() -> Self {
        Self {
            enabled: true,
            host: "127.0.0.1".to_string(),
            port: DEFAULT_PORT,
            token: String::new(),
            transport: Some(TransportMode::Both),
            legacy_streamable_http: None,
        }
    }
}

/// 工具暴露策略（§5.6 / D2）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExposeCfg {
    /// 是否把**每一个控件**都生成一个 `ctl_*` 工具。
    /// 默认关：一次性几百个工具会明显拖累模型选工具的准确率（§5.6 的取舍）。
    pub auto_control_tools: bool,
    /// 只暴露这些面板的控件工具；空数组 = 全部面板
    pub namespaces: Vec<String>,
    /// **只读（沙箱）模式**：打开后所有写操作（`ui_set`/`ui_click`/`serial_open`/`serial_send`/
    /// `log_clear`/`mcp_config_set`/带 index 的 `serial_quick_cmd`/`ctl_*`）**一律拒绝执行**，
    /// 界面与配置一个字都不改。给"让 AI 先自由探索、确认无误再放开"用。
    ///
    /// `#[serde(default)]`：老配置文件里没有这个字段也能直接升级（默认关）。
    #[serde(default)]
    pub read_only: bool,
}

impl Default for ExposeCfg {
    fn default() -> Self {
        Self {
            auto_control_tools: false,
            namespaces: Vec::new(),
            // 默认**关**：默认拒绝一切写操作会让"开箱即用"变成"怎么都改不动"，
            // 而它本来是为了安全/探索才手动打开的开关。
            read_only: false,
        }
    }
}

/// `ai-config.json` 的顶层结构
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConfig {
    pub version: u32,
    pub server: ServerCfg,
    /// 调用记录设置。`#[serde(default)]` 保证老版本（没有这个字段的）配置文件能直接升级
    #[serde(default, rename = "callLog")]
    pub call_log: crate::mcp::calllog::CallLogCfg,
    /// 工具暴露策略
    #[serde(default)]
    pub expose: ExposeCfg,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            version: AI_CONFIG_VERSION,
            server: ServerCfg::default(),
            call_log: crate::mcp::calllog::CallLogCfg::default(),
            expose: ExposeCfg::default(),
        }
    }
}

/// 生成新的访问令牌（64 位十六进制 = 两个 UUIDv4 的熵，约 244 bit）
pub fn new_token() -> String {
    let a = uuid::Uuid::new_v4().simple().to_string();
    let b = uuid::Uuid::new_v4().simple().to_string();
    format!("{}{}", a, b)
}

/// 用户配置目录（复用 main.rs 里既有的实现，不另拼一套）
pub fn config_dir() -> Option<PathBuf> {
    crate::dirs_config_path()
}

pub fn ai_config_path() -> Option<PathBuf> {
    config_dir().map(|d| d.join(AI_CONFIG_FILE))
}

pub fn endpoint_path() -> Option<PathBuf> {
    config_dir().map(|d| d.join(ENDPOINT_FILE))
}

/// 原子写：临时文件 → rename 覆盖。失败不会留下半截文件。
fn write_atomic(path: &Path, data: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, data).map_err(|e| format!("写入临时文件失败: {}", e))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("替换文件失败: {}", e)
    })
}

/// 从指定目录读取 AI 配置。
/// **读失败或解析失败时返回默认值，但绝不回写覆盖原文件**（避免把用户的东西擦掉）。
pub fn load_in(dir: &Path) -> AiConfig {
    let path = dir.join(AI_CONFIG_FILE);
    match std::fs::read_to_string(&path) {
        Ok(s) => match serde_json::from_str::<AiConfig>(&s) {
            Ok(mut cfg) => {
                // **规范化**：老配置里只有 `streamableHttp` 这个 bool，这里把它的意愿
                // **落成**新字段 `transport` 的实际值，并清掉兼容字段。
                //
                // 为什么必须放在读入口、而不是只在序列化端处理：只有这里同时看得到两个字段。
                // 否则「写成 `transport: null` → 读回来还是 None → 又推断成 Both」——
                // 用户当年主动关掉 `/mcp`（或将来改成只 SSE）的意愿会在一次读写之间被**静默丢掉**。
                let mode = cfg.server.transport_mode();
                cfg.server.set_transport_mode(mode);
                cfg
            }
            Err(e) => {
                crate::dbg_log(&format!(
                    "mcp: ai-config.json 解析失败（保留原文件，本次用默认值）: {}",
                    e
                ));
                AiConfig::default()
            }
        },
        Err(_) => AiConfig::default(),
    }
}

pub fn save_in(dir: &Path, cfg: &AiConfig) -> Result<(), String> {
    let s = serde_json::to_string_pretty(cfg).map_err(|e| format!("序列化失败: {}", e))?;
    write_atomic(&dir.join(AI_CONFIG_FILE), &s)
}

/// 读取真实位置的 AI 配置
pub fn load() -> AiConfig {
    match config_dir() {
        Some(d) => load_in(&d),
        None => AiConfig::default(),
    }
}

/// 写入真实位置的 AI 配置
pub fn save(cfg: &AiConfig) -> Result<(), String> {
    let dir = config_dir().ok_or_else(|| "找不到配置目录".to_string())?;
    save_in(&dir, cfg)
}

/// 端点发现文件的内容
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Endpoint {
    pub version: u32,
    /// 应用当前提供的传输：`both` / `http` / `sse`。
    /// 老版本的发现文件里没有这一项，`default` 保证外部工具读到旧文件也能解析
    /// （那时按"两个 URL 哪个非空"判断即可）。
    #[serde(default)]
    pub transport: String,
    /// 遗留 SSE 传输：`GET /sse?token=…`。**不提供 SSE 时是空串**。
    pub url: String,
    /// Streamable HTTP 传输：`POST /mcp?token=…`（MCP 2025-03-26+）。**不提供时是空串**。
    #[serde(rename = "urlStreamable", default)]
    pub url_streamable: String,
    pub host: String,
    pub port: u16,
    #[serde(rename = "appVersion")]
    pub app_version: String,
    pub pid: u32,
    #[serde(rename = "startedAt")]
    pub started_at: String,
}

/// 写出端点发现文件（服务器起来后调用）。
///
/// ⚠️ 按 `mode` 决定写哪条 URL：只提供一种时**另一条写空串而不是留个连不上的地址** ——
/// 外部工具（npm 安装器）据此就能立刻说出"应用当前只提供 X"，而不是让人拿一个 404 地址去配。
pub fn write_endpoint_in(
    dir: &Path,
    host: &str,
    port: u16,
    token: &str,
    mode: TransportMode,
) -> Result<(), String> {
    let ep = Endpoint {
        version: ENDPOINT_VERSION,
        transport: mode.as_str().to_string(),
        url: if mode.serves_sse() {
            sse_url(host, port, token)
        } else {
            String::new()
        },
        url_streamable: if mode.serves_http() {
            http_url(host, port, token)
        } else {
            String::new()
        },
        host: host.to_string(),
        port,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        pid: std::process::id(),
        started_at: chrono::Utc::now().to_rfc3339(),
    };
    let s = serde_json::to_string_pretty(&ep).map_err(|e| format!("序列化失败: {}", e))?;
    write_atomic(&dir.join(ENDPOINT_FILE), &s)
}

/// 删除端点发现文件（服务器停止后调用；文件不存在不算错）
pub fn remove_endpoint_in(dir: &Path) {
    let _ = std::fs::remove_file(dir.join(ENDPOINT_FILE));
}

/// 在真实位置写端点发现文件
pub fn write_endpoint(
    host: &str,
    port: u16,
    token: &str,
    mode: TransportMode,
) -> Result<(), String> {
    let dir = config_dir().ok_or_else(|| "找不到配置目录".to_string())?;
    write_endpoint_in(&dir, host, port, token, mode)
}

/// 在真实位置删除端点发现文件
pub fn remove_endpoint() {
    if let Some(dir) = config_dir() {
        remove_endpoint_in(&dir);
    }
}

/// 把监听地址变成 URL 里合法的 host。
///
/// IPv6 字面量**必须**带方括号：`http://::1:7777/sse` 里的 `::1:7777` 根本解析不出来
/// （`server.host` 是允许 `::1` 的，所以这条不是理论问题 —— 不修的话，选 ::1 的用户
/// 拿到的两个 URL 全是打不开的）。
fn host_in_url(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{}]", host)
    } else {
        host.to_string()
    }
}

/// 组装遗留 SSE 端点 URL（token 放在查询串里：遗留 SSE 客户端不一定能带自定义 Header）
pub fn sse_url(host: &str, port: u16, token: &str) -> String {
    format!("http://{}:{}/sse?token={}", host_in_url(host), port, token)
}

/// 组装 Streamable HTTP 端点 URL（MCP 2025-03-26+ 的单端点形态，`POST /mcp`）。
///
/// token 同样放在查询串里：这样**同一份 URL**对"只会配 headers 的客户端"和
/// "只会配 url 的客户端"都能用（`Authorization: Bearer` 也照样支持，见 `transport::token_from`）。
pub fn http_url(host: &str, port: u16, token: &str) -> String {
    format!("http://{}:{}/mcp?token={}", host_in_url(host), port, token)
}

/// 掩码显示 token（用于日志/界面默认展示，避免泄进终端回滚缓冲或 AI 对话记录）
pub fn mask_token(token: &str) -> String {
    if token.len() <= 4 {
        return "****".to_string();
    }
    format!("…{}", &token[token.len() - 4..])
}

/// 掩码 URL 里的 token（对外返回状态时用：调用方其实已经知道 token 了，但没必要回显）
pub fn mask_url(url: &str) -> String {
    match url.find("token=") {
        Some(i) => {
            let head = &url[..i + 6];
            let tok = &url[i + 6..];
            format!("{}{}", head, mask_token(tok))
        }
        None => url.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("seahi-ai-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn defaults_are_loopback_and_enabled() {
        let c = AiConfig::default();
        assert!(c.server.enabled, "默认应随程序启动");
        assert_eq!(c.server.host, "127.0.0.1", "绝不能默认监听 0.0.0.0");
        assert_eq!(c.server.port, DEFAULT_PORT);
        assert_eq!(c.version, AI_CONFIG_VERSION);
        assert_ne!(c.server.port, 3000, "3000 被错误上报服务占用");
        assert_ne!(c.server.port, 19876, "19876 被 wsl-daemon 占用");
    }

    #[test]
    fn save_load_roundtrip_is_atomic() {
        let dir = tmp("roundtrip");
        let mut cfg = AiConfig::default();
        cfg.server.token = "abc123".into();
        cfg.server.port = 8123;
        save_in(&dir, &cfg).expect("保存应成功");

        let back = load_in(&dir);
        assert_eq!(back.server.token, "abc123");
        assert_eq!(back.server.port, 8123);
        // 临时文件不能留在目录里
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "不应残留临时文件: {:?}", leftovers);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_config_falls_back_without_destroying_file() {
        let dir = tmp("corrupt");
        let path = dir.join(AI_CONFIG_FILE);
        std::fs::write(&path, "{ 这不是 JSON").unwrap();

        let cfg = load_in(&dir);
        assert!(cfg.server.enabled, "解析失败应回退默认值");

        // 关键：原文件必须原样保留（不能像 config.json 那样被静默清空）
        let raw = std::fs::read_to_string(&path).unwrap();
        assert_eq!(raw, "{ 这不是 JSON", "坏文件必须原样保留，绝不覆盖");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_config_yields_defaults_without_creating_file() {
        let dir = tmp("missing");
        let cfg = load_in(&dir);
        assert!(cfg.server.enabled);
        assert!(
            !dir.join(AI_CONFIG_FILE).exists(),
            "只读操作不应顺手创建配置文件"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn token_is_long_random_and_masked() {
        let a = new_token();
        let b = new_token();
        assert_eq!(a.len(), 64, "64 位十六进制");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b, "两次生成必须不同");
        assert_eq!(
            mask_token(&a).chars().count(),
            5,
            "掩码是「…」+ 末 4 位；注意 len() 是字节数（… 占 3 字节），要用 chars().count()"
        );
        assert!(mask_token(&a).ends_with(&a[a.len() - 4..]));
        assert_eq!(mask_token("ab"), "****");
    }

    #[test]
    fn endpoint_file_carries_url_and_pid() {
        let dir = tmp("endpoint");
        write_endpoint_in(&dir, "127.0.0.1", 7777, "tok", TransportMode::Both).unwrap();
        let s = std::fs::read_to_string(dir.join(ENDPOINT_FILE)).unwrap();
        let ep: Endpoint = serde_json::from_str(&s).unwrap();
        assert_eq!(ep.url, "http://127.0.0.1:7777/sse?token=tok");
        // Streamable HTTP 也要写进发现文件：npm 安装器要按它生成 `"type":"http"` 的客户端配置
        assert_eq!(ep.url_streamable, "http://127.0.0.1:7777/mcp?token=tok");
        assert_eq!(ep.transport, "both");
        assert_eq!(ep.port, 7777);
        assert_eq!(ep.pid, std::process::id());
        assert_eq!(ep.version, ENDPOINT_VERSION);
        remove_endpoint_in(&dir);
        assert!(!dir.join(ENDPOINT_FILE).exists(), "停止后应删除发现文件");
        remove_endpoint_in(&dir); // 幂等：文件不存在也不该 panic
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 只提供一种时，**另一条 URL 必须是空串** —— 留个连不上的地址等于让人白配一遍
    #[test]
    fn endpoint_omits_the_url_of_a_disabled_transport() {
        let dir = tmp("endpoint-http-only");
        write_endpoint_in(&dir, "127.0.0.1", 7777, "tok", TransportMode::Http).unwrap();
        let ep: Endpoint =
            serde_json::from_str(&std::fs::read_to_string(dir.join(ENDPOINT_FILE)).unwrap()).unwrap();
        assert_eq!(ep.transport, "http");
        assert_eq!(ep.url, "", "只提供 /mcp 时不该给出 SSE 地址");
        assert!(ep.url_streamable.ends_with("/mcp?token=tok"));

        write_endpoint_in(&dir, "127.0.0.1", 7777, "tok", TransportMode::Sse).unwrap();
        let ep: Endpoint =
            serde_json::from_str(&std::fs::read_to_string(dir.join(ENDPOINT_FILE)).unwrap()).unwrap();
        assert_eq!(ep.transport, "sse");
        assert!(ep.url.ends_with("/sse?token=tok"));
        assert_eq!(ep.url_streamable, "", "只提供 SSE 时不该给出 /mcp 地址");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 旧版本的发现文件里没有 `urlStreamable` / `transport` —— 外部工具读到它不能直接崩
    #[test]
    fn endpoint_without_streamable_field_still_parses() {
        let old = r#"{"version":1,"url":"http://127.0.0.1:7777/sse?token=t",
            "host":"127.0.0.1","port":7777,"appVersion":"0.0.0","pid":1,"startedAt":"x"}"#;
        let ep: Endpoint = serde_json::from_str(old).expect("老发现文件必须仍能解析");
        assert_eq!(ep.url_streamable, "");
        assert_eq!(ep.transport, "", "老文件没有这个字段，读成空串（按 URL 是否为空判断即可）");
    }

    #[test]
    fn sse_url_puts_token_in_query() {
        // 遗留 SSE 客户端不一定能带自定义 Header，所以 token 必须在 URL 里
        let u = sse_url("127.0.0.1", 7777, "T");
        assert!(u.starts_with("http://127.0.0.1:7777/sse?token="));
        assert!(u.ends_with("T"));
    }

    #[test]
    fn http_url_points_at_the_single_mcp_endpoint() {
        let u = http_url("127.0.0.1", 7777, "T");
        assert_eq!(u, "http://127.0.0.1:7777/mcp?token=T");
    }

    /// `server.host` 允许 `::1`，但 IPv6 字面量在 URL 里必须带方括号，
    /// 否则用户拿到的是一个语法上就解析不了的地址（两个传输都一样）。
    #[test]
    fn ipv6_host_gets_brackets_in_both_urls() {
        assert_eq!(sse_url("::1", 7777, "T"), "http://[::1]:7777/sse?token=T");
        assert_eq!(http_url("::1", 7777, "T"), "http://[::1]:7777/mcp?token=T");
        // localhost / 127.0.0.1 不该被动到
        assert_eq!(sse_url("localhost", 1, "T"), "http://localhost:1/sse?token=T");
    }

    #[test]
    fn transport_mode_helpers_agree() {
        assert!(TransportMode::Both.serves_http() && TransportMode::Both.serves_sse());
        assert!(TransportMode::Http.serves_http() && !TransportMode::Http.serves_sse());
        assert!(!TransportMode::Sse.serves_http() && TransportMode::Sse.serves_sse());
        assert_eq!(TransportMode::parse(" HTTP "), Some(TransportMode::Http));
        assert_eq!(TransportMode::parse("sse"), Some(TransportMode::Sse));
        assert_eq!(TransportMode::parse("ws"), None);
    }

    /// **升级路径**：老配置只有 `streamableHttp` 这个 bool，读进来要正确迁移。
    /// 关键有两条：① 不能因为升级就把某类客户端挡在门外（所以默认是 `Both`）；
    /// ② 用户当年主动关过 `/mcp` 的意愿**不能在写回一轮之后丢掉**。
    #[test]
    fn old_config_migrates_transport_mode() {
        let dir = tmp("migrate-transport");
        let path = dir.join(AI_CONFIG_FILE);

        // ① 完全没有这个字段（0.5.7 之前的老配置）→ 两种都提供
        std::fs::write(
            &path,
            r#"{"version":1,"server":{"enabled":true,"host":"127.0.0.1","port":7777,"token":"t"}}"#,
        )
        .unwrap();
        assert_eq!(
            load_in(&dir).server.transport_mode(),
            TransportMode::Both,
            "升级不能悄悄关掉任何一条传输"
        );

        // ② 显式 true → Both
        std::fs::write(
            &path,
            r#"{"version":1,"server":{"enabled":true,"host":"127.0.0.1","port":7777,"token":"t","streamableHttp":true}}"#,
        )
        .unwrap();
        assert_eq!(load_in(&dir).server.transport_mode(), TransportMode::Both);

        // ③ 用户主动关过 /mcp → 必须是 Sse，**而且写回一轮后还得是 Sse**
        std::fs::write(
            &path,
            r#"{"version":1,"server":{"enabled":true,"host":"127.0.0.1","port":7777,"token":"t","streamableHttp":false}}"#,
        )
        .unwrap();
        let cfg = load_in(&dir);
        assert_eq!(cfg.server.transport_mode(), TransportMode::Sse);
        save_in(&dir, &cfg).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"transport\": \"sse\""), "迁移后要落成新字段：{}", raw);
        assert!(!raw.contains("streamableHttp"), "老字段不该再写回：{}", raw);
        assert_eq!(
            load_in(&dir).server.transport_mode(),
            TransportMode::Sse,
            "第二轮读取必须还是 sse —— 这里丢过一次就会变成 both"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn transport_mode_roundtrips_and_clears_the_legacy_field() {
        let dir = tmp("transport-roundtrip");
        for mode in [TransportMode::Both, TransportMode::Http, TransportMode::Sse] {
            let mut cfg = AiConfig::default();
            cfg.server.set_transport_mode(mode);
            save_in(&dir, &cfg).unwrap();
            let back = load_in(&dir);
            assert_eq!(back.server.transport_mode(), mode, "{:?} 没 round-trip 回来", mode);
            assert!(back.server.legacy_streamable_http.is_none());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
