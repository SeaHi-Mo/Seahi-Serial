/* 83-wsl-mcp.js —— 前端第 13 块，拆自原单文件 src/index.html（**纯搬家**；行号映射见 doc/FRONTEND_LAYOUT.md）。
   ⚠️ **普通脚本**（不是 ESM）：按 index.html 里的 <script src> 顺序加载、共享同一个全局作用域 —— 行内 onclick
   与现有函数互相调用照旧；**别改成 type="module"**（模块作用域会让它们全部失效）。 */
/* ===== WSL 端口映射：给 MCP 通用桥读的那一份 =====
 *
 * 为什么要有这一块：设备行是 `renderWslDeviceList` 用 `innerHTML` 拼出来的**动态 DOM**，
 * 行里的「映射」复选框原本连 id 都没有 —— 于是它在控件注册表里只能落到
 * "标签名_全局序号" 的兜底命名（`input_127`），**既读不到设备表、也认不出哪一行是哪台设备**
 * （用户 2026-09 问"怎么让 AI 把 COM7 映射进 WSL"时，缺口正在这里）。
 * 现在两侧一起补：① 本函数把设备表按结构化返回（`ui_get_state{section:"wslDevices"}`）；
 * ② 行里的控件带稳定 id（`wslMap-<busid>`），AI 拿到的 `mapControlPath` 就是可直接交给
 *    `ui_set` 的路径 —— 与 `serial_quick_cmd` 返回 `domIds` 是同一个用意，别让 AI 猜路径。
 */

/// busid → 设备对象（`_wslDevices` 是唯一真源，不另存一份）
function mcpWslDeviceByBusid(busid) {
    var want = String(busid == null ? '' : busid);
    for (var i = 0; i < _wslDevices.length; i++) {
        if (String(_wslDevices[i].busid) === want) return _wslDevices[i];
    }
    return null;
}

/// 设备行里某个控件在注册表里的路径。**规则只写这一处**：
/// 控件 id 是 `wslMap-<busid>` / `wslAutoMap-<busid>`，它不匹配 `mcpEntryFor` 的
/// `<分栏>-<字段>` 前缀（`wsl` 后面不是 `-`），所以走 id 分支：
/// 面板由祖先 `#wsl-pane` 决定（`wsl`）、分组固定 `ui`、名字就是 id。
/// 用 `mcpJoinPath` 而不是手拼字符串，是为了和注册表那边的 slug 规则**永远一致**。
function mcpWslControlPath(busid, which) {
    var prefix = (which === 'auto') ? 'wslAutoMap-' : 'wslMap-';
    return mcpJoinPath('wsl', 'ui', prefix + String(busid == null ? '' : busid));
}

/// WSL 端口映射区的结构化快照（`ui_get_state{section:"wslDevices"}` 的载荷）
function mcpWslDevicesState() {
    var list = _wslDevices.map(function(d) {
        return {
            busid: d.busid || '',
            // Windows 侧识别到的 COM 名（识别不到时后端给的是 "-"）。
            // 用户嘴里的"把 COM7 映射到 WSL"就是靠它和设备表对上号。
            port: d.port || '',
            name: d.name || '',
            vidpid: d.vidpid || '',
            hasCom: !!d.hasCom,
            status: d.status || 'unmapped',
            wslPath: d.wslPath || '',
            wslSerial: d.wslSerial || '',
            busy: !!_wslBusy[d.busid],
            mapControlPath: mcpWslControlPath(d.busid, 'map'),
            autoMapControlPath: mcpWslControlPath(d.busid, 'auto'),
        };
    });
    var mapped = 0;
    for (var i = 0; i < list.length; i++) if (list[i].status === 'mapped') mapped++;
    // 面板是**懒初始化**的（第一次 openWslMapping 才建 DOM、才去 list_wsl_devices），
    // 所以"设备表是空的"有两种意思 —— 必须说清是哪一种，别让 AI 以为"这台机器没有 USB 设备"。
    var opened = !!document.getElementById('main-wslDeviceList');
    return {
        wslRunning: !!_wslRunning,
        targetDistro: _wslTargetDist || '',
        panelOpened: opened,
        count: list.length,
        mapped: mapped,
        devices: list,
        note: opened ? null
            : 'WSL 端口映射面板还没打开过，设备表此刻是空的。先 ui_click{"path":"global.ui.wslToggleBtn"} 打开它，再重读本区段。',
        mapUnavailableReason: _wslRunning ? null
            : 'WSL 当前没有运行：映射复选框是灰的（`ui_set` 会被拒并说明原因）。',
    };
}

