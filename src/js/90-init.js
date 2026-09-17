/* 90-init.js —— 前端第 14 块，拆自原单文件 src/index.html（**纯搬家**；行号映射见 doc/FRONTEND_LAYOUT.md）。
   ⚠️ **普通脚本**（不是 ESM）：按 index.html 里的 <script src> 顺序加载、共享同一个全局作用域 —— 行内 onclick
   与现有函数互相调用照旧；**别改成 type="module"**（模块作用域会让它们全部失效）。 */
/* ===== 窗口控制 ===== */
function winMinimize() { try { window.__TAURI__.window.getCurrentWindow().minimize(); } catch (err) { console.warn('minimize failed:', err); } }
function winToggleMaximize() { try { window.__TAURI__.window.getCurrentWindow().toggleMaximize(); } catch (err) { console.warn('toggleMaximize failed:', err); } }
function winClose() { try { window.__TAURI__.window.getCurrentWindow().close(); } catch (err) { console.warn('close failed:', err); } }
// 主窗口在启动时是隐藏的，页面布局完成后调用此函数在最终几何位置一次性显示，避免二次跳变。
function revealMainWindow() {
    invoke('reveal_main_window').catch(function(err) { console.warn('显示主窗口失败:', err); });
}

/* ===== 标题栏拖动 ===== */
document.addEventListener('DOMContentLoaded', function() {
    var bar = document.getElementById('globalBar');
    if (!bar) return;
    bar.addEventListener('mousedown', async function(e) {
        // 如果点击的是交互元素，不触发拖动
        if (e.target.closest('button') || e.target.closest('input') ||
            e.target.closest('select') || e.target.closest('textarea') ||
            e.target.closest('a') || e.target.closest('.add-btn') ||
            e.target.closest('.win-ctrl') || e.target.closest('.theme-switch') ||
            e.target.closest('.sel') || e.target.closest('.issue-btn') ||
            e.target.closest('.update-btn') || e.target.closest('.app-info')) return;
        try {
            await window.__TAURI__.window.getCurrentWindow().startDragging();
        } catch(err) { console.warn('startDragging failed:', err); }
    });
});

/* ===== 初始化 ===== */
/* ===== 自定义 tooltip（无延迟） ===== */
(function() {
    var tip = document.createElement('div');
    tip.className = 'custom-tip';
    document.body.appendChild(tip);
    var showTimer = null;
    document.addEventListener('mouseover', function(e) {
        var el = e.target.closest('[title]');
        if (!el || !el.title) { tip.classList.remove('show'); return; }
        // 排除下拉菜单内部元素
        if (el.closest('.sel-drop, .baud-dropdown, .send-hist, .send-as-drop')) return;
        var text = el.title;
        // 动态 tooltip：WSL 端口映射按钮根据当前界面状态实时决定文案（避免 tooltip 缓存陈旧值）
        if (el && el.id === 'wslToggleBtn') {
            var wp = document.getElementById('wsl-pane');
            text = (wp && wp.style.display === 'flex') ? '返回到串口调试器' : 'WSL 端口映射';
        }
        if (el && el.id === 'adbToggleBtn') {
            var ap = document.getElementById('adb-pane');
            text = (ap && ap.style.display === 'flex') ? '返回到串口调试器' : 'ADB 调试';
        }
        if (el && el.id === 'bleToggleBtn') {
            var bp = document.getElementById('ble-pane');
            text = (bp && bp.style.display === 'flex') ? '返回到串口调试器' : '蓝牙调试';
        }
        el.setAttribute('data-title', text);
        el.removeAttribute('title');
        tip.textContent = text;
        tip.classList.add('show');
        var r = el.getBoundingClientRect();
        var tw = tip.offsetWidth;
        var left = r.left + r.width / 2 - tw / 2;
        // 水平边界检测：防止 tooltip 超出屏幕
        if (left < 4) left = 4;
        else if (left + tw > window.innerWidth - 4) left = window.innerWidth - tw - 4;
        tip.style.left = left + 'px';
        // 下拉触发器（.sel 等）提示显示在上方，避免遮挡下拉菜单
        if (el.classList.contains('qcmd-side-tab')) {
            // 右侧竖排标签是整栏高度的按钮：提示放左侧并垂直居中，
            // 否则按“下方”算会落到窗口右下角外面
            tip.style.left = Math.max(4, r.left - tip.offsetWidth - 6) + 'px';
            tip.style.top = Math.max(4, r.top + r.height / 2 - tip.offsetHeight / 2) + 'px';
        } else if (el.classList.contains('sel') || el.classList.contains('baud-wrap') || el.classList.contains('send-as')) {
            tip.style.top = r.top - tip.offsetHeight - 6 + 'px';
        } else {
            tip.style.top = r.bottom + 6 + 'px';
        }
    });
    document.addEventListener('mouseout', function(e) {
        var el = e.target.closest('[data-title]');
        if (el) { el.title = el.getAttribute('data-title'); el.removeAttribute('data-title'); }
        tip.classList.remove('show');
    });
})();

