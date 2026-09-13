# Tauri 后端能力全量盘点（为挂载 MCP SSE 服务器做准备）

- 盘点对象：`src-tauri/src/main.rs`（**7045 行**，单文件）
- 交叉验证：`src/index.html`（10610 行，前端单文件）
- 辅助配置：`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/capabilities/default.json`、`package.json`
- 方式：全文分段通读 + 正则全量抽取 + 前端 `invoke(` / `listen(` 反查。**未修改任何代码文件。**
- 版本：`Cargo.toml` / `tauri.conf.json` / `package.json` 均为 **0.4.1**（identifier `com.seahi.seahi-serial`，产物 `seahi-serial.exe`）

---

## 0. 总览数字（先看这一节）

| 指标 | 数值 | 说明 |
|---|---|---|
| `#[tauri::command]` 属性标记数 | **87** | 其中 `list_ports` 有 2 个（`cfg(windows)` / `cfg(not(windows))` 双实现） |
| **实际注册进 `generate_handler!` 的命令数** | **85** | 逐条核对 `invoke_handler` 数组 = 85 |
| 有 `#[tauri::command]` 但**未注册**的函数 | **1** | `run_usbipd_list_elevated`（L1534/L1536，是内部辅助函数，被 `list_wsl_devices_blocking` 直接调用，标了宏但没进 handler → 宏是冗余的） |
| 前端 `invoke('名字'` 命中（含动态派发） | **80 / 85** | 5 个命令前端完全未调用 |
| 前端完全未调用的命令 | **5** | `list_log_cache`、`load_workflows`、`adb_tool_status`、`adb_shell`、`adb_exec` |
| 后端 → 前端的事件通道 | **4** | `device-changed`、`wsl-status-changed`、`ble-pair-request`、`save-before-exit` |
| 前端 `listen(` 监听点 | **4** | 与上表 1:1 对应 |
| `.manage(...)` 托管状态 | **8** | 见第 4 节 |
| 模块级全局 `static`（未托管） | **11** | 见第 4.2 节，也是隐藏的全局可变状态 |
| 应用内 HTTP 服务 / 监听端口 | **0** | 无 `TcpListener`、无 named pipe 显式代码、无 HTTP server |
| 仓库内潜在端口占用 | **2 处** | `3000`（Node 错误服务，非本进程）、**`19876`（WSL 侧 Python daemon，死代码）** |

### 分类计数（主分类，一命令一主类）

| 分类 | 数量 | 命令 |
|---|---|---|
| **纯读** | **17** | `list_ports`、`read_data`、`read_workflow_events`、`load_workflows`、`load_config`、`list_log_cache`、`get_window_size`、`get_app_info`、`adb_shell_read`、`ble_get_adapters`、`ble_get_devices`、`ble_get_connection`、`ble_get_mtu`、`ble_get_services`、`ble_poll_notifications`、`ble_periph_status`、`ble_periph_poll_events` |
| **改后端状态** | **7** | `save_workflows`、`init_workflows`、`update_workflow_log_dir`、`update_workflow_line_ending`、`start_log_cache`、`ble_pair_respond`、`ble_periph_set_value` |
| **有外部副作用** | **61** | 其余全部（开串口/发数据/跑进程/写文件/连蓝牙/弹原生对话框/网络/窗口） |
| **长耗时阻塞（含该性质，多标签）** | **≈48** | 见第 1.8 节「长耗时与 `spawn_blocking` 现状」——**这是挂 MCP 时最需要注意的一节** |

---

## 1. 命令全量清单（85 条）

字段说明：
- **参数**：`S<X>` = `tauri::State<'_, X>`；其余为普通参数（Tauri 会把 `snake_case` 参数名自动转成前端 `camelCase`）。
- **返回**：`Result<T, E>` 中的 T；`()` 表示无返回。
- **同步性**：`sync` = 普通 `fn`（**跑在主线程/命令线程上，会阻塞 UI**）；`async` = `async fn`。
- **前端**：`✓` 表示 `src/index.html` 中存在 `invoke('<名字>'` 或经动态派发调用（括号内为出现次数）；`✗` 表示前端零调用。

### 1.1 串口核心（`PortState`，8 条）

| # | 函数名 | 参数 | 返回 T | 一句话用途 | 分类 | 同步 | 前端 |
|---|---|---|---|---|---|---|---|
| 1 | `list_ports` | 无 | `Vec<PortInfo>`<br>`PortInfo { port_name: String, friendly_name: String, product_name: String }` | 用 SetupAPI 枚举所有 COM 口（含友好名/产品名），非 Windows 走 `serialport::available_ports` | 纯读（系统探测，已 `spawn_blocking`） | async | ✓ (1) |
| 2 | `open_port` | `S<PortState>`, `S<WorkflowState>`, `monitor_id:String`, `port_name:String`, `baud_rate:u32`, `data_bits:u8`, `stop_bits:u8`, `parity:String`, `dtr:bool`, `rts:bool` | `()` | 打开串口、配置串口参数、建 `PortReader`（3 条后台线程：读 / 工作流 / 动作）并同步已有规则 | **外部副作用（开串口/占资源）+ 长耗时** | **sync** | ✓ (1) |
| 3 | `close_port` | `S<PortState>`, `monitor_id:String` | `()` | 停止读线程并快速释放串口（`try_lock` + 最多 200ms 等待） | **外部副作用 + 长耗时** | **sync** | ✓ (4) |
| 4 | `read_data` | `S<PortState>`, `monitor_id:String` | `ReadDataResult { bytes: Vec<u8>, dropped: u64 }` | 取走接收缓冲 + 本次因超限丢弃的字节数（前端高频轮询） | **纯读**（副作用：设备断开时上报一次错误） | **sync** | ✓ (1) |
| 5 | `send_data` | `S<PortState>`, `monitor_id:String`, `data:Vec<u8>` | `usize`（发送字节数） | 向串口写数据（锁带 500ms 超时，写阻塞已移入 `spawn_blocking`） | 外部副作用（发数据） | async | ✓ (1) |
| 6 | `set_dtr` | `S<PortState>`, `monitor_id:String`, `level:bool` | `()` | 实时设置 DTR | 外部副作用（硬件信号） | **sync** | ✓ (1) |
| 7 | `set_rts` | `S<PortState>`, `monitor_id:String`, `level:bool` | `()` | 实时设置 RTS | 外部副作用（硬件信号） | **sync** | ✓ (1) |
| 8 | `read_workflow_events` | `S<PortState>`, `monitor_id:String` | `Vec<String>`（`[Auto] …` 文本） | 取走工作流触发事件队列 | **纯读**（消费队列） | **sync** | ✓ (1) |

### 1.2 自动化工作流（`WorkflowState`，6 条）

| # | 函数名 | 参数 | 返回 T | 一句话用途 | 分类 | 同步 | 前端 |
|---|---|---|---|---|---|---|---|
| 9 | `check_workflow_matches` | `S<WorkflowState>`, `S<PortState>`, `monitor_id:String`, `data:Vec<u8>` | `Vec<serde_json::Value>`（`[{id,name,sent}]`） | 检查一段数据是否命中规则，命中则**同步执行动作**（发数据 / 切 DTR-RTS / 写日志） | 外部副作用（写串口/写文件）+ **长耗时**（`delay_before` 串行 `sleep`） | **sync** | ✓ (1) |
| 10 | `save_workflows` | `S<WorkflowState>`, `S<PortState>`, `monitor_id:String`, `workflows_json:String` | `()` | 解析 JSON 规则，写入 `WorkflowState` 并同步到 `PortReader` | 改后端状态 | **sync** | ✓ (1) |
| 11 | `load_workflows` | `S<WorkflowState>`, `monitor_id:String` | `String`（JSON） | 读回规则 JSON | 纯读 | **sync** | **✗** |
| 12 | `init_workflows` | `S<WorkflowState>`, `S<PortState>`, `config_json:String` | `()` | 启动时从整份用户配置里抽出每个监视器的 `workflows` / `logDir` 并注入 | 改后端状态 | **sync** | ✓ (1) |
| 13 | `update_workflow_log_dir` | `S<WorkflowState>`, `S<PortState>`, `monitor_id:String`, `log_dir:String` | `()` | 更新某监视器的工作流日志目录 | 改后端状态 | **sync** | ✓ (1) |
| 14 | `update_workflow_line_ending` | `S<PortState>`, `monitor_id:String`, `line_ending:String` | `()` | 更新某监视器的行尾设置（供工作流发数据用） | 改后端状态 | **sync** | ✓ (2) |

### 1.3 日志与文件（6 条）

| # | 函数名 | 参数 | 返回 T | 一句话用途 | 分类 | 同步 | 前端 |
|---|---|---|---|---|---|---|---|
| 15 | `choose_log_directory` | 无 | `Option<String>` | 弹**原生目录选择框**；选中后把路径记进全局 `LAST_LOG_DIR`（供 `save_log` 校验） | 外部副作用（原生对话框）+ 长耗时 | **sync** | ✓ (1) |
| 16 | `save_log` | `content:String`, `path:String` | `()` | 把日志写到「最近一次选中的目录」下、文件名 `Serial Debug YYYY-MM-DD HHMMSS.txt`；`path` 必须 `canonicalize` 后等于白名单目录 | 外部副作用（写文件） | **sync** | ✓ (1) |
| 17 | `start_log_cache` | `S<LogCacheState>`, `monitor_id:String`, `port_name:String` | `()` | 标记一次会话开始（幂等；自动重连日志连续） | 改后端状态 | **sync** | ✓ (1) |
| 18 | `append_log_cache` | `S<LogCacheState>`, `monitor_id:String`, `content:String` | `()` | 往隐形缓存文件追加内容；首次写入时建目录、FIFO 清理（≤10 个）、建文件 | 外部副作用（写文件）+ 改状态 | **sync** | ✓ (1) |
| 19 | `end_log_cache` | `S<LogCacheState>`, `monitor_id:String` | `()` | 结束会话：关句柄，空文件删除 | 外部副作用（删文件）+ 改状态 | **sync** | ✓ (1) |
| 20 | `list_log_cache` | 无 | `Vec<serde_json::Value>`（`[{name,size,modified}]`，按时间倒序） | 列出缓存目录里的会话日志文件 | 纯读（磁盘） | **sync** | **✗** |

