// Release 模式下隐藏命令行窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use regex::Regex;
use serialport::{ClearBuffer, DataBits, Parity, SerialPort, StopBits};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::windows::process::CommandExt;
use std::sync::Mutex;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
use tauri::{Emitter, Manager};
use serde_json::json;

fn dbg_log(msg: &str) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let line = format!("[{}ms] {}\n", now, msg);
    let _ = std::fs::OpenOptions::new()
        .create(true).append(true)
        .open(std::env::temp_dir().join("seahi-serial-debug.log"))
        .and_then(|mut f| f.write_all(line.as_bytes()));
}

#[cfg(windows)]
fn start_device_watcher(app: tauri::AppHandle) {
    use windows_sys::Win32::Devices::DeviceAndDriverInstallation::{
        CM_Register_Notification, CM_NOTIFY_FILTER, CM_NOTIFY_FILTER_TYPE_DEVICEINTERFACE,
        CM_NOTIFY_ACTION_DEVICEINTERFACEARRIVAL, CM_NOTIFY_ACTION_DEVICEINTERFACEREMOVAL,
        CM_NOTIFY_EVENT_DATA, CM_NOTIFY_ACTION,
    };

    unsafe extern "system" fn device_callback(
        _hnotify: *mut std::ffi::c_void,
        context: *const std::ffi::c_void,
        action: CM_NOTIFY_ACTION,
        _event_data: *const CM_NOTIFY_EVENT_DATA,
        _event_data_size: u32,
    ) -> u32 {
        if action == CM_NOTIFY_ACTION_DEVICEINTERFACEARRIVAL
            || action == CM_NOTIFY_ACTION_DEVICEINTERFACEREMOVAL
        {
            dbg_log(&format!("device_callback: action={}", action));
            let app = &*(context as *const tauri::AppHandle);
            let _ = app.emit("device-changed", ());
        }
        0
    }

    std::thread::spawn(move || unsafe {
        let guid_comport = winapi::shared::guiddef::GUID {
            Data1: 0x86E0D1E0,
            Data2: 0x8089,
            Data3: 0x11D0,
            Data4: [0x9C, 0xE4, 0x08, 0x00, 0x3E, 0x30, 0x1F, 0x73],
        };

        let mut filter: CM_NOTIFY_FILTER = std::mem::zeroed();
        filter.cbSize = std::mem::size_of::<CM_NOTIFY_FILTER>() as u32;
        filter.FilterType = CM_NOTIFY_FILTER_TYPE_DEVICEINTERFACE;
        std::ptr::write(&mut filter.u as *mut _ as *mut winapi::shared::guiddef::GUID, guid_comport);

        dbg_log(&format!("CM_NOTIFY_FILTER size={}", filter.cbSize));

        let mut notify_handle: *mut std::ffi::c_void = std::ptr::null_mut();
        let app_handle = Box::new(app);
        let context = Box::into_raw(app_handle) as *const std::ffi::c_void;

        let result = CM_Register_Notification(
            &filter,
            context,
            Some(device_callback),
            &mut notify_handle,
        );

        if result == 0 {
            dbg_log("CM_Register_Notification ok, waiting for events...");
        } else {
            dbg_log(&format!("CM_Register_Notification failed: {}", result));
        }

        loop {
            std::thread::sleep(std::time::Duration::from_secs(3600));
        }
    });
}

/// 持久化 WSL shell：保持一个 WSL 进程存活，通过管道发送命令
/// 避免每次调用都 fork 新进程（WSL2 进程创建 ~300ms）
struct WslShell {
    writer: std::sync::Mutex<std::io::BufWriter<std::process::ChildStdin>>,
    reader: std::sync::Mutex<std::io::BufReader<std::process::ChildStdout>>,
    _child: std::process::Child,
}

static WSL_SHELL: Mutex<Option<WslShell>> = Mutex::new(None);
/// 标记 shell 需要重建（超时/进程退出后设置，get_wsl_shell 检查此标记）
static WSL_SHELL_DIRTY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 获取或创建持久化 WSL shell
fn get_wsl_shell(distro: &str) -> Result<&'static Mutex<Option<WslShell>>, String> {
    let mut shell = WSL_SHELL.lock().unwrap();
    if let Some(ref s) = *shell {
        if !WSL_SHELL_DIRTY.load(std::sync::atomic::Ordering::Relaxed) && is_process_alive(s._child.id()) {
            return Ok(&WSL_SHELL);
        }
        *shell = None;
        WSL_SHELL_DIRTY.store(false, std::sync::atomic::Ordering::Relaxed);
    }
    // 在锁内创建，避免 TOCTOU 竞态
    let mut child = hidden_command("wsl")
        .args(["-d", distro, "-e", "bash", "--norc", "--noprofile"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("创建 WSL shell 失败: {}", e))?;
    let stdout = child.stdout.take().ok_or("无法获取 stdout")?;
    let stdin = child.stdin.take().ok_or("无法获取 stdin")?;
    *shell = Some(WslShell {
        writer: std::sync::Mutex::new(std::io::BufWriter::new(stdin)),
        reader: std::sync::Mutex::new(std::io::BufReader::new(stdout)),
        _child: child,
    });
    Ok(&WSL_SHELL)
}

/// 通过持久化 shell 执行命令并返回输出
fn wsl_shell_exec(distro: &str, cmd: &str, timeout_ms: u64) -> Result<String, String> {
    use std::io::{BufRead, Write};
    let shell_ref = get_wsl_shell(distro)?;
    let shell = shell_ref.lock().unwrap();
    let shell = shell.as_ref().ok_or("WSL shell 未初始化")?;

    let marker_start = "___SEAHI_START___";
    let marker_end = "___SEAHI_END___";
    let full_cmd = format!("echo {}; {} 2>&1; echo {}", marker_start, cmd, marker_end);
    {
        let mut w = shell.writer.lock().map_err(|e| format!("锁失败: {}", e))?;
        w.write_all(full_cmd.as_bytes()).map_err(|e| format!("写入失败: {}", e))?;
        w.write_all(b"\n").map_err(|e| format!("写入换行失败: {}", e))?;
        w.flush().map_err(|e| format!("刷新失败: {}", e))?;
    }

    let mut r = shell.reader.lock().map_err(|e| format!("锁失败: {}", e))?;
    let mut output = String::new();
    let start = std::time::Instant::now();
    loop {
        if start.elapsed().as_millis() > timeout_ms as u128 {
            WSL_SHELL_DIRTY.store(true, std::sync::atomic::Ordering::Relaxed);
            dbg_log(&format!("wsl_shell_exec: timeout after {}ms", timeout_ms));
            return Err("WSL shell 命令超时".into());
        }
        let mut line = String::new();
        match r.read_line(&mut line) {
            Ok(0) => {
                WSL_SHELL_DIRTY.store(true, std::sync::atomic::Ordering::Relaxed);
                dbg_log("wsl_shell_exec: EOF");
                return Err("WSL shell 进程已退出".into());
            }
            Ok(_) => {}
            Err(e) => return Err(format!("读取失败: {}", e)),
        }
        if line.trim() == marker_end { break; }
        if line.trim() == marker_start { continue; }
        output.push_str(&line);
    }
    Ok(output)
}

/// WSL 终端进程 PID（由 launch_wsl 设置，用于检测用户关闭窗口）
static WSL_TERMINAL_PID: Mutex<Option<u32>> = Mutex::new(None);

/// 串口读取 + 工作流监控线程：后台持续读取数据，自动检查规则并执行动作
struct PortReader {
    buffer: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
    events: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    read_handle: Option<std::thread::JoinHandle<()>>,
    wf_handle: Option<std::thread::JoinHandle<()>>,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    port: std::sync::Arc<std::sync::Mutex<Box<dyn SerialPort>>>,
    rules: std::sync::Arc<std::sync::Mutex<Vec<WorkflowRule>>>,
    log_dir: std::sync::Arc<std::sync::Mutex<String>>,
    line_ending: std::sync::Arc<std::sync::Mutex<String>>,
}

