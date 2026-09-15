// 生成 doc/MCP_TOOLS.md：工具名/描述/入参**逐字取自 protocol.rs**，返回结构取自实测抓包。
// 用法：node .walkthrough/gen_mcp_tools_doc.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'mcp', 'protocol.rs'), 'utf8');
const i = src.indexOf('pub fn tool_defs()');
const body = src.slice(i, src.indexOf('\n    ]', i));

/** 读一个 JSON 字符串字面量（honor 转义），返回 [值, 结束下标] */
function readStr(s, from) {
  const q = s.indexOf('"', from);
  let out = '';
  for (let k = q + 1; k < s.length; k++) {
    const c = s[k];
    if (c === '\\') { out += s[k + 1]; k++; continue; }
    if (c === '"') return [out, k + 1];
    out += c;
  }
  throw new Error('未闭合的字符串');
}

/** 从 from 起读一个平衡的 {...}，返回 [文本, 结束下标] */
function readObj(s, from) {
  const start = s.indexOf('{', from);
  let depth = 0, inStr = false;
  for (let k = start; k < s.length; k++) {
    const c = s[k];
    if (inStr) {
      if (c === '\\') { k++; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return [s.slice(start, k + 1), k + 1]; }
  }
  throw new Error('未闭合的对象');
}

const tools = [];
let pos = 0;
for (;;) {
  const n = body.indexOf('"name": "', pos);
  if (n < 0) break;
  const [name, afterName] = readStr(body, n + 8);
  const d = body.indexOf('"description":', afterName);
  const [desc] = readStr(body, d + 14);
  const sch = body.indexOf('"inputSchema":', d);
  const [schemaText] = readObj(body, sch + 14);
  tools.push({ name, desc, schema: JSON.parse(schemaText) });
  pos = sch + 14;
}

// 逐个工具的「读/写」+「返回结构」+ 备注（返回结构取自对真实服务实调抓的 structuredContent）
const META = {
  // ===== 串口语义工具（S12）=====
  serial_get_state: ['读', '{pane, isConnected, portName, port, baud, viewMode, lineEnding, sendAs, dataBits, stopBits, parity, dtr, rts, autoScroll, autoReconnect, lineNum, timestamp, echo, terminalMode, advOpen, outputLines, outputBytes, historyCount, panes, logChannels:{rx,tx}}', '**操作串口前先调它**；省略 pane 默认 main；`logChannels` 是"收发内容去哪读"的通道名'],
  serial_select_port: ['写', '{pane, applied:[{name,ok,from,to}]}', '值必须是 serial_list_ports 里的端口名；给错 → 协议级 `-32602` 并**回列真实可选值**（来自界面下拉的选项），照着改就行'],
  serial_set_baud: ['写', '同上', '110..4000000；越界报 -32602'],
  serial_set_frame: ['写', '同上', 'dataBits/stopBits/parity 至少给一个；**连接中改帧格式无效**，先 serial_close'],
  serial_set_lines: ['写', '同上', 'dtr/rts 布尔；常用于让目标板复位或进下载模式'],
  serial_set_display: ['写', '同上', 'viewMode/lineEnding/echo/lineNum/timestamp/**autoScroll(自动滚动)**/autoReconnect/terminalMode/advOpen；**serial_get_state 报出来的每个开关这里都能设**（断言集里有一条守着这条对称性）'],
  serial_open: ['写', '{pane, connected:true, state:{…}}', '**会等最多 6 秒确认真连上**；失败 → isError:true（-32006）并给出可能原因，不是乐观返回'],
  serial_close: ['写', '{pane, connected:false, state:{…}}', '会等最多 3 秒确认已断开'],
  serial_send: ['写', '{pane, sent:true, mode, bytes, data}', '需要该分栏已在监控中；mode=hex 时 data 按十六进制解析；lineEnding 会**留在界面上**（不是临时覆盖）'],
  serial_clear: ['写', '{pane, cleared:true, outputLines}', '**只清界面**，不动磁盘会话日志缓存'],
  serial_get_history: ['读', '{pane, total, items:[…]}', '最近的在前'],
  serial_get_output: ['读', '{pane, direction, isConnected, channels:{rx,tx}, count, items:[{seq,ts,dir,text,bytes}], truncated, note?}', '**串口监视器的核心：读设备回了什么**。默认收+发按时间归并；数据与 `log_tail` 同一份存储，但**不需要你知道通道名**，且"还没收到数据"返回空列表 + note 而不是报错'],
  // ===== BLE 语义（第一批：状态 + 从机）=====
  ble_get_state: ['读', '{scanning, deviceCount, selected, connected, addr, connName, serviceCount, notifySubs, logCount, monitorOpen}', '**操作蓝牙前先调它**；只反映面板内存里的状态，不会去碰适配器'],
  ble_list_devices: ['读', '{scanning, total, devices:[{mac,name,rssi,paired,selected}], selected, note?}', '**只列已扫到的**（不触发扫描）。空列表时 `note` 会说该先做什么（`ble_start_scan`）；RSSI 是负数，越接近 0 越强'],
  ble_start_scan: ['写', '{scanning, seconds, deviceCount}', '走面板那颗「开始/停止扫描」按钮的同一路径；按面板上设的时长自动停止，扫完用 `ble_list_devices` 取结果'],
  ble_stop_scan: ['写', '{scanning:false, deviceCount}', '同上：复用同一颗按钮的路径'],
  ble_get_services: ['读', '{connected, addr, serviceCount, services:[{uuid,name,chars:[{uuid,props,descs}]}]}', '**取的是面板已经拉到的那份服务树**（不会重新去问设备）；还没连设备时 `note` 会说明'],  ble_periph_status: ['读', '{advertising, serviceUuid, chars, discoverable, connectable, manualReply, warning?}', '**关键**：`advertising=false` 表示"服务建好了但没在广播"（蓝牙关着/不支持外设角色时 `warning` 会给真实原因），别把它当成功'],
  ble_periph_start: ['写⚠️', '{pane, started, advertising, serviceUuid, warning?}', '**危险动作：对外广播**（附近设备都能看到并连上来）。必须带 `confirm:true`，否则不执行并回 `-32006`；用的是面板上已配置好的服务/特征'],
  ble_periph_stop: ['写⚠️', '{pane, started, advertising, serviceUuid, warning?}', '**危险动作**：停掉对外广播（已连上来的中心设备会断开）。必须带 `confirm:true`'],
  mcp_danger: ['读', '{tools:[{name, consequence, confirm}], total, note}', '危险工具清单（会对外产生不可撤销影响的那些）。**先问后果再确认**：不带 confirm 调用它们不会执行'],  serial_quick_cmd: ['读', '{pane, items:[{index,label,value,seq,delayMs,hex}], usable, file, source}', '不带 index 只列；带 index 才执行（→ {pane, ran, label, value, hex}）。`seq`/`delayMs`/`hex` 是**每条自己的发送参数**（顺序号 > 0 才进面板上的「循环发送」列表，`delayMs` 默认 1000，`hex` 默认关闭）；`source=file` 表示这个列表来自外部文件（面板里增删改会写回该文件），`file` 是它的路径；`source=config` 才是纯配置里的列表'],
  app_info: ['读', '`{name, version, profile, os, arch, pid, uptimeSecs}`', ''],
  mcp_status: ['读', '打码后的服务器状态：`running/enabled/host/port/tokenMasked/sessions/statusEmits/readOnly/requests/dropped/toolCalls/registry/logHub/errorReports/callLog/limits/version/uptimeSecs`', '**不含 token 与完整 URL**（`urlMasked` 只在服务器通过界面启动、确实绑定了端口时出现）；`statusEmits` 是"往前端推过多少次状态"，用来判断界面上的会话数是不是在更新；**`readOnly` 必须先看** —— 为 true 时所有写操作会被拒（-32007）'],
  mcp_limits: ['读', '`{maxSessions, sessionQueue, heartbeatSecs, maxBodyBytes, maxUiSetItems, maxSendChars, toolsPage, idleTimeoutSecs, rateLimitPerMin, protocolVersion, protocolFallback, logMaxLineBytes, logTotalCapBytes, logMaxChannels, maxQuickCmdItems, maxQuickCmdLabelChars, maxQuickCmdValueChars, maxQuickCmdFileBytes}`', '用来判断会不会被限流/丢弃；**加新工具时这里也该有对应的一条上限**'],
  serial_list_ports: ['读', '`{count, ports:[{portName, friendlyName, productName}]}`', '不会打开端口；**端口名在 `portName`**（字段一律驼峰，别去猜 `port_name`）'],
  ui_list: ['读', '`{total, controls:[{path, kind, panel, group, label, enabled, disabledReason, value?, options?}], nextCursor?}`', '`enabled=false` 时 `disabledReason` 会说明原因（如"串口未连接"）；建议先枚举再操作'],
  ui_describe: ['读', '`{…控件公开字段…, description, inputSchema}`', '等于"这个控件怎么用"的说明书'],
  ui_get: ['读', '`{path, value, enabled, disabledReason}`', ''],
  ui_set: ['写', '`{results:[{path, ok, notFound?, error?, from?, to?}], effects:[{path, from, to}]}`（**单目标失败时不会有这个结构**：整个调用直接失败）', '**会真的改界面**；支持批量 `items:[{path,value}]`（整批一次回执）；只给一个 `path`/`value` 时按**单目标语义**——失败即整次调用失败（路径不存在 → `-32602`；控件被禁用 → `isError`+`-32006`）'],
  ui_get_state: ['读', '当前会话配置快照（与界面「保存配置」同一份真源）', ''],
  ui_click: ['写', '`{results:[{path, ok, notFound?, error?}], effects:[…]}`（**单目标失败时不会有这个结构**：整个调用直接失败）', '**会真的点下去**（例如"开始监控"）；用于 setter 够不到的动作；点击不存在/不可用的控件 → `-32602` / `isError`+`-32006`，**不会**假装成功'],
  log_channels: ['读', '`{enabled, channelCount, channels:[{channel, lines, bytes, capBytes, seqFrom, seqTo, dropped, lastTs}], totalBytes, totalCapBytes, maxChannels, lockSkips, channelSkips, reclaims, reclaimedBytes}`', '不确定去哪找日志时先调它'],
  log_tail: ['读', '`{channel, lines:[{seq, ts, level, dir, text, rawBytes}], returned, dropped, seqTo, mayBeIncomplete, truncated}`', '给了 `sinceSeq` 就是增量拉取（旧拼写 `since_seq` 也认）；`mayBeIncomplete=true` 表示该通道丢过最旧的行'],
  log_search: ['读', '`{pattern, regex, scanned, hits:[{channel, seq, ts, level, text}], truncated}`', '不给 `channel` 就搜所有通道'],
  log_stats: ['读', '`{enabled, channels:[{channel, lines, bytes, dropped, warnOrError, spanSecs, linesPerSec}], totalBytes, totalCapBytes, maxChannels, lockSkips, channelSkips, reclaims, reclaimedBytes}`', '用来判断"是不是在刷屏"'],
  log_clear: ['写', '`{clearedChannels, channel}`', '省略 `channel` 清全部；**通道名不存在会报 -32602**（不静默成功）；清空后通道仍在，`log_tail` 返回 0 行而不是报错'],
  log_export: ['读', '`{channels, lines, text, truncated}`', '只返回文本，不写文件'],
  mcp_calls: ['读', '`{calls:[{seq, ts, session, tool, args, ok, error, durationMs, effects}], returned, file, enabled, note}`', '返回值默认不记（`includeResults` 打开才记）；只读文件尾部窗口'],
  mcp_stats: ['读', '`{callLog:{totalCalls, seq, dropped, byTool, firstAt, lastAt, settings, enabled, file, fileBytes}, sessionToolCalls:{工具名: 次数}}`', ''],
  mcp_config_get: ['读', '`{server:{host, port, tokenMasked, …}, callLog:{…}, expose:{autoControlTools, namespaces, readOnly}, version}`', 'token 打码；`expose.readOnly` 是只读（沙箱）模式的开关状态'],
  mcp_config_set: ['写', '`{applied:[生效的键路径], needRestart:bool}`', '只接受 `server` / `callLog` 两类键；**不接受改 token**；`host` 只允许回环；改 `server.*` 只保存，需在界面关闭再启用才生效'],
};

const GROUPS = [
  ['串口语义工具（**优先用这些**，比 ui_* 通用桥更准）', ['serial_get_state', 'serial_select_port', 'serial_set_baud', 'serial_set_frame', 'serial_set_lines', 'serial_set_display', 'serial_open', 'serial_close', 'serial_send', 'serial_clear', 'serial_get_history', 'serial_get_output', 'serial_quick_cmd']],
  ['蓝牙语义工具（BLE）', ['ble_get_state', 'ble_list_devices', 'ble_start_scan', 'ble_stop_scan', 'ble_get_services',
                    'ble_periph_status', 'ble_periph_start', 'ble_periph_stop']],
  ['安全与策略', ['mcp_danger']],
  ['应用与服务器', ['app_info', 'mcp_status', 'mcp_limits', 'serial_list_ports']],
  ['界面操作（走合成 DOM 事件，和用户点击同一条路径）', ['ui_list', 'ui_describe', 'ui_get', 'ui_set', 'ui_click', 'ui_get_state']],
  ['日志中心', ['log_channels', 'log_tail', 'log_search', 'log_stats', 'log_clear', 'log_export']],
  ['调用记录与配置', ['mcp_calls', 'mcp_stats', 'mcp_config_get', 'mcp_config_set']],
];

function params(schema) {
  const props = schema.properties || {};
  const req = new Set(schema.required || []);
  const keys = Object.keys(props);
  if (!keys.length) return '无（不需要参数）';
  const rows = keys.map((k) => {
    const p = props[k];
    const t = p.type === 'array' ? 'array&lt;' + ((p.items && p.items.type) || '') + '&gt;'
      : p.type === 'object' ? 'object' : (p.type || 'any');
    let extra = '';
    if (p.enum) extra = '枚举：' + p.enum.map((x) => '`' + x + '`').join(' / ');
    if (p.default !== undefined) extra = (extra ? extra + ' ' : '') + '默认 `' + JSON.stringify(p.default) + '`';
    if (p.description) extra = (extra ? extra + ' ' : '') + p.description;
    return '| `' + k + '` | ' + t + ' | ' + (req.has(k) ? '**是**' : '否') + ' | ' + extra + ' |';
  });
  return ['| 参数 | 类型 | 必填 | 说明 |', '|---|---|---|---|', ...rows].join('\n');
}

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

let md = '';
md += '# MCP 工具参考\n\n';
md += '> 本页的工具名 / 描述 / 入参**逐字取自** `src-tauri/src/mcp/protocol.rs` 的 `tool_defs()`；\n';
md += '> 「返回」列是对着**真实运行的服务**实调一遍抓下来的 `structuredContent` 结构，不是照记忆写的。\n';
md += '> 上手步骤见 [MCP.md](./MCP.md)，设计与取舍见 [MCP_DESIGN.md](./MCP_DESIGN.md)。\n\n';
md += '> **字段命名**：参数与返回**一律 camelCase**（`portName` / `sinceSeq` / `maxLinesPerChannel`）。\n';
md += '> 有四个参数历史上写成了蛇形，**旧拼写仍然认**（`since_seq` / `case_sensitive` / `max_lines_per_channel` / `ok_only`）——\n';
md += '> 直接改名会让按旧写法调用的人**静默失效**，那比报错更危险。\n\n';
md += '⚠️ 返回结构里**没有**的字段就是真的没有（例如串口项只有 `portName / friendlyName / productName`，没有 VID/PID）。\n';
md += '⚠️ 很多客户端只把 `content[].text` 给模型看，所以**摘要必须把数据说出来**（`serial_list_ports` 的文本里就带着端口名）。\n\n';

md += '## 1. 怎么连\n\n';
md += '| | |\n|---|---|\n';
md += '| 传输 | **只有 SSE**（HTTP+SSE）。没有 Streamable HTTP，因此只支持 Streamable HTTP 的客户端连不上 |\n';
md += '| 端点 | `GET /sse`（建立会话，首帧下发 `event: endpoint`）→ `POST /messages?sessionId=…`（发 JSON-RPC，结果从 SSE 流回）|\n';
md += '| 鉴权 | 每个请求都要带 token：`?token=…` 或 `Authorization: Bearer …`；`GET /healthz` 是唯一免鉴权端点，只回 `{"ok":true}` |\n';
md += '| 监听 | **只监听回环**（`127.0.0.1` / `::1` / `localhost`），不对外网/局域网开放 |\n';
md += '| 握手顺序 | 客户端必须先 `GET /sse` 拿到 endpoint，再 `POST` `initialize` → `notifications/initialized` → `tools/list` |\n';
md += '| 地址从哪来 | 程序弹窗里的「连接 URL」，或 `%APPDATA%\\seahi-serial\\mcp-endpoint.json` |\n\n';

md += '## 2. 怎么拿工具列表\n\n';
md += '- 运行时：`tools/list`（分页，每页 50，用 `nextCursor` 翻页）——这是**权威来源**，本页只是它的可读版本。\n';
md += '- `mcp_limits` / `mcp_status` 里的 `toolCount` / `builtinToolCount` 能看到数量。\n';
md += '- 内置工具 **' + tools.length + ' 个**；另有可选的 `ctl_*`（见 §4）。\n\n';

md += '## 3. 一页速查\n\n';
md += '| 工具 | 读/写 | 作用 |\n|---|---|---|\n';
for (const [, names] of GROUPS) {
  for (const n of names) {
    const t = byName[n];
    const rw = (META[n] || ['?'])[0];
    md += '| [`' + n + '`](#' + n.replace(/_/g, '-') + ') | ' + (rw === '写' ? '**写**' : '读') + ' | ' + t.desc + ' |\n';
  }
}
md += '\n> 「写」= 会改变程序状态（界面 / 日志缓存 / AI 配置）。AI 调用这些工具时请先确认意图。\n';
md += '> **只读（沙箱）模式**：用户在弹窗里打开后，上表所有「写」工具一律被拒（错误码 `-32007`，且**没有执行** —— 界面与配置文件一个字都不变）。\n';
md += '> 注意这个不对称是故意的：`mcp_config_set` 自己也是写工具，所以 **AI 只能打开只读模式、关不掉它**，要关必须由用户在弹窗里点。\n\n';

md += '## 4. 逐个工具\n\n';
for (const [groupName, names] of GROUPS) {
  md += '### ' + groupName + '\n\n';
  for (const n of names) {
    const t = byName[n];
    const [rw, ret, note] = META[n] || ['?', '', ''];
    md += '#### `' + n + '`\n\n';
    md += '- **作用**：' + t.desc + '\n';
    md += '- **读/写**：' + (rw === '写' ? '**写**（会改状态）' : '只读，无副作用') + '\n';
    md += '- **返回**：' + ret + '\n';
    if (note) md += '- **注意**：' + note + '\n';
    md += '\n**入参**\n\n' + params(t.schema) + '\n\n';
  }
}

md += '## 5. `ctl_*`：把每个界面控件都变成一个工具（可选）\n\n';
md += '默认**关闭**。打开 `expose.autoControlTools` 后，程序启动时会扫描界面上所有按钮 / 输入框 / 下拉框，\n';
md += '为每个控件生成一个 `ctl_*` 工具：\n\n';
md += '| | |\n|---|---|\n';
md += '| 命名 | `ctl_` + 控件路径清洗（非字母数字转 `_`），总长 ≤ 64 字符，撞名加序号 |\n';
md += '| 路径 | `<面板>.<分组>.<控件名>`，如 `serial.conn.portSelect`；面板 ∈ `serial` / `wsl` / `adb` / `ble` / `global` |\n';
md += '| 入参 | 按控件类型派生：开关→`boolean`、数字输入→`number`、下拉→`enum`（**选项就是下拉里的真实选项**）|\n';
md += '| 不可用 | 控件当前不可用时，**原因写进工具描述**（如"串口未连接"），AI 不用盲试 |\n';
md += '| 上限 | 单次最多 400 个 `ctl_*`；`namespaces` 可只暴露某些面板 |\n';
md += '| 工具列表变化 | 控件增减时会推 `notifications/tools/list_changed`，客户端不必重连 |\n\n';
md += '> 为什么默认关闭：几百个工具会明显拖累模型选工具的准确率（见 `MCP_DESIGN.md` §5.6 D2）。\n';
md += '> 想按需使用：平时用 `ui_list` / `ui_get` / `ui_set`（按路径操作，只有 6 个工具），需要"每个控件一个工具"时再打开。\n\n';

md += '## 6. 错误语义\n\n';
md += '| 情况 | 表现 |\n|---|---|\n';
md += '| 参数错误（缺必填 / 类型错 / 不存在的控件路径 / **取值不在可选集里**（如端口名给错）/ 不存在的日志通道 / 非法正则 / 未知工具名） | JSON-RPC `error.code = -32602`（`E_INVALID_PARAMS`）|\n';
md += '| 工具执行失败（控件被禁用、**前置状态没满足**（如没开监控就发数据）、写盘失败…） | 正常 `result` + `isError: true`，原因在文本内容里（**不是** JSON-RPC error）|\n';
md += '| 没有界面上下文（服务器脱离 GUI 跑，只有开发/测试会遇到） | `isError: true`，文本为 `错误 -32006: MCP 服务器没有界面上下文` |\n';
md += '| 前端桥超时（界面 5 秒没回执） | `-32004`（`E_UI_TIMEOUT`）|\n';
md += '| 前端桥在途请求过多 | `-32005`（`E_UI_BUSY`）|\n';
md += '| 超过 60 次/分 | `-32000`（`E_RATE_LIMITED`）|\n';
md += '| 工具内部 panic | `-32603`，消息里写明"已上报"；连接**不会**被打死，且会上报错误库 |\n';
md += '| token 不对 / 缺失 | HTTP 401（不是 JSON-RPC 层）|\n\n';

md += '## 7. 上限与安全边界\n\n';
md += '| 项 | 值 |\n|---|---|\n';
md += '| 同时会话数 | 4（客户端断开**立刻**回收，不等空闲超时）|\n';
md += '| 每会话出站队列 / 心跳 / 空闲回收 / 限流 | 256 条丢最旧 · 15s · 30 分钟 · 60 次/分 |\n';
md += '| 请求体上限 | 1 MiB |\n';
md += '| `ui_set` 单次 items | **200**（超了 -32602；这条链路跑在界面主线程上）|\n';
md += '| `serial_send` 单次字符数 | **64K**（超了 -32602；串口写是排队的）|\n';
md += '| 工具列表每页 | 50 |\n';
md += '| `ctl_*` 上限 | 400 |\n';
md += '| 日志单条 / 每通道 / 总量 / 通道数 | 8 KiB 截断 · 128 KiB~1 MiB · 16 MiB（超了裁最大通道）· 64 个 |\n';
md += '| 桥回执超时 / 在途上限 | 5 秒 · 32 |\n\n';
md += '安全边界：\n\n';
md += '1. **只监听回环**，`server.host` 只接受 `127.0.0.1`/`::1`/`localhost`；\n';
md += '2. 必须带 token；`/healthz` 是唯一免鉴权端点且只回 `{"ok":true}`；`/status` 需 token 且**不回显 token 与完整 URL**；\n';
md += '3. **工具不能改 token**（必须在界面点「重置令牌」）；\n';
md += '4. AI 记录写独立的 `ai-calls.jsonl`，**用户配置 `config.json` 里不会出现任何 AI 痕迹**；\n';
md += '5. 运行期错误走程序既有的错误上报（LogHub → 本地日志 → Sentry/自建服务），**上报前 token 打码**，同类错误 5 分钟只报一次；\n';
md += '6. **MCP 的运行不得拖慢主程序**：串口收发热路径上只有一次非阻塞的日志旁路（`try_lock`，拿不到锁就丢并计数），上报走独立线程的 channel，SSE 出站是「有界队列 + `try_send`」（生产者绝不阻塞，慢客户端直接断开），界面命令有在途上限（32）与超时（5s），**所有外部输入都有上限**（见上表）。\n\n';

md += '## 8. 手测示例（curl）\n\n';
md += '```bash\n';
md += '# 1) 探活（不需要 token）\n';
md += 'curl.exe -i http://127.0.0.1:7777/healthz\n\n';
md += '# 2) 建 SSE 会话，看首帧 endpoint（-N 关缓冲；这个连接要一直挂着）\n';
md += 'curl.exe -N "http://127.0.0.1:7777/sse?token=<TOKEN>"\n';
md += '#   event: endpoint\n';
md += '#   data: /messages?sessionId=<SID>&token=<TOKEN>\n\n';
md += '# 3) 另开一个窗口，往上面那个 SID 发 JSON-RPC\n';
md += 'curl.exe -i -X POST "http://127.0.0.1:7777/messages?sessionId=<SID>&token=<TOKEN>" \\\n';
md += '  -H "Content-Type: application/json" \\\n';
md += '  -d \'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"curl"}}}\'\n';
md += '#   期望 HTTP 202；结果从第 2 步的 SSE 流里出来\n\n';
md += '# 4) 列工具（同样 202，结果从 SSE 流回）\n';
md += 'curl.exe -i -X POST "http://127.0.0.1:7777/messages?sessionId=<SID>&token=<TOKEN>" \\\n';
md += '  -H "Content-Type: application/json" \\\n';
md += '  -d \'{"jsonrpc":"2.0","id":2,"method":"tools/list"}\'\n\n';
md += '# 5) 调一个只读工具\n';
md += 'curl.exe -i -X POST "http://127.0.0.1:7777/messages?sessionId=<SID>&token=<TOKEN>" \\\n';
md += '  -H "Content-Type: application/json" \\\n';
md += '  -d \'{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"app_info"}}\'\n';
md += '```\n\n';

md += '## 9. 本页怎么校对\n\n';
md += '页面里的工具清单可以直接和运行中的服务器对账：\n\n';
md += '```bash\n';
md += '# 起一个自带 3 个假控件、固定 token=testtoken 的联调服务器（127.0.0.1:7799）\n';
md += 'cargo test --manifest-path src-tauri/Cargo.toml mcp_serve_for_manual_check -- --ignored --nocapture\n\n';
md += '# 另开窗口，用任意 MCP 客户端（SDK / curl）列一下 tools/list，与本页 §4 逐个核对\n';
md += '```\n\n';
md += '本文档由 `node .walkthrough/gen_mcp_tools_doc.js` 生成（工具名/描述/入参直接读 `protocol.rs`，\n';
md += '所以改了工具定义后重跑一次就不会漂）。断言集里有一条守着"本页必须列出全部内置工具名"。\n';

fs.writeFileSync(path.join(root, 'doc', 'MCP_TOOLS.md'), md);
console.log('已生成 doc/MCP_TOOLS.md');
console.log('解析到工具 ' + tools.length + ' 个：' + tools.map((t) => t.name).join(', '));
const missing = tools.filter((t) => !META[t.name]);
if (missing.length) console.log('!! 缺 META（返回结构）的工具：' + missing.map((t) => t.name).join(', '));
