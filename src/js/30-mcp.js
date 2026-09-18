/* 30-mcp.js —— 前端第 4 块，拆自原单文件 src/index.html（**纯搬家**；行号映射见 doc/FRONTEND_LAYOUT.md）。
   ⚠️ **普通脚本**（不是 ESM）：按 index.html 里的 <script src> 顺序加载、共享同一个全局作用域 —— 行内 onclick
   与现有函数互相调用照旧；**别改成 type="module"**（模块作用域会让它们全部失效）。 */
/* ===== MCP 服务器入口（标题栏图标 + 弹窗）=====
 * 服务器本身跑在 Rust 侧（进程内、只监听回环、同时提供 Streamable HTTP 与遗留 SSE）；
 * 这里只负责开关、展示两种连接地址与"安装提示词"，并把状态点画出来。
 * 所有状态都来自后端 mcp_status，前端不自己猜。 */
var _mcpStatus = null;
var _mcpConfig = null;
// 正在发 mcp_set_enabled 的那一小会儿：按钮要禁用，否则连点会陆续发出两条相反的 IPC
var _mcpBusy = false;
// 同上，只读模式那颗按钮自己的在途标志。**必须独立一份**：共用一个标志的话，
// 一边在处理中会把另一颗按钮也连带置灰（两个开关本来就是互不相干的命令）。
var _mcpReadOnlyBusy = false;
// 同上，传输档位（both / http / sse）自己的在途标志（同理：不能与上两个共用）
var _mcpTransportBusy = false;
// 在途期间用户点了哪一档：用来**立刻**把高亮画过去（反馈要快），
// 后端状态回来后由 renderMcpStatus 统一覆盖。失败时就清掉，回到真实状态。
var _mcpTransportCur = null;

/* MCP 弹窗顶栏控件的悬停说明：**停顿一下才显示**，且显示在下方那块常驻说明区里（能换行）。
 *
 * 为什么不用原生 `title`（用户两张截图指出）：
 *   ① 它"鼠标一扫就弹"，鼠标划过一排按钮时会一闪一闪；
 *   ② 它一行铺开不换行，长说明横跨整个窗口；
 *   ③ 它还会被控件注册表当成 label 抄给 AI —— `mcpMakeEntry` 读的是 `title || aria-label`，
 *      于是 AI 看到的"控件名"是一整句话（所以这几个控件现在只留简短的 `aria-label`）。
 * 说明放 `data-mcp-tip`（文案里的换行用 `&#10;`，配合 CSS 的 `white-space:pre-line`）。 */
var _mcpTipTimer = null;
var _mcpTipBound = false;
function mcpTipBind() {
    if (_mcpTipBound) return; // 弹窗是常驻 DOM，重复绑定会挂上一堆计时器
    var row = document.getElementById('mcpTipRow');
    if (!row) return;
    _mcpTipBound = true;
    // 停顿多久才显示：鼠标只是"路过"时什么都不要闪，停住看了才给说明
    var TIP_DELAY_MS = 450;
    var clear = function() {
        if (_mcpTipTimer) { clearTimeout(_mcpTipTimer); _mcpTipTimer = null; }
        row.textContent = '';
        // 用 className 而不是 classList：断言集里的假 DOM 只有 className
        row.className = 'mcp-tip';
    };
    var show = function(el) {
        var tip = el.getAttribute && el.getAttribute('data-mcp-tip');
        if (!tip) return;
        row.textContent = tip;
        row.className = 'mcp-tip show';
    };
    ['mcpToggleBtn', 'mcpTransportSel', 'mcpReadOnlyBtn', 'mcpResetTokenBtn'].forEach(function(id) {
        var el = document.getElementById(id);
        if (!el || !el.addEventListener) return;
        el.addEventListener('mouseenter', function() {
            if (_mcpTipTimer) clearTimeout(_mcpTipTimer);
            _mcpTipTimer = setTimeout(function() { _mcpTipTimer = null; show(el); }, TIP_DELAY_MS);
        });
        el.addEventListener('mouseleave', clear);
        // 键盘 Tab 过去也要能看到（无障碍）；focus 不延迟 —— 那是明确的意图
        el.addEventListener('focus', function() { show(el); });
        el.addEventListener('blur', clear);
    });
}

function openMcpModal() {
    var m = document.getElementById('mcpModal');
    if (!m) return;
    mcpTipBind();
    // 别把上次留下的说明挂在上面（弹窗是常驻 DOM，关了再开还在）
    var tip = document.getElementById('mcpTipRow');
    if (tip) { tip.textContent = ''; tip.className = 'mcp-tip'; }
    m.classList.add('show');
    refreshMcpStatus();
}
function closeMcpModal() {
    var m = document.getElementById('mcpModal');
    if (m) m.classList.remove('show');
}
var _mcpPressOnMask = false;
function mcpMaskPress(e) { _mcpPressOnMask = !!(e.target && e.target.id === 'mcpModal'); }
function mcpMaskClick(e) {
    if (_mcpPressOnMask && e.target && e.target.id === 'mcpModal') closeMcpModal();
    _mcpPressOnMask = false;
}

function _mcpDotClass(st) {
    if (!st) return 'mcp-dot';
    if (!st.running) return st.lastError ? 'mcp-dot err' : 'mcp-dot';
    return st.sessions > 0 ? 'mcp-dot live' : 'mcp-dot on';
}

function renderMcpStatus(st) {
    var cls = _mcpDotClass(st);
    ['mcpDot', 'mcpModalDot'].forEach(function(id) {
        var d = document.getElementById(id);
        if (d) d.className = cls;
    });
    var running = !!(st && st.running);
    var btn = document.getElementById('mcpBtn');
    if (btn) {
        btn.title = !st ? 'MCP 服务器：点开可让本机 AI 客户端操作本程序'
            : (running ? ('MCP 服务器：监听 ' + st.host + ':' + st.port + '（' + st.sessions + ' 个会话）· 点开查看连接地址')
                       : 'MCP 服务器：已关闭 · 点开可让本机 AI 客户端操作本程序');
    }
    var stText = document.getElementById('mcpStateText');
    if (stText) {
        stText.textContent = !st ? '未知'
            : (running ? ('监听中 · ' + st.host + ':' + st.port + ' · ' + st.sessions + ' 个会话')
                       : '已关闭');
    }
    // 一个按钮：点一下开、再点一下关（用户改的决定，原来那两个"启用/关闭"并排按钮已删）。
    // 文案写的是"**点了会发生什么**"，这样不用先看状态点就知道当前处于哪一端。
    // 正在发送命令的那一小会儿要禁用，否则连点两下会陆续发两条相反的 IPC。
    var tg = document.getElementById('mcpToggleBtn');
    if (tg) {
        tg.disabled = !!_mcpBusy;
        tg.textContent = running ? '关闭 MCP 服务器' : '启用 MCP 服务器';
        // 说明走 `data-mcp-tip`（延迟显示在下方说明区里），**不写 title**：
        // 原生 title 会一闪一闪，还会被控件注册表当成 label 抄给 AI。
        tg.setAttribute('data-mcp-tip', running
            ? '关闭 MCP 服务器 —— 释放端口，并清空日志中心的内存。'
            : '开启 MCP 服务器 —— 只监听本机 127.0.0.1，让 AI 客户端连上本程序。');
    }
    var tgh = document.getElementById('mcpToggleHint');
    if (tgh) {
        // 只在命令在途时给一行反馈；**运行时不写任何提示**（用户 2026-09-16 要求删掉"点按钮可停止"）。
        // 元素留着是因为在途的"处理中…"是这颗按钮唯一的文字反馈（它的文案在途时不改，只置灰）。
        tgh.textContent = _mcpBusy ? '处理中…' : '';
    }

    var box = document.getElementById('mcpOnBox');
    if (box) box.style.display = running ? 'block' : 'none';

    // 只读（沙箱）模式：文案写"当前处于哪一端 + 打开会发生什么"。
    // 这个开关**必须在界面上**：只读模式下 AI 连 mcp_config_set 都会被拒（故意的，
    // 否则它自己能把自己放出来），所以关掉它的唯一入口就是这里。
    var ro = document.getElementById('mcpReadOnlyBtn');
    if (ro) {
        var on = !!(st && st.readOnly);
        // 处理中要禁用（连点两下会陆续发出两条相反的 IPC），**但处理完必须放回来**。
        // 这里漏掉 `ro.disabled = false` 就是一类真实故障（2026-09 用户报"只读模式开了之后
        // 无法关闭"）：点一下开启 → 按钮被置灰 → 状态回来时只改了文案、没解禁，
        // 于是这颗"关它的唯一入口"永远点不动，只能重启应用（或手改 ai-config.json）。
        // 所以禁用态**只认 `_mcpReadOnlyBusy`**，与 mcpToggleBtn 的 `_mcpBusy` 同一套口径。
        ro.disabled = !!_mcpReadOnlyBusy;
        // 文案**固定**「只读模式」，状态只写在悬停说明里（用户 2026-09-16 要求：
        // 不要"只读模式：开（AI 只能看）"这种把状态塞进按钮文字的写法 —— 那一栏还要放下
        // 传输下拉框，文案越长越挤）。
        ro.textContent = '只读模式';
        // 状态与解释都进说明区（`data-mcp-tip`），**不写 title** —— 同上：title 会闪、
        // 而且会被注册表当成控件的 label 抄给 AI。
        ro.setAttribute('data-mcp-tip', _mcpReadOnlyBusy ? '处理中…'
            : (on ? '只读模式：开 —— AI 只能看。写操作一律被拒（错误码 -32007），界面与配置文件一个字都不变。点一下放开设限。'
                  : '只读模式：关 —— AI 可以改界面、发串口。点一下打开只读模式（AI 只能看，写操作全被拒）。'));
    }
    // 传输形态**下拉框**（`http` / `sse` / `both`，界面显示 HTTP / SSE / All）。
    // 只有被选中的传输才展示连接方式 —— 一屏同时摆两套地址+两份配置，用户不知道该复制哪份。
    // 在途时先用用户选的那个画（反馈要快），状态回来后由这里统一覆盖；
    // 失败时 `_mcpTransportCur` 会被清掉，于是这一句把下拉框**拨回真实值**。
    var shownTransport = _mcpTransportCur || (st && st.transport) || 'both';
    var sel = document.getElementById('mcpTransportSel');
    if (sel) {
        sel.disabled = !!_mcpTransportBusy;
        sel.value = shownTransport;
    }
    // 只展示当前档**确实提供**的连接方式
    var httpField = document.getElementById('mcpStreamableField');
    if (httpField) httpField.style.display = (shownTransport === 'sse') ? 'none' : 'block';
    var sseField = document.getElementById('mcpSseField');
    if (sseField) sseField.style.display = (shownTransport === 'http') ? 'none' : 'block';

    // 原来底部那行"版本 · 工具 · 请求 · 丢弃 · 发现文件"按用户要求删掉了；
    // 这些数字仍然有用（排查时想知道丢了多少条），所以挪到状态文案的悬停提示里，
    // 界面上不再占一行。
    if (stText && st) {
        var parts = ['版本 ' + st.version, '工具 ' + st.toolCount + ' 个',
                     '请求 ' + st.requests, '丢弃 ' + st.dropped];
        if (st.endpointFile) parts.push('发现文件 ' + st.endpointFile);
        stText.title = parts.join(' · ');
    } else if (stText) {
        stText.title = '';
    }
    var err = document.getElementById('mcpError');
    if (err) {
        if (st && st.lastError) {
            err.style.display = 'block';
            err.textContent = '上次错误：' + st.lastError;
        } else {
            err.style.display = 'none';
            err.textContent = '';
        }
    }
}

function renderMcpConfig(cfg) {
    var urlEl = document.getElementById('mcpUrl');
    if (urlEl) urlEl.textContent = (cfg && cfg.url) || (_mcpStatus && _mcpStatus.url) || '';
    var sEl = document.getElementById('mcpStreamableUrl');
    if (sEl) sEl.textContent = (cfg && cfg.streamableUrl) || (_mcpStatus && _mcpStatus.streamableUrl) || '';
    var c = document.getElementById('mcpClientCfg');
    if (c) c.textContent = (cfg && cfg.clientConfig) || '';
    var cs = document.getElementById('mcpClientCfgStreamable');
    if (cs) {
        // 各家客户端对 http 传输的类型名不统一（`http` / `streamableHttp`）。猜错的代价是
        // 客户端**静默**按遗留 SSE 解析 → 一句没头没尾的连不上，所以这里明确写一句提示。
        var alt = (cfg && cfg.clientConfigStreamableAlias) || '';
        var note = alt
            ? '\n\n（若该客户端不认 "type":"http"，就把这一行改成 "type":"streamableHttp" —— Cline 等属于这种）'
            : '';
        cs.textContent = ((cfg && cfg.clientConfigStreamable) || '') + note;
    }
    var p = document.getElementById('mcpPrompt');
    if (p) p.textContent = (cfg && cfg.installPrompt) || '';
}

function refreshMcpStatus() {
    invoke('mcp_status').then(function(st) {
        _mcpStatus = st;
        renderMcpStatus(st);
        if (st && st.running) {
            invoke('mcp_client_config').then(function(cfg) {
                _mcpConfig = cfg;
                renderMcpConfig(cfg);
            }).catch(function() { renderMcpConfig(null); });
        } else {
            _mcpConfig = null;
            renderMcpConfig(null);
        }
    }).catch(function(e) {
        renderMcpStatus({ running: false, lastError: String(e) });
    });
}

function mcpToggleReadOnly() {
    if (_mcpReadOnlyBusy) return;
    var next = !(_mcpStatus && _mcpStatus.readOnly);
    // 与 mcpToggleEnabled 一样：先自己置灰挡住连点，**回来后由 renderMcpStatus 统一解禁**
    // （禁用态的唯一来源是 _mcpReadOnlyBusy，不在这里写死 true 之后就不管了）。
    _mcpReadOnlyBusy = true;
    renderMcpStatus(_mcpStatus);
    invoke('mcp_set_read_only', { enabled: next }).then(function(st) {
        _mcpReadOnlyBusy = false;
        _mcpStatus = st;
        renderMcpStatus(st);
        showToast(next ? '已开启只读模式：AI 只能读，写操作会被拒' : '已关闭只读模式：AI 可以改界面/发串口了', 'info');
    }).catch(function(e) {
        _mcpReadOnlyBusy = false;
        showToast('只读模式切换失败: ' + e, 'error');
        refreshMcpStatus();
    });
}

/* 传输形态：下拉框选 HTTP / SSE / All（值分别是 http / sse / both）。
 *
 * 切换**立即生效**（后端路由每次请求都读配置），所以选单档时另一条传输会立刻变成 404 ——
 * 三个选项各自的后果写在 select 的悬停说明里，切完还有一条 toast 说明结果。 */
