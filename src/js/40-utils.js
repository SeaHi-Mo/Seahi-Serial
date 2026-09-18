/* 40-utils.js —— 前端第 5 块，拆自原单文件 src/index.html（**纯搬家**；行号映射见 doc/FRONTEND_LAYOUT.md）。
   ⚠️ **普通脚本**（不是 ESM）：按 index.html 里的 <script src> 顺序加载、共享同一个全局作用域 —— 行内 onclick
   与现有函数互相调用照旧；**别改成 type="module"**（模块作用域会让它们全部失效）。 */
/* ===== 接收行缓冲（防止轮询分块造成“假换行”）=====
 * 串口数据按轮询间隔分块到达，若每块都独立拆行显示，块边界会凭空产生换行，
 * 即使设备端从未发送 \r\n。这里为每个监视器维护一条“未结束的接收行”
 * （_recvPartial*），后续数据无缝合并进同一行，只有真正收到 \r\n 才换行。 */
function closeRecvPartial(m) {
    if (!m) return;
    m._recvPartialEl = null;
    m._recvPartial = '';
    m._recvPartialTs = '';
    m._recvPartialOpen = false;
}

// 新建一行接收数据（处于未结束状态，后续数据会合并进来）
function openRecvRow(mid, text, frag) {
    if (!text) return null;
    return appendOutput(mid, 'recv', text, { fragment: frag, open: true });
}

// 将后续数据合并进当前未结束的接收行（DOM 与紧凑存储同步更新）
function updateOpenRowText(m, fullText, mid, frag) {
    if (!m) return;
    // 打开行已被清理（极端情况）→ 重新开一行
    if (!m._recvPartialEl || !m._recvPartialEl.parentNode) {
        closeRecvPartial(m);
        openRecvRow(mid, fullText, frag);
        return;
    }
    var contentSpan = m._recvPartialEl.querySelector('.lc');
    if (contentSpan) {
        if (fullText.indexOf('\x1b') === -1) {
            contentSpan.textContent = m._recvPartialTs + fullText;
        } else {
            contentSpan.innerHTML = escapeHtml(m._recvPartialTs) + parseAnsi(fullText);
        }
    }
    m._recvPartial = fullText;
    var idx = bufferFindLastRecvIndex(m);
    if (idx >= 0) bufferUpdateLineText(m, idx, fullText);
}

// 处理一段接收文本：合并“未结束行”，只有设备真正发送 \r\n 才产生换行
function appendRecvText(mid, decoded, frag) {
    var el = document.getElementById(mid + '-output');
    var m = monitors[mid];
    if (!el || !m || decoded === '') return;

    // 归一化换行：把 \r\n 与单独的 \r 统一为 \n，纯 \r 换行的设备（如 AT 固件）也能正确分行
    var combined = ((m._recvPartial || '') + decoded).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    var endsWithNl = /\n$/.test(combined);
    var body = endsWithNl ? combined.replace(/\n+$/, '') : combined;
    var parts = body === '' ? [] : body.split('\n');

    // 终端模式：未结束行作为"当前行提示符"，完整行作为设备输出（插到当前行之前）
    if (_terminalBuffers[mid] && _terminalBuffers[mid].lineEl) {
        m._recvPartial = (endsWithNl || parts.length === 0) ? '' : parts[parts.length - 1];
        var fullParts = endsWithNl ? parts : parts.slice(0, parts.length - 1);
        for (var k = 0; k < fullParts.length; k++) {
            appendOutput(mid, 'recv', fullParts[k] === '' ? '' : fullParts[k], { fragment: frag });
        }
        // 未结束行（提示符）→ 终端当前行提示符
        if (!endsWithNl && parts.length > 0 && parts[parts.length - 1] !== '') {
            setTermPrompt(mid, parts[parts.length - 1]);
        }
        return;
    }

    if (parts.length === 0) {
        // 纯换行：已有打开行则关闭，否则渲染一个空行
        if (m._recvPartialOpen) closeRecvPartial(m);
        else appendOutput(mid, 'recv', '', { fragment: frag });
        return;
    }

    // 第一段：若此前有打开行，则是它的延续或完成
    var first = parts[0];
    if (m._recvPartialOpen) {
        updateOpenRowText(m, first, mid, frag);
        if (endsWithNl || parts.length > 1) closeRecvPartial(m);
    } else if (first !== '') {
        if (parts.length === 1 && !endsWithNl) {
            openRecvRow(mid, first, frag);          // 未换行结尾 → 新打开行
        } else {
            appendOutput(mid, 'recv', first, { fragment: frag });
        }
    } else {
        // 以换行开头且无打开行 → 空行
        appendOutput(mid, 'recv', '', { fragment: frag });
    }

    // 其余部分：完整行直接输出；最后一段未以换行结尾则作为新的打开行
    for (var i = 1; i < parts.length; i++) {
        var isLast = (i === parts.length - 1);
        if (isLast && !endsWithNl) {
            if (parts[i] !== '') openRecvRow(mid, parts[i], frag);
        } else {
            appendOutput(mid, 'recv', parts[i], { fragment: frag });
        }
    }
}

