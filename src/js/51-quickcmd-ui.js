/* 51-quickcmd-ui.js —— 前端第 7 块，拆自原单文件 src/index.html（**纯搬家**；行号映射见 doc/FRONTEND_LAYOUT.md）。
   ⚠️ **普通脚本**（不是 ESM）：按 index.html 里的 <script src> 顺序加载、共享同一个全局作用域 —— 行内 onclick
   与现有函数互相调用照旧；**别改成 type="module"**（模块作用域会让它们全部失效）。 */
/* ===== 组抬头（可重命名 / 拖动排序 / 折叠 / 加条 / 删组） =====
   抬头用 DOM API 造，**不拼 HTML**：组名来自用户文件，可能含引号/尖括号（同 renderQcmdSource 的纪律）。 */
function makeQcmdGroupBand(mid, g) {
    var on = qcmdGroupOn(g);
    var band = document.createElement('div');
    band.className = 'qcmd-group-hd' + (g.folded ? ' folded' : '');
    band.id = mid + '-qcmdG-' + g.id;

    // **参与循环的滑动开关（放在抬头最前面）**：关掉 = 整组跳过（顺序号原样保留在文件里）。
    // 用 app 里既有的那套滑动开关外观（与主题开关 / WSL 自动映射同款：轨道 + 圆钮）。
    var sw = document.createElement('button');
    sw.className = 'qcmd-group-sw' + (on ? ' on' : '');
    sw.id = mid + '-qcmdSw-' + g.id;
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', on ? 'true' : 'false');
    sw.title = on ? '这一组参与循环发送（点一下 = 跳过这一组）'
                  : '这一组不参与循环发送（点一下 = 恢复参与）';
    sw.addEventListener('click', function(e) { e.stopPropagation(); setQcmdGroupOn(mid, g.id, !qcmdGroupOn(g)); });

    var fold = document.createElement('button');
    fold.className = 'qcmd-group-fold';
    fold.title = g.folded ? '展开这一组' : '折叠这一组';   // 箭头是 CSS 画的（::before），按钮里不放字形
    fold.addEventListener('click', function(e) { e.stopPropagation(); toggleQcmdGroupFold(mid, g.id); });

    var grip = document.createElement('span');
    grip.className = 'qcmd-group-grip';                    // 点阵也是 CSS 画的
    grip.title = '按住上下拖动：调整组的顺序（循环按这个顺序从上往下走，最上面那组就是起点）';
    grip.addEventListener('mousedown', function(e) { startQcmdGroupDrag(e, mid, g.id); });

    var name = document.createElement('input');
    name.className = 'qcmd-group-name';
    name.id = mid + '-qcmdGn-' + g.id;
    name.type = 'text';
    name.value = g.name || '';
    name.placeholder = QCMD_GROUP_DEFAULT_NAME;
    name.title = '点一下改名';
    name.addEventListener('click', function(e) { e.stopPropagation(); });
    name.addEventListener('input', function() { renameQcmdGroup(mid, g.id, this.value); });
    name.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); this.blur(); } });

    var count = document.createElement('span');
    count.className = 'qcmd-group-count';
    var total = (g.items || []).length;
    count.textContent = total + ' 条';
    count.title = '这一组共 ' + total + ' 条指令';

    // 「＋ 添加」不在这里 —— 它在这张表**表头行的最右**（见 rebuildQcmdList 里那个 .qcmd-col-add）

    var del = document.createElement('button');
    del.className = 'qcmd-dep-del';
    del.innerHTML = '&#xd7;';
    del.title = '删除这一组（连同组里的指令）';
    del.addEventListener('click', function(e) { e.stopPropagation(); removeQcmdGroup(mid, g.id); });

    // 顺序：拖动握把（最左的可拖区）· **参与开关（握把与组名之间）** · 组名 ·
    // 折叠箭头（紧挨"N 条"左边）· 条数 · 删组。「＋ 添加」不在这里：它在表头行的最右。
    band.appendChild(grip);
    band.appendChild(sw);
    band.appendChild(name);
    band.appendChild(fold);
    band.appendChild(count);
    band.appendChild(del);
    return band;
}

/// 开关某一组是否参与循环：改模型 + 重算循环计划（跑着的时候立刻生效）
function setQcmdGroupOn(mid, gid, on) {
    var g = qcmdGroupById(mid, gid);
    if (!g) return;
    g.on = !!on;
    var box = document.getElementById(mid + '-qcmdGbox-' + gid);
    if (box) box.classList.toggle('off', !g.on);
    var sw = document.getElementById(mid + '-qcmdSw-' + gid);
    if (sw) {
        sw.classList.toggle('on', g.on);
        sw.setAttribute('aria-checked', g.on ? 'true' : 'false');
        sw.title = g.on ? '这一组参与循环发送（点一下 = 跳过这一组）'
                        : '这一组不参与循环发送（点一下 = 恢复参与）';
    }
    scheduleConfigSave();
    if (monitors[mid] && monitors[mid].qcmdLoop) qcmdLoopSyncPlan(mid);   // 跑着的时候立刻按新计划走
    mcpNotifyState([mid + '.quickGroups']);
}

