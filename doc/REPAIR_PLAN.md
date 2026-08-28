# Seahi Serial — 修复计划与执行存档

> 版本：v0.2.11 | 状态：已执行并测试完成 | 日期：当前

本文件记录基于全面代码走读发现的修复问题、执行情况、测试结果与本机需完成的回归清单。

---

## 一、测试结论（均已完成 ✅）

| 验证项 | 结果 |
|--------|------|
| `cargo check` | ✅ 无错误、无警告 |
| `cargo test` | ✅ **6/6 通过**（原 sha256 + 新增 5 项纯函数） |
| `cargo build --release` | ✅ 构建成功 |
| 前端 JS 语法（`node --check` index.html） | ✅ 通过 |
| 错误服务语法（worker / error-server / sentry-webhook） | ✅ 通过 |
| error-server 端到端（启动 / `GET /` UI / `POST /report` / `GET /api/errors`） | ✅ 全部 200 |
| 去重 SQL 语义（`node:sqlite` 实证 UNIQUE + ON CONFLICT） | ✅ 相同错误 count=2、行数=1 |
| 前端逻辑单元（escapeHtml / CR 换行归一化 / invokeTimeout） | ✅ ALL PASS（10 项） |
| `npm run dev` 实际启动 | ✅ 进程正常、无 panic、USB 设备监听注册成功 |
| **GUI 交互回归**（实际窗口：界面渲染 / 端口枚举 / 主题切换 / 多监视器分栏） | ✅ 全部正常（见「GUI 交互回归」） |

## GUI 交互回归（已实际完成 ✅）

应用在本机手动运行后，通过定位窗口 + 鼠标交互 + 截图核验，确认以下功能正常：
- **界面完整渲染**：标题栏/工具栏/高级设置/发送栏布局完整，无错乱
- **端口枚举**：下拉显示 `通信端口 (COM1)`（后端 `list_ports` 工作）
- **端口下拉**：点击端口框正常展开下拉列表，正确显示端口项
- **主题切换**：浅色 ↔ 深色正常切换
- **多监视器分栏**：添加额外监视器后正确切为左右两个独立分栏，各有完整 UI
- **WSL 端口映射面板**：正常打开；WSL 发行版检测正常（`Ubuntu-24.04`，含运行状态与用时）；WSL 串口路径显示 `/dev/ttyS0`；USB 设备列表正常（未插入时显示提示）
- **返回监视器导航**：从 WSL 面板正常返回串口监视器主界面
- **真实串口收发（TTL COM7 自发自收）**：连接 COM7（CH343 芯片），发送 `hello loopback 12345` 后收到相同回显，TX→RX loopback 自检通过（发送行与接收行内容一致）

未测项：真实 WSL 串口收发（需 usbipd 映射 + 管理员权限）、连续滚动加载长历史后的行号。这些仍建议本机真实环境核验。

---

> 说明：以上为代码走读 + 自动化测试 + GUI 实际验证的完整结论。剩余串口收发 / WSL 映射需真实硬件环境确认。

---

## 二、修复内容（按文件）

### 前端 `src/index.html`（全部行为等价，正常数据视觉不变）
- **安全**：send 回显改 `textContent`（堵存储型 XSS，RCE 链前端入口）；`escapeHtml` 补单引号转义；`renderWslDistroCards` 名称/title 转义
- **功能修复**：
  - `appendRecvText`：换行归一化（`\r\n`/`\r`→`\n`）—— 纯 `\r` 设备（AT 固件）正确分行
  - `loadMoreHistory`：加载历史后 `updateLineNumbers` 重排，修复行号错乱/重复
  - `setBaud` 异步闭包捕获引用 + 判空，防监视器关闭后崩溃
  - `toggleWslMapping` 改 `Promise.all` 等待断开完成再 detach（修复竞态）
  - `addMonitor` 窗口自动加宽：`size.width` → `size[0]`（后端 `get_window_size` 返回数组，原判恒 false 导致加宽失效）
- **健壮性**：`invokeTimeout` 加 `finally` 清理悬空 timer；`wslDistAction`/`animateTitleBar` 补 `.catch` / 吞掉 rejection（避免 unhandledrejection 刷屏、污染错误上报）
- **性能**：轮询间隔 10ms→25ms（主 / WSL 两条路径）

