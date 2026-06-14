// Release 模式下隐藏命令行窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serialport::{ClearBuffer, DataBits, Parity, SerialPort, SerialPortInfo, SerialPortType, StopBits};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::windows::process::CommandExt;
use std::sync::Mutex;

/// 全局状态：多个独立串口连接（key = monitor_id）
struct PortState {
    ports: Mutex<HashMap<String, Box<dyn SerialPort>>>,
}

/// 创建不显示控制台窗口的 Command
fn hidden_command(program: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd
}

/// 串口信息（发给前端）
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
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
                    // 从 FriendlyName 中提取 COM 口名（如 "COM3"）
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

fn port_info_from(info: SerialPortInfo, friendly_map: &HashMap<String, String>) -> PortInfo {
    let port_short = if info.port_name.starts_with("/dev/") {
        info.port_name.rsplit('/').next().unwrap_or(&info.port_name).to_string()
    } else {
        info.port_name.clone()
    };

    let mut friendly = match &info.port_type {
        SerialPortType::UsbPort(usb) => {
            let dev_name = usb.product.as_deref()
                .filter(|s| !s.is_empty())
                .or_else(|| usb.manufacturer.as_deref().filter(|s| !s.is_empty()));
            match dev_name {
                Some(name) => format!("{} - {}", port_short, name),
                None => port_short.clone(),
            }
        },
        SerialPortType::BluetoothPort => format!("{} - 蓝牙", port_short),
        _ => port_short.clone(),
    };

    let need_fix = friendly.contains('\u{FFFD}') || friendly == port_short;
    if need_fix {
        #[cfg(windows)]
        if let Some(fixed) = friendly_map.get(&port_short) {
            friendly = fixed.clone();
        } else if friendly.contains('\u{FFFD}') {
            friendly = friendly.replace('\u{FFFD}', "");
        }
        #[cfg(not(windows))]
        {
            friendly = friendly.replace('\u{FFFD}', "");
        }
    }

    PortInfo {
        port_name: info.port_name.clone(),
        friendly_name: friendly,
    }
}

/// 获取所有可用串口列表
#[tauri::command]
fn list_ports() -> Vec<PortInfo> {
    #[cfg(windows)]
    let friendly_map = build_friendly_name_map();
    #[cfg(not(windows))]
    let friendly_map = HashMap::new();

    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| port_info_from(p, &friendly_map))
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
    if let Err(e) = port.set_baud_rate(baud_rate) {
        eprintln!("设置波特率失败: {}", e);
    }

    // 设置数据位
    let db = match data_bits {
        5 => DataBits::Five,
        6 => DataBits::Six,
        7 => DataBits::Seven,
        _ => DataBits::Eight,
    };
    if let Err(e) = port.set_data_bits(db) {
        eprintln!("设置数据位失败: {}", e);
    }

    // 设置停止位
    let sb = match stop_bits {
        2 => StopBits::Two,
        _ => StopBits::One,
    };
    if let Err(e) = port.set_stop_bits(sb) {
        eprintln!("设置停止位失败: {}", e);
    }

    // 设置校验位
    let pr = match parity.as_str() {
        "even" => Parity::Even,
        "odd" => Parity::Odd,
        _ => Parity::None,
    };
    if let Err(e) = port.set_parity(pr) {
        eprintln!("设置校验位失败: {}", e);
    }

    // 设置 DTR/RTS
    if let Err(e) = port.write_data_terminal_ready(dtr) {
        eprintln!("DTR 设置失败: {}", e);
    }
    if let Err(e) = port.write_request_to_send(rts) {
        eprintln!("RTS 设置失败: {}", e);
    }

    let mut guard = state.ports.lock().unwrap_or_else(|e| e.into_inner());
    guard.insert(monitor_id, port);

    Ok(())
}