impl PortReader {
    fn new(port: Box<dyn SerialPort>, regex_cache: std::sync::Arc<RegexCache>) -> Self {
        let buffer = std::sync::Arc::new(std::sync::Mutex::new(Vec::with_capacity(8192)));
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let rules = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log_dir = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let line_ending = std::sync::Arc::new(std::sync::Mutex::new(String::from("crlf")));
        let buf_clone = buffer.clone();
        let evt_clone = events.clone();
        let stop_clone = stop.clone();
        let port_arc = std::sync::Arc::new(std::sync::Mutex::new(port));
        let port_clone = port_arc.clone();
        let rules_clone = rules.clone();
        let log_dir_clone = log_dir.clone();
        let le_clone = line_ending.clone();

        // channel：读取线程 → 工作流工作线程
        let (tx, rx) = crossbeam_channel::bounded::<Vec<u8>>(2048);

        // 读取线程：从串口读数据，存 buffer，发给工作流线程
        let tx_clone = tx.clone();
        let port_for_read = port_arc.clone();
        let read_handle = std::thread::spawn(move || {
            let mut tmp = [0u8; 4096];
            loop {
                if stop_clone.load(std::sync::atomic::Ordering::Relaxed) { break; }
                let read_result = {
                    let mut p = port_for_read.lock().unwrap_or_else(|e| e.into_inner());
                    p.read(&mut tmp)
                };
                match read_result {
                    Ok(n) if n > 0 => {
                        let chunk = tmp[..n].to_vec();
                        if let Ok(mut buf) = buf_clone.lock() {
                            buf.extend_from_slice(&chunk);
                            if buf.len() > 262144 {
                                let drain = buf.len() - 131072;
                                buf.drain(..drain);
                            }
                        }
                        // 非阻塞发送，channel 满则丢弃（避免背压阻塞读取）
                        let _ = tx_clone.try_send(chunk).is_ok();
                    }
                    Ok(_) => continue,
                    Err(e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
                    Err(_) => break,
                }
            }
        });

        // 工作流工作线程：单线程消费 channel，检查规则，执行动作
        let rc_clone = regex_cache.clone();
        let wf_handle = std::thread::spawn(move || {
            while let Ok(data) = rx.recv() {
                Self::check_workflows(&data, &rules_clone, &log_dir_clone, &port_clone, &evt_clone, &le_clone, &rc_clone);
            }
        });

        PortReader { buffer, events, read_handle: Some(read_handle), wf_handle: Some(wf_handle), stop, port: port_arc, rules, log_dir, line_ending }
    }

    fn check_workflows(
        pending: &[u8],
        rules: &std::sync::Arc<std::sync::Mutex<Vec<WorkflowRule>>>,
        log_dir: &std::sync::Arc<std::sync::Mutex<String>>,
        port: &std::sync::Arc<std::sync::Mutex<Box<dyn SerialPort>>>,
        events: &std::sync::Arc<std::sync::Mutex<Vec<String>>>,
        line_ending: &std::sync::Arc<std::sync::Mutex<String>>,
        regex_cache: &RegexCache,
    ) {
        if pending.is_empty() { return; }

        // 阶段1：极短持锁，仅克隆规则快照
        let snapshot: Vec<WorkflowRule> = {
            rules.lock().unwrap_or_else(|e| e.into_inner()).clone()
        };
        let ld = log_dir.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let le = line_ending.lock().unwrap_or_else(|e| e.into_inner()).clone();

        // 阶段2：无锁匹配（正则编译不阻塞任何共享状态）
        let mut matched_actions: Vec<Vec<WorkflowAction>> = Vec::new();
        for rule in &snapshot {
            if !rule.running || rule.conditions.is_empty() { continue; }
            if rule.conditions.iter().all(|c| match_condition(c, pending, regex_cache)) {
                matched_actions.push(rule.actions.clone());
            }
        }

        if matched_actions.is_empty() { return; }

        let le_bytes: Vec<u8> = match le.as_str() {
            "crlf" => vec![0x0D, 0x0A],
            "lf" => vec![0x0A],
            "cr" => vec![0x0D],
            _ => vec![],
        };

        // 动作执行在独立线程，不阻塞工作流线程
        let pending_clone = pending.to_vec();
        let port_clone = port.clone();
        let events_clone = events.clone();
        std::thread::spawn(move || {
            let mut all_sent = Vec::new();
            for actions in &matched_actions {
                let mut sent_parts = Vec::new();
                for action in actions {
                    if action.delay_before > 0 {
                        std::thread::sleep(std::time::Duration::from_millis(action.delay_before));
                    }
                    match action.action_type.as_str() {
                        "send_data" => {
                            let mut bytes = if action.encoding == "hex" {
                                parse_hex_bytes(&action.data)
                            } else {
                                action.data.as_bytes().to_vec()
                            };
                            if bytes.is_empty() { continue; }
                            if action.encoding != "hex" && !le_bytes.is_empty() {
                                bytes.extend_from_slice(&le_bytes);
                            }
                            sent_parts.push(action.data.clone());
                            let mut p = port_clone.lock().unwrap_or_else(|e| e.into_inner());
                            match p.write_all(&bytes) {
                                Ok(()) => { let _ = p.flush(); }
                                Err(e) => {
                                    eprintln!("[Workflow] 写入串口失败: {}", e);
                                    sent_parts.pop();
                                }
                            }
                        }
                        "toggle_dtr_rts" => {
                            let mut p = port_clone.lock().unwrap_or_else(|e| e.into_inner());
                            let ok = match action.signal.as_str() {
                                "dtr" => p.write_data_terminal_ready(action.level).is_ok(),
                                "rts" => p.write_request_to_send(action.level).is_ok(),
                                _ => false,
                            };
                            if ok { sent_parts.push(format!("[{} {}]", action.signal.to_uppercase(), if action.level { "ON" } else { "OFF" })); }
                        }
                        "save_log" => {
                            if !ld.is_empty() {
                                let filepath = std::path::Path::new(&ld).join("workflow_log.txt");
                                if let Ok(mut f) = std::fs::OpenOptions::new()
                                    .create(true).append(true).open(&filepath)
                                { let _ = f.write_all(&pending_clone); }
                            }
                            sent_parts.push("[LOG]".to_string());
                        }
                        _ => {}
                    }
                }
                all_sent.extend(sent_parts);
            }
            if !all_sent.is_empty() {
                let msg = format!("[Auto] {}", all_sent.join(" "));
                if let Ok(mut evts) = events_clone.lock() { evts.push(msg); }
            }
        });
    }

    fn read_all(&self) -> Vec<u8> {
        if let Ok(mut buf) = self.buffer.lock() {
            std::mem::take(&mut *buf)
        } else { vec![] }
    }

    fn read_events(&self) -> Vec<String> {
        if let Ok(mut evts) = self.events.lock() {
            std::mem::take(&mut *evts)
        } else { vec![] }
    }

    fn update_rules(&self, new_rules: Vec<WorkflowRule>) {
        if let Ok(mut r) = self.rules.lock() { *r = new_rules; }
    }

    fn update_log_dir(&self, dir: String) {
        if let Ok(mut d) = self.log_dir.lock() { *d = dir; }
    }

    fn update_line_ending(&self, le: String) {
        if let Ok(mut v) = self.line_ending.lock() { *v = le; }
    }
}

impl Drop for PortReader {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        if let Some(h) = self.read_handle.take() { let _ = h.join(); }
        if let Some(h) = self.wf_handle.take() { let _ = h.join(); }
    }
}

/// 全局状态：多个独立串口连接（key = monitor_id）
struct PortState {
    readers: Mutex<HashMap<String, PortReader>>,
}

/// WSL 串口会话：通过管道与 bridge 脚本通信
struct WslSerialSession {
    child: std::sync::Arc<std::sync::Mutex<std::process::Child>>,
    writer: std::sync::Mutex<std::io::BufWriter<std::process::ChildStdin>>,
    reader: std::sync::Arc<std::sync::Mutex<std::io::BufReader<std::process::ChildStdout>>>,
}

/// 全局状态：WSL 串口连接（key = monitor_id）
struct WslSerialState {
    sessions: Mutex<HashMap<String, WslSerialSession>>,
}

// ===== 自动化工作流 =====

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
struct WorkflowCondition {
    #[serde(rename = "type")]
    cond_type: String,
    value: String,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
struct WorkflowAction {
    #[serde(rename = "type")]
    action_type: String,
    #[serde(default)]
    data: String,
    #[serde(default = "default_encoding")]
    encoding: String,
    #[serde(default)]
    signal: String,
    #[serde(default)]
    level: bool,
    #[serde(default)]
    delay_before: u64,
}

fn default_encoding() -> String { "text".to_string() }

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
struct WorkflowRule {
    id: String,
    name: String,
    enabled: bool,
    #[serde(default)]
    running: bool,
    conditions: Vec<WorkflowCondition>,
    actions: Vec<WorkflowAction>,
}

/// 正则表达式编译缓存
struct RegexCache {
    cache: std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<Regex>>>,
}

impl RegexCache {
    fn new() -> Self {
        RegexCache { cache: std::sync::Mutex::new(std::collections::HashMap::new()) }
    }

    fn get_or_compile(&self, pattern: &str) -> Option<std::sync::Arc<Regex>> {
        // 先查缓存
        {
            let cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(re) = cache.get(pattern) {
                return Some(re.clone());
            }
        }
        // 缓存未命中，编译并存入
        match Regex::new(pattern) {
            Ok(re) => {
                let re = std::sync::Arc::new(re);
                let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
                cache.insert(pattern.to_string(), re.clone());
                Some(re)
            }
            Err(_) => None,
        }
    }
}

/// 全局正则缓存（随 WorkflowState 一起管理）
struct WorkflowState {
    rules: Mutex<HashMap<String, Vec<WorkflowRule>>>,
    log_dirs: Mutex<HashMap<String, String>>,
    regex_cache: std::sync::Arc<RegexCache>,
}

/// 解析 HEX 字符串为字节序列（支持空格分隔如 "FF 01 02" 或连续 "FF0102"）
fn parse_hex_bytes(s: &str) -> Vec<u8> {
    let cleaned: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    if cleaned.len() % 2 != 0 { return vec![]; }
    cleaned.as_bytes().chunks(2)
        .filter_map(|chunk| {
            let hex_str = std::str::from_utf8(chunk).ok()?;
            u8::from_str_radix(hex_str, 16).ok()
        })
        .collect()
}

/// 检查单个条件是否匹配
fn match_condition(cond: &WorkflowCondition, raw: &[u8], cache: &RegexCache) -> bool {
    match cond.cond_type.as_str() {
        "string_contains" => {
            String::from_utf8_lossy(raw).contains(&cond.value)
        }
        "regex" => {
            let text = String::from_utf8_lossy(raw);
            match cache.get_or_compile(&cond.value) {
                Some(re) => re.is_match(&text),
                None => false,
            }
        }
        "exact_bytes" => {
            let expected = parse_hex_bytes(&cond.value);
            if expected.is_empty() { return false; }
            raw.windows(expected.len()).any(|w| w == expected.as_slice())
        }
        _ => false,
    }
}

/// 执行工作流动作序列，返回所有发送的数据文本
fn execute_workflow_actions(
    actions: &[WorkflowAction],
    monitor_id: &str,
    readers: &Mutex<HashMap<String, PortReader>>,
    log_dir: &str,
    received: &[u8],
) -> String {
    let mut sent_parts = Vec::new();
    for action in actions {
        if action.delay_before > 0 {
            std::thread::sleep(std::time::Duration::from_millis(action.delay_before));
        }
        match action.action_type.as_str() {
            "send_data" => {
                let bytes = if action.encoding == "hex" {
                    parse_hex_bytes(&action.data)
                } else {
                    action.data.as_bytes().to_vec()
                };
                if bytes.is_empty() { continue; }
                sent_parts.push(action.data.clone());
                let map = readers.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(reader) = map.get(monitor_id) {
                    let mut port = reader.port.lock().unwrap_or_else(|e| e.into_inner());
                    let _ = port.write_all(&bytes);
                }
            }
            "toggle_dtr_rts" => {
                let map = readers.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(reader) = map.get(monitor_id) {
                    let mut port = reader.port.lock().unwrap_or_else(|e| e.into_inner());
                    match action.signal.as_str() {
                        "dtr" => { let _ = port.write_data_terminal_ready(action.level); }
                        "rts" => { let _ = port.write_request_to_send(action.level); }
                        _ => {}
                    }
                }
                sent_parts.push(format!("[{} {}]", action.signal.to_uppercase(), if action.level { "ON" } else { "OFF" }));
            }
            "save_log" => {
                if !log_dir.is_empty() && !received.is_empty() {
                    let filepath = std::path::Path::new(log_dir).join("workflow_log.txt");
                    if let Ok(mut f) = std::fs::OpenOptions::new()
                        .create(true).append(true)
                        .open(&filepath)
                    {
                        let _ = f.write_all(received);
                    }
                }
                sent_parts.push("[LOG]".to_string());
            }
            _ => {}
        }
    }
    sent_parts.join(" ")
}

/// 创建不显示控制台窗口的 Command
fn hidden_command(program: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW); // CREATE_NO_WINDOW
    cmd
}

/// 嵌入的 bridge 脚本 base64
const BRIDGE_B64: &str = include_str!("../wsl-daemon/bridge_b64.txt");
const BRIDGE_SCRIPT_PATH: &str = "/tmp/seahi_serial_bridge.py";

/// 串口信息（发给前端）
#[derive(Debug, serde::Serialize, Clone)]
struct PortInfo {
    port_name: String,
    friendly_name: String,
    product_name: String,
}

