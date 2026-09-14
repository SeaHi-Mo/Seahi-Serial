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

/// MCP 服务器设置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerCfg {
    /// 是否随程序启动（用户可在弹窗里关掉）
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    /// 访问令牌；为空时会自动生成
    pub token: String,
}

impl Default for ServerCfg {
    fn default() -> Self {
        Self {
            enabled: true,
            host: "127.0.0.1".to_string(),
            port: DEFAULT_PORT,
            token: String::new(),
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
            Ok(cfg) => cfg,
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
    pub url: String,
    pub host: String,
    pub port: u16,
    #[serde(rename = "appVersion")]
    pub app_version: String,
    pub pid: u32,
    #[serde(rename = "startedAt")]
    pub started_at: String,
}

/// 写出端点发现文件（服务器起来后调用）
pub fn write_endpoint_in(dir: &Path, host: &str, port: u16, token: &str) -> Result<(), String> {
    let ep = Endpoint {
        version: ENDPOINT_VERSION,
        url: sse_url(host, port, token),
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
pub fn write_endpoint(host: &str, port: u16, token: &str) -> Result<(), String> {
    let dir = config_dir().ok_or_else(|| "找不到配置目录".to_string())?;
    write_endpoint_in(&dir, host, port, token)
}

/// 在真实位置删除端点发现文件
pub fn remove_endpoint() {
    if let Some(dir) = config_dir() {
        remove_endpoint_in(&dir);
    }
}

/// 组装 SSE 端点 URL（token 放在查询串里：遗留 SSE 客户端不一定能带自定义 Header）
pub fn sse_url(host: &str, port: u16, token: &str) -> String {
    format!("http://{}:{}/sse?token={}", host, port, token)
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
        write_endpoint_in(&dir, "127.0.0.1", 7777, "tok").unwrap();
        let s = std::fs::read_to_string(dir.join(ENDPOINT_FILE)).unwrap();
        let ep: Endpoint = serde_json::from_str(&s).unwrap();
        assert_eq!(ep.url, "http://127.0.0.1:7777/sse?token=tok");
        assert_eq!(ep.port, 7777);
        assert_eq!(ep.pid, std::process::id());
        assert_eq!(ep.version, ENDPOINT_VERSION);
        remove_endpoint_in(&dir);
        assert!(!dir.join(ENDPOINT_FILE).exists(), "停止后应删除发现文件");
        remove_endpoint_in(&dir); // 幂等：文件不存在也不该 panic
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sse_url_puts_token_in_query() {
        // 遗留 SSE 客户端不一定能带自定义 Header，所以 token 必须在 URL 里
        let u = sse_url("127.0.0.1", 7777, "T");
        assert!(u.starts_with("http://127.0.0.1:7777/sse?token="));
        assert!(u.ends_with("T"));
    }
}
