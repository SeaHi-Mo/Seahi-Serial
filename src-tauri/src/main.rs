// Release 模式下隐藏命令行窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use regex::Regex;
use serialport::{ClearBuffer, DataBits, Parity, SerialPort, StopBits};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::windows::process::CommandExt;
use std::sync::{Mutex, RwLock};

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

/// 全局错误上报通道（单线程消费，避免每次 spawn 新线程）
static ERROR_SENDER: std::sync::OnceLock<std::sync::mpsc::Sender<(String, String)>> = std::sync::OnceLock::new();

/// 最近一次检查更新得到的安装包信息缓存（download_url, sha256, size）。
/// 用于 download_update 校验，防止前端传入任意 URL / 任意大小值 → 任意代码下载。
static UPDATE_INFO_CACHE: std::sync::OnceLock<std::sync::Mutex<Option<(String, Option<String>, Option<u64>)>>> = std::sync::OnceLock::new();

/// 最近一次用户选择的日志保存目录（save_log 校验 path 必须等于它，防止任意路径写文件）
static LAST_LOG_DIR: std::sync::OnceLock<std::sync::Mutex<Option<String>>> = std::sync::OnceLock::new();

fn init_error_reporter() {
    let (tx, rx) = std::sync::mpsc::channel::<(String, String)>();
    std::thread::spawn(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .ok();
        if let Some(client) = client {
            while let Ok((error, context)) = rx.recv() {
                // 未显式配置 ERROR_SERVER_URL 时不上报（隐私：不默认发往公网端点）
                let Ok(server_url) = std::env::var("ERROR_SERVER_URL") else {
                    continue;
                };
                if server_url.trim().is_empty() {
                    continue;
                }
                let api_key = std::env::var("ERROR_API_KEY").unwrap_or_default();
                let payload = serde_json::json!({
                    "app_version": env!("CARGO_PKG_VERSION"),
                    "os": std::env::consts::OS,
                    "error": error,
                    "context": context,
                    "timestamp": chrono::Utc::now().to_rfc3339(),
                });
                let mut req = client.post(format!("{}/report", server_url.trim_end_matches('/'))).json(&payload);
                if !api_key.is_empty() {
                    req = req.header("X-API-Key", &api_key);
                }
                let _ = req.send();
            }
        }
    });
    let _ = ERROR_SENDER.set(tx);
}

/// 上报错误到 Sentry（带上下文信息）
#[cfg(feature = "sentry")]
fn report_error_to_sentry(error: &str, context: &str) {
    sentry::with_scope(
        |scope| {
            scope.set_tag("component", "seahi-serial");
            scope.set_extra("context", context.into());
            scope.set_extra("app_version", env!("CARGO_PKG_VERSION").into());
            scope.set_extra("os", std::env::consts::OS.into());
        },
        || {
            sentry::capture_message(error, sentry::Level::Error);
        },
    );
}

/// 上报错误到自建服务
fn report_to_self_hosted(error: &str, context: &str) {
    // Debug 模式不发往生产，除非显式设置了 ERROR_SERVER_URL
    #[cfg(debug_assertions)]
    {
        if std::env::var("ERROR_SERVER_URL").is_err() {
            dbg_log("[SKIP] Debug 模式未设置 ERROR_SERVER_URL，跳过上报");
            return;
        }
    }

    // 通过通道发送到上报线程，避免每次 spawn 新线程
    if let Some(tx) = ERROR_SENDER.get() {
        let _ = tx.send((error.to_string(), context.to_string()));
    }
}

/// 统一错误上报入口（根据配置选择上报方式）
fn report_error(error: &str, context: &str) {
    // 始终写入本地日志
    dbg_log(&format!("[ERROR] {}: {}", context, error));
    
    // 上报到 Sentry（如果配置了 DSN 且启用了 sentry feature）
    #[cfg(feature = "sentry")]
    {
        if std::env::var("SENTRY_DSN").is_ok() {
            report_error_to_sentry(error, context);
        }
    }
    
    // 上报到自建服务（如果配置了服务器地址）
    report_to_self_hosted(error, context);
}

/// 捕获 panic 并上报
fn set_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let thread_name = thread.name().unwrap_or("<unnamed>");
        
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "Box<dyn Any>".to_string()
        };
        
        let location = info.location().map(|l| {
            format!("{}:{}:{}", l.file(), l.line(), l.column())
        }).unwrap_or_default();
        
        let msg = format!("Panic in thread '{}': {} at {}", thread_name, payload, location);
        report_error(&msg, "panic_handler");
        
        // 调用原始 hook（输出到 stderr）
        default_hook(info);
    }));
}

#[cfg(windows)]
fn start_device_watcher(app: tauri::AppHandle) {
    use windows_sys::Win32::Devices::DeviceAndDriverInstallation::{
        CM_Register_Notification, CM_Unregister_Notification, CM_NOTIFY_FILTER, CM_NOTIFY_FILTER_TYPE_DEVICEINTERFACE,
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

        while !DEVICE_WATCHER_STOP.load(std::sync::atomic::Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
        dbg_log("device_watcher: stopped");

        // 回收 AppHandle Box，避免泄漏（此前用 Box::into_raw 换取回调内指针有效性）
        let _ = Box::from_raw(context as *mut tauri::AppHandle);
        // 注销设备通知
        if !notify_handle.is_null() {
            let _ = CM_Unregister_Notification(notify_handle);
        }
    });
}

/// 持久化 WSL shell：保持一个 WSL 进程存活，通过管道发送命令
/// 避免每次调用都 fork 新进程（WSL2 进程创建 ~300ms）
/// 用 Arc 持有：执行命令时克隆 Arc，超时/异常时可杀掉子进程，
/// 使被阻塞的读取线程因管道 EOF 退出，避免永久阻塞与线程泄漏。
struct WslShell {
    writer: std::sync::Mutex<std::io::BufWriter<std::process::ChildStdin>>,
    reader: std::sync::Arc<std::sync::Mutex<std::io::BufReader<std::process::ChildStdout>>>,
    child: std::sync::Arc<std::sync::Mutex<std::process::Child>>,
    /// 该 shell 绑定的 WSL 发行版（命中时校验，避免命令跑错发行版）
    distro: String,
}

static WSL_SHELL: Mutex<Option<std::sync::Arc<WslShell>>> = Mutex::new(None);
/// 标记 shell 需要重建（超时/进程退出后设置，get_wsl_shell 检查此标记）
static WSL_SHELL_DIRTY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// 串行化对持久化 WSL shell 的命令执行：shell 的读写是同一根管道，
/// 并发执行时会因一个个独立读线程各自截取 `___SEAHI_END___` 标记而串音
/// （A 命令拿到 B 命令的输出）。列表类命令改为 async 并发后必须靠这把锁串行。
static WSL_SHELL_CMD_LOCK: Mutex<()> = Mutex::new(());

/// 获取或创建持久化 WSL shell（返回 Arc，调用方不持有全局锁）
fn get_wsl_shell(distro: &str) -> Result<std::sync::Arc<WslShell>, String> {
    let mut slot = WSL_SHELL.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(s) = slot.as_ref() {
        let alive = !WSL_SHELL_DIRTY.load(std::sync::atomic::Ordering::Relaxed)
            && is_process_alive(s.child.lock().unwrap_or_else(|e| e.into_inner()).id());
        // 命中需同时满足 alive 且发行版一致，否则重建
        if alive && s.distro == distro {
            return Ok(s.clone());
        }
        *slot = None;
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
    let shell = std::sync::Arc::new(WslShell {
        writer: std::sync::Mutex::new(std::io::BufWriter::new(stdin)),
        reader: std::sync::Arc::new(std::sync::Mutex::new(std::io::BufReader::new(stdout))),
        child: std::sync::Arc::new(std::sync::Mutex::new(child)),
        distro: distro.to_string(),
    });
    *slot = Some(shell.clone());
    Ok(shell)
}

/// 通过持久化 shell 执行命令并返回输出
/// 读取在独立线程中进行，主线程用 recv_timeout 等待；
/// 超时/进程退出时杀掉子进程，让阻塞的读取线程随管道 EOF 退出。
fn wsl_shell_exec(distro: &str, cmd: &str, timeout_ms: u64) -> Result<String, String> {
    use std::io::{BufRead, Write};
    use std::sync::mpsc;
    // 串行执行：同一持久化 shell 的读写必须互斥，否则并发命令会串音
    let _cmd_guard = WSL_SHELL_CMD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let shell = get_wsl_shell(distro)?;

    let marker_start = "___SEAHI_START___";
    let marker_end = "___SEAHI_END___";
    let full_cmd = format!("echo {}; {} 2>&1; echo {}", marker_start, cmd, marker_end);
    {
        let mut w = shell.writer.lock().map_err(|e| format!("锁失败: {}", e))?;
        w.write_all(full_cmd.as_bytes()).map_err(|e| format!("写入失败: {}", e))?;
        w.write_all(b"\n").map_err(|e| format!("写入换行失败: {}", e))?;
        w.flush().map_err(|e| format!("刷新失败: {}", e))?;
    }

    let reader = shell.reader.clone();
    let child = shell.child.clone();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let result = (|| -> Result<String, String> {
            let mut r = reader.lock().map_err(|e| format!("锁失败: {}", e))?;
            let mut output = String::new();
            loop {
                let mut line = String::new();
                match r.read_line(&mut line) {
                    Ok(0) => return Err("WSL shell 进程已退出".into()),
                    Ok(_) => {}
                    Err(e) => return Err(format!("读取失败: {}", e)),
                }
                if line.trim() == marker_end { break; }
                if line.trim() == marker_start { continue; }
                output.push_str(&line);
            }
            Ok(output)
        })();
        let _ = tx.send(result);
    });

    match rx.recv_timeout(std::time::Duration::from_millis(timeout_ms)) {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(e)) => {
            WSL_SHELL_DIRTY.store(true, std::sync::atomic::Ordering::Relaxed);
            let _ = child.lock().unwrap_or_else(|e| e.into_inner()).kill();
            Err(e)
        }
        Err(_) => {
            WSL_SHELL_DIRTY.store(true, std::sync::atomic::Ordering::Relaxed);
            {
                let mut c = child.lock().unwrap_or_else(|e| e.into_inner());
                let _ = c.kill();
                let _ = c.wait();
            }
            dbg_log(&format!("wsl_shell_exec: timeout after {}ms", timeout_ms));
            Err("WSL shell 命令超时".into())
        }
    }
}

/// WSL 终端进程 PID（由 launch_wsl 设置，用于检测用户关闭窗口）
static WSL_TERMINAL_PID: Mutex<Option<u32>> = Mutex::new(None);

/// 串口读取 + 工作流监控线程：后台持续读取数据，自动检查规则并执行动作
struct PortReader {
    buffer: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
    events: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    read_handle: Option<std::thread::JoinHandle<()>>,
    wf_handle: Option<std::thread::JoinHandle<()>>,
    act_handle: Option<std::thread::JoinHandle<()>>,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    disconnected: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// 断开后是否已上报过（避免 read_data 每次轮询都重复上报）
    disconnect_reported: std::sync::Arc<std::sync::atomic::AtomicBool>,
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
        let disconnected = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let disconnect_reported = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let rules = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log_dir = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let line_ending = std::sync::Arc::new(std::sync::Mutex::new(String::from("crlf")));
        let match_tail = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let buf_clone = buffer.clone();
        let evt_clone = events.clone();
        let stop_clone = stop.clone();
        let disconnected_clone = disconnected.clone();
        let port_arc = std::sync::Arc::new(std::sync::Mutex::new(port));
        let rules_clone = rules.clone();
        let log_dir_clone = log_dir.clone();
        let le_clone = line_ending.clone();
        let tail_clone = match_tail.clone();

        // channel：读取线程 → 工作流工作线程
        let (tx, rx) = crossbeam_channel::bounded::<Vec<u8>>(2048);
        // channel：工作流线程 → 动作工作线程（有界，串行执行动作，避免每块数据 spawn 线程）
        let (act_tx, act_rx) =
            crossbeam_channel::bounded::<(Vec<Vec<WorkflowAction>>, Vec<u8>, Vec<u8>, String)>(32);

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
                let should_break = matches!(&read_result, Err(e) if e.kind() != std::io::ErrorKind::TimedOut && e.kind() != std::io::ErrorKind::WouldBlock);
                match read_result {
                    Ok(n) if n > 0 => {
                        if let Ok(mut buf) = buf_clone.lock() {
                            buf.extend_from_slice(&tmp[..n]);
                            if buf.len() > 262144 {
                                let drain = buf.len() - 131072;
                                buf.drain(..drain);
                            }
                        }
                        let _ = tx_clone.try_send(tmp[..n].to_vec()).is_ok();
                    }
                    _ if should_break => break,
                    // 无数据时轻微退避（1ms→2ms），减少空转，对读取延迟影响可忽略
                    _ => std::thread::sleep(std::time::Duration::from_millis(2)),
                }
            }
            // 非正常停止（设备断开）时设置标志
            if !stop_clone.load(std::sync::atomic::Ordering::Relaxed) {
                disconnected_clone.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        });

        // 动作工作线程：串行执行匹配到的动作（有界队列，天然带背压，线程数量恒定）
        let port_act = port_arc.clone();
        let evt_act = evt_clone.clone();
        let act_handle = std::thread::spawn(move || {
            while let Ok((matched_actions, pending, le_bytes, ld)) = act_rx.recv() {
                execute_workflow_actions_bg(&matched_actions, &pending, &le_bytes, &ld, &port_act, &evt_act);
            }
        });

        // 工作流工作线程：单线程消费 channel，检查规则，投递动作
        let rc_clone = regex_cache.clone();
        let act_tx_wf = act_tx;
        let tail_wf = tail_clone.clone();
        let wf_handle = std::thread::spawn(move || {
            while let Ok(data) = rx.recv() {
                Self::check_workflows(
                    &data, &rules_clone, &log_dir_clone,
                    &le_clone, &rc_clone, &tail_wf, &act_tx_wf,
                );
            }
        });

        PortReader {
            buffer, events, read_handle: Some(read_handle), wf_handle: Some(wf_handle),
            act_handle: Some(act_handle), stop, disconnected, disconnect_reported,
            port: port_arc, rules, log_dir, line_ending,
        }
    }

    fn check_workflows(
        pending: &[u8],
        rules: &std::sync::Arc<std::sync::Mutex<Vec<WorkflowRule>>>,
        log_dir: &std::sync::Arc<std::sync::Mutex<String>>,
        line_ending: &std::sync::Arc<std::sync::Mutex<String>>,
        regex_cache: &RegexCache,
        tail: &std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
        act_tx: &crossbeam_channel::Sender<(Vec<Vec<WorkflowAction>>, Vec<u8>, Vec<u8>, String)>,
    ) {
        if pending.is_empty() { return; }

        // 阶段1：极短持锁，仅克隆规则快照
        let snapshot: Vec<WorkflowRule> = {
            rules.lock().unwrap_or_else(|e| e.into_inner()).clone()
        };
        let ld = log_dir.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let le = line_ending.lock().unwrap_or_else(|e| e.into_inner()).clone();

        // 阶段2：无锁匹配（正则编译不阻塞任何共享状态）
        // 同时基于「上一块尾部 + 当前块」做跨块边界匹配（fresh_start 之后结束才算命中），
        // 既支持跨块的条件，又不会因窗口重叠对同一条件重复触发。
        let (tail_len, combined) = {
            let mut t = tail.lock().unwrap_or_else(|e| e.into_inner());
            let tl = t.len();
            let mut comb = Vec::with_capacity(tl + pending.len());
            comb.extend_from_slice(&t);
            comb.extend_from_slice(pending);
            // 更新 tail（保留最近 2048 字节）
            t.extend_from_slice(pending);
            const TAIL_CAP: usize = 2048;
            if t.len() > TAIL_CAP {
                let d = t.len() - TAIL_CAP;
                t.drain(..d);
            }
            (tl, comb)
        };

        let mut matched_actions: Vec<Vec<WorkflowAction>> = Vec::new();
        for rule in &snapshot {
            if !rule.running || rule.conditions.is_empty() { continue; }
            if rule.conditions.iter().all(|c| {
                match_condition(c, pending, regex_cache)
                    || (tail_len > 0 && match_condition_window(c, &combined, tail_len, regex_cache))
            }) {
                matched_actions.push(rule.actions.clone());
            }
        }

        if matched_actions.is_empty() { return; }

        let le_bytes: &[u8] = match le.as_str() {
            "crlf" => &[0x0D, 0x0A],
            "lf" => &[0x0A],
            "cr" => &[0x0D],
            _ => &[],
        };

        // 动作投递到有界队列由动作工作线程串行执行（不再每块数据 spawn 线程）
        let _ = act_tx.send((
            matched_actions,
            pending.to_vec(),
            le_bytes.to_vec(),
            ld,
        ));
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
        use std::time::{Duration, Instant};
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        // 所有线程 join 都带超时，避免读线程卡死（部分 USB 转串口驱动不按超时返回）
        // 导致关闭/重连/关窗永久阻塞。超时后 forget 句柄，读线程作为后台线程自行退出。
        if let Some(h) = self.read_handle.take() {
            let deadline = Instant::now() + Duration::from_millis(200);
            while !h.is_finished() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
            if h.is_finished() { let _ = h.join(); } else { std::mem::forget(h); }
        }
        if let Some(h) = self.wf_handle.take() {
            let deadline = Instant::now() + Duration::from_millis(300);
            while !h.is_finished() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
            if h.is_finished() { let _ = h.join(); } else { std::mem::forget(h); }
        }
        if let Some(h) = self.act_handle.take() {
            let deadline = Instant::now() + Duration::from_millis(300);
            while !h.is_finished() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
            if h.is_finished() { let _ = h.join(); } else { std::mem::forget(h); }
        }
    }
}

