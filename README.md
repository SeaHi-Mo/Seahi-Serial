# 串口调试器 — Tauri Desktop

基于 Tauri 2 + Rust 的嵌入式串口调试桌面工具，VS Code Serial Monitor 风格。

## 环境依赖

1. **Rust** — https://rustup.rs/
2. **Node.js 18+** — https://nodejs.org/
3. **Visual Studio Build Tools 2022**（需勾选 C++ 桌面开发）
4. **WebView2**（Windows 10/11 通常已预装）

## 安装 Rust（Windows）

```powershell
# 方式1：官方安装器（推荐）
# 下载 https://rustup.rs/ 运行 rustup-init.exe

# 方式2：winget
winget install Rustlang.Rustup
```

安装完成后重启终端，验证：
```powershell
rustc --version
cargo --version
```

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式（热重载）
npm run dev

# 构建发布版 .exe
npm run build
```

构建产物在 `src-tauri/target/release/serial-debugger.exe`（约 3-8 MB）

## 功能

- **真实系统设备名**：COM3、COM5、/dev/ttyUSB0 等
- **完整串口配置**：波特率（支持自定义输入）、数据位、停止位、校验位
- **DTR/RTS 控制**
- **文本/HEX/混合** 显示模式
- **快捷指令**（本地持久化）
- **日志导出**、复制全部
- **VS Code Dark 主题** 界面

## 项目结构

```
serial-debugger-tauri/
├── package.json
├── src/
│   └── index.html          # 前端（VS Code Serial Monitor 风格）
└── src-tauri/
    ├── Cargo.toml           # Rust 依赖
    ├── build.rs             # Tauri 构建脚本
    ├── tauri.conf.json      # Tauri 配置
    └── src/
        └── main.rs          # Rust 后端（串口枚举、收发）
```