function mcpTransportPicked(mode) {
    if (_mcpTransportBusy) {
        // 在途时又拨了一下：按真实状态画回去，别让下拉框停在"没生效的值"上
        renderMcpStatus(_mcpStatus);
        return;
    }
    var cur = (_mcpStatus && _mcpStatus.transport) || 'both';
    // 选到当前档 = 什么都不做：别白写一次盘、也别白发一次 IPC
    if (cur === mode) return;
    // 与 mcpToggleReadOnly 同一套：**禁用态的唯一来源就是 _mcpTransportBusy**，
    // 回来后由 renderMcpStatus 统一解禁（漏掉解禁 = 这个下拉框再也动不了）
    _mcpTransportBusy = true;
    _mcpTransportCur = mode; // 先画选中态（反馈要快）
    renderMcpStatus(_mcpStatus);
    invoke('mcp_set_transport', { transport: mode }).then(function(st) {
        _mcpTransportBusy = false;
        _mcpTransportCur = null;
        _mcpStatus = st;
        renderMcpStatus(st);
        // 地址区块要跟着刷新（换档会换掉展示的连接方式）
        refreshMcpStatus();
        showToast(mode === 'both' ? '两条传输都在提供：老客户端走 /sse、新客户端走 /mcp'
            : mode === 'http' ? '只提供 Streamable HTTP：/mcp 可用，/sse 与 /messages 已变成 404'
                              : '只提供遗留 SSE：/sse 可用，/mcp 已变成 404', 'info');
    }).catch(function(e) {
        _mcpTransportBusy = false;
        _mcpTransportCur = null; // 失败就回到真实状态（下拉框会被拨回去）
        renderMcpStatus(_mcpStatus);
        showToast('传输切换失败: ' + e, 'error');
    });
}

function mcpSetEnabled(on) {
    _mcpBusy = true;
    renderMcpStatus(_mcpStatus); // 立刻把按钮置灰（"处理中…"），挡住连点
    invoke('mcp_set_enabled', { enabled: !!on }).then(function(st) {
        _mcpBusy = false;
        _mcpStatus = st;
        renderMcpStatus(st);
        refreshMcpStatus();
    }).catch(function(e) {
        _mcpBusy = false;
        showToast('MCP 操作失败: ' + e, 'error');
        refreshMcpStatus();
    });
}

/** 一个按钮：点一下开、再点一下关。以最近一次状态为准，不靠界面猜。 */
function mcpToggleEnabled() {
    if (_mcpBusy) return;
    var running = !!(_mcpStatus && _mcpStatus.running);
    mcpSetEnabled(!running);
}

function mcpResetToken() {
    invoke('mcp_reset_token').then(function() {
        showToast('已重置令牌；旧令牌立即失效，请重新复制客户端配置', 'info');
        refreshMcpStatus();
    }).catch(function(e) { showToast('重置令牌失败: ' + e, 'error'); });
}

function mcpCopy(kind, btn) {
    var text = '';
    if (kind === 'url') text = (_mcpStatus && _mcpStatus.url) || '';
    else if (kind === 'streamableUrl') text = (_mcpStatus && _mcpStatus.streamableUrl) || '';
    else if (kind === 'clientConfig') text = (_mcpConfig && _mcpConfig.clientConfig) || '';
    else if (kind === 'clientConfigStreamable') text = (_mcpConfig && _mcpConfig.clientConfigStreamable) || '';
    else if (kind === 'installPrompt') text = (_mcpConfig && _mcpConfig.installPrompt) || '';
    if (!text) { showToast('没有可复制的内容（服务器未启用，或这条传输已被关闭）', 'error'); return; }
    writeClipboard(text).then(function(ok) {
        if (!ok) { showToast('复制失败', 'error'); return; }
        if (btn) {
            var old = btn.textContent;
            btn.textContent = '已复制';
            setTimeout(function() { btn.textContent = old; }, 1200);
        } else {
            showToast('已复制', 'info');
        }
    });
}

/* ===== MCP 控件注册表（S4）=====
 * 把界面上的可交互控件变成"有稳定路径"的条目，供 MCP 的 ui_* 工具枚举与操作。
 *
 * 为什么不能靠选择器寻址：实测 230 个可交互元素里只有 83 个（36.1%）有 id，
 * 77 个是 class-only 且在同一个容器里重复出现（比如 .ibtn-group 里 5 个 .ibtn 只有 4 个带 id）。
 * 所以做法是 **boot 时给每个控件注入 data-mcp 属性**当唯一锚点，之后只需要 [data-mcp="…"]。
 *
 * 路径形如 <panel>.<group>.<name>，例如：
 *   serial.conn.portSelect / serial.toolbar.btnSend / ble.scan.secs / global.theme.dark
 * 路径一旦发布**只增不改**（AI 提示词与用户脚本会依赖它）。
 */
var MCP_SELECTOR = 'button, input, select, textarea, [onclick], [role="tab"]';
/* 危险动作在界面上的**另一个入口**：这些控件带 `data-mcp-skip`，注册表**不收**它们 ——
   否则 AI 用 `ui_click` 点一下就能绕过确认门（危险门按**工具名**判，而 `ui_click` 不是危险工具）。
   ⚠️ **加新的危险按钮时先问一句"它有没有专用工具"**：有 → 加 `data-mcp-skip` 并登记到下面这张表；
   没有 → 别 skip（那等于把 AI 唯一的路也堵了），先补一个带确认门的工具。
   这张表的 key 必须与 Rust `DANGER_TOOLS` **完全一致**（断言守着：不漏、不虚）。 */
var MCP_DANGER_CONTROLS = {
    serial_workflow_run: 'wf-run-btn',      // 工作流每条规则那颗「运行/停止」
};
/* 危险动作里**界面上本来就没有可点入口**的那些（显式列出来，免得"漏了一个"和"本来就没有"分不清）：
   - adb_open_shell：设备卡片是 `div` + addEventListener，**不在 MCP_SELECTOR 里**，通用桥本来就点不到；
   - adb_shell_write：终端输入走 xterm 自己的 keydown/composition，往它的 textarea 写值不会执行 ——
     真正的执行路径只有 `adb_shell_write` 这个工具。 */
var MCP_DANGER_NO_UI = {
    adb_open_shell: '设备卡片是 div + addEventListener，不在 MCP_SELECTOR 里',
    adb_shell_write: '终端输入走 xterm 自己的 keydown，注册表写 textarea 不会执行',
};
var MCP_REGISTRY = {};        // path -> entry
var MCP_REGISTRY_LIST = [];   // 按文档序（列表与分页都基于它）
var _mcpRegistrySig = -1;     // 用于判断 DOM 是否变了（懒重建）

/// 名称清洗：只留 [A-Za-z0-9_]，保证路径可预测
function mcpSlug(s) {
    var out = String(s == null ? '' : s).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return out || 'x';
}

/// 把监视器 id 映射到面板名
function mcpPanelOfMid(mid) {
    if (!mid) return 'global';
    if (mid === 'main' || /^extra-\d+$/.test(mid)) return 'serial';
    if (mid === 'wsl' || /^wsl-x\d+$/.test(mid)) return 'wsl';
    if (mid === 'ble-mon') return 'ble';
    return 'global';
}

/// 控件所在的容器 → 面板。沿 parentNode 上溯而不是用 closest()，便于无头测试。
function mcpPanelOfNode(el) {
    var n = el;
    while (n) {
        var id = n.id || '';
        if (id === 'globalBar') return 'global';
        if (id === 'mcpModal') return 'mcp';
        if (id === 'bleWriteModal' || id === 'blePairModal') return 'dialog';
        if (id === 'wsl-map-approval-overlay') return 'dialog';
        if (id === 'ble-pane') return 'ble';
        if (id === 'wsl-pane') return 'wsl';
        if (id === 'adb-pane') return 'adb';
        if (id === 'paneContainer') return 'serial';
        if (typeof n.className === 'string' && n.className.indexOf('ble-modal-mask') >= 0) return 'dialog';
        n = n.parentNode;
    }
    return 'global';
}

/// 监视器内的字段名 → 分组（写死一张表，比按 class 猜稳定）
var MCP_GROUP_BY_FIELD = {
    // 监视器头部的连接栏：端口 / 波特率 / 行尾 / 数据位 / 校验 / DTR / RTS / 文本·HEX / 开始
    portSelect: 'conn', baudRate: 'conn', lineEnding: 'conn', viewMode: 'conn',
    dataBits: 'conn', stopBits: 'conn', parity: 'conn', chkDTR: 'conn', chkRTS: 'conn', btnStart: 'conn',
    btnSend: 'send', sendInput: 'send', sendAs: 'send',
    btnScroll: 'toolbar', btnAutoReconnect: 'toolbar', btnSendLE: 'toolbar',
    btnTs: 'toolbar', btnEcho: 'toolbar', btnLineNum: 'toolbar',
    advRow: 'adv', advWf: 'adv', advBtn: 'adv'
};
function mcpGroupOfField(field) {
    if (MCP_GROUP_BY_FIELD[field]) return MCP_GROUP_BY_FIELD[field];
    if (/^btn/.test(field)) return 'toolbar';
    if (/^(qcmd|quickCmd)/.test(field)) return 'adv';
    return 'misc';
}

function mcpJoinPath(panel, group, name) {
    return mcpSlug(panel) + '.' + mcpSlug(group) + '.' + mcpSlug(name);
}

/// 控件类型：决定怎么读、怎么写
function mcpKindOf(el) {
    var tag = String(el.tagName || '').toLowerCase();
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'text';
    if (tag === 'input') {
        var t = String((el.getAttribute && el.getAttribute('type')) || 'text').toLowerCase();
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'range') return 'range';
        if (t === 'number') return 'number';
        return 'text';
    }
    if (el.classList && el.classList.contains('sel')) return 'select';
    if (el.classList && (el.classList.contains('ibtn') || el.classList.contains('win-ctrl-btn'))) return 'toggle';
    return 'button';
}

/// 读当前值（只读 DOM，不另存一份状态）
function mcpReadEl(el, kind) {
    kind = kind || mcpKindOf(el);
    switch (kind) {
        case 'select':
            return String(el.tagName || '').toLowerCase() === 'select'
                ? el.value
                : (el.getAttribute('data-val') || '');
        case 'checkbox': case 'radio': return !!el.checked;
        case 'toggle': return !!(el.classList && el.classList.contains('on'));
        case 'text': case 'number': case 'range': return el.value;
        default: return null;
    }
}

function _mcpDispatch(el, type) {
    try {
        el.dispatchEvent(new Event(type, { bubbles: true }));
    } catch (e) { /* 假 DOM 或老环境里失败不该影响主流程 */ }
}

/// 在自定义下拉里找对应的选项元素
function _mcpFindOption(el, v) {
    try {
        var opts = el.querySelectorAll ? el.querySelectorAll('.sel-opt') : [];
        for (var i = 0; i < opts.length; i++) {
            var dv = opts[i].getAttribute('data-val');
            var ds = opts[i].getAttribute('data-style');
            if ((dv != null && dv === String(v)) || (ds != null && ds === String(v))) return opts[i];
        }
    } catch (e) { /* ignore */ }
    return null;
}

/// 写值：**一律走合成 DOM 事件**，复用的就是用户点那条路（界面必然同步，不写第二套逻辑）。
/// 返回写后的真实值 —— 很多控件会规范化输入（波特率纠正、端口失效回退），AI 要看真实结果。
function mcpWriteEl(el, kind, v) {
    kind = kind || mcpKindOf(el);
    switch (kind) {
        case 'select': {
            if (String(el.tagName || '').toLowerCase() === 'select') {
                el.value = String(v);
                _mcpDispatch(el, 'change');
                return mcpReadEl(el, kind);
            }
            var opt = _mcpFindOption(el, v);
            if (opt) {
                opt.click();
                return mcpReadEl(el, kind);
            }
            el.setAttribute('data-val', String(v));
            _mcpDispatch(el, 'change');
            return mcpReadEl(el, kind);
        }
        case 'checkbox': case 'radio': {
            var want = !!v;
            if (!!el.checked !== want) el.click();
            return !!el.checked;
        }
        case 'toggle': {
            var on = !!v;
            var isOn = !!(el.classList && el.classList.contains('on'));
            if (on !== isOn) el.click();
            return !!(el.classList && el.classList.contains('on'));
        }
        case 'text': case 'number': case 'range': {
            el.value = String(v);
            _mcpDispatch(el, 'input');
            _mcpDispatch(el, 'change');
            return el.value;
        }
        default:
            el.click();
            return null;
    }
}

function mcpElEnabled(el) {
    if (el.disabled) return false;
    if (el.style && el.style.pointerEvents === 'none') return false;
    if (el.classList && el.classList.contains('disabled')) return false;
    return true;
}

/// 灰掉的原因 —— 这是 AI 最需要的信息（"为什么不能点"）
function mcpDisabledReason(el) {
    if (el.disabled) return '控件当前被禁用';
    if (el.style && el.style.pointerEvents === 'none') return '当前不可点（pointer-events:none）';
    if (el.classList && el.classList.contains('disabled')) return '当前不可点（disabled 类）';
    return null;
}

/// 单个控件 → 注册表条目
function mcpEntryFor(el, ordinal) {
    var id = el.id || '';
    var panel, group, name;
    var midMatch = /^(main|extra-\d+|wsl|wsl-x\d+|ble-mon)-(.+)$/.exec(id);
    if (midMatch) {
        panel = mcpPanelOfMid(midMatch[1]);
        name = midMatch[2];
        group = mcpGroupOfField(name);
    } else if (id) {
        panel = mcpPanelOfNode(el);
        group = 'ui';
        name = id;
    } else {
        // 既没有可解析的 id 也没有 data-*：用「面板 + 标签名 + 文档序」兜底。
        // 模板不变时它是稳定的；模板改了由断言兜底（见 .walkthrough/gen_ble_preview.js）。
        panel = mcpPanelOfNode(el);
        group = 'misc';
        name = String(el.tagName || 'el').toLowerCase() + '_' + ordinal;
    }
    var path = mcpJoinPath(panel, group, name);
    var kind = mcpKindOf(el);
    return {
        path: path,
        el: el,
        kind: kind,
        panel: panel,
        group: group,
        label: (el.getAttribute && (el.getAttribute('title') || el.getAttribute('aria-label'))) || id || name,
        read: function () { return mcpReadEl(el, kind); },
        write: function (v) { return mcpWriteEl(el, kind, v); },
        enabled: function () { return mcpElEnabled(el); },
        disabledReason: function () { return mcpDisabledReason(el); },
    };
}

/// 重建注册表并把 data-mcp 注入到控件上（幂等）
function mcpBuildRegistry() {
    var nodes = document.querySelectorAll(MCP_SELECTOR);
    MCP_REGISTRY = {};
    MCP_REGISTRY_LIST = [];
    var dup = {};
    for (var i = 0; i < nodes.length; i++) {
        // 危险动作的"另一个入口"（BLE 从机启停、工作流那颗运行按钮）：**不收进注册表** ——
        // 否则 `ui_click` 一下就等于绕过确认门（危险门按工具名判）。这些按钮的 `data-mcp-skip`
        // 与 `MCP_DANGER_CONTROLS` 那张表配对，断言守着"不漏也不虚"。
        if (nodes[i].closest && nodes[i].closest('[data-mcp-skip]')) continue;
        var entry = mcpEntryFor(nodes[i], i);
        if (!entry) continue;
        if (MCP_REGISTRY[entry.path]) {
            // 路径撞了：加序号保证唯一（模板重复出现时会走到这里）
            dup[entry.path] = (dup[entry.path] || 1) + 1;
            entry.path = entry.path + '_' + dup[entry.path];
        }
        MCP_REGISTRY[entry.path] = entry;
        MCP_REGISTRY_LIST.push(entry);
        try { nodes[i].setAttribute('data-mcp', entry.path); } catch (e) { /* ignore */ }
    }
    _mcpRegistrySig = nodes.length;
    return MCP_REGISTRY_LIST.length;
}

