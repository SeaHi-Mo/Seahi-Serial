/* 50-quickcmd.js —— 前端第 6 块，拆自原单文件 src/index.html（**纯搬家**；行号映射见 doc/FRONTEND_LAYOUT.md）。
   ⚠️ **普通脚本**（不是 ESM）：按 index.html 里的 <script src> 顺序加载、共享同一个全局作用域 —— 行内 onclick
   与现有函数互相调用照旧；**别改成 type="module"**（模块作用域会让它们全部失效）。 */
/* ===== 快速指令（监控输出区最右侧的可折叠分栏，默认折叠） =====
   只占输出区那一行的高度（.mon-body），不跨越上方工具栏与下方发送栏。
   折叠态按用户要求不放图标、文字，也不放小三角：整条只有一根主题色细握把
   （悬停点亮、展开态常亮），方向靠"这栏是开还是关"本身表达；可发现性靠 title 提示。 */

/// 循环发送开关的两个提示（HTML 初态与 JS 切换态共用，避免两处文案漂移）
var QCMD_LOOP_TITLE_OFF = '循环发送已关闭：点击开启（顺序号大于 0 的指令按数字从小到大依次发送）';
var QCMD_LOOP_TITLE_ON  = '循环发送进行中：点击停止';

/// 列标题里那四格（纯静态文案）。单独拆出来是因为 rebuildQcmdList 要**逐个组建元素**：
/// 直接 `el.innerHTML = '<div class="qcmd-cols">…</div>'` 在真实浏览器里没问题，
/// 但在无头断言用的假 DOM 里 innerHTML 不解析 → 拿不到那个 .qcmd-cols 元素（断言就测不到它）。
/// ⚠️ `＋ 添加` **不在**这里：它要绑到"这一组"，由 rebuildQcmdList 建成真元素后挂到这一行的最右
/// （用户 2026-09 要求："＋添加 按钮应该放在 顺序、指令那一栏最右侧"）。
function qcmdColsInnerHtml() {
    return '<span class="qcmd-col-seq">顺序</span>' +
        '<span class="qcmd-col-val">指令</span>' +
        '<span class="qcmd-col-delay" title="超时（毫秒）：这条发出去最多等多久 —— 等到 OK 发下一条；等到 ERROR 重发本条（默认最多 3 次）；等满这个时间还没等到 OK 就终止整条循环。填 0 = 这条不等响应（连续 HEX 帧等）">超时' +
            '<span class="qcmd-col-unit">(ms)</span></span>' +
        '<span class="qcmd-col-hex" title="本条按 HEX 格式发送（默认关闭）">HEX</span>';
}

/// 一整行列标题的 HTML（id 带组号 —— 每组一张表，各自一份表头，id 不能撞）
function qcmdColsHtml(mid, gid) {
    return '<div class="qcmd-cols" id="' + mid + '-qcmdCols-' + gid + '">' + qcmdColsInnerHtml() + '</div>';
}

/* ===== 循环组：一个监视器可以有多组，循环按"组的上下顺序 → 组内顺序号"从上往下走 =====
   每条指令自己的配置（顺序号 / 延时 / HEX / 内容）**一律不变**（用户 2026-09 明确要求）；
   组只是把这些指令分了段，段的上下顺序可以**拖动**调整 —— 拖到最上面的那组就是循环起点，
   走完最后一组回到最上面那组。组的名字可以重命名（抬头左侧那个输入框）。 */
var QCMD_GROUP_DEFAULT_NAME = '循环 1';

function qcmdNewGroupId() {
    return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/// 监视器的组列表。老配置里只有扁平的 `quickCmds` → 现场包成一组（迁移；
/// 下一次保存配置才会写成 `quickGroups`，老字段不再写）
function qcmdGroups(mid) {
    var m = monitors[mid];
    if (!m) return [];
    if (!m.quickGroups || !m.quickGroups.length) {
        m.quickGroups = [{ id: qcmdNewGroupId(), name: QCMD_GROUP_DEFAULT_NAME,
                           items: (m.quickCmds || []) }];
    }
    m.quickGroups.forEach(function(g) {
        if (!g.id) g.id = qcmdNewGroupId();
        if (!g.name) g.name = QCMD_GROUP_DEFAULT_NAME;
        if (!g.items) g.items = [];
    });
    return m.quickGroups;
}

/// 某一格控件的 id（组会变 → id 必须带组号，否则两组的下标会撞）。
/// 单独成函数：MCP 的 quickList 要把这些 id 告诉 AI（它想用 ui_set 直接改某格时不用猜）
function qcmdItemElId(mid, gid, idx, suffix) {
    return mid + '-qcmdi-' + gid + '-' + idx + (suffix ? '-' + suffix : '');
}

/* ===== MCP 复用的一组小工具（AI 侧的 quick* 动作全走这里，不另写一套） ===== */

/// 循环发送的前置检查：返回拒绝原因（null = 可以开）。
/// **面板那颗开关与 MCP 的 quickLoop 共用这一份文案** —— 两处各写一套，迟早出现提示不一致。
function qcmdLoopRefusal(mid) {
    var m = monitors[mid];
    if (!m) return '没有这个分栏';
    if (!m.isConnected) return '还没打开监控：先连上串口，再开循环发送';
    if (!qcmdLoopPlan(mid).length) {
        return '没有顺序号大于 0 的指令：先在每条左侧的方框里填 1、2、3…（0 = 不参与），'
             + '或者某一组被"参与开关"关掉了';
    }
    return null;
}

/// 组引用 → 组对象。ref 可以是组序号（0 起，见 quickList 的 groups[].index）、组名或组 id；
/// 认不出来返回 null —— **不猜**（猜错就是删错组）
function qcmdResolveGroup(mid, ref) {
    var list = qcmdGroups(mid);
    if (ref === undefined || ref === null || ref === '') return null;
    if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
        var i = parseInt(ref, 10);
        return (i >= 0 && i < list.length) ? list[i] : null;
    }
    var key = String(ref);
    for (var k = 0; k < list.length; k++) {
        if (list[k].id === key || (list[k].name || '') === key) return list[k];
    }
    return null;
}

/// 摊平下标 → 条目（与 quickList 的 items[].index 同一套口径）
function qcmdResolveItem(mid, index) {
    var i = parseInt(index, 10);
    var flat = qcmdAllItems(mid);
    if (!(i >= 0 && i < flat.length)) return null;
    return flat[i];
}

/// 把 {value,seq,timeoutMs,expect,retry,hex} 落到某一条上。**走用户手点那条路**：交给 `mcpWriteEl`
/// （写真实输入框 + 派发 input/change；hex 是按钮 → 状态不一致才点它），
/// 所以界面、模型、配置文件三者不会各说各话。控件不在时退回直接改模型 + 重建列表。
/// 返回真正改动的字段名（空数组 = 没给任何字段）。
function qcmdApplyItemPatch(mid, gid, idx, patch) {
    var applied = [];
    var it = qcmdItemAt(mid, gid, idx);
    if (!it) return applied;
    var put = function(suffix, kind, val) {
        var el = document.getElementById(qcmdItemElId(mid, gid, idx, suffix));
        if (el && el.value !== undefined) { mcpWriteEl(el, kind, val); return true; }
        return false;
    };
    if (patch.value !== undefined) {
        // 兜底夹取：任何入口都不许把超长内容写进内存 —— 走 MCP 的两个分支已经提前报错了，
        // 这里是防"以后新加的调用方忘了判"（写进去也活不过一次重载：读入端会截断，写回时就永久丢了尾部）。
        var vNew = String(patch.value);
        if (vNew.length > QCMD_FILE_MAX_VALUE) vNew = vNew.slice(0, QCMD_FILE_MAX_VALUE);
        if (!put('val', 'text', vNew)) it.value = vNew;
        applied.push('value');
    }
    if (patch.seq !== undefined) {
        var sq = String(Math.max(0, Math.min(QCMD_SEQ_MAX, parseInt(patch.seq, 10) || 0)));
        if (!put('seq', 'text', sq)) it.seq = parseInt(sq, 10);
        applied.push('seq');
    }
    if (patch.timeoutMs !== undefined || patch.delayMs !== undefined) {
        // ⚠️ `delayMs` 是历史拼写：这一项的语义已经变成「超时」，但仍然认它
        // （直接改名会让按旧写法调用的人静默失效 —— 那比报错危险得多）
        var rawTo = patch.timeoutMs !== undefined ? patch.timeoutMs : patch.delayMs;
        var t = String(qcmdItemTimeout({ timeout: parseInt(rawTo, 10) }));
        if (!put('delay', 'text', t)) it.timeout = parseInt(t, 10);
        applied.push('timeoutMs');
    }
    if (patch.expect !== undefined) {
        // 「期望」面板上没有入口（写在文件表头声明的列里）→ 直接改模型，再由写回落到文件
        it.expect = String(patch.expect == null ? '' : patch.expect).trim().slice(0, QCMD_EXPECT_MAX);
        applied.push('expect');
    }
    if (patch.retry !== undefined) {
        var rv = parseInt(patch.retry, 10);
        it.retry = Math.max(0, Math.min(QCMD_RETRY_MAX, isFinite(rv) ? rv : QCMD_RETRY_DEFAULT));
        applied.push('retry');
    }
    // 跳转两列（面板上没有入口，写在文件里）：值按归一化后的口径落模型
    // （'' = 下一条 / 'end' = 结束 / '数字' = 顺序号）；不认得的值一律落成"下一条"并如实回报
    if (patch.okGoto !== undefined) {
        it.okgoto = qcmdGotoNorm(patch.okGoto);
        applied.push('okGoto');
    }
    if (patch.errGoto !== undefined) {
        it.errgoto = qcmdGotoNorm(patch.errGoto);
        applied.push('errGoto');
    }
    if (patch.hex !== undefined) {
        var hb = document.getElementById(qcmdItemElId(mid, gid, idx, 'hex'));
        if (hb) mcpWriteEl(hb, 'toggle', !!patch.hex); else it.hex = !!patch.hex;
        applied.push('hex');
    }
    if (!applied.length) return applied;
    // 改了 期望/重试 之后，超时那一格的描边与悬停说明要跟着变（它是这两项唯一的可见出口）
    var tEl = document.getElementById(qcmdItemElId(mid, gid, idx, 'delay'));
    if (tEl) { tEl.title = qcmdTimeoutTitle(it); syncQcmdTimeoutMark(tEl, it); }
    if (!document.getElementById(qcmdItemElId(mid, gid, idx, 'val'))) rebuildQcmdList(mid);
    scheduleConfigSave();
    scheduleQcmdFileSave(mid);      // 文件即存储：改了内容就写回
    return applied;
}

