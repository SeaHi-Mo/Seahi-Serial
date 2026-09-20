/* 84-ble-ota.js —— BLE 固件升级（OTA）面板。
   ⚠️ **普通脚本**（不是 ESM）：按 index.html 里的 <script src> 顺序加载、与其它文件共享同一个
   全局作用域 —— 行内 onclick 与跨文件调用（logBle / escapeHtml / _bleServices / invoke…）照旧有效。
   **别改成 type="module"**（模块作用域会让它们全部失效）。

   ===== 本文件的范围：阶段 0 + 阶段 1 =====
   **阶段 0**：选固件 → 认包头 → 算校验 → 读设备版本对比。
   **阶段 1**：真传输。但**写入整个在后端引擎里**（`main.rs` 的 `ota_start` / `ota_status` /
   `ota_abort`）：前端只负责「协议档」表单、二次确认、进度与日志 —— 它一次 invoke 传不了 8 MB，
   而且"谁在写设备"必须只有一个答案。设备侧私有协议的可变部分（UUID / 分包 / ACK / 起止帧）
   **全部由协议档给出，前端一个都不预填**。评估与分期见 doc/BLE_OTA_EVALUATION.md。

   ⚠️ 别为了"看起来完整"在这里偷偷调 ble_write：**半成品的固件写入 = 变砖**，
   而变砖的兜底只能在设备侧（双 bank / rollback），上位机做不到。
   `.walkthrough` 里有一条断言专门扫这件事（本文件必须没有任何写入/断链调用）。 */

/* ⚠️ OTA 整条功能的**总开关**（用户 2026-09 要求："OTA 的功能先隐藏起来吧"）。
   `false` = 设备详情页里**不出现**「固件升级」按钮，弹窗也就没有任何入口（DOM 还在，但打不开）。
   为什么用开关而不是删代码：阶段 0/1 的引擎、协议档、二次确认、断言全都是好的，
   真正卡住的只有**真机协议里 `crc16()` 的参数**（实现在泰凌的预编译库里，见
   `doc/BLE_OTA_TELINK.md` §6）—— 核对完把这一行改成 `true`，整条就回来。
   ⚠️ 别改成"把按钮删掉"：那样再打开时没人记得还有哪些配套（危险动作登记 / MCP_SKIP_NO_TOOL /
   断言 / 三份文档）。断言里有两条专门守着这个开关与它的理由。 */
var BLE_OTA_UI_ENABLED = false;

/* 设备信息服务（DIS 0x180A）里的版本类特征：key → 短 UUID + 显示名。
   读不到不是错误：很多透传模组根本没实现 DIS（评估文档 §4 第 3 条），
   那种设备只能靠协议档自带的版本查询命令（阶段 1）。 */
var BLE_OTA_DIS_CHARS = [
    { key: 'firmware',     uuid: '2A26', label: '固件版本' },
    { key: 'model',        uuid: '2A24', label: '型号' },
    { key: 'hardware',     uuid: '2A27', label: '硬件版本' },
    { key: 'software',     uuid: '2A28', label: '软件版本' },
    { key: 'manufacturer', uuid: '2A29', label: '厂商' }
];

var _bleOtaFw = null;      // 选中的固件解析结果（后端 ota_pick_firmware / ota_inspect_firmware）
var _bleOtaDev = null;     // 设备版本读取结果：{ ok:true, values:{…} } 或 { ok:false, err }
var _bleOtaBusy = false;   // 选择/读取进行中门闩（防连点）
var _bleOtaRecent = [];    // 后端记着的"最近选过的固件"（ota_list_firmwares）
// ---- 阶段 1（真传输）的状态 ----
var _bleOtaProfile = null;      // 协议档（懒初始化，见 bleOtaProfileEnsure）；随 config.json 持久化
var _bleOtaArmed = false;       // 二次确认已武装（第一次点只是把按钮改成「确认升级」）
var _bleOtaRunning = false;     // 后端引擎正在写设备（前端只轮询进度）
var _bleOtaPoll = null;         // 进度轮询定时器
var _bleOtaPollLoggedPct = -1;  // 上次写进日志的 10% 档位（别每 400ms 刷一行）
var _bleOtaPollRetries = -1;    // 上次写进日志的重传数
var _bleOtaPollAckShown = false; // 设备回的 ACK 原文只展示一次

/// 拿到协议档（没初始化过就回默认值）。默认值**不含任何 UUID** —— 见 bleOtaProfileDefaults。
function bleOtaProfileEnsure() {
    if (!_bleOtaProfile) _bleOtaProfile = bleOtaProfileDefaults();
    return _bleOtaProfile;
}

// 在 GATT 服务树里按短 UUID 找特征（纯函数：列表由调用方传入，便于无头断言）。
// ⚠️ 比较前**先归一化成短 UUID**（`shortUuid`）：后端给出的 uuid 写法不完全一样，
// 拿完整 128 位字符串硬比会「明明有这个特征却说没有」—— 2026-09 真机上就踩到了
// （用户截图：ai-thinker 设备的 0x180A 明明在，界面却说「设备未提供 0x180A」）。
// 找不到返回 null —— 由调用方决定是"少了这一项"还是"整个服务都没有"。
function bleOtaFindChar(services, short) {
    var want = String(short).toUpperCase();
    var list = services || [];
    for (var i = 0; i < list.length; i++) {
        var chars = list[i].characteristics || [];
        for (var j = 0; j < chars.length; j++) {
            if (shortUuid(chars[j].uuid || '') === want) return chars[j];
        }
    }
    return null;
}

