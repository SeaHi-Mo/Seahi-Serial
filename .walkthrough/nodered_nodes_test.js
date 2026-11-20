#!/usr/bin/env node
/* serial rxd / serial txd 两个节点的无头断言（不依赖真串口、不依赖正在跑的应用）
 *
 * 做法：起一个**假桥**（回环 TCP，协议与 main.rs 的 bridge_serve 一致，包括
 *      「回执必须带请求 id」这一条），把 local-nodes/seahi-serial.js 加载进一个
 *      假 RED 运行时，直接驱动节点的 input / 轮询，断言发出去与收到的 payload。
 *
 * 为什么要有它：这两个节点是随包分发的运行时代码，前端断言集扫不到；
 *      2026-11 真机验证时"桥忘了回 id"就是两端各自单测都绿、合起来全超时。
 *
 * 用法：node .walkthrough/nodered_nodes_test.js
 */

'use strict';

const net = require('net');
const path = require('path');
const fs = require('fs');

const BRIDGE_TOKEN = 'test-token';
const NODES_DIR = path.join(__dirname, '..', 'src-tauri', 'resources', 'node-red', 'local-nodes');
const NODE_FILE = path.join(NODES_DIR, 'seahi-serial.js');
const HTML_FILE = path.join(NODES_DIR, 'seahi-serial.html');

let checks = 0;
let failures = 0;

function check(cond, name, detail) {
    checks++;
    if (cond) {
        console.log('  ok   ' + name);
    } else {
        failures++;
        console.log('  FAIL ' + name + (detail ? '\n       ' + detail : ''));
    }
}