/// 一次 WSL 映射写入的**真实**结果 —— 只说"发出去了没有"，绝不假装"已经映射好了"。
///
/// 为什么不能直接信那个复选框：`toggleWslMapping` 是 async，映射要过 `usbipd`
/// （几十秒），需要提权时还会弹出 `#wsl-map-approval-overlay` 等**用户在机器上点**
/// 「授权并映射」（60 秒自动取消）。这期间 `el.click()` 早就返回了，而 `mcpWriteEl`
/// 读到的 `checked=true` 只代表"这个框被点过"——那就是一次假成功。
///
/// 判据用 `_wslBusy[busid]`：`toggleWslMapping` 在**第一个 await 之前**就把它置起来了，
/// 所以 `el.click()` 一返回就能确定"到底跑起来没有"。**因此不需要等待、不需要轮询**，
/// 也就不会去撞界面桥的 5s 超时预算（等过头只会把一个正在正常进行的操作变成
/// `-32004`「界面可能正忙」的假失败 —— 与 BLE 那次 `ble_connect` 的教训同源）。
function mcpWslMapOutcome(busid, want) {
    var out = { busid: String(busid == null ? '' : busid), want: !!want };
    var d = mcpWslDeviceByBusid(busid);
    if (!d) {
        // 列表每 5 秒刷新一次 → 拿旧 busid 来操作是可能的。这是**真错误**，要能自解释。
        out.stale = true;
        out.settled = true;
        out.note = '设备 ' + out.busid + ' 已经不在当前设备表里（列表每 5 秒刷新）。'
                 + '重新调 ui_get_state{section:"wslDevices"} 拿最新的 busid 与 mapControlPath 再试。';
        return out;
    }
    out.port = d.port || '';
    out.name = d.name || '';
    out.status = d.status || 'unmapped';
    if (_wslBusy[d.busid]) {
        // 真在跑：**回执只能说"发起了"**，完成与否要去看 status
        out.settled = false;
        out.inFlight = true;
        out.note = '映射动作已发起，但**还没有完成**（usbipd 映射可能要几十秒；需要管理员权限时会弹授权框等用户确认）。'
                 + '**不要重试** —— 稍后用 ui_get_state{section:"wslDevices"} 看这台设备的 status 是否变成 mapped。';
        return out;
    }
    // 没跑起来：要么本来就是这个状态（幂等），要么前置条件不满足
    out.settled = true;
    var already = (d.status === 'mapped') === !!want;
    out.alreadyInTargetState = already;
    out.note = already
        ? '目标状态本来就是这样，无需改动。'
        : '映射动作没有跑起来 —— 检查 ui_get_state{section:"wslDevices"} 里的 wslRunning 与 mapUnavailableReason。';
    return out;
}

