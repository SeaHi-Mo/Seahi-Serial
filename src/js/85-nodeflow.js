/* ===== node-red 自动化（独立窗口，默认停靠进主窗口；2026-11） =====
 *
 * ⚠️ 这里**不画任何界面**：窗口里跑的是 Node-RED 本体（Apache-2.0，5.x），
 *    由 Rust 侧车拉起、由 `nodered_open_window` 开成一个**独立窗口**（加载
 *    `http://127.0.0.1:<port>/`，不是 iframe），再按需要 `SetParent` 贴进主窗口正文区。
 *
 * 为什么从"一个分栏里的内嵌画布"改成"独立窗口 + 默认停靠"（用户 2026-11）：
 *   Node-RED 是**全局**工作台（一套流程服务所有分栏），塞进某个分栏就等于"编辑器跟着分栏走"。
 *   用户的原话是"它属于一个全局的界面，不可能跟着分栏一次存在"，同时要求
 *   "编辑流程的同时还能查看窗口数据情况" —— 于是默认贴进正文区，拖出来就是独立窗口。
 *
 * 别做的事：
 *   ① 别再往这个文件里塞画布/节点定义（那套自绘节点 2026-11 已删除）；
 *   ② 别改成 iframe 内嵌（`#nodeflow-pane` 那套覆盖层已整段删除）；
 *   ③ 别在这里停/启引擎（窗口只是编辑器的一张皮，流程由侧车继续跑）；
 *   ④ 嵌入的是**同一个 WebView**（父子窗口），不是第二个窗口 —— 重建页面会丢未部署的流程。
 *
 * 侧车的资源树（打包进安装包）：
 *   resources/node-red/
 *     ├ node.exe                 Node 运行时
 *     ├ settings.js              离线固化配置（禁调色板安装、关遥测）
 *     ├ package.json
 *     └ node_modules/            node-red + 本程序的 at-suite 节点
 */

var NF_OPENING = false;   // 在途闸：`nodered_open_window` 可能要等好几秒（首次拉起侧车）
var NF_LAST_ERROR = '';

/* ===== 自动化发出去的数据也要能在监视窗口看见 =====
 *
 * 宿主把 Node-RED 通过桥写串口的数据用 `nodered-sent` 事件送过来（payload: {monitor, hex}，
 * 见 main.rs 的 bridge_write）。这里只负责呈现，三条口径：
 *   ① **与手动发送完全相同**：走 `appendOutput(mid,'send',…)`，所以输出区、行号、时间戳、
 *      日志中心（`serial:<分栏>:tx`）、MCP 的 serial_get_output 全都照旧；
 *   ② **消息回显关掉就不写**（用户 2026-11 明确要求："除非关闭了消息回显"）——
 *      判据与 sendData 一样是 `#<mid>-btnEcho` 的 `.on`，不另设开关；
 *   ③ 来源标 `auto`（不是 ui、也不是 ai）：它是用户编排的流程发的，复盘时要能区分。
 */
function nfOnSent(payload) {
    var p = payload || {};
    var mid = p.monitor ? String(p.monitor) : 'main';
    var hex = p.hex ? String(p.hex) : '';
    if (!hex || !monitors[mid]) return;
    var echoBtn = document.getElementById(mid + '-btnEcho');
    if (!echoBtn || !echoBtn.classList.contains('on')) return;
    var bytes;
    try { bytes = hexToBytes(hex); } catch (e) { return; }
    if (!bytes.length) return;
    var text = decodeRaw(bytes);
    /* 能当文本读就照原样显示（AT 指令就是这种）；含控制字节时退回 HEX，
       否则二进制帧在输出区等于看不见。 */
    var printable = !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
    appendOutput(mid, 'send', printable ? text : 'HEX: ' + bytesToHex(bytes), { src: 'auto' });
}

