// Release 模式下隐藏命令行窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serialport::{ClearBuffer, DataBits, Parity, SerialPort, SerialPortInfo, SerialPortType, StopBits};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::Emitter;

/// 全局状态：多个独立串口连接（key = monitor_id）
struct PortState {
    ports: Mutex<HashMap<String, Box<dyn SerialPort>>>,
}

/// 串口信息（发给前端）
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
struct PortInfo {
    port_name: String,
    friendly_name: String,
}

/// Windows 下通过 SetupAPI 以 UTF-16 读取串口设备的 FriendlyName，
/// 用于修复 serialport crate 读取 USB 描述符时中文乱码（U+FFFD）的问题。
#[cfg(windows)]
fn get_port_friendly_name_winapi(port_name: &str) -> Option<String> {
    use std::ptr;
    use winapi::shared::guiddef::GUID;
    use winapi::um::setupapi::{
        SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo, SetupDiGetClassDevsW,
        SetupDiGetDeviceRegistryPropertyW, HDEVINFO, SPDRP_FRIENDLYNAME, SP_DEVINFO_DATA,
        DIGCF_PRESENT,
    };

    // GUID_DEVCLASS_PORTS = {4D36E978-E325-11CE-BFC1-08002BE10318}
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
            return None;
        }

        let mut dev_info_data: SP_DEVINFO_DATA = std::mem::zeroed();
        dev_info_data.cbSize = std::mem::size_of::<SP_DEVINFO_DATA>() as u32;

        let mut index: u32 = 0;
        while SetupDiEnumDeviceInfo(h_dev_info, index, &mut dev_info_data) != 0 {
            index += 1;

            // 第一次调用获取缓冲区大小
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

            // 分配 UTF-16 缓冲区
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
                    if name.contains(port_name) {
                        SetupDiDestroyDeviceInfoList(h_dev_info);
                        return Some(name);
                    }
                }
            }
        }

        SetupDiDestroyDeviceInfoList(h_dev_info);
    }

    None
}