// 服务树里有没有这个服务（同样归一化后比）。用来把"服务不在"与"服务在但没有版本类特征"分开说。
function bleOtaHasService(services, short) {
    var want = String(short).toUpperCase();
    var list = services || [];
    for (var i = 0; i < list.length; i++) {
        if (shortUuid(list[i].uuid || '') === want) return true;
    }
    return false;
}

// 某个服务下**实际**有哪些特征（短 UUID 数组）。读不到版本时要把它列出来 ——
// 用户想知道的是"我该往设备侧加哪个特征"，而不是一句"读不到"。
function bleOtaSvcCharShorts(services, svcShort) {
    var want = String(svcShort).toUpperCase();
    var out = [];
    var list = services || [];
    for (var i = 0; i < list.length; i++) {
        if (shortUuid(list[i].uuid || '') !== want) continue;
        (list[i].characteristics || []).forEach(function(c) {
            var s = shortUuid(c.uuid || '');
            if (s && out.indexOf(s) < 0) out.push(s);
        });
    }
    return out;
}

// 读不到版本时**该说什么**（纯函数，便于无头断言）。返回 null = 有可读的版本特征。
// 三态必须分清，别把三件事说成一句：
//   ① 服务树是空的（连接后没取到服务）→ 让用户重连，而不是说设备没有某服务；
//   ② 确实没有 0x180A 服务；
//   ③ **有** 0x180A 但没有版本类特征 → 把现有特征列出来（这是设备侧该补什么的信息）。
function bleOtaReadBlockReason(services) {
    var list = services || [];
    if (!list.length) return '没拿到 GATT 服务树，先断开重连一次';
    if (BLE_OTA_DIS_CHARS.some(function(d) { return !!bleOtaFindChar(list, d.uuid); })) return null;
    if (!bleOtaHasService(list, '180A')) return '设备未提供 0x180A';
    var chars = bleOtaSvcCharShorts(list, '180A');
    return '0x180A 里没有版本类特征' + (chars.length ? '（现有：' + chars.join(' / ') + '）' : '');
}

// 字节数 → 人话（固件动辄几百 KB~几 MB，界面上直接写字节数没人看得懂）。
function bleOtaFmtSize(n) {
    var v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
    return (v / 1024 / 1024).toFixed(2) + ' MB';
}

// 版本字符串解码：按 UTF-8 解码，再去掉结尾的 NUL 与首尾空白
// （设备常在定长字段里补 0，直接显示会带一堆看不见的字符）。
function bleOtaDecodeVersion(bytes) {
    var arr = bytes || [];
    if (!arr.length) return '';
    var s = '';
    try { s = new TextDecoder('utf-8').decode(new Uint8Array(arr)); } catch (e) { s = ''; }
    return s.replace(/\u0000+$/g, '').trim();
}

// 固件版本 ↔ 设备当前版本 → 一行结论（纯函数，便于无头断言）。
// ⚠️ **不判断"谁新谁旧"**：版本号写法各家不同（"1.2.3" / "V1.2" / 日期 / 纯数字），
// 猜大小必然误报，而误报的后果是"用户以为不用升"或"以为升失败"。这里只说一致 / 不一致 / 读不到。
// ⚠️ 2026-09 起界面**不再单开一块显示这个结论**（用户要求删掉"设备版本"区）——
// 读到的两侧版本都按行写进日志窗口，用户自己对照；这个纯函数留给 MCP/阶段 1 复用。
function bleOtaVerdict(fwVersion, devVersion) {
    var a = String(fwVersion == null ? '' : fwVersion).trim();
    var b = String(devVersion == null ? '' : devVersion).trim();
    if (!a) return { level: 'unknown', text: '固件无版本号' };
    if (!b) return { level: 'unknown', text: '设备版本读不到' };
    if (a.toLowerCase() === b.toLowerCase()) return { level: 'same', text: '与设备一致 · ' + a };
    return { level: 'diff', text: '不一致 · 固件 ' + a + ' / 设备 ' + b };
}