/// 重建一个监视器下所有组。**每组自成一张表**：抬头（组名/拖动/折叠/加条/删组）→ 列标题 → 数据行。
/// 列标题放在组里面（而不是列表顶上共用一份）：共用一份的话它夹在"第一组抬头"和"第一组数据行"
/// 之间，读起来是断的，第二组的行又离它很远 —— 用户 2026-09 指出的正是这里。
/// 现在面板与文件的形状完全一致（文件里也是"一组一张表"，见 qcmdExportPrep）。
function rebuildQcmdList(mid) {
    var qlist = document.getElementById(mid + '-qcmdList');
    if (!qlist) return;
    qlist.innerHTML = '';
    qcmdGroups(mid).forEach(function(g) {
        var box = document.createElement('div');
        box.className = 'qcmd-group' + (g.folded ? ' folded' : '') + (qcmdGroupOn(g) ? '' : ' off');
        box.id = mid + '-qcmdGbox-' + g.id;
        box.appendChild(makeQcmdGroupBand(mid, g));
        // 列标题：自己建元素（不用 innerHTML 套壳 —— 假 DOM 里 innerHTML 不解析）
        var cols = document.createElement('div');
        cols.className = 'qcmd-cols';
        cols.id = mid + '-qcmdCols-' + g.id;
        cols.innerHTML = qcmdColsInnerHtml();
        // 「＋ 添加」挂在**这张表表头行的最右**：它属于这一组（往这张表加一行），
        // 跨 .qcmd-item-send / .qcmd-item-del 两条轨道、右对齐，正好落在数据行那两个图标的上方
        var addBtn = document.createElement('button');
        addBtn.className = 'qcmd-col-add';
        addBtn.id = mid + '-qcmdAdd-' + g.id;
        addBtn.textContent = '＋ 添加';
        addBtn.title = '在这一组末尾加一条指令（写进上面这张表）';
        addBtn.addEventListener('click', function(e) { e.stopPropagation(); addQcmdItem(mid, g.id); });
        cols.appendChild(addBtn);
        box.appendChild(cols);
        var items = document.createElement('div');
        items.className = 'qcmd-group-items';
        items.id = mid + '-qcmdGL-' + g.id;
        (g.items || []).forEach(function(it, i) { items.appendChild(makeQcmdItem(mid, g.id, i, it.label, it.value)); });
        box.appendChild(items);
        qlist.appendChild(box);
    });
}

/* ===== 组的新增 / 删除 / 改名 / 折叠 / 拖动排序 ===== */

/// 新建组：追加到最下面，默认带 1 条空指令（用户要求）
function addQcmdGroup(mid) {
    if (!monitors[mid]) return;
    var list = qcmdGroups(mid);
    if (list.length >= QCMD_FILE_MAX_ITEMS) {
        showToast('组太多了（上限 ' + QCMD_FILE_MAX_ITEMS + '）', 'error');
        return;
    }
    var g = { id: qcmdNewGroupId(), name: '循环 ' + (list.length + 1),
              items: [{ label: '', value: '', seq: 0, timeout: QCMD_TIMEOUT_DEFAULT, hex: false }] };
    list.push(g);
    // 挂了文件：新组要在文件里补出自己那一节（抬头 + 表 + 这一行）
    if (monitors[mid].quickCmdsFile) qcmdInsertItemBlock(mid, g.id, g.items[0]);
    rebuildQcmdList(mid);
    scheduleConfigSave();
    scheduleQcmdFileSave(mid);
    if (monitors[mid].qcmdLoop) qcmdLoopSyncPlan(mid);   // 跑着的时候加组：纳入计划，不用重启
    showToast('已新建「' + g.name + '」（拖抬头可以调它的位置：最上面那组是循环起点）', 'success');
}

function removeQcmdGroup(mid, gid) {
    var list = qcmdGroups(mid);
    var gi = qcmdGroupIndex(mid, gid);
    if (gi < 0) return;
    if (list.length <= 1) {
        showToast('至少要留一组：可以删掉组里的指令，但组本身得留着', 'error');
        return;
    }
    var g = list[gi];
    var n = (g.items || []).length;
    list.splice(gi, 1);
    qcmdRemoveGroupBlocks(mid, gid);    // 文件里那张表（含抬头）一起删掉
    rebuildQcmdList(mid);
    scheduleConfigSave();
    scheduleQcmdFileSave(mid);
    if (monitors[mid].qcmdLoop) qcmdLoopSyncPlan(mid);
    showToast('已删除「' + (g.name || '') + '」' + (n ? '（连带 ' + n + ' 条指令）' : ''), 'success');
}

function renameQcmdGroup(mid, gid, name) {
    var g = qcmdGroupById(mid, gid);
    if (!g) return;
    g.name = String(name == null ? '' : name).slice(0, QCMD_FILE_MAX_LABEL);
    qcmdRenameGroupBlock(mid, gid, g.name);   // 文件里那行抬头跟着改
    var cnt = document.getElementById(mid + '-qcmdGn-' + gid);
    if (cnt) cnt.title = '点一下改名';
    scheduleConfigSave();
    scheduleQcmdFileSave(mid);
}

function toggleQcmdGroupFold(mid, gid) {
    var g = qcmdGroupById(mid, gid);
    if (!g) return;
    g.folded = !g.folded;
    var box = document.getElementById(mid + '-qcmdGbox-' + gid);
    if (box) box.classList.toggle('folded', !!g.folded);
    var band = document.getElementById(mid + '-qcmdG-' + gid);
    if (band) {
        band.classList.toggle('folded', !!g.folded);
        var fold = band.querySelector('.qcmd-group-fold');
        if (fold) fold.title = g.folded ? '展开这一组' : '折叠这一组';   // 箭头朝向由 .folded 上的 CSS 决定
    }
    scheduleConfigSave();
}

/* 拖动排序：按住抬头左侧的握把上下拖。指针越过邻组的**中线**就换位（经典 sortable 手感），
   松手时写配置 + 写回文件（文件里的表顺序跟着变 —— 用户要求"每次拖动就会更改文件"）。
   ⚠️ 换位时**只挪已有的 DOM 节点**（`qcmdReorderBoxes`），绝不 `rebuildQcmdList`：
   重建会整块替换 DOM —— 既没有过渡动画（用户 2026-09 反馈"拖动的时候怎么没有动画"），
   又会把正在拖的那个元素换掉、焦点和事件监听一起丢。 */