/// 把某一组挪到第 to 位（**拖动排序与 MCP 的 quickGroup/move 共用这一条路**）：
/// 模型换位 + 文件里那段表跟着挪 + DOM 按新顺序重排（带 FLIP 动画）
function qcmdMoveGroup(mid, gid, to) {
    var list = qcmdGroups(mid);
    var from = qcmdGroupIndex(mid, gid);
    if (from < 0) return false;
    var toIdx = parseInt(to, 10);
    // 非法目标（NaN / 非数字）**什么都不做**并返回 false：原来 `Math.min(n, NaN)` 恒为 NaN，
    // 再 `Math.max(0, NaN)` 还是 NaN，`splice(NaN, 0, …)` 会被当成 0 —— 于是"参数写错"
    // 静默变成了"把这组挪到最前面"（最上面那组是循环起点，后果不是纯视觉的）。2026-09 审计发现。
    if (isNaN(toIdx)) return false;
    to = Math.max(0, Math.min(list.length - 1, toIdx));
    if (to === from) return true;
    qcmdReorderBoxes(mid, function() {
        var moved = list.splice(from, 1)[0];
        list.splice(to, 0, moved);
        qcmdMoveGroupBlocks(mid, gid, to);
        list.forEach(function(g) {
            var b = document.getElementById(mid + '-qcmdGbox-' + g.id);
            if (b) document.getElementById(mid + '-qcmdList').appendChild(b);
        });
    });
    scheduleConfigSave();
    scheduleQcmdFileSave(mid);
    if (monitors[mid] && monitors[mid].qcmdLoop) qcmdLoopSyncPlan(mid);
    return true;
}

/// 显式设置某一组的折叠状态（MCP 的 quickGroup/fold 用；面板那颗箭头走 toggle）
function setQcmdGroupFold(mid, gid, on) {
    var g = qcmdGroupById(mid, gid);
    if (!g) return false;
    if (!!g.folded === !!on) return true;
    toggleQcmdGroupFold(mid, gid);
    return true;
}

function qcmdGroupById(mid, gid) {
    var list = qcmdGroups(mid);
    for (var i = 0; i < list.length; i++) if (list[i].id === gid) return list[i];
    return null;
}

function qcmdGroupIndex(mid, gid) {
    var list = qcmdGroups(mid);
    for (var i = 0; i < list.length; i++) if (list[i].id === gid) return i;
    return -1;
}

/// 某一组是否参与循环发送（缺省参与）。关掉 = 整组跳过，**不动文件里的顺序号**
/// （开关状态跟 `folded` 一样存在 config.json 里；文件里没有"组级开关"这一列，硬塞会破坏表结构）
function qcmdGroupOn(g) { return !(g && g.on === false); }

/// 摊平所有组的条目（组序 = 上下顺序；组内保持原下标）。TAB 补全 / MCP 列表 / 循环计划都用它
function qcmdAllItems(mid) {
    var out = [];
    qcmdGroups(mid).forEach(function(g, gi) {
        (g.items || []).forEach(function(it, ii) { out.push({ gid: g.id, group: g, gi: gi, it: it, ii: ii }); });
    });
    return out;
}

function qcmdSideHtml(mid) {
    // 监视器窗格与 WSL 监视器共用这一份，避免两处 HTML 漂移。
    // 折叠条同时是"展开/收起"的按钮和"调宽"的拖拽手柄（mousedown 起拖，位移 <3px 仍算点击）。
    return '<div class="qcmd-side" id="' + mid + '-qcmdSide">' +
        '<button class="qcmd-side-tab" id="' + mid + '-btnQcmdSide"' +
            ' onclick="toggleQcmdSide(\'' + mid + '\')"' +
            ' onmousedown="startQcmdSideDrag(event,\'' + mid + '\')"' +
            ' title="展开快速指令"></button>' +
        '<div class="qcmd-side-body">' +
            '<div class="qcmd-side-hd">' +
                // 左边是状态（循环发送开关），右边是动作（新建循环组 / 导入 / 导出）。
                // 「＋ 添加」不再在这里：它属于**某个组**，所以挪到每个组的抬头里去了。
                '<button class="qcmd-dh-loop" id="' + mid + '-btnQcmdLoop"' +
                    ' onclick="toggleQcmdLoop(\'' + mid + '\')"' +
                    ' title="' + QCMD_LOOP_TITLE_OFF + '">循环发送</button>' +
                '<span class="qcmd-hd-acts">' +
                    '<button class="qcmd-dh-add" id="' + mid + '-btnQcmdGroupAdd"' +
                        ' onclick="addQcmdGroup(\'' + mid + '\')"' +
                        ' title="新建一个循环组（追加到最下面，默认带 1 条空指令）">＋ 新建循环组</button>' +
                    '<button class="qcmd-dh-add" id="' + mid + '-btnQcmdImport" onclick="qcmdImportFile(\'' + mid + '\')" title="从文件加载指令列表（加载后增删改都会写回该文件）">导入</button>' +
                    '<button class="qcmd-dh-add" id="' + mid + '-btnQcmdExport" onclick="qcmdExportFile(\'' + mid + '\')" title="把当前列表另存为一份文件（Markdown 表格 / TSV）">导出</button>' +
                '</span>' +
            '</div>' +
            '<div class="qcmd-side-src" id="' + mid + '-qcmdSrc" style="display:none;"></div>' +
            // 列标题行放在列表**里面**（sticky 钉顶）：它跟数据行共享同一个滚动容器，
            // 出滚动条时两边的分隔线才等长（见 .qcmd-cols 的注释）。
            // 所有组共用这一行列标题（列是同一套），组与组之间靠抬头分隔。
            // 列标题**不在这里**：每组自带一张表的表头（见 rebuildQcmdList），跟文件里"一组一张表"完全对应
            '<div class="qcmd-list" id="' + mid + '-qcmdList"></div>' +
        '</div>' +
    '</div>';
}

/// 侧栏是否展开（纯读，便于无头断言）
function qcmdSideOpen(mid) {
    var side = document.getElementById(mid + '-qcmdSide');
    return !!(side && side.classList.contains('open'));
}

/* 分栏宽度：拖折叠条调节，按监视器各记一份，随配置持久化（缺省 300px：一条六格要放得下）。
   **最小宽度 = 缺省宽度 300px**（用户 2026-09 要求"最小宽度以当前的宽度为准"）：六格在更窄的栏里
   会挤成一团（内容框只剩几十像素），不如干脆别让人拖到那么窄。
   上限**跟着窗格走**（`QCMD_SIDE_MAX_RATIO` × 窗格宽度），并与"给输出区留 `QCMD_SIDE_RESERVE`"
   取更严的那个 —— 原来是写死的 640px：窗口拉到 2000 多也拖不过 640（用户 2026-09 的反馈）。
   ⚠️ 口径与 CSS 里 `.qcmd-side.open` 的 `min-width:300px` / `max-width:min(60%, calc(100% - 160px))`
   **必须一致**：CSS 那两条是兜底（分栏在隐藏页里被恢复宽度时量不到窗格宽度），改一处必须改另一处。 */
var QCMD_SIDE_DEFAULT = 300, QCMD_SIDE_MIN = 300;
var QCMD_SIDE_MAX_RATIO = 0.6;   // 侧栏最多占窗格宽度的 60%
var QCMD_SIDE_RESERVE = 160;     // 同时永远给输出区留 160px

function qcmdSideWidth(mid) {
    var m = monitors[mid];
    return (m && m.qcmdSideWidth) ? m.qcmdSideWidth : QCMD_SIDE_DEFAULT;
}

function setQcmdSideWidth(mid, w) {
    var side = document.getElementById(mid + '-qcmdSide');
    if (!side) return 0;
    var body = side.parentElement;                      // .mon-body：宽度 = 窗格可用宽度
    var avail = (body && body.clientWidth) ? body.clientWidth : 0;
    w = Math.max(QCMD_SIDE_MIN, Math.round(w || 0));
    if (avail > 0) {
        var max = Math.min(Math.round(avail * QCMD_SIDE_MAX_RATIO), avail - QCMD_SIDE_RESERVE);
        w = Math.min(w, Math.max(QCMD_SIDE_MIN, max));
    }
    // avail=0（分栏在还没显示的那一页里）：照单收下 —— 不去悄悄改用户存下来的宽度，
    // 视觉溢出交给 CSS 的 max-width 兜住
    side.style.setProperty('--qcmd-side-w', w + 'px');  // CSS：.qcmd-side.open { width: var(--qcmd-side-w, 300px) }
    if (monitors[mid]) monitors[mid].qcmdSideWidth = w;
    return w;
}

/// 展开/收起快速指令分栏（默认折叠，不持久化：每次打开监视器都从折叠开始）
function setQcmdSideOpen(mid, open) {
    var side = document.getElementById(mid + '-qcmdSide');
    if (!side) return;
    open = !!open;
    if (open) setQcmdSideWidth(mid, qcmdSideWidth(mid));   // 展开时套回用户调过的宽度
    side.classList.toggle('open', open);
    var tab = document.getElementById(mid + '-btnQcmdSide');
    if (!tab) return;
    tab.classList.toggle('on', open);                 // 展开态：整条填主题蓝（CSS .on）
    tab.title = qcmdSideTabTitle(mid, open);
}

/* 拖折叠条调宽：往左拖 = 变宽（分栏贴在右边缘）。
   位移小于 3px 视为点击（交给 onclick 去展开/收起），松手后短暂屏蔽 click，
   免得"拖完顺手把刚调好的分栏又收起来"。 */
var _qcmdDrag = null, _qcmdDragMovedAt = 0;

function startQcmdSideDrag(e, mid) {
    if (!e || e.button !== 0) return;
    var side = document.getElementById(mid + '-qcmdSide');
    if (!side || !side.classList.contains('open')) return;   // 折叠态：点一下就是展开，不进入拖动
    e.preventDefault();
    _qcmdDrag = { mid: mid, x: e.clientX, w: side.offsetWidth, moved: false };
    side.classList.add('dragging');
    document.addEventListener('mousemove', onQcmdSideDragMove);
    document.addEventListener('mouseup', endQcmdSideDrag);
}

function onQcmdSideDragMove(e) {
    if (!_qcmdDrag) return;
    var side = document.getElementById(_qcmdDrag.mid + '-qcmdSide');
    if (!side) return;
    var dx = e.clientX - _qcmdDrag.x;
    if (Math.abs(dx) > 3) _qcmdDrag.moved = true;
    setQcmdSideWidth(_qcmdDrag.mid, _qcmdDrag.w - dx);
}

function endQcmdSideDrag() {
    if (!_qcmdDrag) return;
    var mid = _qcmdDrag.mid;
    var side = document.getElementById(mid + '-qcmdSide');
    if (side) side.classList.remove('dragging');
    if (_qcmdDrag.moved) _qcmdDragMovedAt = Date.now();
    document.removeEventListener('mousemove', onQcmdSideDragMove);
    document.removeEventListener('mouseup', endQcmdSideDrag);
    _qcmdDrag = null;
    scheduleConfigSave();                              // 宽度随配置保留
}

function toggleQcmdSide(mid) {
    // 刚拖完调宽就松手会补一个 click：这一次不算"点击"，否则会顺手把刚调好的分栏收起来
    if (Date.now() - _qcmdDragMovedAt < 300) return;
    setQcmdSideOpen(mid, !qcmdSideOpen(mid));
}

