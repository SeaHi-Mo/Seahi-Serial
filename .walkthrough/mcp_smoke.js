// MCP 工具自检：连上**正在运行的应用**，对着它把每个内置工具真调一遍，逐条打印调用结果。
//
// 为什么必须有：两边的单测（Rust 假前端 / 前端断言集）各自只证明自己那一半，
// 而"客户端看不到新工具""扫描结果没返回来"这类问题恰恰出在**真正的这一跳**上 ——
// 2026-09 的真实教训：客户端一直在用 v0.5.3 的旧构建（33 个工具、0 个 ble_*），
// AI 只能退回去用通用 ui_* 桥，于是"工具明明写了却没结果"。
//
// 用法：
//   node .walkthrough/mcp_smoke.js          # 安全模式（默认）：只读工具真调；
//                                           #   写工具用"必填缺失/危险动作无 confirm"探针，
//                                           #   验证参数校验与二次确认门（都不产生副作用）；
//                                           #   其余有副作用的（无必填参数）跳过并如实标注
//   node .walkthrough/mcp_smoke.js --full   # 连有副作用的写工具也真调（会动界面/发数据，自己确认）
//   node .walkthrough/mcp_smoke.js --url http://127.0.0.1:7777/sse?token=xxx
//
// 退出码：有"硬失败"（工具缺失、参数校验没生效、危险门没生效…）时为 1。
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const FULL = args.indexOf('--full') >= 0;
const urlArg = (() => {
  const i = args.indexOf('--url');
  return i >= 0 ? args[i + 1] : null;
})();

function endpointUrl() {
  if (urlArg) return urlArg;
  const f = path.join(process.env.APPDATA || '', 'seahi-serial', 'mcp-endpoint.json');
  if (!fs.existsSync(f)) {
    console.error('找不到 ' + f + '：MCP 服务器没在跑（先在应用里打开 MCP 服务器），或用 --url 指定');
    process.exit(2);
  }
  const ep = JSON.parse(fs.readFileSync(f, 'utf8'));
  console.log('运行中的应用：version=' + ep.appVersion + ' pid=' + ep.pid + '  ' + ep.host + ':' + ep.port);
  return ep.url;
}

// ---- 源码侧的"应该有哪些工具、哪些算写/危险"（与 protocol.rs 同一份真源）----
const proto = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'mcp', 'protocol.rs'), 'utf8');
const srcTools = [...proto
  .slice(proto.indexOf('pub fn tool_defs()'), proto.indexOf('\n    ]', proto.indexOf('pub fn tool_defs()')))
  .matchAll(/"name":\s*"([a-z][a-z0-9_]*)"/g)].map((m) => m[1]);
const listConst = (constName) => {
  // 元素类型不写死：WRITE_TOOLS 是 &[&str]，DANGER_TOOLS 是 &[(&str, &str)]（(名字, 后果)）
  const re = new RegExp('pub const ' + constName + ': &\\[[^\\]]*\\] = &\\[([\\s\\S]*?)\\n\\];');
  const m = re.exec(proto);
  if (!m) return [];
  return [...new Set([...m[1].matchAll(/"([a-z][a-z0-9_]*)"/g)].map((x) => x[1]))];
};
const WRITES = new Set(listConst('WRITE_TOOLS'));
const DANGER = new Set(listConst('DANGER_TOOLS'));
// serial_quick_cmd 按**调用**判定：不带 index 只列举（只读）
const PER_CALL_READ = new Set(['serial_quick_cmd']);
// 安全模式下也允许真调的写工具：**只开/关蓝牙扫描**（不碰用户的串口会话、不碰已连设备）。
// 其余写工具一律用"必填缺失 / 危险动作无 confirm"探针（都在碰主程序之前就被挡下），
// 或者跳过（无必填参数的）—— 宁可不测，也不去关用户的串口、断用户的设备。
const SAFE_WRITES = new Set(['ble_start_scan', 'ble_stop_scan']);

if (!WRITES.size || !DANGER.size) {
  console.error('解析 protocol.rs 的 WRITE_TOOLS / DANGER_TOOLS 失败（自检脚本要能分清读写，别误调写工具）');
  process.exit(2);
}

