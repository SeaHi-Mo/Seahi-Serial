# 开发指南

写给要改这个仓库的人：环境、命令、测试、目录、发版。**项目约定以根目录的 [`AGENTS.md`](https://github.com/SeaHi-Mo/Seahi-Serial/blob/main/AGENTS.md) 为准**，这一页只做索引和最小上手路径。

## 环境

| 依赖 | 说明 |
|---|---|
| **Rust** | https://rustup.rs/ |
| **Node.js 18+** | https://nodejs.org/ |
| **Visual Studio Build Tools 2022** | 需勾选「C++ 桌面开发」 |
| **WebView2** | Windows 10/11 通常已预装 |

## 跑起来

```bash
git clone git@github.com:SeaHi-Mo/Seahi-Serial.git
cd Seahi-Serial

npm install          # 前端依赖（只有 @tauri-apps/cli）
npm run dev          # 开发模式（热重载）
npm run build        # 发布构建 → src-tauri/target/release/seahi-serial.exe
```

`npm run dev` 跑完没有窗口时，**先看构建输出里有没有 `error` / `拒绝访问`**，不要先怀疑应用逻辑——多半是构建阶段就失败了。排查流程见 [技能 → Windows 构建期拒绝访问](/dev/skills#win-build-access-denied)。

## 测试

| 命令 | 覆盖范围 |
|---|---|
| `cargo test --manifest-path src-tauri/Cargo.toml` | 后端单测（含 MCP 工具契约） |
| `node .walkthrough/gen_ble_preview.js` | 前端无头断言（沙箱里跑真实 handler） |
| `node .walkthrough/mcp_smoke.js` | 对**正在运行的应用**逐个真调 MCP 工具 |

没有 lint / 类型检查 / 格式化工具。**改前端后必须跑断言集**；改 MCP 后必须跑 `mcp_smoke.js`。

## 目录结构

```
Seahi-Serial/
├── src/
│   ├── index.html            # 前端骨架（4 个 <link> + 16 个 <script src>）
│   ├── css/                  # 4 块样式，按顺序加载
│   ├── js/                   # 16 块逻辑（普通脚本、共享全局作用域）
│   └── vendor/xterm/         # 终端模式用的 xterm
├── src-tauri/
│   ├── src/main.rs           # Rust 后端（串口 / WSL / ADB / BLE / OTA）
│   ├── src/mcp/              # MCP 服务器（transport / protocol / bridge / registry / loghub …）
│   ├── vendor/btleplug/      # btleplug 的本地 fork（4 处补丁，升级按 VENDOR.md 重打）
│   └── wsl-daemon/           # WSL bridge 脚本
├── npm/seahi-serial-mcp/     # MCP 客户端配置安装器（npx 可用）
├── skills/                   # 写给 AI 助手的开发手册，见「技能」
├── .walkthrough/             # 前端断言集 + MCP 自检 + 两个生成器
├── doc/                      # 内部文档（架构、前端布局、MCP 设计、签名说明…）
└── installer.iss             # Inno Setup 安装脚本
```

前端**没有构建步骤**：`index.html` 按顺序加载 `css/*.css` 与 `js/*.js`，改动直接生效。

## 发版

版本号必须**五处一致**，CI 会校验，不一致直接构建失败：

1. `src-tauri/Cargo.toml` 的 `version`
2. `src-tauri/tauri.conf.json` 的 `version`
3. `installer.iss` 的 `MyAppVersion`
4. `package.json` 的 `version`
5. `src-tauri/Cargo.lock` 里 `seahi-serial` 条目的 `version`

流程：

```bash
# 1. 改上面五处版本号
# 2. 更新 RELEASE_NOTES.md（只写功能：新增 / 修复 / 性能 / 删除）
# 3. 提交并推送
git commit -am "chore(release): v0.x.y"
git push

# 4. 打 tag 触发 CI，构建完成后直接发布为正式 Release
git tag v0.x.y
git push origin v0.x.y
```

⚠️ 版本号是**编译期烘焙**进 exe 的：只改文件不重编，装出来的应用仍是旧号。本地打包前先 `npm run build`。

## 用技能（skills）开发

仓库里的 `skills/` 是写给 AI 助手的开发手册：项目约束、命令、常见坑都在里面。开始改代码前先让助手读对应的 SKILL.md，能少踩很多坑。详见 [技能](/dev/skills)。

## 更多文档

| 文件 | 内容 |
|---|---|
| `AGENTS.md` | 项目约定总表（改代码前必读） |
| `doc/ARCHITECTURE.md` | 架构与关键流程 |
| `doc/FRONTEND_LAYOUT.md` | 前端目录、加载顺序、原单文件行号映射 |
| `doc/MCP_DESIGN.md` | MCP 设计与实施记录 |
| `doc/SIGNING.md` | 签名现状与 SHA-256 / cosign 校验 |
