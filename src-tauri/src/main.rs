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

/// MCP 服务器（进程内、只用 SSE）。设计见 doc/MCP_DESIGN.md；
/// 放在独立目录而不是继续堆进本文件：本文件已经 7000+ 行。
mod mcp;

use std::sync::atomic::{AtomicI64, Ordering};

/// 调试日志单文件上限：超过即轮转到 `.1`（旧的 `.1` 会被覆盖）
const DEBUG_LOG_MAX_BYTES: u64 = 4 * 1024 * 1024;
/// 调试日志开关（`SEAHI_DEBUG_LOG=0/false/off` 时整体关闭），只读一次环境变量
static DEBUG_LOG_ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
/// 当前文件已写字节数；-1 表示未知（下次写入前先 stat 一次，避免每次都做系统调用）
static DEBUG_LOG_BYTES: AtomicI64 = AtomicI64::new(-1);
/// 串行化"检查-轮转-写"，避免并发轮转互相踩（本来就有文件 I/O，加锁开销可忽略）
static DEBUG_LOG_LOCK: Mutex<()> = Mutex::new(());

fn debug_log_enabled() -> bool {
    *DEBUG_LOG_ENABLED.get_or_init(|| {
        !matches!(
            std::env::var("SEAHI_DEBUG_LOG").ok().as_deref(),
            Some("0") | Some("false") | Some("off") | Some("OFF")
        )
    })
}

/// 是否需要轮转（纯函数，便于单测）。
/// `current_size > 0` 这一条是为了避免对空文件/不存在的文件做无意义的 rename。
fn debug_log_needs_rotate(current_size: u64, line_len: u64, max_bytes: u64) -> bool {
    current_size > 0 && current_size + line_len > max_bytes
}

/// 轮转：先删掉旧的 `.1`，再把当前文件改名为 `.1`
fn debug_log_rotate(path: &std::path::Path) -> std::io::Result<()> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "seahi-serial-debug.log".to_string());
    let backup = path.with_file_name(format!("{}.1", name));
    let _ = std::fs::remove_file(&backup); // 不存在则忽略
    std::fs::rename(path, &backup)
}

fn dbg_log(msg: &str) {
    // 旁路进 MCP 日志中心：**与文件开关无关**（用户可能关掉文件日志但仍要在 MCP 里看）。
    // 关闭时只是一次原子读；拿不到通道锁就丢一条并计数，绝不阻塞调用方（可能是串口读线程）。
    crate::mcp::loghub::hub().push(
        "app",
        crate::mcp::loghub::LEVEL_INFO,
        crate::mcp::loghub::DIR_NONE,
        msg,
        0,
    );
    if !debug_log_enabled() {
        return;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let line = format!("[{}ms] {}\n", now, msg);
    let path = std::env::temp_dir().join("seahi-serial-debug.log");
    let _guard = DEBUG_LOG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // 已写字节数：未知时先用文件真实大小初始化
    let cur = match DEBUG_LOG_BYTES.load(Ordering::Relaxed) {
        n if n >= 0 => n as u64,
        _ => {
            let n = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            DEBUG_LOG_BYTES.store(n as i64, Ordering::Relaxed);
            n
        }
    };
    let base = if debug_log_needs_rotate(cur, line.len() as u64, DEBUG_LOG_MAX_BYTES) {
        let _ = debug_log_rotate(&path);
        0
    } else {
        cur
    };
    let ok = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| f.write_all(line.as_bytes()))
        .is_ok();
    // 写失败则置为未知，下次重新 stat（文件可能被外部删除/占用）
    DEBUG_LOG_BYTES.store(
        if ok { (base + line.len() as u64) as i64 } else { -1 },
        Ordering::Relaxed,
    );
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
    // 旁路进 MCP 日志中心（错误单独一个通道，便于 AI 只看错误）
    crate::mcp::loghub::hub().push(
        "error",
        crate::mcp::loghub::LEVEL_ERROR,
        crate::mcp::loghub::DIR_NONE,
        &format!("{}: {}", context, error),
        0,
    );
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

        // 先注销通知：注销后回调不会再被调用，此时才能安全回收 context。
        // （此前顺序相反：先 Box::from_raw 释放，再注销 —— 窗口内回调解引用已释放内存）
        if !notify_handle.is_null() {
            let _ = CM_Unregister_Notification(notify_handle);
        }
        // 回收 AppHandle Box，避免泄漏（此前用 Box::into_raw 换取回调内指针有效性）
        let _ = Box::from_raw(context as *mut tauri::AppHandle);
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

/* ===== 快速指令：等回话的状态机 =====
   循环发送现在是一条一条来：发一条 → 等设备的回话 → busy 继续等 / OK 发下一条 /
   ERROR 重发本条 / 等满超时终止整条链。**判定只在这里做一份**：
   - 普通串口：读线程收到数据顺手喂进来（本进程内，不复制不排队）；
   - WSL：数据只有前端拉得到（Rust 侧没有它的读线程）→ 前端把拉到的块喂给 `qcmd_hs_feed`。
   前端只负责"发、等、按结论决定下一步"，不在 JS 里另写一套匹配（两套必然漂移）。 */

/// 一条指令的等待状态。`Idle` = 没在等（也用于"被停掉了"）
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum HsState { Idle, Waiting, Ok, Err, Timeout }

impl HsState {
    fn as_str(self) -> &'static str {
        match self {
            HsState::Idle => "idle",
            HsState::Waiting => "waiting",
            HsState::Ok => "ok",
            HsState::Err => "err",
            HsState::Timeout => "timeout",
        }
    }
}

const HS_BUF_CAP: usize = 8192;      // 累积缓冲上限（没有换行的长数据不许把内存撑爆）
const HS_LAST_LINES: usize = 8;      // 排障用：留最近几行回应，供 MCP/界面查看
const HS_MAX_EXPECT: usize = 8;      // 自定义成功词最多几个
const HS_MAX_EXPECT_LEN: usize = 64; // 单个成功词的长度上限（与前端一致）
const HS_MAX_FEED: usize = 65536;    // 一次喂进来的数据上限（前端 WSL 路径传进来的）

/// 一条指令的等待状态（arm 重置；出结论后保留给前端取一次，前端下一次 arm 自然覆盖）
struct QcmdHs {
    state: HsState,
    expect: Vec<String>,
    armed_at: Option<std::time::Instant>,
    deadline: Option<std::time::Instant>,
    buf: Vec<u8>,          // 跨块的行拼装：`OK` 被切成两块也认得出
    busy: bool,            // 见到过 busy（只是展示用：它**不是**结论）
    last_lines: Vec<String>,
}

impl Default for QcmdHs {
    fn default() -> Self {
        QcmdHs { state: HsState::Idle, expect: Vec::new(), armed_at: None, deadline: None,
                 buf: Vec::new(), busy: false, last_lines: Vec::new() }
    }
}

impl QcmdHs {
    /// 开始等这一条：清空上一条的残留。`timeout_ms` 下限 1（0 由前端解释成"不等回话"，不会走到这里）
    fn arm(&mut self, expect: Vec<String>, timeout_ms: u64) {
        let now = std::time::Instant::now();
        self.state = HsState::Waiting;
        self.expect = expect.into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .take(HS_MAX_EXPECT)
            .collect();
        self.armed_at = Some(now);
        self.deadline = Some(now + std::time::Duration::from_millis(timeout_ms.max(1)));
        self.buf.clear();
        self.busy = false;
        self.last_lines.clear();
    }

    fn stop(&mut self) {
        self.state = HsState::Idle;
        self.armed_at = None;
        self.deadline = None;
        self.buf.clear();
        self.busy = false;
    }

    /// 结算：到点了还没结论就是超时。由前端轮询 state 时顺带调用 —— 不另起定时器，
    /// 也就没有"定时器忘了清"这种悬挂状态。
    fn poll(&mut self) -> HsState {
        if self.state == HsState::Waiting {
            if let Some(dl) = self.deadline {
                if std::time::Instant::now() >= dl {
                    self.state = HsState::Timeout;
                    self.deadline = None;
                }
            }
        }
        self.state
    }

    /// 喂一块新数据：按行切，逐行判定。跨块的行靠 `buf` 拼起来（这是最容易做错的一处：
    /// 设备回 `OK\r\n` 完全可能被拆成 `O` + `K\r\n` 两次读上来）
    fn feed(&mut self, data: &[u8]) {
        if self.state != HsState::Waiting { return; }
        self.buf.extend_from_slice(data);
        if self.buf.len() > HS_BUF_CAP {
            let drop = self.buf.len() - HS_BUF_CAP;
            self.buf.drain(..drop);
        }
        loop {
            let pos = self.buf.iter().position(|&b| b == b'\n' || b == b'\r');
            let Some(pos) = pos else { break };
            let line: Vec<u8> = self.buf.drain(..pos).collect();
            // ⚠️ **每轮必须至少吃掉一个字节**：行尾那个 `\r`/`\n` 无条件拿走，再看后面还有没有 `\n`。
            // 早先写成"只在 next 是 `\n` 时才 remove(0)"，于是遇到 buf 以孤立 `\r` 开头时
            // `drain(..0)` 什么也没吃掉 → 原地打转、CPU 打满（跨块拆开时极常见：上一块以 `\r` 收尾、
            // 下一块从 `\n` 开始；2026-09 写完单测当场实测到，测试进程把一整个核跑满）
            self.buf.remove(0);
            if self.buf.first() == Some(&b'\n') { self.buf.remove(0); }   // `\r\n` 的第二个字节
            if self.judge(&line) { break; }                                // 有结论了，剩下的不再看
        }
    }

    /// 单行判定。顺序是有讲究的：busy 只是"还在处理"，**绝不能**当成结论；
    /// ERROR 要排在 OK 前面（`+CME ERROR` 这类行里同时出现别的东西时不能判成成功）。
    fn judge(&mut self, line: &[u8]) -> bool {
        let text = String::from_utf8_lossy(line).trim().to_string();
        if text.is_empty() { return false; }
        if self.last_lines.len() >= HS_LAST_LINES { self.last_lines.remove(0); }
        self.last_lines.push(text.clone());
        let lower = text.to_lowercase();
        if lower.contains("busy") { self.busy = true; return false; }
        if lower.contains("error") { self.state = HsState::Err; self.deadline = None; return true; }
        // 内置成功词：整行 `OK`，以及 `SEND OK` / `CONNECT OK` 这类以 " OK" 收尾的行
        if lower == "ok" || lower.ends_with(" ok") { self.state = HsState::Ok; self.deadline = None; return true; }
        for w in &self.expect {
            if lower == w.to_lowercase() { self.state = HsState::Ok; self.deadline = None; return true; }
        }
        false
    }
}

/// 给某个监视器的等待状态喂数据（拿不到锁就丢这一块：判定是尽力而为，绝不阻塞读线程）
fn hs_feed(arc: &std::sync::Arc<std::sync::Mutex<QcmdHs>>, data: &[u8]) {
    if let Ok(mut hs) = arc.lock() { hs.feed(data); }
}

/// 取（或惰性创建）某个监视器的等待状态。串口与 WSL **共用这张表**：
/// 串口由读线程喂数据，WSL 由前端 `qcmd_hs_feed` 喂 —— 判定仍然是同一份代码。
fn hs_slot(map: &Mutex<HashMap<String, std::sync::Arc<std::sync::Mutex<QcmdHs>>>>, mid: &str)
    -> std::sync::Arc<std::sync::Mutex<QcmdHs>> {
    let mut m = map.lock().unwrap_or_else(|e| e.into_inner());
    m.entry(mid.to_string())
        .or_insert_with(|| std::sync::Arc::new(std::sync::Mutex::new(QcmdHs::default())))
        .clone()
}

/// 串口读取 + 工作流监控线程：后台持续读取数据，自动检查规则并执行动作
struct PortReader {
    buffer: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
    events: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    /// 因接收缓冲超上限而被丢弃的字节数（累计；前端每次 read_data 取走并清零）
    dropped: std::sync::Arc<std::sync::atomic::AtomicU64>,
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
    /// `hs` 由读线程 clone 走（收到数据时喂进去）；PortReader 自己不留字段 ——
    /// 那份状态的生命周期归 `PortState::qcmd_hs` 那张表（WSL 也要用它，见 `hs_slot`）。
    fn new(port: Box<dyn SerialPort>, regex_cache: std::sync::Arc<RegexCache>,
           hs: std::sync::Arc<std::sync::Mutex<QcmdHs>>) -> Self {
        let buffer = std::sync::Arc::new(std::sync::Mutex::new(Vec::with_capacity(8192)));
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let dropped = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let disconnected = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let disconnect_reported = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let rules = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log_dir = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let line_ending = std::sync::Arc::new(std::sync::Mutex::new(String::from("crlf")));
        let match_tail = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let buf_clone = buffer.clone();
        let evt_clone = events.clone();
        let dropped_clone = dropped.clone();
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
        let hs_for_read = hs.clone();
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
                            // 上限保护：监视器隐藏、或前端读取不及时时，设备持续吐数据不会把内存吃满。
                            // 超限丢弃最旧数据并记账 —— 前端下次 read_data 会看到 dropped 增量并提示一行，
                            // 否则用户会以为"日志就是这些"，看不出中间被丢过。
                            if buf.len() > 262144 {
                                let drain = buf.len() - 131072;
                                buf.drain(..drain);
                                let prev = dropped_clone.fetch_add(drain as u64, std::sync::atomic::Ordering::Relaxed);
                                if prev == 0 {
                                    dbg_log(&format!("serial reader: 接收缓冲超限，开始丢弃最旧数据（本次 {} 字节）", drain));
                                }
                            }
                        }
                        let _ = tx_clone.try_send(tmp[..n].to_vec()).is_ok();
                        // 快速指令的"等回话"：判定在 Rust，读线程把同一块数据顺手喂进去。
                        // 锁只在此刻短暂持有（判定就是几行字符串比较），拿不到就丢这一块 ——
                        // 绝不为了等回话把读取线程堵住（串口收发热路径优先）。
                        hs_feed(&hs_for_read, &tmp[..n]);
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
            buffer, events, dropped, read_handle: Some(read_handle), wf_handle: Some(wf_handle),
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

    /// 取走并清零「因缓冲超限被丢弃的字节数」：前端每次读数据时会拿到这个增量并提示用户
    fn take_dropped(&self) -> u64 {
        self.dropped.swap(0, std::sync::atomic::Ordering::Relaxed)
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
    /// 快速指令的"等回话"状态机（key = monitor_id）。
    /// ⚠️ 放在这里而不是 PortReader 里：**WSL 监视器在 Rust 侧根本没有 reader**，
    /// 而它的判定同样要走这一份代码（前端 `qcmd_hs_feed` 喂数据），所以两边共用这张表。
    qcmd_hs: Mutex<HashMap<String, std::sync::Arc<std::sync::Mutex<QcmdHs>>>>,
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
    // ⚠️ 前端（与 config.json 里存着的）用的名字是**驼峰 `delayBefore`**；早先这里只认
    // snake_case，serde 于是落到 `default` = 0 —— 面板上填的「延时(ms)」**从来没生效过**
    // （静默失效，2026-09 查工作流时发现）。两个名字都认：驼峰是既有数据，snake_case 是结构体自己的。
    #[serde(default, alias = "delayBefore")]
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
                    // 与 send_data 保持一致：锁带超时。此前用无限期 lock()，
                    // 一旦设备不排空导致 write_all 阻塞，该串口就被永久占住，
                    // 读线程再也拿不到锁 → 该串口停止接收、后续写命令全部超时（假死）。
                    match lock_port_with_timeout(&port_clone, 500) {
                        Ok(mut p) => match p.write_all(&bytes) {
                            Ok(()) => { let _ = p.flush(); }
                            Err(e) => {
                                eprintln!("[Workflow] 写入串口失败: {}", e);
                                sent_parts.pop();
                            }
                        },
                        Err(e) => {
                            eprintln!("[Workflow] 取串口锁失败: {}", e);
                            sent_parts.pop();
                        }
                    }
                }
                "toggle_dtr_rts" => {
                    // 同上传送动作：锁带超时，避免占死串口
                    match lock_port_with_timeout(&port_clone, 500) {
                        Ok(mut p) => {
                            let ok = match action.signal.as_str() {
                                "dtr" => p.write_data_terminal_ready(action.level).is_ok(),
                                "rts" => p.write_request_to_send(action.level).is_ok(),
                                _ => false,
                            };
                            if ok { sent_parts.push(format!("[{} {}]", action.signal.to_uppercase(), if action.level { "ON" } else { "OFF" })); }
                        }
                        Err(e) => eprintln!("[Workflow] 取串口锁失败({}): {}", action.signal, e),
                    }
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
        // 上限保护：这些事件由前端轮询取走；工作流高频触发时避免无限堆积
        const WF_EVENTS_MAX: usize = 200;
        if let Ok(mut evts) = events_clone.lock() {
            while evts.len() >= WF_EVENTS_MAX { evts.remove(0); }
            evts.push(msg.clone());
        }
        // 同一行也进日志中心（`workflow` 通道）—— 否则**只有界面看得到**规则触发过什么，
        // AI 那边 `log_tail` 里一片空白，连"规则到底跑没跑"都查不出来（2026-09 补）。
        // push 是非阻塞的（拿不到通道锁就丢一条并计数），动作线程不会被它拖住。
        crate::mcp::loghub::hub().push(
            "workflow",
            crate::mcp::loghub::LEVEL_INFO,
            crate::mcp::loghub::DIR_TX,
            &msg,
            msg.len() as u32,
        );
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

    port.set_baud_rate(baud_rate).map_err(|e| {
        // Windows 对不支持的波特率回 ERROR_INVALID_PARAMETER(87)，serialport 只给出一句中文「参数错误」，
        // 用户看不出是「这个串口不吃这个波特率」（板载 / 虚拟 COM1 上填 2000000 就会撞上）。
        let raw = e.to_string();
        if raw.contains("参数错误") || raw.contains("Incorrect parameter") || raw.contains("Invalid argument") {
            format!(
                "设置波特率失败: 这个串口不接受 {} 波特率，请换 USB 转串口设备，或把波特率降到 115200 及以下（原始错误: {}）",
                baud_rate, raw
            )
        } else {
            format!("设置波特率失败: {}", raw)
        }
    })?;

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
    let hs = hs_slot(&state.qcmd_hs, &monitor_id);    // 快速指令的等待状态：读线程与前端共用这一份
    let reader = PortReader::new(port, wf_state.regex_cache.clone(), hs);
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
    // 快速指令的"等回话"状态：断开就别留着（下一次 arm 会重建一份干净的）
    {
        let mut hsmap = state.qcmd_hs.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(hs) = hsmap.remove(&monitor_id) {
            if let Ok(mut g) = hs.lock() { g.stop(); }
        }
    }
    Ok(())
}

/* ===== 快速指令：等回话的四个命令 =====
   前端循环发送的节奏是：arm → send → 轮询 state → 按结论走下一步。
   ⚠️ **arm 必须排在 send 之前**：反过来的话，设备的回话可能赶在 arm 之前到达，
   被当成"上一条的迟到数据"丢掉 —— 那这一条就必然白等到超时。 */

/// 开始等一条指令的回话。`expect` 是自定义成功词（`|` 分隔，与文件里的「期望」列同一套写法）
#[tauri::command]
fn qcmd_hs_arm(
    state: tauri::State<'_, PortState>,
    monitor_id: String,
    expect: String,
    timeout_ms: u64,
) -> Result<serde_json::Value, String> {
    if expect.len() > HS_MAX_EXPECT * HS_MAX_EXPECT_LEN {
        return Err(format!("期望词太长（上限 {} 字符）", HS_MAX_EXPECT * HS_MAX_EXPECT_LEN));
    }
    let timeout_ms = timeout_ms.min(600_000);        // 与面板的上限一致
    let hs = hs_slot(&state.qcmd_hs, &monitor_id);
    let list: Vec<String> = expect.split('|').map(|s| s.to_string()).collect();
    let mut g = hs.lock().map_err(|_| "等待状态锁不可用".to_string())?;
    g.arm(list, timeout_ms);
    Ok(serde_json::json!({ "armed": true, "timeoutMs": timeout_ms }))
}

/// 问一句"这条有结论了吗"。**超时也在这里结算** —— 不另起定时器，也就没有悬挂状态。
#[tauri::command]
fn qcmd_hs_state(state: tauri::State<'_, PortState>, monitor_id: String) -> serde_json::Value {
    let hs = hs_slot(&state.qcmd_hs, &monitor_id);
    let mut g = hs.lock().unwrap_or_else(|e| e.into_inner());
    let st = g.poll();
    let elapsed = g.armed_at.map(|t| t.elapsed().as_millis() as u64).unwrap_or(0);
    serde_json::json!({
        "state": st.as_str(),
        "busy": g.busy,
        "elapsedMs": elapsed,
        "lastLines": g.last_lines.clone(),
    })
}

/// 喂一块收到的数据（**WSL 路径用**：数据只有前端拉得到，而判定要留在 Rust 这一份）。
/// 串口路径**不走这里** —— 它的读线程直接喂，免得同一块数据被喂两遍、把一个 OK 算成两次。
#[tauri::command]
fn qcmd_hs_feed(state: tauri::State<'_, PortState>, monitor_id: String, data: Vec<u8>) -> Result<(), String> {
    if data.len() > HS_MAX_FEED {
        return Err(format!("一次喂进来的数据太多（上限 {} 字节）", HS_MAX_FEED));
    }
    let hs = hs_slot(&state.qcmd_hs, &monitor_id);
    hs_feed(&hs, &data);
    Ok(())
}

/// 停掉等待（用户关循环 / 断开连接时清干净，不留"还在等"的悬挂状态）
#[tauri::command]
fn qcmd_hs_stop(state: tauri::State<'_, PortState>, monitor_id: String) {
    let hs = hs_slot(&state.qcmd_hs, &monitor_id);
    // 尾分号不是多余的：不写它，这一句就是尾表达式，临时 guard 会比 `hs` 晚析构（E0597）
    if let Ok(mut g) = hs.lock() { g.stop(); };
}

/// 从缓冲区读取数据（毫秒级，不阻塞）
/// read_data 的返回：字节 + 本次「因缓冲超限被丢弃」的字节数（正常恒为 0）
#[derive(serde::Serialize)]
struct ReadDataResult {
    bytes: Vec<u8>,
    dropped: u64,
}

#[tauri::command]
fn read_data(state: tauri::State<'_, PortState>, monitor_id: String) -> Result<ReadDataResult, String> {
    let map = state.readers.read().unwrap_or_else(|e| e.into_inner());
    if let Some(reader) = map.get(&monitor_id) {
        if reader.disconnected.load(std::sync::atomic::Ordering::Relaxed) {
            // 断开上报只触发一次，避免轮询期间重复上报
            if !reader.disconnect_reported.swap(true, std::sync::atomic::Ordering::Relaxed) {
                report_error("设备已断开连接", "read_data");
            }
            return Err("设备已断开连接".into());
        }
        Ok(ReadDataResult { bytes: reader.read_all(), dropped: reader.take_dropped() })
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

/// 启动 bridge 进程用的参数（纯函数，便于单测）。
///
/// 为什么要分两种：`sg`（switch group，来自 `shadow` 包）是用来把进程补上 `dialout` 附加组的
/// —— 用户在 WSL 会话**启动之后**才被加进 `dialout` 时，本次会话的组集合是旧的，直接跑
/// `python3` 会以 EACCES 打不开 `/dev/ttyACM*`，`sg` 会重新读一遍组数据库补上。
///
/// ⚠️ 但 `sg` 有**两种**会让整条链路起不来的失败，都必须绕开：
///   ① **`sg` 根本不存在**（精简镜像、Alpine 等常没装 shadow）→ WSL relay 直接
///      `execvpe(sg) failed: No such file or directory`（2026-09-16 issue #21 就是这句）；
///   ② **`sg` 在、但当前用户不在 `dialout` 里** → `sg` 会**交互式要密码**，而它的 stdin
///      正是我们写 JSON 的管道 —— 表现是"bridge 启动超时（5 秒没等到 ready）"，
///      而且提示里看不出原因（那不是错误文本，是**卡住**）。
///
/// 两种的正确处置是同一条：**别用 `sg`，直接跑 `python3`**。真的缺权限时 bridge 自己会回
/// `无权访问 /dev/xxx，请在 WSL 终端执行: sudo chmod 666 /dev/xxx` —— 那句话可操作得多。
fn bridge_wsl_args(distro: &str, use_sg: bool) -> Vec<String> {
    let script = format!("python3 {}", BRIDGE_SCRIPT_PATH);
    let mut args = vec!["-d".to_string(), distro.to_string(), "-e".to_string()];
    if use_sg {
        args.extend(
            ["sg", "dialout", "-c"]
                .iter()
                .map(|s| s.to_string())
                .chain(std::iter::once(script)),
        );
    } else {
        args.push("python3".to_string());
        args.push(BRIDGE_SCRIPT_PATH.to_string());
    }
    args
}

/// 探测结果（`None` = 拿不准/超时）→ 用不用 `sg`。**纯函数**，把这条判断钉住。
///
/// 拿不准时**不用**：用错的代价是"整条链路起不来、提示还看不出原因"，
/// 不用的代价只是"缺权限时 bridge 回一句 sudo chmod 666"——后者可操作得多。
/// 这是**故意的不对称**，别为了"保守起见沿用旧行为"改成 `true`（旧行为就是 #21）。
fn bridge_use_sg(probe: Option<bool>) -> bool {
    probe.unwrap_or(false)
}

/// 试一次：**当前用户能不能非交互地** `sg dialout`。
///
/// 为什么是"真的试一次"而不是去查 `id -nG` / `/etc/group`：
/// `sg` 的判据是**组数据库**，而"本会话的组集合过期"恰恰是 `sg` 存在的理由 ——
/// 用 `id -nG`（反映本会话）去判断，会把**正该用 `sg`** 的场景误判成"别用"，等于把
/// 这个功能废掉。直接跑 `sg dialout -c true` 是把结论建立在**真正会发生的那件事**上，
/// 一次 WSL 往返同时覆盖上文 ① ② 两种失败（外加"串口组不叫 dialout"这种发行版差异）。
///
/// 两道保险：`stdin` 设成 **null**（万一它真要密码，读不到，也不会把我们写 JSON 的管道吃掉）、
/// 带 **4 秒超时**（真卡住就杀）。超时/失败统一算"不能"。
fn wsl_sg_can_switch(distro: &str) -> Option<bool> {
    let mut cmd = hidden_command("wsl");
    cmd.args(["-d", distro, "-e", "sg", "dialout", "-c", "true"])
        .stdin(std::process::Stdio::null());
    // 注意：run_output_timeout 只接管 stdout/stderr，上面设的 stdin 会保留。
    run_output_timeout(&mut cmd, 4000).map(|o| o.status.success())
}

/// 启动 bridge 进程（使用 hidden_command 隐藏窗口；能非交互切组时才用 `sg`）
fn spawn_bridge(distro: &str) -> Result<std::process::Child, String> {
    let child = hidden_command("wsl")
        .args(bridge_wsl_args(distro, bridge_use_sg(wsl_sg_can_switch(distro))))
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

/// bridge 没就绪时的错误文案（纯函数，便于单测）。
///
/// 为什么必须把两种分开：`deploy_bridge` 成功之后，bridge 脚本**导入完就立刻**往 stderr 打一行
/// `ready`（正常在百毫秒级）。所以"5 秒没等到"其实是两类完全不同的事：
///   ① `exited = true`：进程**已经退出** —— `python3` 不在、`sg dialout` 切组失败、脚本没落地…
///      这时 stderr 的最后几行就是真正的原因，必须原样带给用户；
///   ② `exited = false`：进程还活着但没打 ready（真的卡住/极慢）—— 罕见。
/// 原先两者都只报一句"bridge 启动超时"，用户拿着这句话没有任何下手处（2026-09 真实反馈）。
fn bridge_startup_error(exited: bool, stderr_tail: &str) -> String {
    let head = if exited {
        "bridge 启动失败（进程已退出）"
    } else {
        "bridge 启动超时（5 秒内没等到 ready）"
    };
    let tail = stderr_tail.trim();
    let mut msg = if tail.is_empty() {
        head.to_string()
    } else {
        format!("{}: {}", head, tail)
    };
    if let Some(h) = bridge_stderr_hint(tail) {
        msg.push_str("【");
        msg.push_str(h);
        msg.push('】');
    }
    msg
}

/// stderr 里最常见的几种"起不来"给一句可执行的提示（纯函数）
///
/// ⚠️ **顺序有讲究**：`sg: not found` 同时含 `sg:`，所以"sg 不存在"必须排在"sg 切组失败"**前面**，
/// 否则后者会把它吞掉，用户拿到的提示就是"你不在 dialout 组里"——而真实原因是**根本没装 sg**
/// （2026-09-16 issue #21：截图里那句 `execvpe(sg) failed: No such file or directory` 一个分支都没命中，
/// 用户只能看到原始 WSL 报错）。现在 `spawn_bridge` 已经不会在缺 sg 时去调它，这一段是**兜底**
/// （探测与真正 spawn 之间可能出岔子）。
fn bridge_stderr_hint(tail: &str) -> Option<&'static str> {
    let t = tail.to_ascii_lowercase();
    if t.contains("python3: command not found") || t.contains("python3: not found") {
        Some("这个发行版里没有 python3：Debian/Ubuntu 上先 sudo apt install -y python3 python3-serial")
    } else if t.contains("can't open file") || t.contains("cannot open") {
        Some("脚本没落到 /tmp：重新连接会重新部署；也可以看 /tmp 是否可写、是否已满")
    } else if t.contains("execvpe(sg)") || t.contains("sg: not found") || t.contains("sg: command not found") {
        Some("这个发行版里没有 sg（shadow 包）：装上即可 —— Debian/Ubuntu `sudo apt install -y shadow`，\
              Alpine `apk add shadow`。装好后重连一次（本程序会自动改用它）")
    } else if t.contains("sg:") || (t.contains("dialout") && t.contains("group")) {
        Some("sg 切 dialout 组失败：有些发行版串口组叫 uucp/tty，或当前用户不在组里")
    } else {
        None
    }
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
        // 等待 bridge 就绪（最多 5 秒）：用 channel + recv_timeout 替代无超时 join，避免永久阻塞。
        // 通道里带的是"为什么没就绪"：`Err(stderr 尾部)` = 进程已退出（那就是原因），
        // 超时（recv_timeout 到期）= 进程还活着但一直没打 ready。
        let not_ready = {
            use std::sync::mpsc;
            let (tx, rx) = mpsc::channel::<Result<(), String>>();
            std::thread::spawn(move || {
                use std::io::BufRead;
                // 留着 stderr 的最后几行：进程起不来时它就是唯一的原因说明
                let mut tail: Vec<String> = Vec::new();
                for line in std::io::BufReader::new(stderr).lines() {
                    match line {
                        Ok(l) if l.trim() == "ready" => { let _ = tx.send(Ok(())); return; }
                        Ok(l) => {
                            let t = l.trim();
                            if !t.is_empty() {
                                tail.push(t.to_string());
                                if tail.len() > 5 { tail.remove(0); }
                            }
                        }
                        Err(_) => break,   // stderr 断了：按"进程已退出"处理
                    }
                }
                let _ = tx.send(Err(tail.join(" | ")));
            });
            match rx.recv_timeout(std::time::Duration::from_secs(5)) {
                Ok(Ok(())) => None,
                Ok(Err(tail)) => Some(bridge_startup_error(true, &tail)),
                Err(_) => Some(bridge_startup_error(false, "")),
            }
        };
        if let Some(msg) = not_ready {
            let _ = child.kill();
            let _ = child.wait();
            report_error(&msg, "open_wsl_serial");
            return Err(msg);
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
    let is_busid = is_valid_busid(&port_name);

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

/// busid 白名单：只接受 `数字-数字`（如 `1-4`）。
/// 这个值会被插进以**管理员权限**执行的 PowerShell 脚本（usbipd detach/attach），
/// 必须严格校验，否则 `1-1; <命令>` 就是一条提权命令执行路径。
fn is_valid_busid(s: &str) -> bool {
    let mut parts = s.splitn(2, '-');
    let a = parts.next().unwrap_or("");
    let b = parts.next().unwrap_or("");
    !a.is_empty() && a.chars().all(|c| c.is_ascii_digit())
        && !b.is_empty() && b.chars().all(|c| c.is_ascii_digit())
}

/// 通过 UAC 提权执行 usbipd detach
fn run_usbipd_detach_elevated(busid: &str) -> Option<String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static DETACH_COUNTER: AtomicU64 = AtomicU64::new(0);

    // busid 来自前端，会被直接插进下面那段**以管理员身份执行**的 PowerShell 脚本，
    // 必须严格白名单校验（busid="1-1; <任意命令>" 否则即为提权命令执行）。
    // 兄弟函数 attach_port_to_wsl_blocking 对同一语义参数有同样校验，这里此前漏了。
    if !is_valid_busid(busid) {
        #[cfg(debug_assertions)]
        dbg_log(&format!("run_usbipd_detach_elevated: busid 非法已拒绝: {busid}"));
        return None;
    }
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

// ===== 快速指令外部文件（导入 / 导出 / 写回） =====
//
// 语义：**文件就是列表的存储** —— 导入一个文件后，面板里的增删改都写回它，不再有两份真相。
// 因此三件事必须做对：
//   ① 路径只认用户在原生文件框里亲手选过的（同 save_log / BLE 从机配置的纪律：
//      capabilities 只有 core:*、没有 fs 插件，绝不让前端传任意路径来读写文件）；
//   ② 写回前比对内容哈希 —— 文件被别的编辑器改过就报冲突，绝不静默覆盖别人的改动；
//   ③ 原子写（临时文件 + rename），并沿用读入时的编码（用户的 GBK 文件不会被偷偷变成 UTF-8）。

/// 单个指令文件大小上限：读之前先看 metadata（也拦得住手抖选了个几百 MB 的日志）
const QUICK_CMD_FILE_MAX_BYTES: u64 = 256 * 1024;
/// 允许表最多记多少条路径（超出按最久未用淘汰）
const QUICK_CMD_FILE_MAX_ALLOWED: usize = 50;

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct QuickCmdFiles {
    /// 用户在原生文件框里选过的路径（读/写都只认这些）
    allowed: Vec<String>,
    /// 上次读/写后原始字节的 SHA-256（hex），用于"文件是否被外部改过"的冲突检测
    #[serde(default)]
    hashes: std::collections::HashMap<String, String>,
}

static QUICK_CMD_FILES: std::sync::OnceLock<std::sync::Mutex<QuickCmdFiles>> = std::sync::OnceLock::new();

fn quick_cmd_files_path() -> Option<std::path::PathBuf> {
    dirs_config_path().map(|d| d.join("quick-cmds-files.json"))
}

fn quick_cmd_files() -> &'static std::sync::Mutex<QuickCmdFiles> {
    QUICK_CMD_FILES.get_or_init(|| {
        let loaded = quick_cmd_files_path()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<QuickCmdFiles>(&s).ok())
            .unwrap_or_default();
        std::sync::Mutex::new(loaded)
    })
}

/// 原子落盘（临时文件 + rename）。这张表丢了顶多让用户重选一次文件，失败只记日志不报错。
fn quick_cmd_files_persist(files: &QuickCmdFiles) {
    let Some(path) = quick_cmd_files_path() else { return };
    if let Some(dir) = path.parent() { let _ = std::fs::create_dir_all(dir); }
    let Ok(text) = serde_json::to_string_pretty(files) else { return };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, text.as_bytes()).is_ok() { let _ = std::fs::rename(&tmp, &path); }
}

/// 允许表的插入逻辑（纯函数，便于无盘单测）：LRU 挪到末尾，超上限丢最旧的
fn quick_cmd_allow_push(files: &mut QuickCmdFiles, path: &str, hash: Option<String>) {
    if path.is_empty() { return; }
    if let Some(h) = hash { files.hashes.insert(path.to_string(), h); }
    if let Some(pos) = files.allowed.iter().position(|p| p == path) { files.allowed.remove(pos); }
    files.allowed.push(path.to_string());
    while files.allowed.len() > QUICK_CMD_FILE_MAX_ALLOWED {
        let old = files.allowed.remove(0);
        files.hashes.remove(&old);
    }
}

/// 记一条"用户亲手选过"的路径，并落盘
fn quick_cmd_file_remember(path: &str, hash: Option<String>) {
    if path.is_empty() { return; }
    let mut files = quick_cmd_files().lock().unwrap_or_else(|e| e.into_inner());
    quick_cmd_allow_push(&mut files, path, hash);
    quick_cmd_files_persist(&files);
}

fn quick_cmd_file_allowed(path: &str) -> bool {
    quick_cmd_files().lock().unwrap_or_else(|e| e.into_inner()).allowed.iter().any(|p| p == path)
}

/// 文本解码：UTF-8（含 BOM）优先 → 失败回退 GBK(936) → 再失败用有损 UTF-8。
/// 返回 (文本, 编码标记)；写回时按同一标记编码，不能把用户的 GBK 文件变成乱码。
fn decode_text_file(raw: &[u8]) -> (String, String) {
    if let Some(rest) = raw.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return (String::from_utf8_lossy(rest).to_string(), "utf-8-bom".to_string());
    }
    if let Ok(s) = std::str::from_utf8(raw) {
        return (s.to_string(), "utf-8".to_string());
    }
    if let Some(s) = decode_gbk(raw) {
        return (s, "gbk".to_string());
    }
    (String::from_utf8_lossy(raw).to_string(), "utf-8".to_string())
}

/// GBK(936) → Unicode。`MB_ERR_INVALID_CHARS`(8) 让非法字节直接失败，而不是变成 '?'。
#[cfg(windows)]
fn decode_gbk(raw: &[u8]) -> Option<String> {
    use windows_sys::Win32::Globalization::MultiByteToWideChar;
    const CP_GBK: u32 = 936;
    const MB_ERR_INVALID_CHARS: u32 = 8;
    if raw.is_empty() { return Some(String::new()); }
    let need = unsafe {
        MultiByteToWideChar(CP_GBK, MB_ERR_INVALID_CHARS, raw.as_ptr(), raw.len() as i32, std::ptr::null_mut(), 0)
    };
    if need <= 0 { return None; }
    let mut buf = vec![0u16; need as usize];
    let got = unsafe {
        MultiByteToWideChar(CP_GBK, MB_ERR_INVALID_CHARS, raw.as_ptr(), raw.len() as i32, buf.as_mut_ptr(), need)
    };
    if got <= 0 { return None; }
    buf.truncate(got as usize);
    Some(String::from_utf16_lossy(&buf))
}

#[cfg(not(windows))]
fn decode_gbk(_raw: &[u8]) -> Option<String> { None }

/// 按读入时的编码写回；返回 (字节, 实际用的编码)。GBK 编不出来的字符会退到 UTF-8。
fn encode_text_file(text: &str, enc: &str) -> (Vec<u8>, String) {
    if enc == "gbk" {
        if let Some(v) = encode_gbk(text) { return (v, "gbk".to_string()); }
        return (text.as_bytes().to_vec(), "utf-8".to_string());
    }
    if enc == "utf-8-bom" {
        let mut v = vec![0xEF, 0xBB, 0xBF];
        v.extend_from_slice(text.as_bytes());
        return (v, "utf-8-bom".to_string());
    }
    (text.as_bytes().to_vec(), "utf-8".to_string())
}

#[cfg(windows)]
fn encode_gbk(text: &str) -> Option<Vec<u8>> {
    use windows_sys::Win32::Globalization::WideCharToMultiByte;
    const CP_GBK: u32 = 936;
    let wide: Vec<u16> = text.encode_utf16().collect();
    if wide.is_empty() { return Some(Vec::new()); }
    let mut used_default: i32 = 0;
    let need = unsafe {
        WideCharToMultiByte(CP_GBK, 0, wide.as_ptr(), wide.len() as i32,
                            std::ptr::null_mut(), 0, std::ptr::null(), &mut used_default)
    };
    if need <= 0 || used_default != 0 { return None; }   // 有编不出来的字符 → 交给调用方退 UTF-8
    let mut buf = vec![0u8; need as usize];
    let got = unsafe {
        WideCharToMultiByte(CP_GBK, 0, wide.as_ptr(), wide.len() as i32,
                            buf.as_mut_ptr(), need, std::ptr::null(), &mut used_default)
    };
    if got <= 0 || used_default != 0 { return None; }
    buf.truncate(got as usize);
    Some(buf)
}

#[cfg(not(windows))]
fn encode_gbk(_text: &str) -> Option<Vec<u8>> { None }

#[cfg(test)]
mod quick_cmd_file_tests {
    use super::*;

