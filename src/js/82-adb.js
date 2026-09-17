/* 82-adb.js —— 前端第 12 块，拆自原单文件 src/index.html（**纯搬家**；行号映射见 doc/FRONTEND_LAYOUT.md）。
   ⚠️ **普通脚本**（不是 ESM）：按 index.html 里的 <script src> 顺序加载、共享同一个全局作用域 —— 行内 onclick
   与现有函数互相调用照旧；**别改成 type="module"**（模块作用域会让它们全部失效）。 */
/* ===== ADB 调试面板（前端壳） ===== */
function openAdb() {
    console.log('[ADB] 打开ADB调试页面');
    // 隐藏主面板与 WSL 面板，显示 ADB 面板
    document.getElementById('paneContainer').style.display = 'none';
    document.getElementById('wsl-pane').style.display = 'none';
    document.getElementById('adb-pane').style.display = 'flex';
    refreshMonitorPollRates();   // 页面切换 → 按可见性重设读取频率（隐藏的监视器降频）
    document.getElementById('ble-pane').style.display = 'none';
    var wBtn = document.getElementById('wslToggleBtn');
    if (wBtn) {
        wBtn.setAttribute('title', 'WSL 端口映射');
        wBtn.setAttribute('onclick', 'openWslMapping()');
        wBtn.classList.remove('active');
    }
    var bBtn = document.getElementById('bleToggleBtn');
    if (bBtn) {
        bBtn.setAttribute('title', '蓝牙调试');
        bBtn.setAttribute('onclick', 'openBle()');
        bBtn.classList.remove('active');
    }
    var bText = document.getElementById('bleToggleText');
    if (bText) bText.textContent = '蓝牙调试';
    var wText = document.getElementById('wslToggleText');
    if (wText) wText.textContent = 'WSL 端口映射';
    // 更新顶部栏按钮：进入后悬停提示「返回到串口调试器」
    var btn = document.getElementById('adbToggleBtn');
    if (btn) {
        btn.setAttribute('title', '返回到串口调试器');
        btn.setAttribute('onclick', 'closeAdb()');
        btn.classList.add('active');
    }
    var text = document.getElementById('adbToggleText');
    if (text) text.textContent = '返回到串口调试器';
    // 首次打开时填充 ADB 面板内容（占位）
    var adbPane = document.getElementById('adb-pane');
    if (!adbPane._initialized) {
        adbPane.style.flexDirection = 'column';
        adbPane.innerHTML =
            '<div style="display:flex;align-items:center;gap:16px;padding:10px 14px;border-bottom:1px solid var(--border);background:var(--toolbar-bg);flex-shrink:0;">' +
                '<div class="no-scrollbar" style="flex:1;overflow-x:auto;min-width:0;display:flex;align-items:center;gap:8px;" id="adb-deviceList"></div>' +
                '<button class="add-btn icon-btn" id="adbRefreshDevBtn" onclick="refreshAdbDevices()" title="重新扫描设备" style="background:var(--accent-focus);color:#fff;border:1px solid transparent;width:45px;height:30px;box-sizing:border-box;padding:0;margin:0;gap:0;border-radius:5px;font-size:12px;flex-shrink:0;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;">刷新</button>' +
            '</div>' +
            '<div style="flex:1;overflow:hidden;min-height:0;background:var(--editor-bg);" id="adb-sessionArea">' +
                '<div class="no-scrollbar" style="width:100%;height:100%;overflow-y:auto;display:flex;align-items:center;justify-content:center;font-family:var(--font-mono);color:var(--text-d);font-size:13px;">选择上方设备开始调试会话</div>' +
            '</div>';
        adbPane._initialized = true;
    }
    // 进入面板即刷新设备列表
    refreshAdbDevices();
    // 面板可见：恢复高频轮询
    setAllAdbPollRate(120);
    // ADB 面板打开期间自动刷新设备列表（每 5s；ADB 设备不在 COM 口 device-changed 通知范围内，靠此轮询）
    if (_adbDevTimer) clearInterval(_adbDevTimer);
    _adbDevTimer = setInterval(refreshAdbDevices, 5000);
    // ADB 界面隐藏了主监视器区，禁用「打开额外监视器」（同时清掉蓝牙页可能留下的高亮）
    var addBtn = document.getElementById('addMonitorBtn');
    if (addBtn) {
        addBtn.style.opacity = '0.4';
        addBtn.style.pointerEvents = 'none';
        addBtn.title = 'ADB 界面不可用';
        addBtn.classList.remove('active');
    }
}

