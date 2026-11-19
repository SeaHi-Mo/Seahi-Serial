/**
 * 离线固化运行的 settings.js
 *
 * 三条关键设置：
 *   1. externalModules.palette.allowInstall=false
 *      → @node-red/registry/lib/installer.js 的 checkPrereq() 会在这里直接 return，
 *        **根本不 spawn npm**，所以 node_modules 里的 npm 包可以删掉（省 11.7MB），
 *        也不会因为机器上没有 npm 而启动失败。
 *   2. telemetry.enabled=false + updateNotification=false
 *      → 关掉匿名统计与"有新版本"检查（后者会访问 npm registry），做到全程不出网。
 *   3. credentialSecret=false
 *      → 不加密凭据文件，避免每次启动生成随机密钥导致 flows 凭据读不出来。
 */
module.exports = {
  uiPort: 1880,
  flowFile: "flows.json",
  credentialSecret: false,

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
