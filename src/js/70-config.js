/* 70-config.js —— 前端第 9 块，拆自原单文件 src/index.html（**纯搬家**；行号映射见 doc/FRONTEND_LAYOUT.md）。
   ⚠️ **普通脚本**（不是 ESM）：按 index.html 里的 <script src> 顺序加载、共享同一个全局作用域 —— 行内 onclick
   与现有函数互相调用照旧；**别改成 type="module"**（模块作用域会让它们全部失效）。 */
/* ===== 自动更新 ===== */
var _updateInfo = null;

// 检查更新（启动时调用，之后每 30 分钟轮询）
async function checkForUpdate() {
    // 已经发现更新且按钮可见，无需重复检查
    if (_updateInfo && _updateInfo.has_update) return;
    try {
        var result = await invoke('check_update');
        if (result.has_update) {
            _updateInfo = result;
            var btn = document.getElementById('updateBtn');
            btn.textContent = '更新 ' + result.latest_version;
            btn.style.display = 'inline-flex';
        }
    } catch (e) {
        console.warn('检查更新失败:', e);
        reportError(e, 'checkForUpdate');
    }
}

// 下载并安装更新
async function downloadAndInstallUpdate() {
    if (!_updateInfo || !_updateInfo.download_url) return;
    var btn = document.getElementById('updateBtn');
    btn.classList.add('disabled');
    btn.textContent = '正在下载...';
    try {
        var filePath = await invoke('download_update', { downloadUrl: _updateInfo.download_url, sha256: _updateInfo.sha256 || null, size: _updateInfo.size || null });
        btn.textContent = '正在安装...';
        await invoke('install_update', { filePath: filePath });
    } catch (e) {
        showToast('更新失败: ' + e, 'error');
        btn.classList.remove('disabled');
        btn.textContent = '更新 ' + _updateInfo.latest_version;
    }
}