// 固件解析结果 → 展示行（纯函数：把"该说哪些话"从 DOM 里拿出来，便于无头断言）。
// 返回 [{k, v, cls}]；cls 只影响配色：ok / bad / warn。
function bleOtaFwRows(fw) {
    if (!fw) return [];
    var rows = [];
    if (fw.name) rows.push({ k: '文件', v: String(fw.name) });
    rows.push({ k: '大小', v: String(fw.size_text || bleOtaFmtSize(fw.size || 0)) });
    if (fw.header_kind === 'ai_pack_head') {
        var h = fw.header || {};
        var chip = String(h.chip || '');
        rows.push({ k: '包头', v: 'ai_pack_head · ' + (fw.header_size || 0) + ' B' });
        rows.push({ k: '包头版本', v: h.head_version ? String(h.head_version) : '(空)' });
        rows.push({ k: '芯片', v: chip || '(空)', cls: (!chip || chip.toUpperCase() === 'UNKN') ? 'warn' : '' });
        rows.push({ k: '固件体', v: (fw.body_size || 0) + ' B' });
        rows.push({ k: '声明 MD5', v: h.md5 ? String(h.md5) : '(空)' });
        rows.push({ k: '实测 MD5', v: String(fw.body_md5 || '') });
        rows.push({ k: '校验', v: fw.md5_match ? '一致 ✓' : '不一致 ✗', cls: fw.md5_match ? 'ok' : 'bad' });
    } else {
        // 只写「未识别」（用户 2026-09 要求删掉那个括号）—— 这一行只是说"没认出包头"，
        // "按裸固件处理"是我们的做法，不是这个字段的值；做法写在选固件那行日志里。
        rows.push({ k: '包头', v: '未识别' });
        rows.push({ k: 'MD5', v: String(fw.body_md5 || '') });
    }
    rows.push({ k: 'SHA-256', v: String(fw.file_sha256 || '') });
    (fw.warnings || []).forEach(function(w) { rows.push({ k: '⚠', v: String(w), cls: 'warn' }); });
    return rows;
}

// 弹窗里**不摆常驻说明文字**（用户 2026-09 明确要求）：
// 边界与阶段说明都在 doc/BLE_OTA_EVALUATION.md；界面上只在真有结果时提示一行。
// ⚠️ 别再加"阶段 0 · 只做选择与校验，不会写入设备"这类常驻文案 —— 加回会被断言拦下。

function openBleOtaModal() {
    // 关掉时**连手动调用也打不开**：只藏按钮的话，一条 `openBleOtaModal()` 就能把整条流程喊出来
    if (!BLE_OTA_UI_ENABLED) return;
    var mask = document.getElementById('bleOtaModal');
    if (!mask) return;
    bleOtaRenderTarget();
    var verBtn = document.getElementById('bleOtaVerBtn');
    if (verBtn) verBtn.disabled = !_bleConnAddr;
    mask.classList.add('show');
    bleOtaRenderFw();
    bleOtaLoadRecent();
    bleOtaLogReset();                  // 日志是"本次会话"的：跟上次的混着看会误判
    bleOtaProgress(0, '未开始');
    // 协议档：把存下来的填回界面，并把"配没配"写在摘要行里（收起状态也要能一眼看见）
    bleOtaProfileFill(bleOtaProfileEnsure());
    bleOtaRenderProfileSum();
    bleOtaDisarm();
    bleOtaSetRunning(!!_bleOtaRunning);   // 弹窗关掉又打开时，正在跑的任务要接着显示
    if (_bleOtaRunning) bleOtaStartPoll();
}

// 标题栏中间那行 = **名称 + MAC**（纯函数，便于无头断言）。一律以后端真实连着的那台为准，
// 不是列表里选中的那台 —— OTA 里最不能含糊的就是"我在写哪台设备"，写错比不写更糟。
// 名称与 MAC **分开给**：界面上 MAC 要上灰色（用户 2026-09：MAC 当提示信息用）。
function bleOtaTargetParts() {
    if (!_bleConnAddr) return { name: '未连接设备', mac: '' };
    var name = '';
    for (var i = 0; i < _bleDevices.length; i++) {
        if (_bleDevices[i].address === _bleConnAddr) { name = _bleDevices[i].name || ''; break; }
    }
    return { name: name, mac: _bleConnAddr };
}

// 拼成一行文本（日志与断言用；界面是分两个 span 渲染的，见 bleOtaRenderTarget）。
// **不加「目标设备」前缀**（用户 2026-09 要求删）：弹窗本身就是对这台设备发的升级。
function bleOtaTargetText() {
    var p = bleOtaTargetParts();
    if (!p.mac) return p.name;
    return p.name ? p.name + ' ' + p.mac : p.mac;
}

// 把名称与 MAC 分别写进标题栏那两个 span。
function bleOtaRenderTarget() {
    var p = bleOtaTargetParts();
    var nm = document.getElementById('bleOtaDevName');
    var mac = document.getElementById('bleOtaDevMac');
    if (nm) nm.textContent = p.name;
    if (mac) mac.textContent = p.mac;
}

/* ===== OTA 日志窗口（用户 2026-09：读取版本等提示都写这里）=====
   ⚠️ 上限 200 行，**超了丢最旧并记账**（项目纪律：丢弃必须能被看出来，否则用户会以为
   "本来就没这几条"）。同一份也写进 BLE 面板的数据日志 —— MCP 的 ble_get_output 靠那份。 */
var BLE_OTA_LOG_MAX = 200;
var _bleOtaLog = [];        // [{ text, level }]；level: '' / ok / warn / bad / dim
var _bleOtaLogDropped = 0;  // 被丢掉的条数（渲染时会说明一句）

function bleOtaLog(text, level) {
    var line = String(text == null ? '' : text);
    _bleOtaLog.push({ text: line, level: level || '' });
    while (_bleOtaLog.length > BLE_OTA_LOG_MAX) { _bleOtaLog.shift(); _bleOtaLogDropped++; }
    renderBleOtaLog();
    logBle('[OTA] ' + line);   // 同一份也进面板数据日志
}

