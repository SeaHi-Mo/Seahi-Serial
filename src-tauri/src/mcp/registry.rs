//! 控件注册表的**服务端视图**（S6）：前端上报 → 后端生成 `ctl_*` 工具。
//!
//! 为什么要有这一层：MCP 客户端要先 `tools/list` 才知道有哪些工具，而工具列表必须由**服务端**给出。
//! 控件注册表的真源在界面（只有它知道当前有哪些面板、哪些控件可见），所以前端在注册表变化时
//! 把一份**精简描述**（不含 DOM 句柄）报上来，这里缓存并据此生成工具定义。
//!
//! 生成规则：
//! - 工具名 `ctl_` + 路径里的非字母数字换成 `_`（MCP 客户端不允许工具名带点号）；
//! - ≤64 字符（超长截断），**并保证唯一**（截断后可能撞名，撞了就加序号）；
//! - 入参 schema 按控件类型派生：按钮/开关是布尔、下拉给出 `enum`、数字是 number、其余是字符串。

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// 一条上报的控件（对应前端 `MCP_REGISTRY` 的条目，但去掉 DOM 句柄）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEntry {
    pub path: String,
    pub kind: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub panel: String,
    #[serde(default)]
    pub group: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub disabled_reason: Option<String>,
    /// 下拉类控件的可选值（来自界面上的 `.sel-opt`），直接作为 `enum` 暴露给 AI
    #[serde(default)]
    pub options: Vec<String>,
}

fn default_true() -> bool {
    true
}

/// 工具名上限（MCP 客户端约束）
pub const MAX_TOOL_NAME_LEN: usize = 64;
/// 留出加序号的余量
const NAME_BUDGET: usize = 58;

/// 路径 → 工具名（纯函数，便于单测）
pub fn tool_name_for(path: &str) -> String {
    let mut s = String::from("ctl_");
    for c in path.chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c.to_ascii_lowercase());
        } else {
            s.push('_');
        }
    }
    while s.ends_with('_') {
        s.pop();
    }
    // 连续下划线收成一个，读起来更清楚
    let mut out = String::with_capacity(s.len());
    let mut prev_us = false;
    for c in s.chars() {
        if c == '_' {
            if !prev_us {
                out.push(c);
            }
            prev_us = true;
        } else {
            out.push(c);
            prev_us = false;
        }
    }
    if out.len() > NAME_BUDGET {
        out.truncate(NAME_BUDGET);
    }
    out
}

/// 按控件类型派生入参 schema
pub fn schema_for(kind: &str, options: &[String]) -> Value {
    match kind {
        "button" | "toggle" => json!({
            "type": "object",
            "properties": {
                "value": { "type": "boolean", "description": "true=点击/打开、false=关闭；可省略（默认 true）" }
            },
            "additionalProperties": false
        }),
        "checkbox" | "radio" => json!({
            "type": "object",
            "properties": { "value": { "type": "boolean" } },
            "required": ["value"],
            "additionalProperties": false
        }),
        "number" | "range" => json!({
            "type": "object",
            "properties": { "value": { "type": "number" } },
            "required": ["value"],
            "additionalProperties": false
        }),
        "select" if !options.is_empty() => json!({
            "type": "object",
            "properties": { "value": { "type": "string", "enum": options } },
            "required": ["value"],
            "additionalProperties": false
        }),
        _ => json!({
            "type": "object",
            "properties": { "value": { "type": "string", "description": "新值（文本）" } },
            "required": ["value"],
            "additionalProperties": false
        }),
    }
}

/// 注册表缓存
#[derive(Default)]
pub struct RegistryCache {
    entries: Mutex<Vec<RegistryEntry>>,
    /// 工具名 → 控件路径
    names: Mutex<HashMap<String, String>>,
    updated_at: Mutex<Option<String>>,
}

