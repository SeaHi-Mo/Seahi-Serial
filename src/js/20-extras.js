/* 20-extras.js —— 前端第 3 块，拆自原单文件 src/index.html（**纯搬家**；行号映射见 doc/FRONTEND_LAYOUT.md）。
   ⚠️ **普通脚本**（不是 ESM）：按 index.html 里的 <script src> 顺序加载、共享同一个全局作用域 —— 行内 onclick
   与现有函数互相调用照旧；**别改成 type="module"**（模块作用域会让它们全部失效）。 */
/* ===== 额外监视器 ===== */
function addMonitor() {
    // 上下文感知：蓝牙页面下「打开额外监视器」是开关 —— 打开/关闭右侧嵌入的串口监视器
    var blePane = document.getElementById('ble-pane');
    if (blePane && blePane.style.display !== 'none' && blePane._initialized) {
        toggleBleMonitor();
        return;
    }
    // 上下文感知：WSL 页面下创建 WSL 监视器
    var wslPane = document.getElementById('wsl-pane');
    if (wslPane && wslPane.style.display !== 'none') {
        addWslMonitor();
        return;
    }
    extraCount++;
    createMonitorPane('extra-' + extraCount, '监视器 ' + (extraCount + 1), true);
    // 复制当前主监视器的用户配置到新监视器（波特率、滚动、行号、快捷指令等，深拷贝互不干扰）
    copyMonitorConfig('main', 'extra-' + extraCount);
    // 自动扩展窗口宽度以容纳新监视器
    var panes = document.querySelectorAll('#paneContainer .monitor-pane');
    var minWidth = panes.length * 524;
    invoke('get_window_size').then(function(size) {
        // 后端 get_window_size 返回 Result<(u32,u32)>，经 serde 序列化为数组 [width, height]
        var w = Array.isArray(size) ? size[0] : size.width;
        var h = Array.isArray(size) ? size[1] : size.height;
        if (w < minWidth) {
            invoke('set_window_size', { width: minWidth, height: h });
        }
    }).catch(function() {});
    scheduleConfigSave();
}

// 拖拽后的宽度（纯函数，便于无头断言）：
// 监视器在最右侧 → 向左拖（curX < startX）变宽；夹取到 [280, 视口 46%]
function clampBleMonWidth(startW, startX, curX, viewportW) {
    var w = startW + (startX - curX);
    var max = Math.max(280, Math.round((viewportW || 0) * 0.46));
    return Math.max(280, Math.min(max, Math.round(w)));
}