/// 全局状态：多个独立串口连接（key = monitor_id）
struct PortState {
    readers: RwLock<HashMap<String, PortReader>>,
}

/// WSL 串口会话：通过管道与 bridge 脚本通信
/// 每个会话有且仅有一条常驻 stdout 读取线程（按序推送响应行），
/// 避免每次命令都新建线程；bridge 进程退出/被杀后读取线程随管道 EOF 自行退出。
struct WslSerialSession {
    child: std::sync::Arc<std::sync::Mutex<std::process::Child>>,
    writer: std::sync::Mutex<std::io::BufWriter<std::process::ChildStdin>>,
    /// 常驻读取线程推送的响应行：命令按发出顺序严格对应
    responses: crossbeam_channel::Receiver<String>,
    /// 会话已失效（超时被杀后置位，防止消费过期响应）
    dead: std::sync::atomic::AtomicBool,
}

/// 全局状态：WSL 串口连接（key = monitor_id）
/// sessions 用 Arc 持有，以便在 spawn_blocking 中克隆移出、且不跨 bridge 等待持锁。
struct WslSerialState {
    sessions: std::sync::Arc<Mutex<HashMap<String, std::sync::Arc<WslSerialSession>>>>,
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
                // 容量淘汰：超过 100 条时清空
                if cache.len() > 100 {
                    cache.clear();
                }
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
    let bytes = s.as_bytes();
    let mut result = Vec::with_capacity(bytes.len() / 2);
    let mut hi: Option<u8> = None;
    for &b in bytes {
        if b.is_ascii_whitespace() { continue; }
        let n = match b {
            b'0'..=b'9' => b - b'0',
            b'a'..=b'f' => b - b'a' + 10,
            b'A'..=b'F' => b - b'A' + 10,
            _ => return Vec::new(),
        };
        match hi {
            Some(h) => { result.push((h << 4) | n); hi = None; }
            None => { hi = Some(n); }
        }
    }
    if hi.is_some() { return Vec::new(); }
    result
}