### 1.4 WSL 系统管理（7 条）

| # | 函数名 | 参数 | 返回 T | 一句话用途 | 分类 | 同步 | 前端 |
|---|---|---|---|---|---|---|---|
| 21 | `list_wsl_devices` | 无 | `Vec<serde_json::Value>`（`{busid,vidpid,port,name,hasCom,status,wslPath?,wslSerial?}`） | 跑 `usbipd list`（失败/超时则**UAC 提权**重跑），解析设备与映射状态，补 WSL 侧 `/dev/tty*` 路径与序列号 | 外部副作用（跑进程 + 提权 + 写临时文件）+ 长耗时（最长 ~3s+10s 轮询） | async（已 `spawn_blocking`） | ✓ (1) |
| 22 | `check_wsl_status` | 无 | `Vec<String>`（运行中的发行版名） | 跑 `wsl --list --verbose`（3s 超时）过滤出 Running | 外部副作用（跑进程） | async（已 `spawn_blocking`） | ✓ (2) |
| 23 | `launch_wsl` | `dist:Option<String>` | `()` | 优先 `wt.exe -p <dist>`（含 `printenv HOME` + 路径转换），否则 `conhost.exe` 回退；记录终端 PID | 外部副作用（起进程） | **sync** | ✓ (1，动态) |
| 24 | `shutdown_wsl` | `dist:String` | `()` | 清 `WSL_TERMINAL_PID` 后跑 `wsl -t <dist>`（5s 超时） | 外部副作用（跑进程） | async（已 `spawn_blocking`） | ✓（动态派发 `wslDistAction('shutdown_wsl',…)`，L6674） |
| 25 | `get_wsl_distributions` | 无 | `Vec<serde_json::Value>`（`{name,isDefault,running,uptime,memUsedMB,memTotalMB}`） | 列出发行版，并为运行中的逐个跑 `cat /proc/uptime` + `free -m`（5s + N×6s） | 外部副作用（跑进程）+ 长耗时 | async（已 `spawn_blocking`） | ✓ (1) |
| 26 | `attach_port_to_wsl` | `port_name:String`, `distro:Option<String>`, `authorized:bool` | `MapWslOutcome { needs_approval:bool, message:String, busid:String, name:String, port:String }`（`camelCase`） | 把 USB 串口映射进 WSL：已 bound 直接 attach；否则 `authorized=false` 先回 `needs_approval` 让前端弹授权框，`true` 时经 **UAC 提权 PowerShell** 执行 bind+attach | 外部副作用（提权/跑进程/写临时文件）+ 长耗时（最长 60s 轮询） | async（已 `spawn_blocking`） | ✓ (1) |
| 27 | `detach_port_from_wsl` | `busid:String` | `String`（提示文案） | 先普通权限 `usbipd detach`，失败则 UAC 提权重试（`busid` 有 `数字-数字` 白名单校验） | 外部副作用（提权/跑进程）+ 长耗时（最长 20s） | async（已 `spawn_blocking`） | ✓ (1) |

### 1.5 WSL 串口转发（`WslSerialState`，7 条）

> 全部经 `spawn_blocking`；底层是与 `wsl … python3 /tmp/seahi_serial_bridge.py` 子进程的 **stdin/stdout 管道 JSON 协议**（非 socket），单命令响应超时 **5s**，超时即 kill bridge。

| # | 函数名 | 参数 | 返回 T | 一句话用途 | 分类 | 同步 | 前端 |
|---|---|---|---|---|---|---|---|
| 28 | `open_wsl_serial` | `S<WslSerialState>`, `monitor_id:String`, `device_path:String`, `baud_rate:u32` | `()` | 校验 `/dev/tty*` 白名单 → 选/启动发行版 → 部署 bridge → 启 bridge → 等 stderr `ready`（5s）→ 发 `open` | 外部副作用（起进程/写 WSL 文件）+ 长耗时（可达 ~13s+5+5+5s） | async | ✓ (2) |
| 29 | `close_wsl_serial` | `S<WslSerialState>`, `monitor_id:String` | `()` | 发 `{"cmd":"close"}` 后 kill + wait | 外部副作用（kill 进程） | async | ✓ (4) |
| 30 | `read_wsl_serial` | `S<WslSerialState>`, `monitor_id:String` | `Vec<u8>` | 发 `{"cmd":"read","max":4096}`，base64 解码（`port not open` 归一成空数组） | 外部副作用（IPC 读写）+ 长耗时（≤5s） | async | ✓（动态 `invokeTimeout('read_wsl_serial',…)`，L6385） |
| 31 | `send_wsl_serial` | `S<WslSerialState>`, `monitor_id:String`, `data:Vec<u8>` | `usize` | 发 `{"cmd":"write", data:b64}` | 外部副作用（IPC 写）+ 长耗时（≤5s） | async | ✓（L3223 / L4911 / L6342） |
| 32 | `get_wsl_serial_devices` | 无 | `Vec<serde_json::Value>`（`[{path,name}]`） | 经**持久化 WSL shell**（`wsl -d <distro> -e bash --norc --noprofile`）跑一条 sysfs 遍历脚本，取 `/dev/tty*` | 外部副作用（跑进程）+ 长耗时（3s） | async（已 `spawn_blocking`） | ✓ (1) |
| 33 | `set_wsl_dtr` | `S<WslSerialState>`, `monitor_id:String`, `level:bool` | `()` | 转发 `{"cmd":"dtr"}` | 外部副作用（IPC） | async | ✓ (1) |
| 34 | `set_wsl_rts` | `S<WslSerialState>`, `monitor_id:String`, `level:bool` | `()` | 转发 `{"cmd":"rts"}` | 外部副作用（IPC） | async | ✓ (1) |

### 1.6 配置 / 更新 / 窗口 / 杂项（13 条）

| # | 函数名 | 参数 | 返回 T | 一句话用途 | 分类 | 同步 | 前端 |
|---|---|---|---|---|---|---|---|
| 35 | `save_config` | `config_json:String` | `()` | `fs::write(%APPDATA%\seahi-serial\config.json, config_json)` | 外部副作用（写文件） | **sync** | ✓ (5) |
| 36 | `load_config` | 无 | `String`（JSON；文件不存在返回 `""`） | 读 `config.json` | **纯读**（磁盘） | **sync** | ✓ (2) |
| 37 | `backup_config` | 无 | `String`（备份文件绝对路径） | 把 `config.json` 复制成 `config.json.bak` | 外部副作用（写文件） | **sync** | ✓ (1) |
| 38 | `check_update` | 无 | `UpdateInfo { has_update, latest_version, current_version, download_url, sha256?, size? }` | 请求 `https://api.github.com/repos/SeaHi-Mo/Seahi-Serial/releases/latest`（8s 超时），挑 `-setup.exe` / `.exe` / `.msi`，把 `(url,sha256,size)` 缓存进全局 `UPDATE_INFO_CACHE` | 外部副作用（HTTP 出网）+ 长耗时 | async（tokio，不阻塞主线程） | ✓ (1) |
| 39 | `download_update` | `download_url:String`, `_sha256:Option<String>`, `_size:Option<u64>`（**后两个被忽略**，只用后端缓存） | `String`（`%TEMP%\seahi-serial-update\<file>`） | 下载安装包，校验 SHA-256（缺失则用 size 兜底），失败即删 | 外部副作用（HTTP + 写文件）+ **长耗时（300s 超时，全程在 tokio 上 await）** | async | ✓ (1) |
| 40 | `install_update` | `app:tauri::AppHandle`, `file_path:String` | `()` | 校验路径必须在 `%TEMP%\seahi-serial-update\` 且扩展名 exe/msi → 起安装进程 → `emit("save-before-exit")` → `sleep(600ms)` → **`std::process::exit(0)`** | 外部副作用（起进程 + **杀本进程**） | **sync** | ✓ (1) |
| 41 | `get_window_size` | `window:tauri::Window` | `(u32, u32)` | 内尺寸（JSON 数组 `[w,h]`） | 纯读 | **sync** | ✓ (2) |
| 42 | `set_window_size` | `window:tauri::Window`, `width:u32`, `height:u32` | `()` | 设窗口尺寸（下限 1047×650） | 外部副作用（窗口） | **sync** | ✓ (2) |
| 43 | `open_url` | `url:String` | `()` | 校验必须 `http(s)://` 且无空白/命令元字符 → `rundll32 url.dll,FileProtocolHandler` | 外部副作用（起进程） | **sync** | ✓ (1) |
| 44 | `set_title_bar_color` | `window:tauri::Window`, `r:u8`, `g:u8`, `b:u8` | `()` | DWM `DWMWA_CAPTION_COLOR` 上色；失败后置 `DWM_CAPTION_COLOR_SUPPORTED=-1` 跳过后续 | 外部副作用（DWM 窗口） | **sync** | ✓ (1) |
| 45 | `get_app_info` | 无 | `AppInfo { version: String, commit: String }` | 版本号 + `GIT_COMMIT_HASH`（编译期，缺省 `"dev"`） | **纯读** | **sync** | ✓ (1) |
| 46 | `report_js_error` | `error:String`, `context:String` | `()`（无 Result） | 前端 JS 错误转发进统一上报管道（写本地日志 + 可选 Sentry / 自建服务） | 外部副作用（写 `%TEMP%\seahi-serial-debug.log`；网络上报走全局 channel 异步线程） | **sync** | ✓ (1) |
| 47 | `test_error_report` | 无 | `Result<String, String>` | 测试上报（**`#[cfg(debug_assertions)]`，Release 不存在**；handler 里同样 cfg-gated） | 外部副作用（网络） | **sync** | ✓ (1) |