// 蓝牙页内嵌监视器的宽度拖拽：照 WSL 页 initWslMonResize 的做法，方向改为左右。
// 松手后把宽度转成 flex-basis，窗口缩小时仍受 max-width 约束自动收窄。
function initBleMonResize() {
    var handle = document.getElementById('ble-monResize');
    var area = document.getElementById('ble-monitorArea');
    if (!handle || !area || handle._bound) return;
    handle._bound = true;
    var startX = 0, startW = 0;
    function onMouseMove(e) {
        var w = clampBleMonWidth(startW, startX, e.clientX, window.innerWidth);
        area.style.flex = 'none';
        area.style.width = w + 'px';
    }
    function onMouseUp() {
        handle.classList.remove('dragging');
        var finalW = area.offsetWidth;
        area.style.width = '';
        // ⚠️ 必须是 `0 1`（可收缩）而不是 `0 0`（不可收缩）—— 用户 2026-09 要求
        // 「发送面板打开时，串口监视器自动收窄」。`0 0` 会把 width 钉死，空间不够时
        // 只能去挤设备详情（服务树被压没）。收缩下限由 CSS 的 min-width:280px 兜住。
        area.style.flex = '0 1 ' + finalW + 'px';
        _bleMonWidth = finalW;            // 宽度随用户配置保留（下次进入/重启沿用）
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = '';
        scheduleConfigSave();
    }
    handle.addEventListener('mousedown', function(e) {
        e.preventDefault();
        startX = e.clientX;
        startW = area.offsetWidth;
        handle.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

// 蓝牙页内嵌监视器：在蓝牙页右侧开一个**串口**监视器，用来抓蓝牙设备的串口日志。
// 顶栏「打开额外监视器」在蓝牙页是**开关**语义：点一次打开，再点一次关闭（与窗口右上 ✕ 等效）。
// 因此"最多一个"是天然成立的 —— 不存在开第二个的路径。
var _bleExtraMon = null;   // 内嵌监视器的 mid（'ble-mon'），未打开时为 null
var _bleMonWidth = 380;    // 内嵌监视器宽度（拖动时更新，随用户配置文件保留）
var _bleRestoreMon = null; // 启动时从配置读到的监视器状态；蓝牙页 DOM 建立后消费（见 openBle）

// 蓝牙页左栏（设备列表 / 从机配置）宽度：默认 288px，可拖手柄调，随配置保留。
// 夹取到 [240, 视口 38%] —— 上限与 CSS 的 max-width 一致，免得拖出来的宽度下次被 CSS 拉回去。
var BLE_LEFT_DEFAULT = 288, BLE_LEFT_MIN = 240;
// 当前左栏宽度（拖动时更新，随用户配置文件保留）。必须声明在默认值之后 ——
// 否则 `var x = BLE_LEFT_DEFAULT` 会在常量赋值前求值，拿到 undefined。
var _bleLeftWidth = BLE_LEFT_DEFAULT;

// 拖拽后的宽度（纯函数，便于无头断言）：手柄在左栏右边 → 向右拖（curX > startX）变宽
function clampBleLeftWidth(startW, startX, curX, viewportW) {
    var w = startW + (curX - startX);
    var max = Math.max(BLE_LEFT_MIN, Math.round((viewportW || 0) * 0.38));
    return Math.max(BLE_LEFT_MIN, Math.min(max, Math.round(w)));
}

/// 把记住的宽度套到蓝牙页左栏上
function applyBleLeftWidth() {
    var w = _bleLeftWidth || BLE_LEFT_DEFAULT;
    document.querySelectorAll('.ble-left').forEach(function(col) {
        col.style.flex = '0 0 ' + w + 'px';
    });
}

/// 绑左栏宽度拖拽手柄
function initBleLeftResize() {
    document.querySelectorAll('.ble-left-resize').forEach(function(handle) {
        if (handle._bound) return;
        handle._bound = true;
        var startX = 0, startW = 0, col = null;
        function onMouseMove(e) {
            if (!col) return;
            col.style.flex = '0 0 ' + clampBleLeftWidth(startW, startX, e.clientX, window.innerWidth) + 'px';
        }
        function onMouseUp() {
            handle.classList.remove('dragging');
            if (col) {
                _bleLeftWidth = col.offsetWidth;          // 宽度随用户配置保留
                col.style.flex = '0 0 ' + _bleLeftWidth + 'px';
            }
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            document.body.style.cursor = '';
            scheduleConfigSave();
        }
        handle.addEventListener('mousedown', function(e) {
            e.preventDefault();
            col = handle.previousElementSibling;          // .ble-left
            if (!col) return;
            startX = e.clientX;
            startW = col.offsetWidth;
            handle.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    });
}

// 采集蓝牙页状态（纯数据函数，便于随配置持久化与无头断言）
function collectBleState(s) {
    s = s || {};
    return {
        monitor: !!s.monitor,
        monitorWidth: s.monitorWidth || 380,
        leftWidth: s.leftWidth || BLE_LEFT_DEFAULT,
        monitorCfg: s.monitorCfg || null,
        openSvcs: s.openSvcs || [],
        advOpen: !!s.advOpen,
        filterText: s.filterText || '',
        filterOpen: !!s.filterOpen,
        selected: s.selected || '',
        // 扫描自动停止时长（秒），0 = 持续
        scanSecs: (s.scanSecs === 0 || s.scanSecs) ? s.scanSecs : 15,
    };
}

// 恢复蓝牙页状态。内嵌监视器**不能**在这里直接开：蓝牙页 DOM 是懒加载的（首次进入才建），
// 所以先记进 _bleRestoreMon，等 openBle 把 DOM 建好后再消费。
function restoreBleState(b) {
    if (!b) return;
    _bleSelected = b.selected || null;
    _bleOpenSvcs = {};
    (b.openSvcs || []).forEach(function(u) { if (u) _bleOpenSvcs[u] = true; });
    _bleAdvOpen = !!b.advOpen;
    _bleFilterText = b.filterText || '';
    _bleFilterOpen = !!b.filterOpen;
    _bleMonWidth = b.monitorWidth || 380;
    _bleRestoreMon = b.monitor ? { width: _bleMonWidth, cfg: b.monitorCfg || null } : null;
    // 左栏宽度：纯数据，DOM 建好后由 openBle → applyBleLeftWidth 套上去
    _bleLeftWidth = (typeof b.leftWidth === 'number' && b.leftWidth > 0) ? b.leftWidth : BLE_LEFT_DEFAULT;
    // 老配置里可能残留已删除的 BLE 从机键（模式 / 表单 / 多套配置）：
    // 这里不读它们，未知键自然被忽略，加载不报错；保存时也不再写出（见 collectBleState）。
    _bleScanSecs = (typeof b.scanSecs === 'number') ? b.scanSecs : 15;
}

// 顶栏按钮状态跟随开关：打开时高亮 + 标题改为"关闭…"，关闭时还原。
// **同时把它重置为可用**：ADB / WSL 页会禁用该按钮，若从那些页面直接切到蓝牙页
// （不经过它们的 close 逻辑），禁用态会残留 → 蓝牙页点不动（用户反馈的问题2）。
function updateBleMonBtn() {
    var btn = document.getElementById('addMonitorBtn');
    if (!btn) return;
    btn.style.opacity = '';
    btn.style.pointerEvents = '';
    var open = !!(_bleExtraMon && monitors[_bleExtraMon]);
    btn.classList.toggle('active', open);
    btn.title = open ? '关闭右侧串口监视器' : '打开右侧串口监视器';
}

/* ===== 「打开右侧监视器」时向右撑开窗口（用户 2026-09 要求）=====
   为什么要撑：设备详情是 GATT 服务树，被挤窄就没法用；而窗口右边通常本来就是空的。
   与"监视器自动收窄"的关系：`.ble-monArea` 的 `flex:0 1` 那条规则**留着当兜底** ——
   屏幕真的排不下、或者撑窗失败时，总得有人让位。正常情况下窗口被撑宽，收窄根本不会触发。

   ⚠️ 坐标系是本功能最容易错的地方：`.ble-monArea` 的宽度是 **CSS 像素**（逻辑），
   而 `set_window_size` 收的是**物理像素**（后端用 `Size::Physical`，见 main.rs）。
   150% 缩放下 1 CSS px = 1.5 物理 px —— 拿 380 直接去加物理宽只能撑出 253 CSS px，
   监视器照样放不下，用户看到的现象是"点了开关、窗口也确实变了，但详情还是被挤"。
   所以下面一律在 CSS 像素里算，只在最后一步乘 devicePixelRatio。

   ⚠️ 上限取「屏幕可用宽 − 窗口左边距」，不是无脑加：窗口已经接近屏幕宽时增量自然趋近 0
   （不会把窗口撑到屏幕外），**最大化时必然为 0**（窗口宽 ≈ 可用宽）—— 于是"最大化下点开关"
   不需要任何特判就安全（`set_size` 对最大化窗口本来也无效）。
   多显示器下 `screenX` 可能大于主屏宽（`screen.availWidth` 只报主屏），那时**放弃减左边距**：
   否则会算出负上限，反而把用户的窗口缩成 1047。

   纯函数（便于无头断言）：返回实际可撑开的 CSS 像素数，0 = 不用撑 / 撑不动。 */
function bleMonWindowGrowDelta(curLogicalW, monLogicalW, availLogicalW, screenX) {
    var target = curLogicalW + monLogicalW;
    var max = (typeof availLogicalW === 'number' && availLogicalW > 0) ? availLogicalW : target;
    if (typeof screenX === 'number' && screenX > 0 && screenX < max) max = max - screenX;
    max = Math.max(1047, max);          // 与 set_window_size / tauri.conf.json 的最小宽一致
    target = Math.min(target, max);
    return Math.max(0, Math.round(target - curLogicalW));
}

// 本次「打开监视器」实际撑开了多少 CSS 像素（关闭时按这个数收；被夹取时可能小于监视器宽度）
var _bleMonWinGrow = 0;

function growWindowForBleMon(monLogicalW) {
    if (_bleMonWinGrow > 0) return;     // 已经撑过（正常路径到不了这里）
    var dpr = window.devicePixelRatio || 1;
    invoke('get_window_size').then(function(size) {
        // 后端 get_window_size 返回 Result<(u32,u32)>，经 serde 序列化为数组 [width, height]
        var physW = Array.isArray(size) ? size[0] : size.width;
        var physH = Array.isArray(size) ? size[1] : size.height;
        var curLog = physW / dpr;
        var delta = bleMonWindowGrowDelta(curLog, monLogicalW,
            (window.screen && window.screen.availWidth), window.screenX);
        if (delta <= 0) {
            // 撑不动只可能是"窗口已经贴到屏幕可用宽的上限"（含最大化）——
            // 此时退回"监视器收窄让位"的兜底。写一行日志，免得用户以为开关坏了。
            logBle('[监视器] 窗口已到屏幕宽度上限，改为收窄让位');
            return;
        }
        _bleMonWinGrow = delta;
        return invoke('set_window_size', { width: Math.round((curLog + delta) * dpr), height: physH })
            .catch(function(e) {
                // 撑失败就当没撑过：否则关掉监视器时会平白把窗口缩一次
                _bleMonWinGrow = 0;
                console.warn('[BLE] 撑开窗口失败:', e);
            });
    }).catch(function(e) { console.warn('[BLE] 读取窗口大小失败:', e); });
}

// 关闭监视器：把当初为它撑开的那截宽度收回去。
// ⚠️ 按 `_bleMonWinGrow`（**实际**撑开量）收，不是按监视器宽度收 —— 被屏幕夹取过时两者不相等。
// 用户若在这期间手动改过窗口大小，这里也只收掉"当初为它撑出来的那部分"，不会多缩。
function shrinkWindowForBleMon() {
    var delta = _bleMonWinGrow;
    _bleMonWinGrow = 0;
    if (delta <= 0) return;
    var dpr = window.devicePixelRatio || 1;
    invoke('get_window_size').then(function(size) {
        var physW = Array.isArray(size) ? size[0] : size.width;
        var physH = Array.isArray(size) ? size[1] : size.height;
        return invoke('set_window_size', { width: Math.round(physW - delta * dpr), height: physH });
    }).catch(function(e) { console.warn('[BLE] 收回窗口宽度失败:', e); });
}

function toggleBleMonitor(fromRestore) {
    var area = document.getElementById('ble-monitorArea');
    if (!area) return;
    // 已打开 → 再点即关闭：走与窗口右上 ✕ 完全相同的释放路径（含串口释放 + 收回窗口宽度）
    if (_bleExtraMon && monitors[_bleExtraMon]) {
        closeMonitor(_bleExtraMon);
        return;
    }
    var mid = 'ble-mon';
    // 复用通用监视器窗口（自带完整工具条、发送栏、快捷指令），建好后搬到蓝牙页右侧。
    // closable=false：不生成薄标题栏上的 ✕ —— 该窗口由顶栏「打开额外监视器」开关控制开/关，
    // 再来一个 ✕ 是多余的（与 WSL 主监视器一致，它也没有自带关闭按钮）。
    createMonitorPane(mid, '监视器 · 蓝牙日志', false);
    var pane = document.getElementById('pane-' + mid);
    if (pane) {
        pane.style.flex = '1';
        pane.style.minWidth = '0';
        area.appendChild(pane);
    }
    // 宽度统一按 _bleMonWidth（用户拖过的值）：**撑窗量必须与它一致**，否则撑出来的空间
    // 和实际占用对不上。（不能拿 area.style.flex 当依据 —— 那可能只是上次拖拽的残留。）
    area.style.flex = '0 1 ' + _bleMonWidth + 'px';
    area.classList.add('active');
    // 继承主监视器的显示/行为设置，但**不继承端口**：避免与主监视器抢同一个串口
    copyMonitorConfig('main', mid, { skipPort: true });
    if (monitors[mid]) monitors[mid].bleEmbedded = true;
    _bleExtraMon = mid;
    updateBleMonBtn();
    logBle('[监视器] 已在蓝牙页右侧打开串口监视器（端口需自行选择，可用来抓蓝牙设备的串口日志）');
    // ⚠️ 恢复路径（fromRestore）**不撑窗**：那时窗口宽度已经从 window.json 恢复成上次退出时的值
    // （上次就是开着监视器退出的，那个值本身就是宽的），再撑一次会变成"每启动一次宽 380"。
    // 只有用户主动点开关（或 MCP 走 addMonitor → 这里不带参数）才撑。
    if (!fromRestore) growWindowForBleMon(_bleMonWidth);
    scheduleConfigSave();
}

// 添加 WSL 额外串口监视器
function addWslMonitor() {
    if (!_wslRunning) return; // WSL 未运行时不允许创建
    _wslExtraCount++;
    var wmid = 'wsl-x' + _wslExtraCount;
    var area = document.getElementById('wsl-monitorArea');
    if (!area) return;

    var pane = document.createElement('div');
    pane.className = 'monitor-pane';
    pane.id = 'pane-' + wmid;
    pane.style.flex = '1';
    pane.style.minWidth = '0';
    pane.style.borderLeft = '2px solid var(--split-line)';
    pane.innerHTML = '<div class="pane-header pane-header-thin" style="display:flex;justify-content:flex-end;">' +
        '<button class="pane-close" onclick="closeWslMonitor(\'' + wmid + '\')" title="关闭">\u2715</button>' +
        '</div>' + getWslMonitorHtml(wmid);
    area.appendChild(pane);

    monitors[wmid] = { isConnected: false, portName: '', readTimer: null, sendHistory: [], histNavIdx: -1, _editing: false, quickCmds: [
        // 首次启动：**一组、一条空指令**（用户 2026-09 定的默认）。组由 qcmdGroups() 现场包出来。
        {label:'', value:'', seq:0, timeout:QCMD_TIMEOUT_DEFAULT, hex:false}
    ], isWsl: true, workflows: [], _bufferStart: 0,
    _textData: new Uint8Array(TEXT_BUF_INIT), _textDataLen: 0,
    _textDataMaxBytes: 8 * 1024 * 1024,
    _textOffsets: new Uint32Array(TEXT_IDX_INIT), _textTypes: new Uint8Array(TEXT_IDX_INIT),
    _textTsLens: new Uint16Array(TEXT_IDX_INIT), _textCount: 0 };
    initWslMonitor(wmid);
    // 复制主 WSL 监视器的用户配置到新 WSL 监视器
    copyMonitorConfig('wsl', wmid);

    if (_wslRunning) {
        setWslMonitorEnabled(true, wmid);
    }
    scheduleConfigSave();
}

// 关闭 WSL 额外串口监视器
function closeWslMonitor(wmid) {
    stopReading(wmid);
    stopQcmdLoop(wmid);   // 同 closeMonitor：定时器不能跟着监视器一起被 delete 掉还继续跑
    logCacheEnd(wmid); // 删除监视器：结束会话缓存
    var wasConnected = !!(monitors[wmid] && monitors[wmid].isConnected);
    var cleanup = function() {
        delete monitors[wmid];
        var pane = document.getElementById('pane-' + wmid);
        if (pane) pane.remove();
        renderWslDeviceList('main'); // 及时刷新 WSL 设备状态点
        scheduleConfigSave();
    };
    if (wasConnected) {
        // 等待连接释放完成（最多 3 秒），避免端口未释放（#15/#16）
        invokeTimeout('close_wsl_serial', { monitorId: wmid }, 3000)
            .catch(function() {})
            .finally(cleanup);
    } else {
        cleanup();
    }
}

function closeMonitor(mid) {
    stopReading(mid);
    stopQcmdLoop(mid);   // 监视器没了，那个还在倒计时的循环定时器必须一起收掉
    logCacheEnd(mid); // 删除监视器：结束会话缓存
    var wasConnected = !!(monitors[mid] && monitors[mid].isConnected);
    var cleanup = function() {
        delete monitors[mid];
        delete _terminalBuffers[mid];
        var pane = document.getElementById('pane-' + mid);
        if (pane) pane.remove();
        // 蓝牙页内嵌监视器：关闭后必须清账，否则再点「+」会以为还有一个而不给开
        if (mid === _bleExtraMon) {
            _bleExtraMon = null;
            var bleArea = document.getElementById('ble-monitorArea');
            if (bleArea) bleArea.classList.remove('active');
            updateBleMonBtn();   // 顶栏按钮回到「打开右侧串口监视器」
            // 关掉内嵌监视器 → 把当初为它撑开的窗口宽度**同步收回**（用户 2026-09 要求）。
            // 所有关闭路径（顶栏开关 / closeMonitor / MCP）都会经过这里，只写一处。
            shrinkWindowForBleMon();
        }
        renderWslDeviceList('main'); // 及时刷新 WSL 设备状态点
        scheduleConfigSave();
    };
    if (wasConnected) {
        // 等待端口释放完成（最多 3 秒），避免直接删除监视器导致端口句柄未释放（#15/#16）
        invokeTimeout('close_port', { monitorId: mid }, 3000)
            .catch(function() {})
            .finally(cleanup);
    } else {
        cleanup();
    }
}

/* ===== 发送数据 ===== */
async function sendData(mid) {
    if (!monitors[mid] || !monitors[mid].isConnected) return;
    var input = document.getElementById(mid + '-sendInput');
    var text = input.value;
    if (!text) return;
    var hexMode = document.getElementById(mid + '-sendAsText').textContent === 'HEX';
    var bytes;
    try {
        if (hexMode) { bytes = hexToBytes(text); }
        else { text = parseEscapes(text); text += leStr(mid); bytes = new TextEncoder().encode(text); }
    } catch (e) { appendOutput(mid, 'err', '格式错误: ' + e); return; }
    try {
        // 先显示 echo，再发送数据，避免回车后等待卡顿
        var echoBtn = document.getElementById(mid + '-btnEcho');
        if (echoBtn && echoBtn.classList.contains('on')) {
            appendOutput(mid, 'send', hexMode ? 'HEX: ' + bytesToHex(bytes) : decodeRaw(bytes));
        }
        await invokeTimeout('send_data', { monitorId: mid, data: Array.from(bytes) }, 5000);
        // 保存到发送历史（去重：不存连续重复）
        var hist = monitors[mid].sendHistory;
        if (hist.length === 0 || hist[0] !== text) {
            hist.unshift(text);
            if (hist.length > MAX_SEND_HISTORY) hist.pop();
        }
        monitors[mid].histNavIdx = -1;
        input.value = '';
        input.focus();
        scheduleConfigSave();
    } catch (e) { appendOutput(mid, 'err', '发送失败: ' + e); reportError(e, 'sendData'); }
}

/* ===== 发送历史下拉 ===== */
function showSendHistory(mid) {
    var hist = monitors[mid].sendHistory;
    var histEl = document.getElementById(mid + '-sendHist');
    if (hist.length === 0) return;
    histEl.innerHTML = '';
    hist.forEach(function(item) {
        var div = document.createElement('div');
        div.className = 'send-hist-item';
        div.textContent = item;
        div.addEventListener('click', function() {
            document.getElementById(mid + '-sendInput').value = item;
            histEl.classList.remove('open');
            document.getElementById(mid + '-sendInput').focus();
        });
        histEl.appendChild(div);
    });
    histEl.classList.add('open');
}

function leStr(mid) {
    var el = document.getElementById(mid + '-lineEnding');
    var v = el ? (el.getAttribute('data-val') || 'crlf') : 'crlf';
    return v==='crlf'?'\r\n': v==='lf'?'\n': v==='cr'?'\r':'';
}

/* ===== 日志 ===== */
async function chooseLogDir(mid) {
    mid = mid || 'main';
    try {
        var result = await invoke('choose_log_directory');
        if (result) {
            logDirPath = result;
            appendOutput(mid, 'sys', '日志目录: ' + logDirPath);
            invoke('update_workflow_log_dir', { monitorId: mid, logDir: logDirPath }).catch(function() {});
        }
    } catch (e) { appendOutput(mid, 'err', '选择目录失败: ' + e); }
}
async function saveLogToFile(mid) {
    mid = mid || 'main';
    try {
        var content = getOutputText(mid);
        await invoke('save_log', { content: content, path: logDirPath });
        showToast('日志保存成功', 'info');
    } catch (e) { showToast('保存失败: ' + e, 'error'); }
}
function copyOutput(mid) {
    var text = getOutputText(mid);
    if (!text) { appendOutput(mid, 'err', '没有可复制的内容。'); return; }
    // 优先使用 Clipboard API
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function() {
            appendOutput(mid, 'sys', '已复制。');
        }).catch(function() { fallbackCopy(mid, text); });
    } else {
        fallbackCopy(mid, text);
    }
}
// 把文本写进剪贴板：优先 Clipboard API，失败回退 execCommand。返回 Promise<boolean>。
// 抽成独立函数是为了让日志复制与 MCP 弹窗共用同一份实现（弹窗那边没有 monitor，用不了 fallbackCopy）。
function writeClipboard(text) {
    return new Promise(function(resolve) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text)
                .then(function() { resolve(true); })
                .catch(function() { resolve(_execCommandCopy(text)); });
        } else {
            resolve(_execCommandCopy(text));
        }
    });
}
function _execCommandCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
}
function fallbackCopy(mid, text) {
    var ok = _execCommandCopy(text);
    appendOutput(mid, ok ? 'sys' : 'err', ok ? '已复制。' : '复制失败。');
}
function getOutputText(mid) {
    // 优先从紧凑存储读取（保留完整日志，不受 DOM maxLines 限制）
    if (monitors[mid] && monitors[mid]._textCount > 0) {
        return bufferGetAllText(monitors[mid]);
    }
    // fallback：从 DOM 读取
    var output = document.getElementById(mid + '-output');
    if (!output) return '';
    return Array.from(output.querySelectorAll('.ol'))
        .map(function(l) {
            var lc = l.querySelector('.lc');
            return lc ? lc.textContent : '';
        }).join('\n');
}