/// 检查单个条件是否匹配
fn match_condition(cond: &WorkflowCondition, raw: &[u8], cache: &RegexCache) -> bool {
    match cond.cond_type.as_str() {
        "string_contains" => {
            // 直接在字节层面搜索，避免 String 分配
            let needle = cond.value.as_bytes();
            if needle.is_empty() { return true; }
            raw.windows(needle.len()).any(|w| w == needle)
        }
        "regex" => {
            // 先尝试零拷贝 UTF-8 解析
            if let Ok(text) = std::str::from_utf8(raw) {
                match cache.get_or_compile(&cond.value) {
                    Some(re) => re.is_match(text),
                    None => false,
                }
            } else {
                // fallback: 只在非 UTF-8 时才 lossy 转换
                let text = String::from_utf8_lossy(raw);
                match cache.get_or_compile(&cond.value) {
                    Some(re) => re.is_match(&text),
                    None => false,
                }
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

/// 在「上一块尾部 + 当前块」组合窗口上匹配条件；
/// 仅当匹配结束位置 > fresh_start（即匹配延伸到新到达的数据）时才判定命中，
/// 从而支持跨块边界匹配，同时避免窗口重叠导致同一条件重复触发。
fn match_condition_window(cond: &WorkflowCondition, window: &[u8], fresh_start: usize, cache: &RegexCache) -> bool {
    if window.len() <= fresh_start { return false; }
    match cond.cond_type.as_str() {
        "string_contains" => {
            let needle = cond.value.as_bytes();
            if needle.is_empty() { return false; }
            window
                .windows(needle.len())
                .position(|w| w == needle)
                .map(|pos| pos + needle.len() > fresh_start)
                .unwrap_or(false)
        }
        "regex" => {
            let text = String::from_utf8_lossy(window);
            match cache.get_or_compile(&cond.value) {
                Some(re) => re.find(&text).map(|m| m.end() > fresh_start).unwrap_or(false),
                None => false,
            }
        }
        "exact_bytes" => {
            let expected = parse_hex_bytes(&cond.value);
            if expected.is_empty() { return false; }
            window
                .windows(expected.len())
                .position(|w| w == expected.as_slice())
                .map(|pos| pos + expected.len() > fresh_start)
                .unwrap_or(false)
        }
        _ => false,
    }
}

/// 后台动作执行（由 PortReader 的单个动作工作线程串行调用）：
/// 遍历匹配规则的动作序列并执行，汇总 [Auto] 消息写入事件队列。
fn execute_workflow_actions_bg(
    matched_actions: &[Vec<WorkflowAction>],
    pending_clone: &[u8],
    le_bytes: &[u8],
    ld: &str,
    port_clone: &std::sync::Arc<std::sync::Mutex<Box<dyn SerialPort>>>,
    events_clone: &std::sync::Arc<std::sync::Mutex<Vec<String>>>,
) {
    let mut all_sent = Vec::new();
    for actions in matched_actions {
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
                        bytes.extend_from_slice(le_bytes);
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
                        let filepath = std::path::Path::new(ld).join("workflow_log.txt");
                        if let Ok(mut f) = std::fs::OpenOptions::new()
                            .create(true).append(true).open(&filepath)
                        { let _ = f.write_all(pending_clone); }
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
}

/// 执行工作流动作序列，返回所有发送的数据文本
fn execute_workflow_actions(
    actions: &[WorkflowAction],
    monitor_id: &str,
    readers: &RwLock<HashMap<String, PortReader>>,
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
                if let Some(port_arc) = {
                    let map = readers.read().unwrap_or_else(|e| e.into_inner());
                    map.get(monitor_id).map(|r| r.port.clone())
                } {
                    let mut port = port_arc.lock().unwrap_or_else(|e| e.into_inner());
                    if let Err(e) = port.write_all(&bytes) {
                        eprintln!("[Workflow] 写入串口失败: {}", e);
                    }
                    port.flush().ok();
                }
            }
            "toggle_dtr_rts" => {
                if let Some(port_arc) = {
                    let map = readers.read().unwrap_or_else(|e| e.into_inner());
                    map.get(monitor_id).map(|r| r.port.clone())
                } {
                    let mut port = port_arc.lock().unwrap_or_else(|e| e.into_inner());
                    match action.signal.as_str() {
                        "dtr" => { if let Err(e) = port.write_data_terminal_ready(action.level) { eprintln!("[Workflow] DTR 设置失败: {}", e); } }
                        "rts" => { if let Err(e) = port.write_request_to_send(action.level) { eprintln!("[Workflow] RTS 设置失败: {}", e); } }
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

/// 运行命令并等待输出；超过 timeout_ms 毫秒则杀掉子进程并返回 None。
/// 避免 WSL 无响应时 `.output()` 永久阻塞（wsl 进程卡住时管道不会关闭）。
fn run_output_timeout(cmd: &mut std::process::Command, timeout_ms: u64) -> Option<std::process::Output> {
    use std::io::Read;
    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let _ = child.stdout.take().and_then(|mut s| s.read_to_end(&mut stdout).ok());
    let _ = child.stderr.take().and_then(|mut s| s.read_to_end(&mut stderr).ok());
    let status = child.wait().ok()?;
    Some(std::process::Output { status, stdout, stderr })
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
async fn list_ports() -> Vec<PortInfo> {
    tauri::async_runtime::spawn_blocking(move || {
        let t0 = std::time::Instant::now();
        let ports = enumerate_ports();
        dbg_log(&format!("list_ports: {} ports, {:?}", ports.len(), t0.elapsed()));
        ports
    })
    .await
    .unwrap_or_default()
}

#[cfg(not(windows))]
#[tauri::command]
async fn list_ports() -> Vec<PortInfo> {
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .unwrap_or_default()
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
    // 关闭该监视器已有的连接（用 close_reader 避免旧读线程卡住阻塞重连）
    let old_reader = {
        let mut map = state.readers.write().unwrap_or_else(|e| e.into_inner());
        map.remove(&monitor_id)
    };
    if let Some(old) = old_reader {
        close_reader(old);
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
    let mut guard = state.readers.write().unwrap_or_else(|e| e.into_inner());
    guard.insert(monitor_id, reader);

    Ok(())
}

/// 停止读线程并尝试快速释放串口（#15/#16/#18）
/// 之前 close_port 先 `port.lock()` 再 drop，若读线程正阻塞在 read 上
/// （部分 USB 转串口驱动不按超时返回），会永久卡住命令线程 → 端口不释放/发送无响应。
/// 这里改为：先置 stop → try_lock 快速清理 → 等待读线程退出（带 200ms 上限），
/// 超时则放弃等待，读线程作为后台线程自行退出。
fn close_reader(mut reader: PortReader) {
    use std::time::{Duration, Instant};
    reader.stop.store(true, std::sync::atomic::Ordering::Relaxed);
    // 尝试快速清理（拿不到锁说明读线程正忙，跳过即可）
    if let Ok(mut port) = reader.port.try_lock() {
        let _ = port.flush();
        let _ = port.clear(ClearBuffer::All);
    }
    // 等待读线程退出，最多 200ms；超时不再阻塞（读线程最终自行退出并释放句柄）
    if let Some(h) = reader.read_handle.take() {
        let deadline = Instant::now() + Duration::from_millis(200);
        while !h.is_finished() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        if h.is_finished() {
            let _ = h.join();
        } else {
            std::mem::forget(h);
        }
    }
    // 其余工作线程（工作流/动作）消费 channel，读线程退出后自然结束
    drop(reader);
}

/// 关闭串口（停止读取线程）
#[tauri::command]
fn close_port(state: tauri::State<'_, PortState>, monitor_id: String) -> Result<(), String> {
    let reader = {
        let mut map = state.readers.write().unwrap_or_else(|e| e.into_inner());
        map.remove(&monitor_id)
    };
    if let Some(reader) = reader {
        close_reader(reader);
    }
    Ok(())
}

/// 从缓冲区读取数据（毫秒级，不阻塞）
#[tauri::command]
fn read_data(state: tauri::State<'_, PortState>, monitor_id: String) -> Result<Vec<u8>, String> {
    let map = state.readers.read().unwrap_or_else(|e| e.into_inner());
    if let Some(reader) = map.get(&monitor_id) {
        if reader.disconnected.load(std::sync::atomic::Ordering::Relaxed) {
            // 断开上报只触发一次，避免轮询期间重复上报
            if !reader.disconnect_reported.swap(true, std::sync::atomic::Ordering::Relaxed) {
                report_error("设备已断开连接", "read_data");
            }
            return Err("设备已断开连接".into());
        }
        Ok(reader.read_all())
    } else {
        // 未连接是前端高频轮询的常态（用户关闭连接后仍 poll），不触发错误上报，避免风暴
        Err("未连接串口".into())
    }
}

/// 读取工作流触发事件（前端轮询显示 [Auto] 消息）
#[tauri::command]
fn read_workflow_events(state: tauri::State<'_, PortState>, monitor_id: String) -> Vec<String> {
    let map = state.readers.read().unwrap_or_else(|e| e.into_inner());
    if let Some(reader) = map.get(&monitor_id) {
        reader.read_events()
    } else {
        vec![]
    }
}

/// 带超时获取串口锁：读线程正常周期性持锁，若某驱动忽略读超时而长期持锁，
/// 写命令的 `lock()` 会无限卡死（E5）。改用 try_lock 轮询，超时返回明确错误，主线程不会被冻结。
fn lock_port_with_timeout(
    port_arc: &std::sync::Arc<std::sync::Mutex<Box<dyn SerialPort>>>,
    timeout_ms: u64,
) -> Result<std::sync::MutexGuard<'_, Box<dyn SerialPort>>, String> {
    use std::time::{Duration, Instant};
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        match port_arc.try_lock() {
            Ok(g) => return Ok(g),
            Err(std::sync::TryLockError::Poisoned(p)) => return Ok(p.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => {
                if Instant::now() >= deadline {
                    return Err("串口无响应（读线程占用或驱动卡顿）".into());
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }
}

/// 发送数据。写阻塞（设备不读时 WriteFile 可无限阻塞）移到 spawn_blocking，主线程不冻结；
/// 锁也带超时，避免读线程持锁时无限等待。
#[tauri::command]
async fn send_data(state: tauri::State<'_, PortState>, monitor_id: String, data: Vec<u8>) -> Result<usize, String> {
    let port_arc = {
        let map = state.readers.read().unwrap_or_else(|e| e.into_inner());
        match map.get(&monitor_id) {
            Some(reader) => reader.port.clone(),
            None => {
                report_error("未连接串口", "send_data");
                return Err("未连接串口".into());
            }
        }
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut port = lock_port_with_timeout(&port_arc, 500)?;
        port.write_all(&data).map_err(|e| {
            report_error(&format!("发送失败: {}", e), "send_data");
            format!("发送失败: {}", e)
        })?;
        port.flush().ok();
        Ok(data.len())
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))?
}

/// 实时设置 DTR 信号
#[tauri::command]
fn set_dtr(state: tauri::State<'_, PortState>, monitor_id: String, level: bool) -> Result<(), String> {
    let port_arc = {
        let map = state.readers.read().unwrap_or_else(|e| e.into_inner());
        match map.get(&monitor_id) {
            Some(reader) => reader.port.clone(),
            None => {
                report_error("未连接串口", "set_dtr");
                return Err("未连接串口".into());
            }
        }
    };
    let mut port = lock_port_with_timeout(&port_arc, 500)?;
    port.write_data_terminal_ready(level).map_err(|e| {
        report_error(&format!("DTR 设置失败: {}", e), "set_dtr");
        format!("DTR 设置失败: {}", e)
    })
}

/// 实时设置 RTS 信号
#[tauri::command]
fn set_rts(state: tauri::State<'_, PortState>, monitor_id: String, level: bool) -> Result<(), String> {
    let port_arc = {
        let map = state.readers.read().unwrap_or_else(|e| e.into_inner());
        match map.get(&monitor_id) {
            Some(reader) => reader.port.clone(),
            None => {
                report_error("未连接串口", "set_rts");
                return Err("未连接串口".into());
            }
        }
    };
    let mut port = lock_port_with_timeout(&port_arc, 500)?;
    port.write_request_to_send(level).map_err(|e| {
        report_error(&format!("RTS 设置失败: {}", e), "set_rts");
        format!("RTS 设置失败: {}", e)
    })
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
        let map = port_state.readers.read().unwrap_or_else(|e| e.into_inner());
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
    let readers = port_state.readers.read().unwrap_or_else(|e| e.into_inner());
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
    let readers = port_state.readers.read().unwrap_or_else(|e| e.into_inner());
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
    let readers = port_state.readers.read().unwrap_or_else(|e| e.into_inner());
    if let Some(reader) = readers.get(&monitor_id) {
        reader.update_line_ending(line_ending);
    }
}

/// 选择日志文件目录（使用原生对话框）
#[tauri::command]
fn choose_log_directory() -> Result<Option<String>, String> {
    let picked = rfd::FileDialog::new()
        .set_title("选择日志保存目录")
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string());
    // 记录最近一次选择，供 save_log 校验（防止前端调用 save_log 写任意路径）
    if let Some(dir) = picked.clone() {
        let cache = LAST_LOG_DIR.get_or_init(|| std::sync::Mutex::new(None));
        if let Ok(mut c) = cache.lock() {
            *c = Some(dir);
        }
    }
    Ok(picked)
}

/// 将 PowerShell 脚本编码为 -EncodedCommand 需要的 UTF-16LE Base64
fn encode_ps_command(script: &str) -> String {
    use base64::Engine;
    let mut u16: Vec<u8> = Vec::with_capacity(script.len() * 2);
    for u in script.encode_utf16() {
        u16.extend_from_slice(&u.to_le_bytes());
    }
    base64::engine::general_purpose::STANDARD.encode(&u16)
}

/// 生成不可预测的临时文件后缀（时间戳 + 进程 id 混合），
/// 用于提权结果文件命名，降低同用户进程预置/劫持临时文件的风险
fn temp_rand_suffix() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    nanos ^ (std::process::id() as u64).rotate_left(32) ^ (nanos.rotate_left(17))
}

/// 获取所有串口（包括已映射到WSL的）
#[tauri::command]
/// 通过 UAC 提权执行 usbipd list，返回 stdout 内容
fn run_usbipd_list_elevated() -> Option<String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static LIST_COUNTER: AtomicU64 = AtomicU64::new(0);
    let unique_id = LIST_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_result = std::env::temp_dir().join(format!(
        "usbipd_list_{}_{}_{}.txt",
        std::process::id(),
        unique_id,
        temp_rand_suffix()
    ));
    let tmp_result_str = tmp_result.to_str().unwrap_or("C:\\Temp\\usbipd_list.txt");

    let ps_script = format!(
        "try {{ \
           $out = & usbipd.exe list 2>&1 | Out-String; \
           $out | Out-File -FilePath '{result}' -Encoding UTF8; \
         }} catch {{ \
           $_.Exception.Message | Out-File -FilePath '{result}' -Encoding UTF8; \
         }}",
        result = tmp_result_str
    );

    // 通过 -EncodedCommand 传脚本内容，避免写可预测的临时 .ps1 被同用户进程替换（TOCTOU）
    let _ = std::fs::remove_file(&tmp_result);
    let encoded = encode_ps_command(&ps_script);
    // 不再使用 -Wait：UAC 弹窗未被确认时 -Wait 会永久挂起，导致界面卡死
    // -WindowStyle Hidden：隐藏提权后 PowerShell 的控制台窗口，避免"授权终端一闪而过"
    // 捕获启动退出码：非零（UAC 可能被拒绝）用较短等待；零（UAC 已同意）给 usbipd 足够时间。
    let launch_status = hidden_command("powershell")
        .args(["-NonInteractive", "-Command"])
        .arg(format!("Start-Process -FilePath 'powershell' -ArgumentList '-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-NonInteractive','-EncodedCommand','{}' -Verb RunAs -WindowStyle Hidden", encoded))
        .status();
    let ok = launch_status.map(|s| s.success()).unwrap_or(false);
    let poll_secs: u64 = if ok { 10 } else { 8 };
    // 轮询结果文件直到超时（UAC 未确认也不会永久阻塞）
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(poll_secs);
    while !tmp_result.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    std::thread::sleep(std::time::Duration::from_millis(200)); // 等待文件写入完成

    let result = std::fs::read_to_string(&tmp_result).ok();
    let _ = std::fs::remove_file(&tmp_result);
    result
}

/// 阻塞式实现：在 spawn_blocking 中执行，避免同步命令占用主线程卡住整个 UI。
/// 取消映射后前端会密集重扫本命令（device-changed + 重试），并发时靠 WSL_SHELL_CMD_LOCK 串行。
fn list_wsl_devices_blocking() -> Result<Vec<serde_json::Value>, String> {
    // 检查 WSL 是否正在运行（取第一个运行中的发行版，用于解析 WSL 侧设备路径）
    let distro = check_wsl_running().and_then(|d| d.into_iter().next()).unwrap_or_default();
    let wsl_running = !distro.is_empty();

    // 用带 kill 的 run_output_timeout：usbipd 卡死时杀掉子进程，避免泄漏孤儿线程/进程
    // 缩短超时：usbipd list 在无 WSL / 未授权环境下可能卡住，避免拖垮 WSL 面板加载
    let mut cmd = hidden_command("usbipd");
    cmd.args(["list"]);
    let output = run_output_timeout(&mut cmd, 3000);

    // 仅当 usbipd list 执行失败/超时才提权；成功（即使无已 attach 设备）直接使用输出，
    // 避免"无设备"时无谓触发 UAC 提权导致加载拖慢/超时
    let list_str = match output {
        Some(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).to_string(),
        _ => {
            dbg_log("usbipd list 失败/超时，尝试提权执行");
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
                    let vidpid = parts.get(1).unwrap_or(&"").to_string();
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
                    // 去掉 usbipd 名称末尾的 Windows 侧 COM 后缀，如 "USB 串行设备 (COM38)" -> "USB 串行设备"
                    let name = strip_windows_com_suffix(&name);

                    static FILTERS: &[&str] = &[
                        "通信端口", "通讯端口", "communicationsport",
                        "蓝牙", "bluetooth",
                        "usb输入设备", "usb-baseddslinstrument",
                        "ethernet", "网络适配器", "networkadapter", "lan",
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
                        "vidpid": vidpid,
                        "port": port,
                        "name": name,
                        "hasCom": has_com,
                        "status": if is_mapped { "mapped" } else { "unmapped" }
                    }));
                }
            }
    }

    // 为已映射设备解析 WSL 侧设备路径与序列号（按 sysfs 的 idVendor:idProduct 匹配 VID:PID）
    if wsl_running {
        let mut vid_to_path: HashMap<String, String> = HashMap::new();
        let mut vid_to_serial: HashMap<String, String> = HashMap::new();
        for (path, _name, vidpid, serial) in list_wsl_tty_details(&distro) {
            if !vidpid.is_empty() {
                if !serial.is_empty() {
                    vid_to_serial.insert(vidpid.clone(), serial);
                }
                vid_to_path.insert(vidpid, path);
            }
        }
        for d in devices.iter_mut() {
            let vidpid = d.get("vidpid").and_then(|v| v.as_str()).unwrap_or("").to_uppercase();
            if !vidpid.is_empty() {
                // 序列号用于区分同型号设备（仅已映射设备在 WSL 中可见，可解析到）
                if let Some(serial) = vid_to_serial.get(&vidpid) {
                    d["wslSerial"] = serde_json::Value::String(serial.clone());
                }
            }
            if d.get("status").and_then(|v| v.as_str()) == Some("mapped") {
                if let Some(path) = vid_to_path.get(&vidpid) {
                    d["wslPath"] = serde_json::Value::String(path.clone());
                }
            }
        }
    }

    Ok(devices)
}

#[tauri::command]
async fn list_wsl_devices() -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(list_wsl_devices_blocking)
        .await
        .map_err(|e| format!("任务执行失败: {}", e))?
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
async fn check_wsl_status() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(|| check_wsl_running().unwrap_or_default())
        .await
        .unwrap_or_default()
}

/// 去掉设备名末尾的 Windows 侧 COM 端口后缀（如 "USB 串行设备 (COM38)" -> "USB 串行设备"）
fn strip_windows_com_suffix(name: &str) -> String {
    let trimmed = name.trim_end();
    if let Some(pos) = trimmed.rfind(" (COM") {
        let tail = &trimmed[pos + 5..];
        if let Some(close) = tail.find(')') {
            let digits = &tail[..close];
            if !digits.is_empty()
                && digits.chars().all(|c| c.is_ascii_digit())
                && tail[close + 1..].trim().is_empty()
            {
                return trimmed[..pos].trim_end().to_string();
            }
        }
    }
    trimmed.to_string()
}

fn check_wsl_running() -> Option<Vec<String>> {
    let mut cmd = hidden_command("wsl");
    cmd.args(["--list", "--verbose"]);
    // 用带 kill 的 run_output_timeout：wsl 卡死时杀掉子进程，避免泄漏孤儿线程/进程
    // 缩短超时（3s），避免 WSL 面板加载被 `wsl --list --verbose` 卡住拖垮
    let output = run_output_timeout(&mut cmd, 3000)?;
    let text = decode_wsl_output(&output.stdout);
    let dists: Vec<String> = text.lines()
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
        .collect();
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
        while !WSL_WATCHER_STOP.load(std::sync::atomic::Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_secs(2));

            let distros = check_wsl_running().unwrap_or_default();
            let wsl_running = !distros.is_empty();

            let terminal_alive = {
                let pid = WSL_TERMINAL_PID.lock().unwrap_or_else(|e| e.into_inner());
                match *pid {
                    Some(p) => is_process_alive(p),
                    None => true,
                }
            };

            if !terminal_alive && wsl_running {
                *CACHED_DISTRO.lock().unwrap_or_else(|e| e.into_inner()) = None;
            }

            let running = wsl_running && terminal_alive;
            if running != last_running {
                last_running = running;
                dbg_log(&format!("wsl_watcher: status changed, running={}, terminal_alive={}, wsl_running={}", running, terminal_alive, wsl_running));
                let _ = app.emit("wsl-status-changed", running);
            }
        }
        dbg_log("wsl_watcher: stopped");
    });
}

/// 将 WSL 路径转换为 Windows 可识别的路径
/// 例如: /home/seahi -> \\wsl$\Ubuntu-20.04\home\seahi
///       /mnt/c/Users/seahi -> C:\Users\seahi
fn wsl_path_to_win(wsl_path: &str, dist_name: &str) -> Option<String> {
    if wsl_path.starts_with("/mnt/") && wsl_path.len() >= 6 {
        // /mnt/c/... -> C:\...
        let drive = wsl_path[5..6].to_uppercase();
        let rest = &wsl_path[6..];
        // 将正斜杠转换为反斜杠
        let win_rest: String = rest.replace('/', "\\");
        Some(format!("{}:{}", drive, win_rest))
    } else {
        // 其他路径使用 \\wsl$\格式
        let win_path: String = wsl_path.replace('/', "\\");
        Some(format!("\\\\wsl$\\{}{}", dist_name, win_path))
    }
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
        // 获取 WSL 用户主目录，用于设置终端启动路径（带超时，避免 WSL 无响应时卡住）
        let home = run_output_timeout(
            std::process::Command::new("wsl.exe")
                .args(["-d", dist_name, "--", "printenv", "HOME"])
                .creation_flags(CREATE_NO_WINDOW),
            5000,
        )
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
        // 设置启动目录为 WSL 主目录（转换为 Windows 可识别的路径）
        if let Some(ref h) = home {
            if let Some(win_path) = wsl_path_to_win(h, dist_name) {
                dbg_log(&format!("launch_wsl: converting {} -> {}", h, win_path));
                c.args(["--startingDirectory", &win_path]);
            } else {
                dbg_log(&format!("launch_wsl: failed to convert WSL path: {}", h));
            }
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
        *WSL_TERMINAL_PID.lock().unwrap_or_else(|e| e.into_inner()) = None;
    } else {
        *WSL_TERMINAL_PID.lock().unwrap_or_else(|e| e.into_inner()) = Some(child.id());
    }
    Ok(())
}

/// 关闭指定 WSL 发行版（异步，不阻塞 UI）
#[tauri::command]
async fn shutdown_wsl(dist: String) -> Result<(), String> {
    *WSL_TERMINAL_PID.lock().unwrap_or_else(|e| e.into_inner()) = None;
    tauri::async_runtime::spawn_blocking(move || {
        let out = run_output_timeout(hidden_command("wsl").args(["-t", &dist]), 5000)
            .ok_or_else(|| "关闭 WSL 发行版超时".to_string())?;
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
fn get_wsl_distributions_blocking() -> Result<Vec<serde_json::Value>, String> {
    // 检查由 launch_wsl 启动的终端进程是否仍然存活
    let terminal_alive = {
        let pid = WSL_TERMINAL_PID.lock().unwrap_or_else(|e| e.into_inner());
        match *pid {
            Some(p) => is_process_alive(p),
            None => true, // 未跟踪终端进程时，以 WSL 实际状态为准
        }
    };

    // 所有 wsl 子进程调用都带超时，避免 WSL 无响应时永久阻塞
    let output = run_output_timeout(hidden_command("wsl").args(["--list", "--verbose"]), 5000)
        .ok_or_else(|| "获取 WSL 列表超时或失败".to_string())?;

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
            // 用超时避免命令阻塞，且不启动已停止的发行版
            let uptime_out = run_output_timeout(
                hidden_command("wsl").args(["-d", &name, "--", "cat", "/proc/uptime"]),
                3000,
            );
            let uptime = match uptime_out {
                Some(o) => parse_uptime_hms(&decode_wsl_output(&o.stdout)),
                None => String::new(),
            };
            let free_out = run_output_timeout(
                hidden_command("wsl").args(["-d", &name, "--", "free", "-m"]),
                3000,
            );
            let (total, used) = match free_out {
                Some(o) => parse_free_output(&decode_wsl_output(&o.stdout)),
                None => (0, 0),
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

/// wsl --list + 每个运行发行版的 uptime/free 子进程（可到 5+N×6s），移到 spawn_blocking，主线程不冻结。
#[tauri::command]
async fn get_wsl_distributions() -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(get_wsl_distributions_blocking)
        .await
        .map_err(|e| format!("任务执行失败: {}", e))?
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
        let cached = CACHED_DISTRO.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(ref name) = *cached {
            return Ok(name.clone());
        }
    }
    // 优先选择已在运行的发行版
    let running = check_wsl_running().unwrap_or_default();
    if let Some(name) = running.first() {
        *CACHED_DISTRO.lock().unwrap_or_else(|e| e.into_inner()) = Some(name.clone());
        return Ok(name.clone());
    }
    // 没有运行中的，选择默认发行版并启动（所有调用带超时，避免 WSL 无响应时阻塞）
    let out = run_output_timeout(hidden_command("wsl").args(["--list", "--verbose"]), 5000)
        .ok_or_else(|| "获取 WSL 列表超时".to_string())?;
    let text = decode_wsl_output(&out.stdout);
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('*') {
            let name = line[1..].trim().split_whitespace().next()
                .ok_or("无法解析默认发行版名称")?;
            let _ = run_output_timeout(hidden_command("wsl").args(["-d", name, "-e", "echo", "ok"]), 5000);
            *CACHED_DISTRO.lock().unwrap_or_else(|e| e.into_inner()) = Some(name.to_string());
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
        let _ = run_output_timeout(hidden_command("wsl").args(["-d", name, "-e", "echo", "ok"]), 5000);
        *CACHED_DISTRO.lock().unwrap_or_else(|e| e.into_inner()) = Some(name.to_string());
        return Ok(name.to_string());
    }
    Err("没有可用的 WSL 发行版".into())
}

/// 将路径用 bash 单引号包裹并转义，避免路径含空格/特殊字符时被 shell 拆分或注入
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 部署 bridge 脚本到指定 WSL 发行版（通过 /mnt 路径直接写入）
/// 每次连接都强制覆盖部署，避免应用升级后 WSL /tmp 中残留旧版脚本导致协议不匹配
fn deploy_bridge(distro: &str) -> Result<(), String> {
    let b64 = BRIDGE_B64.trim();
    let tmp_b64 = std::env::temp_dir().join("seahi_bridge_b64.txt");
    std::fs::write(&tmp_b64, b64).map_err(|e| format!("写入临时文件失败: {}", e))?;
    let win_path = tmp_b64.to_string_lossy().to_string();
    let drive = win_path.chars().next().unwrap_or('c').to_lowercase();
    let rest = win_path[2..].replace('\\', "/");
    let mnt_path = format!("/mnt/{}{}", drive, rest);
    let decode_cmd = format!("base64 -d < {} > {}", sh_quote(&mnt_path), sh_quote(BRIDGE_SCRIPT_PATH));
    let out = run_output_timeout(
        hidden_command("wsl").args(["-d", distro, "-e", "bash", "-c", &decode_cmd]),
        5000,
    );
    let _ = std::fs::remove_file(&tmp_b64);
    match out {
        Some(o) if o.status.success() => Ok(()),
        Some(o) => {
            let msg = format!("部署 bridge 失败: {}", String::from_utf8_lossy(&o.stderr));
            report_error(&msg, "deploy_bridge");
            Err(msg)
        }
        None => {
            let msg = "部署 bridge 超时".to_string();
            report_error(&msg, "deploy_bridge");
            Err(msg)
        }
    }
}

/// 启动 bridge 进程（使用 hidden_command 隐藏窗口 + sg dialout 切换组）
fn spawn_bridge(distro: &str) -> Result<std::process::Child, String> {
    let child = hidden_command("wsl")
        .args(["-d", distro, "-e", "sg", "dialout", "-c", &format!("python3 {}", BRIDGE_SCRIPT_PATH)])
        .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            report_error(&format!("启动 bridge 失败: {}", e), "spawn_bridge");
            format!("启动 bridge 失败: {}", e)
        })?;
    Ok(child)
}
fn bridge_command(session: &WslSerialSession, cmd: &serde_json::Value) -> Result<serde_json::Value, String> {
    use std::io::Write;
    // 会话已失效（之前超时被杀）：直接失败，不再读写管道
    if session.dead.load(std::sync::atomic::Ordering::Relaxed) {
        let e = "bridge 进程已退出".to_string();
        report_error(&e, "bridge_command");
        return Err(e);
    }
    let mut msg = serde_json::to_string(cmd).map_err(|e| { let s = format!("序列化失败: {}", e); report_error(&s, "bridge_command"); s })?;
    msg.push('\n');
    {
        let mut w = session.writer.lock().map_err(|e| { let s = format!("锁失败: {}", e); report_error(&s, "bridge_command"); s })?;
        w.write_all(msg.as_bytes()).map_err(|e| { let s = format!("写入失败: {}", e); report_error(&s, "bridge_command"); s })?;
        w.flush().map_err(|e| { let s = format!("刷新失败: {}", e); report_error(&s, "bridge_command"); s })?;
    }
    // 从常驻读取线程的有序通道消费响应；超时则判定 bridge 挂起并杀进程
    match session.responses.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(resp_line) => serde_json::from_str(resp_line.trim()).map_err(|e| { let s = format!("解析响应失败: {}", e); report_error(&s, "bridge_command"); s }),
        Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
            session.dead.store(true, std::sync::atomic::Ordering::Relaxed);
            let mut c = session.child.lock().map_err(|e| format!("锁失败: {}", e))?;
            let _ = c.kill();
            let _ = c.wait();
            report_error("bridge 响应超时(5s)", "bridge_command");
            Err("bridge 响应超时(5s)".into())
        }
        Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
            // 读取线程退出（bridge 进程已退出或被杀）
            session.dead.store(true, std::sync::atomic::Ordering::Relaxed);
            let mut c = session.child.lock().map_err(|e| format!("锁失败: {}", e))?;
            let _ = c.kill();
            report_error("bridge 进程已退出（管道断开）", "bridge_command");
            Err("bridge 进程已退出".into())
        }
    }
}