/// Windows 下通过 SetupAPI 一次性遍历所有串口设备，返回 COM 口名 → (FriendlyName, ProductName) 的映射表。
/// FriendlyName 来自 SPDRP_FRIENDLYNAME（如 "USB 串行设备 (COM28)"）。
/// ProductName 来自 DEVPKEY_Device_BusReportedDeviceDesc（USB iProduct 字符串，如 "FlashKey"）。
#[cfg(windows)]
fn build_friendly_name_map() -> HashMap<String, (String, String)> {
    use std::ptr;
    use winapi::shared::guiddef::GUID;
    use winapi::um::setupapi::{
        SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo, SetupDiGetClassDevsW,
        SetupDiGetDeviceRegistryPropertyW,
        HDEVINFO, SPDRP_FRIENDLYNAME, SP_DEVINFO_DATA,
        DIGCF_PRESENT,
    };

    let mut map = HashMap::new();

    let guid_ports = GUID {
        Data1: 0x4D36E978,
        Data2: 0xE325,
        Data3: 0x11CE,
        Data4: [0xBF, 0xC1, 0x08, 0x00, 0x2B, 0xE1, 0x03, 0x18],
    };

    unsafe {
        let h_dev_info: HDEVINFO = SetupDiGetClassDevsW(
            &guid_ports,
            ptr::null(),
            ptr::null_mut(),
            DIGCF_PRESENT,
        );

        if h_dev_info as usize == usize::MAX {
            return map;
        }

        let mut dev_info_data: SP_DEVINFO_DATA = std::mem::zeroed();
        dev_info_data.cbSize = std::mem::size_of::<SP_DEVINFO_DATA>() as u32;

        let mut index: u32 = 0;
        while SetupDiEnumDeviceInfo(h_dev_info, index, &mut dev_info_data) != 0 {
            index += 1;

            let mut friendly_name = String::new();
            let product_name = String::new();

            // 读取 FriendlyName
            {
                let mut required_size: u32 = 0;
                let _ = SetupDiGetDeviceRegistryPropertyW(
                    h_dev_info, &mut dev_info_data, SPDRP_FRIENDLYNAME,
                    ptr::null_mut(), ptr::null_mut(), 0, &mut required_size,
                );
                if required_size > 0 {
                    let mut buffer: Vec<u16> = vec![0; (required_size / 2 + 1) as usize];
                    let mut actual_size: u32 = 0;
                    let success = SetupDiGetDeviceRegistryPropertyW(
                        h_dev_info, &mut dev_info_data, SPDRP_FRIENDLYNAME,
                        ptr::null_mut(), buffer.as_mut_ptr() as *mut u8,
                        buffer.len() as u32 * 2, &mut actual_size,
                    );
                    if success != 0 {
                        let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
                        friendly_name = String::from_utf16(&buffer[..len]).unwrap_or_default();
                    }
                }
            }

            if let Some(com_start) = friendly_name.find("COM") {
                let rest = &friendly_name[com_start..];
                let com_end = rest.find(|c: char| !c.is_alphanumeric()).unwrap_or(rest.len());
                let com_port = rest[..com_end].to_string();
                map.insert(com_port, (friendly_name, product_name));
            }
        }

        SetupDiDestroyDeviceInfoList(h_dev_info);
    }

    map
}

/// 通过 SetupAPI 枚举所有 COM 端口，同时获取端口名和友好名称。
/// 比 serialport::available_ports() 快得多，因为它不需要尝试打开每个端口。
#[cfg(windows)]
fn enumerate_ports() -> Vec<PortInfo> {
    build_friendly_name_map()
        .into_iter()
        .map(|(port_name, (friendly_name, product_name))| PortInfo { port_name, friendly_name, product_name })
        .collect()
}

/// 获取所有可用串口列表
#[cfg(windows)]
#[tauri::command]
fn list_ports() -> Vec<PortInfo> {
    let t0 = std::time::Instant::now();
    let ports = enumerate_ports();
    dbg_log(&format!("list_ports: {} ports, {:?}", ports.len(), t0.elapsed()));
    ports
}

#[cfg(not(windows))]
#[tauri::command]
fn list_ports() -> Vec<PortInfo> {
    use serialport::SerialPortType;
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| {
            let friendly = match &p.port_type {
                SerialPortType::UsbPort(usb) => {
                    let dev_name = usb.product.as_deref()
                        .filter(|s| !s.is_empty())
                        .or_else(|| usb.manufacturer.as_deref().filter(|s| !s.is_empty()));
                    match dev_name {
                        Some(name) => format!("{} - {}", p.port_name, name),
                        None => p.port_name.clone(),
                    }
                },
                SerialPortType::BluetoothPort => format!("{} - 蓝牙", p.port_name),
                _ => p.port_name.clone(),
            };
            PortInfo { port_name: p.port_name.clone(), friendly_name: friendly, product_name: String::new() }
        })
        .collect()
}

/// 打开串口（启动后台读取线程）
#[tauri::command]
fn open_port(
    state: tauri::State<'_, PortState>,
    wf_state: tauri::State<'_, WorkflowState>,
    monitor_id: String,
    port_name: String,
    baud_rate: u32,
    data_bits: u8,
    stop_bits: u8,
    parity: String,
    dtr: bool,
    rts: bool,
) -> Result<(), String> {
    // 关闭该监视器已有的连接
    {
        let mut map = state.readers.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(&monitor_id);
    }

    let mut port: Box<dyn SerialPort> = serialport::open(&port_name)
            .map_err(|e| format!("打开失败: {}", e))?;

    port.set_baud_rate(baud_rate).map_err(|e| format!("设置波特率失败: {}", e))?;

    let db = match data_bits {
        5 => DataBits::Five, 6 => DataBits::Six, 7 => DataBits::Seven, _ => DataBits::Eight,
    };
    port.set_data_bits(db).map_err(|e| format!("设置数据位失败: {}", e))?;

    let sb = match stop_bits { 2 => StopBits::Two, _ => StopBits::One };
    port.set_stop_bits(sb).map_err(|e| format!("设置停止位失败: {}", e))?;

    let pr = match parity.as_str() {
        "even" => Parity::Even, "odd" => Parity::Odd, _ => Parity::None,
    };
    port.set_parity(pr).map_err(|e| format!("设置校验位失败: {}", e))?;

    port.set_timeout(std::time::Duration::from_millis(10))
        .map_err(|e| format!("设置超时失败: {}", e))?;

    port.write_data_terminal_ready(dtr).map_err(|e| format!("DTR 设置失败: {}", e))?;
    port.write_request_to_send(rts).map_err(|e| format!("RTS 设置失败: {}", e))?;

    // 创建读取线程，同步已有的工作流规则
    let reader = PortReader::new(port, wf_state.regex_cache.clone());
    {
        let rules_map = wf_state.rules.lock().unwrap_or_else(|e| e.into_inner());
        let dirs_map = wf_state.log_dirs.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(rules) = rules_map.get(&monitor_id) {
            reader.update_rules(rules.clone());
        }
        if let Some(dir) = dirs_map.get(&monitor_id) {
            reader.update_log_dir(dir.clone());
        }
    }
    let mut guard = state.readers.lock().unwrap_or_else(|e| e.into_inner());
    guard.insert(monitor_id, reader);

    Ok(())
}

/// 关闭串口（停止读取线程）
#[tauri::command]
fn close_port(state: tauri::State<'_, PortState>, monitor_id: String) -> Result<(), String> {
    let mut map = state.readers.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(reader) = map.remove(&monitor_id) {
        let mut port = reader.port.lock().unwrap_or_else(|e| e.into_inner());
        let _ = port.flush();
        let _ = port.clear(ClearBuffer::All);
    }
    Ok(())
}

/// 从缓冲区读取数据（毫秒级，不阻塞）
#[tauri::command]
fn read_data(state: tauri::State<'_, PortState>, monitor_id: String) -> Result<Vec<u8>, String> {
    let map = state.readers.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(reader) = map.get(&monitor_id) {
        Ok(reader.read_all())
    } else {
        Err("未连接串口".into())
    }
}

/// 读取工作流触发事件（前端轮询显示 [Auto] 消息）
#[tauri::command]
fn read_workflow_events(state: tauri::State<'_, PortState>, monitor_id: String) -> Vec<String> {
    let map = state.readers.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(reader) = map.get(&monitor_id) {
        reader.read_events()
    } else {
        vec![]
    }
}

/// 发送数据
#[tauri::command]
fn send_data(state: tauri::State<'_, PortState>, monitor_id: String, data: Vec<u8>) -> Result<usize, String> {
    let map = state.readers.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(reader) = map.get(&monitor_id) {
        let mut port = reader.port.lock().unwrap_or_else(|e| e.into_inner());
        port.write_all(&data).map_err(|e| format!("发送失败: {}", e))?;
        Ok(data.len())
    } else {
        Err("未连接串口".into())
    }
}

/// 实时设置 DTR 信号
#[tauri::command]
fn set_dtr(state: tauri::State<'_, PortState>, monitor_id: String, level: bool) -> Result<(), String> {
    let map = state.readers.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(reader) = map.get(&monitor_id) {
        let mut port = reader.port.lock().unwrap_or_else(|e| e.into_inner());
        port.write_data_terminal_ready(level).map_err(|e| format!("DTR 设置失败: {}", e))
    } else {
        Err("未连接串口".into())
    }
}

/// 实时设置 RTS 信号
#[tauri::command]
fn set_rts(state: tauri::State<'_, PortState>, monitor_id: String, level: bool) -> Result<(), String> {
    let map = state.readers.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(reader) = map.get(&monitor_id) {
        let mut port = reader.port.lock().unwrap_or_else(|e| e.into_inner());
        port.write_request_to_send(level).map_err(|e| format!("RTS 设置失败: {}", e))
    } else {
        Err("未连接串口".into())
    }
}

// ===== 自动化工作流命令 =====

/// 检查收到的数据是否匹配工作流规则，匹配则执行动作
/// 匹配阶段短暂持锁，执行阶段单独加锁避免阻塞串口读取
#[tauri::command]
fn check_workflow_matches(
    wf_state: tauri::State<'_, WorkflowState>,
    port_state: tauri::State<'_, PortState>,
    monitor_id: String,
    data: Vec<u8>,
) -> Vec<serde_json::Value> {
    // 阶段1：短暂持锁，收集匹配的规则（克隆动作数据）
    let (log_dir, matched_rules) = {
        let rules = wf_state.rules.lock().unwrap_or_else(|e| e.into_inner());
        let log_dirs = wf_state.log_dirs.lock().unwrap_or_else(|e| e.into_inner());
        let log_dir = log_dirs.get(&monitor_id).cloned().unwrap_or_default();
        let Some(monitor_rules) = rules.get(&monitor_id) else {
            return vec![];
        };
        let mut matched = vec![];
        for rule in monitor_rules {
            if !rule.running || rule.conditions.is_empty() { continue; }
            if rule.conditions.iter().all(|c| match_condition(c, &data, &wf_state.regex_cache)) {
                matched.push((rule.id.clone(), rule.name.clone(), rule.actions.clone()));
            }
        }
        (log_dir, matched)
    }; // 锁在此释放

    // 阶段2：无锁执行动作，每个动作单独加锁
    let mut result = vec![];
    for (id, name, actions) in matched_rules {
        let sent = execute_workflow_actions(&actions, &monitor_id, &port_state.readers, &log_dir, &data);
        result.push(serde_json::json!({ "id": id, "name": name, "sent": sent }));
    }
    result
}

