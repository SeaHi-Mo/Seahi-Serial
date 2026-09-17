/* 80-wsl.js —— 前端第 10 块，拆自原单文件 src/index.html（**纯搬家**；行号映射见 doc/FRONTEND_LAYOUT.md）。
   ⚠️ **普通脚本**（不是 ESM）：按 index.html 里的 <script src> 顺序加载、共享同一个全局作用域 —— 行内 onclick
   与现有函数互相调用照旧；**别改成 type="module"**（模块作用域会让它们全部失效）。 */
/* ===== WSL 映射页面 ===== */
var _wslExtraCount = 0;
var _wslTargetDist = ''; // “映射到”目标发行版（空 = 默认发行版）

function setWslTargetDist(name) {
    _wslTargetDist = name || '';
}

// WSL 设备区域 HTML（共享，单实例）
function getWslDeviceAreaHtml() {
    return '<div id="wsl-paneHeader" style="background:var(--toolbar-bg);border-bottom:1px solid var(--border);padding:8px 16px;display:flex;align-items:center;gap:20px;flex-shrink:0;">' +
            '<div style="font-size:13px;font-weight:600;color:var(--text-b);white-space:nowrap;flex-shrink:0;">WSL 端口映射</div>' +
            '<div style="display:flex;align-items:center;gap:6px;flex-shrink:0;" title="多发行版时选择设备映射到的目标发行版">' +
                '<span style="font-size:12px;color:var(--text-d);white-space:nowrap;">映射到</span>' +
                '<select id="main-wslTargetDist" onchange="setWslTargetDist(this.value)" style="background:var(--surface-1);color:var(--text);border:1px solid var(--border);border-radius:4px;font-size:12px;padding:3px 6px;max-width:160px;outline:none;"><option value="">默认</option></select>' +
            '</div>' +
            '<div id="main-wslDistroList" style="display:flex;flex-wrap:wrap;gap:6px;flex:1;min-width:0;justify-content:flex-end;"></div>' +
        '</div>' +
        '<div style="flex:1;overflow:hidden;display:flex;flex-direction:column;min-height:0;" id="main-wslTop">' +
            '<div class="no-scrollbar" style="flex:1;overflow-y:auto;min-height:0;" id="main-wslDeviceList">' +
                '<div style="color:var(--text-d);text-align:center;padding:20px;">正在加载设备列表...</div>' +
            '</div>' +
        '</div>';
}