/// 终止 WSL 会话：置失效标志、杀子进程、等待退出
fn kill_wsl_session(session: &WslSerialSession) {
    session.dead.store(true, std::sync::atomic::Ordering::Relaxed);
    let mut c = session.child.lock().unwrap_or_else(|e| e.into_inner());
    let _ = c.kill();
    let _ = c.wait();
}

/// 打开 WSL 串口（通过 bridge 管道）。整体移入 spawn_blocking：get_or_start_wsl_distro(可达13s)
/// + deploy_bridge(5s) + ready(5s) + bridge(5s) 均不阻塞主线程。
#[tauri::command]
async fn open_wsl_serial(
    state: tauri::State<'_, WslSerialState>,
    monitor_id: String,
    device_path: String,
    baud_rate: u32,
) -> Result<(), String> {
    validate_device_path(&device_path)?;
    let sessions = state.sessions.clone();
    tauri::async_runtime::spawn_blocking(move || {
        { let mut s = sessions.lock().unwrap_or_else(|e| e.into_inner()); if let Some(old) = s.remove(&monitor_id) { kill_wsl_session(&old); } }
        let distro = get_or_start_wsl_distro().map_err(|e| {
            // 连接失败时清除缓存，下次重新检测
            *CACHED_DISTRO.lock().unwrap_or_else(|e| e.into_inner()) = None;
            e
        })?;
        deploy_bridge(&distro)?;
        let mut child = spawn_bridge(&distro)?;
        let stderr = child.stderr.take().ok_or("无法获取 stderr")?;
        // 等待 bridge 就绪（最多 5 秒）：用 channel + recv_timeout 替代无超时 join，避免永久阻塞；
        // 超时后由下方 !ready 分支 kill + wait，且就绪线程因 stderr EOF 自行退出。
        let ready = {
            use std::sync::mpsc;
            let (tx, rx) = mpsc::channel::<bool>();
            std::thread::spawn(move || {
                use std::io::BufRead;
                for line in std::io::BufReader::new(stderr).lines() {
                    match line {
                        Ok(l) if l.trim() == "ready" => { let _ = tx.send(true); return; }
                        Err(_) => { let _ = tx.send(false); return; }
                        _ => {}
                    }
                }
                let _ = tx.send(false);
            });
            rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap_or(false)
        };
        if !ready {
            let _ = child.kill();
            let _ = child.wait();
            report_error("bridge 启动超时", "open_wsl_serial");
            return Err("bridge 启动超时".into());
        }
        let stdout = child.stdout.take().ok_or("无法获取 stdout")?;
        let stdin = child.stdin.take().ok_or("无法获取 stdin")?;
        let writer = std::sync::Mutex::new(std::io::BufWriter::new(stdin));
        // 常驻 stdout 读取线程：按序推送响应行（会话关闭/进程退出后随管道 EOF 自行结束）
        let (resp_tx, resp_rx) = crossbeam_channel::unbounded::<String>();
        std::thread::spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(stdout);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                if resp_tx.send(line).is_err() {
                    break;
                }
            }
        });
        let session = WslSerialSession {
            child: std::sync::Arc::new(std::sync::Mutex::new(child)),
            writer,
            responses: resp_rx,
            dead: std::sync::atomic::AtomicBool::new(false),
        };
        // 若 bridge 命令失败（超时/进程退出/序列化或写入错误），先杀子进程再返回，避免泄漏孤儿 python 进程
        let resp = match bridge_command(&session, &json!({"cmd":"open","id":&monitor_id,"path":&device_path,"baud":baud_rate})) {
            Ok(r) => r,
            Err(e) => {
                kill_wsl_session(&session);
                report_error(&format!("WSL串口打开失败: {}", e), "open_wsl_serial");
                return Err(e);
            }
        };
        if resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
            sessions.lock().unwrap_or_else(|e| e.into_inner()).insert(monitor_id, std::sync::Arc::new(session));
            Ok(())
        } else {
            let err = resp.get("error").and_then(|v| v.as_str()).unwrap_or("打开失败").to_string();
            report_error(&format!("WSL串口打开失败: {}", err), "open_wsl_serial");
            kill_wsl_session(&session);
            Err(err)
        }
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))?
}

/// 关闭 WSL 串口连接（kill 子进程的 wait() 无超时，移入 spawn_blocking 防主线程卡死）
#[tauri::command]
async fn close_wsl_serial(state: tauri::State<'_, WslSerialState>, monitor_id: String) -> Result<(), String> {
    let sessions = state.sessions.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut map = sessions.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(session) = map.remove(&monitor_id) {
            { use std::io::Write; if let Ok(mut w) = session.writer.lock() { let _ = w.write_all(b"{\"cmd\":\"close\"}\n"); let _ = w.flush(); } }
            kill_wsl_session(&session);
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))?
}

/// 读取 WSL 串口数据。把会话 Arc 克隆出来、释放 sessions 锁后再与 bridge 通信，
/// 避免某个慢命令持全局锁导致其它 WSL 命令串行/阻塞；整体移入 spawn_blocking。
#[tauri::command]
async fn read_wsl_serial(state: tauri::State<'_, WslSerialState>, monitor_id: String) -> Result<Vec<u8>, String> {
    let sessions = state.sessions.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let session = {
            let map = sessions.lock().unwrap_or_else(|e| e.into_inner());
            map.get(&monitor_id).ok_or("未连接 WSL 串口")?.clone()
        };
        let resp = bridge_command(&session, &json!({"cmd":"read","id":&monitor_id,"max":4096}))?;
        if resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
            let b64 = resp.get("data").and_then(|v| v.as_str()).unwrap_or("");
            use base64::Engine;
            Ok(base64::engine::general_purpose::STANDARD.decode(b64).unwrap_or_default())
        } else {
            let err = resp.get("error").and_then(|v| v.as_str()).unwrap_or("读取失败");
            if err.contains("port not open") || err.contains("Resource temporarily unavailable") { Ok(vec![]) } else { Err(err.to_string()) }
        }
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))?
}

/// 向 WSL 串口发送数据
#[tauri::command]
async fn send_wsl_serial(state: tauri::State<'_, WslSerialState>, monitor_id: String, data: Vec<u8>) -> Result<usize, String> {
    let sessions = state.sessions.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let session = {
            let map = sessions.lock().unwrap_or_else(|e| e.into_inner());
            map.get(&monitor_id).ok_or("未连接 WSL 串口")?.clone()
        };
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
        let resp = bridge_command(&session, &json!({"cmd":"write","id":&monitor_id,"data":b64}))?;
        if resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
            Ok(resp.get("n").and_then(|v| v.as_u64()).unwrap_or(data.len() as u64) as usize)
        } else {
            Err(resp.get("error").and_then(|v| v.as_str()).unwrap_or("写入失败").to_string())
        }
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))?
}

/// 设置 WSL 串口信号
async fn set_wsl_signal_cmd(state: tauri::State<'_, WslSerialState>, monitor_id: String, level: bool, signal: String) -> Result<(), String> {
    let sessions = state.sessions.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let session = {
            let map = sessions.lock().unwrap_or_else(|e| e.into_inner());
            map.get(&monitor_id).ok_or("未连接 WSL 串口")?.clone()
        };
        let resp = bridge_command(&session, &json!({"cmd":signal.to_lowercase(),"id":&monitor_id,"level":level}))?;
        if resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) { Ok(()) } else { Err(resp.get("error").and_then(|v| v.as_str()).unwrap_or("设置信号失败").to_string()) }
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))?
}

/// 列出 WSL 内所有串口设备及其 USB 产品名 / VID:PID（单条命令批量获取，避免多次 shell 往返）
/// 通过向上遍历 sysfs 查找 product / idVendor / idProduct，兼容不同内核的符号链接深度
fn list_wsl_tty_details(distro: &str) -> Vec<(String, String, String, String)> {
    let cmd = "for d in /dev/ttyACM* /dev/ttyUSB* /dev/ttyS*; do [ -e \"$d\" ] || continue; b=${d#/dev/}; p=\"\"; v=\"\"; i=\"\"; s=\"\"; dir=$(readlink -f \"/sys/class/tty/$b/device\" 2>/dev/null); while [ -n \"$dir\" ] && [ \"$dir\" != \"/\" ]; do if [ -z \"$p\" ] && [ -f \"$dir/product\" ]; then p=$(cat \"$dir/product\" 2>/dev/null); fi; if [ -z \"$v\" ] && [ -f \"$dir/idVendor\" ]; then v=$(cat \"$dir/idVendor\" 2>/dev/null); fi; if [ -z \"$i\" ] && [ -f \"$dir/idProduct\" ]; then i=$(cat \"$dir/idProduct\" 2>/dev/null); fi; if [ -z \"$s\" ] && [ -f \"$dir/serial\" ]; then s=$(cat \"$dir/serial\" 2>/dev/null); fi; dir=${dir%/*}; done; vidpid=\"\"; if [ -n \"$v\" ] && [ -n \"$i\" ]; then vidpid=$(echo \"$v:$i\" | tr '[:lower:]' '[:upper:]'); fi; echo \"$d|$p|$vidpid|$s\"; done";
    match wsl_shell_exec(distro, cmd, 3000) {
        Ok(out) => out
            .lines()
            .map(|l| l.trim())
            .filter(|l| l.starts_with("/dev/tty"))
            .filter_map(|l| {
                let mut it = l.splitn(4, '|');
                let path = it.next()?.to_string();
                let name = it.next().unwrap_or("").to_string();
                let vidpid = it.next().unwrap_or("").to_string();
                let serial = it.next().unwrap_or("").to_string();
                Some((path, name, vidpid, serial))
            })
            .collect(),
        Err(_) => vec![],
    }
}

/// 获取 WSL 中可用的串口设备列表（路径 + 设备名，使用持久化 shell）
/// 阻塞式实现：在 spawn_blocking 中执行，避免同步命令占用主线程卡住整个 UI。
/// 取消映射后 `device-changed` 事件会触发刷新本命令，同为异步后可并发，靠 WSL_SHELL_CMD_LOCK 串行。
fn get_wsl_serial_devices_blocking() -> Result<Vec<serde_json::Value>, String> {
    let distros = check_wsl_running().unwrap_or_default();
    let distro = distros.first().cloned().unwrap_or_default();
    if distro.is_empty() {
        dbg_log("get_wsl_serial_devices: no running distro");
        return Ok(vec![]);
    }

    let details = list_wsl_tty_details(&distro);
    let devices: Vec<serde_json::Value> = details
        .into_iter()
        .map(|(path, name, _vidpid, _serial)| serde_json::json!({"path": path, "name": name}))
        .collect();
    dbg_log(&format!("get_wsl_serial_devices: distro={}, devices={:?}", distro, devices));
    Ok(devices)
}

#[tauri::command]
async fn get_wsl_serial_devices() -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(get_wsl_serial_devices_blocking)
        .await
        .map_err(|e| format!("任务执行失败: {}", e))?
}

#[tauri::command]
async fn set_wsl_dtr(state: tauri::State<'_, WslSerialState>, monitor_id: String, level: bool) -> Result<(), String> {
    set_wsl_signal_cmd(state, monitor_id, level, "DTR".to_string()).await
}

#[tauri::command]
async fn set_wsl_rts(state: tauri::State<'_, WslSerialState>, monitor_id: String, level: bool) -> Result<(), String> {
    set_wsl_signal_cmd(state, monitor_id, level, "RTS".to_string()).await
}

/// 设备映射操作结果。当需要管理员权限且在授权确认之前（authorized=false），
/// 返回 needs_approval=true（不触发 UAC），由前端弹独立授权窗口让用户确认；
/// 用户确认后以 authorized=true 再次调用，后端才真正提权执行。
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MapWslOutcome {
    needs_approval: bool,
    message: String,
    #[serde(default)]
    busid: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    port: String,
}