/* ===== 输出区 ===== */
// 说明：原 decodeData() 包装函数已删除（零调用，功能由 decodeRaw 直接承担）。
function decodeRaw(bytes, mode) {
    mode = mode || 'text';
    var arr = new Uint8Array(bytes);
    if (mode === 'hex') return bytesToHex(arr);
    return _textDecoder.decode(arr);
}

var _scrollRaf = {}; // { elementId: rafId }
function requestScroll(el) {
    if (_scrollRaf[el.id]) return;
    _scrollRaf[el.id] = requestAnimationFrame(function() {
        _scrollRaf[el.id] = 0;
        el.scrollTop = el.scrollHeight;
    });
}

/// 输出行的**时间戳前缀**（「时间戳」开关关着时是空串）。
///
/// 为什么抽出来：`mcpSerialOp` 在"echo 关着、这次发送没进日志中心"时要**补记**一条 tx，
/// 那条也得戴上与界面一致的前缀 —— 两处各写一份格式化必然漂移（一处改了、另一处忘了）。
function outputTs(mid) {
    var tsEl = document.getElementById(mid + '-btnTs');
    var showTs = tsEl && tsEl.classList.contains('on');
    if (!showTs) return '';
    var now = new Date();
    return '[' + now.toTimeString().slice(0,8) + '.' + String(now.getMilliseconds()).padStart(3,'0') + '] ';
}

