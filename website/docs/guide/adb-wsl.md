# ADB 与 WSL

ADB 和 WSL 两个面板用于调试不在本机 COM 口上的设备。

## ADB 调试

打开 ADB 面板后点刷新，获取设备列表。状态为 `device` 的设备可以使用；显示 `unauthorized` 时，需要在设备上允许 USB 调试。

选中设备后打开终端，操作方式和串口终端一致：直接输入命令、查看 PTY 输出，也可以调整终端尺寸或关闭会话。

安装包自带 `platform-tools`。adb 服务器是常驻后台进程，会占用 `platform-tools` 下的 exe 和 dll，导致升级安装时文件覆写失败。安装器在安装和卸载前会结束镜像路径位于本应用目录下的 adb，不影响 Android Studio 等其它来源的 adb。

## WSL 端口映射

顶栏的「WSL 端口映射」把 USB 串口映射进 WSL。

- 依赖 [usbipd-win](https://github.com/dorssel/usbipd-win)，安装包里已经包含。绑定和映射需要管理员权限。
- 支持自动映射和手动绑定。绑定过程中 Windows 会弹出授权窗口，需要在系统弹框上确认。
- 映射完成后，WSL 里会出现新的 `/dev/ttyUSB*` 或 `/dev/ttyACM*`。

<GuideMedia
  src="/img/guide/wsl.mp4"
  poster="/img/guide/wsl.png"
  caption="WSL 端口映射面板列出本机的 usbipd 设备和发行版状态。"
/>

## 在 WSL 分栏里调试

WSL 分栏可以直接在 WSL 内部打开串口并收发数据。背后使用一个 Python bridge，通过持久化 shell 减少每次启动的开销。

分栏里的「启动」用 Windows Terminal 打开对应的发行版。发行版名称来自 `wsl --list --verbose` 的真实结果；解析失败时界面会显示 WSL 的报错原文，不会拿错误的名称去启动。

读取轮询连续失败时，程序会把该分栏判定为掉线，界面显示「等待接入」。如果此时循环发送正在运行，也会随之停止。

系统没有 `sg` 或当前用户不在 `dialout` 组时，bridge 只在能非交互切换用户组的情况下使用 `sg`，否则直接运行 `python3`。缺少 `sg` 不影响启动；不在 `dialout` 组时，需要把用户加入该组，或通过 usbipd 指定设备。