### 1.7 ADB（9 条）

| # | 函数名 | 参数 | 返回 T | 一句话用途 | 分类 | 同步 | 前端 |
|---|---|---|---|---|---|---|---|
| 48 | `adb_tool_status` | 无 | `serde_json::Value`（`{found,version,path}`） | 找 adb.exe 并跑 `adb version`（5s 超时） | 外部副作用（跑进程）+ 长耗时 | async（`run_output_timeout` 内部轮询，**未 spawn_blocking**，直接在 async 里阻塞） | **✗** |
| 49 | `adb_devices` | 无 | `Vec<serde_json::Value>`（`{serial,state,model,product}`） | `adb devices -l`（5s 超时）解析 | 外部副作用（跑进程）+ 长耗时 | async | ✓ (1) |
| 50 | `adb_shell` | `serial:String`, `cmd:String` | `String` | `adb -s <serial> shell <cmd>`（10s 超时） | 外部副作用（跑进程）+ 长耗时 | async | **✗**（仅注释里提到） |
| 51 | `adb_exec` | `serial:Option<String>`, `cmd:String`, `args:Vec<String>` | `String` | `adb [-s serial] <cmd> <args...>`（15s 超时） | 外部副作用（跑进程）+ 长耗时 | async | **✗** |
| 52 | `adb_open_shell` | `S<AdbPtyState>`, `serial:String` | `String`（`session_id` = `adb-pty-<nanos>`） | 用 `portable-pty` 开 ConPTY 跑 `adb -s <serial> shell`（TERM=xterm-256color，40×120），起常驻读线程推 channel | 外部副作用（PTY/进程）+ 长耗时（固定 `sleep 1500ms`） | async（已 `spawn_blocking`） | ✓ (1) |
| 53 | `adb_shell_write` | `S<AdbPtyState>`, `session_id:String`, `data:String` | `()` | 往 PTY master 写命令/字符 | 外部副作用（PTY 写） | async（已 `spawn_blocking`） | ✓ (1) |
| 54 | `adb_shell_read` | `S<AdbPtyState>`, `session_id:String` | `Vec<u8>` | 非阻塞 drain PTY 输出 channel（上限 512 块，超出丢弃并计数） | **纯读**（消费队列） | async（已 `spawn_blocking`） | ✓ (1) |
| 55 | `adb_shell_close` | `S<AdbPtyState>`, `session_id:String` | `()` | 移除会话，kill + wait adb shell | 外部副作用（kill） | async（已 `spawn_blocking`） | ✓ (2) |
| 56 | `adb_shell_resize` | `S<AdbPtyState>`, `session_id:String`, `cols:u16`, `rows:u16` | `()` | `MasterPty::resize`，让后端 shell 布局与前端 xterm 一致 | 外部副作用（PTY ioctl） | async（已 `spawn_blocking`） | ✓ (1) |

### 1.8 BLE 主机（`BleState`，18 条）

| # | 函数名 | 参数 | 返回 T | 一句话用途 | 分类 | 同步 | 前端 |
|---|---|---|---|---|---|---|---|
| 57 | `ble_get_adapters` | 无 | `Vec<serde_json::Value>`（`[{index,info,address}]`） | 新建 `btleplug::Manager` 枚举全部蓝牙适配器 | 纯读（系统探测） | async | ✓ (1) |
| 58 | `ble_start_scan` | `S<BleState>` | `usize`（成功启动的适配器数） | 对**全部**适配器 `start_scan`，并刷新 `state.adapters` | 外部副作用（射频）+ 改状态 | async | ✓ (1) |
| 59 | `ble_stop_scan` | `S<BleState>` | `()` | 对缓存里的全部适配器 `stop_scan` | 外部副作用（射频）+ 改状态 | async | ✓ (1) |
| 60 | `ble_get_devices` | `S<BleState>` | `Vec<serde_json::Value>`（`ble_props_json`：address/address_type/device_type/local_name/advertisement_name/rssi/tx_power_level/appearance/manufacturer_data/service_data/services/adv_raw） | 合并所有适配器扫到的设备，按 MAC 去重 | 纯读（适配器缓存） | async | ✓ (1) |
| 61 | `ble_connect` | `S<BleState>`, `address:String` | `()` | 三路兜底找设备（适配器表 → `last_peripheral` → 3×1500ms 短扫描脉冲）→ 连接（10s 超时）→ discover_services | 外部副作用（射频连接）+ 长耗时（最长 ~14.5s + 10s） | async | ✓ (2) |
| 62 | `ble_connect_direct` | `S<BleState>`, `address:String` | `()` | **不要求设备在扫描列表里**：`adapter.add_peripheral(BDAddr)` 按 MAC 直连（AGENTS.md 明令不许删的入口） | 外部副作用 + 长耗时（10s） | async | ✓ (1) |
| 63 | `ble_disconnect` | `S<BleState>` | `()` | disconnect，并把外设对象保留进 `last_peripheral`（便于秒重连），清 services / 通知缓冲 / `notify_spawned` | 外部副作用 + 改状态 | async | ✓ (1) |
| 64 | `ble_get_connection` | `S<BleState>` | `Option<String>`（已连接 MAC） | 查真实链路状态；`is_connected=false` 时**顺手清理后端状态**并保留对象 | **纯读**（含状态自愈） | async | ✓ (2) |
| 65 | `ble_get_mtu` | `S<BleState>` | `u16`（未连接 0） | 协商后的 ATT MTU | 纯读 | async | ✓ (1) |
| 66 | `ble_refresh_rssi` | `S<BleState>` | `BleRssiInfo { rssi: Option<i16>, connected: bool }` | 先断链检查/自愈，再做 800ms 短扫描脉冲后读 RSSI（缓存优先） | 外部副作用（射频）+ 长耗时（≥800ms） | async | ✓ (1) |
| 67 | `ble_get_services` | `S<BleState>` | `Vec<serde_json::Value>`（服务树：uuid/primary/characteristics[{uuid,service_uuid,properties,descriptors}]） | 返回已发现的服务树 | 纯读 | async | ✓ (2) |
| 68 | `ble_read` | `S<BleState>`, `char_uuid:String` | `Vec<u8>` | GATT 读特征值 | 外部副作用（GATT） | async | ✓ (1) |
| 69 | `ble_write` | `S<BleState>`, `char_uuid:String`, `data:Vec<u8>`, `write_type:Option<String>` | `()` | GATT 写特征值（`without_response` 走 `WriteType::WithoutResponse`） | 外部副作用（GATT） | async | ✓ (1) |
| 70 | `ble_read_descriptor` | `S<BleState>`, `char_uuid:String`, `desc_uuid:String` | `Vec<u8>` | 读描述符（0x2901 / 0x2902 等） | 外部副作用（GATT） | async | ✓ (1) |
| 71 | `ble_write_descriptor` | `S<BleState>`, `char_uuid:String`, `desc_uuid:String`, `data:Vec<u8>` | `()` | 写描述符（典型：往 CCCD 写 0x0001/0x0002 手动开关通知） | 外部副作用（GATT） | async | ✓ (1) |
| 72 | `ble_subscribe` | `S<BleState>`, `char_uuid:String` | `()` | 订阅特征；首次订阅时起 `ble_notify_loop` 常驻任务（`notify_spawned` 去重，循环结束自动复位） | 外部副作用 + 改状态 | async | ✓（动态 `invoke(on ? 'ble_subscribe' : 'ble_unsubscribe', …)`，L7068） |
| 73 | `ble_unsubscribe` | `S<BleState>`, `char_uuid:String` | `()` | 取消订阅 | 外部副作用（GATT） | async | ✓（同上） |
| 74 | `ble_poll_notifications` | `S<BleState>` | `serde_json::Value`（`{items:[{uuid,service_uuid,value_hex}], dropped:u64}`） | drain 通知缓冲（上限 2000，超限丢最旧并计数） | **纯读**（消费队列） | async | ✓ (1) |

### 1.9 BLE 配对（`BlePairState`，2 条）

| # | 函数名 | 参数 | 返回 T | 一句话用途 | 分类 | 同步 | 前端 |
|---|---|---|---|---|---|---|---|
| 75 | `ble_pair` | `app:tauri::AppHandle`, `address:String` | `bool`（是否已配对） | WinRT 自定义配对：已配对直接 true；需要用户确认时 `emit("ble-pair-request")` 并**阻塞等前端答复（60s 超时）** | 外部副作用（蓝牙配对）+ **长耗时（最长 60s）** | async（已 `spawn_blocking`；内部全程同步阻塞，用 `futures::executor::block_on` 驱动 WinRT 异步） | ✓（`invokeTimeout('ble_pair',…)`，L8599） |
| 76 | `ble_pair_respond` | `S<BlePairState>`, `accept:bool`, `pin:Option<String>` | `()` | 把用户答复回传给等待中的配对线程 | 改后端状态 | **sync** | ✓ (1) |

