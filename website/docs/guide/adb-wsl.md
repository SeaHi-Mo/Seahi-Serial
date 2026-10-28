# ADB 与 WSL

两个面板，一个目的：让「不在本机 COM 口上的设备」也能像串口一样调。

## ADB 调试

顶栏切到 **ADB 调试**：

1. 点刷新拉设备列表。状态为 `device` 的才能用；显示 `unauthorized` 表示设备上还没点「允许 USB 调试」。
2. 选中设备 → 打开终端（同一套 xterm 画布）。
3. 直接敲命令、看 PTY 输出；可以改终端尺寸、关闭会话。

安装包里自带 `platform-tools`。它有个坑：**adb 服务器是常驻后台进程**，会把 `platform-tools` 下的 exe / dll 映射住，导致升级安装时文件覆写失败。安装器会在安装/卸载前**只停掉镜像路径位于本应用目录下的 adb**，不误伤 Android Studio 等其它来源的 adb。

## WSL 端口映射

顶栏 **WSL 端口映射**，把 USB 串口映射进 WSL：

- 依赖 [usbipd-win](https://github.com/dorssel/usbipd-win)，安装/绑定需要**管理员权限**（安装包里带了 usbipd-win）。
- 支持自动映射与手动绑定，绑定过程中会弹授权窗口，需要你在系统弹框上确认。
- 映射完成后，WSL 里能看到新增的 `/dev/ttyUSB*` 或 `/dev/ttyACM*`。

## 在 WSL 里直接调试

WSL 分栏可在 **WSL 内**打开串口并收发：

- 背后走一个 Python bridge（持久化 shell，避免每次 fork 的延迟）。
- 分栏里的「启动」用 Windows Terminal 打开对应发行版；发行版名只认真实列表，解析不出来时会把 WSL 的报错原文显示出来，而不是拿一个假名字去启动（那会静默打开 PowerShell）。
- 读轮询连续失败会判定掉线（界面变「等待接入」），循环发送会跟着自愈停止。

::: tip 没装 `sg` 或者不在 dialout 组？
bridge 只有在能**非交互**切组时才用 `sg`，否则直接跑 `python3`。没有 `sg` 的发行版不会因此起不来；不在 `dialout` 组里时也不会卡在密码提示上——这种情况需要你把用户加进组（或让 `usbipd` 认到设备）。
:::