function closeAdb() {
    console.log('[ADB] 返回监视器页面');
    document.getElementById('adb-pane').style.display = 'none';
    document.getElementById('paneContainer').style.display = 'flex';
    refreshMonitorPollRates();   // 页面切换 → 按可见性重设读取频率（隐藏的监视器降频）
    // 面板隐藏：ADB 会话降频轮询，避免离开后仍高频率空转后端
    setAllAdbPollRate(2000);
    // 离开 ADB 面板：停止设备列表自动刷新
    if (_adbDevTimer) { clearInterval(_adbDevTimer); _adbDevTimer = null; }
    // 返回主界面：恢复「打开额外监视器」
    var addBtn = document.getElementById('addMonitorBtn');
    if (addBtn) { addBtn.style.opacity = ''; addBtn.style.pointerEvents = ''; addBtn.title = '打开额外监视器'; addBtn.classList.remove('active'); }
    // 恢复顶部栏按钮
    var btn = document.getElementById('adbToggleBtn');
    if (btn) {
        btn.setAttribute('title', 'ADB 调试');
        btn.setAttribute('onclick', 'openAdb()');
        btn.classList.remove('active');
    }
    var text = document.getElementById('adbToggleText');
    if (text) text.textContent = 'ADB 调试';
}

// 点击应用图标回到串口监视器主界面
function goMain() {
    var wsl = document.getElementById('wsl-pane');
    if (wsl && wsl.style.display === 'flex') { restoreMonitorPane(); return; }
    var adb = document.getElementById('adb-pane');
    if (adb && adb.style.display === 'flex') { closeAdb(); return; }
    var ble = document.getElementById('ble-pane');
    if (ble && ble.style.display === 'flex') { closeBle(); return; }
}

/* ===== ADB 设备与会话（对接 Rust adb_devices/adb_shell） ===== */
var _adbSessions = 0;
var _adbDevTimer = null; // ADB 面板打开期间的设备列表自动刷新定时器（ADB/USB 设备不在 COM 口通知范围内，需轮询）
// 根据 adb 设备状态返回状态点颜色
function adbDotColor(state) {
    var st = (state || '').toLowerCase();
    if (st === 'device') return 'var(--accent-green)';
    if (st === 'offline') return 'var(--accent-orange)';
    if (st === 'unauthorized') return 'var(--accent-red)';
    if (st === 'no' || st === 'no-permissions' || st === 'no_permissions') return 'var(--accent-red)';
    if (st === 'recovery' || st === 'sideload' || st === 'bootloader' || st === 'connecting' || st === 'authorizing') return 'var(--accent-orange)';
    if (st === 'error' || st === 'failed' || st === 'unknown') return 'var(--accent-red)';
    return 'var(--accent-orange)';
}