// WSL 串口监视器 HTML（可多实例）
function getWslMonitorHtml(wmid) {
    var baudOpts = [50,75,110,134,150,200,300,600,1200,1800,2400,4800,7200,9600,14400,19200,28800,38400,57600,115200,230400,460800,500000,576000,921600,1000000,1152000,1500000,2000000,2500000,3000000,3500000,4000000].map(function(v) {
        return '<div class="baud-opt' + (v===115200?' active':'') + '" onclick="setBaud(\'' + wmid + '\',' + v + ')">' + v + '</div>';
    }).join('');
    return '<div style="display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:var(--editor-bg);">' +
            '<div class="toolbar-wrap" id="' + wmid + '-tbWrap"><div class="toolbar" id="' + wmid + '-toolbar">' +
                '<span class="lbl">查看</span>' +
                '<div class="sel" id="' + wmid + '-viewMode" data-val="text" onclick="toggleSelDrop(this)">' +
                    '<span class="sel-text">文本</span><span class="sel-arrow">&#9660;</span>' +
                    '<div class="sel-drop">' +
                        '<div class="sel-opt active" data-val="text" onclick="setSel(this,\'text\',event)">文本</div>' +
                        '<div class="sel-opt" data-val="hex" onclick="setSel(this,\'hex\',event)">HEX</div>' +
                    '</div>' +
                '</div>' +
                '<span class="lbl">端口</span>' +
                '<div class="sel sel-port" id="' + wmid + '-portSelect" onclick="toggleSelDrop(this)" style="min-width:180px;">' +
                    '<span class="sel-text">无可用端口</span><span class="sel-arrow">&#9660;</span>' +
                    '<div class="sel-drop wsl-port-drop" id="' + wmid + '-portDrop"></div>' +
                '</div>' +
                '<button class="btn-ref" onclick="refreshWslMonPorts(\'' + wmid + '\')" title="刷新端口">' + ICONS.refresh + '</button>' +
                '<span class="lbl">波特率</span>' +
                '<div class="baud-wrap" id="' + wmid + '-baudWrap">' +
                    '<input class="baud-input" id="' + wmid + '-baudRate" type="number" value="115200" min="110" max="4000000" autocomplete="off">' +
                    '<button class="baud-arrow" onclick="toggleBaudDropdown(event,\'' + wmid + '\')" title="波特率">&#9660;</button>' +
                    '<div class="baud-dropdown" id="' + wmid + '-baudDropdown">' + baudOpts + '</div>' +
                '</div>' +
                '<span class="lbl">行尾</span>' +
                '<div class="sel" id="' + wmid + '-lineEnding" data-val="crlf" onclick="toggleSelDrop(this)">' +
                    '<span class="sel-text">CRLF</span><span class="sel-arrow">&#9660;</span>' +
                    '<div class="sel-drop">' +
                        '<div class="sel-opt active" data-val="crlf" onclick="setSel(this,\'crlf\',event)">CRLF</div>' +
                        '<div class="sel-opt" data-val="lf" onclick="setSel(this,\'lf\',event)">LF</div>' +
                        '<div class="sel-opt" data-val="cr" onclick="setSel(this,\'cr\',event)">CR</div>' +
                        '<div class="sel-opt" data-val="none" onclick="setSel(this,\'none\',event)">无</div>' +
                    '</div>' +
                '</div>' +
                '<button class="btn-main start" id="' + wmid + '-btnStart" onclick="toggleWslConnection(\'' + wmid + '\')">' +
                    '<span style="font-size:11px;">&#9654;</span> 开始监控' +
                '</button>' +
                '<div class="tsep"></div>' +
                '<div class="ibtn-group" id="' + wmid + '-ibtnGroup">' +
                '<button class="ibtn" onclick="clearLog(\'' + wmid + '\')" title="清除内容">' + ICONS.clear + '</button>' +
                '<button class="ibtn on" id="' + wmid + '-btnScroll" onclick="toggleIbtn(this)" title="自动滚动">' + ICONS.rollback + '</button>' +
                '<button class="ibtn" id="' + wmid + '-btnAutoReconnect" onclick="toggleIbtn(this)" title="自动重连">' + ICONS.reconnect + '</button>' +
                '<button class="ibtn" id="' + wmid + '-btnSendLE" onclick="toggleTerminalMode(this,\'' + wmid + '\')" title="终端模式">' + ICONS.terminal + '</button>' +
                '<button class="ibtn" id="' + wmid + '-btnLineNum" onclick="toggleLineNum(this,\'' + wmid + '\')" title="显示行号">' + ICONS.lineNum + '</button>' +
                '<button class="ibtn" id="' + wmid + '-btnTs" onclick="toggleIbtn(this)" title="开启时间戳">' + ICONS.timestamp + '</button>' +
                '<button class="ibtn" id="' + wmid + '-btnEcho" onclick="toggleIbtn(this)" title="启动消息回显">' + ICONS.copy + '</button>' +
                '<button class="ibtn" id="' + wmid + '-btnAdv" onclick="toggleAdv(\'' + wmid + '\')" title="更多设置">' + ICONS.settings + '</button>' +
                '</div>' +
            '</div>' +
            '<div class="adv-row" id="' + wmid + '-advRow">' +
                '<span class="lbl">数据位</span>' +
                '<div class="sel" id="' + wmid + '-dataBits" onclick="toggleSelDrop(this)">' +
                    '<span class="sel-text">8</span><span class="sel-arrow">&#9660;</span>' +
                    '<div class="sel-drop">' +
                        '<div class="sel-opt" data-val="5" onclick="setSel(this,\'5\',event)">5</div>' +
                        '<div class="sel-opt" data-val="6" onclick="setSel(this,\'6\',event)">6</div>' +
                        '<div class="sel-opt" data-val="7" onclick="setSel(this,\'7\',event)">7</div>' +
                        '<div class="sel-opt active" data-val="8" onclick="setSel(this,\'8\',event)">8</div>' +
                    '</div>' +
                '</div>' +
                '<span class="lbl">停止位</span>' +
                '<div class="sel" id="' + wmid + '-stopBits" onclick="toggleSelDrop(this)">' +
                    '<span class="sel-text">1</span><span class="sel-arrow">&#9660;</span>' +
                    '<div class="sel-drop">' +
                        '<div class="sel-opt active" data-val="1" onclick="setSel(this,\'1\',event)">1</div>' +
                        '<div class="sel-opt" data-val="2" onclick="setSel(this,\'2\',event)">2</div>' +
                    '</div>' +
                '</div>' +
                '<span class="lbl">校验位</span>' +
                '<div class="sel" id="' + wmid + '-parity" onclick="toggleSelDrop(this)">' +
                    '<span class="sel-text">无</span><span class="sel-arrow">&#9660;</span>' +
                    '<div class="sel-drop">' +
                        '<div class="sel-opt active" data-val="none" onclick="setSel(this,\'none\',event)">无</div>' +
                        '<div class="sel-opt" data-val="odd" onclick="setSel(this,\'odd\',event)">奇校验</div>' +
                        '<div class="sel-opt" data-val="even" onclick="setSel(this,\'even\',event)">偶校验</div>' +
                    '</div>' +
                '</div>' +
                '<div class="chk-wrap"><input type="checkbox" id="' + wmid + '-chkDTR" onchange="toggleWslDTR(this.checked,\'' + wmid + '\')"><label for="' + wmid + '-chkDTR">DTR</label></div>' +
                '<div class="chk-wrap"><input type="checkbox" id="' + wmid + '-chkRTS" checked onchange="toggleWslRTS(this.checked,\'' + wmid + '\')"><label for="' + wmid + '-chkRTS">RTS</label></div>' +
                '<button class="btn-logdir" onclick="chooseLogDir(\'' + wmid + '\')">&#128193; 选择日志目录</button>' +
                '<button class="ibtn" onclick="saveLogToFile(\'' + wmid + '\')" title="保存日志">' + ICONS.saveLog + '</button>' +
                '<button class="ibtn" onclick="copyOutput(\'' + wmid + '\')" title="复制全部">' + ICONS.copyAll + '</button>' +
                '<button class="ibtn" id="' + wmid + '-btnCollapseTb" onclick="toggleToolbarCollapse(\'' + wmid + '\')" title="折叠工具栏">' + ICONS.chevronUp + '</button>' +
                '<div style="flex:1;"></div>' +
                '<button class="wf-add-btn" onclick="addWorkflowRule(\'' + wmid + '\')">+ 添加规则</button>' +
            '</div></div>' +
            '<div class="adv-wf-wrap" id="' + wmid + '-advWf">' +
                '<div class="wf-list" id="' + wmid + '-wfList"></div>' +
            '</div>' +
            '<div class="mon-body">' +
            '<div class="output" contenteditable="true" id="' + wmid + '-output"></div>' +
            qcmdSideHtml(wmid) +
            '</div>' +
            '<div class="send-bar" id="' + wmid + '-sendBar">' +
                '<div class="send-wrap" id="' + wmid + '-sendWrap">' +
                    '<input class="send-inp" id="' + wmid + '-sendInput" placeholder="输入要发送的内容，回车发送..." autocomplete="off" spellcheck="false">' +
                    '<div class="send-hist" id="' + wmid + '-sendHist"></div>' +
                '</div>' +
                '<div class="send-as" id="' + wmid + '-sendAs" onclick="toggleSendAsDrop(\'' + wmid + '\')">' +
                    '<span class="send-as-text" id="' + wmid + '-sendAsText">文本</span>' +
                    '<span class="send-as-arrow">&#9660;</span>' +
                    '<div class="send-as-drop" id="' + wmid + '-sendAsDrop">' +
                        '<div class="send-as-opt active" data-val="text" onclick="setSendAs(\'' + wmid + '\',\'text\',this,event)">文本</div>' +
                        '<div class="send-as-opt" data-val="hex" onclick="setSendAs(\'' + wmid + '\',\'hex\',this,event)">HEX</div>' +
                    '</div>' +
                '</div>' +
                '<span class="ssep">|</span>' +
                '<button class="btn-send" id="' + wmid + '-btnSend" onclick="sendWslData(\'' + wmid + '\')" disabled>' +
                    '<span style="font-size:10px;">&#9654;</span> 发送' +
                '</button>' +
            '</div>' +
        '</div>';
}