/// 懒重建：DOM 数量变了就重建（面板懒加载/增删监视器都会改变数量），
/// 这样不用去改各面板的渲染代码。重建后顺带把注册表报给后端（S6）。
///
/// ⚠️ **数量没变也必须查"元素还在不在 DOM 里"**：面板经常用 `innerHTML` 整棵重画
/// （WSL 设备表每 5 秒一次、端口下拉每次刷新一次），设备/选项个数不变时节点总数**恰好一样**。
/// 只比数量的话注册表里会留着一批**已脱离 DOM 的旧元素** —— 它们照样 `enabled()`、照样能
/// `click()`，于是 `ui_set` 点的是空气却回 `ok:true`；更糟的是行内 `onchange` 里可能还带着
/// **旧下标**，会去操作另一台设备（WSL 映射那里原本就是这个形状）。
/// `document.contains` 不存在时（无头假 DOM）退回原来的行为 —— 探测不到不该被当成 stale。
function mcpEnsureRegistry(force) {
    var nodes = document.querySelectorAll(MCP_SELECTOR);
    var stale = false;
    if (!force && nodes.length === _mcpRegistrySig && document.contains) {
        for (var i = 0; i < MCP_REGISTRY_LIST.length; i++) {
            var el = MCP_REGISTRY_LIST[i].el;
            if (!el || !document.contains(el)) { stale = true; break; }
        }
    }
    if (force || stale || nodes.length !== _mcpRegistrySig) {
        mcpBuildRegistry();
        mcpReportRegistry();
    }
    return MCP_REGISTRY_LIST.length;
}

/// 下拉类控件的可选值（给 AI 当 enum，省得它猜）
function mcpEnumValuesFor(entry) {
    if (!entry || entry.kind !== 'select') return [];
    var out = [];
    try {
        var list = entry.el.querySelectorAll ? entry.el.querySelectorAll('.sel-opt') : [];
        for (var i = 0; i < list.length; i++) {
            var v = list[i].getAttribute('data-val') || list[i].getAttribute('data-style');
            if (v) out.push(String(v));
        }
    } catch (e) { /* 假 DOM/老环境忽略 */ }
    return out;
}

var _mcpRegistryReported = '';
var _mcpReportTimer = null;

/// 把注册表报给后端（S6）：后端据此生成 `ctl_*` 工具定义。
/// 带签名去重 + 300ms 合并 —— 面板每次渲染都会重建注册表，不能每次都发一遍。
function mcpReportRegistry() {
    if (_mcpReportTimer) return;
    _mcpReportTimer = setTimeout(function() {
        _mcpReportTimer = null;
        var entries = MCP_REGISTRY_LIST.map(function(e) {
            return {
                path: e.path,
                kind: e.kind,
                label: e.label || '',
                panel: e.panel,
                group: e.group,
                enabled: e.enabled(),
                disabledReason: e.disabledReason(),
                options: mcpEnumValuesFor(e),
            };
        });
        var sig = entries.map(function(e) {
            return e.path + '/' + e.kind + '/' + (e.enabled ? '1' : '0');
        }).join('|');
        if (sig === _mcpRegistryReported) return;   // 没变就不发
        _mcpRegistryReported = sig;
        invoke('mcp_report_registry', { entries: entries }).catch(function() {});
    }, 300);
}

/// 供 AI 的输入 schema 用：把控件类型翻译成 JSON Schema 片段
function mcpInputSchemaFor(entry) {
    var s = { type: 'object', properties: {}, additionalProperties: false };
    if (entry.kind === 'button' || entry.kind === 'toggle') {
        s.properties = { value: { type: 'boolean', description: 'true=点击/打开，false=关闭（按钮可省略）' } };
        return s;
    }
    if (entry.kind === 'checkbox' || entry.kind === 'radio') {
        s.properties = { value: { type: 'boolean' } };
        s.required = ['value'];
        return s;
    }
    if (entry.kind === 'number' || entry.kind === 'range') {
        s.properties = { value: { type: 'number' } };
        s.required = ['value'];
        return s;
    }
    if (entry.kind === 'select') {
        var opts = [];
        try {
            var list = entry.el.querySelectorAll ? entry.el.querySelectorAll('.sel-opt') : [];
            for (var i = 0; i < list.length; i++) {
                var dv = list[i].getAttribute('data-val') || list[i].getAttribute('data-style');
                if (dv) opts.push(dv);
            }
        } catch (e) { /* ignore */ }
        s.properties = { value: opts.length ? { type: 'string', enum: opts } : { type: 'string' } };
        s.required = ['value'];
        return s;
    }
    s.properties = { value: { type: 'string' } };
    s.required = ['value'];
    return s;
}

/// 给 AI 看的条目摘要（不含 DOM 句柄）
function mcpEntryPublic(entry) {
    return {
        path: entry.path,
        kind: entry.kind,
        panel: entry.panel,
        group: entry.group,
        label: entry.label,
        enabled: entry.enabled(),
        disabledReason: entry.disabledReason(),
        value: entry.read(),
    };
}

/* ===== MCP 前端桥（S5）：接收后端下发的 ui 命令并回执 =====
 * 后端 emit("mcp-ui-cmd") → 这里执行 → invoke("mcp_ui_ack") 回执。
 * 执行走的就是上面的合成 DOM 事件路径，所以界面必然会跟着变。 */
var _mcpUiOrigin = 0;   // >0 表示当前变更由 AI 触发（用于回声抑制）

// AI 下发的界面命令 → 执行 → 回执（后端在等这个 ack，5s 超时）。
//
// **必须能等 Promise**：不少分支返回的是 Promise（连设备 / 读写特征 / 读 RSSI…），
// 而这里原先直接读 `res.ok` —— Promise 上没有 ok，于是回执变成 `ok:false` + `error:null`，
// 客户端只看到一句没头没尾的"前端执行失败"（真实原因是"设备还没连"，AI 却什么都不知道）。
// ackFn(ack) 由调用方给出（生产里是 `invoke('mcp_ui_ack', …)`），便于无头断言"到底等了没等"。
function mcpUiCmdReply(cmd, ackFn) {
    var p = cmd || {};
    var send = function(res) {
        ackFn({
            cmdId: p.cmdId,
            ok: !!(res && res.ok),
            value: (res && res.value !== undefined) ? res.value : null,
            error: (res && res.error) || null,
            // notFound / invalidParams 必须回传：后端靠它们把"路径或取值不存在"判成
            // 协议级 -32602（丢了会一律退化成 -32006"没有界面"，AI 会误解成应用没开界面）
            notFound: !!(res && res.notFound),
            invalidParams: !!(res && res.invalidParams),
            disabledReason: (res && res.disabledReason) || null,
        });
    };
    var res;
    try {
        res = mcpHandleUiCmd(p.op, p.payload);
    } catch (e) {
        send({ ok: false, error: String((e && e.message) || e) });
        return;
    }
    Promise.resolve(res).then(send, function(e) {
        send({ ok: false, error: String((e && e.message) || e) });
    });
}

function mcpHandleUiCmd(op, payload) {
    payload = payload || {};
    mcpEnsureRegistry(false);
    if (op === 'list') {
        var panel = payload.panel, kind = payload.kind, q = payload.query;
        var all = MCP_REGISTRY_LIST.filter(function (e) {
            if (panel && e.panel !== panel) return false;
            if (kind && e.kind !== kind) return false;
            if (q) {
                var hay = (e.path + ' ' + (e.label || '')).toLowerCase();
                if (hay.indexOf(String(q).toLowerCase()) < 0) return false;
            }
            return true;
        });
        // 游标必须夹到**非负整数**：JS `slice` 对负数是从末尾算的 —— `cursor:-5` 会静默返回
        // 末尾几条，并把负游标当 `nextCursor` 回传（客户端此后每页都空，还永久跳过前面的控件）。
        // 与 Rust 侧 tools/list 的游标夹取是同一条纪律（非法输入要么报错、要么按确定语义处理）。
        var cursor = Math.max(0, parseInt(payload.cursor, 10) || 0);
        var limit = payload.limit ? Math.max(1, Math.min(500, parseInt(payload.limit, 10) || 100)) : 100;
        var page = all.slice(cursor, cursor + limit);
        var out = {
            total: all.length,
            controls: page.map(mcpEntryPublic),
        };
        if (cursor + limit < all.length) out.nextCursor = String(cursor + limit);
        return { ok: true, value: out };
    }
    if (op === 'describe') {
        var e = MCP_REGISTRY[payload.path];
        if (!e) return { ok: false, notFound: true, error: '未找到控件: ' + payload.path };
        var pub = mcpEntryPublic(e);
        pub.description = e.label;
        pub.inputSchema = mcpInputSchemaFor(e);
        return { ok: true, value: pub };
    }
    if (op === 'get') {
        var g = MCP_REGISTRY[payload.path];
        if (!g) return { ok: false, notFound: true, error: '未找到控件: ' + payload.path };
        return { ok: true, value: { path: g.path, value: g.read(), enabled: g.enabled(), disabledReason: g.disabledReason() } };
    }
    if (op === 'getState') {
        // 界面状态的唯一真源就是 collectConfig()（与"随用户配置持久化"用的是同一份）
        var snap = (typeof collectConfig === 'function') ? collectConfig() : null;
        if (!snap) return { ok: false, error: '界面状态不可用（初始化未完成）' };
        var sec = payload.section;
        if (!sec) return { ok: true, value: snap };
        var out;
        if (sec === 'monitors') {
            out = snap.monitors;
        } else if (sec === 'serial' || sec === 'wsl') {
            out = {};
            Object.keys(snap.monitors || {}).forEach(function(mid) {
                var isWsl = (mid === 'wsl' || /^wsl-x\d+$/.test(mid));
                if ((sec === 'wsl') === isWsl) out[mid] = snap.monitors[mid];
            });
        } else if (sec === 'ble') {
            // 顺带把扫描结果带一份**精简版**：通用桥（ui_*）原先没有任何入口能读到它 ——
            // 设备卡片是动态生成的 div、不在控件注册表里，所以"面板上明明扫到了、AI 却读不到"
            // （用户 2026-09 报的"连接器读不到扫描结果列表"）。完整列表用 section=bleDevices。
            // ⚠️ limit/offset 要**透传**（原来写死 (10, 0)）：`ui_get_state` 的 schema 里就带着这两个
            // 参数，写死等于"传了没用"—— 调用方按 bleDevices 那套翻页时会一直拿到前 10 台
            // （2026-09 审计发现）。省略时仍保持原来的精简口径（前 10 台）。
            var bleLim = parseInt(payload.limit, 10);
            var bleOff = parseInt(payload.offset, 10);
            out = Object.assign({}, snap.ble, {
                scanResult: mcpBleScanResult(isNaN(bleLim) ? 10 : bleLim,
                                             isNaN(bleOff) ? 0 : bleOff)
            });
        } else if (sec === 'bleDevices') {
            // 运行时数据（**不是配置**）：扫描结果。给只有通用桥、或工具列表还没刷新的客户端
            // 一个读得到的入口；语义工具那边是 ble_list_devices（两者读的是同一份 _bleDevices）。
            // 同样支持 limit / offset 分页（payload 里给就行）。
            out = mcpBleScanResult(parseInt(payload.limit, 10), parseInt(payload.offset, 10));
        } else if (sec === 'wslDevices') {
            // 运行时数据（**不是配置**）：WSL 端口映射那张 USB 设备表。
            // 与 `bleDevices` 是**同一个教训**（那段注释就在上面几行）：设备行是动态
            // `innerHTML` 出来的、不在控件注册表里 —— 于是"面板上明明列着 COM7、AI 却读不到"。
            // 用户 2026-09 原话是要 AI"把 COM7 映射到 WSL 当中"，而当时没有任何工具能读到这张表。
            out = mcpWslDevicesState();
        } else if (sec === 'theme') {
            out = { theme: snap.theme, themeStyle: snap.themeStyle };
        } else if (sec === 'window') {
            out = { width: snap.windowWidth, height: snap.windowHeight };
        } else {
            return {
                ok: false, notFound: true,
                error: '没有这个区段: ' + sec
                    + '（可用：serial / wsl / ble / bleDevices / wslDevices / theme / window / monitors）',
            };
        }
        return { ok: true, value: out };
    }
    if (op === 'set' || op === 'click') {
        var items = payload.items;
        if (!items) items = [{ path: payload.path, value: (op === 'click' ? true : payload.value) }];
        var results = [], effects = [], changed = [];
        _mcpUiOrigin++;
        try {
            for (var i = 0; i < items.length; i++) {
                var it = items[i] || {};
                var ent = MCP_REGISTRY[it.path];
                if (!ent) {
                    results.push({ path: it.path, ok: false, notFound: true, error: '未找到控件: ' + it.path });
                    continue;
                }
                // 先把控件所在的面板显示出来：用户得看得见 AI 正在动哪个页面
                mcpRevealPaneFor(ent.panel);
                if (!ent.enabled()) {
                    // 不可用就明确说原因，不要假装成功
                    results.push({
                        path: ent.path, ok: false,
                        error: ent.disabledReason() || '控件当前不可用',
                        disabledReason: ent.disabledReason(),
                    });
                    continue;
                }
                var before = ent.read();
                var after = ent.write(it.value);
                if (before !== after) effects.push({ path: ent.path, from: before, to: after });
                changed.push(ent.path);
                var itemRes = { path: ent.path, ok: true, value: after };
                // 「点了才开始跑」的控件（目前只有 WSL 端口映射那个复选框）：同步回执**只能**说
                // "发起了/没跑起来"，不能说"映射好了"。判据与理由见 mcpWslMapOutcome 的注释 ——
                // 关键是它靠 `_wslBusy` 在**点击返回的同一刻**就能判定，所以不用等、不会撞桥的 5s 预算。
                var mapBusid = (ent.el && ent.el.getAttribute)
                    ? ent.el.getAttribute('data-wsl-busid') : null;
                if (mapBusid) itemRes.mapRequest = mcpWslMapOutcome(mapBusid, after);
                results.push(itemRes);
            }
        } finally {
            _mcpUiOrigin--;
        }
        // 让界面把这次变更落盘（与用户操作走同一条路）
        try { scheduleConfigSave(); } catch (e) { /* ignore */ }
        if (changed.length) mcpNotifyState(changed);
        // 单目标失败 = **整次调用失败**：只给一个 path 时（ui_click / ui_set{path}）
        // 顶层还回 ok:true 会让调用方以为点成功了 —— 拿不到任何可用信息。
        // 多目标才是批量语义：逐项回报结果，调用本身算成功。
        if (items.length === 1 && results.length === 1 && !results[0].ok) {
            return {
                ok: false,
                notFound: !!results[0].notFound,
                error: results[0].error,
                disabledReason: results[0].disabledReason,
            };
        }
        return { ok: true, value: { results: results, effects: effects } };
    }
    if (op === 'serial') return mcpSerialOp(payload);
    if (op === 'ble') return mcpBleOp(payload);
    if (op === 'adb') return mcpAdbOp(payload);
    return { ok: false, error: '未知的 ui 操作: ' + op };
}

/* ===== BLE 语义层（给 MCP 的 ble_* 工具用）=====
 *
 * 与 `mcpSerialOp` 同构：一个 action 分支表，**每个分支都调面板那颗按钮走的函数**
 * （连接就是 `connectBleDirect()` / 断开就是 `bleDisconnect()`），不给 AI 另写一套。
 * 只读的几个（state / listDevices / getServices / getOutput / refreshRssi）保证没有任何副作用。
 */
