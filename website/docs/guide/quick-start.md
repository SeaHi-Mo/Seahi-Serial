# 快速开始

## 环境要求

| 项 | 说明 |
|---|---|
| 系统 | **Windows 10 / 11**（本工具只支持 Windows） |
| WebView2 | Win10/11 通常已预装；缺失时安装程序会引导 |
| 串口驱动 | USB 转串口（CH340 / CP210x / FTDI…）需已装好驱动，设备管理器里能看到 COM 口 |

## 安装

1. 打开 [Releases](https://github.com/SeaHi-Mo/Seahi-Serial/releases/latest)，下载 `.msi` 或 `Seahi-Serial-Setup-*.exe`。
2. 安装包**没有代码签名**，SmartScreen 会拦一下：点「更多信息」→「仍要运行」。
3. 安装完成后从开始菜单启动。

::: tip 校验安装包
发布页附带 `SHA256SUMS.txt` 与 cosign 的 `.sigstore.json`。核对方法与「为什么没有签名」的说明见
[代码签名与安装说明](https://github.com/SeaHi-Mo/Seahi-Serial/blob/main/doc/SIGNING.md)。
:::

## 连上第一个串口

1. 插入设备。
2. 工具栏 **端口** 下拉框里选中目标 COM 口（插拔会自动刷新）。
3. **波特率** 默认 `115200`；不对就手输，其它档位也支持自定义输入。
4. 点 **▶ 开始监控**。连接成功后按钮变成「停止监控」，输出区开始滚动。

> 要改数据位 / 停止位 / 校验位、或拨 DTR / RTS，点工具栏的齿轮展开高级设置。

## 发一条，看它回什么

在底部输入框键入内容，按 `Enter` 或点发送：

- 默认文本模式；切到 HEX 后按十六进制字节发送。
- **行尾**（`\r`、`\n`、`\r\n`）在工具栏选，发 AT 指令一般用 `\r\n` 或 `\r`。
- 发送历史每栏记最近 50 条，按 `↑` / `↓` 翻。

如果设备没反应，先确认三件事：波特率对不对、行尾加没加、**本机没被别的串口工具占着这个 COM 口**（同一个口不能被两个程序同时打开）。

## 关掉也不会丢日志

每次打开串口后只要有收发，程序会自动把本次会话缓存到磁盘（最多保留最近 10 个）：

```
%APPDATA%\seahi-serial\log-cache\session-<时间戳>-<端口>.log
```

需要正式存档时用「保存日志」走系统文件对话框另存。

## 下一步

- [串口调试](/guide/serial)：分栏、行尾、DTR/RTS、日志
- [终端模式](/guide/terminal)：把输出区变成真终端
- [快速指令](/guide/quick-cmds)：一组一组地自动发
- [蓝牙调试](/guide/ble) / [ADB 与 WSL](/guide/adb-wsl)
