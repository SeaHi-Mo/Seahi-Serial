/**
 * Sentry Webhook -> GitHub Issue 自动转换服务
 * 
 * 使用方法：
 * 1. 在 Sentry 项目设置中配置 Webhook URL: https://your-server.com/sentry-webhook
 * 2. 设置环境变量：GITHUB_TOKEN, GITHUB_REPO
 * 3. 运行：node sentry-webhook.js
 */

const http = require('http');
const crypto = require('crypto');
const https = require('https');

const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO; // 格式: owner/repo

if (!GITHUB_TOKEN || !GITHUB_REPO) {
  console.error('请设置 GITHUB_TOKEN 和 GITHUB_REPO 环境变量');
  process.exit(1);
}

// 存储已创建的 Issue（避免重复，带 TTL 过期）
const createdIssues = new Map();
const ISSUE_TTL = 24 * 60 * 60 * 1000; // 24小时

function checkAndSetIssue(key, value) {
  const now = Date.now();
  // 清理过期项
  for (const [k, v] of createdIssues) {
    if (now - v.time > ISSUE_TTL) createdIssues.delete(k);
  }
  if (createdIssues.has(key)) return true;
  createdIssues.set(key, { number: value, time: now });
  return false;
}

async function createGitHubIssue(title, body, labels = ['bug', 'auto-reported']) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/issues`;
  
  const payload = JSON.stringify({
    title,
    body,
    labels
  });

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Seahi-Serial-Webhook'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 201) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`GitHub API error: ${res.statusCode} - ${data}`));
        }
      });
    });
    
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function formatSentryEvent(event) {
  const title = event.message || event.title || 'Unknown Error';
  const culprit = event.culprit || '';
  const url = event.web_url || '';
  const level = event.level || 'error';
  const timestamp = event.timestamp || new Date().toISOString();
  
  // 提取错误详情
  let errorDetail = '';
  if (event.exception && event.exception.values) {
    const exc = event.exception.values[0];
    if (exc) {
      errorDetail = `
## 异常详情

\`\`\`
类型: ${exc.type || 'Unknown'}
值: ${exc.value || 'No value'}
\`\`\`

### 堆栈跟踪

\`\`\`
${exc.stacktrace?.frames?.map(f => `${f.filename}:${f.lineno} - ${f.function || 'anonymous'}`).join('\n') || '无堆栈信息'}
\`\`\`
`;
    }
  }

  // 提取面包屑
  let breadcrumbs = '';
  if (event.breadcrumbs && event.breadcrumbs.values) {
    breadcrumbs = `
## 操作记录

${event.breadcrumbs.values.slice(-10).map(b => `- [${b.category}] ${b.message}`).join('\n')}
`;
  }

  // 提取标签
  const tags = event.tags || {};
  const tagsList = Object.entries(tags).map(([k, v]) => `- ${k}: ${v}`).join('\n');

  return `
## Sentry 错误报告

- **级别**: ${level}
- **时间**: ${timestamp}
- **Sentry 链接**: ${url}
- **触发位置**: ${culprit}

${errorDetail}

${breadcrumbs}

## 环境信息

${tagsList || '无标签信息'}

---
*此 Issue 由 Sentry Webhook 自动创建*
`.trim();
}

async function handleWebhook(req, res) {
  let body = '';
  let size = 0;
  const MAX_BODY = 1024 * 1024; // 1MB
  
  req.on('data', chunk => {
    size += chunk.length;
    if (size > MAX_BODY) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Body too large' }));
      req.destroy();
      return;
    }
    body += chunk;
  });
  
  req.on('end', async () => {
    try {
      const payload = JSON.parse(body);
      
      // 验证 Webhook 签名（HMAC-SHA256）
      const webhookSecret = process.env.SENTRY_WEBHOOK_SECRET;
      if (webhookSecret) {
        const signature = req.headers['sentry-hook-signature'];
        if (!signature) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing signature' }));
          return;
        }
        const expected = crypto.createHmac('sha256', webhookSecret).update(body).digest('hex');
        if (signature !== expected) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid signature' }));
          return;
        }
      }
      
      // Sentry Webhook 格式
      if (payload.event) {
        const event = payload.event;
        const issueKey = event.id || event.event_id;
        
        // 检查是否已创建（带 TTL 过期）
        if (checkAndSetIssue(issueKey, 0)) {
          console.log(`Issue already created for event ${issueKey}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ignored', reason: 'duplicate' }));
          return;
        }
        
        // 限制标题长度
        let title = event.message || event.title || 'Unknown Error';
        if (title.length > 100) {
          title = title.substring(0, 97) + '...';
        }
        title = `[Sentry] ${title}`;
        
        const body = formatSentryEvent(event);
        
        const issue = await createGitHubIssue(title, body);
        // 更新 Issue 编号
        createdIssues.set(issueKey, { number: issue.number, time: Date.now() });
        
        console.log(`Created GitHub Issue #${issue.number} for event ${issueKey}`);
        
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          status: 'created', 
          issue_number: issue.number,
          issue_url: issue.html_url 
        }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid payload format' }));
      }
    } catch (error) {
      console.error('Webhook error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
}

const server = http.createServer(handleWebhook);

server.listen(PORT, () => {
  console.log(`Sentry Webhook server running on port ${PORT}`);
  console.log(`Webhook URL: http://localhost:${PORT}/sentry-webhook`);
});
