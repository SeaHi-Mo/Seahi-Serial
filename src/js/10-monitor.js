/* 10-monitor.js —— 前端第 2 块，拆自原单文件 src/index.html（**纯搬家**；行号映射见 doc/FRONTEND_LAYOUT.md）。
   ⚠️ **普通脚本**（不是 ESM）：按 index.html 里的 <script src> 顺序加载、共享同一个全局作用域 —— 行内 onclick
   与现有函数互相调用照旧；**别改成 type="module"**（模块作用域会让它们全部失效）。 */
/* ===== Toast 通知 ===== */
function showToast(message, type) {
    type = type || 'info';
    var toasts = document.querySelectorAll('.toast');
    var offset = 0;
    toasts.forEach(function(t) { if (t.style.display !== 'none') offset += 44; });
    var toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.textContent = message;
    toast.style.top = (40 + offset) + 'px';
    if (type === 'error') { toast.style.cursor = 'pointer'; toast.title = '点击关闭'; toast.addEventListener('click', function() { toast.remove(); }); }
    document.body.appendChild(toast);
    setTimeout(function() { toast.classList.add('show'); }, 10);
    var autoHideMs = type === 'error' ? 5000 : 3000;
    setTimeout(function() {
        toast.classList.remove('show');
        setTimeout(function() { toast.remove(); }, 300);
    }, autoHideMs);
}