function appendOutput(mid, type, text, opts) {
    var el = document.getElementById(mid + '-output');
    if (!el) return;
    var ts = outputTs(mid);
    var div = document.createElement('div');
    div.className = 'ol ' + type;
    if (opts && opts.hex) div.classList.add('hex-view');
    var isEmpty = !text || text.trim() === '';
    var lnSpan = document.createElement('span');
    lnSpan.className = 'ln';
    lnSpan.setAttribute('contenteditable', 'false');
    if (!isEmpty) {
        if (!el._lineCount) el._lineCount = 0;
        el._lineCount++;
        lnSpan.textContent = String(el._lineCount);
    }
    div.appendChild(lnSpan);
    if (isEmpty) div.classList.add('empty-line');
    var contentSpan = document.createElement('span');
    contentSpan.className = 'lc';
    // 写入紧凑存储（保留完整日志，不受 maxLines 限制）
    if (monitors[mid] && !isEmpty) {
        bufferPush(mid, type, ts, text);
    }
    if (type === 'recv') {
        if (opts && opts.hex) {
            contentSpan.textContent = ts + text;
        } else if (text.indexOf('\x1b') === -1) {
            contentSpan.textContent = ts + text;
        } else {
            contentSpan.innerHTML = escapeHtml(ts) + parseAnsi(text);
        }
    } else if (type === 'send') {
        contentSpan.textContent = ts + text;
    } else {
        contentSpan.textContent = ts + text;
    }
    div.appendChild(contentSpan);
    var target = (opts && opts.fragment) ? opts.fragment : el;
    // 终端模式下，新行插到终端当前行之前（当前行保持在末尾），使设备输出显示在提示符上方
    var termCur = _terminalBuffers[mid] && _terminalBuffers[mid].lineEl;
    if (target === el && termCur && termCur.parentNode === el) {
        el.insertBefore(div, termCur);
    } else {
        target.appendChild(div);
    }
    // 维护“未结束的接收行”状态：opts.open 的 recv 行可接受后续数据合并，
    // 其余行（send/sys/hex/普通 recv）都会关闭当前打开行，避免跨输出合并
    var m = monitors[mid];
    if (m) {
        if (opts && opts.open && type === 'recv' && !(opts && opts.hex)) {
            m._recvPartialEl = div;
            m._recvPartial = text;
            m._recvPartialTs = ts;
            m._recvPartialOpen = true;
        } else {
            closeRecvPartial(m);
        }
    }
    if (!(opts && opts.fragment)) {
        trimOutputDom(mid, el);
        var scrollBtn = document.getElementById(mid + '-btnScroll');
        if (scrollBtn && scrollBtn.classList.contains('on')) requestScroll(el);
    }
    return div;
}

