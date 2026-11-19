// 一次性检查：at-suite.html 里的编辑器脚本能否通过语法检查，模板名与注册名是否一致
// 用 vm 在本进程编译（沙箱里 spawn 子进程会 EPERM）
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "at-suite.html"), "utf8");

const blocks = [...src.matchAll(/<script type="text\/javascript">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
console.log("javascript blocks:", blocks.length);

const checks = {
  'data-template-name="at-suite"': /data-template-name="at-suite"/.test(src),
  'data-help-name="at-suite"': /data-help-name="at-suite"/.test(src),
  'registerType("at-suite")': /registerType\("at-suite"/.test(src)
};
let fail = false;
for (const [k, v] of Object.entries(checks)) {
  if (!v) fail = true;
  console.log((v ? "ok   " : "FAIL ") + k);
}

blocks.forEach((code, i) => {
  try {
    new vm.Script(code, { filename: "at-suite-block" + i + ".js" });
    console.log("ok   block " + i + " syntax");
  } catch (e) {
    fail = true;
    console.log("FAIL block " + i + " syntax: " + e.message);
  }
});

process.exitCode = fail ? 1 : 0;