/* ===== 配置保存/恢复 ===== */
// 收集所有监视器的当前配置，返回 JSON 对象
function collectConfig() {
    var maxExtra = 0;
    Object.keys(monitors).forEach(function(mid) {
        var m = mid.match(/^extra-(\d+)$/);
        if (m) { var n = parseInt(m[1], 10); if (n > maxExtra) maxExtra = n; }
    });
    var cfg = { version: 2, extraCount: maxExtra, wslExtraCount: _wslExtraCount, monitors: {}, logDir: logDirPath, wslAutoMap: _wslAutoMap, theme: _currentTheme, themeStyle: _currentThemeStyle };
    // 注意（别删）：窗口尺寸与位置**已改由 Rust 端统一记忆**（window.json，含最大化状态），
    // 恢复不再走这里。但这两个字段仍要写 —— ① MCP 的 ui_get_state(window) 读的就是它
    // （见 window 分支 snap.windowWidth/windowHeight）；② 老版本升级过来时 Rust 的
    // load_window_state() 读不到 window.json，会回退用这两个字段兜一次尺寸。
    if (_cachedWindowSize) {
        cfg.windowWidth = _cachedWindowSize[0];
        cfg.windowHeight = _cachedWindowSize[1];
    }
    // 蓝牙页状态：随用户配置文件保留（恢复见 restoreBleState / openBle 里的消费）。
    // monitors['ble-mon'] 本身仍被下面排除（避免走 extra-N 的恢复路径），
    // 它的监视器设置单独放在 cfg.ble.monitorCfg 里一起存。
    cfg.ble = collectBleState({
        monitor: !!(_bleExtraMon && monitors[_bleExtraMon]),
        monitorWidth: _bleMonWidth,
        leftWidth: _bleLeftWidth,
        monitorCfg: (_bleExtraMon && monitors[_bleExtraMon]) ? collectConfigForMonitor(_bleExtraMon) : null,
        openSvcs: Object.keys(_bleOpenSvcs).filter(function(k) { return _bleOpenSvcs[k]; }),
        advOpen: _bleAdvOpen,
        filterText: _bleFilterText,
        filterOpen: _bleFilterOpen,
        selected: _bleSelected || '',
        scanSecs: _bleScanSecs,
    });
    // OTA 协议档（阶段 1）：设备侧私有协议的可变部分，用户填一次就该记住 ——
    // 但它**不是**蓝牙页状态的一部分（升级弹窗随时可能先于蓝牙页打开），所以单独存一个键。
    // 落盘的是**归一化后**的那一份（bleOtaProfileLoad）：界面上的临时值不许原样写进配置。
    cfg.otaProfile = bleOtaProfileLoad(bleOtaProfileEnsure());
    Object.keys(monitors).forEach(function(mid) {
        var m = monitors[mid];
        // 蓝牙页内嵌监视器是临时助手（不持久化；恢复逻辑也只按 extra-N 重建）
        if (m && m.bleEmbedded) return;
        var portSel   = document.getElementById(mid + '-portSelect');
        var baudInp   = document.getElementById(mid + '-baudRate');
        var lineEnd   = document.getElementById(mid + '-lineEnding');
        var viewMode  = document.getElementById(mid + '-viewMode');
        var dataBits  = document.getElementById(mid + '-dataBits');
        var stopBits  = document.getElementById(mid + '-stopBits');
        var parity    = document.getElementById(mid + '-parity');
        var chkDTR    = document.getElementById(mid + '-chkDTR');
        var chkRTS    = document.getElementById(mid + '-chkRTS');
        var advRow    = document.getElementById(mid + '-advRow');
        var sendAsText = document.getElementById(mid + '-sendAsText');
        function btnOn(id) { var el = document.getElementById(id); return el ? el.classList.contains('on') : true; }
        // DOM 不存在时使用 monitors[mid] 中已保存的状态值
        var saved = m._savedSettings || {};
        cfg.monitors[mid] = {
            port:         portSel  ? (portSel.getAttribute('data-val') || '') : (saved.port || ''),
            baud:         baudInp  ? baudInp.value  : (saved.baud || '115200'),
            lineEnding:   lineEnd  ? (lineEnd.getAttribute('data-val') || 'crlf') : (saved.lineEnding || 'crlf'),
            viewMode:     viewMode ? (viewMode.getAttribute('data-val') || 'text') : (saved.viewMode || 'text'),
            sendAs:       sendAsText ? (sendAsText.textContent === 'HEX' ? 'hex' : 'text') : (saved.sendAs || 'text'),
            dataBits:     dataBits ? (dataBits.getAttribute('data-val') || '8') : (saved.dataBits || '8'),
            stopBits:     stopBits ? (stopBits.getAttribute('data-val') || '1') : (saved.stopBits || '1'),
            parity:       parity   ? (parity.getAttribute('data-val') || 'none')   : (saved.parity || 'none'),
            dtr:          chkDTR   ? chkDTR.checked : (saved.dtr !== undefined ? saved.dtr : false),
            rts:          chkRTS   ? chkRTS.checked : (saved.rts !== undefined ? saved.rts : true),
            advOpen:      advRow   ? advRow.classList.contains('vis') : false,
            btnScroll:    btnOn(mid + '-btnScroll'),
            btnAutoReconnect: btnOn(mid + '-btnAutoReconnect'),
            btnSendLE:    btnOn(mid + '-btnSendLE'),
            btnTs:        btnOn(mid + '-btnTs'),
            btnEcho:      btnOn(mid + '-btnEcho'),
            btnLineNum:   btnOn(mid + '-btnLineNum'),
            quickGroups:  qcmdGroups(mid).map(function(g) { return { id: g.id, name: g.name, folded: !!g.folded, on: qcmdGroupOn(g), items: JSON.parse(JSON.stringify(g.items || [])) }; }),
            qcmdSideWidth: qcmdSideWidth(mid),
            // 外部文件挂载（文件即存储）：路径 + 编码 + 载体风格；quickCmds 只是它的缓存
            quickCmdsFile:      m.quickCmdsFile || '',
            quickCmdsFileEnc:   m.quickCmdsFileEnc || '',
            quickCmdsFileStyle: m.quickCmdsFileStyle || '',
            sendHistory:  m.sendHistory ? m.sendHistory.slice(0, 20) : [],
            panelHeight:  saved.panelHeight || 0,
            workflows:    m.workflows ? JSON.parse(JSON.stringify(m.workflows)) : [],
        };
    });
    // WSL 面板为懒加载，未初始化时用缓存的配置，防止主监视器保存时丢失 WSL 快捷指令
    if (!monitors['wsl'] && _wslSavedConfig) {
        cfg.monitors['wsl'] = _wslSavedConfig;
    }
    return cfg;
}