/* ===== 创建监视器窗格 ===== */
function createMonitorPane(mid, title, closable) {
    const closeBtn = closable ? '<button class="pane-close" onclick="closeMonitor(\'' + mid + '\')" title="关闭">\u2715</button>' : '';
    const baudOpts = [50,75,110,134,150,200,300,600,1200,1800,2400,4800,7200,9600,14400,19200,28800,38400,57600,115200,230400,460800,500000,576000,921600,1000000,1152000,1500000,2000000,2500000,3000000,3500000,4000000].map(v =>
        '<div class="baud-opt' + (v===115200?' active':'') + '" onclick="setBaud(\'' + mid + '\',' + v + ')">' + v + '</div>'
    ).join('');

    const pane = document.createElement('div');
    pane.className = 'monitor-pane';
    pane.id = 'pane-' + mid;
    pane.innerHTML =
        (closable ? '<div class="pane-header pane-header-thin" id="' + mid + '-paneHeader">' + closeBtn + '</div>' : '') +
        '<div class="toolbar-wrap" id="' + mid + '-tbWrap"><div class="toolbar">' +
            '<span class="lbl">查看</span>' +
            '<div class="sel" id="' + mid + '-viewMode" data-val="text" onclick="toggleSelDrop(this)">' +
                '<span class="sel-text">文本</span><span class="sel-arrow">&#9660;</span>' +
                '<div class="sel-drop">' +
                    '<div class="sel-opt active" data-val="text" onclick="setSel(this,\'text\',event)">文本</div>' +
                    '<div class="sel-opt" data-val="hex" onclick="setSel(this,\'hex\',event)">HEX</div>' +
                '</div>' +
            '</div>' +
            '<span class="lbl">端口</span>' +
            '<div class="sel sel-port" id="' + mid + '-portSelect" onclick="toggleSelDrop(this)" style="min-width:252px;">' +
                '<span class="sel-text">加载中...</span><span class="sel-arrow">&#9660;</span>' +
                '<div class="sel-drop" id="' + mid + '-portDrop"></div>' +
            '</div>' +
            '<button class="btn-ref" onclick="refreshPorts(\'' + mid + '\')" title="刷新端口">' + ICONS.refresh + '</button>' +
            '<span class="lbl">波特率</span>' +
            '<div class="baud-wrap" id="' + mid + '-baudWrap">' +
                '<input class="baud-input" id="' + mid + '-baudRate" type="number" value="115200" min="110" max="4000000" autocomplete="off">' +
                '<button class="baud-arrow" onclick="toggleBaudDropdown(event,\'' + mid + '\')" title="波特率">&#9660;</button>' +
                '<div class="baud-dropdown" id="' + mid + '-baudDropdown">' + baudOpts + '</div>' +
            '</div>' +
            '<span class="lbl">行尾</span>' +
            '<div class="sel" id="' + mid + '-lineEnding" data-val="crlf" onclick="toggleSelDrop(this)">' +
                '<span class="sel-text">CRLF</span><span class="sel-arrow">&#9660;</span>' +
                '<div class="sel-drop">' +
                    '<div class="sel-opt active" data-val="crlf" onclick="setSel(this,\'crlf\',event)">CRLF</div>' +
                    '<div class="sel-opt" data-val="lf" onclick="setSel(this,\'lf\',event)">LF</div>' +
                    '<div class="sel-opt" data-val="cr" onclick="setSel(this,\'cr\',event)">CR</div>' +
                    '<div class="sel-opt" data-val="none" onclick="setSel(this,\'none\',event)">无</div>' +
                '</div>' +
            '</div>' +
            '<button class="btn-main start" id="' + mid + '-btnStart" onclick="toggleConnection(\'' + mid + '\')">' +
                '<span style="font-size:11px;">&#9654;</span> 开始监控' +
            '</button>' +
            '<div class="tsep"></div>' +
            '<div class="ibtn-group" id="' + mid + '-ibtnGroup">' +
            '<button class="ibtn" onclick="clearLog(\'' + mid + '\')" title="清除内容">' + ICONS.clear + '</button>' +
            '<button class="ibtn on" id="' + mid + '-btnScroll" onclick="toggleIbtn(this)" title="自动滚动">' + ICONS.rollback + '</button>' +
            '<button class="ibtn" id="' + mid + '-btnAutoReconnect" onclick="toggleIbtn(this)" title="自动重连">' + ICONS.reconnect + '</button>' +
            '<button class="ibtn" id="' + mid + '-btnSendLE" onclick="toggleTerminalMode(this,\'' + mid + '\')" title="终端模式">' + ICONS.terminal + '</button>' +
            '<button class="ibtn" id="' + mid + '-btnLineNum" onclick="toggleLineNum(this,\'' + mid + '\')" title="显示行号">' + ICONS.lineNum + '</button>' +
            '<button class="ibtn" id="' + mid + '-btnTs" onclick="toggleIbtn(this)" title="开启时间戳">' + ICONS.timestamp + '</button>' +
            '<button class="ibtn" id="' + mid + '-btnEcho" onclick="toggleIbtn(this)" title="启动消息回显">' + ICONS.copy + '</button>' +
            '<button class="ibtn" id="' + mid + '-btnAdv" onclick="toggleAdv(\'' + mid + '\')" title="更多设置">' + ICONS.settings + '</button>' +
            '</div>' +
        '</div>' +
        '<div class="adv-row" id="' + mid + '-advRow">' +
            '<span class="lbl">数据位</span>' +
            '<div class="sel" id="' + mid + '-dataBits" onclick="toggleSelDrop(this)">' +
                '<span class="sel-text">8</span><span class="sel-arrow">&#9660;</span>' +
                '<div class="sel-drop">' +
                    '<div class="sel-opt" data-val="5" onclick="setSel(this,\'5\',event)">5</div>' +
                    '<div class="sel-opt" data-val="6" onclick="setSel(this,\'6\',event)">6</div>' +
                    '<div class="sel-opt" data-val="7" onclick="setSel(this,\'7\',event)">7</div>' +
                    '<div class="sel-opt active" data-val="8" onclick="setSel(this,\'8\',event)">8</div>' +
                '</div>' +
            '</div>' +
            '<span class="lbl">停止位</span>' +
            '<div class="sel" id="' + mid + '-stopBits" onclick="toggleSelDrop(this)">' +
                '<span class="sel-text">1</span><span class="sel-arrow">&#9660;</span>' +
                '<div class="sel-drop">' +
                    '<div class="sel-opt active" data-val="1" onclick="setSel(this,\'1\',event)">1</div>' +
                    '<div class="sel-opt" data-val="2" onclick="setSel(this,\'2\',event)">2</div>' +
                '</div>' +
            '</div>' +
            '<span class="lbl">校验位</span>' +
            '<div class="sel" id="' + mid + '-parity" onclick="toggleSelDrop(this)">' +
                '<span class="sel-text">无</span><span class="sel-arrow">&#9660;</span>' +
                '<div class="sel-drop">' +
                    '<div class="sel-opt active" data-val="none" onclick="setSel(this,\'none\',event)">无</div>' +
                    '<div class="sel-opt" data-val="odd" onclick="setSel(this,\'odd\',event)">奇校验</div>' +
                    '<div class="sel-opt" data-val="even" onclick="setSel(this,\'even\',event)">偶校验</div>' +
                '</div>' +
            '</div>' +
            '<div class="chk-wrap"><input type="checkbox" id="' + mid + '-chkDTR" onchange="toggleDTR(\'' + mid + '\',this.checked)"><label for="' + mid + '-chkDTR">DTR</label></div>' +
            '<div class="chk-wrap"><input type="checkbox" id="' + mid + '-chkRTS" checked onchange="toggleRTS(\'' + mid + '\',this.checked)"><label for="' + mid + '-chkRTS">RTS</label></div>' +
            '<button class="btn-logdir" onclick="chooseLogDir(\'' + mid + '\')">&#128193; 选择日志目录</button>' +
            '<button class="ibtn" onclick="saveLogToFile(\'' + mid + '\')" title="保存日志">' + ICONS.saveLog + '</button>' +
            '<button class="ibtn" onclick="copyOutput(\'' + mid + '\')" title="复制全部">' + ICONS.copyAll + '</button>' +
            '<button class="ibtn" id="' + mid + '-btnCollapseTb" onclick="toggleToolbarCollapse(\'' + mid + '\')" title="折叠工具栏">' + ICONS.chevronUp + '</button>' +
            '<div style="flex:1;"></div>' +
            '<button class="wf-add-btn" onclick="addWorkflowRule(\'' + mid + '\')">+ 添加规则</button>' +
        '</div>' +
        '</div>' +
        '<div class="adv-wf-wrap" id="' + mid + '-advWf">' +
            '<div class="wf-list" id="' + mid + '-wfList"></div>' +
        '</div>' +
        '<div class="mon-body">' +
        '<div class="output" contenteditable="true" id="' + mid + '-output"></div>' +
        qcmdSideHtml(mid) +
        '</div>' +
        '<div class="send-bar" id="' + mid + '-sendBar">' +
            '<div class="send-wrap" id="' + mid + '-sendWrap">' +
                '<input class="send-inp" id="' + mid + '-sendInput" placeholder="输入要发送的内容，回车发送..." autocomplete="off" spellcheck="false">' +
                '<div class="send-hist" id="' + mid + '-sendHist"></div>' +
            '</div>' +
            '<div class="send-as" id="' + mid + '-sendAs" onclick="toggleSendAsDrop(\'' + mid + '\')">' +
                '<span class="send-as-text" id="' + mid + '-sendAsText">文本</span>' +
                '<span class="send-as-arrow">&#9660;</span>' +
                '<div class="send-as-drop" id="' + mid + '-sendAsDrop">' +
                    '<div class="send-as-opt active" data-val="text" onclick="setSendAs(\'' + mid + '\',\'text\',this,event)">文本</div>' +
                    '<div class="send-as-opt" data-val="hex" onclick="setSendAs(\'' + mid + '\',\'hex\',this,event)">HEX</div>' +
                '</div>' +
            '</div>' +
            '<span class="ssep">|</span>' +
            '<button class="btn-send" id="' + mid + '-btnSend" onclick="sendData(\'' + mid + '\')" disabled>' +
                '<span style="font-size:10px;">&#9654;</span> 发送' +
            '</button>' +
        '</div>';

    document.getElementById('paneContainer').appendChild(pane);
    monitors[mid] = { isConnected: false, portName: '', readTimer: null, sendHistory: [], histNavIdx: -1, _editing: false, quickCmds: [
        // 首次启动：**一组、一条空指令**（用户 2026-09 定的默认）。组由 qcmdGroups() 现场包出来。
        // 每条只剩：顺序号(seq) / 指令(value) / 延时(delay) / HEX(hex)，名称已退出界面（label 留空）
        {label:'', value:'', seq:0, timeout:QCMD_TIMEOUT_DEFAULT, hex:false}
    ], workflows: [], _bufferStart: 0,
    // 紧凑存储：TypedArray 替代对象数组
    _textData: new Uint8Array(TEXT_BUF_INIT),  // 起步 64 KB，按需翻倍（原来固定 1 MB）
    _textDataLen: 0,
    _textDataMaxBytes: 8 * 1024 * 1024,       // 紧凑存储字节预算（M29：按字节而非行数限制）
    _textOffsets: new Uint32Array(TEXT_IDX_INIT),  // 偏移表（每行结束位置）
    _textTypes: new Uint8Array(TEXT_IDX_INIT),     // 类型表（0=recv,1=send,2=sys,3=err）
    _textTsLens: new Uint16Array(TEXT_IDX_INIT),   // 时间戳长度
    _textCount: 0};

    // 新建监视器默认展开高级设置
    var advRow = document.getElementById(mid + '-advRow');
    if (advRow) advRow.classList.add('vis');
    var advBtn = document.getElementById(mid + '-btnAdv');
    if (advBtn) advBtn.classList.add('on');

    // 输出区域编辑状态检测：进入编辑关自动滚动，退出恢复
    var outputEl = document.getElementById(mid + '-output');
    if (outputEl) {
        outputEl.addEventListener('focus', function() {
            if (!monitors[mid]) return;
            monitors[mid]._editing = true;
            var btn = document.getElementById(mid + '-btnScroll');
            if (btn && btn.classList.contains('on')) {
                monitors[mid]._autoScrollSaved = true;
                btn.classList.remove('on');
            }
        });
        outputEl.addEventListener('blur', function() {
            if (!monitors[mid]) return;
            monitors[mid]._editing = false;
            if (monitors[mid]._autoScrollSaved) {
                var btn = document.getElementById(mid + '-btnScroll');
                if (btn) btn.classList.add('on');
                monitors[mid]._autoScrollSaved = false;
            }
        });
        // 鼠标移开输出监控区时恢复自动滚动并清除光标（无需离开整个监视器面板）
        outputEl.addEventListener('mouseleave', function() {
            if (!monitors[mid]) return;
            // 恢复自动滚动（若因点击输出而暂停）
            if (monitors[mid]._autoScrollSaved) {
                var btn = document.getElementById(mid + '-btnScroll');
                if (btn) btn.classList.add('on');
                monitors[mid]._autoScrollSaved = false;
            }
            // 终端模式下保留输入光标；有文本选区时不打断复制
            var sel = window.getSelection();
            if (_terminalBuffers[mid] || (sel && sel.toString().length > 0)) return;
            // 移开鼠标后清除监控区里残留的编辑光标
            if (document.activeElement === outputEl) outputEl.blur();
        });
        // 滚动到顶部时加载更多历史
        var _loadingHistory = false;
        var _mouseDown = false;
        outputEl.addEventListener('mousedown', function() { _mouseDown = true; });
        // 绑在 outputEl 而不是 document：绑 document 时每个监视器都会留一个永不解绑的
        // 监听器（闭包还持有整个 initMonitor 作用域），反复开关串口就持续泄漏
        outputEl.addEventListener('mouseup', function() { _mouseDown = false; });
        outputEl.addEventListener('scroll', function() {
            if (_loadingHistory || _mouseDown) return;
            // 用户有文本选中时不加载，避免打断复制操作
            var sel = window.getSelection();
            if (sel && sel.toString().length > 0) return;
            if (outputEl.scrollTop < 50 && monitors[mid] && monitors[mid]._bufferStart > 0) {
                _loadingHistory = true;
                loadMoreHistory(mid, outputEl, function() { _loadingHistory = false; });
            }
            // 滚回底部时，清理多余旧行
            if (outputEl.scrollTop + outputEl.clientHeight >= outputEl.scrollHeight - 20) {
                cleanupExtraLines(mid, outputEl);
            }
        });
    }

    // 初始化快速指令列表（按"组"建：列标题 + 每组抬头 + 组内指令）
    rebuildQcmdList(mid);

    // 绑定键盘：Enter 发送，上/下箭头浏览历史
    var sendInput = document.getElementById(mid + '-sendInput');
    sendInput.addEventListener('keydown', function(e) {
        var hist = monitors[mid].sendHistory;
        var histEl = document.getElementById(mid + '-sendHist');
        if (e.key === 'Enter') {
            e.preventDefault();
            if (histEl.classList.contains('open')) {
                // 如果历史下拉打开且有选中项，选择它
                var selItem = histEl.querySelector('.send-hist-item.selected');
                if (selItem) {
                    sendInput.value = selItem.textContent;
                    histEl.classList.remove('open');
                    sendInput.focus();
                    return;
                }
            }
            sendData(mid);
            histEl.classList.remove('open');
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (histEl.classList.contains('open')) {
                var selItem = histEl.querySelector('.send-hist-item.selected');
                if (selItem && selItem.nextElementSibling) {
                    selItem.classList.remove('selected');
                    selItem.nextElementSibling.classList.add('selected');
                    selItem.nextElementSibling.scrollIntoView({ block: 'nearest' });
                }
            } else if (hist.length > 0) {
                showSendHistory(mid);
                var items = histEl.querySelectorAll('.send-hist-item');
                if (items.length > 0) items[0].classList.add('selected');
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (histEl.classList.contains('open')) {
                var selItem = histEl.querySelector('.send-hist-item.selected');
                if (selItem && selItem.previousElementSibling) {
                    selItem.classList.remove('selected');
                    selItem.previousElementSibling.classList.add('selected');
                    selItem.previousElementSibling.scrollIntoView({ block: 'nearest' });
                } else if (!selItem || !selItem.previousElementSibling) {
                    histEl.classList.remove('open');
                }
            } else if (hist.length > 0) {
                // 上箭头：直接填入上一条历史（类似终端行为）
                monitors[mid].histNavIdx = Math.min(monitors[mid].histNavIdx + 1, hist.length - 1);
                sendInput.value = hist[monitors[mid].histNavIdx];
            }
        } else if (e.key === 'Escape') {
            histEl.classList.remove('open');
            monitors[mid].histNavIdx = -1;
        }
    });
    // 输入时重置历史导航索引
    sendInput.addEventListener('input', function() { monitors[mid].histNavIdx = -1; });

    // 波特率手动输入 → 自动保存
    var baudInput = document.getElementById(mid + '-baudRate');
    if (baudInput) baudInput.addEventListener('change', function() { scheduleConfigSave(); });
    // DTR/RTS checkbox → 自动保存
    ['chkDTR','chkRTS'].forEach(function(key) {
        var el = document.getElementById(mid + '-' + key);
        if (el) el.addEventListener('change', function() { scheduleConfigSave(); });
    });

    refreshPorts(mid);
    
    // 初始化终端模式
    initTerminalMode(mid);
}

/* ===== 波特率下拉 ===== */
function toggleBaudDropdown(e, mid) {
    e.stopPropagation();
    document.getElementById(mid + '-baudDropdown').classList.toggle('open');
}
function setBaud(mid, val) {
    var oldVal = parseInt(document.getElementById(mid + '-baudRate').value) || 0;
    document.getElementById(mid + '-baudRate').value = val;
    document.getElementById(mid + '-baudDropdown').classList.remove('open');
    var drop = document.getElementById(mid + '-baudDropdown');
    drop.querySelectorAll('.baud-opt').forEach(function(o) {
        o.classList.toggle('active', o.textContent.trim() === String(val));
    });
    scheduleConfigSave();
    // 如果端口已连接且波特率发生变化，自动重连
    if (monitors[mid] && monitors[mid].isConnected && val !== oldVal) {
        if (monitors[mid]._reconnecting) return;
        monitors[mid]._reconnecting = true;
        var savedPort = monitors[mid].portName;
        var isWsl = monitors[mid].isWsl;
        appendOutput(mid, 'sys', '波特率从 ' + oldVal + ' 切换到 ' + val + '，正在重新连接...');
        var btn = document.getElementById(mid + '-btnStart');
        if (btn) { btn.disabled = true; btn.innerHTML = '<span style="font-size:11px;">⏳</span> 切换中...'; }
        (async function() {
            // 捕获监视器引用；切换期间用户可能关闭监视器（delete monitors[mid]），需判空避免崩溃
            var m = monitors[mid];
            try {
                if (isWsl) { await invoke('close_wsl_serial', { monitorId: mid }); }
                else { await invoke('close_port', { monitorId: mid }); }
                if (!m) { return; }
                m.isConnected = false;
                stopReading(mid);
                logCacheEnd(mid); // 切换端口：结束旧会话缓存，新连接会另开文件
                updateMonitorUI(mid, false);
                if (isWsl) { await connectWslPort(mid); }
                else { await connectPort(mid, true); }
                if (!m.isConnected && savedPort) {
                    if (isWsl) { reconnectWslPort(mid, savedPort); }
                    else { reconnectPort(mid, savedPort, 1); }
                }
            } catch (e) {
                console.error('[setBaud] 重连失败:', e);
                if (m) { try { reportError(e, 'setBaud'); } catch (_) {} }
            } finally {
                // 无论成败都复位，避免 _reconnecting 卡死导致后续波特率/端口切换被永久拦截（E7）
                if (m) m._reconnecting = false;
                var btn2 = document.getElementById(mid + '-btnStart');
                if (btn2) { btn2.disabled = false; btn2.innerHTML = '开始监控'; }
                if (m) updateMonitorUI(mid, m.isConnected);
            }
        })();
    }
}
// 点击外部关闭所有下拉
document.addEventListener('click', function(e) {
    document.querySelectorAll('.baud-dropdown.open').forEach(function(dd) {
        var wrap = dd.closest('.baud-wrap');
        if (wrap && !wrap.contains(e.target)) dd.classList.remove('open');
    });
    document.querySelectorAll('.send-hist.open').forEach(function(h) {
        var wrap = h.closest('.send-wrap');
        if (wrap && !wrap.contains(e.target)) h.classList.remove('open');
    });
    document.querySelectorAll('.send-as-drop.open').forEach(function(d) {
        var wrap = d.closest('.send-as');
        if (wrap && !wrap.contains(e.target)) d.classList.remove('open');
    });
    document.querySelectorAll('.sel-drop.open').forEach(function(d) {
        var wrap = d.closest('.sel');
        if (wrap && !wrap.contains(e.target)) d.classList.remove('open');
    });
});

/* ===== 通用下拉选择 ===== */
function toggleSelDrop(el) {
    var drop = el.querySelector('.sel-drop');
    if (!drop) return;
    var willOpen = !drop.classList.contains('open');
    drop.classList.toggle('open');
    if (willOpen) {
        // 空间不足时向上翻转（复用 .sel-drop-up 样式），避免下拉超出窗口底部被裁
        try {
            var r = drop.getBoundingClientRect();
            if (r.bottom > window.innerHeight - 8 && r.top > window.innerHeight / 2) {
                drop.classList.add('sel-drop-up');
            } else {
                drop.classList.remove('sel-drop-up');
            }
        } catch (_) {}
    }
}
function setSel(optEl, val, e) {
    if (e) e.stopPropagation();
    var sel = optEl.closest('.sel');
    var drop = sel.querySelector('.sel-drop');
    var text = sel.querySelector('.sel-text');
    text.textContent = optEl.textContent;
    drop.querySelectorAll('.sel-opt').forEach(function(o) { o.classList.remove('active'); });
    optEl.classList.add('active');
    drop.classList.remove('open');
    sel.setAttribute('data-val', val);
    scheduleConfigSave();
    // 行尾设置同步到后台工作流线程（连接中即时生效，无需重连）
    var selId = sel.id || '';
    if (selId.indexOf('-lineEnding') > 0) {
        var mid = selId.replace('-lineEnding', '');
        if (monitors[mid] && monitors[mid].isConnected) {
            invoke('update_workflow_line_ending', { monitorId: mid, lineEnding: val }).catch(function() {});
        }
    }
}

/* ===== 格式选择下拉 ===== */
function toggleSendAsDrop(mid) {
    document.getElementById(mid + '-sendAsDrop').classList.toggle('open');
}
function setSendAs(mid, val, el, e) {
    if (e) e.stopPropagation();
    document.getElementById(mid + '-sendAsText').textContent = val === 'hex' ? 'HEX' : '文本';
    var drop = document.getElementById(mid + '-sendAsDrop');
    drop.querySelectorAll('.send-as-opt').forEach(function(o) { o.classList.remove('active'); });
    el.classList.add('active');
    drop.classList.remove('open');
    scheduleConfigSave();
}

/* ===== 端口管理 ===== */
var _portCache = { data: null, ts: 0 };
async function refreshPorts(mid, force) {
    try {
        var now = Date.now();
        var ports;
        if (!force && _portCache.data && now - _portCache.ts < 2000) {
            ports = _portCache.data;
        } else {
            ports = await invoke('list_ports');
            _portCache.data = ports;
            _portCache.ts = now;
        }
        var sel = document.getElementById(mid + '-portSelect');
        var drop = document.getElementById(mid + '-portDrop');
        if (!sel || !drop) return;
        var prev = (sel.getAttribute('data-val')) || (monitors[mid] && monitors[mid]._savedPort) || '';
        drop.innerHTML = '';
        if (!ports || ports.length === 0) {
            sel.querySelector('.sel-text').textContent = '无可用端口';
            sel.setAttribute('data-val', '');
            return;
        }
        var frag = document.createDocumentFragment();
        ports.forEach(function(p) {
            var opt = document.createElement('div');
            opt.className = 'sel-opt';
            opt.setAttribute('data-val', p.port_name);
            var owner = findPortOwner(p.port_name, mid);
            var displayName = p.product_name ? p.product_name + ' (' + p.port_name + ')' : (p.friendly_name || p.port_name);
            if (owner) {
                opt.className += ' port-in-use';
                opt.textContent = displayName + ' [占用中]';
                opt.style.opacity = '0.45';
                opt.style.pointerEvents = 'none';
            } else {
                opt.textContent = displayName;
                opt.onclick = function(e) { e.stopPropagation(); setPortSel(mid, p.port_name, this); };
            }
            frag.appendChild(opt);
        });
        drop.appendChild(frag);
        // 恢复之前选中的端口
        var matchPort = prev && ports.some(function(p) { return p.port_name === prev; }) ? prev : (ports[0] ? ports[0].port_name : '');
        if (matchPort) {
            var matchEl = drop.querySelector('.sel-opt[data-val="' + matchPort + '"]');
            if (matchEl) {
                sel.querySelector('.sel-text').textContent = matchEl.textContent;
                sel.setAttribute('data-val', matchPort);
                drop.querySelectorAll('.sel-opt').forEach(function(o) { o.classList.remove('active'); });
                matchEl.classList.add('active');
            }
        }
        // 清除已恢复的端口标记
        if (monitors[mid]) monitors[mid]._savedPort = '';
    } catch (e) { appendOutput(mid, 'err', '刷新端口失败: ' + e); reportError(e, 'refreshPorts'); }
}

function setPortSel(mid, val, el) {
    var sel = document.getElementById(mid + '-portSelect');
    var drop = document.getElementById(mid + '-portDrop');
    sel.querySelector('.sel-text').textContent = el.textContent;
    sel.setAttribute('data-val', val);
    drop.querySelectorAll('.sel-opt').forEach(function(o) { o.classList.remove('active'); });
    el.classList.add('active');
    drop.classList.remove('open');
    scheduleConfigSave();
    // 监控中（或自动重连等待中）切换端口：自动释放旧端口并连接新端口
    var m = monitors[mid];
    if (!m) return;
    var isActive = m.isConnected || m._reconnectPending;
    if (!isActive || val === (m.portName || '')) return;
    if (m._reconnecting) return; // 已有切换进行中，连接时以 DOM 最新选择为准
    // 防御性占用检查（占用中的端口在下拉中本已不可点）
    var owner = findPortOwner(val, mid);
    if (owner) {
        showToast('端口 ' + val + ' 已被监视器 ' + owner + ' 占用', 'error');
        revertPortSel(mid, m.portName);
        return;
    }
    m._reconnecting = true;
    m._reconnectPending = false; // 取消残留的自动重连重试
    switchMonitorPort(mid, val, m.portName || '');
}

// 把端口下拉回显为指定端口（用于占用检查失败时恢复原选择）
function revertPortSel(mid, portName) {
    var sel = document.getElementById(mid + '-portSelect');
    var drop = document.getElementById(mid + '-portDrop');
    if (!sel || !drop || !portName) return;
    var matchEl = drop.querySelector('.sel-opt[data-val="' + portName + '"]');
    if (matchEl) {
        sel.querySelector('.sel-text').textContent = matchEl.textContent;
        sel.setAttribute('data-val', portName);
        drop.querySelectorAll('.sel-opt').forEach(function(o) { o.classList.remove('active'); });
        matchEl.classList.add('active');
    }
}

// 监控中切换端口：释放旧端口资源 → 连接新端口（复用现有连接命令）
async function switchMonitorPort(mid, newPort, oldPort) {
    var m = monitors[mid];
    if (!m) return;
    var isWsl = !!m.isWsl;
    appendOutput(mid, 'sys', '正在切换端口: ' + (oldPort || '无') + ' → ' + newPort + ' ...');
    var btn = document.getElementById(mid + '-btnStart');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span style="font-size:11px;">⏳</span> 切换中...'; }
    try {
        // 释放旧端口资源（已断开/已释放时忽略错误）
        try {
            if (isWsl) { await invoke('close_wsl_serial', { monitorId: mid }); }
            else { await invoke('close_port', { monitorId: mid }); }
        } catch (_) {}
        m.isConnected = false;
        m.portName = '';
        stopReading(mid);
        logCacheEnd(mid); // 切换端口：结束旧会话缓存
        updateMonitorUI(mid, false);
        // 切换期间用户点击了"停止监控"：保持断开，不复活连接
        if (m._manuallyDisconnected) return;
        if (isWsl) { await connectWslPort(mid); }
        else { await connectPort(mid, true); }
        if (m.isConnected) {
            appendOutput(mid, 'sys', '端口已切换至 ' + (m.portName || newPort));
        } else {
            refreshAllPorts();
            if (!isWsl) {
                var selEl = document.getElementById(mid + '-portSelect');
                var latestPort = selEl ? (selEl.getAttribute('data-val') || newPort) : newPort;
                showToast('切换失败: ' + latestPort + '，请检查端口后重试', 'error');
            }
        }
    } finally {
        if (monitors[mid]) monitors[mid]._reconnecting = false;
    }
}

/* ===== 更多设置 ===== */
function toggleAdv(mid) {
    var row = document.getElementById(mid + '-advRow');
    var btn = document.getElementById(mid + '-btnAdv');
    var wfWrap = document.getElementById(mid + '-advWf');
    row.classList.toggle('vis');
    btn.classList.toggle('on', row.classList.contains('vis'));
    // 工作流面板跟随更多设置栏显隐
    if (wfWrap && wfWrap.classList.contains('has-rules')) {
        wfWrap.classList.toggle('vis', row.classList.contains('vis'));
    }
    scheduleConfigSave();
}
/* ===== 工具栏折叠 ===== */
function toggleToolbarCollapse(mid) {
    var wrap = document.getElementById(mid + '-tbWrap');
    var btn = document.getElementById(mid + '-btnCollapseTb');
    var header = document.getElementById(mid + '-paneHeader');
    if (!wrap) return;
    // 如果自动隐藏已激活（鼠标悬停展开中），点击按钮 = 关闭自动隐藏并保持展开
    if (wrap.onmouseleave) {
        wrap.onmouseenter = null;
        wrap.onmouseleave = null;
        if (header) { header.onmouseenter = null; header.onmouseleave = null; }
        btn.innerHTML = ICONS.chevronUp;
        btn.title = '折叠工具栏';
        btn.classList.remove('on');
        wrap.classList.remove('collapsed');
        return;
    }
    // 切换折叠状态（CSS 兄弟选择器自动隐藏/显示工作流面板）
    var collapsing = !wrap.classList.contains('collapsed');
    wrap.classList.toggle('collapsed');
    btn.innerHTML = collapsing ? ICONS.chevronDown : ICONS.chevronUp;
    btn.title = collapsing ? '展开工具栏' : '折叠工具栏';
    btn.classList.toggle('on', collapsing);
    if (collapsing) {
        var hoverTimer = null;
        function expand() {
            hoverTimer = setTimeout(function() {
                wrap.classList.remove('collapsed');
                btn.innerHTML = ICONS.chevronUp;
                btn.title = '折叠工具栏';
    }, 10);
        }
        function collapse() {
            if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
            wrap.classList.add('collapsed');
            btn.innerHTML = ICONS.chevronDown;
            btn.title = '展开工具栏';
        }
        wrap.onmouseenter = expand;
        wrap.onmouseleave = collapse;
        if (header) { header.onmouseenter = expand; header.onmouseleave = collapse; }
    }
}
function toggleIbtn(btn) { btn.classList.toggle('on'); scheduleConfigSave(); }

/* ===== 行号切换 ===== */
function toggleLineNum(btn, mid) {
    btn.classList.toggle('on');
    var output = document.getElementById(mid + '-output');
    if (output) {
        output.classList.toggle('with-line-num');
        // 更新现有行的行号
        updateLineNumbers(mid);
    }
    scheduleConfigSave();
}

function updateLineNumbers(mid) {
    var output = document.getElementById(mid + '-output');
    if (!output) return;
    var lines = output.querySelectorAll('.ol');
    var lineNum = 1;
    for (var i = 0; i < lines.length; i++) {
        var ln = lines[i].querySelector('.ln');
        if (lines[i].classList.contains('empty-line')) {
            if (ln) ln.textContent = '';
        } else {
            if (ln) ln.textContent = String(lineNum);
            lineNum++;
        }
    }
    output._lineCount = lineNum - 1;
}


/* ===== 终端模式 ===== */
var _terminalBuffers = {}; // 用于标记终端模式开启（真值），供相关保护逻辑判断

function initTerminalMode(mid) {
    var output = document.getElementById(mid + '-output');
    if (!output) return;

    // 让输出区可获得焦点（点击时聚焦到终端当前行的输入框）
    output.setAttribute('tabindex', '0');
    output.style.outline = 'none';

    // 终端当前行：提示符（来自设备输出）+ 可见输入框，内联跟随设备提示符（继承系统输入法，候选框在光标旁）。
    // 输出区在终端模式时 contentEditable 关闭，输入全部由输入框负责，避免组合文本污染输出区。
    var termCur = document.getElementById(mid + '-termCurrent');
    if (!termCur) {
        termCur = document.createElement('div');
        termCur.id = mid + '-termCurrent';
        termCur.className = 'term-current';
        var out = document.createElement('span');
        out.id = mid + '-termOut';
        out.className = 'term-out';
        var input = document.createElement('input');
        input.id = mid + '-termInput';
        input.className = 'term-in';
        input.type = 'text';
        input.autocomplete = 'off';
        input.spellcheck = false;
        termCur.appendChild(out);
        termCur.appendChild(input);
        // TAB 补全弹层（相对当前行定位，输入时由 JS 控制显隐）
        var comp = document.createElement('div');
        comp.id = mid + '-termComp';
        comp.className = 'term-comp';
        termCur.appendChild(comp);
        output.appendChild(termCur);
    }
    var termInput = document.getElementById(mid + '-termInput');

    function termOn() {
        var btn = document.getElementById(mid + '-btnSendLE');
        return btn && btn.classList.contains('on');
    }

    termInput.addEventListener('keydown', function(e) {
        if (!termOn()) return;
        var m = monitors[mid];
        if (!m) return;
        if (e.isComposing) return; // 输入法组合中，回车确认候选，不发送

        // TAB 补全：优先本地补全（历史命令 + 快捷指令 + 通用命令），重复 Tab 在候选中循环
        if (e.key === 'Tab') {
            e.preventDefault();
            if (e.shiftKey) { // Shift+Tab：撤销当前补全
                m._termComp = null;
                hideTermComp(mid);
                return;
            }
            completeTermTab(mid);
            return;
        }
        // Esc：关闭补全弹层
        if (e.key === 'Escape') {
            hideTermComp(mid);
            m._termComp = null;
            return;
        }
        // 补全弹层打开时，↑/↓ 在候选中切换
        if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && m._termComp && m._termComp.matches.length > 1) {
            e.preventDefault();
            var dir = e.key === 'ArrowDown' ? 1 : -1;
            var st = m._termComp;
            st.index = ((st.index < 0 ? 0 : st.index) + dir + st.matches.length) % st.matches.length;
            var v = termInput.value;
            var s = v.length;
            while (s > 0 && !/\s/.test(v[s - 1]) && v[s - 1] !== '\n') s--;
            termInput.value = v.slice(0, s) + st.matches[st.index];
            termInput.setSelectionRange(termInput.value.length, termInput.value.length);
            showTermComp(mid, st.matches, st.index);
            return;
        }

        if (e.key === 'Enter') {
            hideTermComp(mid);
            if (m) m._termComp = null;
            e.preventDefault();
            var line = termInput.value;
            var le = leStr(mid);
            if (m.isConnected) {
                // 本地回显关闭：发送内容 + 行尾。空内容也发换行（与 Linux 终端一致，空回车触发 \r\n）
                var bytes = new TextEncoder().encode(line + le);
                var isWsl = m.isWsl;
                var sendCmd = isWsl ? 'send_wsl_serial' : 'send_data';
                invokeTimeout(sendCmd, { monitorId: mid, data: Array.from(bytes) }, 5000).catch(function(err) {
                    appendOutput(mid, 'err', '发送失败: ' + err);
                });
            } else {
                // 未连接：提示（空输入不提示，仅清空）
                if (line) appendOutput(mid, 'err', '未连接串口，无法发送');
            }
            // 清空输入，并清空旧的提示符缓冲（旧提示符不应并入后续设备响应）
            if (m) m._recvPartial = '';
            termInput.value = '';
            termInput.focus();
        }
    });

    // 手动编辑输入时关闭补全弹层并重置补全状态
    termInput.addEventListener('input', function() {
        hideTermComp(mid);
        if (monitors[mid]) monitors[mid]._termComp = null;
    });

    // 点击输出区 → 聚焦输入框继续输入
    output.addEventListener('click', function() {
        if (termOn()) termInput.focus();
    });

    // 输入框获得焦点时滚动到当前行，保证输入框可见（用户要输入时）
    termInput.addEventListener('focus', function() {
        if (termOn()) {
            var out = document.getElementById(mid + '-output');
            if (out) requestScroll(out);
        }
    });
}