document.addEventListener('DOMContentLoaded', function() {
    try {
        // 加载应用信息（版本号 + commit hash），设置到 tooltip
        invoke('get_app_info').then(function(info) {
            var wrap = document.getElementById('appInfoWrap');
            if (wrap) wrap.title = 'Seahi Serial v' + info.version + ' (' + info.commit + ') · 点击回到串口主界面';
        }).catch(function() {});

        // 主面板创建成功后隐藏启动兜底页（createMonitorPane 抛错则进入 catch 显示错误）
        createMonitorPane('main', '主监视器', false);
        var bootBox = document.getElementById('bootError');
        if (bootBox) bootBox.style.display = 'none';

        setInterval(function() { if (!monitors.main || !monitors.main.isConnected) refreshPorts('main'); }, 10000);

        // 加载并恢复用户上次的配置
        loadAndApplyConfig();

        // 页面 DOM/样式已就绪（主面板已同步创建完成，尚未发生绘制），
        // 此刻把隐藏的主窗口一次性显示在恢复后的最终几何位置，避免“先显示再移动/缩放”的二次跳变。
        revealMainWindow();

        // 延迟检查更新，避免与端口加载竞争网络和 CPU 资源
        setTimeout(checkForUpdate, 2000);
        // 每 10 分钟轮询一次更新，运行中也能发现新版本
        setInterval(checkForUpdate, 10 * 60 * 1000);

        // 监听设备变更事件，自动刷新端口列表（防抖 150ms）
        if (window.__TAURI__ && window.__TAURI__.event) {
            // 配对请求：后端 ble_pair 需要用户确认配对码时发这个事件（payload: {address, kind, pin}）
            window.__TAURI__.event.listen('ble-pair-request', function(ev) {
                showBlePairDialog(ev && ev.payload);
            });
            // 窗口最小化/切走也算"不可见"：回来时把读取频率调回实时
            document.addEventListener('visibilitychange', function() { refreshMonitorPollRates(); });
            var _deviceChangeTimer = null;
            window.__TAURI__.event.listen('device-changed', function() {
                console.log('[device-changed] event received at', Date.now());
                if (_deviceChangeTimer) clearTimeout(_deviceChangeTimer);
                _deviceChangeTimer = setTimeout(function() {
                    _deviceChangeTimer = null;
                    console.log('[device-changed] refreshing ports at', Date.now());
                    document.querySelectorAll('.monitor-pane').forEach(function(pane) {
                        var mid = pane.id.replace('pane-', '');
                        if (!monitors[mid] || monitors[mid].isConnected) return;
                        // 区分 WSL / Windows 监视器：WSL 监视器刷新 WSL 设备列表，Windows 监视器刷新 COM 列表。
                        // 此前统一用 refreshPorts，会导致授权期间（设备变更事件）把 WSL 监视器端口填成 Windows COM 列表
                        if (monitors[mid].isWsl) {
                            refreshWslMonPorts(mid);
                        } else {
                            refreshPorts(mid, true);
                        }
                    });
                    // WSL 自动映射：拔插事件到来立即检查一次（配合后台 15s 降频轮询，插拔仍能快速响应）
                    if (_wslAutoMapTimer) autoMapCheck();
                    // ADB 面板打开时，设备变更事件也刷新一次 ADB 设备列表（即时响应）
                    var adbPane = document.getElementById('adb-pane');
                    if (adbPane && adbPane.style.display === 'flex' && typeof refreshAdbDevices === 'function') {
                        refreshAdbDevices();
                    }
                    // WSL 页面打开时也刷新设备列表
                    var wslList = document.querySelector('[id$="-wslDeviceList"]');
                    if (wslList) {
                        var wslMid = wslList.id.replace('-wslDeviceList', '');
                        loadWslDevices(wslMid);
                    }
                }, 150);
            });
            // 日志缓存文件触顶（后端单文件 8 MiB 上限）：明确告知用户，不静默停止写入
            window.__TAURI__.event.listen('log-cache-capped', function(ev) {
                var p = (ev && ev.payload) || {};
                var mid = p.monitorId || 'main';
                var mb = Math.round((p.maxBytes || 0) / (1024 * 1024));
                if (monitors[mid]) {
                    appendOutput(mid, 'sys', '日志缓存文件已达上限 ' + mb + ' MiB，后续内容不再写入（完整内容以实时输出为准）');
                }
                showToast('会话 ' + mid + ' 的日志缓存已达 ' + mb + ' MiB 上限，已停止写入', 'info');
            });
            // AI 下发的界面操作：执行后回执（后端在等这个 ack，5s 超时）
            window.__TAURI__.event.listen('mcp-ui-cmd', function(ev) {
                mcpUiCmdReply((ev && ev.payload) || {}, function(ack) {
                    invoke('mcp_ui_ack', ack).catch(function() {});
                });
            });
            // MCP 服务器状态变化（启用/停用/会话增减）：更新标题栏图标上的状态点
            window.__TAURI__.event.listen('mcp-status-changed', function(ev) {
                _mcpStatus = ev && ev.payload;
                renderMcpStatus(_mcpStatus);
            });
            // 启动时拉一次状态，把状态点画对（服务器是随程序启动的）
            setTimeout(refreshMcpStatus, 500);
            // 启动时把控件注册表报给后端，这样 ctl_* 工具从一开始就存在
            setTimeout(function() { try { mcpEnsureRegistry(true); } catch (e) {} }, 700);
            // 安装更新前强制保存配置（process::exit 会跳过 beforeunload）
            window.__TAURI__.event.listen('save-before-exit', function() {
                if (_saveConfigTimer) { clearTimeout(_saveConfigTimer); _saveConfigTimer = null; }
                // 退出前把待回灌的日志发出去（批量窗口可能还没到）
                try { mcpLogFlush(); } catch (e) {}
                Object.keys(monitors).forEach(function(mid) { logCacheEnd(mid); }); // 退出前 flush 并结束所有会话缓存
                var cfg = collectConfig();
                invoke('save_config', { configJson: JSON.stringify(cfg) }).catch(function(e) { console.warn('退出前保存配置失败:', e); reportError(e, 'save-before-exit'); });
            });
        }

        // 监听窗口大小变化，缓存并保存到配置（防抖 500ms）
        function refreshWindowSizeCache() {
            invoke('get_window_size').then(function(size) {
                _cachedWindowSize = size;
            }).catch(function() {});
        }
        refreshWindowSizeCache();
        var _resizeTimer = null;
        window.addEventListener('resize', function() {
            refreshWindowSizeCache();
            if (_resizeTimer) clearTimeout(_resizeTimer);
            _resizeTimer = setTimeout(function() {
                _resizeTimer = null;
                scheduleConfigSave();
            }, 500);
        });

        // 首次使用引导
        if (!localStorage.getItem('onboarding_done')) {
            setTimeout(showOnboarding, 600);
        }

        // 窗口关闭前强制保存配置，防止未提交的编辑丢失
        window.addEventListener('beforeunload', function() {
            if (_saveConfigTimer) { clearTimeout(_saveConfigTimer); _saveConfigTimer = null; }
            qcmdFlushPendingFileSaves();   // 去抖中的"写回指令文件"也一并刷掉
            Object.keys(monitors).forEach(function(mid) { logCacheEnd(mid); }); // 关闭前 flush 并结束所有会话缓存
            var cfg = collectConfig();
            invoke('save_config', { configJson: JSON.stringify(cfg) }).catch(function(e) { console.warn('关闭前保存配置失败:', e); reportError(e, 'beforeunload'); });
        });
    } catch (err) {
        console.error('初始化失败:', err);
        revealMainWindow(); // 出错也要让隐藏的窗口显示出来，以便用户看到提示
        if (document.getElementById('pane-main')) {
            // 主面板已创建，仅部分功能失败：提示但不遮屏
            try { showToast('部分功能初始化失败: ' + err, 'error'); } catch (_) {}
        } else {
            showFatalError('界面初始化失败', err);
        }
    }
});

