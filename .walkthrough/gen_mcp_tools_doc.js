// 生成 doc/MCP_TOOLS.md：工具名/描述/入参**逐字取自 protocol.rs**，返回结构取自实测抓包。
// 用法：node .walkthrough/gen_mcp_tools_doc.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'mcp', 'protocol.rs'), 'utf8');
const i = src.indexOf('pub fn tool_defs()');
const body = src.slice(i, src.indexOf('\n    ]', i));

/**
 * `pub const XXX: &str = "…";` 的表。
 *
 * 为什么要这一步：schema 里可能引用 Rust 常量（如 `PANE_DESC`）而不是直接写字符串 ——
 * 那是 `json!` 宏里的**表达式**，抽出来的文本不是合法 JSON，`JSON.parse` 会直接抛。
 * 也就是说"把重复的文案抽成常量"这个正常重构会把文档生成器搞挂（13 个串口工具共用
 * `pane` 描述时就这么踩了一次）。这里先把常量读出来、再把引用换回字面量。
 * 只认 `&str`（数值常量与 `&[&str]` 与 schema 无关）。
 */
const consts = {};
for (const m of src.matchAll(/pub const ([A-Z][A-Z0-9_]*): &str =\s*"((?:[^"\\]|\\.)*)";/g)) {
  consts[m[1]] = m[2];
}

/** 把 schema 文本里"字符串之外"的已知常量引用替换成它的字面量（JSON 转义过） */
function resolveConsts(text) {
  let out = '', k = 0, inStr = false;
  while (k < text.length) {
    const c = text[k];
    if (inStr) {
      out += c;
      if (c === '\\') { out += text[k + 1] || ''; k += 2; continue; }
      if (c === '"') inStr = false;
      k++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; k++; continue; }
    const m = /^[A-Z][A-Z0-9_]*/.exec(text.slice(k));
    if (m && consts[m[0]] !== undefined) {
      out += JSON.stringify(consts[m[0]]);
      k += m[0].length;
      continue;
    }
    out += c;
    k++;
  }
  return out;
}

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
  tools.push({ name, desc, schema: JSON.parse(resolveConsts(schemaText)) });
  pos = sch + 14;
}