// 设置终端当前行的提示符（设备输出检测到的提示符）
// 含转义序列时用 ANSI 解析（渲染颜色 + 剥离光标/擦除等控制符），避免提示符显示成乱码
function setTermPrompt(mid, text) {
    var p = document.getElementById(mid + '-termOut');
    if (!p) return;
    if (text && text.indexOf('\x1b') !== -1) {
        p.innerHTML = parseAnsi(text);
    } else {
        p.textContent = text;
    }
}

/* ===== 终端 TAB 补全 ===== */

// 取输入框内最后一个空白分隔的 token 起点下标（用于补全/替换）
function termTokenStart(value) {
    var s = value.length;
    while (s > 0 && !/\s/.test(value[s - 1]) && value[s - 1] !== '\n') s--;
    return s;
}

// ===== 通用/内置命令（基础补全词库） =====
var GENERIC_CMDS = ['help','?','version','ver','reset','reboot','info','status','get','set','ls','dir','exit','quit','start','scan','wifi','ota','cd','pwd','cat','echo','date','ps','top','df','mount','ifconfig','ip','ping','clear','cls','type','del','copy','mkdir','rm','mv','cp','sed','grep','find','which','su','cmd'];

// ===== ADB 命令树（上下文命令补全） =====
var ADB_GLOBAL_OPTS = ['-s','-d','-e','-t','-L','--help','--version'];
var ADB_SUBCMDS = ['connect','disconnect','devices','get-state','get-serialno','install','install-multiple','uninstall','shell','push','pull','sync','logcat','forward','reverse','reboot','sideload','root','unroot','remount','usb','tcpip','wait-for-device','start-server','kill-server','bugreport','screencap','screenrecord','version','help'];
var ADB_SHELL_CMDS = ['ls','cat','cd','pwd','mkdir','rm','rmdir','cp','mv','chmod','chown','touch','echo','date','ps','top','df','du','mount','umount','getprop','setprop','pm','am','dumpsys','input','settings','wm','screencap','screenrecord','logcat','reboot','ifconfig','ip','netstat','ping','id','whoami','uname','env','tar','gzip','find','grep','sed','awk','which','su','cmd'];
var ADB_SUB_OPTS = {
    install: ['--help','-r','-t','-s','-g','-d','--no-streaming','--streaming'],
    'install-multiple': ['--help','-r','-t','-s','-g','-d'],
    uninstall: ['--help','-k','--user'],
    shell: ['--help','-T','-x'],
    logcat: ['--help','-v','-b','-f','-s','--pid'],
    push: ['--help','--sync','-n'],
    pull: ['--help','-a'],
    forward: ['--help','--no-rebind','-tcp','-local','-dev','-remote'],
    reverse: ['--help','--no-rebind','-tcp','-local','-dev','-remote'],
    reboot: ['--help','bootloader','recovery','sideload','sideload-auto-reboot','fastboot'],
    connect: ['--help'],
    disconnect: ['--help'],
    devices: ['--help','-l'],
    'get-state': ['--help'],
    'get-serialno': ['--help']
};
// 已知设备序列号（由 ADB 设备列表回填，用于 `adb -s <TAB>` 的设备补全）
var _adbSerials = [];

