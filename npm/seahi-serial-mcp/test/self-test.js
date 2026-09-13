#!/usr/bin/env node
/*
 * seahi-serial-mcp 自测：零依赖、无子进程（直接 require 内部函数），
 * 全程在临时目录里跑并自带一个本地探活服务 —— **不会碰你真实的客户端配置**。
 *
 *   node test/self-test.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const cli = require('../cli.js');

let pass = 0;
let fail = 0;
function check(ok, label, extra) {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined && !ok ? '   -> ' + extra : ''}`);
}

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `seahi-mcp-${tag}-`));
}

function read(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

/** 跑一次 CLI，顺手把它的输出收起来（免得测试输出被刷屏） */
async function runMain(argv) {
  const out = [];
  const err = [];
  const ol = console.log;
  const oe = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try {
    const code = await cli.main(argv);
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = ol;
    console.error = oe;
  }
}

(async () => {
  // ===== 本地探活服务（/healthz → {"ok":true}）=====
  const srv = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const TOKEN = 'abcdef0123456789';
  const URL_OK = `http://127.0.0.1:${port}/sse?token=${TOKEN}`;

  const base = tmpdir('base');
  const EP = path.join(base, 'mcp-endpoint.json');
  const CLAUDE = path.join(base, 'claude_desktop_config.json');
  const CURSOR = path.join(base, 'cursor-mcp.json');
  const CODE = path.join(base, 'claude-code.json');
  process.env.SEAHI_CONFIG_DIR = base;
  process.env.SEAHI_ENDPOINT_FILE = EP;
  process.env.SEAHI_MCP_CLAUDE_CONFIG = CLAUDE;
  process.env.SEAHI_MCP_CURSOR_CONFIG = CURSOR;
  process.env.SEAHI_MCP_CLAUDECODE_CONFIG = CODE;

  console.log('【路径与参数解析】');
  check(cli.endpointFile() === EP, '发现文件路径可被环境变量覆盖');
  const pa = cli.parseArgs(['--client', 'claude,cursor', '--dry-run', '--json']);
  check(pa.clients.join(',') === 'claude,cursor', '--client 解析成列表', JSON.stringify(pa.clients));
  check(pa.dryRun === true && pa.json === true, '--dry-run / --json 被识别');
  check(pa.cmd === 'install', '默认命令是 install');
  check(cli.parseArgs(['status']).cmd === 'status', '子命令能解析');
  check(cli.parseArgs(['--url', 'http://x/sse']).url === 'http://x/sse', '--url 能解析');

  console.log('\n【token 打码】');
  check(cli.maskUrl(URL_OK) === `http://127.0.0.1:${port}/sse?token=…${TOKEN.slice(-4)}`,
    '打印时只留 token 末 4 位', cli.maskUrl(URL_OK));
  check(!cli.maskUrl(URL_OK).includes(TOKEN), '打码后不含完整 token');

  console.log('\n【pid 存活判断】');
  check(cli.pidAlive(process.pid) === true, '当前进程的 pid 判为存活');
  check(cli.pidAlive(999999) === false, '不存在的 pid 判为已退出');
  check(cli.pidAlive(null) === false, '没给 pid 时判为已退出');

  console.log('\n【应用没在跑时必须拒绝】');
  let r = await runMain(['install', '--client', 'claude']);
  check(r.code === 2, '没有发现文件 → 退出码 2', r.code);
  check(r.err.includes('找不到端点发现文件'), '错误信息说清原因', r.err);
  check(!fs.existsSync(CLAUDE), '拒绝时不会创建客户端配置');

  console.log('\n【探活失败也必须拒绝】');
  fs.writeFileSync(EP, JSON.stringify({ url: `http://127.0.0.1:1/sse?token=x`, pid: process.pid }));
  r = await runMain(['install', '--client', 'claude']);
  check(r.code === 2, '端点无响应 → 退出码 2', r.code);
  check(r.err.includes('没有响应'), '错误信息说明"应用没有响应"', r.err);
  check(!fs.existsSync(CLAUDE), '探活失败时不写盘');

  console.log('\n【正常安装：只动我们自己那把键】');
  fs.writeFileSync(EP, JSON.stringify({ url: URL_OK, pid: process.pid, appVersion: '9.9.9' }));
  fs.writeFileSync(
    CLAUDE,
    JSON.stringify({ globalShortcut: 'Ctrl+Space', mcpServers: { other: { type: 'sse', url: 'http://other' } } }, null, 2) + '\n'
  );
  r = await runMain(['install', '--client', 'claude']);
  check(r.code === 0, '安装成功 → 退出码 0', r.code);
  const cfg = JSON.parse(read(CLAUDE));
  check(cfg.mcpServers['seahi-serial'].url === URL_OK, '写入了正确端点');
  check(cfg.mcpServers['seahi-serial'].type === 'sse', 'type 为 sse');
  check(cfg.mcpServers.other && cfg.mcpServers.other.url === 'http://other', '其它 MCP server 条目原样保留');
  check(cfg.globalShortcut === 'Ctrl+Space', '文件里的其它键原样保留');
  check(r.out.includes('已写入'), '输出说明已写入');
  check(r.out.includes('备份'), '输出提到备份');
  check(!r.out.includes(TOKEN), '输出里没有完整 token');

  console.log('\n【幂等：已经是目标 URL 就不写盘】');
  const before = read(CLAUDE);
  r = await runMain(['install', '--client', 'claude']);
  check(r.code === 0, '重跑退出码 0', r.code);
  check(r.out.includes('无需修改'), '明确说"无需修改"', r.out);
  check(read(CLAUDE) === before, '文件内容逐字节未变（连 mtime 都不会动）');

  console.log('\n【端口回退后重跑即可修正】');
  const URL2 = `http://127.0.0.1:${port}/sse?token=ffff9999`;
  fs.writeFileSync(EP, JSON.stringify({ url: URL2, pid: process.pid }));
  r = await runMain(['install', '--client', 'claude']);
  check(r.code === 0 && r.out.includes('已写入'), 'URL 变了会重新写入');
  check(r.out.includes('原值'), '输出里给出原值（便于确认改了什么）');
  check(!r.out.includes(TOKEN), '原值里的 token 也打码了');
  check(JSON.parse(read(CLAUDE)).mcpServers['seahi-serial'].url === URL2, '文件里是新的 URL');
  const bak = cli.backupsOf(CLAUDE);
  check(bak.length >= 1, '产生了备份文件', bak.length);

  console.log('\n【备份份数有上限】');
  for (let i = 0; i < 8; i++) {
    fs.writeFileSync(EP, JSON.stringify({ url: `http://127.0.0.1:${port}/sse?token=aa${i}${i}${i}`, pid: process.pid }));
    await runMain(['install', '--client', 'claude']);
  }
  check(cli.backupsOf(CLAUDE).length <= cli.KEEP_BACKUPS,
    `备份最多留 ${cli.KEEP_BACKUPS} 份`, cli.backupsOf(CLAUDE).length);

  console.log('\n【--dry-run 绝不写盘】');
  const dryBase = tmpdir('dry');
  process.env.SEAHI_MCP_CURSOR_CONFIG = path.join(dryBase, 'cursor.json');
  fs.writeFileSync(process.env.SEAHI_MCP_CURSOR_CONFIG, JSON.stringify({ mcpServers: {} }, null, 2) + '\n');
  const dryBefore = read(process.env.SEAHI_MCP_CURSOR_CONFIG);
  r = await runMain(['install', '--client', 'cursor', '--dry-run']);
  check(r.code === 0, 'dry-run 退出码 0', r.code);
  check(r.out.includes('将写入'), '输出说明"将写入"', r.out);
  check(r.out.includes('将被修改'), 'dry-run 的结论说"将被修改"（而不是误报"无需改动"）', r.out);
  check(read(process.env.SEAHI_MCP_CURSOR_CONFIG) === dryBefore, 'dry-run 确实没写盘');

  console.log('\n【含注释的文件（JSONC）绝不硬改】');
  const jsonc = '{\n  // 这是注释\n  "mcpServers": {}\n}\n';
  fs.writeFileSync(process.env.SEAHI_MCP_CURSOR_CONFIG, jsonc);
  r = await runMain(['install', '--client', 'cursor']);
  check(r.code === 4, 'JSONC 被拒 → 退出码 4', r.code);
  check(r.err.includes('拒绝写入'), '明确说明拒绝', r.err);
  check(r.out.includes('seahi-serial'), '给出可粘贴的片段', r.out);
  check(read(process.env.SEAHI_MCP_CURSOR_CONFIG) === jsonc, '原文件逐字节未被改动');

  console.log('\n【uninstall 只删自己那一条】');
  process.env.SEAHI_MCP_CURSOR_CONFIG = CURSOR;
  fs.writeFileSync(
    CURSOR,
    JSON.stringify({ mcpServers: { other: { url: 'http://other' }, 'seahi-serial': { type: 'sse', url: URL2 } }, x: 1 }, null, 2) + '\n'
  );
  r = await runMain(['uninstall', '--client', 'cursor']);
  check(r.code === 0, '卸载退出码 0', r.code);
  const after = JSON.parse(read(CURSOR));
  check(!after.mcpServers['seahi-serial'], '我们那条被移除');
  check(after.mcpServers.other && after.mcpServers.other.url === 'http://other', '别人的条目不动');
  check(after.x === 1, '其它键不动');
  r = await runMain(['uninstall', '--client', 'cursor']);
  check(r.out.includes('无需修改'), '没配过时卸载是 no-op', r.out);

  console.log('\n【默认只挑"已经装了"的客户端】');
  const t2 = tmpdir('defaults');
  process.env.SEAHI_CONFIG_DIR = t2;
  process.env.SEAHI_ENDPOINT_FILE = path.join(t2, 'ep.json');
  process.env.SEAHI_MCP_CLAUDE_CONFIG = path.join(t2, 'claude.json');   // 不存在
  process.env.SEAHI_MCP_CURSOR_CONFIG = path.join(t2, 'cursor.json');   // 存在
  process.env.SEAHI_MCP_CLAUDECODE_CONFIG = path.join(t2, 'cc.json');  // 不存在
  fs.writeFileSync(process.env.SEAHI_ENDPOINT_FILE, JSON.stringify({ url: URL_OK, pid: process.pid }));
  fs.writeFileSync(process.env.SEAHI_MCP_CURSOR_CONFIG, JSON.stringify({ mcpServers: {} }, null, 2) + '\n');
  r = await runMain(['install']);
  check(r.code === 0, '有已装客户端时能装', r.code);
  check(r.out.includes('Cursor'), '只挑了存在的那个', r.out.split('\n')[0]);
  check(!fs.existsSync(process.env.SEAHI_MCP_CLAUDE_CONFIG), '不会凭空创建未安装客户端的配置');

  const t3 = tmpdir('nodefault');
  process.env.SEAHI_CONFIG_DIR = t3;
  process.env.SEAHI_ENDPOINT_FILE = path.join(t3, 'ep.json');
  process.env.SEAHI_MCP_CLAUDE_CONFIG = path.join(t3, 'claude.json');
  process.env.SEAHI_MCP_CURSOR_CONFIG = path.join(t3, 'cursor.json');
  process.env.SEAHI_MCP_CLAUDECODE_CONFIG = path.join(t3, 'cc.json');
  fs.writeFileSync(process.env.SEAHI_ENDPOINT_FILE, JSON.stringify({ url: URL_OK, pid: process.pid }));
  r = await runMain(['install']);
  check(r.code === 3, '一个都没装 → 退出码 3 并给指引', r.code);
  check(r.err.includes('--client'), '提示用 --client 指定', r.err);

  console.log('\n【status】');
  process.env.SEAHI_MCP_CURSOR_CONFIG = path.join(t3, 'cursor.json');
  fs.writeFileSync(process.env.SEAHI_MCP_CURSOR_CONFIG, JSON.stringify({ mcpServers: {} }, null, 2) + '\n');
  const st = await cli.statusAll({ timeoutMs: 2000 });
  check(st.app.running === true, 'status 判定应用在运行', JSON.stringify(st.app));
  check(st.app.endpoint.includes('…'), 'status 里 token 也打码');
  check(st.clients.find((c) => c.client === 'cursor').state === '未配置', '能报出"未配置"');
  check(st.clients.find((c) => c.client === 'claude').state.includes('未安装'), '能报出"客户端未安装"');
  // 装上后再看状态
  await runMain(['install', '--client', 'cursor']);
  const st2 = await cli.statusAll({ timeoutMs: 2000 });
  check(st2.clients.find((c) => c.client === 'cursor').state.includes('已配置且指向当前端点'),
    '装上后 status 说"已配置且指向当前端点"', JSON.stringify(st2.clients.find((c) => c.client === 'cursor')));

  console.log('\n【包本身的约束】');
  const pkg = JSON.parse(read(path.join(__dirname, '..', 'package.json')));
  check(!pkg.dependencies && !pkg.devDependencies, '零依赖（含 devDependencies）');
  check(!pkg.scripts.postinstall, '没有 postinstall（不下载、不执行任何东西）');
  check(pkg.bin['seahi-serial-mcp'] === 'cli.js', 'bin 指向 cli.js');
  check(/>=18/.test(pkg.engines.node), '要求 node >= 18');
  check(JSON.stringify(pkg.os) === '["win32"]', '仅 Windows（路径都是 Windows 的）');

  srv.close();
  console.log(`\n结果: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('自测崩了: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