function refreshAdbDevices() {
    console.log('[ADB] 刷新设备列表');
    var list = document.getElementById('adb-deviceList');
    if (!list) return;
    invoke('adb_devices').then(function(devices) {
        // 回填 TAB 补全用的设备序列号：此前 _adbSerials 恒为空，
        // 导致 `adb -s <TAB>` 没有任何候选（钩子早就留好了，只是没人填）
        _adbSerials = pickAdbSerials(devices);
        if (!Array.isArray(devices) || devices.length === 0) {
            list.innerHTML = '<span style="font-family:var(--font-mono);font-size:12px;color:var(--text-d);">未检测到 ADB 设备</span>';
            return;
        }
        // 有设备：移除占位/空状态等非卡片残留，避免与设备卡并存（上次从空到有设备时不刷新出提示）
        for (var n = list.children.length - 1; n >= 0; n--) {
            if (!list.children[n].classList || !list.children[n].classList.contains('adb-dev-card')) list.removeChild(list.children[n]);
        }
        var activeSerial = getActiveAdbSerial(); // 高亮与当前会话关联
        // 建立 serial -> 已有卡片映射，做增量更新
        var existing = {};
        var curCards = list.querySelectorAll('.adb-dev-card');
        for (var i = 0; i < curCards.length; i++) existing[curCards[i].getAttribute('data-serial')] = curCards[i];
        var seen = {};
        devices.forEach(function(d) {
            var dotColor = adbDotColor(d.state);
            var label = d.model ? d.model : d.serial;
            var card = existing[d.serial];
            if (!card) {
                card = document.createElement('div');
                card.className = 'adb-dev-card';
                card.setAttribute('data-serial', d.serial);
                card.style.cssText = 'display:inline-flex;align-items:center;gap:8px;padding:8px 12px;background:var(--surface-1);border:1px solid var(--border);border-radius:6px;cursor:pointer;font-family:var(--font-mono);font-size:12px;color:var(--text);';
                card.innerHTML = '<span class="adb-dot" style="width:8px;height:8px;border-radius:50%;flex-shrink:0;"></span><span class="adb-name"></span>';
                (function(serial){ card.addEventListener('click', function(){
                    var cards = list.querySelectorAll('.adb-dev-card');
                    for (var k=0;k<cards.length;k++) cards[k].classList.remove('active');
                    card.classList.add('active');
                    openAdbSession(serial);
                });})(d.serial);
                list.appendChild(card);
            }
            card.querySelector('.adb-dot').style.background = dotColor;
            card.querySelector('.adb-name').textContent = label;
            if (d.serial === activeSerial) card.classList.add('active'); else card.classList.remove('active');
            seen[d.serial] = true;
        });
        // 移除已不在列表中的设备卡
        Object.keys(existing).forEach(function(serial) {
            var c = existing[serial];
            if (!seen[serial] && c && c.parentNode) c.parentNode.removeChild(c);
        });
    }).catch(function(e) {
        console.warn('[ADB] 获取设备列表失败:', e);
        list.innerHTML = '<span style="font-family:var(--font-mono);font-size:12px;color:var(--text-d);">未检测到 ADB 设备（请检查 adb 是否已安装）</span>';
    });

}
// 让后端 PTY 尺寸与前端 xterm 实际容器尺寸保持一致。
// 修复：后端以往固定 40x120，前端容器尺寸不同且从未同步，
// 导致 busybox 按 40x120 的光标寻址/多列布局在前端渲染错位（乱码/重复/空白）。
function syncAdbTermSize(el) {
    if (!el) return;
    var term = el._adbTerm;
    if (!term) return;
    var box = term.element && term.element.parentElement;
    if (!box) return;
    // 面板隐藏（display:none）时容器尺寸为 0，此时跳过：
    // 否则会把终端/PTY 缩成 2x2，压碎缓冲区与 shell 布局（导致 "回到界面状态被清空/只剩提示符碎片"）。
    if (box.offsetParent === null) return;
    var boxW = box.clientWidth, boxH = box.clientHeight;
    if (!boxW || !boxH) return;
    var cw = 0, ch = 0;
    try {
        var d = term._core && term._core._renderService && term._core._renderService.dimensions;
        if (d && d.css && d.css.cell && d.css.cell.width > 0) {
            cw = d.css.cell.width; ch = d.css.cell.height;
        }
    } catch (_) {}
    if (cw <= 0 || ch <= 0) {
        try {
            var probe = document.createElement('span');
            probe.textContent = '0'.repeat(200);
            probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;left:-9999px;font-family:' +
                getComputedStyle(box).fontFamily + ';font-size:' + getComputedStyle(box).fontSize + ';';
            box.appendChild(probe);
            cw = probe.offsetWidth / 200;
            ch = parseFloat(getComputedStyle(box).lineHeight) || 16;
            probe.remove();
        } catch (_) { return; }
    }
    var cols = Math.max(2, Math.floor(boxW / cw));
    var rows = Math.max(2, Math.floor(boxH / ch));
    if (cols !== term.cols || rows !== term.rows) {
        term.resize(cols, rows);
    }
    console.log('[ADB] term size cols=' + cols + ' rows=' + rows + ' (实际 ' + term.cols + 'x' + term.rows + ')');
    if (el._adbPtyId) {
        invoke('adb_shell_resize', { sessionId: el._adbPtyId, cols: cols, rows: rows }).catch(function(e) {
            console.warn('[ADB] resize PTY 失败:', e);
        });
    }
}