// 从 adb_devices 的返回中取出可用于补全的序列号（纯函数，便于无头断言）
function pickAdbSerials(devices) {
    if (!Array.isArray(devices)) return [];
    var out = [];
    devices.forEach(function(d) {
        var s = (d && d.serial) ? String(d.serial) : '';
        if (s && out.indexOf(s) < 0) out.push(s);
    });
    return out;
}

// 根据「已输入的前缀 token」推断补全上下文（首词是 adb 时走命令树）
function getAdbContextCandidates(toks) {
    var i = 1;                                    // 跳过 'adb'
    // 1) 消费全局取值选项及其值（-s/-t/-L/-p <值>）
    while (i < toks.length && (toks[i] === '-s' || toks[i] === '-t' || toks[i] === '-L' || toks[i] === '-p')) {
        if (i === toks.length - 1) return _adbSerials.slice();   // 正在补该选项的值（设备序列号）
        i += 2;
    }
    // 2) 消费布尔型全局选项（-d -e --help --version ...）
    var afterBool = false;
    while (i < toks.length && toks[i].charAt(0) === '-') {
        afterBool = true;
        i += 1;
    }
    if (i >= toks.length) {
        // 正在补「首个子命令」这一位：已给过布尔选项只补子命令，否则全局选项 + 子命令
        return afterBool ? ADB_SUBCMDS : ADB_GLOBAL_OPTS.concat(ADB_SUBCMDS);
    }
    var sub = toks[i];
    if (sub === 'shell') return ADB_SHELL_CMDS;   // adb shell <Tab> → 设备内命令
    if (toks.length - 1 === i) {                  // 正在补该子命令的参数/选项
        var opts = (ADB_SUB_OPTS[sub] || []).slice();
        if (sub === 'install' || sub === 'install-multiple' || sub === 'push' || sub === 'pull' || sub === 'sideload') {
            opts = opts.concat(['./', '../', '/sdcard/', '/data/local/tmp/', '<path>']);
        }
        if (sub === 'connect' || sub === 'disconnect') opts = opts.concat(['<ip:port>']);
        return opts;
    }
    // 更深层级：多为选项/路径，回退到该子命令的选项表
    return ADB_SUB_OPTS[sub] || [];
}