// 流式解码：保持跨轮询分块的多字节 UTF-8 字符完整，避免块边界出现乱码
function decodeRecv(mid, data) {
    var m = monitors[mid];
    if (!m) return '';
    if (!m._recvDecoder) m._recvDecoder = new TextDecoder();
    return m._recvDecoder.decode(new Uint8Array(data), { stream: true });
}

// 串口（重新）连接时重置行缓冲与解码器：新数据流不应与旧流合并
function resetRecvStream(mid) {
    var m = monitors[mid];
    if (!m) return;
    closeRecvPartial(m);
    m._recvDecoder = null;
    if (_terminalBuffers[mid]) setTermPrompt(mid, ''); // 终端模式：清空提示符
    // 重连/切换后重置终端补全状态
    if (m) { m._termComp = null; if (m._termHintTimer) { clearTimeout(m._termHintTimer); m._termHintTimer = null; } }
    hideTermComp(mid);
}

function clearLog(mid) {
    var el = document.getElementById(mid + '-output');
    // 始终保留终端当前行（隐藏时也在 DOM 里），避免清理日志后终端模式丢行
    var termCur = document.getElementById(mid + '-termCurrent');
    if (termCur && termCur.parentNode === el) {
        Array.from(el.childNodes).forEach(function(n) { if (n !== termCur) n.remove(); });
        el.appendChild(termCur);
    } else {
        el.innerHTML = '';
    }
    el._lineCount = 0;
    // 同时清空紧凑存储
    if (monitors[mid]) {
        monitors[mid]._textDataLen = 0;
        monitors[mid]._textCount = 0;
        monitors[mid]._bufferStart = 0;
        closeRecvPartial(monitors[mid]);
        // 「清空输出」是用户明确表达"这些我不要了"的时刻，顺手把容量收回到起步值
        // （否则一个跑满 8 MiB 预算的监视器会一直占着这份内存）
        bufferCompactCapacity(monitors[mid]);
    }
    if (_terminalBuffers[mid]) setTermPrompt(mid, '');
}