// 收集单个监视器的配置
function collectConfigForMonitor(mid) {
    var m = monitors[mid];
    if (!m) return null;
    var portSel   = document.getElementById(mid + '-portSelect');
    var baudInp   = document.getElementById(mid + '-baudRate');
    var lineEnd   = document.getElementById(mid + '-lineEnding');
    var viewMode  = document.getElementById(mid + '-viewMode');
    var dataBits  = document.getElementById(mid + '-dataBits');
    var stopBits  = document.getElementById(mid + '-stopBits');
    var parity    = document.getElementById(mid + '-parity');
    var chkDTR    = document.getElementById(mid + '-chkDTR');
    var chkRTS    = document.getElementById(mid + '-chkRTS');
    var advRow    = document.getElementById(mid + '-advRow');
    var sendAsText = document.getElementById(mid + '-sendAsText');
    function btnOn(id) { var el = document.getElementById(id); return el ? el.classList.contains('on') : true; }
    return {
        port:         portSel  ? (portSel.getAttribute('data-val') || '') : '',
        baud:         baudInp  ? baudInp.value  : '115200',
        lineEnding:   lineEnd  ? (lineEnd.getAttribute('data-val') || 'crlf') : 'crlf',
        viewMode:     viewMode ? (viewMode.getAttribute('data-val') || 'text') : 'text',
        sendAs:       sendAsText ? (sendAsText.textContent === 'HEX' ? 'hex' : 'text') : 'text',
        dataBits:     dataBits ? (dataBits.getAttribute('data-val') || '8') : '8',
        stopBits:     stopBits ? (stopBits.getAttribute('data-val') || '1') : '1',
        parity:       parity   ? (parity.getAttribute('data-val') || 'none')   : 'none',
        dtr:          chkDTR   ? chkDTR.checked : false,
        rts:          chkRTS   ? chkRTS.checked : true,
        advOpen:      advRow   ? advRow.classList.contains('vis') : false,
        btnScroll:    btnOn(mid + '-btnScroll'),
        btnAutoReconnect: btnOn(mid + '-btnAutoReconnect'),
        btnSendLE:    btnOn(mid + '-btnSendLE'),
        btnTs:        btnOn(mid + '-btnTs'),
        btnEcho:      btnOn(mid + '-btnEcho'),
        btnLineNum:   btnOn(mid + '-btnLineNum'),
        quickGroups:  qcmdGroups(mid).map(function(g) { return { id: g.id, name: g.name, folded: !!g.folded, on: qcmdGroupOn(g), items: JSON.parse(JSON.stringify(g.items || [])) }; }),
        qcmdSideWidth: qcmdSideWidth(mid),
        quickCmdsFile:      m.quickCmdsFile || '',
        quickCmdsFileEnc:   m.quickCmdsFileEnc || '',
        quickCmdsFileStyle: m.quickCmdsFileStyle || '',
        sendHistory:  m.sendHistory ? m.sendHistory.slice(0, 20) : [],
        workflows:    m.workflows ? JSON.parse(JSON.stringify(m.workflows)) : [],
    };
}