// 初始化看门狗：主面板未在 8 秒内创建成功则显示兜底页，避免无提示黑屏
setTimeout(function() {
    try {
        if (!document.getElementById('pane-main')) {
            var d = document.getElementById('bootErrorDetail');
            // 若 catch 已经显示了具体错误信息，不覆盖为笼统的超时提示
            if (!d || !d.textContent) {
                showFatalError('界面初始化超时', '主监视器面板未在 8 秒内创建完成，请点击下方按钮重新加载。');
            }
        }
    } catch (_) {}
}, 8000);

/* ===== 首次使用引导 ===== */
var _onboardSteps = [
    {
        target: '.global-bar',
        pos: 'bottom',
        title: '1 / 9 — 全局操作栏',
        desc: '左侧可打开额外监视器和 WSL 端口映射；右侧可切换主题风格、提交反馈，以及深浅色模式。'
    },
    {
        target: '#main-portSelect',
        pos: 'bottom',
        title: '2 / 9 — 选择串口',
        desc: '点击下拉选择串口设备。插拔设备后会自动刷新列表。'
    },
    {
        target: '#main-baudWrap',
        pos: 'bottom',
        title: '3 / 9 — 设置波特率',
        desc: '输入或从下拉选择波特率，默认 115200。'
    },
    {
        target: '#main-btnStart',
        pos: 'bottom',
        title: '4 / 9 — 启动监控',
        desc: '确认串口和波特率无误后，点击「开始监控」连接串口。'
    },
    {
        target: '#main-ibtnGroup',
        pos: 'bottom',
        title: '5 / 9 — 工具栏按钮',
        desc: '清空内容、自动滚动、自动重连、终端模式、行号、时间戳、消息回显，以及更多设置。'
    },
    {
        target: '#main-sendBar',
        pos: 'top',
        title: '6 / 9 — 发送数据',
        desc: '在输入框输入内容后发送。支持 Text / HEX 双模式和发送历史。'
    },
    {
        target: '#main-btnQcmdSide',
        pos: 'top',
        title: '7 / 9 — 快速指令',
        desc: '监控输出区最右侧那条窄条就是快速指令分栏（默认折叠）：点一下展开，可添加常用指令一键发送；每条能设自己的顺序号、延时与 HEX，顺序号大于 0 的会按序号循环发送。'
    },
    {
        target: '#main-btnAdv',
        pos: 'bottom',
        title: '8 / 9 — 高级设置',
        desc: '点击齿轮图标展开：数据位、停止位、校验位、DTR/RTS 控制、日志保存。'
    },
    {
        target: '.global-bar',
        pos: 'bottom',
        title: '9 / 9 — 开始使用',
        desc: '以上就是核心功能。点击「跳过」或此处外部区域可随时关闭引导。'
    }
];
var _onboardIdx = 0;

