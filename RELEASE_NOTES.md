## 🎉 SeaHi Serial v0.1.1

一款基于 **Tauri 2 + Rust** 的轻量级串口调试桌面工具，VS Code Serial Monitor 风格界面。

### ✨ 新增功能

- **自定义 SVG 工具栏图标** — 10 个专用矢量图标，支持深色主题自适应，视觉统一
- **自动重连** — 串口意外断开后自动尝试重新连接，无需手动操作
- **消息回显** — 可独立开关发送数据的本地回显，方便调试确认
- **Inno Setup 安装程序** — 提供专业安装包，支持桌面快捷方式、开始菜单、中文界面
- **自定义应用图标** — 青色 Logo 替换默认图标

### 🔧 改进

- 工具栏按钮按功能重新排列：清除内容 → 自动回滚 → 自动重连 → 终端模式 → 时间戳 → 消息回显 → 更多设置
- 移除冗余的状态文字标签，界面更简洁

### 📦 下载

| 文件 | 说明 |
|------|------|
| `Seahi-Serial-Setup-0.1.1.exe` | Inno Setup 安装程序 |
| `seahi-serial.exe` | 便携版可执行文件（需从源码构建） |

### 🛠️ 技术栈

- **前端**：原生 HTML/CSS/JavaScript（无框架依赖）
- **后端**：Rust + `serialport 3.3`
- **桌面框架**：Tauri 2
- **平台**：Windows 10/11（WebView2）

### 📋 系统要求

- Windows 10 1809+ / Windows 11
- WebView2 Runtime（系统通常已预装）

---

> 从源码构建：`git clone git@github.com:SeaHi-Mo/Seahi-Serial.git && cd SeaHi-Serial && npm install && npm run build`
