# Seahi-Serial 动态交互突破记录

> **日期**：2026-07-19
> **目的**：验证 Tauri WebView 自动化交互能力
> **结论**：**完全可行** — 之前走查报告中的"动态交互限制"已被解除

## 一、历史问题

2026-07-18 走查时，所有动态交互测试（点击、输入、F12）均未生效。截图显示界面无变化。归因结论：
- Tauri WebView 屏蔽了 Python/pyautogui 的输入事件
- 改用 SendMessageW(WM_LBUTTONDOWN/UP) 也无效

## 二、根本原因

不是 Tauri WebView 屏蔽输入，而是**窗口未被正确激活到前台**。

- `pyautogui.click()` 内部使用 `mouse_event` 注入事件，但 Windows 要求目标窗口必须是前台窗口（受 UIPI 限制）
- 当目标窗口被其他窗口遮挡时，输入事件会被静默丢弃
- 之前的 `SetForegroundWindow` 调用被 Windows 自身的焦点保护策略拒绝

## 三、解决方案

组合使用以下 Win32 API：

```python
# 1. 多步激活窗口（绕过焦点保护）
user32.ShowWindow(hwnd, SW_RESTORE)
user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE)
user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE)
user32.SetForegroundWindow(hwnd)

# 2. 使用 SendInput 而非 mouse_event
# SendInput 是 Windows 推荐的输入注入方式，更底层
# 使用绝对坐标 (0-65535 归一化)
norm_x = int(abs_x * 65535 / screen_width)
norm_y = int(abs_y * 65535 / screen_height)

inputs = (INPUT * 3)()
inputs[0].type = INPUT_MOUSE
inputs[0].mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE
inputs[0].mi.dx = norm_x
inputs[0].mi.dy = norm_y
# ... 后续 MOUSELEFTDOWN / MOUSELEFTUP

user32.SendInput(3, ctypes.byref(inputs), ctypes.sizeof(INPUT))
```

## 四、验证结果（2026-07-19 实际执行）

| 操作 | 坐标（相对窗口） | 截图证据 | 结果 |
|------|----------------|---------|------|
| 点击"+打开额外监视器" | (210, 20) | `v2_01_after_wsl.png` | ✅ 界面成功分栏为双监视器 |
| 点击主题风格下拉 | (1190, 15) | `v2_03_theme_toggle.png` | ✅ 主题从深色切换为浅色 + 下拉展开 |
| 点击发送输入框 | (400, 1010) | `v2_04_input_text.png` | ✅ 输入框获得焦点 |
| 键盘输入 "AT" | — | `v2_04_input_text.png` | ✅ 输入框显示 "AT" |

## 五、对走查报告的影响

之前 `doc/USER_RESEARCH_HEURISTIC_WALKTHROUGH.md` 的局限性章节（7.1）声明"无动态交互测试"。**这个限制现在已被解除**。

可立即扩展的动态验证场景：
1. **快捷指令入口可发现性**（F2/P-09）— 第一次用户能否找到三横线图标？
2. **下拉菜单展开行为** — 端口下拉、主题风格下拉的视觉表现
3. **Onboarding 触发与步骤** — 清除 localStorage 后重触发
4. **错误提示可操作性** — 模拟串口占用、设备拔出等异常
5. **日志保存流程** — 验证文件命名规则、目录选择
6. **多监视器切换** — 实际操作的分栏布局评估
7. **快捷指令面板** — 点击三横线图标后能看到什么？

## 六、技术备忘

```python
# 可用工具
- pyautogui: 不可靠（与 Tauri WebView 兼容性问题）
- ctypes + SendInput: ✅ 稳定
- comtypes + UIAutomation: comtypes 已安装但 UIAutomationClient 类型库加载失败（需单独解决）
- desktop-operator MCP: 不可用（缺少 desktop_operator_core/_mcp Python 模块）

# 关键代码路径
D:\Users\Seahi\Desktop\serial-debugger-tauri\.walkthrough\interaction_v2.py
```
