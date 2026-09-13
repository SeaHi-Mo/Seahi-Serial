#!/usr/bin/env node
/*
 * seahi-serial-mcp —— SeaHi Serial 的 MCP **客户端配置安装器**
 *
 * 它**不是** MCP 服务器。真正的服务器跑在 SeaHi Serial 应用进程内（只监听回环、只用 SSE）；
 * 这个包只做一件事：把应用已经告诉你的端点，写进各家 AI 客户端的配置里。
 *
 * 设计约束（见 SeaHi Serial 仓库的 doc/MCP_DESIGN.md §3.5）：
 *   1. **零运行时依赖**，只用 Node 内置模块；**不加 postinstall**、不下载任何东西；
 *   2. **只动我们自己那一把键**（mcpServers["seahi-serial"]），其它 MCP server 一律不碰；
 *   3. 先备份、原子写（临时文件 + rename）；
 *   4. 目标文件含注释（JSONC）时**绝不硬改**，改为打印可粘贴片段并以非 0 退出；
 *   5. 幂等：已经是目标 URL 就不写盘；
 *   6. 应用没在跑就**拒绝写入**（不能往客户端塞一个连不上的地址）；
 *   7. 打印时 token 打码（避免泄进终端回滚缓冲或 AI 对话记录）。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const SERVER_KEY = 'seahi-serial';
const PKG_VERSION = require('./package.json').version;
/** 每个目标文件保留几份备份 */
const KEEP_BACKUPS = 5;
const PROBE_TIMEOUT_MS = 3000;

/**
 * 各家客户端及其**候选**配置路径。
 * ⚠️ 这些路径需要在本机逐个核实（各客户端版本可能不同）；`status` 会把实际存在与否打出来。
 * 环境变量覆盖（`env`）既方便多环境，也让自测能在临时目录里跑而不碰真实配置。
 */
const CLIENTS = {
  claude: {
    label: 'Claude Desktop',
    env: 'SEAHI_MCP_CLAUDE_CONFIG',
    path: () => path.join(appDataDir(), 'Claude', 'claude_desktop_config.json'),
    format: 'mcpServers',
  },
  claudecode: {
    label: 'Claude Code',
    env: 'SEAHI_MCP_CLAUDECODE_CONFIG',
    path: () => path.join(os.homedir(), '.claude.json'),
    format: 'mcpServers',
  },
  cursor: {
    label: 'Cursor（全局）',
    env: 'SEAHI_MCP_CURSOR_CONFIG',
    path: () => path.join(os.homedir(), '.cursor', 'mcp.json'),
    format: 'mcpServers',
  },
  vscode: {
    label: 'VS Code（当前工作区，需显式指定）',
    env: 'SEAHI_MCP_VSCODE_CONFIG',
    path: () => path.join(process.cwd(), '.vscode', 'mcp.json'),
    format: 'mcpServers',
    /** 工作区文件：不显式 --client 时不要自作主张往当前目录写 */
    workspaceScoped: true,
  },
};

function appDataDir() {
  if (process.env.SEAHI_CONFIG_DIR) return process.env.SEAHI_CONFIG_DIR;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'seahi-serial');
  }
  return path.join(os.homedir(), '.config', 'seahi-serial');
}

function endpointFile() {
  return process.env.SEAHI_ENDPOINT_FILE || path.join(appDataDir(), 'mcp-endpoint.json');
}

function clientConfigPath(id) {
  const c = CLIENTS[id];
  if (!c) throw new Error(`未知客户端: ${id}`);
  if (c.env && process.env[c.env]) return process.env[c.env];
  return c.path();
}

/** 打印时把 token 打码（URL 里带 token，不能整串抄进日志） */
function maskUrl(url) {
  return String(url).replace(/(token=)([0-9a-fA-F]{8,})/, (m, p1, tok) => p1 + '…' + tok.slice(-4));
}

function readEndpoint() {
  const f = endpointFile();
  if (!fs.existsSync(f)) {
    return { ok: false, reason: `找不到端点发现文件：${f}\n（说明 SeaHi Serial 没在运行，或 MCP 服务器被关掉了）` };
  }
  let ep;
  try {
    ep = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    return { ok: false, reason: `端点发现文件解析失败：${e.message}` };
  }
  if (!ep || typeof ep.url !== 'string' || !ep.url) {
    return { ok: false, reason: '端点发现文件里没有 url 字段' };
  }
  return { ok: true, endpoint: ep, file: f };
}

/** pid 是否还活着。Windows 上 `kill(pid,0)` 对存在的进程返回 true（无权限时抛 EPERM 也算活着）。 */
function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