/// 保存工作流规则到内存（前端编辑后调用）
#[tauri::command]
fn save_workflows(
    state: tauri::State<'_, WorkflowState>,
    port_state: tauri::State<'_, PortState>,
    monitor_id: String,
    workflows_json: String,
) -> Result<(), String> {
    let rules: Vec<WorkflowRule> = serde_json::from_str(&workflows_json)
        .map_err(|e| format!("解析工作流数据失败: {}", e))?;
    // 更新 WorkflowState（供前端读取）
    {
        let mut map = state.rules.lock().unwrap_or_else(|e| e.into_inner());
        map.insert(monitor_id.clone(), rules.clone());
    }
    // 同步更新 PortReader 中的规则（供后台线程使用）
    {
        let map = port_state.readers.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(reader) = map.get(&monitor_id) {
            reader.update_rules(rules);
        }
    }
    Ok(())
}

/// 加载工作流规则（返回 JSON 字符串）
#[tauri::command]
fn load_workflows(
    state: tauri::State<'_, WorkflowState>,
    monitor_id: String,
) -> String {
    let map = state.rules.lock().unwrap_or_else(|e| e.into_inner());
    let rules = map.get(&monitor_id).cloned().unwrap_or_default();
    serde_json::to_string(&rules).unwrap_or_else(|_| "[]".to_string())
}

/// 启动时从配置初始化所有监视器的工作流规则
#[tauri::command]
fn init_workflows(
    state: tauri::State<'_, WorkflowState>,
    port_state: tauri::State<'_, PortState>,
    config_json: String,
) -> Result<(), String> {
    let cfg: serde_json::Value = serde_json::from_str(&config_json)
        .map_err(|e| format!("解析配置失败: {}", e))?;
    let mut map = state.rules.lock().unwrap_or_else(|e| e.into_inner());
    let mut dirs = state.log_dirs.lock().unwrap_or_else(|e| e.into_inner());
    let readers = port_state.readers.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(monitors) = cfg.get("monitors").and_then(|m| m.as_object()) {
        for (mid, mc) in monitors {
            if let Some(wf_arr) = mc.get("workflows").and_then(|w| w.as_array()) {
                let rules: Vec<WorkflowRule> = wf_arr.iter()
                    .filter_map(|v| serde_json::from_value(v.clone()).ok())
                    .collect();
                // 同步到 PortReader
                if let Some(reader) = readers.get(mid) {
                    reader.update_rules(rules.clone());
                }
                map.insert(mid.clone(), rules);
            }
            if let Some(ld) = mc.get("logDir").and_then(|l| l.as_str()) {
                if !ld.is_empty() {
                    if let Some(reader) = readers.get(mid) {
                        reader.update_log_dir(ld.to_string());
                    }
                    dirs.insert(mid.clone(), ld.to_string());
                }
            }
        }
    }
    Ok(())
}

/// 更新监视器的日志目录
#[tauri::command]
fn update_workflow_log_dir(
    state: tauri::State<'_, WorkflowState>,
    port_state: tauri::State<'_, PortState>,
    monitor_id: String,
    log_dir: String,
) {
    {
        let mut dirs = state.log_dirs.lock().unwrap_or_else(|e| e.into_inner());
        dirs.insert(monitor_id.clone(), log_dir.clone());
    }
    let readers = port_state.readers.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(reader) = readers.get(&monitor_id) {
        reader.update_log_dir(log_dir);
    }
}

/// 更新监视器的行尾设置（供工作流使用）
#[tauri::command]
fn update_workflow_line_ending(
    port_state: tauri::State<'_, PortState>,
    monitor_id: String,
    line_ending: String,
) {
    let readers = port_state.readers.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(reader) = readers.get(&monitor_id) {
        reader.update_line_ending(line_ending);
    }
}

/// 选择日志文件目录（使用原生对话框）
#[tauri::command]
fn choose_log_directory() -> Result<Option<String>, String> {
    Ok(rfd::FileDialog::new()
        .set_title("选择日志保存目录")
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string()))
}

/// 获取所有串口（包括已映射到WSL的）
#[tauri::command]
/// 通过 UAC 提权执行 usbipd list，返回 stdout 内容
fn run_usbipd_list_elevated() -> Option<String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static LIST_COUNTER: AtomicU64 = AtomicU64::new(0);
    let unique_id = LIST_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_result = std::env::temp_dir().join(format!("usbipd_list_{}_{}.txt", std::process::id(), unique_id));
    let tmp_result_str = tmp_result.to_str().unwrap_or("C:\\Temp\\usbipd_list.txt").replace('\'', "''");

    let ps_script = format!(
        "try {{ \
           $out = & usbipd.exe list 2>&1 | Out-String; \
           $out | Out-File -FilePath '{result}' -Encoding UTF8; \
         }} catch {{ \
           $_.Exception.Message | Out-File -FilePath '{result}' -Encoding UTF8; \
         }}",
        result = tmp_result_str
    );

    let tmp_script = std::env::temp_dir().join(format!("usbipd_list_script_{}_{}.ps1", std::process::id(), unique_id));
    let _ = std::fs::remove_file(&tmp_result);
    let _ = std::fs::write(&tmp_script, &ps_script);

    let script_path_str = tmp_script.to_str().unwrap_or("");
    let sp = script_path_str.replace('\'', "''");
    let _ = hidden_command("powershell")
        .args(["-NonInteractive", "-Command"])
        .arg(format!("Start-Process -FilePath 'powershell' -ArgumentList '-ExecutionPolicy','Bypass','-NonInteractive','-File','{}' -Verb RunAs -Wait", sp))
        .status();
    let _ = std::fs::remove_file(&tmp_script);
    std::thread::sleep(std::time::Duration::from_millis(500));

    let result = std::fs::read_to_string(&tmp_result).ok();
    let _ = std::fs::remove_file(&tmp_result);
    result
}

#[tauri::command]
fn list_wsl_devices() -> Result<Vec<serde_json::Value>, String> {
    use std::sync::mpsc;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let result = hidden_command("usbipd")
            .args(["list"])
            .output();
        let _ = tx.send(result);
    });

    // 检查 WSL 是否正在运行
    let wsl_running = check_wsl_running().map(|d| !d.is_empty()).unwrap_or(false);

    let output = match rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(Ok(out)) => Some(out),
        Ok(Err(e)) => {
            dbg_log(&format!("usbipd list 执行失败: {}", e));
            None
        }
        Err(_) => {
            dbg_log(&format!("usbipd list 执行超时"));
            None
        }
    };

    // 如果普通模式失败或输出为空，尝试管理员权限执行
    let list_str = match output {
        Some(out) if out.status.success() => {
            let s = String::from_utf8_lossy(&out.stdout).to_string();
            if s.lines().any(|l| l.split_whitespace().count() >= 3 && l.contains('-')) {
                s
            } else {
                dbg_log("usbipd list 输出为空，尝试提权执行");
                run_usbipd_list_elevated().unwrap_or_default()
            }
        }
        _ => {
            dbg_log("usbipd list 失败，尝试提权执行");
            run_usbipd_list_elevated().unwrap_or_default()
        }
    };

    let mut devices: Vec<serde_json::Value> = Vec::new();

    if !list_str.is_empty() {
            for line in list_str.lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 3 && parts[0].contains('-') {
                    let busid = parts[0].to_string();
                    let line_upper = line.to_uppercase();

                    let status = if line_upper.contains("ATTACHED") {
                        "attached"
                    } else if line_upper.contains("CONNECTED") || line_upper.contains("SHARED") {
                        "connected"
                    } else {
                        "other"
                    };

                    if status == "other" {
                        continue;
                    }

                    // usbipd list 格式: BUSID VID:PID DEVICE... STATE
                    // STATE 可能是 "Shared" / "Attached" / "Connected" / "Not shared"
                    let name = {
                        let name_parts = &parts[2..];
                        let end = if name_parts.last().map(|s| s.to_lowercase()) == Some("shared".into()) {
                            let last2 = name_parts.len();
                            if last2 >= 2 && name_parts[last2-2].to_lowercase() == "not" {
                                last2 - 2
                            } else {
                                last2 - 1
                            }
                        } else if name_parts.last().map(|s| matches!(s.to_lowercase().as_str(), "attached" | "connected")) == Some(true) {
                            name_parts.len() - 1
                        } else {
                            name_parts.len()
                        };
                        if end > 0 {
                            name_parts[..end].join(" ")
                        } else {
                            format!("USB Device ({})", busid)
                        }
                    };

                    static FILTERS: &[&str] = &[
                        "通信端口", "通讯端口", "communicationsport",
                        "蓝牙", "bluetooth",
                        "usb输入设备", "usb-baseddslinstrument",
                    ];
                    let name_lower = name.to_lowercase().replace(" ", "");
                    if FILTERS.iter().any(|f| name_lower.contains(f)) {
                        continue;
                    }

                    let has_com = line.find("COM").is_some();
                    let port = if let Some(com_match) = line.find("COM") {
                        let rest = &line[com_match..];
                        if let Some(end) = rest.find(|c: char| !c.is_alphanumeric()) {
                            rest[..end].to_string()
                        } else {
                            rest.to_string()
                        }
                    } else {
                        String::from("-")
                    };

                    // usbipd 报告 "Attached" 且 WSL 正在运行时视为已映射
                    let is_mapped = status == "attached" && wsl_running;

                    devices.push(serde_json::json!({
                        "busid": busid,
                        "port": port,
                        "name": name,
                        "hasCom": has_com,
                        "status": if is_mapped { "mapped" } else { "unmapped" }
                    }));
                }
            }
    }

    Ok(devices)
}

fn decode_utf32_lossy(raw: &[u8]) -> String {
    raw.chunks_exact(4)
        .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .filter_map(|cp| char::from_u32(cp))
        .collect()
}

fn decode_wsl_output(raw: &[u8]) -> String {
    if raw.len() >= 4 {
        // 检测 UTF-32LE BOM：FF FE 00 00（可靠）
        if raw[0] == 0xFF && raw[1] == 0xFE && raw[2] == 0x00 && raw[3] == 0x00 {
            return decode_utf32_lossy(&raw[4..]);
        }
        // 检测 UTF-32BE BOM：00 00 FE FF（可靠）
        if raw[0] == 0x00 && raw[1] == 0x00 && raw[2] == 0xFE && raw[3] == 0xFF {
            return raw[4..].chunks_exact(4)
                .map(|c| u32::from_be_bytes([c[0], c[1], c[2], c[3]]))
                .filter_map(|cp| char::from_u32(cp))
                .collect();
        }
    }
    if raw.len() >= 2 {
        // 检测 UTF-16LE BOM：FF FE（可靠）
        if raw[0] == 0xFF && raw[1] == 0xFE {
            let u16_vec: Vec<u16> = raw[2..]
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            return String::from_utf16_lossy(&u16_vec);
        }
        // 检测 UTF-16BE BOM：FE FF
        if raw[0] == 0xFE && raw[1] == 0xFF {
            let u16_vec: Vec<u16> = raw[2..]
                .chunks_exact(2)
                .map(|c| u16::from_be_bytes([c[0], c[1]]))
                .collect();
            return String::from_utf16_lossy(&u16_vec);
        }
        // 无 BOM：默认按 UTF-16LE 处理（wsl --list 最常见编码）
        if raw.len() % 2 == 0 && raw.len() >= 4 {
            let null_count = raw.iter().enumerate().skip(1).step_by(2).filter(|(_, b)| **b == 0).count();
            if null_count > 0 {
                let u16_vec: Vec<u16> = raw
                    .chunks_exact(2)
                    .map(|c| u16::from_le_bytes([c[0], c[1]]))
                    .collect();
                return String::from_utf16_lossy(&u16_vec);
            }
        }
    }
    String::from_utf8_lossy(raw).to_string()
}