/// 关闭串口
#[tauri::command]
fn close_port(state: tauri::State<'_, PortState>, monitor_id: String) -> Result<(), String> {
    let mut map = state.ports.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(port) = map.remove(&monitor_id) {
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

/// 读取数据（非阻塞，返回可用字节）
#[tauri::command]
fn read_data(state: tauri::State<'_, PortState>, monitor_id: String) -> Result<Vec<u8>, String> {
    let mut map = state.ports.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ref mut port) = map.get_mut(&monitor_id) {
        let mut buf = [0u8; 4096];
        match port.read(&mut buf) {
            Ok(n) if n > 0 => Ok(buf[..n].to_vec()),
            Ok(_) => Ok(vec![]),
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => Ok(vec![]),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => Ok(vec![]),
            Err(e) => Err(format!("读取失败: {}", e)),
        }
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
    // 1. 查询usbipd获取所有设备信息（使用超时机制）
    let mut usbipd_devices: Vec<(String, String, String, String)> = Vec::new(); // (busid, port, name, status)
    
    use std::sync::mpsc;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let result = hidden_command("usbipd")
            .args(["list"])
            .output();
        let _ = tx.send(result);
    });
    
    let output = match rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(Ok(out)) => Some(out),
        Ok(Err(e)) => {
            println!("[DEBUG] usbipd list 执行失败: {}", e);
            None
        }
        Err(_) => {
            println!("[DEBUG] usbipd list 执行超时");
            None
        }
    };
    
    if let Some(out) = output {
        if out.status.success() {
            let list_str = String::from_utf8_lossy(&out.stdout).to_string();
            
            for line in list_str.lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 3 && parts[0].contains('-') {
                    // 这是一个设备行：BUSID DEVICE STATE ...
                    let busid = parts[0].to_string();
                    let line_upper = line.to_uppercase();
                    
                    // 判断状态
                    let status = if line_upper.contains("ATTACHED") {
                        "attached"
                    } else if line_upper.contains("CONNECTED") || line_upper.contains("SHARED") {
                        "connected"
                    } else {
                        "other"
                    };
                    
                    // 只显示 Connected 和 Attached 状态的设备
                    if status == "other" {
                        continue;
                    }
                    
                    // 提取设备名称（第4列到倒数第2列，排除状态列）
                    let name = if parts.len() > 4 {
                        parts[3..parts.len()-1].join(" ")
                    } else if parts.len() > 3 {
                        parts[3].to_string()
                    } else {
                        format!("USB Device ({})", busid)
                    };
                    
                    // 提取COM端口（如果有）
                    let port = if let Some(com_match) = line.find("COM") {
                        let com_start = com_match;
                        let rest = &line[com_start..];
                        if let Some(end) = rest.find(|c: char| !c.is_alphanumeric()) {
                            rest[..end].to_string()
                        } else {
                            rest.to_string()
                        }
                    } else {
                        busid.clone()
                    };
                    
                    usbipd_devices.push((busid, port, name, status.to_string()));
                }
            }
        }
    }
    
    // 2. 获取系统串口列表，过滤并关联usbipd信息
    let ports = serialport::available_ports().unwrap_or_default();
    let mut devices: Vec<serde_json::Value> = Vec::new();
    
    #[cfg(windows)]
    let friendly_map = build_friendly_name_map();
    
    for p in ports {
        let port_name = p.port_name.clone();
        if !port_name.starts_with("COM") {
            continue;
        }
        
        // 使用预建映射表获取友好名称（一次性遍历，避免逐端口 O(N×M) 查询）
        #[cfg(windows)]
        let friendly = friendly_map.get(&port_name).cloned().unwrap_or(port_name.clone());
        #[cfg(not(windows))]
        let friendly = match &p.port_type {
            serialport::SerialPortType::UsbPort(usb) => {
                usb.product.as_deref()
                    .filter(|s| !s.is_empty())
                    .or_else(|| usb.manufacturer.as_deref().filter(|s| !s.is_empty()))
                    .unwrap_or(&port_name)
                    .to_string()
            },
            _ => port_name.clone(),
        };
        
        let name_lower = friendly.to_lowercase();
        // 排除通讯端口（主板集成串口）
        if name_lower.contains("通信端口") || name_lower.contains("通讯端口") || name_lower.contains("communications port") {
            continue;
        }
        // 排除蓝牙串口
        if name_lower.contains("蓝牙") || name_lower.contains("bluetooth") || name_lower.contains("标准串行") {
            continue;
        }
        
        // 在usbipd列表中查找对应的busid和状态
        if let Some((busid, _, _, status)) = usbipd_devices.iter().find(|(_, port, _, _)| port == &port_name) {
            devices.push(serde_json::json!({
                "busid": busid,
                "port": port_name,
                "name": friendly,
                "status": if status == "attached" { "mapped" } else { "unmapped" }
            }));
        }
    }
    
    // 3. 添加已附加但不在系统串口列表中的设备（可能是WSL中的设备）
    for (busid, port, name, status) in usbipd_devices {
        if status != "attached" {
            continue; // 只添加已附加的设备
        }
        
        let already_listed = devices.iter().any(|d| {
            d["port"].as_str().unwrap_or("") == port || d["busid"].as_str().unwrap_or("") == busid
        });
        
        if !already_listed {
            devices.push(serde_json::json!({
                "busid": busid,
                "port": port,
                "name": name,
                "status": "mapped"
            }));
        }
    }
    
    Ok(devices)
}