/* ===== 顶栏那颗 Node-RED 按钮 =====
 *
 * 用户 2026-11："点击 node red 按钮打开之后的状态，按钮背景用主题色，再次点击即可隐藏窗口"。
 * 用的是项目里既有的 `.add-btn.icon-btn.active`（主题色底 + 白字，随 12 套主题走）。
 *
 * 高亮不靠猜：宿主在 **开 / 隐藏 / 被关掉**（窗口 Destroyed）三种时刻都会发 `nodered-state`，
 * 页面加载时再用 `nodered_window_state` 校正一次 —— 所以用户从编辑器自己的「✕」关掉时，
 * 顶栏按钮也会跟着灭（否则它会一直亮着，看着像"还开着"）。
 */
function nfSetNodeRedBtn(on) {
    var btn = document.getElementById('nodeRedBtn');
    if (btn) btn.classList.toggle('active', !!on);
}

function nfBindNodeRedState() {
    try {
        if (typeof window.__TAURI__ === 'undefined' || !window.__TAURI__.event) return;
        window.__TAURI__.event.listen('nodered-state', function (ev) {
            var st = ev && ev.payload;
            nfSetNodeRedBtn(st === 'open');
        });
    } catch (e) { console.warn('[node-red] 监听窗口状态失败:', e); }
    try {
        invoke('nodered_window_state').then(function (st) {
            nfSetNodeRedBtn(st === 'open');
        }).catch(function () {});
    } catch (e) { /* 老构建没有这条命令，忽略 */ }
}

/* ===== 打开 / 隐藏编辑器窗口 =====
 *
 * 工具栏那颗图标调用的唯一入口。它**不接收分栏 id** —— 编辑器不属于任何分栏：
 *   · 没有 → 拉起侧车再开窗，默认贴进正文区；
 *   · 已开着且嵌着 → 按当前正文区重贴一次；
 *   · 已开着且浮着 → 只抬到前面，**绝不**拽回主窗口；
 *   · 已开着且看得见 → **收起（hide）**，再点一次原样回来（编辑器与未部署的修改都留着）。
 */
function openNodeRed() {
    if (NF_OPENING) return;
    NF_OPENING = true;
    var p;
    try {
        p = invoke('nodered_open_window');
    } catch (e) {
        NF_OPENING = false;
        NF_LAST_ERROR = String(e);
        showToast('打开 Node-RED 失败: ' + e, 'error');
        return;
    }
    Promise.resolve(p).then(function (res) {
        NF_OPENING = false;
        NF_LAST_ERROR = '';
        var state = (res && res.state) || 'open';
        nfSetNodeRedBtn(state === 'open');
        if (state === 'hidden') {
            /* 收起：贴窗循环要停掉（窗口都不显示了，还每 250ms 挪一次没意义） */
            nfStopDockSync();
            return;
        }
        /* 宿主说"别贴"（用户自己拖出去成浮动窗口了）→ 只把它抬到前面，别拽回来 */
        if (res && res.shouldDock === false) return;
        nfDockToPane(true);
        nfStartDockSync();
    }).catch(function (err) {
        NF_OPENING = false;
        var msg = (err && err.message) ? err.message : String(err);
        NF_LAST_ERROR = msg;
        /* 启动失败的原因（缺 node.exe / 端口没起来 / 日志尾巴）必须原样给用户看：
           截断成一句"打开失败"等于把唯一的下手处藏起来。 */
        showToast('打开 Node-RED 失败: ' + msg, 'error');
        console.error('[node-red] 打开窗口失败:', msg);
    });
}

/* ===== 嵌入态：把编辑器窗口贴到监视器正文区 =====
 *
 * 区域由**前端量**（`getBoundingClientRect` 就是相对 WebView 客户区的坐标），宿主只负责
 * `SetParent` + `MoveWindow`。为什么不让宿主猜：分栏是前端动态建的，只有这里知道哪块可见。
 * ⚠️ 嵌入的是**同一个 WebView**（父子窗口），不是 iframe —— 编辑器不会重载，未部署的修改不会丢。
 */
var NF_DOCK_TIMER = null;
var NF_DOCK_IDLE = 0;      // 连续收到「当前不是嵌入态」的次数（够了就停掉定时器）
var NF_MAX_H = 0;          // 正文区满高（CSS px）：宿主拖上边沿时按它夹上限