/* ===== 快速指令外部文件：解析 / 生成（纯函数，便于无头断言） =====
   语义：**文件就是列表的存储** —— 导入后面板里的增删改都写回它，不再有两份真相。
   支持三种载体（读取时自动识别，写回时保持原样）：
     · Markdown 表格： | 名称 | 指令 |        （单元格内的竖线按规范写 \|）
     · TSV：          名称 <TAB> 指令
     · 纯指令行：      一行一条指令（没有名称列，名称取指令本身）
   ⚠️ 刻意**不按逗号切分**：AT 指令里逗号是常态（AT+CWJAP="ssid","pass"），
      按 CSV 切必然把一条指令切碎。文件名可以叫 .csv，读进来也是"整行一条指令"。
   注释（# / // 开头）与空行**按原位置原样保留**：文件在内存里是块序列（raw / item），
   增删改只动 item 块 —— 手写文件里的说明、分节、额外列都不会被写回时抹掉。

   ==== 顺序号 / 延时 / HEX 怎么进文件（表头驱动，2026-09）====
   **只认表头写了列名的列**：`| 名称 | 指令 | 顺序号 | 延时(ms) | HEX |` 这样的表头一出现，
   这一列就被当作该参数解析、并写回同一列；**没有表头的文件一律按老规矩**（第 1 列名称、
   第 2 列指令、第 3 列起是用户的备注，原样保留）。绝不按列号硬塞 —— 那会把用户写在
   第 3 列的「备注甲」读成顺序号、再改写成 `0`（真丢数据）。
   写回挂载文件时**不擅自补列**（用户的表结构由用户定）；需要一份自包含的三列文件时用「导出」：
   导出的是副本，一律补全这三列（纯指令行载体放不下 → 升级成 Markdown 表格并提示）。 */

var QCMD_FILE_MAX_ITEMS = 500;     // 与后端/文档一致的条目上限
var QCMD_FILE_MAX_LABEL = 64;      // 名称上限（字符）
var QCMD_FILE_MAX_VALUE = 4096;    // 单条指令上限（字符）

// 一个分栏里**指令条目总数**（跨组摊平）—— 与文件读入端 500 条的上限同一个口径。
function qcmdItemTotal(mid) {
    return (typeof qcmdAllItems === 'function') ? qcmdAllItems(mid).length : 0;
}

// 指令内容长度检查：返回错误文案；没问题返回 null。
//
// 为什么**写入口也要拦**（不只是读入端截断）：文件读入时超过 4096 字符会被截断/跳过，
// 而写回端一个字都不截 —— 于是"内存里 1 万字符 → 重载被截到 4096 → 下一次写回用截断后的
// 模型整份覆盖文件"会把尾巴永久丢掉（用户数据不可逆）。所以宁可在这里明确报错。
function qcmdValueTooLong(v) {
    if (v === undefined || v === null) return null;
    var s = String(v);
    if (s.length <= QCMD_FILE_MAX_VALUE) return null;
    return '指令内容太长：' + s.length + ' 字符，上限 ' + QCMD_FILE_MAX_VALUE
         + ' 字符（外部文件也按这个上限读回）。请拆成多条。';
}

/// Markdown 表格行 → 单元格数组（单元格内的 \| 先藏起来再切分）
function qcmdMdCells(line) {
    var t = String(line == null ? '' : line).trim();
    if (t.charAt(0) === '|') t = t.slice(1);
    if (t.charAt(t.length - 1) === '|') t = t.slice(0, -1);
    var PH = '\u0000';
    t = t.replace(/\\\|/g, PH);
    return t.split('|').map(function(c) { return c.split(PH).join('|').trim(); });
}

/* 表头列名 → 列的含义。别名表**刻意收窄**：像 `编号`/`no`/`num`/`index` 这种
   很可能是用户自己的 ID 列，认成顺序号就会把 `A1` 改写成 `0` —— 宁可少认，不可乱认。
   ⚠️ `delay` 那一行是**旧名**：这一列以前是"延时"（发完等多久再发下一条），
   现在按**超时**解读（发完最多等多久）—— 面板上那一格也早就改叫「超时」了。
   两列同时存在时 `timeout` 优先；只写了旧名时仍能读，并在导入时提示一次。 */
var QCMD_COL_ALIASES = {
    name:  ['名称', '名字', '标签', '指令名', 'name', 'label', 'title'],
    value: ['指令', '命令', '内容', '指令内容', '发送内容', 'cmd', 'command', 'value', 'data'],
    seq:   ['顺序号', '顺序', '序号', '次序', '序', 'order', 'seq', 'sequence'],
    timeout: ['超时', '超时时间', '超时毫秒', '等待', '等待时间', 'timeout', 'wait'],
    delay: ['延时', '延迟', '延时时间', '延时毫秒', '间隔', 'delay', 'interval', 'ms', 'delayms'],
    expect: ['期望', '期望值', '响应词', '成功词', 'expect'],
    retry: ['重试', '重试次数', 'retry', 'retries'],
    // 跳转（分支与循环）：取值 = 空/`下一条`（缺省）、数字（**顺序号**）、`结束`
    okgoto: ['成功跳转', '成功后', '成功', 'ok跳转', 'okgoto', 'success', 'onsuccess'],
    errgoto: ['失败跳转', '失败后', '失败', 'err跳转', 'errgoto', 'fail', 'onfail', 'ongoto'],
    hex:   ['hex', 'hex开关', '十六进制', '格式', 'format', 'mode']
};