impl From<SerialPortInfo> for PortInfo {
    fn from(info: SerialPortInfo) -> Self {
        // Windows: "COM3", macOS/Linux: "/dev/ttyUSB0" 取最后一段
        let port_short = if info.port_name.starts_with("/dev/") {
            info.port_name.rsplit('/').next().unwrap_or(&info.port_name).to_string()
        } else {
            info.port_name.clone()
        };

        // 构建 "COMX (设备名称)" 格式
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

        // 修复：如果名称中包含 Unicode 替换字符（U+FFFD，显示为 ◆），
        // 说明 serialport crate 读取 USB 描述符时编码出错（常见于 CH340/CH341 中文设备名）。
        // 此时通过 Windows SetupAPI 以 UTF-16 重新读取正确的 FriendlyName。
        if friendly.contains('\u{FFFD}') {
            #[cfg(windows)]
            if let Some(fixed) = get_port_friendly_name_winapi(&port_short) {
                friendly = fixed;
            } else {
                // 后备：去掉替换字符，避免显示成 ◆◆◆◆◆◆
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
}

/// 获取所有可用串口列表
#[tauri::command]
fn list_ports() -> Vec<PortInfo> {
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| PortInfo::from(p))
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
        let mut map = state.ports.lock().unwrap();
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

    let mut guard = state.ports.lock().unwrap();
    guard.insert(monitor_id, port);

    Ok(())
}

/// 关闭串口
#[tauri::command]
fn close_port(state: tauri::State<'_, PortState>, monitor_id: String) -> Result<(), String> {
    let mut map = state.ports.lock().unwrap();
    if let Some(port) = map.remove(&monitor_id) {
        let _ = port.clear(ClearBuffer::All);
    }
    Ok(())
}

/// 发送数据
#[tauri::command]
fn send_data(state: tauri::State<'_, PortState>, monitor_id: String, data: Vec<u8>) -> Result<usize, String> {
    let mut map = state.ports.lock().unwrap();
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
    let mut map = state.ports.lock().unwrap();
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
    let mut map = state.ports.lock().unwrap();
    if let Some(ref mut port) = map.get_mut(&monitor_id) {
        port.write_data_terminal_ready(level).map_err(|e| format!("DTR 设置失败: {}", e))
    } else {
        Err("未连接串口".into())
    }
}

/// 实时设置 RTS 信号
#[tauri::command]
fn set_rts(state: tauri::State<'_, PortState>, monitor_id: String, level: bool) -> Result<(), String> {
    let mut map = state.ports.lock().unwrap();
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

/// 检查 usbipd-win 是否已安装，返回版本字符串或 "not_found"
/// 仅供安装流程调用，正常映射操作不需要调用此函数
#[tauri::command]
fn check_usbipd() -> String {
    match std::process::Command::new("usbipd")
        .args(["--version"])
        .output()
    {
        Ok(out) if out.status.success() => {
            let ver = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if ver.is_empty() { "installed".to_string() } else { ver }
        }
        _ => "not_found".to_string(),
    }
}

/// 从 GitHub releases 获取最新 usbipd-win MSI，通过 PowerShell 以管理员权限安装
#[tauri::command]
fn install_usbipd() -> Result<String, String> {
    // 1. 查询 GitHub API 最新 release
    let client = reqwest::blocking::Client::builder()
        .user_agent("seahi-serial")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("网络初始化失败: {}", e))?;

    let resp: serde_json::Value = client
        .get("https://api.github.com/repos/dorssel/usbipd-win/releases/latest")
        .send()
        .map_err(|e| format!("获取版本信息失败: {}", e))?
        .json()
        .map_err(|e| format!("解析版本信息失败: {}", e))?;

    // 2. 找到 .msi 下载地址
    let msi_url = resp["assets"]
        .as_array()
        .and_then(|arr| {
            arr.iter().find(|a| {
                a["name"].as_str()
                    .map(|n| n.ends_with(".msi"))
                    .unwrap_or(false)
            })
        })
        .and_then(|a| a["browser_download_url"].as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "未找到 MSI 安装包".to_string())?;

    let version = resp["tag_name"].as_str().unwrap_or("未知").to_string();

    // 3. 下载 MSI 到临时目录
    let tmp_dir = tempfile::tempdir()
        .map_err(|e| format!("创建临时目录失败: {}", e))?;
    let msi_path = tmp_dir.path().join("usbipd-win.msi");

    let mut response = client
        .get(&msi_url)
        .send()
        .map_err(|e| format!("下载失败: {}", e))?;

    let mut file = std::fs::File::create(&msi_path)
        .map_err(|e| format!("创建文件失败: {}", e))?;
    std::io::copy(&mut response, &mut file)
        .map_err(|e| format!("写入文件失败: {}", e))?;

    // 4. 通过 PowerShell Start-Process -Verb RunAs 触发 UAC，以管理员权限静默安装
    let msi_str = msi_path.to_str().unwrap_or("").replace('\'', "''");
    let ps_script = format!(
        "Start-Process -FilePath 'msiexec' -ArgumentList '/i','{}','/quiet','/norestart' -Verb RunAs -Wait",
        msi_str
    );
    let status = std::process::Command::new("powershell")
        .args(["-NonInteractive", "-Command", &ps_script])
        .status()
        .map_err(|e| format!("安装启动失败: {}", e))?;

    if status.success() {
        Ok(format!("usbipd-win {} 安装成功", version))
    } else {
        Err(format!("安装失败，退出码: {:?}（用户取消或权限不足）", status.code()))
    }
}

/// 内部 helper：快速预检 usbipd 是否存在，然后带 3 秒超时执行 usbipd list
fn run_usbipd_list_with_timeout() -> Result<String, String> {
    // 1. 快速预检：usbipd 是否在 PATH 中
    let quick_check = std::process::Command::new("usbipd")
        .args(["--version"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();

    match quick_check {
        Ok(s) if s.success() => {}
        _ => {
            return Err(
                "usbipd-win 未安装或不在 PATH 中\n"
                    .to_string()
                    + "可通过调试器工具栏的 WSL 映射按钮自动安装，"
                    + "或访问 https://github.com/dorssel/usbipd-win/releases 手动下载安装包",
            );
        }
    }

    // 2. 主命令在独立线程中执行，带 3 秒超时
    use std::sync::mpsc;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let result = std::process::Command::new("usbipd")
            .args(["list"])
            .output();
        let _ = tx.send(result);
    });

    match rx.recv_timeout(std::time::Duration::from_secs(3)) {
        Ok(Ok(out)) => {
            if out.status.success() {
                Ok(String::from_utf8_lossy(&out.stdout).to_string())
            } else {
                Err(String::from_utf8_lossy(&out.stderr).to_string())
            }
        }
        Ok(Err(e)) => Err(format!("执行 usbipd list 失败: {}", e)),
        Err(_) => Err(
            "usbipd list 执行超时（3 秒）\n".to_string()
                + "可能原因：usbipd-win 未正确安装，或系统正在等待用户交互。",
        ),
    }
}

/// 列出 usbipd 管理的 USB 设备（原始输出）
#[tauri::command]
fn list_usb_devices() -> Result<String, String> {
    run_usbipd_list_with_timeout()
}

/// 将指定串口对应的 USB 设备映射到 WSL
/// 通过 PowerShell Start-Process -Verb RunAs 以管理员权限执行：
///   1. 检查绑定状态，未绑定则先执行 bind
///   2. 执行 attach --wsl
/// UAC 弹窗会请求用户授权，授权后在提权进程中完成操作
#[tauri::command]
fn attach_port_to_wsl(port_name: String) -> Result<String, String> {
    // 1. 普通权限获取设备列表，找到对应 busid（带超时和预检）
    let list_str = run_usbipd_list_with_timeout()?;

    // 在输出中寻找包含 port_name（如 COM3）的行，提取 busid（格式 x-y）
    let busid = list_str.lines()
        .find(|line| {
            let upper = line.to_uppercase();
            upper.contains(&port_name.to_uppercase())
        })
        .and_then(|line| {
            // busid 是行首的 x-y 格式，如 "2-3  ..."
            line.split_whitespace().next()
        })
        .map(|s| s.to_string())
        .ok_or_else(|| format!("在 usbipd 设备列表中未找到 {}，请确认设备已连接", port_name))?;

    // 2. 检查当前绑定状态（查找该行是否包含 "Shared" 关键字，表示已绑定）
    let already_bound = list_str.lines()
        .find(|line| line.to_uppercase().contains(&port_name.to_uppercase()))
        .map(|line| line.to_uppercase().contains("SHARED"))
        .unwrap_or(false);

    // 3. 构建 PowerShell 提权脚本
    //    - 若未绑定：先 bind，再 attach --wsl
    //    - 若已绑定：直接 attach --wsl
    //    使用临时文件传递执行结果，因为提权进程的 stdout 无法直接捕获
    let tmp_result = std::env::temp_dir().join(format!("usbipd_result_{}.txt", std::process::id()));
    let tmp_result_str = tmp_result.to_str().unwrap_or("C:\\Temp\\usbipd_result.txt").replace('\'', "''");

    let ps_script = if already_bound {
        format!(
            "$out = & usbipd attach --wsl --busid '{}' 2>&1; \
             $out | Out-File -FilePath '{}' -Encoding UTF8; \
             if ($LASTEXITCODE -ne 0) {{ exit 1 }}",
            busid, tmp_result_str
        )
    } else {
        format!(
            "$bind = & usbipd bind --busid '{}' 2>&1; \
             if ($LASTEXITCODE -ne 0 -and $bind -notmatch 'already') {{ \
               $bind | Out-File -FilePath '{}' -Encoding UTF8; exit 1 \
             }}; \
             $out = & usbipd attach --wsl --busid '{}' 2>&1; \
             $out | Out-File -FilePath '{}' -Encoding UTF8; \
             if ($LASTEXITCODE -ne 0) {{ exit 1 }}",
            busid, tmp_result_str, busid, tmp_result_str
        )
    };

    // 4. 通过 PowerShell Start-Process -Verb RunAs 触发 UAC 提权
    let launcher = format!(
        "Start-Process -FilePath 'powershell' \
         -ArgumentList '-NonInteractive','-Command',\"{}\" \
         -Verb RunAs -Wait",
        ps_script.replace('"', "`\"")
    );

    let status = std::process::Command::new("powershell")
        .args(["-NonInteractive", "-Command", &launcher])
        .status()
        .map_err(|e| format!("提权启动失败: {}", e))?;

    // 5. 读取提权进程写入的结果文件
    let result_content = std::fs::read_to_string(&tmp_result)
        .unwrap_or_default()
        .trim()
        .to_string();
    let _ = std::fs::remove_file(&tmp_result);

    if status.success() {
        let bind_note = if already_bound { "（已绑定）" } else { "（已绑定并）" };
        Ok(format!("已将 {} (busid: {}) {}映射到 WSL{}",
            port_name, busid, bind_note,
            if result_content.is_empty() { String::new() } else { format!("\n{}", result_content) }
        ))
    } else {
        if result_content.is_empty() {
            Err(format!("操作失败或用户取消了管理员权限请求（busid: {}）", busid))
        } else {
            Err(format!("映射失败: {}", result_content))
        }
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
    let secs = now.as_secs();
    let filename = format!("serial-log-{}.txt", secs);
    let filepath = Path::new(&path).join(&filename);

    fs::write(&filepath, content).map_err(|e| format!("写入日志失败: {}", e))?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(PortState {
            ports: Mutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            list_ports,
            open_port,
            close_port,
            send_data,
            read_data,
            set_dtr,
            set_rts,
            choose_log_directory,
            save_log,
            check_usbipd,
            install_usbipd,
            list_usb_devices,
            attach_port_to_wsl,
        ])
        .setup(|app| {
            // 程序启动时检查 usbipd-win 是否已安装
            // 若未安装，向前端发送通知事件
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                let installed = std::process::Command::new("usbipd")
                    .args(["--version"])
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false);
                if !installed {
                    // 延迟 800ms，确保前端页面已加载完成
                    std::thread::sleep(std::time::Duration::from_millis(800));
                    let _ = app_handle.emit("usbipd-not-found", ());
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动应用失败");
}