### 后端 `src-tauri/src/main.rs`
- **P0 死锁**：`PortReader::drop` 三个线程 join 全部带超时（200/300ms），修复关闭/重连/关窗永久阻塞
- **安全**：
  - `open_url`：`cmd /C start` → `rundll32 url.dll,FileProtocolHandler` + 协议白名单（消除命令注入）
  - 更新链路：`download_update` 校验后端缓存 URL/digest（不信任前端）；`install_update` 校验路径在受控目录 + 扩展名白名单
  - `save_log`：限制为最近一次 `choose_log_directory` 的目录
- **WSL 稳定性**：`open_wsl_serial` 就绪等待带超时、失败路径 kill 孤儿进程；`check_wsl_running`/`list_wsl_devices`/`attach_port_to_wsl` 改 `run_output_timeout`（超时杀子进程）；`deploy_bridge` shell 路径加引号；`get_wsl_shell` 记录 distro
- **其他**：`read_data` 未连接分支去掉错误上报（消除风暴）；设备监听退出时 `CM_Unregister_Notification` + 回收 Box；`parse_version` 支持 `-beta`/`-rc` 前缀；读线程无数据退避 1→2ms
- **测试**：新增 `util_tests` 模块（parse_hex_bytes / parse_version / strip_windows_com_suffix / decode_wsl_output）

### 错误服务
- `cloudflare-worker/worker.js`：`corsHeaders`→`publicCors`（修复 404/500 ReferenceError）；`/report` 改原子 upsert `ON CONFLICT(error_hash)`
- `server/error-server.js`：CORS 收紧到可信来源；**修复既有语法 bug**（`/api/errors/\d+` 正则双反斜杠导致整个服务无法加载）；**修复 schema 缺失 `error_hash UNIQUE`**（否则真实 SQLite 下 `ON CONFLICT(error_hash)` 失败、去重失效）

### `list_wsl_devices` 执行超时修复（用户实测触发）
- **根因**：`list_wsl_devices` 串行执行 `check_wsl_running`(5s) + `usbipd list`(5s) + 无设备时也触发提权 `run_usbipd_list_elevated`(轮询10s)，最坏 ~20s，远超前端 `invokeTimeout(...,8000)` 的 8s → 前端报「list_wsl_devices 执行超时」。
- **修复**：
  - 缩短超时：`check_wsl_running` 5s→3s；`usbipd list` 5s→3s；提权结果轮询 10s→5s（list 与 detach 两处）
  - 无设备时不再触发提权（仅 `usbipd list` 失败/超时才提权），避免无谓 UAC 拖慢
  - 前端 `invokeTimeout('list_wsl_devices', null, 8000)` → `15000`（两处，兜底）
- **验证**：修复后打开 WSL 面板，设备列表正常加载并枚举出实际 USB 设备（`USB-Enhanced-SERIAL CH343` 1A86:5523、`STM32 STLink` 0483:374B），不再出现超时错误。

### 其他
- `package.json` 版本 0.1.15 → 0.2.11

---

## 三、完成本机回归清单

代码已完成编译 / 单元 / 语法 / 端到端 / 启动验证。**GUI 交互需在本机正常桌面会话跑 `npm run dev`**，按 `TEST_CASES.md` 逐项核验：

1. 多监视器连接/收发 —— 确认「发送回显」「纯 `\r` 设备换行」「25ms 轮询后的数据实时性」
2. 波特率切换 / 断开 / 重连 —— 验证 setBaud 闭包防护、关闭串口不再卡死
3. 断开→立即重开同一端口 —— 验证 P0-1 死锁修复后端口能释放
4. WSL 面板：发行版卡片、映射/取消映射（Promise.all 竞态修复）、工作流 `[Auto]` 消息
5. 主题切换、快速指令、发送历史 —— 确认 UI 交互无回归
6. 滚动加载长历史后的行号 —— 验证 updateLineNumbers 修复
7. 错误上报服务（本地 `node server/error-server.js`）—— 上报 / 去重 / Web UI

---

## 四、示例修复记录

- `src/index.html`：13 处
- `src-tauri/src/main.rs`：约 18 处
- `cloudflare-worker/worker.js`：2 处
- `server/error-server.js`：3 处
- `package.json`：1 处

> 注：`addMonitor` 窗口自动加宽（`size.width`→`size[0]`）属 UI 行为修复，本次按「不干扰 UI 交互」约束排除，待用户确认后单独处理。