impl RegistryCache {
    /// 用前端上报的整份列表替换缓存。返回条目数。
    pub fn replace(&self, entries: Vec<RegistryEntry>) -> usize {
        self.replace_and_diff(entries).0
    }

    /// 同上，但额外告诉调用方**工具名集合是否变了** ——
    /// 变了才需要给客户端发 `notifications/tools/list_changed`（不然就是无意义地打扰它）。
    pub fn replace_and_diff(&self, entries: Vec<RegistryEntry>) -> (usize, bool) {
        let before: HashSet<String> = self
            .names
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect();
        let mut names: HashMap<String, String> = HashMap::new();
        let mut used: HashSet<String> = HashSet::new();
        for e in &entries {
            let base = tool_name_for(&e.path);
            let mut n = base.clone();
            let mut i = 2;
            // 截断或不同路径清洗后可能撞名 → 加序号保证唯一
            while used.contains(&n) {
                n = format!("{}_{}", base, i);
                i += 1;
            }
            used.insert(n.clone());
            names.insert(n, e.path.clone());
        }
        let changed = before != used;
        let n = entries.len();
        *self.entries.lock().unwrap_or_else(|e| e.into_inner()) = entries;
        *self.names.lock().unwrap_or_else(|e| e.into_inner()) = names;
        *self.updated_at.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(chrono::Utc::now().to_rfc3339());
        (n, changed)
    }