// 复制源监视器的用户配置到目标监视器（深拷贝，两监视器配置互不干扰）
function copyMonitorConfig(srcMid, dstMid, opts) {
    if (!monitors[srcMid] || !monitors[dstMid]) return;
    var cfg = collectConfigForMonitor(srcMid);
    if (!cfg) return;
    // opts.skipPort：不继承端口（蓝牙页内嵌监视器用，避免与主监视器抢同一个串口）
    if (opts && opts.skipPort) { delete cfg.port; }
    // 终端模式需要额外的初始化状态，暂不复制；发送历史是运行时数据，不复制
    delete cfg.btnSendLE;
    delete cfg.sendHistory;
    // 外部指令文件**不复制**：两个监视器挂同一个文件会互相写回打架（后写的会撞冲突哈希）
    delete cfg.quickCmdsFile;
    delete cfg.quickCmdsFileEnc;
    delete cfg.quickCmdsFileStyle;
    applyMonitorConfig(dstMid, cfg);
    // 复制的工作流规则需要重新渲染列表
    if (cfg.workflows && cfg.workflows.length > 0 && monitors[dstMid]) {
        renderWorkflowList(dstMid);
    }
    // 触发端口列表刷新，应用复制的端口选择
    if (monitors[dstMid] && monitors[dstMid].isWsl) {
        refreshWslMonPorts(dstMid);
    } else {
        refreshPorts(dstMid);
    }
}