function openWslMapping() {
    console.log('[WSL] 打开WSL映射页面');

    // 隐藏监视器，显示 WSL 面板
    document.getElementById('paneContainer').style.display = 'none';
    document.getElementById('wsl-pane').style.display = 'flex';
    refreshMonitorPollRates();   // 页面切换 → 按可见性重设读取频率（隐藏的监视器降频）
    document.getElementById('adb-pane').style.display = 'none';
    document.getElementById('ble-pane').style.display = 'none';
    var aBtn = document.getElementById('adbToggleBtn');
    if (aBtn) {
        aBtn.setAttribute('title', 'ADB 调试');
        aBtn.setAttribute('onclick', 'openAdb()');
        aBtn.classList.remove('active');
    }
    var aText = document.getElementById('adbToggleText');
    if (aText) aText.textContent = 'ADB 调试';
    var bBtn = document.getElementById('bleToggleBtn');
    if (bBtn) {
        bBtn.setAttribute('title', '蓝牙调试');
        bBtn.setAttribute('onclick', 'openBle()');
        bBtn.classList.remove('active');
    }
    var bText = document.getElementById('bleToggleText');
    if (bText) bText.textContent = '蓝牙调试';

    // 面板打开期间定期刷新设备列表，保证映射后的 WSL 路径能及时解析显示
    if (_wslDevListTimer) clearInterval(_wslDevListTimer);
    _wslDevListTimer = setInterval(function() { loadWslDevices('main'); }, 5000);

    // 更新顶部栏按钮：进入映射界面后，悬停提示「返回到串口调试器」
    var btn = document.getElementById('wslToggleBtn');
    if (btn) {
        btn.setAttribute('title', '返回到串口调试器');
        btn.setAttribute('onclick', 'restoreMonitorPane()');
        btn.classList.add('active');
    }
    var text = document.getElementById('wslToggleText');
    if (text) text.textContent = '返回到串口调试器';
    // 进入 WSL 模式时，根据 WSL 运行状态设置按钮状态（并清掉蓝牙页可能留下的高亮）
    var addBtn = document.getElementById('addMonitorBtn');
    if (addBtn) {
        addBtn.style.opacity = _wslRunning ? '' : '0.4';
        addBtn.style.pointerEvents = _wslRunning ? '' : 'none';
        addBtn.classList.remove('active');
    }


    // 首次打开时初始化 WSL 面板内容（设备区 + 监视器区）
    var wslPane = document.getElementById('wsl-pane');
    if (!wslPane._initialized) {
        wslPane.style.flexDirection = 'column';
        wslPane.innerHTML =
            '<div style="flex:1;overflow:hidden;display:flex;flex-direction:column;min-height:0;" id="wsl-deviceArea">' +
                getWslDeviceAreaHtml() +
            '</div>' +
            '<div class="wsl-mon-resize" id="main-wslMonResize"></div>' +
            '<div style="flex:0 1 300px;min-height:120px;display:flex;flex-direction:row;overflow:hidden;" id="wsl-monitorArea">' +
                '<div class="monitor-pane" id="pane-wsl" style="flex:1;min-width:0;">' +
                    getWslMonitorHtml('wsl') +
                '</div>' +
            '</div>';
        wslPane._initialized = true;
        initWslMonitor('wsl');
        initWslMonResize('main');

        // 从配置文件恢复设置（加锁防止恢复期间配置被覆盖）
        _loadingConfig = true;
        (async function() {
            try {
                var raw = await invoke('load_config');
                if (raw) {
                    var cfg = JSON.parse(raw);
                    if (cfg && cfg.monitors && cfg.monitors['wsl']) {
                        _wslSavedConfig = cfg.monitors['wsl'];
                        applyMonitorConfig('wsl', cfg.monitors['wsl']);
                    }
                    // 恢复 WSL 额外监视器
                    if (cfg && cfg.wslExtraCount) {
                        for (var i = 1; i <= cfg.wslExtraCount; i++) {
                            var xmid = 'wsl-x' + i;
                            addWslMonitor();
                            if (cfg.monitors && cfg.monitors[xmid]) {
                                applyMonitorConfig(xmid, cfg.monitors[xmid]);
                            }
                        }
                    }
                }
            } catch (_) {}
            _loadingConfig = false;
        })();
    }

    // 恢复所有 WSL 监视器的连接状态
    getWslMonitorIds().forEach(function(wmid) {
        if (monitors[wmid] && monitors[wmid].isConnected && monitors[wmid].portName) {
            updateMonitorUI(wmid, true);
            startWslReading(wmid);
        }
    });

    // 恢复面板高度
    var monPanel = document.getElementById('wsl-monitorArea');
    if (monPanel && monitors['wsl'] && monitors['wsl']._savedSettings && monitors['wsl']._savedSettings.panelHeight > 120) {
        monPanel.style.flex = '0 0 ' + monitors['wsl']._savedSettings.panelHeight + 'px';
        monPanel.style.minHeight = '120px';
    }

    // 检查 WSL 运行状态
    function loadWslDistros() {
        invokeTimeout('get_wsl_distributions', null, 6000).then(function(distros) {
            renderWslDistroCards('main', distros);
        }).catch(function() {
            var container = document.getElementById('main-wslDistroList');
            if (container) container.innerHTML = '';
        });
    }
    function updateWslStatusUI(running) {
        console.log('[WSL] updateWslStatusUI:', running);
        _wslRunning = running;
        loadWslDistros();
        // 启用/禁用所有 WSL 监视器
        getWslMonitorIds().forEach(function(wmid) {
            setWslMonitorEnabled(running, wmid);
        });
        // WSL 模式下，根据运行状态启用/禁用"打开额外监视器"按钮
        var addBtn = document.getElementById('addMonitorBtn');
        if (addBtn && document.getElementById('wsl-pane').style.display !== 'none') {
            addBtn.style.opacity = running ? '' : '0.4';
            addBtn.style.pointerEvents = running ? '' : 'none';
        }
        if (!running) {
            var changed = false;
            _wslDevices.forEach(function(d) {
                if (d.status === 'mapped') {
                    d.status = 'unmapped';
                    delete _wslBusy[d.busid];
                    changed = true;
                }
            });
        }
        // 无论 WSL 启动还是关闭，都重新渲染设备列表以更新复选框状态
        renderWslDeviceList('main');
        if (running) {
            loadWslDevices('main');
        }
    }
    if (_wslStatusUnlisten) _wslStatusUnlisten();
    if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.listen('wsl-status-changed', function(event) {
            console.log('[WSL] wsl-status-changed event:', event.payload);
            updateWslStatusUI(event.payload);
        }).then(function(unlisten) {
            _wslStatusUnlisten = unlisten;
        });
    }
    invoke('check_wsl_status').then(function(dists) {
        console.log('[WSL] check_wsl_status result:', dists);
        var running = dists && dists.length > 0;
        _wslRunning = running;
        updateWslStatusUI(running);
    }).catch(function(e) {
        console.error('[WSL] check_wsl_status error:', e);
    });

    loadWslDevices('main');
}