var _qcmdGroupDrag = null;

/// 重排组盒子并做 FLIP 动画：先记下各盒子当前位置，执行 reorder() 后把位移差用 transform 抵掉，
/// 下一帧放开过渡 → 盒子平滑滑到新位置（比"重建 DOM 硬跳"高一档，且不用引入动画库）。
function qcmdReorderBoxes(mid, reorder) {
    var qlist = document.getElementById(mid + '-qcmdList');
    if (!qlist) { reorder(); return; }
    var boxes = Array.prototype.slice.call(qlist.children || []);
    var canAnim = boxes.length > 0 && boxes.every(function(b) {
        return b && typeof b.getBoundingClientRect === 'function';
    });
    var firstTop = canAnim ? boxes.map(function(b) { return b.getBoundingClientRect().top; }) : null;
    reorder();
    if (!canAnim) return;                       // 无头断言用的假 DOM 没有布局 → 直接跳过动画
    var raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame : function(fn) { fn(); };
    boxes.forEach(function(b, i) {
        var dy = firstTop[i] - b.getBoundingClientRect().top;
        if (!dy) return;
        b.style.transition = 'none';
        b.style.transform = 'translateY(' + dy + 'px)';
        raf(function() {
            b.style.transition = 'transform .18s ease';
            b.style.transform = '';
        });
    });
}

function startQcmdGroupDrag(e, mid, gid) {
    if (!e || e.button !== 0) return;
    var band = document.getElementById(mid + '-qcmdG-' + gid);
    if (!band) return;
    e.preventDefault();
    _qcmdGroupDrag = { mid: mid, gid: gid, moved: false, y: e.clientY };
    var box = document.getElementById(mid + '-qcmdGbox-' + gid);
    if (box) box.classList.add('dragging');
    band.classList.add('dragging');
    document.addEventListener('mousemove', onQcmdGroupDragMove);
    document.addEventListener('mouseup', endQcmdGroupDrag);
}

function onQcmdGroupDragMove(e) {
    if (!_qcmdGroupDrag) return;
    var d = _qcmdGroupDrag, mid = d.mid;
    var list = qcmdGroups(mid);
    var gi = qcmdGroupIndex(mid, d.gid);
    if (gi < 0) return;
    var band = document.getElementById(mid + '-qcmdG-' + d.gid);
    if (!band) return;
    if (Math.abs(e.clientY - d.y) > 2) d.moved = true;
    // 找"指针已经越过中线"的那一组，跟它换位（一次只换一格，手感更稳）
    var boxes = list.map(function(g) { return document.getElementById(mid + '-qcmdG-' + g.id); });
    var target = -1;
    for (var i = 0; i < boxes.length; i++) {
        if (!boxes[i] || !boxes[i].getBoundingClientRect) continue;
        var r = boxes[i].getBoundingClientRect();
        if (i < gi && e.clientY < r.top + r.height / 2) { target = i; break; }
        if (i > gi && e.clientY > r.top + r.height / 2) { target = i; }
    }
    if (target < 0 || target === gi) return;
    qcmdMoveGroup(mid, d.gid, target);             // 与 MCP 的 quickGroup/move 同一条路（含 FLIP 动画）
    band.classList.add('dragging');                // 节点没被换掉，补一次也无妨（幂等）
}

function endQcmdGroupDrag() {
    if (!_qcmdGroupDrag) return;
    var mid = _qcmdGroupDrag.mid, gid = _qcmdGroupDrag.gid, moved = _qcmdGroupDrag.moved;
    var band = document.getElementById(mid + '-qcmdG-' + gid);
    if (band) band.classList.remove('dragging');
    var box = document.getElementById(mid + '-qcmdGbox-' + gid);
    if (box) box.classList.remove('dragging');
    document.removeEventListener('mousemove', onQcmdGroupDragMove);
    document.removeEventListener('mouseup', endQcmdGroupDrag);
    _qcmdGroupDrag = null;
    if (!moved) return;                 // 只是点了一下握把
    scheduleConfigSave();
    scheduleQcmdFileSave(mid);
    showToast('组顺序已更新：循环从最上面那组开始（文件里的表顺序也跟着改了）', 'success');
}

