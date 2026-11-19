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

/* 挂进这个分栏、藏在工具栏下面：只隐藏 .mon-body，顶部的串口选择那几行留着 */
function nfAttach(mid) {
    var pane = document.getElementById('nodeflow-pane');
    if (!pane) return;
    var host = document.getElementById('pane-' + mid) || document.querySelector('.monitor-pane');
    if (!host) return;
    var body = host.querySelector('.mon-body');
    if (body && body.parentNode === host) {
        host.insertBefore(pane, body);
        body.style.display = 'none';
    }
    pane.style.display = 'flex';
}

/* 收起：画布挪回 body、恢复输出区 */
function nfDetach() {
    var pane = document.getElementById('nodeflow-pane');
    if (!pane) return;
    pane.style.display = 'none';
    if (pane.parentNode !== document.body) document.body.appendChild(pane);
    var bodies = document.querySelectorAll('.monitor-pane > .mon-body');
    for (var i = 0; i < bodies.length; i++) {
        if (bodies[i].style.display === 'none') bodies[i].style.display = '';
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
