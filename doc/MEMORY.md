# SeaHi Serial — AI 会话记忆

> 供 AI 助手与开发者快速恢复上下文。最后更新: 2026-08-11 | 对应版本: v0.2.9

---

## 1. 项目当前状态

- **版本**: v0.2.9，已作为 latest 发布（draft/prerelease 均为 false）
- **分支**: `main`（**注意不是 master**，推送 refspec 易写错）
- **远端**: `git@github.com:SeaHi-Mo/Seahi-Serial.git`
- **工作区**: 干净，最后一次提交 `542aede`（v0.2.9 修复 installer 后重建 tag）
- 本地另有 Inno Setup 装于 `%LOCALAPPDATA%\InnoSetup6\ISCC.exe`，可离线验证 installer.iss 编译

## 2. v0.2.9 本次会话改动

### 功能
- **监控中切换端口自动重连**（普通 + WSL 串口）：`setPortSel` 触发 → `switchMonitorPort` 释放旧端口并连接新端口；失败保持断开并提示（不自动回退）；快速连续切换以 DOM 最新选择为准
- 新增 `_reconnectPending` 机制：自动重连等待中切换端口会取消残留重试；手动断开也会清标志

### 修复
- **启动防黑/白屏**：`#bootError` 兜底页（默认可见"正在初始化界面…"，成功后隐藏）+ 8s 看门狗 + `_safeInvoke` 桥接降级（`__TAURI__` 缺失不中断脚本）+ 全局错误捕获提前注册 + 窗口 `backgroundColor: #1c1e22` + 兜底页"退出应用"按钮
- **安装包**：WebView2 Runtime 缺失检测与自动安装（Evergreen Bootstrapper）
- **UI 配合**：行尾设置连接中即时同步（div 的 change 事件是死监听，改在 `setSel` 里同步）；下拉空间不足自动上翻；4+ 监视器横向滚动；主题过渡排除日志区；引导层与 Toast 层级错开
- **配色**：设备映射行背景与"WSL"文字跟随主题风格（`--mapped-*`、`--accent-focus`），默认深色不再固定绿色
- **清理**：删除 `.mimocode/`、`inspect_db.py`、`@mimo-ai/mimocode-windows-x64` 依赖；`mimocode-tip` 类名改为 `custom-tip`

## 3. 关键技术事实与坑

- **Inno Setup 6.1+ 内置下载页**：`DownloadPage.Add(url, filename, sha256)` 入队，再调用**无参** `DownloadPage.Download`；不存在带 URL 参数的 `Download()`（v0.2.9 首轮 CI 就因此失败）
- **SSH 推送**：私钥 ACL 曾被沙箱容器 SID 污染导致 OpenSSH 拒绝；已修复为仅当前用户。`git`/`ssh` 建议加 `-o BatchMode=yes` 防止挂起
- **git 沙箱限制**：`.git` 对沙箱只读，commit/push/tag 等写操作需要提权（require_escalated）
- **div 元素陷阱**：`.disabled` 属性对 div 无效（端口下拉监控中仍可点，这成就了切端口功能）；`change` 事件不会在 div 上触发
- **Tauri v2**：窗口配置支持 `backgroundColor`；`withGlobalTauri` 注入的 `__TAURI__` 不能假设存在，需防御
- **多实例混淆**：可能同时存在多个 `seahi-serial.exe`（旧 dev/release 窗口），排查"改动没生效"前先确认看的是新实例
- **dev 模式**：`npm run dev` 用 Start-Process 后台启动（控制台隐藏），日志在 `.dev-run.log` / `.dev-run.err.log`，用后删除

## 4. 发布流程（v0.2.9 已验证）

1. 同步版本号三处：`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、`installer.iss`（`MyAppVersion`）；`Cargo.lock` 由 `cargo check` 自动更新
2. 更新 `RELEASE_NOTES.md`（正文用 `{VERSION}` 占位符，CI 会替换）
3. `git add -A && git commit`（提权）
4. `git tag -a v0.2.9 -m "..."` → `git push origin main` → `git push origin v0.2.9`
5. GitHub Actions 自动构建：tauri-action（MSI，`releaseDraft:false` + `prerelease:false` = latest）+ ISCC 生成安装程序并上传
6. 构建状态用 GitHub API 查询（`actions/runs`、`jobs`）；日志下载接口需认证，未登录 gh 时 403，本地用 ISCC 复现编译错误