/// 解析 usbipd 行，返回 (设备名, COM口)，用于授权窗口的展示。
fn parse_usbipd_line(line: &str) -> (String, String) {
    let parts: Vec<&str> = line.split_whitespace().collect();
    let name = if parts.len() >= 3 {
        let name_parts = &parts[2..];
        let end = if name_parts.last().map(|s| s.to_lowercase()) == Some("shared".into()) {
            let last2 = name_parts.len();
            if last2 >= 2 && name_parts[last2 - 2].to_lowercase() == "not" {
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
            format!("USB Device ({})", parts[0])
        }
    } else {
        String::new()
    };
    let port = if let Some(com_match) = line.find("COM") {
        let rest = &line[com_match..];
        if let Some(ep) = rest.find(|c: char| !c.is_alphanumeric()) {
            rest[..ep].to_string()
        } else {
            rest.to_string()
        }
    } else {
        String::new()
    };
    (name, port)
}

/// 判断提权结果文件是否已写入"终态标记"（成功操作成功 / bind失败 / attach失败 / 异常）。
/// 用于避免在 usbipd 尚未执行完毕、结果还不完整时提前读取，导致"已成功却报失败"。
fn is_wsl_result_terminal(content: &str) -> bool {
    content.contains("操作成功")
        || content.contains("bind失败")
        || content.contains("attach失败")
        || content.contains("异常")
}

/// 将指定串口对应的 USB 设备映射到 WSL
/// 通过 usbipd 工具实现：
///   1. usbipd list 找到目标端口的 busid
///   2. 检查绑定状态，已绑定则直接 attach（无需管理员权限）
///   3. 未绑定则通过 PowerShell 提权执行 bind + attach
/// authorized=false 时仅在需要提权的情况下返回需授权标志（不触发 UAC），
/// 由前端弹独立授权窗口让用户确认；用户确认后以 authorized=true 再次调用，
/// 此时后端才真正提权执行（提权进程窗口隐藏，避免控制台一闪而过）。
#[tauri::command]
async fn attach_port_to_wsl(port_name: String, distro: Option<String>, authorized: bool) -> Result<MapWslOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || attach_port_to_wsl_blocking(port_name, distro, authorized))
        .await
        .map_err(|e| format!("任务执行失败: {}", e))?
}

fn attach_port_to_wsl_blocking(port_name: String, distro: Option<String>, authorized: bool) -> Result<MapWslOutcome, String> {
    // 目标 WSL 发行版：多发行版时 usbipd 默认附加到默认发行版，需显式指定（#19）
    let distro_args: Vec<String> = match distro.as_deref().map(str::trim) {
        Some(d) if !d.is_empty() => vec!["--distribution".to_string(), d.to_string()],
        _ => vec![],
    };
    let distro_ps: String = match distro.as_deref().map(str::trim) {
        Some(d) if !d.is_empty() => format!("--distribution '{}'", d.replace('\'', "''")),
        _ => String::new(),
    };
    // 0. 检查是否有正在运行的 WSL 发行版（带超时）
    let wsl_check = run_output_timeout(hidden_command("wsl").args(["--list", "--running"]), 5000);
    match wsl_check {
        Some(out) => {
            let text = decode_wsl_output(&out.stdout);
            let has_running = text.lines()
                .any(|line| {
                    let l = line.trim();
                    !l.is_empty() && !l.contains("Distributions") && !l.contains("分发")
                });
            if !has_running {
                report_error("WSL 未运行", "attach_port_to_wsl");
                return Err("WSL 未运行，请先打开一个 WSL 终端窗口再进行映射".to_string());
            }
        }
        None => {
            report_error("检测 WSL 状态超时", "attach_port_to_wsl");
            return Err("检测 WSL 状态超时，请确认 WSL 已安装且未卡死".to_string());
        }
    }

    // 1. 获取设备列表（带 kill 的超时，避免 usbipd 卡死时泄漏孤儿线程/进程）
    let list_out = match run_output_timeout(hidden_command("usbipd").args(["list"]), 3000) {
        Some(out) => out,
        None => {
            report_error("usbipd list 执行超时或失败", "attach_port_to_wsl");
            return Err("usbipd list 执行超时（3 秒），请确认 usbipd-win 已正确安装".to_string());
        }
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
        return Ok(MapWslOutcome {
            needs_approval: false,
            message: format!("已将 {} (busid: {}) 映射到 WSL", port_name, busid),
            busid: busid.clone(),
            name: String::new(),
            port: String::new(),
        });
    }

    // 4. 如果已绑定，尝试直接 attach（无需管理员权限）
    if already_bound {
        dbg_log(&format!("Device {} already bound, trying direct attach", busid));
        let output = hidden_command("usbipd")
            .args(["attach", "--wsl", "--busid", &busid])
            .args(&distro_args)
            .output();

        match output {
            Ok(out) if out.status.success() => {
                dbg_log(&format!("Direct attach succeeded for {}", busid));
                return Ok(MapWslOutcome {
                    needs_approval: false,
                    message: format!("已将 {} (busid: {}) 映射到 WSL", port_name, busid),
                    busid: busid.clone(),
                    name: String::new(),
                    port: String::new(),
                });
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                dbg_log(&format!("Direct attach failed for {}: stderr={}, stdout={}", busid, stderr, stdout));
                // 直接attach失败，需要用管理员权限
            }
            Err(e) => {
                dbg_log(&format!("Direct attach command error for {}: {}", busid, e));
                report_error(&format!("执行 usbipd attach 失败: {}", e), "attach_port_to_wsl");
                return Err(format!("执行 usbipd attach 失败: {}", e));
            }
        }
    }

    // 5. 需要管理员权限。首次映射时先让用户在独立的授权窗口确认，不直接触发 UAC，
    //    避免控制台一闪而过与"可能用户取消"的误报。
    if !authorized {
        let (line_name, line_port) = parse_usbipd_line(&target_line);
        dbg_log(&format!("Device {} needs elevation, requesting user approval", busid));
        return Ok(MapWslOutcome {
            needs_approval: true,
            message: "映射该设备需要管理员权限授权，请在授权窗口中确认".to_string(),
            busid: busid.clone(),
            name: line_name,
            port: line_port,
        });
    }

    // 6. 未绑定 或 直接attach失败，需要管理员权限
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let unique_id = COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_result = std::env::temp_dir().join(format!(
        "usbipd_result_{}_{}_{}.txt",
        std::process::id(),
        unique_id,
        temp_rand_suffix()
    ));
    let tmp_result_str = tmp_result.to_str().unwrap_or("C:\\Temp\\usbipd_result.txt");

    let ps_script = if already_bound {
        // 已绑定但直接attach失败，用管理员权限attach
        dbg_log(&format!("Using admin to attach {}", busid));
        format!(
            "try {{ \
               $out = & usbipd.exe attach --wsl --busid {busid} {distro} 2>&1 | Out-String; \
               $out | Out-File -FilePath '{result}' -Encoding UTF8; \
               if ($LASTEXITCODE -ne 0) {{ 'attach失败，退出码: ' + $LASTEXITCODE | Out-File -FilePath '{result}' -Encoding UTF8 -Append; exit 1 }}; \
               '操作成功' | Out-File -FilePath '{result}' -Encoding UTF8 -Append \
             }} catch {{ \
               '异常: ' + $_.Exception.Message | Out-File -FilePath '{result}' -Encoding UTF8; \
               exit 1 \
             }}",
            busid = busid,
            distro = distro_ps,
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
               $attachOut = & usbipd.exe attach --wsl --busid {busid} {distro} 2>&1 | Out-String; \
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
            distro = distro_ps,
            result = tmp_result_str
        )
    };

    // 6. 通过 -EncodedCommand 传脚本内容触发 UAC 提权（不写可预测临时 .ps1，消除 TOCTOU）
    let _ = std::fs::remove_file(&tmp_result);
    let encoded = encode_ps_command(&ps_script);

    dbg_log(&format!("PowerShell elevated attach: busid={}", busid));

    // 不再使用 -Wait：UAC 弹窗未被确认时 -Wait 会永久挂起，导致界面卡死
    // -WindowStyle Hidden：隐藏提权后 PowerShell 的控制台窗口，避免"授权终端一闪而过"
    // Start-Process -Verb RunAs 会阻塞等待 UAC 授权结果。启动退出码不用于立即判定成败
    // （有些环境下成功时退出码也可能非零），而是：启动非零用较短等待，零用较长等待；
    // 最终一律以结果文件内容判断成功/失败，避免误报"授权失败"。
    let launch_status = hidden_command("powershell")
        .args(["-NonInteractive", "-Command"])
        .arg(format!("Start-Process -FilePath 'powershell' -ArgumentList '-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-NonInteractive','-EncodedCommand','{}' -Verb RunAs -WindowStyle Hidden", encoded))
        .status()
        .map_err(|e| format!("提权启动失败: {}", e))?;
    dbg_log(&format!("Elevated attach launch: ok={}, code={:?}", launch_status.success(), launch_status.code()));

    // 启动成功给足时间（60s）完成；启动非零（可能被拒绝 UAC）用较短等待，但结果文件出现仍视为成功
    let poll_secs: u64 = if launch_status.success() { 60 } else { 15 };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(poll_secs);
    // 轮询直到结果文件写入完毕（出现终态标记），避免读取到 usbipd 执行中途的内容，
    // 否则会因尚未写入"操作成功"而误判失败（实际设备已成功映射）。
    let result_exists = loop {
        if std::time::Instant::now() >= deadline { break tmp_result.exists(); }
        if !tmp_result.exists() {
            std::thread::sleep(std::time::Duration::from_millis(150));
            continue;
        }
        if let Ok(content) = std::fs::read_to_string(&tmp_result) {
            if is_wsl_result_terminal(&content) { break true; }
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    };
    std::thread::sleep(std::time::Duration::from_millis(150)); // 等待最后一次写入落盘

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
        Ok(MapWslOutcome {
            needs_approval: false,
            message: format!("已将 {} (busid: {}) 绑定并映射到 WSL", port_name, busid),
            busid: busid.clone(),
            name: String::new(),
            port: String::new(),
        })
    } else if result_exists && result_content.is_empty() {
        // 已绑定时 attach 成功不会写入 "操作成功"，但结果文件存在且无输出表示成功
        Ok(MapWslOutcome {
            needs_approval: false,
            message: format!("已将 {} (busid: {}) 绑定并映射到 WSL", port_name, busid),
            busid: busid.clone(),
            name: String::new(),
            port: String::new(),
        })
    } else if result_content.contains("bind失败") || result_content.contains("attach失败") || result_content.contains("异常") {
        report_error(&format!("WSL映射失败: {}", result_content), "wsl_attach");
        Err(format!("usbipd 映射失败: {}", result_content))
    } else if !launch_status.success() {
        report_error("WSL映射未完成，UAC 可能被拒绝", "wsl_attach");
        Err("未获得管理员授权，已取消映射（UAC 被拒绝）".to_string())
    } else {
        report_error("WSL映射操作未完成，可能超时", "wsl_attach");
        Err("未获得管理员授权（可能取消了 UAC 或操作超时），请重试".to_string())
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
            Some(s) => {
                report_error(&format!("WSL断开映射失败: {}", s), "detach_port_from_wsl");
                Err(format!("断开失败: {}", s))
            }
            None => {
                report_error("WSL断开映射失败，用户可能取消了管理员权限请求", "detach_port_from_wsl");
                Err("断开失败，可能用户取消了管理员权限请求".to_string())
            }
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
    let tmp_result = std::env::temp_dir().join(format!(
        "usbipd_detach_{}_{}_{}.txt",
        std::process::id(),
        unique_id,
        temp_rand_suffix()
    ));
    let tmp_result_str = tmp_result.to_str().unwrap_or("C:\\Temp\\usbipd_detach.txt");

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

    // 通过 -EncodedCommand 传脚本内容，避免写可预测的临时 .ps1（TOCTOU）
    let _ = std::fs::remove_file(&tmp_result);
    let encoded = encode_ps_command(&ps_script);
    // 不再使用 -Wait：UAC 弹窗未被确认时 -Wait 会永久挂起，导致界面卡死
    // -WindowStyle Hidden：隐藏提权后 PowerShell 的控制台窗口，避免"授权终端一闪而过"
    // 捕获启动退出码：非零（UAC 可能被拒绝）用较短等待；零（UAC 已同意）给 usbipd 足够时间完成。
    let launch_status = hidden_command("powershell")
        .args(["-NonInteractive", "-Command"])
        .arg(format!("Start-Process -FilePath 'powershell' -ArgumentList '-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-NonInteractive','-EncodedCommand','{}' -Verb RunAs -WindowStyle Hidden", encoded))
        .status();
    let ok = launch_status.map(|s| s.success()).unwrap_or(false);
    dbg_log(&format!("Elevated detach launch ok={}", ok));
    let poll_secs: u64 = if ok { 20 } else { 8 };
    // 轮询结果文件直到超时（UAC 未确认也不会永久阻塞）
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(poll_secs);
    while !tmp_result.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    std::thread::sleep(std::time::Duration::from_millis(200)); // 等待文件写入完成

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

/// 备份用户配置（升级/迁移前兜底，防止旧配置被覆盖时丢失）
#[tauri::command]
fn backup_config() -> Result<String, String> {
    use std::fs;

    let config_dir = match dirs_config_path() {
        Some(p) => p,
        None => return Ok(String::new()),
    };
    let config_file = config_dir.join("config.json");
    let backup_file = config_dir.join("config.json.bak");
    // 已存在备份时覆盖；无配置文件则跳过（无配置可备份）
    if let Ok(s) = fs::read_to_string(&config_file) {
        fs::write(&backup_file, &s).map_err(|e| format!("备份配置失败: {}", e))?;
    }
    Ok(backup_file.to_string_lossy().into_owned())
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

    // 安全：path 必须规范化为最近一次通过 choose_log_directory 选择的目录，防止任意路径写文件
    let allowed_dir = {
        let cache = LAST_LOG_DIR.get_or_init(|| std::sync::Mutex::new(None));
        let lock = cache.lock().map_err(|_| "日志目录锁获取失败".to_string())?;
        lock.clone().unwrap_or_default()
    };
    if allowed_dir.is_empty() {
        return Err("日志目录不是最近一次选择的目录".into());
    }
    let allowed = Path::new(&allowed_dir)
        .canonicalize()
        .map_err(|e| format!("日志目录解析失败: {}", e))?;
    let target = Path::new(&path)
        .canonicalize()
        .map_err(|e| format!("日志目录路径无效: {}", e))?;
    if allowed != target {
        return Err("日志目录不是最近一次选择的目录，已拒绝写入".into());
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

// ===== 日志隐形缓存 =====
// 每次打开串口并产生收发内容的会话会自动缓存为一个日志文件（无需用户手动保存）。
// 缓存目录：%APPDATA%\seahi-serial\log-cache（Windows）
// 上限 LOG_CACHE_MAX_COUNT 个文件，新建文件时按 FIFO 删除最旧的。

/// 缓存文件前缀（含时间戳，可按键排序）
const LOG_CACHE_PREFIX: &str = "session-";
/// 缓存文件后缀
const LOG_CACHE_SUFFIX: &str = ".log";
/// 最多保留的缓存文件数
const LOG_CACHE_MAX_COUNT: usize = 10;

/// 单个监视器的会话缓存状态
struct LogCacheSession {
    /// 会话端口名（用于文件命名）
    port_name: String,
    /// 已打开的文件句柄；None 表示会话尚未写入任何内容（即未创建文件）
    file: Option<std::fs::File>,
    /// 文件完整路径（结束会话时用于清理空文件）
    path: std::path::PathBuf,
}

/// 全局日志隐形缓存状态（key = monitor_id）
struct LogCacheState {
    sessions: std::sync::Mutex<std::collections::HashMap<String, LogCacheSession>>,
}

/// 获取日志缓存目录
fn log_cache_dir() -> std::path::PathBuf {
    let base = dirs_config_path();
    match base {
        Some(p) => p.join("log-cache"),
        None => std::env::temp_dir().join("seahi-serial-log-cache"),
    }
}

/// 紧凑时间戳（用于文件名，Windows 用本地时间）
fn log_cache_time_stamp() -> String {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::GetLocalTime;
        use windows_sys::Win32::Foundation::SYSTEMTIME;
        let mut st: SYSTEMTIME = unsafe { std::mem::zeroed() };
        unsafe { GetLocalTime(&mut st) };
        format!(
            "{:04}{:02}{:02}-{:02}{:02}{:02}{:03}",
            st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds
        )
    }
    #[cfg(not(windows))]
    {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .unwrap_or_default();
        format!("{}", now.as_millis())
    }
}

/// 清洗端口名为合法的文件名片段
fn sanitize_for_filename(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
            out.push(c);
        } else if c == '/' || c == '\\' {
            out.push('-');
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        out.push_str("port");
    }
    out
}

/// 保证缓存目录下的文件数不超过上限：超出时删除最旧的（按文件名时间戳升序）
fn enforce_log_cache_limit(dir: &std::path::Path) {
    use std::fs;
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_file() {
                if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with(LOG_CACHE_PREFIX) && name.ends_with(LOG_CACHE_SUFFIX) {
                        files.push(p);
                    }
                }
            }
        }
    }
    files.sort(); // 文件名前缀含可排序时间戳，字典序即时间序
    if files.len() > LOG_CACHE_MAX_COUNT {
        let remove_count = files.len() - LOG_CACHE_MAX_COUNT;
        for p in files.into_iter().take(remove_count) {
            let _ = fs::remove_file(p);
        }
    }
}

