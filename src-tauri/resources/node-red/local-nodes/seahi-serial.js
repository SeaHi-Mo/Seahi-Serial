/**
 * seahi-serial —— 宿主串口 ↔ Node-RED 的桥接节点（serial rxd / serial txd / serial request）
 *
 * ⚠️ 这几个节点**不自己开串口**。
 *    COM 口由宿主进程（Rust）独占：监视器、DTR/RTS、WSL 映射、BLE 都在用同一个口。
 *    节点如果再 open 一次，要么直接失败，要么把数据分走一半（监视器少一段、流程多一段）。
 *    所以节点只跟宿主说话，走的是启动时用环境变量给出的回环 TCP 桥：
 *
 *        SEAHI_BRIDGE_PORT   —— 端口
 *        SEAHI_BRIDGE_TOKEN  —— 一次性令牌（不写命令行，避免进程列表里可见）
 *
 *    协议是换行分隔的 JSON：
 *        → {"op":"hello","token":"…"}            ← {"ok":true}
 *        → {"op":"send","monitor":"main","hex":"4154"}  ← {"ok":true,"written":2}
 *        → {"op":"read","monitor":"main"}        ← {"ok":true,"rx":"4f4b0d0a"}
 *        → {"op":"monitors"}                     ← {"ok":true,"monitors":[{"id":"main","port":"COM17","baud":115200}]}
 *
 *    ⚠️ 宿主回执必须带请求里的 `id`：本文件按 id 匹配回执，没有 id 的行会被当成
 *       不相干的输出丢掉 → 每个请求都等到超时（2026-11 真机验证踩过，见 main.rs 的
 *       bridge_attach_id）。
 *
 *    一个进程只建一条连接，所有节点共用（连不上会退避重试，不会把日志刷爆）。
 */

const { StringDecoder } = require('string_decoder');

/* 格式归一化。
 *  - 新字段是 `format`：text / hex（serial txd）、text / hex / buffer（serial rxd）。
 *  - 老流程里的 `asHex:true` 必须继续按 HEX 走，否则升级后发出去的就是字面量 "41 54"。 */
function normalizeFormat(value, legacyHex) {
    if (value === 'hex' || value === 'text' || value === 'buffer') return value;
    return legacyHex === true ? 'hex' : 'text';
}

