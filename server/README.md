# Seahi Serial 错误上报系统

## 概述

本项目提供两种错误上报方案：

### 方案 1：自建错误收集服务（推荐）
- 完全自主可控，无第三方依赖
- 使用 SQLite 存储，轻量级
- 提供 Web 界面查看错误
- 支持错误分组和统计

### 方案 2：Sentry + GitHub Webhook
- 使用 Sentry 的错误聚合功能
- 自动创建 GitHub Issue
- 适合需要高级错误分析的场景

## 快速开始（自建服务）

### 1. 启动错误收集服务

```bash
cd server
npm install
node error-server.js
```

服务启动后：
- Web 界面：http://localhost:3000
- 上报接口：http://localhost:3000/report
- API 接口：http://localhost:3000/api/errors

### 2. 配置应用程序

在构建时设置环境变量：

```bash
# Windows
set ERROR_SERVER_URL=http://localhost:3000
cargo build --release

# 或使用 .env 文件
```

### 3. 测试上报

```bash
curl -X POST http://localhost:3000/report \
  -H "Content-Type: application/json" \
  -d '{
    "app_version": "0.2.1",
    "os": "windows",
    "error": "Test error message",
    "stack": "at main.rs:100",
    "context": "test"
  }'
```

## 快速开始（Sentry + GitHub）

### 1. 创建 Sentry 账号

1. 访问 https://sentry.io/signup
2. 创建免费账号（每月 5,000 个事件）
3. 创建新项目，选择 "Rust"
4. 获取 DSN（格式：`https://xxx@sentry.io/xxx`）

### 2. 配置 GitHub Token

1. 访问 https://github.com/settings/tokens
2. 生成新 Token，权限：`repo`（完整仓库访问）
3. 记录 Token

### 3. 部署 Webhook 服务

```bash
cd server
npm install
node sentry-webhook.js
```

### 4. 配置 Sentry Webhook

1. 登录 Sentry
2. 进入项目设置 -> Integrations -> Internal Integrations
3. 创建新的 Internal Integration
4. 设置 Webhook URL: `https://your-server.com/sentry-webhook`
5. 选择触发事件：`error`, `issue`

### 5. 配置应用程序

在构建时设置环境变量：

```bash
# Windows
set SENTRY_DSN=https://your-dsn@sentry.io/project-id
cargo build --release

# 或使用 .env 文件（需要 dotenv 支持）
```

## 架构

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Tauri 应用     │────▶│   Sentry     │────▶│  Webhook 服务   │
│  (Rust + 前端)  │     │  (错误收集)   │     │  (Node.js)      │
└─────────────────┘     └──────────────┘     └────────┬────────┘
                                                      │
                                                      ▼
                                              ┌─────────────────┐
                                              │  GitHub Issues  │
                                              │  (自动创建)      │
                                              └─────────────────┘
```

## 功能特性

### Rust 后端

- **自动 Panic 捕获**: 使用 `sentry-panic` 捕获所有 panic
- **上下文信息**: 自动添加应用版本、操作系统、设备信息
- **离线支持**: 错误缓存到本地，网络恢复后上报
- **性能监控**: 自动收集系统指标

### Webhook 服务

- **自动去重**: 避免重复创建相同错误的 Issue
- **智能标题**: 截断长错误消息，保持标题清晰
- **详细报告**: 包含堆栈跟踪、操作记录、环境信息
- **错误标签**: 自动添加 `bug`, `auto-reported` 标签

## 配置选项

### 环境变量

| 变量 | 说明 | 必需 |
|------|------|------|
| `SENTRY_DSN` | Sentry 项目 DSN | 是 |
| `GITHUB_TOKEN` | GitHub Personal Access Token | 是 |
| `GITHUB_REPO` | GitHub 仓库（格式：owner/repo） | 是 |
| `PORT` | Webhook 服务端口 | 否（默认：3000） |

### Sentry 配置

在 `main.rs` 中可以自定义：

```rust
sentry::init((
    dsn.as_str(),
    sentry::ClientOptions {
        release: sentry::release_name!(),
        environment: Some("production".into()),
        // 启用追踪
        traces_sample_rate: 0.1,
        // 启用调试
        debug: cfg!(debug_assertions),
        ..Default::default()
    },
));
```

## 测试

### 1. 测试 Sentry 连接

```rust
// 在代码中添加测试错误
sentry::capture_message("测试错误消息", sentry::Level::Info);
```

### 2. 测试 Webhook

```bash
curl -X POST http://localhost:3000/sentry-webhook \
  -H "Content-Type: application/json" \
  -d '{
    "event": {
      "id": "test-123",
      "message": "Test error",
      "level": "error",
      "timestamp": "2024-01-01T00:00:00Z"
    }
  }'
```

## 生产部署建议

1. **使用 HTTPS**: Webhook URL 必须是 HTTPS
2. **添加签名验证**: 验证 Sentry Webhook 签名
3. **监控服务**: 使用 PM2 或 systemd 管理进程
4. **日志记录**: 记录所有 webhook 事件
5. **错误处理**: 实现重试机制

### Nginx 配置示例

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;
    
    location /sentry-webhook {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## 故障排除

### 常见问题

1. **Webhook 未触发**
   - 检查 Sentry Webhook 配置
   - 验证 URL 是否可访问
   - 查看 Sentry Webhook 日志

2. **Issue 创建失败**
   - 检查 GitHub Token 权限
   - 验证仓库名称格式
   - 查看 Webhook 服务日志

3. **错误未上报**
   - 检查 SENTRY_DSN 环境变量
   - 确认 Release 模式构建
   - 查看本地日志文件

## 隐私考虑

- 不上报敏感数据（如串口内容）
- 用户可禁用错误上报
- 实现数据匿名化
- 遵守 GDPR 规范

## 成本

- **Sentry 免费版**: 5,000 事件/月
- **GitHub**: 无额外成本
- **服务器**: 低流量下几乎无成本

## 扩展功能

### 可选增强

1. **用户反馈**: 在 Issue 中添加用户描述
2. **附件支持**: 附加日志文件
3. **优先级自动设置**: 根据错误严重程度设置
4. **自动关闭**: 相关 PR 合并后自动关闭 Issue
5. **Slack 通知**: 错误发生时发送 Slack 通知
