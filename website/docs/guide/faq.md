# 常见问题

## 安装包为什么没有签名？SmartScreen 为什么报「未知发布者」？

个人项目，没有商业代码签名证书（OV / EV 证书对本项目成本过高）。未签名程序在 Windows 上必然触发 SmartScreen，这是既定事实，**不代表程序有问题**，也没有任何「已签名 / 绝对安全」的说法。

能做的是可验证：

- 只从 [GitHub Releases](https://github.com/SeaHi-Mo/Seahi-Serial/releases/latest) 下载；
- 对照发布页的 `SHA256SUMS.txt` 核对安装包；
- CI 用 cosign keyless 签名（`.sigstore.json`），能证明「产物由本仓库构建」。

完整步骤见 [代码签名与安装说明](https://github.com/SeaHi-Mo/Seahi-Serial/blob/main/doc/SIGNING.md)。

## 支持 macOS / Linux 吗？

不支持，且短期不会支持。串口枚举走的是 Win32 SetupAPI（为了正确显示中文设备名），窗口、WSL、ADB 的很多行为都绑定 Windows。

## 配置文件在哪？

```
%APPDATA%\seahi-serial\
├── config.json          # 界面/串口配置
├── window.json          # 窗口位置与尺寸
├── ai-config.json       # MCP 设置（开关、端口、token）
├── ai-calls.jsonl       # AI 工具调用记录（可在弹窗里开关）
└── log-cache\           # 会话日志缓存，最多 10 个
```

MCP 的设置与调用记录**单独存放**，`config.json` 里不会出现任何 AI 痕迹。

## 关掉程序后窗口位置/大小会丢吗？

不会。位置与尺寸由程序自己记在 `window.json`：位置存窗口外框、尺寸存内容区；最小化/最大化状态下不会覆盖你正常窗口的几何。老版本升级上来时，会从 `config.json` 里迁移一次尺寸。

## 设备明明插着，端口列表里没有

按顺序查：

1. 设备管理器里有没有该 COM 口（没有 → 驱动问题）；
2. 端口是否被别的程序占着（同一个口不能被两个进程同时打开）；
3. 换一根数据线（不少线只能供电）。

蓝牙设备则是另一套：设备不广播就搜不到，用「按 MAC 直连」，见 [蓝牙调试](/guide/ble)。

## AI 客户端里看不到新工具 / 报「连不上」

- **看不到新工具**：工具定义是编译进 exe 的，**升级程序后客户端要重连**才会重读 `tools/list`；还不行就确认跑的是新构建。
- **连不上**：确认程序正在运行、MCP 服务器已启用；`/healthz` 是唯一免鉴权端点，可先用它确认端口通。
- 传输选错是常见原因：新客户端用 Streamable HTTP（`POST /mcp`），老客户端用遗留 SSE。弹窗里可以切「仅 HTTP / 仅 SSE / 两者」，选单档时另一条端点直接 404。

详见 [MCP 接入](/mcp/)。

## 怎么反馈问题？

[GitHub Issues](https://github.com/SeaHi-Mo/Seahi-Serial/issues)。带上：版本号（设置里可见）、Windows 版本、复现步骤、相关日志片段。**不要贴 token**——MCP 弹窗里的连接地址带令牌，贴之前删掉。