// 在已渲染的服务树里按「特征 UUID + 属性」找到那颗操作图标（读/写/订阅共用同一套 DOM 结构）。
// 找不到返回 null —— 调用方据此说明"这个特征不支持该操作"，而不是去猜或另写一套读写逻辑。
function bleCharActionBtn(uuid, prop) {
    var want = String(uuid || '').toLowerCase() + '::' + prop;
    var btns = document.querySelectorAll ? document.querySelectorAll('.ble-ch-action') : [];
    for (var i = 0; i < btns.length; i++) {
        var key = String(btns[i].getAttribute('onclick') || '').toLowerCase();
        if (key.indexOf(want) >= 0) return btns[i];
    }
    return null;
}

// 扫描结果的"通用桥可读"版本（`ui_get_state` 的 ble / bleDevices 两段都用它，
// 语义工具那边是 ble_list_devices —— 三者读的是同一份 `_bleDevices`，不另存一份）。
//
// 为什么需要它：面板上的设备卡片是**动态生成的 div**，不在控件注册表里（注册表只收
// button/input/select/textarea/[onclick]），所以一个只有通用桥的客户端（或工具列表还没刷新的
// 客户端）**没有任何入口**能读到扫描结果 —— 用户 2026-09 报的"连接器读不到扫描结果列表"就是它。
// limit>0 时只回前 limit 台（精简版，避免把几十台设备塞进每个 ui_get_state 响应）。
function mcpBleScanResult(limit, offset) {
    var all = _bleDevices || [];
    var off = Math.max(0, parseInt(offset, 10) || 0);
    var lim = Math.max(0, parseInt(limit, 10) || 0);           // 0 = 不限
    var end = lim > 0 ? Math.min(all.length, off + lim) : all.length;
    var page = all.slice(off, end);
    var devices = page.map(function (d) {
        return {
            mac: d.address || d.mac || null,
            name: d.name || null,
            rssi: (typeof d.rssi === 'number') ? d.rssi : null,
            paired: !!d.paired,
            selected: !!(_bleSelected && (d.address || d.mac) === _bleSelected),
        };
    });
    var hasMore = end < all.length;
    var note = null;
    if (!all.length) {
        note = _bleScanning ? '正在扫描，稍后再读（扫描时长见 ble 段/面板左上角）'
                            : '还没有扫描结果：先开扫描（语义工具 ble_start_scan，或点面板上的「开始扫描」）';
    } else if (!devices.length) {
        note = 'offset=' + off + ' 越界：一共只有 ' + all.length + ' 台（offset 从 0 起）';
    } else if (hasMore) {
        note = '还有 ' + (all.length - end) + ' 台：用 offset=' + end + ' 接着翻（每页 ' + lim + ' 台）';
    }
    return {
        scanning: !!_bleScanning,
        total: all.length,
        offset: off,
        limit: lim,                       // 0 = 不限（一次全给）
        returned: devices.length,
        hasMore: hasMore,
        nextOffset: hasMore ? end : null, // 下一页直接拿它接着调
        // `truncated` 保留（老客户端在用），但含义**必须与 hasMore 一致**：
        // 原来算的是 `devices.length < all.length`，offset>0 时最后一页也会是 true ——
        // 同一个响应里"后面没有了"和"这条被截断了"自相矛盾（2026-09 审计发现）。
        truncated: hasMore,
        devices: devices,
        note: note,
    };
}

// 图标 onclick（`bleCharAction(this,'<uuid>::<prop>')`）里的**真实 UUID**。
// 大小写以服务树为准：`_bleSubs` 的键就是服务树里那个写法，用调用方传来的大小写去查
// 会查不到 —— 那会让"已经是订阅中"被误判成"未订阅"，退订请求于是静默不生效。
function bleBtnUuid(el) {
    var m = /bleCharAction\(this,'([^']*)::/.exec(String((el && el.getAttribute) ? el.getAttribute('onclick') : ''));
    return m ? m[1] : '';
}

// 服务树里那个服务抬头行（.ble-svc）
function bleSvcRowEl(svcUuid) {
    var want = String(svcUuid || '').toLowerCase();
    if (!want || !document.querySelectorAll) return null;
    var rows = document.querySelectorAll('.ble-svc');
    for (var i = 0; i < rows.length; i++) {
        if (String(rows[i].getAttribute('data-uuid') || '').toLowerCase() === want) return rows[i];
    }
    return null;
}

// 某个特征属于哪个服务（大小写不敏感 —— 后端回的特征 UUID 是小写，调用方可能给大写）
function bleSvcUuidOfChar(charUuid) {
    var want = String(charUuid || '').toLowerCase();
    var list = _bleServices || [];
    for (var i = 0; i < list.length; i++) {
        var chars = list[i].characteristics || [];
        for (var j = 0; j < chars.length; j++) {
            if (String(chars[j].uuid || '').toLowerCase() === want) return list[i].uuid || '';
        }
    }
    return '';
}

// 特征行上的操作图标**只在该服务展开时才在 DOM 里**（面板一次只展开一个服务，收起即移除）。
// 所以找不到就先让拥有它的那个服务展开（= 用户点服务抬头，同一条路），再找一次 ——
// 否则"没手动展开过服务"会被误判成"这个特征不支持读写"。
function bleFindCharBtn(uuid, prop) {
    var btn = bleCharActionBtn(uuid, prop);
    if (btn) return btn;
    var svcUuid = bleSvcUuidOfChar(uuid);
    if (!svcUuid) return null;
    var row = bleSvcRowEl(svcUuid);
    if (!row) {
        // 整个服务树还没渲染（例如蓝牙页是刚被 AI 打开的）：让面板自己渲染一遍再找
        if (typeof renderBleDetail === 'function') renderBleDetail();
        row = bleSvcRowEl(svcUuid);
    }
    if (!row) return null;
    // 已经展开说明这个特征确实没有该属性：别再点一下把人家收起来
    if (!(row.classList && row.classList.contains('expanded'))) row.click();
    return bleCharActionBtn(uuid, prop);
}

// 设备列表里那台设备的卡片（点它 = 选中，与用户点卡片同一条路）
function bleDevCardEl(addr) {
    var want = String(addr || '').trim().toUpperCase();
    if (!want || !document.querySelectorAll) return null;
    var cards = document.querySelectorAll('.ble-dev-card');
    for (var i = 0; i < cards.length; i++) {
        if (String(cards[i].getAttribute('data-addr') || '').toUpperCase() === want) return cards[i];
    }
    return null;
}

// 通用桥（ui_set / ui_click）要动某个面板里的控件时，先把那个面板显示出来 ——
// 否则用户看到的是"AI 在操控蓝牙页，界面上却还停在串口页"（用户 2026-09 反馈：
// AI 明明点了扫描，界面上什么都没切，等于看不见 AI 在干什么）。
// 一律走用户自己的入口按钮（合成点击）；**已经在目标页时一个点都不发**：
// 那几个按钮都是开关，盲点一下会把用户从当前页踢回串口页。
// 返回是否真的切了页。
function mcpRevealPaneFor(panel) {
    if (!panel || panel === 'global' || panel === 'mcp' || panel === 'dialog') return false;
    var idOf = { serial: 'paneContainer', wsl: 'wsl-pane', adb: 'adb-pane', ble: 'ble-pane' };
    var pane = document.getElementById(idOf[panel] || '');
    if (pane && pane.style.display !== 'none') return false;   // 已经在目标页
    if (panel === 'serial') {
        // 回串口页 = 点"当前打开那个面板"的按钮（它此刻的 onclick 已是「返回到串口调试器」）
        var open = ['ble', 'wsl', 'adb'].filter(function(p) {
            var el = document.getElementById(idOf[p]);
            return el && el.style.display !== 'none';
        })[0];
        var back = open ? document.getElementById(open + 'ToggleBtn') : null;
        if (!back || !back.click) return false;
        back.click();
        return true;
    }
    var btn = document.getElementById(panel + 'ToggleBtn');
    if (!btn || !btn.click) return false;
    btn.click();
    return true;
}

// 让蓝牙页真的显示出来（与用户点那颗蓝牙按钮同一条路：DOM 合成点击 → openBle()）。
// 返回调用后是否处于蓝牙页。
function bleEnsurePaneVisible() {
    var pane = document.getElementById('ble-pane');
    if (pane && pane.style.display !== 'none') return true;   // 已经在蓝牙页
    mcpRevealPaneFor('ble');
    pane = document.getElementById('ble-pane');
    return !!(pane && pane.style.display !== 'none');
}

