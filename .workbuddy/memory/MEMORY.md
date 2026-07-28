# Seahi-Serial 项目长期记忆

## 用户研究进展
- 2026-07-19: 完成动态可用性测试 v3（BitBlt 截图方案，32 项场景）
- 2026-07-27: 完成错误上报系统代码评审（25 个问题，4 个 P0 级安全漏洞）

## 技术备忘
- BitBlt 从屏幕 DC 捕获可获取 Tauri WebView2 动态内容，PrintWindow 不行
- 坐标硬编码不可靠，应从 HTML 源码反推或用 UI Automation
- 配置持久化：monitors 状态存 localStorage，跨重启保留
- 错误上报系统架构：双方案（自建服务 + Sentry）+ Cloudflare Worker 免费部署
- **安全要点**：Web UI 渲染用户数据时所有字段必须 escapeHtml，不能只转义 error_message
- **安全要点**：上报端点必须加 API Key 认证，不能裸奔
- **体积优化**：sentry 依赖应做 feature gate，避免无条件编译进 exe

## 待办
- [ ] 修复 P0 级安全问题（XSS + 无认证 + .gitignore + URL 硬编码）
- [ ] 统一哈希算法为 SHA-256
- [ ] sentry 依赖 feature gate
- [ ] test_error_report 加 #[cfg(debug_assertions)]
- [ ] error_details 清理机制