function renderBleOtaLog() {
    var box = document.getElementById('bleOtaLog');
    if (!box) return;
    if (!_bleOtaLog.length) { box.innerHTML = '<span class="dim">暂无</span>'; return; }
    var html = _bleOtaLog.map(function(e) {
        return '<div' + (e.level ? ' class="' + e.level + '"' : '') + '>' + escapeHtml(e.text) + '</div>';
    }).join('');
    // 丢过就说一声 —— "少了几条"不能是看不见的事
    if (_bleOtaLogDropped > 0) html = '<div class="dim">…更早的 ' + _bleOtaLogDropped + ' 条已省略</div>' + html;
    box.innerHTML = html;
    box.scrollTop = box.scrollHeight;   // 跟到最新一行
}

// 清空：每次打开弹窗调用 —— 日志是"本次会话"的记录，跟上次的混着看会误判
function bleOtaLogReset() {
    _bleOtaLog = [];
    _bleOtaLogDropped = 0;
    renderBleOtaLog();
}

// 更新进度条与阶段文字。阶段 0 恒为 (0, '未开始')；阶段 1 接上传输后只填数值。
function bleOtaProgress(pct, text) {
    var p = Number(pct);
    if (!isFinite(p)) p = 0;
    p = Math.max(0, Math.min(100, p));
    var bar = document.getElementById('bleOtaBar');
    var stage = document.getElementById('bleOtaStage');
    if (bar) bar.style.width = p + '%';
    if (stage) stage.textContent = String(text == null ? '' : text);
}

// 连接态变化时刷新弹窗。由 bleOnConnected / onBleLinkLost 调用（那是连接态变化的两个出口）。
// 弹窗没开着就什么都不做 —— 别在这里做多余的 DOM 操作。
function bleOtaSyncTarget() {
    var mask = document.getElementById('bleOtaModal');
    if (!mask || !mask.classList || !mask.classList.contains('show')) return;
    bleOtaRenderTarget();
    var verBtn = document.getElementById('bleOtaVerBtn');
    if (verBtn) verBtn.disabled = !_bleConnAddr;
    // 断开后上一台的读数必须作废（换台设备还拿着旧版本号就是误判），并写日志说明
    if (!_bleConnAddr && _bleOtaDev) {
        _bleOtaDev = null;
        bleOtaLog('设备已断开，先前的版本读数已作废', 'warn');
    }
}

function closeBleOtaModal() {
    // 升级中不许关：关了就没进度可看，而后端还在写设备 —— 那是最糟的状态
    // （用户以为"关掉就停了"）。要停就给「中止」，而且中止也撤不回已写入的部分。
    if (_bleOtaRunning) {
        bleOtaLog('升级进行中，不能关闭弹窗：要停请点「中止」（已写入的部分撤不回来）', 'warn');
        return;
    }
    bleOtaStopPoll();
    bleOtaDisarm();
    var mask = document.getElementById('bleOtaModal');
    if (mask) mask.classList.remove('show');
}

// 只在「按下点就在遮罩上」时关闭（与写入弹窗同一处理：拖右下角改尺寸时松手会落在遮罩上，
// 不做这个判断就会"一拖就关"）。见 .ble-modal 的 resize:both。
var _bleOtaPressOnMask = false;
function bleOtaMaskPress(e) {
    _bleOtaPressOnMask = !!(e.target && e.target.id === 'bleOtaModal');
}
function bleOtaMaskClick(e) {
    var pressedOnMask = _bleOtaPressOnMask;
    _bleOtaPressOnMask = false;
    if (pressedOnMask && e.target && e.target.id === 'bleOtaModal') closeBleOtaModal();
}

// （这里原来有个 bleOtaNotice「结果提示区」，2026-09 用户要求删掉：提示统一进日志窗口
//   —— 见 bleOtaLog。两块提示区并存必然漂移，只留一处。）

function bleOtaRenderFw() {
    var box = document.getElementById('bleOtaFwInfo');
    if (!box) return;
    if (!_bleOtaFw) { box.innerHTML = '<div class="ble-ota-empty">未选择固件</div>'; return; }
    box.innerHTML = bleOtaFwRows(_bleOtaFw).map(function(r) {
        return '<div class="ble-ota-kv' + (r.cls ? ' ' + r.cls : '') + '">'
             + '<span class="ble-ota-k">' + escapeHtml(r.k) + '</span>'
             + '<span class="ble-ota-v">' + escapeHtml(r.v) + '</span></div>';
    }).join('');
}

// （这里原来有个 bleOtaRenderDev：把 DIS 读到的版本渲染成一块「设备版本」显示区。
//   2026-09 用户要求删掉那块 —— 读到的内容按行写进日志窗口，见 bleOtaReadDevice。）