/// 表头单元格 → 列名 key（先把大小写、空格、`(ms)` 这类括注抹平再比）
function qcmdColKey(cell) {
    var t = String(cell == null ? '' : cell).toLowerCase()
        .replace(/[（(][^）)]*[）)]/g, '')
        .replace(/[\s:：*`]/g, '');
    if (!t) return '';
    var keys = Object.keys(QCMD_COL_ALIASES);
    for (var i = 0; i < keys.length; i++) {
        if (QCMD_COL_ALIASES[keys[i]].indexOf(t) >= 0) return keys[i];
    }
    return '';
}

/// 表头行 → {name:0, value:1, seq:2, …}（认不出就不是表头 → null）
/// 判定分三档：① 认出 ≥2 个列名 → 表头；② 只认出 1 个，但**第一格**就是 名称/指令
/// （老规矩 `| 指令 | 编号 |`、`| 名称 | 备注 |` 都算表头）或整行只有一格 → 表头；
/// ③ 其余（如 `| order | AT+X |` 这种正常数据行）→ 不是表头。
function qcmdHeaderMap(cells) {
    var map = {}, hit = 0;
    (cells || []).forEach(function(c, i) {
        var k = qcmdColKey(c);
        if (k && map[k] === undefined) { map[k] = i; hit++; }
    });
    if (hit >= 2) return map;
    if (hit !== 1) return null;
    var first = qcmdColKey(cells[0]);
    if (first === 'name' || first === 'value') return map;
    return cells.length === 1 ? map : null;
}

/// 「超时」列在表头里的下标：新名 `超时` 优先，旧名 `延时` 兜底（两个都没声明 = undefined）。
/// 面板上那一格只有一列，所以文件里也只认一列 —— 两列都写时以「超时」为准。
function qcmdTimeoutColIndex(cols) {
    if (!cols) return undefined;
    return cols.timeout !== undefined ? cols.timeout : cols.delay;
}

/// `|---|---|` 这种 Markdown 分隔行
function qcmdIsSeparatorRow(cells) {
    return !!(cells && cells.length) && cells.every(function(c) {
        return /^:?-{2,}:?$/.test(c) || c === '';
    });
}

/// 该跳过的"结构行"：Markdown 分隔行与表头行（写回时原样保留）
function qcmdIsStructureRow(cells) {
    if (!cells.length) return true;
    return qcmdIsSeparatorRow(cells) || qcmdHeaderMap(cells) !== null;
}

/// 单元格 → 整数（认不出就用缺省；不把用户的怪值带进模型）
function qcmdCellInt(s, dflt) {
    var t = String(s == null ? '' : s).trim();
    if (!t) return dflt;
    var m = /-?\d+/.exec(t.replace(/,/g, ''));
    return m ? parseInt(m[0], 10) : dflt;
}

var QCMD_HEX_TRUE = ['hex', '16', '1', 'true', 'yes', 'on', '是', '√', '十六进制', 'hexadecimal'];

/// 单元格 → HEX 开关（空白 / 无法识别一律当"关"）
function qcmdCellHex(s) {
    return QCMD_HEX_TRUE.indexOf(String(s == null ? '' : s).trim().toLowerCase()) >= 0;
}

/// front matter 里这些 key 看起来"应该改变发送行为"，但本版只在面板上生效 ——
/// 明确告知用户，别让他以为写了 baud/mode 就生效了（文档里的格式说明也用同一套口径）
/// 注意：`delay`/`hex` 现在是**每条自己的设置**（写在表头声明的列里），文件头这一层仍不解释。
var QCMD_FRONT_UNSUPPORTED = ['baud', 'mode', 'lineending', 'line-ending', 'line_ending', 'delay', 'expect', 'timeout', 'hex'];

/// 文本 → {blocks, items, skipped, style, cols, frontKeys, frontUnclosed}
///   blocks：raw（注释/空行/表头/坏行/文件头，原样保留）与 item（指向 items 里的同一个对象）
///   cols：表头声明的列映射（没有表头就是 null）
///   skipped：[{line, reason}]，行号从 1 开始（坏行跳过但**不丢**：仍以 raw 保留在文件里）
function qcmdParseText(text) {
    var src = String(text == null ? '' : text);
    var lines = src.split(/\r?\n/);
    var blocks = [], items = [], skipped = [], style = '';
    var frontKeys = [], frontUnclosed = false, frontEnd = -1, colMap = null;
    // 组：文件里"一张表 = 一组"。没有 `## 抬头` 的老文件就是**隐含的一组**（名字留空，
    // 由面板给个默认名 —— 老文件因此一字不动）
    var groups = [{ key: 0, name: '', cols: null, items: [] }];
    var curGroup = 0;
    var legacyTimeoutCol = false;    // 文件里那一列用的是旧名「延时」→ 导入时提示一次
    var customCondCount = 0;         // 有自定义「期望 / 重试」的条数（面板不显示它们 → 也要说一声）
    var gotoUnknown = 0;             // 跳转列里写了认不出来的值的次数（同样要提示一次）
    var gotoCount = 0;               // 写了跳转（成功/失败任一）的条数
    // 文件头（YAML / TOML 风格的 front matter）：首行是 --- 或 +++ 时，直到配对收尾行都原样保留。
    // 不做这一步，`baud: 115200` 这种没有分隔符的行会被当成一条"指令"混进列表（2026-09 实测踩到）。
    var head = lines.length ? lines[0].trim() : '';
    if (head === '---' || head === '+++') {
        var closers = head === '---' ? ['---', '...'] : ['+++'];
        for (var k = 1; k < lines.length; k++) {
            if (closers.indexOf(lines[k].trim()) >= 0) { frontEnd = k; break; }
        }
        if (frontEnd < 0) {
            // 没有配对的收尾：**只当第一行是头部**，正文照常解析
            // （不能整份吞掉 —— 以 --- 开头的普通 Markdown 也可能只是条水平线）
            frontEnd = 0;
            frontUnclosed = true;
        }
        for (var j = 1; j < frontEnd; j++) {
            var mk = /^\s*([A-Za-z_][\w.-]*)\s*[:=]/.exec(lines[j]);
            if (mk) frontKeys.push(mk[1].toLowerCase());
        }
    }
    for (var i = 0; i < lines.length; i++) {
        var raw = lines[i], t = raw.trim();
        if (i <= frontEnd) { blocks.push({ kind: 'raw', text: raw }); continue; }
        // 组抬头：**两个及以上 `#`** 开头的一行 = 一个组，名字取 `#` 后面的文字。
        // ⚠️ 必须写在下面的注释判断**之前** —— 否则 `## 循环 1` 会被当注释吞掉
        // （单个 `#` 仍是注释，原样保留）。文件里"每一组就是一张自己的表"就靠它分隔。
        var hm2 = /^#{2,}\s*(.*)$/.exec(t);
        if (hm2) {
            var gname = hm2[1].trim().slice(0, QCMD_FILE_MAX_LABEL);
            // 文件一开头就是抬头：把那个"隐含的空组"顶掉，别多出一个没名字的空组
            if (groups.length === 1 && !groups[0].name && !groups[0].items.length) {
                groups[0].name = gname;
                curGroup = 0;
            } else {
                groups.push({ key: groups.length, name: gname, cols: null, items: [] });
                curGroup = groups.length - 1;
            }
            colMap = null;                     // 组换了 → 列映射重新认（每组一张表，表头各自声明）
            if (!style) style = 'md';
            blocks.push({ kind: 'raw', text: raw, heading: true, group: curGroup });
            continue;
        }
        if (t === '' || t.charAt(0) === '#' || t.slice(0, 2) === '//') { blocks.push({ kind: 'raw', text: raw }); continue; }
        var cells, thisStyle;
        if (t.charAt(0) === '|') { cells = qcmdMdCells(t); thisStyle = 'md'; }
        else if (t.indexOf('\t') >= 0) { cells = t.split('\t').map(function(c) { return c.trim(); }); thisStyle = 'tsv'; }
        else { cells = [t]; thisStyle = 'lines'; }
        if (qcmdIsStructureRow(cells)) {
            var hm = qcmdHeaderMap(cells);
            if (hm) { colMap = hm; groups[curGroup].cols = hm; }   // 表头声明了列 → 之后的数据行（本组内）按它解析
            blocks.push({ kind: 'raw', text: raw });
            continue;
        }
        // 列映射：表头说了算；没表头就是老规矩（第 1 列名称、第 2 列指令、其余是备注）
        var cols = colMap;
        if (!cols) cols = cells.length >= 2 ? { name: 0, value: 1 } : { value: 0 };
        // 表头声明了名称/指令列，但这一行短得够不到指令列（手写文件里常见）→ 按"只有一列"读
        if (cols.value === undefined || cells.length <= cols.value) {
            cols = { value: 0 };
        }
        var label = cols.name !== undefined && cells.length > cols.name ? (cells[cols.name] || '') : '';
        var value = cells.length > cols.value ? (cells[cols.value] || '') : '';
        // 这一行算不算"一条指令"：名称/内容有值，**或者**表头声明的参数格里有值（哪怕只是 `0` / `1000`）。
        // 只看名称+内容的话，`|  | 0 | 1000 | text |` 这种"还没填内容的指令行"会被丢掉 ——
        // 导出的文件再导入就少几条，与面板对不上（用户 2026-09 报的"文件与前端对不上"）。
        var cellFilled = function(i) {
            return i !== undefined && cells.length > i && String(cells[i] == null ? '' : cells[i]).trim() !== '';
        };
        if (!label && !value && !cellFilled(cols.seq) && !cellFilled(qcmdTimeoutColIndex(cols))
            && !cellFilled(cols.hex) && !cellFilled(cols.expect) && !cellFilled(cols.retry)
            && !cellFilled(cols.okgoto) && !cellFilled(cols.errgoto)) {
            blocks.push({ kind: 'raw', text: raw }); continue;
        }
        if (items.length >= QCMD_FILE_MAX_ITEMS) {
            skipped.push({ line: i + 1, reason: '超过 ' + QCMD_FILE_MAX_ITEMS + ' 条上限' });
            blocks.push({ kind: 'raw', text: raw }); continue;
        }
        if (label.length > QCMD_FILE_MAX_LABEL) {
            skipped.push({ line: i + 1, reason: '名称超长已截断（上限 ' + QCMD_FILE_MAX_LABEL + ' 字符）' });
            label = label.slice(0, QCMD_FILE_MAX_LABEL);
        }
        if (value.length > QCMD_FILE_MAX_VALUE) {
            skipped.push({ line: i + 1, reason: '指令超长已截断（上限 ' + QCMD_FILE_MAX_VALUE + ' 字符）' });
            value = value.slice(0, QCMD_FILE_MAX_VALUE);
        }
        if (!style) style = thisStyle;
        // 名称可省：只有指令时用指令本身当名称（与面板"名称/内容"两栏一致）
        var item = { label: label || value, value: value };
        // 文件**声明了**这些列才把值读进模型（没声明就留给"按内容带回本机配置"那条路）；
        // 单元格空着就**不设**（写回时也保持空，别把用户没写的缺省值硬写进他的表）
        var seqCell = cols.seq !== undefined ? cells[cols.seq] : undefined;
        var timeoutIdx = qcmdTimeoutColIndex(cols);
        var timeoutCell = timeoutIdx !== undefined ? cells[timeoutIdx] : undefined;
        var hexCell = cols.hex !== undefined ? cells[cols.hex] : undefined;
        var expectCell = cols.expect !== undefined ? cells[cols.expect] : undefined;
        var retryCell = cols.retry !== undefined ? cells[cols.retry] : undefined;
        var okGotoCell = cols.okgoto !== undefined ? cells[cols.okgoto] : undefined;
        var errGotoCell = cols.errgoto !== undefined ? cells[cols.errgoto] : undefined;
        if (seqCell !== undefined && String(seqCell).trim() !== '') {
            item.seq = Math.max(0, Math.min(QCMD_SEQ_MAX, qcmdCellInt(seqCell, 0)));
        }
        if (timeoutCell !== undefined && String(timeoutCell).trim() !== '') {
            item.timeout = Math.max(0, Math.min(QCMD_TIMEOUT_MAX, qcmdCellInt(timeoutCell, QCMD_TIMEOUT_DEFAULT)));
            // 命中的是旧列名「延时」→ 记一笔，导入时提示一次（语义变了，不能闷着改）
            if (cols.timeout === undefined) legacyTimeoutCol = true;
        }
        if (hexCell !== undefined && String(hexCell).trim() !== '') {
            item.hex = qcmdCellHex(hexCell);
        }
        if (expectCell !== undefined && String(expectCell).trim() !== '') {
            item.expect = String(expectCell).trim().slice(0, QCMD_EXPECT_MAX);
        }
        if (retryCell !== undefined && String(retryCell).trim() !== '') {
            item.retry = Math.max(0, Math.min(QCMD_RETRY_MAX, qcmdCellInt(retryCell, QCMD_RETRY_DEFAULT)));
        }
        // 跳转两列：**空着不设**（缺省就是"下一条"）；写了认不出来的，值按"下一条"落，
        // 但原字保在 cells 里（写回时原样回吐），由导入提示告诉用户哪里没被理解
        if (okGotoCell !== undefined && String(okGotoCell).trim() !== '') {
            item.okgoto = String(okGotoCell).trim().slice(0, 32);
            if (!qcmdGotoNorm(item.okgoto)) gotoUnknown++;
        }
        if (errGotoCell !== undefined && String(errGotoCell).trim() !== '') {
            item.errgoto = String(errGotoCell).trim().slice(0, 32);
            if (!qcmdGotoNorm(item.errgoto)) gotoUnknown++;
        }
        if (qcmdItemExpect(item) || item.retry !== undefined) customCondCount++;
        if (item.okgoto !== undefined || item.errgoto !== undefined) gotoCount++;
        items.push(item);
        if (groups[curGroup]) groups[curGroup].items.push(item);
        // 原始单元格 + 读进来时的参数值：写回时"没动过的格子原样回吐"就靠这两样
        blocks.push({ kind: 'item', item: item, cols: cols, cells: cells.slice(), group: curGroup,
                      orig: { seq: item.seq, timeout: item.timeout, hex: item.hex,
                              expect: item.expect, retry: item.retry,
                              okgoto: item.okgoto, errgoto: item.errgoto } });
    }
    // 摊平的 items 仍然返回（TAB 补全 / MCP 列表 / 老断言都用它）；groups 是按文件里的表分好的组
    return { blocks: blocks, items: items, groups: groups, skipped: skipped, style: style || 'md', cols: colMap,
             frontKeys: frontKeys, frontUnclosed: frontUnclosed,
             legacyTimeoutCol: legacyTimeoutCol, customCondCount: customCondCount,
             gotoUnknown: gotoUnknown, gotoCount: gotoCount };
}

/// 一行单元格 → 该载体的行文本（md 转义竖线；tsv 去掉制表符；lines 只取第一格）
function qcmdJoinRow(cells, style) {
    var clean = function(s) { return String(s == null ? '' : s).replace(/[\r\n]+/g, ' '); };
    var arr = (cells || []).map(clean);
    if (style === 'tsv') return arr.map(function(s) { return s.replace(/\t/g, ' '); }).join('\t');
    if (style === 'lines') return arr.length ? arr[0] : '';
    return '| ' + arr.map(function(s) { return s.replace(/\|/g, '\\|'); }).join(' | ') + ' |';
}

/// 参数格 → 文本。三条规则（顺序不能反）：
///   ① 用户**没动过**这一格（模型值还是读进来时那个）→ 原样写回他写的字（`0` / `是` / 空格都保留）；
///   ② 原本空着且没设过值 → 还是空（别把缺省值硬写进他的表）；
///   ③ 其余（改过值 / 面板新建的行 / 导出副本）→ 规范化成 0 / 1000 / text。
function qcmdParamCell(b, key, value, text, fill) {
    if (!fill && b.orig && b.orig[key] === value) {
        var i = (b.cols || {})[key];
        if (b.cells && i !== undefined && b.cells[i] !== undefined) return b.cells[i];
    }
    if (!fill && (value === undefined || value === null || value === '')) return '';
    return text;
}

/// item 块 → 这一行的单元格：按 cols 把当前值写回**原位**，其余列（用户的备注）一字不动。
/// cells 是读入时的原始行；没有原始行（导出/新加的条目）就按 cols 的宽度补空格。
function qcmdItemCells(b) {
    var it = b.item || {};
    var cols = b.cols || { value: 0 };
    var fill = !!b.fill;
    var cells = b.cells ? b.cells.slice() : [];
    var width = cells.length;
    Object.keys(cols).forEach(function(k) { if (cols[k] + 1 > width) width = cols[k] + 1; });
    while (cells.length < width) cells.push('');
    if (cols.name !== undefined) cells[cols.name] = String(it.label == null ? '' : it.label);
    if (cols.value !== undefined) cells[cols.value] = String(it.value == null ? '' : it.value);
    if (cols.seq !== undefined) cells[cols.seq] = qcmdParamCell(b, 'seq', it.seq, String(qcmdItemSeq(it)), fill);
    // 超时那一格：新名「超时」优先、旧名「延时」兜底 —— 写回仍然落在**用户原来那一列**里
    var timeoutIdx = qcmdTimeoutColIndex(cols);
    if (timeoutIdx !== undefined) cells[timeoutIdx] = qcmdParamCell(b, 'timeout', it.timeout, String(qcmdItemTimeout(it)), fill);
    if (cols.hex !== undefined) cells[cols.hex] = qcmdParamCell(b, 'hex', it.hex, qcmdItemHex(it) ? 'true' : 'false', fill);
    // 「期望 / 重试」面板上没有入口（它们写在文件里），但值要原样写回去，别在别的字段一改就被抹掉
    if (cols.expect !== undefined) cells[cols.expect] = qcmdParamCell(b, 'expect', it.expect, qcmdItemExpect(it), fill);
    if (cols.retry !== undefined) cells[cols.retry] = qcmdParamCell(b, 'retry', it.retry, String(qcmdItemRetry(it)), fill);
    // 跳转两列：同样面板上没有入口，值原样写回（空着就保持空 —— 缺省是"下一条"）
    if (cols.okgoto !== undefined) cells[cols.okgoto] = qcmdParamCell(b, 'okgoto', it.okgoto, it.okgoto || '', fill);
    if (cols.errgoto !== undefined) cells[cols.errgoto] = qcmdParamCell(b, 'errgoto', it.errgoto, it.errgoto || '', fill);
    return cells;
}

/// {blocks} + 载体风格 → 文本（raw 原样回吐，item 按 cols/cells 重拼）
function qcmdBuildText(blocks, style) {
    style = style || 'md';
    var out = [];
    (blocks || []).forEach(function(b) {
        if (!b || b.kind !== 'item') { out.push(b && typeof b.text === 'string' ? b.text : ''); return; }
        var cells = qcmdItemCells(b);
        // **整行都空**才跳过（而不是"名称与内容空就跳"）：表头声明了 顺序号/延时/HEX 的文件里，
        // 一条还没填内容的指令仍然占一行 —— 跳过它，导出/写回的条数就跟面板对不上
        // （用户 2026-09 报的"指令文件的内容没有和前端对应上"）。
        // 用户手写文件里那种纯空白行（所有格都空）仍然不会被写出来。
        var hasAny = cells.some(function(c) { return String(c == null ? '' : c).trim() !== ''; });
        if (!hasAny) return;
        out.push(qcmdJoinRow(cells, style));
    });
    return out.join('\r\n');
}

/* ===== 挂载：导入 / 重载 / 导出 / 断开 / 写回 ===== */

function qcmdBaseName(p) {
    var s = String(p == null ? '' : p);
    var parts = s.split(/[\\/]/);
    return parts[parts.length - 1] || s;
}

/// 从文件读入时，把"面板侧的发送参数"按指令内容带回来。
/// 表头**声明了**那几列的文件以文件为准（值已经读进 item 了）；没声明的列（含完全没有表头的
/// 纯指令行 / 老式两列表格）才按内容从本机配置里补 —— 内容改过就对不上（回到默认 0 / 1000 / 关），
/// 这比"整体丢失"或"按行号乱配"都好解释。
function qcmdCarryItemPrefs(mid, items, fileCols) {
    var has = fileCols || {};
    var needSeq = has.seq === undefined, needTimeout = qcmdTimeoutColIndex(has) === undefined,
        needHex = has.hex === undefined;
    // 「期望 / 重试」不兜：它们只写在文件里，本机配置里没有它们的家 —— 兜回来用户也看不见
    if (!needSeq && !needTimeout && !needHex) return;   // 文件自己带齐了，不用兜
    var old = [];
    qcmdGroups(mid).forEach(function(g) { old = old.concat(g.items || []); });
    var byVal = {};
    old.forEach(function(o) { if (o && o.value && !byVal[o.value]) byVal[o.value] = o; });
    (items || []).forEach(function(it) {
        var o = (it && it.value) ? byVal[it.value] : null;
        if (!o) return;
        if (needSeq && qcmdItemSeq(o) > 0) it.seq = qcmdItemSeq(o);
        if (needTimeout && (o.timeout !== undefined || o.delay !== undefined)) it.timeout = qcmdItemTimeout(o);
        if (needHex && o.hex) it.hex = true;
    });
}

/// 把解析结果套到某个监视器上（items 与 blocks 里的对象是同一批引用，编辑即改到文件）。
/// quiet=true 用于启动期的静默重载：不弹提示（否则每次开程序都糊一条）
function qcmdApplyParsed(mid, parsed, res, quiet) {
    if (!monitors[mid]) return;
    // 文件里的表 → 面板里的组；老文件（没有 `## 抬头`）只有那一组，名字给个默认
    var src = (parsed.groups && parsed.groups.length) ? parsed.groups
                                                      : [{ name: '', cols: parsed.cols, items: parsed.items }];
    src.forEach(function(g) { qcmdCarryItemPrefs(mid, g.items || [], g.cols || parsed.cols); });
    monitors[mid].quickGroups = src.map(function(g, i) {
        return { id: qcmdNewGroupId(), name: g.name || ('循环 ' + (i + 1)),
                 items: g.items || [], cols: g.cols || parsed.cols || null, folded: false };
    });
    // 块序列里的"组序号"换成面板的真 gid（重建 DOM、写回、拖动都靠它认门）
    (parsed.blocks || []).forEach(function(b) {
        if (b && b.group !== undefined && b.group !== null && monitors[mid].quickGroups[b.group]) {
            b.group = monitors[mid].quickGroups[b.group].id;
        }
    });
    monitors[mid]._qcmdBlocks = parsed.blocks;
    monitors[mid]._qcmdCols = parsed.cols || null;
    monitors[mid].quickCmdsFileStyle = parsed.style;
    if (res) {
        monitors[mid].quickCmdsFile = res.path || '';
        monitors[mid].quickCmdsFileEnc = res.encoding || 'utf-8';
        monitors[mid].quickCmdsFileHash = res.hash || '';
        // 只有"成功读过一次"的挂载才允许写回 —— 否则（文件读不到/被删/超限）写回会拿不到
        // 内容基线，等于把用户文件按内存里的列表重写一遍（注释就没了），这是数据丢失路径
        monitors[mid].quickCmdsFileVerified = !!res.hash;
    }
    rebuildQcmdList(mid);
    renderQcmdSource(mid);
    scheduleConfigSave();
    if (parsed.skipped.length) {
        showToast('已跳过 ' + parsed.skipped.length + ' 行（首个：第 ' + parsed.skipped[0].line + ' 行 ' + parsed.skipped[0].reason + '）', 'error');
    }
    // 文件头（YAML/TOML front matter）：能原样保留，但**本版不解释**那些字段 ——
    // 必须说出来，否则用户会以为 `baud: 9600` 生效了（静默 no-op 比报错更坑）
    if (parsed.frontUnclosed) {
        showToast('文件头没有配对的收尾行（--- / +++），已按正文处理', 'error');
    }
    var risky = (parsed.frontKeys || []).filter(function(k) { return QCMD_FRONT_UNSUPPORTED.indexOf(k) >= 0; });
    if (risky.length) {
        showToast('文件头里的 ' + risky.join(' / ') + ' 暂不生效：这些是**每条自己**的设置，要写在表头声明的列里（超时 / 期望 / 重试 / HEX）', 'error');
    }
    // 旧列名「延时」被按「超时」解读 —— 语义变了，必须说一次（静默改行为是最坑的那种）
    if (parsed.legacyTimeoutCol) {
        showToast('这个文件的「延时」列现在按「超时」解读：那条指令发出去最多等这么久，等不到 OK 就终止循环（想自己掌控可以把它改名成「超时(ms)」）', 'info');
    }
    // 「期望 / 重试」面板上没有入口：文件里有它们就必须告诉用户去哪改
    if (parsed.customCondCount) {
        showToast('这个文件里有 ' + parsed.customCondCount + ' 条写了 期望 / 重试（面板不显示这两项，改它请直接编辑文件）', 'info');
    }
    // 跳转（分支与循环）：面板上同样没有入口 —— 有就提示在哪改、以及哪里没被理解
    if (parsed.gotoCount && !quiet) {
        showToast('这个文件里有 ' + parsed.gotoCount + ' 条写了 成功跳转 / 失败跳转（面板不显示这两项，改它请直接编辑文件）', 'info');
    }
    if (parsed.gotoUnknown && !quiet) {
        showToast('跳转列里有 ' + parsed.gotoUnknown + ' 处认不出来（只认：留空/下一条、数字=顺序号、结束），已按「下一条」处理', 'error');
    }
    // 跳转目标指向不存在的顺序号：**导入时就说**，别等运行到那一步才发现（会把流程走成另一条路）
    if (!quiet) {
        var gotoBad = qcmdGotoWarnings(mid);
        if (gotoBad.length) {
            showToast('有 ' + gotoBad.length + ' 处跳转指向不存在的顺序号：' + gotoBad.slice(0, 3).join('、')
                + (gotoBad.length > 3 ? ' 等' : '') + '（成功跳转会按「下一条」走、失败跳转会按「终止」走）', 'error');
        }
    }
    // 表头认出了列、但没写这三列 → 面板里设的顺序号/超时/HEX 只存在本机配置里。
    // 这不是静默 no-op：用户得知道"这三项没进这个文件"，想要自包含的文件就用「导出」。
    var declared = parsed.cols;
    if (!quiet && declared && (declared.seq === undefined || qcmdTimeoutColIndex(declared) === undefined || declared.hex === undefined)) {
        showToast('这个文件的表头没有 顺序号 / 超时(ms) / HEX 三列：这三项只保存在本机配置里（点「导出」可得到带这三列的文件）', 'info');
    }
    if (!quiet && monitors[mid].quickGroups.length > 1) {
        showToast('这个文件里有 ' + src.length + ' 张表 → 读成 ' + monitors[mid].quickGroups.length + ' 个循环组', 'success');
    }
}

/// 来源行：只显示文件名 + 重载/断开（**全部用 DOM API + textContent**：
/// 路径是用户文件，可能含引号/尖括号，绝不能拼进 HTML）
function renderQcmdSource(mid) {
    var el = document.getElementById(mid + '-qcmdSrc');
    if (!el) return;
    var m = monitors[mid];
    var f = m && m.quickCmdsFile;
    if (!f) { el.style.display = 'none'; el.textContent = ''; return; }
    el.style.display = 'flex';
    el.textContent = '';
    var name = document.createElement('span');
    name.className = 'qcmd-src-name';
    name.textContent = qcmdBaseName(f);
    name.title = f + '（增删改都会写回这个文件）';
    var reload = document.createElement('button');
    reload.className = 'qcmd-dh-add';
    reload.id = mid + '-btnQcmdReload';
    reload.textContent = '重载';
    reload.title = '从文件重新读取（文件被外部改过时用）';
    reload.onclick = function() { qcmdReloadFile(mid, false); };
    var off = document.createElement('button');
    off.className = 'qcmd-dh-add';
    off.id = mid + '-btnQcmdUnmount';
    off.textContent = '断开';
    off.title = '不再写回这个文件（列表保留在配置里）';
    off.onclick = function() { qcmdUnmountFile(mid); };
    el.appendChild(name);
    el.appendChild(reload);
    el.appendChild(off);
}

/// 同一个文件被两个监视器挂载会互相写回打架（后写的撞冲突哈希）→ 挂载前先查
function qcmdFileMountedBy(path, exceptMid) {
    var found = null;
    Object.keys(monitors).forEach(function(mid) {
        if (mid === exceptMid) return;
        if (monitors[mid] && monitors[mid].quickCmdsFile === path) found = mid;
    });
    return found;
}

function qcmdImportFile(mid) {
    invoke('quick_cmds_pick_file').then(function(res) {
        if (!res) return;                                   // 用户取消
        var other = qcmdFileMountedBy(res.path, mid);
        if (other) {
            showToast('这个文件已经被「' + other + '」挂载了：先在那里点「断开」，否则两边写回会互相覆盖', 'error');
            return;
        }
        qcmdApplyParsed(mid, qcmdParseText(res.text), res);
        // 成功不弹提示（用户 2026-09 要求）：列表已经显示在面板上、来源行也写着文件名，
        // 再糊一条"已加载"只是噪音。**失败仍然要弹** —— 成功路径里抛异常会被下面的 catch
        // 变成"导入失败"，那种问题必须看得见。
    }).catch(function(e) { showToast('导入失败: ' + e, 'error'); });
}

function qcmdReloadFile(mid, silent) {
    var m = monitors[mid];
    if (!m || !m.quickCmdsFile) return;
    var path = m.quickCmdsFile;
    invoke('quick_cmds_read_file', { path: path }).then(function(res) {
        qcmdApplyParsed(mid, qcmdParseText(res.text), res, silent);   // 静默重载不弹提示
        // 重载成功也不弹提示（用户 2026-09 要求）；失败要弹（保留当前列表，绝不静默清空）
    }).catch(function(e) {
        // 文件没了/读不动：**保留现有列表**并提示，绝不静默清空（那是最伤的体验）
        showToast('重载失败（保留当前列表）: ' + e, 'error');
    });
}

function qcmdUnmountFile(mid) {
    if (!monitors[mid]) return;
    monitors[mid].quickCmdsFile = '';
    monitors[mid].quickCmdsFileHash = '';
    monitors[mid].quickCmdsFileVerified = false;
    monitors[mid]._qcmdBlocks = null;                       // 回到"只有指令、没有原始行"的状态
    monitors[mid]._qcmdCols = null;                         // 列映射也一起忘掉（那属于那个文件）
    renderQcmdSource(mid);
    scheduleConfigSave();
    showToast('已断开文件（列表保留在配置里）', 'success');
}

/// 导出的列：**列序照抄面板** —— 顺序号 → 指令 → 超时(ms) → HEX（面板上每一行就是这四格从左到右）。
/// 末尾另补 `期望 / 重试`：面板上没有它们的入口，但导出是**自包含快照** —— 不写出来，
/// 用户"另存一份"就把自定义的响应词与重试次数丢了。
/// **不带「名称」列**：面板里没有名称入口，导出的副本就不该多一栏。
/// 挂载文件自己的「名称」列由**写回**路径原样保留，不受影响。
function qcmdExportCols() {
    return [
        { key: 'seq',     label: '顺序号' },
        { key: 'value',   label: '指令' },
        { key: 'timeout', label: '超时(ms)' },
        { key: 'hex',     label: 'HEX' },
        { key: 'expect',  label: '期望' },
        { key: 'retry',   label: '重试' },
        { key: 'okgoto',  label: '成功跳转' },
        { key: 'errgoto', label: '失败跳转' }
    ];
}

/// 导出用的块序列：**一组一张表**（用户 2026-09 的要求）—— 每组一段：
/// `## 组名` 抬头 + 表头行 + 分隔行 + **每条一行**（一律带 顺序号/指令/延时/HEX，`fill:true`
/// 把 0 / 1000 / false 写全，空条目也占一行 —— 行数必须与面板上的条数一致）。
/// 导出的是副本，补列/补抬头只动副本、不碰用户的挂载文件。
/// 导出物开头那段**注释形式的用法说明 + 案例**（用户 2026-09 要求："快捷指令的 md 文件中，
/// 应该使用注释的方式提供案例，比如表格案例，DSL 编写案例"）。
///
/// 为什么放在**导出物**里、而不是只在 `doc/QUICK_CMDS.md`：用户手里真正会打开的是这份文件 ——
/// 让他"导出一份看看"就等于拿到一份自带语法的模板，不必再去翻文档。
///
/// 三条纪律：
/// ① **只在导出物里出现**（靠 `qcmdExportPrep` 的 `withHelp`），绝不进 `qcmdCurrentText` ——
///    后者是**要写回用户文件**的内容，往人家表里塞说明就是污染；
/// ② 每一行都以 `#` 开头：解析端是"**单个 `#` 是注释、`##` 及以上才是组抬头**"
///    （见 `qcmdParseText` 里那条"必须写在注释判断之前"的注释），所以案例里的 `## 组名`
///    只能写成 `#   ## 组名`（行首只有一个 `#`，不会被当成组抬头）；
/// ③ 这些行会被解析器**原样保留**（当注释丢掉、不进条目），所以"把导出的文件再导入回来"
///    条目数与组名必须一模一样 —— 断言集里有一条专门守这个往返。
function qcmdHelpComment(style) {
    var head = [
        '# ══ 快速指令文件 · 自带说明（本段每行都以 # 开头 = 注释，不会被当成指令发送）══',
        '#',
        '# 【结构】一组一张表：`## 组名` 抬头 → 表头行 → 每条指令一行。',
        '#   循环顺序 = 组的**上下顺序** → 组内「顺序号」升序；组名不参与排序（拖组抬头才改顺序）。',
        '#   单个 `#` 是注释（原样保留、不解释）；`##` 及以上是**组抬头**。',
        '#'
    ];
    if (style === 'tsv') {
        head.push('#   （这份文件是 TSV：同一张表里各列用制表符分隔，下面为便于阅读画成表格）');
        head.push('#');
    }
    return head.concat([
        '# 【表格案例】',
        '#   ## 上电初始化',
        '#   | 顺序号 | 指令 | 超时(ms) | HEX | 期望 | 重试 | 成功跳转 | 失败跳转 |',
        '#   |---|---|---|---|---|---|---|---|',
        '#   | 1 | AT | 1000 | false |  | 3 |  |  |',
        '#   | 2 | AT+CWMODE=1 | 2000 | false | OK | 3 |  |  |',
        '#   | 3 | AT+CWJAP="ssid","pwd" | 15000 | false | WIFI GOT IP\\|OK | 2 | 结束 | 10 |',
        '#   | 10 | AT+RST | 1000 | false | ready | 3 | 结束 | 结束 |',
        '#',
        '# 【判断与分支案例】「期望」是**条件**，「成功跳转 / 失败跳转」就是**分支出口** ——',
        '#   一张表就能表达"识别到什么就往哪走"，不必另学一套语法：',
        '#   ## 配网：连上就问 IP，连不上就重启',
        '#   | 顺序号 | 指令 | 超时(ms) | HEX | 期望 | 重试 | 成功跳转 | 失败跳转 |',
        '#   |---|---|---|---|---|---|---|---|',
        '#   | 1 | AT+CWJAP="ssid","pwd" | 15000 | false | WIFI GOT IP | 2 | 5 | 8 |',
        '#   | 5 | AT+CIFSR | 1000 | false |  | 3 | 结束 | 结束 |',
        '#   | 8 | AT+RST | 1000 | false | ready | 3 | 结束 | 结束 |',
        '#   读法：整行收到 `WIFI GOT IP` → 跳到顺序号 5；超时或用完重试 → 跳到 8。',
        '#   跳转列可填顺序号（跨组也行），或「结束」= 收尾停下；留空 = 成功走"下一条"、失败"终止整条链"。',
        '#   内置判定：整行 `OK`（或以 " OK" 结尾）= 成功；含 `error` = 失败；含 `busy` = 继续等。',
        '#   ⚠️ 自定义「期望」是**整行完全相等**，不是包含 —— 设备若回 `+CWJAP:WIFI GOT IP` 就匹配不上。',
        '#      要"包含某个词就算成功"，请用**工作流规则**（面板「更多设置 → 工作流」，条件选 `string_contains`）。',
        '#   跳转可以成环（成功回到自己就是轮询），但有**跳转次数上限**保护，超了会自愈停止。',
        '#',
        '# 【DSL 案例】只写「指令」一列也认（第 2 列起是你的备注，原样保留）：',
        '#   AT',
        '#   AT+CWMODE=1',
        '#   AT+CWJAP="ssid","pwd"',
        '#',
        '# 【HEX 案例】',
        '#   | 顺序号 | 指令 | 超时(ms) | HEX |',
        '#   |---|---|---|---|',
        '#   | 1 | 01 03 00 00 00 02 | 0 | true |',
        '#',
        '# 【各列】顺序号：0 = 不参与循环，>0 在组内按它升序发；',
        '#   超时(ms)：发出去后最多等多久，填 0 = 这条不等响应（连续 HEX 帧）；',
        '#   期望：自定义成功词，多个用 \\| 分隔（留空则只用内置的 OK / ERROR / busy）；',
        '#   重试：收到 ERROR 后最多重发几次；成功跳转 / 失败跳转：填顺序号，「结束」= 收尾 / 终止整条链。',
        '#   注：面板上没有「期望 / 重试 / 跳转」的入口 —— 它们只从文件读。',
        '# ══ 说明结束，下面是你的指令 ══'
        // ⚠️ 行尾必须是 `\r\n`：`qcmdBuildText` 最后是 `out.join('\r\n')`，而 raw 块是**原样回吐**的。
        // 这里用 `\n` 的话，导出物就成了"注释段 LF、其余 CRLF"的混合行尾 ——
        // 后果不是不好看，而是"导出 → 导入 → 原样写回"**不再逐字节一致**
        // （2026-09 就是这么被往返断言逮住的）。
    ]).join('\r\n');
}

function qcmdExportPrep(groups, style, withHelp) {
    var cols = qcmdExportCols();
    var map = {}, header = [];
    cols.forEach(function(c, i) { map[c.key] = i; header.push(c.label); });
    var blocks = [];
    // 导出物自带一段注释形式的说明 + 案例（见 qcmdHelpComment）。
    // ⚠️ **只在导出时给**（withHelp）：`qcmdCurrentText` 也走这个函数，但那是要**写回用户文件**
    // 的内容 —— 往人家的表里塞说明就是污染。
    if (withHelp) blocks.push({ kind: 'raw', text: qcmdHelpComment(style) });
    (groups || []).forEach(function(g, gi) {
        if (gi) blocks.push({ kind: 'raw', text: '' });          // 组与组之间空一行，读起来清楚
        blocks.push({ kind: 'raw', text: '## ' + String((g && g.name) || ('循环 ' + (gi + 1))).replace(/[\r\n]+/g, ' '), heading: true });
        blocks.push({ kind: 'raw', text: qcmdJoinRow(header, style) });
        if (style !== 'tsv' && style !== 'lines') {
            blocks.push({ kind: 'raw', text: qcmdJoinRow(header.map(function() { return '---'; }), 'md') });
        }
        ((g && g.items) || []).forEach(function(it) {
            blocks.push({ kind: 'item', item: it, cols: map, cells: null, fill: true });
        });
    });
    return { blocks: blocks, style: style, cols: cols };
}

/// 导出的**默认文件名**：按监视器区分。
/// 为什么不是一律 `quick-cmds.md`：WSL 分栏、额外分栏、蓝牙页内嵌监视器**各有一份快速指令列表**，
/// 默认名相同的话，"连点两次导出、都保存到同一目录"就会第二次盖掉第一次（原生保存框会问一句，
/// 但顺手点"是"是常事）；更麻烦的是导出是**直接写文件**、不走写回那条哈希冲突检测 ——
/// 万一目标正是另一个监视器挂载着的那个文件，它的内容当场就被换掉了。
/// `main` 保持 `quick-cmds.md`（老用户的习惯与文档都按它写），其余带上自己的 mid。
function qcmdExportBaseName(mid) {
    var base = 'quick-cmds';
    var id = String(mid == null ? '' : mid);
    if (id && id !== 'main') base += '-' + id.replace(/[^A-Za-z0-9_-]/g, '-');
    return base;
}

/// 这条指令有没有"非默认的发送参数"（决定纯指令行载体要不要升级成表格）
function qcmdItemHasParams(it) {
    return qcmdItemSeq(it) > 0 || qcmdItemHex(it) || qcmdItemTimeout(it) !== QCMD_TIMEOUT_DEFAULT
        || !!qcmdItemExpect(it) || qcmdItemRetry(it) !== QCMD_RETRY_DEFAULT;
}

/// 导出：只给 Markdown / TSV，**不给 CSV**（逗号会切碎 AT 指令）；导出的是副本，不改变当前目标。
/// 副本按组分段，每组一张带 顺序号/指令/延时/HEX 的表；纯指令行载体放不下这些就升级成表格。
function qcmdExportFile(mid) {
    var m = monitors[mid];
    if (!m) return;
    var groups = qcmdGroups(mid);
    var items = [];
    groups.forEach(function(g) { items = items.concat(g.items || []); });
    var style = m.quickCmdsFileStyle || 'md';
    var prep, upgraded = false;
    if (style === 'lines' && groups.length === 1) {
        // 纯指令行、且只有一组 → 保持用户熟悉的形态，不硬塞表头（多组时表达不了组，只能升级）
        prep = { blocks: items.map(function(it) { return { kind: 'item', item: it, cols: { value: 0 }, cells: null }; }),
                 style: 'lines', cols: null };
    } else {
        if (style === 'lines') upgraded = true;
        prep = qcmdExportPrep(groups, style === 'tsv' ? 'tsv' : 'md', true);
    }
    var text = qcmdBuildText(prep.blocks, prep.style);
    var defName = qcmdExportBaseName(mid) + '.' + (prep.style === 'tsv' ? 'tsv' : 'md');
    invoke('quick_cmds_export_file', { text: text, encoding: m.quickCmdsFileEnc || 'utf-8', defaultName: defName })
        .then(function(res) {
            if (!res) return;
            showToast('已导出：' + res.path + '（' + groups.length + ' 组，每组一张表；点「导入」可把它设为当前目标）', 'success');
            if (upgraded) showToast('纯指令行放不下分组与 顺序号/超时/HEX：这份导出已升级成 Markdown 表格', 'info');
            // ⚠️ 导出是**直接写文件**（它是"另存一份副本"，不走写回那条哈希冲突检测）。
            // 万一用户把副本存到了另一个监视器正挂载的那个文件上，那边的内容已经被换掉了 ——
            // 必须当场说清，别让他之后在那边"重载"时才一脸茫然。
            var other = qcmdFileMountedBy(res.path, mid);
            if (other) {
                showToast('注意：这个文件正被「' + other + '」挂载，你这次导出已经把它的内容换掉了 —— 在那边点「重载」取新的，或者换个文件名重导一次', 'error');
            }
        }).catch(function(e) { showToast('导出失败: ' + e, 'error'); });
}

/// 当前列表 → 文件文本（挂了文件就沿用它的块序列与载体，注释/额外列都在）
/// ⚠️ 写回**不擅自补列**：文件表头没写那三列就不写（用户的表结构由用户定），
/// 想要自包含的三列文件走「导出」（导出的是副本）。
/// 没挂文件时（纯配置）按"一组一张表"现拼出来 —— 与导出同一套形状。
function qcmdCurrentText(mid) {
    var m = monitors[mid];
    if (!m) return '';
    var blocks = m._qcmdBlocks;
    var style = m.quickCmdsFileStyle || 'md';
    if (blocks) return qcmdBuildText(blocks, style);
    var groups = qcmdGroups(mid);
    if (groups.length === 1) {
        // 只有一组、又没挂文件（纯配置）：**只写指令本身** —— 顺序号/延时/HEX 只存在配置里，
        // 绝不能凭空给用户文件加列（那条不变式：表头没声明就不写）
        return qcmdBuildText(((groups[0].items) || []).map(function(it) {
            return { kind: 'item', item: it, cols: { value: 0 }, cells: null };
        }), style);
    }
    return qcmdBuildText(qcmdExportPrep(groups, style).blocks, style);
}

/// 写回（去抖 600ms）：增/删/改都走这里 —— 这就是"添加的新项要落在目标文件里"
var _qcmdFileSaveTimers = {};
function scheduleQcmdFileSave(mid) {
    if (!monitors[mid] || !monitors[mid].quickCmdsFile) return;
    if (_qcmdFileSaveTimers[mid]) clearTimeout(_qcmdFileSaveTimers[mid]);
    _qcmdFileSaveTimers[mid] = setTimeout(function() {
        _qcmdFileSaveTimers[mid] = null;
        qcmdFileSaveNow(mid);
    }, 600);
}

function qcmdFileSaveNow(mid) {
    var m = monitors[mid];
    if (!m || !m.quickCmdsFile) return;
    if (_qcmdFileSaveTimers[mid]) { clearTimeout(_qcmdFileSaveTimers[mid]); _qcmdFileSaveTimers[mid] = null; }
    // 没成功读过就没有内容基线：宁可不写，也不能把用户的文件按内存列表重写（会丢注释/额外列）
    if (!m.quickCmdsFileVerified || !m.quickCmdsFileHash) {
        showToast('「' + qcmdBaseName(m.quickCmdsFile) + '」还没成功读过，这次改动暂未写回（点「重载」或重新「导入」）', 'error');
        return;
    }
    var path = m.quickCmdsFile;
    invoke('quick_cmds_write_file', {
        path: path,
        text: qcmdCurrentText(mid),
        encoding: m.quickCmdsFileEnc || 'utf-8',
        expectHash: m.quickCmdsFileHash || ''
    }).then(function(res) {
        if (monitors[mid] && monitors[mid].quickCmdsFile === path) {
            monitors[mid].quickCmdsFileHash = res.hash || '';
            monitors[mid].quickCmdsFileEnc = res.encoding || monitors[mid].quickCmdsFileEnc;
        }
    }).catch(function(e) {
        var msg = String(e && e.message ? e.message : e);
        showToast('未能写回 ' + qcmdBaseName(path) + '：' + msg, 'error');
    });
}

/// 关闭窗口前把还没落盘的去抖写回刷掉（与 config 的 beforeunload 处理同一套路）
function qcmdFlushPendingFileSaves() {
    Object.keys(_qcmdFileSaveTimers).forEach(function(mid) {
        if (_qcmdFileSaveTimers[mid]) qcmdFileSaveNow(mid);
    });
}

/// 挂载了文件时，面板里的增删必须同步到块序列 —— 否则改了根本写不进文件
function qcmdBlockIndexOf(mid, item) {
    var blocks = monitors[mid] && monitors[mid]._qcmdBlocks;
    if (!blocks) return -1;
    for (var i = 0; i < blocks.length; i++) {
        if (blocks[i] && blocks[i].kind === 'item' && blocks[i].item === item) return i;
    }
    return -1;
}

/// 某一组在文件里占的那一段块（抬头 + 表头 + 分隔 + 数据行 + 夹在中间的注释）的起止下标。
/// 从"这组的抬头（或第一行数据）"起，到"下一组抬头（或文件末尾）"止 —— 注释跟着它所在的那组走。
function qcmdGroupBlocksRange(blocks, gid) {
    var start = -1, end = blocks.length;
    for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i];
        if (!b) continue;
        var mine = (b.group === gid);
        if (mine && start < 0) start = i;
        if (start >= 0 && !mine && (b.heading || b.kind === 'item')) { end = i; break; }
    }
    if (start < 0) return null;
    // 结尾把"这段后面、属于本段的表格结构行"（分隔行等）也算进来
    while (end > start && blocks[end - 1] && !blocks[end - 1].group && blocks[end - 1].kind === 'raw'
           && !blocks[end - 1].heading) { end--; }
    return { start: start, end: end };
}