/// 检查 WSL 运行状态，返回正在运行的发行版列表
#[tauri::command]
fn check_wsl_status() -> Vec<String> {
    check_wsl_running().unwrap_or_default()
}

fn check_wsl_running() -> Option<Vec<String>> {
    use std::sync::mpsc;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let result = hidden_command("wsl")
            .args(["--list", "--verbose"])
            .output();
        let _ = tx.send(result);
    });
    let output = match rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(Ok(out)) => Some(out),
        _ => return None,
    };
    let dists: Vec<String> = match output {
        Some(out) => {
            let text = decode_wsl_output(&out.stdout);
            text.lines()
                .map(|l| l.trim())
                .filter(|l| {
                    if l.is_empty() { return false; }
                    let lower = l.to_lowercase();
                    if lower.starts_with("name") || lower.starts_with("名称") { return false; }
                    if lower.starts_with("version") || lower.starts_with("版本") { return false; }
                    true
                })
                .filter_map(|l| {
                    let clean = l.trim_start_matches('*').trim();
                    let parts: Vec<&str> = clean.split_whitespace().collect();
                    if parts.len() >= 2 {
                        let state = parts[1].to_lowercase();
                        if state.contains("running") || state.contains("运行") {
                            Some(parts[0].to_string())
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                })
                .collect()
        }
        None => vec![],
    };
    Some(dists)
}

fn is_process_alive(pid: u32) -> bool {
    unsafe {
        use windows_sys::Win32::System::Threading::{OpenProcess, GetExitCodeProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() { return false; }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut code);
        windows_sys::Win32::Foundation::CloseHandle(handle);
        ok != 0 && code == 259
    }
}

fn start_wsl_watcher(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut last_running = false;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));

            let distros = check_wsl_running().unwrap_or_default();
            let wsl_running = !distros.is_empty();

            let terminal_alive = {
                let pid = WSL_TERMINAL_PID.lock().unwrap();
                match *pid {
                    Some(p) => is_process_alive(p),
                    None => true,
                }
            };

            if !terminal_alive && wsl_running {
                *CACHED_DISTRO.lock().unwrap() = None;
            }

            let running = wsl_running && terminal_alive;
            if running != last_running {
                last_running = running;
                dbg_log(&format!("wsl_watcher: status changed, running={}, terminal_alive={}, wsl_running={}", running, terminal_alive, wsl_running));
                let _ = app.emit("wsl-status-changed", running);
            }
        }
    });
}

/// 启动 WSL 终端（可指定分发版）
/// 直接启动 wsl.exe 并分配独立控制台窗口，避免 PowerShell 参数传递问题
#[tauri::command]
fn launch_wsl(dist: Option<String>) -> Result<(), String> {
    dbg_log(&format!("launch_wsl: dist={:?}", dist));
    // 通过 Windows Terminal (wt.exe) 启动，支持多标签。
    // 仅首次调用时检测 wt.exe 是否存在，后续复用缓存结果。
    static USE_WT: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    let use_wt = *USE_WT.get_or_init(|| {
        // 用 where 命令静默检测 wt.exe 是否存在，避免 --version 弹出对话框
        std::process::Command::new("cmd")
            .args(["/c", "where", "wt.exe"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    });
    let mut cmd = if use_wt {
        let dist_name = dist.as_deref().unwrap_or("Ubuntu-20.04");
        // 获取 WSL 用户主目录，用于设置终端启动路径
        let home = std::process::Command::new("wsl.exe")
            .args(["-d", dist_name, "--", "printenv", "HOME"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    String::from_utf8(o.stdout).ok().map(|s| s.trim().to_string())
                } else {
                    None
                }
            });
        let mut c = std::process::Command::new("wt.exe");
        // 使用 Windows Terminal 的 WSL 配置文件（带图标和正确配色）
        c.args(["-p", dist_name]);
        // 设置启动目录为 WSL 主目录
        if let Some(ref h) = home {
            c.args(["--startingDirectory", h]);
        }
        c
    } else {
        // conhost.exe 回退：确保控制台窗口正确初始化
        let mut args: Vec<String> = Vec::new();
        args.push("wsl.exe".to_string());
        if let Some(ref d) = dist {
            args.push("-d".to_string());
            args.push(d.clone());
        }
        let mut c = std::process::Command::new("conhost.exe");
        c.args(&args);
        c
    };
    #[cfg(windows)]
    cmd.creation_flags(0x10);
    let child = cmd.spawn().map_err(|e| {
        let msg = format!("launch_wsl spawn failed: {}", e);
        dbg_log(&msg);
        msg
    })?;
    dbg_log(&format!("launch_wsl: spawned pid={}, use_wt={}", child.id(), use_wt));
    if use_wt {
        // wt.exe 会立即退出，不追踪其 PID，让 watcher 以 WSL 实际状态为准
        *WSL_TERMINAL_PID.lock().unwrap() = None;
    } else {
        *WSL_TERMINAL_PID.lock().unwrap() = Some(child.id());
    }
    Ok(())
}

/// 关闭指定 WSL 发行版（异步，不阻塞 UI）
#[tauri::command]
async fn shutdown_wsl(dist: String) -> Result<(), String> {
    *WSL_TERMINAL_PID.lock().unwrap() = None;
    tauri::async_runtime::spawn_blocking(move || {
        let out = hidden_command("wsl")
            .args(["-t", &dist])
            .output()
            .map_err(|e| format!("{}", e))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(format!("关闭 WSL 发行版失败: {}", stderr.trim()));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))?
}

/// 获取所有 WSL 分发版信息
#[tauri::command]
fn get_wsl_distributions() -> Result<Vec<serde_json::Value>, String> {
    // 检查由 launch_wsl 启动的终端进程是否仍然存活
    let terminal_alive = {
        let pid = WSL_TERMINAL_PID.lock().unwrap();
        match *pid {
            Some(p) => is_process_alive(p),
            None => true, // 未跟踪终端进程时，以 WSL 实际状态为准
        }
    };

    let output = hidden_command("wsl")
        .args(["--list", "--verbose"])
        .output()
        .map_err(|e| format!("{}", e))?;

    let text = decode_wsl_output(&output.stdout);
    let mut distros: Vec<serde_json::Value> = Vec::new();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        let lower = line.to_lowercase();
        if lower.starts_with("name") || lower.starts_with("名称") || lower.starts_with("version") || lower.starts_with("版本") {
            continue;
        }

        let is_default = line.starts_with('*');
        let trimmed = if is_default { line[1..].trim_start() } else { line };
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() < 2 { continue; }

        let name = parts[0].to_string();
        let state_str = parts[1].to_lowercase();
        let wsl_says_running = state_str.contains("running") || state_str.contains("运行");
        // 终端窗口已关闭时，即使 WSL 发行版仍在后台运行，也视为未启动
        let running = wsl_says_running && terminal_alive;

        let (uptime, mem_used, mem_total) = if wsl_says_running {
            // 用 timeout 避免命令阻塞，且不启动已停止的发行版
            let uptime_out = hidden_command("wsl")
                .args(["-d", &name, "--", "cat", "/proc/uptime"])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
            let uptime = match uptime_out {
                Ok(o) => {
                    let raw = decode_wsl_output(&o.stdout);
                    parse_uptime_hms(&raw)
                }
                Err(_) => String::new(),
            };
            let free_out = hidden_command("wsl")
                .args(["-d", &name, "--", "free", "-m"])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
            let (total, used) = match free_out {
                Ok(o) => parse_free_output(&decode_wsl_output(&o.stdout)),
                Err(_) => (0, 0),
            };
            (uptime, used, total)
        } else {
            (String::new(), 0u64, 0u64)
        };

        distros.push(serde_json::json!({
            "name": name,
            "isDefault": is_default,
            "running": running,
            "uptime": uptime,
            "memUsedMB": mem_used,
            "memTotalMB": mem_total,
        }));
    }

    Ok(distros)
}

fn parse_free_output(text: &str) -> (u64, u64) {
    for line in text.lines() {
        if line.starts_with("Mem:") {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 3 {
                let total = parts[1].parse::<u64>().unwrap_or(0);
                let used = parts[2].parse::<u64>().unwrap_or(0);
                return (total, used);
            }
        }
    }
    (0, 0)
}

fn parse_uptime_hms(text: &str) -> String {
    // /proc/uptime 格式: "12345.67 56789.01"
    let secs = text.split_whitespace()
        .next()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0) as u64;
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    format!("{:02}:{:02}:{:02}", h, m, s)
}

// ===== WSL 串口转发（通过子进程管道）=====

/// 验证 WSL 设备路径合法性（只允许 /dev/ttyXXX 格式）
fn validate_device_path(path: &str) -> Result<(), String> {
    if !path.starts_with("/dev/tty") {
        return Err("设备路径必须以 /dev/tty 开头".into());
    }
    if !path.chars().all(|c| c.is_alphanumeric() || c == '/' || c == '_') {
        return Err("设备路径包含非法字符".into());
    }
    if path.contains("..") || path.contains(' ') || path.contains(';') || path.contains('&') || path.contains('|') {
        return Err("设备路径包含非法字符".into());
    }
    Ok(())
}

/// 缓存已运行的发行版名（避免每次都检测）
static CACHED_DISTRO: Mutex<Option<String>> = Mutex::new(None);

/// 获取 WSL 发行版名称：优先已运行的，其次默认发行版
fn get_or_start_wsl_distro() -> Result<String, String> {
    // 先检查缓存
    {
        let cached = CACHED_DISTRO.lock().unwrap();
        if let Some(ref name) = *cached {
            return Ok(name.clone());
        }
    }
    // 优先选择已在运行的发行版
    let running = check_wsl_running().unwrap_or_default();
    if let Some(name) = running.first() {
        *CACHED_DISTRO.lock().unwrap() = Some(name.clone());
        return Ok(name.clone());
    }
    // 没有运行中的，选择默认发行版并启动
    let out = hidden_command("wsl")
        .args(["--list", "--verbose"])
        .output()
        .map_err(|e| format!("获取 WSL 列表失败: {}", e))?;
    let text = decode_wsl_output(&out.stdout);
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('*') {
            let name = line[1..].trim().split_whitespace().next()
                .ok_or("无法解析默认发行版名称")?;
            let _ = hidden_command("wsl")
                .args(["-d", name, "-e", "echo", "ok"])
                .output();
            *CACHED_DISTRO.lock().unwrap() = Some(name.to_string());
            return Ok(name.to_string());
        }
    }
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        let lower = line.to_lowercase();
        if lower.starts_with("name") || lower.starts_with("version") { continue; }
        let name = line.split_whitespace().next()
            .ok_or("无法解析发行版名称")?;
        let _ = hidden_command("wsl")
            .args(["-d", name, "-e", "echo", "ok"])
            .output();
        *CACHED_DISTRO.lock().unwrap() = Some(name.to_string());
        return Ok(name.to_string());
    }
    Err("没有可用的 WSL 发行版".into())
}

