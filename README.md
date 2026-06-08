# SeaHi Serial

一款基于 **Tauri 2 + Rust** 的轻量级串口调试桌面工具，VS Code Serial Monitor 风格界面。

![Tauri](https://img.shields.io/badge/Tauri-2-blue?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-2021-orange?logo=rust&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-Windows-blue?logo=windows&logoColor=white)

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

## 使用说明

1. 点击串口下拉框选择目标端口（格式：`COMx - 设备名称`）
2. 配置波特率、数据位、停止位、校验位
3. 点击 **打开串口** 连接
4. 在底部输入框输入数据，按 **Enter** 发送
5. 点击 **+ 额外监视器** 添加新分栏，可同时连接多个串口
6. 通过 **历史记录** 下拉或上下键快速复用之前发送的数据

## License

MIT
