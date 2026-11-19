/**
 * 离线固化运行的 settings.js（随安装包分发）
 *
 * 三条关键设置，都是源码级验证过的：
 *   1. externalModules.palette.allowInstall=false
 *      → @node-red/registry/lib/installer.js 的 checkPrereq() 在这里直接 return，
 *        **根本不 spawn npm**。所以 node_modules 里的 npm 包可以换成百字节桩
 *        （scripts/prepare-nodered.mjs --slim），也不会因为机器上没有 npm 而启动失败。
 *   2. telemetry.enabled=false + updateNotification=false
 *      → 关掉匿名统计与"有新版本"检查（后者会访问 npm registry），运行期不出网。
 *   3. credentialSecret=false
 *      → 不加密凭据文件，避免换机器/重装后 flows 凭据读不出来。
 *
 *  ⚠️ 本程序自带的 at-suite 节点**不在这里配**：Node-RED 启动时只扫 coreNodesDir 与
 *     `<userDir>/nodes`，而 `nodesDir` 只用于模块查找、不参与调色板加载（实测无效）。
 *     节点文件由 Rust 侧在启动前复制到 `%APPDATA%\...\node-red\nodes\`（见 main.rs 的
 *     nodered_install_local_nodes）。
 */
module.exports = {
  uiPort: 1880,
  flowFile: "flows.json",
  credentialSecret: false,

  /** 只监听回环地址。
   *
   *  ⚠️ 不设这一项，Node-RED 会绑 **所有网卡**（0.0.0.0 / ::），于是：
   *    ① Windows 防火墙每次都弹「是否允许 node.exe 通过防火墙」；
   *    ② 同一局域网里的其它机器可以直接打开这个编辑器 —— 而我们没有配 adminAuth，
   *       等于把「可执行任意 function 代码」的面板暴露在网上。
   *  绑 127.0.0.1 后两个问题一起消失：防火墙不管回环流量，外部也连不进来。 */
  uiHost: "127.0.0.1",

  /** 界面语言：Node-RED 自带 zh-CN 翻译（默认是 en-US）。
   *  编辑器里还能随时用「用户设置 → 语言」覆盖，这里只是给个合理的默认。 */
  lang: "zh-CN",

  /** 关掉不需要的核心节点分类（**官方机制**）。
   *
   *  见 @node-red/registry/lib/localfilesystem.js 的 isExcluded()：
   *  按**文件名**过滤，`getLocalFile()` 在加载前就把它跳掉；
   *  而且同一文件名的 `.html`（编辑器里那份节点定义）也会一起跳过 —— 见 `file.replace(/\.[cm]?js$/,".html")`。
   *  所以调色板里连分类都不会出现，不是"藏起来"，是根本没注册。
   *
   *  网络：tls / httpproxy / mqtt / http in / http request / websocket / tcp in / udp
   *  存储：file in、file out、watch
   *
   *  ⚠️ 是按 basename 全局匹配：以后要是引入了同名文件的节点包，会被一起挡掉。
   */
  nodesExcludes: [
    "05-tls.js",
    "06-httpproxy.js",
    "10-mqtt.js",
    "21-httpin.js",
    "21-httprequest.js",
    "22-websocket.js",
    "31-tcpin.js",
    "32-udp.js",
    "10-file.js",
    "23-watch.js"
  ],

  externalModules: {
    autoInstall: false,
    autoInstallRetry: 0,
    palette: {
      allowInstall: false,
      allowUpload: false,
      allowList: []
    }
  },

  telemetry: {
    enabled: false,
    updateNotification: false
  },

  editorTheme: {
    tours: false,
    projects: { enabled: false }
  },

  logging: {
    console: { level: "info", metrics: false, audit: false }
  }
};