    #[test]
    fn decode_plain_utf8_and_bom() {
        assert_eq!(decode_text_file("AT+GMR".as_bytes()), ("AT+GMR".to_string(), "utf-8".to_string()));
        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice("查版本".as_bytes());
        assert_eq!(decode_text_file(&bom), ("查版本".to_string(), "utf-8-bom".to_string()));
    }

    #[test]
    fn decode_gbk_fallback_keeps_chinese() {
        // "指令" 的 GBK 编码：D6 B8 C1 EE
        let gbk = [0xD6u8, 0xB8, 0xC1, 0xEE];
        assert_eq!(decode_text_file(&gbk), ("指令".to_string(), "gbk".to_string()));
    }

    #[test]
    fn gbk_round_trip_and_unmappable_fallback() {
        // GBK 能编出来的：读回来必须一模一样（写回不会把用户的 GBK 文件变成乱码）
        let (bytes, enc) = encode_text_file("查版本 AT+GMR", "gbk");
        assert_eq!(enc, "gbk");
        assert_eq!(decode_text_file(&bytes), ("查版本 AT+GMR".to_string(), "gbk".to_string()));
        // GBK 编不出来的（emoji）→ 退回 UTF-8，而不是写成 '?' 把内容吃掉
        let (_, enc2) = encode_text_file("🚀", "gbk");
        assert_eq!(enc2, "utf-8");
        // 带 BOM 的 UTF-8 写回仍带 BOM
        let (b3, e3) = encode_text_file("x", "utf-8-bom");
        assert_eq!(e3, "utf-8-bom");
        assert_eq!(&b3[..3], &[0xEF, 0xBB, 0xBF]);
    }

    #[test]
    fn allow_list_is_lru_and_capped() {
        let mut files = QuickCmdFiles::default();
        for i in 0..(QUICK_CMD_FILE_MAX_ALLOWED + 5) {
            quick_cmd_allow_push(&mut files, &format!("C:\\cmds\\f{i}.md"), Some(format!("h{i}")));
        }
        assert_eq!(files.allowed.len(), QUICK_CMD_FILE_MAX_ALLOWED, "超出上限要淘汰");
        assert!(!files.allowed.contains(&"C:\\cmds\\f0.md".to_string()), "最旧的应被丢掉");
        assert!(files.allowed.contains(&format!("C:\\cmds\\f{}.md", QUICK_CMD_FILE_MAX_ALLOWED + 4)),
            "最新的必须在表里");
        // 重复选同一个文件：只挪位置，不重复登记
        let last = format!("C:\\cmds\\f{}.md", QUICK_CMD_FILE_MAX_ALLOWED + 4);
        quick_cmd_allow_push(&mut files, &last, None);
        assert_eq!(files.allowed.iter().filter(|p| **p == last).count(), 1);
        assert_eq!(files.allowed.last().unwrap(), &last);
        // 淘汰时对应的哈希也要清掉，别让表无限长
        assert!(files.hashes.len() <= QUICK_CMD_FILE_MAX_ALLOWED);
    }

    #[test]
    fn file_size_cap_is_256kb() {
        assert_eq!(QUICK_CMD_FILE_MAX_BYTES, 256 * 1024);
        // 读之前先看 metadata：超限的路径直接拒（这里只验证常量与错误文案的约定）
        let too_big = QUICK_CMD_FILE_MAX_BYTES + 1;
        assert!(too_big > QUICK_CMD_FILE_MAX_BYTES);
    }
}

/// 读一个指令文件：先看大小上限，再解码，返回 {path,text,encoding,hash}
fn quick_cmd_read(path: &std::path::Path) -> Result<serde_json::Value, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
    if !meta.is_file() { return Err(format!("{} 不是普通文件", path.display())); }
    if meta.len() > QUICK_CMD_FILE_MAX_BYTES {
        return Err(format!("文件太大（{} KB），上限 {} KB", meta.len() / 1024, QUICK_CMD_FILE_MAX_BYTES / 1024));
    }
    let raw = std::fs::read(path).map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
    let (text, encoding) = decode_text_file(&raw);
    Ok(serde_json::json!({
        "path": path.to_string_lossy(),
        "text": text,
        "encoding": encoding,
        "hash": sha256_hex(&raw),
    }))
}

/// 导入：弹原生文件框选一个指令文件。注意这里只收 md/txt/tsv/csv 做筛选，
/// 但**不按逗号切分**（AT 指令里逗号是常态，CSV 一路切下去必然切碎）——解析规则见前端。
#[tauri::command]
fn quick_cmds_pick_file() -> Result<Option<serde_json::Value>, String> {
    let picked = rfd::FileDialog::new()
        .set_title("选择快速指令文件")
        .add_filter("指令文件（Markdown 表格 / TSV / 纯指令行）", &["md", "markdown", "txt", "tsv", "csv"])
        .add_filter("全部文件", &["*"])
        .pick_file();
    let Some(path) = picked else { return Ok(None) };
    let v = quick_cmd_read(&path)?;
    quick_cmd_file_remember(v["path"].as_str().unwrap_or_default(), v["hash"].as_str().map(|s| s.to_string()));
    Ok(Some(v))
}

/// 重载：按已挂载的路径重读（路径必须曾在原生框里选过）
#[tauri::command]
fn quick_cmds_read_file(path: String) -> Result<serde_json::Value, String> {
    if !quick_cmd_file_allowed(&path) {
        return Err("这个路径不是你在文件框里选过的，已拒绝读取".into());
    }
    let v = quick_cmd_read(std::path::Path::new(&path))?;
    quick_cmd_file_remember(&path, v["hash"].as_str().map(|s| s.to_string()));
    Ok(v)
}

/// 写回：面板里增/删/改后调用。expect_hash 与磁盘当前内容不一致 → 报冲突（让用户先重载或另存）
#[tauri::command]
fn quick_cmds_write_file(path: String, text: String, encoding: String, expect_hash: String) -> Result<serde_json::Value, String> {
    if !quick_cmd_file_allowed(&path) {
        return Err("这个路径不是你在文件框里选过的，已拒绝写入".into());
    }
    let p = std::path::PathBuf::from(&path);
    // 没有内容基线（前端没能成功读过一次）就直接拒 —— 那种情况下写回等于按内存列表重写用户的文件
    if expect_hash.is_empty() {
        return Err("拒绝写入：没有内容基线（请先成功读取一次该文件再改）".into());
    }
    if let Ok(raw) = std::fs::read(&p) {
        let cur = sha256_hex(&raw);
        if cur != expect_hash {
            return Err("冲突：文件已被其它程序修改（请先「重载」再改，或「另存」到新文件）".into());
        }
    }
    if text.len() as u64 > QUICK_CMD_FILE_MAX_BYTES {
        return Err(format!("内容超出上限 {} KB", QUICK_CMD_FILE_MAX_BYTES / 1024));
    }
    let (bytes, actual_enc) = encode_text_file(&text, &encoding);
    let tmp = std::path::PathBuf::from(format!("{}.seahi-tmp", path));
    std::fs::write(&tmp, &bytes).map_err(|e| format!("写入失败: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("替换 {} 失败: {e}", p.display())
    })?;
    let hash = sha256_hex(&bytes);
    quick_cmd_file_remember(&path, Some(hash.clone()));
    Ok(serde_json::json!({ "path": path, "hash": hash, "encoding": actual_enc, "bytes": bytes.len() }))
}

/// 导出：弹保存框把当前列表另存一份（只给 Markdown/TSV/纯文本，不给 CSV —— 逗号会切碎 AT 指令）
#[tauri::command]
fn quick_cmds_export_file(text: String, encoding: String, default_name: String) -> Result<Option<serde_json::Value>, String> {
    let name = if default_name.trim().is_empty() { "quick-cmds.md".to_string() } else { default_name };
    let picked = rfd::FileDialog::new()
        .set_title("导出快速指令")
        .set_file_name(&name)
        .add_filter("Markdown 表格", &["md"])
        .add_filter("TSV 表格", &["tsv", "txt"])
        .save_file();
    let Some(path) = picked else { return Ok(None) };
    if text.len() as u64 > QUICK_CMD_FILE_MAX_BYTES {
        return Err(format!("内容超出上限 {} KB", QUICK_CMD_FILE_MAX_BYTES / 1024));
    }
    let (bytes, actual_enc) = encode_text_file(&text, &encoding);
    std::fs::write(&path, &bytes).map_err(|e| format!("写入 {} 失败: {e}", path.display()))?;
    let path_str = path.to_string_lossy().to_string();
    let hash = sha256_hex(&bytes);
    quick_cmd_file_remember(&path_str, Some(hash.clone()));
    Ok(Some(serde_json::json!({ "path": path_str, "hash": hash, "encoding": actual_enc })))
}

// ===== 窗口大小与位置记忆 =====
// 在退出时把主窗口的几何信息写入 %APPDATA%\seahi-serial\window.json，
// 下次启动时据此恢复窗口大小与位置（含最大化状态）。
// 注意：最大化时只翻转 maximized 标志并保留最近一次“非最大化”时的普通几何，
// 以免把最大化后的工作区尺寸误存为普通尺寸，导致还原时窗口异常。

/// 持久化的窗口状态（单位：物理像素）
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
struct SavedWindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

impl Default for SavedWindowState {
    fn default() -> Self {
        // 与 tauri.conf.json 中 main 窗口的默认几何保持一致
        SavedWindowState { x: 0, y: 0, width: 1047, height: 794, maximized: false }
    }
}

fn window_state_file() -> Option<std::path::PathBuf> {
    dirs_config_path().map(|d| d.join("window.json"))
}

fn load_window_state() -> Option<SavedWindowState> {
    let f = window_state_file()?;
    std::fs::read_to_string(f).ok().and_then(|s| serde_json::from_str(&s).ok())
}

fn save_window_state(s: &SavedWindowState) {
    if let Some(f) = window_state_file() {
        if let Some(dir) = f.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(s) {
            let _ = std::fs::write(f, json);
        }
    }
}

/// 捕获当前窗口几何并持久化。核心约定：窗口处于最大化时只更新标志、保留
/// 已存的普通几何；处于最小化/隐藏等异常态时不改写普通几何（此时系统会给
/// 出 (-32000,-32000) 之类的哨兵坐标，写入会污染记录）。
fn persist_window_geometry(window: &tauri::Window) {
    if window.label() != "main" {
        return;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    let mut state = load_window_state().unwrap_or_default();
    if maximized {
        state.maximized = true;
    } else {
        state.maximized = false;
        if !minimized {
            // 位置必须用“外框”坐标(outer_position)：恢复时 set_position 设置的正是外框左上角，
            // 若这里保存“客户区”坐标(inner_position)，无边框窗口因外框比客户区外扩一圈 margin，
            // 每次恢复都会把窗口再向右/下推 margin，反复开关便持续漂移。
            // 尺寸仍取内尺寸(inner_size)，因为 set_size 设置的是客户区(内容)尺寸，二者一致。
            if let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) {
                state.x = pos.x;
                state.y = pos.y;
                state.width = size.width;
                state.height = size.height;
            }
        }
    }
    save_window_state(&state);
}

/// Moved / Resized 自动保存的去抖计时（只在窗口 label=main 时使用）
static WINDOW_SAVE_DEBOUNCE: std::sync::OnceLock<std::sync::Mutex<Option<std::time::Instant>>> =
    std::sync::OnceLock::new();

/// 事件触发的自动保存：force 用于 CloseRequested 强制写盘；否则按 ~400ms 去抖，
/// 避免拖动/缩放窗口时高频写文件。
fn window_auto_save(window: &tauri::Window, force: bool) {
    if window.label() != "main" {
        return;
    }
    // 启动时窗口先隐藏用于恢复几何，这段时间会触发 Moved/Resized，但那是程序自己摆放的
    // 瞬时态，写盘会污染记录（甚至存下 2068×2060 这类异常尺寸）。因此非强制的自动保存
    // 仅在窗口已可见(用户实际交互/显示后)才执行；CloseRequested(force)不受此限制。
    if !force && !window.is_visible().unwrap_or(false) {
        return;
    }
    let lock = WINDOW_SAVE_DEBOUNCE.get_or_init(|| std::sync::Mutex::new(None));
    if !force {
        let last = lock.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(prev) = *last {
            if prev.elapsed() < std::time::Duration::from_millis(400) {
                return;
            }
        }
    }
    persist_window_geometry(window);
    if let Ok(mut last) = lock.lock() {
        *last = Some(std::time::Instant::now());
    }
}

/// 迁移兜底：0.5.1 之前窗口尺寸是存在 `config.json` 的 `windowWidth`/`windowHeight` 里的
/// （由前端 `collectConfig` 写入），没有位置、也没有最大化状态。刚升级上来的老用户
/// 一次都还没写过 `window.json`，若直接回退默认值，窗口尺寸会被重置一次（用户可感知）。
/// 所以读不到 `window.json` 时用它兜一次尺寸。
fn legacy_window_state_from_config() -> Option<SavedWindowState> {
    let cfg = dirs_config_path()?.join("config.json");
    let text = std::fs::read_to_string(cfg).ok()?;
    legacy_window_state_from_config_json(&text)
}

/// 从 `config.json` 的文本里取旧的窗口尺寸字段（纯函数，便于单测）。
fn legacy_window_state_from_config_json(text: &str) -> Option<SavedWindowState> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let width = v.get("windowWidth").and_then(|x| x.as_u64()).unwrap_or(0);
    let height = v.get("windowHeight").and_then(|x| x.as_u64()).unwrap_or(0);
    if width == 0 || height == 0 {
        return None;
    }
    Some(SavedWindowState {
        // 旧字段里没有位置：留 (0,0) 但由调用方决定**不恢复位置**（否则会把窗口顶到左上角，
        // 还不如保持 tauri.conf.json 的居中）。
        x: 0,
        y: 0,
        width: width.min(u32::MAX as u64) as u32,
        height: height.min(u32::MAX as u64) as u32,
        maximized: false,
    })
}

/// 恢复窗口几何：仅在启动时调用一次。位置需保证落在某块显示器可见区域内，
/// 避免用户拔掉外接显示器后窗口被“放”到不可见的虚拟屏上。
fn apply_window_state(window: &tauri::WebviewWindow) {
    // window.json 优先（含位置 + 最大化）；读不到时退回老配置里的尺寸。
    // `restore_pos` 只有前者为真 —— 旧字段没有位置，用 (0,0) 会把窗口挪到左上角。
    let (state, restore_pos) = match load_window_state() {
        Some(s) => (s, true),
        None => match legacy_window_state_from_config() {
            Some(s) => (s, false),
            None => return,
        },
    };
    let width = state.width.max(1047);
    let height = state.height.max(650);
    if state.maximized {
        let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize { width, height }));
        let _ = window.maximize();
        return;
    }
    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize { width, height }));
    // 仅当窗口矩形能与至少一块显示器重叠到可操作尺寸时才恢复位置，否则保持默认居中。
    if restore_pos && rect_on_screen(window.app_handle(), state.x, state.y, width, height) {
        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: state.x,
            y: state.y,
        }));
    }
}

