/* 60-workflow.js —— 前端第 8 块，拆自原单文件 src/index.html（**纯搬家**；行号映射见 doc/FRONTEND_LAYOUT.md）。
   ⚠️ **普通脚本**（不是 ESM）：按 index.html 里的 <script src> 顺序加载、共享同一个全局作用域 —— 行内 onclick
   与现有函数互相调用照旧；**别改成 type="module"**（模块作用域会让它们全部失效）。 */
/* ===== 自动化工作流 UI ===== */

function genWfId() { return 'wf_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4); }

/* ===== 工作流规则的边界与形状（与 Rust 侧 `check_workflow_args` 同一套口径） =====
   面板里改、MCP 改、AI 改，走的都是 `monitor.workflows` 这一份模型；上限**两边都要拦**：
   前端拦是为了"在面板上手工填也拦得住"，Rust 拦是为了"碰界面之前就拒绝"（AGENTS #10）。 */
var WF_MAX_RULES = 50;
var WF_MAX_CONDITIONS = 8;
var WF_MAX_ACTIONS = 8;
var WF_MAX_NAME = 64;
var WF_MAX_COND_VALUE = 512;
var WF_MAX_ACTION_DATA = 4096;

/// 工作流控件的**稳定 id**：注册表按 id 认门。没有 id 的控件只能靠"面板+标签名+文档序"兜底，
/// 规则一增删路径就漂 —— 而 AI 看到那种路径也不知道它是哪条规则的哪个按钮
/// （误点那颗"运行"就等于让规则开始自动往设备发数据）。
function mcpWfElId(mid, ruleId, suffix) { return mid + '-wf-' + ruleId + '-' + suffix; }

/// 动作的延时：**驼峰 `delayBefore` 是既有数据**（前端与 `config.json` 一直是它），
/// snake_case 是 Rust 结构体的字段名 —— 两个都认，别再让"面板填了、后端读不到"重演。
function wfDelayOf(a) {
    if (!a) return 0;
    var raw = (a.delayBefore !== undefined) ? a.delayBefore : a.delay_before;
    var n = parseInt(raw, 10);
    return (isFinite(n) && n > 0) ? n : 0;
}

function mcpWfActionOut(a) {
    a = a || {};
    return { type: a.type || 'send_data', data: a.data || '',
             encoding: a.encoding === 'hex' ? 'hex' : 'text',
             signal: a.signal || '', level: !!a.level, delayBefore: wfDelayOf(a) };
}

function mcpWfConds(payload) {
    return (payload.conditions || []).map(function(c) {
        c = c || {};
        return { type: String(c.type || 'string_contains'),
                 value: String(c.value == null ? '' : c.value).slice(0, WF_MAX_COND_VALUE) };
    });
}

function mcpWfActs(payload) {
    return (payload.actions || []).map(function(a) {
        a = a || {};
        return { type: String(a.type || 'send_data'),
                 data: String(a.data == null ? '' : a.data).slice(0, WF_MAX_ACTION_DATA),
                 encoding: a.encoding === 'hex' ? 'hex' : 'text',
                 signal: String(a.signal || ''),
                 level: !!a.level,
                 delayBefore: wfDelayOf(a) };
    });
}

/// 入参形状校验：返回错误文案（null = 没问题）。与 Rust `check_workflow_args` 同口径。
function mcpWfValidate(payload) {
    var CT = ['string_contains', 'regex', 'exact_bytes'];
    var AT = ['send_data', 'toggle_dtr_rts', 'save_log'];
    if (payload.name !== undefined && String(payload.name).length > WF_MAX_NAME) {
        return '规则名太长：' + String(payload.name).length + ' 字符，上限 ' + WF_MAX_NAME;
    }
    if (payload.conditions !== undefined) {
        if (!Array.isArray(payload.conditions)) return 'conditions 要是数组：[{type, value}]';
        if (!payload.conditions.length) return 'conditions 不能是空数组：一条条件都没有的规则永远不触发';
        if (payload.conditions.length > WF_MAX_CONDITIONS) return 'conditions 最多 ' + WF_MAX_CONDITIONS + ' 条';
        for (var i = 0; i < payload.conditions.length; i++) {
            var c = payload.conditions[i] || {};
            if (CT.indexOf(String(c.type)) < 0) return '第 ' + (i + 1) + ' 条条件的 type 不认得：可用 ' + CT.join(' / ');
            if (String(c.value == null ? '' : c.value).length > WF_MAX_COND_VALUE) {
                return '第 ' + (i + 1) + ' 条条件的 value 最长 ' + WF_MAX_COND_VALUE + ' 字符';
            }
        }
    }
    if (payload.actions !== undefined) {
        if (!Array.isArray(payload.actions)) return 'actions 要是数组：[{type, data, …}]';
        if (!payload.actions.length) return 'actions 不能是空数组：这样的规则命中了也什么都不做';
        if (payload.actions.length > WF_MAX_ACTIONS) return 'actions 最多 ' + WF_MAX_ACTIONS + ' 条';
        for (var j = 0; j < payload.actions.length; j++) {
            var a = payload.actions[j] || {};
            if (AT.indexOf(String(a.type)) < 0) return '第 ' + (j + 1) + ' 个动作的 type 不认得：可用 ' + AT.join(' / ');
            if (String(a.data == null ? '' : a.data).length > WF_MAX_ACTION_DATA) {
                return '第 ' + (j + 1) + ' 个动作的 data 最长 ' + WF_MAX_ACTION_DATA + ' 字符';
            }
        }
    }
    return null;
}

function addWorkflowRule(mid) {
    if (!monitors[mid]) return;
    if (!monitors[mid].workflows) monitors[mid].workflows = [];
    monitors[mid].workflows.push({
        id: genWfId(), name: '新规则', enabled: true, running: false, collapsed: false,
        conditions: [{ type: 'string_contains', value: '' }],
        actions: [{ type: 'send_data', data: '', encoding: 'text', delayBefore: 0 }]
    });
    // 确保更多设置栏和工作流面板都展开
    var advRow = document.getElementById(mid + '-advRow');
    if (advRow && !advRow.classList.contains('vis')) {
        var advBtn = document.getElementById(mid + '-btnAdv');
        if (advBtn) advBtn.classList.add('on');
        advRow.classList.add('vis');
    }
    var wfWrap = document.getElementById(mid + '-advWf');
    if (wfWrap) wfWrap.classList.add('vis');
    renderWorkflowList(mid);
    saveWorkflowConfig(mid);
}

function deleteWorkflowRule(mid, ruleId) {
    if (!monitors[mid] || !monitors[mid].workflows) return;
    monitors[mid].workflows = monitors[mid].workflows.filter(function(r) { return r.id !== ruleId; });
    renderWorkflowList(mid);
    saveWorkflowConfig(mid);
}

function toggleWorkflowEnabled(mid, ruleId, enabled) {
    var rule = findWfRule(mid, ruleId);
    if (rule) { rule.enabled = enabled; saveWorkflowConfig(mid); }
}

function renameWorkflowRule(mid, ruleId, name) {
    var rule = findWfRule(mid, ruleId);
    if (rule) { rule.name = name; saveWorkflowConfig(mid); }
}

function toggleWfRuleCollapse(mid, ruleId) {
    var el = document.getElementById(mid + '-wfRule-' + ruleId);
    if (!el) return;
    el.classList.toggle('collapsed');
    var rule = findWfRule(mid, ruleId);
    if (rule) rule.collapsed = el.classList.contains('collapsed');
    var arrow = el.querySelector('.wf-rule-arrow');
    if (arrow) arrow.style.transform = el.classList.contains('collapsed') ? 'rotate(-90deg)' : '';
    scheduleConfigSave();
}

function findWfRule(mid, ruleId) {
    if (!monitors[mid] || !monitors[mid].workflows) return null;
    return monitors[mid].workflows.find(function(r) { return r.id === ruleId; });
}

function updateWfCondition(mid, ruleId, idx, field, value) {
    var rule = findWfRule(mid, ruleId);
    if (rule && rule.conditions[idx]) { rule.conditions[idx][field] = value; saveWorkflowConfig(mid); }
}

function addWfCondition(mid, ruleId) {
    var rule = findWfRule(mid, ruleId);
    if (!rule) return;
    rule.conditions.push({ type: 'string_contains', value: '' });
    renderWorkflowList(mid);
    saveWorkflowConfig(mid);
}

function removeWfCondition(mid, ruleId, idx) {
    var rule = findWfRule(mid, ruleId);
    if (!rule || rule.conditions.length <= 1) return;
    rule.conditions.splice(idx, 1);
    renderWorkflowList(mid);
    saveWorkflowConfig(mid);
}

function updateWfAction(mid, ruleId, idx, field, value) {
    var rule = findWfRule(mid, ruleId);
    if (rule && rule.actions[idx]) { rule.actions[idx][field] = value; saveWorkflowConfig(mid); }
}

function addWfAction(mid, ruleId) {
    var rule = findWfRule(mid, ruleId);
    if (!rule) return;
    rule.actions.push({ type: 'send_data', data: '', encoding: 'text', delayBefore: 0 });
    renderWorkflowList(mid);
    saveWorkflowConfig(mid);
}

function removeWfAction(mid, ruleId, idx) {
    var rule = findWfRule(mid, ruleId);
    if (!rule || rule.actions.length <= 1) return;
    rule.actions.splice(idx, 1);
    renderWorkflowList(mid);
    saveWorkflowConfig(mid);
}

function saveWorkflowConfig(mid) {
    if (!monitors[mid]) return;
    var rules = monitors[mid].workflows || [];
    invoke('save_workflows', { monitorId: mid, workflowsJson: JSON.stringify(rules) }).catch(function(e) { console.warn('保存工作流失败:', e); reportError(e, 'saveWorkflowConfig'); });
    scheduleConfigSave();
}

function toggleWorkflowRun(mid, ruleId) {
    var rule = findWfRule(mid, ruleId);
    if (!rule) return;
    rule.running = !rule.running;
    // 同步到后端
    saveWorkflowConfig(mid);
    // 只更新按钮外观
    var card = document.getElementById(mid + '-wfRule-' + ruleId);
    if (card) {
        var runBtn = card.querySelector('.wf-run-btn');
        if (runBtn) {
            if (rule.running) {
                runBtn.classList.add('wf-running');
                runBtn.title = '停止';
                runBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 1024 1024" fill="currentColor"><path d="M256 128h170.666667v768H256zM597.333333 128H768v768H597.333333z"/></svg>';
                runBtn.style.cssText = 'background:var(--btn-p);color:#fff;border-color:var(--btn-p);';
            } else {
                runBtn.classList.remove('wf-running');
                runBtn.title = '运行';
                runBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 1024 1024" fill="currentColor"><path d="M725.333333 512L362.666667 256v512z"/></svg>';
                runBtn.style.cssText = '';
            }
        }
    }
}

function renderWorkflowList(mid) {
    var list = document.getElementById(mid + '-wfList');
    var wfContainer = document.getElementById(mid + '-advWf');
    var advRow = document.getElementById(mid + '-advRow');
    if (!list) return;
    var workflows = (monitors[mid] && monitors[mid].workflows) || [];
    // 切换 has-rules 类
    if (wfContainer) wfContainer.classList.toggle('has-rules', workflows.length > 0);
    // 如果更多设置栏可见且有规则，显示工作流面板；无规则则隐藏
    if (wfContainer && advRow && advRow.classList.contains('vis')) {
        wfContainer.classList.toggle('vis', workflows.length > 0);
    }
    list.innerHTML = '';
    if (workflows.length === 0) return;
    workflows.forEach(function(rule) {
        var card = document.createElement('div');
        var isCollapsed = !!rule.collapsed;
        card.className = 'wf-rule' + (isCollapsed ? ' collapsed' : '');
        card.id = mid + '-wfRule-' + rule.id;

        // Header
        var header = document.createElement('div');
        header.className = 'wf-rule-header';
        var isRunning = rule.running || false;
        var runIcon = isRunning
            ? '<svg width="14" height="14" viewBox="0 0 1024 1024" fill="currentColor"><path d="M256 128h170.666667v768H256zM597.333333 128H768v768H597.333333z"/></svg>'
            : '<svg width="20" height="20" viewBox="0 0 1024 1024" fill="currentColor"><path d="M725.333333 512L362.666667 256v512z"/></svg>';
        header.innerHTML =
            '<input type="checkbox" class="wf-enabled" id="' + mcpWfElId(mid, rule.id, 'enabled') + '" name="wf-enabled"' + (rule.enabled ? ' checked' : '') + ' onchange="toggleWorkflowEnabled(\'' + mid + '\',\'' + rule.id + '\',this.checked)">' +
            '<input class="wf-rule-name" id="' + mcpWfElId(mid, rule.id, 'name') + '" name="wf-rule-name" value="' + escapeHtml(rule.name) + '" onchange="renameWorkflowRule(\'' + mid + '\',\'' + rule.id + '\',this.value)">' +
            '<button class="wf-rule-btn wf-run-btn' + (isRunning ? ' wf-running' : '') + '" id="' + mcpWfElId(mid, rule.id, 'run') + '" data-mcp-skip="1" onclick="toggleWorkflowRun(\'' + mid + '\',\'' + rule.id + '\')" title="' + (isRunning ? '停止' : '运行') + '" style="' + (isRunning ? 'background:var(--btn-p);color:#fff;border-color:var(--btn-p);' : '') + '">' + runIcon + '</button>' +
            '<button class="wf-rule-btn wf-rule-arrow" id="' + mcpWfElId(mid, rule.id, 'fold') + '" onclick="toggleWfRuleCollapse(\'' + mid + '\',\'' + rule.id + '\')" title="折叠/展开" style="transition:transform .2s ease;' + (isCollapsed ? 'transform:rotate(-90deg);' : '') + '">' + ICONS.chevronDown + '</button>' +
            '<button class="wf-rule-btn del" id="' + mcpWfElId(mid, rule.id, 'del') + '" onclick="deleteWorkflowRule(\'' + mid + '\',\'' + rule.id + '\')" title="删除">&#xd7;</button>';
        card.appendChild(header);

        // Body
        var body = document.createElement('div');
        body.className = 'wf-rule-body';

        // Conditions section
        var condSection = document.createElement('div');
        condSection.className = 'wf-section';
        condSection.innerHTML = '<div class="wf-section-title">匹配条件 (全部满足)</div>';
        rule.conditions.forEach(function(cond, ci) {
            var row = document.createElement('div');
            row.className = 'wf-row';
            row.innerHTML =
                '<div class="sel" onclick="toggleSelDrop(this)">' +
                    '<span class="sel-text">' + wfCondLabel(cond.type) + '</span><span class="sel-arrow">&#9660;</span>' +
                    '<div class="sel-drop">' +
                        '<div class="sel-opt' + (cond.type==='string_contains'?' active':'') + '" data-val="string_contains" onclick="setWfCondType(this,\'' + mid + '\',\'' + rule.id + '\',' + ci + ',\'string_contains\',event)">字符串包含</div>' +
                        '<div class="sel-opt' + (cond.type==='regex'?' active':'') + '" data-val="regex" onclick="setWfCondType(this,\'' + mid + '\',\'' + rule.id + '\',' + ci + ',\'regex\',event)">正则表达式</div>' +
                        '<div class="sel-opt' + (cond.type==='exact_bytes'?' active':'') + '" data-val="exact_bytes" onclick="setWfCondType(this,\'' + mid + '\',\'' + rule.id + '\',' + ci + ',\'exact_bytes\',event)">精确字节(HEX)</div>' +
                    '</div>' +
                '</div>' +
                '<input type="text" id="' + mcpWfElId(mid, rule.id, 'c' + ci) + '" name="wf-cond-value" value="' + escapeHtml(cond.value) + '" placeholder="' + wfCondPlaceholder(cond.type) + '" oninput="updateWfCondition(\'' + mid + '\',\'' + rule.id + '\',' + ci + ',\'value\',this.value)">' +
                '<button class="wf-row-btn" onclick="addWfCondition(\'' + mid + '\',\'' + rule.id + '\')" title="添加条件">+</button>' +
                '<button class="wf-row-btn del" onclick="removeWfCondition(\'' + mid + '\',\'' + rule.id + '\',' + ci + ')" title="删除条件">&#xd7;</button>';
            condSection.appendChild(row);
        });
        body.appendChild(condSection);

        // Actions section
        var actSection = document.createElement('div');
        actSection.className = 'wf-section';
        actSection.innerHTML = '<div class="wf-section-title">执行动作 (按顺序)</div>';
        rule.actions.forEach(function(act, ai) {
            var row = document.createElement('div');
            row.className = 'wf-row';
            // 显式标记：`renderWfActRow` 按它定位要重渲染的那一行。
            // 不要靠"第几个 .wf-row"去数 —— 标题的 class 是 .wf-section-title（不在 .wf-row 里），
            // 而末尾那颗「+ 添加动作」按钮**是** .wf-row，按位置数必然错位。
            row.setAttribute('data-wf-act-idx', ai);
            var extraInputs = '';
            if (act.type === 'send_data') {
                extraInputs =
                    '<div class="sel" onclick="toggleSelDrop(this)">' +
                        '<span class="sel-text">' + (act.encoding==='hex'?'HEX':'文本') + '</span><span class="sel-arrow">&#9660;</span>' +
                        '<div class="sel-drop">' +
                            '<div class="sel-opt' + (act.encoding==='text'?' active':'') + '" onclick="setWfActEnc(this,\'' + mid + '\',\'' + rule.id + '\',' + ai + ',\'text\',event)">文本</div>' +
                            '<div class="sel-opt' + (act.encoding==='hex'?' active':'') + '" onclick="setWfActEnc(this,\'' + mid + '\',\'' + rule.id + '\',' + ai + ',\'hex\',event)">HEX</div>' +
                        '</div>' +
                    '</div>' +
                    '<input type="text" id="' + mcpWfElId(mid, rule.id, 'a' + ai) + '" name="wf-act-data" value="' + escapeHtml(act.data) + '" placeholder="发送内容" oninput="updateWfAction(\'' + mid + '\',\'' + rule.id + '\',' + ai + ',\'data\',this.value)">';
            } else if (act.type === 'toggle_dtr_rts') {
                extraInputs =
                    '<div class="sel" onclick="toggleSelDrop(this)">' +
                        '<span class="sel-text">' + (act.signal==='rts'?'RTS':'DTR') + '</span><span class="sel-arrow">&#9660;</span>' +
                        '<div class="sel-drop">' +
                            '<div class="sel-opt' + (act.signal!=='rts'?' active':'') + '" onclick="setWfActSig(this,\'' + mid + '\',\'' + rule.id + '\',' + ai + ',\'dtr\',event)">DTR</div>' +
                            '<div class="sel-opt' + (act.signal==='rts'?' active':'') + '" onclick="setWfActSig(this,\'' + mid + '\',\'' + rule.id + '\',' + ai + ',\'rts\',event)">RTS</div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="sel" onclick="toggleSelDrop(this)">' +
                        '<span class="sel-text">' + (act.level?'高电平':'低电平') + '</span><span class="sel-arrow">&#9660;</span>' +
                        '<div class="sel-drop">' +
                            '<div class="sel-opt' + (act.level?' active':'') + '" onclick="setWfActLvl(this,\'' + mid + '\',\'' + rule.id + '\',' + ai + ',true,event)">高电平</div>' +
                            '<div class="sel-opt' + (!act.level?' active':'') + '" onclick="setWfActLvl(this,\'' + mid + '\',\'' + rule.id + '\',' + ai + ',false,event)">低电平</div>' +
                        '</div>' +
                    '</div>';
            }
            row.innerHTML =
                '<div class="sel" onclick="toggleSelDrop(this)">' +
                    '<span class="sel-text">' + wfActLabel(act.type) + '</span><span class="sel-arrow">&#9660;</span>' +
                    '<div class="sel-drop">' +
                        '<div class="sel-opt' + (act.type==='send_data'?' active':'') + '" onclick="setWfActType(this,\'' + mid + '\',\'' + rule.id + '\',' + ai + ',\'send_data\',event)">发送数据</div>' +
                        '<div class="sel-opt' + (act.type==='toggle_dtr_rts'?' active':'') + '" onclick="setWfActType(this,\'' + mid + '\',\'' + rule.id + '\',' + ai + ',\'toggle_dtr_rts\',event)">切换信号</div>' +
                        '<div class="sel-opt' + (act.type==='save_log'?' active':'') + '" onclick="setWfActType(this,\'' + mid + '\',\'' + rule.id + '\',' + ai + ',\'save_log\',event)">保存日志</div>' +
                    '</div>' +
                '</div>' +
                extraInputs +
                '<input type="number" id="' + mcpWfElId(mid, rule.id, 'ad' + ai) + '" name="wf-act-delay" value="' + wfDelayOf(act) + '" min="0" step="100" title="延时(ms)" oninput="updateWfAction(\'' + mid + '\',\'' + rule.id + '\',' + ai + ',\'delayBefore\',parseInt(this.value)||0)">' +
                '<span style="font-size:10px;color:var(--text-d);">ms</span>' +
                '<button class="wf-row-btn del" onclick="removeWfAction(\'' + mid + '\',\'' + rule.id + '\',' + ai + ')" title="删除动作">&#xd7;</button>';
            actSection.appendChild(row);
        });
        var addActBtn = document.createElement('div');
        addActBtn.className = 'wf-row';
        addActBtn.innerHTML = '<button class="wf-row-btn" onclick="addWfAction(\'' + mid + '\',\'' + rule.id + '\')" title="添加动作" style="font-size:11px;width:auto;padding:0 6px;">+ 添加动作</button>';
        actSection.appendChild(addActBtn);
        body.appendChild(actSection);

        card.appendChild(body);
        list.appendChild(card);
    });
}

function wfCondLabel(type) {
    return { string_contains: '字符串包含', regex: '正则表达式', exact_bytes: '精确字节' }[type] || type;
}
function wfCondPlaceholder(type) {
    return { string_contains: '输入匹配字符串...', regex: '输入正则表达式...', exact_bytes: '输入HEX如 FF 01 02' }[type] || '';
}
function wfActLabel(type) {
    return { send_data: '发送数据', toggle_dtr_rts: '切换信号', save_log: '保存日志' }[type] || type;
}
// Setter functions - only re-render when row structure changes
function setWfCondType(el, mid, ruleId, idx, val, e) {
    e.stopPropagation();
    setSel(el, val, e);
    updateWfCondition(mid, ruleId, idx, 'type', val);
    // 类型变了，placeholder 要更新
    var row = el.closest('.wf-row');
    var inp = row ? row.querySelector('input[type="text"]') : null;
    if (inp) inp.placeholder = wfCondPlaceholder(val);
    scheduleConfigSave();
}
function setWfActType(el, mid, ruleId, idx, val, e) {
    e.stopPropagation();
    setSel(el, val, e);
    var rule = findWfRule(mid, ruleId);
    if (rule && rule.actions[idx]) {
        rule.actions[idx].type = val;
        if (val === 'send_data') { rule.actions[idx].encoding = rule.actions[idx].encoding || 'text'; rule.actions[idx].data = rule.actions[idx].data || ''; }
        if (val === 'toggle_dtr_rts') { rule.actions[idx].signal = rule.actions[idx].signal || 'dtr'; rule.actions[idx].level = rule.actions[idx].level || false; }
    }
    // 行结构变了，只重渲染该行
    var row = el.closest('.wf-row');
    var actSection = row ? row.closest('.wf-section') : null;
    if (actSection) renderWfActRow(actSection, mid, ruleId, idx);
    saveWorkflowConfig(mid);
}
function setWfActEnc(el, mid, ruleId, idx, val, e) {
    e.stopPropagation();
    setSel(el, val, e);
    updateWfAction(mid, ruleId, idx, 'encoding', val);
    scheduleConfigSave();
}
function setWfActSig(el, mid, ruleId, idx, val, e) {
    e.stopPropagation();
    setSel(el, val, e);
    updateWfAction(mid, ruleId, idx, 'signal', val);
    scheduleConfigSave();
}
function setWfActLvl(el, mid, ruleId, idx, val, e) {
    e.stopPropagation();
    setSel(el, val ? 'true' : 'false', e);
    updateWfAction(mid, ruleId, idx, 'level', val);
    scheduleConfigSave();
}

// 只重新渲染一个动作行（类型切换时）
function renderWfActRow(actSection, mid, ruleId, targetIdx) {
    var rule = findWfRule(mid, ruleId);
    if (!rule) return;
    // 按**显式标记**找目标行，不按位置数。
    // 原来写的是 `querySelectorAll('.wf-row')[targetIdx + 1]`，注释说"rows[0] 是标题行" ——
    // 但标题的 class 是 `.wf-section-title`，**根本不带 `.wf-row`**；而末尾那颗「+ 添加动作」
    // 按钮**倒**是 `.wf-row`。于是这里整体错位一行：改第 0 个动作的类型，被重渲染的是第 1 个；
    // 只有 1 个动作时更糟 —— 被 replaceWith 掉的是那颗添加按钮。
    // 表现就是用户报的那条：**「发送数据 → 切换信号 → 再改回发送数据，DTR/RTS 那两栏不消失」**，
    // 因为真正该重渲染的那一行从头到尾没被重渲染过（只有 `setSel` 把它的文字改了，
    // 而 `extraInputs` 是上一次渲染的残留）。
    var targetRow = actSection.querySelector('[data-wf-act-idx="' + targetIdx + '"]');
    if (!targetRow) return;
    var act = rule.actions[targetIdx];
    if (!act) return;
    var newRow = document.createElement('div');
    newRow.className = 'wf-row';
    newRow.setAttribute('data-wf-act-idx', targetIdx);
    var extraInputs = '';
    if (act.type === 'send_data') {
        extraInputs =
            '<div class="sel" onclick="toggleSelDrop(this)">' +
                '<span class="sel-text">' + (act.encoding==='hex'?'HEX':'文本') + '</span><span class="sel-arrow">&#9660;</span>' +
                '<div class="sel-drop">' +
                    '<div class="sel-opt' + (act.encoding==='text'?' active':'') + '" onclick="setWfActEnc(this,\'' + mid + '\',\'' + ruleId + '\',' + targetIdx + ',\'text\',event)">文本</div>' +
                    '<div class="sel-opt' + (act.encoding==='hex'?' active':'') + '" onclick="setWfActEnc(this,\'' + mid + '\',\'' + ruleId + '\',' + targetIdx + ',\'hex\',event)">HEX</div>' +
                '</div>' +
            '</div>' +
            '<input type="text" id="' + mcpWfElId(mid, ruleId, 'a' + targetIdx) + '" name="wf-act-data" value="' + escapeHtml(act.data) + '" placeholder="发送内容" oninput="updateWfAction(\'' + mid + '\',\'' + ruleId + '\',' + targetIdx + ',\'data\',this.value)">';
    } else if (act.type === 'toggle_dtr_rts') {
        extraInputs =
            '<div class="sel" onclick="toggleSelDrop(this)">' +
                '<span class="sel-text">' + (act.signal==='rts'?'RTS':'DTR') + '</span><span class="sel-arrow">&#9660;</span>' +
                '<div class="sel-drop">' +
                    '<div class="sel-opt' + (act.signal!=='rts'?' active':'') + '" onclick="setWfActSig(this,\'' + mid + '\',\'' + ruleId + '\',' + targetIdx + ',\'dtr\',event)">DTR</div>' +
                    '<div class="sel-opt' + (act.signal==='rts'?' active':'') + '" onclick="setWfActSig(this,\'' + mid + '\',\'' + ruleId + '\',' + targetIdx + ',\'rts\',event)">RTS</div>' +
                '</div>' +
            '</div>' +
            '<div class="sel" onclick="toggleSelDrop(this)">' +
                '<span class="sel-text">' + (act.level?'高电平':'低电平') + '</span><span class="sel-arrow">&#9660;</span>' +
                '<div class="sel-drop">' +
                    '<div class="sel-opt' + (act.level?' active':'') + '" onclick="setWfActLvl(this,\'' + mid + '\',\'' + ruleId + '\',' + targetIdx + ',true,event)">高电平</div>' +
                    '<div class="sel-opt' + (!act.level?' active':'') + '" onclick="setWfActLvl(this,\'' + mid + '\',\'' + ruleId + '\',' + targetIdx + ',false,event)">低电平</div>' +
                '</div>' +
            '</div>';
    }
    newRow.innerHTML =
        '<div class="sel" onclick="toggleSelDrop(this)">' +
            '<span class="sel-text">' + wfActLabel(act.type) + '</span><span class="sel-arrow">&#9660;</span>' +
            '<div class="sel-drop">' +
                '<div class="sel-opt' + (act.type==='send_data'?' active':'') + '" onclick="setWfActType(this,\'' + mid + '\',\'' + ruleId + '\',' + targetIdx + ',\'send_data\',event)">发送数据</div>' +
                '<div class="sel-opt' + (act.type==='toggle_dtr_rts'?' active':'') + '" onclick="setWfActType(this,\'' + mid + '\',\'' + ruleId + '\',' + targetIdx + ',\'toggle_dtr_rts\',event)">切换信号</div>' +
                '<div class="sel-opt' + (act.type==='save_log'?' active':'') + '" onclick="setWfActType(this,\'' + mid + '\',\'' + ruleId + '\',' + targetIdx + ',\'save_log\',event)">保存日志</div>' +
            '</div>' +
        '</div>' +
        extraInputs +
        '<input type="number" id="' + mcpWfElId(mid, ruleId, 'ad' + targetIdx) + '" name="wf-act-delay" value="' + wfDelayOf(act) + '" min="0" step="100" title="延时(ms)" oninput="updateWfAction(\'' + mid + '\',\'' + ruleId + '\',' + targetIdx + ',\'delayBefore\',parseInt(this.value)||0)">' +
        '<span style="font-size:10px;color:var(--text-d);">ms</span>' +
        '<button class="wf-row-btn del" onclick="removeWfAction(\'' + mid + '\',\'' + ruleId + '\',' + targetIdx + ')" title="删除动作">&#xd7;</button>';
    targetRow.replaceWith(newRow);
}