function makeQcmdItem(mid, gid, idx, label, value) {
    // label/value 只是模板参数；顺序号/延时/HEX 都从监视器模型里读，避免再多三个形参。
    // 组是必须的：条目现在住在某个组里，id 也要带组（否则两组的下标会撞）。
    var model = qcmdItemAt(mid, gid, idx);
    var hexOn = qcmdItemHex(model);

    var item = document.createElement('div');
    item.className = 'qcmd-item';
    item.id = qcmdItemElId(mid, gid, idx);

    // 顺序号：方形小框，默认 0（= 不参与循环发送）。组内按它从小到大发。
    var seqInp = document.createElement('input');
    seqInp.className = 'qcmd-item-seq' + (qcmdItemSeq(model) > 0 ? ' on' : '');
    seqInp.id = qcmdItemElId(mid, gid, idx, 'seq');
    seqInp.type = 'text';
    seqInp.setAttribute('inputmode', 'numeric');
    seqInp.setAttribute('autocomplete', 'off');
    seqInp.value = String(qcmdItemSeq(model));
    seqInp.title = '本组内的循环顺序号：0 = 不参与；大于 0 的按数字从小到大依次发送';
    seqInp.addEventListener('click', function(e) { e.stopPropagation(); });
    seqInp.addEventListener('input', function() {
        var v = qcmdDigits(this.value, 4);
        if (this.value !== v) this.value = v;
        var n = v ? parseInt(v, 10) : 0;
        var it = qcmdItemAt(mid, gid, idx);
        if (it) it.seq = n;
        this.classList.toggle('on', n > 0);
        scheduleConfigSave();
    });

    var valInp = document.createElement('input');
    valInp.className = 'qcmd-item-val';
    valInp.id = qcmdItemElId(mid, gid, idx, 'val');   // 补 id：MCP 的 ui_list/ui_set 才够得到这一格
    valInp.type = 'text';
    valInp.value = value;
    valInp.placeholder = '指令内容...';
    valInp.setAttribute('autocomplete', 'off');
    valInp.setAttribute('spellcheck', 'false');
    valInp.addEventListener('click', function(e) { e.stopPropagation(); });
    valInp.addEventListener('input', function() {
        var it = qcmdItemAt(mid, gid, idx);
        // 名称不再有界面入口，但 label 仍原样留在数据/文件里（写回时那一列不会被抹掉）
        if (it) it.value = this.value;
        scheduleConfigSave();
        scheduleQcmdFileSave(mid);      // 挂了文件就写回文件（文件即存储）
    });
    valInp.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); sendQcmdItem(mid, gid, idx); }
    });

    // 超时（毫秒）：这条发出去最多等多久 —— 等到 OK 发下一条 / 等到 ERROR 重发本条 / 等满就终止整条循环。
    // 填 0 = 这条不等响应（连续 HEX 帧、设备本来就不回 OK 的指令）。
    // ⚠️ 类名与 id 后缀仍然是 `delay`：CSS 的 grid 轨道、MCP 的 domIds 都按它认门，
    // 换名字要连带改一堆断言与 AI 侧的 domIds，而这一格的含义由列标题与 title 说清楚就够了。
    var timeoutInp = document.createElement('input');
    timeoutInp.className = 'qcmd-item-delay';
    timeoutInp.id = qcmdItemElId(mid, gid, idx, 'delay');
    timeoutInp.type = 'text';
    timeoutInp.setAttribute('inputmode', 'numeric');
    timeoutInp.setAttribute('autocomplete', 'off');
    timeoutInp.value = String(qcmdItemTimeout(model));
    timeoutInp.title = qcmdTimeoutTitle(model);
    syncQcmdTimeoutMark(timeoutInp, model);
    timeoutInp.addEventListener('click', function(e) { e.stopPropagation(); });
    timeoutInp.addEventListener('input', function() {
        var v = qcmdDigits(this.value, 6);
        if (this.value !== v) this.value = v;
    });
    timeoutInp.addEventListener('change', function() {
        var it = qcmdItemAt(mid, gid, idx);
        // 留空 = 回到缺省（别让"清空输入框"变成 0 毫秒的疯跑）
        var n = this.value === '' ? QCMD_TIMEOUT_DEFAULT : parseInt(this.value, 10);
        n = qcmdItemTimeout({ timeout: n });
        if (it) it.timeout = n;
        this.value = String(n);
        this.title = qcmdTimeoutTitle(it);
        syncQcmdTimeoutMark(this, it);
        scheduleConfigSave();
    });

    // HEX 使能（每条独立，默认关）
    var hexBtn = document.createElement('button');
    hexBtn.className = 'qcmd-item-hex' + (hexOn ? ' on' : '');
    hexBtn.id = qcmdItemElId(mid, gid, idx, 'hex');
    hexBtn.textContent = 'HEX';
    hexBtn.title = '本条按 HEX 格式发送（默认关闭；与主发送栏的文本/HEX 模式互不影响）';
    hexBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        var it = qcmdItemAt(mid, gid, idx);
        var on = !qcmdItemHex(it);
        if (it) it.hex = on;
        this.classList.toggle('on', on);
        scheduleConfigSave();
    });

    var sendBtn = document.createElement('button');
    sendBtn.className = 'qcmd-item-send';
    sendBtn.innerHTML = ICONS.sendIcon;
    sendBtn.title = '发送';
    sendBtn.disabled = !monitors[mid].isConnected;
    sendBtn.setAttribute('data-qsend', '1');
    sendBtn.addEventListener('click', function(e) { e.stopPropagation(); sendQcmdItem(mid, gid, idx); });

    var delBtn = document.createElement('button');
    delBtn.className = 'qcmd-item-del';
    delBtn.title = '删除';
    delBtn.innerHTML = '&#xd7;';
    delBtn.addEventListener('click', function(e) { e.stopPropagation(); removeQcmdItem(mid, gid, idx); });

    item.appendChild(seqInp);
    item.appendChild(valInp);
    item.appendChild(timeoutInp);
    item.appendChild(hexBtn);
    item.appendChild(sendBtn);
    item.appendChild(delBtn);
    return item;
}

/// 超时那一格的悬停说明：把"这条还有文件里才有的自定义条件"也说出去（面板上没有它们的入口）
function qcmdTimeoutTitle(it) {
    var base = '超时（毫秒）：这条发出去最多等多久。等到 OK 就发下一条；等到 ERROR 就重发本条（默认最多 '
             + QCMD_RETRY_DEFAULT + ' 次）；等满这个时间还没等到 OK 就走「失败跳转」（没配就终止整条循环）。'
             + '填 0 = 这条不等响应';
    var extra = [];
    if (qcmdItemExpect(it)) extra.push('期望 = ' + qcmdItemExpect(it));
    if (qcmdItemRetry(it) !== QCMD_RETRY_DEFAULT) extra.push('重试 = ' + qcmdItemRetry(it));
    var og = qcmdItemOkGoto(it), eg = qcmdItemErrGoto(it);
    if (og) extra.push('成功跳转 = ' + (og === 'end' ? '结束' : '顺序号 ' + og));
    if (eg) extra.push('失败跳转 = ' + (eg === 'end' ? '结束' : '顺序号 ' + eg));
    return extra.length ? (base + '（本条另有：' + extra.join('、') + '，写在文件里）') : base;
}

