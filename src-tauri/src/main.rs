// Release 模式下隐藏命令行窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serialport::{ClearBuffer, DataBits, Parity, SerialPort, SerialPortInfo, SerialPortType, StopBits};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

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

/// 将指定串口对应的 USB 设备映射到 WSL
/// 通过 PowerShell Start-Process -Verb RunAs 以管理员权限执行：
///   1. usbipd list 找到目标端口的 busid（带 3s 超时）
///   2. 检查绑定状态，未绑定则先执行 bind
///   3. 执行 attach --wsl
/// UAC 弹窗会请求用户授权，授权后在提权进程中完成操作
#[tauri::command]
fn attach_port_to_wsl(port_name: String) -> Result<String, String> {
    // 1. 获取设备列表（独立线程 + 3s 超时），只找目标端口
    use std::sync::mpsc;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let result = std::process::Command::new("usbipd")
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

    // 3. 检查绑定状态（该行是否包含 "Shared"）
    let already_bound = target_line.to_uppercase().contains("SHARED");

    // 4. 构建 PowerShell 提权脚本
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

    // 5. 通过 PowerShell Start-Process -Verb RunAs 触发 UAC 提权
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

    // 6. 读取提权进程写入的结果文件
    let result_content = std::fs::read_to_string(&tmp_result)
        .unwrap_or_default()
        .trim()
        .to_string();
    let _ = std::fs::remove_file(&tmp_result);

    if status.success() {
        let bind_note = if already_bound { "（已绑定）" } else { "（新绑定并）" };
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
    let secs = now.as_secs();
    let filename = format!("serial-log-{}.txt", secs);
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

/// 检查 GitHub Releases 是否有新版本
#[tauri::command]
fn check_update() -> Result<UpdateInfo, String> {
    let current = get_current_version();
    let client = reqwest::blocking::Client::new();
    let resp = client
        .get("https://api.github.com/repos/SeaHi-Mo/Seahi-Serial/releases/latest")
        .header("User-Agent", "seahi-serial-updater")
        .send()
        .map_err(|e| format!("请求 GitHub API 失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API 返回错误状态码: {}", resp.status()));
    }

    let release: GitHubRelease = resp
        .json()
        .map_err(|e| format!("解析 GitHub 响应失败: {}", e))?;

    let has_update = is_newer_version(&current, &release.tag_name);

    // 查找 Windows 安装包（优先 NSIS .exe，其次 .msi）
    let download_url = if has_update {
        // 优先查找 NSIS 安装包（文件名含 -setup.exe）
        release
            .assets
            .iter()
            .find(|a| a.name.contains("-setup") && a.name.ends_with(".exe"))
            .or_else(|| release.assets.iter().find(|a| a.name.ends_with(".exe")))
            .or_else(|| release.assets.iter().find(|a| a.name.ends_with(".msi")))
            .map(|a| a.browser_download_url.clone())
            .unwrap_or_default()
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
fn download_update(download_url: String) -> Result<String, String> {
    use std::fs;
    use std::io::copy;

    let client = reqwest::blocking::Client::new();
    let mut resp = client
        .get(&download_url)
        .header("User-Agent", "seahi-serial-updater")
        .send()
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

    let mut file = fs::File::create(&file_path).map_err(|e| format!("创建文件失败: {}", e))?;
    copy(&mut resp, &mut file).map_err(|e| format!("写入安装包失败: {}", e))?;

    Ok(file_path.to_string_lossy().to_string())
}

/// 启动安装包并退出当前程序
#[tauri::command]
fn install_update(file_path: String) -> Result<(), String> {
    use std::process::Command;

    #[cfg(windows)]
    {
        // Windows: 启动安装包，不等待其完成
        Command::new("cmd")
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
    std::thread::sleep(std::time::Duration::from_millis(1000));
    std::process::exit(0);
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
            attach_port_to_wsl,
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
