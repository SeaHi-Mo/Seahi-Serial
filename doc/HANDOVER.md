# SeaHi Serial - 项目交接文档

> 版本: v0.1.2 | 最后更新: 2026-06-09 | 作者: SeaHi

---

## 1. 项目简介

**SeaHi Serial** 是一款基于 Tauri 2 + Rust 的轻量级串口调试桌面工具，采用 VS Code Serial Monitor 风格界面。适用于嵌入式开发、物联网调试等需要串口通信的场景。

### 核心特性

- 多串口分栏同时调试
- 文本/Hex/双模式数据显示
- ANSI 颜色渲染
- 快速指令（自定义常用命令一键发送）
- 发送历史记录（最多 50 条，键盘上下键快速回填）
- 自动重连、自动滚动
- DTR/RTS 信号实时控制
- 日志导出
- VS Code Dark 主题界面

---

## 2. 环境准备

### 2.1 开发环境要求

| 工具 | 版本要求 | 用途 |
|------|----------|------|
| **Rust** | stable (1.70+) | 后端编译 |
| **Node.js** | 18+ | 前端工具链 |
| **npm** | 随 Node.js 安装 | 包管理 |
| **WebView2 Runtime** | 系统预装 | 运行时 (Win10 1809+ 已内置) |
| **Inno Setup** | 6.x (可选) | 打包安装程序 |

### 2.2 安装步骤

```bash
# 1. 克隆仓库
git clone git@github.com:SeaHi-Mo/Seahi-Serial.git
cd SeaHi-Serial

# 2. 安装前端依赖
npm install

# 3. 开发模式运行（热重载）
npm run dev

# 4. 构建发布版
npm run build
```

构建产物位于 `src-tauri/target/release/bundle/`。

---

## 3. 项目结构说明

```
serial-debugger-tauri/
├── src/index.html           ⭐ 前端全部代码（HTML + CSS + JS，单文件 ~990 行）
├── src-tauri/src/main.rs    ⭐ 后端全部代码（Rust，单文件 ~248 行）
├── src-tauri/tauri.conf.json  Tauri 主配置
├── src-tauri/Cargo.toml        Rust 依赖
├── installer.iss               安装打包脚本
├── package.json                Node.js 配置
└── .github/workflows/build.yml  CI/CD 自动构建
```

> ⚠️ **重要**: 前端是一个单文件应用，所有 CSS 和 JS 都内联在 `index.html` 中，没有模块拆分。如果后续代码量增大，建议拆分为独立文件。

---

## 4. 代码导航指南

### 4.1 前端 (index.html)

| 区域 | 行号范围 | 内容 |
|------|----------|------|
| CSS 样式 | 7 ~ 338 | 全部样式（设计变量 + 组件样式 + ANSI 颜色） |
| SVG 图标常量 | 360 ~ 373 | ICONS 对象（11 个内联 SVG） |
| 工具函数 | 376 ~ 399 | parseAnsi, escapeHtml |
| 窗格创建 | 401 ~ 502 | createMonitorPane（生成完整监视器 DOM） |
| 键盘事件 | 504 ~ 556 | sendInput 的 keydown 处理 |
| 波特率下拉 | 564 ~ 583 | toggleBaudDropdown, setBaud |
| 串口操作 | 585 ~ 707 | refreshPorts, connectPort, disconnectPort, startReading 等 |
| 发送逻辑 | 709 ~ 775 | sendData, addMonitor, closeMonitor, 行尾处理 |
| 日志保存 | 777 ~ 813 | chooseLogDir, saveLogToFile, copyOutput |
| 数据解码 | 815 ~ 852 | decodeData, decodeRaw, hexToBytes, bytesToHex |
| 快速指令 | 854 ~ 988 | makeQcmdItem, toggleQcmdDropdown, addQcmdItem 等 |
| 初始化 | 983 ~ 987 | DOMContentLoaded 事件 |

### 4.2 后端 (main.rs)

| 区域 | 行号范围 | 内容 |
|------|----------|------|
| 状态定义 | 1 ~ 30 | PortState 结构体 |
| PortInfo | 32 ~ 51 | 端口信息数据结构 + From trait |
| list_ports | 53 ~ 60 | 枚举串口 |
| open_port | 63 ~ 133 | 打开串口（含参数配置） |
| close_port | 136 ~ 143 | 关闭串口 |
| send_data | 146 ~ 155 | 发送数据 |
| read_data | 158 ~ 173 | 读取数据 (4KB 缓冲区) |
| set_dtr / set_rts | 176 ~ 195 | DTR/RTS 控制 |
| choose_log_directory | 198 ~ 204 | 日志目录选择 |
| save_log | 207 ~ 226 | 日志保存 |
| main() | 228 ~ 247 | 应用入口，注册命令 |