// 将配置应用到指定监视器
function applyMonitorConfig(mid, mc) {
    if (!mc) return;
    // 波特率
    var baudInp = document.getElementById(mid + '-baudRate');
    if (baudInp && mc.baud) {
        baudInp.value = mc.baud;
        var baudDrop = document.getElementById(mid + '-baudDropdown');
        if (baudDrop) {
            baudDrop.querySelectorAll('.baud-opt').forEach(function(o) {
                o.classList.toggle('active', o.textContent.trim() === String(mc.baud));
            });
        }
    }
    // 行尾
    if (mc.lineEnding) {
        var lineEnd = document.getElementById(mid + '-lineEnding');
        if (lineEnd) {
            lineEnd.setAttribute('data-val', mc.lineEnding);
            var lineEndOpt = lineEnd.querySelector('.sel-opt[data-val="' + mc.lineEnding + '"]');
            if (lineEndOpt) {
                lineEnd.querySelector('.sel-text').textContent = lineEndOpt.textContent;
                lineEnd.querySelectorAll('.sel-opt').forEach(function(o) { o.classList.remove('active'); });
                lineEndOpt.classList.add('active');
            }
        }
    }
    // 视图模式
    if (mc.viewMode) {
        var viewMode = document.getElementById(mid + '-viewMode');
        if (viewMode) {
            viewMode.setAttribute('data-val', mc.viewMode);
            var vmOpt = viewMode.querySelector('.sel-opt[data-val="' + mc.viewMode + '"]');
            if (vmOpt) {
                viewMode.querySelector('.sel-text').textContent = vmOpt.textContent;
                viewMode.querySelectorAll('.sel-opt').forEach(function(o) { o.classList.remove('active'); });
                vmOpt.classList.add('active');
            }
        }
    }
    // 格式选择
    if (mc.sendAs) {
        var sendAsText = document.getElementById(mid + '-sendAsText');
        var sendAsDrop = document.getElementById(mid + '-sendAsDrop');
        if (sendAsText) sendAsText.textContent = mc.sendAs === 'hex' ? 'HEX' : '文本';
        if (sendAsDrop) {
            sendAsDrop.querySelectorAll('.send-as-opt').forEach(function(o) {
                o.classList.toggle('active', o.getAttribute('data-val') === mc.sendAs);
            });
        }
    }
    // 高级设置
    if (mc.dataBits) {
        var dataBits = document.getElementById(mid + '-dataBits');
        if (dataBits) {
            dataBits.setAttribute('data-val', mc.dataBits);
            var dbOpt = dataBits.querySelector('.sel-opt[data-val="' + mc.dataBits + '"]');
            if (dbOpt) {
                dataBits.querySelector('.sel-text').textContent = dbOpt.textContent;
                dataBits.querySelectorAll('.sel-opt').forEach(function(o) { o.classList.remove('active'); });
                dbOpt.classList.add('active');
            }
        }
    }
    if (mc.stopBits) {
        var stopBits = document.getElementById(mid + '-stopBits');
        if (stopBits) {
            stopBits.setAttribute('data-val', mc.stopBits);
            var sbOpt = stopBits.querySelector('.sel-opt[data-val="' + mc.stopBits + '"]');
            if (sbOpt) {
                stopBits.querySelector('.sel-text').textContent = sbOpt.textContent;
                stopBits.querySelectorAll('.sel-opt').forEach(function(o) { o.classList.remove('active'); });
                sbOpt.classList.add('active');
            }
        }
    }
    if (mc.parity) {
        var parity = document.getElementById(mid + '-parity');
        if (parity) {
            parity.setAttribute('data-val', mc.parity);
            var parOpt = parity.querySelector('.sel-opt[data-val="' + mc.parity + '"]');
            if (parOpt) {
                parity.querySelector('.sel-text').textContent = parOpt.textContent;
                parity.querySelectorAll('.sel-opt').forEach(function(o) { o.classList.remove('active'); });
                parOpt.classList.add('active');
            }
        }
    }
    var chkDTR = document.getElementById(mid + '-chkDTR');
    if (chkDTR && mc.dtr !== undefined) chkDTR.checked = mc.dtr;
    var chkRTS = document.getElementById(mid + '-chkRTS');
    if (chkRTS && mc.rts !== undefined) chkRTS.checked = mc.rts;
    // 高级行是否展开
    var advRow = document.getElementById(mid + '-advRow');
    var btnAdv = document.getElementById(mid + '-btnAdv');
    if (advRow && mc.advOpen) {
        advRow.classList.add('vis');
        if (btnAdv) btnAdv.classList.add('on');
    }
    // Toggle 按钮状态
    function setBtn(id, on) {
        var el = document.getElementById(id);
        if (el) el.classList.toggle('on', !!on);
    }
    if (mc.btnScroll !== undefined)       setBtn(mid + '-btnScroll', mc.btnScroll);
    if (mc.btnAutoReconnect !== undefined) setBtn(mid + '-btnAutoReconnect', mc.btnAutoReconnect);
    // 终端模式是交互式会话状态，不随配置自动恢复为"开"，否则按钮显示开启但实际未进入终端模式
    setBtn(mid + '-btnSendLE', false);
    if (mc.btnTs !== undefined)            setBtn(mid + '-btnTs', mc.btnTs);
    if (mc.btnEcho !== undefined)          setBtn(mid + '-btnEcho', mc.btnEcho);
    if (mc.btnLineNum !== undefined) {
        setBtn(mid + '-btnLineNum', mc.btnLineNum);
        var output = document.getElementById(mid + '-output');
        if (output && mc.btnLineNum) output.classList.add('with-line-num');
    }
    // 快速指令（现在是"组"）：新配置里有 quickGroups 就直接用；老配置只有扁平的 quickCmds →
    // 置空 quickGroups 让 qcmdGroups() 现场包成一组（迁移，不丢任何一条）。
    // ⚠️ 迁移后 `m.quickCmds` **保持 null**（只是给 qcmdGroups 读一次的种子）——
    // 任何地方都别再从监视器对象上读它：旧代码在导入成功提示里读了 `quickCmds.length`，
    // 于是抛 "Cannot read properties of null (reading 'length')"，
    // 被 catch 一兜就变成"导入明明成功却报导入失败"（2026-09 真踩过）。要条数用 qcmdAllItems(mid).length
    if (monitors[mid]) {
        if (mc.quickGroups && mc.quickGroups.length) {
            monitors[mid].quickGroups = JSON.parse(JSON.stringify(mc.quickGroups));
            monitors[mid].quickCmds = null;
        } else if (mc.quickCmds && mc.quickCmds.length > 0) {
            monitors[mid].quickGroups = null;
            monitors[mid].quickCmds = mc.quickCmds;
        }
        rebuildQcmdList(mid);
    }
    // 快速指令分栏宽度（拖动折叠条调过就沿用；没调过保持缺省 300px）
    if (mc.qcmdSideWidth) setQcmdSideWidth(mid, mc.qcmdSideWidth);
    // 快速指令外部文件：记下路径与编码/风格，并按文件重读一遍（文件才是存储）
    if (mc.quickCmdsFile && monitors[mid]) {
        monitors[mid].quickCmdsFile = mc.quickCmdsFile;
        monitors[mid].quickCmdsFileEnc = mc.quickCmdsFileEnc || 'utf-8';
        monitors[mid].quickCmdsFileStyle = mc.quickCmdsFileStyle || 'md';
        monitors[mid].quickCmdsFileVerified = false;   // 读完之前不许写回
        renderQcmdSource(mid);
        qcmdReloadFile(mid, true);   // 读不到就保留配置里的缓存并提示，绝不清空
    }
    // 发送历史
    if (mc.sendHistory && mc.sendHistory.length > 0 && monitors[mid]) {
        monitors[mid].sendHistory = mc.sendHistory;
    }
    // 工作流规则
    if (mc.workflows && mc.workflows.length > 0 && monitors[mid]) {
        monitors[mid].workflows = mc.workflows;
    }
    // 端口选择（在 refreshPorts 回调中设置，避免端口未加载时失效）
    if (mc.port) {
        monitors[mid]._savedPort = mc.port;
    }
}

