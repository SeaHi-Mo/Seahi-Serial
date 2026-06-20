// Release 模式下隐藏命令行窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serialport::{ClearBuffer, DataBits, Parity, SerialPort, StopBits};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::windows::process::CommandExt;
use std::sync::Mutex;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
use tauri::Emitter;
use serde_json::json;

fn dbg_log(msg: &str) {
    #[cfg(debug_assertions)]
    {
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
    let _ = msg;
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

/// 全局状态：多个独立串口连接（key = monitor_id）
struct PortState {
    ports: Mutex<HashMap<String, Box<dyn SerialPort>>>,
}

/// WSL 串口会话：通过管道与 bridge 脚本通信
struct WslSerialSession {
    child: std::process::Child,
    writer: std::sync::Mutex<std::io::BufWriter<std::process::ChildStdin>>,
    reader: std::sync::Mutex<std::io::BufReader<std::process::ChildStdout>>,
    device_path: String,
    distro: String,
}

/// 全局状态：WSL 串口连接（key = monitor_id）
struct WslSerialState {
    sessions: Mutex<HashMap<String, WslSerialSession>>,
}

/// 创建不显示控制台窗口的 Command
fn hidden_command(program: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW); // CREATE_NO_WINDOW
    cmd
}

/// 带超时执行 Command::output()
fn output_with_timeout(cmd: &mut std::process::Command, timeout_secs: u64) -> Result<std::process::Output, String> {
    use std::sync::mpsc;
    let (tx, rx) = mpsc::channel();
    let child = cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped())
        .spawn().map_err(|e| format!("启动进程失败: {}", e))?;
    let child_id = child.id();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(std::time::Duration::from_secs(timeout_secs)) {
        Ok(result) => result.map_err(|e| format!("进程执行失败: {}", e)),
        Err(_) => {
            unsafe { windows_sys::Win32::System::Threading::TerminateProcess(child_id as *mut _, 1); }
            Err(format!("命令执行超时（{}秒）", timeout_secs))
        }
    }
}

/// 嵌入的 bridge 脚本 base64
const BRIDGE_B64: &str = include_str!("../wsl-daemon/bridge_b64.txt");
const BRIDGE_SCRIPT_PATH: &str = "/tmp/seahi_serial_bridge.py";
const BRIDGE_TIMEOUT_SECS: u64 = 5;

/// 串口信息（发给前端）
#[derive(Debug, serde::Serialize, Clone)]
struct PortInfo {
    port_name: String,
    friendly_name: String,
}

/// Windows 下通过 SetupAPI 一次性遍历所有串口设备，返回 COM 口名 → FriendlyName 的映射表。
/// 用于修复 serialport crate 读取 USB 描述符时中文乱码（U+FFFD）的问题。
#[cfg(windows)]
fn build_friendly_name_map() -> HashMap<String, String> {
    use std::ptr;
    use winapi::shared::guiddef::GUID;
    use winapi::um::setupapi::{
        SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo, SetupDiGetClassDevsW,
        SetupDiGetDeviceRegistryPropertyW, HDEVINFO, SPDRP_FRIENDLYNAME, SP_DEVINFO_DATA,
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

            let mut required_size: u32 = 0;
            let _ = SetupDiGetDeviceRegistryPropertyW(
                h_dev_info,
                &mut dev_info_data,
                SPDRP_FRIENDLYNAME,
                ptr::null_mut(),
                ptr::null_mut(),
                0,
                &mut required_size,
            );

            if required_size == 0 {
                continue;
            }

            let mut buffer: Vec<u16> = vec![0; (required_size / 2 + 1) as usize];
            let mut actual_size: u32 = 0;

            let success = SetupDiGetDeviceRegistryPropertyW(
                h_dev_info,
                &mut dev_info_data,
                SPDRP_FRIENDLYNAME,
                ptr::null_mut(),
                buffer.as_mut_ptr() as *mut u8,
                buffer.len() as u32 * 2,
                &mut actual_size,
            );

            if success != 0 {
                let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
                if let Ok(name) = String::from_utf16(&buffer[..len]) {
                    if let Some(com_start) = name.find("COM") {
                        let rest = &name[com_start..];
                        let com_end = rest.find(|c: char| !c.is_alphanumeric()).unwrap_or(rest.len());
                        let com_port = rest[..com_end].to_string();
                        map.insert(com_port, name);
                    }
                }
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
        .map(|(port_name, friendly_name)| PortInfo { port_name, friendly_name })
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
            PortInfo { port_name: p.port_name.clone(), friendly_name: friendly }
        })
        .collect()
}