// 补全候选：首词是 adb → 走命令树（上下文感知）；否则 通用命令 + 历史 + 快捷指令
function getTermCompletionCandidates(mid, value, tokenStart) {
    var before = (value.slice(0, tokenStart) || '').trim();
    var toks = before ? before.split(/\s+/) : [];
    if (toks.length && toks[0].toLowerCase() === 'adb') {
        return getAdbContextCandidates(toks);
    }
    var set = [];
    var seen = {};
    function add(s) {
        s = String(s == null ? '' : s).trim();
        if (s && s.indexOf(' ') === -1 && !seen[s]) { seen[s] = 1; set.push(s); }
    }
    var m = monitors[mid];
    if (m) {
        (m.sendHistory || []).forEach(add);
        qcmdGroups(mid).forEach(function(g) {
            (g.items || []).forEach(function(c) { if (c) { add(c.label); add(c.value); } });
        });
    }
    GENERIC_CMDS.forEach(add);
    return set;
}

// 求字符串列表的最长公共前缀
function commonPrefix(list) {
    var p = list[0] || '';
    for (var i = 1; i < list.length; i++) {
        var s = list[i];
        var j = 0;
        while (j < p.length && j < s.length && p.charCodeAt(j) === s.charCodeAt(j)) j++;
        p = p.slice(0, j);
        if (!p) break;
    }
    return p;
}

