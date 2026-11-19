# node-red-at-test（原型）

在 Node-RED 画布上编排 AT 指令测试：画布负责「什么时候跑、跑完往哪分流」，
指令本身在节点对话框里填表。

## 跑起来

```bash
cd prototypes/node-red-at-test

# 1) 原生串口模块必须与包本体在一起
#    （Node-RED 用 junction 加载本包，require 按真实路径解析，找不到 data/node_modules 里的）
npm install

# 2) userDir：装 node-red + 本包（file:.. 会建 junction）
cd data
npm install

# 3) 启动
npx node-red -u . -s ../flows.json --port 1880
```

打开 <http://localhost:1880>，左侧面板的「AT 测试」分类里就是 `at-suite` 节点。
`flows.json` 里已带一条示例流（手动触发 → 冒烟三条 → 按结果分流），把节点里的
`COM5` 改成你实际的口，点「部署」再点注入。

> 本仓库的沙箱里 `npm install serialport` 与 `node-red` 启动都会失败：
> 前者是 `@serialport/bindings-cpp` 的 install 脚本被拦（可用 `--ignore-scripts` 绕过，
> 但那样没有原生绑定），后者是 Node-RED 启动时 `execFile("npm", ["--version"])` 报
> `spawn EPERM`。以上两步都需在宿主环境执行。

## 一个节点 = 一串线性指令

这是这个原型的核心取舍，也是「画布 vs 表格」的分界：

- **画布**表达控制结构：手动 / 定时 / 外部事件触发，按 `payload.pass` 分流，多套件串行，
  失败后重跑整组，结果写文件或喂给 Dashboard。
- **节点对话框**表达线性序列：一条指令一行，勾选、排序、设期望。

不要把一个套件的 40 条指令画成 40 个节点——画布会变成一条改不动也看不全的长链。

## 指令表字段

| 列 | 含义 |
|---|---|
| ☑ | 取消勾选的条目不执行（也可以由上游 `msg.steps` 整个覆盖） |
| 名称 | 只用于报告，可空 |
| 指令 | 原样发出，行尾由节点级「行尾」决定（CRLF / CR / LF / 不加） |
| 期望 | 留空 = 只等「超时」那么久，不判定 |
| 匹配 | 包含（忽略大小写）/ 正则（原样，多行模式）/ 不出现 |
| 超时 | 这条等多久，毫秒 |
| 失败 | 中止（默认）/ 重试 / 继续 |
| 重试 | 仅「失败=重试」时生效，总尝试次数 |

## 输出

- 输出 1：汇总 `{ pass, total, ran, failed, elapsedMs, results[] }`；
  勾了「逐条输出」时，每跑完一条先发一条 `{index, total, done:false, payload:结果}`，最后一条才是汇总。
- 输出 2：失败明细（数组）。
- 附带 `msg.report`：一份 HTML 表格，可直接喂 `ui_template` 或写进文件。

## 离线固化运行

[data/settings.js](data/settings.js) 把 Node-RED 锁成离线模式，三条都是源码级验证过的：

- `externalModules.palette.allowInstall = false` → `@node-red/registry/lib/installer.js` 的
  `checkPrereq()` 在开头就 `return`，**根本不 spawn npm**。所以 `node_modules/npm` 可以整个删掉
  （省 11.7 MB），机器上没装 npm 也不会启动失败。
- `telemetry.enabled = false` + `telemetry.updateNotification = false` → 关掉匿名统计与版本检查，
  运行期不出网。
- `credentialSecret = false` → 凭据不加密，避免换机器/重装后 flows 凭据读不出来。

启动时直接用随包的 node.exe，**不要走 `npx`**（npx 发现本地没装会联网下载）：

```bat
"<随包目录>\node.exe" node_modules\node-red\red.js ^
  -u "%APPDATA%\seahi-at" -s settings.js --port 1880
```

`-u` 必须指向用户可写目录（`%APPDATA%`），不能是 Program Files —— Node-RED 要在里面写
`flows.json`、`.config.runtime.json`、`.sessions.json`。

版本锁定靠提交进仓库的 `package-lock.json` + `npm ci`；`node-red` 与 `node.exe` 都钉死，
升级是手工动作，不会自己漂移。

## 已知边界

- 只支持串口。TCP / BLE 要么加节点，要么在这个节点里按 `msg.transport` 分支。
- 一次运行占一个串口；同一口有两个套件同时跑会互相抢。要串行就在画布上串起来。
- 没有断点/单步；停下来只能靠拔线或注入一条让流程提前结束。
- `serialport` 是原生模块，换 Node 大版本要重装。

## 打包体积（实测）

Node-RED 没有"工程"要打——它就是一坨 npm 包 + 一个入口 `red.js`。但也不能只打"你自己的包"：
你的包只是调色板上的一个节点，编辑器和运行时是 Node-RED 自己的。

| 组成 | 实测 | 能否裁 |
|---|---|---|
| `node.exe` | 82.9 MB | 不能（除非换运行时） |
| `@node-red/editor-client` | 32.2 MB | 整包不能删；内部 Monaco 16.1（Function 节点编辑器）、`red` 5.4、mermaid 3.4、ace 2.3、types 2.2 |
| `@node-red/{nodes,runtime,util,editor-api,registry}` | 5.0 MB | 不能 |
| 246 个第三方包 | ~36 MB | 按需，别乱删 |
| `npm` | 11.7 MB | **可换成 ~100 字节的桩**，见 [tools/slim-npm.js](tools/slim-npm.js)（实测启动正常） |
| `*.map` | 7.7 MB | 可删（实测启动正常） |
| `@types` | 2.5 MB | 可删（实测启动正常） |

裁剪后 `node_modules` ≈ 71 MB；加 `node.exe` 后安装占盘 ≈ 154 MB，`setup.exe` ≈ 45 MB。

`npm` 那条要特别说明：`@node-red/registry/lib/externalModules.js:17` 在模块加载时就
`require.resolve("npm/package.json")`，所以**直接删 npm 会让启动崩掉**（`Cannot find module`）。
但 `allowInstall=false` 时它算出来的 `npmCli` 路径永远不会被执行，所以换成只有
`package.json` + 空 `bin/npm-cli.js` 的桩就够了——这是对 Node-RED 内部实现的依赖，
升级后要重新验证，失效时表现很明确（启动即报错）。

## 测试

```bash
node test/judge.test.js      # 判定逻辑（纯函数）
node test/runtime.test.js    # 用假串口跑完整流程：通过/超时中止/重试/继续/未勾选
```

（`node --test` 在本机沙箱里会因 spawn 受限失败，直接执行文件即可。）