// 当前正在显示的 ADB 会话元素（多会话：所有会话常驻，仅一个显示）
// 当前打开的 ADB 会话对应的设备序列号（单会话模型，最多一个）
function getActiveAdbSerial() {
    var area = document.getElementById('adb-sessionArea');
    if (!area) return null;
    var el = area.querySelector('[id^="adb-session-"]');
    return el ? (el._adbSerial || null) : null;
}

function openAdbSession(serial) {
    console.log('[ADB] 打开调试会话:', serial);
    var area = document.getElementById('adb-sessionArea');
    if (!area) return;
    // 已在打开/已连接的同一设备，忽略重复点击（避免重复连接）
    var cur = area.querySelector('[id^="adb-session-"]');
    if (cur && cur._adbSerial === serial) { if (cur._adbTerm) cur._adbTerm.focus(); return; }
    // 单会话切换：关闭并移除已有会话窗口
    var exist = area.querySelectorAll('[id^="adb-session-"]');
    for (var x = 0; x < exist.length; x++) closeAdbSession(exist[x].id);
    _adbSessions++;
    var sid = 'adb-session-' + _adbSessions;
    var el = document.createElement('div');
    el.id = sid;
    el.style.cssText = 'margin:0;flex:1;min-height:0;border:1px solid var(--border);border-radius:8px;display:flex;flex-direction:column;background:var(--surface-1);overflow:hidden;';
    el.innerHTML = '<div id="' + sid + '-termBox" style="flex:1;min-height:0;background:var(--editor-bg);"></div>';
    // 清空占位提示并设置纵向 flex 布局
    area.style.display = 'flex';
    area.style.flexDirection = 'column';
    area.style.padding = '0';
    var ph = area.querySelector('.no-scrollbar');
    if (ph && ph.parentNode === area && ph.children.length === 0) area.removeChild(ph);
    area.appendChild(el);
    // 会话状态
    el._adbSerial = serial;
    el._adbPtyId = null;
    el._adbReadTimer = null;
    el._adbTerm = null;
    // 创建 xterm 终端
    if (typeof Terminal === 'undefined') {
        el.innerHTML = '<div style="color:var(--accent-red);padding:12px;font-family:var(--font-mono);font-size:12px;">xterm.js 未加载</div>';
        return;
    }
    var term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: '"Cascadia Code", "JetBrains Mono", "Fira Code", Consolas, monospace',
        theme: { background: '#1c1e22', foreground: '#dce0e8', cursor: '#dce0e8' },
        scrollback: 1000,
    });
    term.open(el.querySelector('#' + sid + '-termBox'));
    term.writeln('');  // 留空行
    el._adbTerm = term;
    syncAdbTermSize(el);
    term.onResize(function() { syncAdbTermSize(el); });
    var tBox = el.querySelector('#' + sid + '-termBox');
    if (window.ResizeObserver) {
        el._adbResizeObserver = new ResizeObserver(function() { syncAdbTermSize(el); });
        el._adbResizeObserver.observe(tBox);
    }
    term.onData(function(data) {
        if (el._adbPtyId) {
            invoke('adb_shell_write', { sessionId: el._adbPtyId, data: data }).catch(function(err) {
                console.warn('[ADB] 写PTY失败:', err);
            });
        }
        if (el._adbTerm) el._adbTerm.scrollToBottom();
    });
    // 建立 PTY shell 会话
    invoke('adb_open_shell', { serial: serial }).then(function(pid) {
        // 若会话在打开期间已被关闭（如快速切换设备），立即回收刚建立的 PTY，避免孤儿连接
        if (el._adbClosed) { invoke('adb_shell_close', { sessionId: pid }).catch(function() {}); if (el._adbTerm) { try { el._adbTerm.dispose(); } catch(_) {} } return; }
        console.log('[ADB] PTY会话建立 pid=', pid);
        el._adbPtyId = pid;
        el._adbInited = true;
        // 会话建立后立刻把当前容器尺寸推给后端 PTY，并启动高频轮询
        syncAdbTermSize(el);
        setAdbPollRate(el, 120);
        term.focus();
    }).catch(function(e) {
        console.error('[ADB] 打开PTY会话失败:', e);
        // 失败原因要**留下来**：MCP 的 adb_open_shell 在等"真的开出来"，光往终端上写一行
        // 它看不见（那行是给人看的），于是 AI 只会拿到一句含糊的超时。
        el._adbOpenError = String((e && e.message) || e);
        term.writeln('\x1b[31m连接设备失败: ' + e + '\x1b[0m');
    });
}