// ===== 日志隐形缓存 =====
// 每次打开串口并产生收发内容的会话，会自动把收发日志缓存到后端 log-cache 目录
// （一个会话一个文件，最多保留 10 个，新建文件时按 FIFO 删除最旧的）。
// 收发内容经 bufferPush 汇入，300ms 节流批量写入，会话断开/窗口关闭时 flush 并结束。
var _logCacheFlushMs = 300;
function logCacheScheduleFlush(mid) {
    var m = monitors[mid];
    if (!m || m._logCacheTimer || !m._logCachePending) return;
    m._logCacheTimer = setTimeout(function() {
        m._logCacheTimer = null;
        logCacheFlush(mid);
    }, _logCacheFlushMs);
}
function logCacheFlush(mid) {
    var m = monitors[mid];
    if (!m || !m._logCachePending) return;
    var content = m._logCachePending;
    m._logCachePending = '';
    try {
        invoke('append_log_cache', { monitorId: mid, content: content }).catch(function() {});
    } catch (e) {}
}
// 标记会话开始（幂等：自动重连时保留原缓存文件，日志连续）
function logCacheStart(mid, portName) {
    var m = monitors[mid];
    if (!m) return;
    m._logCachePending = m._logCachePending || '';
    m._logCacheStarted = true;
    try {
        invoke('start_log_cache', { monitorId: mid, portName: portName || '' }).catch(function() {});
    } catch (e) {}
}
// 结束会话：flush 剩余内容，结束缓存文件，清空会话状态
function logCacheEnd(mid) {
    var m = monitors[mid];
    if (!m) return;
    if (m._logCacheTimer) { clearTimeout(m._logCacheTimer); m._logCacheTimer = null; }
    if (!m._logCacheStarted) return;
    logCacheFlush(mid);
    try {
        invoke('end_log_cache', { monitorId: mid }).catch(function() {});
    } catch (e) {}
    m._logCacheStarted = false;
}

// ===== 紧凑存储辅助函数 =====
var _typeMap = {recv: 0, send: 1, sys: 2, err: 3};
var _typeNames = ['recv', 'send', 'sys', 'err'];

// 写入一行到紧凑存储
function bufferPush(mid, type, ts, text) {
    var m = monitors[mid];
    if (!m) return;

    // 编码为 UTF-8
    var tsBytes = new TextEncoder().encode(ts);
    var textBytes = new TextEncoder().encode(text);
    var totalLen = tsBytes.length + textBytes.length;

    // 扩容数据缓冲区。
    // 必须用 Math.max(翻倍, 实际需要)：只翻倍时，单行比当前容量还大就会 set 越界抛错
    // （原来初始容量 1 MB 掩盖了这个问题，容量调小后必须修掉）。
    if (m._textDataLen + totalLen > m._textData.length) {
        var newBuf = new Uint8Array(Math.max(m._textData.length * 2, m._textDataLen + totalLen));
        newBuf.set(m._textData.subarray(0, m._textDataLen));
        m._textData = newBuf;
    }
    // 扩容索引缓冲区。
    // ⚠️ 必须把旧数据拷过去：原来只 new 了更大的数组就替换，等于把已积累的偏移表清零，
    // 会让保存/复制/历史加载读到错乱的数据。原来要 10 万行才踩到，容量调小后 4096 行就会触发。
    if (m._textCount >= m._textOffsets.length) {
        var newSize = Math.max(m._textOffsets.length * 2, 64);
        var nOffsets = new Uint32Array(newSize);
        var nTypes = new Uint8Array(newSize);
        var nTsLens = new Uint16Array(newSize);
        nOffsets.set(m._textOffsets);
        nTypes.set(m._textTypes);
        nTsLens.set(m._textTsLens);
        m._textOffsets = nOffsets;
        m._textTypes = nTypes;
        m._textTsLens = nTsLens;
    }

    // 写入数据
    m._textData.set(tsBytes, m._textDataLen);
    m._textDataLen += tsBytes.length;
    m._textData.set(textBytes, m._textDataLen);
    m._textDataLen += textBytes.length;

    // 写入索引
    m._textOffsets[m._textCount] = m._textDataLen;
    m._textTypes[m._textCount] = _typeMap[type] || 0;
    m._textTsLens[m._textCount] = tsBytes.length;
    m._textCount++;

    // 自动清理：按字节预算裁到一半（行数对 20 字节和 4KB 的行完全不是一个量级）
    bufferEnforceBudget(m);

    // 隐形日志缓存：会话活跃时把收发内容批量写入缓存文件（300ms 节流）
    if (m.isConnected && (type === 'recv' || type === 'send')) {
        if (m._logCachePending === undefined) m._logCachePending = '';
        m._logCachePending += ts + text + '\n';
        logCacheScheduleFlush(mid);
    }

    // MCP 日志中心回灌（S7）：串口/WSL 收发 → serial:/wsl: 通道；系统提示 → ui: 通道。
    // 后端拿不到这些（它们在界面这边才成型），所以必须从这里回灌。
    var mcpCh, mcpLevel, mcpDir;
    // 来源：这条发送是不是 **AI 触发的**。`mcpSerialOp` 的 send 分支在点按钮**之前**挂标记，
    // 而 `sendData` 跑到 `appendOutput` 这一段是同步的（第一个 `await` 在它后面），
    // 所以这里一定能认领到；认领后由调用方跳过"补记"，同一次发送不会记两条。
    var mcpSrc = 'none';
    if (type === 'send' && _mcpAiSend && _mcpAiSend.mid === mid) {
        mcpSrc = 'ai';
        _mcpAiSend.claimed = true;
    }
    if (type === 'recv' || type === 'send') {
        // 通道名规则只在 mcpSerialLogChannels 里定义一处（与 serial_get_output 读的是同一套名字）
        var chans = mcpSerialLogChannels(mid);
        mcpCh = type === 'send' ? chans.tx : chans.rx;
        mcpLevel = 'info';
        mcpDir = (type === 'send' ? 'tx' : 'rx');
    } else {
        mcpCh = (type === 'err' ? 'ui:err' : 'ui:sys');
        mcpLevel = (type === 'err' ? 'error' : 'info');
        mcpDir = 'none';
    }
    mcpLogPush(mcpCh, mcpLevel, mcpDir, ts + text, textBytes.length, mcpSrc);
}