/// 造一个组在文件里的"分节"：`## 名字` + 表头行 + 分隔行（md），数据行由调用方接着插
function qcmdGroupSectionBlocks(name, style, cols) {
    var map = cols || { seq: 0, value: 1, timeout: 2, hex: 3 };
    var labels = { seq: '顺序号', value: '指令', timeout: '超时(ms)', hex: 'HEX', name: '名称',
                   expect: '期望', retry: '重试' };
    var width = 0, header = [];
    Object.keys(map).forEach(function(k) { if (map[k] + 1 > width) width = map[k] + 1; });
    for (var i = 0; i < width; i++) header.push('');
    Object.keys(map).forEach(function(k) { header[map[k]] = labels[k] || k; });
    var out = [{ kind: 'raw', text: '## ' + String(name == null ? '' : name).replace(/[\r\n]+/g, ' '), heading: true }];
    out.push({ kind: 'raw', text: qcmdJoinRow(header, style) });
    if (style !== 'tsv' && style !== 'lines') {
        out.push({ kind: 'raw', text: qcmdJoinRow(header.map(function() { return '---'; }), 'md') });
    }
    return out;
}

/// 新条目插到**该组**最后一个数据行之后（保持那组的表格连续）。
/// 该组在文件里还没有位置（面板新建的组）→ 在文件末尾补一整节（抬头 + 表头 + 分隔 + 这一行）。
/// 列映射与行宽跟着该组已有的数据行走（原本只写一列的表，新行也只写一列；
/// 表头声明了 顺序号/超时/HEX 的表，新行照样补齐这几格）—— 否则写回时会把表格撑歪。
function qcmdInsertItemBlock(mid, gid, item) {
    var blocks = monitors[mid] && monitors[mid]._qcmdBlocks;
    if (!blocks) return false;
    var g = qcmdGroupById(mid, gid);
    var at = -1, cols = null, width = 0;
    for (var i = 0; i < blocks.length; i++) {
        if (blocks[i] && blocks[i].kind === 'item' && blocks[i].group === gid) {
            at = i;
            if (blocks[i].cols) { cols = blocks[i].cols; width = (blocks[i].cells || []).length; }
        }
    }
    if (at < 0) {
        // 这一组在文件里还没有段落：补一节出来（放在文件末尾 —— 新建的组本来就追加在最下面）
        cols = (g && g.cols) || monitors[mid]._qcmdCols || { seq: 0, value: 1, timeout: 2, hex: 3 };
        var sec = qcmdGroupSectionBlocks(g ? g.name : '', monitors[mid].quickCmdsFileStyle || 'md', cols);
        sec.forEach(function(b) { b.group = gid; });
        blocks.push.apply(blocks, sec);
        at = blocks.length - 1;
    }
    if (!cols && g && g.cols) cols = g.cols;
    if (!cols && monitors[mid]) cols = monitors[mid]._qcmdCols;
    if (!cols) cols = { value: 0 };
    Object.keys(cols).forEach(function(k) { if (cols[k] + 1 > width) width = cols[k] + 1; });
    var cells = [];
    for (var w = 0; w < width; w++) cells.push('');
    // fill：面板新建的行要把 0 / 1000 / false 写全（用户看得见缺省值，也好直接改）
    blocks.splice(at + 1, 0, { kind: 'item', item: item, cols: cols, cells: cells, group: gid, fill: true });
    return true;
}

