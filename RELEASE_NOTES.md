## 🎉 SeaHi Serial v0.1.2

一款基于 **Tauri 2 + Rust** 的轻量级串口调试桌面工具，VS Code Serial Monitor 风格界面。

### ✨ 新增功能

- **快速指令下拉列表** — 发送栏右侧新增快速指令入口，支持自定义指令名称与内容，一键快速发送常用命令
- **指令增删管理** — 默认 5 条指令槽位，可自由添加、删除，按需配置
- **GitHub Actions 自动构建** — 推送 `v*` 标签即可自动构建并生成 Release，支持手动触发

### 🔧 改进

- **下拉列表宽度优化** — 快速指令面板宽度扩展至 520px，长指令内容显示更充裕
- **发送按钮图标** — 快速指令每行配备专用发送图标，操作更直观
- **界面精简** — 移除工具栏冗余状态文字标签，界面更简洁

### 📦 下载

| 文件 | 说明 |
|------|------|
| `Seahi Serial_0.1.2_x64-setup.exe` | Inno Setup 安装程序 |
| `seahi-serial.exe` | 便携版可执行文件（需从源码构建） |

### 🛠️ 技术栈

- **前端**：原生 HTML/CSS/JavaScript（无框架依赖）
- **后端**：Rust + `serialport 3.3`
- **桌面框架**：Tauri 2
- **CI/CD**：GitHub Actions（tauri-action）
- **平台**：Windows 10/11（WebView2）

### 📋 系统要求

- Windows 10 1809+ / Windows 11
- WebView2 Runtime（系统通常已预装）

---

> 从源码构建：`git clone git@github.com:SeaHi-Mo/Seahi-Serial.git && cd SeaHi-Serial && npm install && npm run build`
