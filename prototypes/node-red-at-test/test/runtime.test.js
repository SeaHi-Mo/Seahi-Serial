const test = require("node:test");
const assert = require("node:assert");

// ---------- 假串口：写入即按脚本回话，不需要真硬件 ----------
let SCRIPT = [];
const PORTS = [];

class FakePort {
  constructor(opts) {
    this.opts = opts;
    this.isOpen = false;
    this.written = [];
    this._data = [];
    PORTS.push(this);
  }
  open(cb) { this.isOpen = true; setImmediate(cb); }
  close(cb) { this.isOpen = false; if (cb) cb(); }
  on(ev, fn) { if (ev === "data") this._data.push(fn); }
  removeListener(ev, fn) { this._data = this._data.filter((f) => f !== fn); }
  write(str) {
    this.written.push(str);
    const reply = SCRIPT.shift();
    if (reply === undefined) return;
    setTimeout(() => {
      this._data.slice().forEach((fn) => fn(Buffer.from(reply, "utf8")));
    }, 5);
  }
}

// 把 at-suite.js 里的 require("serialport") 换成假实现
const Module = require("node:module");
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "serialport") return { SerialPort: FakePort };
  return origLoad.apply(this, arguments);
};

// ---------- 假 RED ----------
function makeRED() {
  let Ctor = null;
  return {
    getCtor: () => Ctor,
    RED: {
      nodes: {
        registerType(name, c) { Ctor = c; },
        createNode(node, config) {
          node._sent = [];
          node._handlers = {};
          node.on = function (ev, fn) { (node._handlers[ev] = node._handlers[ev] || []).push(fn); };
          node.send = function (m) { node._sent.push(m); };
          node.status = function (s) { node._status = s; };
          node.warn = function () {};
          node.error = function () {};
          node.config = config;
        }
      }
    }
  };
}

require("../at-suite.js")((function () { const r = makeRED(); globalThis.__RED = r; return r.RED; })());
const Ctor = globalThis.__RED.getCtor();

function run(config, msg) {
  return new Promise((resolve, reject) => {
    const node = new Ctor(config);
    // 第二参数传 undefined，让节点走自己的 node.send 回落分支（与 Node-RED 一致）
    node._handlers.input[0](msg || { payload: 1 }, undefined, (err) => {
      if (err) reject(err); else resolve(node);
    });
  });
}

test.beforeEach(() => { SCRIPT = []; PORTS.length = 0; });

test("三步全通过：结果、回话、行尾都对", async () => {
  SCRIPT = ["AT\r\r\nOK\r\n", "AT+GMR\r\r\n+GMR: 1.2.3\r\nOK\r\n"];
  const node = await run({
    port: "COM9", baud: "115200", eol: "crlf", verbose: false,
    steps: [
      { on: true, cmd: "AT", expect: "OK", mode: "contains", timeout: 1000, fail: "abort" },
      { on: true, cmd: "AT+GMR", expect: "\\+GMR:", mode: "regex", timeout: 1000, fail: "abort" }
    ]
  });
  const out = node._sent[0];
  const sum = out[0].payload;

  assert.equal(sum.pass, true);
  assert.equal(sum.total, 2);
  assert.equal(sum.failed, 0);
  assert.equal(sum.results[1].ok, true);
  assert.match(sum.results[1].reply, /\+GMR: 1\.2\.3/);
  assert.deepEqual(PORTS[0].written, ["AT\r\n", "AT+GMR\r\n"]);
  assert.match(out[0].report, /<table/);
  assert.equal(out[1].payload.length, 0); // 失败明细为空
});

test("中止：第二条超时后，第三条标跳过且不发送", async () => {
  SCRIPT = ["\r\nOK\r\n"]; // 第二条没有回话 → 超时
  const node = await run({
    port: "COM9", baud: "115200", eol: "crlf", verbose: false,
    steps: [
      { on: true, cmd: "AT", expect: "OK", mode: "contains", timeout: 300, fail: "abort" },
      { on: true, cmd: "AT+NOREPLY", expect: "OK", mode: "contains", timeout: 200, fail: "abort" },
      { on: true, cmd: "AT+LATER", expect: "OK", mode: "contains", timeout: 200, fail: "abort" }
    ]
  });
  const sum = node._sent[0][0].payload;

  assert.equal(sum.pass, false);
  assert.equal(sum.failed, 1);
  assert.equal(sum.results[1].reason, "timeout");
  assert.equal(sum.results[2].skipped, true);
  assert.deepEqual(PORTS[0].written, ["AT\r\n", "AT+NOREPLY\r\n"]); // 第三条没发
});

test("重试：第一次 ERROR，第二次 OK，attempts=2", async () => {
  SCRIPT = ["\r\nERROR\r\n", "\r\nOK\r\n"];
  const node = await run({
    port: "COM9", baud: "115200", eol: "crlf", verbose: false,
    steps: [
      { on: true, cmd: "AT+UART?", expect: "OK", mode: "contains", timeout: 500, fail: "retry", retry: 3 }
    ]
  });
  const sum = node._sent[0][0].payload;

  assert.equal(sum.pass, true);
  assert.equal(sum.results[0].attempts, 2);
  assert.deepEqual(PORTS[0].written, ["AT+UART?\r\n", "AT+UART?\r\n"]);
});

test("继续：失败不中止，后面的照跑", async () => {
  SCRIPT = ["\r\nERROR\r\n", "\r\nOK\r\n"];
  const node = await run({
    port: "COM9", baud: "115200", eol: "crlf", verbose: false,
    steps: [
      { on: true, cmd: "AT+MAYBE", expect: "OK", mode: "contains", timeout: 300, fail: "continue" },
      { on: true, cmd: "AT", expect: "OK", mode: "contains", timeout: 300, fail: "abort" }
    ]
  });
  const sum = node._sent[0][0].payload;

  assert.equal(sum.pass, false);
  assert.equal(sum.results[0].ok, false);
  assert.equal(sum.results[1].ok, true);
  assert.equal(PORTS[0].written.length, 2);
});

test("未勾选的条目不执行", async () => {
  SCRIPT = ["\r\nOK\r\n"];
  const node = await run({
    port: "COM9", baud: "115200", eol: "crlf", verbose: false,
    steps: [
      { on: true, cmd: "AT", expect: "OK", mode: "contains", timeout: 300 },
      { on: false, cmd: "AT+SKIP", expect: "OK", mode: "contains", timeout: 300 }
    ]
  });
  assert.deepEqual(PORTS[0].written, ["AT\r\n"]);
});

test("逐条输出：verbose 时先逐条发，最后一条是汇总", async () => {
  SCRIPT = ["\r\nOK\r\n"];
  const node = await run({
    port: "COM9", baud: "115200", eol: "crlf", verbose: true,
    steps: [{ on: true, cmd: "AT", expect: "OK", mode: "contains", timeout: 300 }]
  });

  const flat = node._sent.flat();
  const partial = flat.find((m) => m.done === false);
  const summary = flat.find((m) => m.payload && m.payload.pass !== undefined);
  assert.ok(partial, "应该有逐条消息");
  assert.equal(partial.index, 1);
  assert.ok(summary, "应该有汇总消息");
});
