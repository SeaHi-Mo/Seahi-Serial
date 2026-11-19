"use strict";

/**
 * at-suite —— 一个节点 = 一串线性指令。
 *
 * 设计边界：
 *   画布（Node-RED）负责        —— 触发（inject/dashboard）、按结果分流（switch）、
 *                                 多套件串行、失败重跑整组、结果落文件/上报
 *   本节点负责                  —— 逐条发、等回话、判成败、按策略重试或中止
 *
 * 为什么指令表在节点对话框里而不是画在画布上：
 *   一条链 40 个节点既画不下也不好改；画布留给「控制结构」，线性序列用表。
 */

var EOL = { crlf: "\r\n", cr: "\r", lf: "\n", none: "" };

// ---------- 纯逻辑（可单测，不依赖硬件） ----------

/**
 * @param {string} mode   contains | regex | absent
 * @param {string} expect 期望串
 * @param {string} buf    已收到的全部回话
 * @returns {boolean}
 */
function judge(mode, expect, buf) {
  if (expect === undefined || expect === null || expect === "") return false;
  var e = String(expect);
  var b = String(buf || "");
  if (mode === "regex") {
    try {
      return new RegExp(e, "m").test(b);
    } catch (_) {
      return false; // 用户写错正则：判为不匹配，不要让整个流程抛异常
    }
  }
  if (mode === "absent") {
    return b.toLowerCase().indexOf(e.toLowerCase()) === -1;
  }
  // 默认：包含，忽略大小写（AT 回话大小写不靠谱，用户也不想写 OK|ok|Ok）
  return b.toLowerCase().indexOf(e.toLowerCase()) !== -1;
}