---

## 5. 关键设计决策

### 5.1 为什么选择单文件前端？

- 项目规模较小，模块化收益不明显
- 部署简单，`frontendDist` 直接指向 `src/` 目录
- 无需打包工具（webpack/vite），减少构建复杂度
- **代价**: 随功能增长，维护难度增加，建议在 1500+ 行时拆分

### 5.2 为什么轮询读取而非事件驱动？

- `serialport` crate 的事件驱动 API 在 Windows 上稳定性不佳
- 50ms 轮询间隔在串口调试场景下完全足够（最高波特率 921600 也远超 50ms 周期）
- 实现简单，可靠性高

### 5.3 为什么用 Mutex 而非 tokio？

- 当前串口操作不需要异步（读写都是阻塞式）
- Tauri 的 invoke handler 已经是异步的，前端不会被阻塞
- 保持依赖最小化，不引入 async runtime

---

## 6. 常见开发任务

### 6.1 添加新的串口参数

**步骤**:

1. 前端 `createMonitorPane()` 中添加对应的 `<select>` 或 `<input>`
2. `connectPort()` 函数中读取新参数并传给后端
3. 后端 `open_port` 命令添加对应参数，配置到 `SerialPortBuilder`
4. 更新 `decodeRaw()` 或其他相关解码函数

### 6.2 添加新的工具栏按钮

**步骤**:

1. 在 `ICONS` 对象中添加 SVG 图标常量
2. 在 `createMonitorPane()` 的 `.toolbar` 区域添加按钮 HTML
3. 编写对应的 JS 函数
4. 如需后端支持，添加新的 Tauri 命令

### 6.3 发布新版本

```bash
# 1. 同步版本号（4 处）
#    - Cargo.toml        → package.version
#    - tauri.conf.json   → version
#    - installer.iss     → MyAppVersion
#    - package.json      → version

# 2. 提交并推送
git add -A && git commit -m "chore: 版本号更新至 v0.x.x"
git push origin main

# 3. 创建标签并推送
git tag v0.x.x
git push origin v0.x.x

# 4. GitHub Actions 自动构建 Draft Release
# 5. 到 GitHub Releases 页面手动发布
```

### 6.4 本地构建安装包

```bash
# 1. 构建 exe
npm run build

# 2. 使用 Inno Setup Compiler 编译安装包
#    打开 installer.iss → Build → Compile
#    产物在 installer/ 目录
```

---

## 7. 已知问题与注意事项

### 7.1 Windows 图标缓存

Windows 会缓存 exe 图标。修改应用图标后需要：
1. 删除 `%LocalAppData%\IconCache.db`
2. 重启资源管理器或重启电脑
3. 或运行项目中的 `refresh-icon-cache.ps1`

### 7.2 串口权限

- Windows 下串口访问通常需要管理员权限
- 安装程序设置了 `PrivilegesRequired=admin`
- 开发时建议以管理员身份运行终端

### 7.3 CSP 已禁用

`tauri.conf.json` 中 `security.csp` 设为 `null`，这是为了支持内联 `<script>` 和 `style`。如果未来改为外部文件引用，建议启用 CSP 策略。

### 7.4 版本号同步

发布前务必检查 4 处版本号是否一致。历史上曾出现 Cargo.toml 和 tauri.conf.json 版本不同步的情况。

---

## 8. 功能开关说明

| 按钮 | 默认状态 | 说明 |
|------|----------|------|
| 自动滚动 | 关闭 | 输出区满时自动滚动到底部 |
| 自动重连 | 关闭 | 串口断开时自动尝试重新连接 |
| 终端模式 | 关闭 | 输出区行为模拟终端 |
| 时间戳 | 关闭 | 每条接收数据前显示时间戳 |
| 消息回显 | 关闭 | 发送数据时在输出区显示已发送内容 |

---

## 9. Git 分支策略

| 分支 | 用途 |
|------|------|
| `main` | 稳定发布分支 |
| `v0.x.x` | 对应版本的开发分支（可选） |
| `v*` tag | 版本发布标签，触发 GitHub Actions 自动构建 |

---

## 10. 联系与资源

- **GitHub**: https://github.com/SeaHi-Mo/Seahi-Serial
- **Issue 反馈**: 提交至 GitHub Issues
- **技术文档**: `doc/ARCHITECTURE.md`（技术架构）