### 1.10 BLE 从机 / GATT Server（`BlePeripheralState`，9 条）

| # | 函数名 | 参数 | 返回 T | 一句话用途 | 分类 | 同步 | 前端 |
|---|---|---|---|---|---|---|---|
| 77 | `ble_periph_start` | `S<BlePeripheralState>`, `service_uuid:String`, `characteristics:Vec<BlePeriphCharSpec>`, `discoverable:Option<bool>`, `connectable:Option<bool>`, `adv_data:Option<Vec<u8>>`, `manual_reply:Option<bool>` | `serde_json::Value`（状态快照，同 `ble_periph_status`） | 收掉上一次 → 探适配器能力 → `GattServiceProvider::CreateAsync` → 建 N 个特征（+自定义描述符）→ 挂读/写/订阅回调 → `StartAdvertisingWithParameters` → 落定广播状态 | 外部副作用（射频广播/GATT）+ **长耗时（多次 200~300ms 等待，最多 2 次 provider 重试）** | async | ✓ (1) |
| 78 | `ble_periph_stop` | `S<BlePeripheralState>` | `serde_json::Value`（`{stopped:bool}`） | 停广播、把所有待应答写请求按协议错误 0x80 收干净、清特征 | 外部副作用（射频）+ 改状态 | async | ✓ (1) |
| 79 | `ble_periph_status` | `S<BlePeripheralState>` | `serde_json::Value`（`running`/`advertising`/`advertising_status`/`warning`/`adapter`/`manual_write_reply`/`pending_writes`/`service_uuid`/`characteristics[]`） | 状态快照 + 分级告警文案 | 纯读 | async | ✓ (1) |
| 80 | `ble_periph_set_value` | `S<BlePeripheralState>`, `char_uuid:String`, `data:Vec<u8>` | `()` | 改某可读特征的值（主机下次读到的就是它）；不可读特征报错 | 改后端状态 | async | ✓ (1) |
| 81 | `ble_periph_notify` | `S<BlePeripheralState>`, `char_uuid:String`, `data:Vec<u8>` | `serde_json::Value`（`{count, sent:[{peer,status,bytes}]}`） | 向已订阅主机下发通知/指示；无订阅者或超 MTU 提前报错 | 外部副作用（射频下发） | async | ✓ (1) |
| 82 | `ble_periph_poll_events` | `S<BlePeripheralState>` | `Vec<serde_json::Value>`（`[{kind,ts,…}]`） | drain 主机动作事件队列（上限 400） | **纯读**（消费队列） | async | ✓ (1) |
| 83 | `ble_periph_respond_write` | `S<BlePeripheralState>`, `pending_id:u64`, `accept:bool`, `protocol_error:Option<u8>` | `()` | 对一条待应答写请求做决定（接受 / 按协议错误码拒绝，默认 0x80） | 外部副作用（GATT 应答） | async | ✓ (1) |
| 84 | `ble_periph_pick_config_file` | 无 | `Option<serde_json::Value>`（`{path,text}`） | 弹**原生文件框**（csv/md/markdown/txt）并读回文本 | 外部副作用（原生对话框 + 读文件）+ 长耗时 | **sync** | ✓ (1) |
| 85 | `ble_periph_save_config_file` | `text:String` | `Option<String>`（保存路径） | 弹**原生保存框**写 CSV/MD | 外部副作用（原生对话框 + 写文件）+ 长耗时 | **sync** | ✓ (1) |

### 1.11 长耗时与 `spawn_blocking` 现状（挂 MCP 时最需要注意）

**已经移出主线程的（安全）**：`list_ports`、`send_data`、`list_wsl_devices`、`check_wsl_status`、`shutdown_wsl`、`get_wsl_distributions`、`attach_port_to_wsl`、`detach_port_from_wsl`、`open_wsl_serial`、`close_wsl_serial`、`read_wsl_serial`、`send_wsl_serial`、`get_wsl_serial_devices`、`set_wsl_dtr`、`set_wsl_rts`、`adb_open_shell`、`adb_shell_write`、`adb_shell_read`、`adb_shell_close`、`adb_shell_resize`、`ble_pair`。

**是 `sync fn` 且会明显阻塞命令线程（≥200ms 风险，改成 async 时要注意）**：

| 命令 | 阻塞来源 | 量级 |
|---|---|---|
| `open_port` | `serialport::open` + 参数设置 + DTR/RTS | 数十 ms ~ 1s+（USB 转串口常见） |
| `close_port` | `flush`/`clear` + 读线程 join 等待 | ≤200ms（超时后 `mem::forget`） |
| `check_workflow_matches` | 动作串行执行，含 `delay_before` 的 `std::thread::sleep` | **用户可配，无上限** |
| `choose_log_directory` / `ble_periph_pick_config_file` / `ble_periph_save_config_file` | 原生模态对话框 | 用户思考时间（无限） |
| `save_log` / `save_config` / `backup_config` / `append_log_cache` / `end_log_cache` | 同步磁盘 IO | 通常 <10ms，网络盘/大文件时更久 |
| `launch_wsl` | `where wt.exe` + `printenv HOME`（5s 超时）+ `spawn` | ≤5s |
| `install_update` | `sleep(600ms)` + `process::exit(0)` | 600ms + 退出 |
| `open_url` / `set_title_bar_color` / `set_dtr` / `set_rts` | 起进程 / DWM 调用 / 串口 ioctl | 通常小（DTR/RTS 会等 500ms 锁超时） |

**是 `async fn` 但内部仍在 async 上下文里同步阻塞**（`run_output_timeout` 用轮询 `try_wait` + `sleep`，不是真异步）：`adb_tool_status`（5s）、`adb_devices`（5s）、`adb_shell`（10s）、`adb_exec`（15s）。这三/四条**没有** `spawn_blocking`，会占着一个 async worker。

---

## 2. 配置持久化

### 2.1 读写函数

| 命令 | 行为 | 备注 |
|---|---|---|
| `save_config(config_json: String)` | `fs::write(config_file, config_json)` | 只接字符串，**后端不解析 JSON** |
| `load_config() -> String` | `fs::read_to_string`，失败/不存在返回 `""` | 前端负责 `JSON.parse` 与版本迁移 |
| `backup_config() -> String` | `config.json` → `config.json.bak`（存在才拷） | 迁移前兜底 |

### 2.2 配置文件绝对路径怎么拼

```rust
fn dirs_config_path() -> Option<PathBuf> {
    #[cfg(windows)]
    { std::env::var("APPDATA").ok().map(|p| PathBuf::from(p).join("seahi-serial")) }
    #[cfg(not(windows))]
    { std::env::var("HOME").ok().map(|p| PathBuf::from(p).join(".config").join("seahi-serial")) }
}
```

- **没有用 `dirs` crate、没有用 Tauri 的 `app_config_dir()`**，而是直接读环境变量 `APPDATA`（非 Windows 读 `HOME`）。
- 实际绝对路径（Windows）：**`%APPDATA%\seahi-serial\config.json`**
  - 典型展开：`C:\Users\<用户名>\AppData\Roaming\seahi-serial\config.json`
  - 备份：**`%APPDATA%\seahi-serial\config.json.bak`**
- 路径由 `dirs_config_path()` 决定；脚本/前端**只能**通过 `load_config` 拿到内容，**没有命令返回 config 绝对路径**。MCP 侧若要读配置，需自己拼 `%APPDATA%\seahi-serial\config.json`。
- 若 `APPDATA` 缺失：`save_config` 返回 `Err("无法获取应用配置目录")`，`load_config`/`backup_config` 返回 `Ok("")`。

### 2.3 同目录下的其它持久化路径