// 逐个工具的「读/写」+「返回结构」+ 备注（返回结构取自对真实服务实调抓的 structuredContent）
const META = {
  // ===== 串口语义工具（S12）=====
  serial_get_state: ['读', '{pane, isConnected, portName, port, baud, viewMode, lineEnding, sendAs, dataBits, stopBits, parity, dtr, rts, autoScroll, autoReconnect, lineNum, timestamp, echo, terminalMode, advOpen, outputLines, outputBytes, historyCount, panes, portOptions:[{value,label,inUse}], logChannels:{rx,tx}}', '**操作串口前先调它**；省略 pane 默认 main；`logChannels` 是"收发内容去哪读"的通道名；`portOptions` 是**这个分栏**当前能选的端口（Windows 分栏是 COM 名，WSL 分栏是 `/dev/...` 路径）——选端口前先看它'],
  serial_select_port: ['写', '{pane, applied:[{name,ok,from,to}]}', '值必须是**该分栏**端口下拉里的一个（就是 `serial_get_state` 的 `portOptions[].value`）；给错 → 协议级 `-32602` 并**回列真实可选值**，照着改就行。⚠️ 别拿 `serial_list_ports` 当依据：它只有 Windows 的 COM 口，WSL 分栏要的是 `/dev/ttyUSB0` 这类 WSL 内部路径'],
  serial_set_baud: ['写', '同上', '110..4000000；越界报 -32602'],
  serial_set_frame: ['写', '同上', 'dataBits/stopBits/parity 至少给一个；**连接中改帧格式无效**，先 serial_close'],
  serial_set_lines: ['写', '同上', 'dtr/rts 布尔；常用于让目标板复位或进下载模式'],
  serial_set_display: ['写', '同上', 'viewMode/lineEnding/echo/lineNum/timestamp/**autoScroll(自动滚动)**/autoReconnect/terminalMode/advOpen；**serial_get_state 报出来的每个开关这里都能设**（断言集里有一条守着这条对称性）'],
  serial_open: ['写', '{pane, connected:true, state:{…}}', '**会等最多 6 秒确认真连上**；失败 → isError:true（-32006）并给出可能原因，不是乐观返回'],
  serial_close: ['写', '{pane, connected:false, state:{…}}', '会等最多 3 秒确认已断开'],
  serial_send: ['写', '{pane, sent:true, mode, bytes, data}', '需要该分栏已在监控中；mode=hex 时 data 按十六进制解析；lineEnding 会**留在界面上**（不是临时覆盖）'],
  serial_clear: ['写', '{pane, cleared:true, outputLines}', '**只清界面**，不动磁盘会话日志缓存'],
  serial_get_history: ['读', '{pane, total, items:[…]}', '最近的在前'],
  serial_get_output: ['读', '{pane, direction, format, isConnected, channels:{rx,tx}, count, items:[{seq,ts,dir,text,bytes}], truncated, note?}（`format:"text"` 时改为 `{…, text}`，**没有再给 items**）', '**串口监视器的核心：读设备回了什么**。默认收+发按时间归并；数据与 `log_tail` 同一份存储，但**不需要你知道通道名**，且"还没收到数据"返回空列表 + note 而不是报错。**优先用 `format:"text"`**（一行一条 `[时刻] [rx|tx] 正文`，比 json 省一半以上 token；头部那行带着两通道各自的 dropped/mayBeIncomplete，正文在 content 文本里）'],
  // ===== BLE 语义（第一批：状态 + 从机）=====
  ble_get_state: ['读', '{scanning, deviceCount, selected, connected, addr, connName, serviceCount, notifySubs, logCount, monitorOpen}', '**操作蓝牙前先调它**；只反映面板内存里的状态，不会去碰适配器'],
  ble_list_devices: ['读', '{scanning, total, offset, limit, returned, hasMore, nextOffset, devices:[{mac,name,rssi,paired,selected}], selected, note?}', '**每调一次都会现问一次后端**（不是只读面板缓存）—— 刚 ble_start_scan 完立刻问也拿得到。**支持分页**：`limit` 每页几台（省略=全量）、`offset` 从第几台开始，返回里给 `hasMore`/`nextOffset` 接着翻。空列表时 `note` 会说下一步（含"设备不广播就只能按 MAC 直连"）；RSSI 是负数，越接近 0 越强'],
  ble_start_scan: ['写', '{scanning, seconds, deviceCount}', '走面板那颗「开始/停止扫描」按钮的同一路径；按面板上设的时长自动停止，扫完用 `ble_list_devices` 取结果'],
  ble_stop_scan: ['写', '{scanning:false, deviceCount}', '同上：复用同一颗按钮的路径'],
  ble_read: ['读', '{pane, uuid, action, note}', '按特征 UUID 寻址，**点的是面板上那颗读按钮**；结果随后出现在 ble_get_output 里。特征没有 read 属性时直接说清'],
  ble_subscribe: ['写', '{pane, uuid, prop, on, changed}', '开/关通知订阅（notify/indicate）。**状态已经是目标值时不会重复点**（`changed:false`）—— 否则会把用户刚打开的订阅关掉'],
  ble_write: ['写', '{pane, uuid, hex, bytes, writeType, format, lineEnding}', '**打开面板那个写入窗并点「发送」**：HEX/文本解析、行尾、写响应/无响应全用面板那套（写入窗会留在界面上）。单次最多 `maxBleWriteChars` 个字符；特征的写入方式不支持时要的错误里会把可选值列出来'],
  ble_connect: ['写', '{pane, connected, addr, name, via, serviceCount, paired?}', '`via=list`（扫描列表里点卡片连）/ `direct`（列表里没有 → 按 MAC 直连，**不依赖广播**）/ `selected`（用面板已选中的那台）。**等连接真的成功才返回**；需要配对时会弹出配对窗等用户确认'],
  ble_disconnect: ['写', '{pane, connected:false, addr, changed}', '断开后面板的服务树、订阅状态、本次会话数据日志一并清空（与点那颗「断开设备」按钮完全一样）'],
  ble_cts_time: ['读', '{field, charUuid, bytes, hex, utc, skewSecs, year, month, day, hour, minute, second, dayOfWeek, dayOfWeekName, fractions256, fractionMillis, adjustReason, adjustReasons, notes}；`field:"localTimeInfo"`（2 字节）时是 `{timeZoneQuarterHours, utcOffset, utcOffsetMinutes, dstOffset, dstName, dstOffsetMinutes, notes}`；`field:"referenceTimeInfo"`（4 字节）时是 `{timeSource, timeSourceName, timeAccuracy, accuracyMillis, accuracyName, daysSinceUpdate, hoursSinceUpdate, sinceUpdateHours, sinceUpdateText, notes}`', '把 CTS（Current Time Service 0x1805）的原始值翻译成人话 —— **纯后端工具**：不碰设备也不碰界面（读值仍走 `ble_read` → `ble_get_output`）。**按长度认字段**：`2A2B` 的 10 字节 / `2A0F` 的 2 字节 / `2A14` 的 4 字节都认；返回里 `utc`/`skewSecs` 是结论，`notes` 会主动指出可疑处（年份像 RTC 没初始化、星期与日期对不上、时钟偏了多少分钟、设备自报"未同步"）。⚠️ **设备没给出的字段回 `null`，不许猜一个具体值**（`0` 也是结论）：时区 `-128` → `utcOffset:null`、DST `0xFF` → `dstOffsetMinutes:null`、时间精度 `254/255` → `accuracyMillis:null`（`timeZoneQuarterHours`/`dstOffset`/`timeAccuracy` 保留原始字节）。单位都按规范：DST 值是 **15 分钟单位**（2=+0.5h / 4=+1h / 8=+2h）、时间精度是 **1/8 秒（125ms）步长**；越界与保留值都会写进 `notes`。'],
  ble_get_output: ['读', '{pane, count, scanned, mode, total, channels:{rx}, items:[{seq,ts,kind,hex,charUuid,descUuid,text,dim}]}（CTS 条目另有 `decoded` / `decodedSummary`）；`mode:"matches"` 时是 `hits:[{seq,ts,kind,match}]`，`mode:"count"` 时是 `total`/`totalMatches`（**都没有 items**），后两档另外带 `pattern`/`regex`', '**本次会话的蓝牙数据日志**（切设备/断开就清空）。要跨会话用 `channels.rx` 去 log_tail；`sinceSeq` 增量跟进。**要"这条 ERROR 出现几次"别拉条目**：给 `pattern` + `mode`（`count` 只回计数、`matches` 只回片段）；匹配的文本取 `text`，`text` 为空时取 `hex`（HEX 通知也搜得到）。⚠️ **CTS 的时间条目会自动带上解读**（`items[].decoded` + `items[].decodedSummary`），不用再把这些 HEX 喂给 `ble_cts_time`；判据是特征短号 `2a2b`/`2a0f` 且长度正好对得上 —— **描述符的值不解读**（CCCD 也是 2 字节，解出来会说一个错的时区）'],
  ble_refresh_rssi: ['读', '{addr, rssi, raw}', '只问一次射频、不改状态；没连设备时直接报"先连上"'],
  ble_get_services: ['读', '{connected, addr, serviceCount, services:[{uuid,name,chars:[{uuid,props,descs}]}]}', '**取的是面板已经拉到的那份服务树**（不会重新去问设备）；还没连设备时 `note` 会说明'],
  // ⚠️ BLE **从机**（外设）的三个工具已于 2026-09 删除：本机适配器自报支持外设角色，
  // 但实测广播起不来（Aborted），整条方向下线。客户端拿旧名字调过来会得到"已删除 + 还能用什么"的 -32602。
  mcp_danger: ['读', '{tools:[{name, consequence, confirm}], total, note}', '危险工具清单（会对外产生不可撤销影响的那些）。**先问后果再确认**：不带 confirm 调用它们不会执行'],
  // ===== ADB 语义（§16.6.2 第三批的 ADB 部分）=====
  adb_list_devices: ['读', '{total, ready, devices:[{serial,state,model,product}], note?}', '**只有 `state=device` 的那台可用**（`unauthorized` 表示设备上还没点「允许 USB 调试」）。读的是 `adb devices -l` 的实时结果（与面板那颗「刷新」同一个命令），不吃面板 5 秒轮询的空窗'],
  adb_open_shell: ['写⚠️', '{serial, opened, cols, rows, note?}', '**危险动作**（开出来之后就能在设备上执行任意命令），必须带 `confirm:true`，否则不执行并回 `-32006`。开之前先确认设备 `state=device`（`serial` 省略=用第一台可用的）；**等 PTY 真的建出来才返回**（最长 10 秒），失败会如实说清是"这台机器没有可用设备"还是"serial 不存在"'],
  adb_shell_write: ['写⚠️', '{serial, written, bytes, data}', '**危险动作**（写进去的内容会被设备真的执行），必须带 `confirm:true`。命令要自己带 `\\n`，不带只是填在命令行上；单次最多 `maxAdbWriteChars` 个字符（超了 -32602）。走的就是面板终端敲键盘那条命令'],
  adb_shell_read: ['读', '{serial, channel, count, scanned, mode, items:[{seq,ts,level,dir,bytes,text}], truncated, dropped, mayBeIncomplete, note?}；`mode:"matches"` 时是 `hits:[{seq,ts,level,dir,match}]`，`mode:"count"` 时是 `total`/`totalMatches`（**都没有 items**），后两档另外带 `pattern`/`regex`', '读日志中心 `adb:rx` —— PTY 读线程在**生产端**旁路的一份副本（**不会抢走界面终端要显示的队列**）。`items` 是 PTY 的**输出块**、不是按行切好的文本；`truncated=true` 表示凑满了一页（还有更多，用 `sinceSeq` 接着拉）；`mayBeIncomplete=true` 表示通道丢过最旧的行。**`logcat` 刷屏时先给 `pattern` + `mode`**：`count` 只回"命中多少块/多少处"（几十 token），`matches` 只回片段。**纯后端工具，没有界面也能用**'],
  adb_shell_resize: ['写', '{serial, cols, rows, note?}', '`cols` / `rows` 都是 **2~1000**（`maxAdbCols` / `maxAdbRows`），越界或 0/1 → -32602。注意面板自己的尺寸同步（窗口/容器变化时）可能随后把 PTY 改回真实容器尺寸'],
  adb_close_shell: ['写', '{serial, opened:false, closed, note?}', '关掉当前会话（kill `adb shell` 子进程 + 移除终端）；本来就没开会话时是幂等的（`closed:false` + `note`），不是错误'],
  serial_quick_cmd: ['读', '{pane, items:[{index,label,value,seq,timeoutMs,expect,retry,okGoto,errGoto,hex}], usable, file, source}', '不带 index 只列；带 index 才执行（→ {pane, ran, label, value, hex}）。`seq`/`timeoutMs`/`expect`/`retry`/`okGoto`/`errGoto`/`hex` 是**每条自己的等待参数**（顺序号 > 0 才进面板上的「循环发送」列表；`timeoutMs` = 这条发出去最多等多久、缺省 3000、**填 0 = 这条不等响应**；`expect` = 追加的成功词（`|` 分隔）、`retry` = 收到 ERROR 后重发几次、缺省 3；**`okGoto`/`errGoto` = 跳转**：收到 OK 走前者、ERROR 用尽**或超时**走后者，取值 `留空`/`下一条`（缺省）/ 数字=顺序号 / `结束` —— 这就是"分支与循环"）；除 `timeoutMs` 外这几项**面板上都没有入口**，写在指令文件的同名列里；add/update 也收 `delayMs`（**旧拼写**，与 `timeoutMs` 同值）；`source=file` 表示这个列表来自外部文件（面板里增删改会写回该文件），`file` 是它的路径；`source=config` 才是纯配置里的列表'],
  // 按 action 判读写：省略/`list` 是读，`add`/`update`/`remove` 是写（所以这一列写「读/写」而不是「写」，
  // 否则会和 Rust 的 WRITE_TOOLS 对不上 —— 它同样不在那张表里，只读模式是按调用拦的）
  serial_workflow: ['读/写', '{pane, count, runningCount, rules:[{id,name,enabled,running,conditions,actions,domIds}], limits}', '串口/WSL 分栏的**自动化工作流规则**（面板「更多设置 → 工作流」）：收到匹配数据就自动执行动作。省略 action = 列出；`action=add|update|remove` 改规则（走的就是面板改的同一条路，立刻写进配置）。⚠️ 新规则**一律 running=false**；`running:true` 这里会被拒（-32602）—— 让规则跑起来必须用 `serial_workflow_run`（带确认门）。规则一旦 running，**收到匹配数据就会自动往设备发数据**'],
  serial_workflow_run: ['写⚠️', '{pane, rule, running, changed}', '开始/停止一条工作流规则的运行（`running`）。**危险动作**（开始之后规则会自动往设备发数据、动作里可能还有存日志文件），必须带 `confirm:true`，否则不执行并回 `-32006`。`rule` 是规则 id（见 `serial_workflow` 的 `rules[].id`），`on` 省略 = true'],
  app_info: ['读', '`{name, version, profile, os, arch, pid, uptimeSecs}`', ''],
  mcp_status: ['读', '打码后的服务器状态：`running/enabled/host/port/streamableHttp/tokenMasked/sessions/statusEmits/readOnly/requests/dropped/toolCalls/registry/logHub/errorReports/callLog/limits/version/uptimeSecs`', '**不含 token 与完整 URL**（`urlMasked` 与 `streamableUrlMasked` 只在服务器通过界面启动、确实绑定了端口时出现；**两条 URL 都打码**）；`streamableHttp` 为 false 时 `/mcp` 返回 404、只剩遗留 SSE；`statusEmits` 是"往前端推过多少次状态"，用来判断界面上的会话数是不是在更新；**`readOnly` 必须先看** —— 为 true 时所有写操作会被拒（-32007）'],
  mcp_limits: ['读', '`{maxSessions, sessionQueue, heartbeatSecs, maxBodyBytes, maxUiSetItems, maxSendChars, toolsPage, idleTimeoutSecs, rateLimitPerMin, protocolVersion, protocolFallback, logMaxLineBytes, logTotalCapBytes, logMaxChannels, maxQuickCmdItems, maxQuickCmdLabelChars, maxQuickCmdValueChars, maxQuickCmdFileBytes, maxQuickCmdTimeoutMs, maxQuickCmdRetry, maxQuickCmdExpectChars, maxBleWriteChars, maxAdbWriteChars, maxAdbCols, maxAdbRows, maxAdbReadLines}`', '用来判断会不会被限流/丢弃；**加新工具时这里也该有对应的一条上限**。注意"报出来"≠"被执行"：这几个数各自都有代码里真的拦一道（快速指令的 `maxQuickCmdTimeoutMs`/`maxQuickCmdRetry`/`maxQuickCmdExpectChars` 就是在碰界面之前校验的）'],
  serial_list_ports: ['读', '`{count, ports:[{portName, friendlyName, productName}]}`', '不会打开端口；**端口名在 `portName`**（字段一律驼峰，别去猜 `port_name`）。⚠️ **只列 Windows 侧的 COM 口** —— WSL 分栏的端口是 WSL 内部的 `/dev/...`，不在这里（用 `serial_get_state` 的 `portOptions`）'],
  ui_list: ['读', '`{total, controls:[{path, kind, panel, group, label, enabled, disabledReason, value?, options?}], nextCursor?}`', '`enabled=false` 时 `disabledReason` 会说明原因（如"串口未连接"）；建议先枚举再操作'],
  ui_describe: ['读', '`{…控件公开字段…, description, inputSchema}`', '等于"这个控件怎么用"的说明书'],
  ui_get: ['读', '`{path, value, enabled, disabledReason}`', ''],
  ui_set: ['写', '`{results:[{path, ok, notFound?, error?, from?, to?, mapRequest?}], effects:[{path, from, to}]}`（**单目标失败时不会有这个结构**：整个调用直接失败）', '**会真的改界面**；支持批量 `items:[{path,value}]`（整批一次回执）；只给一个 `path`/`value` 时按**单目标语义**——失败即整次调用失败（路径不存在 → `-32602`；控件被禁用 → `isError`+`-32006`）。⚠️ 少数动作**点了才开始跑**（典型：WSL 端口映射那个复选框要过 usbipd、还可能弹授权框等用户点）—— 那时结果里会带 `mapRequest.settled=false` + `note`：**别重试**，稍后用 `ui_get_state{section:"wslDevices"}` 看 status 是否变成 `mapped`'],
  ui_get_state: ['读', '当前会话配置快照（与界面「保存配置」同一份真源）；**两张"运行时设备表"都要从它读**：`section:"bleDevices"` = 蓝牙扫描结果全量、`section:"wslDevices"` = WSL 端口映射的 USB 设备表（`{wslRunning, targetDistro, panelOpened, count, mapped, devices:[{busid, port, name, vidpid, hasCom, status, wslPath, wslSerial, busy, mapControlPath, autoMapControlPath}], note, mapUnavailableReason}`）—— 两处的行都是**动态 div、不在控件注册表里**，只有通用桥的客户端只能从这里读；`ble` 段里另带一份前 10 台的 `scanResult`', ''],
  ui_click: ['写', '`{results:[{path, ok, notFound?, error?, mapRequest?}], effects:[…]}`（**单目标失败时不会有这个结构**：整个调用直接失败）', '**会真的点下去**（例如"开始监控"）；用于 setter 够不到的动作；点击不存在/不可用的控件 → `-32602` / `isError`+`-32006`，**不会**假装成功。⚠️ 同 `ui_set`：WSL 端口映射那种"点了才开始跑"的动作会带 `mapRequest.settled=false`，**别重试**'],
  log_channels: ['读', '`{enabled, channelCount, channels:[{channel, lines, bytes, capBytes, seqFrom, seqTo, dropped, lastTs}], totalBytes, totalCapBytes, maxChannels, lockSkips, channelSkips, reclaims, reclaimedBytes}`', '不确定去哪找日志时先调它'],
  log_tail: ['读', '`{channel, format, lines:[{seq, ts, level, dir, text, rawBytes}], returned, dropped, seqFrom, seqTo, missed, nextSinceSeq, mayBeIncomplete, truncated}`（`format:"text"` 时是 `{…, text}`，**没有再给 lines**）', '**读日志优先用 `format:"text"`**：一行一条纯文本（头部一行元信息 + `[时刻] [级别] 正文`），同样数据比 json 省一半以上 token —— 实测 200 条短行 **101 字节/行 → 29 字节/行（3.5 倍）**，行越长省得越少。增量跟进用 `sinceSeq`，并把**返回里的 `nextSinceSeq`** 当下次的入参（**别直接跳到 `seqTo`**，那会跳过 `missed` 那些行）；`missed>0` = 这一段还有行没给你（含已被裁掉的），`mayBeIncomplete=true` = 该通道丢过最旧的行。text 格式的**正文在 content 文本里**，structuredContent 只给元信息（要逐行字段就用默认 json）。渠道名见 `log_channels`'],
  log_search: ['读', '`{pattern, regex, mode, hits:[{channel, seq, ts, level, dir, text, before?, after?}], scanned, truncated}`；`mode:"matches"` 时 `hits[]` 里是 `{channel, seq, ts, level, dir, match}`（**没有整行 text**）；`mode:"count"` 时是 `{pattern, regex, mode, total, channels:[{channel, count, scanned}], scanned, scannedChannels, truncated:false}`（**没有 hits**）', '**三档按需要的信息量选**：`count` 只回计数（几十 token —— "ERROR 出现过几次""到底有没有超时"就用它）；`matches` 只回匹配片段（一行多处算多条，长行日志用它比回整行省得多）；`lines`（默认）回命中行，可配 `context` 0~5 带前后几行。不给 `channel` 就搜所有通道；`matches`/`count` 的图案同样按字面量处理（`+`/`(` 不用转义）'],
  log_stats: ['读', '`{enabled, channels:[{channel, lines, bytes, dropped, warnOrError, spanSecs, linesPerSec}], totalBytes, totalCapBytes, maxChannels, lockSkips, channelSkips, reclaims, reclaimedBytes}`', '用来判断"是不是在刷屏"'],
  log_clear: ['写', '`{clearedChannels, channel}`', '省略 `channel` 清全部；**通道名不存在会报 -32602**（不静默成功）；清空后通道仍在，`log_tail` 返回 0 行而不是报错'],
  // `log_export` 已于 2026-09 删除（用户要求）：它是唯一能把全部通道日志一次塞进返回体的工具，
  // 而返回体没有大小上限 —— 一次可能几十 MB。要看全量用 log_tail{format:"text"} 增量跟进。
  // 客户端拿旧名字调过来会得到一句"已删除 + 现在用什么"的 -32602。
  mcp_calls: ['读', '`{calls:[{seq, ts, session, tool, args, ok, error, durationMs, effects}], returned, scanned, tailOnly, file, enabled, note}`', '返回值默认不记（`includeResults` 打开才记）；只读文件尾部窗口 —— `tailOnly=true` 表示更早的记录**没被扫到**，`returned` 小于 `limit` 时别当成"历史上就这么多"（用 export 或直接读文件）'],
  mcp_stats: ['读', '`{callLog:{totalCalls, seq, dropped, byTool, firstAt, lastAt, settings, enabled, file, fileBytes}, sessionToolCalls:{工具名: 次数}}`', ''],
  mcp_config_get: ['读', '`{server:{host, port, tokenMasked, …}, callLog:{…}, expose:{autoControlTools, namespaces, readOnly}, version}`', 'token 打码；`expose.readOnly` 是只读（沙箱）模式的开关状态'],
  mcp_config_set: ['写', '`{applied:[生效的键路径], needRestart:bool}`', '只接受 `server` / `callLog` 两类键；**不接受改 token**；`host` 只允许回环；改 `server.*` 只保存，需在界面关闭再启用才生效'],
};