/// 判断 (x,y,w,h)（物理像素）是否能与任一块显示器产生足够大的可见重叠。
fn rect_on_screen(app: &tauri::AppHandle, x: i32, y: i32, w: u32, h: u32) -> bool {
    let Ok(monitors) = app.available_monitors() else { return false };
    for m in monitors {
        let p = m.position();
        let s = m.size();
        let (mx, my) = (p.x, p.y);
        let (mw, mh) = (s.width as i32, s.height as i32);
        let ow = (x + w as i32).min(mx + mw) - x.max(mx);
        let oh = (y + h as i32).min(my + mh) - y.max(my);
        // 至少露出标题栏高度 + 一定宽度才算“可见”，否则视为在屏外
        if ow >= 60 && oh >= 40 {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod window_state_tests {
    use super::*;

    #[test]
    fn legacy_config_size_is_used_as_fallback() {
        // 老用户的 config.json：只有尺寸、没有位置（位置与最大化状态是 window.json 才有的）
        let s = legacy_window_state_from_config_json(
            r#"{"version":2,"windowWidth":1400,"windowHeight":900,"theme":"dark"}"#,
        )
        .expect("旧配置里有尺寸就该回退，否则老用户升级后窗口尺寸被重置一次");
        assert_eq!((s.width, s.height), (1400, 900));
        assert!(!s.maximized, "旧字段没有最大化状态，不能凭空当成最大化");
    }

    #[test]
    fn legacy_config_without_size_yields_nothing() {
        // 没写过尺寸（或为 0、只写了一半）→ 不回退，保持 tauri.conf.json 的默认几何
        assert!(legacy_window_state_from_config_json(r#"{"version":2}"#).is_none());
        assert!(legacy_window_state_from_config_json(r#"{"windowWidth":0,"windowHeight":900}"#).is_none());
        assert!(legacy_window_state_from_config_json(r#"{"windowWidth":1400}"#).is_none());
        // 配置损坏也不能 panic —— 这是启动路径，panic 等于应用起不来
        assert!(legacy_window_state_from_config_json("not json").is_none());
        assert!(legacy_window_state_from_config_json("").is_none());
    }

    #[test]
    fn saved_window_state_round_trips_through_json() {
        // 副屏在主屏左侧时 x 为负，必须能存能读（否则多屏用户的窗口每次都被拉回主屏）
        let s = SavedWindowState { x: -1200, y: 40, width: 1500, height: 950, maximized: true };
        let text = serde_json::to_string(&s).unwrap();
        assert!(text.contains("-1200"));
        let back: SavedWindowState = serde_json::from_str(&text).unwrap();
        assert_eq!((back.x, back.y, back.width, back.height, back.maximized),
                   (-1200, 40, 1500, 950, true));
        // 默认值与 tauri.conf.json 里主窗口的几何（1047×794）一致
        let d = SavedWindowState::default();
        assert_eq!((d.width, d.height), (1047, 794));
        assert!(!d.maximized);
        // 位置哨兵：最小化时系统会给 (-32000,-32000)，只要求能存能读（是否写由 persist 决定）
        let m = SavedWindowState { x: -32000, y: -32000, width: 1047, height: 794, maximized: false };
        assert_eq!(serde_json::from_str::<SavedWindowState>(&serde_json::to_string(&m).unwrap()).unwrap().x, -32000);
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
/// 单个缓存文件的大小上限（超过则停止写入并留一行终止标记）
const LOG_CACHE_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// 缓存目录总字节上限（软目标：先保证单文件上限，再按总量从最旧删）
const LOG_CACHE_MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;

/// 单个监视器的会话缓存状态
struct LogCacheSession {
    /// 会话端口名（用于文件命名）
    port_name: String,
    /// 已打开的文件句柄；None 表示会话尚未写入任何内容（即未创建文件）
    file: Option<std::fs::File>,
    /// 文件完整路径（结束会话时用于清理空文件）
    path: std::path::PathBuf,
    /// 已写入字节数（用于单文件大小上限判断；只在新建文件时归零）
    bytes: u64,
    /// 是否已因超过单文件上限而停止写入
    capped: bool,
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

/// 保证缓存目录不超预算：从最旧开始删（按文件名时间戳升序）。
/// `active` 里的文件正在被会话写入，不删 —— 否则会把日志从正在写的会话脚下抽走。
fn enforce_log_cache_limit_in(
    dir: &std::path::Path,
    max_count: usize,
    max_total_bytes: u64,
    active: &std::collections::HashSet<std::path::PathBuf>,
) {
    use std::fs;
    let mut files: Vec<(std::path::PathBuf, u64)> = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if !p.is_file() {
                continue;
            }
            if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                if name.starts_with(LOG_CACHE_PREFIX) && name.ends_with(LOG_CACHE_SUFFIX) {
                    let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    files.push((p, size));
                }
            }
        }
    }
    files.sort(); // 文件名前缀含可排序时间戳，字典序即时间序
    let removable: Vec<(std::path::PathBuf, u64)> = files
        .iter()
        .filter(|(p, _)| !active.contains(p))
        .cloned()
        .collect();
    let mut total: u64 = files.iter().map(|(_, s)| *s).sum();
    let mut count = files.len();
    for (p, size) in removable.iter() {
        if count <= max_count && total <= max_total_bytes {
            break;
        }
        if fs::remove_file(p).is_ok() {
            total = total.saturating_sub(*size);
            count = count.saturating_sub(1);
        }
    }
}

/// **创建新缓存文件之前**腾位：紧接着还要多出一个文件，所以目标数是 `LOG_CACHE_MAX_COUNT - 1`
/// —— 建完正好 ≤ `LOG_CACHE_MAX_COUNT`。
///
/// 为什么不在 `enforce_log_cache_limit_in` 里把比较符改成 `<`：那个函数的语义是
/// "这个目录里最多留 N 个"（单测直接按这个语义用它），把"马上还要再建一个"这层意图
/// 藏进比较符里，会让两个调用点的含义都变模糊。这里用一个名字把意图写明白。
///
/// 2026-09 审计发现的真实缺陷：原来在建文件**之前**直接调 `enforce_log_cache_limit`（目标 10），
/// 目录里恰好有 10 个时就 break 不删，紧接着建出第 11 个 —— 声明为硬上限的"最多 10 个"
/// 从来就没成立过（单测从 12 个文件起步，正好绕过了 `count == max_count` 这个边界）。
fn make_room_for_new_log_cache(
    dir: &std::path::Path,
    active: &std::collections::HashSet<std::path::PathBuf>,
) {
    enforce_log_cache_limit_in(
        dir,
        LOG_CACHE_MAX_COUNT.saturating_sub(1),
        LOG_CACHE_MAX_TOTAL_BYTES,
        active,
    );
}

/// 开一次会话缓存时对**已存在**会话的处理。
///
/// 正常情况下幂等：保留原文件，自动重连时日志连续。
/// 但**触顶（capped）的会话必须换一个新文件**（返回 `true`）—— 否则那个面板的日志缓存
/// 会永久失效且不再通知：`start_log_cache` 原来是 `or_insert_with`，把 `capped` 一起保住了，
/// 之后 `append_log_cache` 每次都静默 `return`，只有把整个监视器关掉才释放（2026-09 审计发现）。
fn restart_capped_log_cache_session(sess: &mut LogCacheSession) -> bool {
    if !sess.capped {
        return false;
    }
    sess.file = None;                       // → append 时会新建文件（并先腾位）
    sess.path = std::path::PathBuf::new();
    sess.bytes = 0;
    sess.capped = false;
    true
}

/// 标记一次串口会话开始（幂等：已存在则保留原文件，自动重连时日志连续）
#[tauri::command]
fn start_log_cache(state: tauri::State<'_, LogCacheState>, monitor_id: String, port_name: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(sess) = sessions.get_mut(&monitor_id) {
        restart_capped_log_cache_session(sess);
        return Ok(());
    }
    sessions.insert(monitor_id, LogCacheSession {
        port_name,
        file: None,
        path: std::path::PathBuf::new(),
        bytes: 0,
        capped: false,
    });
    Ok(())
}

/// 向当前会话缓存文件追加内容。首次写入时创建文件并清理旧缓存（≤10 个 / ≤64 MiB）。
/// 单文件超过 LOG_CACHE_MAX_BYTES 后停止写入并留一行终止标记，同时通知前端（不静默丢弃）。
#[tauri::command]
fn append_log_cache(
    app: tauri::AppHandle,
    state: tauri::State<'_, LogCacheState>,
    monitor_id: String,
    content: String,
) -> Result<(), String> {
    use std::io::Write;
    if content.is_empty() {
        return Ok(());
    }
    let mut capped_notice: Option<u64> = None;
    {
        let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());

        // 1) 确保会话存在
        if !sessions.contains_key(&monitor_id) {
            sessions.insert(
                monitor_id.clone(),
                LogCacheSession {
                    port_name: String::new(),
                    file: None,
                    path: std::path::PathBuf::new(),
                    bytes: 0,
                    capped: false,
                },
            );
        }

        // 2) 尚未建文件则先建（创建目录 → 清理旧缓存 → 新建）
        let need_create = sessions.get(&monitor_id).map(|s| s.file.is_none()).unwrap_or(false);
        if need_create {
            let dir = log_cache_dir();
            std::fs::create_dir_all(&dir).map_err(|e| format!("创建日志缓存目录失败: {}", e))?;
            // 正在被其它会话写入的文件不能删（否则会把日志从其脚下抽走）
            let active: std::collections::HashSet<std::path::PathBuf> = sessions
                .values()
                .filter(|s| !s.path.as_os_str().is_empty())
                .map(|s| s.path.clone())
                .collect();
            // 建文件**之前**腾位（目标 = 上限 - 1，建完正好 ≤ 上限，见函数注释）
            make_room_for_new_log_cache(&dir, &active);
            let port_name = sessions
                .get(&monitor_id)
                .map(|s| s.port_name.clone())
                .unwrap_or_default();
            let filename = format!(
                "{}{}-{}{}",
                LOG_CACHE_PREFIX,
                log_cache_time_stamp(),
                sanitize_for_filename(&port_name),
                LOG_CACHE_SUFFIX
            );
            let path = dir.join(&filename);
            let file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .map_err(|e| format!("创建日志缓存文件失败: {}", e))?;
            if let Some(sess) = sessions.get_mut(&monitor_id) {
                sess.path = path;
                sess.file = Some(file);
                sess.bytes = 0;
                sess.capped = false;
            }
        }

        // 3) 写入，或触顶后只补一行终止标记
        if let Some(sess) = sessions.get_mut(&monitor_id) {
            if sess.capped {
                return Ok(());
            }
            let add = content.len() as u64;
            if sess.bytes + add > LOG_CACHE_MAX_BYTES {
                if let Some(f) = sess.file.as_mut() {
                    let marker = format!(
                        "\n--- 日志缓存已达单文件上限 {} MiB，后续内容不再写入（完整内容请以实时输出或导出为准）---\n",
                        LOG_CACHE_MAX_BYTES / (1024 * 1024)
                    );
                    let _ = f.write_all(marker.as_bytes());
                    let _ = f.flush();
                }
                sess.capped = true;
                capped_notice = Some(LOG_CACHE_MAX_BYTES);
            } else {
                if let Some(f) = sess.file.as_mut() {
                    f.write_all(content.as_bytes())
                        .map_err(|e| format!("写入日志缓存失败: {}", e))?;
                    let _ = f.flush();
                }
                sess.bytes += add;
            }
        }
    }
    // 在释放锁之后再通知前端，避免持锁做跨进程通信
    if let Some(max_bytes) = capped_notice {
        dbg_log(&format!(
            "append_log_cache: 会话 {} 已达单文件上限 {} 字节，停止写入",
            monitor_id, max_bytes
        ));
        let _ = app.emit(
            "log-cache-capped",
            serde_json::json!({ "monitorId": monitor_id, "maxBytes": max_bytes }),
        );
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

    #[test]
    fn ble_adv_has_type_scans_ad_sections() {
        // Flags(02 01 06) + Complete Local Name(06 09 "SeaHi") + Mesh Beacon(02 2B 00)
        let adv = [
            0x02, 0x01, 0x06,
            0x06, 0x09, b'S', b'e', b'a', b'H', b'i',
            0x02, 0x2B, 0x00,
        ];
        assert!(super::ble_adv_has_type(&adv, 0x01));   // Flags
        assert!(super::ble_adv_has_type(&adv, 0x09));   // Complete Local Name
        assert!(super::ble_adv_has_type(&adv, 0x2B));   // Mesh Beacon
        assert!(!super::ble_adv_has_type(&adv, 0x2A));  // 不含 Mesh Message
        assert!(!super::ble_adv_has_type(&adv, 0xFF));  // 不含厂商数据
        // 空数据不 panic
        assert!(!super::ble_adv_has_type(&[], 0x01));
        // 0x00 为广播结束段，其后不再解析
        assert!(!super::ble_adv_has_type(&[0x00, 0x01, 0x06], 0x01));
        // 段长度越界（数据被截断）不 panic，且不误判
        assert!(!super::ble_adv_has_type(&[0x09, 0x2B], 0x2B));
    }

    #[test]
    fn is_ibeacon_payload_only_matches_ibeacon_structure() {
        // 标准 iBeacon：02 15 + 16B Proximity UUID + 2B Major + 2B Minor + 1B TxPower = 23 字节
        let mut beacon = vec![0x02, 0x15];
        beacon.extend_from_slice(&[0x11; 16]);
        beacon.extend_from_slice(&[0x00, 0x01]);
        beacon.extend_from_slice(&[0x00, 0x02]);
        beacon.push(0xC5);
        assert_eq!(beacon.len(), 23);
        assert!(super::is_ibeacon_payload(&beacon));

        // iPhone/Mac 常见的 Nearby Info(0x10) 不能被当成 iBeacon（实机抓到的真实值）
        assert!(!super::is_ibeacon_payload(&[0x10, 0x85, 0x25, 0x1C, 0x31, 0xFD, 0xE4]));
        // Proximity Pairing(0x07) 同理
        assert!(!super::is_ibeacon_payload(&[0x07, 0x19, 0x01]));
        // 前缀对但长度不足（截断报文）不认
        assert!(!super::is_ibeacon_payload(&[0x02, 0x15, 0x00, 0x01]));
        // 空 / 过短不 panic
        assert!(!super::is_ibeacon_payload(&[]));
        assert!(!super::is_ibeacon_payload(&[0x02]));
    }

    #[test]
    fn busid_whitelist_rejects_shell_metacharacters() {
        // 合法：usbipd 的 busid 形如 1-4（数字-数字）
        assert!(super::is_valid_busid("1-4"));
        assert!(super::is_valid_busid("12-34"));
        // 非法：这条值会进提权 PowerShell 脚本，任何拼接/元字符都必须拒绝
        assert!(!super::is_valid_busid("1-1; Start-Process calc"));
        assert!(!super::is_valid_busid("1-1' ; whoami #"));
        assert!(!super::is_valid_busid("1-1 | Out-Null; calc"));
        assert!(!super::is_valid_busid("$(calc)"));
        assert!(!super::is_valid_busid("1-1 2-2"));      // 多段
        assert!(!super::is_valid_busid("1-"));           // 缺后半
        assert!(!super::is_valid_busid("-1"));           // 缺前半
        assert!(!super::is_valid_busid("1-a"));          // 非数字
        assert!(!super::is_valid_busid(""));             // 空
        assert!(!super::is_valid_busid("1-1-1"));        // 三段
    }

    #[test]
    fn bt_addr_to_u64_parses_mac() {
        // 冒号分隔（本应用显示与前端回传的形式）
        assert_eq!(super::bt_addr_to_u64("A4:C1:38:11:14:2B"), Some(0xA4C13811142B));
        // 小写、无分隔符也应接受（大小写与分隔符都不影响）
        assert_eq!(super::bt_addr_to_u64("a4c13811142b"), Some(0xA4C13811142B));
        assert_eq!(super::bt_addr_to_u64("a4:c1:38:11:14:2b"), Some(0xA4C13811142B));
        // 非法输入：位数不对 / 空 / 非十六进制混入导致位数不足
        assert_eq!(super::bt_addr_to_u64("A4:C1:38:11:14"), None);   // 少一段
        assert_eq!(super::bt_addr_to_u64(""), None);
        assert_eq!(super::bt_addr_to_u64("ZZ:ZZ:ZZ:ZZ:ZZ:ZZ"), None);
        // 不能溢出：48 位地址须落在 u64 内且高位在前
        assert!(super::bt_addr_to_u64("FF:FF:FF:FF:FF:FF").unwrap() < u64::MAX);
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

/// 前端页面就绪后调用：把启动时隐藏的主窗口在“最终几何位置”一次性显示出来。
/// 这样窗口第一次出现就落在上次退出时的位置，避免“先居中/先显示默认尺寸、再移动”的二次跳变。
#[tauri::command]
fn reveal_main_window(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if !win.is_visible().unwrap_or(true) {
            let _ = win.show();
        }
        let _ = win.set_focus();
    }
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
    /// 这个会话连的是哪台设备。存在的意义：MCP 的 `adb_shell_read` 读的是**所有会话共用**的
    /// `adb:rx` 日志通道，要如实告诉调用方"这段输出来自哪台设备"，就得记住它
    /// （后端自己的事实，不是把界面状态镜像一份）。
    serial: String,
    child: std::sync::Arc<std::sync::Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    /// 写入端：portable-pty 的 master 通过 take_writer() 得到可写句柄
    writer: std::sync::Mutex<Box<dyn std::io::Write + Send>>,
    /// 常驻读取线程推送的原始输出块
    output: crossbeam_channel::Receiver<Vec<u8>>,
    /// 因通道积压而丢掉的**块数**（读线程累加，`adb_shell_read` 取增量回传前端）
    dropped: std::sync::Arc<std::sync::atomic::AtomicU64>,
    dead: std::sync::atomic::AtomicBool,
    /// 保活：保存 PTY master/slave，避免 pair drop 导致 shell 退出
    _master: std::sync::Mutex<Option<Box<dyn portable_pty::MasterPty + Send>>>,
    _slave: std::sync::Mutex<Option<Box<dyn portable_pty::SlavePty + Send>>>,
}

/// 全局状态：ADB PTY 会话（key = session_id）
struct AdbPtyState {
    sessions: std::sync::Arc<Mutex<HashMap<String, std::sync::Arc<AdbPtySession>>>>,
}

/// 当前 ADB PTY 会话连接的是哪台设备（给 MCP 的 `adb_shell_read` 用）。
///
/// 单会话模型下最多一个；0 个、或切换设备那一瞬有多个时返回 `None` ——
/// 与其猜一台，不如如实说"不确定"（输出与设备对不上比没有设备名更糟）。
pub(crate) fn adb_active_serial(state: &AdbPtyState) -> Option<String> {
    let s = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
    if s.len() == 1 {
        s.values().next().map(|x| x.serial.clone())
    } else {
        None
    }
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
        // 丢弃计数放在**会话上**（而不是读取线程的局部变量）：前端每次 read 都要能拿到增量，
        // 否则"设备就输出了这么多"是假象（release 构建没有控制台，eprintln 谁也看不见）。
        let dropped = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let dropped_thread = dropped.clone();
        std::thread::spawn(move || {
            use std::io::Read;
            /// 通道积压上限：ADB 侧若刷得很快（logcat/top）而前端没及时取走，
            /// 无上限通道会让内存线性增长。超限丢弃本块并计数（计数由 adb_shell_read 回传前端）。
            const ADB_PTY_QUEUE_MAX: usize = 512;
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => { println!("[ADB-PTY] reader EOF"); let _ = tx.send(Vec::new()); break; }
                    Ok(n) => {
                        if tx.len() >= ADB_PTY_QUEUE_MAX {
                            dropped_thread.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            continue;
                        }
                        // 生产端旁路：这个 crossbeam 通道是"前端轮询取走的单消费者队列"，
                        // 所以 MCP 的 `adb_shell_read` 只能读**在产生处复制的这一份**，
                        // 绝不能去 drain 队列（那会把界面终端要显示的输出抢走，AGENTS #6）。
                        // push 拿不到锁就丢一条并计数，绝不阻塞这条读线程（AGENTS #6/#10）；
                        // MCP 没启用时它只是一次原子读，零成本。
                        crate::mcp::loghub::hub().push(
                            "adb:rx",
                            crate::mcp::loghub::LEVEL_INFO,
                            crate::mcp::loghub::DIR_RX,
                            &String::from_utf8_lossy(&buf[..n]),
                            n as u32,
                        );
                        if tx.send(buf[..n].to_vec()).is_err() { break; }
                    }
                    Err(e) => { println!("[ADB-PTY] reader err {}", e); break; }
                }
            }
        });
        let session_id = format!("adb-pty-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        // 用 take_writer() 拿写入句柄
        let writer = pair.master.take_writer().map_err(|e| format!("take_writer 失败: {}", e))?;
        let session = std::sync::Arc::new(AdbPtySession {
            serial,
            child: std::sync::Arc::new(std::sync::Mutex::new(child)),
            writer: std::sync::Mutex::new(writer),
            output: rx,
            dropped: dropped.clone(),
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

/// 读取会话输出（非阻塞：立即返回当前累积的数据）。
///
/// 回 `{ bytes, dropped }`：`dropped` 是"自上次 read 以来因积压被丢掉的**块数**"（取增量并清零）。
/// 形状与串口的 `ReadDataResult`、BLE 通知的 `{items, dropped}` 一致 —— 丢弃必须能传到界面上，
/// 否则用户会以为"设备就输出了这么多"（2026-09 审计发现：ADB 这一路原来只在 stderr 上打日志，
/// 而 release 构建没有控制台）。
#[tauri::command]
async fn adb_shell_read(
    state: tauri::State<'_, AdbPtyState>,
    session_id: String,
) -> Result<serde_json::Value, String> {
    let sessions = state.sessions.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let session = { let s = sessions.lock().unwrap_or_else(|e| e.into_inner()); s.get(&session_id).cloned() };
        let session = session.ok_or_else(|| "会话不存在".to_string())?;
        let mut buf: Vec<u8> = Vec::new();
        while let Ok(chunk) = session.output.try_recv() {
            buf.extend_from_slice(&chunk);
        }
        let dropped = session.dropped.swap(0, std::sync::atomic::Ordering::Relaxed);
        Ok(serde_json::json!({ "bytes": buf, "dropped": dropped }))
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

/// 遍历广播 AD 结构（[len][type][payload...]）判断是否含指定 AD type
/// 置于 crate 根（不在 main 内部）以便单元测试直接覆盖
fn ble_adv_has_type(raw: &[u8], ad_type: u8) -> bool {
    let mut i = 0usize;
    while i < raw.len() {
        let len = raw[i] as usize;
        if len == 0 { break; }                    // 0x00：广播结束段
        if i + 1 + len > raw.len() { break; }     // 长度越界：数据不完整，停止解析
        if raw[i + 1] == ad_type { return true; }
        i += 1 + len;
    }
    false
}

/// iBeacon payload 判定：Apple 厂商数据（Company ID 之后的字节）为固定前缀
/// `02 15` + 16B Proximity UUID + 2B Major + 2B Minor + 1B TxPower，共 23 字节。
/// 置于 crate 根（不在 main 内部）以便单元测试直接覆盖
fn is_ibeacon_payload(d: &[u8]) -> bool {
    d.len() >= 23 && d[0] == 0x02 && d[1] == 0x15
}

/// 蓝牙地址字符串 → WinRT 配对接口需要的 u64（高位在前）：
/// "A4:C1:38:11:14:2B" → 0xA4C13811142B
/// 置于 crate 根（不在 main 内部）以便单元测试直接覆盖
fn bt_addr_to_u64(s: &str) -> Option<u64> {
    let hex: String = s.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() != 12 { return None; }
    u64::from_str_radix(&hex, 16).ok()
}

fn ble_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join(" ")
}

/* ===== BLE 从机（Peripheral / GATT Server，WinRT） =====
   btleplug 是 central-only，没有外设角色，所以这里直接用 WinRT：
   建本地 GATT 服务 → StartAdvertisingWithParameters，本机作为从机被主机搜到并连接；
   主机的读 / 写 / 订阅都通过 GattLocalCharacteristic 的事件回调转成前端可见的事件。

   ⚠ 平台限制（不是缺陷，已记入 doc/BLE_PERIPHERAL.md）：
   1) 广播里的设备名由 Windows 决定（系统蓝牙名称），GattServiceProvider 改不了 ——
      手机上看到的是电脑名，不是这里配的服务名；
   2) 一个 GattServiceProvider 只广播它自己那一个服务 UUID；
   3) 没有任何主机订阅时 NotifyValueAsync 无处可发，必须先被订阅；
   4) 同一时刻只能有一个进程持有同一个服务 UUID，重复「开始广播」要先收掉上一个。 */

use windows::Devices::Bluetooth::BluetoothError;
use windows::Devices::Bluetooth::GenericAttributeProfile::{
    GattCharacteristicProperties, GattCommunicationStatus, GattLocalCharacteristic,
    GattLocalCharacteristicParameters, GattLocalDescriptorParameters, GattProtectionLevel,
    GattReadRequestedEventArgs, GattServiceProvider, GattServiceProviderAdvertisementStatus,
    GattServiceProviderAdvertisementStatusChangedEventArgs, GattServiceProviderAdvertisingParameters,
    GattSession, GattWriteOption, GattWriteRequest, GattWriteRequestedEventArgs,
};
use windows::Storage::Streams::{DataReader, DataWriter, IBuffer};

/// 从机侧的一个本地特征
struct BlePeriphChar {
    uuid: String,
    /// 属性名（与主机面板同一套命名：read / write / write_without_response / notify / indicate）
    props: Vec<String>,
    /// 主机读到的值。收到主机写入时同步更新，这样「主机写 → 本机读回」的闭环成立。
    value: std::sync::Arc<Mutex<Vec<u8>>>,
    /// 当前订阅该特征的主机数（由 SubscribedClientsChanged 维护）
    subscribed: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    /// 单次通知的最大字节数（= 协商后的 ATT_MTU - 3，由 GattSubscribedClient 给出）。
    /// 0 表示还没有订阅者、还不知道。
    max_notify: std::sync::Arc<std::sync::atomic::AtomicU16>,
    /// 该特征下建出来的描述符 UUID（如 2901 用户描述）
    descriptors: Vec<String>,
    /// 持有它才能下发通知（WinRT 要求特征对象存活）
    characteristic: GattLocalCharacteristic,
}

/// 一条等待用户决定如何应答的写请求。
/// 手动应答模式下写回调**不立即 Respond**，而是把请求与 Deferral 存下来等前端决定 ——
/// 调试主机侧的错误处理逻辑时必须能主动拒绝（返回协议错误码），而不是只能接受。
struct BlePeriphPendingWrite {
    request: GattWriteRequest,
    deferral: windows::Foundation::Deferral,
    uuid: String,
}

/// 手动应答的兜底超时：到点按协议错误回过去，不能让主机一直挂着。
const BLE_PERIPH_REPLY_TIMEOUT_MS: u64 = 20_000;

/// 下发前的长度校验（纯函数，便于无头断言）。
/// 超长时 WinRT 只会给一个底层错误（甚至静默截断），提前挡住并说清"该切多少字节"要好得多。
fn ble_periph_notify_size_check(len: usize, max_notify: u16) -> Result<(), String> {
    // 0 = 还没有订阅者 / 没拿到 MTU：不做长度判断，交给下面的"没有订阅者"分支去报
    if max_notify == 0 || len <= max_notify as usize {
        return Ok(());
    }
    Err(format!(
        "下发数据 {len} 字节超过单次通知上限 {max_notify} 字节（= 协商 MTU - 3）：请拆成多包发送",
    ))
}

/// 按写请求的 Offset 落值（纯函数，便于无头断言）。
/// 长写（Prepare Write / Execute Write）会带 Offset；以前直接忽略它，
/// 于是多段写会被当成互相覆盖的独立写入，值就乱了。
fn ble_periph_apply_write(value: &mut Vec<u8>, offset: usize, data: &[u8]) {
    if offset == 0 {
        // 普通写：整段替换（也顺带把之前更长的旧值截掉）
        *value = data.to_vec();
        return;
    }
    if value.len() < offset + data.len() {
        value.resize(offset + data.len(), 0);
    }
    value[offset..offset + data.len()].copy_from_slice(data);
}

/// UUID → 16 位短写（仅当它落在 Bluetooth SIG 基址下）
fn ble_periph_uuid_short(u: &uuid::Uuid) -> Option<u16> {
    const BASE_LOW96: u128 = 0x0000_1000_8000_0080_5F9B_34FB;
    let v = u.as_u128();
    let mask: u128 = (1u128 << 96) - 1;
    if (v & mask) == BASE_LOW96 {
        Some((v >> 96) as u16)
    } else {
        None
    }
}

/// WinRT 会**自己发布**这一组标准描述符，手工创建会被拒。
/// 真机实测（0x2901）：`所提供的描述符 uuid 已保留，并且将由系统自动发布。(0x80070057)`。
/// 与其把这句底层 HRESULT 甩给用户，不如在本地就挡住并说清楚该用什么。
fn ble_periph_desc_reserved(short: Option<u16>) -> Option<&'static str> {
    match short {
        Some(v) if (0x2900..=0x290F).contains(&v) => Some(
            "这是 Bluetooth SIG 标准描述符（0x2900~0x290F：用户描述 / CCCD / 表示格式等），\
             由系统按特征自动发布，不能也不必手工创建；需要附加信息请改用厂商自定义 UUID（128 位）",
        ),
        _ => None,
    }
}

/// 特征是否可读。设值只对可读特征有意义 —— 不可读的特征主机取不到，
/// 那个值只反映"主机刚写进来什么"。
fn ble_periph_props_readable(props: &[String]) -> bool {
    props.iter().any(|p| p == "read")
}

/// 传统广播总长只有 31 字节（flags 3 + 服务数据段头 4 + UUID/载荷）。
/// 这里给的是保守提示值，**真正的判定以后端返回的 `StartedWithoutAllAdvertisementData` 为准**。
const BLE_PERIPH_ADV_DATA_SAFE: usize = 24;

fn ble_periph_adv_data_warn(len: usize) -> Option<String> {
    if len > BLE_PERIPH_ADV_DATA_SAFE {
        Some(format!(
            "广播服务数据填了 {len} 字节，偏长：传统广播总共只有 31 字节（还要放 flags 与服务 UUID），\
             可能被截断 —— 看下面的广播状态是否为「部分数据被截断」"
        ))
    } else {
        None
    }
}

struct BlePeripheralState {
    /// 持有 provider 才能维持广播；置 None 即释放服务注册
    provider: Mutex<Option<GattServiceProvider>>,
    service_uuid: Mutex<Option<String>>,
    chars: Mutex<Vec<BlePeriphChar>>,
    /// 最近一次探测到的适配器能力（启动时刷新）
    adapter: Mutex<BlePeriphAdapterInfo>,
    /// 手动应答模式下待处理的写请求（id → 请求 + Deferral）
    pending_writes: std::sync::Arc<Mutex<std::collections::HashMap<u64, BlePeriphPendingWrite>>>,
    /// 待应答 id 序号
    write_seq: std::sync::Arc<std::sync::atomic::AtomicU64>,
    /// 是否启用「写入需手动应答」
    manual_write_reply: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// 主机动作事件队列（写入 / 读取 / 订阅 / 广播状态），前端轮询取走
    events: std::sync::Arc<Mutex<std::collections::VecDeque<serde_json::Value>>>,
    running: std::sync::atomic::AtomicBool,
}

/// 事件缓冲上限：前端 500ms 拉一次；不设限的话主机持续写会无限堆积。
const BLE_PERIPH_EVENT_MAX: usize = 400;
/// 一个服务下最多允许建多少个特征（Windows 的属性表空间有限，超了 CreateCharacteristicAsync 会失败）
const BLE_PERIPH_CHAR_MAX: usize = 16;

fn ble_periph_emit(
    events: &std::sync::Arc<Mutex<std::collections::VecDeque<serde_json::Value>>>,
    mut item: serde_json::Value,
) {
    if let Some(o) = item.as_object_mut() {
        o.insert("ts".to_string(), json!(chrono::Utc::now().timestamp_millis()));
    }
    let mut q = events.lock().unwrap_or_else(|e| e.into_inner());
    while q.len() >= BLE_PERIPH_EVENT_MAX {
        q.pop_front();
    }
    q.push_back(item);
}

/// 数据类事件（写入 / 读取 / 下发）的统一载荷
fn ble_periph_data_event(kind: &str, uuid: &str, value: &[u8], peer: &str, note: &str) -> serde_json::Value {
    json!({
        "kind": kind,
        "uuid": uuid,
        "value_hex": ble_hex(value),
        "len": value.len(),
        "peer": peer,
        "note": note,
    })
}

/// 适配器能力探测结果（启动从机前先问一遍）。
/// 存在的意义：广播失败时 `StartAdvertisingWithParameters` 只会给一个 `Aborted`，
/// 且 `AdvertisementStatusChanged` 里的 `BluetoothError` 实测是 `Success`（等于没说），
/// 所以"真正的原因"只能靠自己探 —— 没适配器 / 不支持 BLE / 蓝牙关着 / 没有无线电访问权 /
/// 不支持外设角色。
#[derive(Clone, Default)]
struct BlePeriphAdapterInfo {
    present: bool,
    low_energy: bool,
    peripheral_role: bool,
    central_role: bool,
    /// 电源状态："On" / "Off" / "Disabled" / "Unknown"（取不到时为空）
    radio_state: String,
    /// 无线电访问权："Allowed" / "DeniedByUser" / "DeniedBySystem" / "Unspecified" / ""（未取到）
    radio_access: String,
}

impl BlePeriphAdapterInfo {
    fn to_json(&self) -> serde_json::Value {
        json!({
            "present": self.present,
            "low_energy": self.low_energy,
            "peripheral_role": self.peripheral_role,
            "central_role": self.central_role,
            "radio_state": self.radio_state,
            "radio_access": self.radio_access,
        })
    }
}

/// 按适配器能力给出"为什么广播不起来"的可操作结论（纯函数，便于无头断言）。
/// 返回 `None` 表示能力层面没问题，广播失败要往别处找。
fn ble_periph_probe_warning(i: &BlePeriphAdapterInfo) -> Option<&'static str> {
    if !i.present {
        return Some("本机没有蓝牙适配器：无法作为 BLE 从机广播");
    }
    if !i.low_energy {
        return Some("当前蓝牙适配器不支持 BLE（低功耗蓝牙）：无法作为 BLE 从机广播");
    }
    if i.radio_state == "Off" {
        return Some("蓝牙已关闭：请在「Windows 设置 → 蓝牙和其他设备」中打开蓝牙后重试");
    }
    if i.radio_state == "Disabled" {
        return Some("蓝牙被禁用（可能是飞行模式或设备管理器里停用了适配器）：启用后重试");
    }
    if !i.peripheral_role {
        return Some("该适配器不支持 BLE 外设角色：硬件层面无法作为从机被搜索到（换适配器或用手机当从机）");
    }
    // 无线电访问权异常：桌面进程拿不到 AppContainer 身份时 RequestAccessAsync 也会返回这个，
    // 不一定等于"用户真的拒绝了"，所以文案只说现象与两种可能，不下断言
    if i.radio_access == "DeniedByUser" || i.radio_access == "DeniedBySystem" {
        return Some("无线电访问权未获授权（RadioAccessStatus 非 Allowed）：可能是隐私设置/组策略拒绝，也可能是非交互会话无法弹窗授权；本项不一定会挡住扫描，但会挡住广播");
    }
    None
}

/// 探测默认蓝牙适配器的能力。探测本身也可能失败（比如蓝牙栈没起来），
/// 那种情况下把所有能力都当 false，让上层给出"没有可用适配器"的结论。
async fn ble_periph_probe_adapter() -> BlePeriphAdapterInfo {
    let mut info = BlePeriphAdapterInfo::default();
    // 访问权先问：它是"能不能广播"的前置条件，且扫描用不到它
    if let Ok(op) = windows::Devices::Radios::Radio::RequestAccessAsync() {
        if let Ok(st) = op.await {
            info.radio_access = match st {
                windows::Devices::Radios::RadioAccessStatus::Allowed => "Allowed",
                windows::Devices::Radios::RadioAccessStatus::DeniedByUser => "DeniedByUser",
                windows::Devices::Radios::RadioAccessStatus::DeniedBySystem => "DeniedBySystem",
                _ => "Unspecified",
            }
            .to_string();
        }
    }
    let adapter = {
        let op = match windows::Devices::Bluetooth::BluetoothAdapter::GetDefaultAsync() {
            Ok(o) => o,
            Err(_) => return info,
        };
        match op.await {
            Ok(a) => a,
            Err(_) => return info,
        }
    };
    info.present = true;
    info.low_energy = adapter.IsLowEnergySupported().unwrap_or(false);
    info.peripheral_role = adapter.IsPeripheralRoleSupported().unwrap_or(false);
    info.central_role = adapter.IsCentralRoleSupported().unwrap_or(false);
    if let Ok(op) = adapter.GetRadioAsync() {
        if let Ok(radio) = op.await {
            info.radio_state = match radio.State() {
                Ok(windows::Devices::Radios::RadioState::On) => "On",
                Ok(windows::Devices::Radios::RadioState::Off) => "Off",
                Ok(windows::Devices::Radios::RadioState::Disabled) => "Disabled",
                _ => "Unknown",
            }
            .to_string();
        }
    }
    info
}

/// UUID 文本 → WinRT GUID（同时回一个规范化后的字符串给前端回显）。
/// 支持 128 位完整写法，也支持 `FFE0` / `0xFFE0` 这类短写法（按 Bluetooth SIG 基址展开）。
fn ble_periph_guid(s: &str) -> Result<(windows::core::GUID, String), String> {
    const BASE: u128 = 0x0000_0000_0000_1000_8000_0080_5F9B_34FB;
    let t = s.trim();
    let hex = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")).unwrap_or(t);
    let u = if (hex.len() == 4 || hex.len() == 8) && hex.chars().all(|c| c.is_ascii_hexdigit()) {
        let v = u128::from_str_radix(hex, 16).map_err(|_| format!("UUID 格式不正确: {s}"))?;
        uuid::Uuid::from_u128(BASE | (v << 96))
    } else {
        uuid::Uuid::parse_str(t).map_err(|_| {
            "UUID 格式不正确（例：6E400001-B5A3-F393-E0A9-E50E24DCCA9E，或短写 0xFFE0）".to_string()
        })?
    };
    Ok((windows::core::GUID::from_u128(u.as_u128()), u.to_string()))
}

/// 属性名 → WinRT 属性位。未知名字直接报错，避免"配了不生效的属性还去怀疑设备"。
fn ble_periph_props_from_names(names: &[String]) -> Result<GattCharacteristicProperties, String> {
    let mut p = GattCharacteristicProperties::None;
    for n in names {
        p |= match n.trim() {
            "read" => GattCharacteristicProperties::Read,
            "write" => GattCharacteristicProperties::Write,
            "write_without_response" => GattCharacteristicProperties::WriteWithoutResponse,
            "notify" => GattCharacteristicProperties::Notify,
            "indicate" => GattCharacteristicProperties::Indicate,
            "broadcast" => GattCharacteristicProperties::Broadcast,
            other => return Err(format!("不支持的属性: {other}")),
        };
    }
    if p == GattCharacteristicProperties::None {
        return Err("特征至少要有一个属性".to_string());
    }
    Ok(p)
}

fn ble_periph_props_to_names(p: GattCharacteristicProperties) -> Vec<&'static str> {
    let mut v = Vec::new();
    if p.contains(GattCharacteristicProperties::Read) { v.push("read"); }
    if p.contains(GattCharacteristicProperties::Write) { v.push("write"); }
    if p.contains(GattCharacteristicProperties::WriteWithoutResponse) { v.push("write_without_response"); }
    if p.contains(GattCharacteristicProperties::Notify) { v.push("notify"); }
    if p.contains(GattCharacteristicProperties::Indicate) { v.push("indicate"); }
    if p.contains(GattCharacteristicProperties::Broadcast) { v.push("broadcast"); }
    v
}

fn ble_periph_adv_status(s: GattServiceProviderAdvertisementStatus) -> &'static str {
    match s.0 {
        0 => "Created",
        1 => "Stopped",
        2 => "Started",
        3 => "Aborted",
        4 => "StartedWithoutAllAdvertisementData",
        _ => "Unknown",
    }
}

/// WinRT 的 GattSession.DeviceId 形如 `BluetoothLE#BluetoothLE<本机MAC>-<对端MAC>`。
/// 取末尾的 MAC 更利于用户辨认（"到底是哪台手机连上来的"）；解析不出来就原样返回。
fn ble_periph_parse_device_id(raw: &str) -> String {
    if let Some(pos) = raw.rfind('-') {
        let tail = &raw[pos + 1..];
        let ok = tail.len() == 17
            && tail.as_bytes().iter().enumerate().all(|(i, b)| {
                if i % 3 == 2 { *b == b':' } else { b.is_ascii_hexdigit() }
            });
        if ok {
            return tail.to_ascii_uppercase();
        }
    }
    raw.to_string()
}

fn ble_periph_peer_of(session: Option<&GattSession>) -> String {
    let s = match session {
        Some(s) => s,
        None => return String::new(),
    };
    match s.DeviceId().and_then(|d| d.Id()) {
        Ok(h) => ble_periph_parse_device_id(&h.to_string()),
        Err(_) => String::new(),
    }
}

/// 字节 → WinRT IBuffer（特征值 / 广播服务数据都要用）
fn ble_periph_to_buffer(data: &[u8]) -> Result<IBuffer, String> {
    let w = DataWriter::new().map_err(|e| format!("创建数据写入器失败: {e}"))?;
    w.WriteBytes(data).map_err(|e| format!("写入缓冲失败: {e}"))?;
    w.DetachBuffer().map_err(|e| format!("取出缓冲失败: {e}"))
}

/// WinRT IBuffer → 字节
fn ble_periph_from_buffer(buf: &IBuffer) -> Vec<u8> {
    let len = buf.Length().unwrap_or(0) as usize;
    if len == 0 {
        return Vec::new();
    }
    let mut out = vec![0u8; len];
    if let Ok(r) = DataReader::FromBuffer(buf) {
        let _ = r.ReadBytes(&mut out);
    }
    out
}

/// 给一个本地特征挂上读 / 写 / 订阅三组回调。
/// 读和写都要先取 Deferral 再异步应答（WinRT 的标准姿势）——
/// 同步 block_on 会占住回调线程，一旦完成回调也要同一个线程就死锁。
fn ble_periph_attach_handlers(
    ch: &GattLocalCharacteristic,
    uuid: &str,
    value: std::sync::Arc<Mutex<Vec<u8>>>,
    subscribed: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    max_notify: std::sync::Arc<std::sync::atomic::AtomicU16>,
    pending_writes: std::sync::Arc<Mutex<std::collections::HashMap<u64, BlePeriphPendingWrite>>>,
    write_seq: std::sync::Arc<std::sync::atomic::AtomicU64>,
    manual_write_reply: std::sync::Arc<std::sync::atomic::AtomicBool>,
    events: std::sync::Arc<Mutex<std::collections::VecDeque<serde_json::Value>>>,
) -> Result<(), String> {
    // ---- 主机读：把当前值回过去 ----
    {
        let value = value.clone();
        let events = events.clone();
        let uuid = uuid.to_string();
        ch.ReadRequested(&windows::Foundation::TypedEventHandler::<
            GattLocalCharacteristic,
            GattReadRequestedEventArgs,
        >::new(move |_sender, args| {
            let args = match args.as_ref() {
                Some(a) => a,
                None => return Ok(()),
            };
            let deferral = args.GetDeferral()?;
            let peer = ble_periph_peer_of(args.Session().ok().as_ref());
            let op = match args.GetRequestAsync() {
                Ok(o) => o,
                Err(e) => {
                    let _ = deferral.Complete();
                    return Err(e);
                }
            };
            let value = value.clone();
            let events = events.clone();
            let uuid = uuid.clone();
            tauri::async_runtime::spawn(async move {
                let bytes = value.lock().unwrap_or_else(|e| e.into_inner()).clone();
                let mut note = String::new();
                if let Ok(req) = op.await {
                    match ble_periph_to_buffer(&bytes) {
                        Ok(buf) => {
                            if let Err(e) = req.RespondWithValue(&buf) {
                                note = format!("应答失败: {e}");
                            }
                        }
                        Err(e) => {
                            let _ = req.RespondWithProtocolError(0x80); // 0x80 = Application Error
                            note = e;
                        }
                    }
                }
                ble_periph_emit(&events, ble_periph_data_event("read", &uuid, &bytes, &peer, &note));
                let _ = deferral.Complete();
            });
            Ok(())
        }))
        .map_err(|e| format!("注册读回调失败: {e}"))?;
    }

    // ---- 主机写：记录 + 更新本地值 + 按需回写响应 ----
    {
        let value = value.clone();
        let events = events.clone();
        let uuid = uuid.to_string();
        ch.WriteRequested(&windows::Foundation::TypedEventHandler::<
            GattLocalCharacteristic,
            GattWriteRequestedEventArgs,
        >::new(move |_sender, args| {
            let args = match args.as_ref() {
                Some(a) => a,
                None => return Ok(()),
            };
            let deferral = args.GetDeferral()?;
            let peer = ble_periph_peer_of(args.Session().ok().as_ref());
            let op = match args.GetRequestAsync() {
                Ok(o) => o,
                Err(e) => {
                    let _ = deferral.Complete();
                    return Err(e);
                }
            };
            let value = value.clone();
            let events = events.clone();
            let uuid = uuid.clone();
            let pending = pending_writes.clone();
            let seq = write_seq.clone();
            let manual = manual_write_reply.clone();
            tauri::async_runtime::spawn(async move {
                let mut bytes = Vec::new();
                let mut note = String::new();
                let mut offset = 0usize;
                if let Ok(req) = op.await {
                    if let Ok(buf) = req.Value() {
                        bytes = ble_periph_from_buffer(&buf);
                    }
                    offset = req.Offset().unwrap_or(0) as usize;
                    // 落值：**按 Offset 写**。长写会被拆成多段，忽略 Offset 会把值写乱。
                    {
                        let mut v = value.lock().unwrap_or_else(|e| e.into_inner());
                        ble_periph_apply_write(&mut v, offset, &bytes);
                    }
                    // 「无响应写」调 Respond() 会返回 E_ILLEGAL_METHOD_CALL，必须分开处理
                    match req.Option() {
                        Ok(GattWriteOption::WriteWithResponse) => {
                            if manual.load(std::sync::atomic::Ordering::Relaxed) {
                                // 手动应答：存下请求与 Deferral 等前端决定，这里**不** Complete
                                let id = seq.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                                pending
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner())
                                    .insert(id, BlePeriphPendingWrite {
                                        request: req,
                                        deferral: deferral.clone(),
                                        uuid: uuid.clone(),
                                    });
                                ble_periph_emit(&events, json!({
                                    "kind": "write",
                                    "uuid": uuid,
                                    "value_hex": ble_hex(&bytes),
                                    "len": bytes.len(),
                                    "peer": peer,
                                    "note": format!("待应答 #{id}"),
                                    "offset": offset,
                                    "pending_id": id,
                                }));
                                // 兜底：用户一直不理也不能让主机永远挂着
                                let pending2 = pending.clone();
                                let events2 = events.clone();
                                let uuid2 = uuid.clone();
                                tauri::async_runtime::spawn(async move {
                                    let _ = tauri::async_runtime::spawn_blocking(|| {
                                        std::thread::sleep(std::time::Duration::from_millis(
                                            BLE_PERIPH_REPLY_TIMEOUT_MS,
                                        ))
                                    })
                                    .await;
                                    let taken = pending2
                                        .lock()
                                        .unwrap_or_else(|e| e.into_inner())
                                        .remove(&id);
                                    if let Some(w) = taken {
                                        let _ = w.request.RespondWithProtocolError(0x80);
                                        let _ = w.deferral.Complete();
                                        ble_periph_emit(&events2, json!({
                                            "kind": "write_reply",
                                            "uuid": uuid2,
                                            "pending_id": id,
                                            "note": format!("#{id} 超时未应答，已按协议错误 0x80 回复"),
                                        }));
                                    }
                                });
                                return;
                            }
                            note = "写响应".to_string();
                            if let Err(e) = req.Respond() {
                                note = format!("写响应失败: {e}");
                            }
                        }
                        Ok(_) => note = "无响应写".to_string(),
                        Err(e) => note = format!("读取写入类型失败: {e}"),
                    }
                }
                if offset > 0 {
                    note = format!("{note} · offset {offset}");
                }
                let cur = value.lock().unwrap_or_else(|e| e.into_inner()).clone();
                ble_periph_emit(&events, ble_periph_data_event("write", &uuid, &cur, &peer, &note));
                let _ = deferral.Complete();
            });
            Ok(())
        }))
        .map_err(|e| format!("注册写回调失败: {e}"))?;
    }

    // ---- 订阅变化：主机开了/关了通知 ----
    {
        let events = events.clone();
        let uuid = uuid.to_string();
        let max_notify = max_notify.clone();
        ch.SubscribedClientsChanged(&windows::Foundation::TypedEventHandler::<
            GattLocalCharacteristic,
            windows::core::IInspectable,
        >::new(move |sender, _args| {
            let sender = match sender.as_ref() {
                Some(s) => s,
                None => return Ok(()),
            };
            let mut peers = Vec::new();
            // 单次通知的最大字节数（= 协商后的 ATT_MTU - 3）。下发长数据被截断/失败时，
            // 用户最需要知道的就是这个数字，所以订阅时就一并报出来。
            let mut max_notify_size: u16 = 0;
            let count = match sender.SubscribedClients() {
                Ok(list) => {
                    let n = list.Size().unwrap_or(0);
                    for i in 0..n {
                        if let Ok(c) = list.GetAt(i) {
                            if let Ok(s) = c.Session() {
                                peers.push(ble_periph_peer_of(Some(&s)));
                            }
                            if let Ok(m) = c.MaxNotificationSize() {
                                max_notify_size = max_notify_size.max(m);
                            }
                        }
                    }
                    n
                }
                Err(_) => 0,
            };
            subscribed.store(count as usize, std::sync::atomic::Ordering::Relaxed);
            max_notify.store(max_notify_size, std::sync::atomic::Ordering::Relaxed);
            ble_periph_emit(&events, json!({
                "kind": "subscribe",
                "uuid": uuid,
                "subscribed": count,
                "max_notify": max_notify_size,
                "peer": peers.join(", "),
            }));
            Ok(())
        }))
        .map_err(|e| format!("注册订阅回调失败: {e}"))?;
    }

    Ok(())
}

/// 建服务提供者。重复「开始广播」时上一个 provider 刚释放，Windows 可能还占着这个 UUID
/// （ResourceInUse 等）—— 等一拍重试一次即可。
async fn ble_periph_create_provider(guid: windows::core::GUID) -> Result<GattServiceProvider, String> {
    let mut last = String::new();
    for attempt in 0..2 {
        if attempt > 0 {
            let _ = tauri::async_runtime::spawn_blocking(|| {
                std::thread::sleep(std::time::Duration::from_millis(300))
            })
            .await;
        }
        let op = GattServiceProvider::CreateAsync(guid)
            .map_err(|e| format!("创建 GATT 服务失败: {e}"))?;
        let res = op.await.map_err(|e| format!("创建 GATT 服务失败: {e}"))?;
        let err = res.Error().map_err(|e| format!("读取服务错误码失败: {e}"))?;
        if err == BluetoothError::Success {
            return res.ServiceProvider().map_err(|e| format!("获取服务提供者失败: {e}"));
        }
        last = format!("{err:?}");
        // ResourceInUse 是文档里的"UUID 还被占着"；其余错误码 Windows 之间不一致，
        // 多试一次没有副作用（多等 300ms），不值得为它写一张映射表
    }
    Err(format!(
        "创建 GATT 服务失败: {last}（该服务 UUID 可能已被系统或其它程序占用）"
    ))
}

fn ble_periph_stop_inner(state: &BlePeripheralState) -> bool {
    let provider = state.provider.lock().unwrap_or_else(|e| e.into_inner()).take();
    let was = provider.is_some();
    if let Some(p) = provider {
        let _ = p.StopAdvertising();
    }
    // 待应答的写请求要收干净：不回的话主机会一直挂着等响应
    {
        let mut pending = state.pending_writes.lock().unwrap_or_else(|e| e.into_inner());
        for (_, w) in pending.drain() {
            let _ = w.request.RespondWithProtocolError(0x80);
            let _ = w.deferral.Complete();
        }
    }
    state.chars.lock().unwrap_or_else(|e| e.into_inner()).clear();
    *state.service_uuid.lock().unwrap_or_else(|e| e.into_inner()) = None;
    state.running.store(false, std::sync::atomic::Ordering::Relaxed);
    was
}

/// 等广播状态落定：`StartAdvertisingWithParameters` 返回 Ok **不代表真的在广播**。
/// 没有蓝牙适配器或蓝牙被关时状态会停在 `Aborted`（本机实测：无射频环境下必然如此）。
async fn ble_periph_settle_adv_status(provider: &GattServiceProvider) -> &'static str {
    let mut status = "Created";
    for _ in 0..8 {
        match provider.AdvertisementStatus() {
            Ok(s) => {
                status = ble_periph_adv_status(s);
                // Created/Stopped 是"还没起来"的中间态，继续等；Started/Aborted 是终态
                if status != "Created" && status != "Stopped" {
                    break;
                }
            }
            Err(_) => break,
        }
        let _ = tauri::async_runtime::spawn_blocking(|| {
            std::thread::sleep(std::time::Duration::from_millis(200))
        })
        .await;
    }
    status
}

fn ble_periph_adv_ok(status: &str) -> bool {
    status == "Started" || status == "StartedWithoutAllAdvertisementData"
}

/// 广播没起来时的可操作提示。
/// 走到这里说明能力位与电源状态都正常、权限也没有被策略拒绝 —— 本机实测（Intel 适配器）就是这种情况。
/// **逐字段实测的结论**：这块射频能发广播（仅厂商数据时 `Started`），但带「广播名」或
/// 「服务 UUID」的广播一律被拒（`E_INVALIDARG`）；而 `GattServiceProvider` 必须广播自己的
/// 服务 UUID，所以恒 `Aborted`。故文案指向"服务 UUID 类广播被拒"这个真实现象，
/// 而不是笼统地让人换适配器。
fn ble_periph_adv_warning(status: &str) -> Option<&'static str> {
    match status {
        "Aborted" => Some(
            "广播被系统中止：本机实测**能**发广播，但带「广播名 / 服务 UUID」的广播会被系统拒绝，\
             而 GATT 服务必须广播服务 UUID。可能是该适配器/驱动的限制，也可能是非打包桌面应用的\
             平台限制（缺应用标识）。可用一个已打包的 BLE 外设工具在本机试同一个服务来区分 —— \
             详见 doc/BLE_PERIPHERAL.md 第 5 节",
        ),
        "StartedWithoutAllAdvertisementData" => Some(
            "广播已启动，但**部分数据没发出去**（被系统截断）：传统广播总共只有 31 字节，\
             服务数据/UUID 加起来超了。请把「广播服务数据」改短或留空",
        ),
        "Created" | "Stopped" => Some("广播尚未生效（状态仍为未启动），可停止后重试"),
        _ => None,
    }
}

fn ble_periph_status_json(state: &BlePeripheralState) -> serde_json::Value {
    let advertising_status = {
        let p = state.provider.lock().unwrap_or_else(|e| e.into_inner()).clone();
        match p.and_then(|p| p.AdvertisementStatus().ok()) {
            Some(s) => ble_periph_adv_status(s),
            None => "Stopped",
        }
    };
    let chars: Vec<serde_json::Value> = state
        .chars
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .map(|c| {
            json!({
                "uuid": c.uuid,
                "props": c.props,
                "value_hex": ble_hex(&c.value.lock().unwrap_or_else(|e| e.into_inner())),
                "subscribed": c.subscribed.load(std::sync::atomic::Ordering::Relaxed),
                "max_notify": c.max_notify.load(std::sync::atomic::Ordering::Relaxed),
                "descriptors": c.descriptors,
            })
        })
        .collect();
    let service_uuid = state.service_uuid.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let adapter = state.adapter.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let running = state.running.load(std::sync::atomic::Ordering::Relaxed);
    let manual_reply = state.manual_write_reply.load(std::sync::atomic::Ordering::Relaxed);
    let pending_count = state.pending_writes.lock().unwrap_or_else(|e| e.into_inner()).len();
    // 告警分两级：
    //  - **阻断级**（能力/权限问题）只在广播确实没起来时报 —— 广播起来就别吓唬人，能力位有假阴性；
    //  - **提示级**（广播起来了但数据被截断）任何时候都要报，否则用户不知道发出去的不全。
    let blocking: Option<String> = if !running || ble_periph_adv_ok(advertising_status) {
        None
    } else {
        ble_periph_probe_warning(&adapter)
            .map(|s| s.to_string())
            .or_else(|| ble_periph_adv_warning(advertising_status).map(|s| s.to_string()))
    };
    let warning = blocking.or_else(|| {
        if running {
            ble_periph_adv_warning(advertising_status).map(|s| s.to_string())
        } else {
            None
        }
    });
    json!({
        "running": running,
        // running 只表示"服务建好了"；真正对外可被搜到要看 advertising。
        // 分开报是为了不让"建好了服务但广播被中止"显示成一切正常。
        "advertising": running && ble_periph_adv_ok(advertising_status),
        "advertising_status": advertising_status,
        "warning": warning,
        "adapter": adapter.to_json(),
        "manual_write_reply": manual_reply,
        "pending_writes": pending_count,
        "service_uuid": service_uuid,
        "characteristics": chars,
    })
}

#[derive(serde::Deserialize)]
struct BlePeriphDescSpec {
    uuid: String,
    #[serde(default)]
    value: Vec<u8>,
}

#[derive(serde::Deserialize)]
struct BlePeriphCharSpec {
    uuid: String,
    props: Vec<String>,
    #[serde(default)]
    value: Vec<u8>,
    /// 该特征下的自定义描述符（可选）
    #[serde(default)]
    descriptors: Vec<BlePeriphDescSpec>,
}

/// 启动从机广播：建本地 GATT 服务（1 个服务 + N 个特征）并开始广播。
/// 重复调用会先收掉上一次，避免残留 provider 抢同一个 UUID。
async fn ble_periph_start_inner(
    state: &BlePeripheralState,
    service_uuid: String,
    characteristics: Vec<BlePeriphCharSpec>,
    discoverable: Option<bool>,
    connectable: Option<bool>,
    adv_data: Option<Vec<u8>>,
    manual_reply: Option<bool>,
) -> Result<serde_json::Value, String> {
    if characteristics.is_empty() {
        return Err("至少需要一个特征".to_string());
    }
    if characteristics.len() > BLE_PERIPH_CHAR_MAX {
        return Err(format!("特征数量上限 {BLE_PERIPH_CHAR_MAX} 个"));
    }
    ble_periph_stop_inner(state);
    state
        .manual_write_reply
        .store(manual_reply.unwrap_or(false), std::sync::atomic::Ordering::Relaxed);
    let adv_data = adv_data.unwrap_or_default();
    // 长度只是提示，不阻断：真正的判定以后端返回的广播状态为准
    let adv_data_note = ble_periph_adv_data_warn(adv_data.len());
    // 启动前先探适配器能力：不是为了提前失败，而是为了把"为什么搜不到"说清楚。
    // 服务与特征照建不误 —— 用户可以先配好、看到特征树，打开蓝牙后直接「重新广播」。
    let info = ble_periph_probe_adapter().await;
    *state.adapter.lock().unwrap_or_else(|e| e.into_inner()) = info.clone();
    let (svc_guid, svc_str) = ble_periph_guid(&service_uuid)?;
    let provider = ble_periph_create_provider(svc_guid).await?;
    let service = provider.Service().map_err(|e| format!("获取本地服务失败: {e}"))?;

    let mut built: Vec<BlePeriphChar> = Vec::new();
    for spec in &characteristics {
        let (guid, uuid_str) = ble_periph_guid(&spec.uuid)?;
        if built.iter().any(|c| c.uuid == uuid_str) {
            return Err(format!("特征 UUID 重复: {uuid_str}"));
        }
        let props = ble_periph_props_from_names(&spec.props)?;
        let params = GattLocalCharacteristicParameters::new()
            .map_err(|e| format!("创建特征参数失败: {e}"))?;
        params
            .SetCharacteristicProperties(props)
            .map_err(|e| format!("设置特征属性失败: {e}"))?;
        // 调试场景一律不做配对/加密：否则主机"只是来读一下"也要先配对，白白卡住
        params
            .SetReadProtectionLevel(GattProtectionLevel::Plain)
            .map_err(|e| format!("设置读保护级别失败: {e}"))?;
        params
            .SetWriteProtectionLevel(GattProtectionLevel::Plain)
            .map_err(|e| format!("设置写保护级别失败: {e}"))?;
        let op = service
            .CreateCharacteristicAsync(guid, &params)
            .map_err(|e| format!("创建特征 {uuid_str} 失败: {e}"))?;
        let cres = op.await.map_err(|e| format!("创建特征 {uuid_str} 失败: {e}"))?;
        let cerr = cres.Error().map_err(|e| format!("读取特征错误码失败: {e}"))?;
        if cerr != BluetoothError::Success {
            return Err(format!("创建特征 {uuid_str} 失败: {cerr:?}"));
        }
        let ch = cres.Characteristic().map_err(|e| format!("获取特征对象失败: {e}"))?;
        let value = std::sync::Arc::new(Mutex::new(spec.value.clone()));
        let subs = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let max_notify = std::sync::Arc::new(std::sync::atomic::AtomicU16::new(0));
        ble_periph_attach_handlers(
            &ch,
            &uuid_str,
            value.clone(),
            subs.clone(),
            max_notify.clone(),
            state.pending_writes.clone(),
            state.write_seq.clone(),
            state.manual_write_reply.clone(),
            state.events.clone(),
        )?;
        // 自定义描述符（如 0x2901 用户描述）：WinRT 的本地描述符只支持静态值，够用了
        let mut desc_uuids: Vec<String> = Vec::new();
        for d in &spec.descriptors {
            let (dguid, duuid) = ble_periph_guid(&d.uuid)?;
            // 标准描述符由系统自动发布，手工创建必失败 —— 本地先挡掉并说清原因
            if let Ok(du) = uuid::Uuid::parse_str(&duuid) {
                if let Some(msg) = ble_periph_desc_reserved(ble_periph_uuid_short(&du)) {
                    return Err(format!("描述符 {duuid} 不能手工创建：{msg}"));
                }
            }
            let dparams = GattLocalDescriptorParameters::new()
                .map_err(|e| format!("创建描述符参数失败: {e}"))?;
            dparams
                .SetReadProtectionLevel(GattProtectionLevel::Plain)
                .map_err(|e| format!("设置描述符读保护级别失败: {e}"))?;
            dparams
                .SetWriteProtectionLevel(GattProtectionLevel::Plain)
                .map_err(|e| format!("设置描述符写保护级别失败: {e}"))?;
            if !d.value.is_empty() {
                let buf = ble_periph_to_buffer(&d.value)?;
                dparams
                    .SetStaticValue(&buf)
                    .map_err(|e| format!("设置描述符静态值失败: {e}"))?;
            }
            let dop = ch
                .CreateDescriptorAsync(dguid, &dparams)
                .map_err(|e| format!("创建描述符 {duuid} 失败: {e}"))?;
            let dres = dop.await.map_err(|e| format!("创建描述符 {duuid} 失败: {e}"))?;
            dres.Descriptor().map_err(|e| format!("创建描述符 {duuid} 失败: {e}"))?;
            desc_uuids.push(duuid);
        }
        built.push(BlePeriphChar {
            uuid: uuid_str,
            props: ble_periph_props_to_names(props).into_iter().map(|s| s.to_string()).collect(),
            value,
            subscribed: subs,
            max_notify,
            descriptors: desc_uuids,
            characteristic: ch,
        });
    }

    // 广播状态变化：StartedWithoutAllAdvertisementData / Aborted 正是"主机搜不到"的线索
    {
        let events = state.events.clone();
        let _ = provider.AdvertisementStatusChanged(&windows::Foundation::TypedEventHandler::<
            GattServiceProvider,
            GattServiceProviderAdvertisementStatusChangedEventArgs,
        >::new(move |_sender, args| {
            let status = match args.as_ref().and_then(|a| a.Status().ok()) {
                Some(s) => ble_periph_adv_status(s),
                None => "Unknown",
            };
            ble_periph_emit(&events, json!({ "kind": "adv", "status": status }));
            Ok(())
        }));
    }

    let adv = GattServiceProviderAdvertisingParameters::new()
        .map_err(|e| format!("创建广播参数失败: {e}"))?;
    adv.SetIsDiscoverable(discoverable.unwrap_or(true))
        .map_err(|e| format!("设置「可被发现」失败: {e}"))?;
    adv.SetIsConnectable(connectable.unwrap_or(true))
        .map_err(|e| format!("设置「可连接」失败: {e}"))?;
    let adv_len = adv_data.len();
    if !adv_data.is_empty() {
        let buf = ble_periph_to_buffer(&adv_data)?;
        adv.SetServiceData(&buf)
            .map_err(|e| format!("设置广播服务数据失败: {e}"))?;
    }
    provider
        .StartAdvertisingWithParameters(&adv)
        .map_err(|e| format!("启动广播失败: {e}"))?;
    let adv_status = ble_periph_settle_adv_status(&provider).await;

    *state.service_uuid.lock().unwrap_or_else(|e| e.into_inner()) = Some(svc_str.clone());
    *state.chars.lock().unwrap_or_else(|e| e.into_inner()) = built;
    *state.provider.lock().unwrap_or_else(|e| e.into_inner()) = Some(provider);
    state.running.store(true, std::sync::atomic::Ordering::Relaxed);
    ble_periph_emit(
        &state.events,
        json!({
            "kind": "start",
            "uuid": svc_str,
            "note": format!(
                "{} 个特征 · 广播数据 {} 字节 · {adv_status}{}",
                characteristics.len(),
                adv_len,
                if manual_reply.unwrap_or(false) { " · 写入需手动应答" } else { "" },
            ),
        }),
    );
    if let Some(n) = adv_data_note {
        ble_periph_emit(&state.events, json!({ "kind": "notice", "note": n }));
    }
    Ok(ble_periph_status_json(state))
}

#[tauri::command]
async fn ble_periph_start(
    state: tauri::State<'_, BlePeripheralState>,
    service_uuid: String,
    characteristics: Vec<BlePeriphCharSpec>,
    discoverable: Option<bool>,
    connectable: Option<bool>,
    adv_data: Option<Vec<u8>>,
    manual_reply: Option<bool>,
) -> Result<serde_json::Value, String> {
    ble_periph_start_inner(
        &state,
        service_uuid,
        characteristics,
        discoverable,
        connectable,
        adv_data,
        manual_reply,
    )
    .await
}

/// 对一条待应答的写请求作出决定：接受，或按协议错误码拒绝（默认 0x80 Application Error）。
#[tauri::command]
async fn ble_periph_respond_write(
    state: tauri::State<'_, BlePeripheralState>,
    pending_id: u64,
    accept: bool,
    protocol_error: Option<u8>,
) -> Result<(), String> {
    let w = state
        .pending_writes
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&pending_id)
        .ok_or_else(|| format!("没有待应答的写入 #{pending_id}（可能已超时或已应答过）"))?;
    let note = if accept {
        w.request
            .Respond()
            .map(|_| "已接受".to_string())
            .map_err(|e| format!("应答失败: {e}"))?
    } else {
        let code = protocol_error.unwrap_or(0x80);
        w.request
            .RespondWithProtocolError(code)
            .map(|_| format!("已按协议错误 0x{code:02X} 回复"))
            .map_err(|e| format!("应答失败: {e}"))?
    };
    let _ = w.deferral.Complete();
    ble_periph_emit(
        &state.events,
        json!({ "kind": "write_reply", "uuid": w.uuid, "pending_id": pending_id,
                "note": format!("#{pending_id} {note}") }),
    );
    Ok(())
}

#[tauri::command]
async fn ble_periph_stop(state: tauri::State<'_, BlePeripheralState>) -> Result<serde_json::Value, String> {
    let was = ble_periph_stop_inner(&state);
    ble_periph_emit(&state.events, json!({ "kind": "stop" }));
    Ok(json!({ "stopped": was }))
}

#[tauri::command]
async fn ble_periph_status(state: tauri::State<'_, BlePeripheralState>) -> Result<serde_json::Value, String> {
    Ok(ble_periph_status_json(&state))
}

/// 改某个特征的可读值（主机下次读到的就是它）
fn ble_periph_set_value_inner(
    state: &BlePeripheralState,
    char_uuid: &str,
    data: Vec<u8>,
) -> Result<(), String> {
    let (val, readable) = {
        let chars = state.chars.lock().unwrap_or_else(|e| e.into_inner());
        let c = chars
            .iter()
            .find(|c| c.uuid.eq_ignore_ascii_case(char_uuid))
            .ok_or_else(|| format!("未找到从机特征: {char_uuid}"))?;
        (c.value.clone(), ble_periph_props_readable(&c.props))
    };
    // 不可读的特征主机取不到，那个值只反映"主机刚写进来什么" —— 设值没有意义，
    // 早点报错比静默接受好（前端也会把这个入口藏起来，这里是第二道）
    if !readable {
        return Err(format!("特征 {char_uuid} 没有 read 属性：主机读不到它，设置可读值没有意义"));
    }
    *val.lock().unwrap_or_else(|e| e.into_inner()) = data;
    Ok(())
}

#[tauri::command]
async fn ble_periph_set_value(
    state: tauri::State<'_, BlePeripheralState>,
    char_uuid: String,
    data: Vec<u8>,
) -> Result<(), String> {
    ble_periph_set_value_inner(&state, &char_uuid, data)
}

/// 主动向已订阅的主机下发通知（Notify / Indicate 都走这里）
async fn ble_periph_notify_inner(
    state: &BlePeripheralState,
    char_uuid: &str,
    data: Vec<u8>,
) -> Result<serde_json::Value, String> {
    let (ch, subs, max_notify) = {
        let chars = state.chars.lock().unwrap_or_else(|e| e.into_inner());
        let c = chars
            .iter()
            .find(|c| c.uuid.eq_ignore_ascii_case(char_uuid))
            .ok_or_else(|| format!("未找到从机特征: {char_uuid}"))?;
        (
            c.characteristic.clone(),
            c.subscribed.load(std::sync::atomic::Ordering::Relaxed),
            c.max_notify.load(std::sync::atomic::Ordering::Relaxed),
        )
    };
    if !ch
        .CharacteristicProperties()
        .map(|p| p.contains(GattCharacteristicProperties::Notify) || p.contains(GattCharacteristicProperties::Indicate))
        .unwrap_or(false)
    {
        return Err("该特征没有 notify / indicate 属性，无法下发".to_string());
    }
    if subs == 0 {
        return Err("还没有主机订阅该特征（请先在主机侧打开通知）".to_string());
    }
    ble_periph_notify_size_check(data.len(), max_notify)?;
    // IBuffer 不是 Send：必须在 await 之前把它丢掉，否则整个 command 的 future 不 Send。
    // NotifyValueAsync 已经把缓冲引用进去了，调用返回后本地这份就不需要了。
    let op = {
        let buf = ble_periph_to_buffer(&data)?;
        ch.NotifyValueAsync(&buf).map_err(|e| format!("下发失败: {e}"))?
    };
    let results = op.await.map_err(|e| format!("下发失败: {e}"))?;
    let mut sent = Vec::new();
    let n = results.Size().unwrap_or(0);
    for i in 0..n {
        if let Ok(r) = results.GetAt(i) {
            let peer = r
                .SubscribedClient()
                .ok()
                .and_then(|c| c.Session().ok())
                .map(|s| ble_periph_peer_of(Some(&s)))
                .unwrap_or_default();
            sent.push(json!({
                "peer": peer,
                "status": match r.Status() { Ok(GattCommunicationStatus::Success) => "Success", Ok(_) => "Failed", Err(_) => "Unknown" },
                "bytes": r.BytesSent().unwrap_or(0),
            }));
        }
    }
    ble_periph_emit(
        &state.events,
        ble_periph_data_event("notify", char_uuid, &data, "", &format!("已下发 {} 个订阅者", sent.len())),
    );
    Ok(json!({ "count": sent.len(), "sent": sent }))
}

#[tauri::command]
async fn ble_periph_notify(
    state: tauri::State<'_, BlePeripheralState>,
    char_uuid: String,
    data: Vec<u8>,
) -> Result<serde_json::Value, String> {
    ble_periph_notify_inner(&state, &char_uuid, data).await
}

#[tauri::command]
async fn ble_periph_poll_events(
    state: tauri::State<'_, BlePeripheralState>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut q = state.events.lock().unwrap_or_else(|e| e.into_inner());
    Ok(q.drain(..).collect())
}

/// 从机配置：弹文件框选一个表格文件（CSV / Markdown），返回 `{path, text}`；取消返回 None。
/// 文件读写放在后端：`capabilities/default.json` 里只有 `core:*`，没有 fs 插件权限，
/// 而且路径必须由用户在原生对话框里亲自选。
#[tauri::command]
fn ble_periph_pick_config_file() -> Result<Option<serde_json::Value>, String> {
    let picked = rfd::FileDialog::new()
        .set_title("选择广播配置表格")
        .add_filter("表格文件", &["csv", "md", "markdown", "txt"])
        .pick_file();
    let path = match picked {
        Some(p) => p,
        None => return Ok(None),
    };
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
    Ok(Some(json!({
        "path": path.to_string_lossy(),
        "text": text,
    })))
}

/// 从机配置：弹保存框把表格写到文件，返回路径（取消返回 None）。
#[tauri::command]
fn ble_periph_save_config_file(text: String) -> Result<Option<String>, String> {
    let picked = rfd::FileDialog::new()
        .set_title("导出广播配置表格")
        .set_file_name("ble-peripheral-config.csv")
        .add_filter("CSV 表格", &["csv"])
        .add_filter("Markdown 表格", &["md"])
        .save_file();
    let path = match picked {
        Some(p) => p,
        None => return Ok(None),
    };
    std::fs::write(&path, text.as_bytes())
        .map_err(|e| format!("写入 {} 失败: {e}", path.display()))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[cfg(test)]
mod log_maintenance_tests {
    use super::*;

    // ===== WSL bridge 起不来时的报错文案 =====
    // 这两种情况原先都只报一句"bridge 启动超时"，用户完全没有下手处。

    #[test]
    fn bridge_startup_error_separates_exited_from_slow() {
        assert_eq!(
            bridge_startup_error(true, ""),
            "bridge 启动失败（进程已退出）",
            "进程已退出但 stderr 空着时也要说清是「退出」而不是「超时」"
        );
        assert_eq!(
            bridge_startup_error(false, "   "),
            "bridge 启动超时（5 秒内没等到 ready）",
            "还活着没打 ready 才是真的超时"
        );
    }

    #[test]
    fn bridge_startup_error_carries_stderr_and_hint() {
        let m = bridge_startup_error(true, "python3: command not found");
        assert!(m.contains("python3: command not found"), "原始 stderr 必须带上: {}", m);
        assert!(m.contains("apt install -y python3"), "缺 python3 时给可执行提示: {}", m);

        let m2 = bridge_startup_error(true, "sg: group 'dialout' does not exist");
        assert!(m2.contains("sg: group"), "{}", m2);
        assert!(m2.contains("uucp"), "dialout 组不存在时指出发行版差异: {}", m2);

        let m3 = bridge_startup_error(true, "python3: can't open file '/tmp/seahi_serial_bridge.py'");
        assert!(m3.contains("/tmp"), "脚本没落地时提示 /tmp: {}", m3);

        let m4 = bridge_startup_error(true, "some unexpected failure");
        assert!(!m4.contains("【"), "认不出的 stderr 不乱猜原因: {}", m4);
    }

    /// `sg` 不存在时**必须**给出"装 shadow"，而不是"你不在 dialout 组里"。
    ///
    /// 这条是 issue #21 的正身：用户在 WSL 分栏点「开始监控」拿到的是
    /// `<3>WSL (…) ERROR: CreateProcessCommon:818: execvpe(sg) failed: No such file or directory`
    /// —— 原文既没有 `sg:` 也没有 `dialout`，旧的分支链**一个都不命中**，
    /// 于是只把原始 WSL 报错丢给用户，没有任何下手处。
    #[test]
    fn bridge_stderr_hint_recognizes_missing_sg() {
        // WSL relay 的真实原文（issue #21 截图里那句）
        let relay = "<3>WSL (744341 - Relay) ERROR: CreateProcessCommon:818: execvpe(sg) failed: No such file or directory";
        let m = bridge_startup_error(true, relay);
        assert!(m.contains("execvpe(sg)"), "原始 stderr 要原样带上: {}", m);
        assert!(m.contains("shadow"), "缺 sg 要提示装 shadow 包: {}", m);
        assert!(!m.contains("uucp"), "别退化成'你不在 dialout 组里'（那不是这个原因）: {}", m);

        // shell 报的另外两种写法也要认
        for s in ["sg: not found", "bash: sg: command not found"] {
            let h = bridge_stderr_hint(s).unwrap_or("");
            assert!(h.contains("shadow"), "{} 应识别为缺 sg，实际: {}", s, h);
        }
        // 「sg 在，但组不对」仍走原来那条（顺序不能颠倒 —— `sg: not found` 也含 `sg:`）
        let g = bridge_stderr_hint("sg: group 'dialout' does not exist").unwrap_or("");
        assert!(g.contains("uucp"), "组不存在仍是原来那条提示: {}", g);
    }

    /// `sg` 有就带切组、没有就直接跑 python3 —— 这条是 #21 的修法本身。
    #[test]
    fn bridge_wsl_args_falls_back_when_sg_is_missing() {
        let with = bridge_wsl_args("Ubuntu", true);
        assert_eq!(
            with,
            vec!["-d", "Ubuntu", "-e", "sg", "dialout", "-c", "python3 /tmp/seahi_serial_bridge.py"],
            "有 sg：保持原来那条切组路径（组集合过期的用户就靠它）"
        );
        let without = bridge_wsl_args("Alpine", false);
        assert_eq!(
            without,
            vec!["-d", "Alpine", "-e", "python3", "/tmp/seahi_serial_bridge.py"],
            "没有 sg：**不能**再硬写 -e sg（WSL relay 会 execvpe 失败，监视器永远打不开）"
        );
        // 关键不变量：无论哪条路，`-d <distro>` 与"python3 + 脚本"都得在，且不能再出现裸 `sg`。
        // 注意两条路的形态不同 —— 有 sg 时"python3 <脚本>"是**一个** argv（交给 `sg -c` 解析），
        // 没有时是**两个** argv（直接 execvp）。所以这里 join 起来看。
        for (args, sg) in [(&with, true), (&without, false)] {
            assert_eq!(args[0], "-d");
            assert_eq!(args[1], if sg { "Ubuntu" } else { "Alpine" });
            let joined = args.join(" ");
            assert!(joined.contains("python3 /tmp/seahi_serial_bridge.py"), "{}", joined);
            assert_eq!(args.iter().filter(|a| *a == "sg").count(), if sg { 1 } else { 0 });
        }
    }

    /// "能不能非交互切组"的探测结果 → 用不用 `sg`。
    ///
    /// 重点是那条**故意的不对称**：**拿不准（超时）时不用**。
    /// 用错的代价是 issue #21 那两种死法（`execvpe(sg)` 起不来 / `sg` 卡在密码提示上，
    /// 两者都表现为"整条链路不可用、提示还看不出原因"），
    /// 不用的代价只是"权限不够时 bridge 回一句 `sudo chmod 666`"——可操作得多。
    /// 若有人为了"保守起见沿用旧行为"把它改成 `true`，这个测试会红。
    #[test]
    fn bridge_use_sg_prefers_plain_python3_when_unsure() {
        assert!(bridge_use_sg(Some(true)), "确认能非交互切组 → 用 sg（会话组集合过期的用户靠它）");
        assert!(!bridge_use_sg(Some(false)), "确认切不了（没装 sg / 不在组里 / 组名不同）→ 别用");
        assert!(!bridge_use_sg(None), "探测超时（可能正卡在密码提示上）→ 也不能用；别退回旧的硬写行为");
    }

    /// 每个测试用独立临时目录（带 tag + pid），避免并行执行时互相踩
    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("seahi-test-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("创建测试临时目录");
        d
    }

    // ===== L3a：调试日志轮转 =====

    #[test]
    fn debug_log_rotate_decision_respects_limit() {
        assert!(
            !debug_log_needs_rotate(0, 100, 1000),
            "空文件不该轮转（无意义的 rename）"
        );
        assert!(!debug_log_needs_rotate(900, 100, 1000), "正好等于上限时不轮转");
        assert!(debug_log_needs_rotate(901, 100, 1000), "超出上限必须轮转");
        assert!(
            debug_log_needs_rotate(DEBUG_LOG_MAX_BYTES, 1, DEBUG_LOG_MAX_BYTES),
            "已达上限后再写一行就要轮转"
        );
    }

    #[test]
    fn debug_log_rotate_replaces_old_backup() {
        let dir = tmp_dir("dbglog");
        let path = dir.join("seahi-serial-debug.log");
        let backup = dir.join("seahi-serial-debug.log.1");
        std::fs::write(&path, "old-content").unwrap();
        std::fs::write(&backup, "stale-backup").unwrap();

        debug_log_rotate(&path).expect("轮转应成功");

        assert!(!path.exists(), "原文件应已被改名");
        assert_eq!(
            std::fs::read_to_string(&backup).unwrap(),
            "old-content",
            "新的 .1 应是刚轮转的内容（旧 .1 被覆盖）"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ===== M28：会话缓存上限 =====

    fn touch_cache_file(dir: &std::path::Path, i: u32, size: usize) -> std::path::PathBuf {
        let p = dir.join(format!("session-20260101-{:09}-COM1.log", i));
        std::fs::write(&p, vec![b'x'; size]).unwrap();
        p
    }

    fn cache_file_names(dir: &std::path::Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .filter(|e| e.path().is_file())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn log_cache_enforces_file_count() {
        let dir = tmp_dir("cache-count");
        for i in 0..12 {
            touch_cache_file(&dir, i, 1024);
        }
        let active = std::collections::HashSet::new();

        enforce_log_cache_limit_in(&dir, 10, u64::MAX, &active);

        let files = cache_file_names(&dir);
        assert_eq!(files.len(), 10, "超过个数上限应删到 10 个");
        assert!(
            files[0].contains("000000002"),
            "应删最旧的，剩下的从第 3 个开始，实际: {}",
            files[0]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 边界：目录里**恰好**等于上限时，建新文件之前必须先腾出一格 —— 否则建完就是 `上限 + 1` 个，
    /// 声明的硬上限根本不成立。老单测从 12 个文件起步，正好绕过了 `count == max_count` 这个点。
    #[test]
    fn log_cache_makes_room_before_creating() {
        let dir = tmp_dir("cache-make-room");
        for i in 0..LOG_CACHE_MAX_COUNT {
            touch_cache_file(&dir, i as u32, 1024);
        }
        assert_eq!(cache_file_names(&dir).len(), LOG_CACHE_MAX_COUNT);
        let active = std::collections::HashSet::new();

        // 这一步正是 `append_log_cache` 建新文件之前做的事
        make_room_for_new_log_cache(&dir, &active);

        let files = cache_file_names(&dir);
        assert_eq!(
            files.len(),
            LOG_CACHE_MAX_COUNT - 1,
            "必须腾出一格：建完新文件才正好 ≤ {} 个",
            LOG_CACHE_MAX_COUNT
        );
        assert!(
            !files.iter().any(|f| f.contains("000000000")),
            "腾位时删掉的应是最旧的那个，实际: {:?}",
            files
        );

        // 模拟"建新文件"：腾位 + 新建之后，总数仍不得超过声明的硬上限
        touch_cache_file(&dir, 999, 1024);
        assert!(
            cache_file_names(&dir).len() <= LOG_CACHE_MAX_COUNT,
            "腾位 + 新建之后不得超过声明的硬上限"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 触顶（capped）的会话在**重连**时必须换一个新文件：
    /// 老实现是 `or_insert_with`，把 `capped` 一起保住了 —— 于是那个面板的日志缓存
    /// 永久失效、而且再也不会通知（只有关掉整个监视器才释放）。2026-09 审计发现。
    #[test]
    fn capped_log_cache_session_starts_a_new_file_on_reconnect() {
        let mut s = LogCacheSession {
            port_name: "COM3".into(),
            file: None,
            path: std::path::PathBuf::from("C:\\logs\\session-1-COM3.log"),
            bytes: 7 * 1024 * 1024,
            capped: true,
        };
        assert!(
            restart_capped_log_cache_session(&mut s),
            "触顶过的会话必须换新文件（否则永久静默停写）"
        );
        assert!(s.path.as_os_str().is_empty() && s.file.is_none());
        assert_eq!(s.bytes, 0);
        assert!(!s.capped, "换新文件后要能继续写（下一轮触顶还会再通知一次）");
        assert_eq!(s.port_name, "COM3", "端口名不该被这次重置弄丢");

        // 没触顶的会话保持幂等：自动重连继续写同一个文件（日志连续，这是原设计要的）
        let mut n = LogCacheSession {
            port_name: "COM3".into(),
            file: None,
            path: std::path::PathBuf::from("C:\\logs\\session-2-COM3.log"),
            bytes: 1234,
            capped: false,
        };
        let before = n.path.clone();
        assert!(!restart_capped_log_cache_session(&mut n), "没触顶就该继续用原文件");
        assert_eq!(n.path, before);
        assert_eq!(n.bytes, 1234);
    }

    #[test]
    fn log_cache_enforces_total_bytes() {
        let dir = tmp_dir("cache-bytes");
        for i in 0..10 {
            touch_cache_file(&dir, i, 1024);
        }
        let active = std::collections::HashSet::new();

        // 个数上限放宽到 100，只靠 3 KiB 的总预算来限制
        enforce_log_cache_limit_in(&dir, 100, 3 * 1024, &active);

        let files = cache_file_names(&dir);
        assert_eq!(files.len(), 3, "总字节超预算应删到 3 个");
        assert!(
            files[0].contains("000000007"),
            "留下的应是最新的三个，实际: {}",
            files[0]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn log_cache_never_deletes_active_file() {
        let dir = tmp_dir("cache-active");
        for i in 0..3 {
            touch_cache_file(&dir, i, 1024);
        }
        // 最新的那个正被会话写入；上限设成 0 以确定性地证明"活跃文件被跳过"
        let mut active = std::collections::HashSet::new();
        let newest = dir.join("session-20260101-000000002-COM1.log");
        active.insert(newest.clone());

        enforce_log_cache_limit_in(&dir, 0, u64::MAX, &active);

        let files = cache_file_names(&dir);
        assert_eq!(files.len(), 1, "除活跃文件外都应被删掉");
        assert_eq!(
            files[0],
            "session-20260101-000000002-COM1.log",
            "正在写入的文件绝不能被删"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod qcmd_hs_tests {
    use super::*;

    fn armed(expect: &str, timeout_ms: u64) -> QcmdHs {
        let mut hs = QcmdHs::default();
        hs.arm(expect.split('|').map(|s| s.to_string()).collect(), timeout_ms);
        hs
    }

    #[test]
    fn ok_split_across_two_chunks_is_recognized() {
        // 设备回 `OK\r\n` 完全可能被拆成两块读上来 —— 跨块的行拼装就是为它写的
        let mut hs = armed("", 3000);
        hs.feed(b"AT+GMR\r\nO");
        assert_eq!(hs.poll(), HsState::Waiting, "半个 OK 不算结论");
        hs.feed(b"K\r\n");
        assert_eq!(hs.poll(), HsState::Ok);
    }

    #[test]
    fn busy_keeps_waiting_and_is_flagged() {
        let mut hs = armed("", 3000);
        hs.feed(b"busy p...\r\n");
        assert_eq!(hs.poll(), HsState::Waiting, "busy 只是还在处理，绝不是结论");
        assert!(hs.busy, "busy 要记下来给界面看");
        hs.feed(b"OK\r\n");
        assert_eq!(hs.poll(), HsState::Ok);
    }

    #[test]
    fn error_wins_over_other_text() {
        let mut hs = armed("", 3000);
        hs.feed(b"+CME ERROR: 3\r\n");
        assert_eq!(hs.poll(), HsState::Err, "+CME ERROR 这类行也要判成失败");
    }

    #[test]
    fn send_ok_counts_as_ok() {
        let mut hs = armed("", 3000);
        hs.feed(b"SEND OK\r\n");
        assert_eq!(hs.poll(), HsState::Ok, "SEND OK / CONNECT OK 以 \" OK\" 收尾，算成功");
    }

    #[test]
    fn custom_expect_words_are_appended() {
        let mut hs = armed("WIFI GOT IP|ready", 3000);
        hs.feed(b"WIFI DISCONNECT\r\n");
        assert_eq!(hs.poll(), HsState::Waiting, "不在期望列表里的中间行不算结论");
        hs.feed(b"WIFI GOT IP\r\n");
        assert_eq!(hs.poll(), HsState::Ok);
    }

    #[test]
    fn timeout_is_settled_on_poll() {
        let mut hs = armed("", 1);
        std::thread::sleep(std::time::Duration::from_millis(15));
        assert_eq!(hs.poll(), HsState::Timeout, "到点没结论 = 超时（由 poll 结算，不另起定时器）");
        hs.feed(b"OK\r\n");
        assert_eq!(hs.poll(), HsState::Timeout, "结算之后来的 OK 属于下一条，不能改写结论");
    }

    #[test]
    fn arm_clears_previous_verdict_and_stop_resets() {
        let mut hs = armed("", 3000);
        hs.feed(b"OK\r\n");
        assert_eq!(hs.poll(), HsState::Ok);
        hs.arm(Vec::new(), 3000);
        assert_eq!(hs.poll(), HsState::Waiting, "arm 必须清掉上一条的结论（否则下一条会秒过）");
        hs.stop();
        assert_eq!(hs.poll(), HsState::Idle);
    }

    #[test]
    fn last_lines_are_capped() {
        let mut hs = armed("", 3000);
        for i in 0..20 { hs.feed(format!("line{}\r\n", i).as_bytes()); }
        assert!(hs.last_lines.len() <= HS_LAST_LINES, "排障用的最近行不许无限增长");
    }

    #[test]
    fn buffer_is_capped_without_newline() {
        let mut hs = armed("", 3000);
        let big = vec![b'x'; HS_BUF_CAP * 2];
        hs.feed(&big);
        assert!(hs.buf.len() <= HS_BUF_CAP, "没有换行的长数据不许把缓冲撑爆");
    }

    #[test]
    fn bare_cr_is_also_a_line_end() {
        let mut hs = armed("", 3000);
        hs.feed(b"AT\rOK\n");
        assert_eq!(hs.poll(), HsState::Ok, "\\r 单独也算行尾（有些设备就是只回 CR）");
    }

    /// 回归：**行尾字节必须被无条件吃掉**。
    /// 跨块拆开时（上一块以 `\r` 收尾、下一块从 `\n` 开始）缓冲里会出现"开头的孤立 `\r`"，
    /// 早先的实现 `drain(..0)` 什么都没吃掉 → 原地打转、把一个核跑满（写完这段单测当场踩到）。
    #[test]
    fn feed_never_spins_on_leading_line_ends() {
        let chunks: [&[u8]; 5] = [b"\r", b"\n", b"\r\n", b"\r\r\n", b"\r\n\r\n"];
        for chunk in chunks {
            let mut hs = armed("", 3000);
            hs.feed(chunk);                       // 只喂行尾：不许卡住、不许 panic
            hs.feed(b"OK\r\n");
            assert_eq!(hs.poll(), HsState::Ok, "前导行尾之后仍能认出 OK（chunk={:?}）", chunk);
        }
        // 一整条被拆成"三块 + 行尾"的极端情形
        let mut hs = armed("", 3000);
        hs.feed(b"OK\r");
        hs.feed(b"\n");
        assert_eq!(hs.poll(), HsState::Ok);
    }

    #[test]
    fn expect_list_is_capped() {
        let hs = armed(&vec!["w"; 20].join("|"), 3000);
        assert!(hs.expect.len() <= HS_MAX_EXPECT, "自定义成功词的数量有上限（外部输入必须有上限）");
    }

    #[test]
    fn slot_is_shared_by_key() {
        let map: Mutex<HashMap<String, std::sync::Arc<std::sync::Mutex<QcmdHs>>>> =
            Mutex::new(HashMap::new());
        let a = hs_slot(&map, "main");
        let b = hs_slot(&map, "main");
        let c = hs_slot(&map, "other");
        assert!(std::sync::Arc::ptr_eq(&a, &b), "同一个监视器必须拿到同一份状态（串口与 WSL 共用）");
        assert!(!std::sync::Arc::ptr_eq(&a, &c), "不同监视器各一份");
    }
}

#[cfg(test)]
mod ble_periph_tests {
    use super::*;

    fn state() -> BlePeripheralState {
        BlePeripheralState {
            provider: Mutex::new(None),
            service_uuid: Mutex::new(None),
            chars: Mutex::new(Vec::new()),
            adapter: Mutex::new(BlePeriphAdapterInfo::default()),
            pending_writes: std::sync::Arc::new(Mutex::new(std::collections::HashMap::new())),
            write_seq: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
            manual_write_reply: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            events: std::sync::Arc::new(Mutex::new(std::collections::VecDeque::new())),
            running: std::sync::atomic::AtomicBool::new(false),
        }
    }

    fn adapter(present: bool, le: bool, periph: bool, radio: &str) -> BlePeriphAdapterInfo {
        BlePeriphAdapterInfo {
            present,
            low_energy: le,
            peripheral_role: periph,
            central_role: true,
            radio_state: radio.to_string(),
            radio_access: "Allowed".to_string(),
        }
    }

    fn adapter_with_access(access: &str) -> BlePeriphAdapterInfo {
        let mut a = adapter(true, true, true, "On");
        a.radio_access = access.to_string();
        a
    }

    #[test]
    fn guid_parses_full_and_short_forms() {
        let (g, s) = ble_periph_guid("6E400001-B5A3-F393-E0A9-E50E24DCCA9E").unwrap();
        assert_eq!(s, "6e400001-b5a3-f393-e0a9-e50e24dcca9e");
        assert_eq!(g.to_u128(), 0x6E400001_B5A3_F393_E0A9_E50E24DCCA9E);
        // 16 位短写按 Bluetooth SIG 基址展开（用户从模块手册抄 0xFFE0 是常态）
        let (_, s16) = ble_periph_guid("0xFFE0").unwrap();
        assert_eq!(s16, "0000ffe0-0000-1000-8000-00805f9b34fb");
        // 32 位短写同理
        let (_, s32) = ble_periph_guid("1234ABCD").unwrap();
        assert_eq!(s32, "1234abcd-0000-1000-8000-00805f9b34fb");
        // 大小写归一：同一个 UUID 必须落到同一个字符串，否则前端回传会找不到特征
        assert_eq!(ble_periph_guid("6e400001-b5a3-f393-e0a9-e50e24dcca9e").unwrap().1, s);
        // 前后空格容忍
        assert!(ble_periph_guid("  0xFFE0  ").is_ok());
        // 非法输入要报错，不能静默当成 0
        assert!(ble_periph_guid("不是UUID").is_err());
        assert!(ble_periph_guid("").is_err());
    }

    #[test]
    fn props_map_both_ways_and_reject_unknown() {
        let names: Vec<String> = ["write", "write_without_response", "notify"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let p = ble_periph_props_from_names(&names).unwrap();
        assert_eq!(
            ble_periph_props_to_names(p),
            vec!["write", "write_without_response", "notify"]
        );
        let p2 = ble_periph_props_from_names(&["read".to_string()]).unwrap();
        assert_eq!(ble_periph_props_to_names(p2), vec!["read"]);
        // 未知属性必须报错：静默忽略会让人以为是设备不生效
        assert!(ble_periph_props_from_names(&["readd".to_string()]).is_err());
        // 一个属性都没有的特征在 BLE 上无意义
        assert!(ble_periph_props_from_names(&[]).is_err());
    }

    #[test]
    fn device_id_parsing_extracts_peer_mac() {
        assert_eq!(
            ble_periph_parse_device_id("BluetoothLE#BluetoothLE00:11:22:33:44:55-aa:bb:cc:dd:ee:ff"),
            "AA:BB:CC:DD:EE:FF"
        );
        // 认不出来就原样返回，别把设备 ID 吃掉（否则日志里什么线索都没有）
        assert_eq!(ble_periph_parse_device_id("some-other-id"), "some-other-id");
        assert_eq!(ble_periph_parse_device_id(""), "");
    }

    #[test]
    fn adv_status_names_cover_documented_values() {
        // 值取自 WinRT GattServiceProviderAdvertisementStatus
        assert_eq!(ble_periph_adv_status(GattServiceProviderAdvertisementStatus(0)), "Created");
        assert_eq!(ble_periph_adv_status(GattServiceProviderAdvertisementStatus(1)), "Stopped");
        assert_eq!(ble_periph_adv_status(GattServiceProviderAdvertisementStatus(2)), "Started");
        assert_eq!(ble_periph_adv_status(GattServiceProviderAdvertisementStatus(3)), "Aborted");
        assert_eq!(
            ble_periph_adv_status(GattServiceProviderAdvertisementStatus(4)),
            "StartedWithoutAllAdvertisementData"
        );
        assert_eq!(ble_periph_adv_status(GattServiceProviderAdvertisementStatus(99)), "Unknown");
    }

    /// 适配器能力判定：广播失败时到底该怪谁，全靠这一条
    #[test]
    fn probe_warning_names_the_real_blocker() {
        // 能力齐全 → 没有能力层面的问题（广播再失败就是别的原因）
        assert!(ble_periph_probe_warning(&adapter(true, true, true, "On")).is_none());
        // 没适配器
        let w = ble_periph_probe_warning(&adapter(false, false, false, "")).unwrap();
        assert!(w.contains("没有蓝牙适配器"), "{w}");
        // 有适配器但不支持 BLE
        let w = ble_periph_probe_warning(&adapter(true, false, false, "On")).unwrap();
        assert!(w.contains("不支持 BLE"), "{w}");
        // 蓝牙关着（这是最常见的"搜不到"）
        let w = ble_periph_probe_warning(&adapter(true, true, true, "Off")).unwrap();
        assert!(w.contains("蓝牙已关闭") && w.contains("设置"), "{w}");
        // 被禁用（飞行模式 / 设备管理器停用）
        let w = ble_periph_probe_warning(&adapter(true, true, true, "Disabled")).unwrap();
        assert!(w.contains("禁用"), "{w}");
        // 硬件不支持外设角色：这一条最容易被误当成软件 bug
        let w = ble_periph_probe_warning(&adapter(true, true, false, "On")).unwrap();
        assert!(w.contains("外设角色"), "{w}");
        // radio_state 取不到（空串）不应被当成"关着"
        assert!(ble_periph_probe_warning(&adapter(true, true, true, "")).is_none());
        assert!(ble_periph_probe_warning(&adapter(true, true, true, "Unknown")).is_none());
        // 顺序：能力问题比电源状态更根本，必须先报能力
        let w = ble_periph_probe_warning(&adapter(true, false, false, "Off")).unwrap();
        assert!(w.contains("不支持 BLE"), "{w}");
        // 无线电访问权被拒：扫描可能仍可用，所以"能搜到别人"不代表能广播 —— 很隐蔽
        let w = ble_periph_probe_warning(&adapter_with_access("DeniedByUser")).unwrap();
        assert!(w.contains("无线电访问权") && w.contains("RadioAccessStatus"), "{w}");
        // 文案不能说死是"用户拒绝了"：本机 ConsentStore\radios = Allow，却仍返回 DeniedByUser
        assert!(!w.contains("请在「Windows 设置"), "不该断言是隐私设置导致：{w}");
        let w = ble_periph_probe_warning(&adapter_with_access("DeniedBySystem")).unwrap();
        assert!(w.contains("无线电访问权"), "{w}");
        // Allowed / 取不到都不该报权限问题（免得没权限问题时乱提示）
        assert!(ble_periph_probe_warning(&adapter_with_access("Allowed")).is_none());
        assert!(ble_periph_probe_warning(&adapter_with_access("")).is_none());
        assert!(ble_periph_probe_warning(&adapter_with_access("Unspecified")).is_none());
        // 能力位比权限更根本：硬件不支持时不必谈权限
        let mut a = adapter_with_access("DeniedByUser");
        a.peripheral_role = false;
        assert!(ble_periph_probe_warning(&a).unwrap().contains("外设角色"));
    }

    #[test]
    fn adapter_json_shape_is_stable() {
        let j = adapter(true, true, false, "Off").to_json();
        assert_eq!(j["present"], true);
        assert_eq!(j["low_energy"], true);
        assert_eq!(j["peripheral_role"], false);
        assert_eq!(j["radio_state"], "Off");
        assert_eq!(j["radio_access"], "Allowed");
        // 默认值：什么都探测不到
        let d = BlePeriphAdapterInfo::default().to_json();
        assert_eq!(d["present"], false);
        assert_eq!(d["radio_state"], "");
        assert_eq!(d["radio_access"], "");
    }

    #[test]
    fn event_buffer_is_bounded_and_timestamped() {
        let events = std::sync::Arc::new(Mutex::new(std::collections::VecDeque::new()));
        for i in 0..(BLE_PERIPH_EVENT_MAX + 10) {
            ble_periph_emit(&events, json!({ "kind": "write", "i": i }));
        }
        let q = events.lock().unwrap();
        assert_eq!(q.len(), BLE_PERIPH_EVENT_MAX);
        // 丢的是最旧的，不是最新的
        assert_eq!(q.front().unwrap()["i"], 10);
        assert_eq!(q.back().unwrap()["i"], BLE_PERIPH_EVENT_MAX + 9);
        // ts 由后端补，前端不猜时间
        assert!(q.back().unwrap()["ts"].is_i64());
    }

    #[test]
    fn data_event_shape_is_stable() {
        let e = ble_periph_data_event("write", "0000ffe1-0000-1000-8000-00805f9b34fb", &[0x01, 0xA0], "AA:BB:CC:DD:EE:FF", "写响应");
        assert_eq!(e["kind"], "write");
        assert_eq!(e["value_hex"], "01 A0");
        assert_eq!(e["len"], 2);
        assert_eq!(e["peer"], "AA:BB:CC:DD:EE:FF");
        assert_eq!(e["note"], "写响应");
    }

    #[test]
    fn set_value_and_notify_reject_unknown_char() {
        let s = state();
        assert!(ble_periph_set_value_inner(&s, "0000ffe1-0000-1000-8000-00805f9b34fb", vec![1]).is_err());
        // 没启动时停止是幂等 no-op，不该报错
        assert!(!ble_periph_stop_inner(&s));
        let st = ble_periph_status_json(&s);
        assert_eq!(st["running"], false);
        assert_eq!(st["advertising_status"], "Stopped");
        assert_eq!(st["characteristics"].as_array().unwrap().len(), 0);
    }

    /// 长写要按 Offset 落值：忽略它会把多段写当成互相覆盖的独立写入
    #[test]
    fn apply_write_honours_offset() {
        let mut v: Vec<u8> = vec![];
        // 普通写：整段替换
        ble_periph_apply_write(&mut v, 0, &[1, 2, 3]);
        assert_eq!(v, vec![1, 2, 3]);
        // 再来一次普通写：旧值更长时要被截掉，不能留尾巴
        ble_periph_apply_write(&mut v, 0, &[9]);
        assert_eq!(v, vec![9]);
        // 长写：往中间写
        let mut v2 = vec![0xAAu8; 6];
        ble_periph_apply_write(&mut v2, 2, &[1, 2]);
        assert_eq!(v2, vec![0xAA, 0xAA, 1, 2, 0xAA, 0xAA]);
        // 超出当前长度：扩展并补 0
        let mut v3 = vec![0xAAu8; 2];
        ble_periph_apply_write(&mut v3, 4, &[7]);
        assert_eq!(v3, vec![0xAA, 0xAA, 0, 0, 7]);
        // 空数据 + offset 0：清空
        let mut v4 = vec![1, 2, 3];
        ble_periph_apply_write(&mut v4, 0, &[]);
        assert!(v4.is_empty());
    }

    /// 标准描述符由系统发布，必须本地挡住（真机在 0x2901 上实测过）
    #[test]
    fn reserved_descriptors_are_rejected_locally() {
        for v in [0x2900u16, 0x2901, 0x2902, 0x2904, 0x290F] {
            let msg = ble_periph_desc_reserved(Some(v)).unwrap_or_else(|| panic!("0x{v:04X} 应被判为保留"));
            assert!(msg.contains("自动发布"), "{msg}");
        }
        // 厂商自定义 UUID 不该被拦
        assert!(ble_periph_desc_reserved(Some(0xFFF1)).is_none());
        assert!(ble_periph_desc_reserved(None).is_none());
        // 短写提取：SIG 基址下的 16 位 UUID 能取出来，自定义 128 位取不出来
        assert_eq!(ble_periph_uuid_short(&uuid::Uuid::parse_str("00002901-0000-1000-8000-00805f9b34fb").unwrap()), Some(0x2901));
        assert_eq!(ble_periph_uuid_short(&uuid::Uuid::parse_str("6e400001-b5a3-f393-e0a9-e50e24dcca9e").unwrap()), None);
    }

    #[test]
    fn readable_check_matches_props() {
        assert!(ble_periph_props_readable(&["read".to_string(), "notify".to_string()]));
        assert!(!ble_periph_props_readable(&["write".to_string(), "write_without_response".to_string()]));
        assert!(!ble_periph_props_readable(&[]));
        // 只认精确的 "read"，不被 "write_without_response" 之类混淆
        assert!(!ble_periph_props_readable(&["readd".to_string()]));
    }

    /// 广播服务数据过长要给出提示（传统广播只有 31 字节）
    #[test]
    fn adv_data_length_is_flagged() {
        assert!(ble_periph_adv_data_warn(0).is_none());
        assert!(ble_periph_adv_data_warn(BLE_PERIPH_ADV_DATA_SAFE).is_none());
        let w = ble_periph_adv_data_warn(BLE_PERIPH_ADV_DATA_SAFE + 1).unwrap();
        assert!(w.contains("31 字节") && w.contains("截断"), "{w}");
    }

    /// 下发长度守卫：超长要在本地挡住并说清"该切多少"，而不是丢一个底层错误
    #[test]
    fn notify_size_check_guards_mtu_limit() {
        // MTU 23 → 单次通知 20 字节，这是 BLE 默认值，最常见
        assert!(ble_periph_notify_size_check(20, 20).is_ok());
        let e = ble_periph_notify_size_check(21, 20).unwrap_err();
        assert!(e.contains("21") && e.contains("20") && e.contains("拆成多包"), "{e}");
        // MTU 185 → 182 字节
        assert!(ble_periph_notify_size_check(182, 182).is_ok());
        assert!(ble_periph_notify_size_check(183, 182).is_err());
        // 0 表示"还没有订阅者/还没拿到 MTU"：不在这里报长度问题，交给订阅检查去报
        assert!(ble_periph_notify_size_check(9999, 0).is_ok());
        // 空数据永远合法
        assert!(ble_periph_notify_size_check(0, 20).is_ok());
    }

    /// 能力/权限问题必须压过广播状态码：否则用户会照着 Aborted 去查"是不是被别的程序占了"
    #[test]
    fn probe_warning_outranks_adv_status_warning() {
        let s = state();
        {
            let mut a = s.adapter.lock().unwrap();
            *a = adapter(true, true, false, "On");
        }
        s.running.store(true, std::sync::atomic::Ordering::Relaxed);
        let st = ble_periph_status_json(&s);
        let w = st["warning"].as_str().unwrap();
        assert!(w.contains("外设角色"), "{w}");
        assert_eq!(st["adapter"]["peripheral_role"], false);
        // 没启动时不该有告警（免得一进页面就红一片）
        s.running.store(false, std::sync::atomic::Ordering::Relaxed);
        assert!(ble_periph_status_json(&s)["warning"].is_null());
    }

    /// 无线电访问权被拒时也要给出可操作文案（本机实测就是这一种）
    #[test]
    fn denied_radio_access_is_reported() {
        let s = state();
        {
            let mut a = s.adapter.lock().unwrap();
            *a = adapter_with_access("DeniedByUser");
        }
        s.running.store(true, std::sync::atomic::Ordering::Relaxed);
        let st = ble_periph_status_json(&s);
        let w = st["warning"].as_str().unwrap();
        assert!(w.contains("无线电访问权"), "{w}");
        assert_eq!(st["adapter"]["radio_access"], "DeniedByUser");
    }

    /// Aborted 的文案必须指向"适配器自报支持但广播不了"，而不是误导成"蓝牙没开"
    #[test]
    fn aborted_adv_warning_points_at_adapter() {
        let s = state();
        {
            let mut a = s.adapter.lock().unwrap();
            *a = adapter(true, true, true, "On"); // 能力位全正常、蓝牙也开着
        }
        s.running.store(true, std::sync::atomic::Ordering::Relaxed);
        let st = ble_periph_status_json(&s);
        // 没有适配器能力问题时，才会落到广播状态码的文案上
        assert_eq!(st["advertising_status"], "Stopped", "没建 provider 时状态应为 Stopped");
        let w = st["warning"].as_str().unwrap();
        assert!(w.contains("未启动"), "{w}");

        // 直接验 Aborted 的措辞（这是本机实测唯一命中的分支）
        let w = ble_periph_adv_warning("Aborted").unwrap();
        // 逐字段实测：能发广播，被拒的是"带服务 UUID / 广播名"的内容 —— 文案要指向这个现象
        assert!(w.contains("服务 UUID") && w.contains("能**发") && w.contains("平台限制"), "{w}");
        assert!(!w.contains("USB 蓝牙适配器再试"), "不该只把人往换适配器上引：{w}");
        assert!(ble_periph_adv_warning("Started").is_none());
    }

    /// 环境诊断（`#[ignore]`，排障用）：把"广播为什么起不来"可能的原因一次性打全，
    /// 输出可以直接贴进 issue / 文档。
    ///
    ///   cargo test --manifest-path src-tauri/Cargo.toml ble_periph_diagnose -- --ignored --nocapture
    ///
    /// 打的内容：无线电访问权（`DeniedByUser` 会挡住广播，而**扫描仍然可用**）、
    /// 系统里的适配器清单、默认适配器的能力位与 Radio 明细、应用侧探测结论，
    /// 以及一次真实广播的返回值和落定状态（含 `AdvertisementStatusChanged` 里的 `BluetoothError`）。
    #[test]
    #[ignore]
    fn ble_periph_diagnose() {
        use windows::Devices::Bluetooth::GenericAttributeProfile as g;
        use windows::Devices::Enumeration::DeviceInformation;
        use windows::Devices::Radios::Radio;
        tauri::async_runtime::block_on(async {
            println!("==== BLE 从机环境诊断 ====");
            // [1] 无线电访问权：被拒时扫描仍可能可用，但广播会被挡
            match Radio::RequestAccessAsync() {
                Ok(op) => match op.await {
                    Ok(st) => println!(
                        "[1] RadioAccessStatus = {st:?}   (1=Allowed 2=DeniedByUser 3=DeniedBySystem)"
                    ),
                    Err(e) => println!("[1] RequestAccessAsync 等待失败: {e}"),
                },
                Err(e) => println!("[1] RequestAccessAsync 调用失败: {e}"),
            }
            // [2] 适配器清单（"默认"那个是不是真的可用）
            match windows::Devices::Bluetooth::BluetoothAdapter::GetDeviceSelector() {
                Ok(sel) => match DeviceInformation::FindAllAsyncAqsFilter(&sel) {
                    Ok(op) => match op.await {
                        Ok(col) => {
                            let n = col.Size().unwrap_or(0);
                            println!("[2] 蓝牙适配器数量 = {n}");
                            for i in 0..n {
                                if let Ok(d) = col.GetAt(i) {
                                    println!("    [{i}] enabled={:?} id={:?}", d.IsEnabled(), d.Id());
                                }
                            }
                        }
                        Err(e) => println!("[2] 枚举失败: {e}"),
                    },
                    Err(e) => println!("[2] 枚举失败: {e}"),
                },
                Err(e) => println!("[2] 取选择器失败: {e}"),
            }
            // [3] 默认适配器能力位 + Radio 明细
            if let Ok(op) = windows::Devices::Bluetooth::BluetoothAdapter::GetDefaultAsync() {
                if let Ok(a) = op.await {
                    println!(
                        "[3] 默认适配器: le={:?} periph={:?} central={:?} offload={:?} classic={:?}",
                        a.IsLowEnergySupported(),
                        a.IsPeripheralRoleSupported(),
                        a.IsCentralRoleSupported(),
                        a.IsAdvertisementOffloadSupported(),
                        a.IsClassicSupported()
                    );
                    if let Ok(rop) = a.GetRadioAsync() {
                        if let Ok(r) = rop.await {
                            println!("    radio: kind={:?} state={:?} name={:?}", r.Kind(), r.State(), r.Name());
                        }
                    }
                }
            }
            // [4] 应用侧探测结论（与界面 warning 用的是同一份判定）
            println!("[4] 应用侧探测 = {}", ble_periph_probe_adapter().await.to_json());
            // [5] 真广播一次
            let (svc, _) = ble_periph_guid("0000FFE0-0000-1000-8000-00805F9B34FB").unwrap();
            let (chr, _) = ble_periph_guid("0000FFE1-0000-1000-8000-00805F9B34FB").unwrap();
            if let Ok(p) = ble_periph_create_provider(svc).await {
                if let Ok(s) = p.Service() {
                    let params = g::GattLocalCharacteristicParameters::new().unwrap();
                    let _ = params.SetCharacteristicProperties(
                        g::GattCharacteristicProperties::Read | g::GattCharacteristicProperties::Write,
                    );
                    let _ = params.SetReadProtectionLevel(g::GattProtectionLevel::Plain);
                    let _ = params.SetWriteProtectionLevel(g::GattProtectionLevel::Plain);
                    if let Ok(op) = s.CreateCharacteristicAsync(chr, &params) {
                        let _ = op.await; // 只需要它建出来；成败由下面的广播状态体现
                    }
                    let _ = p.AdvertisementStatusChanged(&windows::Foundation::TypedEventHandler::<
                        g::GattServiceProvider,
                        g::GattServiceProviderAdvertisementStatusChangedEventArgs,
                    >::new(|_s, args| {
                        if let Some(a) = args.as_ref() {
                            println!(
                                "    [事件] status={:?} error={:?}",
                                a.Status().map(ble_periph_adv_status),
                                a.Error()
                            );
                        }
                        Ok(())
                    }));
                    let adv = g::GattServiceProviderAdvertisingParameters::new().unwrap();
                    let _ = adv.SetIsDiscoverable(true);
                    let _ = adv.SetIsConnectable(true);
                    println!(
                        "[5] StartAdvertisingWithParameters = {:?}",
                        p.StartAdvertisingWithParameters(&adv)
                    );
                    println!("    落定状态 = {}", ble_periph_settle_adv_status(&p).await);
                    let _ = p.StopAdvertising();
                }
            }
            println!("==== 诊断结束 ====");
        });
    }

    /// 真机冒烟（已证实部分）：真的建出 GATT 服务与特征，并可读写本地值。
    #[test]
    #[ignore]
    fn ble_periph_builds_service_and_characteristics() {
        let s = state();
        let out = tauri::async_runtime::block_on(ble_periph_start_inner(
            &s,
            "6E400001-B5A3-F393-E0A9-E50E24DCCA9E".to_string(),
            vec![
                BlePeriphCharSpec {
                    uuid: "6E400002-B5A3-F393-E0A9-E50E24DCCA9E".to_string(),
                    props: vec!["write".to_string(), "write_without_response".to_string()],
                    value: vec![],
                    // 顺带在真机上验一下自定义描述符的创建路径。
                    // 注意不能用 0x2901：标准描述符由系统自动发布，手工建会被拒（真机实测）
                    descriptors: vec![BlePeriphDescSpec {
                        uuid: "6E400004-B5A3-F393-E0A9-E50E24DCCA9E".to_string(),
                        value: b"RX".to_vec(),
                    }],
                },
                BlePeriphCharSpec {
                    uuid: "6E400003-B5A3-F393-E0A9-E50E24DCCA9E".to_string(),
                    props: vec!["read".to_string(), "notify".to_string()],
                    value: vec![0x41],
                    descriptors: vec![],
                },
            ],
            Some(true),
            Some(true),
            Some(vec![0x01, 0x02]),
            Some(false),
        ))
        .expect("建 GATT 服务 / 特征失败");
        println!("{}", serde_json::to_string_pretty(&out).unwrap());
        // UUID 必须被规范化成小写，前端回传才能命中
        assert_eq!(out["service_uuid"], "6e400001-b5a3-f393-e0a9-e50e24dcca9e");
        assert_eq!(out["running"], true);
        assert_eq!(out["characteristics"].as_array().unwrap().len(), 2);
        assert_eq!(out["characteristics"][0]["uuid"], "6e400002-b5a3-f393-e0a9-e50e24dcca9e");
        assert_eq!(out["characteristics"][1]["props"], serde_json::json!(["read", "notify"]));
        // 自定义描述符真的建出来了
        assert_eq!(
            out["characteristics"][0]["descriptors"],
            serde_json::json!(["6e400004-b5a3-f393-e0a9-e50e24dcca9e"])
        );

        // 不可读的特征（只写）不接受设值 —— 主机读不到它，设了没意义
        let e = ble_periph_set_value_inner(&s, "6E400002-B5A3-F393-E0A9-E50E24DCCA9E", vec![1])
            .unwrap_err();
        assert!(e.contains("read"), "不可读特征的设值报错应提到 read，实际: {e}");
        // 可读特征照常
        ble_periph_set_value_inner(&s, "6E400003-B5A3-F393-E0A9-E50E24DCCA9E", vec![0xDE, 0xAD]).unwrap();
        assert_eq!(ble_periph_status_json(&s)["characteristics"][1]["value_hex"], "DE AD");

        // 没有订阅者时下发必须明确报错，而不是静默成功
        let err = tauri::async_runtime::block_on(ble_periph_notify_inner(
            &s,
            "6E400003-B5A3-F393-E0A9-E50E24DCCA9E",
            vec![1],
        ))
        .unwrap_err();
        assert!(err.contains("订阅"), "错误文案应当提示先订阅，实际: {err}");

        // 不存在的特征也要报错
        assert!(ble_periph_set_value_inner(&s, "0000ffe1-0000-1000-8000-00805f9b34fb", vec![1]).is_err());

        // 状态自洽：没在广播就必须给出可操作告警，不能显示成一切正常
        let st = ble_periph_status_json(&s);
        if !st["advertising"].as_bool().unwrap() {
            assert!(st["warning"].is_string(), "未广播时必须给出告警：{st}");
            println!("⚠ 广播未生效：{}", st["warning"]);
        }

        assert!(ble_periph_stop_inner(&s));
        let after = ble_periph_status_json(&s);
        assert_eq!(after["running"], false);
        assert_eq!(after["advertising"], false);
        assert_eq!(after["characteristics"].as_array().unwrap().len(), 0);

        // 标准描述符（0x2901 等）由系统发布，手工创建必须在本地就被挡住并给出原因。
        // 注意用**独立 state**：ble_periph_start_inner 开头会清空上一个服务，
        // 复用同一个 state 会把上面刚建好、还没断言完的特征清掉。
        let s2 = state();
        let reserved = tauri::async_runtime::block_on(ble_periph_start_inner(
            &s2,
            "6E400001-B5A3-F393-E0A9-E50E24DCCA9E".to_string(),
            vec![BlePeriphCharSpec {
                uuid: "6E400002-B5A3-F393-E0A9-E50E24DCCA9E".to_string(),
                props: vec!["read".to_string()],
                value: vec![],
                descriptors: vec![BlePeriphDescSpec { uuid: "0x2901".to_string(), value: vec![] }],
            }],
            Some(true),
            Some(true),
            None,
            Some(false),
        ))
        .unwrap_err();
        assert!(reserved.contains("不能手工创建"), "实际: {reserved}");
        assert!(ble_periph_stop_inner(&s2) == false, "被本地挡下后不该留下运行中的服务");
    }

    /// 真机冒烟（**待你在自己的桌面会话里验证**）：本机是否真的在对外广播。
    ///
    /// 现状（2026-09，开发执行环境实测）：**这一条是失败的**。
    /// 同一个环境里 BLE 扫描完全正常（btleplug 扫到 29 台设备）、GATT 服务与特征也建得出来、
    /// 适配器自报 `BLE 支持 / 外设角色 支持 / 蓝牙 On`，但 `StartAdvertisingWithParameters`
    /// 返回 Ok 之后状态落定为 `Aborted`（把 connectable 关掉则一直停在 `Created`）。
    /// 结论：不是"没硬件"，但**"能被手机搜到"这件事至今没有任何真机证据** —— 见
    /// `doc/BLE_PERIPHERAL.md` 第 5 节。请在有蓝牙的交互式桌面会话里跑本应用点「开始广播」，
    /// 用手机 nRF Connect 扫一次，把结果回填到那份清单里。
    ///
    ///   cargo test --manifest-path src-tauri/Cargo.toml ble_periph_starts_advertising -- --ignored --nocapture
    #[test]
    #[ignore]
    fn ble_periph_starts_advertising() {
        let s = state();
        let out = tauri::async_runtime::block_on(ble_periph_start_inner(
            &s,
            "6E400001-B5A3-F393-E0A9-E50E24DCCA9E".to_string(),
            vec![BlePeriphCharSpec {
                uuid: "6E400002-B5A3-F393-E0A9-E50E24DCCA9E".to_string(),
                props: vec!["read".to_string(), "write".to_string(), "notify".to_string()],
                value: vec![0x41],
                descriptors: vec![],
            }],
            Some(true),
            Some(true),
            None,
            Some(false),
        ))
        .expect("建 GATT 服务 / 特征失败");
        let adapter = &out["adapter"];
        let status = out["advertising_status"].as_str().unwrap().to_string();
        let advertising = out["advertising"].as_bool().unwrap();
        ble_periph_stop_inner(&s);
        // 不管成功失败都把证据打全，方便贴进 issue / 文档
        println!("adapter = {adapter}");
        println!("advertising_status = {status}");
        println!("advertising = {advertising}");
        assert!(
            advertising,
            "广播没有起来：advertising_status={status}、adapter={adapter}。\
             若 adapter 显示 present=true / low_energy=true / peripheral_role=true 而状态是 Aborted，\
             说明适配器自报支持外设角色但实际广播不了 —— 请把这几行连同 doc/BLE_PERIPHERAL.md 第 5 节的清单一起回填"
        );
    }
}

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
use btleplug::api::{Service as BtService, Characteristic as BtChar, PeripheralProperties, Descriptor as BtDescriptor};
use btleplug::api::bleuuid::BleUuid;
use btleplug::api::BDAddr;
use btleplug::platform::{Adapter as BtAdapter, Manager as BleManager, Peripheral as BtPeripheral, PeripheralId as BtPeripheralId};

struct BleState {
    /// 系统里的**全部**蓝牙适配器（`ble_start_scan` 时刷新）。
    /// 以前只留第一个，导致"插在第二个适配器上的设备永远搜不到"。
    adapters: Mutex<Vec<BtAdapter>>,
    scanning: std::sync::atomic::AtomicBool,
    connected: Mutex<Option<BtPeripheral>>,
    /// 上次断开时保留的外设对象。
    /// btleplug 在 DeviceDisconnected 时会把它从适配器表里删掉，若直接丢弃，
    /// 重连就只能靠重新广播（要等设备恢复广播，常常 1~2 秒都扫不到）。
    /// WinRT 的 connect() 内部按地址重建连接、不依赖适配器表，所以留着它可秒连。
    last_peripheral: Mutex<Option<BtPeripheral>>,
    /// 已连接设备的地址（与 connected 同步维护）。
    /// 前端切换页面回来时靠它恢复连接态，关闭程序时靠它做主动断开。
    connected_addr: Mutex<Option<String>>,
    services: Mutex<Vec<BtService>>,
    notify_buf: std::sync::Arc<Mutex<std::collections::VecDeque<serde_json::Value>>>,
    /// 通知缓冲溢出被丢掉的条数。以前只是静默丢最旧的，用户完全不知道丢了数据。
    notify_dropped: std::sync::Arc<std::sync::atomic::AtomicU64>,
    /// 通知循环是否在跑。用 Arc 是为了让循环结束时能自行复位 ——
    /// 断开会让通知流结束，若不复位则重连后再订阅不会起新循环（收不到通知）。
    notify_spawned: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

/// 后端连接超时。比前端 `BLE_CONNECT_TIMEOUT_MS`(15s) 略短，
/// 这样超时时**后端先报错并清干净**，而不是前端单方面放弃、
/// 后端稍后才连上（那会造成"界面未连接、实际已连接"的长期错位）。
const BLE_CONNECT_TIMEOUT_MS: u64 = 10_000;

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

/// 设备类型判定（依据 Bluetooth SIG Assigned Numbers）
/// - `mesh`：BLE Mesh —— AD type 0x2B(Mesh Beacon) / 0x2A(Mesh Message)，或服务 UUID 0x1827 / 0x1828
/// - `ibeacon`：Apple iBeacon —— 厂商数据 Company ID 0x004C 且 payload 为 `02 15 …` 结构
/// - `apple`：iPhone / iPad / Mac —— 厂商数据 Company ID 0x004C（非 iBeacon 结构）
/// - `pc`：个人电脑 —— 厂商数据 Company ID 0x0006(Microsoft)
/// - `ble`：标准 BLE 设备（默认）
fn ble_device_type(p: &PeripheralProperties) -> &'static str {
    // 1) BLE Mesh：先看专用 AD type，再看 Mesh Provisioning / Proxy 服务
    if let Some(raw) = &p.advertisement_data {
        if ble_adv_has_type(raw, 0x2B) || ble_adv_has_type(raw, 0x2A) {
            return "mesh";
        }
    }
    if p.services.iter().any(|u| matches!(u.to_ble_u16(), Some(0x1827) | Some(0x1828))) {
        return "mesh";
    }
    // 2) iBeacon：与 iPhone/Mac 同用 Company ID 0x004C，只能靠 payload 结构区分，
    //    因此必须先于 apple 分支判断，否则会被当成 iPhone
    if matches!(p.manufacturer_data.get(&0x004C), Some(d) if is_ibeacon_payload(d)) {
        return "ibeacon";
    }
    // 3) Apple：其余带 Company ID 0x004C 的（iPhone/iPad/Mac/AirPods 等）
    if p.manufacturer_data.contains_key(&0x004C) {
        return "apple";
    }
    // 4) PC：Windows（Swift Pair 等）带 Company ID 0x0006
    if p.manufacturer_data.contains_key(&0x0006) {
        return "pc";
    }
    // 5) 其余归为标准 BLE 设备
    "ble"
}
fn ble_props_json(p: &PeripheralProperties) -> serde_json::Value {
    // 优先用 btleplug 记录的原始广播字节（fork 暴露）；无则回退按字段重组
    let adv_raw = match &p.advertisement_data {
        Some(raw) => ble_hex(raw),
        None => ble_encode_adv(p),
    };
    json!({
        "address": p.address.to_string(),
        "address_type": ble_addr_type(&p.address_type),
        "device_type": ble_device_type(p),
        "local_name": p.local_name,
        "advertisement_name": p.advertisement_name,
        "rssi": p.rssi,
        "tx_power_level": p.tx_power_level,
        "appearance": p.appearance,
        "manufacturer_data": p.manufacturer_data.iter().map(|(id, v)| json!({"id": id, "hex": ble_hex(v)})).collect::<Vec<_>>(),
        "service_data": p.service_data.iter().map(|(u, v)| json!({"uuid": u.to_string(), "hex": ble_hex(v)})).collect::<Vec<_>>(),
        "services": p.services.iter().map(|u| u.to_string()).collect::<Vec<_>>(),
        "adv_raw": adv_raw,
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
/// 在已发现的服务树里按 (特征 UUID, 描述符 UUID) 定位描述符。
/// 描述符挂在特征下面（如 0x2902 CCCD、0x2901 User Description），
/// 与特征一样需要拿到对象主体才能发起读/写。
fn ble_find_descriptor(services: &[BtService], char_uuid: &str, desc_uuid: &str) -> Option<BtDescriptor> {
    for s in services {
        for c in &s.characteristics {
            if c.uuid.to_string() != char_uuid { continue; }
            if let Some(d) = c.descriptors.iter().find(|d| d.uuid.to_string() == desc_uuid) {
                return Some(d.clone());
            }
        }
    }
    None
}
async fn ble_notify_loop(
    peripheral: BtPeripheral,
    buf: std::sync::Arc<Mutex<std::collections::VecDeque<serde_json::Value>>>,
    dropped: std::sync::Arc<std::sync::atomic::AtomicU64>,
) {
    use futures::StreamExt;
    /// 通知缓冲上限：前端每 250ms 轮询取走（drain），正常远到不了这个量。
    /// 但前端若停止轮询（切到别的页面、或自身异常），通知会在这里无限堆积 ——
    /// 加上限后丢最旧的，内存不会随设备持续上报而线性增长。
    /// **丢弃要记账**：静默丢数据会让人以为"设备就没发那么多"。
    const NOTIFY_BUF_MAX: usize = 2000;
    if let Ok(mut stream) = peripheral.notifications().await {
        while let Some(n) = stream.next().await {
            let hex = ble_hex(&n.value);
            // 生产端旁路：BLE 通知是"前端轮询取走的单消费者队列"，所以只能在**产生处**复制一份，
            // 不能去 drain 队列（那会把界面要的数据抢走）。
            crate::mcp::loghub::hub().push(
                "ble:rx",
                crate::mcp::loghub::LEVEL_INFO,
                crate::mcp::loghub::DIR_RX,
                &format!("{} · {} = {}", n.service_uuid, n.uuid, hex),
                n.value.len() as u32,
            );
            let item = json!({
                "uuid": n.uuid.to_string(),
                "service_uuid": n.service_uuid.to_string(),
                "value_hex": hex,
            });
            {
                // 锁中毒也照常写（`unwrap_or_else(into_inner)`）：写成 `if let Ok(..)` 会把一次中毒
                // 变成"静默丢一条**且不计入 dropped**" —— 与"丢弃要记账"的纪律相悖
                // （2026-09 审计发现；同一函数的其它锁都用了 into_inner）。
                let mut b = buf.lock().unwrap_or_else(|e| e.into_inner());
                while b.len() >= NOTIFY_BUF_MAX {
                    b.pop_front();
                    dropped.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
                b.push_back(item);
            }
        }
    }
}

/// 取系统里的全部蓝牙适配器，并记进 state 供后续命令（设备列表 / 连接 / RSSI）使用。
async fn ble_load_adapters(state: &BleState) -> Result<Vec<BtAdapter>, String> {
    let manager = BleManager::new().await.map_err(|e| format!("BLE manager: {e}"))?;
    let adapters = manager.adapters().await.map_err(|e| format!("BLE adapters: {e}"))?;
    if adapters.is_empty() {
        return Err("未找到蓝牙适配器".to_string());
    }
    *state.adapters.lock().unwrap_or_else(|e| e.into_inner()) = adapters.clone();
    Ok(adapters)
}

fn ble_cached_adapters(state: &BleState) -> Vec<BtAdapter> {
    state.adapters.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[tauri::command]
async fn ble_get_adapters() -> Result<Vec<serde_json::Value>, String> {
    let manager = BleManager::new().await.map_err(|e| format!("BLE manager: {e}"))?;
    let adapters = manager.adapters().await.map_err(|e| format!("BLE adapters: {e}"))?;
    let mut out = Vec::new();
    for (i, a) in adapters.iter().enumerate() {
        let info = a.adapter_info().await.unwrap_or_default();
        let addr = a
            .adapter_address()
            .await
            .ok()
            .flatten()
            .map(|x| x.to_string())
            .unwrap_or_default();
        out.push(json!({"index": i, "info": info, "address": addr}));
    }
    Ok(out)
}

/// 开始扫描**全部**适配器；返回成功启动的适配器数量。
#[tauri::command]
async fn ble_start_scan(state: tauri::State<'_, BleState>) -> Result<usize, String> {
    let adapters = ble_load_adapters(&state).await?;
    let mut started = 0usize;
    let mut errs: Vec<String> = Vec::new();
    for a in &adapters {
        match a.start_scan(ScanFilter::default()).await {
            Ok(_) => started += 1,
            Err(e) => errs.push(e.to_string()),
        }
    }
    if started == 0 {
        return Err(format!("启动扫描失败: {}", errs.join("; ")));
    }
    state.scanning.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(started)
}

#[tauri::command]
async fn ble_stop_scan(state: tauri::State<'_, BleState>) -> Result<(), String> {
    for a in ble_cached_adapters(&state) {
        let _ = a.stop_scan().await;
    }
    state.scanning.store(false, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

/// 设备列表：把所有适配器扫到的设备合并，按 MAC 去重（同一台设备可能被两个适配器同时听到）。
#[tauri::command]
async fn ble_get_devices(state: tauri::State<'_, BleState>) -> Result<Vec<serde_json::Value>, String> {
    let adapters = ble_cached_adapters(&state);
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out = Vec::new();
    for a in &adapters {
        let periphs = match a.peripherals().await {
            Ok(p) => p,
            Err(_) => continue,
        };
        for p in periphs {
            if let Ok(Some(props)) = p.properties().await {
                if seen.insert(props.address.to_string().to_uppercase()) {
                    out.push(ble_props_json(&props));
                }
            }
        }
    }
    Ok(out)
}

/* ===== BLE 配对（WinRT；btleplug 不提供配对接口） =====
   背景：btleplug 的 WinRT 后端只做 BluetoothLEDevice + GattSession，完全不碰配对。
   于是遇到「需要输配对码 / 需要确认」的设备时，连接只会失败并抛出底层 HRESULT，
   用户看不到任何提示。这里补上：由应用主动发起 WinRT 自定义配对，
   把配对码通过 Tauri 事件交给前端弹窗，等用户确认后再继续连接。 */

/// 前端对配对请求的答复通道（同一时刻只允许一个配对在途）
struct BlePairState {
    responder: Mutex<Option<crossbeam_channel::Sender<(bool, String)>>>,
}

/// 把配对请求推给前端并等待答复；60 秒无响应视为取消。
/// kind：confirm=请在设备上确认 / display=把配对码显示给用户 / match=两端比对同一配对码
///       / provide=需要用户在应用里输入设备上显示的配对码
fn ble_ask_pair_confirm(app: &tauri::AppHandle, address: &str, kind: &str, pin: &str) -> Option<(bool, String)> {
    let state = app.state::<BlePairState>();
    let (tx, rx) = crossbeam_channel::bounded(1);
    *state.responder.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
    let _ = app.emit("ble-pair-request", json!({ "address": address, "kind": kind, "pin": pin }));
    rx.recv_timeout(std::time::Duration::from_secs(60)).ok()
}

/// 前端回传配对答复（确认/取消，provide 时带用户输入的配对码）
#[tauri::command]
fn ble_pair_respond(state: tauri::State<'_, BlePairState>, accept: bool, pin: Option<String>) -> Result<(), String> {
    let tx = state.responder.lock().unwrap_or_else(|e| e.into_inner()).take()
        .ok_or("当前没有待处理的配对请求")?;
    tx.send((accept, pin.unwrap_or_default())).map_err(|e| format!("回传配对答复失败: {e}"))
}

/// 发起 WinRT 配对（**全程同步阻塞**：WinRT 对象不是 Send，必须留在同一个线程上，
/// 所以这里用 windows-future 的阻塞 get()，由 ble_pair 丢到阻塞线程池执行）
fn ble_pair_inner(app: &tauri::AppHandle, address: &str, u64_addr: u64) -> Result<bool, String> {
    use windows::core::HSTRING;
    use windows::Devices::Bluetooth::BluetoothLEDevice;
    use windows::Devices::Enumeration::{
        DeviceInformation, DeviceInformationCustomPairing, DevicePairingKinds,
        DevicePairingRequestedEventArgs, DevicePairingResultStatus,
    };
    use windows::Foundation::TypedEventHandler;

    let selector = BluetoothLEDevice::GetDeviceSelectorFromBluetoothAddress(u64_addr)
        .map_err(|e| format!("构造设备选择器失败: {e}"))?;
    // windows-future 0.3 只提供 .await（无阻塞 get），这里在阻塞线程上用 futures 执行器驱动它。
    // 注意：IAsyncOperation 实现的是 IntoFuture（不是 Future），所以必须先放进 async 块里 await，
    // 不能直接把它喂给 block_on。该执行器不要求 Send，正好容纳 WinRT 的 !Send 对象。
    let found = {
        let op = DeviceInformation::FindAllAsyncAqsFilter(&selector)
            .map_err(|e| format!("枚举设备失败: {e}"))?;
        futures::executor::block_on(async { op.await }).map_err(|e| format!("枚举设备失败: {e}"))?
    };
    // DeviceInformationCollection 是 IVectorView：按索引取第一个（空集合时 GetAt 报错，正好给提示）
    let dev = found.GetAt(0).map_err(|_| "未找到该蓝牙设备（请确认设备在范围内）".to_string())?;
    let pairing = dev.Pairing().map_err(|e| format!("读取配对状态失败: {e}"))?;
    if pairing.IsPaired().unwrap_or(false) {
        dbg_log(&format!("ble_pair: {address} 已配对，无需重新配对"));
        return Ok(true);
    }
    let custom = pairing.Custom()
        .map_err(|_| "该设备不支持自定义配对（无法在应用内确认配对码）".to_string())?;

    let app2 = app.clone();
    let addr2 = address.to_string();
    let handler = TypedEventHandler::<DeviceInformationCustomPairing, DevicePairingRequestedEventArgs>::new(
        move |_, args| {
            let args = match args.as_ref() { Some(a) => a, None => return Ok(()) };
            let deferral = args.GetDeferral()?;
            let kind = args.PairingKind()?;
            let shown_pin = args.Pin().map(|h| h.to_string()).unwrap_or_default();
            let kind_str = if kind == DevicePairingKinds::DisplayPin { "display" }
                else if kind == DevicePairingKinds::ProvidePin || kind == DevicePairingKinds::ProvidePasswordCredential { "provide" }
                else if kind == DevicePairingKinds::ConfirmPinMatch { "match" }
                else { "confirm" };
            dbg_log(&format!("ble_pair: 收到配对请求 kind={kind_str} pin_len={}", shown_pin.len()));
            match ble_ask_pair_confirm(&app2, &addr2, kind_str, &shown_pin) {
                Some((true, user_pin)) => {
                    let r = if kind == DevicePairingKinds::ProvidePin
                             || kind == DevicePairingKinds::ProvidePasswordCredential {
                        args.AcceptWithPin(&HSTRING::from(user_pin.as_str()))
                    } else {
                        args.Accept()
                    };
                    if let Err(e) = r { dbg_log(&format!("ble_pair: 接受配对失败 {e}")); }
                }
                Some((false, _)) => dbg_log("ble_pair: 用户取消配对"),
                None => dbg_log("ble_pair: 等待用户确认超时，按取消处理"),
            }
            deferral.Complete()?;
            Ok(())
        },
    );
    custom.PairingRequested(&handler).map_err(|e| format!("注册配对事件失败: {e}"))?;
    let kinds = DevicePairingKinds::ConfirmOnly
        | DevicePairingKinds::DisplayPin
        | DevicePairingKinds::ProvidePin
        | DevicePairingKinds::ConfirmPinMatch;
    let result = {
        let op = custom.PairAsync(kinds).map_err(|e| format!("发起配对失败: {e}"))?;
        futures::executor::block_on(async { op.await }).map_err(|e| format!("配对过程出错: {e}"))?
    };
    let status = result.Status().map_err(|e| format!("读取配对结果失败: {e}"))?;
    dbg_log(&format!("ble_pair: {address} 配对结果 {status:?}"));
    Ok(status == DevicePairingResultStatus::Paired)
}

/// 发起配对：已配对直接返回 true；需要用户确认时经 ble-pair-request 事件询问前端
#[tauri::command]
async fn ble_pair(app: tauri::AppHandle, address: String) -> Result<bool, String> {
    let u64_addr = bt_addr_to_u64(&address).ok_or("蓝牙地址格式不正确")?;
    tauri::async_runtime::spawn_blocking(move || ble_pair_inner(&app, &address, u64_addr))
        .await
        .map_err(|e| format!("配对任务失败: {e}"))?
}

/// 建立链路（含显式超时）。已经连着的不重复 connect。
async fn ble_ensure_connected(target: &BtPeripheral, address: &str) -> Result<(), String> {
    // 已经连着就不要再 connect 一次：connect() 会换掉底层设备对象，
    // 旧对象随之关闭；若 GATT 缓存没跟着刷新，后续写入/订阅会用到已关闭的对象。
    // （前端状态一旦与后端不同步，用户就可能对同一台设备重复点「连接设备」）
    if target.is_connected().await.unwrap_or(false) {
        #[cfg(debug_assertions)]
        dbg_log(&format!("ble_ensure_connected: {address} 已处于连接状态，跳过重复连接"));
        return Ok(());
    }
    match tokio::time::timeout(
        std::time::Duration::from_millis(BLE_CONNECT_TIMEOUT_MS),
        target.connect(),
    )
    .await
    {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => {
            let s = e.to_string();
            // WinRT 对「设备已离开范围」和「随机地址已轮换」都只报含糊的 Device not found，
            // 这里翻译成用户能理解的提示（随机地址设备过一段时间旧地址就失效）
            if s.contains("not found") || s.contains("Not found") {
                Err(format!("设备已离线或地址已变化（{s}）：随机地址设备会轮换地址，请重新扫描后再试"))
            } else {
                Err(format!("connect: {s}"))
            }
        }
        Err(_) => {
            // 超时后主动断开：把"到底连上没有"收敛掉，别留给下一次操作去猜
            let _ = target.disconnect().await;
            Err(format!(
                "连接超时（{BLE_CONNECT_TIMEOUT_MS}ms）：设备未响应。请确认设备在范围内、未被其它主机占用（地址 {address}）"
            ))
        }
    }
}

/// 连接成功后的收尾：发现服务、落状态。
/// 抽出来是为了让「扫描找到的设备」与「按 MAC 直连的设备」走**同一条**路径。
async fn ble_finalize_connection(
    state: &BleState,
    target: BtPeripheral,
) -> Result<(), String> {
    target.discover_services().await.map_err(|e| format!("discover: {e}"))?;
    let svcs: Vec<BtService> = target.services().iter().cloned().collect();
    let addr = target.address().to_string();
    // 新连接不继承上一台设备的残留通知，丢弃计数也清零
    state.notify_buf.lock().unwrap_or_else(|e| e.into_inner()).clear();
    state.notify_dropped.store(0, std::sync::atomic::Ordering::Relaxed);
    *state.services.lock().unwrap_or_else(|e| e.into_inner()) = svcs;
    *state.connected_addr.lock().unwrap_or_else(|e| e.into_inner()) = Some(addr);
    *state.connected.lock().unwrap_or_else(|e| e.into_inner()) = Some(target);
    *state.last_peripheral.lock().unwrap_or_else(|e| e.into_inner()) = None;   // 已成为当前连接，槽位清空
    Ok(())
}

#[tauri::command]
async fn ble_connect(state: tauri::State<'_, BleState>, address: String) -> Result<(), String> {
    let adapters = ble_cached_adapters(&state);
    if adapters.is_empty() {
        return Err("请先扫描设备".to_string());
    }
    // 找设备，三条路依次兜底：
    // 1) 各适配器表（扫描时已在表内，最快）
    // 2) 上次断开保留的外设对象（按地址重连，不需要广播，断开后立刻重连走这条）
    // 3) 全适配器短扫描脉冲重试若干轮（设备不在表内、也没有保留对象时兜底）
    let mut target = ble_find_peripheral(&adapters, &address).await;
    if target.is_none() {
        let last = state.last_peripheral.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(p) = last {
            if p.address().to_string().eq_ignore_ascii_case(&address) {
                #[cfg(debug_assertions)]
                dbg_log(&format!("ble_connect: {address} 复用上次断开保留的外设对象"));
                target = Some(p);
            }
        }
    }
    if target.is_none() {
        #[cfg(debug_assertions)]
        dbg_log(&format!("ble_connect: {address} 不在适配器表内，补短扫描重试"));
        for _ in 0..3 {
            ble_scan_pulse(&adapters, &state.scanning, 1500).await;
            target = ble_find_peripheral(&adapters, &address).await;
            if target.is_some() { break; }
        }
    }
    let target = target.ok_or("未找到该设备（重新扫描后仍未发现，请确认设备在范围内）")?;
    ble_ensure_connected(&target, &address).await?;
    ble_finalize_connection(&state, target).await
}

/// 按 MAC 直连 —— **不要求设备出现在扫描列表里**。
///
/// 这是"从机搜不到、也连不上"的正解：从机一旦被 Windows 配对过、或被另一台主机连走，
/// 就常常不再广播，于是永远进不了扫描列表，用户也就永远选不中它。
/// btleplug 提供了 `add_peripheral`，注释原文：
/// "a device the OS already knows (bonded or connected to another central) can be
/// reached without waiting for an advertisement." —— 应用以前一处都没用它。
#[tauri::command]
async fn ble_connect_direct(state: tauri::State<'_, BleState>, address: String) -> Result<(), String> {
    let adapters = ble_cached_adapters(&state);
    let adapter = adapters
        .first()
        .ok_or("需要先初始化蓝牙适配器：请先在主机模式里点一次「开始扫描」")?;
    let parsed: BDAddr = address
        .trim()
        .parse()
        .map_err(|_| "蓝牙地址格式不正确（应形如 A4:C1:38:11:14:2B）".to_string())?;
    let pid: BtPeripheralId = parsed.into();
    let target = adapter
        .add_peripheral(&pid)
        .await
        .map_err(|e| format!("按地址取出设备失败: {e}"))?;
    ble_ensure_connected(&target, &address).await?;
    ble_finalize_connection(&state, target).await
}

#[tauri::command]
async fn ble_disconnect(state: tauri::State<'_, BleState>) -> Result<(), String> {
    let p = state.connected.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(p) = p {
        let _ = p.disconnect().await;
        // 保留对象：btleplug 已把它从适配器表里删掉，留着才能立刻重连（不必等重新广播）
        *state.last_peripheral.lock().unwrap_or_else(|e| e.into_inner()) = Some(p);
    }
    state.services.lock().unwrap_or_else(|e| e.into_inner()).clear();
    *state.connected_addr.lock().unwrap_or_else(|e| e.into_inner()) = None;
    // 订阅随连接一起失效：清掉残留通知并复位通知循环标志，
    // 否则重连后「再次订阅」不会起新循环（前端也会一直显示启用状态）
    state.notify_buf.lock().unwrap_or_else(|e| e.into_inner()).clear();
    state.notify_spawned.store(false, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

/// 查询真实连接状态：返回已连接设备地址；未连接或链路已断返回 None。
/// 前端切换页面回来时据此恢复连接态，避免「后端仍连着却显示成未连接」。
#[tauri::command]
async fn ble_get_connection(state: tauri::State<'_, BleState>) -> Result<Option<String>, String> {
    let addr = match state.connected_addr.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        Some(a) => a,
        None => return Ok(None),
    };
    // 先把外设克隆出来再 await，避免把 std Mutex 的 guard 跨 await 持有
    let periph = state.connected.lock().unwrap_or_else(|e| e.into_inner()).clone();
    match periph {
        Some(p) => match p.is_connected().await {
            Ok(true) => Ok(Some(addr)),
            Ok(false) => {
                // 链路已断（例如设备主动断开/系统空闲回收）：清理后端状态，保持前后端一致
                #[cfg(debug_assertions)]
                dbg_log(&format!("ble_get_connection: {addr} is_connected=false -> 清理连接状态"));
                // 注意：锁守卫必须在 await 之前释放（MutexGuard 非 Send，
                // 若在 if let 的条件里直接 take，守卫会跨过 .await 导致 future 不 Send）
                let dropped = state.connected.lock().unwrap_or_else(|e| e.into_inner()).take();
                if let Some(p) = dropped {
                    // 顺手 disconnect：它会清掉 GATT 服务缓存。
                    // 只把对象存起来的话，重连后缓存里还是已关闭的旧对象，
                    // 写入/订阅会报「该对象已经关闭」。
                    let _ = p.disconnect().await;
                    *state.last_peripheral.lock().unwrap_or_else(|e| e.into_inner()) = Some(p);   // 保留以便快速重连
                }
                state.services.lock().unwrap_or_else(|e| e.into_inner()).clear();
                *state.connected_addr.lock().unwrap_or_else(|e| e.into_inner()) = None;
                state.notify_buf.lock().unwrap_or_else(|e| e.into_inner()).clear();
                state.notify_spawned.store(false, std::sync::atomic::Ordering::Relaxed);
                Ok(None)
            }
            Err(_) => Ok(Some(addr)),   // 查询失败不误报为断开
        },
        None => Ok(None),
    }
}

/// 短扫描脉冲：Windows 上「设备发现」与「RSSI」都只来自广播包，必须让扫描处于活动态。
/// 若用户已在扫描则只等待，不重复开关（避免抢走用户的扫描）；
/// 收尾前复查一次，防止脉冲期间用户点了「开始扫描」被误关。
async fn ble_scan_pulse(
    adapters: &[BtAdapter],
    scanning: &std::sync::atomic::AtomicBool,
    ms: u64,
) {
    let already = scanning.load(std::sync::atomic::Ordering::Relaxed);
    if !already {
        for a in adapters {
            let _ = a.start_scan(ScanFilter::default()).await;
        }
    }
    // 等广播到达；用 spawn_blocking 睡，避免为一次 sleep 引入 tokio 直接依赖
    let _ = tauri::async_runtime::spawn_blocking(
        move || std::thread::sleep(std::time::Duration::from_millis(ms))
    ).await;
    if !already && !scanning.load(std::sync::atomic::Ordering::Relaxed) {
        for a in adapters {
            let _ = a.stop_scan().await;
        }
    }
}

/// 在**全部**适配器的已知设备里按地址查找（忽略大小写）。
/// 单个适配器查不到不该让整体失败 —— 设备在另一个适配器上是很正常的。
async fn ble_find_peripheral(adapters: &[BtAdapter], address: &str) -> Option<BtPeripheral> {
    for a in adapters {
        if let Ok(periphs) = a.peripherals().await {
            if let Some(p) = periphs
                .into_iter()
                .find(|p| p.address().to_string().eq_ignore_ascii_case(address))
            {
                return Some(p);
            }
        }
    }
    None
}

/// 协商后的 ATT MTU。
/// 默认值是 23（有效载荷 20 字节），写长数据失败时"到底是 MTU 还是特征的问题"
/// 就靠这个数字来分辨，以前界面上完全看不到。
#[tauri::command]
async fn ble_get_mtu(state: tauri::State<'_, BleState>) -> Result<u16, String> {
    let p = state.connected.lock().unwrap_or_else(|e| e.into_inner()).clone();
    Ok(p.map(|p| p.mtu()).unwrap_or(0))
}

/// RSSI 轮询的返回：顺带报告链路是否还在。
/// 设备主动断开（关机/走远/另一台手机连走）时，光靠切页或刷新列表才发现，
/// 会让界面一直停在假的「已连接」上；这里每轮轮询都如实回报。
#[derive(serde::Serialize)]
struct BleRssiInfo {
    rssi: Option<i16>,
    connected: bool,
}

/// 刷新已连接设备的信号强度，返回最新 RSSI 与链路状态（未连接返回 connected=false）。
/// Windows 上 RSSI 只随广播包更新（btleplug 文档明确：需要扫描处于活动状态），
/// 因此这里做一次「短扫描脉冲」后再读缓存值。
#[tauri::command]
async fn ble_refresh_rssi(state: tauri::State<'_, BleState>) -> Result<BleRssiInfo, String> {
    let periph = match state.connected.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        Some(p) => p,
        None => return Ok(BleRssiInfo { rssi: None, connected: false }),
    };
    // 链路已断：顺手清理后端状态并如实告知前端（前端据此切回未连接）
    if !periph.is_connected().await.unwrap_or(true) {
        #[cfg(debug_assertions)]
        dbg_log("ble_refresh_rssi: 链路已断（设备侧断开）-> 清理连接状态");
        let dropped = state.connected.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(p) = dropped {
            let _ = p.disconnect().await;   // 顺带清 GATT 缓存
            *state.last_peripheral.lock().unwrap_or_else(|e| e.into_inner()) = Some(p);   // 保留以便快速重连
        }
        state.services.lock().unwrap_or_else(|e| e.into_inner()).clear();
        *state.connected_addr.lock().unwrap_or_else(|e| e.into_inner()) = None;
        state.notify_buf.lock().unwrap_or_else(|e| e.into_inner()).clear();
        state.notify_spawned.store(false, std::sync::atomic::Ordering::Relaxed);
        return Ok(BleRssiInfo { rssi: None, connected: false });
    }
    let adapters = ble_cached_adapters(&state);
    if adapters.is_empty() {
        return Ok(BleRssiInfo { rssi: None, connected: true });
    }
    ble_scan_pulse(&adapters, &state.scanning, 800).await;
    // 广播回调会把设备（可能是一个新的外设对象）放进适配器表，
    // 优先用表里那个读 RSSI；表里没有再退回我们持有的连接对象（其 last_rssi 可能偏旧）
    let addr = periph.address().to_string();
    let mut rssi = None;
    if let Some(p) = ble_find_peripheral(&adapters, &addr).await {
        rssi = p.read_rssi().await.ok();
    }
    if rssi.is_none() {
        rssi = periph.read_rssi().await.ok();
    }
    #[cfg(debug_assertions)]
    dbg_log(&format!("ble_refresh_rssi: rssi={:?}", rssi));
    Ok(BleRssiInfo { rssi: rssi, connected: true })
}

#[tauri::command]
async fn ble_get_services(state: tauri::State<'_, BleState>) -> Result<Vec<serde_json::Value>, String> {
    let svcs = state.services.lock().unwrap_or_else(|e| e.into_inner());
    Ok(svcs.iter().map(ble_service_json).collect())
}

#[tauri::command]
async fn ble_read(state: tauri::State<'_, BleState>, char_uuid: String) -> Result<Vec<u8>, String> {
    let p = state.connected.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("未连接")?;
    let c = {
        let svcs = state.services.lock().unwrap_or_else(|e| e.into_inner());
        ble_find_char(&svcs, &char_uuid).ok_or("未找到特征")?
    };
    p.read(&c).await.map_err(|e| format!("read: {e}"))
}

#[tauri::command]
async fn ble_write(state: tauri::State<'_, BleState>, char_uuid: String, data: Vec<u8>, write_type: Option<String>) -> Result<(), String> {
    let p = state.connected.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("未连接")?;
    let c = {
        let svcs = state.services.lock().unwrap_or_else(|e| e.into_inner());
        ble_find_char(&svcs, &char_uuid).ok_or("未找到特征")?
    };
    let wt = if write_type.as_deref() == Some("without_response") { WriteType::WithoutResponse } else { WriteType::WithResponse };
    p.write(&c, &data, wt).await.map_err(|e| format!("write: {e}"))
}

/// 读取描述符（0x2901 User Description、0x2902 CCCD 当前值等）
#[tauri::command]
async fn ble_read_descriptor(state: tauri::State<'_, BleState>, char_uuid: String, desc_uuid: String) -> Result<Vec<u8>, String> {
    let p = state.connected.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("未连接")?;
    let d = {
        let svcs = state.services.lock().unwrap_or_else(|e| e.into_inner());
        ble_find_descriptor(&svcs, &char_uuid, &desc_uuid).ok_or("未找到描述符")?
    };
    p.read_descriptor(&d).await.map_err(|e| format!("read_descriptor: {e}"))
}

/// 写描述符（典型用法：往 0x2902 CCCD 写 0x0001/0x0002 手动开关通知/指示）
#[tauri::command]
async fn ble_write_descriptor(state: tauri::State<'_, BleState>, char_uuid: String, desc_uuid: String, data: Vec<u8>) -> Result<(), String> {
    let p = state.connected.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("未连接")?;
    let d = {
        let svcs = state.services.lock().unwrap_or_else(|e| e.into_inner());
        ble_find_descriptor(&svcs, &char_uuid, &desc_uuid).ok_or("未找到描述符")?
    };
    p.write_descriptor(&d, &data).await.map_err(|e| format!("write_descriptor: {e}"))
}

#[tauri::command]
async fn ble_subscribe(state: tauri::State<'_, BleState>, char_uuid: String) -> Result<(), String> {
    let p = state.connected.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("未连接")?;
    let c = {
        let svcs = state.services.lock().unwrap_or_else(|e| e.into_inner());
        ble_find_char(&svcs, &char_uuid).ok_or("未找到特征")?
    };
    p.subscribe(&c).await.map_err(|e| format!("subscribe: {e}"))?;
    let flag = state.notify_spawned.clone();
    if !flag.swap(true, std::sync::atomic::Ordering::Relaxed) {
        let buf = state.notify_buf.clone();
        let dropped = state.notify_dropped.clone();
        tauri::async_runtime::spawn(async move {
            ble_notify_loop(p.clone(), buf, dropped).await;
            // 通知流结束（断开连接会走到这里）：复位标志，下次订阅才能重新起循环
            flag.store(false, std::sync::atomic::Ordering::Relaxed);
        });
    }
    Ok(())
}

#[tauri::command]
async fn ble_unsubscribe(state: tauri::State<'_, BleState>, char_uuid: String) -> Result<(), String> {
    let p = state.connected.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("未连接")?;
    let c = {
        let svcs = state.services.lock().unwrap_or_else(|e| e.into_inner());
        ble_find_char(&svcs, &char_uuid).ok_or("未找到特征")?
    };
    p.unsubscribe(&c).await.map_err(|e| format!("unsubscribe: {e}"))
}

#[tauri::command]
async fn ble_poll_notifications(state: tauri::State<'_, BleState>) -> Result<serde_json::Value, String> {
    let items: Vec<serde_json::Value> = {
        let mut b = state.notify_buf.lock().unwrap_or_else(|e| e.into_inner());
        b.drain(..).collect()
    };
    // 丢弃数一并取走并清零：静默丢数据会让人以为"设备就没发那么多"
    let dropped = state.notify_dropped.swap(0, std::sync::atomic::Ordering::Relaxed);
    Ok(json!({ "items": items, "dropped": dropped }))
}

    tauri::Builder::default()
        .manage(PortState {
            readers: RwLock::new(HashMap::new()),
            qcmd_hs: Mutex::new(HashMap::new()),
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
            adapters: Mutex::new(Vec::new()),
            scanning: std::sync::atomic::AtomicBool::new(false),
            connected: Mutex::new(None),
            last_peripheral: Mutex::new(None),
            connected_addr: Mutex::new(None),
            services: Mutex::new(Vec::new()),
            notify_buf: std::sync::Arc::new(Mutex::new(std::collections::VecDeque::new())),
            notify_dropped: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
            notify_spawned: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        })
        .manage(BlePairState { responder: Mutex::new(None) })
        .manage(BlePeripheralState {
            provider: Mutex::new(None),
            service_uuid: Mutex::new(None),
            chars: Mutex::new(Vec::new()),
            adapter: Mutex::new(BlePeriphAdapterInfo::default()),
            pending_writes: std::sync::Arc::new(Mutex::new(std::collections::HashMap::new())),
            write_seq: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
            manual_write_reply: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            events: std::sync::Arc::new(Mutex::new(std::collections::VecDeque::new())),
            running: std::sync::atomic::AtomicBool::new(false),
        })
        .manage(mcp::McpState::default())
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
            quick_cmds_pick_file,
            quick_cmds_read_file,
            quick_cmds_write_file,
            qcmd_hs_arm,
            qcmd_hs_state,
            qcmd_hs_feed,
            qcmd_hs_stop,
            quick_cmds_export_file,
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
            reveal_main_window,
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
            ble_connect_direct,
            ble_get_mtu,
        ble_pair,
        ble_pair_respond,
            ble_disconnect,
            ble_get_connection,
            ble_refresh_rssi,
            ble_get_services,
            ble_read,
            ble_write,
            ble_read_descriptor,
        ble_write_descriptor,
        ble_subscribe,
            ble_unsubscribe,
            ble_poll_notifications,
            ble_periph_start,
            ble_periph_stop,
            ble_periph_status,
            ble_periph_set_value,
            ble_periph_respond_write,
            ble_periph_pick_config_file,
            ble_periph_save_config_file,
            ble_periph_notify,
            ble_periph_poll_events,
            mcp::mcp_status,
            mcp::mcp_set_enabled,
            mcp::mcp_set_read_only,
            mcp::mcp_set_transport,
            mcp::mcp_reset_token,
            mcp::mcp_client_config,
            mcp::mcp_ui_ack,
            mcp::mcp_notify_state,
            mcp::log_push_batch,
            mcp::mcp_report_registry,
            #[cfg(debug_assertions)]
            test_error_report,
        ])
        .setup(|app| {
            // 恢复上次窗口大小与位置（须在窗口创建后、仍可取到 monitors 前完成，
            // 且要在设最小尺寸之后，避免恢复值小于最小尺寸）。
            // 主窗口在 tauri.conf.json 中设为 visible:false（避免先居中/默认尺寸闪现），
            // 几何恢复后由前端页面就绪时调用 reveal_main_window 一次性显示。
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_min_size(Some(tauri::LogicalSize::new(1047.0, 650.0)));
                apply_window_state(&win);
                // 兜底：若前端迟迟未(或未能)主动显示，超时后强制显示，避免窗口一直隐藏
                let reveal_app = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(4000));
                    if let Some(w) = reveal_app.get_webview_window("main") {
                        if !w.is_visible().unwrap_or(true) {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                });
            }
            #[cfg(windows)]
            {
                start_device_watcher(app.handle().clone());
            }
            start_wsl_watcher(app.handle().clone());
            // MCP 服务器随程序启动（配置里 enabled=false 时自动跳过）。
            // 它是"寄生"在应用里的：起不来只写日志与 last_error，绝不影响主功能。
            mcp::autostart(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                    // 拖动/缩放时去抖持久化窗口几何（含最大化标志切换）
                    window_auto_save(window, false);
                }
                tauri::WindowEvent::CloseRequested { .. } => {
                    // 退出前强制保存最终窗口几何
                    window_auto_save(window, true);
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

                    // 断开 BLE：主动 disconnect，让外设侧立刻感知断开，
                    // 否则对端要等监督超时才释放链路（表现为「App 关了但设备仍显示已连接」）
                    if let Some(state) = window.try_state::<BleState>() {
                        let periph = state.connected.lock().unwrap_or_else(|e| e.into_inner()).take();
                        if let Some(p) = periph {
                            let _ = tauri::async_runtime::block_on(async { p.disconnect().await });
                            dbg_log("CloseRequested: BLE disconnected");
                        }
                        state.services.lock().unwrap_or_else(|e| e.into_inner()).clear();
                        *state.connected_addr.lock().unwrap_or_else(|e| e.into_inner()) = None;
                    }

                    // 停止 BLE 从机广播：否则进程退出前手机仍能看到并尝试连接
                    if let Some(state) = window.try_state::<BlePeripheralState>() {
                        if ble_periph_stop_inner(&state) {
                            dbg_log("CloseRequested: BLE peripheral advertising stopped");
                        }
                    }

                    dbg_log("CloseRequested: cleanup done");

                    // MCP：广播收尾信号并释放监听端口/会话（放在最后，前面的清理不该被它拖慢）
                    mcp::shutdown_on_exit(window.app_handle());
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("启动应用失败");
}
