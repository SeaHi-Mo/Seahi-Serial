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

## 使用说明

1. 点击串口下拉框选择目标端口（格式：`COMx - 设备名称`）
2. 配置波特率、数据位、停止位、校验位
3. 点击 **打开串口** 连接
4. 在底部输入框输入数据，按 **Enter** 发送
5. 点击 **+ 额外监视器** 添加新分栏，可同时连接多个串口
6. 通过 **历史记录** 下拉或上下键快速复用之前发送的数据

## License

MIT