// 保存配置（防抖：500ms 后写入）
var _saveConfigTimer = null;
function scheduleConfigSave() {
    if (_loadingConfig) return; // 配置恢复期间跳过
    if (_saveConfigTimer) clearTimeout(_saveConfigTimer);
    _saveConfigTimer = setTimeout(function() {
        var cfg = collectConfig();
        invoke('save_config', { configJson: JSON.stringify(cfg) }).catch(function(e) {
            console.warn('保存配置失败:', e);
            reportError(e, 'scheduleConfigSave');
        });
    }, 500);
}

/* ===== 主题切换 ===== */
var _currentTheme = 'light';
var _currentThemeStyle = 'default';

var _TITLE_BAR_COLORS = {
    'default':      { dark: { r:28,g:30,b:34 }, light: { r:237,g:240,b:242 } },
    'japanese':     { dark: { r:20,g:22,b:32 }, light: { r:244,g:240,b:232 } },
    'poetic':       { dark: { r:18,g:16,b:20 }, light: { r:232,g:226,b:240 } },
    'ink':          { dark: { r:20,g:22,b:24 }, light: { r:244,g:240,b:232 } },
    'peach':        { dark: { r:24,g:16,b:20 }, light: { r:246,g:240,b:242 } },
    'autumn':       { dark: { r:20,g:16,b:8 }, light: { r:242,g:235,b:224 } }
};

function getSystemTheme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getThemeDataAttr() {
    if (_currentThemeStyle === 'default') return _currentTheme === 'light' ? 'default-light' : 'default';
    if (_currentThemeStyle === 'japanese') return _currentTheme === 'light' ? 'japanese-light' : 'japanese';
    if (_currentThemeStyle === 'poetic') return _currentTheme === 'light' ? 'poetic' : 'poetic-dark';
    if (_currentThemeStyle === 'ink') return _currentTheme === 'light' ? 'ink' : 'ink-dark';
    if (_currentThemeStyle === 'peach') return _currentTheme === 'light' ? 'peach' : 'peach-dark';
    if (_currentThemeStyle === 'autumn') return _currentTheme === 'light' ? 'autumn' : 'autumn-dark';
    return 'default';
}

function syncThemeUI() {
    var sw = document.getElementById('themeSwitch');
    if (sw) {
        sw.classList.toggle('on', _currentTheme === 'dark');
        sw.title = '深浅色切换（当前：' + (_currentTheme === 'dark' ? '深色' : '浅色') + '）';
    }
    var drop = document.getElementById('themeStyleDrop');
    if (drop) {
        drop.querySelectorAll('.sel-opt').forEach(function(o) {
            o.classList.toggle('active', o.getAttribute('data-style') === _currentThemeStyle);
        });
    }
    var wrap = document.getElementById('themeStyleWrap');
    var names = { 'default': '默认', 'japanese': '浮世绘彩', 'poetic': '诗意东方', 'ink': '水墨丹青', 'peach': '桃之夭夭', 'autumn': '金风玉露' };
    if (wrap) wrap.title = '主题风格：' + (names[_currentThemeStyle] || '默认') + '（6 种配色 × 深浅色）';
}

