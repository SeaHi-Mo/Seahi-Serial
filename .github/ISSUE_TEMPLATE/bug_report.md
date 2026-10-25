---
name: 🐞 问题反馈
about: 报告崩溃、异常行为、连接/数据问题（请尽量附日志与截图）
title: "[bug] "
labels: bug
assignees: ''
---

## 环境

- SeaHi Serial 版本（窗口标题/关于，或启动日志里的 `version`）：
- Windows 版本（`winver` 的结果，如 Windows 10 22H2 / Windows 11 23H2）：
- 连接方式：串口 / WSL 串口 / ADB / 蓝牙 / 只用 MCP

## 设备与参数

- 串口芯片（CH340 / CP210x / FT232 / 其它）或 BLE 设备名 + MAC：
- 波特率、数据位、校验、停止位、行尾：
- 是否开启终端模式：

## 复现步骤

1.
2.
3.

## 期望结果

（你期望发生什么）

## 实际结果

（实际发生了什么；崩溃请贴出错误弹窗/退出前后现象）

## 日志与截图

- 调试日志：`%TEMP%\seahi-serial-debug.log`（把最近一段贴上来即可）
- 如果是 AI / MCP 触发的问题：请附上调用的工具名与大致时间（`mcp_calls` 里能查到）
- 截图 / 录屏：
