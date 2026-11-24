/* 86-node-red-window.js —— Node-RED **独立窗口**的外壳脚本（2026-11）
 *
 * 这个文件只跑在 `src/node-red-window.html` 里（那是编辑器窗口自己的页面，**不进 index.html**）。
 * 它干三件事：
 *   ① 自绘标题栏的窗口按钮：最小化 / 最大化 / 关闭（与主窗口同一个 API）；
 *   ② 向宿主要编辑器地址（`nodered_url`），填进 iframe；
 *   ③ 地址变了（引擎重启会换随机端口）就换 iframe.src —— 否则窗口停在旧端口上永远是白屏。
 *
 * ⚠️ 三条别改回去：
 *   ① **iframe 从生到死不许搬位置**（不 appendChild / insertBefore / 不 detach 再挂回）：
 *      reparent 会重建浏览上下文，编辑器整页重载，**没部署的修改就丢了**。
 *      （2026-11 之前主窗口里的分栏内嵌画布就踩过这个坑，那套已整段删除。）
 *   ② **不在这个窗口里停引擎**：关窗只是关一张皮，流程由侧车继续跑。
 *   ③ 标题栏按钮走 `core:window:*` 命令 —— 所以 `capabilities/default.json` 的 `windows`
 *      必须包含 `nodered`，否则按钮点了没反应（权限被 ACL 拦掉，控制台一条 deny）。
 */

var NR_URL = '';          // 当前 iframe 指向的地址（空 = 还没拿到）
var NR_TRIES = 0;         // 拿地址重试次数（引擎刚起时可能还没就绪）
var NR_MAX_TRIES = 30;    // 约 30 × 1s；宿主那边拉起侧车最坏 25s，再多就是真出错

/* ⚠️ 这个页面**不加载 00-bootstrap.js**（那是主窗口的引导块），所以全局的 `invoke()` 在这里不存在 ——
   必须直接用 Tauri 注入的 `window.__TAURI__.core.invoke`。（第一版写了裸 `invoke`，结果外壳页永远显示
   "没有 Tauri 桥，无法连接编辑器"，而宿主侧一切正常。） */
function nrInvoke(cmd, args) {
    try {
        var t = window.__TAURI__;
        if (t && t.core && typeof t.core.invoke === 'function') return t.core.invoke(cmd, args || {});
        if (t && typeof t.invoke === 'function') return t.invoke(cmd, args || {});   // 老形态兜底
    } catch (e) {
        return Promise.reject(e);
    }
    return Promise.reject(new Error('没有 Tauri 桥'));
}

var _nrWin = null;
function nrWindow() {
    if (_nrWin) return _nrWin;
    try { _nrWin = window.__TAURI__.window.getCurrentWindow(); } catch (e) { console.warn('[node-red] 取窗口句柄失败:', e); }
    return _nrWin;
}

function nrStatus(text, isErr) {
    var el = document.getElementById('nrStatus');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'nr-status' + (isErr ? ' err' : '');
}

/* ===== 标题栏 ===== */
function nrSyncMaxIcon() {
    var win = nrWindow();
    var btn = document.getElementById('nrMax');
    if (!win || !btn) return;
    try {
        win.isMaximized().then(function (max) {
            btn.title = max ? '还原' : '最大化';
            btn.setAttribute('aria-label', max ? '还原' : '最大化');
            btn.innerHTML = max
                ? '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1"><rect x="1.5" y="2.5" width="6" height="6" rx="0.5"/><path d="M3.2 2.2V1.6h5.2v5.2H7.6"/></svg>'
                : '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1"><rect x="1.5" y="1.5" width="7" height="7" rx="0.5"/></svg>';
        }).catch(function () {});
    } catch (e) { /* 拿不到就算了，不影响按钮本身 */ }
}

function nrToggleMaximize() {
    var win = nrWindow();
    if (!win) return;
    try { win.toggleMaximize().then(nrSyncMaxIcon).catch(function () {}); } catch (e) { console.warn('[node-red] 最大化失败:', e); }
}

function nrMinimize() {
    var win = nrWindow();
    if (!win) return;
    try { win.minimize(); } catch (e) { console.warn('[node-red] 最小化失败:', e); }
}

function nrClose() {
    var win = nrWindow();
    if (!win) return;
    /* 关窗 = 销毁（与浏览器关标签页一致）：未部署的修改会丢 —— 宿主侧据此存几何，
       引擎不受影响（见 main.rs 的 nodered_persist_geometry 与 nodered_kill 的两个时机）。 */
    try { win.close(); } catch (e) { console.warn('[node-red] 关闭失败:', e); }
}