// 设置某个 ADB 会话的轮询频率（ms）。用 setInterval 复用 _adbReadTimer。
function setAdbPollRate(el, ms) {
    if (!el) return;
    if (el._adbReadTimer) { clearInterval(el._adbReadTimer); el._adbReadTimer = null; }
    el._adbReadTimer = setInterval(function() { adbPtyPoll(el); }, ms);
}

// 根据面板显隐统一调整所有 ADB 会话的轮询频率：可见 120ms，隐藏降频到 2000ms，
// 避免离开 ADB 界面后仍以 8 次/秒空轮询后端 adb_shell_read（浪费 IPC/CPU）。
function setAllAdbPollRate(ms) {
    var area = document.getElementById('adb-sessionArea');
    if (!area) return;
    var els = area.querySelectorAll('[id^="adb-session-"]');
    for (var i = 0; i < els.length; i++) setAdbPollRate(els[i], ms);
}

// 读取 PTY 输出并写入 xterm（xterm 原生解析 ANSI/光标/多列）
function adbPtyPoll(el) {
    if (!el._adbPtyId) return;
    var term = el._adbTerm;
    if (!term) return;
    invoke('adb_shell_read', { sessionId: el._adbPtyId }).then(function(res) {
        if (!res) return;
        var bytes = res.bytes || [];
        if (bytes.length) {
            term.write(new Uint8Array(bytes));
            term.scrollToBottom();
        }
        // 积压丢弃要**说出来**（后端在 release 下没有控制台，只打 stderr 等于没提示）。
        // 与串口那路的"已丢弃 N 字节"同一条纪律：宁可提示一行，也不让用户以为设备就输出这么多。
        if (res.dropped) {
            term.write('\r\n\x1b[33m[提示] 前端消费不及时，已丢弃 ' + res.dropped
                + ' 块输出（后台命令刷得太快时可切走页面减少输出）\x1b[0m\r\n');
            term.scrollToBottom();
        }
    }).catch(function() {});
}

function closeAdbSession(sid) {
    var el = document.getElementById(sid);
    if (el) {
        el._adbClosed = true; // 标记已关闭：若 adb_open_shell 尚未 resolve，回调里据此回收 PTY
        if (el._adbReadTimer) { clearInterval(el._adbReadTimer); el._adbReadTimer = null; }
        if (el._adbResizeObserver) { try { el._adbResizeObserver.disconnect(); } catch(_) {} el._adbResizeObserver = null; }
        if (el._adbTerm) { try { el._adbTerm.dispose(); } catch(_) {} }
        if (el._adbPtyId) {
            invoke('adb_shell_close', { sessionId: el._adbPtyId }).catch(function() {});
        }
        if (el.parentNode) el.parentNode.removeChild(el);
    }
}

