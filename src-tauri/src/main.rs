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

impl From<SerialPortInfo> for PortInfo {
    fn from(info: SerialPortInfo) -> Self {
        // Windows: "COM3", macOS/Linux: "/dev/ttyUSB0" 取最后一段
        let port_short = if info.port_name.starts_with("/dev/") {
            info.port_name.rsplit('/').next().unwrap_or(&info.port_name).to_string()
        } else {
            info.port_name.clone()
        };

        // 构建 "COMX (设备名称)" 格式
        let friendly = match &info.port_type {
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
        ])
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("启动应用失败");
}