// TAB 补全主逻辑：只有唯一候选时直接补全；多候选先补到公共前缀，再次 Tab 循环
function completeTermTab(mid) {
    var m = monitors[mid];
    var input = document.getElementById(mid + '-termInput');
    if (!m || !input) return;
    var value = input.value;
    var start = termTokenStart(value);
    var token = value.slice(start);
    var prefix = value.slice(0, start);

    var st = m._termComp;
    if (!st || st.token !== token) {
        var candidates = getTermCompletionCandidates(mid, value, start);
        var matches = candidates.filter(function(c) {
            return c !== token && c.toLowerCase().indexOf(token.toLowerCase()) === 0;
        });
        st = { token: token, matches: matches, index: -1 };
        m._termComp = st;
    }

    if (st.matches.length === 0) {
        // 无本地匹配：给出提示，不做其它改动
        showTermHint(mid, '无匹配命令: ' + (token || '(空)'));
        return;
    }
    if (st.matches.length === 1) {
        input.value = prefix + st.matches[0];
        input.setSelectionRange(input.value.length, input.value.length);
        m._termComp = null;
        hideTermComp(mid);
        return;
    }
    // 多匹配：先尝试补到公共前缀，后续 Tab 在候选中循环
    if (st.index < 0) {
        var lcp = commonPrefix(st.matches);
        if (lcp.length > token.length) {
            input.value = prefix + lcp;
            input.setSelectionRange(input.value.length, input.value.length);
            showTermComp(mid, st.matches, -1);
            return;
        }
        st.index = 0;
    } else {
        st.index = (st.index + 1) % st.matches.length;
    }
    input.value = prefix + st.matches[st.index];
    input.setSelectionRange(input.value.length, input.value.length);
    showTermComp(mid, st.matches, st.index);
}

// 显示补全候选弹层（selIdx 高亮当前选中项，-1 表示未选中）
function showTermComp(mid, items, selIdx) {
    var comp = document.getElementById(mid + '-termComp');
    if (!comp) return;
    var m = monitors[mid];
    if (m && m._termHintTimer) { clearTimeout(m._termHintTimer); m._termHintTimer = null; }
    comp.innerHTML = '';
    var frag = document.createDocumentFragment();
    items.forEach(function(it, idx) {
        var div = document.createElement('div');
        div.className = 'term-comp-item' + (idx === selIdx ? ' selected' : '');
        div.textContent = it;
        div.addEventListener('mousedown', function(e) {
            e.preventDefault();
            var input = document.getElementById(mid + '-termInput');
            var mm = monitors[mid];
            if (input && mm) {
                var v = input.value;
                var s = termTokenStart(v);
                input.value = v.slice(0, s) + it;
                input.setSelectionRange(input.value.length, input.value.length);
                mm._termComp = null;
                input.focus();
            }
            hideTermComp(mid);
        });
        frag.appendChild(div);
    });
    comp.appendChild(frag);
    comp.classList.add('open');
}

function hideTermComp(mid) {
    var comp = document.getElementById(mid + '-termComp');
    if (comp) comp.classList.remove('open');
}

// 无匹配时的短暂提示（约 1.6s 后自动关闭）
function showTermHint(mid, text) {
    var comp = document.getElementById(mid + '-termComp');
    if (!comp) return;
    comp.innerHTML = '<div class="term-comp-item term-comp-more">' + escapeHtml(text) + '</div>';
    comp.classList.add('open');
    var m = monitors[mid];
    if (m) {
        if (m._termHintTimer) clearTimeout(m._termHintTimer);
        m._termHintTimer = setTimeout(function() { hideTermComp(mid); }, 1600);
    }
}