function mcpBleOp(payload) {
    payload = payload || {};
    var action = payload.action;
    // AI **动手**时先把蓝牙页显示出来（用户得看得见 AI 在干什么）。
    // 纯读状态那几条（state / listDevices / getServices / getOutput / refreshRssi）
    // **不切页**：客户端一 poll 就把用户从别的页面拽走，比看不见更烦人。
    if (action === 'startScan' || action === 'stopScan' || action === 'connect' || action === 'disconnect'
        || action === 'read' || action === 'write' || action === 'subscribe') {
        bleEnsurePaneVisible();
    }

    if (action === 'state') {
        // 只读：全部来自面板已有的内存状态（_ble* 那几个模块级变量），不多打一次后端
        return { ok: true, value: {
            scanning: !!_bleScanning,
            deviceCount: (_bleDevices || []).length,
            selected: _bleSelected || null,
            connected: !!_bleConnInfo,
            addr: _bleConnAddr || null,
            connName: (_bleConnInfo && (_bleConnInfo.name || _bleConnInfo.deviceName)) || null,
            serviceCount: (_bleServices || []).length,
            notifySubs: Object.keys(_bleSubs || {}).filter(function (k) { return _bleSubs[k]; }).length,
            logCount: (_bleLog || []).length,
            monitorOpen: !!_bleExtraMon,
        } };
    }
    if (action === 'listDevices') {
        // 读扫描结果。**不能只读面板缓存** `_bleDevices`：它由面板每 2 秒的轮询刷新，
        // 而"AI 刚开完扫描就来问"完全可能落在两次轮询之间（用户 2026-09 报的
        // "扫描结果没有返回给 MCP 客户端"就是这个）——所以先让面板自己刷新一遍
        // （refreshBleDevices 就是那颗扫描按钮走的同一条路），再读。
        return bleRefreshDevicesNow().then(function () {
            // 分页：limit 每页几台（0/省略=全部）、offset 从第几台开始（0 起）。
            // **必须有 offset**：几十上百台设备一次全塞进一次响应，客户端既读不完也没法翻页
            // （用户 2026-09："limit 只能设上限，没有分页/offset，没法一页页翻完剩下的 88 台"）。
            var r = mcpBleScanResult(parseInt(payload.limit, 10), parseInt(payload.offset, 10));
            r.selected = _bleSelected || null;
            if (!r.total) {
                // 一台都没有：用面板那条更完整的说明（含"设备不广播就只能按 MAC 直连"的出路）
                r.note = _bleScanning
                    ? ('正在扫描（' + bleScanSecsLabel() + '）：稍后再问一次')
                    : '还没扫到设备：先 ble_start_scan；设备不广播时（被配对过/被别的主机连走）'
                      + '扫描永远搜不到，改用 ble_connect + addr 直连';
            }
            return { ok: true, value: r };
        });
    }
    if (action === 'startScan' || action === 'stopScan') {
        // 复用面板那颗"开始/停止扫描"按钮的函数（toggleBleScan 内部按 _bleScanning 分流）
        var wantScan = (action === 'startScan');
        if (!!_bleScanning !== wantScan) {
            try { toggleBleScan(); } catch (e) { return { ok: false, error: '切换扫描失败: ' + e }; }
        }
        return { ok: true, value: {
            scanning: !!_bleScanning,
            seconds: (typeof bleScanSecs === 'function') ? bleScanSecs() : null,
            deviceCount: (_bleDevices || []).length,
        } };
    }
    if (action === 'getServices') {
        // 只读：当前连接设备的 GATT 服务树（面板已经拉好的那份）
        var svcs = (_bleServices || []).map(function (s) {
            return {
                uuid: s.uuid || null,
                name: s.name || null,
                chars: (s.characteristics || s.chars || []).map(function (c) {
                    return { uuid: c.uuid || null, props: c.properties || c.props || [],
                             descs: (c.descriptors || []).length };
                }),
            };
        });
        return { ok: true, value: {
            connected: !!_bleConnInfo,
            addr: _bleConnAddr || null,
            serviceCount: svcs.length,
            services: svcs,
            note: svcs.length ? null : (_bleConnInfo ? '设备已连但还没服务树：稍后重试' : '还没连设备：先 ble_connect'),
        } };
    }
    if (action === 'getOutput') {
        // 只读：面板**本次会话**的数据日志缓冲（切设备/断开都会清空 —— 这与串口那套不同：
        // 串口读的是 LogHub 的通道，BLE 这里先给"面板上看到的那份"，并附上 LogHub 通道名，
        // 想要跨会话的完整历史就用 log_tail 去读那个通道）
        var lim = parseInt(payload.limit, 10);
        var logs = (_bleLog || []);
        var since = parseInt(payload.sinceSeq, 10);
        // `sinceSeq` 认的是**条目自己的稳定编号**（`l.seq`），不是数组下标：
        // 缓冲满 400 条会丢最旧的，下标随之整体前移 —— 老实现拿 `from + i` 当下标算 seq，
        // 于是"返回第 380-399 条却标成 seq 0-19"，客户端按 sinceSeq 跟进时会重复拉几百条
        // （2026-09 审计发现）。lim 与 sinceSeq 同时给时：先按 seq 增量，再取最后 lim 条。
        var after = (since >= 0)
            ? logs.filter(function (l) { return (typeof l.seq === 'number' ? l.seq : -1) > since; })
            : logs;
        var slice = (lim > 0) ? after.slice(Math.max(0, after.length - lim)) : after;
        return { ok: true, value: {
            pane: 'ble',
            count: slice.length,
            total: logs.length,
            channels: { rx: 'ble:rx', tx: 'ble:tx' },   // 给 log_tail 用（跨会话/更多条）
            items: slice.map(function (l) {
                return {
                    seq: (typeof l.seq === 'number') ? l.seq : 0,
                    ts: l.ts || null,
                    kind: l.kind || null,     // 'rx' / 'tx' / 'info' / 'err'
                    hex: l.hex || null,
                    // 值属于哪个特征/描述符：**CTS 的时间自动解读**就靠它认（后端按短号 2a2b/2a0f 判断）；
                    // 描述符的值只给 descUuid —— CCCD 也是 2 字节，别让它在解读时被当成时区
                    charUuid: l.charUuid || null,
                    descUuid: l.descUuid || null,
                    text: l.text || '',
                    dim: l.dim || '',
                };
            }),
        } };
    }
    if (action === 'refreshRssi') {
        // 只读（只问一次射频，不改任何状态）：当前已连设备的信号强度
        if (!_bleConnAddr) {
            return { ok: false, error: '还没连设备：先连上再读 RSSI（当前没有已连接地址）' };
        }
        return invoke('ble_refresh_rssi').then(function (info) {
            return { ok: true, value: {
                addr: _bleConnAddr,
                rssi: (info && typeof info.rssi === 'number') ? info.rssi : null,
                raw: info || null,
            } };
        }).catch(function (e) { return { ok: false, error: '读 RSSI 失败: ' + e }; });
    }
    if (action === 'read' || action === 'subscribe') {
        // 按特征 UUID 找到**面板上那颗按钮**并点它 —— 与用户点击同一条路
        // （日志、图标状态、_bleSubs 都会跟着变；不给 AI 另写一套读取/订阅逻辑）
        var wantUuid = String(payload.char || '').toLowerCase();
        if (!wantUuid) {
            return { ok: false, invalidParams: true,
                     error: '要给 char：特征 UUID（见 ble_get_services 的 services[].chars[].uuid）' };
        }
        var devSel = (typeof getSelectedBleDev === 'function') ? getSelectedBleDev() : null;
        if (!devSel || !devSel.connected) return { ok: false, error: '还没连设备：先连上再操作特征' };
        var findBtn = function(prop0) { return bleFindCharBtn(wantUuid, prop0); };
        if (action === 'read') {
            var rbtn = findBtn('read');
            if (!rbtn) return { ok: false, error: '服务树里没有这个特征，或它没有 read 属性：先用 ble_get_services 确认 UUID' };
            rbtn.click();
            return { ok: true, value: { pane: 'ble', uuid: bleBtnUuid(rbtn) || wantUuid, action: 'read',
                                        note: '已触发读取（结果随后出现在 ble_get_output 里）' } };
        }
        // subscribe：订阅开关（notify / indicate 都算）。**只在状态不一致时点**，
        // 否则会把用户刚打开的订阅又关掉。
        var btn = findBtn('notify') || findBtn('indicate');
        if (!btn) return { ok: false, error: '这个特征不支持订阅（没有 notify / indicate 属性），或它不在当前服务树里' };
        var propName = (String(btn.getAttribute('onclick')).toLowerCase().indexOf('::indicate') >= 0) ? 'indicate' : 'notify';
        // 键用**服务树里那个写法**（bleBtnUuid），不是调用方传来的 —— `_bleSubs` 就是按它存的
        var subUuid = bleBtnUuid(btn) || wantUuid;
        var subKey = subUuid + '::' + propName;
        var wantOn = (payload.on === undefined) ? true : !!payload.on;
        var already = !!_bleSubs[subKey];
        if (already !== wantOn) {
            btn.click();
            return { ok: true, value: { pane: 'ble', uuid: subUuid, prop: propName, on: wantOn,
                                        changed: true, note: '已' + (wantOn ? '订阅' : '退订') + '（数据随后出现在 ble_get_output）' } };
        }
        return { ok: true, value: { pane: 'ble', uuid: subUuid, prop: propName, on: already,
                                    changed: false, note: '本来就是' + (already ? '订阅中' : '未订阅') } };
    }
    if (action === 'connect') {
        // 连接：扫描列表里有它就「点卡片 + 走连接路径」；没有它就走面板那个「按 MAC 直连」
        // （不依赖广播 —— 被 Windows 配对过 / 被别的主机连走而不广播的设备，只有这条路能连）
        var cAddr = String(payload.addr || '').trim().toUpperCase();
        if (cAddr) {
            var card = bleDevCardEl(cAddr);
            if (!card && typeof renderBleDeviceList === 'function') {
                // 列表还没渲染（蓝牙页刚被 AI 打开 / 扫完还没刷）：让面板自己渲染一遍再找
                renderBleDeviceList();
                card = bleDevCardEl(cAddr);
            }
            if (card) {
                card.click();                        // 选中它（与用户点列表卡片同一条路）
                var selDev = (typeof getSelectedBleDev === 'function') ? getSelectedBleDev() : null;
                if (!selDev) return { ok: false, error: '选中设备失败：列表里找不到 ' + cAddr };
                return bleConnectTo(selDev.address, selDev.name || '未知设备').then(function (r) {
                    if (!r.ok) return { ok: false, error: r.error };
                    return { ok: true, value: { pane: 'ble', connected: true, addr: r.addr,
                                                name: r.name, via: 'list', paired: !!r.paired,
                                                serviceCount: (_bleServices || []).length } };
                });
            }
            return connectBleDirect(cAddr).then(function (r) {
                if (!r.ok) return { ok: false, invalidParams: !!r.invalidParams, error: r.error };
                return { ok: true, value: { pane: 'ble', connected: true, addr: r.addr,
                                            name: r.name, via: 'direct', paired: false,
                                            serviceCount: (_bleServices || []).length } };
            });
        }
        var curDev = (typeof getSelectedBleDev === 'function') ? getSelectedBleDev() : null;
        if (!curDev) {
            return { ok: false, invalidParams: true,
                     error: '先给 addr（设备 MAC），或在面板列表里选一台设备' };
        }
        if (curDev.connected) {
            return { ok: true, value: { pane: 'ble', connected: true, addr: curDev.address,
                                        name: curDev.name || '未知设备', via: 'selected', paired: false,
                                        changed: false, serviceCount: (_bleServices || []).length,
                                        note: '本来就连着，没有重复连接' } };
        }
        return bleConnectTo(curDev.address, curDev.name || '未知设备').then(function (r) {
            if (!r.ok) return { ok: false, error: r.error };
            return { ok: true, value: { pane: 'ble', connected: true, addr: r.addr, name: r.name,
                                        via: 'selected', paired: !!r.paired,
                                        serviceCount: (_bleServices || []).length } };
        });
    }
    if (action === 'disconnect') {
        if (!_bleConnAddr) {
            return { ok: true, value: { pane: 'ble', connected: false, addr: null, changed: false,
                                        note: '本来就没连设备' } };
        }
        var wasAddr = _bleConnAddr;
        return bleDisconnect().then(function (r) {
            if (!r.ok) return { ok: false, error: r.error };
            return { ok: true, value: { pane: 'ble', connected: false, addr: wasAddr, changed: true } };
        });
    }
    if (action === 'write') {
        // 写入 = 点面板那颗写图标打开写入窗 → 填内容 → 点「发送」。
        // HEX/文本解析、行尾、写响应/无响应**全用弹窗自己那套**（不复刻一份），
        // 所以写入窗会真的打开并留在界面上，数据日志里也能看到这一条。
        var wUuid = String(payload.char || '').toLowerCase();
        if (!wUuid) {
            return { ok: false, invalidParams: true,
                     error: '要给 char：特征 UUID（见 ble_get_services 的 services[].chars[].uuid）' };
        }
        var wData = (payload.data === undefined || payload.data === null) ? '' : String(payload.data);
        if (!wData) {
            return { ok: false, invalidParams: true,
                     error: '要给 data：要写入的内容（format=hex 时是十六进制串，如 01A0FF）' };
        }
        var fmt = String(payload.format || 'text').toLowerCase();
        if (fmt !== 'text' && fmt !== 'hex') {
            return { ok: false, invalidParams: true, error: 'format 只能是 text 或 hex' };
        }
        // 行尾默认 none：AI 写入多半是协议帧，擅自补 CRLF 会写坏数据（用户自己发时才用面板上的选择）
        var le = (payload.lineEnding === undefined) ? 'none' : String(payload.lineEnding).toLowerCase();
        if (['none', 'cr', 'lf', 'crlf'].indexOf(le) < 0) {
            return { ok: false, invalidParams: true, error: 'lineEnding 只能是 none / cr / lf / crlf' };
        }
        var devW = (typeof getSelectedBleDev === 'function') ? getSelectedBleDev() : null;
        if (!devW || !devW.connected) return { ok: false, error: '还没连设备：先连上再写特征' };
        var wBtn = bleFindCharBtn(wUuid, 'write');
        if (!wBtn) return { ok: false, error: '这个特征不支持写入（没有 write / write_without_response 属性），或它不在当前服务树里' };
        var modes = String(wBtn.getAttribute('data-modes') || 'write').split(',');
        var wantType = String(payload.writeType || '').toLowerCase();
        if (wantType && modes.indexOf(wantType) < 0) {
            return { ok: false, invalidParams: true,
                     error: 'writeType 只能是 ' + modes.join(' / ') + '（这个特征支持的写入方式）' };
        }
        wBtn.click();      // 打开写入窗（与用户点那颗图标同一条路）
        var q = function(sel) { return document.querySelector ? document.querySelector(sel) : null; };
        // 弹窗里的三个选择器都用面板自己的 setter，免得下拉高亮与实际值不符
        setBleWriteAs(fmt, q('#bleWriteAsDrop .send-as-opt[data-val="' + fmt + '"]'), null);
        var leOpt = q('#bleWriteLineEnd .sel-opt[data-val="' + le + '"]');
        if (leOpt) setSel(leOpt, le, null);
        if (wantType) setBleWriteMode(wantType, q('#bleWriteModeDrop .send-as-opt[data-val="' + wantType + '"]'), null);
        var wInp = document.getElementById('bleWriteValue');
        if (wInp) wInp.value = wData;
        return sendBleWriteCore().then(function(r) {
            if (!r || !r.ok) return { ok: false, error: (r && r.error) || '写入失败' };
            return { ok: true, value: {
                pane: 'ble', uuid: (_bleWriteTarget && _bleWriteTarget.uuid) || wUuid,
                hex: r.hex, bytes: r.bytes, writeType: r.writeType,
                format: fmt, lineEnding: le,
                note: '已写入（面板写入窗与数据日志里都能看到）',
            } };
        });
    }
    return { ok: false, invalidParams: true, error: '未知的 ble action: ' + action
        + '（可用：state / listDevices / startScan / stopScan / getServices / read / subscribe / write'
        + ' / connect / disconnect / getOutput / refreshRssi）' };
}

/* ===== ADB 语义层（给 MCP 的 adb_* 工具用）=====
 *
 * 与 `mcpBleOp` 同构：一个 action 分支表，**每个分支都调面板那条真实路径**
 * （`openAdbSession` / `closeAdbSession` / `invoke('adb_shell_write')` …），不给 AI 另写一套。
 * 与 BLE 的差别只有一处：ADB 面板是**单会话**模型，所以"当前会话"就是 `#adb-sessionArea`
 * 里那个 `[id^="adb-session-"]` 元素，会话身份看它身上的 `_adbSerial` / `_adbPtyId`。
 *
 * 两个危险动作（`openShell` / `shellWrite`）的确认门在 Rust 侧（`DANGER_TOOLS`）：
 * 没带 `confirm:true` 根本走不到这里（见 protocol.rs）。
 */

// 开会话最多在前端等多久（毫秒）。Rust 桥对 `adb.openShell` 用的是"设备档"超时
// （bridge.rs 的 UI_TIMEOUT_DEVICE_MS = 30s），必须**大于**这个值 —— 否则慢一点的
// 成功会被桥判成 -32004「界面可能正忙」，AI 拿到的是假失败（与 BLE connect 同一个坑）。
// 断言集里有一条守着这个大小关系。
var ADB_OPEN_WAIT_MS = 10000;

// UTF-8 字节数（写进 PTY 的是**字节**，回执里的 bytes 得是真的字节数）。
// 不引 TextEncoder：老 WebView 上它不一定在，而这里只需要一个 10 行的纯函数。
function adbUtf8Bytes(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c < 0x80) n += 1;
        else if (c < 0x800) n += 2;
        // 代理对（emoji 等）算一个 4 字节字符：跳过低位代理
        else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
        else n += 3;
    }
    return n;
}

// 当前那个 ADB 会话元素（单会话模型：最多一个）
function adbSessionEl() {
    var area = document.getElementById('adb-sessionArea');
    if (!area || !area.querySelector) return null;
    return area.querySelector('[id^="adb-session-"]');
}

// 把会话元素的真实状态整理成回执。cols/rows 取 xterm 自己的尺寸 ——
// 面板同步 PTY 尺寸（syncAdbTermSize）用的就是这两个数，所以它们是同一份事实。
function adbSessionValue(el, note) {
    var term = el && el._adbTerm;
    var v = {
        serial: (el && el._adbSerial) || null,
        opened: true,
        cols: (term && term.cols) || null,
        rows: (term && term.rows) || null,
    };
    if (note) v.note = note;
    return v;
}

// 让 ADB 页真的显示出来（与用户点顶栏那颗按钮同一条路：合成点击 → openAdb()）。
// 返回调用后 ADB 页（含会话区）是否就绪。
// 为什么要切页：① 用户得看得见 AI 在干什么；② 面板隐藏时 syncAdbTermSize 会主动跳过
// （容器尺寸为 0 会把 PTY 压成 2x2），于是 PTY 会停在 40x120 的默认值 —— 终端一打开就错位。
function adbEnsurePaneVisible() {
    var pane = document.getElementById('adb-pane');
    var ready = function() {
        return !!(pane && pane.style.display !== 'none' && document.getElementById('adb-sessionArea'));
    };
    if (ready()) return true;
    mcpRevealPaneFor('adb');
    pane = document.getElementById('adb-pane');
    return ready();
}

