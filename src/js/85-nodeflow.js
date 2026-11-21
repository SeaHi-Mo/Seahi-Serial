/* ===== node-red 自动化（内嵌**真** Node-RED） =====
 *
 * ⚠️ 这里的画布不是我画的。窗口里跑的是 Node-RED 本体（Apache-2.0，5.x），
 *    由 Rust 侧车拉起：`src-tauri/src/main.rs` 的 `nodered_open`。
 *    前端只做三件事 —— 调后端拿地址、把 iframe 指过去、出错时说清原因。
 *
 * 为什么不再自己画：用户 2026-11 明确要求"用成熟的，不要我再次开发"。
 * 之前那套自绘节点（节点/连线/属性全是自造的，没有任何执行层）已经作废，
 * 别再往这个文件里塞节点定义或画布逻辑。
 *
 * 侧车的资源树（打包进安装包）：
 *   resources/node-red/
 *     ├ node.exe                 Node 运行时
 *     ├ settings.js              离线固化配置（禁调色板安装、关遥测）
 *     ├ package.json
 *     └ node_modules/            node-red + 本程序的 at-suite 节点
 */

var NF_URL = '';
var NF_BUILT = false;
var NF_MID = null;
var NF_BODY = null;      // 被画布盖住、需要恢复的 .mon-body
var NF_RO = null;        // 跟随分栏尺寸变化
var NF_PLACE_BOUND = false;

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