/* ===== 编辑器地址 → iframe ===== */
function nrApplyUrl(url) {
    var f = document.getElementById('nfFrame');
    if (!f || !url) return;
    if (NR_URL === url && f.getAttribute('src')) return;      // 没变就别碰 src（会整页重载）
    NR_URL = url;
    f.setAttribute('src', url);
    nrStatus('正在加载编辑器…');
}

function nrLoadFrame() {
    var f = document.getElementById('nfFrame');
    if (f) {
        f.onload = function () { nrStatus(''); };
        f.onerror = function () { nrStatus('编辑器加载失败（地址：' + NR_URL + '）', true); };
    }
    nrPoll();
}

function nrPoll() {
    nrInvoke('nodered_url').then(function (url) {
        if (url) { NR_TRIES = 0; nrApplyUrl(String(url)); return; }
        NR_TRIES++;
        if (NR_TRIES >= NR_MAX_TRIES) {
            nrStatus('自动化引擎没起来。关掉这个窗口，回到主窗口再点一次 Node-RED 图标。', true);
            return;
        }
        nrStatus('正在等待自动化引擎启动…（首次约 2–5 秒）');
        setTimeout(nrPoll, 1000);
    }).catch(function (e) {
        nrStatus('读取编辑器地址失败：' + ((e && e.message) ? e.message : e), true);
        setTimeout(nrPoll, 2000);
    });
}

/* 引擎重启会换端口：定期问一次，变了才换 src（换 src = 编辑器重载，只在必要时做） */
function nrWatchUrl() {
    setInterval(function () {
        nrInvoke('nodered_url').then(function (url) {
            if (url && String(url) !== NR_URL) nrApplyUrl(String(url));
        }).catch(function () {});
    }, 4000);
}

/* ===== 嵌入态 / 独立态（2026-11 用户定的共存方式：默认贴进主窗口，拖出来就成独立窗口）=====
 *
 * 两种形态是**同一个窗口**（同一个 WebView）：宿主用 Win32 `SetParent` 把它挂进主窗口，
 * 这里只负责按状态切换外观 —— 嵌入时标题栏收成 24px 细拖条、隐藏窗口按钮；独立时恢复整条标题栏。
 * ⚠️ 不要为了"嵌入"去重建页面或换 iframe：那会让编辑器整页重载，未部署的流程就丢了。
 */
function nrApplyDocked(docked) {
    var on = !!docked;
    document.body.classList.toggle('docked', on);
    if (on) nrStatus('');
}

/* 嵌入态把自己**当前尺寸**报给主窗口：用户拖窗口边缘改大小后，主窗口据此记住"占正文区的比例"，
   这样主窗口再缩放时编辑器会按比例跟着缩，而不是留着旧像素尺寸被父窗口裁掉（2026-11 用户报的）。
   ⚠️ 走 `invoke` 让宿主转发（不是页面之间直接 emit）：跨窗口 emit 受 ACL 影响且**静默失败**
   —— 2026-11 实测宽度被拖小之后一直回不来，日志里一条都没有。 */
function nrReportSize() {
    if (!document.body.classList.contains('docked')) return;
    try {
        nrInvoke('nodered_report_size', { width: window.innerWidth, height: window.innerHeight });
    } catch (e) { /* 纯体验优化，失败不影响编辑 */ }
}

function nrUndock() {
    nrInvoke('nodered_dock', { rect: null }).then(function () {
        nrApplyDocked(false);
        nrSyncMaxIcon();
    }).catch(function (e) { console.warn('[node-red] 脱离失败:', e); });
}

/* 「停靠」：把编辑器放回主窗口。矩形只有主窗口知道（分栏是它建的），所以这里发个事件让它来贴。 */
function nrDock() {
    try {
        var t = window.__TAURI__;
        if (t && t.event && typeof t.event.emit === 'function') {
            t.event.emit('nodered-dock-request').catch(function () {});
            return;
        }
    } catch (e) { /* 落到下面的兜底 */ }
    console.warn('[node-red] 没有事件通道，无法请求停靠');
}

/* 嵌入时"把标题条拖出去"= 脱离 + 接着原生拖动（用户说的"拖动独立成窗口"）；
   独立时拖标题条 = 普通窗口拖动。
   ⚠️ 这里**不能用 `data-tauri-drag-region`**（第一版用了，结果嵌入态的拖动被它抢先变成"在父窗口里
   挪一下子窗口"，自定义的脱离逻辑根本收不到 pointermove）。所以两种形态的拖动都由这里接管。
   ⚠️ 拖动阈值取 5px：细拖条只有 26px 高，阈值大了会"明明拖了却没反应"。 */
var NR_DRAG_MIN = 5;

