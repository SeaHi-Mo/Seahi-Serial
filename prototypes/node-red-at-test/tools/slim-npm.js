/**
 * 把 node_modules/npm 换成约 100 字节的桩。
 *
 * 依据（@node-red/registry/lib/externalModules.js:17-19）：
 *     const npmPackageJson = require.resolve('npm/package.json')
 *     const npmRoot = path.dirname(npmPackageJson);
 *     const npmCli = path.join(npmRoot, 'bin', 'npm-cli.js');
 *
 * Node-RED 只在「安装调色板节点」时执行 npmCli；当 settings.js 里
 * externalModules.palette.allowInstall=false 时，checkPrereq() 提前返回，
 * npmCli 永远不会被执行。所以真正被用到的只有 **这两个路径存在**。
 *
 * 实测（node-red 5.0.10 / Node 22）：替换后正常启动，
 * GET / 与 GET /nodes 均 200。省下 11.7 MB。
 *
 * 注意：这是对 Node-RED 内部实现的依赖，升级 Node-RED 后要重新验证；
 * 一旦失效，表现为启动时 "Cannot find module 'npm/package.json'"，很容易发现。
 *
 * 用法：
 *     node tools/slim-npm.js            # 只报告
 *     node tools/slim-npm.js --apply    # 真替换
 *     npm install --ignore-scripts node-red   # 恢复原样
 */
const fs = require("fs");
const path = require("path");

const nm = path.join(__dirname, "..", "node_modules");
const npmDir = path.join(nm, "npm");
const apply = process.argv.includes("--apply");

function dirSize(p) {
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    if (e.isDirectory()) total += dirSize(f);
    else if (e.isFile()) total += fs.statSync(f).size;
  }
  return total;
}

if (!fs.existsSync(npmDir)) {
  console.log("node_modules/npm 不存在，先装依赖");
  process.exit(1);
}

const before = dirSize(npmDir);
console.log(`当前 node_modules/npm: ${(before / 1048576).toFixed(1)} MB`);

if (!apply) {
  console.log("加上 --apply 才会替换");
  process.exit(0);
}

fs.rmSync(npmDir, { recursive: true, force: true });
fs.mkdirSync(path.join(npmDir, "bin"), { recursive: true });
fs.writeFileSync(
  path.join(npmDir, "package.json"),
  JSON.stringify({ name: "npm", version: "10.9.8", bin: { npm: "bin/npm-cli.js" } })
);
fs.writeFileSync(path.join(npmDir, "bin", "npm-cli.js"), "");

const after = dirSize(npmDir);
console.log(`替换后: ${after} 字节（省 ${((before - after) / 1048576).toFixed(1)} MB）`);
console.log("跑一次 node-red，确认 GET /nodes 返回 200 即成功。");