/// 部署 bridge 脚本到指定 WSL 发行版（通过 /mnt 路径直接写入）
fn deploy_bridge(distro: &str) -> Result<(), String> {
    // 先检查 bridge 是否已存在（跳过重复部署）
    let check = hidden_command("wsl")
        .args(["-d", distro, "-e", "test", "-f", BRIDGE_SCRIPT_PATH])
        .output();
    if let Ok(o) = check { if o.status.success() { return Ok(()); } }

    let b64 = BRIDGE_B64.trim();
    let tmp_b64 = std::env::temp_dir().join("seahi_bridge_b64.txt");
    std::fs::write(&tmp_b64, b64).map_err(|e| format!("写入临时文件失败: {}", e))?;
    let win_path = tmp_b64.to_string_lossy().to_string();
    let drive = win_path.chars().next().unwrap_or('c').to_lowercase();
    let rest = win_path[2..].replace('\\', "/");
    let mnt_path = format!("/mnt/{}{}", drive, rest);
    let decode_cmd = format!("base64 -d < {} > {}", mnt_path, BRIDGE_SCRIPT_PATH);
    let out = hidden_command("wsl")
        .args(["-d", distro, "-e", "bash", "-c", &decode_cmd])
        .output()
        .map_err(|e| format!("解码失败: {}", e))?;
    let _ = std::fs::remove_file(&tmp_b64);
    if out.status.success() { Ok(()) } else { Err(format!("部署 bridge 失败: {}", String::from_utf8_lossy(&out.stderr))) }
}

/// 启动 bridge 进程（使用 hidden_command 隐藏窗口 + sg dialout 切换组）
fn spawn_bridge(distro: &str) -> Result<std::process::Child, String> {
    let child = hidden_command("wsl")
        .args(["-d", distro, "-e", "sg", "dialout", "-c", &format!("python3 {}", BRIDGE_SCRIPT_PATH)])
        .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 bridge 失败: {}", e))?;
    Ok(child)
}
fn bridge_command(session: &WslSerialSession, cmd: &serde_json::Value) -> Result<serde_json::Value, String> {
    use std::io::{BufRead, Write};
    use std::sync::mpsc;
    let mut msg = serde_json::to_string(cmd).map_err(|e| format!("序列化失败: {}", e))?;
    msg.push('\n');
    {
        let mut w = session.writer.lock().map_err(|e| format!("锁失败: {}", e))?;
        w.write_all(msg.as_bytes()).map_err(|e| format!("写入失败: {}", e))?;
        w.flush().map_err(|e| format!("刷新失败: {}", e))?;
    }
    // 在独立线程中读取，通过 channel 超时保护，防止 bridge 挂起导致永久阻塞
    let reader = session.reader.clone();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let result = (|| -> Result<String, String> {
            let mut r = reader.lock().map_err(|e| format!("锁失败: {}", e))?;
            let mut resp_line = String::new();
            match r.read_line(&mut resp_line) {
                Ok(0) => Err("bridge 进程已退出".into()),
                Ok(_) => Ok(resp_line),
                Err(e) => Err(format!("读取 bridge 响应失败: {}", e)),
            }
        })();
        let _ = tx.send(result);
    });
    match rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(Ok(resp_line)) => {
            serde_json::from_str(resp_line.trim()).map_err(|e| format!("解析响应失败: {}", e))
        }
        Ok(Err(e)) => {
            if e.contains("bridge 进程已退出") {
                let mut c = session.child.lock().map_err(|e| format!("锁失败: {}", e))?;
                let _ = c.kill();
            }
            Err(e)
        }
        Err(_) => {
            let mut c = session.child.lock().map_err(|e| format!("锁失败: {}", e))?;
            let _ = c.kill();
            Err("bridge 响应超时(5s)".into())
        }
    }
}

/// 打开 WSL 串口（通过 bridge 管道）
#[tauri::command]
fn open_wsl_serial(
    state: tauri::State<'_, WslSerialState>,
    monitor_id: String,
    device_path: String,
    baud_rate: u32,
) -> Result<(), String> {
    validate_device_path(&device_path)?;
    { let mut s = state.sessions.lock().unwrap(); if let Some(old) = s.remove(&monitor_id) { { let mut c = old.child.lock().unwrap(); let _ = c.kill(); let _ = c.wait(); } } }
    let distro = get_or_start_wsl_distro().map_err(|e| {
        // 连接失败时清除缓存，下次重新检测
        *CACHED_DISTRO.lock().unwrap() = None;
        e
    })?;
    deploy_bridge(&distro)?;
    let mut child = spawn_bridge(&distro)?;
    let stderr = child.stderr.take().ok_or("无法获取 stderr")?;
    let ready = std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::BufReader::new(stderr).lines() {
            match line { Ok(l) if l.trim() == "ready" => return true, Err(_) => return false, _ => {} }
        }
        false
    }).join().unwrap_or(false);
    if !ready { let _ = child.kill(); let _ = child.wait(); return Err("bridge 启动超时".into()); }
    let stdout = child.stdout.take().ok_or("无法获取 stdout")?;
    let stdin = child.stdin.take().ok_or("无法获取 stdin")?;
    let writer = std::sync::Mutex::new(std::io::BufWriter::new(stdin));
    let reader = std::sync::Arc::new(std::sync::Mutex::new(std::io::BufReader::new(stdout)));
    let session = WslSerialSession { child: std::sync::Arc::new(std::sync::Mutex::new(child)), writer, reader };
    let resp = bridge_command(&session, &json!({"cmd":"open","id":&monitor_id,"path":&device_path,"baud":baud_rate}))?;
    if resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        state.sessions.lock().unwrap().insert(monitor_id, session);
        Ok(())
    } else {
        let err = resp.get("error").and_then(|v| v.as_str()).unwrap_or("打开失败").to_string();
        { let mut c = session.child.lock().unwrap(); let _ = c.kill(); let _ = c.wait(); }
        Err(err)
    }
}

/// 关闭 WSL 串口连接
#[tauri::command]
fn close_wsl_serial(state: tauri::State<'_, WslSerialState>, monitor_id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.remove(&monitor_id) {
        { use std::io::Write; if let Ok(mut w) = session.writer.lock() { let _ = w.write_all(b"{\"cmd\":\"close\"}\n"); let _ = w.flush(); } }
        { let mut c = session.child.lock().unwrap(); let _ = c.kill(); let _ = c.wait(); }
    }
    Ok(())
}

/// 读取 WSL 串口数据
#[tauri::command]
fn read_wsl_serial(state: tauri::State<'_, WslSerialState>, monitor_id: String) -> Result<Vec<u8>, String> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions.get(&monitor_id).ok_or("未连接 WSL 串口")?;
    let resp = bridge_command(session, &json!({"cmd":"read","id":&monitor_id,"max":4096}))?;
    if resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        let b64 = resp.get("data").and_then(|v| v.as_str()).unwrap_or("");
        use base64::Engine;
        Ok(base64::engine::general_purpose::STANDARD.decode(b64).unwrap_or_default())
    } else {
        let err = resp.get("error").and_then(|v| v.as_str()).unwrap_or("读取失败");
        if err.contains("port not open") || err.contains("Resource temporarily unavailable") { Ok(vec![]) } else { Err(err.to_string()) }
    }
}

/// 向 WSL 串口发送数据
#[tauri::command]
fn send_wsl_serial(state: tauri::State<'_, WslSerialState>, monitor_id: String, data: Vec<u8>) -> Result<usize, String> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions.get(&monitor_id).ok_or("未连接 WSL 串口")?;
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
    let resp = bridge_command(session, &json!({"cmd":"write","id":&monitor_id,"data":b64}))?;
    if resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        Ok(resp.get("n").and_then(|v| v.as_u64()).unwrap_or(data.len() as u64) as usize)
    } else {
        Err(resp.get("error").and_then(|v| v.as_str()).unwrap_or("写入失败").to_string())
    }
}

/// 设置 WSL 串口信号
fn set_wsl_signal_cmd(state: tauri::State<'_, WslSerialState>, monitor_id: String, level: bool, signal: &str) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions.get(&monitor_id).ok_or("未连接 WSL 串口")?;
    let resp = bridge_command(session, &json!({"cmd":signal.to_lowercase(),"id":&monitor_id,"level":level}))?;
    if resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) { Ok(()) } else { Err(resp.get("error").and_then(|v| v.as_str()).unwrap_or("设置信号失败").to_string()) }
}

/// 获取 WSL 中可用的串口设备列表（使用持久化 shell，毫秒级响应）
#[tauri::command]
fn get_wsl_serial_devices() -> Result<Vec<String>, String> {
    let distros = check_wsl_running().unwrap_or_default();
    let distro = distros.first().cloned().unwrap_or_default();
    if distro.is_empty() {
        dbg_log("get_wsl_serial_devices: no running distro");
        return Ok(vec![]);
    }

    let output = wsl_shell_exec(&distro, "ls /dev/ttyACM* /dev/ttyUSB* /dev/ttyS* 2>/dev/null || true", 2000)?;
    let devices: Vec<String> = output
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s.starts_with("/dev/tty"))
        .collect();
    dbg_log(&format!("get_wsl_serial_devices: distro={}, raw={}, devices={:?}", distro, output.trim(), devices));
    Ok(devices)
}

#[tauri::command]
fn set_wsl_dtr(state: tauri::State<'_, WslSerialState>, monitor_id: String, level: bool) -> Result<(), String> {
    set_wsl_signal_cmd(state, monitor_id, level, "DTR")
}

#[tauri::command]
fn set_wsl_rts(state: tauri::State<'_, WslSerialState>, monitor_id: String, level: bool) -> Result<(), String> {
    set_wsl_signal_cmd(state, monitor_id, level, "RTS")
}

/// 将指定串口对应的 USB 设备映射到 WSL
/// 通过 usbipd 工具实现：
///   1. usbipd list 找到目标端口的 busid
///   2. 检查绑定状态，已绑定则直接 attach（无需管理员权限）
///   3. 未绑定则通过 PowerShell 提权执行 bind + attach
#[tauri::command]
async fn attach_port_to_wsl(port_name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || attach_port_to_wsl_blocking(port_name))
        .await
        .map_err(|e| format!("任务执行失败: {}", e))?
}

