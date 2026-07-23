/**
 * Cloudflare Worker - 错误收集服务
 * 
 * 使用 Cloudflare D1 (SQLite) 存储错误数据
 * 
 * 部署步骤：
 * 1. npm install -g wrangler
 * 2. wrangler login
 * 3. wrangler d1 create seahi-errors
 * 4. 更新 wrangler.toml 中的 database_id
 * 5. wrangler d1 execute seahi-errors --file=./schema.sql
 * 6. wrangler deploy
 */

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const DB = env.seahi_errors;
    
    try {
      if (request.method === 'POST' && url.pathname === '/report') {
        return await handleReport(request, DB, corsHeaders);
      } else if (request.method === 'GET' && url.pathname === '/api/errors') {
        return await handleList(request, DB, corsHeaders, url);
      } else if (request.method === 'GET' && url.pathname.match(/^\/api\/errors\/\d+$/)) {
        const id = parseInt(url.pathname.split('/').pop());
        return await handleErrorDetail(id, DB, corsHeaders);
      } else if (request.method === 'GET' && url.pathname === '/api/filters') {
        return await handleFilters(DB, corsHeaders);
      } else if (request.method === 'GET' && url.pathname === '/api/stats') {
        return await handleStats(DB, corsHeaders);
      } else if (request.method === 'GET' && url.pathname === '/') {
        return handleWebUI(corsHeaders);
      } else {
        return new Response(
          JSON.stringify({ error: 'Not found' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    } catch (error) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  }
};

async function handleReport(request, DB, corsHeaders) {
  const data = await request.json();
  const {
    app_version = 'unknown',
    os = 'unknown',
    error = 'Unknown error',
    stack = '',
    context = ''
  } = data;
  
  const errorHash = await generateHash(error + stack);
  
  const existing = await DB.prepare(
    'SELECT id, count FROM errors WHERE error_hash = ?'
  ).bind(errorHash).first();
  
  if (existing) {
    await DB.prepare(
      'UPDATE errors SET count = count + 1, last_seen = datetime(\'now\') WHERE id = ?'
    ).bind(existing.id).run();
    
    await DB.prepare(
      'INSERT INTO error_details (error_id, app_version, os, error_message, stack_trace, context) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(existing.id, app_version, os, error, stack, context).run();
    
    return new Response(
      JSON.stringify({ status: 'updated', error_id: existing.id, count: existing.count + 1 }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } else {
    const result = await DB.prepare(
      'INSERT INTO errors (app_version, os, error_hash, error_message, stack_trace, context) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(app_version, os, errorHash, error, stack, context).run();
    
    const errorId = result.meta.last_row_id;
    
    await DB.prepare(
      'INSERT INTO error_details (error_id, app_version, os, error_message, stack_trace, context) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(errorId, app_version, os, error, stack, context).run();
    
    return new Response(
      JSON.stringify({ status: 'created', error_id: errorId }),
      { status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}

async function handleList(request, DB, corsHeaders, url) {
  const conditions = [];
  const params = [];

  const search = url.searchParams.get('search');
  const version = url.searchParams.get('version');
  const osFilter = url.searchParams.get('os');
  const dateFrom = url.searchParams.get('date_from');
  const dateTo = url.searchParams.get('date_to');
  const page = Math.max(1, parseInt(url.searchParams.get('page')) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit')) || 20));
  const offset = (page - 1) * limit;

  if (search) {
    conditions.push('(error_message LIKE ? OR stack_trace LIKE ? OR context LIKE ?)');
    const term = `%${search}%`;
    params.push(term, term, term);
  }
  if (version) { conditions.push('app_version = ?'); params.push(version); }
  if (osFilter) { conditions.push('os = ?'); params.push(osFilter); }
  if (dateFrom) { conditions.push('last_seen >= ?'); params.push(dateFrom); }
  if (dateTo) { conditions.push('last_seen <= ?'); params.push(dateTo); }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const countResult = await DB.prepare(
    `SELECT COUNT(*) as total FROM errors ${where}`
  ).bind(...params).first();

  const total = countResult ? countResult.total : 0;

  const { results } = await DB.prepare(
    `SELECT * FROM errors ${where} ORDER BY last_seen DESC LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all();
  
  return new Response(
    JSON.stringify({
      data: results || [],
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

async function handleErrorDetail(id, DB, corsHeaders) {
  const error = await DB.prepare('SELECT * FROM errors WHERE id = ?').bind(id).first();
  if (!error) {
    return new Response(
      JSON.stringify({ error: 'Not found' }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const { results: details } = await DB.prepare(
    'SELECT * FROM error_details WHERE error_id = ? ORDER BY created_at DESC'
  ).bind(id).all();

  return new Response(
    JSON.stringify({ ...error, details: details || [] }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

async function handleFilters(DB, corsHeaders) {
  const { results: versions } = await DB.prepare(
    'SELECT DISTINCT app_version FROM errors WHERE app_version IS NOT NULL ORDER BY app_version'
  ).all();
  const { results: osList } = await DB.prepare(
    'SELECT DISTINCT os FROM errors WHERE os IS NOT NULL ORDER BY os'
  ).all();

  return new Response(
    JSON.stringify({
      versions: (versions || []).map(r => r.app_version),
      osList: (osList || []).map(r => r.os)
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

async function handleStats(DB, corsHeaders) {
  const stats = await DB.prepare(`
    SELECT 
      COUNT(*) as total_errors,
      SUM(count) as total_reports,
      COUNT(DISTINCT app_version) as versions,
      MIN(first_seen) as first_seen,
      MAX(last_seen) as last_seen
    FROM errors
  `).first();
  
  return new Response(
    JSON.stringify(stats || {}),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

function handleWebUI(corsHeaders) {
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
    table { width: 100%; border-collapse: collapse; }
    th { background: #252526; color: #808080; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; padding: 10px 12px; text-align: left; border-bottom: 1px solid #3c3c3c; position: sticky; top: 0; }
    td { padding: 10px 12px; border-bottom: 1px solid #2d2d2d; font-size: 13px; vertical-align: top; }
    tr:hover td { background: #2a2d2e; cursor: pointer; }
    .error-msg { max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #d4d4d4; }
    .count-badge { background: #c586c0; color: #fff; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
    .count-badge.high { background: #f44747; }
    .count-badge.medium { background: #cca700; }
    .os-tag { background: #3c3c3c; padding: 2px 8px; border-radius: 4px; font-size: 12px; }
    .version-tag { color: #569cd6; }
    .time-col { color: #808080; font-size: 12px; white-space: nowrap; }
    .empty-state { text-align: center; padding: 60px 20px; color: #808080; }

    .pagination { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 20px 0; }
    .pagination button { background: #3c3c3c; color: #d4d4d4; border: 1px solid #555; border-radius: 4px; padding: 6px 12px; cursor: pointer; font-size: 13px; }
    .pagination button:hover:not(:disabled) { background: #505050; }
    .pagination button:disabled { opacity: 0.4; cursor: default; }
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

function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
function formatDate(s) { if (!s) return '-'; try { return new Date(s + 'Z').toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }); } catch(e) { return s; } }
function countClass(n) { return n >= 10 ? 'high' : n >= 3 ? 'medium' : ''; }

async function loadFilters() {
  try {
    const res = await fetch('/api/filters');
    const data = await res.json();
    const vs = document.getElementById('filter-version');
    (data.versions || []).forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v; vs.appendChild(o); });
    const os = document.getElementById('filter-os');
    (data.osList || []).forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v; os.appendChild(o); });
  } catch(e) {}
}

async function loadData(page) {
  currentPage = page || 1;
  const params = {
    search: document.getElementById('search').value,
    version: document.getElementById('filter-version').value,
    os: document.getElementById('filter-os').value,
    date_from: document.getElementById('filter-date-from').value,
    date_to: document.getElementById('filter-date-to').value,
    page: currentPage,
    limit: 20
  };
  const qs = Object.entries(params).filter(([k,v]) => v).map(([k,v]) => k+'='+encodeURIComponent(v)).join('&');

  try {
    const [statsRes, errorsRes] = await Promise.all([fetch('/api/stats'), fetch('/api/errors?' + qs)]);
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
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">暂无错误记录</td></tr>';
    } else {
      tbody.innerHTML = errors.map(function(e) {
        return '<tr onclick="showDetail(' + e.id + ')">' +
          '<td>' + e.id + '</td>' +
          '<td class="error-msg" title="' + escapeHtml(e.error_message) + '">' + escapeHtml(e.error_message) + '</td>' +
          '<td><span class="version-tag">' + (e.app_version || '-') + '</span></td>' +
          '<td><span class="os-tag">' + (e.os || '-') + '</span></td>' +
          '<td><span class="count-badge ' + countClass(e.count) + '">' + e.count + '</span></td>' +
          '<td class="time-col">' + formatDate(e.first_seen) + '</td>' +
          '<td class="time-col">' + formatDate(e.last_seen) + '</td>' +
        '</tr>';
      }).join('');
    }

    const pg = document.getElementById('pagination');
    const tp = result.totalPages || 1;
    if (tp <= 1) { pg.innerHTML = ''; return; }
    let html = '<button ' + (currentPage<=1?'disabled':'') + ' onclick="loadData('+(currentPage-1)+')">上一页</button>';
    html += '<span class="info">第 ' + currentPage + ' / ' + tp + ' 页 (共 ' + result.total + ' 条)</span>';
    html += '<button ' + (currentPage>=tp?'disabled':'') + ' onclick="loadData('+(currentPage+1)+')">下一页</button>';
    pg.innerHTML = html;
  } catch(e) {
    document.getElementById('errors').innerHTML = '<tr><td colspan="7" class="empty-state">加载失败</td></tr>';
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
    alert('加载详情失败');
  }
}

function closeModal() { document.getElementById('modal-overlay').classList.remove('active'); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

loadFilters();
loadData();
</script>
</body>
</html>`;
  
  return new Response(html, {
    headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' }
  });
}

async function generateHash(content) {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