/** 探活：由 SSE 端点推出 /healthz，要求 200 + {"ok":true}（该端点不带任何信息） */
function probe(sseUrl, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(sseUrl);
    } catch (e) {
      return resolve({ ok: false, reason: `端点 URL 不合法：${sseUrl}` });
    }
    const req = http.request(
      { host: u.hostname, port: u.port, path: '/healthz', method: 'GET', timeout: timeoutMs || PROBE_TIMEOUT_MS },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return resolve({ ok: false, reason: `探活返回 HTTP ${res.statusCode}` });
          }
          try {
            const j = JSON.parse(body);
            if (j && j.ok === true) return resolve({ ok: true });
            return resolve({ ok: false, reason: `探活响应不是 {"ok":true}：${body.slice(0, 80)}` });
          } catch (e) {
            return resolve({ ok: false, reason: `探活响应不是 JSON：${body.slice(0, 80)}` });
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('探活超时')));
    req.on('error', (e) => resolve({ ok: false, reason: `探活失败：${e.message}` }));
    req.end();
  });
}

/**
 * 严格读 JSON。**含注释（JSONC）时明确拒绝** —— 宁可让用户手工粘贴，也不能把人家配置改坏。
 */
function loadJsonStrict(file) {
  if (!fs.existsSync(file)) return { ok: true, data: {} };
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.trim() === '') return { ok: true, data: {} };
  try {
    return { ok: true, data: JSON.parse(raw), raw };
  } catch (e) {
    const looksJsonc = /(^|\n)\s*(\/\/|\/\*)/.test(raw);
    return {
      ok: false,
      raw,
      jsonc: looksJsonc,
      reason: looksJsonc
        ? '目标文件含注释（JSONC），本工具不解析它，以免破坏你的文件'
        : `目标文件不是合法 JSON：${e.message}`,
    };
  }
}

function backupsOf(file) {
  const dir = path.dirname(file);
  const base = path.basename(file) + '.seahi-bak-';
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(base))
    .map((n) => path.join(dir, n))
    .sort();
}

function pruneBackups(file) {
  const all = backupsOf(file);
  const extra = all.length - KEEP_BACKUPS;
  for (let i = 0; i < extra; i++) {
    try {
      fs.unlinkSync(all[i]);
    } catch (e) {
      /* 删不掉就算了，不该因此失败 */
    }
  }
}

/** 先备份，再原子写（临时文件 + rename）。返回备份路径（没写盘时为 null） */
function saveAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup = null;
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backup = `${file}.seahi-bak-${stamp}`;
    fs.copyFileSync(file, backup);
    pruneBackups(file);
  }
  const tmp = `${file}.seahi-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return backup;
}

/** 供"拒绝硬改"时给用户的可粘贴片段 */
function snippetFor(url) {
  return JSON.stringify({ mcpServers: { [SERVER_KEY]: { type: 'sse', url } } }, null, 2);
}

function desiredEntry(url) {
  return { type: 'sse', url };
}

/**
 * 往一个客户端配置里写入我们的条目。
 * 返回 { status: 'installed'|'unchanged'|'skipped'|'refused', ... }
 */
function installFor(id, url, opts) {
  opts = opts || {};
  const file = clientConfigPath(id);
  const label = CLIENTS[id].label;
  const loaded = loadJsonStrict(file);
  if (!loaded.ok) {
    return {
      status: 'refused',
      client: id,
      label,
      file,
      reason: loaded.reason,
      snippet: snippetFor(url),
    };
  }
  const cfg = loaded.data && typeof loaded.data === 'object' ? loaded.data : {};
  const servers = cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};
  const cur = servers[SERVER_KEY];
  if (cur && cur.type === 'sse' && cur.url === url) {
    return { status: 'unchanged', client: id, label, file, url };
  }
  if (opts.dryRun) {
    return {
      status: 'would-install',
      client: id,
      label,
      file,
      url,
      from: cur ? maskUrl(cur.url || '') : null,
    };
  }
  const next = Object.assign({}, cfg);
  next.mcpServers = Object.assign({}, servers);
  next.mcpServers[SERVER_KEY] = desiredEntry(url);
  const backup = saveAtomic(file, next);
  return {
    status: 'installed',
    client: id,
    label,
    file,
    url,
    backup,
    from: cur ? maskUrl(cur.url || '') : null,
  };
}

function uninstallFor(id, opts) {
  opts = opts || {};
  const file = clientConfigPath(id);
  const label = CLIENTS[id].label;
  const loaded = loadJsonStrict(file);
  if (!loaded.ok) {
    return { status: 'refused', client: id, label, file, reason: loaded.reason };
  }
  const cfg = loaded.data && typeof loaded.data === 'object' ? loaded.data : {};
  const servers = cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};
  if (!servers[SERVER_KEY]) {
    return { status: 'unchanged', client: id, label, file, reason: '本来就没配置过' };
  }
  if (opts.dryRun) return { status: 'would-remove', client: id, label, file };
  const next = Object.assign({}, cfg);
  next.mcpServers = Object.assign({}, servers);
  delete next.mcpServers[SERVER_KEY];
  const backup = saveAtomic(file, next);
  return { status: 'removed', client: id, label, file, backup };
}

/** 默认只写"已经装了客户端"的那些（配置文件存在）；工作区作用域的要显式指定 */
function defaultTargets() {
  const out = [];
  for (const id of Object.keys(CLIENTS)) {
    const c = CLIENTS[id];
    if (c.workspaceScoped) continue;
    try {
      if (fs.existsSync(clientConfigPath(id))) out.push(id);
    } catch (e) {
      /* 忽略 */
    }
  }
  return out;
}

function parseArgs(argv) {
  const out = { cmd: 'install', clients: null, url: null, dryRun: false, json: false, help: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--json') out.json = true;
    else if (a === '--client') out.clients = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith('--client=')) out.clients = a.slice(9).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--url') out.url = argv[++i];
    else if (a.startsWith('--url=')) out.url = a.slice(6);
    else rest.push(a);
  }
  if (rest.length) out.cmd = rest[0];
  return out;
}

const HELP = `seahi-serial-mcp v${PKG_VERSION} —— 把 SeaHi Serial 的 MCP 端点写进 AI 客户端配置