/// 标记一次串口会话开始（幂等：已存在则保留原文件，自动重连时日志连续）
#[tauri::command]
fn start_log_cache(state: tauri::State<'_, LogCacheState>, monitor_id: String, port_name: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
    sessions.entry(monitor_id).or_insert_with(|| LogCacheSession {
        port_name,
        file: None,
        path: std::path::PathBuf::new(),
    });
    Ok(())
}

/// 向当前会话缓存文件追加内容。首次写入时创建文件并清理旧缓存（FIFO，≤10 个）
#[tauri::command]
fn append_log_cache(state: tauri::State<'_, LogCacheState>, monitor_id: String, content: String) -> Result<(), String> {
    use std::io::Write;
    if content.is_empty() {
        return Ok(());
    }
    let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
    let sess = sessions.entry(monitor_id).or_insert_with(|| LogCacheSession {
        port_name: String::new(),
        file: None,
        path: std::path::PathBuf::new(),
    });

    // 首次写入：创建目录、清理旧缓存、新建文件
    if sess.file.is_none() {
        let dir = log_cache_dir();
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建日志缓存目录失败: {}", e))?;
        enforce_log_cache_limit(&dir);
        let filename = format!(
            "{}{}-{}{}",
            LOG_CACHE_PREFIX,
            log_cache_time_stamp(),
            sanitize_for_filename(&sess.port_name),
            LOG_CACHE_SUFFIX
        );
        let path = dir.join(&filename);
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| format!("创建日志缓存文件失败: {}", e))?;
        sess.path = path;
        sess.file = Some(file);
    }

    if let Some(f) = sess.file.as_mut() {
        f.write_all(content.as_bytes()).map_err(|e| format!("写入日志缓存失败: {}", e))?;
        let _ = f.flush();
    }
    Ok(())
}

/// 结束当前会话缓存：关闭文件句柄，若文件为空则删除，并清理会话状态
#[tauri::command]
fn end_log_cache(state: tauri::State<'_, LogCacheState>, monitor_id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(sess) = sessions.remove(&monitor_id) {
        drop(sess.file);
        if sess.path.exists() {
            let size = std::fs::metadata(&sess.path).map(|m| m.len()).unwrap_or(0);
            if size == 0 {
                let _ = std::fs::remove_file(&sess.path);
            }
        }
    }
    Ok(())
}

/// 列出当前已缓存的日志文件（供界面展示/排查，返回文件名 + 大小 + 修改时间）
#[tauri::command]
fn list_log_cache() -> Result<Vec<serde_json::Value>, String> {
    use std::fs;
    let dir = log_cache_dir();
    let mut items: Vec<serde_json::Value> = Vec::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_file() {
                if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with(LOG_CACHE_PREFIX) && name.ends_with(LOG_CACHE_SUFFIX) {
                        if let Ok(meta) = p.metadata() {
                            let modified = meta.modified()
                                .ok()
                                .and_then(|t| t.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
                                .map(|d| d.as_millis())
                                .unwrap_or(0);
                            items.push(serde_json::json!({
                                "name": name,
                                "size": meta.len(),
                                "modified": modified,
                            }));
                        }
                    }
                }
            }
        }
    }
    items.sort_by(|a, b| {
        let am = a.get("modified").and_then(|v| v.as_u64()).unwrap_or(0);
        let bm = b.get("modified").and_then(|v| v.as_u64()).unwrap_or(0);
        bm.cmp(&am) // 新的在前
    });
    Ok(items)
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
    /// GitHub API 提供的 SHA-256 digest（格式 "sha256:<base64>"，可能缺失）
    #[serde(default)]
    digest: Option<String>,
    #[serde(default)]
    size: Option<u64>,
}

/// 返回给前端的更新信息
#[derive(Debug, serde::Serialize)]
struct UpdateInfo {
    has_update: bool,
    latest_version: String,
    current_version: String,
    download_url: String,
    /// 安装包 SHA-256（hex 小写），用于下载后校验；GitHub 未提供 digest 时为 null
    #[serde(skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
    /// 安装包字节数（GitHub 提供时用于校验；digest 缺失时的兜底）
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
}

/// 纯 Rust SHA-256（用于更新包校验，避免引入额外依赖）
fn sha256_hex(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    let bit_len = (data.len() as u64).wrapping_mul(8);
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }
    h.iter().map(|v| format!("{:08x}", v)).collect()
}

/// 将 GitHub digest（"sha256:<base64>"）转换为 hex 小写；解析失败返回 None
fn digest_to_hex(digest: &str) -> Option<String> {
    let b64 = digest.strip_prefix("sha256:").unwrap_or(digest);
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    if bytes.len() != 32 {
        return None;
    }
    Some(bytes.iter().map(|b| format!("{:02x}", b)).collect())
}

#[cfg(test)]
mod sha256_tests {
    #[test]
    fn known_vectors() {
        assert_eq!(
            super::sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            super::sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}

#[cfg(test)]
mod util_tests {
    #[test]
    fn parse_hex_bytes_works() {
        assert_eq!(super::parse_hex_bytes("FF 01 02"), vec![0xFF, 0x01, 0x02]);
        assert_eq!(super::parse_hex_bytes("ff0102"), vec![0xFF, 0x01, 0x02]);
        assert_eq!(super::parse_hex_bytes("00 41 62"), vec![0x00, 0x41, 0x62]);
        // 奇数长度 → 非法，返回空
        assert_eq!(super::parse_hex_bytes("abc"), Vec::<u8>::new());
        // 非 hex 字符 → 非法
        assert_eq!(super::parse_hex_bytes("zz"), Vec::<u8>::new());
    }

    #[test]
    fn parse_version_handles_prefix_and_prerelease() {
        assert_eq!(super::parse_version("0.2.11"), (0, 2, 11));
        assert_eq!(super::parse_version("v0.2.10"), (0, 2, 10));
        assert_eq!(super::parse_version("0.2.11-beta"), (0, 2, 11));
        assert_eq!(super::parse_version("0.2.11-rc.1"), (0, 2, 11));
        // 预发布版本不高于正式版；is_newer_version(current, latest) 为 true 表示有更新
        assert!(!super::is_newer_version("0.2.11", "0.2.11-beta"));
        assert!(super::is_newer_version("0.2.10", "0.2.11"));
        assert!(!super::is_newer_version("0.2.11", "0.2.10"));
    }

    #[test]
    fn strip_windows_com_suffix_works() {
        assert_eq!(super::strip_windows_com_suffix("USB 串行设备 (COM28)"), "USB 串行设备");
        assert_eq!(super::strip_windows_com_suffix("COM3"), "COM3");
        // 含 "(COM" + 数字 后缀会被剥离
        assert_eq!(super::strip_windows_com_suffix("COM xx (COM28)"), "COM xx");
    }

    #[test]
    fn decode_wsl_output_utf16le() {
        // "Ubuntu\n" 的 UTF-16LE 编码
        let mut raw = vec![0xFF, 0xFE];
        for u in "Ubuntu\n".encode_utf16() {
            raw.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(super::decode_wsl_output(&raw), "Ubuntu\n");
    }

    #[test]
    fn decode_wsl_output_ascii() {
        // 没有 BOM，当作 UTF-8 处理
        let raw = b"NAME          STATE";
        assert_eq!(super::decode_wsl_output(raw), "NAME          STATE");
    }
}

/// 解析版本号字符串，返回 (major, minor, patch) 元组
/// 支持 -beta / -rc 等预发布后缀（只取数字部分）与 v/V 前缀
fn parse_version(ver: &str) -> (u32, u32, u32) {
    let ver = ver.trim_start_matches('v').trim_start_matches('V');
    // 去掉 -beta / -rc / +build 等后缀，只保留数字主体
    let ver = ver.split(['-', '+']).next().unwrap_or(ver);
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

    // 2. 网络失败不上报错误（瞬态问题，前端已优雅处理）
    if resp.is_none() {
        return Err("无法连接 GitHub，请检查网络".to_string());
    }

    let resp = resp.unwrap();

    if !resp.status().is_success() {
        let msg = format!("GitHub API 返回错误状态码: {}", resp.status());
        report_error(&msg, "check_update");
        return Err(msg);
    }

    let release: GitHubRelease = resp
        .json()
        .await
        .map_err(|e| {
            report_error(&format!("解析 GitHub 响应失败: {}", e), "check_update");
            format!("解析 GitHub 响应失败: {}", e)
        })?;

    let has_update = is_newer_version(&current, &release.tag_name);

    // 查找 Windows 安装包（优先 NSIS .exe，其次 .msi）
    let (download_url, sha256, size) = if has_update {
        let asset = release
            .assets
            .iter()
            .find(|a| a.name.to_lowercase().contains("-setup") && a.name.ends_with(".exe"))
            .or_else(|| release.assets.iter().find(|a| a.name.ends_with(".exe")))
            .or_else(|| release.assets.iter().find(|a| a.name.ends_with(".msi")));

        match asset {
            Some(a) => (
                a.browser_download_url.clone(),
                a.digest.as_deref().and_then(digest_to_hex),
                a.size,
            ),
            None => (String::new(), None, None),
        }
    } else {
        (String::new(), None, None)
    };

    // 缓存本次检查结果，供 download_update 校验（防前端传入任意 URL / 大小值）
    {
        let cache = UPDATE_INFO_CACHE.get_or_init(|| std::sync::Mutex::new(None));
        if let Ok(mut c) = cache.lock() {
            *c = Some((download_url.clone(), sha256.clone(), size));
        }
    }

    Ok(UpdateInfo {
        has_update,
        latest_version: release.tag_name,
        current_version: current,
        download_url,
        sha256,
        size,
    })
}

/// 下载更新安装包到临时目录
/// 提供 sha256（hex 小写）时下载完成后做哈希校验，未提供时用 size 做兜底长度校验；
/// 校验不匹配则删除并报错，杜绝执行被篡改的安装包
#[tauri::command]
async fn download_update(download_url: String, _sha256: Option<String>, _size: Option<u64>) -> Result<String, String> {
    use std::fs;

    // 安全：从后端缓存取值校验，不信任前端传入的 download_url / sha256 / size
    let (cached_url, cached_sha256, cached_size) = {
        let cache = UPDATE_INFO_CACHE.get_or_init(|| std::sync::Mutex::new(None));
        let lock = cache.lock().map_err(|_| "更新信息锁获取失败".to_string())?;
        lock.clone().unwrap_or_default()
    };

    // 校验下载 URL 必须等于最近一次检查更新得到的 URL
    if cached_url.is_empty() || download_url != cached_url {
        return Err("更新信息已过期，请重新检查更新后重试".to_string());
    }
    // 校验：SHA-256 或缓存大小值至少一个存在，杜绝零校验下载任意文件
    if cached_sha256.is_none() && cached_size.is_none() {
        return Err("更新包缺少校验信息，已拒绝下载".to_string());
    }

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
        .map_err(|e| {
            report_error(&format!("下载更新包失败: {}", e), "download_update");
            format!("下载失败: {}", e)
        })?;

    if !resp.status().is_success() {
        let msg = format!("下载失败，HTTP 状态码: {}", resp.status());
        report_error(&msg, "download_update");
        return Err(msg);
    }

    // 获取文件名并净化：拒绝路径分隔符 / 反斜杠 / ".." / 盘符，防止路径穿越
    let filename = download_url
        .rsplit_once('/')
        .map(|(_, name)| name)
        .unwrap_or("update-setup.exe");
    let filename = if filename.is_empty()
        || filename.contains('\\')
        || filename.contains('/')
        || filename.contains(':')
        || filename.contains("..")
    {
        "update-setup.exe".to_string()
    } else {
        filename.to_string()
    };

    // 保存到临时目录
    let temp_dir = std::env::temp_dir().join("seahi-serial-update");
    fs::create_dir_all(&temp_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;
    let file_path = temp_dir.join(&filename);

    let bytes = resp.bytes().await.map_err(|e| format!("读取下载内容失败: {}", e))?;

    // 校验安装包完整性：优先 SHA-256（来自后端缓存），缺失时用缓存的大小值兜底
    if let Some(expected) = &cached_sha256 {
        let actual = sha256_hex(&bytes);
        if !actual.eq_ignore_ascii_case(expected) {
            let _ = fs::remove_file(&file_path);
            let msg = format!("更新包校验失败（SHA-256 不匹配），已中止安装");
            report_error(&msg, "download_update");
            return Err(msg);
        }
        dbg_log(&format!("download_update: SHA-256 校验通过 {}", actual));
    } else if let Some(expected_size) = cached_size {
        if bytes.len() as u64 != expected_size {
            let _ = fs::remove_file(&file_path);
            let msg = format!(
                "更新包校验失败（大小 {} != 预期 {}），已中止安装",
                bytes.len(),
                expected_size
            );
            report_error(&msg, "download_update");
            return Err(msg);
        }
        dbg_log(&format!("download_update: 大小校验通过 {}", bytes.len()));
    }

    fs::write(&file_path, &bytes).map_err(|e| format!("写入安装包失败: {}", e))?;

    Ok(file_path.to_string_lossy().to_string())
}

/// 启动安装包并退出当前程序
/// 直接以独立进程启动安装包（.msi 走 msiexec），不再经过 cmd start，避免 cmd 元字符注入
#[tauri::command]
fn install_update(app: tauri::AppHandle, file_path: String) -> Result<(), String> {
    // 安全：只允许启动位于 %TEMP%\seahi-serial-update\ 下的 .exe / .msi 安装包，防止任意路径执行
    let temp_dir = std::env::temp_dir()
        .join("seahi-serial-update")
        .canonicalize()
        .map_err(|e| format!("解析临时目录失败: {}", e))?;
    let canonical = std::path::Path::new(&file_path)
        .canonicalize()
        .map_err(|e| format!("安装包路径无效: {}", e))?;
    if !canonical.starts_with(&temp_dir) {
        return Err("安装包路径不在受控目录内，已拒绝执行".to_string());
    }
    let ext = canonical
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext != "exe" && ext != "msi" {
        return Err("安装包扩展名不合法，已拒绝执行".to_string());
    }
    let installable = canonical.to_string_lossy().to_string();

    #[cfg(windows)]
    {
        // Windows: 启动安装包，不等待其完成
        let lower = installable.to_lowercase();
        if lower.ends_with(".msi") {
            hidden_command("msiexec")
                .args(["/i", &installable, "/passive", "/norestart"])
                .spawn()
                .map_err(|e| format!("启动安装程序失败: {}", e))?;
        } else {
            std::process::Command::new(&installable)
                .spawn()
                .map_err(|e| format!("启动安装程序失败: {}", e))?;
        }
    }

    #[cfg(not(windows))]
    {
        std::process::Command::new(&installable)
            .spawn()
            .map_err(|e| format!("启动安装程序失败: {}", e))?;
    }

    // 通知前端保存配置（beforeunload 可能被 process::exit 跳过）
    let _ = app.emit("save-before-exit", ());
    std::thread::sleep(std::time::Duration::from_millis(600));
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
    let w = width.max(1047);
    let h = height.max(650);
    window.set_size(tauri::Size::Physical(tauri::PhysicalSize { width: w, height: h }))
        .map_err(|e| format!("设置窗口大小失败: {}", e))
}

/// 用系统默认浏览器打开 URL
/// 安全：不再使用 `cmd /C start`（存在命令注入风险），改用 rundll32 url.dll,FileProtocolHandler，
/// 并校验 URL 必须为 http/https 协议、不含空白与命令元字符。
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    let is_allowed = trimmed.starts_with("http://") || trimmed.starts_with("https://");
    let has_bad_chars = trimmed.chars().any(|c| {
        c.is_whitespace()
            || c == '"'
            || c == '\''
            || c == '&'
            || c == '|'
            || c == '^'
            || c == ';'
            || c == '\r'
            || c == '\n'
    });
    if !is_allowed || has_bad_chars {
        return Err(format!("非法 URL: {}", url));
    }

    let mut cmd = std::process::Command::new("rundll32.exe");
    cmd.args(["url.dll,FileProtocolHandler", trimmed]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.spawn()
        .map_err(|e| format!("打开 URL 失败: {}", e))?;
    Ok(())
}

/// 测试错误上报功能（仅用于开发测试）
#[cfg(debug_assertions)]
#[tauri::command]
fn test_error_report() -> Result<String, String> {
    let test_error = "Test error from Tauri application";
    let test_context = "test_error_report_function";
    
    report_error(test_error, test_context);
    
    Ok(format!("已上报测试错误: {}", test_error))
}

/// 接收前端 JS 错误并上报
#[tauri::command]
fn report_js_error(error: String, context: String) {
    report_error(&error, &context);
}

/// PTY 会话：通过伪终端让 adb shell 交互式运行（ls 多列 + ANSI 彩色 + 标准提示符）
struct AdbPtySession {
    child: std::sync::Arc<std::sync::Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    /// 写入端：portable-pty 的 master 通过 take_writer() 得到可写句柄
    writer: std::sync::Mutex<Box<dyn std::io::Write + Send>>,
    /// 常驻读取线程推送的原始输出块
    output: crossbeam_channel::Receiver<Vec<u8>>,
    dead: std::sync::atomic::AtomicBool,
    /// 保活：保存 PTY master/slave，避免 pair drop 导致 shell 退出
    _master: std::sync::Mutex<Option<Box<dyn portable_pty::MasterPty + Send>>>,
    _slave: std::sync::Mutex<Option<Box<dyn portable_pty::SlavePty + Send>>>,
}

/// 全局状态：ADB PTY 会话（key = session_id）
struct AdbPtyState {
    sessions: std::sync::Arc<Mutex<HashMap<String, std::sync::Arc<AdbPtySession>>>>,
}

/// 查找 adb，打开一个交互式 shell 会话
#[tauri::command]
async fn adb_open_shell(
    state: tauri::State<'_, AdbPtyState>,
    serial: String,
) -> Result<String, String> {
    let adb = find_adb().ok_or_else(|| "未找到 adb 可执行文件".to_string())?;
    let sessions = state.sessions.clone();
    tauri::async_runtime::spawn_blocking(move || {
        println!("[ADB-PTY] open_shell entered, serial={}", serial);
        let pty_system = portable_pty::native_pty_system();
        let mut cmd = portable_pty::CommandBuilder::new(&adb);
        cmd.arg("-s");
        cmd.arg(&serial);
        cmd.arg("shell");
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.cwd("C:\\");
        let pty_size = portable_pty::PtySize { rows: 40, cols: 120, pixel_width: 0, pixel_height: 0 };
        println!("[ADB-PTY] openpty size rows={} cols={}", pty_size.rows, pty_size.cols);
        let pair = pty_system
            .openpty(pty_size)
            .map_err(|e| format!("openpty 失败: {}", e))?;
        let child = pair.slave.spawn_command(cmd).map_err(|e| format!("spawn adb shell 失败: {}", e))?;
        println!("[ADB-PTY] shell spawned, waiting for ready...");
        std::thread::sleep(std::time::Duration::from_millis(1500));
        // 读线程：读 PTY 输出并推送到 channel
        let mut reader = pair.master.try_clone_reader().map_err(|e| format!("克隆reader失败: {}", e))?;
        let (tx, rx) = crossbeam_channel::unbounded::<Vec<u8>>();
        std::thread::spawn(move || {
            use std::io::Read;
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => { println!("[ADB-PTY] reader EOF"); let _ = tx.send(Vec::new()); break; }
                    Ok(n) => { if tx.send(buf[..n].to_vec()).is_err() { break; } }
                    Err(e) => { println!("[ADB-PTY] reader err {}", e); break; }
                }
            }
        });
        let session_id = format!("adb-pty-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        // 用 take_writer() 拿写入句柄
        let writer = pair.master.take_writer().map_err(|e| format!("take_writer 失败: {}", e))?;
        let session = std::sync::Arc::new(AdbPtySession {
            child: std::sync::Arc::new(std::sync::Mutex::new(child)),
            writer: std::sync::Mutex::new(writer),
            output: rx,
            dead: std::sync::atomic::AtomicBool::new(false),
            _master: std::sync::Mutex::new(Some(pair.master)),
            _slave: std::sync::Mutex::new(Some(pair.slave)),
        });
        { let mut s = sessions.lock().unwrap_or_else(|e| e.into_inner()); s.insert(session_id.clone(), session); }

        Ok(session_id)
    }).await.map_err(|e| format!("任务错误: {}", e))?
}

/// 向会话写入命令/字符
#[tauri::command]
async fn adb_shell_write(
    state: tauri::State<'_, AdbPtyState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let sessions = state.sessions.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let session = { let s = sessions.lock().unwrap_or_else(|e| e.into_inner()); s.get(&session_id).cloned() };
        let session = session.ok_or_else(|| "会话不存在".to_string())?;
        if session.dead.load(std::sync::atomic::Ordering::Relaxed) { return Err("会话已关闭".into()); }
        let mut w = session.writer.lock().map_err(|e| format!("锁失败: {}", e))?;
        use std::io::Write;
        w.write_all(data.as_bytes()).map_err(|e| format!("写入失败: {}", e))?;
        let _ = w.flush();
        Ok(())
    }).await.map_err(|e| format!("任务错误: {}", e))?
}

/// 读取会话输出（非阻塞：立即返回当前累积的数据）
#[tauri::command]
async fn adb_shell_read(
    state: tauri::State<'_, AdbPtyState>,
    session_id: String,
) -> Result<Vec<u8>, String> {
    let sessions = state.sessions.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let session = { let s = sessions.lock().unwrap_or_else(|e| e.into_inner()); s.get(&session_id).cloned() };
        let session = session.ok_or_else(|| "会话不存在".to_string())?;
        let mut buf: Vec<u8> = Vec::new();
        while let Ok(chunk) = session.output.try_recv() {
            buf.extend_from_slice(&chunk);
        }
        Ok(buf)
    }).await.map_err(|e| format!("任务错误: {}", e))?
}