/* 嵌入区域 = **所有可见分栏的正文区并集**（用户 2026-11："编辑器被分栏了。不应该分栏的"）。
   Node-RED 是全局的，不能被某个分栏的边界切开 —— 只贴第一个 `.mon-body` 会出现"编辑器只占半拉窗口、
   另一栏还露着"的样子。取并集后：多分栏时它横跨整个监视区，分栏之间的分隔线也被盖住。
 */
function nfDockRect() {
    var bodies = document.querySelectorAll('.mon-body');
    var left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (var i = 0; i < bodies.length; i++) {
        var el = bodies[i];
        if (!el || !el.getBoundingClientRect) continue;
        var r = el.getBoundingClientRect();
        /* 只认真的在屏幕上、且够大的那块（隐藏分栏的 rect 是 0×0） */
        if (r.width < 200 || r.height < 150) continue;
        if (!el.offsetParent && el.offsetWidth === 0) continue;
        if (r.left < left) left = r.left;
        if (r.top < top) top = r.top;
        if (r.right > right) right = r.right;
        if (r.bottom > bottom) bottom = r.bottom;
    }
    if (!isFinite(left) || right - left < 200 || bottom - top < 150) return null;
    NF_MAX_H = Math.round(bottom - top);
    /* ⚠️ 这里**不做"矩形没变就不发"的优化**：宿主自己会去重（`NODERED_RECT`），前端再省一次会让
       "主窗口变了、编辑器不动"（实测：缩窗口后编辑器一直保持旧尺寸）。 */
    return {
        x: Math.round(left), y: Math.round(top),
        width: Math.round(right - left), height: NF_MAX_H
    };
}

function nfDockToPane(force) {
    /* force = 明确的"按正文区重贴"（拖回来 / 停靠 / 点图标打开）：宿主会把手动高度也清掉，恢复铺满 */
    var rect = nfDockRect();
    if (!rect) {
        /* 没找到可嵌入的区域（所有分栏都隐藏、或页面正停在不带监视器的页）——
           这时就让它当独立窗口，别硬贴。留一条日志便于排查"为什么没贴进去"。 */
        if (typeof mcpLogPush === 'function') {
            mcpLogPush('ui:sys', 'info', 'none', 'Node-RED 未嵌入：没找到可用的监视器正文区', 0, 'ui');
        }
        return;
    }
    if (typeof mcpLogPush === 'function') {
        mcpLogPush('ui:sys', 'info', 'none', 'Node-RED 嵌入 rect=' + JSON.stringify(rect), 0, 'ui');
    }
    invoke('nodered_dock', { rect: rect, force: !!force, maxH: NF_MAX_H }).then(function () {
        nfStartDockSync();
    }).catch(function (e) {
        /* 贴不进去就让它当普通窗口（别因为"嵌不进去"把编辑器弄没了） */
        console.warn('[node-red] 嵌入失败，保持独立窗口:', (e && e.message) ? e.message : e);
        if (typeof mcpLogPush === 'function') {
            mcpLogPush('ui:err', 'warn', 'none', 'Node-RED 嵌入失败: ' + ((e && e.message) ? e.message : e), 0, 'ui');
        }
    });
}

function nfSyncDock() {
    var rect = nfDockRect();
    if (!rect) return;
    invoke('nodered_dock_sync', { rect: rect, maxH: NF_MAX_H }).then(function (active) {
        /* 宿主说"当前不是嵌入态"（用户把它拖出来了）→ 连着几次都这样就把定时器停了，
           免得一个空转的 250ms IPC 一直陪跑。再次点图标时会重新起。 */
        if (active === false) {
            NF_DOCK_IDLE++;
            if (NF_DOCK_IDLE > 8) nfStopDockSync();
        } else {
            NF_DOCK_IDLE = 0;
        }
    }).catch(function () {});
}

function nfStartDockSync() {
    NF_DOCK_IDLE = 0;
    if (NF_DOCK_TIMER) return;
    /* 250ms 一次：拖窗口、拉分栏、切分栏都能跟手；宿主侧非嵌入态直接返回，开销就是一次 IPC。 */
    NF_DOCK_TIMER = setInterval(nfSyncDock, 250);
    window.addEventListener('resize', nfSyncDock);
}