function mcpAdbOp(payload) {
    payload = payload || {};
    var action = payload.action;

    if (action === 'listDevices') {
        // 直接问后端（与面板那颗「刷新」按钮**同一个命令**）：不吃面板那 5 秒轮询的空窗，
        // 刚插上设备也能立刻看到。只读，不碰会话。
        return invoke('adb_devices').then(function(list) {
            var devs = Array.isArray(list) ? list : [];
            var devices = devs.map(function(d) {
                return {
                    serial: String(d.serial || ''),
                    state: String(d.state || ''),
                    model: (d.model === undefined || d.model === null) ? '' : String(d.model),
                    product: (d.product === undefined || d.product === null) ? '' : String(d.product),
                };
            });
            var ready = devices.filter(function(d) { return d.state.toLowerCase() === 'device'; }).length;
            var out = { total: devices.length, ready: ready, devices: devices };
            if (!devices.length) {
                out.note = '没有 ADB 设备：插上设备并打开 USB 调试；'
                    + '设备上还没点「允许 USB 调试」时 state 会是 unauthorized。'
                    + '（adb 本身没装/找不到时后端会直接报「未找到 adb 可执行文件」）';
            } else if (!ready) {
                out.note = '有 ' + devices.length + ' 台但一台都不可用（state 不是 device）：'
                    + 'unauthorized 需要在设备上点「允许 USB 调试」，offline 需要重新插拔/重启 adb 服务。';
            }
            return { ok: true, value: out };
        }).catch(function(e) {
            return { ok: false, error: '读 ADB 设备列表失败: ' + String((e && e.message) || e) };
        });
    }

    if (action === 'openShell') {
        if (typeof openAdbSession !== 'function') {
            return { ok: false, error: '这个界面版本没有 ADB 会话功能（openAdbSession 不存在）：请更新应用' };
        }
        if (!adbEnsurePaneVisible()) {
            return { ok: false, error: 'ADB 页没能显示出来（找不到 #adb-pane / #adbToggleBtn）' };
        }
        var wantSerial = String(payload.serial || '').trim();
        return invoke('adb_devices').then(function(list) {
            var ready2 = (Array.isArray(list) ? list : []).filter(function(d) {
                return String(d.state || '').toLowerCase() === 'device';
            });
            if (!ready2.length) {
                return { ok: false, error: '这台机器没有可用的 ADB 设备（adb devices 里一台 state=device 都没有）：'
                    + '先插上设备并在设备上允许 USB 调试，再用 adb_list_devices 确认' };
            }
            var target = null;
            if (wantSerial) {
                target = ready2.filter(function(d) { return String(d.serial) === wantSerial; })[0] || null;
                if (!target) {
                    // 设备名错了：这是**参数问题**（invalidParams → -32602），并把可选项列出来
                    return { ok: false, invalidParams: true,
                             error: '没有 ' + wantSerial + ' 这台可用设备（可选：' +
                                 ready2.map(function(d) { return String(d.serial); }).join(' / ') + '）' };
                }
            } else {
                target = ready2[0];
            }
            var serial = String(target.serial);
            var area = document.getElementById('adb-sessionArea');
            if (!area) return { ok: false, error: 'ADB 面板还没建出来（缺少 #adb-sessionArea）' };
            var cur = adbSessionEl();
            if (cur && cur._adbSerial === serial && cur._adbPtyId) {
                return { ok: true, value: adbSessionValue(cur, '本来就开着这个设备的 shell，没有重复打开') };
            }
            try {
                openAdbSession(serial);      // 与用户点设备卡片完全同一条路（建面板 + xterm + PTY）
            } catch (e) {
                return { ok: false, error: '打开 ADB 会话失败: ' + String((e && e.message) || e) };
            }
            // 点下去只代表"开始了"：`_adbPtyId` 要等 `invoke('adb_open_shell')` 回来才有，
            // 所以这里轮询到**真的开出来**才回执（与 serial_open 点完轮询确认同一套纪律）。
            return new Promise(function(resolve) {
                var deadline = Date.now() + ADB_OPEN_WAIT_MS;
                var tick = function() {
                    var el = adbSessionEl();
                    if (el && el._adbPtyId) { resolve({ ok: true, value: adbSessionValue(el) }); return; }
                    if (el && el._adbOpenError) {
                        resolve({ ok: false, error: '打开 ADB shell 失败: ' + el._adbOpenError });
                        return;
                    }
                    if (el && !el._adbTerm) {
                        resolve({ ok: false, error: 'ADB 会话节点建出来了但没有终端（xterm.js 未加载）' });
                        return;
                    }
                    if (!el) {
                        resolve({ ok: false, error: 'ADB 会话没能建起来（#adb-sessionArea 里没有会话节点）' });
                        return;
                    }
                    if (Date.now() >= deadline) {
                        resolve({ ok: false, error: (ADB_OPEN_WAIT_MS / 1000)
                            + ' 秒内没拿到 PTY 会话（adb_open_shell 一直没回来）：设备可能断开/未授权，'
                            + '或 adb 不可用。详情看界面终端上的报错或 log_tail(channel="error")' });
                        return;
                    }
                    setTimeout(tick, 100);
                };
                tick();      // 先查一次：已经开好时（或同步就绪时）不必等第一个 100ms
            });
        }).catch(function(e) {
            return { ok: false, error: '打开 ADB shell 失败: ' + String((e && e.message) || e) };
        });
    }

    if (action === 'shellWrite') {
        var data = (payload.data === undefined || payload.data === null) ? '' : String(payload.data);
        if (!data) {
            return { ok: false, invalidParams: true,
                     error: '要给 data：要写进 shell 的内容（命令请自己带上 \\n，不带就只是填在命令行上不会执行）' };
        }
        var elW = adbSessionEl();
        if (!elW) return { ok: false, error: '还没开 ADB shell 会话：先 adb_open_shell' };
        if (!elW._adbPtyId) {
            return { ok: false, error: 'ADB 会话还在建立中（还没拿到 PTY id）：稍等片刻，或先用 adb_open_shell 确认' };
        }
        // 用的就是面板终端 onData 走的那条命令（xterm 敲键盘 → invoke('adb_shell_write')），
        // 所以设备收到的字节与用户手打完全一样。
        return invoke('adb_shell_write', { sessionId: elW._adbPtyId, data: data }).then(function() {
            return { ok: true, value: {
                serial: elW._adbSerial || null,
                written: true,
                bytes: adbUtf8Bytes(data),
                data: data,
            } };
        }).catch(function(e) {
            return { ok: false, error: '写 ADB shell 失败: ' + String((e && e.message) || e) };
        });
    }

    if (action === 'shellResize') {
        var cols = parseInt(payload.cols, 10);
        var rows = parseInt(payload.rows, 10);
        if (!(cols >= 2) || !(rows >= 2)) {
            return { ok: false, invalidParams: true, error: 'cols / rows 都要是 >= 2 的整数' };
        }
        var elR = adbSessionEl();
        if (!elR) return { ok: false, error: '还没开 ADB shell 会话：先 adb_open_shell' };
        if (!elR._adbPtyId) {
            return { ok: false, error: 'ADB 会话还在建立中（还没拿到 PTY id）：稍等片刻再改尺寸' };
        }
        return invoke('adb_shell_resize', { sessionId: elR._adbPtyId, cols: cols, rows: rows })
            .then(function() {
                return { ok: true, value: {
                    serial: elR._adbSerial || null, cols: cols, rows: rows,
                    // 说清"这不是独占的"：面板自己跟着容器尺寸同步时会把 PTY 改回真实尺寸
                    note: '已把 PTY 改成 ' + cols + 'x' + rows
                        + '；面板自己的尺寸同步（容器变化时）可能随后改回真实容器尺寸',
                } };
            }).catch(function(e) {
                return { ok: false, error: '改 ADB PTY 尺寸失败: ' + String((e && e.message) || e) };
            });
    }

    if (action === 'closeShell') {
        var elC = adbSessionEl();
        if (!elC) {
            return { ok: true, value: { serial: null, opened: false, closed: false,
                                        note: '本来就没有打开的 ADB shell 会话' } };
        }
        var serialC = elC._adbSerial || null;
        // 复用面板那个关闭入口（含 kill adb shell 子进程 + 移除终端 + 回收在途的 open_shell）
        closeAdbSession(elC.id);
        return { ok: true, value: { serial: serialC, opened: false, closed: true } };
    }

    return { ok: false, invalidParams: true, error: '未知的 adb action: ' + action
        + '（可用：listDevices / openShell / shellWrite / shellResize / closeShell）' };
}

/* ===== 串口语义层（给 MCP 的 serial_* 工具用）=====
 *
 * 它与 `ui_*`（通用控件桥）的关系：`ui_*` 用"控件路径"寻址，这里用"**分栏 + 语义字段**"寻址。
 * 为什么需要它：
 *   1. 多分栏时通用路径会撞名（两个监视器都算出 `serial.conn.portSelect`，只能靠 `_2` 后缀区分），
 *      AI 分不清哪个是哪个分栏；这里用 `pane`（main / extra-1 / …）明确指向；
 *   2. AI 想要的是"选串口 / 设波特率 / 开监控"，不是"改某个控件"；
 *   3. 动作要能确认结果（开监控后到底连上没有）。
 *
 * 约定（守 AGENTS.md #3，**不写第二套逻辑**）：
 *   - 改值：走 mcpWriteEl（与 ui_set 完全同一个函数：合成 input/change 或点下拉项）；
 *   - 点按钮：el.click()，触发它自己的 inline onclick；
 *   - 少数没有 id 的按钮（如"清除内容"）：调用**它 onclick 里那个函数**（白名单，见 MCP_SERIAL_FUNCS）。
 *   所以界面必然跟着变，不存在"AI 改了但界面没动"。
 */
var MCP_SERIAL_FIELDS = {
    // 语义字段 → [控件 id 后缀, 控件类型]；类型与 mcpKindOf 的口径一致
    port:       ['portSelect', 'select'],
    baud:       ['baudRate',   'number'],
    viewMode:   ['viewMode',   'select'],
    lineEnding: ['lineEnding', 'select'],
    dataBits:   ['dataBits',   'select'],
    stopBits:   ['stopBits',   'select'],
    parity:     ['parity',     'select'],
    dtr:        ['chkDTR',     'checkbox'],
    rts:        ['chkRTS',     'checkbox'],
};
// 开关类（.ibtn，靠 `on` class 表示状态；toggleIbtn 只切 class，所以"不同才点"即幂等）
var MCP_SERIAL_TOGGLES = {
    autoScroll:    'btnScroll',
    autoReconnect: 'btnAutoReconnect',
    lineNum:       'btnLineNum',
    timestamp:     'btnTs',
    echo:          'btnEcho',
    terminalMode:  'btnSendLE',
    advOpen:       'btnAdv',
};
// 没有 id 的按钮 → 直接调用它 onclick 里的那个函数（不是另写一套）
var MCP_SERIAL_FUNCS = {
    clear:        function (mid) { clearLog(mid); },
    refreshPorts: function (mid) { refreshPorts(mid); },
    copyOutput:   function (mid) { copyOutput(mid); },
};

/// 可用的串口分栏（排除蓝牙页里那个内嵌临时监视器）
function mcpSerialPanes() {
    return Object.keys(monitors).filter(function (mid) {
        return monitors[mid] && !monitors[mid].bleEmbedded;
    });
}

function mcpSerialResolvePane(pane) {
    var panes = mcpSerialPanes();
    if (!pane) return panes.indexOf('main') >= 0 ? 'main' : panes[0];
    if (panes.indexOf(pane) < 0) return null;
    return pane;
}

function mcpSerialEl(mid, suffix) {
    return document.getElementById(mid + '-' + suffix);
}

/// 某个 .sel 控件的可选值（给 AI 报错时列出来，省得它猜）
function mcpSerialOptions(el) {
    if (!el || !el.querySelectorAll) return [];
    var out = [];
    el.querySelectorAll('.sel-opt').forEach(function (o) {
        var v = o.getAttribute('data-val');
        if (v !== null && v !== undefined) out.push(v);
    });
    return out;
}

/// 一个分栏的日志通道名（`serial:<分栏>:rx|tx`，WSL 分栏是 `wsl:` 前缀）。
/// **规则只在这里定义一处**：`bufferPush`（回灌）与 `mcpSerialState`（告诉 AI 去哪读）都用它，
/// 免得"写进去的名字"和"读出来的名字"各写一遍然后漂移。
function mcpSerialLogChannels(mid) {
    var m = monitors[mid] || {};
    var p = (m.isWsl ? 'wsl:' : 'serial:') + mid;
    return { rx: p + ':rx', tx: p + ':tx' };
}

/// 某个分栏端口下拉里当前可选的端口。
/// **与下拉本身读同一份 DOM**，不另存一份状态：Windows 分栏是 `refreshPorts` 填的 COM 列表，
/// WSL 分栏是 `refreshWslMonPorts` 填的 `/dev/...` 列表 —— 两条路都往 `<mid>-portDrop` 里放
/// `.sel-opt[data-val]`，所以这里读一次就够了，也就不会出现"下拉里明明有、工具却读不到"。
///
/// 为什么需要它：`serial_list_ports` 只列 **Windows** 的 COM 口，对 WSL 分栏是**误导**
/// （把 USB 串口 usbipd bind 进 WSL 之后 Windows 侧本来就没有那个口）。而 AI 要选端口
/// 必须知道"这个分栏"有哪些可选值 —— 那就是这里。
function mcpSerialPortOptions(mid) {
    var out = [];
    var drop = document.getElementById(mid + '-portDrop');
    if (!drop || !drop.querySelectorAll) return out;
    var opts = drop.querySelectorAll('.sel-opt');
    for (var i = 0; i < opts.length; i++) {
        var val = opts[i].getAttribute('data-val');
        if (!val) continue;   // "无可用端口"那条占位没有 data-val，跳过
        out.push({
            value: String(val),
            label: String(opts[i].textContent || ''),
            // 被别的分栏占着的端口在下拉里是灰的（`port-in-use`），工具里也要看得出来
            inUse: !!(opts[i].classList && opts[i].classList.contains('port-in-use')),
        });
    }
    return out;
}

/// 汇总一个分栏的完整状态：持久化配置（复用 collectConfigForMonitor）+ 运行时 + 开关状态
function mcpSerialState(mid) {
    var m = monitors[mid];
    var cfg = {};
    try { cfg = collectConfigForMonitor(mid) || {}; } catch (e) { /* ignore */ }
    var toggles = {};
    Object.keys(MCP_SERIAL_TOGGLES).forEach(function (k) {
        var el = mcpSerialEl(mid, MCP_SERIAL_TOGGLES[k]);
        toggles[k] = el && el.classList ? el.classList.contains('on') : null;
    });
    return {
        pane: mid,
        isConnected: !!m.isConnected,
        portName: m.portName || '',
        port: cfg.port || '',
        baud: cfg.baud ? parseInt(cfg.baud, 10) || cfg.baud : '',
        viewMode: cfg.viewMode || 'text',
        lineEnding: cfg.lineEnding || 'crlf',
        sendAs: cfg.sendAs || 'text',
        dataBits: cfg.dataBits || '8',
        stopBits: cfg.stopBits || '1',
        parity: cfg.parity || 'none',
        dtr: cfg.dtr, rts: cfg.rts,
        autoScroll: toggles.autoScroll,
        autoReconnect: toggles.autoReconnect,
        lineNum: toggles.lineNum,
        timestamp: toggles.timestamp,
        echo: toggles.echo,
        terminalMode: toggles.terminalMode,
        advOpen: toggles.advOpen,
        outputLines: m._textCount || 0,
        outputBytes: m._textDataLen || 0,
        historyCount: (m.sendHistory || []).length,
        panes: mcpSerialPanes(),
        // 这个分栏**当前可选的端口**：Windows 分栏是 COM 名，WSL 分栏是 `/dev/...` 路径。
        // 选端口前先看它 —— `serial_list_ports` 只有 Windows 的那一份，对 WSL 分栏不适用。
        portOptions: mcpSerialPortOptions(mid),
        // 让 AI 知道"收发内容去哪读"：serial_get_output 直接读它，log_tail 也能按名字增量拉
        logChannels: mcpSerialLogChannels(mid),
    };
}

/// 应用一批改动：每项 {name, value}；name 命中字段表就写值，命中开关表就切 class。返回变更明细。
function mcpSerialApply(mid, items) {
    var changed = [], results = [];
    _mcpUiOrigin++;
    try {
        for (var i = 0; i < items.length; i++) {
            var it = items[i] || {};
            var name = it.name;
            var value = it.value;
            if (!name) { results.push({ name: name, ok: false, invalidParams: true, error: '缺少 name' }); continue; }

            if (MCP_SERIAL_FIELDS[name]) {
                var spec = MCP_SERIAL_FIELDS[name];
                var el = mcpSerialEl(mid, spec[0]);
                if (!el) { results.push({ name: name, ok: false, error: '找不到控件 ' + mid + '-' + spec[0] }); continue; }
                var before = mcpReadEl(el, spec[1]);
                // 下拉：先校验选项真的存在，报错时把可选值列出来（AI 最需要这个）
                if (spec[1] === 'select') {
                    var opts = mcpSerialOptions(el);
                    if (opts.length && opts.indexOf(String(value)) < 0) {
                        results.push({ name: name, ok: false, invalidParams: true, error: '可选值只有: ' + opts.join(' / ') });
                        continue;
                    }
                }
                if (name === 'baud') {
                    var b = parseInt(value, 10);
                    if (!(b >= 110 && b <= 4000000)) {
                        results.push({ name: name, ok: false, invalidParams: true, error: '波特率必须在 110..4000000 之间' });
                        continue;
                    }
                }
                mcpWriteEl(el, spec[1], value);
                var after = mcpReadEl(el, spec[1]);
                var ok = String(after) === String(value);
                results.push({ name: name, ok: ok, from: before, to: after,
                               error: ok ? undefined : '写入后读回不一致（控件可能拒绝了这个值）' });
                if (ok && String(before) !== String(after)) changed.push(name);
            } else if (MCP_SERIAL_TOGGLES[name]) {
                var tel = mcpSerialEl(mid, MCP_SERIAL_TOGGLES[name]);
                if (!tel) { results.push({ name: name, ok: false, error: '找不到开关 ' + mid + '-' + MCP_SERIAL_TOGGLES[name] }); continue; }
                var was = tel.classList.contains('on');
                var want = !!value;
                if (was !== want) tel.click();          // 交给它自己的 onclick（toggleIbtn / toggleLineNum / …）
                var now = tel.classList.contains('on');
                results.push({ name: name, ok: now === want, from: was, to: now });
                if (now !== was) changed.push(name);
            } else {
                results.push({ name: name, ok: false, invalidParams: true, error: '不认识的字段: ' + name + '（可用：' +
                    Object.keys(MCP_SERIAL_FIELDS).concat(Object.keys(MCP_SERIAL_TOGGLES)).join(', ') + '）' });
            }
        }
    } finally {
        _mcpUiOrigin--;
    }
    try { scheduleConfigSave(); } catch (e) { /* ignore */ }
    if (changed.length) mcpNotifyState(changed.map(function (n) { return mid + '.' + n; }));
    var bad = results.filter(function (r) { return !r.ok; });
    if (bad.length) {
        // 已经生效的字段必须点名：整批校验是逐项进行的，前面的项可能已经改掉了，
        // 只说"失败"会让 AI 以为界面没变（于是重复下发或错判当前状态）。
        var applied = results.filter(function (r) { return r.ok; }).map(function (r) { return r.name; });
        var msg = bad[0].error || ('字段 ' + bad[0].name + ' 设置失败');
        if (applied.length) msg += '（注意：' + applied.join('、') + ' 已经生效，这次是部分成功）';
        var out = { ok: false, error: msg, detail: results };
        // 参数**取值**非法（端口不在下拉里、字段名不认识…）要标记出来：
        // 后端据此回协议级 -32602（"改参数重试"），而不是 isError 的 -32006（"先做前置操作"）。
        if (bad[0].invalidParams) out.invalidParams = true;
        return out;
    }
    return { ok: true, value: { pane: mid, applied: results } };
}