fn attach_port_to_wsl_blocking(port_name: String) -> Result<String, String> {
    // 0. 检查是否有正在运行的 WSL 发行版
    let wsl_check = hidden_command("wsl")
        .args(["--list", "--running"])
        .output();
    match wsl_check {
        Ok(out) => {
            let text = decode_wsl_output(&out.stdout);
            let has_running = text.lines()
                .any(|line| {
                    let l = line.trim();
                    !l.is_empty() && !l.contains("Distributions") && !l.contains("分发")
                });
            if !has_running {
                return Err("WSL 未运行，请先打开一个 WSL 终端窗口再进行映射".to_string());
            }
        }
        Err(e) => {
            return Err(format!("检测 WSL 状态失败: {}，请确认 WSL 已安装", e));
        }
    }

    // 1. 获取设备列表
    use std::sync::mpsc;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let result = hidden_command("usbipd")
            .args(["list"])
            .output();
        let _ = tx.send(result);
    });

    let list_out = match rx.recv_timeout(std::time::Duration::from_secs(3)) {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return Err(format!("执行 usbipd list 失败: {}", e)),
        Err(_) => return Err("usbipd list 执行超时（3 秒），请确认 usbipd-win 已正确安装".to_string()),
    };

    if !list_out.status.success() {
        return Err(String::from_utf8_lossy(&list_out.stderr).to_string());
    }

    let list_str = String::from_utf8_lossy(&list_out.stdout).to_string();

    // 2. 找到目标行：如果传入的是 busid 格式则按 busid 匹配，否则按 COM 口名匹配
    let is_busid = port_name.contains('-') && {
        let mut parts = port_name.splitn(2, '-');
        let a = parts.next().unwrap_or("");
        let b = parts.next().unwrap_or("");
        !a.is_empty() && a.chars().all(|c| c.is_ascii_digit())
            && !b.is_empty() && b.chars().all(|c| c.is_ascii_digit())
    };

    let target_line = if is_busid {
        list_str.lines()
            .find(|line| {
                let parts: Vec<&str> = line.split_whitespace().collect();
                parts.first().map(|s| *s == port_name).unwrap_or(false)
            })
            .ok_or_else(|| format!("在 usbipd 设备列表中未找到 busid {}", port_name))?
    } else {
        list_str.lines()
            .find(|line| line.to_uppercase().contains(&port_name.to_uppercase()))
            .ok_or_else(|| format!("在 usbipd 设备列表中未找到 {}，请确认设备已连接", port_name))?
    };

    let busid = if is_busid {
        port_name.clone()
    } else {
        target_line.split_whitespace()
            .find(|s| {
                let mut parts = s.splitn(2, '-');
                let a = parts.next().unwrap_or("");
                let b = parts.next().unwrap_or("");
                !a.is_empty() && a.chars().all(|c| c.is_ascii_digit())
                    && !b.is_empty() && b.chars().all(|c| c.is_ascii_digit())
            })
            .ok_or_else(|| format!("无法解析 {} 的 busid（行: {}）", port_name, target_line.trim()))?
            .to_string()
    };

    let already_bound = {
        let line_upper = target_line.to_uppercase();
        line_upper.contains("SHARED") && !line_upper.contains("NOT SHARED")
    };
    dbg_log(&format!("Device {} bound status: {} (line: {})", busid, already_bound, target_line));

    // 已经映射到WSL，直接返回成功
    if target_line.to_uppercase().contains("ATTACHED") {
        return Ok(format!("已将 {} (busid: {}) 映射到 WSL", port_name, busid));
    }

    // 4. 如果已绑定，尝试直接 attach（无需管理员权限）
    if already_bound {
        dbg_log(&format!("Device {} already bound, trying direct attach", busid));
        let output = hidden_command("usbipd")
            .args(["attach", "--wsl", "--busid", &busid])
            .output();

        match output {
            Ok(out) if out.status.success() => {
                dbg_log(&format!("Direct attach succeeded for {}", busid));
                return Ok(format!("已将 {} (busid: {}) 映射到 WSL", port_name, busid));
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                dbg_log(&format!("Direct attach failed for {}: stderr={}, stdout={}", busid, stderr, stdout));
                // 直接attach失败，需要用管理员权限
            }
            Err(e) => {
                dbg_log(&format!("Direct attach command error for {}: {}", busid, e));
                return Err(format!("执行 usbipd attach 失败: {}", e));
            }
        }
    }

    // 5. 未绑定 或 直接attach失败，需要管理员权限
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let unique_id = COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_result = std::env::temp_dir().join(format!("usbipd_result_{}_{}.txt", std::process::id(), unique_id));
    let tmp_result_str = tmp_result.to_str().unwrap_or("C:\\Temp\\usbipd_result.txt").replace('\'', "''");

    let ps_script = if already_bound {
        // 已绑定但直接attach失败，用管理员权限attach
        dbg_log(&format!("Using admin to attach {}", busid));
        format!(
            "try {{ \
               $out = & usbipd.exe attach --wsl --busid {busid} 2>&1 | Out-String; \
               $out | Out-File -FilePath '{result}' -Encoding UTF8; \
               if ($LASTEXITCODE -ne 0) {{ exit 1 }} \
             }} catch {{ \
               $_.Exception.Message | Out-File -FilePath '{result}' -Encoding UTF8; \
               exit 1 \
             }}",
            busid = busid,
            result = tmp_result_str
        )
    } else {
        // 未绑定，用管理员权限bind + attach
        dbg_log(&format!("Using admin to bind and attach {}", busid));
        format!(
            "try {{ \
               '开始绑定设备 {busid}...' | Out-File -FilePath '{result}' -Encoding UTF8; \
               $bindOut = & usbipd.exe bind --busid {busid} 2>&1 | Out-String; \
               'bind输出: ' + $bindOut | Out-File -FilePath '{result}' -Encoding UTF8 -Append; \
               if ($LASTEXITCODE -ne 0) {{ \
                 'bind失败，退出码: ' + $LASTEXITCODE | Out-File -FilePath '{result}' -Encoding UTF8 -Append; \
                 exit 1 \
               }}; \
               'bind成功，开始附加到WSL...' | Out-File -FilePath '{result}' -Encoding UTF8 -Append; \
               $attachOut = & usbipd.exe attach --wsl --busid {busid} 2>&1 | Out-String; \
               'attach输出: ' + $attachOut | Out-File -FilePath '{result}' -Encoding UTF8 -Append; \
               if ($LASTEXITCODE -ne 0) {{ \
                 'attach失败，退出码: ' + $LASTEXITCODE | Out-File -FilePath '{result}' -Encoding UTF8 -Append; \
                 exit 1 \
               }}; \
               '操作成功' | Out-File -FilePath '{result}' -Encoding UTF8 -Append \
             }} catch {{ \
               '异常: ' + $_.Exception.Message | Out-File -FilePath '{result}' -Encoding UTF8; \
               exit 1 \
             }}",
            busid = busid,
            result = tmp_result_str
        )
    };

    // 6. 通过临时 .ps1 文件 + Start-Process -Verb RunAs 触发 UAC 提权
    let tmp_script = std::env::temp_dir().join(format!("usbipd_script_{}_{}.ps1", std::process::id(), unique_id));
    let _ = std::fs::remove_file(&tmp_result);
    let _ = std::fs::write(&tmp_script, &ps_script);

    let script_path_str = tmp_script.to_str().unwrap_or("");

    dbg_log(&format!("PowerShell script file: {:?}", tmp_script));

    let status = hidden_command("powershell")
        .args(["-NonInteractive", "-Command"])
        .arg({
            let sp = script_path_str.replace('\'', "''");
            format!("Start-Process -FilePath 'powershell' -ArgumentList '-ExecutionPolicy','Bypass','-NonInteractive','-File','{}' -Verb RunAs -Wait", sp)
        })
        .status()
        .map_err(|e| format!("提权启动失败: {}", e))?;

    let _ = std::fs::remove_file(&tmp_script);
    std::thread::sleep(std::time::Duration::from_millis(500));

    // 7. 读取提权进程写入的结果文件
    dbg_log(&format!("Reading result file: {:?}", tmp_result));
    let result_content = std::fs::read_to_string(&tmp_result)
        .unwrap_or_else(|e| {
            dbg_log(&format!("Failed to read result file: {}", e));
            String::new()
        })
        .trim()
        .to_string();
    dbg_log(&format!("Result content: {}", result_content));
    let _ = std::fs::remove_file(&tmp_result);

    // 检查是否成功 - 通过结果内容判断
    if result_content.contains("操作成功") {
        Ok(format!("已将 {} (busid: {}) 绑定并映射到 WSL", port_name, busid))
    } else if result_content.contains("绑定失败") || result_content.contains("附加失败") {
        Err(format!("映射失败: {}", result_content))
    } else if !status.success() {
        Err("操作失败或用户取消了管理员权限请求".to_string())
    } else {
        // status.success() 但结果不明确，可能是用户取消了UAC
        Err("操作未完成，可能用户取消了管理员权限请求".to_string())
    }
}

/// 断开WSL串口映射
#[tauri::command]
async fn detach_port_from_wsl(busid: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // 先尝试普通权限
        let output = hidden_command("usbipd")
            .args(["detach", "--busid", &busid])
            .output()
            .map_err(|e| format!("执行 usbipd detach 失败: {}", e))?;

        if output.status.success() {
            return Ok(format!("已断开 {} 的WSL映射", busid));
        }

        // 普通权限失败，尝试管理员权限
        dbg_log(&format!("usbipd detach 失败，尝试提权: {}", String::from_utf8_lossy(&output.stderr)));
        let result = run_usbipd_detach_elevated(&busid);
        match result {
            Some(s) if s.contains("成功") || s.is_empty() => Ok(format!("已断开 {} 的WSL映射", busid)),
            Some(s) => Err(format!("断开失败: {}", s)),
            None => Err("断开失败，可能用户取消了管理员权限请求".to_string()),
        }
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))?
}

/// 通过 UAC 提权执行 usbipd detach
fn run_usbipd_detach_elevated(busid: &str) -> Option<String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static DETACH_COUNTER: AtomicU64 = AtomicU64::new(0);
    let unique_id = DETACH_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_result = std::env::temp_dir().join(format!("usbipd_detach_{}_{}.txt", std::process::id(), unique_id));
    let tmp_result_str = tmp_result.to_str().unwrap_or("C:\\Temp\\usbipd_detach.txt").replace('\'', "''");

    let ps_script = format!(
        "try {{ \
           $out = & usbipd.exe detach --busid {busid} 2>&1 | Out-String; \
           $out | Out-File -FilePath '{result}' -Encoding UTF8; \
         }} catch {{ \
           $_.Exception.Message | Out-File -FilePath '{result}' -Encoding UTF8; \
         }}",
        busid = busid,
        result = tmp_result_str
    );

    let tmp_script = std::env::temp_dir().join(format!("usbipd_detach_script_{}_{}.ps1", std::process::id(), unique_id));
    let _ = std::fs::remove_file(&tmp_result);
    let _ = std::fs::write(&tmp_script, &ps_script);

    let script_path_str = tmp_script.to_str().unwrap_or("");
    let sp = script_path_str.replace('\'', "''");
    let _ = hidden_command("powershell")
        .args(["-NonInteractive", "-Command"])
        .arg(format!("Start-Process -FilePath 'powershell' -ArgumentList '-ExecutionPolicy','Bypass','-NonInteractive','-File','{}' -Verb RunAs -Wait", sp))
        .status();
    let _ = std::fs::remove_file(&tmp_script);
    std::thread::sleep(std::time::Duration::from_millis(500));

    let result = std::fs::read_to_string(&tmp_result).ok();
    let _ = std::fs::remove_file(&tmp_result);
    result
}

/// 保存用户配置到 AppData 目录
#[tauri::command]
fn save_config(config_json: String) -> Result<(), String> {
    use std::fs;

    let config_dir = dirs_config_path().ok_or("无法获取应用配置目录")?;
    fs::create_dir_all(&config_dir).map_err(|e| format!("创建配置目录失败: {}", e))?;
    let config_file = config_dir.join("config.json");
    fs::write(&config_file, &config_json).map_err(|e| format!("写入配置失败: {}", e))?;
    Ok(())
}