module.exports = function (RED) {
    const net = require('net');

    const BRIDGE_PORT = parseInt(process.env.SEAHI_BRIDGE_PORT || '0', 10);
    const BRIDGE_TOKEN = process.env.SEAHI_BRIDGE_TOKEN || '';

    /* ---------------- 桥客户端（进程级单例） ---------------- */
    const bridge = {
        sock: null,
        ready: false,
        connecting: false,
        nextAt: 0,          // 退避：连不上时不要每次都立即重试
        seq: 0,
        pending: new Map(), // id -> {resolve, reject, timer, need}
        carry: ''           // 半行缓存
    };

    function bridgeCall(op, payload, timeoutMs) {
        return new Promise(function (resolve, reject) {
            if (!BRIDGE_PORT) {
                return reject(new Error('没有拿到宿主桥端口（SEAHI_BRIDGE_PORT 为空）'));
            }
            bridgeEnsure();
            const id = ++bridge.seq;
            const msg = Object.assign({ op: op, id: id }, payload || {});
            const timer = setTimeout(function () {
                bridge.pending.delete(id);
                reject(new Error('桥请求超时：' + op));
            }, timeoutMs || 3000);
            bridge.pending.set(id, { resolve: resolve, reject: reject, timer: timer });
            if (bridge.ready && bridge.sock) {
                bridge.sock.write(JSON.stringify(msg) + '\n');
            } else {
                // 还没连上：先挂在待发队列里，hello 成功后再统一 flush
                (bridge.queue = bridge.queue || []).push(JSON.stringify(msg) + '\n');
            }
        });
    }

    function bridgeEnsure() {
        if (bridge.ready || bridge.connecting) return;
        if (Date.now() < bridge.nextAt) return;
        bridge.connecting = true;
        bridge.carry = '';
        const sock = net.connect({ host: '127.0.0.1', port: BRIDGE_PORT }, function () {
            sock.write(JSON.stringify({ op: 'hello', token: BRIDGE_TOKEN }) + '\n');
        });
        bridge.sock = sock;

        sock.on('data', function (chunk) {
            bridge.carry += chunk.toString('utf8');
            let i;
            while ((i = bridge.carry.indexOf('\n')) >= 0) {
                const line = bridge.carry.slice(0, i);
                bridge.carry = bridge.carry.slice(i + 1);
                if (!line.trim()) continue;
                let v;
                try { v = JSON.parse(line); } catch (e) { continue; }
                if (v.ok === true && !bridge.ready) {
                    // 握手成功：把排队请求发出去
                    bridge.ready = true;
                    bridge.connecting = false;
                    (bridge.queue || []).forEach(function (s) { sock.write(s); });
                    bridge.queue = [];
                    continue;
                }
                const id = v.id;
                if (id === undefined) continue;
                const p = bridge.pending.get(id);
                if (!p) continue;
                bridge.pending.delete(id);
                clearTimeout(p.timer);
                if (v.ok) p.resolve(v);
                else p.reject(new Error(v.error || '桥返回失败'));
            }
        });

        function onDown(err) {
            bridge.ready = false;
            bridge.connecting = false;
            bridge.sock = null;
            bridge.nextAt = Date.now() + 2000;   // 2 秒退避
            bridge.queue = [];
            bridge.pending.forEach(function (p) {
                clearTimeout(p.timer);
                p.reject(err || new Error('桥连接断开'));
            });
            bridge.pending.clear();
        }
        sock.on('error', onDown);
        sock.on('close', function () { onDown(); });
    }

    /* ---------------- 编辑器接口：当前打开的串口 ---------------- */
    /* 节点的「监视器」下拉靠它填：Node-RED 编辑器是**另一个 origin**（127.0.0.1:端口），
       拿不到宿主桥的令牌，所以由侧车这边代问一次，只把 id / 端口名 / 波特率回给编辑器。
       走 RED.httpAdmin（与编辑器同源、受 adminAuth 保护；本程序没开 adminAuth，但只有回环可达）。 */
    function registerAdminRoutes() {
        if (!RED.httpAdmin || typeof RED.httpAdmin.get !== 'function') return;
        RED.httpAdmin.get('/seahi-serial/monitors', function (req, res) {
            bridgeCall('monitors', {}, 2000)
                .then(function (r) { res.json(r.monitors || []); })
                .catch(function (err) {
                    res.status(503).json({ error: String((err && err.message) || err) });
                });
        });
    }

    /* id → 端口名（COM17 · 115200）。界面上不露 main/extra-1 —— 那是宿主的内部实现细节。
       只查一次，进程内缓存；查不到就退回 id，不影响功能。 */
    let monitorNames = null;
    function monitorLabel(id) {
        if (monitorNames && monitorNames[id]) return monitorNames[id];
        if (!monitorNames) {
            monitorNames = {};
            bridgeCall('monitors', {}, 1500).then(function (r) {
                (r.monitors || []).forEach(function (m) {
                    const info = [];
                    if (m.port) info.push(m.port);
                    if (m.baud) info.push(m.baud + ' bps');
                    monitorNames[m.id] = info.length ? info.join(' · ') : m.id;
                });
            }).catch(function () {});
        }
        return id === 'main' ? '主分栏' : id;
    }
    /* 桥只会回一句「没有打开的串口」—— 具体是"一个口都没开"还是"这一个口没开"，
       只有节点这边说得清（它缓存了端口名）。用户 2026-11 要求两种说法分开：
         · 没有任何可用端口          → 没有可用的串口
         · 选中的那个端口没打开      → COM17 没有打开
       其余错误原样返回（别把真错误也吞成一句通用话）。 */
    function portErrorText(msg, id) {
        const s = String((msg && msg.message) || msg || '');
        if (s.indexOf('没有打开的串口') < 0) return s;
        // 缓存里有这个口 → 它现在是关着的；缓存整个是空的 → 一个口都没有
        if (monitorNames && monitorNames[id]) return String(monitorNames[id]).split(' · ')[0] + ' 没有打开';
        return '没有可用的串口';
    }
    /* ---------------- serial txd ---------------- */
    function SerialOutNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.monitor = (config.monitor || 'main').trim();
        node.eol = config.eol || 'crlf';
        node.format = normalizeFormat(config.format, config.asHex);

        const EOL = { crlf: '\r\n', cr: '\r', lf: '\n', none: '' };

        node.on('input', function (msg, send, done) {
            send = send || function () { node.send.apply(node, arguments); };
            done = done || function (err) { if (err) node.error(err, msg); };

            let bytes;
            if (node.format === 'hex') {
                const s = String(msg.payload === undefined ? '' : msg.payload).replace(/\s+/g, '');
                if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) {
                    node.status({ fill: 'red', shape: 'ring', text: 'HEX 非法' });
                    return done(new Error('payload 不是合法的十六进制串'));
                }
                bytes = Buffer.from(s, 'hex');
            } else {
                const text = (typeof msg.payload === 'string') ? msg.payload : String(msg.payload);
                bytes = Buffer.from(text + (EOL[node.eol] || ''), 'utf8');
            }
            if (!bytes.length) {
                node.status({ fill: 'grey', shape: 'dot', text: '空内容，未发送' });
                return done();
            }

            node.status({ fill: 'blue', shape: 'dot', text: '发送中 ' + bytes.length + 'B' });
            bridgeCall('send', { monitor: node.monitor, hex: bytes.toString('hex') }, 3000)
                .then(function (r) {
                    node.status({ fill: 'green', shape: 'dot', text: '已发 ' + (r.written || bytes.length) + 'B' });
                    msg.sent = r.written || bytes.length;
                    send(msg);
                    done();
                })
                .catch(function (err) {
                    const text = portErrorText(err, node.monitor);
                    node.status({ fill: 'red', shape: 'ring', text: text });
                    done(new Error(text));
                });
        });
    }
    RED.nodes.registerType('serial txd', SerialOutNode);

    /* ---------------- serial rxd ---------------- */
    function SerialInNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.monitor = (config.monitor || 'main').trim();
        node.pollMs = Math.max(20, parseInt(config.pollMs, 10) || 100);
        node.format = normalizeFormat(config.format, config.asHex);

        /* text 模式按 UTF-8 解码，并**跨包保留半个字符**：
           串口读线程按 4 KB 切块，一个汉字（3 字节）恰好被切在两块之间时，
           逐块 toString() 会得到两个 U+FFFD。StringDecoder 会把残字节留在内部。 */
        let decoder = node.format === 'text' ? new StringDecoder('utf8') : null;

        let timer = null;
        let busy = false;

        node.on('close', function () {
            if (timer) { clearInterval(timer); timer = null; }
            if (decoder) { decoder.end(); decoder = null; }
        });

        function convert(buf) {
            if (node.format === 'hex') return buf.toString('hex');
            if (node.format === 'buffer') return buf;
            return decoder.write(buf);
        }

        function tick() {
            if (busy) return;           // 上一轮还没回来就跳过这一拍，别堆积
            busy = true;
            bridgeCall('read', { monitor: node.monitor }, 2000)
                .then(function (r) {
                    busy = false;
                    if (!r.rx) return;
                    const buf = Buffer.from(r.rx, 'hex');
                    const payload = convert(buf);
                    /* text 模式下可能只收到半个 UTF-8 字符（payload 为空串）：
                       这一拍不发空消息，等下一块补全。 */
                    if (node.format === 'text' && payload === '') return;
                    const n = (node.format === 'text') ? payload.length : buf.length;
                    node.status({
                        fill: 'green', shape: 'dot',
                        text: '收到 ' + n + (node.format === 'text' ? ' 字符' : 'B')
                    });
                    /* raw 永远给原始字节：text 模式下要按字节匹配（如 CRC、二进制头）也不必回头改节点。
                       buffer 模式下 payload 与 raw 是同一个 Buffer（不复制）。 */
                    node.send({ payload: payload, raw: buf, monitor: node.monitor });
                })
                .catch(function (err) {
                    busy = false;
                    node.status({ fill: 'red', shape: 'ring', text: portErrorText(err, node.monitor) });
                });
        }

        timer = setInterval(tick, node.pollMs);
        node.status({ fill: 'blue', shape: 'dot', text: '监听 ' + monitorLabel(node.monitor) + '（' + node.format + '）' });
    }
    RED.nodes.registerType('serial rxd', SerialInNode);

    /* ---------------- serial request（发一条、收一段） ---------------- */
    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function clampInt(v, dflt, min, max) {
        const n = parseInt(v, 10);
        if (!isFinite(n) || n <= 0) return dflt;
        return Math.min(max, Math.max(min, n));
    }

    /* 一个节点内串行排队：一条请求收口之后才发下一条，绝不让两段回复混在一起。
       这不是"优化"，是这条节点的语义 —— 否则又回到"这条 OK 是谁的"那个问题。 */
    function SerialRequestNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.monitor = (config.monitor || 'main').trim();
        node.sendFormat = config.sendFormat === 'hex' ? 'hex' : 'text';
        node.recvFormat = (config.recvFormat === 'hex' || config.recvFormat === 'buffer')
            ? config.recvFormat : 'text';
        node.eol = config.eol || 'crlf';
        node.timeoutMs = clampInt(config.timeoutMs, 1000, 50, 60000);
        node.quietMs = clampInt(config.quietMs, 80, 10, 5000);

        /* 结果分支：**一个条件一个连接点**（与 switch 同一套用法）。
           默认 OK / ERROR 两路；用户可加「包含 / 等于 / 正则 / 未匹配或超时」。
           「未匹配或超时」是兜底条件：只有前面所有文本条件都没命中时才走它。 */
        const RULE_TYPES = { cont: 1, eq: 1, regex: 1, timeout: 1 };
        const DEFAULT_RULES = [{ t: 'cont', v: 'OK' }, { t: 'cont', v: 'ERROR' }];
        node.rules = (Array.isArray(config.rules) && config.rules.length ? config.rules : DEFAULT_RULES)
            .map(function (r) {
                const t = (r && RULE_TYPES[r.t]) ? r.t : 'cont';
                return { t: t, v: String(r && r.v != null ? r.v : '') };
            });
        node.outputs = node.rules.length;
        const reCache = node.rules.map(function (r) {
            if (r.t !== 'regex') return null;
            try { return new RegExp(r.v); }
            catch (e) { node.warn('条件不是合法的正则，已忽略：' + r.v); return null; }
        });
        const timeoutIndex = node.rules.findIndex(function (r) { return r.t === 'timeout'; });

        function matchIndex(text) {
            for (let i = 0; i < node.rules.length; i++) {
                const r = node.rules[i];
                if (r.t === 'timeout') continue;      // 兜底条件不参与"命中"
                if (r.t === 'cont') {
                    if (text.indexOf(r.v) !== -1) return i;
                } else if (r.t === 'eq') {
                    if (text.trim() === r.v) return i;
                } else if (r.t === 'regex') {
                    const re = reCache[i];
                    if (re && re.test(text)) return i;
                }
            }
            return -1;
        }

        const EOL = { crlf: '\r\n', cr: '\r', lf: '\n', none: '' };

        let closed = false;
        let busy = false;
        const queue = [];           // {msg, send, done}
        const MAX_QUEUE = 32;

        node.on('close', function () {
            closed = true;
            queue.length = 0;
        });

        function encode(payload) {
            if (node.sendFormat === 'hex') {
                const s = String(payload === undefined ? '' : payload).replace(/\s+/g, '');
                if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) {
                    throw new Error('payload 不是合法的十六进制串');
                }
                return Buffer.from(s, 'hex');
            }
            const text = (typeof payload === 'string') ? payload : String(payload);
            return Buffer.from(text + (EOL[node.eol] || ''), 'utf8');
        }

        function convert(raw) {
            if (node.recvFormat === 'hex') return raw.toString('hex');
            if (node.recvFormat === 'buffer') return raw;
            return raw.toString('utf8');
        }

        async function run(job) {
            const msg = job.msg;
            let bytes;
            try { bytes = encode(msg.payload); }
            catch (e) { job.done(e); return; }

            /* ① 清空旧数据：上一轮迟到的尾巴不能混进这一条的回复。
               这一步必须在**写之前**（顺序反过来就会把刚到的回复清掉）。 */
            node.status({ fill: 'blue', shape: 'dot', text: '清空旧数据' });
            await bridgeCall('read', { monitor: node.monitor }, 2000);
            if (closed) return;

            /* ② 写串口（与 serial txd 同一个桥命令，监视窗口里同样会看到这条发送） */
            node.status({ fill: 'blue', shape: 'dot', text: '发送 ' + bytes.length + 'B' });
            await bridgeCall('send', { monitor: node.monitor, hex: bytes.toString('hex') }, 3000);
            if (closed) return;

            /* ③ 收窗口：命中任一条件 / 静默 / 最长，谁先到谁收口 */
            const start = Date.now();
            let lastByteAt = 0;
            let total = 0;
            const chunks = [];
            let matchedIndex = -1;
            let timedOut = false;

            while (!closed) {
                const r = await bridgeCall('read', { monitor: node.monitor }, 2000);
                if (r.rx) {
                    const b = Buffer.from(r.rx, 'hex');
                    chunks.push(b);
                    total += b.length;
                    lastByteAt = Date.now();
                    /* 条件按"到目前为止的整段文本"匹配：分块到达也不会漏。 */
                    matchedIndex = matchIndex(Buffer.concat(chunks).toString('utf8'));
                    if (matchedIndex >= 0) break;
                    node.status({ fill: 'blue', shape: 'dot', text: '收集中 ' + total + 'B' });
                }
                const now = Date.now();
                if (total > 0 && now - lastByteAt >= node.quietMs) break;
                if (now - start >= node.timeoutMs) { timedOut = true; break; }
                await sleep(20);
            }
            if (closed) return;

            const raw = Buffer.concat(chunks);
            const rule = matchedIndex >= 0 ? node.rules[matchedIndex] : null;
            const out = Object.assign({}, msg, {
                payload: convert(raw),
                raw: raw,
                cmd: String(msg.payload === undefined ? '' : msg.payload),
                monitor: node.monitor,
                bytes: total,
                elapsedMs: Date.now() - start,
                matched: rule ? rule.v : null,
                matchedIndex: matchedIndex,
                matchedType: rule ? rule.t : null,
                timedOut: timedOut,
                reason: rule ? 'rule' : (timedOut ? 'timeout' : 'quiet')
            });

            /* 路由：命中哪条规则就走哪个输出口；都没命中才轮到「未匹配/超时」兜底口。
               兜底条件也没配时**不静默吞掉**：状态标黄 + node.warn 说明结果被丢弃。 */
            let target = matchedIndex >= 0 ? matchedIndex : timeoutIndex;
            if (target < 0) {
                node.status({ fill: 'yellow', shape: 'dot', text: '收到 ' + total + 'B（未匹配，无兜底口）' });
                node.warn('serial request：回复未命中任何条件，且没有配置「未匹配/超时」条件，结果已丢弃');
                job.done();
                return;
            }

            const ports = new Array(Math.max(node.outputs || 0, node.rules.length)).fill(null);
            ports[target] = out;
            if (rule) node.status({ fill: 'green', shape: 'dot', text: '命中「' + rule.v + '」' });
            else node.status({ fill: 'grey', shape: 'dot', text: timedOut ? '超时（走兜底口）' : '未匹配（走兜底口）' });

            job.send(ports);
            job.done();
        }

        async function pump() {
            if (busy || closed) return;
            const job = queue.shift();
            if (!job) return;
            busy = true;
            try {
                await run(job);
            } catch (e) {
                const text = portErrorText(e, job.monitor || node.monitor);
                node.status({ fill: 'red', shape: 'ring', text: text });
                job.done(new Error(text));
            } finally {
                busy = false;
                pump();
            }
        }

        node.on('input', function (msg, send, done) {
            send = send || function () { node.send.apply(node, arguments); };
            done = done || function (err) { if (err) node.error(err, msg); };
            if (queue.length >= MAX_QUEUE) {
                return done(new Error('serial request 队列已满（' + MAX_QUEUE + ' 条）'));
            }
            queue.push({ msg: msg, send: send, done: done });
            pump();
        });

        node.status({ fill: 'grey', shape: 'dot', text: '待请求（' + monitorLabel(node.monitor) + '）' });
    }
    RED.nodes.registerType('serial request', SerialRequestNode);

    registerAdminRoutes();
};