用法：
  npx seahi-serial-mcp [install] [选项]     写入客户端配置（默认命令）
  npx seahi-serial-mcp status               看应用是否在跑、各客户端配没配
  npx seahi-serial-mcp uninstall            只移除本工具写入的那一条

选项：
  --client a,b    只处理指定客户端（${Object.keys(CLIENTS).join(' / ')}）
  --url <url>     手动指定端点（跳过发现文件）
  --dry-run       只显示将要做什么，不写盘
  --json          机器可读输出
  -h, --help      显示帮助

说明：安装前会确认应用在运行（发现文件 + /healthz 探活）。
端口回退导致 URL 变化后，重跑一次 install 即可修正 —— 这就是它比手工粘贴强的地方。`;

async function statusAll(opts) {
  const ep = readEndpoint();
  const out = { app: { running: false }, clients: [], endpointFile: endpointFile() };
  if (ep.ok) {
    out.app.endpoint = maskUrl(ep.endpoint.url);
    out.app.pid = ep.endpoint.pid;
    out.app.pidAlive = pidAlive(ep.endpoint.pid);
    out.app.appVersion = ep.endpoint.appVersion;
    const pr = await probe(ep.endpoint.url, opts.timeoutMs);
    out.app.healthy = pr.ok;
    out.app.running = pr.ok;
    if (!pr.ok) out.app.reason = pr.reason;
    for (const id of Object.keys(CLIENTS)) {
      let file;
      try {
        file = clientConfigPath(id);
      } catch (e) {
        continue;
      }
      const exists = fs.existsSync(file);
      const loaded = exists ? loadJsonStrict(file) : { ok: true, data: {} };
      let state = '未配置';
      if (!exists) state = '客户端未安装（配置文件不存在）';
      else if (!loaded.ok) state = loaded.jsonc ? '配置文件含注释（本工具不会改）' : '配置文件无法解析';
      else {
        const cur = loaded.data && loaded.data.mcpServers && loaded.data.mcpServers[SERVER_KEY];
        if (!cur) state = '未配置';
        else if (cur.url === ep.endpoint.url) state = '已配置且指向当前端点';
        else state = '已配置但 URL 已过期（重跑 install 即可修正）';
      }
      out.clients.push({ client: id, label: CLIENTS[id].label, file, exists, state });
    }
  } else {
    out.app.reason = ep.reason;
    for (const id of Object.keys(CLIENTS)) {
      let file = '';
      try {
        file = clientConfigPath(id);
      } catch (e) {
        continue;
      }
      out.clients.push({
        client: id,
        label: CLIENTS[id].label,
        file,
        exists: fs.existsSync(file),
        state: '应用未运行，无法判断',
      });
    }
  }
  return out;
}

function printStatus(s) {
  console.log(`应用：${s.app.running ? '在运行' : '未运行'}`);
  if (s.app.reason) console.log(`  原因：${s.app.reason}`);
  if (s.app.endpoint) console.log(`  端点：${s.app.endpoint}（pid ${s.app.pid}${s.app.pidAlive ? '，存活' : '，已退出'}）`);
  if (s.app.appVersion) console.log(`  应用版本：${s.app.appVersion}`);
  console.log('发现文件：' + s.endpointFile);
  console.log('客户端：');
  for (const c of s.clients) {
    console.log(`  ${c.label.padEnd(30, ' ')} ${c.state}`);
    console.log(`    ${c.file}`);
  }
}

function printResult(r) {
  const tag = { installed: '已写入', unchanged: '无需修改', 'would-install': '将写入', refused: '拒绝写入', removed: '已移除', 'would-remove': '将移除' }[r.status] || r.status;
  console.log(`[${tag}] ${r.label}`);
  console.log(`  文件：${r.file}`);
  if (r.url) console.log(`  端点：${maskUrl(r.url)}`);
  if (r.from) console.log(`  原值：${r.from}`);
  if (r.backup) console.log(`  备份：${r.backup}`);
  if (r.reason) console.log(`  原因：${r.reason}`);
  if (r.snippet) {
    console.log('  请手工把下面这段合并进该文件（本工具不敢改含注释的文件）：');
    console.log(
      r.snippet
        .split('\n')
        .map((l) => '    ' + l)
        .join('\n')
    );
  }
}

async function main(argv) {
  const args = parseArgs(argv || []);
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  if (args.cmd === 'status') {
    const s = await statusAll({ timeoutMs: PROBE_TIMEOUT_MS });
    if (args.json) console.log(JSON.stringify(s, null, 2));
    else printStatus(s);
    return s.app.running ? 0 : 2;
  }

  if (args.cmd !== 'install' && args.cmd !== 'uninstall') {
    console.error(`未知命令：${args.cmd}\n\n${HELP}`);
    return 1;
  }

  // 解析端点：显式 --url 优先；否则读发现文件并**必须探活成功**
  let url = args.url;
  if (!url) {
    const ep = readEndpoint();
    if (!ep.ok) {
      console.error(`✗ ${ep.reason}`);
      return 2;
    }
    const pr = await probe(ep.endpoint.url, PROBE_TIMEOUT_MS);
    if (!pr.ok) {
      console.error(`✗ 应用没有响应（${pr.reason}）—— 不写入，免得客户端拿到一个连不上的地址`);
      return 2;
    }
    url = ep.endpoint.url;
  }

  let targets = args.clients;
  if (!targets || !targets.length) {
    if (args.cmd === 'uninstall') {
      targets = Object.keys(CLIENTS);
    } else {
      targets = defaultTargets();
      if (!targets.length) {
        console.error('✗ 没找到已安装的客户端配置文件。请用 --client 指定，例如：');
        console.error(`    npx seahi-serial-mcp install --client ${Object.keys(CLIENTS)[0]}`);
        console.error('  各客户端的候选路径见 README（这些路径需要你按本机实际情况核实）。');
        return 3;
      }
      console.log(`未指定 --client，按"已装客户端"处理：${targets.map((t) => CLIENTS[t].label).join('、')}`);
    }
  }
  for (const t of targets) {
    if (!CLIENTS[t]) {
      console.error(`✗ 未知客户端：${t}（可用：${Object.keys(CLIENTS).join(' / ')}）`);
      return 1;
    }
  }

  const results = [];
  for (const t of targets) {
    results.push(
      args.cmd === 'install'
        ? installFor(t, url, { dryRun: args.dryRun })
        : uninstallFor(t, { dryRun: args.dryRun })
    );
  }

  if (args.json) {
    console.log(JSON.stringify({ url: maskUrl(url), results }, null, 2));
  } else {
    console.log(`端点：${maskUrl(url)}${args.dryRun ? '（--dry-run：不会写盘）' : ''}`);
    for (const r of results) printResult(r);
    const refused = results.filter((r) => r.status === 'refused');
    if (refused.length) {
      console.error(`\n✗ 有 ${refused.length} 个文件被拒绝写入（见上面的片段），其余照常处理。`);
      return 4;
    }
    const wouldChange = results.filter((r) =>
      /^(installed|removed|would-install|would-remove)$/.test(r.status)
    ).length;
    const realChange = results.filter((r) => r.status === 'installed' || r.status === 'removed').length;
    console.log(
      `\n完成：${wouldChange} 个文件${args.dryRun ? '将被修改' : '被修改'}，` +
        `${results.length - wouldChange} 个无需改动。`
    );
    if (!args.dryRun && realChange) {
      console.log('请重启对应的 AI 客户端让它重新加载 MCP 配置。');
    }
  }
  return 0;
}

module.exports = {
  SERVER_KEY,
  CLIENTS,
  KEEP_BACKUPS,
  appDataDir,
  endpointFile,
  clientConfigPath,
  maskUrl,
  readEndpoint,
  pidAlive,
  probe,
  loadJsonStrict,
  backupsOf,
  pruneBackups,
  saveAtomic,
  snippetFor,
  desiredEntry,
  installFor,
  uninstallFor,
  defaultTargets,
  parseArgs,
  statusAll,
  main,
};

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code || 0))
    .catch((e) => {
      console.error('✗ ' + (e && e.message ? e.message : e));
      process.exit(1);
    });
}