/// 打开串口
#[tauri::command]
fn open_port(
    state: tauri::State<'_, PortState>,
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
        let mut map = state.ports.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(old) = map.remove(&monitor_id) {
            let _ = old.clear(ClearBuffer::All);
        }
    }

    let mut port: Box<dyn SerialPort> = serialport::open(&port_name)
            .map_err(|e| format!("打开失败: {}", e))?;

    // 设置波特率
    port.set_baud_rate(baud_rate)
        .map_err(|e| format!("设置波特率失败: {}", e))?;

    // 设置数据位
    let db = match data_bits {
        5 => DataBits::Five,
        6 => DataBits::Six,
        7 => DataBits::Seven,
        _ => DataBits::Eight,
    };
    port.set_data_bits(db)
        .map_err(|e| format!("设置数据位失败: {}", e))?;

    // 设置停止位
    let sb = match stop_bits {
        2 => StopBits::Two,
        _ => StopBits::One,
    };
    port.set_stop_bits(sb)
        .map_err(|e| format!("设置停止位失败: {}", e))?;

    // 设置校验位
    let pr = match parity.as_str() {
        "even" => Parity::Even,
        "odd" => Parity::Odd,
        _ => Parity::None,
    };
    port.set_parity(pr)
        .map_err(|e| format!("设置校验位失败: {}", e))?;

    // 设置 DTR/RTS
    port.write_data_terminal_ready(dtr)
        .map_err(|e| format!("DTR 设置失败: {}", e))?;
    port.write_request_to_send(rts)
        .map_err(|e| format!("RTS 设置失败: {}", e))?;

    let mut guard = state.ports.lock().unwrap_or_else(|e| e.into_inner());
    guard.insert(monitor_id, port);

    Ok(())
}

/// 关闭串口
#[tauri::command]
fn close_port(state: tauri::State<'_, PortState>, monitor_id: String) -> Result<(), String> {
    let mut map = state.ports.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut port) = map.remove(&monitor_id) {
        let _ = port.flush();
        let _ = port.clear(ClearBuffer::All);
    }
    Ok(())
}

/// 发送数据
#[tauri::command]
fn send_data(state: tauri::State<'_, PortState>, monitor_id: String, data: Vec<u8>) -> Result<usize, String> {
    let mut map = state.ports.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ref mut port) = map.get_mut(&monitor_id) {
        port.write_all(&data).map_err(|e| format!("发送失败: {}", e))?;
        Ok(data.len())
    } else {
        Err("未连接串口".into())
    }
}

/// 读取数据（非阻塞，返回所有可用字节）
#[tauri::command]
fn read_data(state: tauri::State<'_, PortState>, monitor_id: String) -> Result<Vec<u8>, String> {
    let mut map = state.ports.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ref mut port) = map.get_mut(&monitor_id) {
        let mut all_data = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            match port.read(&mut buf) {
                Ok(n) if n > 0 => all_data.extend_from_slice(&buf[..n]),
                Ok(_) => break,
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => break,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(e) if all_data.is_empty() => return Err(format!("读取失败: {}", e)),
                Err(_) => break,
            }
        }
        Ok(all_data)
    } else {
        Err("未连接串口".into())
    }
}

/// 实时设置 DTR 信号
#[tauri::command]
fn set_dtr(state: tauri::State<'_, PortState>, monitor_id: String, level: bool) -> Result<(), String> {
    let mut map = state.ports.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ref mut port) = map.get_mut(&monitor_id) {
        port.write_data_terminal_ready(level).map_err(|e| format!("DTR 设置失败: {}", e))
    } else {
        Err("未连接串口".into())
    }
}

/// 实时设置 RTS 信号
#[tauri::command]
fn set_rts(state: tauri::State<'_, PortState>, monitor_id: String, level: bool) -> Result<(), String> {
    let mut map = state.ports.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ref mut port) = map.get_mut(&monitor_id) {
        port.write_request_to_send(level).map_err(|e| format!("RTS 设置失败: {}", e))
    } else {
        Err("未连接串口".into())
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
    
    let mut devices: Vec<serde_json::Value> = Vec::new();
    
    if let Some(out) = output {
        if out.status.success() {
            let list_str = String::from_utf8_lossy(&out.stdout).to_string();
            
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
                    
                    devices.push(serde_json::json!({
                        "busid": busid,
                        "port": port,
                        "name": name,
                        "hasCom": has_com,
                        "status": if status == "attached" && wsl_running { "mapped" } else { "unmapped" }
                    }));
                }
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

fn start_wsl_watcher(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut last_running = false;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let running = !check_wsl_running().unwrap_or_default().is_empty();
            if running != last_running {
                last_running = running;
                dbg_log(&format!("wsl_watcher: status changed, running={}", running));
                let _ = app.emit("wsl-status-changed", running);
            }
        }
    });
}