function renderWslDeviceList(mid) {
    var container = document.getElementById(mid + '-wslDeviceList');
    if (!container) return;

    // "设备名称"标题需要右移的量：使它与"端口"的标题间距 = BUSID↔端口 的标题间距
    var nameMargin = wslNameHeaderMargin();
    
    if (_wslDevices.length === 0) {
        container.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-soft);">' +
            '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-d)" stroke-width="1.5" style="margin-bottom:10px;"><rect x="2" y="3" width="20" height="14" rx="2"/><polyline points="8 21 12 17 16 21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>' +
            '<div style="font-size:13px;">未发现可用的 USB 设备</div>' +
            '<div style="font-size:11px;margin-top:4px;color:var(--text-muted);">连接设备后将自动刷新</div>' +
            '<div style="font-size:11px;margin-top:8px;color:var(--text-muted);padding:0 20px;text-align:center;">如列表持续为空，可尝试<span style="color:var(--btn-p);">以管理员身份运行</span>本程序</div>' +
        '</div>';
        return;
    }

    var html = '<div style="padding:10px 10px 10px 14px;display:flex;flex-direction:column;gap:6px;">';

    // 表头
    html += '<div style="display:flex;align-items:center;padding:6px 10px 6px 14px;gap:14px;font-size:11px;color:var(--text-d);text-transform:uppercase;letter-spacing:0.8px;font-weight:600;">';
    html += '<span style="width:64px;flex-shrink:0;text-align:center;">BUSID</span>';
    html += '<span style="flex:0 0 auto;min-width:140px;text-align:center;">端口</span>';
    html += '<span style="flex:1;min-width:0;margin-left:' + nameMargin + 'px;">设备名称</span>';
    html += '<span style="width:40px;flex-shrink:0;text-align:center;">状态</span>';
    html += '<span style="width:60px;flex-shrink:0;text-align:center;">自动</span>';
    html += '<span style="width:60px;flex-shrink:0;text-align:center;">映射</span>';
    html += '</div>';
    // 分隔线
    html += '<div style="height:1px;background:var(--border);margin:0 4px;"></div>';

    _wslDevices.forEach(function(device, idx) {
        var isMapped = device.status === 'mapped';
        var isBusy = _wslBusy[device.busid];
        var selected = _wslSelectedBusid === device.busid;
        var rowBg = isMapped ? 'var(--mapped-bg)' : 'transparent';
        var rowBorder = isMapped ? 'var(--mapped-border)' : 'var(--border)';
        var safeBusid = escapeHtml(device.busid || '');
        var safePort = escapeHtml(device.port || '');
        // 进 JS 字符串字面量的那一份（属性值走上面的 HTML 转义，两者不能混用）
        var jsBusid = String(device.busid || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        var displayName = device.name || '';
        var safeName = escapeHtml(displayName);
        var sub = (device.vidpid || '').toUpperCase();
        if (device.wslSerial) sub += ' · SN ' + device.wslSerial;
        var safeSub = escapeHtml(sub);
        var status = wslDeviceStatus(device);
        var autoOn = device.vidpid ? !!_wslAutoMap[device.vidpid] : false;
        // 自动映射开关始终可切换（即使当前未识别到 WSL 运行）；仅当该设备正在映射操作中时禁用
        var autoDisabled = isBusy;

        // 给 AI（和人）看得懂的控件身份：优先 COM 名，其次 WSL 路径，最后退回 busid。
        // 没有它的话，这三个控件在注册表里只有"标签名_全局序号"式的兜底名字（`input_127`），
        // 连 `ui_list` 都认不出哪一行是哪台设备 —— 那正是"AI 读得到控件却点不准设备"的根因。
        var devIdentity = (device.port && device.port !== '-') ? device.port
            : (device.wslPath || device.busid || '');
        if (device.name) devIdentity += '（' + device.name + '）';
        var safeRowLabel = escapeHtml('USB 设备 ' + devIdentity);
        var safeMapLabel = escapeHtml('映射到 WSL：' + devIdentity + '（busid ' + (device.busid || '') + '）');
        var safeAutoLabel = escapeHtml('插入时自动映射到 WSL：' + devIdentity + '（VID:PID ' + (device.vidpid || '') + '）');

        html += '<div class="wsl-device-row' + (selected ? ' selected' : '') + '" id="wslRow-' + safeBusid + '" aria-label="' + safeRowLabel + '" style="display:flex;align-items:center;padding:5px 10px 5px 14px;min-height:48px;gap:14px;border-radius:4px;background:' + rowBg + ';border:1px solid ' + rowBorder + ';' + (isBusy ? 'opacity:0.6;' : '') + '" onclick="selectWslRow(\'' + safeBusid + '\',event)">';
        // BUSID
        html += '<span style="width:64px;flex-shrink:0;font-family:monospace;font-size:12px;color:var(--text-d);font-weight:500;text-align:center;">' + safeBusid + '</span>';
        // 端口
        if (isBusy) {
            var direction = isMapped ? '← WSL' : '→ WSL';
            html += '<span style="flex:0 0 auto;min-width:140px;font-family:monospace;font-size:12px;text-align:center;"><span class="wsl-loading-cell"><span class="wsl-spinner"></span>' + direction + '</span></span>';
        } else {
            var portColor = isMapped ? 'var(--accent-focus)' : 'var(--link)';
            // 不显示 Windows 侧设备名称/COM：已映射显示 WSL 路径，未映射显示占位符
            var portText = isMapped ? (device.wslPath || 'WSL') : '—';
            html += '<span style="flex:0 0 auto;min-width:140px;font-family:monospace;font-size:12px;font-weight:600;color:' + portColor + ';text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escapeHtml(device.wslPath || '') + '">' + escapeHtml(portText) + '</span>';
        }
        // 设备名称（双行：名称 + VID:PID · SN 副标题）
        html += '<span style="flex:1;min-width:0;margin-left:' + nameMargin + 'px;">';
        html += '<span class="wsl-device-name" title="' + safeName + '">' + safeName + '</span>';
        html += '<span class="wsl-device-sub">' + safeSub + '</span>';
        html += '</span>';
        // 状态点
        html += '<span style="width:40px;flex-shrink:0;text-align:center;" title="' + escapeHtml(status.tip) + '"><span class="wsl-status-dot ' + status.cls + '"></span></span>';
        // 自动映射（按 VID:PID 匹配）
        html += '<span style="width:60px;flex-shrink:0;text-align:center;">';
        html += '<label class="wsl-auto-toggle"><input type="checkbox" name="wsl-auto-map" id="wslAutoMap-' + safeBusid + '" aria-label="' + safeAutoLabel + '" ' + (autoOn ? 'checked' : '') + ' ' + (autoDisabled ? 'disabled' : '') + ' onchange="toggleAutoMap(\'' + (device.vidpid||'').replace(/'/g,"\\'") + '\', \'' + safePort.replace(/'/g,"\\'") + '\', this.checked)"><span class="wsl-auto-slider"></span></label>';
        html += '</span>';
        // 映射
        var mapDisabled = isBusy || !_wslRunning;
        html += '<span style="width:60px;flex-shrink:0;text-align:center;">';
        // 映射复选框：**按 busid 寻址**（不再传下标）。
        // 下标会过期 —— 设备表每 5 秒 `innerHTML` 重画一次，而行里控件的注册表路径是由
        // busid 决定的；用旧下标去操作 = "AI 点的"和"实际动的"是两台设备。
        // `data-wsl-busid` 是给 MCP 回执用的：`mcpHandleUiCmd` 靠它把"复选框被点过"和
        // "映射真的跑起来了"区分开（见 mcpWslMapOutcome）。
        html += '<input type="checkbox" name="wsl-map" class="wsl-checkbox" id="wslMap-' + safeBusid + '" data-wsl-busid="' + safeBusid + '" aria-label="' + safeMapLabel + '" ' + (isMapped ? 'checked' : '') + ' ' + (mapDisabled ? 'disabled' : '') + ' onchange="toggleWslMapping(\'' + jsBusid + '\', this.checked)">';
        html += '</span>';
        html += '</div>';
    });
    
    html += '</div>';
    container.innerHTML = html;
}

// 行选中（点击交互控件时不触发）
// 说明：自动映射开关是 <label class="wsl-auto-toggle">（内含滑块 <span>），映射复选框是
// 裸 <input class="wsl-checkbox">。点击这些控件时，事件会冒泡到行级 onclick，
// 若在此处重新 render 整行列表会重建 DOM，干扰 checkbox 的 change 事件，
// 使 toggleAutoMap 不触发/不稳定，导致开关显示状态无法切换、自动映射无法开启。
// 故除 input/button 外，也须匹配 label（覆盖开关 label 及其内滑块 span）。
function selectWslRow(busid, ev) {
    if (ev && ev.target && ev.target.closest('input,button,label')) return;
    _wslSelectedBusid = (_wslSelectedBusid === busid) ? null : busid;
    renderWslDeviceList('main');
}

// 连接状态：绿=空闲 黄=占用/使用中 红=错误
function wslDeviceStatus(device) {
    var mapped = device.status === 'mapped';
    if (mapped && !device.wslPath) return { cls: 'err', tip: '已映射但 WSL 侧未找到设备路径' };
    if (device.port && device.port !== '-' && findPortOwner(device.port, 'wsl')) return { cls: 'busy', tip: 'Windows 端口被其他监视器占用' };
    if (mapped && device.wslPath && wslPathInUse(device.wslPath)) return { cls: 'busy', tip: 'WSL 端口正被监视器使用中' };
    return { cls: 'free', tip: mapped ? '已映射 · 空闲' : '空闲可用' };
}
function wslPathInUse(path) {
    if (!path) return false;
    return Object.keys(monitors).some(function(k) {
        var m = monitors[k];
        return m && m.isWsl && m.isConnected && m.portName === path;
    });
}

/* ===== WSL 映射授权窗口 ===== */
// 映射设备若需管理员权限，弹出独立的授权确认窗口（Promise<boolean>）
function showWslMapApproval(device, distro) {
    return new Promise(function(resolve) {
        var old = document.getElementById('wsl-map-approval-overlay');
        if (old) old.remove();
        var overlay = document.createElement('div');
        overlay.id = 'wsl-map-approval-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;';
        // 目标设备：端口号（设备名）。无端口时仅显示设备名或 BUSID。
        var portText = (device.port && device.port !== '-') ? escapeHtml(device.port) : '';
        var nameText = escapeHtml((device.name || '').trim());
        var deviceLabel = portText ? (portText + '（' + nameText + '）') : (nameText || escapeHtml(device.busid || ''));
        overlay.innerHTML =
            '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;width:380px;max-width:92vw;box-shadow:0 12px 40px rgba(0,0,0,0.5);overflow:hidden;">' +
                '<div style="background:var(--toolbar-bg);border-bottom:1px solid var(--border);padding:12px 16px;font-size:14px;font-weight:600;color:var(--text-b);">授权确认</div>' +
                '<div style="padding:16px 20px 6px;font-size:13px;color:var(--text);line-height:1.6;">' +
                    '<div style="margin-bottom:10px;">将设备映射到 WSL 需要<b style="color:var(--accent-orange);font-weight:600;">管理员权限授权</b>。</div>' +
                    '<div style="font-size:15px;font-weight:600;color:var(--text-b);">' + deviceLabel + '</div>' +
                '</div>' +
                '<div style="display:flex;justify-content:flex-end;gap:10px;padding:14px 16px;border-top:1px solid var(--border);">' +
                    '<button id="wsl-map-approval-cancel" style="padding:6px 14px;border-radius:4px;border:1px solid var(--border);background:var(--surface-1);color:var(--text);font-size:12px;cursor:pointer;">取消</button>' +
                    '<button id="wsl-map-approval-ok" style="padding:6px 14px;border-radius:4px;border:1px solid var(--btn-p);background:var(--btn-p);color:#fff;font-size:12px;cursor:pointer;font-weight:600;">授权并映射</button>' +
                '</div>' +
            '</div>';
        document.body.appendChild(overlay);
        var settled = false;
        function settle(val) {
            if (settled) return;
            settled = true;
            clearTimeout(autoTimer);
            if (overlay && overlay.parentNode) overlay.remove();
            resolve(val);
        }
        var autoTimer = setTimeout(function() { settle(false); }, 60000);
        overlay.querySelector('#wsl-map-approval-ok').onclick = function() { settle(true); };
        overlay.querySelector('#wsl-map-approval-cancel').onclick = function() { settle(false); };
        overlay.addEventListener('click', function(ev) { if (ev.target === overlay) settle(false); });
    });
}

/// 映射/取消映射一台设备。
///
/// **按 busid 寻址，不按下标**：设备表每 5 秒 `innerHTML` 重画一次，下标随时会过期；
/// 而行里控件的注册表路径（`wsl.ui.wslMap_<busid>`）是由 busid 决定的 —— 拿旧下标操作
/// 就等于"AI 点的"和"实际动的"是两台设备。`mid` 也省了：WSL 设备区是共享单实例（容器 id 写死 `main-`）。
async function toggleWslMapping(busid, checked) {
    if (!_wslRunning) return;
    var device = mcpWslDeviceByBusid(busid);
    if (!device || _wslBusy[device.busid]) return;
    
    _wslBusy[device.busid] = true;
    renderWslDeviceList('main');
    
    var attachId = device.hasCom ? device.port : device.busid;
    
    try {
        if (checked) {
            // 两阶段映射：先探测是否需要管理员权限；需要时弹出独立授权窗口，确认后才提权执行
            var res = await invokeTimeout('attach_port_to_wsl', { portName: attachId, distro: _wslTargetDist || null, authorized: false }, 60000);
            if (res && res.needsApproval) {
                var approved = await showWslMapApproval(device, _wslTargetDist || '');
                if (!approved) { return; }
                res = await invokeTimeout('attach_port_to_wsl', { portName: attachId, distro: _wslTargetDist || null, authorized: true }, 60000);
            }
            device.status = 'mapped';
            showToast((res && res.message) || '设备已映射到 WSL', 'success');
        } else {
            // 如果 WSL 监视器正在使用该设备的 WSL 端口，先关闭连接释放资源
            // forEach 不等待 async 回调，需收集 Promise 后统一 await，避免断开与 detach 竞态
            await Promise.all(getWslMonitorIds().map(function(wmid) {
                if (monitors[wmid] && monitors[wmid].isConnected) {
                    var wslPath = device.wslPath || '';
                    var portName = monitors[wmid].portName || '';
                    if (wslPath && portName && (portName === wslPath || portName.indexOf(wslPath) !== -1 || wslPath.indexOf(portName) !== -1)) {
                        appendOutput(wmid, 'sys', '取消映射：正在关闭 WSL 串口连接...');
                        return disconnectWslPort(wmid);
                    }
                }
                return Promise.resolve();
            }));
            await invokeTimeout('detach_port_from_wsl', { busid: device.busid }, 60000);
            device.status = 'unmapped';
        }
    } catch (e) { console.error('[WSL] 映射/断开失败:', e); showToast('操作失败: ' + e, 'error'); reportError(e, 'toggleWslMapping'); }
    finally {
        // 无论成功/失败/取消授权都释放 busy，避免该设备行永久禁用
        delete _wslBusy[device.busid];
        renderWslDeviceList('main');
    }
    
    // 映射/断开后自动刷新所有 WSL 监视器的端口列表（授权取消的 early return 不会跑到这里）
    setTimeout(function() { getWslMonitorIds().forEach(function(wmid) { refreshWslMonPorts(wmid); }); }, 1000);
    // 后台静默刷新：合并最新数据并解析 WSL 路径（tty 节点出现有延迟，自动重试）
    retryResolveWslPaths('main', 0);
}

// 拉取最新 WSL 设备列表并合并到当前列表（保留 wslPath），完成后重新渲染
async function refreshWslDeviceListData(mid) {
    // 单飞：与 loadWslDevices 共用锁，避免取消映射后多路重扫并发（E9）
    if (_wslRefreshing) return;
    _wslRefreshing = true;
    try {
        var fresh = await invokeTimeout('list_wsl_devices', null, 15000);
        var freshMap = {};
        fresh.forEach(function(d) { freshMap[d.busid] = d; });
        // 保留现有设备，用 fresh 数据更新状态
        _wslDevices.forEach(function(d) {
            if (freshMap[d.busid]) {
                d.status = freshMap[d.busid].status;
                d.port = freshMap[d.busid].port;
                d.name = freshMap[d.busid].name;
                if (freshMap[d.busid].wslPath) d.wslPath = freshMap[d.busid].wslPath;
            }
        });
        // 添加 fresh 中新出现的设备
        var existBusids = {};
        _wslDevices.forEach(function(d) { existBusids[d.busid] = true; });
        fresh.forEach(function(d) {
            if (!existBusids[d.busid]) _wslDevices.push(d);
        });
        sortWslDevices();
        renderWslDeviceList(mid);
    } catch (e) {
        console.error('[WSL] 刷新设备列表失败:', e);
        reportError(e, 'refreshWslDeviceListData');
    } finally {
        _wslRefreshing = false;
    }
}

// 已映射设备若尚未解析出 WSL 路径，轮询重试（最多 4 次，间隔 1s）
function retryResolveWslPaths(mid, attempt) {
    if (attempt >= 4) return;
    setTimeout(function() {
        refreshWslDeviceListData(mid).then(function() {
            var unresolved = _wslDevices.some(function(d) { return d.status === 'mapped' && !d.wslPath; });
            if (unresolved) retryResolveWslPaths(mid, attempt + 1);
        }).catch(function() {});
    }, 1000);
}

/* ===== 自动映射 ===== */
function toggleAutoMap(vidpid, portName, on) {
    // 允许随时配置自动映射（即使当前未识别到 WSL 运行）；真正的自动映射由 autoMapCheck
    // 依据后端 list_wsl_devices 返回的 wsl_running 来决定是否执行，无需读这里的 _wslRunning。
    if (on) {
        _wslAutoMap[vidpid] = portName;
        delete _wslAutoFailCount[vidpid];
    } else {
        delete _wslAutoMap[vidpid];
        delete _wslAutoFailCount[vidpid];
    }
    scheduleConfigSave();
    updateAutoMapPolling();
    // 刷新当前显示的设备列表（WSL 设备区为共享单实例，固定使用 'main' 前缀）
    renderWslDeviceList('main');
}

function updateAutoMapPolling() {
    var hasAny = Object.keys(_wslAutoMap).length > 0;
    if (hasAny && !_wslAutoMapTimer) {
        // 后台自动映射降频到 15s（原 5s）；快速响应改由 device-changed 事件触发（见事件监听）
        _wslAutoMapTimer = setInterval(autoMapCheck, 15000);
    } else if (!hasAny && _wslAutoMapTimer) {
        clearInterval(_wslAutoMapTimer);
        _wslAutoMapTimer = null;
    }
}

async function autoMapCheck() {
    if (Object.keys(_wslAutoMap).length === 0) return;
    if (_wslAutoMapRunning) return; // 已在执行，避免并发重复映射
    _wslAutoMapRunning = true;
    try {
        var devices = await invokeTimeout('list_wsl_devices', null, 15000);
        // 收集需要映射的设备，并发执行
        var tasks = [];
        for (var i = 0; i < devices.length; i++) {
            var d = devices[i];
            // 连续失败 3 次后暂停该设备（防 UAC 弹窗轰炸），成功或用户重开自动映射时重置
            if (d.vidpid && _wslAutoMap[d.vidpid] && d.status !== 'mapped' && !_wslBusy[d.busid] && !((_wslAutoFailCount[d.vidpid] || 0) >= 3)) {
                _wslBusy[d.busid] = true;
                var autoAttachId = d.hasCom ? d.port : d.busid;
                (function(device, attachId) {
                    tasks.push(
                        invokeTimeout('attach_port_to_wsl', { portName: attachId, distro: _wslTargetDist || null, authorized: true }, 60000)
                            .then(function(result) {
                                device.status = 'mapped';
                                delete _wslAutoFailCount[device.vidpid];
                            })
                            .catch(function(e) {
                                console.error('[WSL] 自动映射失败:', e);
                                _wslAutoFailCount[device.vidpid] = (_wslAutoFailCount[device.vidpid] || 0) + 1;
                                if (_wslAutoFailCount[device.vidpid] === 3) {
                                    showToast('自动映射连续失败 3 次，已暂停该设备 (' + (device.name || device.busid) + ')，请检查 WSL 状态', 'error');
                                }
                            })
                            .finally(function() {
                                delete _wslBusy[device.busid];
                            })
                    );
                })(d, autoAttachId);
            }
        }
        if (tasks.length > 0) {
            await Promise.all(tasks);
        }
        // 如果 WSL 页面打开，刷新列表（WSL 设备区为共享单实例，固定使用 'main' 前缀）
        var listEl = document.getElementById('main-wslDeviceList');
        if (listEl) {
            if (listEl) {
                // 合并状态，保留 _wslBusy 状态
                var freshMap = {};
                devices.forEach(function(d) { freshMap[d.busid] = d; });
                _wslDevices.forEach(function(d) {
                    if (freshMap[d.busid]) {
                        d.status = freshMap[d.busid].status;
                        d.port = freshMap[d.busid].port;
                        d.name = freshMap[d.busid].name;
                    }
                });
                var existBusids = {};
                _wslDevices.forEach(function(d) { existBusids[d.busid] = true; });
                devices.forEach(function(d) {
                    if (!existBusids[d.busid]) _wslDevices.push(d);
                });
                sortWslDevices();
                renderWslDeviceList('main');
            }
        }
        // 自动映射完成后也刷新 WSL 串口端口列表
        if (tasks.length > 0) {
            setTimeout(function() { refreshWslMonPorts(); }, 1500);
        }
    } catch (e) {
        // 静默失败，下次轮询重试；但接入上报以便诊断自动映射为何失效
        console.error('[WSL] 自动映射检查异常:', e);
        reportError(e, 'autoMapCheck');
    } finally {
        _wslAutoMapRunning = false;
    }
}

// 说明：原 refreshWslDevices() 已删除（零调用，等价于 loadWslDevices('main')）。