function eq(actual, expected, name) {
    check(actual === expected, name, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

/* ---------------- 假桥 ---------------- */
const bridgeState = {
    rx: [],        // 每次 read 依次取一项（hex 串）；空了就回空
    sends: [],     // 收到的 send 请求
    reads: [],     // 收到的 read 请求（钉住监视器 id 有没有被原样带过去）
    /* 「当前已打开的串口」——与 main.rs bridge_list_monitors 的回执形状一致 */
    monitors: [
        { id: 'main', port: 'COM17', baud: 115200 },
        { id: 'extra-1', port: 'COM3', baud: 9600 }
    ],
    clients: 0
};

function startFakeBridge() {
    return new Promise(function (resolve) {
        const server = net.createServer(function (sock) {
            bridgeState.clients++;
            let carry = '';
            sock.on('data', function (chunk) {
                carry += chunk.toString('utf8');
                let i;
                while ((i = carry.indexOf('\n')) >= 0) {
                    const line = carry.slice(0, i);
                    carry = carry.slice(i + 1);
                    if (!line.trim()) continue;
                    let v;
                    try { v = JSON.parse(line); } catch (e) { continue; }

                    if (v.op === 'hello') {
                        // 与真宿主一致：握手回执没有 id
                        sock.write(JSON.stringify(
                            v.token === BRIDGE_TOKEN ? { ok: true } : { ok: false, error: '令牌不对' }
                        ) + '\n');
                        continue;
                    }
                    if (v.id === undefined) {
                        sock.write(JSON.stringify({ ok: false, error: '缺 id' }) + '\n');
                        continue;
                    }
                    if (v.op === 'send') {
                        bridgeState.sends.push(v);
                        sock.write(JSON.stringify({ ok: true, id: v.id, written: v.hex.length / 2 }) + '\n');
                    } else if (v.op === 'read') {
                        bridgeState.reads.push(v);
                        const rx = bridgeState.rx.length ? bridgeState.rx.shift() : '';
                        sock.write(JSON.stringify({ ok: true, id: v.id, rx: rx }) + '\n');
                    } else if (v.op === 'monitors') {
                        sock.write(JSON.stringify({ ok: true, id: v.id, monitors: bridgeState.monitors }) + '\n');
                    } else {
                        sock.write(JSON.stringify({ ok: false, id: v.id, error: '未知 op' }) + '\n');
                    }
                }
            });
            sock.on('error', function () {});
        });
        server.listen(0, '127.0.0.1', function () {
            resolve(server);
        });
    });
}

/* ---------------- 假 RED 运行时 ---------------- */
const types = {};
const adminRoutes = {};
const RED = {
    nodes: {
        createNode: function (node, config) {
            node._handlers = {};
            node.on = function (ev, fn) { node._handlers[ev] = fn; };
            node.status = function (s) { node._status = s; };
            node.error = function (e) { node._error = e; };
            node.warn = function () {};
            node.log = function () {};
            node.send = function (m) {
                /* 多输出节点送的是数组（按输出口下标）；单输出节点送对象。
                   这里同时记消息与它落在哪个口，request 的分支断言要用。 */
                const outs = Array.isArray(m) ? m : [m];
                outs.forEach(function (x, i) {
                    if (!x) return;
                    (node._sent = node._sent || []).push(x);
                    (node._sentOut = node._sentOut || []).push(i);
                });
            };
            return node;
        },
        registerType: function (name, ctor) { types[name] = ctor; }
    },
    /* 编辑器侧要用到的管理路由，真 Node-RED 通过 RED.httpAdmin 注册 */
    httpAdmin: {
        get: function (p, handler) { adminRoutes[p] = handler; }
    }
};

/* 调一次管理路由，把 res.json 的结果取出来（失败走 reject，便于断言） */
function callAdminRoute(p) {
    return new Promise(function (resolve, reject) {
        const res = {
            json: function (v) { resolve(v); },
            status: function (code) {
                return { json: function (v) { reject(new Error('HTTP ' + code + ' ' + JSON.stringify(v))); } };
            }
        };
        adminRoutes[p]({ query: {} }, res);
    });
}

function makeNode(type, config) {
    const node = {};
    types[type].call(node, config || {});
    return node;
}

function closeNode(node) {
    if (node && node._handlers && node._handlers.close) node._handlers.close();
}

function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
}

/* ---------------- 用例 ---------------- */
async function main() {
    const server = await startFakeBridge();
    process.env.SEAHI_BRIDGE_PORT = String(server.address().port);
    process.env.SEAHI_BRIDGE_TOKEN = BRIDGE_TOKEN;

    require(NODE_FILE)(RED);

    check(typeof types['serial rxd'] === 'function', '注册了 serial rxd 节点');
    check(typeof types['serial txd'] === 'function', '注册了 serial txd 节点');
    check(typeof types['serial request'] === 'function', '注册了 serial request 节点');

    /* --- 编辑器接口：当前已打开的串口列表 --- */
    check(typeof adminRoutes['/seahi-serial/monitors'] === 'function',
        '注册了 /seahi-serial/monitors（编辑器下拉的数据源）');
    const monitors = await Promise.race([
        callAdminRoute('/seahi-serial/monitors'),
        sleep(2000).then(function () { throw new Error('管理路由 2s 未返回'); })
    ]);
    check(Array.isArray(monitors) && monitors.length === 2, '监视器接口返回已打开的两个串口',
        JSON.stringify(monitors));
    eq(monitors[0] && monitors[0].id, 'main', '监视器接口：主监视器排第一');
    eq(monitors[0] && monitors[0].port, 'COM17', '监视器接口：带端口名');
    eq(monitors[0] && monitors[0].baud, 115200, '监视器接口：带波特率');
    eq(monitors[1] && monitors[1].id, 'extra-1', '监视器接口：额外分栏也在列表里');

    /* --- 编辑器模板：监视器必须是下拉，且带刷新 --- */
    const html = fs.readFileSync(HTML_FILE, 'utf8');
    check(/<select id="node-input-monitor"/.test(html), '编辑器模板：监视器是下拉框（不再是自由文本）');
    check(/id="node-input-monitor-refresh"/.test(html), '编辑器模板：有「刷新」按钮');
    check(html.indexOf('seahi-serial/monitors') >= 0, '编辑器模板：从侧车读已打开的串口');
    check(/seahiBindMonitorSelect\(this\.monitor\)/.test(html), '编辑器模板：各节点都会在下拉里回填已保存的监视器');
    check(/data-template-name="serial request"/.test(html), '编辑器模板：有 serial request 的配置面板');
    check(/id="node-input-rules"/.test(html) && /id="node-input-add-rule"/.test(html),
        '编辑器模板：serial request 有结果分支编辑器（可添加条件）');
    check(/id="node-input-outputs"/.test(html) && /outputs: \{ value: 2 \}/.test(html),
        '编辑器模板：默认两个连接点，输出口数量跟条件数量走');

    /* ⚠️ 收方向的用例必须「先建节点、再喂数据」：关掉一个节点时可能还有一次 read 在路上，
       它会先取走队列里的数据（桥的接收队列是单消费者）—— 那会让用例随机拿到残片。 */
    async function feed(chunks, config, waitMs) {
        await sleep(80);                     // 等上一个节点在途的 read 落地
        const node = makeNode('serial rxd', Object.assign({ monitor: 'main', pollMs: 20 }, config || {}));
        chunks.forEach(function (c) { bridgeState.rx.push(c); });
        await sleep(waitMs || 200);
        closeNode(node);
        await sleep(60);
        return node;
    }

    /* --- serial rxd：默认（没写 format）必须是文本 --- */
    const rxText = await feed(['4f4b0d0a']);
    check(!!(rxText._sent && rxText._sent.length), '默认格式：收到数据并发出消息');
    if (rxText._sent && rxText._sent.length) {
        const m = rxText._sent[0];
        eq(typeof m.payload, 'string', '默认格式 payload 是字符串（不是 Buffer / hex）');
        eq(m.payload, 'OK\r\n', '默认格式按 UTF-8 解码出原文');
        check(Buffer.isBuffer(m.raw) && m.raw.toString('hex') === '4f4b0d0a', 'msg.raw 保留原始字节');
    }
    check(/text/.test(JSON.stringify(rxText._status || {})), '状态里标明当前格式');

    /* --- serial rxd：显式 format=hex --- */
    const rxHex = await feed(['41540d0a'], { format: 'hex' });
    const mh = rxHex._sent && rxHex._sent[0];
    eq(mh && mh.payload, '41540d0a', 'HEX 格式：payload 是小写十六进制串');

    /* --- serial rxd：format=buffer（老流程语义） --- */
    const rxBuf = await feed(['00ff10'], { format: 'buffer' });
    const mb = rxBuf._sent && rxBuf._sent[0];
    check(mb && Buffer.isBuffer(mb.payload), 'Buffer 格式：payload 是 Buffer');
    if (mb && Buffer.isBuffer(mb.payload)) {
        eq(mb.payload.toString('hex'), '00ff10', 'Buffer 格式：字节完整');
    }

    /* --- serial rxd：UTF-8 半个字符跨包拼接 --- */
    // "中" = e4 b8 ad，故意切在 e4b8 / ad 两块
    const rxSplit = await feed(['e4b8', 'ad'], {}, 280);
    const ms = rxSplit._sent || [];
    check(ms.length === 1, '跨包 UTF-8：只发一条消息，不把半个字符当乱码发出', 'got ' + ms.length + ' 条');
    eq(ms[0] && ms[0].payload, '中', '跨包 UTF-8：拼接后是完整字符');

    /* --- 监视器选择必须原样传给桥（两个分栏各读各的） --- */
    check(bridgeState.reads.some(function (r) { return r.monitor === 'main'; }),
        '监视器 main 的 read 请求带对了 id');
    const rxOther = await feed(['4f4b'], { monitor: 'extra-1' });
    check(bridgeState.reads.some(function (r) { return r.monitor === 'extra-1'; }),
        '换到第二个已打开的串口（extra-1）后，read 请求带的是它');
    eq(rxOther._sent && rxOther._sent[0] && rxOther._sent[0].monitor, 'extra-1',
        '消息上的 monitor 字段跟着选中的分栏走');

    /* --- serial request：发一条、收一段（发送 + 等回复的顺序由节点保证） --- */
    async function requestOnce(config, payload, waitMs) {
        await sleep(80);
        const node = makeNode('serial request', Object.assign({ monitor: 'main' }, config || {}));
        const out = [];
        const outIdx = [];
        const errs = [];
        node._handlers.input({ payload: payload }, function (m) {
            /* 多输出节点送数组（按下标对应连接点） */
            if (Array.isArray(m)) {
                m.forEach(function (x, i) {
                    if (x) { out.push(x); outIdx.push(i); }
                });
            } else {
                out.push(m);
                outIdx.push(0);
            }
        }, function (e) { if (e) errs.push(e); });
        await sleep(waitMs || 500);
        closeNode(node);
        await sleep(60);
        return { node: node, out: out, outIdx: outIdx, errs: errs };
    }

    // ⓪ 默认两条分支：OK / ERROR
    {
        const def = makeNode('serial request', { monitor: 'main' });
        check(Array.isArray(def.rules) && def.rules.length === 2 && def.rules[0].v === 'OK' && def.rules[1].v === 'ERROR',
            'serial request：默认有 OK / ERROR 两个结果分支');
        eq(def.outputs, 2, 'serial request：输出口数量 = 条件数量（默认 2）');
        def._handlers.close && def._handlers.close();
    }

    // ① 成功：第一条 rx 是"旧数据"（必须被清掉），第二条才是回复；命中第一条规则 → 输出口 0
    bridgeState.sends.length = 0;
    bridgeState.rx.length = 0;
    bridgeState.rx.push('aa', '4f4b0d0a');
    const reqOk = await requestOnce({
        timeoutMs: 600, quietMs: 80,
        rules: [{ t: 'cont', v: 'OK' }]
    }, 'AT');
    check(reqOk.out.length === 1 && reqOk.errs.length === 0, 'serial request：一条请求只输出一条结果',
        'out=' + reqOk.out.length + ' errs=' + JSON.stringify(reqOk.errs));
    eq(reqOk.outIdx[0], 0, 'serial request：命中第一个条件 → 从第 1 个连接点出去');
    if (reqOk.out[0]) {
        eq(reqOk.out[0].matched, 'OK', 'serial request：命中条件带回 matched');
        eq(reqOk.out[0].matchedType, 'cont', 'serial request：带回条件类型');
        eq(reqOk.out[0].payload, 'OK\r\n', 'serial request：回复按文本输出，且**旧数据已被清掉**');
        eq(reqOk.out[0].cmd, 'AT', 'serial request：带回这次发送的命令');
        eq(reqOk.out[0].reason, 'rule', 'serial request：reason=rule');
        check(Buffer.isBuffer(reqOk.out[0].raw) && reqOk.out[0].raw.toString('hex') === '4f4b0d0a',
            'serial request：raw 是原始字节');
    }
    eq(bridgeState.sends.length && bridgeState.sends[bridgeState.sends.length - 1].hex,
        '41540d0a', 'serial request：文本 + 行尾写进桥（与 serial txd 同一条路）');

    // ② 两个条件：命中 ERROR → 从第 2 个连接点出去
    bridgeState.rx.length = 0;
    bridgeState.rx.push('', '4552524f520d0a');
    const reqFail = await requestOnce({
        timeoutMs: 600,
        rules: [{ t: 'cont', v: 'OK' }, { t: 'cont', v: 'ERROR' }]
    }, 'AT+CSQ');
    eq(reqFail.outIdx[0], 1, 'serial request：命中第二个条件 → 从第 2 个连接点出去');
    eq(reqFail.out[0] && reqFail.out[0].matched, 'ERROR', 'serial request：ERROR 分支带回 matched');
    eq(reqFail.out[0] && reqFail.out[0].reason, 'rule', 'serial request：reason=rule（ERROR 也是规则命中）');

    // ③ 用户新增第三个条件：每加一条就多一个连接点
    bridgeState.rx.length = 0;
    bridgeState.rx.push('', '425553590d0a');   // BUSY\r\n
    const reqBusy = await requestOnce({
        timeoutMs: 600,
        rules: [{ t: 'cont', v: 'OK' }, { t: 'cont', v: 'BUSY' }, { t: 'cont', v: 'ERROR' }]
    }, 'AT+X');
    eq(reqBusy.outIdx[0], 1, 'serial request：新增的条件有自己的连接点（BUSY → 第 2 口）');
    eq(reqBusy.out[0] && reqBusy.out[0].matched, 'BUSY', 'serial request：新增条件命中后带回 matched');
    eq(reqBusy.node.outputs, 3, 'serial request：三个条件 → 三个连接点');

    // ④ 未匹配/超时兜底条件：没有回复 → 从兜底口出去
    bridgeState.rx.length = 0;
    const reqTimeout = await requestOnce({
        timeoutMs: 150, quietMs: 80,
        rules: [{ t: 'cont', v: 'OK' }, { t: 'timeout' }]
    }, 'AT+SLOW', 500);
    eq(reqTimeout.outIdx[0], 1, 'serial request：未匹配/超时走兜底连接点');
    check(reqTimeout.out[0] && reqTimeout.out[0].timedOut === true, 'serial request：没有回复 → timedOut=true');
    eq(reqTimeout.out[0] && reqTimeout.out[0].payload, '', 'serial request：超时也输出一条（payload 为空）');
    eq(reqTimeout.out[0] && reqTimeout.out[0].reason, 'timeout', 'serial request：reason=timeout');

    // ⑤ 没配兜底条件时：结果不假装成功，丢弃并 warn
    bridgeState.rx.length = 0;
    const reqNoFallback = await requestOnce({
        timeoutMs: 150, quietMs: 80,
        rules: [{ t: 'cont', v: 'OK' }]
    }, 'AT+NONE', 400);
    check(reqNoFallback.out.length === 0, 'serial request：未匹配且无兜底条件 → 不往任何连接点送');

    // ⑥ 发送 HEX：不追加行尾
    bridgeState.sends.length = 0;
    bridgeState.rx.length = 0;
    bridgeState.rx.push('', '4f4b');
    const reqHex = await requestOnce({ sendFormat: 'hex', timeoutMs: 600, rules: [{ t: 'cont', v: 'OK' }] }, '41 54');
    eq(bridgeState.sends.length && bridgeState.sends[bridgeState.sends.length - 1].hex, '4154',
        'serial request：HEX 模式按字节发送且不追加行尾');

    /* --- serial txd：默认文本 + 行尾 --- */
    bridgeState.sends.length = 0;
    const txText = makeNode('serial txd', { monitor: 'main', eol: 'crlf' });
    txText._handlers.input({ payload: 'AT' }, null, function () {});
    await sleep(150);
    check(bridgeState.sends.length === 1, '默认格式：发出一次 send');
    eq(bridgeState.sends[0] && bridgeState.sends[0].hex, '41540d0a', '默认格式：文本 + CRLF');

    /* --- serial txd：format=hex（不加行尾） --- */
    bridgeState.sends.length = 0;
    const txHex = makeNode('serial txd', { monitor: 'main', eol: 'crlf', format: 'hex' });
    txHex._handlers.input({ payload: '41 54 0D 0A' }, null, function () {});
    await sleep(150);
    eq(bridgeState.sends[0] && bridgeState.sends[0].hex, '41540d0a', 'HEX 格式：按字节发送且不追加行尾');

    /* --- 兼容：老流程 asHex=true 且没有 format --- */
    bridgeState.sends.length = 0;
    const txLegacy = makeNode('serial txd', { monitor: 'main', asHex: true });
    txLegacy._handlers.input({ payload: '4154' }, null, function () {});
    await sleep(150);
    eq(bridgeState.sends[0] && bridgeState.sends[0].hex, '4154', '老流程 asHex=true 仍按 HEX 发送');

    /* --- 兼容：serial rxd 老流程 asHex=true（早期字段） --- */
    const rxLegacy = await feed(['4f4b'], { asHex: true });
    eq(rxLegacy._sent && rxLegacy._sent[0] && rxLegacy._sent[0].payload, '4f4b', 'serial rxd 老字段 asHex=true 仍按 HEX 输出');

    /* --- 非法 HEX 必须报错，而不是把字面量发出去 --- */
    bridgeState.sends.length = 0;
    let err = null;
    const txBad = makeNode('serial txd', { monitor: 'main', format: 'hex' });
    txBad._handlers.input({ payload: '4G' }, null, function (e) { err = e; });
    await sleep(60);
    check(!!err, '非法 HEX：走 done(err)');
    eq(bridgeState.sends.length, 0, '非法 HEX：一个字节都不发');

    server.close();
    console.log('\n' + checks + ' checks, ' + failures + ' failed');
    process.exit(failures ? 1 : 0);
}

main().catch(function (e) {
    console.error(e);
    process.exit(1);
});