/// 将指定串口对应的 USB 设备映射到 WSL
/// 通过 usbipd 工具实现：
///   1. usbipd list 找到目标端口的 busid
///   2. 检查绑定状态，已绑定则直接 attach（无需管理员权限）
///   3. 未绑定则通过 PowerShell 提权执行 bind + attach
#[tauri::command]
fn attach_port_to_wsl(port_name: String) -> Result<String, String> {
    // 1. 获取设备列表（独立线程 + 3s 超时），只找目标端口
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

    // 2. 在输出中只找包含目标端口名的行，提取 busid
    let target_line = list_str.lines()
        .find(|line| line.to_uppercase().contains(&port_name.to_uppercase()))
        .ok_or_else(|| format!("在 usbipd 设备列表中未找到 {}，请确认设备已连接", port_name))?;

    let busid = target_line.split_whitespace().next()
        .map(|s| s.to_string())
        .ok_or_else(|| format!("无法解析 {} 的 busid", port_name))?;

    // 3. 检查绑定状态
    // usbipd list 输出格式可能是：
    // BUSID  DEVICE        STATE
    // 2-3    USB Device    Shared
    // 2-3    USB Device    Not shared
    let already_bound = {
        let line_upper = target_line.to_uppercase();
        // 检查是否包含 "Shared" 但不包含 "Not shared"
        line_upper.contains("SHARED") && !line_upper.contains("NOT SHARED")
    };
    println!("[DEBUG] Device {} bound status: {} (line: {})", busid, already_bound, target_line);

    // 4. 如果已绑定，尝试直接 attach（无需管理员权限）
    if already_bound {
        println!("[DEBUG] Device {} already bound, trying direct attach", busid);
        let output = hidden_command("usbipd")
            .args(["attach", "--wsl", "--busid", &busid])
            .output();

        match output {
            Ok(out) if out.status.success() => {
                println!("[DEBUG] Direct attach succeeded for {}", busid);
                return Ok(format!("已将 {} (busid: {}) 映射到 WSL", port_name, busid));
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                println!("[DEBUG] Direct attach failed for {}: stderr={}, stdout={}", busid, stderr, stdout);
                // 直接attach失败，需要用管理员权限
            }
            Err(e) => {
                println!("[DEBUG] Direct attach command error for {}: {}", busid, e);
                return Err(format!("执行 usbipd attach 失败: {}", e));
            }
        }
    }

    // 5. 未绑定 或 直接attach失败，需要管理员权限
    let tmp_result = std::env::temp_dir().join(format!("usbipd_result_{}.txt", std::process::id()));
    let tmp_result_str = tmp_result.to_str().unwrap_or("C:\\Temp\\usbipd_result.txt").replace('\'', "''");

    let ps_script = if already_bound {
        // 已绑定但直接attach失败，用管理员权限attach
        println!("[DEBUG] Using admin to attach {}", busid);
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
        println!("[DEBUG] Using admin to bind and attach {}", busid);
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

    // 6. 通过 PowerShell Start-Process -Verb RunAs 触发 UAC 提权
    // 先删除旧的结果文件
    let _ = std::fs::remove_file(&tmp_result);
    
    let launcher = format!(
        "Start-Process -FilePath 'powershell' \
         -ArgumentList '-ExecutionPolicy','Bypass','-NonInteractive','-Command',\"{script}\" \
         -Verb RunAs -Wait",
        script = ps_script.replace('"', "`\"")
    );

    println!("[DEBUG] PowerShell script: {}", ps_script);
    println!("[DEBUG] Launcher: {}", launcher);

    let status = hidden_command("powershell")
        .args(["-NonInteractive", "-Command", &launcher])
        .status()
        .map_err(|e| format!("提权启动失败: {}", e))?;

    // 等待一小段时间确保文件写入完成
    std::thread::sleep(std::time::Duration::from_millis(500));

    // 7. 读取提权进程写入的结果文件
    println!("[DEBUG] Reading result file: {:?}", tmp_result);
    let result_content = std::fs::read_to_string(&tmp_result)
        .unwrap_or_else(|e| {
            println!("[DEBUG] Failed to read result file: {}", e);
            String::new()
        })
        .trim()
        .to_string();
    println!("[DEBUG] Result content: {}", result_content);
    let _ = std::fs::remove_file(&tmp_result);

    // 检查是否成功 - 通过结果内容判断
    if result_content.contains("操作成功") {
        Ok(format!("已将 {} (busid: {}) 绑定并映射到 WSL",
            port_name, busid
        ))
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
fn detach_port_from_wsl(busid: String) -> Result<String, String> {
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
    #[cfg(target_os = "macos")]
    {
        dirs_mac_config()
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        std::env::var("HOME").ok().map(|p| std::path::PathBuf::from(p).join(".config").join("seahi-serial"))
    }
}

#[cfg(target_os = "macos")]
fn dirs_mac_config() -> Option<std::path::PathBuf> {
    std::env::var("HOME").ok().map(|p|
        std::path::PathBuf::from(p)
            .join("Library")
            .join("Application Support")
            .join("seahi-serial")
    )
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
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;
    
    // 使用镜像 URL
    let api_url = mirror_github_url("https://api.github.com/repos/SeaHi-Mo/Seahi-Serial/releases/latest");
    
    let resp = client
        .get(&api_url)
        .header("User-Agent", "seahi-serial-updater")
        .send()
        .await
        .map_err(|e| format!("请求 GitHub API 失败: {}", e))?;

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
        // 优先查找 NSIS 安装包（文件名含 -setup.exe）
        let asset = release
            .assets
            .iter()
            .find(|a| a.name.contains("-setup") && a.name.ends_with(".exe"))
            .or_else(|| release.assets.iter().find(|a| a.name.ends_with(".exe")))
            .or_else(|| release.assets.iter().find(|a| a.name.ends_with(".msi")));
        
        match asset {
            Some(a) => mirror_github_url(&a.browser_download_url),
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
    std::process::exit(0);
}

fn main() {
    tauri::Builder::default()
        .manage(PortState {
            ports: Mutex::new(HashMap::new()),
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
            save_config,
            load_config,
            check_update,
            download_update,
            install_update,
        ])
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("启动应用失败");
}