/// 关闭会话
#[tauri::command]
async fn adb_shell_close(
    state: tauri::State<'_, AdbPtyState>,
    session_id: String,
) -> Result<(), String> {
    let sessions = state.sessions.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let session = { let mut s = sessions.lock().unwrap_or_else(|e| e.into_inner()); s.remove(&session_id) };
        if let Some(session) = session {
            session.dead.store(true, std::sync::atomic::Ordering::Relaxed);
            if let Ok(mut child) = session.child.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        Ok(())
    }).await.map_err(|e| format!("任务错误: {}", e))?
}

/// 通知 PTY 改变尺寸，使后端 shell 布局与前端 xterm 实际大小一致。
/// 根因修复：后端此前固定 40 行 x 120 列，前端容器尺寸不同且从未同步，
/// 导致 busybox 按 40x120 计算的光标寻址/多列布局在前端渲染错位。
#[tauri::command]
async fn adb_shell_resize(
    state: tauri::State<'_, AdbPtyState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let session = { let s = sessions.lock().unwrap_or_else(|e| e.into_inner()); s.get(&session_id).cloned() };
        let session = session.ok_or_else(|| "会话不存在".to_string())?;
        if cols == 0 || rows == 0 {
            return Err("尺寸必须大于 0".to_string());
        }
        // portable-pty 的 MasterPty::resize(&self) 接受 PtySize
        let mut master = session._master.lock().map_err(|e| format!("锁失败: {}", e))?;
        if let Some(m) = master.as_mut() {
            m.resize(portable_pty::PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
                .map_err(|e| format!("resize 失败: {}", e))?;
            println!("[ADB-PTY] resized -> {}x{}", cols, rows);
        }
        Ok(())
    }).await.map_err(|e| format!("任务错误: {}", e))?
}


/// ===== ADB 调试命令 =====

/// 查找 adb 可执行文件路径。
/// 优先项目内 platform-tools\adb.exe（安装包分发到 {app}\platform-tools），
/// 其次检查系统 PATH 中是否存在 adb.exe；都找不到返回 None。
fn find_adb() -> Option<String> {
    // 1) 应用安装目录下的 platform-tools\adb.exe
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("platform-tools").join("adb.exe");
            if candidate.exists() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }
    // 2) 从可执行文件目录向上回溯到项目根，逐级检查 platform-tools\adb.exe（dev 场景兜底）
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(|d| d.to_path_buf());
        while let Some(cur) = dir {
            let cand = cur.join("platform-tools").join("adb.exe");
            if cand.exists() {
                return Some(cand.to_string_lossy().to_string());
            }
            dir = cur.parent().map(|d| d.to_path_buf());
        }
    }
    // 3) 遍历 PATH 找 adb.exe，存在才返回
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let cand = dir.join("adb.exe");
            if cand.exists() {
                return Some(cand.to_string_lossy().to_string());
            }
        }
    }
    // 4) 都找不到，返回 None
    None
}

/// 检查 adb 工具状态（是否存在、版本）
#[tauri::command]
async fn adb_tool_status() -> Result<serde_json::Value, String> {
    let adb = find_adb().ok_or_else(|| "未找到 adb 可执行文件".to_string())?;
    let mut cmd = hidden_command(&adb);
    cmd.args(["version"]);
    let output = run_output_timeout(&mut cmd, 5000);
    let (found, version) = match output {
        Some(out) if out.status.success() => {
            let text = String::from_utf8_lossy(&out.stdout).to_string();
            let first = text.lines().next().unwrap_or("").trim().to_string();
            (true, first)
        }
        _ => (false, String::new()),
    };
    Ok(serde_json::json!({ "found": found, "version": version, "path": adb }))
}

/// 获取 adb 设备列表（adb devices -l），返回序列号 + 状态 + 型号
#[tauri::command]
async fn adb_devices() -> Result<Vec<serde_json::Value>, String> {
    let adb = find_adb().ok_or_else(|| "未找到 adb 可执行文件".to_string())?;
    let mut cmd = hidden_command(&adb);
    cmd.args(["devices", "-l"]);
    let output = run_output_timeout(&mut cmd, 5000);
    let out = match output {
        Some(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        Some(o) => String::from_utf8_lossy(&o.stderr).to_string(),
        None => return Err("adb devices 执行超时".to_string()),
    };
    let mut devices: Vec<serde_json::Value> = Vec::new();
    for line in out.lines().skip(1) {
        let line = line.trim();
        if line.is_empty() { continue; }
        // 解析 "serial state product:... model:... device:..."
        let mut tokens = line.split_whitespace();
        let serial = tokens.next().unwrap_or("").to_string();
        let state = tokens.next().unwrap_or("").to_string();
        if serial.is_empty() || state.is_empty() { continue; }
        let mut model = String::new();
        let mut product = String::new();
        for t in tokens {
            if let Some(v) = t.strip_prefix("model:") { model = v.to_string(); }
            else if let Some(v) = t.strip_prefix("product:") { product = v.to_string(); }
        }
        devices.push(serde_json::json!({
            "serial": serial,
            "state": state,
            "model": model,
            "product": product,
        }));
    }
    Ok(devices)
}

/// 对指定设备执行 adb shell 命令，返回输出
#[tauri::command]
async fn adb_shell(serial: String, cmd: String) -> Result<String, String> {
    let adb = find_adb().ok_or_else(|| "未找到 adb 可执行文件".to_string())?;
    let mut cmd_line = hidden_command(&adb);
    cmd_line
        .arg("-s")
        .arg(&serial)
        .arg("shell")
        .arg(&cmd);
    let output = run_output_timeout(&mut cmd_line, 10000);
    match output {
        Some(o) if o.status.success() => Ok(String::from_utf8_lossy(&o.stdout).to_string()),
        Some(o) => Err(String::from_utf8_lossy(&o.stderr).to_string()),
        None => Err("adb shell 执行超时".to_string()),
    }
}

/// 对指定设备执行 adb 命令（非 shell，用于 push/pull/logcat 等），返回输出
#[tauri::command]
async fn adb_exec(serial: Option<String>, cmd: String, args: Vec<String>) -> Result<String, String> {
    let adb = find_adb().ok_or_else(|| "未找到 adb 可执行文件".to_string())?;
    let mut cmd_line = hidden_command(&adb);
    if let Some(s) = serial {
        if !s.is_empty() { cmd_line.arg("-s").arg(&s); }
    }
    cmd_line.arg(&cmd);
    for a in &args { cmd_line.arg(a); }
    let output = run_output_timeout(&mut cmd_line, 15000);
    match output {
        Some(o) if o.status.success() => Ok(String::from_utf8_lossy(&o.stdout).to_string()),
        Some(o) => Err(String::from_utf8_lossy(&o.stderr).to_string()),
        None => Err("adb 命令执行超时".to_string()),
    }
}


/// DWM 标题栏颜色是否支持（缓存，避免在不支持的系统上反复失败）
static DWM_CAPTION_COLOR_SUPPORTED: std::sync::atomic::AtomicI8 = std::sync::atomic::AtomicI8::new(0); // 0=未知, 1=支持, -1=不支持

/// 设置标题栏颜色 (R, G, B)
#[tauri::command]
fn set_title_bar_color(window: tauri::Window, r: u8, g: u8, b: u8) -> Result<(), String> {
    dbg_log(&format!("set_title_bar_color: r={} g={} b={}", r, g, b));
    #[cfg(windows)]
    {
        // 已知不支持，直接跳过
        if DWM_CAPTION_COLOR_SUPPORTED.load(std::sync::atomic::Ordering::Relaxed) == -1 {
            return Ok(());
        }

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
                // 标记为不支持，后续调用直接跳过
                DWM_CAPTION_COLOR_SUPPORTED.store(-1, std::sync::atomic::Ordering::Relaxed);
                dbg_log("DWMWA_CAPTION_COLOR 不支持，已禁用后续调用");
                return Ok(());
            } else {
                DWM_CAPTION_COLOR_SUPPORTED.store(1, std::sync::atomic::Ordering::Relaxed);
            }
        }
    }
    Ok(())
}