// 最近选过的固件（后端白名单里的那份）；文件已被移走的标注出来，不让用户选了才发现读不到。
function bleOtaLoadRecent() {
    var sel = document.getElementById('bleOtaRecent');
    if (!sel) return Promise.resolve();
    return invoke('ota_list_firmwares').then(function(list) {
        _bleOtaRecent = list || [];
        var opts = ['<option value="">最近使用…</option>'];
        _bleOtaRecent.forEach(function(f) {
            var label = (f.name || f.path) + (f.exists ? '（' + (f.size_text || '') + '）' : '（文件已不在）');
            opts.push('<option value="' + escapeHtml(String(f.path)) + '"' + (f.exists ? '' : ' disabled') + '>'
                    + escapeHtml(String(label)) + '</option>');
        });
        sel.innerHTML = opts.join('');
        sel.value = '';
    }).catch(function() { /* 列表拿不到不影响选文件 */ });
}

// 选择固件：**路径由后端原生框产生**，前端拿回的是解析结果（固件字节从不进 IPC）。
function bleOtaPickFirmware() {
    if (_bleOtaBusy) return;
    _bleOtaBusy = true;
    var btn = document.getElementById('bleOtaPickBtn');
    if (btn) { btn.disabled = true; btn.textContent = '选择中…'; }
    return invoke('ota_pick_firmware').then(function(v) {
        // 返回 null = 用户取消了文件框（不是错误）
        if (v) {
            _bleOtaFw = v;
            bleOtaLog('已选固件：' + (v.name || v.path) + ' · ' + (v.size_text || '')
                + (v.header_kind === 'ai_pack_head' ? ' · 包头校验' + (v.md5_match ? '一致' : '不一致') : ' · 裸固件'),
                v.md5_match === false ? 'bad' : (v.md5_match ? 'ok' : ''));
            (v.warnings || []).forEach(function(w) { bleOtaLog('⚠ ' + w, 'warn'); });
        }
    }).catch(function(e) {
        bleOtaLog('选择固件失败：' + e, 'bad');
    }).then(function() {
        _bleOtaBusy = false;
        if (btn) { btn.disabled = false; btn.textContent = '选择固件…'; }
        bleOtaRenderFw();
        bleOtaLoadRecent();
    });
}

// 从「最近使用」下拉里重新解析一个固件（后端只认它自己记过的路径）
function bleOtaUseRecent(path) {
    if (!path || _bleOtaBusy) return;
    _bleOtaBusy = true;
    return invoke('ota_inspect_firmware', { path: path }).then(function(v) {
        _bleOtaFw = v;
        bleOtaLog('重新解析固件：' + (v.name || v.path) + ' · ' + (v.size_text || ''));
    }).catch(function(e) {
        bleOtaLog('重新解析失败：' + e, 'bad');
    }).then(function() {
        _bleOtaBusy = false;
        bleOtaRenderFw();
    });
}

// 读设备当前版本：走既有的 ble_read（不新增后端命令）。
// 只读**服务树里真实存在**的 DIS 特征；读不到时由 bleOtaReadBlockReason 说清是哪一种，
// 而不是给一个空结果、或把三件事都报成"设备未提供 0x180A"。
// **结果一律写日志窗口**（用户 2026-09：界面不再单开一块"设备版本"显示区）。
function bleOtaReadDevice() {
    if (_bleOtaBusy) return;
    if (!_bleConnAddr) {
        _bleOtaDev = { ok: false, err: '未连接设备' };
        bleOtaLog('读版本失败：未连接设备', 'warn');
        return;
    }
    var reason = bleOtaReadBlockReason(_bleServices);
    if (reason) {
        _bleOtaDev = { ok: false, err: reason };
        bleOtaLog('读版本失败：' + reason, 'warn');
        return;
    }
    var targets = BLE_OTA_DIS_CHARS.filter(function(d) { return !!bleOtaFindChar(_bleServices, d.uuid); });
    _bleOtaBusy = true;
    var btn = document.getElementById('bleOtaVerBtn');
    if (btn) { btn.disabled = true; btn.textContent = '读取中…'; }
    var values = {};
    var chain = Promise.resolve();
    targets.forEach(function(d) {
        chain = chain.then(function() {
            var ch = bleOtaFindChar(_bleServices, d.uuid);
            if (!ch) return null;
            return invoke('ble_read', { charUuid: ch.uuid }).then(function(bytes) {
                values[d.key] = bleOtaDecodeVersion(bytes);
            }).catch(function() {
                return null;   // 某个特征读失败不该让整轮失败（版本类特征常被权限限制）
            });
        });
    });
    return chain.then(function() {
        _bleOtaDev = { ok: true, values: values };
        // 逐项写成日志：用户要自己对照固件/设备两侧的版本，这里就把原值摆出来
        var got = BLE_OTA_DIS_CHARS.filter(function(d) { return values[d.key]; });
        if (!got.length) {
            bleOtaLog('读到版本特征，但值都是空的', 'warn');
        } else {
            got.forEach(function(d) { bleOtaLog(d.label + ' = ' + values[d.key]); });
            // 已经选过固件的话，顺手给一行对照结论（以前它是界面上单独一块，现在进日志）
            if (_bleOtaFw) {
                var fwVer = _bleOtaFw.header ? _bleOtaFw.header.head_version : '';
                var v = bleOtaVerdict(fwVer, values.firmware || '');
                if (v.text) bleOtaLog(v.text, v.level === 'same' ? 'ok' : (v.level === 'diff' ? 'warn' : 'dim'));
            }
        }
    }).then(function() {
        _bleOtaBusy = false;
        if (btn) { btn.disabled = false; btn.textContent = '读取版本'; }
    });
}