function toggleTerminalMode(btn, mid) {
    btn.classList.toggle('on');
    var output = document.getElementById(mid + '-output');
    var sendBar = document.querySelector('#pane-' + mid + ' .send-bar');
    var termCur = document.getElementById(mid + '-termCurrent');
    var termInput = document.getElementById(mid + '-termInput');
    if (output) {
        if (btn.classList.contains('on')) {
            output.style.cursor = 'text';
            // 终端模式：关闭输出区 contenteditable（不让浏览器往输出区插入文本），
            // 显示终端当前行（提示符+输入框，内联跟随设备提示符），输入由输入框负责（继承系统输入法）。
            output.contentEditable = 'false';
            if (sendBar) sendBar.style.display = 'none';
            if (termCur) termCur.classList.add('show');
            setTermPrompt(mid, ''); // 提示符由设备输出决定，先清空
            if (monitors[mid]) closeRecvPartial(monitors[mid]); // 清空普通模式残留行，避免污染
            if (termInput) { termInput.value = ''; termInput.focus(); }
            // 记录当前行元素，供 appendOutput 把设备输出插入到它之前（当前行始终在末尾）
            _terminalBuffers[mid] = termCur ? { lineEl: termCur } : true;
            var scrollBtn = document.getElementById(mid + '-btnScroll');
            if (scrollBtn && scrollBtn.classList.contains('on')) requestScroll(output);
        } else {
            output.style.cursor = 'default';
            // 恢复日志编辑
            output.contentEditable = 'true';
            if (sendBar) sendBar.style.display = '';
            if (termCur) termCur.classList.remove('show');
            if (termInput) termInput.value = '';
            // 清除终端模式的接收行缓冲（提示符），避免普通模式错误合并残留数据
            if (monitors[mid]) closeRecvPartial(monitors[mid]);
            // 关闭补全弹层并重置补全状态
            hideTermComp(mid);
            if (monitors[mid]) { monitors[mid]._termComp = null; if (monitors[mid]._termHintTimer) clearTimeout(monitors[mid]._termHintTimer); }
            delete _terminalBuffers[mid];
        }
    }
    scheduleConfigSave();
}

/* ===== DTR/RTS 实时切换（防抖 100ms，避免连续点击导致 IPC 拥堵卡死） ===== */
var _dtrRtsTimers = {};
function toggleDTR(mid, level) {
    if (!monitors[mid] || !monitors[mid].isConnected) return;
    var key = mid + '_dtr';
    if (_dtrRtsTimers[key]) clearTimeout(_dtrRtsTimers[key]);
    _dtrRtsTimers[key] = setTimeout(function() {
        delete _dtrRtsTimers[key];
        invoke('set_dtr', { monitorId: mid, level: level }).catch(function(e) { appendOutput(mid, 'err', 'DTR 失败: ' + e); });
    }, 100);
}
function toggleRTS(mid, level) {
    if (!monitors[mid] || !monitors[mid].isConnected) return;
    var key = mid + '_rts';
    if (_dtrRtsTimers[key]) clearTimeout(_dtrRtsTimers[key]);
    _dtrRtsTimers[key] = setTimeout(function() {
        delete _dtrRtsTimers[key];
        invoke('set_rts', { monitorId: mid, level: level }).catch(function(e) { appendOutput(mid, 'err', 'RTS 失败: ' + e); });
    }, 100);
}

/* ===== 端口锁定 ===== */
// 检查指定端口是否已被其他监视器占用
function findPortOwner(portName, excludeMid) {
    if (!portName) return null;
    for (var k in monitors) {
        if (k === excludeMid) continue;
        if (monitors[k] && monitors[k].isConnected && monitors[k].portName === portName) return k;
    }
    return null;
}
// 刷新所有监视器的端口列表（更新占用状态）
function refreshAllPorts() {
    Object.keys(monitors).forEach(function(mid) {
        if (monitors[mid] && monitors[mid].isWsl) {
            refreshWslMonPorts(mid);
        } else if (!monitors[mid].isConnected) {
            refreshPorts(mid, true);
        }
    });
}

/* ===== 连接管理 ===== */
async function toggleConnection(mid) {
    if (monitors[mid] && monitors[mid].isConnected) await disconnectPort(mid);
    else await connectPort(mid);
}

async function connectPort(mid, silent) {
    var name = document.getElementById(mid + '-portSelect').getAttribute('data-val') || '';
    if (!name) { if (!silent) appendOutput(mid, 'err', '请先选择端口'); return; }
    // 端口锁定检查
    var owner = findPortOwner(name, mid);
    if (owner) {
        if (!silent) showToast('端口 ' + name + ' 已被监视器 ' + owner + ' 占用', 'error');
        return;
    }
    var btn = document.getElementById(mid + '-btnStart');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span style="font-size:11px;">⏳</span> 连接中...'; }
    var baud = parseInt(document.getElementById(mid + '-baudRate').value) || 115200;
    var dataBits = parseInt((document.getElementById(mid + '-dataBits').getAttribute('data-val'))) || 8;
    var stopBits = parseInt((document.getElementById(mid + '-stopBits').getAttribute('data-val'))) || 1;
    var parity = document.getElementById(mid + '-parity').getAttribute('data-val') || 'none';
    var dtr = document.getElementById(mid + '-chkDTR').checked;
    var rts = document.getElementById(mid + '-chkRTS').checked;
    try {
        await invoke('open_port', { monitorId:mid, portName:name, baudRate:baud, dataBits:dataBits, stopBits:stopBits, parity:parity, dtr:dtr, rts:rts });
        monitors[mid].isConnected = true;
        monitors[mid].portName = name;
        monitors[mid]._manuallyDisconnected = false;
        resetRecvStream(mid); // 新数据流：不继承上一次连接的未结束行
        logCacheStart(mid, name); // 打开串口：标记本次会话，有收发内容时自动缓存
        updateMonitorUI(mid, true);
        startReading(mid);
        // 同步行尾设置到后台线程
        var leEl = document.getElementById(mid + '-lineEnding');
        var leVal = leEl ? (leEl.getAttribute('data-val') || 'crlf') : 'crlf';
        invoke('update_workflow_line_ending', { monitorId: mid, lineEnding: leVal }).catch(function() {});
        refreshAllPorts();
        renderWslDeviceList('main'); // 及时刷新 WSL 设备状态点（端口占用）
    } catch (e) {
        monitors[mid].isConnected = false;
        stopReading(mid);
        if (btn) { btn.disabled = false; }
        updateMonitorUI(mid, false);
        if (!silent) showToast('连接失败: ' + e, 'error');
        reportError(e, 'connectPort');
    }
}

async function disconnectPort(mid) {
    var btn = document.getElementById(mid + '-btnStart');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span style="font-size:11px;">⏳</span> 断开中...'; }
    // 先停止轮询，防止 in-flight 的 timer 回调触发重连
    stopReading(mid);
    monitors[mid]._manuallyDisconnected = true;
    monitors[mid]._reconnectPending = false; // 取消残留的自动重连重试
    try {
        await invoke('close_port', { monitorId: mid });
    } catch (e) {
        showToast('断开失败: ' + e, 'error');
        reportError(e, 'disconnectPort');
    }
    monitors[mid].isConnected = false;
    monitors[mid].portName = '';
    logCacheEnd(mid); // 结束本次会话缓存
    updateMonitorUI(mid, false);
    refreshAllPorts();
    renderWslDeviceList('main'); // 及时刷新 WSL 设备状态点（端口释放）
}

function updateMonitorUI(mid, connected, waiting) {
    var m = monitors[mid];
    var btn = document.getElementById(mid + '-btnStart');
    var sendBtn = document.getElementById(mid + '-btnSend');
    var ps = document.getElementById(mid + '-portSelect');
    if (connected) {
        btn.innerHTML = '<span style="font-size:11px;">&#9632;</span> 停止监控';
        btn.className = 'btn-main stop';
        btn.disabled = false;
        sendBtn.disabled = false;
        ps.disabled = true;
    } else if (waiting) {
        btn.innerHTML = '<span style="font-size:11px;">&#9654;</span> 等待接入';
        btn.className = 'btn-main start waiting';
        btn.disabled = true;
        sendBtn.disabled = true;
        ps.disabled = true;
    } else {
        btn.innerHTML = '<span style="font-size:11px;">&#9654;</span> 开始监控';
        btn.className = 'btn-main start';
        btn.disabled = false;
        sendBtn.disabled = true;
        ps.disabled = false;
    }
    updateQcmdSendBtns(mid, connected);
    // 连接掉线就**立刻**停掉循环发送：留着一个还在倒计时的定时器最坑 ——
    // 用户把延时调到几分钟时，开关还亮着，却早已发不出去
    if (!connected && monitors[mid] && monitors[mid].qcmdLoop) {
        stopQcmdLoop(mid, '监控已断开，循环发送已停止');
    }
}

// ===== 自动化工作流 =====