/* ===== WSL 串口监视器 ===== */
// 获取所有 WSL 监视器 ID 列表
function getWslMonitorIds() {
    var ids = [];
    Object.keys(monitors).forEach(function(k) {
        if (monitors[k] && monitors[k].isWsl) ids.push(k);
    });
    return ids;
}

function initWslMonitor(wmid) {
    wmid = wmid || 'wsl';
    if (!monitors[wmid]) {
        monitors[wmid] = { isConnected: false, portName: '', readTimer: null, sendHistory: [], histNavIdx: -1, _editing: false, quickCmds: [
            {label:'', value:'', seq:0, timeout:QCMD_TIMEOUT_DEFAULT, hex:false}
        ], isWsl: true, workflows: [], _bufferStart: 0,
        _textData: new Uint8Array(TEXT_BUF_INIT), _textDataLen: 0,
        _textDataMaxBytes: 8 * 1024 * 1024,
        _textOffsets: new Uint32Array(TEXT_IDX_INIT), _textTypes: new Uint8Array(TEXT_IDX_INIT),
        _textTsLens: new Uint16Array(TEXT_IDX_INIT), _textCount: 0 };
    }
    // 输出区域编辑状态检测：进入编辑关自动滚动，退出恢复
    var wslOutputEl = document.getElementById(wmid + '-output');
    if (wslOutputEl && !wslOutputEl._bound) {
        wslOutputEl._bound = true;
        wslOutputEl.addEventListener('focus', function() {
            if (!monitors[wmid]) return;
            monitors[wmid]._editing = true;
            var btn = document.getElementById(wmid + '-btnScroll');
            if (btn && btn.classList.contains('on')) {
                monitors[wmid]._autoScrollSaved = true;
                btn.classList.remove('on');
            }
        });
        wslOutputEl.addEventListener('blur', function() {
            if (!monitors[wmid]) return;
            monitors[wmid]._editing = false;
            if (monitors[wmid]._autoScrollSaved) {
                var btn = document.getElementById(wmid + '-btnScroll');
                if (btn) btn.classList.add('on');
                monitors[wmid]._autoScrollSaved = false;
            }
        });
        // 鼠标移开输出监控区时恢复自动滚动并清除光标（无需离开整个监视器面板）
        wslOutputEl.addEventListener('mouseleave', function() {
            if (!monitors[wmid]) return;
            // 恢复自动滚动（若因点击输出而暂停）
            if (monitors[wmid]._autoScrollSaved) {
                var btn = document.getElementById(wmid + '-btnScroll');
                if (btn) btn.classList.add('on');
                monitors[wmid]._autoScrollSaved = false;
            }
            // 终端模式下保留输入光标；有文本选区时不打断复制
            var sel = window.getSelection();
            if (_terminalBuffers[wmid] || (sel && sel.toString().length > 0)) return;
            // 移开鼠标后清除监控区里残留的编辑光标
            if (document.activeElement === wslOutputEl) wslOutputEl.blur();
        });
    }
    // 初始化快速指令列表（按"组"建：列标题 + 每组抬头 + 组内指令）
    if (document.getElementById(wmid + '-qcmdList')) rebuildQcmdList(wmid);
    // 绑定键盘事件
    var sendInput = document.getElementById(wmid + '-sendInput');
    if (sendInput && !sendInput._bound) {
        sendInput._bound = true;
        sendInput.addEventListener('keydown', function(e) {
            var hist = monitors[wmid].sendHistory;
            var histEl = document.getElementById(wmid + '-sendHist');
            if (e.key === 'Enter') {
                e.preventDefault();
                if (histEl && histEl.classList.contains('open')) {
                    var selItem = histEl.querySelector('.send-hist-item.selected');
                    if (selItem) { sendInput.value = selItem.textContent; histEl.classList.remove('open'); sendInput.focus(); return; }
                }
                sendWslData(wmid);
                if (histEl) histEl.classList.remove('open');
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (histEl && histEl.classList.contains('open')) {
                    var selItem = histEl.querySelector('.send-hist-item.selected');
                    if (selItem && selItem.nextElementSibling) { selItem.classList.remove('selected'); selItem.nextElementSibling.classList.add('selected'); selItem.nextElementSibling.scrollIntoView({ block: 'nearest' }); }
                } else if (hist.length > 0) { showSendHistory(wmid); var items = histEl ? histEl.querySelectorAll('.send-hist-item') : []; if (items.length > 0) items[0].classList.add('selected'); }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (histEl && histEl.classList.contains('open')) {
                    var selItem = histEl.querySelector('.send-hist-item.selected');
                    if (selItem && selItem.previousElementSibling) { selItem.classList.remove('selected'); selItem.previousElementSibling.classList.add('selected'); selItem.previousElementSibling.scrollIntoView({ block: 'nearest' }); }
                    else if (!selItem || !selItem.previousElementSibling) { histEl.classList.remove('open'); }
                } else if (hist.length > 0) { monitors[wmid].histNavIdx = Math.min(monitors[wmid].histNavIdx + 1, hist.length - 1); sendInput.value = hist[monitors[wmid].histNavIdx]; }
            } else if (e.key === 'Escape') { if (histEl) histEl.classList.remove('open'); monitors[wmid].histNavIdx = -1; }
        });
        sendInput.addEventListener('input', function() { monitors[wmid].histNavIdx = -1; });
    }
    // 重写开始/停止按钮的 onclick
    var btnStart = document.getElementById(wmid + '-btnStart');
    if (btnStart) {
        btnStart.setAttribute('onclick', "toggleWslConnection('" + wmid + "')");
    }
    // 初始禁用（等WSL状态确认后再启用）
    setWslMonitorEnabled(false, wmid);
    // 初始化终端模式（不刷新端口，等WSL确认运行后再刷新）
    initTerminalMode(wmid);
}