function qcmdRemoveItemBlock(mid, item) {
    var idx = qcmdBlockIndexOf(mid, item);
    var blocks = monitors[mid] && monitors[mid]._qcmdBlocks;
    if (idx < 0 || !blocks) return false;
    blocks.splice(idx, 1);
    return true;
}

/// 删掉一整组在文件里那一段（抬头 + 那张表）
function qcmdRemoveGroupBlocks(mid, gid) {
    var blocks = monitors[mid] && monitors[mid]._qcmdBlocks;
    if (!blocks) return false;
    var r = qcmdGroupBlocksRange(blocks, gid);
    if (!r) return false;
    blocks.splice(r.start, r.end - r.start);
    return true;
}

/// 拖组之后把文件里那一段挪到第 index 个组的位置（文件里的表顺序 = 面板上的组顺序）
function qcmdMoveGroupBlocks(mid, gid, targetIndex) {
    var blocks = monitors[mid] && monitors[mid]._qcmdBlocks;
    if (!blocks) return false;
    var list = qcmdGroups(mid);
    var r = qcmdGroupBlocksRange(blocks, gid);
    if (!r) return false;
    var run = blocks.splice(r.start, r.end - r.start);
    // 目标位置：第 targetIndex 组的段落**之前**（targetIndex 到最后就放文件末尾）
    var at = blocks.length;
    var next = list[targetIndex + 1];
    if (next) {
        var nr = qcmdGroupBlocksRange(blocks, next.id);
        if (nr) at = nr.start;
    }
    blocks.splice.apply(blocks, [at, 0].concat(run));
    return true;
}

