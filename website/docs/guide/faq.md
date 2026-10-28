# 常见问题

## 安装包为什么没有签名？

这是个人项目，没有购买 OV / EV 代码签名证书。未签名的程序在 Windows 上会触发 SmartScreen「未知发布者」提示，这是系统的默认行为，并不代表程序有问题。

可以这样验证安装包：

- 只从 [GitHub Releases](https://github.com/SeaHi-Mo/Seahi-Serial/releases/latest) 下载。
- 用发布页的 `SHA256SUMS.txt` 核对文件哈希。
- CI 使用 cosign keyless 签名生成 `.sigstore.json`，可以验证产物由本仓库构建。

完整步骤见 [代码签名与安装说明](https://github.com/SeaHi-Mo/Seahi-Serial/blob/main/doc/SIGNING.md)。

## 支持 macOS 或 Linux 吗？

不支持，短期也没有计划。串口枚举使用 Win32 SetupAPI，窗口、WSL 和 ADB 的许多行为也依赖 Windows。

## 配置文件在哪里？

```
%APPDATA%\seahi-serial\
├── config.json          # 界面和串口配置
├── window.json          # 窗口位置与尺寸
├── ai-config.json       # MCP 设置（开关、端口、token）
├── ai-calls.jsonl       # AI 工具调用记录
└── log-cache\           # 会话日志缓存，最多 10 个
```

MCP 的配置和调用记录单独存放，`config.json` 里不会包含 AI 相关数据。

## 关闭程序后窗口位置和大小会丢失吗？

不会。位置和尺寸保存在 `window.json`，位置记录外框坐标，尺寸记录内容区大小。窗口最小化或最大化时不会覆盖正常状态的几何信息。从旧版本升级时，会从 `config.json` 迁移一次尺寸。

## 设备已插入，端口列表里却没有

按顺序检查：

1. 设备管理器里有没有对应的 COM 口。没有的话是驱动问题。
2. 端口是否被其他程序占用。一个串口只能被一个程序打开。
3. 换一根数据线。有些线只能供电，不能传输数据。

蓝牙设备的问题通常不同：设备不广播时不会出现在扫描列表里，可以使用「按 MAC 直连」，见[蓝牙调试](/guide/ble)。

## AI 客户端看不到新工具，或提示连不上

看不到新工具：工具定义编译在 exe 里，升级程序后需要让客户端重新连接，才会重新读取 `tools/list`。也可以先确认客户端启动的是新版本。

提示连不上：确认程序正在运行、MCP 服务器已启用。`/healthz` 是唯一不需要鉴权的端点，可以先访问它确认端口是否可用。

传输方式选错也是常见原因。新客户端使用 Streamable HTTP（`POST /mcp`），老客户端使用遗留 SSE。MCP 弹窗里可以切换「仅 HTTP」「仅 SSE」或「两者」，选择单档时另一条端点会返回 404。

更多说明见 [MCP 接入](/mcp/)。

## 如何反馈问题？

到 [GitHub Issues](https://github.com/SeaHi-Mo/Seahi-Serial/issues) 提交。请附上版本号、Windows 版本、复现步骤和相关日志片段。

MCP 弹窗里的连接地址包含访问令牌，贴出之前请删除令牌。