/// 这一格有没有"只在文件里配得到的额外条件"→ 描一层淡边标出来，别让它静默生效
function syncQcmdTimeoutMark(el, it) {
    if (!el) return;
    el.classList.toggle('has-extra', !!qcmdItemExpect(it) || qcmdItemRetry(it) !== QCMD_RETRY_DEFAULT
        || !!qcmdItemOkGoto(it) || !!qcmdItemErrGoto(it));
}

// 返回 true = 真的加上了；false = 被条目上限挡下（调用方必须**如实报失败**，别假装成功）。
function addQcmdItem(mid, gid) {
    var g = qcmdGroupById(mid, gid);
    if (!g) return false;
    // 条目总数上限：文件读入端在 500 条处截断（超出部分 skipped），所以内存里**绝不能**越过这条线 ——
    // 否则写回的文件超限 → 重载被截断到 500 → 之后每次写回都用"截断后的模型"整份覆盖文件，
    // 用户多出来的那些指令就永久没了（与 AGENTS 里"文件与面板对不上"同一类事故）。
    if (qcmdItemTotal(mid) >= QCMD_FILE_MAX_ITEMS) {
        showToast('指令太多了（上限 ' + QCMD_FILE_MAX_ITEMS + ' 条）：先删掉几条再加', 'error');
        return false;
    }
    var idx = (g.items || []).length;
    // 名称按用户要求退出界面：新条目不再取「指令N」这种占位名，label 留空
    g.items.push({label: '', value: '', seq: 0, timeout: QCMD_TIMEOUT_DEFAULT, hex: false});
    var holder = document.getElementById(mid + '-qcmdGL-' + gid);
    if (holder) holder.appendChild(makeQcmdItem(mid, gid, idx, g.items[idx].label, g.items[idx].value));
    qcmdInsertItemBlock(mid, gid, g.items[idx]);   // 挂了文件：块的插入点要跟上，否则写回时漏掉这条
    scheduleConfigSave();
    scheduleQcmdFileSave(mid);             // 新增的这条也要落在目标文件里
    return true;
}

function removeQcmdItem(mid, gid, idx) {
    var g = qcmdGroupById(mid, gid);
    if (!g || !g.items[idx]) return;
    var removed = g.items[idx];
    g.items.splice(idx, 1);
    qcmdRemoveItemBlock(mid, removed);     // 块也要删，否则写回时这条又冒出来
    rebuildQcmdList(mid);
    scheduleConfigSave();
    scheduleQcmdFileSave(mid);
    if (monitors[mid].qcmdLoop) qcmdLoopSyncPlan(mid);
}

/// 取某条的指令内容：优先读输入框（可能刚敲完还没触发 input/失焦）
function qcmdItemText(mid, gid, idx) {
    var item = document.getElementById(mid + '-qcmdi-' + gid + '-' + idx);
    var valInp = item ? item.querySelector('.qcmd-item-val') : null;
    if (valInp) return valInp.value;
    var it = qcmdItemAt(mid, gid, idx);
    return it ? (it.value || '') : '';
}

/// 按文本/HEX 两种格式之一发一条 —— 手动点发、Enter、循环发送**共用这一条路径**
/// （绝不为循环发送另写一套，否则两条路迟早漂移）
async function sendQcmdPayload(mid, text, hexMode) {
    if (!monitors[mid] || !monitors[mid].isConnected) return false;
    var bytes;
    try {
        if (hexMode) { bytes = hexToBytes(text); }
        else { text = parseEscapes(text); text += leStr(mid); bytes = new TextEncoder().encode(text); }
    } catch (e) { appendOutput(mid, 'err', '格式错误: ' + e); return false; }
    try {
        // 先显示 echo，再发送数据
        var echoBtn = document.getElementById(mid + '-btnEcho');
        if (echoBtn && echoBtn.classList.contains('on')) {
            appendOutput(mid, 'send', hexMode ? 'HEX: ' + bytesToHex(bytes) : decodeRaw(bytes));
        }
        var isWsl = monitors[mid].isWsl;
        if (isWsl) { await invokeTimeout('send_wsl_serial', { monitorId: mid, data: Array.from(bytes) }, 5000); }
        else { await invokeTimeout('send_data', { monitorId: mid, data: Array.from(bytes) }, 5000); }
        monitors[mid].histNavIdx = -1;
        scheduleConfigSave();
        return true;
    } catch (e) { appendOutput(mid, 'err', '发送失败: ' + e); return false; }
}

async function sendQcmdItem(mid, gid, idx) {
    if (!monitors[mid] || !monitors[mid].isConnected) return false;
    var text = qcmdItemText(mid, gid, idx);
    if (!text) return false;
    // 格式由**本条自己的 HEX 使能按钮**决定（见 makeQcmdItem 上方的说明）
    return sendQcmdPayload(mid, text, qcmdItemHex(qcmdItemAt(mid, gid, idx)));
}

/* ===== 循环发送（一条链：组从上到下 → 组内顺序号从小到大，**一条一条来、等它回话**） =====
   参与条件：顺序号 > 0。开启前置条件：串口已连接 + 整条链上至少有一条可发 ——
   不满足就当场拒绝并说明原因，绝不"悄悄开着但什么都不发"。
   每条的节奏由**超时**那一格说了算：
     超时 > 0 → 发出去后等回话：busy 继续等（不重发）/ 收到 OK 发下一条 /
                收到 ERROR 重发本条（默认最多 3 次）/ 等满超时还没等到 OK → **终止整条链**
     超时 = 0 → 不等回话，发完就过（连续 HEX 帧、或设备本来就不回 OK 的指令）
   判定放在 **Rust 侧**（`qcmd_hs_*` 四个命令）：普通串口由读线程直接喂数据，
   WSL 由前端把轮询拉到的数据喂进去 —— 两边共用同一份判定，绝不在 JS 里再写一套（那必然漂移）。
   自愈：跑的过程中断开连接 / 链上再没有可发的条目 → 自动停止并说明（不留还在跑的定时器）。 */