function nfStopDockSync() {
    if (NF_DOCK_TIMER) {
        clearInterval(NF_DOCK_TIMER);
        NF_DOCK_TIMER = null;
    }
    window.removeEventListener('resize', nfSyncDock);
}

/* 宿主把浮动窗口拖回主窗口范围时（Moved 停下 600ms 且中心落在主窗口里）会发这个事件 ——
   用户 2026-11："脱离之后也要拖动回归程序"。矩形只能前端算（分栏是前端建的），所以这一跳走事件。 */
function nfBindDockRequest() {
    try {
        if (typeof window.__TAURI__ === 'undefined' || !window.__TAURI__.event) return;
        window.__TAURI__.event.listen('nodered-dock-request', function () {
            nfShowDockHint(false);
            /* 用户主动把它拖回来 / 点「停靠」= 明确的"按正文区重贴"意图 → force */
            nfDockToPane(true);
            nfStartDockSync();
        });
        /* 拖动中的"可以停靠"蒙版（用户 2026-11：拖回来时程序里什么都没有，不知道能不能放） */
        window.__TAURI__.event.listen('nodered-drag-hover', function (ev) {
            nfShowDockHint(!!(ev && ev.payload));
        });
    } catch (e) { console.warn('[node-red] 监听停靠请求失败:', e); }
}

/* ===== 可停靠蒙版 =====
 *
 * 浮动窗口被拖到主窗口上方时，在**分栏正文区**画一块淡色蒙版 + 一行提示，告诉用户"松手就停在这儿"。
 * 三条：① `pointer-events:none`（绝不能挡住拖动落点或点击）；② 只在"离开过主窗口"之后才亮
 * （与归位判据同一套，免得刚拖出来就亮）；③ 嵌入成功 / 拖走 / 关窗都要收（宿主那边会发 false）。
 * ⚠️ **不要边框**（用户 2026-11："虚线完全是多余的"）。
 */
var NF_HINT_EL = null;

function nfDockHintEl() {
    if (NF_HINT_EL && NF_HINT_EL.parentNode) return NF_HINT_EL;
    var d = document.createElement('div');
    d.id = 'nfDockHint';
    d.setAttribute('aria-hidden', 'true');
    d.style.cssText = [
        'position:fixed', 'z-index:9998', 'pointer-events:none', 'display:none',
        'box-sizing:border-box',
        /* 只留淡色蒙版 + 一行字：**不要边框**。没有边框以后填充要稍微实一点，
           否则整块蒙版看不出来（0.16 实测太淡）。 */
        'background:rgba(74,122,181,.24)', 'border-radius:6px',
        'color:var(--text)', 'font-size:13px',
        /* 文字贴**顶部**居中：拖动时浮动窗口盖住的是中间和下面，放中间会被挡住看不见 */
        'align-items:flex-start', 'justify-content:center', 'text-align:center',
        'padding-top:10px', 'text-shadow:0 1px 2px rgba(0,0,0,.45)'
    ].join(';');
    d.textContent = '松开鼠标：把编辑器停靠到这里';
    document.body.appendChild(d);
    NF_HINT_EL = d;
    return d;
}

function nfShowDockHint(show) {
    var el = nfDockHintEl();
    if (!show) { el.style.display = 'none'; return; }
    var r = nfDockRect();
    if (!r) { el.style.display = 'none'; return; }
    el.style.left = r.x + 'px';
    el.style.top = r.y + 'px';
    el.style.width = r.width + 'px';
    el.style.height = r.height + 'px';
    el.style.display = 'flex';
}

/* 85-nodeflow.js 在 <script> 里同步执行，那时 DOM 还没就绪 —— 监听器只是挂 Tauri 事件，
   不碰 DOM，所以可以直接在文件末尾调；失败也不影响打开编辑器。 */
nfBindDockRequest();
/* 顶栏按钮的高亮要跟宿主同步：开/隐藏/被关掉时都靠 nodered-state 事件校正 */
nfBindNodeRedState();
