/**
 * 准备随安装包分发的 Node-RED 运行时。
 *
 *   node scripts/prepare-nodered.mjs             # 装依赖 + 拷 node.exe
 *   node scripts/prepare-nodered.mjs --slim      # 额外把 npm 换成百字节桩（省 11.7MB）
 *   node scripts/prepare-nodered.mjs --clean     # 删掉 node_modules/node.exe 重来
 *
 * 产出目录 src-tauri/resources/node-red/ 会被 tauri.conf.json 的 bundle.resources 一起打包：
 *     node.exe        ← 从当前 Node 复制（固定版本：用哪个 Node 跑这个脚本，就打哪个版本）
 *     settings.js     ← 仓库里的离线固化配置
 *     package.json
 *     at-suite/       ← 从 prototypes/node-red-at-test 复制（节点包的唯一真源还在那儿）
 *     node_modules/   ← npm install 产物
 *
 * ⚠️ 只跑 `npm install --omit=dev`，不要 `--ignore-scripts` 之外的花活：
 *    node-red 是纯 JS，没有需要本地编译的原生依赖；serialport 之类的原生模块**不在**这棵树里
 *    （串口收发达成本程序 Rust 侧负责，画布只做流程编排）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const resDir = path.join(root, "src-tauri", "resources", "node-red");
const protoDir = path.join(root, "prototypes", "node-red-at-test");
const slim = process.argv.includes("--slim");
const clean = process.argv.includes("--clean");

function log(m) { console.log("[nodered] " + m); }
function sizeOf(p) {
  let n = 0, files = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) { n += fs.statSync(f).size; files++; }
    }
  };
  walk(p);
  return { mb: (n / 1048576).toFixed(1), files };
}

if (clean) {
  for (const t of ["node_modules", "node.exe", "at-suite", "package-lock.json"]) {
    fs.rmSync(path.join(resDir, t), { recursive: true, force: true });
  }
  log("已清理");
}

// 1) 节点包：从原型目录复制（唯一真源在那边，别在这儿复制一份改）
const atSrc = path.join(protoDir, "at-suite.js");
const atHtml = path.join(protoDir, "at-suite.html");
if (!fs.existsSync(atSrc)) {
  console.error("[nodered] 找不到 " + atSrc + "（节点包原型缺失）");
  process.exit(1);
}
const atDir = path.join(resDir, "local-nodes");
fs.mkdirSync(atDir, { recursive: true });
for (const f of ["at-suite.js", "at-suite.html"]) {
  fs.copyFileSync(path.join(protoDir, f), path.join(atDir, f));
}
fs.writeFileSync(
  path.join(atDir, "package.json"),
  JSON.stringify(
    {
      name: "node-red-contrib-at-test",
      version: "0.1.0",
      description: "AT 指令序列测试节点：填表即用，画布编排",
      keywords: ["node-red", "at-command", "serial", "test"],
      license: "MIT",
      "node-red": { nodes: { "at-suite": "at-suite.js" } }
    },
    null,
    2
  )
);
log("节点包已复制 → resources/node-red/local-nodes/");

// 2) 依赖
//
// ⚠️ 不要直接 execFile("npm.cmd")：Node 18.20 / 20.12 起（CVE-2024-27980）在 Windows 上
//    **禁止不经 shell 执行 .cmd**，会直接抛 `spawn EINVAL` —— 表现就是"at-suite 建好了，
//    然后什么都没有"，因为后面的步骤一个都没跑。
//    正确做法是拿 npm 自己的 cli.js 用当前 node 跑；拿不到才退回 shell:true。
log("npm install（首次约 20–40 秒，会下载 ~300 个包）…");
const npmArgs = ["install", "--omit=dev", "--no-audit", "--no-fund"];
const npmCli = process.env.npm_execpath;
try {
  if (npmCli && /npm-cli\.js$/i.test(npmCli) && fs.existsSync(npmCli)) {
    execFileSync(process.execPath, [npmCli].concat(npmArgs), { cwd: resDir, stdio: "inherit" });
  } else {
    execFileSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      npmArgs,
      { cwd: resDir, stdio: "inherit", shell: process.platform === "win32" }
    );
  }
} catch (e) {
  console.error("[nodered] npm install 失败：" + (e && e.message ? e.message : e));
  console.error("[nodered] 常见原因：没有网络 / 公司代理拦了 registry / Node 版本过旧");
  console.error("[nodered] 手工排查：cd src-tauri\\resources\\node-red && npm install --omit=dev");
  process.exit(1);
}

// 3) 裁掉不需要的核心节点分类
//
// ⚠️ Node-RED 5.x 的 @node-red/nodes **没有** `node-red` 清单段（老版本才有），
//    核心节点是 registry 扫 `settings.coreNodesDir` 这个**目录**加载的
//    （见 @node-red/registry/lib/localfilesystem.js 的 getLocalNodeFiles）。
//    所以要删的是目录本身，不是改 package.json。
//
// 默认删 core/network（mqtt / http / tcp / udp / websocket）与 core/storage（file in/out）。
// 想全留：--keep-all。还原：重跑 `npm install` 再跑一次本脚本。
if (!process.argv.includes("--keep-all")) {
  const coreDir = path.join(resDir, "node_modules", "@node-red", "nodes", "core");
  if (fs.existsSync(coreDir)) {
    let n = 0;
    for (const cat of ["network", "storage"]) {
      const target = path.join(coreDir, cat);
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
        n++;
        log(`已删除核心分类：core/${cat}/`);
      }
    }
    if (!n) log("网络 / 存储分类已经不在了（重复执行是安全的）");
    const left = fs.readdirSync(coreDir).filter((x) => fs.statSync(path.join(coreDir, x)).isDirectory());
    log("保留的核心分类：" + left.join(", "));
  } else {
    log("没找到 @node-red/nodes/core，跳过裁剪");
  }
} else {
  log("--keep-all：保留全部核心节点");
}

// 4) node.exe
const nodeExe = path.join(resDir, "node.exe");
fs.copyFileSync(process.execPath, nodeExe);
log("node.exe ← " + process.execPath + "（" + process.version + "）");

// 5) npm 桩（可选）
if (slim) {
  const npmDir = path.join(resDir, "node_modules", "npm");
  if (fs.existsSync(npmDir)) {
    fs.rmSync(npmDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(npmDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(npmDir, "package.json"),
      JSON.stringify({ name: "npm", version: "10.9.8", bin: { npm: "bin/npm-cli.js" } }));
    fs.writeFileSync(path.join(npmDir, "bin", "npm-cli.js"), "");
    log("npm 已替换为桩（allowInstall=false 时不会被执行）");
  }
}

// 6) 报告
const total = sizeOf(resDir);
log(`完成：${total.mb} MB / ${total.files} 个文件`);
const nm = path.join(resDir, "node_modules");
if (fs.existsSync(nm)) {
  const s = sizeOf(nm);
  log(`  其中 node_modules ${s.mb} MB / ${s.files} 个文件`);
}
log("提醒：安装包会因此增大 ~45 MB（压缩后），这是内嵌 Node-RED 的固定成本。");