// 移除最旧的 N 行
function bufferTrimOld(m, count) {
    count = Math.min(count, m._textCount);
    if (count <= 0) return;
    var newStart = m._textOffsets[count - 1]; // 第 N 行的结束位置 = 新数据的起始位置
    // 移动数据到开头
    var remaining = m._textDataLen - newStart;
    m._textData.copyWithin(0, newStart, m._textDataLen);
    m._textDataLen = remaining;
    // 移动索引
    for (var i = count; i < m._textCount; i++) {
        m._textOffsets[i - count] = m._textOffsets[i] - newStart;
        m._textTypes[i - count] = m._textTypes[i];
        m._textTsLens[i - count] = m._textTsLens[i];
    }
    m._textCount -= count;
    m._bufferStart = Math.max(0, m._bufferStart - count);
}

// 按字节预算裁剪：保留尾部约 targetBytes 字节的数据（二分找起点，O(log n)）
// 单调性：从第 i 行起到末尾的字节数随 i 递增而单调不增，所以可以二分。
function bufferTrimToBytes(m, targetBytes) {
    if (!m || m._textCount <= 1) return;
    if (m._textDataLen <= targetBytes) return;
    var lo = 0, hi = m._textCount - 1; // hi 上界保证至少保留最后一行
    while (lo < hi) {
        var mid = (lo + hi) >> 1;
        var start = mid === 0 ? 0 : m._textOffsets[mid - 1];
        if (m._textDataLen - start <= targetBytes) hi = mid; else lo = mid + 1;
    }
    if (lo > 0) bufferTrimOld(m, lo);
}

// 容量跟随活跃数据收缩。
// 原实现只做 2 倍扩容、裁剪后从不收缩 ⇒ 容量单调增长，且扩容瞬间要同时持有"旧+新"两份
// （瞬时峰值可达活跃数据的 3 倍）。这里在"用量不到容量一半"时重新分配到刚好够用的 2 的幂。
function bufferCompactCapacity(m) {
    if (!m) return;
    var needData = m._textDataLen;
    if (m._textData.length > TEXT_BUF_INIT && needData * 2 < m._textData.length) {
        var cap = TEXT_BUF_INIT;
        while (cap < needData) cap <<= 1;
        var nd = new Uint8Array(cap);
        nd.set(m._textData.subarray(0, needData));
        m._textData = nd;
    }
    var needIdx = m._textCount;
    if (m._textOffsets.length > TEXT_IDX_INIT && needIdx * 2 < m._textOffsets.length) {
        var capIdx = TEXT_IDX_INIT;
        while (capIdx < needIdx) capIdx <<= 1;
        var no = new Uint32Array(capIdx), nt = new Uint8Array(capIdx), nl = new Uint16Array(capIdx);
        no.set(m._textOffsets.subarray(0, needIdx));
        nt.set(m._textTypes.subarray(0, needIdx));
        nl.set(m._textTsLens.subarray(0, needIdx));
        m._textOffsets = no;
        m._textTypes = nt;
        m._textTsLens = nl;
    }
}

