const test = require("node:test");
const assert = require("node:assert");
const { judge } = require("../at-suite.js")._test;

test("包含：忽略大小写", () => {
  assert.equal(judge("contains", "OK", "AT\r\r\nOK\r\n"), true);
  assert.equal(judge("contains", "ok", "AT\r\r\nOK\r\n"), true);
  assert.equal(judge("contains", "ERROR", "OK"), false);
});

test("包含：不误判子串", () => {
  // 设备回 "OK" 但期望 "OKAY" 时不能算通过
  assert.equal(judge("contains", "OKAY", "OK"), false);
});

test("正则：按原样解释（大小写敏感）", () => {
  assert.equal(judge("regex", "\\+GMR:\\s*\\d", "+GMR: 1.2.3"), true);
  assert.equal(judge("regex", "\\+GMR:", "AT+GMR\r\n+GMR: 1.2.3\r\nOK"), true);
  assert.equal(judge("regex", "\\+GMR:", "AT+GMR\r\nOK"), false); // 指令回显里没有冒号，不能误判
  assert.equal(judge("regex", "ok", "OK"), false);                // 正则区分大小写，包含才忽略
});

test("正则：写错不抛异常，判为不匹配", () => {
  assert.equal(judge("regex", "([", "anything"), false);
});

test("不出现：等满超时后判定", () => {
  assert.equal(judge("absent", "ERROR", "OK"), true);
  assert.equal(judge("absent", "ERROR", "something ERROR here"), false);
});

test("空期望：不判定", () => {
  assert.equal(judge("contains", "", "whatever"), false);
});