// WSL 串口连接/断开切换
async function toggleWslConnection(wmid) {
    wmid = wmid || 'wsl';
    if (monitors[wmid] && monitors[wmid].isConnected) {
        await disconnectWslPort(wmid);
    } else {
        await connectWslPort(wmid);
    }
}

// 连接 WSL 串口
async function connectWslPort(mid) {
    var ps = document.getElementById(mid + '-portSelect');
    var devicePath = ps ? ps.getAttribute('data-val') : '';
    if (!devicePath) { showToast('请先选择端口', 'error'); return; }
    // 端口锁定检查
    var owner = findPortOwner(devicePath, mid);
    if (owner) {
        showToast('端口 ' + devicePath + ' 已被监视器 ' + owner + ' 占用', 'error');
        return;
    }
    var btn = document.getElementById(mid + '-btnStart');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span style="font-size:11px;">⏳</span> 连接中...'; }
    var baud = parseInt(document.getElementById(mid + '-baudRate').value) || 115200;
    try {
        await invoke('open_wsl_serial', { monitorId: mid, devicePath: devicePath, baudRate: baud });
        monitors[mid].isConnected = true;
        monitors[mid].portName = devicePath;
        monitors[mid]._manuallyDisconnected = false;
        resetRecvStream(mid); // 新数据流：不继承上一次连接的未结束行
        logCacheStart(mid, devicePath); // WSL 串口：标记本次会话
        updateMonitorUI(mid, true);
        startWslReading(mid);
        showToast('WSL 串口已连接', 'success');
        refreshAllPorts();
        renderWslDeviceList('main'); // 及时刷新 WSL 设备状态点（WSL 端口使用中）
    } catch (e) {
        if (btn) btn.disabled = false;
        updateMonitorUI(mid, false);
        showToast('连接失败: ' + e, 'error');
    }
}

// 断开 WSL 串口
async function disconnectWslPort(mid) {
    try {
        monitors[mid]._reconnectPending = false; // 取消残留的自动重连重试
        await invoke('close_wsl_serial', { monitorId: mid });
        monitors[mid].isConnected = false;
        monitors[mid].portName = '';
        stopReading(mid);
        logCacheEnd(mid); // 结束 WSL 串口会话缓存
        updateMonitorUI(mid, false);
        showToast('WSL 串口已断开', 'info');
        refreshAllPorts();
        renderWslDeviceList('main'); // 及时刷新 WSL 设备状态点（WSL 端口释放）
    } catch (e) { showToast('断开失败: ' + e, 'error'); }
}

// 发送数据到 WSL 串口
async function sendWslData(mid) {
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
        await invokeTimeout('send_wsl_serial', { monitorId: mid, data: Array.from(bytes) }, 5000);
        var hist = monitors[mid].sendHistory;
        if (hist.length === 0 || hist[0] !== text) {
            hist.unshift(text);
            if (hist.length > MAX_SEND_HISTORY) hist.pop();
        }
        monitors[mid].histNavIdx = -1;
        input.value = '';
        input.focus();
    } catch (e) { appendOutput(mid, 'err', '发送失败: ' + e); }
}

// WSL DTR/RTS 控制（防抖）
function toggleWslDTR(level, wmid) {
    wmid = wmid || 'wsl';
    if (!monitors[wmid] || !monitors[wmid].isConnected) return;
    var key = wmid + '_dtr';
    if (_dtrRtsTimers[key]) clearTimeout(_dtrRtsTimers[key]);
    _dtrRtsTimers[key] = setTimeout(function() {
        delete _dtrRtsTimers[key];
        invoke('set_wsl_dtr', { monitorId: wmid, level: level }).catch(function(e) { showToast('DTR 设置失败: ' + e, 'error'); });
    }, 100);
}
function toggleWslRTS(level, wmid) {
    wmid = wmid || 'wsl';
    if (!monitors[wmid] || !monitors[wmid].isConnected) return;
    var key = wmid + '_rts';
    if (_dtrRtsTimers[key]) clearTimeout(_dtrRtsTimers[key]);
    _dtrRtsTimers[key] = setTimeout(function() {
        delete _dtrRtsTimers[key];
        invoke('set_wsl_rts', { monitorId: wmid, level: level }).catch(function(e) { showToast('RTS 设置失败: ' + e, 'error'); });
    }, 100);
}