// 超预算就裁到一半并压缩容量（紧凑存储的唯一入口，别在别处单独写裁剪逻辑）
function bufferEnforceBudget(m) {
    if (!m) return;
    // 防御：万一某条监视器创建路径忘了设 _textDataMaxBytes，`len <= undefined` 恒为 false、
    // `undefined >> 1` 又是 0，会把缓冲裁成只剩一行（保存/复制全废）。这里回退到默认预算。
    var max = (typeof m._textDataMaxBytes === 'number' && m._textDataMaxBytes > 0)
        ? m._textDataMaxBytes : (8 * 1024 * 1024);
    if (m._textDataLen <= max) return;
    bufferTrimToBytes(m, max >> 1);
    bufferCompactCapacity(m);
}

// 找到紧凑存储中最后一条 recv 记录（即“未结束的接收行”所在条目）
function bufferFindLastRecvIndex(m) {
    if (!m) return -1;
    for (var j = m._textCount - 1; j >= 0; j--) {
        if (m._textTypes[j] === 0) return j; // 0 = recv
    }
    return -1;
}

// 原地更新紧凑存储中某一行文本（保留时间戳），并修正后续行的偏移
function bufferUpdateLineText(m, idx, text) {
    if (!m || idx < 0 || idx >= m._textCount) return;
    var start = idx > 0 ? m._textOffsets[idx - 1] : 0;
    var oldEnd = m._textOffsets[idx];
    var tsLen = m._textTsLens[idx];
    var tsBytes = m._textData.slice(start, start + tsLen);
    var textBytes = new TextEncoder().encode(text);
    var newEnd = start + tsLen + textBytes.length;
    var delta = newEnd - oldEnd;
    if (m._textDataLen + delta > m._textData.length) {
        var newBuf = new Uint8Array(Math.max(m._textData.length * 2, m._textDataLen + delta));
        newBuf.set(m._textData);
        m._textData = newBuf;
    }
    if (delta !== 0) {
        m._textData.copyWithin(newEnd, oldEnd, m._textDataLen);
    }
    m._textData.set(tsBytes, start);
    m._textData.set(textBytes, start + tsLen);
    m._textDataLen += delta;
    m._textOffsets[idx] = newEnd;
    for (var j = idx + 1; j < m._textCount; j++) {
        m._textOffsets[j] += delta;
    }
    // 单行持续增长（比如设备长时间不发换行）也要受字节预算约束；
    // bufferTrimToBytes 至少保留最后一行，所以正在更新的这一行不会被裁掉。
    bufferEnforceBudget(m);
}

// 读取一行
function bufferGetLine(m, index) {
    if (index < 0 || index >= m._textCount) return null;
    var end = m._textOffsets[index];
    var tsLen = m._textTsLens[index];
    var start = index > 0 ? m._textOffsets[index - 1] : 0;
    var tsBytes = m._textData.slice(start, start + tsLen);
    var textBytes = m._textData.slice(start + tsLen, end);
    return {
        type: _typeNames[m._textTypes[index]],
        ts: _textDecoder.decode(tsBytes),
        text: _textDecoder.decode(textBytes)
    };
}

// 读取范围
function bufferGetLines(m, startIdx, endIdx) {
    var result = [];
    for (var i = startIdx; i < endIdx && i < m._textCount; i++) {
        result.push(bufferGetLine(m, i));
    }
    return result;
}