function applyTheme(theme) {
    _currentTheme = theme;
    var el = document.documentElement;
    el.classList.add('transitioning');
    el.setAttribute('data-theme', getThemeDataAttr());
    syncThemeUI();
    var palette = _TITLE_BAR_COLORS[_currentThemeStyle] || _TITLE_BAR_COLORS['default'];
    animateTitleBar(palette[_currentTheme] || palette.dark, 300);
    clearTimeout(el._transTid);
    el._transTid = setTimeout(function() { el.classList.remove('transitioning'); }, 350);
}

var _titleBarCur = { r: 28, g: 30, b: 34 };

function easeOut(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }

function animateTitleBar(target, duration) {
    var start = { r: _titleBarCur.r, g: _titleBarCur.g, b: _titleBarCur.b };
    var startTime = Date.now();
    if (_titleBarAnim) clearInterval(_titleBarAnim);
    _titleBarAnim = setInterval(function() {
        var elapsed = Date.now() - startTime;
        var t = Math.min(elapsed / duration, 1);
        var et = easeOut(t);
        var r = Math.round(start.r + (target.r - start.r) * et);
        var g = Math.round(start.g + (target.g - start.g) * et);
        var b = Math.round(start.b + (target.b - start.b) * et);
        try { invoke('set_title_bar_color', { r: r, g: g, b: b }).catch(function(_v) {}); } catch(_) {}
        if (t >= 1) { clearInterval(_titleBarAnim); _titleBarAnim = null; _titleBarCur = { r: target.r, g: target.g, b: target.b }; }
    }, 16);
}
var _titleBarAnim = null;

function syncTitleBarColor(theme) {
    var palette = _TITLE_BAR_COLORS[_currentThemeStyle] || _TITLE_BAR_COLORS['default'];
    animateTitleBar(palette[theme] || palette.dark, 300);
}

function toggleTheme() {
    applyTheme(_currentTheme === 'dark' ? 'light' : 'dark');
    scheduleConfigSave();
}

function toggleThemeStyleDrop(e) {
    e.stopPropagation();
    var drop = document.getElementById('themeStyleDrop');
    if (drop) drop.classList.toggle('open');
}

function selectThemeStyle(style) {
    _currentThemeStyle = style;
    var el = document.documentElement;
    el.classList.add('transitioning');
    el.setAttribute('data-theme', getThemeDataAttr());
    syncThemeUI();
    var palette = _TITLE_BAR_COLORS[_currentThemeStyle] || _TITLE_BAR_COLORS['default'];
    animateTitleBar(palette[_currentTheme] || palette.dark, 300);
    clearTimeout(el._transTid);
    el._transTid = setTimeout(function() { el.classList.remove('transitioning'); }, 350);
    var drop = document.getElementById('themeStyleDrop');
    if (drop) drop.classList.remove('open');
    scheduleConfigSave();
}

document.addEventListener('click', function(e) {
    var drop = document.getElementById('themeStyleDrop');
    var wrap = document.getElementById('themeStyleWrap');
    if (drop && wrap && !wrap.contains(e.target)) drop.classList.remove('open');
});

try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function() {
        applyTheme(getSystemTheme());
        scheduleConfigSave();
    });
} catch (_) { console.warn('matchMedia 监听注册失败:', _); }

// 启动时跟随系统主题
try {
    applyTheme(getSystemTheme());
    syncThemeUI();
} catch (err) {
    console.warn('主题初始化失败:', err);
}

// 延迟再次设置标题栏颜色，确保窗口完全初始化
setTimeout(function() { syncTitleBarColor(_currentTheme); }, 500);
setTimeout(function() { syncTitleBarColor(_currentTheme); }, 1500);

