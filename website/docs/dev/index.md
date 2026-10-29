# 开发指南

写给要改这个仓库的人：环境、命令、测试与目录。**项目约定以根目录的 [`AGENTS.md`](https://github.com/SeaHi-Mo/Seahi-Serial/blob/main/AGENTS.md) 为准**，这一页只做索引和最小上手路径。

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

## 用技能（skills）开发

仓库里的 `skills/` 是写给 AI 助手的开发手册：项目约束、命令、常见坑都在里面。开始改代码前先让助手读对应的 SKILL.md，能少踩很多坑。详见 [技能](/dev/skills)。

## 提交 PR

### 前提条件

动手前先确认这几条，否则 PR 大概率要打回：

1. **分支基于最新的 `main`**，不要从过期分支拉；一个 PR 只做一件事。
2. **能编译、能启动**：`npm run build` 通过；`npm run dev` 起得来，改动涉及界面时手动点一遍。
3. **测试通过**：
   - `cargo test --manifest-path src-tauri/Cargo.toml`
   - `node .walkthrough/gen_ble_preview.js`（改前端必跑）
   - `node .walkthrough/mcp_smoke.js`（改 MCP 必跑，需要应用正在运行）
   - 改了文档站时 `npm run docs:build`，它会检查死链
4. **版本号没动**（除非这个 PR 就是发版）：五个版本号文件只由发版提交修改，CI 会校验一致性。
5. **没夹带无关改动**：顺手格式化、改编辑器配置、删空行这类噪声，会让 review 变得很痛苦。

### 要求

**标题**：`类型(范围): 一句话说明`，类型用 `feat` / `fix` / `docs` / `chore` / `refactor` / `test`，例如：

```
fix(logs): 「清除内容」连带清掉磁盘会话缓存
docs(dev): 新增开发指南与 skills 使用指引
```

**描述**：写清三件事——为什么改（现象或 issue）、改了什么、怎么验证的。贴上报错原文、复现步骤或截图，比「修复了一些问题」有用得多。

**不要提交**：

- 生成物：`node_modules/`、`dist/`、`website/docs/mcp/tools.md`、`website/docs/changelog.md`、`*.generated.ts`（构建时自动生成，`.gitignore` 已覆盖）；
- 本机路径、令牌、`config.json` 这类带个人环境的内容；
- 与本次改动无关的重新格式化。

**提交前自查**：

```bash
git diff --stat          # 改动范围是否符合预期
git status               # 有没有误加的文件
npm run docs:build       # 改了文档时确认无死链
cargo test --manifest-path src-tauri/Cargo.toml
```

**合并流程**：PR 由维护者 review 后合并；CI 会在 PR 上跑构建与测试，红了先修再喊人看。涉及发布产物的改动（版本号、安装器、CI）需要额外说明影响范围。
## 更多文档

| 文件 | 内容 |
|---|---|
| `AGENTS.md` | 项目约定总表（改代码前必读） |
| `doc/ARCHITECTURE.md` | 架构与关键流程 |
| `doc/FRONTEND_LAYOUT.md` | 前端目录、加载顺序、原单文件行号映射 |
| `doc/MCP_DESIGN.md` | MCP 设计与实施记录 |
| `doc/SIGNING.md` | 签名现状与 SHA-256 / cosign 校验 |