/// 读取用户配置（不存在时返回空字符串）
#[tauri::command]
fn load_config() -> Result<String, String> {
    use std::fs;

    let config_dir = match dirs_config_path() {
        Some(p) => p,
        None => return Ok(String::new()),
    };
    let config_file = config_dir.join("config.json");
    match fs::read_to_string(&config_file) {
        Ok(s) => Ok(s),
        Err(_) => Ok(String::new()),
    }
}

/// 获取应用配置目录路径（跨平台）
fn dirs_config_path() -> Option<std::path::PathBuf> {
    // Windows: %APPDATA%\seahi-serial
    // macOS:   ~/Library/Application Support/seahi-serial
    // Linux:   ~/.config/seahi-serial
    #[cfg(windows)]
    {
        std::env::var("APPDATA").ok().map(|p| std::path::PathBuf::from(p).join("seahi-serial"))
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME").ok().map(|p| std::path::PathBuf::from(p).join(".config").join("seahi-serial"))
    }
}

/// 保存日志内容到文件
#[tauri::command]
fn save_log(content: String, path: String) -> Result<(), String> {
    use std::fs;
    use std::path::Path;

    if path.is_empty() {
        return Err("未设置日志目录".into());
    }

    let filename = {
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::SystemInformation::GetLocalTime;
            use windows_sys::Win32::Foundation::SYSTEMTIME;
            let mut st: SYSTEMTIME = unsafe { std::mem::zeroed() };
            unsafe { GetLocalTime(&mut st) };
            format!(
                "Serial Debug {:04}-{:02}-{:02} {:02}{:02}{:02}.txt",
                st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond
            )
        }
        #[cfg(not(windows))]
        {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::SystemTime::UNIX_EPOCH)
                .unwrap_or_default();
            format!("Serial Debug {}.txt", now.as_secs())
        }
    };
    let filepath = Path::new(&path).join(&filename);

    fs::write(&filepath, content).map_err(|e| format!("写入日志失败: {}", e))?;
    Ok(())
}

// ===== 自动更新功能 =====

/// GitHub Releases API 响应结构体（简化版）
#[derive(Debug, serde::Deserialize)]
struct GitHubRelease {
    tag_name: String,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, serde::Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

/// 返回给前端的更新信息
#[derive(Debug, serde::Serialize)]
struct UpdateInfo {
    has_update: bool,
    latest_version: String,
    current_version: String,
    download_url: String,
}

/// 解析版本号字符串，返回 (major, minor, patch) 元组
fn parse_version(ver: &str) -> (u32, u32, u32) {
    let ver = ver.trim_start_matches('v').trim_start_matches('V');
    let parts: Vec<&str> = ver.split('.').collect();
    let major = parts.get(0).and_then(|p| p.parse().ok()).unwrap_or(0);
    let minor = parts.get(1).and_then(|p| p.parse().ok()).unwrap_or(0);
    let patch = parts.get(2).and_then(|p| p.parse().ok()).unwrap_or(0);
    (major, minor, patch)
}



/// 比较版本号：如果 latest > current，返回 true
fn is_newer_version(current: &str, latest: &str) -> bool {
    parse_version(current) < parse_version(latest)
}

/// 获取当前程序版本号（从 Cargo.toml 的 version 字段编译时注入）
fn get_current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// 返回应用版本号和 commit hash（前6位），用于前端 tooltip 显示
#[derive(Debug, serde::Serialize)]
struct AppInfo {
    version: String,
    commit: String,
}

#[tauri::command]
fn get_app_info() -> AppInfo {
    let commit = option_env!("GIT_COMMIT_HASH")
        .unwrap_or("dev")
        .to_string();
    AppInfo {
        version: get_current_version(),
        commit,
    }
}

/// 检查 GitHub Releases 是否有新版本
#[tauri::command]
async fn check_update() -> Result<UpdateInfo, String> {
    let current = get_current_version();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let api_url = "https://api.github.com/repos/SeaHi-Mo/Seahi-Serial/releases/latest";

    // 尝试多个来源检查更新
    let mut resp = None;

    // 1. 直连 GitHub API
    let direct = client
        .get(api_url)
        .header("User-Agent", "seahi-serial-updater")
        .send()
        .await;
    if let Ok(r) = direct {
        if r.status().is_success() {
            resp = Some(r);
        }
    }

    // 2. 尝试镜像（ghproxy 已失效，跳过）
    if resp.is_none() {
        // 暂无可用镜像，静默失败
        return Err("无法连接 GitHub，请检查网络".to_string());
    }

    let resp = resp.unwrap();

    if !resp.status().is_success() {
        return Err(format!("GitHub API 返回错误状态码: {}", resp.status()));
    }

    let release: GitHubRelease = resp
        .json()
        .await
        .map_err(|e| format!("解析 GitHub 响应失败: {}", e))?;

    let has_update = is_newer_version(&current, &release.tag_name);

    // 查找 Windows 安装包（优先 NSIS .exe，其次 .msi）
    let download_url = if has_update {
        let asset = release
            .assets
            .iter()
            .find(|a| a.name.to_lowercase().contains("-setup") && a.name.ends_with(".exe"))
            .or_else(|| release.assets.iter().find(|a| a.name.ends_with(".exe")))
            .or_else(|| release.assets.iter().find(|a| a.name.ends_with(".msi")));
        
        match asset {
            Some(a) => a.browser_download_url.clone(),
            None => String::new(),
        }
    } else {
        String::new()
    };

    Ok(UpdateInfo {
        has_update,
        latest_version: release.tag_name,
        current_version: current,
        download_url,
    })
}

/// 下载更新安装包到临时目录
#[tauri::command]
async fn download_update(download_url: String) -> Result<String, String> {
    use std::fs;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    // 直连下载
    let resp = client
        .get(&download_url)
        .header("User-Agent", "seahi-serial-updater")
        .send()
        .await
        .map_err(|e| format!("下载失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("下载失败，HTTP 状态码: {}", resp.status()));
    }

    // 获取文件名
    let filename = download_url
        .rsplit_once('/')
        .map(|(_, name)| name)
        .unwrap_or("update-setup.exe")
        .to_string();

    // 保存到临时目录
    let temp_dir = std::env::temp_dir().join("seahi-serial-update");
    fs::create_dir_all(&temp_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;
    let file_path = temp_dir.join(&filename);

    let bytes = resp.bytes().await.map_err(|e| format!("读取下载内容失败: {}", e))?;
    fs::write(&file_path, &bytes).map_err(|e| format!("写入安装包失败: {}", e))?;

    Ok(file_path.to_string_lossy().to_string())
}

/// 启动安装包并退出当前程序
#[tauri::command]
fn install_update(app: tauri::AppHandle, file_path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        // Windows: 启动安装包，不等待其完成
        hidden_command("cmd")
            .args(["/c", "start", "", &file_path])
            .spawn()
            .map_err(|e| format!("启动安装程序失败: {}", e))?;
    }

    #[cfg(not(windows))]
    {
        Command::new(&file_path)
            .spawn()
            .map_err(|e| format!("启动安装程序失败: {}", e))?;
    }

    // 通知前端保存配置（beforeunload 可能被 process::exit 跳过）
    let _ = app.emit("save-before-exit", ());
    std::thread::sleep(std::time::Duration::from_millis(300));
    std::process::exit(0);
}

/// 获取窗口大小
#[tauri::command]
fn get_window_size(window: tauri::Window) -> Result<(u32, u32), String> {
    let size = window.inner_size().map_err(|e| format!("获取窗口大小失败: {}", e))?;
    Ok((size.width, size.height))
}

/// 设置窗口大小
#[tauri::command]
fn set_window_size(window: tauri::Window, width: u32, height: u32) -> Result<(), String> {
    let w = width.max(1000);
    let h = height.max(650);
    window.set_size(tauri::Size::Physical(tauri::PhysicalSize { width: w, height: h }))
        .map_err(|e| format!("设置窗口大小失败: {}", e))
}

/// 用系统默认浏览器打开 URL
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .spawn()
        .map_err(|e| format!("打开 URL 失败: {}", e))?;
    Ok(())
}

/// 设置标题栏颜色 (R, G, B)
#[tauri::command]
fn set_title_bar_color(window: tauri::Window, r: u8, g: u8, b: u8) -> Result<(), String> {
    dbg_log(&format!("set_title_bar_color: r={} g={} b={}", r, g, b));
    #[cfg(windows)]
    {
        use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_CAPTION_COLOR, DWMWA_USE_IMMERSIVE_DARK_MODE};

        unsafe {
            let hwnd = window.hwnd().map_err(|e| format!("获取窗口句柄失败: {}", e))?;
            let hwnd_ptr: *mut std::ffi::c_void = std::mem::transmute(hwnd.0);

            // 关闭沉浸式暗色模式
            let dark_mode: u32 = 0;
            DwmSetWindowAttribute(
                hwnd_ptr,
                DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
                &dark_mode as *const u32 as *const _,
                std::mem::size_of::<u32>() as u32,
            );

            // 设置标题栏颜色 (COLORREF: 0x00BBGGRR)
            let color: u32 = (b as u32) << 16 | (g as u32) << 8 | (r as u32);
            let hr = DwmSetWindowAttribute(
                hwnd_ptr,
                DWMWA_CAPTION_COLOR as u32,
                &color as *const u32 as *const _,
                std::mem::size_of::<u32>() as u32,
            );
            dbg_log(&format!("DWMWA_CAPTION_COLOR hr={} color=0x{:06X}", hr, color));
            if hr != 0 {
                return Err(format!("DwmSetWindowAttribute 失败: hr={}", hr));
            }
        }
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(PortState {
            readers: Mutex::new(HashMap::new()),
        })
        .manage(WslSerialState {
            sessions: Mutex::new(HashMap::new()),
        })
        .manage(WorkflowState {
            rules: Mutex::new(HashMap::new()),
            log_dirs: Mutex::new(HashMap::new()),
            regex_cache: std::sync::Arc::new(RegexCache::new()),
        })
        .invoke_handler(tauri::generate_handler![
            list_ports,
            list_wsl_devices,
            open_port,
            close_port,
            send_data,
            read_data,
            read_workflow_events,
            set_dtr,
            set_rts,
            choose_log_directory,
            save_log,
            attach_port_to_wsl,
            detach_port_from_wsl,
            check_wsl_status,
            launch_wsl,
            shutdown_wsl,
            get_wsl_distributions,
            save_config,
            load_config,
            check_update,
            download_update,
            install_update,
            get_window_size,
            set_window_size,
            open_wsl_serial,
            close_wsl_serial,
            read_wsl_serial,
            send_wsl_serial,
            get_wsl_serial_devices,
            set_wsl_dtr,
            set_wsl_rts,
            check_workflow_matches,
            save_workflows,
            load_workflows,
            init_workflows,
            update_workflow_log_dir,
            update_workflow_line_ending,
            open_url,
            set_title_bar_color,
            get_app_info,
        ])
        .setup(|app| {
            #[cfg(windows)]
            {
                start_device_watcher(app.handle().clone());
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_min_size(Some(tauri::LogicalSize::new(1000.0, 650.0)));
                }
            }
            start_wsl_watcher(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动应用失败");
}