/* ===== 阶段 1：协议档 + 真传输 =====
   ⚠️ **前端仍然不写设备**：它只调 `ota_start` / `ota_status` / `ota_abort`，写入整个在
   后端引擎里（`.walkthrough` 有一条断言扫这件事）。这么分不是为了好看 —— 前端一次
   invoke 传不了 8 MB，而且"谁在写设备"必须只有一个答案。 */

/// 协议档默认值：**一个 UUID 都不预填**。设备侧是自研私有协议，预填任何值都是猜，
/// 而猜错 UUID 的后果是"写到别的特征上"，比不写危险得多。
function bleOtaProfileDefaults() {
    return {
        writeUuid: '', notifyUuid: '',
        chunkSize: 0, delayMs: 0,
        ackMode: 'write_response', ackTimeoutMs: 3000, retry: 3,
        startHex: '', finishHex: '',
    };
}

/// 数字字段收敛。配置是用户（或 AI）能不经过界面直接改的 JSON，所以
/// **读进来夹一次、界面读出来再夹一次**：NaN / 越界一律回到默认，别让
/// `"abc"` 或 `-1` 一路传到后端去。
function bleOtaNum(v, def, lo, hi) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) return def;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
}

/// 从配置里恢复协议档：只认已知字段（未知键忽略、坏值回默认）
function bleOtaProfileLoad(raw) {
    var d = bleOtaProfileDefaults();
    if (!raw || typeof raw !== 'object') return d;
    function str(v) { return typeof v === 'string' ? v.trim() : ''; }
    var mode = str(raw.ackMode);
    if (mode !== 'write_response' && mode !== 'notify' && mode !== 'none') mode = d.ackMode;
    return {
        writeUuid: str(raw.writeUuid),
        notifyUuid: str(raw.notifyUuid),
        chunkSize: bleOtaNum(raw.chunkSize, d.chunkSize, 0, 512),
        delayMs: bleOtaNum(raw.delayMs, d.delayMs, 0, 10000),
        ackMode: mode,
        ackTimeoutMs: bleOtaNum(raw.ackTimeoutMs, d.ackTimeoutMs, 1, 60000),
        retry: bleOtaNum(raw.retry, d.retry, 0, 20),
        startHex: str(raw.startHex),
        finishHex: str(raw.finishHex),
    };
}

/// 界面 → 协议档。**提交给后端的就是这一份**（后端还会再校验一遍，那才是权威）。
function bleOtaProfileFromForm() {
    function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }
    return bleOtaProfileLoad({
        writeUuid: val('bleOtaWriteUuid'), notifyUuid: val('bleOtaNotifyUuid'),
        chunkSize: val('bleOtaChunk'), delayMs: val('bleOtaDelay'),
        ackMode: val('bleOtaAckMode'), ackTimeoutMs: val('bleOtaAckTimeout'),
        retry: val('bleOtaRetry'), startHex: val('bleOtaStartHex'), finishHex: val('bleOtaFinishHex'),
    });
}

/// 协议档 → 界面
function bleOtaProfileFill(p) {
    p = bleOtaProfileLoad(p);
    function set(id, v) { var el = document.getElementById(id); if (el) el.value = v; }
    set('bleOtaWriteUuid', p.writeUuid); set('bleOtaNotifyUuid', p.notifyUuid);
    set('bleOtaChunk', p.chunkSize); set('bleOtaDelay', p.delayMs);
    set('bleOtaAckMode', p.ackMode); set('bleOtaAckTimeout', p.ackTimeoutMs);
    set('bleOtaRetry', p.retry); set('bleOtaStartHex', p.startHex); set('bleOtaFinishHex', p.finishHex);
}

/// 收起时那一行摘要：说清"配没配、缺什么"。**它是状态，不是说明文字** ——
/// 所以它随填写实时变，而不是一句常驻文案（用户 2026-09 明确要求不摆常驻说明）。
function bleOtaProfileSummary(p) {
    p = bleOtaProfileLoad(p || _bleOtaProfile);
    if (!p.writeUuid) return '未配置：写入特征 UUID 还没填，「开始升级」不会向设备发任何数据';
    var bits = ['写入 ' + p.writeUuid];
    if (p.ackMode === 'notify') bits.push('等通知 ' + (p.notifyUuid || '（缺通知特征）'));
    else bits.push(p.ackMode === 'none' ? '不等应答' : '写响应');
    bits.push(p.chunkSize ? ('分包 ' + p.chunkSize + ' B') : '分包自动');
    bits.push(p.finishHex ? '有结束帧' : '无结束帧（设备多半不会生效）');
    return bits.join(' · ');
}

function bleOtaRenderProfileSum() {
    var el = document.getElementById('bleOtaProfileSum');
    if (el) el.textContent = bleOtaProfileSummary();
}

/// 展开 / 收起。缺项时由 bleOtaStart 自动展开（force=true）
function bleOtaToggleProfile(force) {
    var form = document.getElementById('bleOtaProfileForm');
    if (!form) return;
    var open = (typeof force === 'boolean') ? force : (form.style.display === 'none');
    form.style.display = open ? '' : 'none';
    var btn = document.getElementById('bleOtaProfileToggle');
    if (btn) btn.textContent = open ? '收起' : '展开';
    return open;
}