var _qcmdLoopTimers = {};   // mid → 待执行的 setTimeout id（按监视器各一份）
var _qcmdLoopBusy = {};     // mid → true = 正在"发出去等回话"（挡住重入：一次只跑一条）
var _qcmdHsPoll = {};       // mid → 等回话时的轮询 interval id

var QCMD_HS_POLL_MS = 60;        // 问 Rust "这条回话了吗"的间隔
var QCMD_HS_GRACE_MS = 400;      // 在 Rust 的超时之上再宽限一点（网络/定时器抖动，别抢答）
var QCMD_RETRY_GAP_MS = 300;     // 收到 ERROR 后隔多久重发
var QCMD_LOOP_MIN_GAP_MS = 20;   // 不等回话的条目之间的最小间隔（防"0 超时"连成紧凑死循环刷爆串口）

/// 循环过程的每一步都写进输出区 —— 面板上没有为它新增任何控件，用户就是靠这几行看它在干什么
function qcmdLog(mid, text, cls) {
    try { appendOutput(mid, cls || 'sys', '[快速指令] ' + text); } catch (e) { /* 输出区没了就算了 */ }
}

function qcmdLoopRunning(mid) { return !!(monitors[mid] && monitors[mid].qcmdLoop); }

/// 折叠条的提示文案：把"循环发送在跑"这件事也说出去 —— 折叠时分栏里发生什么完全看不见
function qcmdSideTabTitle(mid, open) {
    var running = qcmdLoopRunning(mid);
    if (open) return '收起快速指令（左右拖动可调宽）' + (running ? '；循环发送进行中' : '');
    return '展开快速指令' + (running ? '（循环发送进行中，展开可停止）' : '');
}

/// 把开关按钮刷成当前状态（开启态填主题色 + 亮圆点，文案也跟着换）。
/// 折叠条同时挂一个 `loop` 标记（CSS 画一颗一闪一闪的小点）：分栏折起来时循环**不会停**，
/// 那颗小点是唯一的可见信号，少它就是"界面看起来什么都没发生，设备却一直在收指令"。
function syncQcmdLoopBtn(mid) {
    var on = qcmdLoopRunning(mid);
    var btn = document.getElementById(mid + '-btnQcmdLoop');
    if (btn) {
        btn.classList.toggle('on', on);
        btn.title = on ? QCMD_LOOP_TITLE_ON : QCMD_LOOP_TITLE_OFF;
    }
    var tab = document.getElementById(mid + '-btnQcmdSide');
    if (tab) {
        tab.classList.toggle('loop', on);
        tab.title = qcmdSideTabTitle(mid, qcmdSideOpen(mid));
    }
}

/// 停掉循环（toast 只在"自愈停止"时给，用户主动关不给）
function stopQcmdLoop(mid, reason) {
    if (_qcmdLoopTimers[mid]) { clearTimeout(_qcmdLoopTimers[mid]); delete _qcmdLoopTimers[mid]; }
    if (_qcmdHsPoll[mid]) { clearInterval(_qcmdHsPoll[mid]); delete _qcmdHsPoll[mid]; }
    delete _qcmdLoopBusy[mid];
    var m = monitors[mid];
    if (m) { m.qcmdLoop = false; m._qcmdLoopPos = 0; m._qcmdGotoRun = 0; }
    // 让 Rust 把"正在等回话"的状态也清掉：下一次 arm 会重置，但留着就是一处悬挂状态
    invoke('qcmd_hs_stop', { monitorId: mid }).catch(function() {});
    syncQcmdLoopBtn(mid);
    if (reason) { showToast(reason, 'error'); qcmdLog(mid, reason, 'err'); }
}

/// 跑着的时候改了组序/加了组/删了条目：把轮次位置钳进新计划的长度里
/// （链本身每步都重算，所以顺序会立刻跟着走，不需要重启循环）
function qcmdLoopSyncPlan(mid) {
    var m = monitors[mid];
    if (!m || !m.qcmdLoop) return;
    var n = qcmdLoopPlan(mid).length;
    if (!n) { stopQcmdLoop(mid, '已经没有顺序号大于 0 的指令，循环发送已停止'); return; }
    if (!(m._qcmdLoopPos >= 0) || m._qcmdLoopPos >= n) m._qcmdLoopPos = 0;
}

/// 日志与 toast 里那条指令的"名份"：组名 + 顺序号 + 指令内容（截断）
function qcmdStepLabel(mid, step, it) {
    var g = qcmdGroupById(mid, step.gid);
    var v = (it && it.value) ? String(it.value) : '';
    if (v.length > 24) v = v.slice(0, 24) + '…';
    return '「' + ((g && g.name) || '未命名组') + '」顺序号 ' + step.seq + ' ' + v;
}

function qcmdSleep(ms) { return new Promise(function(r) { setTimeout(r, Math.max(0, ms || 0)); }); }
function qcmdHsStop(mid) { return invoke('qcmd_hs_stop', { monitorId: mid }).catch(function() {}); }

/// 排下一步（统一的定时器入口：停循环时只要清这一个 id）
function qcmdLoopSchedule(mid, ms) {
    if (_qcmdLoopTimers[mid]) { clearTimeout(_qcmdLoopTimers[mid]); delete _qcmdLoopTimers[mid]; }
    _qcmdLoopTimers[mid] = setTimeout(function() {
        delete _qcmdLoopTimers[mid];
        qcmdLoopStep(mid);
    }, Math.max(0, ms || 0));
}