/// 后台线程停止标志
static DEVICE_WATCHER_STOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static WSL_WATCHER_STOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn main() {
    // 初始化错误上报通道
    init_error_reporter();

    // 设置 panic hook，捕获 panic 并上报（Debug/Release 均生效）
    set_panic_hook();

    // Sentry 初始化仅在 Release 模式且启用 sentry feature
    #[cfg(feature = "sentry")]
    let _sentry_guard = if cfg!(not(debug_assertions)) {
        let dsn = std::env::var("SENTRY_DSN").unwrap_or_default();
        if !dsn.is_empty() {
            Some(sentry::init((
                dsn.as_str(),
                sentry::ClientOptions {
                    release: sentry::release_name!(),
                    environment: Some("production".into()),
                    ..Default::default()
                },
            )))
        } else {
            None
        }
    } else {
        None
    };

/* ===== 蓝牙(BLE) 调试 - 后端（btleplug） ===== */
use btleplug::api::{Central, Peripheral as PeripheralTrait, ScanFilter, CharPropFlags, WriteType, Manager as ManagerTrait};
use btleplug::api::{Service as BtService, Characteristic as BtChar, PeripheralProperties};
use btleplug::platform::{Adapter as BtAdapter, Manager as BleManager, Peripheral as BtPeripheral};

struct BleState {
    adapter: Mutex<Option<BtAdapter>>,
    scanning: std::sync::atomic::AtomicBool,
    connected: Mutex<Option<BtPeripheral>>,
    services: Mutex<Vec<BtService>>,
    notify_buf: std::sync::Arc<Mutex<std::collections::VecDeque<serde_json::Value>>>,
    notify_spawned: std::sync::atomic::AtomicBool,
}

fn ble_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join(" ")
}
fn ble_addr_type(at: &Option<btleplug::api::AddressType>) -> &'static str {
    match at {
        Some(btleplug::api::AddressType::Public) => "Public",
        Some(btleplug::api::AddressType::Random) => "Random",
        None => "",
    }
}
// 构造一个 BLE AD section：[len][type][payload]
fn ble_adv_section(ad_type: u8, payload: &[u8]) -> Vec<u8> {
    let mut v = vec![(payload.len() as u8) + 1, ad_type];
    v.extend_from_slice(payload);
    v
}
// 从已解析字段重组标准广播字节（btleplug 不暴露原始 AD bytes，此为按 AD 规范重组）
fn ble_encode_adv(p: &PeripheralProperties) -> String {
    let mut bytes: Vec<u8> = Vec::new();
    bytes.extend_from_slice(&ble_adv_section(0x01, &[0x06])); // Flags
    if let Some(name) = &p.local_name {
        let nb = name.as_bytes();
        if nb.len() <= 29 && nb.iter().all(|b| *b < 0x80) {
            bytes.extend_from_slice(&ble_adv_section(0x09, nb)); // Complete Local Name
        }
    }
    let mut svc16: Vec<u8> = Vec::new();
    for u in &p.services {
        let v = u.as_u128();
        if v <= 0xFFFF {
            svc16.push((v & 0xFF) as u8);
            svc16.push(((v >> 8) & 0xFF) as u8);
        }
    }
    if !svc16.is_empty() {
        bytes.extend_from_slice(&ble_adv_section(0x03, &svc16)); // 16-bit services
    }
    if let Some(tx) = p.tx_power_level {
        bytes.extend_from_slice(&ble_adv_section(0x0A, &[tx as u8])); // Tx Power
    }
    if let Some(app) = p.appearance {
        bytes.extend_from_slice(&ble_adv_section(0x19, &app.to_le_bytes())); // Appearance
    }
    for (id, data) in &p.manufacturer_data {
        let mut payload = id.to_le_bytes().to_vec();
        payload.extend_from_slice(data);
        bytes.extend_from_slice(&ble_adv_section(0xFF, &payload)); // Manufacturer Data
    }
    for (u, data) in &p.service_data {
        let v = u.as_u128();
        let mut payload = Vec::new();
        if v <= 0xFFFF {
            payload.push((v & 0xFF) as u8);
            payload.push(((v >> 8) & 0xFF) as u8);
            bytes.extend_from_slice(&ble_adv_section(0x16, &payload));
        } else {
            payload.extend(u.as_bytes().iter().rev()); // 128-bit uuid LE
            payload.extend_from_slice(data);
            bytes.extend_from_slice(&ble_adv_section(0x18, &payload));
        }
    }
    ble_hex(&bytes)
}
fn ble_props_json(p: &PeripheralProperties) -> serde_json::Value {
    json!({
        "address": p.address.to_string(),
        "address_type": ble_addr_type(&p.address_type),
        "local_name": p.local_name,
        "advertisement_name": p.advertisement_name,
        "rssi": p.rssi,
        "tx_power_level": p.tx_power_level,
        "appearance": p.appearance,
        "manufacturer_data": p.manufacturer_data.iter().map(|(id, v)| json!({"id": id, "hex": ble_hex(v)})).collect::<Vec<_>>(),
        "service_data": p.service_data.iter().map(|(u, v)| json!({"uuid": u.to_string(), "hex": ble_hex(v)})).collect::<Vec<_>>(),
        "services": p.services.iter().map(|u| u.to_string()).collect::<Vec<_>>(),
        "adv_raw": ble_encode_adv(p),
    })
}
fn ble_char_props(p: CharPropFlags) -> Vec<&'static str> {
    let mut v = Vec::new();
    if p.contains(CharPropFlags::READ) { v.push("read"); }
    if p.contains(CharPropFlags::WRITE) { v.push("write"); }
    if p.contains(CharPropFlags::WRITE_WITHOUT_RESPONSE) { v.push("write_without_response"); }
    if p.contains(CharPropFlags::NOTIFY) { v.push("notify"); }
    if p.contains(CharPropFlags::INDICATE) { v.push("indicate"); }
    if p.contains(CharPropFlags::BROADCAST) { v.push("broadcast"); }
    v
}
fn ble_char_json(c: &BtChar) -> serde_json::Value {
    json!({
        "uuid": c.uuid.to_string(),
        "service_uuid": c.service_uuid.to_string(),
        "properties": ble_char_props(c.properties),
        "descriptors": c.descriptors.iter().map(|d| json!({"uuid": d.uuid.to_string()})).collect::<Vec<_>>(),
    })
}
fn ble_service_json(s: &BtService) -> serde_json::Value {
    json!({
        "uuid": s.uuid.to_string(),
        "primary": s.primary,
        "characteristics": s.characteristics.iter().map(ble_char_json).collect::<Vec<_>>(),
    })
}
fn ble_find_char(services: &[BtService], uuid: &str) -> Option<BtChar> {
    for s in services {
        if let Some(c) = s.characteristics.iter().find(|c| c.uuid.to_string() == uuid) {
            return Some(c.clone());
        }
    }
    None
}
async fn ble_notify_loop(peripheral: BtPeripheral, buf: std::sync::Arc<Mutex<std::collections::VecDeque<serde_json::Value>>>) {
    use futures::StreamExt;
    if let Ok(mut stream) = peripheral.notifications().await {
        while let Some(n) = stream.next().await {
            let item = json!({
                "uuid": n.uuid.to_string(),
                "service_uuid": n.service_uuid.to_string(),
                "value_hex": ble_hex(&n.value),
            });
            if let Ok(mut b) = buf.lock() { b.push_back(item); }
        }
    }
}

#[tauri::command]
async fn ble_get_adapters() -> Result<Vec<serde_json::Value>, String> {
    let manager = BleManager::new().await.map_err(|e| format!("BLE manager: {e}"))?;
    let adapters = manager.adapters().await.map_err(|e| format!("BLE adapters: {e}"))?;
    let mut out = Vec::new();
    for a in &adapters {
        let info = a.adapter_info().await.unwrap_or_default();
        out.push(json!({"info": info}));
    }
    Ok(out)
}

#[tauri::command]
async fn ble_start_scan(state: tauri::State<'_, BleState>) -> Result<(), String> {
    let manager = BleManager::new().await.map_err(|e| format!("BLE manager: {e}"))?;
    let adapters = manager.adapters().await.map_err(|e| format!("BLE adapters: {e}"))?;
    let adapter = adapters.into_iter().next().ok_or("未找到蓝牙适配器")?;
    adapter.start_scan(ScanFilter::default()).await.map_err(|e| format!("start_scan: {e}"))?;
    *state.adapter.lock().unwrap() = Some(adapter);
    state.scanning.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
async fn ble_stop_scan(state: tauri::State<'_, BleState>) -> Result<(), String> {
    let adapter = state.adapter.lock().unwrap().clone();
    if let Some(a) = adapter {
        let _ = a.stop_scan().await;
    }
    state.scanning.store(false, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
async fn ble_get_devices(state: tauri::State<'_, BleState>) -> Result<Vec<serde_json::Value>, String> {
    let adapter = match state.adapter.lock().unwrap().clone() {
        Some(a) => a,
        None => return Ok(Vec::new()),
    };
    let periphs = adapter.peripherals().await.map_err(|e| format!("peripherals: {e}"))?;
    let mut out = Vec::new();
    for p in periphs {
        if let Ok(Some(props)) = p.properties().await {
            out.push(ble_props_json(&props));
        }
    }
    Ok(out)
}

#[tauri::command]
async fn ble_connect(state: tauri::State<'_, BleState>, address: String) -> Result<(), String> {
    let adapter = match state.adapter.lock().unwrap().clone() {
        Some(a) => a,
        None => return Err("请先扫描设备".to_string()),
    };
    let periphs = adapter.peripherals().await.map_err(|e| format!("peripherals: {e}"))?;
    let target = periphs.into_iter().find(|p| p.address().to_string().eq_ignore_ascii_case(&address))
        .ok_or("未找到该设备")?;
    target.connect().await.map_err(|e| format!("connect: {e}"))?;
    target.discover_services().await.map_err(|e| format!("discover: {e}"))?;
    let svcs: Vec<BtService> = target.services().iter().cloned().collect();
    *state.services.lock().unwrap() = svcs;
    *state.connected.lock().unwrap() = Some(target);
    Ok(())
}

#[tauri::command]
async fn ble_disconnect(state: tauri::State<'_, BleState>) -> Result<(), String> {
    let p = state.connected.lock().unwrap().take();
    if let Some(p) = p {
        let _ = p.disconnect().await;
    }
    state.services.lock().unwrap().clear();
    Ok(())
}

#[tauri::command]
async fn ble_get_services(state: tauri::State<'_, BleState>) -> Result<Vec<serde_json::Value>, String> {
    let svcs = state.services.lock().unwrap();
    Ok(svcs.iter().map(ble_service_json).collect())
}

#[tauri::command]
async fn ble_read(state: tauri::State<'_, BleState>, char_uuid: String) -> Result<Vec<u8>, String> {
    let p = state.connected.lock().unwrap().clone().ok_or("未连接")?;
    let c = {
        let svcs = state.services.lock().unwrap();
        ble_find_char(&svcs, &char_uuid).ok_or("未找到特征")?
    };
    p.read(&c).await.map_err(|e| format!("read: {e}"))
}

#[tauri::command]
async fn ble_write(state: tauri::State<'_, BleState>, char_uuid: String, data: Vec<u8>, write_type: Option<String>) -> Result<(), String> {
    let p = state.connected.lock().unwrap().clone().ok_or("未连接")?;
    let c = {
        let svcs = state.services.lock().unwrap();
        ble_find_char(&svcs, &char_uuid).ok_or("未找到特征")?
    };
    let wt = if write_type.as_deref() == Some("without_response") { WriteType::WithoutResponse } else { WriteType::WithResponse };
    p.write(&c, &data, wt).await.map_err(|e| format!("write: {e}"))
}

#[tauri::command]
async fn ble_subscribe(state: tauri::State<'_, BleState>, char_uuid: String) -> Result<(), String> {
    let p = state.connected.lock().unwrap().clone().ok_or("未连接")?;
    let c = {
        let svcs = state.services.lock().unwrap();
        ble_find_char(&svcs, &char_uuid).ok_or("未找到特征")?
    };
    p.subscribe(&c).await.map_err(|e| format!("subscribe: {e}"))?;
    if !state.notify_spawned.swap(true, std::sync::atomic::Ordering::Relaxed) {
        let buf = state.notify_buf.clone();
        tauri::async_runtime::spawn(async move {
            ble_notify_loop(p.clone(), buf).await;
        });
    }
    Ok(())
}

#[tauri::command]
async fn ble_unsubscribe(state: tauri::State<'_, BleState>, char_uuid: String) -> Result<(), String> {
    let p = state.connected.lock().unwrap().clone().ok_or("未连接")?;
    let c = {
        let svcs = state.services.lock().unwrap();
        ble_find_char(&svcs, &char_uuid).ok_or("未找到特征")?
    };
    p.unsubscribe(&c).await.map_err(|e| format!("unsubscribe: {e}"))
}

#[tauri::command]
async fn ble_poll_notifications(state: tauri::State<'_, BleState>) -> Result<Vec<serde_json::Value>, String> {
    let mut b = state.notify_buf.lock().unwrap();
    Ok(b.drain(..).collect())
}

    tauri::Builder::default()
        .manage(PortState {
            readers: RwLock::new(HashMap::new()),
        })
        .manage(WslSerialState {
            sessions: std::sync::Arc::new(Mutex::new(HashMap::new())),
        })
        .manage(AdbPtyState {
            sessions: std::sync::Arc::new(Mutex::new(HashMap::new())),
        })
        .manage(WorkflowState {
            rules: Mutex::new(HashMap::new()),
            log_dirs: Mutex::new(HashMap::new()),
            regex_cache: std::sync::Arc::new(RegexCache::new()),
        })
        .manage(LogCacheState {
            sessions: std::sync::Mutex::new(HashMap::new()),
        })
        .manage(BleState {
            adapter: Mutex::new(None),
            scanning: std::sync::atomic::AtomicBool::new(false),
            connected: Mutex::new(None),
            services: Mutex::new(Vec::new()),
            notify_buf: std::sync::Arc::new(Mutex::new(std::collections::VecDeque::new())),
            notify_spawned: std::sync::atomic::AtomicBool::new(false),
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
            start_log_cache,
            append_log_cache,
            end_log_cache,
            list_log_cache,
            attach_port_to_wsl,
            detach_port_from_wsl,
            check_wsl_status,
            launch_wsl,
            shutdown_wsl,
            get_wsl_distributions,
            save_config,
            load_config,
            backup_config,
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
            report_js_error,
            adb_tool_status,
            adb_devices,
            adb_shell,
            adb_exec,
            adb_open_shell,
            adb_shell_write,
            adb_shell_read,
            adb_shell_close,
            adb_shell_resize,
            ble_get_adapters,
            ble_start_scan,
            ble_stop_scan,
            ble_get_devices,
            ble_connect,
            ble_disconnect,
            ble_get_services,
            ble_read,
            ble_write,
            ble_subscribe,
            ble_unsubscribe,
            ble_poll_notifications,
            #[cfg(debug_assertions)]
            test_error_report,
        ])
        .setup(|app| {
            #[cfg(windows)]
            {
                start_device_watcher(app.handle().clone());
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_min_size(Some(tauri::LogicalSize::new(1047.0, 650.0)));
                }
            }
            start_wsl_watcher(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                dbg_log("CloseRequested: cleaning up resources");
                // 通知前端保存配置
                let _ = window.emit("save-before-exit", ());
                std::thread::sleep(std::time::Duration::from_millis(200));

                // 停止后台线程
                DEVICE_WATCHER_STOP.store(true, std::sync::atomic::Ordering::Relaxed);
                WSL_WATCHER_STOP.store(true, std::sync::atomic::Ordering::Relaxed);

                // 关闭所有串口
                if let Some(state) = window.try_state::<PortState>() {
                    let mut map = state.readers.write().unwrap_or_else(|e| e.into_inner());
                    for (_, reader) in map.drain() {
                        drop(reader);
                    }
                }

                // 关闭所有 WSL 串口会话并杀掉子进程
                if let Some(state) = window.try_state::<WslSerialState>() {
                    let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
                    for (_, session) in sessions.drain() {
                        let _ = { use std::io::Write; if let Ok(mut w) = session.writer.lock() { let _ = w.write_all(b"{\"cmd\":\"close\"}\n"); let _ = w.flush(); } };
                        kill_wsl_session(&session);
                    }
                }

                // 杀掉 WSL shell 进程
                {
                    let mut shell = WSL_SHELL.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(s) = shell.take() {
                        let mut c = s.child.lock().unwrap_or_else(|e| e.into_inner());
                        let _ = c.kill();
                        let _ = c.wait();
                    }
                }

                dbg_log("CloseRequested: cleanup done");
            }
        })
        .run(tauri::generate_context!())
        .expect("启动应用失败");
}