// WSL 发行版启动/关闭，操作后延迟刷新 UI
function wslDistAction(cmd, dist) {
    // 找到被点击的按钮，显示加载动画
    var btn = window.event && window.event.target;
    if (btn && btn.tagName === 'BUTTON') {
        btn.disabled = true;
        btn._origText = btn.textContent;
        btn.innerHTML = '<span style="display:inline-block;width:10px;height:10px;border:2px solid rgba(255,255,255,0.3);border-top-color:#fff;border-radius:50%;animation:wsl-spin .6s linear infinite;vertical-align:middle;"></span>';
    }
    invoke(cmd, {dist: dist}).then(function() {
        // 操作完成后延迟刷新，等待 WSL 状态稳定
        setTimeout(function() {
            document.querySelectorAll('[id$="-wslDistroList"]').forEach(function(el) {
                var mid = el.id.replace('-wslDistroList', '');
                var fn = el.closest('.monitor-pane');
                if (fn) {
                    invokeTimeout('get_wsl_distributions', null, 6000).then(function(distros) {
                        renderWslDistroCards(mid, distros);
                    }).catch(function(e) { console.warn('[WSL] 获取发行版失败:', e); });
                    invoke('check_wsl_status').then(function(dists) {
                        _wslRunning = dists && dists.length > 0;
                        setWslMonitorEnabled(_wslRunning);
                        renderWslDeviceList(mid);
                    }).catch(function(e) { console.warn('[WSL] 检查 WSL 状态失败:', e); });
                }
            });
        }, 1500);
    }).catch(function(e) {
        console.error('[WSL] 操作失败:', cmd, dist, e);
        if (btn) {
            btn.disabled = false;
            btn.textContent = btn._origText || dist;
        }
    });
}

// WSL设备数据
var _wslDevices = [];
var _wslBusy = {}; // { busid: true } 正在操作中的设备
var _wslRefreshing = false; // 单飞：避免取消映射后多路重扫并发挤压（E9）
var _wslSelectedBusid = null; // 选中的设备行
var _wslAutoMap = {}; // { vidpid: portName } 开启自动映射的设备（按 VID:PID 匹配，而非 busid）
var _wslAutoFailCount = {}; // { vidpid: n } 自动映射连续失败次数（>=3 暂停重试）
var _wslAutoMapTimer = null;
var _wslAutoMapRunning = false; // autoMapCheck 重入保护：定时器与设备变更事件可能并发触发
var _wslSavedConfig = null; // 缓存从配置文件加载的 WSL 监视器配置，防止主监视器保存时丢失
var _wslStatusUnlisten = null; // WSL 状态事件监听取消函数
var _wslRunning = false; // WSL 是否正在运行
var _wslUptimeTimer = null;
var _wslDevListTimer = null; // WSL 面板打开期间的设备列表轮询
var _wslDistroBasetime = {};