/// 表单改动：同步进内存 + 摘要 + **收回二次确认**（改了参数还留着"确认升级"状态，
/// 等于用户还没看过新参数就被允许写入），并落盘（去抖）。
function bleOtaProfileChanged() {
    _bleOtaProfile = bleOtaProfileFromForm();
    bleOtaRenderProfileSum();
    bleOtaDisarm();
    if (typeof scheduleConfigSave === 'function') scheduleConfigSave();
}

/// 「现在能不能开始」的**唯一判据**（纯函数，便于无头断言）。返回 '' = 可以开始。
/// 顺序 = 用户最容易卡住的那一步先报；每条都要说清"要做什么"，不能只说"不能"。
function bleOtaStartBlockReason(fw, connAddr, profile) {
    if (!fw) return '先选择固件';
    if (!connAddr) return '未连接设备';
    if (fw.md5_match === false) return '固件校验没通过：先换一个固件（或确认文件没被改过）';
    var p = bleOtaProfileLoad(profile);
    if (!p.writeUuid) return '协议档里还没填「写入特征 UUID」';
    if (p.ackMode === 'notify' && !p.notifyUuid) return '协议档选了「等设备通知」，但没填通知特征 UUID';
    if (p.chunkSize > 512) return '协议档的分包超过 512 B 上限';
    return '';
}

/// 阶段文字（纯函数）：进度条右边那句话。**别把 elapsed 之类的东西塞进来** ——
/// 它要能一眼读完。
function bleOtaStageText(s) {
    if (!s) return '未开始';
    var map = { idle: '未开始', sending: '传输中', finishing: '发送结束帧', done: '已完成', aborted: '已中止', failed: '失败' };
    var t = map[s.state] || String(s.state || '');
    if (s.state === 'sending' && s.totalBytes) {
        t += ' ' + (s.pct || 0) + '%（' + (s.sentBytes || 0) + '/' + s.totalBytes + ' 字节）';
    }
    return t;
}

/// 终态那一行结论（纯函数）。**中止要写明"撤不回来"**：用户会以为中止=回到升级前。
function bleOtaResultLine(s) {
    if (!s) return '';
    if (s.state === 'done') {
        return s.finishConfigured
            ? '传输完成：结束帧已发出，接下来由设备自己校验/重启（期间仍不要断开）'
            : '传输完成，但协议档里没配结束帧：数据都发出去了，设备多半不会生效';
    }
    if (s.state === 'aborted') {
        return '已中止：已写入 ' + (s.sentBytes || 0) + ' 字节 —— 中止 ≠ 回滚，写进去的那部分撤不回来';
    }
    if (s.state === 'failed') {
        return '升级失败：' + (s.error || '未知原因') + '（已写入 ' + (s.sentBytes || 0) + ' 字节）';
    }
    return '';
}

/// 传输中把能点的都锁住：**升级期间不能关弹窗**（关了就没进度可看，而后端还在写），
/// 也不能改协议档/换固件（改了也不生效，只会让人以为生效了）。
function bleOtaSetRunning(on) {
    ['bleOtaPickBtn', 'bleOtaRecent', 'bleOtaVerBtn', 'bleOtaStartBtn', 'bleOtaCloseBtn'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.disabled = !!on;
    });
    var form = document.getElementById('bleOtaProfileForm');
    if (form) {
        var inputs = form.querySelectorAll ? form.querySelectorAll('input, select') : [];
        for (var i = 0; i < inputs.length; i++) inputs[i].disabled = !!on;
    }
    var abort = document.getElementById('bleOtaAbortBtn');
    if (abort) abort.style.display = on ? '' : 'none';
    // 收工时**按真实连接态**重算「读取版本」能不能点：上面那圈是"一律打开"，
    // 而它本来就该在未连接时置灰（不然点下去只能得到一句"未连接设备"）。
    if (!on) {
        var ver = document.getElementById('bleOtaVerBtn');
        if (ver) ver.disabled = !_bleConnAddr;
    }
}

/// 收回二次确认（回到「开始升级」文案）
function bleOtaDisarm() {
    _bleOtaArmed = false;
    var b = document.getElementById('bleOtaStartBtn');
    if (b) { b.textContent = '开始升级'; b.classList.remove('danger'); }
}

function bleOtaStopPoll() {
    if (_bleOtaPoll) { clearInterval(_bleOtaPoll); _bleOtaPoll = null; }
}

function bleOtaStartPoll() {
    bleOtaStopPoll();
    _bleOtaPollLoggedPct = -1;
    _bleOtaPollRetries = -1;
    _bleOtaPoll = setInterval(bleOtaPollOnce, 400);
    return bleOtaPollOnce();
}

