# SeaHi Serial - Rust 后端 API 详细参考

> 来源: src-tauri/src/main.rs

## 数据结构

### PortState（全局状态）

```rust
struct PortState {
    ports: Mutex<HashMap<String, Box<dyn SerialPort>>>,
}
```

- 通过 `tauri::Builder.manage()` 注入
- Key: monitor_id（如 "main", "extra-1"）
- Value: 串口实例

### PortInfo（端口信息）

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
struct PortInfo {
    port_name: String,       // "COM3"
    friendly_name: String,   // "COM3 - Silicon Labs CP210x"
}
```

实现了 `From<SerialPortInfo>` trait，根据端口类型自动生成友好名称：
- USB 串口: `{port_name} - {manufacturer} - {product}`
- 蓝牙串口: `{port_name} - Bluetooth`
- 其他: `{port_name}`

## 命令详解

### list_ports

```rust
fn list_ports() -> Result<Vec<PortInfo>, String>
```

枚举所有可用串口，返回友好名称列表。无参数。

### open_port

```rust
fn open_port(
    state: State<PortState>,
    monitor_id: String,
    port_name: String,
    baud_rate: u32,
    data_bits: u8,
    stop_bits: u8,
    parity: String,
    dtr: bool,
    rts: bool,
) -> Result<(), String>
```

打开并配置串口。如果同名 monitor_id 已有连接，先关闭旧的再打开新的。

参数映射：
- `data_bits`: 5 → DataBits::Five, 6 → Six, 7 → Seven, 8 → Eight
- `stop_bits`: 1 → StopBits::One, 2 → StopBits::Two
- `parity`: "none" → Parity::None, "odd" → Parity::Odd, "even" → Parity::Even

### close_port

```rust
fn close_port(state: State<PortState>, monitor_id: String) -> Result<(), String>
```

关闭串口并从 HashMap 中移除。flush_then_close 清空缓冲区。

### send_data

```rust
fn send_data(
    state: State<PortState>,
    monitor_id: String,
    data: Vec<u8>,
) -> Result<usize, String>
```

向串口写入数据，返回写入字节数。

### read_data

```rust
fn read_data(state: State<PortState>, monitor_id: String) -> Result<Vec<u8>, String>
```

非阻塞读取，4KB 缓冲区。处理逻辑：
- `Ok(n) where n > 0` → 返回数据
- `Ok(0)` → 返回空 Vec
- `TimedOut` / `WouldBlock` → 返回空 Vec（正常情况）
- 其他错误 → 返回错误字符串

### set_dtr / set_rts

```rust
fn set_dtr(state: State<PortState>, monitor_id: String, level: bool) -> Result<(), String>
fn set_rts(state: State<PortState>, monitor_id: String, level: bool) -> Result<(), String>
```

实时控制 DTR/RTS 信号电平。适用于 ESP32/STM32 下载复位。

### choose_log_directory

```rust
fn choose_log_directory() -> Result<Option<String>, String>
```

使用 `rfd` 打开原生目录选择对话框，返回选中路径或 None。

### save_log

```rust
fn save_log(content: String, path: String) -> Result<(), String>
```

保存日志到指定路径，文件名格式：`serial-log-{timestamp}.txt`

## 串口参数默认值

| 参数 | 默认值 | 可选值 |
|------|--------|--------|
| 波特率 | 115200 | 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 自定义 |
| 数据位 | 8 | 5, 6, 7, 8 |
| 停止位 | 1 | 1, 2 |
| 校验位 | none | none, odd, even |
| DTR | true | true, false |
| RTS | true | true, false |