// 获取全部文本（用于保存/复制）
function bufferGetAllText(m) {
    if (!m || m._textCount === 0) return '';
    var parts = [];
    for (var i = 0; i < m._textCount; i++) {
        var item = bufferGetLine(m, i);
        parts.push(item.ts + item.text.replace(/\x1b\[[0-9;]*m/g, ''));
    }
    return parts.join('\n');
}

// 从紧凑存储加载更多历史日志（滚动到顶部时触发）
function loadMoreHistory(mid, el, callback) {
    var m = monitors[mid];
    if (!m || m._bufferStart <= 0 || m._textCount === 0) { if (callback) callback(); return; }

    var loadCount = 1000;
    var startIdx = Math.max(0, m._bufferStart - loadCount);
    var endIdx = m._bufferStart;
    var items = bufferGetLines(m, startIdx, endIdx);
    if (items.length === 0) { if (callback) callback(); return; }

    // 记录当前滚动位置
    var prevScrollHeight = el.scrollHeight;

    // 用 DocumentFragment 批量创建
    var fragment = document.createDocumentFragment();
    for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var div = document.createElement('div');
        div.className = 'ol ' + item.type;
        var lnSpan = document.createElement('span');
        lnSpan.className = 'ln';
        lnSpan.setAttribute('contenteditable', 'false');
        div.appendChild(lnSpan);
        var contentSpan = document.createElement('span');
        contentSpan.className = 'lc';
        if (item.type === 'recv') {
            if (item.text.indexOf('\x1b') === -1) {
                contentSpan.textContent = item.ts + item.text;
            } else {
                contentSpan.innerHTML = escapeHtml(item.ts) + parseAnsi(item.text);
            }
        } else if (item.type === 'send') {
            // 安全：send 行不需要 ANSI 渲染，直接用 textContent，避免未转义文本注入 HTML（XSS）
            contentSpan.textContent = item.ts + item.text;
        } else {
            contentSpan.textContent = item.ts + item.text;
        }
        div.appendChild(contentSpan);
        fragment.appendChild(div);
    }

    // 插入到 DOM 开头
    el.prepend(fragment);

    // 重排行号：新插入的历史行 .ln 为空，且 _lineCount 需重算，避免行号错乱/重复（P1-15）
    updateLineNumbers(mid);

    // 调整滚动位置，让用户看到的内容不跳动
    var newScrollHeight = el.scrollHeight;
    el.scrollTop += (newScrollHeight - prevScrollHeight);

    // 更新 _bufferStart
    m._bufferStart = startIdx;

    if (callback) callback();
}

// 滚回底部时清理多余旧行（force：用户已回到底部，不必再保护）
function cleanupExtraLines(mid, el) {
    if (!monitors[mid]) return;
    trimOutputDom(mid, el, true);
}

/* ===== 工具函数 ===== */
// 解析转义序列：\r\n -> CR+LF, \n -> LF, \r -> CR, \t -> TAB, \\ -> \
function parseEscapes(s) {
    return s.replace(/\\(r|n|t|\\)/g, function(m, ch) {
        if (ch === 'r') return '\r';
        if (ch === 'n') return '\n';
        if (ch === 't') return '\t';
        if (ch === '\\') return '\\';
        return m;
    });
}

function hexToBytes(s) {
    s = s.replace(/0[xX]/g,'').replace(/\s+/g,'');
    if (s.length%2!==0) throw new Error('Hex长度必须为偶数');
    var out = [];
    for (var i=0; i<s.length; i+=2) {
        var b = parseInt(s.substr(i,2),16);
        if (isNaN(b)) throw new Error('无效Hex: '+s.substr(i,2));
        out.push(b);
    }
    return new Uint8Array(out);
}
function bytesToHex(arr) {
    var u8 = arr instanceof Uint8Array ? arr : new Uint8Array(arr);
    var parts = new Array(u8.length);
    for (var i = 0; i < u8.length; i++) {
        parts[i] = (u8[i] < 16 ? '0' : '') + u8[i].toString(16).toUpperCase();
    }
    return parts.join(' ');
}

