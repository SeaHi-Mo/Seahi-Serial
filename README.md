# SeaHi Serial

一款基于 **Tauri 2 + Rust** 的轻量级串口调试桌面工具，VS Code Serial Monitor 风格界面。

![Tauri](https://img.shields.io/badge/Tauri-2-blue?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-2021-orange?logo=rust&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-Windows-blue?logo=windows&logoColor=white)

<center>

![alt text](/doc/IMG/SeahiSerial.png)
</center>

## 功能特性

- **多串口同时连接** — 同窗口分栏显示，每个分栏独立操作互不干扰
- **完整串口配置** — 波特率（支持自定义输入）、数据位、停止位、校验位
- **DTR / RTS 实时切换** — 一键切换高低电平，适配不同硬件复位需求
- **发送历史记录** — 每栏独立保存最近 50 条发送记录，支持上下键快速回填
- **ANSI 颜色解析** — 自动解析 `\x1b[3Xm` 转义序列，以对应颜色显示
- **原生日志目录选择** — 通过系统文件对话框选择日志保存路径
- **VS Code Dark 主题** — 等宽字体、语法高亮配色，熟悉的开发体验
- **自定义应用图标**

## 环境依赖

| 依赖 | 说明 |
|------|------|
| **Rust** | https://rustup.rs/ |
| **Node.js 18+** | https://nodejs.org/ |
| **Visual Studio Build Tools 2022** | 需勾选 "C++ 桌面开发" |
| **WebView2** | Windows 10/11 通常已预装 |

## 快速开始

```bash
# 克隆仓库
git clone git@github.com:SeaHi-Mo/Seahi-Serial.git
cd SeaHi-Serial

# 安装依赖
npm install

# 开发模式（热重载）
npm run dev

# 构建发布版 .exe
npm run build
```

构建产物位于 `src-tauri/target/release/seahi-serial.exe`

## 项目结构

```
serial-debugger-tauri/
├── .gitignore
├── package.json
├── src/
│   └── index.html                # 前端（单文件，VS Code 风格 UI）
└── src-tauri/
    ├── Cargo.toml                # Rust 依赖
    ├── Cargo.lock
    ├── build.rs                  # Tauri 构建脚本
    ├── tauri.conf.json           # Tauri 应用配置
    ├── capabilities/
    │   └── default.json          # ACL 权限配置
    ├── icons/                    # 应用图标（ICO / PNG）
    │   ├── icon.ico
    │   ├── 32x32.png
    │   ├── 128x128.png
    │   └── 128x128@2x.png
    └── src/
        └── main.rs              # Rust 后端（串口枚举、多端口收发、DTR/RTS）
```

## 技术栈

- **前端**：原生 HTML/CSS/JavaScript（无框架）
- **后端**：Rust + `serialport 3.3`
- **桌面框架**：Tauri 2
- **原生对话框**：`rfd 0.15`

## 自动构建（GitHub Actions）

项目已配置 GitHub Actions 自动构建，推送版本 tag 后自动编译并创建 GitHub Release。

### 工作流配置

工作流文件位于 `.github/workflows/build.yml`，包含以下功能：

- **触发方式**：推送 `v*` 格式的 tag 时自动触发，也支持手动触发
- **运行环境**：`windows-latest`
- **缓存优化**：Rust 编译缓存，加速后续构建
- **自动发布**：构建完成后自动创建 Draft Release，附带 exe 安装包

### 如何使用

```bash
# 1. 修改版本号（同步更新以下 3 个文件）
#    - src-tauri/Cargo.toml      中的 version
#    - src-tauri/tauri.conf.json 中的 version
#    - installer.iss              中的 MyAppVersion

# 2. 提交并推送代码
git add -A
git commit -m "v0.x.x: 更新说明"
git push origin main

# 3. 创建并推送版本 tag
git tag v0.x.x
git push origin v0.x.x

# 4. GitHub Actions 自动开始构建
#    构建完成后会生成一个 Draft Release，进入 Releases 页面手动发布即可
```

### 工作流文件说明

```yaml
# .github/workflows/build.yml 核心步骤
steps:
  - Checkout 代码
  - Setup Node.js 22
  - Setup Rust stable
  - Rust 编译缓存
  - npm install（安装前端依赖）
  - tauri-action（构建 Tauri 并创建 Draft Release）
```

### 手动触发构建

进入 GitHub 仓库 → **Actions** → **Build Release** → **Run workflow**，无需创建 tag 即可手动触发构建。

## 使用教程

### 界面总览

下图展示了 SeaHi Serial 的主界面：

<center>

![主界面](/doc/IMG/SeahiSerial.png)

</center>

界面分为以下区域：

| 区域 | 说明 |
|------|------|
| **① 全局操作栏** | 最顶部蓝色链接栏，包含「打开额外监视器」「WSL 端口映射」「提交 issue」和主题切换开关 |
| **② 工具栏** | 串口配置区：查看模式、端口选择、波特率、行尾设置、开始/停止监控按钮，以及右侧的图标按钮组 |
| **③ 输出区** | 中间大面积区域，显示接收到的串口数据（支持文本/HEX 视图、行号、时间戳） |
| **④ 发送栏** | 底部输入框，输入内容后按 Enter 或点击「发送」按钮发送数据 |
| **⑤ 快速指令** | 发送栏最右侧的「≡」按钮，可保存常用指令一键发送 |

### 快速上手

#### 第一步：选择串口并连接

1. 插入串口设备（如 USB 转串口线）
2. 点击工具栏的 **端口** 下拉框，选择目标端口（格式：`通信端口 (COMx)` 或 `设备名称 (COMx)`）
3. 根据设备需求配置参数：
   - **波特率**：常用 9600、115200，也可手动输入任意值
   - **行尾**：CRLF / LF / CR / 无（根据设备协议选择）
4. 点击绿色 **▶ 开始监控** 按钮，连接成功后按钮变为红色 **■ 停止监控**

> 💡 如果看不到端口，点击端口下拉框旁边的 **🔄 刷新按钮** 重新枚举。

<!-- TODO: 替换为实际截图 —— 展开端口下拉框选择端口的画面 -->
<!-- ![端口选择](/doc/IMG/port-select.png) -->

#### 第二步：接收数据

连接成功后，输出区会实时显示设备发来的数据。你可以：

- 切换 **查看** 模式：「文本」查看可读内容，「HEX」查看原始字节
- 点击 **行号按钮**（右上角第 6 个图标）显示/隐藏行号
- 点击 **时间戳按钮**（右上角第 5 个图标）为每条数据添加时间戳
- 点击 **自动滚动按钮**（右上角第 2 个图标）控制是否自动滚到底部

<!-- TODO: 替换为实际截图 —— 输出区显示接收数据、带行号和时间戳 -->
<!-- ![接收数据](/doc/IMG/receive-data.png) -->

#### 第三步：发送数据

1. 在底部输入框输入要发送的内容
2. 选择发送格式：点击「文本 ▾」可切换为「HEX」模式
3. 按 **Enter** 或点击 **▶ 发送** 按钮发送

> 💡 发送历史：按 **↑↓ 方向键** 可快速回填最近发送过的内容。

<!-- TODO: 替换为实际截图 —— 发送栏输入内容并发送后的效果 -->
<!-- ![发送数据](/doc/IMG/send-data.png) -->

#### 第四步：高级设置

点击工具栏最右侧的 **⚙ 齿轮按钮** 展开高级设置行：

| 设置项 | 说明 |
|--------|------|
| **数据位** | 5 / 6 / 7 / 8（默认 8） |
| **停止位** | 1 / 2（默认 1） |
| **校验位** | 无 / 奇校验 / 偶校验 |
| **DTR** | 勾选后拉高 DTR 电平（常用于复位 Arduino 等） |
| **RTS** | 勾选后拉高 RTS 电平 |
| **选择日志目录** | 设置日志保存路径 |
| **💾 保存日志** | 将当前输出内容保存为文件 |
| **📋 复制全部** | 将输出内容复制到剪贴板 |

<!-- TODO: 替换为实际截图 —— 展开高级设置行，显示数据位/停止位/校验位/DTR/RTS -->
<!-- ![高级设置](/doc/IMG/advanced-settings.png) -->

### 进阶功能

#### 多串口同时监控

点击顶部 **＋ 打开额外监视器** 可添加新分栏，每个分栏独立配置、独立连接，支持同时调试多个串口设备。分栏之间用蓝色分隔线区分，点击分栏右上角 **✕** 可关闭。

<!-- TODO: 替换为实际截图 —— 多个监视器分栏并排显示 -->
<!-- ![多串口监控](/doc/IMG/multi-monitor.png) -->

#### 快速指令

点击发送栏最右侧的 **≡ 按钮**，可配置常用指令：

1. 点击 **＋ 添加** 新增一条指令
2. 左侧输入框填写指令名称（如 `AT`、`RST`）
3. 右侧输入框填写指令内容
4. 点击 **▶** 按钮一键发送，或在输入框中按 Enter 发送

> 指令配置会自动保存，下次启动自动恢复。

<!-- TODO: 替换为实际截图 —— 快速指令面板展开状态 -->
<!-- ![快速指令](/doc/IMG/quick-command.png) -->

#### 终端模式

点击工具栏的 **⌨ 终端模式按钮**（右上角第 4 个图标），进入类终端交互模式：

- 底部发送栏隐藏，直接在输出区打字
- 支持 Backspace 退格、Enter 发送
- 带有闪烁光标，模拟终端体验

<!-- TODO: 替换为实际截图 —— 终端模式下的光标和输入效果 -->
<!-- ![终端模式](/doc/IMG/terminal-mode.png) -->

#### 主题切换

点击右上角的 **🌙/☀ 主题开关**，可在深色（VS Code Dark）和浅色主题之间切换。主题偏好会自动保存。

<!-- TODO: 替换为实际截图 —— 浅色主题效果 -->
<!-- ![浅色主题](/doc/IMG/light-theme.png) -->

#### 自动重连

点击工具栏的 **🔗 自动重连按钮**（右上角第 3 个图标），启用后当串口意外断开时会自动尝试重连，最多重试 10 次。

#### WSL 端口映射

点击顶部 **WSL 端口映射** 可将 Windows 串口映射到 WSL 环境中使用，方便在 Linux 子系统中调试嵌入式设备。

<!-- TODO: 替换为实际截图 —— WSL 端口映射面板 -->
<!-- ![WSL 端口映射](/doc/IMG/wsl-mapping.png) -->

### 键盘快捷键

| 按键 | 功能 |
|------|------|
| `Enter` | 发送输入框内容 |
| `↑` / `↓` | 浏览发送历史 |
| `Escape` | 关闭历史下拉列表 |

## License

MIT