/// Rust 侧状态 → 前端结论：'ok' | 'err' | 'timeout' | 'stopped'；`''` = 还没有结论（含 busy，继续等）
function qcmdVerdictOf(state) {
    var s = String(state == null ? '' : state);
    if (s === 'ok' || s === 'err' || s === 'timeout') return s;
    if (s === 'idle') return 'stopped';       // 期间被 stop 掉了
    return '';                                // waiting / busy / 认不出来的 → 继续等
}

/// 终止时的完整原因（哪一条 / 等了多久 / 为什么）—— toast 与输出区共用这一份文案
function qcmdStopReasonOf(kind, label, timeoutMs, retry) {
    if (kind === 'err-exhausted') {
        return '错误终止：' + label + ' 连续 ' + (retry + 1) + ' 次收到 ERROR（循环已停止）';
    }
    return '超时终止：' + label + ' 在 ' + timeoutMs + 'ms 内没有收到 OK（循环已停止）';
}

/// 等这一条的回话结论。**判定在 Rust 侧**（busy 继续等 / OK / ERROR / 超时），
/// 这里只按节奏去问它 —— 前端轮询频率不影响判定本身，只影响"多快知道"。
function qcmdWaitVerdict(mid, timeoutMs, label) {
    return new Promise(function(resolve) {
        var deadline = Date.now() + timeoutMs + QCMD_HS_GRACE_MS;
        var busyLogged = false;
        var done = function(v) {
            if (_qcmdHsPoll[mid]) { clearInterval(_qcmdHsPoll[mid]); delete _qcmdHsPoll[mid]; }
            resolve(v);
        };
        var tick = function() {
            if (!monitors[mid] || !monitors[mid].qcmdLoop) { done('stopped'); return; }
            invoke('qcmd_hs_state', { monitorId: mid }).then(function(st) {
                if (st && st.busy && !busyLogged) {
                    busyLogged = true;
                    qcmdLog(mid, '第 ' + label + ' 条设备回 busy → 继续等（不重发）');
                }
                var v = qcmdVerdictOf(st && st.state);
                if (v) done(v);
                else if (Date.now() > deadline) done('timeout');   // Rust 自己也超时，这里只是兜底
            }).catch(function() {
                if (Date.now() > deadline) done('timeout');        // 查询失败等下一拍，别把循环卡死
            });
        };
        _qcmdHsPoll[mid] = setInterval(tick, QCMD_HS_POLL_MS);
        tick();
    });
}

/// 送一条并等它的回话。返回 'ok' | 'skip' | 'timeout' | 'err-exhausted' | 'stopped'
async function qcmdRunOne(mid, step, it, label) {
    var timeoutMs = qcmdItemTimeout(it), expect = qcmdItemExpect(it), maxRetry = qcmdItemRetry(it);
    // 超时填 0 = 这条不等回话：发完就走
    if (!timeoutMs) {
        var ok0 = await sendQcmdItem(mid, step.gid, step.ii);
        if (!ok0) {
            if (monitors[mid] && monitors[mid].isConnected) { qcmdLog(mid, '第 ' + label + ' 条没内容可发，已跳过', 'err'); return 'skip'; }
            return 'stopped';
        }
        qcmdLog(mid, '第 ' + label + ' 条已发出（这条填了超时 0 = 不等回话）');
        await qcmdSleep(QCMD_LOOP_MIN_GAP_MS);
        return 'ok';
    }
    for (var attempt = 0; attempt <= maxRetry; attempt++) {
        // ⚠️ arm 必须排在 send **之前**：反过来的话，设备的回话可能赶在 arm 之前到达，
        // 被 Rust 当成"上一条的迟到回话"丢掉 —— 于是这一条必然白等到超时
        try {
            await invokeTimeout('qcmd_hs_arm', { monitorId: mid, expect: expect, timeoutMs: timeoutMs }, 5000);
        } catch (e) {
            qcmdLog(mid, '无法启动响应判定：' + e, 'err');
            return 'stopped';
        }
        var sent = await sendQcmdItem(mid, step.gid, step.ii);
        if (!sent) {
            await qcmdHsStop(mid);
            if (monitors[mid] && monitors[mid].isConnected) { qcmdLog(mid, '第 ' + label + ' 条没内容可发，已跳过', 'err'); return 'skip'; }
            qcmdLog(mid, '第 ' + label + ' 条发送失败（连接已断），循环已停止', 'err');
            return 'stopped';
        }
        qcmdLog(mid, '第 ' + label + ' 条已发出，等 OK（最多 ' + timeoutMs + 'ms'
                    + (expect ? '，认 ' + expect : '') + '）');
        var v = await qcmdWaitVerdict(mid, timeoutMs, label);
        if (v === 'ok') { qcmdLog(mid, '第 ' + label + ' 条收到 OK'); return 'ok'; }
        if (v === 'stopped') return 'stopped';
        if (v === 'err') {
            if (attempt < maxRetry) {
                qcmdLog(mid, '第 ' + label + ' 条收到 ERROR → 重发（第 ' + (attempt + 1) + '/' + maxRetry + ' 次）', 'err');
                await qcmdSleep(QCMD_RETRY_GAP_MS);
                continue;
            }
            return 'err-exhausted';
        }
        return 'timeout';
    }
    return 'timeout';
}