/* ===== 输出区 DOM 上限（M29）=====
 * 原逻辑在"用户在顶部看历史"或"有选区"时**整个跳过**清理，DOM 行数因此无上限增长
 * （每行是真实 DOM 元素，比字节缓冲贵得多）。现在改成：
 *   正常：超过 softLimit 就裁到 maxLines（与旧行为一致）
 *   受保护（在顶部 / 有选区）：只裁到 hardLimit，且只移除超出部分（最小干预）+ 滚动补偿
 *   有选区：把"补裁"挂到 selectionchange，选区一消失就补裁 —— 延后，而不是永远不裁 */
var OUT_DOM_MAX_LINES = 10000;
var OUT_DOM_SOFT_LIMIT = 15000;
var OUT_DOM_HARD_LIMIT = 60000;

function hasTextSelection() {
    var s = window.getSelection();
    return !!(s && s.toString().length > 0);
}

// 裁剪输出区 DOM；force=true 时忽略保护（用户已滚回底部）。返回移除的非空行数。
function trimOutputDom(mid, el, force) {
    if (!el || !el.firstChild) return 0;
    var m = monitors[mid];
    var hasSel = force ? false : hasTextSelection();
    var atTop = el.scrollTop < 100;
    var protect = !force && (atTop || hasSel);
    var limit = force ? OUT_DOM_MAX_LINES : (protect ? OUT_DOM_HARD_LIMIT : OUT_DOM_SOFT_LIMIT);
    if (el.children.length <= limit) {
        if (m && !hasSel) m._domTrimPending = false;
        return 0;
    }
    var target = protect ? OUT_DOM_HARD_LIMIT : OUT_DOM_MAX_LINES;
    var removeCount = el.children.length - target;
    if (removeCount <= 0) return 0;

    var prevScrollHeight = el.scrollHeight;
    var prevScrollTop = el.scrollTop;
    var removedNonEmpty = 0;
    // 按**元素行数**收敛（而不是"删 removeCount 个节点"）：输出区是 contenteditable，
    // 用户打字/粘贴可能给它插进**文本节点**，而文本节点没有 classList —— 老代码直接
    // `el.firstChild.classList.contains(...)` 会抛 TypeError，调用方的 catch 又只 console.warn，
    // 结果是**裁剪永久失效、DOM 无上限增长**（M29 修过的那个缺陷会这样复活）。
    // 所以：没有 classList 的节点照删，但不计行数；循环条件盯住 children.length（只数元素）。
    while (el.firstChild && el.children.length > target) {
        var first = el.firstChild;
        if (first.classList && !first.classList.contains('empty-line')) removedNonEmpty++;
        el.removeChild(first);
    }
    // ⚠️ **不要**因为裁掉了 N 行就把 `_lineCount` 减回去：它是"本次会话已输出过多少行"的
    // 全局计数器，残留行的行号就是按它写死的（见 appendOutput 里的 lnSpan）。减回去会让**新行
    // 复用仍然留在屏幕上的行号** —— 就是"行号重复"（2026-09 审计发现；历史行那条路另有
    // 重排行号的处理，见 rebuildOutput 附近的 P1-15）。裁掉的只是 DOM，不是"行号的历史"。
    if (m) {
        m._bufferStart += removedNonEmpty;
        // 还有选区且仍超标：标记待补裁，等 selectionchange 再裁到正常上限
        if (hasSel && el.children.length > OUT_DOM_SOFT_LIMIT) m._domTrimPending = true;
        else if (!hasSel) m._domTrimPending = false;
    }
    // 从顶部移除会让内容整体上移，把 scrollTop 减掉同样的高度，视觉位置保持不动
    if (prevScrollTop > 0) {
        var removedPx = prevScrollHeight - el.scrollHeight;
        var want = prevScrollTop - removedPx;
        el.scrollTop = want > 0 ? want : 0;
    }
    return removedNonEmpty;
}

// 选区消失后补裁（替换原先"有选区就永久跳过"的行为）
document.addEventListener('selectionchange', function() {
    if (hasTextSelection()) return;
    Object.keys(monitors).forEach(function(mid) {
        var m = monitors[mid];
        if (!m || !m._domTrimPending) return;
        var el = document.getElementById(mid + '-output');
        if (!el) { m._domTrimPending = false; return; }
        trimOutputDom(mid, el);
    });
});

function flushBatch(mid, fragment) {
    var el = document.getElementById(mid + '-output');
    if (!el || !fragment) return;
    // 终端模式下，批量数据插到终端当前行之前
    var termCur = _terminalBuffers[mid] && _terminalBuffers[mid].lineEl;
    if (termCur && termCur.parentNode === el) {
        el.insertBefore(fragment, termCur);
    } else {
        el.appendChild(fragment);
    }
    trimOutputDom(mid, el);
    var scrollBtn = document.getElementById(mid + '-btnScroll');
    if (scrollBtn && scrollBtn.classList.contains('on')) requestScroll(el);
}

