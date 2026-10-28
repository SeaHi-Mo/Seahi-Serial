# 快速开始

SeaHi Serial 是 Windows 上的串口与蓝牙调试工具。这一页完成三件事：安装、连上第一个串口、发出第一条命令。

## 准备

需要 Windows 10 或 11。WebView2 一般随系统预装，缺失时安装程序会提示。USB 转串口设备要先装好驱动，在设备管理器里能看到对应的 COM 口。

## 安装

1. 打开 [Releases](https://github.com/SeaHi-Mo/Seahi-Serial/releases/latest)，下载 `.msi` 或 `Seahi-Serial-Setup-*.exe`。
2. 安装包没有代码签名，SmartScreen 会提示。点「更多信息」，再点「仍要运行」。
3. 安装完成后从开始菜单启动。

发布页同时提供 `SHA256SUMS.txt` 和 cosign 的 `.sigstore.json`。核对方法和签名说明见
[代码签名与安装说明](https://github.com/SeaHi-Mo/Seahi-Serial/blob/main/doc/SIGNING.md)。

## 连接第一个串口

1. 插入设备。
2. 在工具栏的「端口」下拉框选择 COM 口，插拔设备时列表会自动刷新。
3. 波特率默认 `115200`，可以在下拉框里选其它常用值，也可以直接输入。
4. 点「开始监控」。连接成功后按钮变为「停止监控」，输出区开始显示数据。

数据位、停止位、校验位和 DTR/RTS 在工具栏的齿轮里。

<GuideMedia
  src="/img/guide/serial.mp4"
  poster="/img/guide/serial.png"
  caption="连接 COM9 后发送命令，设备返回的内容直接显示在输出区。"
/>

## 发送命令

在底部输入框输入内容，按回车或点发送。文本模式下按 UTF-8 发送，切换到 HEX 后按十六进制字节发送。

行尾在工具栏选择，可选 `\r`、`\n` 或 `\r\n`。发送 AT 指令时常用 `\r\n`，具体以模组手册为准。

每个分栏会保留最近 50 条发送记录，用 `↑` 和 `↓` 翻看。

设备没有响应时，先检查波特率、行尾，以及这个 COM 口是否被其它程序占用。一个串口只能被一个程序打开。

## 日志

串口打开期间只要有收发，程序会把这次会话缓存到磁盘，最多保留最近 10 次：

```
%APPDATA%\seahi-serial\log-cache\session-<时间戳>-<端口>.log
```

需要长期保存时，用工具栏的「保存日志」选择路径另存。

## 下一步

- [串口调试](/guide/serial)：分栏、行尾、DTR/RTS、日志与工作流
- [终端模式](/guide/terminal)：把输出区变成终端
- [快速指令](/guide/quick-cmds)：按组循环发送指令
- [MCP 接入](/guide/mcp)：让 AI 客户端连接程序
- [蓝牙调试](/guide/ble)
- [ADB 与 WSL](/guide/adb-wsl)
