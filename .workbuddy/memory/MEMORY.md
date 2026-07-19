# Seahi-Serial 项目长期记忆

## 项目概况
- Tauri 2 + Rust 串口调试器，仅支持 Windows
- 前端单文件 HTML/CSS/JS（约4400行），后端单 Rust 文件（约1745行）
- 版本号需同步 3 个文件：Cargo.toml、tauri.conf.json、installer.iss

## 用户研究进展
- 2026-07-18：完成用户研究计划（doc/USER_RESEARCH_PLAN.md v1.1）
- 2026-07-18：完成专家启发式走查（doc/USER_RESEARCH_HEURISTIC_WALKTHROUGH.md v1.0）
- 2026-07-19：完成动态可用性测试（doc/USER_RESEARCH_USABILITY_TEST.md v1.0）✅
- 走查发现 10 个原始发现(F1-F10) + 9 个新发现(D1-D9)、13 个痛点(P-01~P-13)、9 个假设(H1-H9)
- H1 已删除（中文乱码风险不存在）
- 高优先级改进：快捷指令文字标签、高级设置默认折叠、WSL视觉权重增强
- 实际版本 v0.2.0 (b77d4c)，AGENTS.md 写的 v0.1.2 已过期
- 下一步：P1 深度访谈(3-5人) + 改进实施跟踪

## 技术备忘
- **Tauri WebView 自动化交互三件套**：SetWindowPos(TOPMOST/NOTOPMOST) + SetForegroundWindow + SendInput(绝对坐标0-65535)
- pyautogui 在 Tauri WebView 上不可靠（焦点保护问题）
- **截图方案对比**：
  - ❌ PrintWindow + PW_RENDERFULLCONTENT：Tauri WebView2 渲染层不响应，无法捕获动态内容
  - ✅ BitBlt 屏幕 DC：能捕获所有覆盖层、弹窗、tooltip，但会被其他窗口遮挡
- 坐标硬编码不可靠：需要从 HTML 源码反推精确坐标
- PowerShell 7 工具存在 stdout 捕获 bug，改用 Bash 调用 Python
- 配置持久化会跨重启保留状态（双监视器无法明显重置）
