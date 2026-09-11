# 自建错误收集服务安装指南

## 系统要求

- Node.js 14+ (推荐 18 LTS)
- npm 或 yarn
- 约 100MB 磁盘空间（SQLite 数据库）

## 快速安装

### 1. 安装依赖

```bash
cd server
npm install
```

### 2. 启动服务

```bash
# 生产环境
npm start

# 开发环境（自动重启）
npm run dev
```

### 3. 验证服务

访问 http://localhost:3000 查看 Web 界面

## 配置应用程序

### 环境变量

**服务端**（`error-server.js` / Cloudflare Worker）：

```bash
# 上报接口鉴权 Key（必需，公网部署尤其重要）
# 生成：node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
set ERROR_API_KEY=<随机串>

# 每 IP 每分钟请求上限（仅 node 版，可选，默认 60）
set RATE_LIMIT_PER_MIN=60
```

> **行为说明（fail-safe）**：
> - 设置了 `ERROR_API_KEY` → 所有接口必须带 `X-API-Key` 且匹配，否则 401；
> - **未设置** → node 版只接受来自本机（127.0.0.1/::1）的请求，远程一律 401；
>   Cloudflare Worker 版则直接 401（公网没有"仅本机"退路）。
>
> 也就是说：**忘配 key 不会裸奔**，但公网部署会因此收不到上报 —— 请务必配置。

**客户端**（构建 Tauri 应用前设置）：

```bash
# Windows (CMD)
set ERROR_SERVER_URL=http://localhost:3000
set ERROR_API_KEY=<与服务端相同的随机串>

# Windows (PowerShell)
$env:ERROR_SERVER_URL="http://localhost:3000"
$env:ERROR_API_KEY="<与服务端相同的随机串>"

# Linux/Mac
export ERROR_SERVER_URL=http://localhost:3000
export ERROR_API_KEY=<与服务端相同的随机串>
```

### 构建应用

```bash
cargo build --release
```

## 功能说明

### API 接口

#### 上报错误
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

#### 查询错误列表
```
GET /api/errors
```

#### 查询统计信息
```
GET /api/stats
```

### Web 界面

访问 http://localhost:3000 可以：
- 查看所有错误记录
- 查看错误统计信息
- 查看错误详情

## 生产部署

### 使用 PM2 守护进程

```bash
npm install -g pm2
pm2 start error-server.js --name error-server
pm2 save
pm2 startup
```

### 使用 systemd (Linux)

创建 `/etc/systemd/system/error-server.service`:

```ini
[Unit]
Description=Seahi Serial Error Server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/path/to/server
ExecStart=/usr/bin/node error-server.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

启用服务：
```bash
sudo systemctl enable error-server
sudo systemctl start error-server
```

### 使用 Docker

创建 `Dockerfile`:

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["node", "error-server.js"]
```

构建并运行：
```bash
docker build -t error-server .
docker run -d -p 3000:3000 --name error-server error-server
```

## 数据库管理

### 数据库位置

SQLite 数据库文件位于：`server/errors.db`

### 备份数据库

```bash
cp errors.db errors.db.backup
```

### 清理旧数据

```sql
-- 删除 30 天前的详细记录
DELETE FROM error_details WHERE created_at < datetime('now', '-30 days');

-- 清理无详细记录的错误
DELETE FROM errors WHERE id NOT IN (SELECT DISTINCT error_id FROM error_details);
```

## 故障排除

### 端口被占用

```bash
# 查找占用端口的进程
netstat -ano | findstr :3000

# 或使用 PowerShell
Get-Process -Id (Get-NetTCPConnection -LocalPort 3000).OwningProcess

# 终止进程
taskkill /PID <进程ID> /F
```

### 数据库锁定

如果遇到数据库锁定错误：

```bash
# 重启服务
pm2 restart error-server

# 或删除数据库重新开始
rm errors.db
```

### 权限问题

确保 Node.js 有权限写入数据库文件：

```bash
# Linux/Mac
chmod 666 errors.db
chown www-data:www-data errors.db
```

## 监控

### 健康检查

```bash
curl http://localhost:3000/api/stats
```

### 日志查看

```bash
# PM2 日志
pm2 logs error-server

# Docker 日志
docker logs -f error-server
```

## 安全建议

1. **必须设置 `ERROR_API_KEY`**：接口已内置鉴权（见「环境变量」），未设置时 node 版只允许本机访问、
   Worker 版直接拒绝。公网部署前请确认已配置，否则收不到任何上报。
2. **查询接口也要保护**：`GET /api/errors`、`/api/stats`、`/` 会暴露错误上下文（含本地路径、堆栈），
   生产环境建议再加一层反代 Basic Auth 或仅内网开放。
3. **限制访问**：在生产环境中，限制只允许应用服务器访问
4. **启用 HTTPS**：使用 Nginx 反向代理并启用 HTTPS
5. **数据清理**：定期清理旧数据，避免数据库过大
6. **备份策略**：定期备份数据库文件

> 已内置：`/report` 与查询接口共用鉴权；每 IP 令牌桶限速（默认 60/分钟，返回 429）；
> `app_version/os/error/stack/context` 分别截断为 64/128/8K/32K/16K 字节，防超长字段灌库。

## 性能优化

### SQLite 优化

在 `error-server.js` 中添加：

```javascript
db.run('PRAGMA journal_mode=WAL');
db.run('PRAGMA synchronous=NORMAL');
```

### 内存缓存

对于高并发场景，可以添加内存缓存：

```javascript
const cache = new Map();
const CACHE_TTL = 60000; // 1 分钟

function getCachedErrors() {
  const cached = cache.get('errors');
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return cached.data;
  }
  // 从数据库获取...
}
```