/// 一步：发当前这条，然后按它的**超时**等回话；再按「成功跳转 / 失败跳转」决定下一步去哪。
/// 每步都重新取一遍计划 —— 用户中途改顺序号 / 拖组 / 删条目 / 改超时/跳转会立刻生效，不用重启循环。
/// ⚠️ 这是 async，`_qcmdLoopBusy` 是重入闸（一次只跑一条）：**每条退出路径都要放闸**。
async function qcmdLoopStep(mid) {
    var m = monitors[mid];
    if (!m || !m.qcmdLoop || _qcmdLoopBusy[mid]) return;
    if (!m.isConnected) { stopQcmdLoop(mid, '监控已断开，循环发送已停止'); return; }
    var plan = qcmdLoopPlan(mid);
    if (!plan.length) { stopQcmdLoop(mid, '已经没有顺序号大于 0 的指令，循环发送已停止'); return; }
    if (!(m._qcmdLoopPos >= 0) || m._qcmdLoopPos >= plan.length) m._qcmdLoopPos = 0;
    var step = plan[m._qcmdLoopPos];
    var it = qcmdItemAt(mid, step.gid, step.ii);
    // 先按"下一条"推进（原行为）；下面按跳转列**改写**成目标位置
    m._qcmdLoopPos = m._qcmdLoopPos + 1;
    if (!it) { qcmdLoopSchedule(mid, 0); return; }
    var label = qcmdStepLabel(mid, step, it);
    _qcmdLoopBusy[mid] = true;
    var verdict;
    try {
        verdict = await qcmdRunOne(mid, step, it, label);
    } catch (e) {
        verdict = 'stopped';
        qcmdLog(mid, '第 ' + label + ' 条执行异常：' + e, 'err');
    }
    delete _qcmdLoopBusy[mid];
    if (!monitors[mid] || !monitors[mid].qcmdLoop) return;      // 等回话的过程里被停掉了
    if (verdict === 'stopped') return;

    // ---- 跳转：成功走「成功跳转」；**超时或 ERROR 用尽**都算失败，走「失败跳转」----
    // （超时也走失败路径是有意的：配网失败多半是超时而不是 ERROR，只认 ERROR 的话这个功能没用）
    var failed = (verdict === 'timeout' || verdict === 'err-exhausted');
    var gotoSeq = failed ? qcmdItemErrGoto(it) : qcmdItemOkGoto(it);
    var jumped = false;
    if (gotoSeq === 'end') {
        if (failed) {
            stopQcmdLoop(mid, qcmdStopReasonOf(verdict, label, qcmdItemTimeout(it), qcmdItemRetry(it)));
        } else {
            qcmdLog(mid, '第 ' + label + ' 条收到 OK，按「成功跳转 = 结束」收尾');
            stopQcmdLoop(mid);                       // 正常收尾：不给 toast（这不是错误）
        }
        return;
    }
    if (gotoSeq) {
        // 计划可能在这一条等回话的期间被改过 → **重新取一遍**再定位（与"每步重取计划"同一纪律）
        var plan2 = qcmdLoopPlan(mid);
        var idx = qcmdPlanIndexOfSeq(plan2, gotoSeq);
        if (idx >= 0) {
            m._qcmdLoopPos = idx;
            jumped = true;
            // **连续**跳转计数：中间只要顺序推进一步就清零 —— 它抓的是"只在几条之间打转"的死循环
            m._qcmdGotoRun = (m._qcmdGotoRun || 0) + 1;
            qcmdLog(mid, '第 ' + label + ' 条' + (failed ? '失败' : '收到 OK') + ' → 跳转到顺序号 ' + gotoSeq);
            if (m._qcmdGotoRun > QCMD_GOTO_MAX) {
                stopQcmdLoop(mid, '跳转次数超过上限 ' + QCMD_GOTO_MAX + '（顺序号 ' + gotoSeq
                    + ' 附近形成了死循环）—— 循环已停止');
                return;
            }
        } else {
            // 目标不在计划里（被删了 / 顺序号改了）：**降级**并写清原因，绝不静默乱跳
            qcmdLog(mid, '第 ' + label + ' 条的跳转目标「顺序号 ' + gotoSeq + '」已经不在计划里 → 按'
                        + (failed ? '终止' : '下一条') + '处理', 'err');
            if (failed) {
                stopQcmdLoop(mid, qcmdStopReasonOf(verdict, label, qcmdItemTimeout(it), qcmdItemRetry(it))
                    + '（失败跳转的目标不存在，已按终止处理）');
                return;
            }
        }
    } else if (failed) {
        // 没配「失败跳转」= 原行为：终止整条链
        stopQcmdLoop(mid, qcmdStopReasonOf(verdict, label, qcmdItemTimeout(it), qcmdItemRetry(it)));
        return;
    }
    if (!jumped) m._qcmdGotoRun = 0;      // 顺序推进 → 断掉"连续跳转"的计数
    qcmdLoopSchedule(mid, 0);
}

/// 开/关循环发送（on=true 的三种拒绝路径都会把开关留在关闭态）
function setQcmdLoop(mid, on) {
    var m = monitors[mid];
    if (!m) return false;
    if (!on) { stopQcmdLoop(mid); return false; }
    // 前置检查与 MCP 的 quickLoop 共用一份文案（qcmdLoopRefusal）—— 两处各写一套必然漂移
    var why = qcmdLoopRefusal(mid);
    if (why) {
        showToast(why, 'error');
        syncQcmdLoopBtn(mid);
        return false;
    }
    if (m.qcmdLoop) return true;                   // 已经在跑：不重开（免得把轮次位置重置）
    m.qcmdLoop = true;
    m._qcmdLoopPos = 0;
    m._qcmdGotoRun = 0;      // 连续跳转计数：新开一轮必须从零开始
    syncQcmdLoopBtn(mid);
    qcmdLoopStep(mid);
    return true;
}

function toggleQcmdLoop(mid) { return setQcmdLoop(mid, !qcmdLoopRunning(mid)); }

function updateQcmdSendBtns(mid, connected) {
    var qlist = document.getElementById(mid + '-qcmdList');
    if (!qlist) return;
    qlist.querySelectorAll('[data-qsend]').forEach(function(b) {
        b.disabled = !connected;
    });
}