/// 轮询一次进度。**只在跨过 10% 或重传数变化时写日志** ——
/// 每 400ms 刷一行会把日志窗口刷爆（上限 200 行，一刷就看不到前面发生了什么）。
function bleOtaPollOnce() {
    return invoke('ota_status').then(function(s) {
        bleOtaProgress(s.pct || 0, bleOtaStageText(s));
        var bucket = Math.floor((s.pct || 0) / 10) * 10;
        if (bucket > _bleOtaPollLoggedPct) {
            _bleOtaPollLoggedPct = bucket;
            bleOtaLog('进度 ' + (s.pct || 0) + '% · ' + (s.sentBytes || 0) + '/' + (s.totalBytes || 0)
                + ' 字节 · ' + (s.chunksSent || 0) + '/' + (s.chunksTotal || 0) + ' 片'
                + (s.rateBps ? ' · ' + bleOtaRateText(s.rateBps) : ''));
        }
        if ((s.retries || 0) > Math.max(_bleOtaPollRetries, 0)) {
            _bleOtaPollRetries = s.retries;
            bleOtaLog('重传 ' + s.retries + ' 次（ACK 超时 ' + (s.ackTimeouts || 0) + ' 次）', 'warn');
        }
        // 设备回的 ACK 原文：协议未知时这是最有用的线索，前 3 条摆出来
        if (s.recentAcks && s.recentAcks.length && !_bleOtaPollAckShown) {
            _bleOtaPollAckShown = true;
            bleOtaLog('设备回的 ACK（前几条）：' + s.recentAcks.join(' | '), 'dim');
        }
        if (s.ackDropped) bleOtaLog('⚠ ACK 队列丢过 ' + s.ackDropped + ' 条（设备回得比我们取得快）', 'warn');
        var line = bleOtaResultLine(s);
        if (line) {
            bleOtaStopPoll();
            bleOtaSetRunning(false);
            bleOtaDisarm();
            if (s.state === 'done') { bleOtaProgress(100, bleOtaStageText(s)); bleOtaLog(line, 'ok'); }
            else if (s.state === 'aborted') bleOtaLog(line, 'warn');
            else bleOtaLog(line, 'bad');
            if (s.note) bleOtaLog('⚠ ' + s.note, 'warn');
        }
    }).catch(function(e) {
        bleOtaStopPoll();
        bleOtaSetRunning(false);
        bleOtaLog('读进度失败：' + e, 'bad');
    });
}

function bleOtaRateText(bps) {
    if (bps >= 1024) return (bps / 1024).toFixed(1) + ' KB/s';
    return bps + ' B/s';
}

/// 「开始升级」。两道门，缺一不可：
/// ① **前置校验**（`bleOtaStartBlockReason`，逐条说清缺什么）；
/// ② **人工二次确认**（第一次点只是把按钮变成「确认升级」）——
///    这一步是给"变砖风险"留的思考时间，不是形式主义：写完变砖是不可逆的。
function bleOtaStart() {
    if (_bleOtaRunning) return;
    var reason = bleOtaStartBlockReason(_bleOtaFw, _bleConnAddr, _bleOtaProfile);
    if (reason) {
        bleOtaLog('还不能开始：' + reason, 'warn');
        // 缺的是协议档里的东西 → 直接把表单展开，别让用户去找
        if (reason.indexOf('协议档') === 0) bleOtaToggleProfile(true);
        return;
    }
    if (!_bleOtaArmed) {
        _bleOtaArmed = true;
        var b = document.getElementById('bleOtaStartBtn');
        if (b) { b.textContent = '确认升级'; b.classList.add('danger'); }
        bleOtaLog('再点一次「确认升级」开始写入：' + bleOtaTargetText()
            + ' · ' + _bleOtaFw.name + '（' + (_bleOtaFw.size_text || '') + '）'
            + ' —— 写入后不可撤销，过程中不要断开设备、关闭程序或让设备走远', 'warn');
        return;
    }
    _bleOtaArmed = false;
    var profile = bleOtaProfileFromForm();
    _bleOtaProfile = profile;
    bleOtaLog('开始升级：' + _bleOtaFw.name + ' → ' + bleOtaTargetText());
    if (!profile.finishHex) bleOtaLog('⚠ 协议档没配结束帧：数据会传完，但设备多半不会生效', 'warn');
    return invoke('ota_start', { path: _bleOtaFw.path, profileJson: JSON.stringify(profile) }).then(function(r) {
        _bleOtaRunning = true;
        _bleOtaPollAckShown = false;
        bleOtaSetRunning(true);
        bleOtaProgress(0, '传输中');
        bleOtaLog('传输开始：分包 ' + r.chunk + ' B · MTU ' + r.mtu + ' · 共 ' + r.chunksTotal
            + ' 片 / ' + r.totalBytes + ' 字节');
        bleOtaStartPoll();
    }).catch(function(e) {
        bleOtaDisarm();
        bleOtaSetRunning(false);
        _bleOtaRunning = false;
        bleOtaLog('启动失败：' + e, 'bad');
    });
}

/// 中止。后端把取消标志置上，任务在**下一片之前**停下 —— 已经写进设备的那部分撤不回来。
function bleOtaAbort() {
    if (!_bleOtaRunning) return;
    bleOtaLog('正在中止…（已写入的部分撤不回来）', 'warn');
    return invoke('ota_abort').catch(function(e) {
        bleOtaLog('中止请求失败：' + e, 'bad');
    });
}