const GROUPS = [
  ['串口语义工具（**优先用这些**，比 ui_* 通用桥更准）', ['serial_get_state', 'serial_select_port', 'serial_set_baud', 'serial_set_frame', 'serial_set_lines', 'serial_set_display', 'serial_open', 'serial_close', 'serial_send', 'serial_clear', 'serial_get_history', 'serial_get_output', 'serial_quick_cmd', 'serial_workflow', 'serial_workflow_run']],
  ['蓝牙语义工具（BLE，**主机方向**）', ['ble_get_state', 'ble_list_devices', 'ble_start_scan', 'ble_stop_scan', 'ble_connect', 'ble_disconnect', 'ble_get_services', 'ble_read', 'ble_write', 'ble_subscribe', 'ble_get_output', 'ble_refresh_rssi', 'ble_cts_time']],
  ['ADB 语义工具（ADB shell）', ['adb_list_devices', 'adb_open_shell', 'adb_shell_write', 'adb_shell_read', 'adb_shell_resize', 'adb_close_shell']],
  ['安全与策略', ['mcp_danger']],
  ['应用与服务器', ['app_info', 'mcp_status', 'mcp_limits', 'serial_list_ports']],
  ['界面操作（走合成 DOM 事件，和用户点击同一条路径）', ['ui_list', 'ui_describe', 'ui_get', 'ui_set', 'ui_click', 'ui_get_state']],
  ['日志中心', ['log_channels', 'log_tail', 'log_search', 'log_stats', 'log_clear']],
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
md += '💡 **读日志优先用 `format:"text"`**（`log_tail` / `serial_get_output`）：一行一条纯文本，同样内容比默认 json 省一半以上 token。实测（200 条短行）：**json 101 字节/行 → text 29 字节/行，省 3.5 倍**；行越长省得越少（长行只剩 ~30%）。text 编码的正文放在 `content[].text`（**只有一份**），`structuredContent` 只给元信息，所以"省 token"不会变成"看不到日志"。\n\n';
md += '💡 **要"有没有 / 几次"就别拉命中行**：`log_search{mode:"count"}` 只回计数（几十 token），`mode:"matches"` 只回片段，`mode:"lines"`（默认）才回整行。三档的数据是同一份，差的只是**回多少**。\n\n';

md += '## 1. 怎么连\n\n';
md += '| | |\n|---|---|\n';
md += '| 传输 | **两种并存**（默认）：① **Streamable HTTP**（`POST /mcp`，2025-03-26+ 规范，新版客户端默认走它）；② **遗留 SSE**（`GET /sse` + `POST /messages`，只支持 SSE 的老客户端）。也可以在弹窗里选「仅 /mcp」或「仅 SSE」—— 那时另一条端点返回 404 |\n';
md += '| 端点（推荐，新客户端）| `POST /mcp?token=…` 发 JSON-RPC，**结果直接从这次 HTTP 响应回来**（`Content-Type: application/json`）；`initialize` 的响应头带 `Mcp-Session-Id`，后续请求用同名请求头带回来；`GET /mcp` 可另挂一条 SSE 流收服务端通知；`DELETE /mcp` 主动结束会话 |\n';
md += '| 端点（老客户端）| `GET /sse`（建立会话，首帧下发 `event: endpoint`）→ `POST /messages?sessionId=…`（发 JSON-RPC，结果从 SSE 流回）|\n';
md += '| 鉴权 | 每个请求都要带 token：`?token=…` 或 `Authorization: Bearer …`；`GET /healthz` 是唯一免鉴权端点，只回 `{"ok":true}` |\n';
md += '| 监听 | **只监听回环**（`127.0.0.1` / `::1` / `localhost`），不对外网/局域网开放 |\n';
md += '| 握手顺序（Streamable HTTP）| `POST /mcp` `initialize`（不带会话头）→ 从响应头拿 `Mcp-Session-Id` → 后续请求都带上它 → `notifications/initialized`（回 202）→ `tools/list` |\n';
md += '| 握手顺序（遗留 SSE）| 客户端必须先 `GET /sse` 拿到 endpoint，再 `POST` `initialize` → `notifications/initialized` → `tools/list` |\n';
md += '| 地址从哪来 | 程序弹窗里的「Streamable HTTP / 遗留 SSE」两块地址，或 `%APPDATA%\\seahi-serial\\mcp-endpoint.json`（`url` 与 `urlStreamable` 两个字段）|\n';
md += '| 传输档位 | 弹窗里的「传输」三档：**两种都提供**（默认，兼容性最好）/ **仅 /mcp** / **仅 SSE**。配置键是 `server.transport`（老的 `server.streamableHttp` 布尔写法仍然认）。选单档时**另一条端点立刻返回 404**（切换立即生效，不用重启服务器）|\n\n';

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
    // `写⚠️`（危险写）也是写：原先只认 `rw === '写'`，于是 ble_periph_start/stop 在总表里
    // 被标成了「读」—— 一眼看不出它会对外广播（2026-09 核对时发现）
    const rwCell = rw.indexOf('写') === 0 ? ('**写**' + (rw.indexOf('⚠') > 0 ? ' ⚠️' : '')) : '读';
    md += '| [`' + n + '`](#' + n.replace(/_/g, '-') + ') | ' + rwCell + ' | ' + t.desc + ' |\n';
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
md += '| 前端桥超时（界面动作 5 秒没回执） | `-32004`（`E_UI_TIMEOUT`）|\n';
md += '| 前端桥在途请求过多 | `-32005`（`E_UI_BUSY`）|\n';
md += '| 超过 60 次/分 | `-32000`（`E_RATE_LIMITED`）|\n';
md += '| 工具内部 panic | `-32603`，消息里写明"已上报"；连接**不会**被打死，且会上报错误库 |\n';
md += '| `POST /mcp` 带的 `Mcp-Session-Id` 不认识（过期/被表满淘汰/伪造） | HTTP 404 + `session not found`（**不是** JSON-RPC 错误）；规范里客户端拿到 404 应当重新 `initialize` |\n';
md += '| `POST /mcp` 的 `MCP-Protocol-Version` 不认识 | HTTP 400，响应体里列出我们支持的版本（缺失该头按 2025-03-26 放行）|\n';
md += '| `POST /mcp` 带了非回环的 `Origin`（`http://evil.com` / `https://…` / `null`） | HTTP 403（防 DNS rebinding；不带 Origin 的 SDK/curl 不受影响）|\n';
md += '| token 不对 / 缺失 | HTTP 401（不是 JSON-RPC 层）|\n\n';

md += '## 7. 上限与安全边界\n\n';
md += '| 项 | 值 |\n|---|---|\n';
md += '| 同时会话数 | 4，**两种传输共用一张表**：SSE 会话在流断开时立刻回收；HTTP 会话没有断连信号可依赖，靠 30 分钟空闲回收 + 客户端 `DELETE /mcp` |\n';
md += '| 表满时（HTTP 新建会话）| **淘汰最久未活动的 HTTP 会话**（客户端下次请求得 404 并重新 `initialize`，可恢复）；只有剩下的全是 SSE 会话时才回 429 —— 淘汰 SSE 会话会把它那条长连接变成收不到东西的僵尸 |\n';
md += '| 每会话出站队列 / 心跳 / 空闲回收 / 限流 | 256 条丢最旧 · 15s · 30 分钟 · 60 次/分 |\n';
md += '| 请求体上限 | 1 MiB |\n';
md += '| `ui_set` 单次 items | **200**（超了 -32602；这条链路跑在界面主线程上）|\n';
md += '| `ui_set` 单条 `value` | **8192 字符**（超了 -32602；只挡条数挡不住"一条巨型字符串"）|\n';
md += '| 快速指令 `value` / 组名 / 条目数 | 4096 / 64 字符 · 500 条（超长 -32602；**条目满了是 -32006**，先删几条）|\n';
md += '| `serial_send` 单次字符数 | **64K**（超了 -32602；串口写是排队的）|\n';
md += '| `ble_write` 单次字符数 | **4096**（超了 -32602；BLE 单次写受 MTU 限制）|\n';
md += '| `adb_shell_write` 单次字符数 | **4096**（超了 -32602；这一头是**设备的 shell**）|\n';
md += '| `adb_shell_resize` 的 `cols` / `rows` | **2~1000**（越界 / 0 / 1 都是 -32602）|\n';
md += '| `adb_shell_read` 一次行数 | 默认 200，上限 **2000** |\n';
md += '| 工具列表每页 | 50 |\n';
md += '| `ctl_*` 上限 | 400 |\n';
md += '| 日志单条 / 每通道 / 总量 / 通道数 | 8 KiB 截断 · 128 KiB~1 MiB · 16 MiB（超了裁最大通道）· 64 个 |\n';
md += '| 读日志的编码（`log_tail` / `serial_get_output`） | 默认 `json`（逐行 `seq/ts/t/level/dir/bytes/text`）；`format:"text"` 一行一条纯文本（头部一行元信息 + `[时刻] [级别/方向] 正文`）。**两种编码的数据与丢弃账完全一致**：`returned` / `seqFrom` / `seqTo` / `missed` / `dropped` / `mayBeIncomplete` / `truncated` / `nextSinceSeq` |\n';
md += '| 一次日志读取的行数 | `log_tail` 默认 100 · `serial_get_output` 默认 50 · `adb_shell_read` 默认 200，三者上限都是 **2000**（text 编码只改写法，不改这个上限） |\n';
md += '| `log_search` 的 `limit` / `context` | `limit` 默认 100、上限 **500**（`matches` 档算的是**匹配处数**，一行多处算多条）；`context` **0~5**，超了或配在非 `lines` 档上都是 -32602 |\n';
md += '| 检索图案 `pattern` 的长度 | **512 字符**（`maxSearchPatternChars`；`log_search` / `adb_shell_read` / `ble_get_output` 共用）—— 图案要被编译成正则，1 MiB 的请求体塞得进一条巨型正则，所以**在碰主程序之前**就拦 |\n';
md += '| 桥回执超时 / 在途上限 | **界面动作 5 秒**、设备动作 30 秒、`ble_connect` 130 秒 · 32 |\n';
md += '| `ble_list_devices` / `ui_get_state(bleDevices)` 每页 | 200 台（`limit` 只能是 **1~200**，0 与超限都是 -32602；要全量就**不给** limit，或用 `offset` 翻页）|\n\n';
md += '安全边界：\n\n';
md += '1. **只监听回环**，`server.host` 只接受 `127.0.0.1`/`::1`/`localhost`；\n';
md += '2. 必须带 token；`/healthz` 是唯一免鉴权端点且只回 `{"ok":true}`；`/status` 需 token 且**两条 URL 都打码**（`urlMasked` / `streamableUrlMasked`），绝不回显 token 与完整 URL；`/mcp` 另外校验 `Origin`（只放行回环）；\n';
md += '3. **工具不能改 token**（必须在界面点「重置令牌」）；\n';
md += '4. AI 记录写独立的 `ai-calls.jsonl`，**用户配置 `config.json` 里不会出现任何 AI 痕迹**；\n';
md += '5. 运行期错误走程序既有的错误上报（LogHub → 本地日志 → Sentry/自建服务），**上报前 token 打码**，同类错误 5 分钟只报一次；\n';
md += '6. **MCP 的运行不得拖慢主程序**：串口收发热路径上只有一次非阻塞的日志旁路（`try_lock`，拿不到锁就丢并计数），上报走独立线程的 channel，SSE 出站是「有界队列 + `try_send`」（生产者绝不阻塞，慢客户端直接断开），界面命令有在途上限（32）与**分档超时**（界面动作 5s、设备动作 30s、连接 130s —— 连接要等用户点配对弹窗，按 5s 算必然假失败），**所有外部输入都有上限**（见上表）。\n\n';

md += '## 8. 手测示例（curl）\n\n';
md += '**Streamable HTTP（推荐，新版客户端走这条）**\n\n';
md += '```bash\n';
md += '# 1) initialize：不带会话头，从**响应头**里拿 Mcp-Session-Id（-i 才会打印响应头）\n';
md += 'curl.exe -i -X POST "http://127.0.0.1:7777/mcp?token=<TOKEN>" \\\n';
md += '  -H "Content-Type: application/json" \\\n';
md += '  -H "MCP-Protocol-Version: 2025-06-18" \\\n';
md += '  -d \'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"curl"}}}\'\n';
md += '#   期望 HTTP 200 + content-type: application/json + 响应头 mcp-session-id: <SID>\n';
md += '#   ⚠️ 结果**就在这个响应体里**（不必像 SSE 那样另开一条流等）\n\n';
md += '# 2) 后续请求带上会话头（结果同样直接从响应回来）\n';
md += 'curl.exe -i -X POST "http://127.0.0.1:7777/mcp?token=<TOKEN>" \\\n';
md += '  -H "Content-Type: application/json" \\\n';
md += '  -H "Mcp-Session-Id: <SID>" \\\n';
md += '  -d \'{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"app_info"}}\'\n\n';
md += '# 3) 通知：回 202 + 空体（规范要求，不是 200 加空 JSON）\n';
md += 'curl.exe -i -X POST "http://127.0.0.1:7777/mcp?token=<TOKEN>" \\\n';
md += '  -H "Content-Type: application/json" \\\n';
md += '  -H "Mcp-Session-Id: <SID>" \\\n';
md += '  -d \'{"jsonrpc":"2.0","method":"notifications/initialized"}\'\n\n';
md += '# 4) 用完主动结束会话（立刻释放一个会话名额）\n';
md += 'curl.exe -i -X DELETE "http://127.0.0.1:7777/mcp?token=<TOKEN>" -H "Mcp-Session-Id: <SID>"\n';
md += '#   期望 HTTP 204\n';
md += '```\n\n';
md += '**遗留 SSE（只支持 SSE 的老客户端走这条）**\n\n';
md += '```bash\n';
md += '# 0) 探活（不需要 token）\n';
md += 'curl.exe -i http://127.0.0.1:7777/healthz\n\n';
md += '# 1) 建 SSE 会话，看首帧 endpoint（-N 关缓冲；这个连接要一直挂着）\n';
md += 'curl.exe -N "http://127.0.0.1:7777/sse?token=<TOKEN>"\n';
md += '#   event: endpoint\n';
md += '#   data: /messages?sessionId=<SID>&token=<TOKEN>\n\n';
md += '# 2) 另开一个窗口，往上面那个 SID 发 JSON-RPC\n';
md += 'curl.exe -i -X POST "http://127.0.0.1:7777/messages?sessionId=<SID>&token=<TOKEN>" \\\n';
md += '  -H "Content-Type: application/json" \\\n';
md += '  -d \'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"curl"}}}\'\n';
md += '#   期望 HTTP 202；结果从第 1 步的 SSE 流里出来\n\n';
md += '# 3) 列工具（同样 202，结果从 SSE 流回）\n';
md += 'curl.exe -i -X POST "http://127.0.0.1:7777/messages?sessionId=<SID>&token=<TOKEN>" \\\n';
md += '  -H "Content-Type: application/json" \\\n';
md += '  -d \'{"jsonrpc":"2.0","id":2,"method":"tools/list"}\'\n\n';
md += '# 4) 调一个只读工具\n';
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