/// 启动 WSL 终端（可指定分发版）
#[tauri::command]
fn launch_wsl(dist: Option<String>) -> Result<(), String> {
    let mut cmd = std::process::Command::new("powershell");
    cmd.args(["-NoExit", "-Command"]);
    if let Some(ref d) = dist {
        cmd.args(["wsl", "-d", d]);
    } else {
        cmd.args(["wsl"]);
    }
    cmd.spawn().map_err(|e| format!("{}", e))?;
    Ok(())
}

/// 关闭指定 WSL 分发版
#[tauri::command]
fn shutdown_wsl(dist: String) -> Result<(), String> {
    let out = hidden_command("wsl")
        .args(["-t", &dist])
        .output()
        .map_err(|e| format!("{}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("关闭 WSL 发行版失败: {}", stderr.trim()));
    }
    Ok(())
}

/// 获取所有 WSL 分发版信息
#[tauri::command]
fn get_wsl_distributions() -> Result<Vec<serde_json::Value>, String> {
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
        let running = state_str.contains("running") || state_str.contains("运行");

        let (uptime, mem_used, mem_total) = if running {
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

/// 部署 bridge 脚本到指定 WSL 发行版
fn deploy_bridge(distro: &str) -> Result<(), String> {
    let b64 = BRIDGE_B64.trim();
    let tmp_b64 = std::env::temp_dir().join("seahi_bridge_b64.txt");
    std::fs::write(&tmp_b64, b64).map_err(|e| format!("写入临时文件失败: {}", e))?;
    let wsl_path = std::process::Command::new("wsl")
        .args(["-d", distro, "wslpath", "-u", tmp_b64.to_str().unwrap_or("")])
        .output()
        .map_err(|e| format!("路径转换失败: {}", e))?;
    let wsl_b64_path = String::from_utf8_lossy(&wsl_path.stdout).trim().to_string();
    let decode_cmd = format!("base64 -d < {} > {}", wsl_b64_path, BRIDGE_SCRIPT_PATH);
    let out = std::process::Command::new("wsl")
        .args(["-d", distro, "-e", "bash", "-c", &decode_cmd])
        .output()
        .map_err(|e| format!("解码失败: {}", e))?;
    let _ = std::fs::remove_file(&tmp_b64);
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("部署 bridge 失败: {}", String::from_utf8_lossy(&out.stderr)))
    }
}

/// 通过 bridge 会话发送命令并读取响应
fn bridge_command(session: &WslSerialSession, cmd: &serde_json::Value) -> Result<serde_json::Value, String> {
    use std::io::{BufRead, Write};
    let mut msg = serde_json::to_string(cmd).map_err(|e| format!("序列化失败: {}", e))?;
    msg.push('\n');
    {
        let mut w = session.writer.lock().map_err(|e| format!("锁失败: {}", e))?;
        w.write_all(msg.as_bytes()).map_err(|e| format!("写入失败: {}", e))?;
        w.flush().map_err(|e| format!("刷新失败: {}", e))?;
    }
    let mut r = session.reader.lock().map_err(|e| format!("锁失败: {}", e))?;
    let mut resp_line = String::new();
    r.read_line(&mut resp_line).map_err(|e| format!("读取响应失败: {}", e))?;
    serde_json::from_str(resp_line.trim()).map_err(|e| format!("解析响应失败: {}", e))
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
    { let mut s = state.sessions.lock().unwrap(); if let Some(mut old) = s.remove(&monitor_id) { let _ = old.child.kill(); let _ = old.child.wait(); } }
    let distros = check_wsl_running().unwrap_or_default();
    let distro = distros.first().ok_or("没有运行中的 WSL 发行版，请先启动一个 WSL 终端")?.clone();
    deploy_bridge(&distro)?;
    let mut child = std::process::Command::new("wsl")
        .args(["-d", &distro, "-e", "python3", BRIDGE_SCRIPT_PATH])
        .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).stdin(std::process::Stdio::piped())
        .spawn().map_err(|e| format!("启动 bridge 失败: {}", e))?;
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
    let reader = std::sync::Mutex::new(std::io::BufReader::new(stdout));
    let mut session = WslSerialSession { child, writer, reader, device_path: device_path.clone(), distro };
    let resp = bridge_command(&session, &json!({"cmd":"open","id":&monitor_id,"path":&device_path,"baud":baud_rate}))?;
    if resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        state.sessions.lock().unwrap().insert(monitor_id, session);
        Ok(())
    } else {
        let err = resp.get("error").and_then(|v| v.as_str()).unwrap_or("打开失败").to_string();
        let _ = session.child.kill();
        let _ = session.child.wait();
        Err(err)
    }
}