/* ---------- 入口 ---------- */
function openNodeFlow(mid) {
    var pane = document.getElementById('nodeflow-pane');
    if (!pane) return;

    // 已经开在这个分栏里 → 再点一次收起（工具栏上那颗图标就是个开关）
    if (pane.style.display === 'flex' && NF_MID === mid) {
        closeNodeFlow();
        return;
    }

    ['wsl-pane', 'adb-pane', 'ble-pane'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    var pc = document.getElementById('paneContainer');
    if (pc) pc.style.display = 'flex';

    nfAttach(mid);
    NF_MID = mid;

    if (!NF_BUILT) {
        nfBuildUi(pane);
        NF_BUILT = true;
    }
    nfStart();
}

/* 覆盖到分栏的正文区（工具栏与发送栏之间）。
 *
 * ⚠️ 这里**绝不能把 iframe / #nodeflow-pane 搬到别的 DOM 节点下面**：iframe 一旦被
 *    reparent，浏览器就会重建浏览上下文 —— 编辑器重新加载，画布里**还没部署**的
 *    修改（比如刚删掉的流程页签）会从 flows.json 里原样回来。2026-11 的用户 bug
 *    「删除的流程重新打开后还在」就是它。
 *    正确做法：pane 永远留在 body 下，用 position:absolute 盖在正文区上。 */
function nfPlace() {
    var pane = document.getElementById('nodeflow-pane');
    if (!pane || pane.style.display !== 'flex' || !NF_MID) return;
    var host = document.getElementById('pane-' + NF_MID) || document.querySelector('.monitor-pane');
    if (!host) return;
    var hr = host.getBoundingClientRect();
    var tb = host.querySelector('.toolbar-wrap');
    var sb = host.querySelector('.send-bar');
    var top = tb ? tb.getBoundingClientRect().bottom : hr.top;
    var bottom = sb ? sb.getBoundingClientRect().top : hr.bottom;
    if (bottom <= top) bottom = hr.bottom;
    pane.style.left = Math.round(hr.left + window.scrollX) + 'px';
    pane.style.top = Math.round(top + window.scrollY) + 'px';
    pane.style.width = Math.round(hr.width) + 'px';
    pane.style.height = Math.max(0, Math.round(bottom - top)) + 'px';
}

/* 挂到这个分栏的正文区：只隐藏 .mon-body，pane 本身不移动 */
function nfAttach(mid) {
    var pane = document.getElementById('nodeflow-pane');
    if (!pane) return;
    var host = document.getElementById('pane-' + mid) || document.querySelector('.monitor-pane');
    if (!host) return;
    var body = host.querySelector('.mon-body');
    NF_MID = mid;
    if (body && body !== NF_BODY) {
        if (NF_BODY) NF_BODY.style.display = '';
        NF_BODY = body;
        body.style.display = 'none';
    }
    pane.style.display = 'flex';
    nfPlace();

    if (!NF_PLACE_BOUND) {
        NF_PLACE_BOUND = true;
        window.addEventListener('resize', nfPlace);
        window.addEventListener('scroll', nfPlace, true);
        if (window.ResizeObserver) {
            NF_RO = new ResizeObserver(nfPlace);
            NF_RO.observe(host);
        }
    } else if (NF_RO && window.ResizeObserver) {
        NF_RO.disconnect();
        NF_RO = new ResizeObserver(nfPlace);
        NF_RO.observe(host);
    }
}

/* 收起：只隐藏 pane、恢复正文，不移动 iframe（保住编辑器里未部署的状态） */
function nfDetach() {
    var pane = document.getElementById('nodeflow-pane');
    if (!pane) return;
    pane.style.display = 'none';
    if (NF_BODY) {
        NF_BODY.style.display = '';
        NF_BODY = null;
    }
    if (NF_RO) { NF_RO.disconnect(); NF_RO = null; }
    if (NF_PLACE_BOUND) {
        window.removeEventListener('resize', nfPlace);
        window.removeEventListener('scroll', nfPlace, true);
        NF_PLACE_BOUND = false;
    }
}

function closeNodeFlow() {
    nfDetach();
    NF_MID = null;
    var m = document.getElementById('paneContainer');
    if (m) m.style.display = 'flex';
    if (typeof refreshMonitorPollRates === 'function') refreshMonitorPollRates();
    /* ⚠️ 这里**不停 node-red**：它是自动化引擎，流程要在界面关掉后继续跑。
       停它只有两个时机：应用退出（Rust 侧 CloseRequested）和用户点「重启」。 */
}

/* 注：原来这里有个 nfRestart()（停 sidecar 再起）。
   界面上的按钮撤掉后没有调用方了 —— 引擎随应用启动、关界面不停，
   要"重启引擎"只有两种真实需求：改了 settings、装了新节点，两者都要动安装目录，
   重开应用即可覆盖。留着这个函数只会变成没人调的死代码。 */

/* 别的整页页面要打开时先把画布收起来 */
function nfHidePane() {
    nfDetach();
    NF_MID = null;
}

/* ---------- 界面 ---------- */
function nfBuildUi(pane) {
    // 容器全部去掉：这里只有 iframe 和加载/错误遮罩。
    // 打开/收起由工具栏那颗 Node-RED 图标负责（openNodeFlow 在同一分栏再点一次即收起）。
    pane.innerHTML =
        '<iframe id="nfFrame" class="nf-frame" title="node-red 编辑器" ' +
            'referrerpolicy="no-referrer" allow="clipboard-read; clipboard-write"></iframe>' +
        '<div class="nf-mask" id="nfMask"></div>';
}

function nfShowState(text, isErr) {
    var m = document.getElementById('nfMask');
    if (!m) return;
    if (!text) { m.style.display = 'none'; m.textContent = ''; return; }
    m.style.display = 'flex';
    m.textContent = text;
    m.className = 'nf-mask' + (isErr ? ' err' : '');
}

/* ---------- 启停 ---------- */
function nfStart() {
    var f = document.getElementById('nfFrame');
    if (!f) return;

    /* 已经加载过就直接亮出来：**不要重设 src**。
       重设等于让浏览器把整个编辑器重新加载一遍 —— 那就是"每次打开都白闪"的来源。 */
    if (NF_URL && f.getAttribute('src') === NF_URL && f.getAttribute('data-loaded') === '1') {
        f.classList.add('ready');
        nfShowState('', false);
        return;
    }

    nfShowState('正在启动内置 node-red…（首次启动约 2–5 秒）', false);
    var p;
    try {
        p = invoke('nodered_open');
    } catch (e) {
        nfShowState('调不到后端：' + e, true);
        return;
    }
    Promise.resolve(p).then(function (url) {
        NF_URL = String(url || '');
        if (f.getAttribute('src') === NF_URL && f.getAttribute('data-loaded') === '1') {
            f.classList.add('ready');
            nfShowState('', false);
            return;
        }
        f.classList.remove('ready');
        f.setAttribute('data-loaded', '0');
        f.onload = function () {
            f.setAttribute('data-loaded', '1');
            f.classList.add('ready');
            nfShowState('', false);
        };
        f.src = NF_URL;

        /* 兜底：iframe 被响应头拦住时 onload 可能永远不触发，别让用户对着"正在启动"干等 */
        setTimeout(function () {
            if (f.getAttribute('data-loaded') !== '1') {
                nfShowState('编辑器迟迟没加载出来。\n如果一直停在这里，说明嵌入被拦了 —— 地址是：\n' + NF_URL, true);
            }
        }, 12000);
    }).catch(function (err) {
        var msg = (err && err.message) ? err.message : String(err);
        nfShowState('启动失败：' + msg, true);
    });
}