| 用途 | 路径 | 代码 |
|---|---|---|
| 会话隐形日志缓存目录 | **`%APPDATA%\seahi-serial\log-cache\`** | `log_cache_dir()` L3087 |
| 缓存文件名 | `session-<YYYYMMDD-HHMMSSmmm>-<净化端口名>.log` | L3191 |
| 缓存上限 | `LOG_CACHE_MAX_COUNT = 10`，字典序（=时间序）FIFO 删最旧 | L3069/L3136 |
| 调试日志（**Release 也写**） | **`%TEMP%\seahi-serial-debug.log`**（追加，每次调用都写一行 `[<ms>] …`） | `dbg_log()` L16-L26 |
| 更新包 | `%TEMP%\seahi-serial-update\<filename>` | L3724 |
| bridge 脚本临时 base64 | `%TEMP%\seahi_bridge_b64.txt`（用完即删） | L2173 |
| usbipd 提权结果文件 | `%TEMP%\usbipd_list_<pid>_<n>_<rand>.txt` / `usbipd_result_…` / `usbipd_detach_…`（用完即删） | L1540 / L2708 / L2899 |
| WSL 侧 bridge 脚本 | **`/tmp/seahi_serial_bridge.py`**（每次连接强制覆盖部署） | L975 |
| 工作流日志 | `<logDir>\workflow_log.txt`（追加） | L841 / L913 |

### 2.4 JSON 的完整字段结构

**serde 结构体只用于「工作流规则子树」**（`WorkflowRule` / `WorkflowCondition` / `WorkflowAction`），**配置根对象是前端手写 JSON 拼装**（`collectConfig()` → `JSON.stringify` → `save_config`），后端完全不知道结构。

#### 根对象（`collectConfig()`，index.html L5334-L5409）

| 字段 | 类型 | 来源 / 含义 |
|---|---|---|
| `version` | number | **固定写 2**；读取时接受 1 / 2，其它值视为旧版并迁移 |
| `extraCount` | number | 普通额外监视器数量（键名 `extra-1`…`extra-N`） |
| `wslExtraCount` | number | WSL 额外监视器数量（键名 `wsl-x1`…`wsl-xN`） |
| `monitors` | object\<string, MonitorCfg\> | 键：`main` / `extra-N` / `wsl` / `wsl-xN` |
| `logDir` | string | 日志保存目录（配合 `choose_log_directory` 白名单） |
| `wslAutoMap` | object\<string, any\> | WSL 自动映射表；**只保留含 `:` 的键**（VID:PID，如 `"1A86:7523"`），旧 busid 键会被迁移丢弃 |
| `theme` | string | 主题名（默认 `light`） |
| `themeStyle` | string | 主题风格（12 套主题变量之一） |
| `windowWidth` | number? | 仅当 `_cachedWindowSize` 存在时写入 |
| `windowHeight` | number? | 同上 |
| `ble` | object (BleCfg) | 蓝牙页状态（见下） |

#### `monitors[mid]`（`collectConfigForMonitor`，L5412-L5449；与 `collectConfig` 内联版本字段一致）

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `port` | string | `''` | 端口名 / WSL 设备路径 |
| `baud` | string | `'115200'` | 波特率（**字符串**） |
| `lineEnding` | string | `'crlf'` | `crlf` / `lf` / `cr` |
| `viewMode` | string | `'text'` | `text` / `hex` |
| `sendAs` | string | `'text'` | `text` / `hex` |
| `dataBits` | string | `'8'` | |
| `stopBits` | string | `'1'` | |
| `parity` | string | `'none'` | |
| `dtr` | bool | `false` | |
| `rts` | bool | `true` | |
| `advOpen` | bool | 高级行是否展开 |
| `btnScroll` | bool | 工具条按钮状态 |
| `btnAutoReconnect` | bool | 同上 |
| `btnSendLE` | bool | 同上 |
| `btnTs` | bool | 同上 |
| `btnEcho` | bool | 同上 |
| `btnLineNum` | bool | 同上 |
| `quickCmds` | array | `[{label,value}…]` 快捷指令 |
| `sendHistory` | array\<string\> | 最多 20 条发送历史 |
| `panelHeight` | number | `0`（仅 `collectConfig` 内联版本写，单监视器版本不写） |
| `workflows` | array\<WorkflowRule\> | 工作流规则（后端 `init_workflows` 消费） |
| `logDir` | string | 每个监视器的日志目录（由 `init_workflows` 从 `monitors[*].logDir` 读，**`collectConfigForMonitor` 不写这个字段**，只有 `collectConfig` 内部的 `_wslSavedConfig` 路径可能带） |

#### `ble` 子树（`collectBleState`，L3924-L3943）

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `monitor` | bool | `false` | 蓝牙页是否内嵌串口监视器 |
| `monitorWidth` | number | `380` | 内嵌监视器宽度 |
| `monitorCfg` | MonitorCfg \| null | `null` | 内嵌监视器配置（与 `monitors[mid]` 同构） |
| `openSvcs` | array\<string\> | `[]` | 展开的服务 UUID 列表 |
| `advOpen` | bool | `false` | 广播详情是否展开 |
| `filterText` | string | `''` | 设备过滤关键字 |
| `filterOpen` | bool | `false` | 过滤框是否展开 |
| `selected` | string | `''` | 选中的设备地址 |
| `mode` | string | `'host'` | `host` / `periph`（仅 `'periph'` 且 `BLE_PERIPH_MODE_ENABLED` 时生效） |
| `periph` | BlePeriphForm \| null | `null` | 从机表单（见下） |
| `scanSecs` | number | `15` | 扫描自动停止秒数，`0` = 持续 |
| `periphSaved` | array\<{name:string, form:BlePeriphForm}\> | `[]` | 用户保存的多套从机配置 |

#### `ble.periph`（`blePfCollectForm`，L9026-L9040）

| 字段 | 类型 | 含义 |
|---|---|---|
| `presetId` | string | 预设 UUID 方案 id |
| `service` | string | 服务 UUID（支持 `0xFFE0` 短写） |
| `chars` | array\<{uuid:string, props:string[], value:string, desc:string}\> | 特征列表；`props` ∈ `read`/`write`/`write_without_response`/`notify`/`indicate`/`broadcast`；`value`/`desc` 是 **HEX 文本** |
| `discoverable` | bool | 可被发现 |
| `connectable` | bool | 可连接 |
| `advData` | bool | 是否填了广播服务数据 |
| `advDataHex` | string | 广播服务数据 HEX 文本 |
| `manualReply` | bool | 写入需手动应答 |

#### 工作流子结构（**唯一有 serde 结构体的部分**，main.rs L610-L644）

```rust
struct WorkflowCondition { #[serde(rename="type")] cond_type: String, value: String }
struct WorkflowAction {
    #[serde(rename="type")] action_type: String,
    #[serde(default)] data: String,
    #[serde(default="default_encoding")] encoding: String,   // 默认 "text"
    #[serde(default)] signal: String,                        // "dtr" / "rts"
    #[serde(default)] level: bool,
    #[serde(default)] delay_before: u64,                     // ms
}
struct WorkflowRule {
    id: String, name: String, enabled: bool,
    #[serde(default)] running: bool,
    conditions: Vec<WorkflowCondition>,
    actions: Vec<WorkflowAction>,
}
```
`cond_type` ∈ `string_contains` / `regex` / `exact_bytes`；`action_type` ∈ `send_data` / `toggle_dtr_rts` / `save_log`。

### 2.5 何时被读、何时被写

**读（`load_config`）—— 2 处**：

| 位置 | 时机 |
|---|---|
| index.html L5759 `loadAndApplyConfig()` | **应用启动时**（主流程）；做版本迁移，并用 `backup_config` + `save_config` 回写 |
| index.html L6057 | **首次打开 WSL 面板时**（懒加载），单独再读一次恢复 `monitors['wsl']` / `wsl-xN` |

**写（`save_config`）—— 6 类触发点**：

| 触发 | 位置 | 说明 |
|---|---|---|
| `scheduleConfigSave()` 去抖 | L5610-L5620 | **500ms 去抖**；被 **50+ 处** UI 交互调用（端口/波特率/行尾/视图/数据位/停止位/校验/DTR/RTS/各工具条开关/快捷指令/发送历史/面板高度/主题/蓝牙页各状态/工作流增删/窗口 resize…） |
| 版本迁移回写 | L5773（未知版→v2）、L5780（v1→v2） | 迁移后立即写 |
| `save-before-exit` 事件 | L10357 | 后端 `install_update` / `on_window_event(CloseRequested)` 触发 |
| `beforeunload` | L10388 | 浏览器侧兜底 |
| 窗口 resize | L10374（再走 `scheduleConfigSave` 500ms 去抖） | |
| `_loadingConfig` 保护 | L5611 | 配置恢复期间 `scheduleConfigSave` 直接 return，避免用默认值覆盖 |

### 2.6 是否加锁 / 去抖 / 原子替换

| 项 | 结论 |
|---|---|
| 后端加锁 | **无任何锁**。`save_config`/`load_config` 直接 `fs::write`/`fs::read_to_string`，无 `Mutex`、无文件锁 |
| 写入去抖 | **仅前端**：`scheduleConfigSave` 500ms `setTimeout` 去抖；后端无去抖 |
| 原子替换（临时文件 + rename） | **没有**。直接 `fs::write` 覆盖目标文件 → **崩溃/断电时可能留下截断的 config.json** |
| 备份 | 有，但只在「版本不认识」时由前端调 `backup_config` 生成 `config.json.bak`（**不是**每次写入前备份） |
| 并发写风险 | 前端可能短时间内连续触发（去抖 500ms + 退出事件 + beforeunload），后端无锁 → 后写覆盖先写（一般无害，但 `install_update` 的 `process::exit(0)` 只留 600ms 窗口） |
| 编码 | 直接写前端传来的 UTF-8 字符串，无 BOM |

---

## 3. 事件通道（后端 → 前端）

**共 4 个事件，全部由后端 `emit`，前端全部有 `listen`。** BLE 相关的**高频数据不走事件**，而是前端轮询命令（见下表后的说明）。

| 事件名 | 后端发出位置 | payload 结构 | 触发时机 | 前端监听位置 / 处理函数 |
|---|---|---|---|---|
| **`device-changed`** | `start_device_watcher` → `device_callback`，main.rs **L170**：`app.emit("device-changed", ())` | **`()`（序列化为 `null`）** | **`CM_Register_Notification`** 的 `CM_NOTIFY_ACTION_DEVICEINTERFACEARRIVAL` / `...REMOVAL`，过滤 `GUID_DEVCLASS_PORTS`（`{86E0D1E0-8089-11D0-9CE4-08003E301F73}`）。注意：**只覆盖 COM 端口类接口**；BLE 插拔不会走这里 | index.html **L10320** `window.__TAURI__.event.listen('device-changed', …)` → **再套 150ms 去抖**后：对每个未连接的 `.monitor-pane` 调 `refreshPorts(mid,true)`（Windows）或 `refreshWslMonPorts(mid)`（WSL）；`autoMapCheck()`；ADB 面板可见时 `refreshAdbDevices()`；WSL 设备列表可见时 `loadWslDevices()` |
| **`wsl-status-changed`** | `start_wsl_watcher` 后台线程，main.rs **L1878**：`app.emit("wsl-status-changed", running)` | **`bool`**（`wsl_running && terminal_alive`） | 2 秒轮询 `wsl --list --verbose`；只在状态**翻转**时发（`running != last_running`）。同时会在终端进程已死但 WSL 仍在跑时清空 `CACHED_DISTRO` | index.html **L6136** → `updateWslStatusUI(event.payload)`；并保存 `unlisten` 句柄到 `_wslStatusUnlisten`（WSL 面板重建时先反注册） |
| **`save-before-exit`** | ① `install_update`，main.rs **L3808**；② `on_window_event(CloseRequested)`，main.rs **L6987**（用 `window.emit`） | **`()`（`null`）** | ① 安装更新包后（`process::exit(0)` 前 600ms）；② 用户点关闭窗口时（清理资源前 200ms） | index.html **L10353** → 清 `_saveConfigTimer` → 对每个监视器 `logCacheEnd(mid)`（flush 并结束会话日志缓存）→ `collectConfig()` → `invoke('save_config')` |
| **`ble-pair-request`** | `ble_ask_pair_confirm`，main.rs **L6380**：`app.emit("ble-pair-request", json!({…}))` | `{ "address": String, "kind": String, "pin": String }`<br>`kind` ∈ `confirm`（设备上确认）/ `display`（把配对码显示给用户）/ `match`（两端比对同一码）/ `provide`（需用户输入设备显示的码）；`pin` 可能为空串 | `ble_pair` 发起 WinRT 自定义配对、`PairingRequested` 回调里；发完**阻塞等前端答复，60s 超时按取消**（`rx.recv_timeout`） | index.html **L10314** → `showBlePairDialog(ev && ev.payload)`；用户操作后调 `ble_pair_respond(accept, pin)` |

### 3.1 不走事件的「拉取式」通道（MCP 侧要知道）

以下都是**前端定时轮询命令**，不是 `emit`。MCP 若想复用这些数据，直接调命令即可：

| 数据 | 命令 | 前端轮询频率 |
|---|---|---|
| 串口接收字节 + 丢弃计数 | `read_data` | 实时（可见时高频，最小化/切走降频） |
| 工作流 `[Auto]` 事件 | `read_workflow_events` | 随 `read_data` 同轮 |
| WSL 串口接收字节 | `read_wsl_serial` | 3s 超时的 `invokeTimeout` |
| ADB PTY 输出 | `adb_shell_read` | 高频 |
| BLE 通知（主机侧） | `ble_poll_notifications` | ~250ms |
| BLE 从机事件（写入/读取/订阅/广播状态） | `ble_periph_poll_events` | ~500ms |
| BLE 从机状态快照 | `ble_periph_status` | 按需 |
| BLE 连接真实性 | `ble_get_connection` / `ble_refresh_rssi` | 按需 / 轮询 |

### 3.2 `CM_Register_Notification` 细节（按要求特别说明）

- 位置：`start_device_watcher()`，main.rs L150-L220；`#[cfg(windows)]`；在 `setup()` 里以 `app.handle().clone()` 启动。
- 通知过滤：`CM_NOTIFY_FILTER_TYPE_DEVICEINTERFACE` + `GUID_DEVCLASS_PORTS`（串口类）。
- 回调是 `unsafe extern "system" fn`，通过 `Box::into_raw(AppHandle)` 传 `context`；**回调里只做 `emit`**，不做重活。
- 停止：后台线程 1s 轮询 `DEVICE_WATCHER_STOP`（`AtomicBool`，模块级 `static`，初值 `false`）；退出时先 `CM_Unregister_Notification` 再 `Box::from_raw` 回收（注释里明确写了之前顺序反了导致 use-after-free）。
- **BLE 设备插拔没有任何原生通知**：BLE 侧完全靠 `ble_start_scan` / `ble_scan_pulse` 主动扫描 + 前端轮询 `ble_get_devices`。

---

## 4. Tauri 托管状态（`.manage(...)`）

`.manage()` 共 **8 次**，全部在 `main()` 的 `tauri::Builder::default()` 链上、`invoke_handler` 之前（main.rs L6843-L6883）。

| # | 状态类型 | 字段 | 同步原语 | 含义 |
|---|---|---|---|---|
| 1 | **`PortState`** | `readers: RwLock<HashMap<String, PortReader>>` | `std::sync::RwLock` + 每个 `PortReader` 内部一堆 `Arc<Mutex<…>>` / `Arc<Atomic*>` | 多串口连接表（key = `monitor_id`）。`PortReader` 持有：接收缓冲 `Arc<Mutex<Vec<u8>>>`、事件队列 `Arc<Mutex<Vec<String>>>`、丢弃计数 `Arc<AtomicU64>`、3 个 `JoinHandle`、`stop`/`disconnected`/`disconnect_reported`（各 `Arc<AtomicBool>`）、`port: Arc<Mutex<Box<dyn SerialPort>>>`、`rules: Arc<Mutex<Vec<WorkflowRule>>>`、`log_dir`/`line_ending: Arc<Mutex<String>>` |
| 2 | **`WslSerialState`** | `sessions: Arc<Mutex<HashMap<String, Arc<WslSerialSession>>>>` | `Arc<Mutex<…>>`；`WslSerialSession` 用 `Arc<Mutex<Child>>` + `Mutex<BufWriter<ChildStdin>>` + `crossbeam_channel::Receiver<String>` + `AtomicBool dead` | WSL 串口会话表（key = `monitor_id`）。`Arc` 是为了能在 `spawn_blocking` 里克隆移出、且不跨 bridge 等待持锁 |
| 3 | **`AdbPtyState`** | `sessions: Arc<Mutex<HashMap<String, Arc<AdbPtySession>>>>` | 同上；`AdbPtySession` = `Arc<Mutex<Box<dyn Child>>>` + `Mutex<Box<dyn Write>>` + `crossbeam_channel::Receiver<Vec<u8>>` + `AtomicBool dead` + `Mutex<Option<Box<dyn MasterPty>>>` + `Mutex<Option<Box<dyn SlavePty>>>`（保活用） | ADB PTY 会话表（key = `session_id`，形如 `adb-pty-<nanos>`） |
| 4 | **`WorkflowState`** | `rules: Mutex<HashMap<String, Vec<WorkflowRule>>>`、`log_dirs: Mutex<HashMap<String, String>>`、`regex_cache: Arc<RegexCache>` | 2 个 `std::sync::Mutex` + `Arc<RegexCache>`（内部 `Mutex<HashMap<String, Arc<Regex>>>`，超 100 条清空） | 每个监视器的工作流规则与日志目录；正则编译缓存 |
| 5 | **`LogCacheState`** | `sessions: Mutex<HashMap<String, LogCacheSession>>` | `std::sync::Mutex` | 隐形日志缓存会话（key = `monitor_id`）。`LogCacheSession { port_name: String, file: Option<File>, path: PathBuf }` |
| 6 | **`BleState`** | `adapters: Mutex<Vec<BtAdapter>>`、`scanning: AtomicBool`、`connected: Mutex<Option<BtPeripheral>>`、`last_peripheral: Mutex<Option<BtPeripheral>>`、`connected_addr: Mutex<Option<String>>`、`services: Mutex<Vec<BtService>>`、`notify_buf: Arc<Mutex<VecDeque<serde_json::Value>>>`、`notify_dropped: Arc<AtomicU64>`、`notify_spawned: Arc<AtomicBool>` | 6 个 `Mutex` + 3 个 `Arc<…>`（缓冲/计数/标志） | BLE 主机状态。`adapters` 是**列表**（AGENTS.md 约定 2：只留第一个会让第二适配器上的设备永远搜不到）；`last_peripheral` 用于断开后秒重连 |
| 7 | **`BlePairState`** | `responder: Mutex<Option<crossbeam_channel::Sender<(bool, String)>>>` | `std::sync::Mutex` | 前端对配对请求的答复通道（**同一时刻只允许一个配对在途**） |
| 8 | **`BlePeripheralState`** | `provider: Mutex<Option<GattServiceProvider>>`、`service_uuid: Mutex<Option<String>>`、`chars: Mutex<Vec<BlePeriphChar>>`、`adapter: Mutex<BlePeriphAdapterInfo>`、`pending_writes: Arc<Mutex<HashMap<u64, BlePeriphPendingWrite>>>`、`write_seq: Arc<AtomicU64>`、`manual_write_reply: Arc<AtomicBool>`、`events: Arc<Mutex<VecDeque<serde_json::Value>>>`、`running: AtomicBool` | 4 个 `Mutex` + 4 个 `Arc<…>` + `AtomicBool` | BLE 从机（GATT Server）。`BlePeriphChar` 里还有 `value: Arc<Mutex<Vec<u8>>>`、`subscribed: Arc<AtomicUsize>`、`max_notify: Arc<AtomicU16>`、`characteristic: GattLocalCharacteristic` |

### 4.2 模块级全局 `static`（**未** `.manage`，但同样是全局可变状态）

MCP 服务器若要在同一进程里访问后端能力，**也要面对这批静态量**：

| static | 类型 | 用途 |
|---|---|---|
| `ERROR_SENDER` | `OnceLock<mpsc::Sender<(String,String)>>` | 错误上报单线程消费者（`init_error_reporter` 在 `main()` 最开头起线程） |
| `UPDATE_INFO_CACHE` | `OnceLock<Mutex<Option<(String, Option<String>, Option<u64>)>>>` | 最近一次 `check_update` 的 `(url, sha256, size)`，供 `download_update` 校验 |
| `LAST_LOG_DIR` | `OnceLock<Mutex<Option<String>>>` | 最近一次 `choose_log_directory` 选的目录，`save_log` 的白名单 |
| `DEVICE_WATCHER_STOP` | `AtomicBool` | 设备插拔监听线程停止标志（`CloseRequested` 置 true） |
| `WSL_WATCHER_STOP` | `AtomicBool` | WSL 状态轮询线程停止标志 |
| `WSL_SHELL` | `Mutex<Option<Arc<WslShell>>>` | **持久化 WSL shell**（`wsl -d <d> -e bash --norc --noprofile`），避免每次 fork（~300ms） |
| `WSL_SHELL_DIRTY` | `AtomicBool` | shell 需重建标记（超时/进程退出后置位） |
| `WSL_SHELL_CMD_LOCK` | `Mutex<()>` | **串行化对持久化 shell 的命令执行**（同一根管道，并发会串音） |
| `WSL_TERMINAL_PID` | `Mutex<Option<u32>>` | `launch_wsl` 起 conhost 时记的 PID（用 wt.exe 时为 `None`） |
| `CACHED_DISTRO` | `Mutex<Option<String>>` | 缓存的 WSL 发行版名 |
| `DWM_CAPTION_COLOR_SUPPORTED` | `AtomicI8` | 标题栏上色能力缓存（`0`=未知 / `1`=支持 / `-1`=不支持） |

另有函数内 `static`：`launch_wsl` 里的 `USE_WT: OnceLock<bool>`（wt.exe 是否存在）、`run_usbipd_list_elevated` / `attach_port_to_wsl_blocking` / `run_usbipd_detach_elevated` 里的 `AtomicU64` 计数器。

---

## 5. HTTP 服务器 / 监听端口 / 本地 socket 排查（MCP SSE 冲突评估）

### 5.1 结论（TL;DR）

> **Tauri 应用自身（`main.rs`）没有任何 `TcpListener`、没有 HTTP server、没有显式 named pipe、没有 `bind()`、没有固定监听端口。**
> 加一个 MCP SSE 服务器**在应用进程内不存在端口冲突**。
> 需要避开的只在仓库里：**`19876`（WSL 侧 Python daemon，已是死代码）** 与 **`3000`（Node 错误上报服务，独立进程）**。

### 5.2 main.rs 内逐项核对

| 检查项 | 结果 |
|---|---|
| `TcpListener` / `TcpStream` / `SocketAddr` / `bind(` | **0 处** |
| `HttpServer` / `axum` / `warp` / `hyper` / `tiny_http` | **0 处**（`Cargo.toml` 里也没有这些依赖） |
| HTTP **服务端** | **0 个** |
| named pipe（显式 `\\.\pipe\` / `CreateNamedPipe` / `NetNamedPipe`） | **0 处显式代码**。**但要注意隐式**：`portable-pty`（`adb_open_shell`）底层用 Windows **ConPTY**，ConPTY 内部走**匿名 named pipe**（名字由系统生成，不可预测、不占固定名，不会与 MCP 冲突）；所有子进程（wsl / usbipd / adb / powershell / bridge.py）都用 **stdio 管道**，非 socket |
| 出网 HTTP **客户端**（会发起连接，不监听） | ① `https://api.github.com/repos/SeaHi-Mo/Seahi-Serial/releases/latest`（`check_update`，8s 超时）；② `browser_download_url`（`download_update`，300s 超时）；③ 环境变量 **`ERROR_SERVER_URL`** + 可选 `ERROR_API_KEY` → `POST {ERROR_SERVER_URL}/report`（5s 超时，**未设置则完全不上报**）；④ 可选 Sentry（`SENTRY_DSN`，需 `sentry` feature） |
| 本地 unix domain socket | 无（Windows 目标） |
| 固定端口常量 | 无 |
| `%TEMP%` / `%APPDATA%` 文件 | 有（见 2.3），与端口无关 |

### 5.3 仓库其它位置的端口占用

| 位置 | 端口 / socket | 是否会被本应用进程占用 | 说明 |
|---|---|---|---|
| `src-tauri/wsl-daemon/seahi_serial_daemon.py` L21-L22、L261 | **`HOST = "0.0.0.0"`，`PORT = 19876`，`server.listen(5)`**（TCP） | **否** | **死代码**：`main.rs` 只 `include_str!("../wsl-daemon/bridge_b64.txt")`（L974），**从未引用 `daemon_b64.txt` 或 `seahi_serial_daemon.py`**。全仓库唯一引用者是 `wsl-daemon/test_daemon.py`（`s.connect(('127.0.0.1', 19876))`）。**如果哪天有人手工在 WSL 里跑它，会在 WSL 网络命名空间内占 19876** |
| `src-tauri/wsl-daemon/seahi_serial_bridge.py` | **无端口**，纯 stdin/stdout JSON 行协议 | — | 这是**实际在用**的脚本（base64 内嵌进 exe，部署到 WSL `/tmp/seahi_serial_bridge.py`） |
| `server/error-server.js` L121 / L682 | **`PORT = process.env.PORT \|\| 3000`**，`http.createServer(...).listen(PORT)` | 否（独立 Node 进程） | 仅开发/运维时手工启动 |
| `server/sentry-webhook.js` L14 / L222 | 同上，默认 **3000** | 否 | 与上者**默认端口相同**，同时启动会冲突（README 里靠 `PORT` 环境变量区分） |
| `cloudflare-worker/worker.js` | 无本地端口（Cloudflare 托管） | 否 | |
| Tauri WebView | **无 `devUrl`**（`tauri.conf.json` 只有 `frontendDist: "../src"`），前端由 Tauri 自定义协议（`http://tauri.localhost`）提供，**不监听本地端口** | 否 | 因此**没有 Vite/`tauri dev` 的 1420 端口** |
| `capabilities/default.json` | 仅 `core:*`（window/webview），**没有 `http` / `fs` / `shell` 插件权限** | — | 意味着 MCP SSE 若要从前端访问，必须新增权限；MCP 客户端在外部进程则不受影响 |
| `tauri.conf.json` → `app.security.csp` | **`null`**（无 CSP） | — | 前端可直接连任意 `http://127.0.0.1:<port>`（如 MCP SSE），无需改 CSP |

### 5.4 给 MCP SSE 服务器的端口建议

- **可以直接用**：1024–65535 中任意空闲端口，应用进程内无竞争。避开 **3000**（Node 服务）与 **19876**（WSL 死代码 daemon，防同事手工跑）。
- 建议**动态端口**：绑 `127.0.0.1:0` 由系统分配并回写文件，避免与用户本地其它工具冲突（该应用是"给硬件工程师用的调试器"，用户机器上常驻大量本地服务）。
- 绑 `127.0.0.1` 而非 `0.0.0.0`：应用当前只处理本机串口/BLE，没有远程需求；`capabilities` 也把安全面收在 `core:*`。

---

## 6. 启动流程与退出清理（决定 MCP 服务器挂在哪）

### 6.1 `fn main()` 顺序（main.rs L6026 起）

| 顺序 | 动作 | 行号 | 说明 |
|---|---|---|---|
| 1 | `init_error_reporter()` | L6028 | 起一个**常驻 `std::thread`**（阻塞版 `reqwest::blocking::Client`，5s 超时），从 `mpsc::channel` 消费错误并 POST 到 `ERROR_SERVER_URL/report`；sender 存进 `ERROR_SENDER` |
| 2 | `set_panic_hook()` | L6031 | 包一层默认 hook：把 panic（线程名 / payload / file:line:col）经 `report_error` 上报，再调原 hook |
| 3 | Sentry 初始化 | L6034-L6051 | 仅 `feature = "sentry"` + 非 debug + `SENTRY_DSN` 非空；`_sentry_guard` 存活到 `main` 结束 |
| 4 | `tauri::Builder::default()` | L6843 | |
| 5 | **`.manage(...)` × 8** | L6844-L6883 | 顺序：`PortState` → `WslSerialState` → `AdbPtyState` → `WorkflowState` → `LogCacheState` → `BleState` → `BlePairState` → `BlePeripheralState` |
| 6 | `.invoke_handler(generate_handler![...])` | L6884-L6971 | **85 条命令**（`test_error_report` 被 `#[cfg(debug_assertions)]` 包着） |
| 7 | **`.setup(|app| {...})`** | L6972-L6982 | ① `#[cfg(windows)]`：`start_device_watcher(app.handle().clone())` → 起插拔监听线程；② `#[cfg(windows)]`：`get_webview_window("main").set_min_size(1047×650)`；③ **`start_wsl_watcher(app.handle().clone())`**（不在 cfg 里）→ 起 2s 轮询线程 |
| 8 | **`.on_window_event(|window, event| ...)`** | L6983-L7042 | 只在 `WindowEvent::CloseRequested` 时做清理（见 6.2） |
| 9 | `.run(tauri::generate_context!()).expect("启动应用失败")` | L7043 | 进入事件循环 |

**没有 `.build()` + `RunEvent::Exit` / `RunEvent::ExitRequested` 处理** —— 清理**只**挂在 `on_window_event(CloseRequested)` 上。

**窗口**：不在 Rust 里创建，由 `tauri.conf.json` 声明 —— label `main`，`index.html`，1047×794，min 1047×650，`center: true`，`decorations: false`（自绘标题栏），`backgroundColor: #1c1e22`，`devtools: true`，`withGlobalTauri: true`，`csp: null`。

**后台线程/定时器总览（启动后常驻）**：

| 线程 / 任务 | 数量 | 来源 | 停止方式 |
|---|---|---|---|
| 错误上报消费者 | 1 | `init_error_reporter` (L40) | **无停止机制**（`while let Ok(..) = rx.recv()`）；进程退出即回收 |
| 设备插拔通知线程 + `CM_Register_Notification` | 1 | `start_device_watcher` (L175) | 1s 轮询 `DEVICE_WATCHER_STOP` → `CM_Unregister_Notification` → 回收 `AppHandle` Box |
| WSL 状态轮询 | 1 | `start_wsl_watcher` (L1853) | 2s 轮询 `WSL_WATCHER_STOP` |
| 串口读线程 / 工作流线程 / 动作线程 | **每个连接 3 个** | `PortReader::new` (L392/L433/L443) | `stop: AtomicBool` + `Drop` 里 join（各带 200/300ms 超时，超时 `mem::forget`） |
| WSL 持久化 shell | 0 或 1（按需） | `get_wsl_shell` (L243) | `WSL_SHELL_DIRTY` / 进程死亡时重建；`CloseRequested` 时 kill |
| WSL 持久化 shell 的临时读线程 | 每次 `wsl_shell_exec` 1 个 | L298 | 读完一行标记后自行退出；超时则 kill 子进程让线程随 EOF 退出 |
| WSL bridge 进程 + 常驻 stdout 读线程 | 每 WSL 串口会话 1+1 | `open_wsl_serial` (L2307) | `kill_wsl_session` / `CloseRequested` |
| ADB PTY 子进程 + 常驻读线程 | 每 PTY 会话 1+1 | `adb_open_shell` (L3925) | `adb_shell_close`（kill+wait） |
| BLE 通知循环任务 | 0 或 1 | `ble_subscribe` (L6813) | 通知流结束自动复位 `notify_spawned`；`ble_disconnect` 也复位 |
| BLE 手动应答兜底定时 | 每条待应答写 1 个 | L4786 | 20s 后按协议错误 0x80 回复并 `Complete` |
| 前端轮询定时器（`setInterval`） | 若干 | index.html | 前端侧 |

### 6.2 退出清理（`on_window_event` + `CloseRequested`，L6983-L7042）

按顺序：

1. `dbg_log("CloseRequested: cleaning up resources")`
2. `window.emit("save-before-exit", ())` → 前端立即 `collectConfig()` + `save_config` + 结束所有日志缓存
3. `std::thread::sleep(200ms)` —— **给前端保存留时间（硬编码 200ms，是竞态点）**
4. `DEVICE_WATCHER_STOP = true`、`WSL_WATCHER_STOP = true`
5. 关闭所有串口：`PortState.readers` 全部 `drain()` + `drop`（触发 `PortReader::Drop` 的带超时 join）
6. 关闭所有 WSL 串口会话：发 `{"cmd":"close"}` → `kill_wsl_session`
7. 杀掉持久化 WSL shell（`WSL_SHELL.take()` → `kill` + `wait`）
8. 断开 BLE：`state.connected.take()` → `tauri::async_runtime::block_on(p.disconnect())`（**在事件回调里 block_on**，注释说明是为了让对端立刻感知断开）；清 `services` / `connected_addr`
9. **停止 BLE 从机广播**：`ble_periph_stop_inner(&state)`（否则进程退出前手机仍能搜到）
10. `dbg_log("CloseRequested: cleanup done")`

**未被清理的**：ADB PTY 会话（`AdbPtyState.sessions` 没在 `CloseRequested` 里遍历 kill）——依赖子进程随父进程退出；错误上报线程；`LogCacheState` 里的文件句柄（靠前端 `logCacheEnd` + OS 回收）。

**绕过清理的路径**：`install_update` 在 `emit("save-before-exit")` + `sleep(600ms)` 后直接 **`std::process::exit(0)`** → **不会**走 `CloseRequested` → 串口句柄 / BLE 从机广播 / WSL bridge 进程全部不清理（靠 OS 收尸）。

### 6.3 MCP SSE 服务器挂载建议（基于以上事实）

| 需求 | 建议落点 | 理由 |
|---|---|---|
| 启动 MCP 服务器 | `.setup(|app| { … })` 内、`start_wsl_watcher` 之后（L6980 附近）；或 `.manage()` 之后、`invoke_handler` 之前的自定义 builder 方法 | `setup` 里拿到 `AppHandle`，且所有 8 个托管状态**已经注册完毕**，`app.state::<X>()` 可用 |
| 复用后端能力 | 直接调同名内部函数，或 `app.state::<…>()` + 复用 L1078+ 的命令函数体 | 85 个命令的参数/返回上面已列全；注意命令函数签名带 `tauri::State<'_, X>`，从 MCP 侧调用需换成 `&X`（内部逻辑已抽成 `*_inner` / `*_blocking` 的更好复用，例如 `ble_periph_*_inner`、`attach_port_to_wsl_blocking`、`list_wsl_devices_blocking`、`get_wsl_distributions_blocking`） |
| 阻塞命令的处理 | MCP 一定要在自己的线程 / `spawn_blocking` 里跑 | 见 1.11：`open_port`、`close_port`、`check_workflow_matches`、原生对话框类、`attach_port_to_wsl`、`ble_pair`（可达 60s）等会长时间阻塞命令线程 |
| 关闭 MCP 服务器 | 挂在 `on_window_event(CloseRequested)` 的清理序列里（建议放在第 4 步之后、资源清理之前）；**并在 `.run()` 上补 `RunEvent::Exit` / `ExitRequested`** | 当前唯一清理入口是 `CloseRequested`，而 `install_update` 的 `process::exit(0)` 会绕过它 |
| 端口 | 动态 `127.0.0.1:0`；避开 3000 / 19876 | 见 5.4 |
| 前端权限 | 如需前端直连 SSE，需在 `capabilities/default.json` 加 `http` 权限或让 Rust 侧代理；CSP 已是 `null` 无需改 | 见 5.3 |
| 事件通道 | 若想主动推数据，可新增 `emit`（现有 4 个事件名不要复用）；但**建议沿用轮询式命令**，与现有前端架构一致，且不需要前端 `listen` | 见第 3 节 |

---

## 7. 风险与备注（架构师视角）

| # | 事项 | 影响 |
|---|---|---|
| R1 | `save_config` **无锁、无原子替换、无 fsync** | 崩溃/断电会留下截断的 `config.json`；MCP 若也写这份配置需自行加锁/原子写 |
| R2 | 配置**没有版本化 schema 在 Rust 侧**，结构完全由前端 `collectConfig()` 定义 | MCP 想读/写配置要么复制前端结构（易漂移），要么新增后端结构体 |
| R3 | `install_update` → `process::exit(0)` **绕过** `CloseRequested` 清理 | 串口句柄、BLE 从机广播、WSL bridge 子进程不会被主动释放 |
| R4 | `RunEvent::Exit` / `ExitRequested` **未处理** | 任何非窗口关闭的退出路径都没有清理钩子 |
| R5 | `CloseRequested` 里 `sleep(200ms)` 等前端保存 | 保存竞态；配置较大时可能丢最后一次写入 |
| R6 | `dbg_log` 在 **Release 也写** `%TEMP%\seahi-serial-debug.log`（追加、无轮转、无大小上限） | 长期运行会持续增长；MCP 高频调用命令会加速增长 |
| R7 | 3/4 条 ADB 命令是 `async fn` 但内部同步阻塞（`adb_tool_status`/`adb_devices`/`adb_shell`/`adb_exec`，最长 15s） | 会占住 async worker；MCP 调用时最好再包一层 |
| R8 | `check_workflow_matches` 在主线程串行执行动作，含无上限的 `delay_before` sleep | 用户配了长延时即可冻结 UI |
| R9 | `run_usbipd_list_elevated` 带了 `#[tauri::command]` 但未注册 | 冗余宏，可能是历史遗留；**不是**可被前端调用的命令 |
| R10 | 前端完全未使用的 5 个命令（`list_log_cache`、`load_workflows`、`adb_tool_status`、`adb_shell`、`adb_exec`） | 对 MCP 是"免费"的新能力入口：无需改前端即可暴露 |
| R11 | `wsl-daemon/seahi_serial_daemon.py` 监听 `0.0.0.0:19876` 但是死代码 | 若被误用会引入一个 WSL 内监听端口；建议明确标注/删除 |
| R12 | 单一 `main.rs` 7045 行、85 命令、8 份托管状态 + 11 个模块级 static | MCP 集成建议**不改现有命令签名**，另起一个 `mcp` 模块并在 `setup` 中挂载 |
| R13 | `capabilities/default.json` 仅 `core:*` | 前端无法直接 `fetch` 本地端口以外的 Tauri API；MCP 相关前端访问需新增权限 |
| R14 | BLE 从机 `GattServiceProvider` **同一时刻只能有一个进程持有同一服务 UUID**（代码注释明示） | 若 MCP 也想做 BLE 从机，必须复用同一个 `BlePeripheralState`，不能另起 provider |

---

*报告结束。全部数据来自 `src-tauri/src/main.rs`（7045 行，已分段通读）与 `src/index.html`（10610 行，正则全量抽取 + 关键段落精读）的只读分析。*
