# ADB 调试

ADB 面板用于调试 Android 设备，不依赖本机 COM 口。

## 设备列表

打开 ADB 面板后点刷新，获取设备列表。状态为 `device` 的设备可以使用；显示 `unauthorized` 时，需要在设备上允许 USB 调试。

## 打开终端

选中设备后打开终端，操作方式和串口终端一致：直接输入命令、查看 PTY 输出，也可以调整终端尺寸或关闭会话。

## platform-tools

安装包自带 `platform-tools`。adb 服务器是常驻后台进程，会占用 `platform-tools` 下的 exe 和 dll，导致升级安装时文件覆写失败。安装器在安装和卸载前会结束镜像路径位于本应用目录下的 adb，不影响 Android Studio 等其它来源的 adb。
