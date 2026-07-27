## v0.2.4

### 🔒 安全修复

- **XSS 漏洞修复** — 错误管理 Web UI 所有用户可控字段（`app_version`、`os`、`count`）过 `escapeHtml()` 转义
- **API Key 认证** — 错误上报 `/report` 端点支持 `X-API-Key` 验证，未配置时向后兼容放行
- **CORS 收紧** — `/api/*` 接口 CORS 限制为配置域名，不再通配 `*`
- **Sentry Webhook 签名验证** — 实现 HMAC-SHA256 签名校验
- **Body 大小限制** — 错误上报接口限制 1MB，防止 DoS 攻击
- **Debug 模式隔离** — 开发构建不再往生产错误服务器上报
- **敏感文件忽略** — `.gitignore` 添加 `.env`、`errors.db`

### ✨ 新增

- **WSL 多监视器支持** — WSL 端口映射页面支持打开多个串口监视器，共享设备列表
- **上下文感知"打开额外监视器"** — 按钮根据当前页面自动判断：主监视器页面创建主监视器，WSL 页面创建 WSL 监视器
- **前端错误自动上报** — JavaScript 未捕获错误通过 `window.onerror` + `unhandledrejection` 自动上报到错误服务器

### 🔧 改进

- 错误上报改为 channel + 单线程消费，避免每次错误 spawn 新线程
- 哈希算法统一为 SHA-256，与 Cloudflare Worker 版本一致
- `sentry` 依赖改为 optional feature gate，默认不编译，减小 exe 体积
- `error_details` 表限制每个错误最多 100 条详情记录
- 错误去重 Map 添加 24 小时 TTL 过期，防止内存泄漏
- SQLite 数据库路径改为绝对路径，避免 CWD 依赖
- 前端错误上报附加监视器连接状态，帮助复现问题

### 🐛 修复

- 修复 WSL 设备列表 `renderWslDeviceList` 中 `d.vidpid` 未定义导致页面崩溃
- 修复自定义 tooltip 被屏幕边缘截断的问题
- 修复 `test_error_report` 命令在 Release 构建中可被调用

### 📦 下载

| 文件 | 说明 |
|------|------|
| `Seahi-Serial-Setup-{VERSION}.exe` | Inno Setup 安装程序（推荐） |
| `Seahi.Serial_{VERSION}_x64_en-US.msi` | MSI 安装包 |

---

## v0.2.2

### ✨ 新增

- **错误上报系统** — 应用异常自动上报到云端，支持 Sentry 和自建服务两种后端
- **Cloudflare Workers 错误收集** — 免费全球部署的错误收集服务，带 Web 管理界面
- **Panic Hook 捕获** — Rust panic 自动上报，包含线程、堆栈、位置信息
- **WSL 路径转换修复** — Windows Terminal 启动 WSL 时正确转换路径格式

### 🔧 改进

- 错误上报静默执行，不影响用户体验
- 错误自动去重，相同错误只计数不重复存储
- 本地日志始终写入，离线时可追溯

### 📦 下载

| 文件 | 说明 |
|------|------|
| `Seahi-Serial-Setup-{VERSION}.exe` | Inno Setup 安装程序（推荐） |
| `Seahi.Serial_{VERSION}_x64_en-US.msi` | MSI 安装包 |

---

## v0.2.0

### ✨ 新增

- **自动化工作流** — 为每个监视器配置自定义规则，收到匹配数据时自动执行响应动作（发送数据、切换 DTR/RTS、保存日志）
- **工作流支持正则表达式** — 条件匹配支持字符串包含、正则表达式、精确字节三种模式
- **WSL 监视器工作流** — WSL 端口映射监视器同步支持自动化工作流规则
- **额外监视器默认展开高级设置** — 新建监视器自动显示数据位、停止位、校验位、DTR/RTS、日志目录等设置
- **添加监视器自动扩展窗口** — 窗口宽度不足时自动调整以容纳新监视器

### 🔧 改进

- **编辑模式不再阻断数据刷新** — 点击输出区域编辑时，数据照常追加显示，自动滚动临时关闭，退出编辑后恢复
- **端口下拉框缩窄 28px** — 主监视器端口选择器宽度 280→252px，节省工具栏空间
- **最小窗口宽度提升至 1047px** — 防止工具栏在窄窗口下换行
- **工作流架构优化** — 读写线程分离，正则编译缓存，减少锁竞争

### 🐛 修复

- 修复点击输出区域进入编辑模式后串口数据停止刷新的问题
- 修复 Rust 编译警告（移除 PortReader 中未使用的 regex_cache 字段）

### 📦 下载

| 文件 | 说明 |
|------|------|
| `Seahi-Serial-Setup-{VERSION}.exe` | Inno Setup 安装程序（推荐） |
| `Seahi.Serial_{VERSION}_x64_en-US.msi` | MSI 安装包 |