// 启动时加载配置
async function loadAndApplyConfig() {
    _loadingConfig = true;
    try {
        var raw = await invoke('load_config');
        if (!raw) { _loadingConfig = false; return; }
        var cfg = JSON.parse(raw);
        if (!cfg) { _loadingConfig = false; return; }
        // 旧配置可能没有 version 字段（或值不可识别）：一律按可迁移的旧版处理。
        // 原先这里直接 return 会让配置不生效，而退出时 collectConfig 又会用默认值覆盖，
        // 等于"升级后配置被清空"。现在先备份原文件，再补齐缺失字段并升级到当前 schema。
        if (cfg.version !== 1 && cfg.version !== 2) {
            try { await invoke('backup_config'); } catch (e) { console.warn('配置备份失败(跳过):', e); }
            // 按最老的 v1 结构补齐字段，再升到当前版本
            Object.keys(cfg.monitors || {}).forEach(function(mid) {
                if (cfg.monitors[mid] && !cfg.monitors[mid].workflows) cfg.monitors[mid].workflows = [];
            });
            cfg.version = 2;
            invoke('save_config', { configJson: JSON.stringify(cfg) }).catch(function(e) { console.warn('保存配置失败:', e); reportError(e, 'save-config-migrate'); });
        } else if (cfg.version === 1) {
            // V1 → V2 迁移：添加空 workflows
            Object.keys(cfg.monitors || {}).forEach(function(mid) {
                if (cfg.monitors[mid] && !cfg.monitors[mid].workflows) cfg.monitors[mid].workflows = [];
            });
            cfg.version = 2;
            invoke('save_config', { configJson: JSON.stringify(cfg) }).catch(function(e) { console.warn('保存配置失败:', e); reportError(e, 'save-config-v2'); });
        }
        // 恢复主题
        if (cfg.themeStyle) _currentThemeStyle = cfg.themeStyle;
        if (cfg.theme) applyTheme(cfg.theme);
        // 恢复日志目录
        if (cfg.logDir) logDirPath = cfg.logDir;
        // 恢复WSL自动映射
        if (cfg.wslAutoMap && typeof cfg.wslAutoMap === 'object') {
            // 迁移：清除旧的 busid 键（如 "1-3"），只保留 vidpid 键（如 "1A86:7523"）
            var migrated = {};
            Object.keys(cfg.wslAutoMap).forEach(function(k) {
                if (k.indexOf(':') !== -1) migrated[k] = cfg.wslAutoMap[k];
            });
            _wslAutoMap = migrated;
            updateAutoMapPolling();
        }
        // 注：窗口大小与位置改由 Rust 端在启动时统一恢复（window.json，含最大化状态），
        // 不再在这里用 set_window_size 二次设置，以免窗口显示后再次跳变尺寸。
        // 恢复蓝牙页状态（纯内存变量先就位；内嵌监视器等蓝牙页 DOM 建立后再开，见 openBle）
        if (cfg.ble) restoreBleState(cfg.ble);
        // 恢复 OTA 协议档（阶段 1）：纯数据，蓝牙页 DOM 还没建也照常生效
        // （升级弹窗自己会在打开时把它填回表单，见 openBleOtaModal）
        if (cfg.otaProfile) _bleOtaProfile = bleOtaProfileLoad(cfg.otaProfile);
        // 恢复主监视器配置
        if (cfg.monitors && cfg.monitors['main']) {
            applyMonitorConfig('main', cfg.monitors['main']);
        }
        // 缓存 WSL 监视器配置（WSL 面板为懒加载，需在保存时合并回去）
        if (cfg.monitors && cfg.monitors['wsl']) {
            _wslSavedConfig = cfg.monitors['wsl'];
        }
        // 恢复额外监视器
        var savedExtra = cfg.extraCount || 0;
        for (var i = 1; i <= savedExtra; i++) {
            var emid = 'extra-' + i;
            addMonitor(); // 已经会递增 extraCount
            if (cfg.monitors && cfg.monitors[emid]) {
                applyMonitorConfig(emid, cfg.monitors[emid]);
            }
        }
        // 渲染所有监视器的工作流规则列表
        Object.keys(monitors).forEach(function(mid) {
            if (monitors[mid] && monitors[mid].workflows && monitors[mid].workflows.length > 0) {
                renderWorkflowList(mid);
            }
        });
        // 初始化 Rust 端工作流状态
        invoke('init_workflows', { configJson: JSON.stringify(cfg) }).catch(function() {});
    } catch (e) {
        console.warn('加载配置失败:', e);
    }
    _loadingConfig = false;
}