// 读工具的探针参数（写工具**绝不用这里的参数去真调**：安全模式下写工具一律用"必填缺失"探针）
const PROBES = {
  log_tail: { channel: 'app', lines: 3 },
  log_search: { pattern: 'mcp', limit: 3 },
  ui_describe: { path: 'serial.conn.portSelect' },
  ui_get: { path: 'serial.conn.portSelect' },
  ui_list: { limit: 3 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function txtOf(r) {
  if (!r) return '(没有回执)';
  if (r.error) return '协议错误 ' + r.error.code + ' ' + r.error.message;
  const res = r.result || {};
  const t = (res.content && res.content[0] && res.content[0].text) || '';
  return (res.isError ? 'isError: ' : '') + t.replace(/\s+/g, ' ').slice(0, 200);
}

(async () => {
  const url = endpointUrl();
  const u = new URL(url);
  const base = u.origin;
  const token = u.searchParams.get('token');
  const res = await fetch(base + '/sse?token=' + token, { headers: { accept: 'text/event-stream' } });
  if (!res.ok) { console.error('GET /sse → ' + res.status + '（token 不对？）'); process.exit(2); }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let endpoint = null;
  const replies = new Map();
  (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(frame);
        const data = frame.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
        if (ev && ev[1] === 'endpoint') endpoint = data;
        else if (data) { try { const m = JSON.parse(data); if (m.id) replies.set(m.id, m); } catch (_) {} }
      }
    }
  })();
  for (let i = 0; i < 100 && !endpoint; i++) await sleep(50);
  if (!endpoint) { console.error('没等到 endpoint 事件（SSE 握手失败）'); process.exit(2); }

  let seq = 1;
  const post = (msg) => fetch(base + endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg),
  });
  const rpc = async (method, params) => {
    const id = seq++;
    await post({ jsonrpc: '2.0', id, method, params });
    for (let i = 0; i < 400 && !replies.has(id); i++) await sleep(25);
    return replies.get(id) || {};
  };
  const callTool = (name, a) => rpc('tools/call', { name, arguments: a || {} });

  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {},
                            clientInfo: { name: 'seahi-smoke', version: '1' } });
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });

  // 只读（沙箱）模式会**整体改变写工具的预期**：`call_tool` 的门顺序是
  // 只读门（-32007）→ 危险确认门（-32006）→ 各工具自己的参数校验（-32602），
  // 所以只读模式下写/危险工具的"必填缺失 / 无 confirm"探针**必然**先撞上 -32007。
  // 那不是工具坏了，是策略门在正常工作 —— 不认清这一点，自检会稳定误报 5 个"硬失败"
  // （2026-09 真机跑出来的就是这个现象）。
  const st0 = await callTool('mcp_status', {});
  const readOnly = !!(st0.result && st0.result.structuredContent
    && st0.result.structuredContent.readOnly);
  if (readOnly) {
    console.log('\nℹ️ 只读（沙箱）模式已开启：写工具与危险工具本次的预期是 **-32007（策略拒绝）**。');
    console.log('   参数校验（-32602）与二次确认门（-32006）被策略门挡在前面，本次**未覆盖** ——');
    console.log('   要验证它们，请在应用弹窗里关掉「只读模式」再跑一遍这个脚本。');
  }

  // ⚠️ `tools/list` 是**分页**的（每页 TOOLS_PAGE=50，返回 `nextCursor`）：
  // 只拉第一页的话，工具数一旦超过 50，自检就会误报"运行中缺少 N 个工具"，而且**那 N 个根本没被测到**
  // （2026-09 真机踩到：55 个工具时报"缺少 log_export / mcp_calls / mcp_stats / mcp_config_get /
  //  mcp_config_set"，其实它们在第二页）。这里跟着游标把页翻完。
  const liveAll = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const pr = await rpc('tools/list', cursor ? { cursor: cursor } : {});
    const pres = pr.result || {};
    liveAll.push(...(pres.tools || []));
    cursor = pres.nextCursor || null;
    if (!cursor) break;
  }
  const listed = { tools: liveAll };
  const live = (listed.tools || []).map((t) => ({
    name: t.name,
    required: (t.inputSchema && t.inputSchema.required) || [],
  }));
  const liveNames = new Set(live.map((t) => t.name));

  console.log('\n===== 工具清单 =====');
  console.log('源码 ' + srcTools.length + ' 个 / 运行中的应用 ' + live.length + ' 个');
  const missing = srcTools.filter((n) => !liveNames.has(n));
  const extra = live.map((t) => t.name).filter((n) => srcTools.indexOf(n) < 0 && n.indexOf('ctl_') !== 0);
  if (missing.length) {
    console.log('⚠️ 运行中缺少 ' + missing.length + ' 个：' + missing.join(', '));
    console.log('   → 跑的是**旧构建**（新工具要重新编译并重启应用，客户端也要重连才会重读 tools/list）');
  } else {
    console.log('✅ 源码里的工具在运行中的应用里全都有');
  }
  if (extra.length) console.log('ℹ️ 应用里多出的（ctl_* 之外）：' + extra.join(', '));

  // 需要连接设备的读工具：没连就如实跳过，而不是报"工具坏了"
  let svcChar = null;
  const svc = await callTool('ble_get_services');
  const svcSc = (svc.result && svc.result.structuredContent) || {};
  const svcList = svcSc.services || [];
  for (const s of svcList) {
    for (const c of (s.chars || [])) {
      const props = c.props || [];
      if (!svcChar && (props.indexOf('read') >= 0 || props.indexOf('notify') >= 0)) svcChar = c.uuid;
    }
  }

  console.log('\n===== 逐个工具真调 =====');
  const rows = [];
  let hardFail = 0;
  for (const t of live) {
    const name = t.name;
    if (name.indexOf('ctl_') === 0) continue;              // 控件工具成千上万，量太大（用 ui_list 查）
    // 扫描两条留到最后**单独跑**：在循环里"开完立刻停"是扫不到任何设备的
    if (name === 'ble_start_scan' || name === 'ble_stop_scan') {
      rows.push({ name, kind: '见下方', note: '"扫描链路"单独跑（这里开完立刻停会扫不到东西）' });
      continue;
    }
    const isWrite = WRITES.has(name) && !PER_CALL_READ.has(name);
    const isDanger = DANGER.has(name);
    let a = PROBES[name] ? Object.assign({}, PROBES[name]) : {};
    // 特征类工具的探针：拿服务树里第一个可读/可通知的特征
    if (['ble_read', 'ble_subscribe', 'ble_write'].indexOf(name) >= 0) {
      if (!svcChar) { rows.push({ name, kind: '跳过', note: '没连设备 → 没有特征可探（先 ble_connect）' }); continue; }
      a = { char: svcChar };
      if (name === 'ble_subscribe') a.on = true;
      if (name === 'ble_write') { a.data = 'AT'; a.format = 'text'; }
    }
    let expect;
    if (isDanger) {
      // 不带 confirm：必须被二次确认门拦下（无副作用）；只读模式下则应先是策略门
      expect = readOnly ? 'policy' : 'danger';
      a = {};                                              // 探针参数一律不带（危险动作不该被执行）
    } else if (isWrite && !SAFE_WRITES.has(name)) {
      if (t.required.length) {
        expect = readOnly ? 'policy' : 'invalid';           // 只读时先撞 -32007，不是 -32602
        a = {};
      } else if (!FULL) { rows.push({ name, kind: '跳过', note: '有副作用（无必填参数）→ 加 --full 才调' }); continue; }
      else expect = readOnly ? 'policy' : 'ok';
    } else {
      expect = 'ok';
    }
    const r = await callTool(name, a);
    const res = r.result;
    const err = r.error;
    const text = (res && res.content && res.content[0] && res.content[0].text) || '';
    const sc = (res && res.structuredContent) || null;

    // 判定
    let kind = '成功', note = '';
    if (err) {
      const code = err.code;
      if (expect === 'policy') {
        // 只读模式下**正确**的结果就是 -32007；执行了或报别的码才是异常
        if (code === -32007) { kind = '策略门生效（只读）'; note = '-32007'; }
        else { kind = '**只读门没拦住**'; note = '期望 -32007，实际 ' + code + ' ' + err.message; hardFail++; }
      }
      else if (expect === 'invalid' && code === -32602) { kind = '参数校验生效'; note = '-32602'; }
      else if (code === -32601) { kind = '**工具不存在**'; note = '客户端看到的就是这个'; hardFail++; }
      else if (expect === 'invalid') { kind = '**参数校验异常**'; note = '期望 -32602，实际 ' + code + ' ' + err.message; hardFail++; }
      else { kind = '协议错误'; note = code + ' ' + err.message; }
    } else if (!res) {
      kind = '**没有回执**'; hardFail++;
    } else if (expect === 'policy') {
      // ⚠️ -32007 是**工具级**失败（`result.isError`），不是 JSON-RPC 层的 error：
      // protocol.rs 只把 -32602/-32601 当协议错误，其余一律包成 isError 结果。
      // 所以这里必须先看 isError，再看"到底执行了没有"。
      if (res.isError && /-32007/.test(text)) { kind = '策略门生效（只读）'; note = '-32007'; }
      else if (res.isError) { kind = '策略门生效（只读）'; note = text.replace(/\s+/g, ' ').slice(0, 70); }
      else { kind = '**只读模式下却执行了**'; note = '写操作没被策略门拦下！'; hardFail++; }
    } else if (expect === 'danger') {
      if (res.isError && /-32006|confirm/.test(text)) { kind = '二次确认门生效'; note = '拒绝执行（正确）'; }
      else if (res.isError) { kind = '二次确认门生效'; note = text.slice(0, 60); }
      else { kind = '**危险动作没拦**'; note = '没带 confirm 却执行了！'; hardFail++; }
    } else if (expect === 'invalid') {
      kind = '**参数校验异常**'; note = '期望 -32602，实际成功：' + text.slice(0, 80); hardFail++;
    } else if (res.isError) {
      // 读工具报"前置没满足"是**正常结果**（没连串口/没连设备），如实标注而不是判失败
      kind = /-32006/.test(text) ? '前置没满足' : '失败';
      note = text.replace(/\s+/g, ' ').slice(0, 90);
      if (kind === '失败') hardFail++;
    } else {
      note = text.replace(/\s+/g, ' ').slice(0, 110);
      if (!text) { kind = '**结果没有文本摘要**'; hardFail++; }
    }
    rows.push({ name, kind, note, fields: sc ? Object.keys(sc).length : 0, text: text.length });
  }

  const pad = (s, n) => (s + ' '.repeat(Math.max(0, n - [...String(s)].length)));
  for (const r of rows) {
    console.log('  ' + pad(r.name, 20) + pad(r.kind, 14)
      + (r.fields ? '(' + r.fields + ' 字段/' + r.text + ' 字) ' : '') + (r.note || ''));
  }
  const skipped = rows.filter((r) => r.kind === '跳过').length;
  const bad = rows.filter((r) => r.kind.indexOf('**') >= 0).length;
  console.log('\n合计：' + rows.length + ' 个工具有结果，' + skipped + ' 个按安全模式跳过，'
    + bad + ' 个硬失败' + (missing.length ? '，' + missing.length + ' 个工具在应用里不存在' : ''));
  if (!FULL) console.log('（写工具用"必填缺失 / 危险动作无 confirm"探针验证，都不产生副作用；要真调加 --full）');
  if (readOnly) {
    console.log('ℹ️ 只读模式开着：写工具的探针预期是 -32007（上面标"策略门生效（只读）"的是**正常**的）。'
      + '参数校验与二次确认门本次未覆盖。');
  }
  if (missing.length) {
    console.log('ℹ️ 有 ' + missing.length + ' 个工具只在源码里：跑的是**旧构建**（重编译 + 重启应用，'
      + '客户端也要重连才会重读 tools/list）。');
  }

  // ---- 扫描链路单独跑：开扫 → 等它真扫到 → 读列表 → 停 ----
  // （用户报过"扫描结果没有返回给 MCP 客户端"，这条就是它的端到端验证）
  console.log('\n===== 扫描链路（真等结果）=====');
  const t0 = await callTool('ble_start_scan');
  console.log('  ble_start_scan  → ' + txtOf(t0));
  let found = 0, listText = '';
  for (let i = 0; i < 6; i++) {
    await sleep(2000);
    const r = await callTool('ble_list_devices');
    const sc = (r.result && r.result.structuredContent) || {};
    listText = txtOf(r);
    found = sc.total || 0;
    if (found) break;
  }
  console.log('  ble_list_devices → total=' + found + '  ' + listText.slice(0, 200));
  const t9 = await callTool('ble_stop_scan');
  console.log('  ble_stop_scan   → ' + txtOf(t9));
  if (!found) {
    console.log('  ℹ️ 这段时间没扫到设备：可能它不广播（被 Windows 配对过 / 被别的主机连走 →');
    console.log('     用 ble_connect + addr 按 MAC 直连），也可能确实不在范围内。');
  }
  if (listText.indexOf('-32601') >= 0) hardFail++;
  process.exit(hardFail || missing.length ? 1 : 0);
})().catch((e) => { console.error('自检本身出错:', e); process.exit(2); });