/// 改名：把文件里那行抬头改掉（找不到抬头说明这段是隐含的组 → 不写抬头，名字只留配置）
function qcmdRenameGroupBlock(mid, gid, name) {
    var blocks = monitors[mid] && monitors[mid]._qcmdBlocks;
    if (!blocks) return false;
    for (var i = 0; i < blocks.length; i++) {
        if (blocks[i] && blocks[i].heading && blocks[i].group === gid) {
            blocks[i].text = '## ' + String(name == null ? '' : name).replace(/[\r\n]+/g, ' ');
            return true;
        }
    }
    return false;
}

/* ===== 每条指令自己的发送参数：顺序号 / 延时 / HEX =====
   顺序号（方形框，默认 0）：0 = 不参与循环发送，>0 参与并按数字从小到大发；
   延时（默认 1000ms）：本条发完到下发下一条的间隔；
   HEX（默认关）：本条按 HEX 解析后发送，与主发送栏的文本/HEX 模式彼此独立
   （同一轮循环里"一条文本 + 一条 HEX"是常见需求，跟着全局模式走就做不到）。
   ⚠️ 这三项**不写进用户的外部文件**（那文件只有名称/指令两列，塞私有列会污染用户文件），
   只随 config.json 走；从文件重载时按"指令内容"尽量带回来（见 qcmdCarryItemPrefs）。 */