/// 哪些 action 是"AI 动手"（要切页给用户看），哪些是纯读（**不**切）。
/// 判据与 BLE 那边一致：**写切、读不切** —— 客户端一 poll 就把用户从别的页面拽走，
/// 比"看不见"更烦人（`mcpBleOp` 顶部那段注释就是这条纪律的出处）。
/// 读动作：`panes` / `state` / `history` / `quickList`。
var MCP_SERIAL_WRITE_ACTIONS = {
    apply: true, click: true, clear: true, refreshPorts: true, send: true,
    quickLoop: true, quickAdd: true, quickUpdate: true, quickRemove: true,
    quickGroup: true, quickRun: true, setSendAs: true,
    // 工作流：改规则是写；wfList 是只读（**故意不在这里**）
    wfAdd: true, wfUpdate: true, wfRemove: true, wfToggle: true,
};

/// 分栏名 → 该切到哪个面板（`serial` = 串口页，`wsl` = WSL 端口映射页）。
/// 认不出的分栏名不猜，回串口页。
function mcpSerialRevealForPane(pane) {
    var panel = pane ? mcpPanelOfMid(pane) : 'serial';
    if (panel !== 'serial' && panel !== 'wsl') panel = 'serial';
    mcpRevealPaneFor(panel);
}

/// 分栏"不存在"时的**可操作**提示。
///
/// ⚠️ 分栏有两种"不存在"，AI 看到的都是同一句"没有这个分栏"，但出路完全不同：
/// ① 名字写错了；② **还没被创建出来** —— WSL 分栏要等面板第一次打开
/// （`openWslMapping` → `initWslMonitor('wsl')`），额外监视器要等用户加一个。
/// 而配置里却有它们（`ui_get_state` 的 `monitors` 里有 `wsl`），所以第 ② 种会让 AI
/// 觉得"工具自相矛盾"（2026-09 真机实测：`panes = ["main"]`，
/// 而 `monitors` = `["main","wsl"]`）。这里把第 ② 种说破，并指出**写操作不需要它手动开面板**。
function mcpSerialMissingPaneHint(paneName) {
    var name = String(paneName == null ? '' : paneName);
    if (!name || monitors[name]) return '';
    if (/^wsl(-x\d+)?$/.test(name)) {
        return '。⚠️ WSL 分栏是**懒创建**的：WSL 端口映射面板没打开过时它还不存在（配置里有、运行时还没有）。'
             + '先 ui_click{"path":"global.ui.wslToggleBtn"} 打开面板，再重试。'
             + '（**写操作会自动打开它** —— serial_open / serial_send / serial_select_port 这类不用你手动开，'
             + '只有只读工具才会碰到这个提示。）';
    }
    if (/^extra-\d+$/.test(name)) {
        return '。⚠️ 这个额外监视器还没创建（额外分栏是"加一个才有一个"）：'
             + '先 ui_click{"path":"global.ui.addMonitorBtn"}。';
    }
    return '';
}

