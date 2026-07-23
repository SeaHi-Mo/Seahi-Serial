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

在构建 Tauri 应用前设置：

```bash
# Windows (CMD)
set ERROR_SERVER_URL=http://localhost:3000

# Windows (PowerShell)
$env:ERROR_SERVER_URL="http://localhost:3000"

# Linux/Mac
export ERROR_SERVER_URL=http://localhost:3000
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

1. **限制访问**：在生产环境中，限制只允许应用服务器访问
2. **启用 HTTPS**：使用 Nginx 反向代理并启用 HTTPS
3. **数据清理**：定期清理旧数据，避免数据库过大
4. **备份策略**：定期备份数据库文件

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