function showOnboarding() {
    _onboardIdx = 0;
    _onboardPrevTarget = null;
    var overlay = document.getElementById('onboarding-overlay');
    var nav = document.getElementById('onboard-nav');
    var dotsEl = document.getElementById('onboard-dots');
    dotsEl.innerHTML = '';
    _onboardSteps.forEach(function(_, i) {
        var d = document.createElement('span');
        d.className = 'onboard-dot' + (i === 0 ? ' active' : '');
        dotsEl.appendChild(d);
    });
    overlay.classList.add('show');
    nav.style.display = 'flex';
    overlay.onclick = function(e) {
        if (e.target === overlay) closeOnboarding();
    };
    goStep(0);
}

var _onboardPrevTarget = null;

function goStep(idx) {
    _onboardIdx = idx;
    var step = _onboardSteps[idx];
    // 清除上一个目标的高亮
    if (_onboardPrevTarget) {
        _onboardPrevTarget.style.boxShadow = '';
        _onboardPrevTarget.style.position = '';
        _onboardPrevTarget.style.zIndex = '';
        _onboardPrevTarget.style.borderRadius = '';
    }
    var el = document.querySelector(step.target);
    if (!el) { nextStep(); return; }
    _onboardPrevTarget = el;
    var rect = el.getBoundingClientRect();
    var card = document.getElementById('onboard-step');
    var title = document.getElementById('onboard-title');
    var desc = document.getElementById('onboard-desc');
    var arrow = document.getElementById('onboard-arrow');
    var nextBtn = document.getElementById('onboard-next');
    title.textContent = step.title;
    desc.textContent = step.desc;
    nextBtn.textContent = idx === _onboardSteps.length - 1 ? '开始使用' : '下一步';
    // 聚光灯：给目标元素加 box-shadow（更深更亮）
    el.style.boxShadow = '0 0 0 4px var(--accent-focus, #4a7ab5), 0 0 24px 4px rgba(74,122,181,0.5), 0 0 0 9999px rgba(0,0,0,0.65)';
    el.style.position = 'relative';
    el.style.zIndex = '10001';
    el.style.borderRadius = '4px';
    // 先渲染内容，再测量卡片实际尺寸
    card.classList.remove('anim-in');
    card.style.top = '-9999px';
    card.style.left = '-9999px';
    card.style.visibility = 'hidden';
    card.style.display = '';
    arrow.className = 'onboard-arrow';
    arrow.style.left = '0px';
    var gap = 14;
    if (step.pos === 'bottom') {
        arrow.classList.add('top');
    } else {
        arrow.classList.add('bottom');
    }
    // 测量卡片实际尺寸
    var cardW = card.offsetWidth;
    var cardH = card.offsetHeight;
    // 目标元素水平中心点（或右侧对齐点）
    var targetCX = step.arrowAlign === 'right'
        ? rect.left + rect.width - 15
        : rect.left + rect.width / 2;
    // 理想卡片位置：水平居中对齐目标中心
    var idealLeft = targetCX - cardW / 2;
    var idealTop;
    if (step.pos === 'bottom') {
        idealTop = rect.bottom + gap;
    } else {
        idealTop = rect.top - gap - cardH;
    }
    // 边界 clamp（底部预留导航栏空间 ~80px）
    var vpW = window.innerWidth;
    var vpH = window.innerHeight;
    var navReserved = 80;
    var clampedLeft = Math.max(12, Math.min(idealLeft, vpW - cardW - 12));
    var clampedTop = Math.max(12, Math.min(idealTop, vpH - cardH - navReserved));
    // 箭头在卡片内的 X 偏移 = 目标中心点 - 卡片左边界，限制在卡片范围内
    var arrowX = targetCX - clampedLeft;
    arrowX = Math.max(16, Math.min(arrowX, cardW - 16));
    arrow.style.left = arrowX + 'px';
    // 应用位置
    card.style.visibility = '';
    card.style.top = clampedTop + 'px';
    card.style.left = clampedLeft + 'px';
    void card.offsetWidth;
    card.classList.add('anim-in');
    // 更新步骤指示点
    var dots = document.querySelectorAll('.onboard-dot');
    dots.forEach(function(d, i) { d.classList.toggle('active', i === idx); });
}

function nextStep() {
    if (_onboardIdx < _onboardSteps.length - 1) {
        goStep(_onboardIdx + 1);
    } else {
        closeOnboarding();
    }
}

function closeOnboarding() {
    var overlay = document.getElementById('onboarding-overlay');
    var nav = document.getElementById('onboard-nav');
    if (!overlay.classList.contains('show')) return;
    overlay.classList.remove('show');
    overlay.onclick = null;
    nav.style.display = 'none';
    nav.onclick = null;
    localStorage.setItem('onboarding_done', '1');
    // 清除当前目标的高亮
    if (_onboardPrevTarget) {
        _onboardPrevTarget.style.boxShadow = '';
        _onboardPrevTarget.style.position = '';
        _onboardPrevTarget.style.zIndex = '';
        _onboardPrevTarget.style.borderRadius = '';
        _onboardPrevTarget = null;
    }
}

// 测试错误上报功能
async function testErrorReport() {
    try {
        var result = await invoke('test_error_report');
        showToast('测试错误上报成功: ' + result, 'success');
    } catch (e) {
        showToast('测试失败: ' + e, 'error');
    }
}