async function checkWorkflowMatches(mid, rawBytes) {
    if (!monitors[mid] || !monitors[mid].workflows || monitors[mid].workflows.length === 0) return;
    try {
        var matched = await invoke('check_workflow_matches', {
            monitorId: mid,
            data: Array.from(rawBytes),
        });
        if (matched && matched.length > 0) {
            matched.forEach(function(rule) {
                // 只有运行中的规则才显示发送内容
                var wf = (monitors[mid].workflows || []).find(function(r) { return r.id === rule.id; });
                if (wf && wf._running) {
                    var sentText = rule.sent || '';
                    appendOutput(mid, 'send', '[Auto] ' + sentText);
                }
            });
        }
    } catch (e) {
        console.warn('Workflow check failed:', e);
    }
}

/* ===== 读取轮询频率：可见时实时、隐藏时降频 =====
   串口/WSL 监视器的读循环默认 25ms（40 次/秒/每个监视器）。隐藏着的监视器（切到别的页、
   或蓝牙页那个内嵌监视器在后台跑）没必要保持这个频率 —— 照 ADB 面板的现成做法降频，
   避免一直空耗 IPC 与 CPU。**降频不丢数据**：读线程照旧往缓冲里攒，只是一次多取一些。 */
var MON_READ_MS_VISIBLE = 25;    // 可见：实时
var MON_READ_MS_HIDDEN = 500;    // 隐藏：降 20 倍（500ms 的数据量远小于后端 256KB 缓冲上限）

// 该监视器挂在哪个页面容器里（纯映射，便于无头断言）
function monitorHostId(mid) {
    if (mid === 'ble-mon') return 'ble-pane';                    // 蓝牙页内嵌监视器
    if (String(mid).indexOf('wsl') === 0) return 'wsl-pane';     // 'wsl' 与 'wsl-xN'
    return 'paneContainer';                                      // main / extra-N
}
// 该监视器当前是否可见（窗口最小化/被切走也算不可见）
function monitorVisible(mid, doc) {
    doc = doc || document;
    if (doc.hidden) return false;
    var el = doc.getElementById(monitorHostId(mid));
    return !!(el && el.style.display !== 'none');
}
// 该监视器当前应使用的轮询间隔（ms）
function monitorPollMs(mid, doc) {
    return monitorVisible(mid, doc) ? MON_READ_MS_VISIBLE : MON_READ_MS_HIDDEN;
}
// 页面切换/窗口显隐后重设各监视器的读取频率；只动正在读取的，频率没变就不重建定时器
function refreshMonitorPollRates() {
    Object.keys(monitors).forEach(function(mid) {
        var m = monitors[mid];
        if (!m || !m.readTimer) return;
        var ms = monitorPollMs(mid);
        if (m._pollMs === ms) return;
        if (m.isWsl) startWslReading(mid); else startReading(mid);   // 内部会先 stop 再按新频率起
    });
}

function startReading(mid) {
    stopReading(mid);
    monitors[mid]._pollMs = monitorPollMs(mid);   // 记下本次频率，页面切换时据此判断是否需要重建
    var reading = false;
    monitors[mid].readTimer = setInterval(async function() {
        if (reading || !monitors[mid] || !monitors[mid].isConnected) { if (!monitors[mid] || !monitors[mid].isConnected) stopReading(mid); return; }
        reading = true;
        try {
            var res = await invokeTimeout('read_data', { monitorId: mid }, 3000);
            // 后端接收缓冲超限时会丢弃最旧数据并回报字节数 → 明确提示一行，
            // 否则用户会以为"日志就是这些"，看不出中间被丢过
            if (res && res.dropped > 0) {
                appendOutput(mid, 'sys', '[缓冲] 读取不及时，已丢弃 ' + res.dropped + ' 字节（设备发得太快，或面板长时间隐藏）');
            }
            var data = (res && res.bytes) ? res.bytes : res;   // 兼容旧的纯数组返回
            if (data && data.length > 0) {
                // 渲染异常只记录日志，避免误触发断开/重连逻辑导致界面异常（#13）
                try {
                    var frag = document.createDocumentFragment();
                    var vm = document.getElementById(mid + '-viewMode');
                    var isHex = vm && vm.getAttribute('data-val') === 'hex';
                    if (isHex) {
                        var hexStr = bytesToHex(new Uint8Array(data));
                        var chunkSize = 192;
                        for (var i = 0; i < hexStr.length; i += chunkSize) {
                            var chunk = hexStr.substring(i, i + chunkSize);
                            appendOutput(mid, 'recv', (i === 0 ? 'HEX: ' : '     ') + chunk, { hex: true, fragment: frag });
                        }
                    } else {
                        // 文本模式：合并未结束行，只有真正的 \r\n 才换行
                        appendRecvText(mid, decodeRecv(mid, data), frag);
                    }
                    flushBatch(mid, frag);
                } catch (e) {
                    console.warn('[recv] 数据显示异常:', e);
                }
            }
            // 读取工作流触发事件（无工作流规则时跳过，减少每 tick 的 IPC）
            if (monitors[mid] && (monitors[mid].workflows || []).length > 0) {
                var wfEvents = await invokeTimeout('read_workflow_events', { monitorId: mid }, 3000);
                for (var j = 0; j < wfEvents.length; j++) {
                    appendOutput(mid, 'send', wfEvents[j]);
                }
            }
        } catch (e) {
            // 手动断开或正在重连时不触发自动重连
            if (monitors[mid] && (monitors[mid]._manuallyDisconnected || monitors[mid]._reconnecting)) {
                monitors[mid].isConnected = false;
                stopReading(mid);
                updateMonitorUI(mid, false);
                return;
            }
            var reconnectBtn = document.getElementById(mid + '-btnAutoReconnect');
            if (reconnectBtn && reconnectBtn.classList.contains('on')) {
                try {
                    await invoke('close_port', { monitorId: mid });
                } catch (_) {}
                // await 期间用户可能已经关掉这个监视器（closeMonitor 会 delete monitors[mid]）
                if (!monitors[mid]) return;
                monitors[mid].isConnected = false;
                stopReading(mid);
                updateMonitorUI(mid, false, true);
                var savedPort = monitors[mid].portName;
                appendOutput(mid, 'sys', '连接断开，正在自动重连...');
                reconnectPort(mid, savedPort, 1);
            } else {
                monitors[mid].isConnected = false;
                stopReading(mid);
                logCacheEnd(mid); // 连接断开且无自动重连：结束会话缓存
                updateMonitorUI(mid, false);
                refreshPorts(mid, true);
            }
        } finally {
            reading = false;
        }
    }, monitors[mid]._pollMs || MON_READ_MS_VISIBLE);
}

async function reconnectPort(mid, portName, attempt) {
    if (monitors[mid]) monitors[mid]._reconnectPending = true;
    if (!portName || attempt > 10) {
        if (attempt > 10) {
            appendOutput(mid, 'err', '重连失败，已达到最大重试次数');
            updateMonitorUI(mid, false, false);
            logCacheEnd(mid); // 重连最终失败：结束会话缓存
        }
        if (monitors[mid]) monitors[mid]._reconnectPending = false;
        return;
    }
    await refreshPorts(mid, true);
    var sel = document.getElementById(mid + '-portSelect');
    if (sel && [...sel.querySelectorAll('.sel-opt')].some(function(o) { return o.getAttribute('data-val') === portName; })) {
        // 显式设置下拉框为目标端口，防止 refreshPorts 将其重置为第一个端口
        var matchEl = sel.parentElement.querySelector('.sel-drop .sel-opt[data-val="' + portName + '"]');
        if (matchEl) {
            sel.querySelector('.sel-text').textContent = matchEl.textContent;
            sel.setAttribute('data-val', portName);
            sel.parentElement.querySelectorAll('.sel-opt').forEach(function(o) { o.classList.remove('active'); });
            matchEl.classList.add('active');
        }
        await connectPort(mid, true);
        if (monitors[mid].isConnected) {
            if (monitors[mid]) monitors[mid]._reconnectPending = false;
            return;
        }
    }
    var delay = Math.min(2000 * attempt, 20000);
    appendOutput(mid, 'sys', '重连失败，' + Math.round(delay/1000) + '秒后重试 (' + attempt + '/10)...');
    setTimeout(function() {
        // 用户已切换端口或手动断开时，中止残留重试
        if (!monitors[mid] || !monitors[mid]._reconnectPending) return;
        reconnectPort(mid, portName, attempt + 1);
    }, delay);
}
function stopReading(mid) {
    if (monitors[mid] && monitors[mid].readTimer) { clearInterval(monitors[mid].readTimer); monitors[mid].readTimer = null; }
}

