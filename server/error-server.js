/**
 * 简单自建错误收集服务
 * 
 * 功能：
 * - 接收应用错误报告
 * - 存储到 SQLite 数据库
 * - 提供 Web 界面查看、搜索、筛选错误
 * - 支持错误分组和统计
 * 
 * 使用方法：
 * 1. npm install sqlite3
 * 2. node error-server.js
 * 3. 访问 http://localhost:3000 查看错误
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// SQLite 数据库
let db;
try {
  const sqlite3 = require('sqlite3').verbose();
  db = new sqlite3.Database('./errors.db');
  
  db.run(`CREATE TABLE IF NOT EXISTS errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_version TEXT,
    os TEXT,
    error_hash TEXT,
    error_message TEXT,
    stack_trace TEXT,
    context TEXT,
    count INTEGER DEFAULT 1,
    first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS error_details (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    error_id INTEGER,
    app_version TEXT,
    os TEXT,
    error_message TEXT,
    stack_trace TEXT,
    context TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (error_id) REFERENCES errors(id)
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_errors_hash ON errors(error_hash)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_errors_last_seen ON errors(last_seen)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_error_details_error_id ON error_details(error_id)`);
  
  console.log('SQLite 数据库初始化成功');
} catch (e) {
  console.error('SQLite 未安装，使用内存存储');
  console.error('安装命令：npm install sqlite3');
  
  db = {
    _errors: [],
    _nextId: 1,
    run: function(sql, params, callback) {
      if (sql.includes('INSERT INTO errors')) {
        const error = {
          id: this._nextId++,
          app_version: params[0],
          os: params[1],
          error_hash: params[2],
          error_message: params[3],
          stack_trace: params[4],
          context: params[5],
          count: 1,
          first_seen: new Date().toISOString(),
          last_seen: new Date().toISOString()
        };
        this._errors.push(error);
        if (callback) callback(null);
      } else if (sql.includes('INSERT INTO error_details')) {
        if (callback) callback(null);
      } else if (sql.includes('UPDATE errors')) {
        const id = params[params.length - 1];
        const e = this._errors.find(e => e.id === id);
        if (e) { e.count++; e.last_seen = new Date().toISOString(); }
        if (callback) callback(null);
      }
    },
    get: function(sql, params, callback) {
      if (sql.includes('error_hash')) {
        const error = this._errors.find(e => e.error_hash === params[0]);
        if (callback) callback(null, error || null);
      } else if (sql.includes('FROM errors WHERE id')) {
        const error = this._errors.find(e => e.id === params[0]);
        if (callback) callback(null, error || null);
      } else {
        if (callback) callback(null, null);
      }
    },
    all: function(sql, params, callback) {
      let results = [...this._errors];
      // 简单的 WHERE 条件解析
      if (sql.includes('error_id = ?')) {
        const eid = params[0];
        results = [{ error_id: eid, app_version: 'unknown', os: 'unknown', error_message: 'memory mode', stack_trace: '', context: '', created_at: new Date().toISOString() }];
      } else {
        results.sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen));
        if (sql.includes('LIMIT')) {
          const limitMatch = sql.match(/LIMIT\s+(\d+)/);
          if (limitMatch) results = results.slice(0, parseInt(limitMatch[1]));
        }
      }
      if (callback) callback(null, results);
    }
  };
}

const PORT = process.env.PORT || 3000;

function generateHash(error, stack) {
  const crypto = require('crypto');
  return crypto.createHash('md5').update(`${error}\n${stack || ''}`).digest('hex');
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
  });
}

function parseQuery(queryString) {
  const params = {};
  if (!queryString) return params;
  new URLSearchParams(queryString).forEach((v, k) => { params[k] = v; });
  return params;
}

// 处理错误上报
async function handleReport(req, res) {
  try {
    const data = await parseBody(req);
    const {
      app_version = 'unknown',
      os = 'unknown',
      error = 'Unknown error',
      stack = '',
      context = ''
    } = data;
    
    const errorHash = generateHash(error, stack);
    
    db.get('SELECT id, count FROM errors WHERE error_hash = ?', [errorHash], (err, existing) => {
      if (existing) {
        db.run('UPDATE errors SET count = count + 1, last_seen = CURRENT_TIMESTAMP WHERE id = ?', [existing.id]);
        db.run('INSERT INTO error_details (error_id, app_version, os, error_message, stack_trace, context) VALUES (?, ?, ?, ?, ?, ?)',
          [existing.id, app_version, os, error, stack, context]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'updated', error_id: existing.id, count: existing.count + 1 }));
      } else {
        db.run(
          'INSERT INTO errors (app_version, os, error_hash, error_message, stack_trace, context) VALUES (?, ?, ?, ?, ?, ?)',
          [app_version, os, errorHash, error, stack, context],
          function(err) {
            if (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err.message }));
              return;
            }
            const errorId = this.lastID;
            db.run('INSERT INTO error_details (error_id, app_version, os, error_message, stack_trace, context) VALUES (?, ?, ?, ?, ?, ?)',
              [errorId, app_version, os, error, stack, context]);
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'created', error_id: errorId }));
          }
        );
      }
    });
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// 处理错误列表查询（支持搜索、筛选、分页）
function handleList(req, res, query) {
  const conditions = [];
  const params = [];

  if (query.search) {
    conditions.push('(error_message LIKE ? OR stack_trace LIKE ? OR context LIKE ?)');
    const term = `%${query.search}%`;
    params.push(term, term, term);
  }
  if (query.version) {
    conditions.push('app_version = ?');
    params.push(query.version);
  }
  if (query.os) {
    conditions.push('os = ?');
    params.push(query.os);
  }
  if (query.date_from) {
    conditions.push('last_seen >= ?');
    params.push(query.date_from);
  }
  if (query.date_to) {
    conditions.push('last_seen <= ?');
    params.push(query.date_to);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20));
  const offset = (page - 1) * limit;

  // 获取总数
  db.get(`SELECT COUNT(*) as total FROM errors ${where}`, params, (err, countRow) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
    const total = countRow ? countRow.total : 0;

    // 获取当前页数据
    db.all(
      `SELECT * FROM errors ${where} ORDER BY last_seen DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
      (err, rows) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: rows || [],
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit)
        }));
      }
    );
  });
}

// 处理错误详情
function handleErrorDetail(req, res, errorId) {
  db.get('SELECT * FROM errors WHERE id = ?', [errorId], (err, error) => {
    if (err || !error) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    db.all('SELECT * FROM error_details WHERE error_id = ? ORDER BY created_at DESC', [errorId], (err, details) => {
      if (err) details = [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...error, details: details || [] }));
    });
  });
}

// 获取筛选选项（版本列表、OS 列表）
function handleFilters(req, res) {
  db.all('SELECT DISTINCT app_version FROM errors WHERE app_version IS NOT NULL ORDER BY app_version', [], (err, versions) => {
    db.all('SELECT DISTINCT os FROM errors WHERE os IS NOT NULL ORDER BY os', [], (err2, osList) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        versions: (versions || []).map(r => r.app_version),
        osList: (osList || []).map(r => r.os)
      }));
    });
  });
}

// 处理统计
function handleStats(req, res) {
  db.get(`
    SELECT 
      COUNT(*) as total_errors,
      SUM(count) as total_reports,
      COUNT(DISTINCT app_version) as versions,
      MIN(first_seen) as first_seen,
      MAX(last_seen) as last_seen
    FROM errors
  `, [], (err, stats) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats || {}));
  });
}

// Web 界面
function handleWebUI(req, res) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Seahi Serial 错误收集</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', -apple-system, sans-serif; background: #1e1e1e; color: #d4d4d4; min-height: 100vh; }
    .header { background: #252526; border-bottom: 1px solid #3c3c3c; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; }
    .header h1 { font-size: 18px; font-weight: 600; color: #e0e0e0; }
    .header .refresh-btn { background: #0e639c; color: #fff; border: none; padding: 6px 16px; border-radius: 4px; cursor: pointer; font-size: 13px; }
    .header .refresh-btn:hover { background: #1177bb; }

    .stats-bar { display: flex; gap: 16px; padding: 16px 24px; background: #252526; border-bottom: 1px solid #3c3c3c; }
    .stat-card { flex: 1; background: #2d2d2d; border: 1px solid #3c3c3c; border-radius: 6px; padding: 12px 16px; }
    .stat-value { font-size: 28px; font-weight: 700; color: #569cd6; }
    .stat-label { font-size: 12px; color: #808080; margin-top: 4px; }

    .toolbar { display: flex; gap: 12px; padding: 12px 24px; background: #252526; border-bottom: 1px solid #3c3c3c; flex-wrap: wrap; align-items: center; }
    .toolbar input, .toolbar select { background: #3c3c3c; color: #d4d4d4; border: 1px solid #555; border-radius: 4px; padding: 6px 10px; font-size: 13px; }
    .toolbar input { width: 280px; }
    .toolbar select { min-width: 120px; }
    .toolbar .search-btn { background: #0e639c; color: #fff; border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 13px; }
    .toolbar .search-btn:hover { background: #1177bb; }
    .toolbar .reset-btn { background: transparent; color: #808080; border: 1px solid #555; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 13px; }
    .toolbar .reset-btn:hover { color: #d4d4d4; border-color: #888; }

    .content { padding: 0 24px 24px; }
    table { width: 100%; border-collapse: collapse; margin-top: 0; }
    th { background: #252526; color: #808080; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; padding: 10px 12px; text-align: left; border-bottom: 1px solid #3c3c3c; position: sticky; top: 0; }
    td { padding: 10px 12px; border-bottom: 1px solid #2d2d2d; font-size: 13px; vertical-align: top; }
    tr:hover td { background: #2a2d2e; cursor: pointer; }
    .error-msg { max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #d4d4d4; }
    .error-msg:hover { color: #fff; }
    .count-badge { background: #c586c0; color: #fff; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
    .count-badge.high { background: #f44747; }
    .count-badge.medium { background: #cca700; }
    .os-tag { background: #3c3c3c; padding: 2px 8px; border-radius: 4px; font-size: 12px; }
    .version-tag { color: #569cd6; }
    .time-col { color: #808080; font-size: 12px; white-space: nowrap; }
    .empty-state { text-align: center; padding: 60px 20px; color: #808080; }
    .empty-state .icon { font-size: 48px; margin-bottom: 16px; }

    .pagination { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 20px 0; }
    .pagination button { background: #3c3c3c; color: #d4d4d4; border: 1px solid #555; border-radius: 4px; padding: 6px 12px; cursor: pointer; font-size: 13px; }
    .pagination button:hover:not(:disabled) { background: #505050; }
    .pagination button:disabled { opacity: 0.4; cursor: default; }
    .pagination button.active { background: #0e639c; border-color: #0e639c; color: #fff; }
    .pagination .info { color: #808080; font-size: 13px; }

    .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 100; justify-content: center; align-items: flex-start; padding-top: 40px; }
    .modal-overlay.active { display: flex; }
    .modal { background: #252526; border: 1px solid #3c3c3c; border-radius: 8px; width: 90%; max-width: 900px; max-height: 85vh; overflow-y: auto; }
    .modal-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #3c3c3c; position: sticky; top: 0; background: #252526; z-index: 1; }
    .modal-header h2 { font-size: 16px; color: #e0e0e0; }
    .modal-close { background: none; border: none; color: #808080; font-size: 24px; cursor: pointer; padding: 4px 8px; }
    .modal-close:hover { color: #fff; }
    .modal-body { padding: 20px; }
    .detail-section { margin-bottom: 20px; }
    .detail-section h3 { font-size: 13px; color: #569cd6; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid #3c3c3c; }
    .detail-row { display: flex; gap: 12px; margin-bottom: 8px; font-size: 13px; }
    .detail-label { color: #808080; min-width: 100px; }
    .detail-value { color: #d4d4d4; flex: 1; word-break: break-all; }
    .stack-trace { background: #1e1e1e; border: 1px solid #3c3c3c; border-radius: 4px; padding: 12px; font-family: 'Cascadia Code', 'Fira Code', monospace; font-size: 12px; white-space: pre-wrap; word-break: break-all; color: #d4d4d4; max-height: 300px; overflow-y: auto; }
    .context-text { background: #1e1e1e; border: 1px solid #3c3c3c; border-radius: 4px; padding: 12px; font-family: 'Cascadia Code', 'Fira Code', monospace; font-size: 12px; white-space: pre-wrap; word-break: break-all; color: #ce9178; max-height: 200px; overflow-y: auto; }
    .details-list { margin-top: 12px; }
    .detail-item { background: #1e1e1e; border: 1px solid #3c3c3c; border-radius: 4px; padding: 12px; margin-bottom: 8px; }
    .detail-item-header { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 12px; color: #808080; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Seahi Serial 错误收集</h1>
    <button class="refresh-btn" onclick="loadData()">刷新</button>
  </div>

  <div class="stats-bar">
    <div class="stat-card"><div class="stat-value" id="total-errors">-</div><div class="stat-label">不同错误数</div></div>
    <div class="stat-card"><div class="stat-value" id="total-reports">-</div><div class="stat-label">总上报次数</div></div>
    <div class="stat-card"><div class="stat-value" id="versions">-</div><div class="stat-label">版本数</div></div>
    <div class="stat-card"><div class="stat-value" id="first-seen">-</div><div class="stat-label">首次上报</div></div>
    <div class="stat-card"><div class="stat-value" id="last-seen">-</div><div class="stat-label">最近上报</div></div>
  </div>

  <div class="toolbar">
    <input type="text" id="search" placeholder="搜索错误消息、堆栈、上下文..." onkeydown="if(event.key==='Enter')loadData()">
    <select id="filter-version"><option value="">所有版本</option></select>
    <select id="filter-os"><option value="">所有系统</option></select>
    <input type="date" id="filter-date-from" title="开始日期">
    <input type="date" id="filter-date-to" title="结束日期">
    <button class="search-btn" onclick="loadData()">搜索</button>
    <button class="reset-btn" onclick="resetFilters()">重置</button>
  </div>

  <div class="content">
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>错误消息</th>
          <th>版本</th>
          <th>系统</th>
          <th>次数</th>
          <th>首次上报</th>
          <th>最近上报</th>
        </tr>
      </thead>
      <tbody id="errors"><tr><td colspan="7" class="empty-state">加载中...</td></tr></tbody>
    </table>
    <div class="pagination" id="pagination"></div>
  </div>

  <div class="modal-overlay" id="modal-overlay" onclick="if(event.target===this)closeModal()">
    <div class="modal">
      <div class="modal-header">
        <h2 id="modal-title">错误详情</h2>
        <button class="modal-close" onclick="closeModal()">&times;</button>
      </div>
      <div class="modal-body" id="modal-body"></div>
    </div>
  </div>

<script>
let currentPage = 1;
let currentFilters = {};

function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
function formatDate(s) { if (!s) return '-'; try { return new Date(s).toLocaleString('zh-CN'); } catch(e) { return s; } }
function countClass(n) { return n >= 10 ? 'high' : n >= 3 ? 'medium' : ''; }

async function loadFilters() {
  try {
    const res = await fetch('/api/filters');
    const data = await res.json();
    const vs = document.getElementById('filter-version');
    data.versions.forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v; vs.appendChild(o); });
    const os = document.getElementById('filter-os');
    data.osList.forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v; os.appendChild(o); });
  } catch(e) {}
}

async function loadData(page) {
  currentPage = page || 1;
  currentFilters = {
    search: document.getElementById('search').value,
    version: document.getElementById('filter-version').value,
    os: document.getElementById('filter-os').value,
    date_from: document.getElementById('filter-date-from').value,
    date_to: document.getElementById('filter-date-to').value,
    page: currentPage,
    limit: 20
  };
  const qs = Object.entries(currentFilters).filter(([k,v]) => v).map(([k,v]) => k+'='+encodeURIComponent(v)).join('&');

  try {
    const [statsRes, errorsRes] = await Promise.all([
      fetch('/api/stats'),
      fetch('/api/errors?' + qs)
    ]);
    const stats = await statsRes.json();
    const result = await errorsRes.json();

    document.getElementById('total-errors').textContent = stats.total_errors || 0;
    document.getElementById('total-reports').textContent = stats.total_reports || 0;
    document.getElementById('versions').textContent = stats.versions || 0;
    document.getElementById('first-seen').textContent = stats.first_seen ? formatDate(stats.first_seen).split(' ')[0] : '-';
    document.getElementById('last-seen').textContent = stats.last_seen ? formatDate(stats.last_seen).split(' ')[0] : '-';

    const errors = result.data || [];
    const tbody = document.getElementById('errors');
    if (errors.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state"><div class="icon">&#x1f4e6;</div>暂无错误记录</td></tr>';
    } else {
      tbody.innerHTML = errors.map(e => \\\`
        <tr onclick="showDetail(\\\${e.id})">
          <td>\\\${e.id}</td>
          <td class="error-msg" title="\\\${escapeHtml(e.error_message)}">\\\${escapeHtml(e.error_message)}</td>
          <td><span class="version-tag">\\\${e.app_version || '-'}</span></td>
          <td><span class="os-tag">\\\${e.os || '-'}</span></td>
          <td><span class="count-badge \\\${countClass(e.count)}">\\\${e.count}</span></td>
          <td class="time-col">\\\${formatDate(e.first_seen)}</td>
          <td class="time-col">\\\${formatDate(e.last_seen)}</td>
        </tr>
      \\\`).join('');
    }

    // 分页
    const pg = document.getElementById('pagination');
    const tp = result.totalPages || 1;
    if (tp <= 1) { pg.innerHTML = ''; return; }
    let html = '<button ' + (currentPage<=1?'disabled':'') + ' onclick="loadData('+(currentPage-1)+')">上一页</button>';
    html += '<span class="info">第 ' + currentPage + ' / ' + tp + ' 页 (共 ' + result.total + ' 条)</span>';
    html += '<button ' + (currentPage>=tp?'disabled':'') + ' onclick="loadData('+(currentPage+1)+')">下一页</button>';
    pg.innerHTML = html;
  } catch(e) {
    document.getElementById('errors').innerHTML = '<tr><td colspan="7" class="empty-state">加载失败: ' + escapeHtml(e.message) + '</td></tr>';
  }
}

function resetFilters() {
  document.getElementById('search').value = '';
  document.getElementById('filter-version').value = '';
  document.getElementById('filter-os').value = '';
  document.getElementById('filter-date-from').value = '';
  document.getElementById('filter-date-to').value = '';
  loadData(1);
}

async function showDetail(id) {
  try {
    const res = await fetch('/api/errors/' + id);
    const e = await res.json();
    document.getElementById('modal-title').textContent = '错误 #' + e.id + ' - ' + (e.error_message || '').substring(0, 60);
    let html = '';

    html += '<div class="detail-section"><h3>基本信息</h3>';
    html += '<div class="detail-row"><span class="detail-label">错误消息</span><span class="detail-value">' + escapeHtml(e.error_message || '') + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">版本</span><span class="detail-value">' + (e.app_version || '-') + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">系统</span><span class="detail-value">' + (e.os || '-') + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">上报次数</span><span class="detail-value"><span class="count-badge ' + countClass(e.count) + '">' + e.count + '</span></span></div>';
    html += '<div class="detail-row"><span class="detail-label">首次上报</span><span class="detail-value">' + formatDate(e.first_seen) + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">最近上报</span><span class="detail-value">' + formatDate(e.last_seen) + '</span></div>';
    html += '</div>';

    if (e.stack_trace) {
      html += '<div class="detail-section"><h3>堆栈信息</h3><div class="stack-trace">' + escapeHtml(e.stack_trace) + '</div></div>';
    }
    if (e.context) {
      html += '<div class="detail-section"><h3>上下文</h3><div class="context-text">' + escapeHtml(e.context) + '</div></div>';
    }

    if (e.details && e.details.length > 0) {
      html += '<div class="detail-section"><h3>上报记录 (' + e.details.length + ')</h3><div class="details-list">';
      e.details.forEach(d => {
        html += '<div class="detail-item">';
        html += '<div class="detail-item-header"><span>' + formatDate(d.created_at) + '</span><span>' + (d.app_version||'') + ' / ' + (d.os||'') + '</span></div>';
        if (d.stack_trace) html += '<div class="stack-trace" style="max-height:150px;margin-top:8px">' + escapeHtml(d.stack_trace) + '</div>';
        if (d.context) html += '<div class="context-text" style="max-height:100px;margin-top:8px">' + escapeHtml(d.context) + '</div>';
        html += '</div>';
      });
      html += '</div></div>';
    }

    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal-overlay').classList.add('active');
  } catch(e) {
    alert('加载详情失败: ' + e.message);
  }
}

function closeModal() { document.getElementById('modal-overlay').classList.remove('active'); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

loadFilters();
loadData();
</script>
</body>
</html>`;
  
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// 主服务器
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query = parsed.query;
  
  // API 路由
  if (req.method === 'POST' && pathname === '/report') {
    handleReport(req, res);
  } else if (req.method === 'GET' && pathname === '/api/errors') {
    handleList(req, res, query);
  } else if (req.method === 'GET' && pathname.match(/^\\/api\\/errors\\/\\d+$/)) {
    const id = parseInt(pathname.split('/').pop());
    handleErrorDetail(req, res, id);
  } else if (req.method === 'GET' && pathname === '/api/filters') {
    handleFilters(req, res);
  } else if (req.method === 'GET' && pathname === '/api/stats') {
    handleStats(req, res);
  } else if (req.method === 'GET' && pathname === '/') {
    handleWebUI(req, res);
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.listen(PORT, () => {
  console.log('错误收集服务启动成功');
  console.log('Web 界面: http://localhost:' + PORT);
  console.log('上报接口: http://localhost:' + PORT + '/report');
  console.log('API 接口: http://localhost:' + PORT + '/api/errors');
});