function wslFormatUptime(totalSeconds) {
    var h = Math.floor(totalSeconds / 3600);
    var m = Math.floor((totalSeconds % 3600) / 60);
    var s = Math.floor(totalSeconds % 60);
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

function startWslUptimeTicker(mid) {
    if (_wslUptimeTimer) { clearInterval(_wslUptimeTimer); _wslUptimeTimer = null; }
    if (Object.keys(_wslDistroBasetime).length === 0) return;
    _wslUptimeTimer = setInterval(function() {
        var now = Date.now();
        Object.keys(_wslDistroBasetime).forEach(function(name) {
            var bt = _wslDistroBasetime[name];
            if (!bt) return;
            var elapsed = Math.floor((now - bt.anchorMs) / 1000);
            var total = bt.baseSeconds + elapsed;
            var el = document.getElementById('uptime-' + mid + '-' + name);
            if (el) el.textContent = wslFormatUptime(total);
        });
    }, 1000);
}

function stopWslUptimeTicker() {
    if (_wslUptimeTimer) { clearInterval(_wslUptimeTimer); _wslUptimeTimer = null; }
    _wslDistroBasetime = {};
}

function sortWslDevices() {
    _wslDevices.sort(function(a, b) {
        return (a.busid || '').localeCompare(b.busid || '', undefined, { numeric: true, sensitivity: 'base' });
    });
}

// 带超时的 invoke：后端命令挂起（如 UAC 弹窗未确认）时前端不会永久等待
function invokeTimeout(cmd, args, ms) {
    ms = ms || 8000;
    var timer = null;
    return Promise.race([
        invoke(cmd, args),
        new Promise(function(_, reject) {
            timer = setTimeout(function() { reject(new Error(cmd + ' 执行超时')); }, ms);
        })
    ]).finally(function() {
        // 竞态结束（无论胜负）都清除超时定时器，避免高频调用堆积悬空 timer
        if (timer) clearTimeout(timer);
    });
}

async function loadWslDevices(mid) {
    console.log('[WSL] 加载设备列表');
    var container = document.getElementById(mid + '-wslDeviceList');
    if (!container) {
        console.error('[WSL] 未找到设备列表容器');
        return;
    }
    // 单飞：取消映射后多路重扫会同时触发，避免并发挤压 + 全量 DOM 重建（E9）
    if (_wslRefreshing) return;
    _wslRefreshing = true;
    
    try {
        var devices = await invokeTimeout('list_wsl_devices', null, 15000);
        
        // 保留正在操作中的设备（防止取消映射后设备消失）
        var newBusids = {};
        devices.forEach(function(d) { newBusids[d.busid] = true; });
        _wslDevices.forEach(function(d) {
            if (_wslBusy[d.busid] && !newBusids[d.busid]) {
                devices.push(d);
            }
        });
        
        _wslDevices = devices;
        sortWslDevices();
        
        console.log('[WSL] 设备列表:', _wslDevices);
        renderWslDeviceList(mid);
    } catch (e) {
        console.error('[WSL] 加载设备列表失败:', e);
        // 错误文本可能含 usbipd/WSL 命令输出 → 用 textContent，不要拼进 innerHTML
        container.innerHTML = '<div style="color:var(--accent-red);text-align:center;padding:20px;"></div>';
        container.firstChild.textContent = '加载失败: ' + e;
        reportError(e, 'loadWslDevices');
    } finally {
        _wslRefreshing = false;
    }
}

var _wslNameHeaderMargin = null;
// 测量"设备名称"标题需要右移的量：让 端口↔设备名称 的标题间距 = BUSID↔端口 的标题间距
function wslNameHeaderMargin() {
    if (_wslNameHeaderMargin !== null) return _wslNameHeaderMargin;
    try {
        var probe = document.createElement('div');
        probe.style.cssText = 'position:fixed;left:-9999px;top:0;visibility:hidden;display:flex;align-items:center;gap:14px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;';
        probe.innerHTML = '<span style="width:64px;flex-shrink:0;text-align:center;">BUSID</span>' +
                          '<span style="min-width:140px;flex-shrink:0;text-align:center;">端口</span>' +
                          '<span>设备名称</span>';
        document.body.appendChild(probe);
        var s = probe.querySelectorAll('span');
        var gapAB = s[1].getBoundingClientRect().left - s[0].getBoundingClientRect().right;
        var gapBC = s[2].getBoundingClientRect().left - s[1].getBoundingClientRect().right;
        probe.remove();
        _wslNameHeaderMargin = Math.max(0, Math.round(gapAB - gapBC));
    } catch (_) {
        _wslNameHeaderMargin = 0;
    }
    return _wslNameHeaderMargin;
}