function mcpSerialOp(payload) {
    payload = payload || {};
    var action = payload.action;
    // **AI 动手时先把对应页面显示出来** —— 否则用户看到的是"AI 在操控 WSL 分栏的串口，
    // 界面上却还停在别处"，等于看不见 AI 在干什么（这正是当初加 mcpRevealPaneFor 的原因）。
    // 顺带解决第二件事：WSL / 额外分栏都是**懒创建**的，切页这一步恰好把 `monitors['wsl']` 建出来，
    // 所以**冷启动（面板从没打开过）时写操作也能直接成功**，不用让 AI 先手动开面板。
    if (MCP_SERIAL_WRITE_ACTIONS[action]) mcpSerialRevealForPane(payload.pane);
    var mid = mcpSerialResolvePane(payload.pane);
    if (!mid) {
        return { ok: false, notFound: true,
                 error: '没有这个分栏: ' + (payload.pane || '(默认)') + '；可用分栏: ' + mcpSerialPanes().join(', ')
                      + mcpSerialMissingPaneHint(payload.pane) };
    }
    var m = monitors[mid];

    if (action === 'panes') return { ok: true, value: { panes: mcpSerialPanes(), defaultPane: mid } };
    if (action === 'state') return { ok: true, value: mcpSerialState(mid) };
    if (action === 'apply') {
        var items = payload.items;
        if (!items || !items.length) return { ok: false, invalidParams: true, error: '缺少 items（[{name,value}]）' };
        return mcpSerialApply(mid, items);
    }
    if (action === 'click') {
        // 有 id 的按钮：严格遵守它自己的 disabled 状态（禁用就点不动，和用户一样）
        var target = MCP_SERIAL_TOGGLES[payload.name] || (MCP_SERIAL_FIELDS[payload.name] || [])[0];
        var btn = payload.name === 'start' ? mcpSerialEl(mid, 'btnStart')
                : payload.name === 'send' ? mcpSerialEl(mid, 'btnSend')
                : target ? mcpSerialEl(mid, target) : null;
        if (!btn) return { ok: false, error: '找不到按钮: ' + payload.name };
        if (btn.disabled) return { ok: false, error: '按钮当前不可点（' + (btn.title || btn.textContent || '') .trim() + '）' };
        btn.click();
        return { ok: true, value: { pane: mid, clicked: payload.name } };
    }
    if (action === 'clear') {
        if (!MCP_SERIAL_FUNCS.clear) return { ok: false, error: '内部错误：clear 未注册' };
        MCP_SERIAL_FUNCS.clear(mid);
        return { ok: true, value: { pane: mid, cleared: true, outputLines: m._textCount || 0 } };
    }
    if (action === 'refreshPorts') {
        // ⚠️ 两种分栏的端口**来源不同**：Windows 分栏是本机 COM 口（`list_ports`），
        // WSL 分栏是 WSL 里的设备（`refreshWslMonPorts` → `get_wsl_serial_devices`）。
        // 这个坑在"设备变更"那条路径上**已经踩过一次**（见 device-changed 分支里的注释：
        // "此前统一用 refreshPorts，会导致…把 WSL 监视器端口填成 Windows COM 列表"），当时漏了这里。
        // 工具仍然是**同一套** `serial_*`（靠 pane 区分分栏），这里只是数据源按分栏取。
        // 注：目前没有工具发这个 action（界面那颗"刷新端口"按钮走它自己的 onclick），
        // 所以它还没被真正触发过 —— 但留一条"一调就把 WSL 下拉填成 COM 列表"的分支就是雷。
        if (m.isWsl) refreshWslMonPorts(mid);
        else MCP_SERIAL_FUNCS.refreshPorts(mid);
        return { ok: true, value: { pane: mid, refreshing: true } };
    }
    if (action === 'send') {
        var inp = mcpSerialEl(mid, 'sendInput');
        var sbtn = mcpSerialEl(mid, 'btnSend');
        if (!inp || !sbtn) return { ok: false, error: '找不到发送框/发送按钮' };
        if (!m.isConnected) return { ok: false, error: '这个分栏还没打开监控（先用 serial_open）' };
        if (sbtn.disabled) return { ok: false, error: '发送按钮当前不可点' };
        var data = payload.data == null ? '' : String(payload.data);
        if (!data.length) return { ok: false, invalidParams: true, error: 'data 不能为空' };
        // 与用户输入等价：改 value + 派发 input，让应用自己的监听更新状态
        inp.value = data;
        try {
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e) { /* ignore */ }
        // **先挂标记、再点按钮**（click 是同步派发，`sendData` 会在这行里一直跑到记录那一步），
        // 让日志能把"这次发送"标成 AI 的 —— 否则它与用户手点发送在日志里一模一样。
        _mcpAiSend = { mid: mid, claimed: false };
        sbtn.click();   // → sendData(mid)
        var claimedOnce = _mcpAiSend && _mcpAiSend.claimed;
        _mcpAiSend = null;
        if (!claimedOnce) {
            // 没被认领 = 这条"发送"根本没进日志中心。两种情况：
            // ① 用户把**消息回显（echo）关掉了** —— `sendData` 只在 echo 开时才记一条 `send`；
            // ② 输出区还没渲染出来（`appendOutput` 第一行就 return 了）。
            // 但"AI 发了什么"是**事实**，不该由两个显示开关决定记不记 —— 补一条。
            // 否则 echo 一关，AI 的操作在日志里就是一片空白，用户复盘时看不到它动过手。
            var txChans = mcpSerialLogChannels(mid);
            var approxBytes = 0;
            try { approxBytes = new TextEncoder().encode(data).length; } catch (e) { approxBytes = data.length; }
            // 注：这里是**近似**字节数（没展开 `\n` 转义、也没补行尾）。`bytes` 只是展示字段；
            // 正常路径（echo 开着）记的是 `appendOutput` 算好的精确值，只有补记这一跳用它。
            mcpLogPush(txChans.tx, 'info', 'tx', outputTs(mid) + data, approxBytes, 'ai');
        }
        return { ok: true, value: { pane: mid, sent: true, mode: mcpSerialState(mid).sendAs,
                                    bytes: data.length, data: data.slice(0, 200) } };
    }
    if (action === 'history') {
        var limit = Math.max(1, Math.min(200, parseInt(payload.limit, 10) || 20));
        // sendHistory 是**新→旧**（send 时 unshift），所以"最近的在前"就是取前 limit 条。
        // 原来是 `slice(-limit).reverse()`：拿到的是**最旧**的 limit 条、还倒过来 ——
        // 与工具描述「最近的在前」（protocol.rs serial_get_history）正好相反，
        // 历史超过 limit 条时最近发送的根本不返回（AI 会以为刚才发的是很久以前那条）。
        var hist = (m.sendHistory || []).slice(0, limit);
        return { ok: true, value: { pane: mid, total: (m.sendHistory || []).length, items: hist } };
    }
    if (action === 'quickList') {
        // 列表按"组 → 组内条目"摊平：index 是**摊平后的下标**（组序 = 面板上的上下顺序，
        // 也就是循环的行走顺序），同时把每条属于哪个组一起给出去
        var flat = qcmdAllItems(mid);
        var qs = flat.map(function (x, i) {
            // seq/timeoutMs/hex 是**每条自己的发送参数**（名称已退出界面，label 可能为空）：
            // AI 要能一眼看出"哪几条会被循环发出去、每条最多等多久、按文本还是 HEX"。
            // expect/retry 只在文件里配得到（面板没有入口），一并给出来 —— 否则 AI 看不到这条的完整条件
            var q = x.it || {};
            return { index: i, group: x.group.name || '', groupIndex: x.gi, itemIndex: x.ii,
                     label: q.label || ('指令' + (i + 1)), value: q.value || '',
                     seq: qcmdItemSeq(q), timeoutMs: qcmdItemTimeout(q), hex: qcmdItemHex(q),
                     expect: qcmdItemExpect(q), retry: qcmdItemRetry(q),
                     okGoto: qcmdItemOkGoto(q), errGoto: qcmdItemErrGoto(q),
                     // 想把某个格子交给 ui_set 改时不用猜 id（组变化时前缀也会变）
                     domIds: { value: qcmdItemElId(mid, x.gid, x.ii, 'val'),
                               seq: qcmdItemElId(mid, x.gid, x.ii, 'seq'),
                               delay: qcmdItemElId(mid, x.gid, x.ii, 'delay'),
                               hex: qcmdItemElId(mid, x.gid, x.ii, 'hex') } };
        });
        // 组：名字/条数/是否参与循环/是否折叠 —— AI 得知道"哪几组现在根本不发"
        var groups = qcmdGroups(mid).map(function (g, gi) {
            return { index: gi, name: g.name || '', count: (g.items || []).length,
                     on: qcmdGroupOn(g), folded: !!g.folded, id: g.id };
        });
        var planLen = qcmdLoopPlan(mid).length;
        // 列表可能来自外部文件（文件即存储，见 qcmdSideHtml/quick_cmds_* 命令）：
        // 把来源一起给 AI —— 否则它会以为"改配置就能保住这条指令"，而面板里改的其实会写回文件
        // ⚠️ seq/timeoutMs/hex 只有文件表头声明了那几列时才在文件里，否则随 config.json 走
        return { ok: true, value: { pane: mid, items: qs, groups: groups, groupCount: groups.length,
                                    loop: { on: qcmdLoopRunning(mid), planLength: planLen },
                                    usable: qs.filter(function (q) { return !!q.value; }).length,
                                    file: m.quickCmdsFile || null, source: m.quickCmdsFile ? 'file' : 'config' } };
    }
    if (action === 'quickLoop') {
        // 循环发送开关：**复用面板那颗开关走的同一条路**（qcmdLoopRefusal 判前置、setQcmdLoop 落地），
        // 不另写一套 —— 否则"AI 能开、面板开不了"这种漂移迟早出现
        var want = payload.on === undefined ? !qcmdLoopRunning(mid) : !!payload.on;
        if (want) {
            var why = qcmdLoopRefusal(mid);
            if (why) return { ok: false, error: why };
        }
        setQcmdLoop(mid, want);
        return { ok: true, value: { pane: mid, loop: qcmdLoopRunning(mid), planLength: qcmdLoopPlan(mid).length,
                                    changed: true } };
    }
    if (action === 'quickAdd') {
        var gt = qcmdResolveGroup(mid, payload.group);
        if (!gt) return { ok: false, invalidParams: true, error: 'group 不认得：给组序号（0 起，见 quickList 的 groups[].index）或组名' };
        // 内容长度是**请求本身**的问题 → invalidParams（后端据此翻成 -32602「改参数重试」）。
        // 必须在 addQcmdItem **之前**判：否则被拒的调用会留下一条空指令。
        var tooLongAdd = qcmdValueTooLong(payload.value);
        if (tooLongAdd) return { ok: false, invalidParams: true, error: tooLongAdd };
        if (addQcmdItem(mid, gt.id) !== true) {
            // 满员是**前置状态**问题（先删几条再重试），不是参数错 → 不带 invalidParams
            // （后端据此翻成 -32006「先做前置操作」，见 AGENTS #9 的错误码分工）
            return { ok: false, error: '指令条目已达上限 ' + QCMD_FILE_MAX_ITEMS
                 + ' 条（先 quickRemove 删几条，或换一个分栏）。再加会让写回的文件超限、重载被截断。' };
        }
        var newIdx = (gt.items || []).length - 1;
        var applied = qcmdApplyItemPatch(mid, gt.id, newIdx, payload);
        var flatAdd = qcmdAllItems(mid);
        var at = -1;
        flatAdd.forEach(function(x, i) { if (x.gid === gt.id && x.ii === newIdx) at = i; });
        return { ok: true, value: { pane: mid, index: at, group: gt.name || '', groupIndex: qcmdGroupIndex(mid, gt.id),
                                    itemIndex: newIdx, applied: applied } };
    }
    if (action === 'quickUpdate') {
        var cellU = qcmdResolveItem(mid, payload.index);
        if (!cellU) return { ok: false, invalidParams: true, error: 'index 越界（见 quickList 的 items[].index）' };
        var tooLongUpd = qcmdValueTooLong(payload.value);
        if (tooLongUpd) return { ok: false, invalidParams: true, error: tooLongUpd };
        var appliedU = qcmdApplyItemPatch(mid, cellU.gid, cellU.ii, payload);
        if (!appliedU.length) return { ok: false, invalidParams: true, error: '没给要改的字段（value / seq / timeoutMs / expect / retry / hex 至少一个）' };
        return { ok: true, value: { pane: mid, index: parseInt(payload.index, 10), group: cellU.group.name || '',
                                    itemIndex: cellU.ii, applied: appliedU } };
    }
    if (action === 'quickRemove') {
        var cellR = qcmdResolveItem(mid, payload.index);
        if (!cellR) return { ok: false, invalidParams: true, error: 'index 越界（见 quickList 的 items[].index）' };
        var gone = { group: cellR.group.name || '', value: cellR.it.value || '', seq: qcmdItemSeq(cellR.it) };
        removeQcmdItem(mid, cellR.gid, cellR.ii);
        return { ok: true, value: { pane: mid, removed: parseInt(payload.index, 10), group: gone.group,
                                    value: gone.value, seq: gone.seq, remaining: qcmdAllItems(mid).length } };
    }
    if (action === 'quickGroup') {
        // 组操作：add / remove / rename / move / on / fold —— 每一个都复用面板里那个按钮的函数
        var op = String(payload.op || '').toLowerCase();
        var before = qcmdGroups(mid).map(function(g) { return g.name || ''; });
        if (op === 'add') {
            addQcmdGroup(mid);
        } else {
            var gr = qcmdResolveGroup(mid, payload.group);
            if (!gr) return { ok: false, invalidParams: true, error: 'group 不认得：给组序号（0 起）或组名' };
            if (op === 'remove') removeQcmdGroup(mid, gr.id);
            else if (op === 'rename') {
                if (payload.name === undefined) return { ok: false, invalidParams: true, error: 'rename 要给 name' };
                renameQcmdGroup(mid, gr.id, String(payload.name));
            } else if (op === 'move') {
                var to = parseInt(payload.toIndex, 10);
                if (!(to >= 0 && to < qcmdGroups(mid).length)) {
                    return { ok: false, invalidParams: true, error: 'toIndex 越界（0..' + (qcmdGroups(mid).length - 1) + '）' };
                }
                qcmdMoveGroup(mid, gr.id, to);
            } else if (op === 'on') {
                setQcmdGroupOn(mid, gr.id, payload.on === undefined ? true : !!payload.on);
            } else if (op === 'fold') {
                setQcmdGroupFold(mid, gr.id, payload.on === undefined ? true : !!payload.on);
            } else {
                return { ok: false, invalidParams: true, error: 'op 只能是 add / remove / rename / move / on / fold' };
            }
        }
        var after = qcmdGroups(mid).map(function(g) { return g.name || ''; });
        return { ok: true, value: { pane: mid, op: op, groups: after, before: before,
                                    loop: { on: qcmdLoopRunning(mid), planLength: qcmdLoopPlan(mid).length } } };
    }
    // ===== 工作流规则（面板「更多设置 → 工作流」那一块）=====
    // 与面板上改的是**同一条路**：直接改 `m.workflows` 再调 renderWorkflowList + saveWorkflowConfig，
    // 不另写一套（否则"AI 改的"和"面板改的"迟早对不上）。
    if (action === 'wfList') {
        var wfRules = (m.workflows || []).map(function(r) {
            return { id: r.id, name: r.name || '', enabled: r.enabled !== false, running: !!r.running,
                     collapsed: !!r.collapsed,
                     conditions: (r.conditions || []).map(function(c) {
                         return { type: c.type || 'string_contains', value: c.value || '' };
                     }),
                     actions: (r.actions || []).map(mcpWfActionOut),
                     domIds: { name: mcpWfElId(mid, r.id, 'name'),
                               enabled: mcpWfElId(mid, r.id, 'enabled'),
                               run: mcpWfElId(mid, r.id, 'run') } };
        });
        return { ok: true, value: { pane: mid, count: wfRules.length,
                                    runningCount: wfRules.filter(function(r) { return r.running; }).length,
                                    rules: wfRules,
                                    limits: { maxRules: WF_MAX_RULES, maxConditions: WF_MAX_CONDITIONS,
                                              maxActions: WF_MAX_ACTIONS, maxNameChars: WF_MAX_NAME,
                                              maxCondValueChars: WF_MAX_COND_VALUE,
                                              maxActionDataChars: WF_MAX_ACTION_DATA } } };
    }
    if (action === 'wfAdd') {
        if ((m.workflows || []).length >= WF_MAX_RULES) {
            // 满员是**前置状态**问题（先删几条再重试）→ 不带 invalidParams（-32006 那一类）
            return { ok: false, error: '规则已达上限 ' + WF_MAX_RULES + ' 条（先 wfRemove 删几条）' };
        }
        var whyAdd = mcpWfValidate(payload);
        if (whyAdd) return { ok: false, invalidParams: true, error: whyAdd };
        var newRule = { id: genWfId(), name: String(payload.name || '新规则').slice(0, WF_MAX_NAME),
                        enabled: payload.enabled !== false,
                        // ⚠️ 新规则**一律 running=false**：跑起来要另走 serial_workflow_run（带 confirm）
                        running: false, collapsed: false,
                        conditions: mcpWfConds(payload), actions: mcpWfActs(payload) };
        if (!m.workflows) m.workflows = [];
        m.workflows.push(newRule);
        renderWorkflowList(mid);
        saveWorkflowConfig(mid);
        return { ok: true, value: { pane: mid, rule: newRule.id, name: newRule.name, running: false,
                                    count: m.workflows.length, conditions: newRule.conditions.length,
                                    actions: newRule.actions.length } };
    }
    if (action === 'wfUpdate' || action === 'wfRemove' || action === 'wfToggle') {
        var wfTarget = findWfRule(mid, payload.rule);
        if (!wfTarget) {
            return { ok: false, invalidParams: true,
                     error: '没有这条规则：' + (payload.rule || '(空)') + '（规则 id 见 wfList 的 rules[].id）' };
        }
        if (action === 'wfRemove') {
            var wasRunning = !!wfTarget.running;
            if (wasRunning) toggleWorkflowRun(mid, wfTarget.id);   // 先停掉，别留一条还在跑的规则
            var goneName = wfTarget.name || '';
            deleteWorkflowRule(mid, wfTarget.id);
            return { ok: true, value: { pane: mid, removed: wfTarget.id, name: goneName,
                                        wasRunning: wasRunning, count: ((m.workflows || []).length) } };
        }
        if (action === 'wfToggle') {
            var wantRun = payload.on === undefined ? true : !!payload.on;
            if (!!wfTarget.running !== wantRun) toggleWorkflowRun(mid, wfTarget.id);
            return { ok: true, value: { pane: mid, rule: wfTarget.id, name: wfTarget.name || '',
                                        running: !!wfTarget.running, changed: true } };
        }
        var whyUpd = mcpWfValidate(payload);
        if (whyUpd) return { ok: false, invalidParams: true, error: whyUpd };
        var appliedWf = [];
        if (payload.name !== undefined) { wfTarget.name = String(payload.name).slice(0, WF_MAX_NAME); appliedWf.push('name'); }
        if (payload.enabled !== undefined) { wfTarget.enabled = !!payload.enabled; appliedWf.push('enabled'); }
        // running 只接受 false（停一条正在跑的）；启动必须走 serial_workflow_run
        if (payload.running === false && wfTarget.running) {
            toggleWorkflowRun(mid, wfTarget.id);
            appliedWf.push('running');
        }
        if (payload.conditions !== undefined) { wfTarget.conditions = mcpWfConds(payload); appliedWf.push('conditions'); }
        if (payload.actions !== undefined) { wfTarget.actions = mcpWfActs(payload); appliedWf.push('actions'); }
        if (!appliedWf.length) {
            return { ok: false, invalidParams: true,
                     error: '没给要改的字段（name / enabled / running=false / conditions / actions 至少一个）' };
        }
        renderWorkflowList(mid);
        saveWorkflowConfig(mid);
        return { ok: true, value: { pane: mid, rule: wfTarget.id, applied: appliedWf,
                                    running: !!wfTarget.running, enabled: wfTarget.enabled !== false } };
    }
    if (action === 'quickRun') {
        var idx = parseInt(payload.index, 10);
        var flat2 = qcmdAllItems(mid);
        if (!(idx >= 0 && idx < flat2.length)) {
            return { ok: false, invalidParams: true, error: 'index 越界（0..' + (flat2.length - 1) + '）' };
        }
        var cell = flat2[idx];
        if (!cell.it.value) return { ok: false, error: '第 ' + idx + ' 条快速指令还没配内容' };
        if (!m.isConnected) return { ok: false, error: '这个分栏还没打开监控（先用 serial_open）' };
        try { sendQcmdItem(mid, cell.gid, cell.ii); } catch (e) { return { ok: false, error: '执行快速指令失败: ' + e }; }
        return { ok: true, value: { pane: mid, ran: idx, group: cell.group.name || '', groupIndex: cell.gi,
                                    itemIndex: cell.ii, label: cell.it.label, value: cell.it.value,
                                    hex: qcmdItemHex(cell.it) } };
    }
    if (action === 'setSendAs') {
        // 发送模式（文本/HEX）：与用户点那个下拉项等价 —— 点选项 → 它自己的 onclick → setSendAs()
        var mode = String(payload.mode || 'text').toLowerCase();
        if (mode !== 'text' && mode !== 'hex') return { ok: false, invalidParams: true, error: 'mode 只能是 text 或 hex' };
        var txtEl = mcpSerialEl(mid, 'sendAsText');
        var cur = txtEl && txtEl.textContent === 'HEX' ? 'hex' : 'text';
        if (cur === mode) return { ok: true, value: { pane: mid, sendAs: mode, note: '本来就是' } };
        var drop = mcpSerialEl(mid, 'sendAsDrop');
        var opt = null;
        if (drop && drop.querySelectorAll) {
            drop.querySelectorAll('.send-as-opt').forEach(function (o) {
                if ((o.getAttribute('data-val') || '') === mode) opt = o;
            });
        }
        if (!opt) return { ok: false, error: '找不到发送模式选项: ' + mode };
        opt.click();
        var after = mcpSerialEl(mid, 'sendAsText');
        return { ok: true, value: { pane: mid, sendAs: after && after.textContent === 'HEX' ? 'hex' : 'text' } };
    }
    return { ok: false, invalidParams: true, error: '未知的 serial 操作: ' + action };
}

/// 界面状态变化通知（回声抑制：AI 自己造成的变更打 origin 标记）
function mcpNotifyState(paths) {
    try {
        invoke('mcp_notify_state', {
            paths: paths || [],
            origin: _mcpUiOrigin > 0 ? 'mcp' : 'user',
        }).catch(function () {});
    } catch (e) { /* ignore */ }
}

/* ===== MCP 日志回灌（S7）=====
 * 后端已经把**生产端**的日志收进 LogHub（app / error / ble:rx / mcp）；
 * 界面这边产生的行（串口收发、sys/err 提示）从这里批量回灌。
 * 必须批量：串口 921600 波特下每秒几十上百行，逐行 invoke 会把 IPC 打爆。
 * 也必须**有上限**：宁可丢日志，也不能让待发队列无界堆积。 */
var _mcpLogPending = [];
var _mcpLogTimer = null;
var _mcpLogFlushMs = 200;
var _mcpLogBatchMax = 200;
var _mcpLogQueueMax = 2000;
// 待发队列满时丢掉的条数（**按通道**）：丢弃必须记账，否则 log_tail 的
// `dropped`/`mayBeIncomplete` 会撒谎（说"日志完整"，实际丢了九成）—— 2026-09 审计发现。
var _mcpLogDropByCh = {};
// AI 发送的"待认领"标记：`mcpSerialOp` 的 send 分支挂上它，`bufferPush` 认领它
// （认领到就把那条日志的来源标成 `ai`）。见 `mcpLogPush` 关于"这一跳不许丢字段"的说明。
var _mcpAiSend = null;

function mcpLogSchedule() {
    if (_mcpLogTimer) return;
    _mcpLogTimer = setTimeout(function() {
        _mcpLogTimer = null;
        mcpLogFlush();
    }, _mcpLogFlushMs);
}

function mcpLogFlush() {
    if (!_mcpLogPending.length) return;
    var batch = _mcpLogPending;
    _mcpLogPending = [];
    var drops = _mcpLogDropByCh;
    _mcpLogDropByCh = {};
    // **一批都不许丢**：老实现是 `batch.slice(batch.length - 200)` —— 只发最后 200 条，
    // 其余静默丢掉且不计数。定时器被浏览器节流（后台窗口 ≥1s）时队列能攒到 2000 条，
    // 于是一次丢掉 1800 条、而 Rust 侧的 dropped 仍是 0 → AI 被明确告知"日志是完整的"。
    // 现在按单批上限拆成多批**按顺序**发（invoke 按调用顺序到达，seq 不会乱）。
    var chunks = [];
    while (batch.length) chunks.push(batch.splice(0, _mcpLogBatchMax));
    for (var i = 0; i < chunks.length; i++) {
        var payload = { lines: chunks[i] };
        if (i === 0) payload.droppedByChannel = drops;   // 丢弃计数跟第一批一起报
        invoke('log_push_batch', payload).catch(function() {});
    }
}

/// 推一条到日志中心（前端侧）。
///
/// `src` 是**来源**：`'ai'` = 这次动作是 AI 通过 MCP 工具触发的，`'ui'` = 用户手动，
/// 省略 = 不标。它要一路穿到 Rust 的 `LogHub`（`log_push_batch` → `push_src`）——
/// **中间任何一跳漏掉这个字段，功能就静默失效**（前端标了、后端存成"未标记"，
/// 而两边的单测各自都是绿的，见 AGENTS #9）。
function mcpLogPush(channel, level, dir, text, bytes, src) {
    if (!text) return;
    // 队列也有硬上限：万一定时器被浏览器节流，不能无界堆积。
    // ⚠️ 丢最旧的那条时要**按通道记账**（少了这一步，"丢弃"就变成静默的数据丢失）。
    if (_mcpLogPending.length >= _mcpLogQueueMax) {
        var gone = _mcpLogPending.shift();
        if (gone && gone.channel) {
            _mcpLogDropByCh[gone.channel] = (_mcpLogDropByCh[gone.channel] || 0) + 1;
        }
    }
    _mcpLogPending.push({
        channel: channel,
        level: level,
        dir: dir,
        text: String(text).slice(0, 8192),
        bytes: bytes || 0,
        src: src || 'none',
    });
    mcpLogSchedule();
}

