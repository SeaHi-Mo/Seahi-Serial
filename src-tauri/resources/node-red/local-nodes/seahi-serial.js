/**
 * seahi-serial —— 宿主串口 ↔ Node-RED 的桥接节点（serial in / serial out）
 *
 * ⚠️ 这两个节点**不自己开串口**。
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
 *
 *    一个进程只建一条连接，所有节点共用（连不上会退避重试，不会把日志刷爆）。
 */

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
            (bridge.queue || []).forEach(function () {});
            bridge.queue = [];
            bridge.pending.forEach(function (p) {
                clearTimeout(p.timer);
                p.reject(err || new Error('桥连接断开'));
            });
            bridge.pending.clear();
        }
        sock.on('error', onDown);
        sock.on('close', function () { if (!bridge.ready) onDown(); else onDown(); });
    }

    /* ---------------- serial out ---------------- */
    function SerialOutNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.monitor = (config.monitor || 'main').trim();
        node.eol = config.eol || 'crlf';
        node.asHex = config.asHex === true || config.asHex === 'true';

        const EOL = { crlf: '\r\n', cr: '\r', lf: '\n', none: '' };

        node.on('input', function (msg, send, done) {
            send = send || function () { node.send.apply(node, arguments); };
            done = done || function (err) { if (err) node.error(err, msg); };

            let bytes;
            if (node.asHex) {
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
                    node.status({ fill: 'red', shape: 'ring', text: String(err.message || err) });
                    done(err);
                });
        });
    }
    RED.nodes.registerType('serial out', SerialOutNode);

    /* ---------------- serial in ---------------- */
    function SerialInNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.monitor = (config.monitor || 'main').trim();
        node.pollMs = Math.max(20, parseInt(config.pollMs, 10) || 100);
        let timer = null;
        let busy = false;

        node.on('close', function () {
            if (timer) { clearInterval(timer); timer = null; }
        });

        function tick() {
            if (busy) return;           // 上一轮还没回来就跳过这一拍，别堆积
            busy = true;
            bridgeCall('read', { monitor: node.monitor }, 2000)
                .then(function (r) {
                    busy = false;
                    if (!r.rx) return;
                    const buf = Buffer.from(r.rx, 'hex');
                    node.status({ fill: 'green', shape: 'dot', text: '收到 ' + buf.length + 'B' });
                    node.send({ payload: buf, monitor: node.monitor });
                })
                .catch(function (err) {
                    busy = false;
                    node.status({ fill: 'red', shape: 'ring', text: String(err.message || err) });
                });
        }

        timer = setInterval(tick, node.pollMs);
        node.status({ fill: 'blue', shape: 'dot', text: '监听 ' + node.monitor });
    }
    RED.nodes.registerType('serial in', SerialInNode);
};