/// 关闭 WSL 串口连接
#[tauri::command]
fn close_wsl_serial(state: tauri::State<'_, WslSerialState>, monitor_id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(mut session) = sessions.remove(&monitor_id) {
        { use std::io::Write; if let Ok(mut w) = session.writer.lock() { let _ = w.write_all(b"{\"cmd\":\"close\"}\n"); let _ = w.flush(); } }
        let _ = session.child.kill(); let _ = session.child.wait();
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

/// 获取 WSL 中可用的串口设备列表
#[tauri::command]
fn get_wsl_serial_devices() -> Result<Vec<String>, String> {
    if check_wsl_running().unwrap_or_default().is_empty() {
        return Ok(vec![]);
    }

    let output = hidden_command("wsl")
        .args(["-e", "bash", "-c", "ls /dev/ttyACM* /dev/ttyUSB* /dev/ttyS* 2>/dev/null || true"])
        .output()
        .map_err(|e| format!("执行失败: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let devices: Vec<String> = stdout
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s.starts_with("/dev/tty"))
        .collect();

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
        let output = hidden_command("usbipd")
            .args(["detach", "--busid", &busid])
            .output()
            .map_err(|e| format!("执行 usbipd detach 失败: {}", e))?;

        if output.status.success() {
            Ok(format!("已断开 {} 的WSL映射", busid))
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            Err(format!("断开失败: {}", stderr))
        }
    })
    .await
    .map_err(|e| format!("任务执行失败: {}", e))?
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
    use std::time::SystemTime;

    if path.is_empty() {
        return Err("未设置日志目录".into());
    }

    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let millis = now.as_millis();
    let filename = format!("serial-log-{}.txt", millis);
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

/// 将 GitHub URL 转换为镜像 URL（用于国内网络环境）
fn mirror_github_url(url: &str) -> String {
    // 使用 GitHub 镜像加速（保留完整URL作为代理路径）
    if url.starts_with("https://github.com/") {
        return format!("https://mirror.ghproxy.com/{}", url);
    }
    if url.starts_with("https://api.github.com/") {
        return format!("https://mirror.ghproxy.com/{}", url);
    }
    url.to_string()
}

/// 比较版本号：如果 latest > current，返回 true
fn is_newer_version(current: &str, latest: &str) -> bool {
    parse_version(current) < parse_version(latest)
}

/// 获取当前程序版本号（从 Cargo.toml 的 version 字段编译时注入）
fn get_current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
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
    let mirror_url = mirror_github_url(api_url);

    // 先直连，失败再走镜像
    let resp = match client
        .get(api_url)
        .header("User-Agent", "seahi-serial-updater")
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        _ => client
            .get(&mirror_url)
            .header("User-Agent", "seahi-serial-updater")
            .send()
            .await
            .map_err(|e| format!("请求 GitHub API 失败: {}", e))?,
    };

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
    
    let mirror_url = mirror_github_url(&download_url);

    // 先直连，失败再走镜像
    let resp = match client
        .get(&download_url)
        .header("User-Agent", "seahi-serial-updater")
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        _ => client
            .get(&mirror_url)
            .header("User-Agent", "seahi-serial-updater")
            .send()
            .await
            .map_err(|e| format!("下载失败: {}", e))?,
    };

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
fn install_update(file_path: String) -> Result<(), String> {
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

    // 给安装程序一点时间启动，然后退出当前程序
    std::thread::sleep(std::time::Duration::from_millis(500));
    // 使用 tauri 的退出机制而非 process::exit，确保 Drop 被执行
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
    window.set_size(tauri::Size::Physical(tauri::PhysicalSize { width, height }))
        .map_err(|e| format!("设置窗口大小失败: {}", e))
}

fn main() {
    tauri::Builder::default()
        .manage(PortState {
            ports: Mutex::new(HashMap::new()),
        })
        .manage(WslSerialState {
            sessions: Mutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            list_ports,
            list_wsl_devices,
            open_port,
            close_port,
            send_data,
            read_data,
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
        ])
        .setup(|app| {
            #[cfg(windows)]
            start_device_watcher(app.handle().clone());
            start_wsl_watcher(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动应用失败");
}