    pub fn len(&self) -> usize {
        self.entries.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn updated_at(&self) -> Option<String> {
        self.updated_at
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn entries(&self) -> Vec<RegistryEntry> {
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 工具名 → 控件路径
    pub fn path_for_tool(&self, tool: &str) -> Option<String> {
        self.names
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(tool)
            .cloned()
    }

    /// 某个面板下的条目数（供概览展示）
    pub fn panel_counts(&self) -> Value {
        let e = self.entries();
        let mut m: HashMap<String, u64> = HashMap::new();
        for it in &e {
            *m.entry(it.panel.clone()).or_insert(0) += 1;
        }
        let obj: serde_json::Map<String, Value> =
            m.into_iter().map(|(k, v)| (k, json!(v))).collect();
        json!(obj)
    }

    /// 生成 `ctl_*` 工具定义。
    /// `namespaces` 非空时只暴露这些面板的工具；`page`/`limit` 用于分页。
    pub fn tools(&self, namespaces: &[String], page: usize, limit: usize) -> (Vec<Value>, Option<String>, usize) {
        let entries = self.entries();
        let filtered: Vec<&RegistryEntry> = entries
            .iter()
            .filter(|e| namespaces.is_empty() || namespaces.iter().any(|n| n == &e.panel))
            .collect();
        let total = filtered.len();
        let names = self.names.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let page = page.min(total);
        let end = (page + limit).min(total);
        let mut out: Vec<Value> = Vec::new();
        for e in filtered.iter().take(end).skip(page) {
            let tool_name = names
                .iter()
                .find(|(_, p)| *p == &e.path)
                .map(|(n, _)| n.clone())
                .unwrap_or_else(|| tool_name_for(&e.path));
            let mut desc = format!(
                "界面控件 [{}]（{}·{}，类型 {}）",
                if e.label.is_empty() { &e.path } else { &e.label },
                e.panel,
                e.group,
                e.kind
            );
            if !e.enabled {
                desc.push_str(&format!(
                    "。⚠️ 当前不可用：{}",
                    e.disabled_reason.clone().unwrap_or_else(|| "未说明原因".into())
                ));
            }
            out.push(json!({
                "name": tool_name,
                "description": desc,
                "inputSchema": schema_for(&e.kind, &e.options),
            }));
        }
        let next = if end < total {
            Some(end.to_string())
        } else {
            None
        };
        (out, next, total)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, kind: &str, panel: &str) -> RegistryEntry {
        RegistryEntry {
            path: path.into(),
            kind: kind.into(),
            label: format!("标签{}", path),
            panel: panel.into(),
            group: "conn".into(),
            enabled: true,
            disabled_reason: None,
            options: vec![],
        }
    }

    #[test]
    fn tool_names_are_client_safe() {
        // MCP 客户端只接受 [A-Za-z0-9_-] 且不能用点号
        let n = tool_name_for("serial.conn.portSelect");
        assert_eq!(n, "ctl_serial_conn_portselect");
        assert!(n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));
        assert!(n.len() <= MAX_TOOL_NAME_LEN);
        // 非法字符会被换掉
        assert_eq!(tool_name_for("ble:rx/odd name"), "ctl_ble_rx_odd_name");
        // 连续下划线归一
        assert_eq!(tool_name_for("a..b"), "ctl_a_b");
        // 结尾不留下划线
        assert!(!tool_name_for("a.").ends_with('_'));
    }

    #[test]
    fn long_names_are_truncated_within_limit() {
        let long = "x".repeat(200);
        let n = tool_name_for(&format!("panel.{}.name", long));
        assert!(n.len() <= NAME_BUDGET, "超长必须截断: {} ({})", n.len(), n);
    }

    #[test]
    fn colliding_names_get_a_suffix_and_stay_unique() {
        let c = RegistryCache::default();
        // 两个不同路径清洗后同名（大小写 + 分隔符差异）
        let n = c.replace(vec![
            entry("serial.conn.port", "select", "serial"),
            entry("serial.conn.PORT", "select", "serial"),
            entry("serial.conn_port", "select", "serial"),
        ]);
        assert_eq!(n, 3);
        let used = c.names.lock().unwrap();
        let unique: HashSet<&String> = used.keys().collect();
        assert_eq!(unique.len(), 3, "工具名必须唯一: {:?}", used.keys().collect::<Vec<_>>());
        let paths: Vec<&String> = used.values().collect();
        assert_eq!(paths.len(), 3, "三条路径都要能找回");
    }

    #[test]
    fn schema_is_derived_from_kind() {
        assert_eq!(schema_for("button", &[])["properties"]["value"]["type"], "boolean");
        assert_eq!(schema_for("toggle", &[])["properties"]["value"]["type"], "boolean");
        assert_eq!(schema_for("checkbox", &[])["required"][0], "value");
        assert_eq!(schema_for("number", &[])["properties"]["value"]["type"], "number");
        // 下拉必须把可选值给出来，否则 AI 只能猜
        let s = schema_for("select", &["COM1".into(), "COM3".into()]);
        assert_eq!(s["properties"]["value"]["enum"][1], "COM3");
        // 没有选项的下拉退化成字符串（总不能给个空 enum）
        let s2 = schema_for("select", &[]);
        assert!(s2["properties"]["value"]["enum"].is_null());
        assert_eq!(schema_for("text", &[])["properties"]["value"]["type"], "string");
    }

    #[test]
    fn tools_are_generated_with_labels_and_disabled_reason() {
        let c = RegistryCache::default();
        let mut off = entry("serial.conn.btnStart", "button", "serial");
        off.enabled = false;
        off.disabled_reason = Some("串口未连接".into());
        c.replace(vec![entry("serial.conn.portSelect", "select", "serial"), off]);

        let (tools, next, total) = c.tools(&[], 0, 50);
        assert_eq!(total, 2);
        assert!(next.is_none(), "不足一页不该给游标");
        let names: Vec<String> = tools
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect();
        assert!(names.contains(&"ctl_serial_conn_portselect".to_string()));
        let btn = tools.iter().find(|t| t["name"] == "ctl_serial_conn_btnstart").unwrap();
        assert!(
            btn["description"].as_str().unwrap().contains("串口未连接"),
            "不可用的原因要写进描述，AI 才不用盲试: {}",
            btn["description"]
        );
    }

    #[test]
    fn namespaces_filter_and_pagination_work() {
        let c = RegistryCache::default();
        c.replace(vec![
            entry("serial.conn.a", "button", "serial"),
            entry("serial.conn.b", "button", "serial"),
            entry("ble.scan.c", "button", "ble"),
        ]);
        let (only_ble, _, total) = c.tools(&["ble".to_string()], 0, 50);
        assert_eq!(total, 1);
        assert_eq!(only_ble[0]["name"], "ctl_ble_scan_c");

        let (page1, next1, total2) = c.tools(&[], 0, 2);
        assert_eq!(total2, 3);
        assert_eq!(page1.len(), 2);
        assert_eq!(next1.as_deref(), Some("2"));
        let (page2, next2, _) = c.tools(&[], 2, 2);
        assert_eq!(page2.len(), 1, "第二页只剩 1 条");
        assert!(next2.is_none(), "到底了不该再给游标");
        // 两页不重复
        assert_ne!(page1[0]["name"], page2[0]["name"]);
    }

    #[test]
    fn path_lookup_round_trips() {
        let c = RegistryCache::default();
        c.replace(vec![entry("serial.conn.portSelect", "select", "serial")]);
        assert_eq!(
            c.path_for_tool("ctl_serial_conn_portselect").as_deref(),
            Some("serial.conn.portSelect")
        );
        assert!(c.path_for_tool("ctl_nope").is_none());
    }

    #[test]
    fn diff_reports_whether_the_tool_set_changed() {
        let c = RegistryCache::default();
        let (n, changed) = c.replace_and_diff(vec![entry("a.b.c", "button", "serial")]);
        assert_eq!(n, 1);
        assert!(changed, "第一次上报就该算「变了」（客户端此前没有这些工具）");

        let (_, again) = c.replace_and_diff(vec![entry("a.b.c", "button", "serial")]);
        assert!(
            !again,
            "同样的集合再来一次不该报「变了」——否则会无意义地反复打扰客户端"
        );

        let (_, more) = c.replace_and_diff(vec![
            entry("a.b.c", "button", "serial"),
            entry("a.b.d", "button", "serial"),
        ]);
        assert!(more, "多了一个控件就算变了");

        // 类型变了但路径集合没变：工具名没变，不必通知（schema 会在下次 tools/list 里更新）
        let (_, kind_changed) = c.replace_and_diff(vec![
            entry("a.b.c", "select", "serial"),
            entry("a.b.d", "button", "serial"),
        ]);
        assert!(!kind_changed, "只改类型不改变工具名集合，不该通知");
    }

    #[test]
    fn empty_registry_yields_no_tools() {
        let c = RegistryCache::default();
        assert!(c.is_empty());
        let (tools, next, total) = c.tools(&[], 0, 50);
        assert!(tools.is_empty() && next.is_none() && total == 0);
        assert!(c.updated_at().is_none());
    }

    #[test]
    fn panel_counts_summarise_the_registry() {
        let c = RegistryCache::default();
        c.replace(vec![
            entry("serial.conn.a", "button", "serial"),
            entry("serial.conn.b", "button", "serial"),
            entry("ble.scan.c", "button", "ble"),
        ]);
        let pc = c.panel_counts();
        assert_eq!(pc["serial"], 2);
        assert_eq!(pc["ble"], 1);
        assert!(c.updated_at().is_some());
    }

    #[test]
    fn entries_from_js_json_parse_with_defaults() {
        // 前端上报的是 JSON；缺字段要能走默认值，不能因为少一个 key 就整批失败
        let raw = r#"[{"path":"a.b.c","kind":"button"}]"#;
        let v: Vec<RegistryEntry> = serde_json::from_str(raw).unwrap();
        assert_eq!(v.len(), 1);
        assert!(v[0].enabled, "缺 enabled 默认为可用");
        assert!(v[0].options.is_empty());
        assert!(v[0].disabled_reason.is_none());
    }
}
