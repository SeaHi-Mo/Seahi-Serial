# Cloudflare Workers 错误收集服务

## 快速部署

### 1. 安装 Wrangler CLI

```bash
npm install -g wrangler
```

### 2. 登录 Cloudflare

```bash
wrangler login
```

### 3. 创建 D1 数据库

```bash
wrangler d1 create seahi-errors
```

输出会显示 `database_id`，复制它并更新 `wrangler.toml`。

### 4. 初始化数据库

```bash
wrangler d1 execute seahi-errors --file=./schema.sql
```

### 5. 部署 Worker

```bash
wrangler deploy
```

部署成功后会显示 Worker URL，类似：
```
https://seahi-error-server.your-subdomain.workers.dev
```

### 6. 配置自定义域名（可选）

1. 登录 Cloudflare Dashboard
2. 进入 Workers & Pages
3. 选择你的 Worker
4. Settings → Triggers → Custom Domains
5. 添加域名，如 `error.your-domain.com`

## 配置 Tauri 应用

### 环境变量

```bash
# Windows
set ERROR_SERVER_URL=https://seahi-error-server.your-subdomain.workers.dev

# 构建应用
cargo build --release
```

### 或在 .env 文件中配置

```
ERROR_SERVER_URL=https://seahi-error-server.your-subdomain.workers.dev
```

## API 接口

### 上报错误

```
POST /report
Content-Type: application/json

{
  "app_version": "0.2.1",
  "os": "windows",
  "error": "错误消息",
  "stack": "堆栈信息",
  "context": "上下文"
}
```

### 查询错误列表

```
GET /api/errors
```

### 查询统计信息

```
GET /api/stats
```

### Web 界面

访问 Worker URL 查看错误列表。

## 成本

- **免费额度**：
  - 100,000 请求/天
  - 10ms CPU 时间/请求
  - D1: 5GB 存储，1000 万行读取/天

- **对于串口调试器**：完全免费（除非用户量极大）

## 监控

### 查看日志

```bash
wrangler tail
```

### 查看 D1 数据

```bash
wrangler d1 execute seahi-errors --command "SELECT * FROM errors LIMIT 10"
```

## 故障排除

### 常见错误

1. **CORS 错误**
   - Worker 已配置 CORS，确保请求包含正确的 headers

2. **数据库错误**
   - 检查 `wrangler.toml` 中的 `database_id` 是否正确
   - 重新执行 `wrangler d1 execute` 初始化数据库

3. **部署失败**
   - 检查 `wrangler login` 是否成功
   - 检查账号是否有 Workers 权限

### 调试

```bash
# 本地开发
wrangler dev

# 查看实时日志
wrangler tail
```

## 安全建议

### 1. 添加 API 密钥验证

在 `worker.js` 中添加：

```javascript
const API_KEY = env.API_KEY || 'your-secret-key';

async function handleReport(request, env, corsHeaders) {
  // 验证 API 密钥
  const auth = request.headers.get('Authorization');
  if (auth !== `Bearer ${API_KEY}`) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: corsHeaders }
    );
  }
  
  // ... 其余代码
}
```

在 `wrangler.toml` 中配置：

```toml
[vars]
API_KEY = "your-secret-key"
```

### 2. 限制上报频率

```javascript
// 简单的频率限制
const rateLimit = new Map();

async function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60000; // 1 分钟
  const maxRequests = 100;
  
  const requests = rateLimit.get(ip) || [];
  const recentRequests = requests.filter(t => now - t < windowMs);
  
  if (recentRequests.length >= maxRequests) {
    return false;
  }
  
  recentRequests.push(now);
  rateLimit.set(ip, recentRequests);
  return true;
}
```

## 数据导出

### 导出为 CSV

```bash
wrangler d1 execute seahi-errors --command "SELECT * FROM errors" --output errors.csv
```

### 备份数据库

```bash
wrangler d1 export seahi-errors --output backup.sql
```