var QCMD_SEQ_MAX = 9999;              // 顺序号上限（4 位）
var QCMD_TIMEOUT_DEFAULT = 3000;      // 超时缺省值（毫秒）：这条发出去最多等多久
var QCMD_TIMEOUT_MAX = 600000;        // 超时上限 10 分钟（防手滑打出天文数字把循环挂死）
var QCMD_RETRY_DEFAULT = 3;           // 收到 ERROR 后最多重发几次
var QCMD_RETRY_MAX = 10;              // 重试次数上限（再高就是"永远重发"，用户停不下来）
var QCMD_EXPECT_MAX = 64;             // 自定义成功词的长度上限（字符）

/// 只留数字并去掉多余前导零（顺序号/延时输入框用 text 而不是 number：
/// number 框在深色主题下带上下箭头，还接受 'e' / '-' / '.'，得再拦一道）
function qcmdDigits(s, maxLen) {
    var d = String(s == null ? '' : s).replace(/[^0-9]/g, '');
    if (maxLen && d.length > maxLen) d = d.slice(0, maxLen);
    return d.replace(/^0+(?=\d)/, '');
}

/// 某条的顺序号（读不到/非法/负数都算 0 = 不参与）
function qcmdItemSeq(it) {
    var n = parseInt((it && it.seq) || 0, 10);
    if (!isFinite(n) || n < 0) return 0;
    return Math.min(n, QCMD_SEQ_MAX);
}

/// 某条的**超时**（毫秒）：发出去之后最多等多久 —— 等到 OK 发下一条、等到 ERROR 重发本条、
/// 等满这个时间还没等到 OK 就终止整条循环。`0` = 这条不等响应（发完就过，用于连续 HEX 帧、
/// 或设备本来就不回 OK 的指令）。
/// ⚠️ 兼容老配置/老文件：早期这一项叫「延时」（字段 `delay`）。语义已经变了，但**按超时读回来**
/// —— 只改含义、不改数值，同时在导入时明确提示一次（不做静默语义变更）。
function qcmdItemTimeout(it) {
    var raw = it ? ((it.timeout !== undefined && it.timeout !== null && it.timeout !== '')
                    ? it.timeout : it.delay) : undefined;
    var n = (raw === undefined || raw === null || raw === '') ? QCMD_TIMEOUT_DEFAULT : parseInt(raw, 10);
    if (!isFinite(n) || n < 0) return QCMD_TIMEOUT_DEFAULT;
    return Math.min(n, QCMD_TIMEOUT_MAX);
}

/// 某条的**自定义成功词**（`|` 分隔多个）。面板不显示它 —— 它写在外部文件表头声明的「期望」列里：
/// 通用的 AT 设备只回 `OK`（内置认得），个别设备回 `WIFI GOT IP` / `ready` 这类词时才需要它。
function qcmdItemExpect(it) {
    var s = (it && it.expect !== undefined && it.expect !== null) ? String(it.expect).trim() : '';
    return s.length > QCMD_EXPECT_MAX ? s.slice(0, QCMD_EXPECT_MAX) : s;
}

/// 收到 ERROR 之后最多重发几次（`0` = 不重发，直接终止）。同样写在文件的「重试」列里。
function qcmdItemRetry(it) {
    var raw = it ? it.retry : undefined;
    var n = (raw === undefined || raw === null || raw === '') ? QCMD_RETRY_DEFAULT : parseInt(raw, 10);
    if (!isFinite(n) || n < 0) return QCMD_RETRY_DEFAULT;
    return Math.min(n, QCMD_RETRY_MAX);
}

function qcmdItemHex(it) { return !!(it && it.hex); }

/* ===== 跳转：分支与循环（「成功跳转」「失败跳转」两列，面板上没有入口，同「期望」「重试」） =====
   取值三种：**留空/`下一条`**（缺省 = 原行为）、**数字 = 顺序号**（跳到那一条）、**`结束`**。
   为什么按顺序号而不是"第几行"：顺序号本来就是"这条参不参与、按什么次序发"的口径，
   跨组也能跳，用户改行序不会把跳转指错。 */
var QCMD_GOTO_MAX = 200;              // **连续**跳转次数上限：两列都是"只会打转"的语法，没它就会无限跑
var QCMD_GOTO_NEXT = ['下一条', '下一條', '继续', '繼續', 'next', '-'];
var QCMD_GOTO_END = ['结束', '結束', '终止', '終止', 'end', 'stop'];

/// 跳转取值归一化：'' = 下一条（缺省）/ 'end' = 结束 / '数字' = 顺序号。认不出来的按**下一条**处理
/// （导入时会由 `qcmdGotoWarnings` 提示一次 —— 不静默改语义）
function qcmdGotoNorm(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return '';
    var low = s.toLowerCase();
    if (QCMD_GOTO_NEXT.indexOf(low) >= 0) return '';
    if (QCMD_GOTO_END.indexOf(low) >= 0) return 'end';
    if (/^\d+$/.test(s)) {
        var n = parseInt(s, 10);
        return (n > 0 && n <= QCMD_SEQ_MAX) ? String(n) : '';
    }
    return '';
}

/// 这条的「成功跳转」（收到 OK 之后去哪）
function qcmdItemOkGoto(it) { return qcmdGotoNorm(it && it.okgoto); }
/// 这条的「失败跳转」（ERROR 用尽**或超时**之后去哪）
function qcmdItemErrGoto(it) { return qcmdGotoNorm(it && it.errgoto); }

/// 跳转目标 → 计划里的下标（找不到返回 -1）。计划是"组序 → 组内顺序号"摊平的，按顺序号找。
function qcmdPlanIndexOfSeq(plan, seq) {
    for (var i = 0; i < (plan || []).length; i++) {
        if (String(plan[i].seq) === String(seq)) return i;
    }
    return -1;
}

/// 解析后检查一遍跳转目标：指向不存在的顺序号时**列出来**（导入时提示一次，不静默降级）
function qcmdGotoWarnings(mid) {
    var plan = qcmdLoopPlan(mid);
    var seqs = {};
    plan.forEach(function (p) { seqs[String(p.seq)] = true; });
    var bad = [];
    qcmdAllItems(mid).forEach(function (x) {
        var it = x.it || {};
        [['成功跳转', qcmdItemOkGoto(it)], ['失败跳转', qcmdItemErrGoto(it)]].forEach(function (pair) {
            var g = pair[1];
            if (g && g !== 'end' && !seqs[g]) {
                bad.push('顺序号 ' + qcmdItemSeq(it) + ' 的「' + pair[0] + '=' + g + '」');
            }
        });
    });
    return bad;
}

/// 取某组里的某条（组/条目都可能刚被删掉 → 一律判空，别让定时器或事件打到空气）
function qcmdItemAt(mid, gid, idx) {
    var g = qcmdGroupById(mid, gid);
    return (g && g.items && g.items[idx]) ? g.items[idx] : null;
}

/// 循环计划：**按组的上下顺序**逐组收集（组内仍是顺序号从小到大，同号按列表先后），
/// 摊平成一条链 —— 走完最后一组回到最上面那组。每组只在它自己的条目里排序。
/// ⚠️ 抬头开关关掉的组**整组跳过**（`qcmdGroupOn`）。
function qcmdLoopPlan(mid) {
    var plan = [];
    qcmdGroups(mid).forEach(function(g) {
        if (!qcmdGroupOn(g)) return;
        var picked = [];
        (g.items || []).forEach(function(it, ii) {
            var seq = qcmdItemSeq(it);
            if (seq > 0) picked.push({ ii: ii, seq: seq });
        });
        picked.sort(function(a, b) { return (a.seq - b.seq) || (a.ii - b.ii); });
        picked.forEach(function(x) { plan.push({ gid: g.id, gi: qcmdGroupIndex(mid, g.id), ii: x.ii, seq: x.seq }); });
    });
    return plan;
}