// WSL 串口数据读取轮询
function startWslReading(mid) {
    stopReading(mid);
    monitors[mid]._pollMs = monitorPollMs(mid);   // 同上：WSL 读循环也用同一套可见性频率
    var reading = false;
    monitors[mid].readTimer = setInterval(async function() {
        if (reading || !monitors[mid] || !monitors[mid].isConnected) { if (!monitors[mid] || !monitors[mid].isConnected) stopReading(mid); return; }
        reading = true;
        try {
            var data = await invokeTimeout('read_wsl_serial', { monitorId: mid }, 3000);
            if (data && data.length > 0) {
                // 渲染异常只记录日志，避免误触发断开/重连逻辑导致界面异常（#13）
                try {
                    checkWorkflowMatches(mid, data);
                    // 快速指令的"等回话"：WSL 的数据只有前端拉得到（Rust 侧没有读线程），
                    // 顺手喂给 Rust 的判定状态机 —— 判定只有那一份，JS 里不再写一套。
                    // 不 await：喂数据不能拖慢界面渲染；失败也不影响显示。
                    invoke('qcmd_hs_feed', { monitorId: mid, data: Array.from(data) }).catch(function() {});
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
                try { await invoke('close_wsl_serial', { monitorId: mid }); } catch (_) {}
                monitors[mid].isConnected = false;
                stopReading(mid);
                updateMonitorUI(mid, false, true);
                var savedPort = monitors[mid].portName;
                appendOutput(mid, 'sys', '连接断开，3秒后自动重连...');
                setTimeout(function() { reconnectWslPort(mid, savedPort); }, 3000);
            } else {
                console.error('[WSL] 读取失败:', e);
            }
        } finally {
            reading = false;
        }
    }, monitors[mid]._pollMs || MON_READ_MS_VISIBLE);
}

async function reconnectWslPort(mid, portName, attempt) {
    if (monitors[mid]) monitors[mid]._reconnectPending = true;
    if (!portName) {
        if (monitors[mid]) monitors[mid]._reconnectPending = false;
        return;
    }
    attempt = attempt || 1;
    if (attempt > 10) {
        appendOutput(mid, 'err', '重连失败，已达到最大重试次数');
        updateMonitorUI(mid, false, false);
        logCacheEnd(mid); // WSL 重连最终失败：结束会话缓存
        if (monitors[mid]) monitors[mid]._reconnectPending = false;
        return;
    }
    var baud = parseInt(document.getElementById(mid + '-baudRate').value) || 115200;
    try {
        appendOutput(mid, 'sys', '正在重连 (' + attempt + '/10): ' + portName);
        await invoke('open_wsl_serial', { monitorId: mid, devicePath: portName, baudRate: baud });
        monitors[mid].isConnected = true;
        monitors[mid].portName = portName;
        resetRecvStream(mid); // 新数据流：不继承上一次连接的未结束行
        updateMonitorUI(mid, true);
        startWslReading(mid);
        appendOutput(mid, 'sys', '重连成功');
        renderWslDeviceList('main'); // 及时刷新 WSL 设备状态点
        if (monitors[mid]) monitors[mid]._reconnectPending = false;
    } catch (e) {
        appendOutput(mid, 'err', '重连失败: ' + e);
        var reconnectBtn = document.getElementById(mid + '-btnAutoReconnect');
        if (reconnectBtn && reconnectBtn.classList.contains('on')) {
            var delay = Math.min(3000 * attempt, 30000);
            setTimeout(function() {
                // 用户已切换端口或手动断开时，中止残留重试
                if (!monitors[mid] || !monitors[mid]._reconnectPending) return;
                reconnectWslPort(mid, portName, attempt + 1);
            }, delay);
        } else {
            if (monitors[mid]) monitors[mid]._reconnectPending = false;
        }
    }
}

// WSL 关闭时自动释放所有映射设备
async function autoDetachAllDevices(mid) {
    var detached = [];
    for (var i = 0; i < _wslDevices.length; i++) {
        var d = _wslDevices[i];
        if (d.status === 'mapped' && !_wslBusy[d.busid]) {
            _wslBusy[d.busid] = true;
            try {
                await invoke('detach_port_from_wsl', { busid: d.busid });
                d.status = 'unmapped';
                detached.push(d.name || d.busid);
            } catch (e) { console.error('[WSL] 自动释放失败:', e); }
            delete _wslBusy[d.busid];
        }
    }
    if (detached.length > 0) {
        console.log('[WSL] 已自动释放:', detached);
        renderWslDeviceList(mid);
        // 自动断开后刷新所有 WSL 监视器的端口列表
        setTimeout(function() { getWslMonitorIds().forEach(function(wmid) { refreshWslMonPorts(wmid); }); }, 1000);
    }
}

function setWslMonitorEnabled(enabled, wmid) {
    wmid = wmid || 'wsl';
    var pane = document.getElementById('pane-' + wmid);
    if (!pane) return;
    if (enabled) {
        pane.classList.remove('wsl-mon-disabled');
        refreshWslMonPorts(wmid);
    } else {
        pane.classList.add('wsl-mon-disabled');
        if (monitors[wmid] && monitors[wmid].isConnected) {
            disconnectWslPort(wmid);
        }
    }
}

async function refreshWslMonPorts(wmid) {
    wmid = wmid || 'wsl';
    var drop = document.getElementById(wmid + '-portDrop');
    if (!drop) return;
    // 记住当前选中的端口
    var ps = document.getElementById(wmid + '-portSelect');
    var prevVal = ps ? ps.getAttribute('data-val') : '';
    // 从 WSL 内部获取串口设备列表
    var ports = [];
    try {
        var devices = await invoke('get_wsl_serial_devices');
        if (devices && devices.length > 0) {
            ports = devices.map(function(d) {
                var path = (d && d.path) ? d.path : d;
                var name = (d && d.name) ? d.name : '';
                // 下拉展开时显示: /dev/ttyACM0(设备名称)；选中后只显示路径
                return { name: path, label: path + (name ? '(' + name + ')' : ''), deviceName: name };
            });
        }
    } catch (e) { console.error('[WSL] 获取串口设备失败:', e); reportError(e, 'refreshWslMonPorts'); }
    drop.innerHTML = '';
    if (ports.length === 0) {
        drop.innerHTML = '<div class="sel-opt" style="color:var(--text-placeholder);">无可用端口</div>';
        if (ps) {
            ps.setAttribute('data-val', '');
            ps.querySelector('.sel-text').textContent = '无可用端口';
        }
        return;
    }
    // 查找之前选中的端口是否还在列表中
    var matchIdx = ports.findIndex(function(p) { return p.name === prevVal; });
    if (matchIdx < 0) matchIdx = 0;
    ports.forEach(function(p, i) {
        var div = document.createElement('div');
        div.className = 'sel-opt' + (i === matchIdx ? ' active' : '');
        div.setAttribute('data-val', p.name);
        var owner = findPortOwner(p.name, wmid);
        if (owner) {
            div.className += ' port-in-use';
            div.textContent = p.label + ' [占用中]';
            div.style.opacity = '0.45';
            div.style.pointerEvents = 'none';
        } else {
            div.textContent = p.label;
            div.addEventListener('click', function(e) {
                e.stopPropagation();
                setPortSel(wmid, p.name, div);
                // 选中后只显示路径，设备名仅在下拉展开时可见
                var selEl = document.getElementById(wmid + '-portSelect');
                if (selEl) selEl.querySelector('.sel-text').textContent = p.name;
            });
        }
        drop.appendChild(div);
    });
    if (ps && ports.length > 0) {
        ps.setAttribute('data-val', ports[matchIdx].name);
        ps.querySelector('.sel-text').textContent = ports[matchIdx].name;
    }
}

function initWslMonResize(mid) {
    var handle = document.getElementById(mid + '-wslMonResize');
    var topPanel = document.getElementById('wsl-deviceArea');
    var monPanel = document.getElementById('wsl-monitorArea');
    if (!handle || !topPanel || !monPanel) return;
    var startY = 0, startTopH = 0, startMonH = 0;
    function onMouseDown(e) {
        e.preventDefault();
        startY = e.clientY;
        startTopH = topPanel.offsetHeight;
        startMonH = monPanel.offsetHeight;
        handle.classList.add('dragging');
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }
    function onMouseMove(e) {
        var dy = e.clientY - startY;
        var parentH = monPanel.parentElement.offsetHeight || window.innerHeight;
        var handleH = handle.offsetHeight || 5;
        // 减去 WSL 标题栏（发行版卡片行）的占用高度
        var headerBar = topPanel.previousElementSibling;
        var headerBarH = headerBar ? headerBar.offsetHeight : 0;
        var minTopH = 100; // 表头 ~30px + 1行设备 ~40px + 余量
        var availableH = parentH - headerBarH - handleH - 10;
        var maxMonH = Math.max(120, availableH - minTopH);
        var newTopH = Math.max(minTopH, startTopH + dy);
        var newMonH = Math.max(120, Math.min(maxMonH, startMonH - dy));
        // 拖拽期间用固定高度，松手后会切换为 flex-basis
        topPanel.style.flex = 'none';
        topPanel.style.height = newTopH + 'px';
        monPanel.style.flex = 'none';
        monPanel.style.height = newMonH + 'px';
    }
    function onMouseUp() {
        handle.classList.remove('dragging');
        // 松手后：去掉固定 height，改用 flex-basis，让 flex 容器在窗口缩小时自动缩小面板
        var finalH = monPanel.offsetHeight;
        monPanel.style.height = '';
        monPanel.style.flex = '0 1 ' + finalH + 'px';
        monPanel.style.minHeight = '120px';
        topPanel.style.flex = '1';
        topPanel.style.height = '';
        // 保存面板高度到状态
        if (monitors['wsl'] && monitors['wsl']._savedSettings) {
            monitors['wsl']._savedSettings.panelHeight = finalH;
        } else if (monitors['wsl']) {
            monitors['wsl']._savedSettings = { panelHeight: finalH };
        }
        scheduleConfigSave();
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
    }
    handle.addEventListener('mousedown', onMouseDown);
}

function renderWslDistroCards(mid, distros) {
    var container = document.getElementById(mid + '-wslDistroList');
    if (!container) return;
    if (!distros || distros.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">未检测到 WSL 分发版</div>';
        stopWslUptimeTicker();
        // 清空“映射到”下拉（无可用发行版）
        var tsel = document.getElementById('main-wslTargetDist');
        if (tsel) { tsel.innerHTML = '<option value="">默认</option>'; }
        _wslTargetDist = '';
        return;
    }
    // 填充“映射到”目标发行版下拉（多发行版时选择映射目标）
    var tsel = document.getElementById('main-wslTargetDist');
    if (tsel) {
        var current = tsel.value || _wslTargetDist;
        tsel.innerHTML = '<option value="">默认</option>';
        distros.forEach(function(d) {
            var opt = document.createElement('option');
            opt.value = d.name;
            opt.textContent = d.name + (d.isDefault ? '（默认）' : '');
            tsel.appendChild(opt);
        });
        if (current && distros.some(function(d) { return d.name === current; })) {
            tsel.value = current;
            _wslTargetDist = current;
        } else {
            _wslTargetDist = '';
        }
    }
    var termIcon = '<svg width="27" height="27" viewBox="0 0 1024 1024" fill="currentColor"><path d="M499.712 481.792l-128-128c-16.896-16.384-44.032-15.872-60.416 1.024-15.872 16.384-15.872 42.496 0 59.392L409.088 512l-97.792 97.792c-16.896 16.384-17.408 43.52-1.024 60.416s43.52 17.408 60.416 1.024l1.024-1.024 128-128c16.384-16.896 16.384-43.52 0-60.416zM682.496 597.504h-128c-23.552 0-42.496 18.944-42.496 42.496 0 23.552 18.944 42.496 42.496 42.496h128c23.552 0 42.496-18.944 42.496-42.496s-18.944-42.496-42.496-42.496z"/><path d="M810.496 128H213.504c-70.656 0-128 57.344-128 128v512c0 70.656 57.344 128 128 128h597.504c70.656 0 128-57.344 128-128V256c-0.512-70.656-57.856-128-128.512-128z m0 682.496H213.504c-23.552 0-42.496-18.944-42.496-42.496V256c0-23.552 18.944-42.496 42.496-42.496h597.504c23.552 0 42.496 18.944 42.496 42.496v512c0 23.552-19.456 42.496-43.008 42.496z"/></svg>';
    var html = '';
    distros.forEach(function(d) {
        var nameHtml = escapeHtml(d.name);
        var running = d.running;
        var borderColor = running ? 'var(--wsl-dist-border)' : 'var(--border)';
        var bgGrad = running ? 'linear-gradient(135deg,var(--wsl-dist-bg) 0%,var(--toolbar-bg) 100%)' : 'var(--toolbar-bg)';
        var dotColor = running ? 'var(--accent-green)' : 'var(--text-d)';
        var uptime = running && d.uptime ? d.uptime : '00:00:00';
        var btnText = running ? '关闭' : '启动';
        var btnBg = running ? 'var(--btn-p)' : 'var(--surface-1)';
        var btnBorder = running ? 'var(--btn-p)' : 'var(--border)';
        var btnColor = running ? '#fff' : 'var(--text)';
        var btnAction = running
            ? "wslDistAction('shutdown_wsl','" + d.name.replace(/'/g, "\\'") + "')"
            : "wslDistAction('launch_wsl','" + d.name.replace(/'/g, "\\'") + "')";
        var escapedName = d.name.replace(/'/g, "\\'");
        var termDisabled = running ? '' : 'disabled';
        var termOpacity = running ? '1' : '0.35';

        if (running) {
            var parts = d.uptime.split(':').map(Number);
            var secs = (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
            _wslDistroBasetime[d.name] = { baseSeconds: secs, anchorMs: Date.now() };
        } else {
            delete _wslDistroBasetime[d.name];
        }

        html += '<div style="padding:8px 14px;background:' + bgGrad + ';border:1px solid ' + borderColor + ';border-radius:6px;display:flex;align-items:center;gap:12px;min-width:0;flex-shrink:1;">';
        html += '<span style="width:8px;height:8px;border-radius:50%;background:' + dotColor + ';flex-shrink:0;' + (running ? 'box-shadow:0 0 6px rgba(90,158,110,0.4);' : '') + '"></span>';
        html += '<span style="font-size:13px;font-weight:600;color:var(--text-b);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex-shrink:1;" title="' + nameHtml + '">' + nameHtml + '</span>';
        html += '<span style="width:1px;height:14px;background:var(--border);flex-shrink:0;margin:0 2px;"></span>';
        html += '<span style="font-size:10px;color:var(--text-muted);font-weight:500;flex-shrink:0;">UP</span>';
        html += '<span id="uptime-' + mid + '-' + d.name + '" style="font-size:11px;color:var(--text);font-family:monospace;letter-spacing:0.3px;flex-shrink:0;">' + uptime + '</span>';
        html += '<div style="flex:1;"></div>';
        html += '<button onclick="openWslTerminal(\'' + escapedName + '\')" ' + termDisabled + ' title="打开终端" style="flex-shrink:0;width:28px;height:28px;border:none;border-radius:4px;background:transparent;color:var(--btn-p);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;opacity:' + termOpacity + ';transition:opacity .15s;">' + termIcon + '</button>';
        html += '<button onclick="' + btnAction + '" onmousedown="this.style.transform=\'scale(0.90)\';this.style.filter=\'brightness(0.7)\';this.style.opacity=\'0.6\'" onmouseup="this.style.transform=\'\';this.style.filter=\'\';this.style.opacity=\'\'" onmouseleave="this.style.transform=\'\';this.style.filter=\'\';this.style.opacity=\'\'" style="flex-shrink:0;height:24px;padding:0 12px;border:1px solid ' + btnBorder + ';border-radius:4px;background:' + btnBg + ';color:' + btnColor + ';font-size:11px;cursor:pointer;font-weight:500;transition:all .1s ease;">' + btnText + '</button>';
        html += '</div>';
    });
    container.innerHTML = html;
    startWslUptimeTicker(mid);
}

function openWslTerminal(dist) {
    invoke('launch_wsl', { dist: dist }).catch(function(e) {
        console.error('[WSL] 打开终端失败:', e);
    });
}

// 说明：原 bindMonitorEvents(mid) 已删除 —— 它是主串口发送框键盘绑定的**重复实现**
// （真正生效的绑定在 initMonitor 内，见 sendInput.addEventListener('keydown')），
// 且从未被调用；留着会让人误以为改这里就能改发送行为。

// 快照 WSL 监视器的当前设置到状态中（DOM 即将被替换时调用）
function snapshotWslSettings(wmid) {
    wmid = wmid || 'wsl';
    if (!monitors[wmid]) return;
    var portSel   = document.getElementById(wmid + '-portSelect');
    var baudInp   = document.getElementById(wmid + '-baudRate');
    var lineEnd   = document.getElementById(wmid + '-lineEnding');
    var viewMode  = document.getElementById(wmid + '-viewMode');
    var chkDTR    = document.getElementById(wmid + '-chkDTR');
    var chkRTS    = document.getElementById(wmid + '-chkRTS');
    var monPanel  = document.getElementById('wsl-monitorArea');
    monitors[wmid]._savedSettings = {
        port:         portSel  ? (portSel.getAttribute('data-val') || '') : '',
        baud:         baudInp  ? baudInp.value : '115200',
        lineEnding:   lineEnd  ? (lineEnd.getAttribute('data-val') || 'crlf') : 'crlf',
        viewMode:     viewMode ? (viewMode.getAttribute('data-val') || 'text') : 'text',
        dtr:          chkDTR   ? chkDTR.checked : false,
        rts:          chkRTS   ? chkRTS.checked : true,
        panelHeight:  monPanel ? monPanel.offsetHeight : 0,
    };
    scheduleConfigSave();
}

function restoreMonitorPane() {
    console.log('[WSL] 返回监视器页面');
    if (_wslStatusUnlisten) { _wslStatusUnlisten(); _wslStatusUnlisten = null; }
    if (_wslDevListTimer) { clearInterval(_wslDevListTimer); _wslDevListTimer = null; }
    // 快照所有 WSL 监视器设置并停止读取
    getWslMonitorIds().forEach(function(wmid) {
        snapshotWslSettings(wmid);
        if (monitors[wmid] && monitors[wmid].readTimer) {
            stopReading(wmid);
        }
    });
    // 切换面板显示
    document.getElementById('wsl-pane').style.display = 'none';
    document.getElementById('paneContainer').style.display = 'flex';
    refreshMonitorPollRates();   // 页面切换 → 按可见性重设读取频率（隐藏的监视器降频）
    // 恢复顶部栏按钮：返回后，悬停提示「WSL 端口映射」
    var btn = document.getElementById('wslToggleBtn');
    if (btn) {
        btn.setAttribute('title', 'WSL 端口映射');
        btn.setAttribute('onclick', 'openWslMapping()');
        btn.classList.remove('active');
    }
    var text = document.getElementById('wslToggleText');
    if (text) text.textContent = 'WSL 端口映射';
    // 退出 WSL 模式时恢复"打开额外监视器"按钮状态
    var addBtn = document.getElementById('addMonitorBtn');
    if (addBtn) { addBtn.style.opacity = ''; addBtn.style.pointerEvents = ''; }

}