function nrTearOff(screenX, screenY) {
    nrInvoke('nodered_dock', { rect: null }).then(function () {
        nrApplyDocked(false);
        nrSyncMaxIcon();
        /* 系统拖动（把窗口直接交给用户继续拖）。失败就退化成"把窗口摆到鼠标处" ——
           宁可位置不完美，也不能让用户拖了半天什么都没发生。 */
        try {
            nrWindow().startDragging();
        } catch (err) {
            console.warn('[node-red] 系统拖动不可用，改为定位到鼠标处:', err);
            try {
                var s = (window.devicePixelRatio || 1);
                nrWindow().setPosition({ type: 'Physical', x: Math.round((screenX - 40) * s), y: Math.round((screenY - 12) * s) });
            } catch (e2) { /* 尽力而为 */ }
        }
    }).catch(function (err) { console.warn('[node-red] 脱离失败:', err); });
}

function nrBindDragOut() {
    var bar = document.querySelector('.nr-titlebar');
    if (!bar) return;
    var sx = 0, sy = 0, px = 0, py = 0, armed = false, dragging = false;

    function start(e) {
        if (e.button !== 0) return;
        if (e.target && e.target.closest && (e.target.closest('.win-ctrl') || e.target.closest('.nr-dockact'))) return;
        if (!document.body.classList.contains('docked')) {
            /* 独立态：整条标题栏直接交给系统拖（双击标题最大化仍走 dblclick） */
            try { nrWindow().startDragging(); } catch (err) { console.warn('[node-red] 拖动失败:', err); }
            return;
        }
        armed = true; dragging = false;
        sx = e.clientX; sy = e.clientY;
        px = e.screenX; py = e.screenY;
    }

    function move(e) {
        if (!armed || dragging) return;
        px = e.screenX; py = e.screenY;
        if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) < NR_DRAG_MIN) return;
        dragging = true; armed = false;
        nrTearOff(px, py);
    }

    bar.addEventListener('pointerdown', start);
    /* 把手单独也绑一次：它虽然在标题栏里，但显式绑上能挡住"事件被 span 吃掉"这类意外 */
    var grip = document.getElementById('nrGrip');
    if (grip) grip.addEventListener('pointerdown', start);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', function () { armed = false; dragging = false; });
    window.addEventListener('pointercancel', function () { armed = false; dragging = false; });
}

function nrWatchDockState() {
    try {
        var t = window.__TAURI__;
        if (t && t.event && typeof t.event.listen === 'function') {
            t.event.listen('nodered-dock', function (ev) { nrApplyDocked(ev && ev.payload); });
        }
    } catch (e) { /* 没有事件系统就只靠初值 */ }
    nrInvoke('nodered_docked').then(nrApplyDocked).catch(function () {});
}

document.addEventListener('DOMContentLoaded', function () {
    var byId = function (id) { return document.getElementById(id); };
    if (byId('nrMin')) byId('nrMin').addEventListener('click', nrMinimize);
    if (byId('nrMax')) byId('nrMax').addEventListener('click', nrToggleMaximize);
    if (byId('nrClose')) byId('nrClose').addEventListener('click', nrClose);
    if (byId('nrMax')) byId('nrMax').addEventListener('dblclick', function (e) { e.stopPropagation(); });

    /* 双击标题栏 = 最大化/还原（系统窗口的习惯；自绘标题栏必须自己补上） */
    var bar = document.querySelector('.nr-titlebar');
    if (bar) bar.addEventListener('dblclick', function (e) {
        if (e.target && e.target.closest && e.target.closest('.win-ctrl')) return;
        nrToggleMaximize();
    });

    var win = nrWindow();
    if (win && typeof win.onResized === 'function') {
        try { win.onResized(function () { nrSyncMaxIcon(); nrReportSize(); }); } catch (e) { /* 旧版 API 没有就算了 */ }
    }
    window.addEventListener('resize', nrReportSize);
    if (byId('nrUndock')) byId('nrUndock').addEventListener('click', function (e) {
        e.stopPropagation();
        nrUndock();
    });
    if (byId('nrDock')) byId('nrDock').addEventListener('click', function (e) {
        e.stopPropagation();
        nrDock();
    });
    /* 嵌入态的关闭按钮：关的是编辑器窗口本身（流程继续跑）。stopPropagation 必须留着，
       否则事件冒到细拖条上会被当成"拖动开始"。 */
    if (byId('nrCloseInline')) byId('nrCloseInline').addEventListener('click', function (e) {
        e.stopPropagation();
        nrClose();
    });
    nrBindDragOut();
    nrWatchDockState();
    nrSyncMaxIcon();
    nrLoadFrame();
    nrWatchUrl();
});