module.exports = function (RED) {
  /**
   * 等回话。关键：Promise 构造时立刻挂 data 监听，调用方随后才 write，
   * 否则回话可能在监听挂上之前就到达，白白等到超时。
   */
  function readFor(port, step, timeout) {
    return new Promise(function (resolve) {
      var buf = "";
      var timer = null;
      var settled = false;

      function finish(ok, reason) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        port.removeListener("data", onData);
        resolve({ ok: ok, reply: buf, reason: reason });
      }

      function onData(chunk) {
        buf += chunk.toString("utf8");
        if (step.mode === "absent" || !step.expect) return;
        if (judge(step.mode, step.expect, buf)) finish(true, "match");
      }

      port.on("data", onData);

      timer = setTimeout(function () {
        if (step.mode === "absent") {
          var seen = judge("contains", step.expect, buf);
          finish(!seen, seen ? "unexpected" : "absent");
        } else if (!step.expect) {
          finish(true, "gap"); // 没写期望 = 只等这么久，不判定
        } else {
          finish(false, "timeout");
        }
      }, timeout);
    });
  }

  // ---------- 节点 ----------

  var SerialPortCtor = null;
  function getSerialPort() {
    if (!SerialPortCtor) {
      var sp = require("serialport"); // 延迟加载：只有真要开串口时才需要原生模块
      SerialPortCtor = sp.SerialPort || sp;
    }
    return SerialPortCtor;
  }

  function esc(s) {
    return String(s === undefined || s === null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function renderReport(sum) {
    var rows = sum.results.map(function (r) {
      var verdict = r.skipped ? "跳过" : (r.ok ? "通过" : "失败");
      return "<tr>" +
        "<td>" + r.index + "</td>" +
        "<td>" + esc(r.name) + "</td>" +
        "<td><code>" + esc(r.cmd) + "</code></td>" +
        "<td>" + verdict + "</td>" +
        "<td>" + esc(r.reason) + "</td>" +
        "<td>" + (r.attempts || 0) + "</td>" +
        "<td><pre style=\"margin:0;white-space:pre-wrap\">" + esc((r.reply || "").slice(-300)) + "</pre></td>" +
        "</tr>";
    }).join("");
    return "<table style=\"border-collapse:collapse;font-size:12px\">" +
      "<thead><tr><th>#</th><th>名称</th><th>指令</th><th>结果</th><th>原因</th><th>尝试</th><th>回话</th></tr></thead>" +
      "<tbody>" + rows + "</tbody></table>";
  }

  function AtSuiteNode(config) {
    RED.nodes.createNode(this, config);
    var node = this;

    node.port = config.port || "COM5";
    node.baud = parseInt(config.baud, 10) || 115200;
    node.eol = EOL.hasOwnProperty(config.eol) ? EOL[config.eol] : "\r\n";
    node.verbose = config.verbose !== false;
    node.steps = Array.isArray(config.steps) ? config.steps : [];

    async function runStep(port, step) {
      var timeout = Math.max(50, parseInt(step.timeout, 10) || 3000);
      var attempts = step.fail === "retry" ? Math.max(1, parseInt(step.retry, 10) || 3) : 1;
      var last = { ok: false, reply: "", reason: "not-run", attempts: 0 };

      for (var i = 1; i <= attempts; i++) {
        var pending = readFor(port, step, timeout); // 先挂监听
        port.write(String(step.cmd || "") + node.eol); // 再写
        last = await pending;
        last.attempts = i;
        if (last.ok) break;
      }
      return last;
    }

    node.on("input", async function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (err) { if (err) node.error(err, msg); };

      var list = (Array.isArray(msg.steps) && msg.steps.length) ? msg.steps : node.steps;
      var steps = list.filter(function (s) { return s && s.on !== false && s.cmd; });

      if (!steps.length) {
        node.warn("没有勾选任何指令");
        return done();
      }

      var portInst = null;
      var results = [];
      var t0 = Date.now();
      var hardError = null;

      try {
        var SerialPort = getSerialPort();
        portInst = new SerialPort({
          path: msg.port || node.port,
          baudRate: parseInt(msg.baud, 10) || node.baud,
          autoOpen: false
        });
        await new Promise(function (res, rej) {
          portInst.open(function (e) { return e ? rej(e) : res(); });
        });

        for (var i = 0; i < steps.length; i++) {
          var s = steps[i];
          node.status({ fill: "blue", shape: "dot", text: (i + 1) + "/" + steps.length + " " + (s.cmd || "") });

          var r = await runStep(portInst, s);
          var rec = {
            index: i + 1,
            name: s.name || s.cmd || "",
            cmd: s.cmd || "",
            expect: s.expect || "",
            ok: r.ok,
            attempts: r.attempts,
            reason: r.reason,
            reply: (r.reply || "").slice(-2000)
          };
          results.push(rec);

          if (node.verbose) {
            var partial = Object.assign({}, msg, {
              payload: rec, index: i + 1, total: steps.length, done: false
            });
            send(partial);
          }

          if (!r.ok && s.fail !== "continue") {
            for (var j = i + 1; j < steps.length; j++) {
              results.push({
                index: j + 1,
                name: steps[j].name || steps[j].cmd || "",
                cmd: steps[j].cmd || "",
                ok: false,
                skipped: true,
                reason: "前一条失败，未执行"
              });
            }
            break;
          }
        }
      } catch (err) {
        hardError = err;
      } finally {
        if (portInst && portInst.isOpen) {
          await new Promise(function (res) { portInst.close(function () { res(); }); });
        }
      }

      if (hardError) {
        node.status({ fill: "red", shape: "ring", text: "串口错误" });
        return done(hardError);
      }

      var failed = results.filter(function (r) { return !r.ok && !r.skipped; });
      var sum = {
        pass: failed.length === 0,
        total: steps.length,
        ran: results.filter(function (r) { return !r.skipped; }).length,
        failed: failed.length,
        elapsedMs: Date.now() - t0,
        results: results
      };

      var out = Object.assign({}, msg, { payload: sum, report: renderReport(sum) });
      send([out, { payload: failed, results: results }]);

      node.status({
        fill: sum.pass ? "green" : "red",
        shape: "dot",
        text: (sum.ran - sum.failed) + "/" + sum.total + (sum.pass ? " 全部通过" : " 有失败") + " · " + sum.elapsedMs + "ms"
      });
      done();
    });
  }

  RED.nodes.registerType("at-suite", AtSuiteNode);
};

// 供 node --test 使用（不经过 Node-RED、不加载 serialport）
module.exports._test = { judge: judge };
