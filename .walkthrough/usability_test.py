"""
Seahi-Serial 完整可用性测试脚本
基于已验证的 SendInput + SetForegroundWindow 方案
覆盖 TEST_CASES.md 中所有无需真实硬件的可测试项
"""

import ctypes
import ctypes.wintypes as w
import time
import os
import sys
import json

# ============================================================
# Win32 Setup
# ============================================================
user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
gdi32 = ctypes.windll.gdi32

SW_RESTORE = 9
HWND_TOPMOST = -1
HWND_NOTOPMOST = -2
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_SHOWWINDOW = 0x0040

# Input structures
class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", ctypes.wintypes.LONG),
        ("dy", ctypes.wintypes.LONG),
        ("mouseData", ctypes.wintypes.DWORD),
        ("dwFlags", ctypes.wintypes.DWORD),
        ("time", ctypes.wintypes.ULONG),
        ("dwExtraInfo", ctypes.POINTER(ctypes.wintypes.ULONG)),
    ]

class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", ctypes.wintypes.WORD),
        ("wScan", ctypes.wintypes.WORD),
        ("dwFlags", ctypes.wintypes.DWORD),
        ("time", ctypes.wintypes.ULONG),
        ("dwExtraInfo", ctypes.POINTER(ctypes.wintypes.ULONG)),
    ]

class INPUT_UNION(ctypes.Union):
    _fields_ = [
        ("mi", MOUSEINPUT),
        ("ki", KEYBDINPUT),
    ]

class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [
        ("type", ctypes.wintypes.DWORD),
        ("u", INPUT_UNION),
    ]

# Constants
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_MOVE = 0x0001
INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002

VK_ESCAPE = 0x1B
VK_RETURN = 0x0D
VK_TAB = 0x09
VK_SHIFT = 0x10
VK_BACK = 0x08

# ============================================================
# Core Functions
# ============================================================

def find_seahi_window():
    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    found = []
    def callback(hwnd, lparam):
        if user32.IsWindowVisible(hwnd):
            title = ctypes.create_unicode_buffer(256)
            user32.GetWindowTextW(hwnd, title, 256)
            if 'Seahi' in title.value:
                found.append((hwnd, title.value))
        return True
    user32.EnumWindows(WNDENUMPROC(callback), 0)
    return found[0] if found else (None, None)

def activate_window(hwnd):
    user32.ShowWindow(hwnd, SW_RESTORE)
    user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE)
    user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW)
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.5)

def get_window_rect(hwnd):
    rect = w.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    return rect

def capture_window(hwnd, filepath):
    rect = get_window_rect(hwnd)
    width = rect.right - rect.left
    height = rect.bottom - rect.top

    hwnd_dc = user32.GetWindowDC(hwnd)
    mfc_dc = gdi32.CreateCompatibleDC(hwnd_dc)
    bitmap = gdi32.CreateCompatibleBitmap(hwnd_dc, width, height)
    gdi32.SelectObject(mfc_dc, bitmap)
    user32.PrintWindow(hwnd, mfc_dc, 0x2)

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [
            ("biSize", ctypes.wintypes.UINT),
            ("biWidth", ctypes.wintypes.LONG),
            ("biHeight", ctypes.wintypes.LONG),
            ("biPlanes", ctypes.wintypes.WORD),
            ("biBitCount", ctypes.wintypes.WORD),
            ("biCompression", ctypes.wintypes.DWORD),
            ("biSizeImage", ctypes.wintypes.DWORD),
            ("biXPelsPerMeter", ctypes.wintypes.LONG),
            ("biYPelsPerMeter", ctypes.wintypes.LONG),
            ("biClrUsed", ctypes.wintypes.DWORD),
            ("biClrImportant", ctypes.wintypes.DWORD),
        ]

    bih = BITMAPINFOHEADER()
    bih.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bih.biWidth = width
    bih.biHeight = -height
    bih.biPlanes = 1
    bih.biBitCount = 32
    bih.biCompression = 0

    bitmap_bits = (ctypes.c_ubyte * (width * height * 4))()
    gdi32.GetDIBits(mfc_dc, bitmap, 0, height, bitmap_bits, ctypes.byref(bih), 0)

    from PIL import Image
    img = Image.frombuffer('RGBA', (width, height), bitmap_bits, 'raw', 'BGRA', 0, 1)
    img.save(filepath)

    gdi32.DeleteObject(bitmap)
    gdi32.DeleteDC(mfc_dc)
    user32.ReleaseDC(hwnd, hwnd_dc)
    return filepath

def click(hwnd, rx, ry, label=""):
    """点击窗口内相对坐标 (rx, ry)"""
    activate_window(hwnd)
    rect = get_window_rect(hwnd)
    abs_x = rect.left + rx
    abs_y = rect.top + ry
    screen_w = user32.GetSystemMetrics(0)
    screen_h = user32.GetSystemMetrics(1)
    norm_x = int(abs_x * 65535 / screen_w)
    norm_y = int(abs_y * 65535 / screen_h)

    inputs = (INPUT * 3)()
    inputs[0].type = INPUT_MOUSE
    inputs[0].mi.dx = norm_x
    inputs[0].mi.dy = norm_y
    inputs[0].mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE
    inputs[1].type = INPUT_MOUSE
    inputs[1].mi.dx = norm_x
    inputs[1].mi.dy = norm_y
    inputs[1].mi.dwFlags = MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_ABSOLUTE
    inputs[2].type = INPUT_MOUSE
    inputs[2].mi.dx = norm_x
    inputs[2].mi.dy = norm_y
    inputs[2].mi.dwFlags = MOUSEEVENTF_LEFTUP | MOUSEEVENTF_ABSOLUTE
    sent = user32.SendInput(3, ctypes.byref(inputs), ctypes.sizeof(INPUT))
    time.sleep(0.3)
    return sent

def press_key(vk_code):
    inputs = (INPUT * 2)()
    inputs[0].type = INPUT_KEYBOARD
    inputs[0].ki.wVk = vk_code
    inputs[1].type = INPUT_KEYBOARD
    inputs[1].ki.wVk = vk_code
    inputs[1].ki.dwFlags = KEYEVENTF_KEYUP
    sent = user32.SendInput(2, ctypes.byref(inputs), ctypes.sizeof(INPUT))
    time.sleep(0.3)
    return sent

def type_text(text):
    for ch in text:
        if ch.isupper():
            user32.keybd_event(VK_SHIFT, 0, 0, 0)
            time.sleep(0.02)
            user32.keybd_event(ord(ch), 0, 0, 0)
            time.sleep(0.02)
            user32.keybd_event(ord(ch), 0, KEYEVENTF_KEYUP, 0)
            user32.keybd_event(VK_SHIFT, 0, KEYEVENTF_KEYUP, 0)
        else:
            uc = ord(ch.upper())
            user32.keybd_event(uc, 0, 0, 0)
            time.sleep(0.02)
            user32.keybd_event(uc, 0, KEYEVENTF_KEYUP, 0)
        time.sleep(0.05)

# ============================================================
# Test Framework
# ============================================================

class UsabilityTest:
    def __init__(self, hwnd, shots_dir):
        self.hwnd = hwnd
        self.shots_dir = shots_dir
        self.results = []
        self.step = 0

    def shot(self, name, description=""):
        self.step += 1
        fname = f"ut_{self.step:02d}_{name}.png"
        fpath = os.path.join(self.shots_dir, fname)
        capture_window(self.hwnd, fpath)
        self.results.append({
            "step": self.step,
            "name": name,
            "file": fname,
            "description": description,
            "timestamp": time.strftime("%H:%M:%S")
        })
        print(f"  [{self.step:02d}] {name}: {fname}")
        return fpath

    def test(self, name, action_fn, description=""):
        print(f"\n{'='*50}")
        print(f"TEST: {name}")
        print(f"{'='*50}")
        try:
            action_fn()
            time.sleep(1.0)  # 等待UI响应
            self.shot(name, description)
        except Exception as e:
            print(f"  ERROR: {e}")
            self.results.append({
                "step": self.step,
                "name": name,
                "error": str(e),
                "description": description
            })

    def esc(self):
        activate_window(self.hwnd)
        press_key(VK_ESCAPE)
        time.sleep(0.3)

# ============================================================
# Test Scenarios
# ============================================================

def run_tests():
    shots_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots")
    os.makedirs(shots_dir, exist_ok=True)

    hwnd, title = find_seahi_window()
    if not hwnd:
        print("ERROR: Seahi-Serial not running!")
        return

    print(f"Window: HWND={hwnd} Title={title}")
    activate_window(hwnd)
    rect = get_window_rect(hwnd)
    print(f"Rect: ({rect.left},{rect.top}) - ({rect.right},{rect.bottom})")
    print(f"Size: {rect.right-rect.left} x {rect.bottom-rect.top}")

    t = UsabilityTest(hwnd, shots_dir)

    # ---- T01: 基线截图 ----
    t.test("baseline", lambda: None, "初始界面状态")

    # ---- T02: 端口下拉 ----
    def test_port_dropdown():
        click(hwnd, 165, 70)
    t.test("port_dropdown", test_port_dropdown, "点击端口下拉框，预期显示COM口列表")

    # ESC 关闭
    t.esc()

    # ---- T03: 波特率下拉 ----
    def test_baud_dropdown():
        click(hwnd, 280, 70)
    t.test("baud_dropdown", test_baud_dropdown, "点击波特率下拉，预期显示常用波特率列表")

    t.esc()

    # ---- T04: 查看模式切换 ----
    def test_view_mode():
        click(hwnd, 30, 70)
    t.test("view_mode", test_view_mode, "点击查看模式切换（文本/HEX）")

    time.sleep(0.5)
    # 切换回去
    click(hwnd, 30, 70)
    time.sleep(0.5)

    # ---- T05: 行尾切换 ----
    def test_line_ending():
        click(hwnd, 380, 70)
    t.test("line_ending", test_line_ending, "点击行尾下拉，预期显示CRLF/LF/CR/无")

    t.esc()

    # ---- T06: 开始监控（无端口）----
    def test_start_monitor():
        click(hwnd, 490, 70)
    t.test("start_monitor_no_port", test_start_monitor, "未选端口时点击开始监控，预期显示错误提示")

    time.sleep(1.5)
    t.esc()

    # ---- T07: 清除按钮 ----
    def test_clear():
        click(hwnd, 540, 70)
    t.test("clear_button", test_clear, "点击清除按钮")

    # ---- T08: 自动滚动切换 ----
    def test_auto_scroll():
        click(hwnd, 575, 70)
    t.test("auto_scroll_toggle", test_auto_scroll, "点击自动滚动按钮，预期切换高亮状态")

    # ---- T09: 自动重连切换 ----
    def test_auto_reconnect():
        click(hwnd, 610, 70)
    t.test("auto_reconnect_toggle", test_auto_reconnect, "点击自动重连按钮")

    # ---- T10: 终端模式切换 ----
    def test_terminal_mode():
        click(hwnd, 645, 70)
    t.test("terminal_mode", test_terminal_mode, "点击终端模式按钮")

    # 切换回去
    click(hwnd, 645, 70)
    time.sleep(0.3)

    # ---- T11: 行号切换 ----
    def test_line_numbers():
        click(hwnd, 680, 70)
    t.test("line_numbers_toggle", test_line_numbers, "点击行号按钮")

    # 切换回去
    click(hwnd, 680, 70)
    time.sleep(0.3)

    # ---- T12: 时间戳切换 ----
    def test_timestamp():
        click(hwnd, 715, 70)
    t.test("timestamp_toggle", test_timestamp, "点击时间戳按钮")

    # 切换回去
    click(hwnd, 715, 70)
    time.sleep(0.3)

    # ---- T13: 回显切换 ----
    def test_echo():
        click(hwnd, 750, 70)
    t.test("echo_toggle", test_echo, "点击回显按钮")

    # 切换回去
    click(hwnd, 750, 70)
    time.sleep(0.3)

    # ---- T14: 更多设置/高级设置行 ----
    def test_more_settings():
        click(hwnd, 785, 70)
    t.test("more_settings", test_more_settings, "点击更多设置按钮，预期展开/折叠高级设置行")

    time.sleep(0.5)

    # ---- T15: 折叠工具栏 ----
    def test_collapse_toolbar():
        click(hwnd, 1300, 130)
    t.test("collapse_toolbar", test_collapse_toolbar, "点击折叠工具栏按钮")

    time.sleep(0.5)
    # 再次点击展开
    click(hwnd, 1300, 130)
    time.sleep(0.5)

    # ---- T16: 添加规则 ----
    def test_add_rule():
        click(hwnd, 1340, 130)
    t.test("add_rule", test_add_rule, "点击添加规则按钮")

    time.sleep(0.5)
    t.esc()

    # ---- T17: 快捷指令面板 ----
    def test_quick_commands():
        # 快捷指令按钮在发送栏右侧
        click(hwnd, 1320, 1005)
    t.test("quick_commands_panel", test_quick_commands, "点击快捷指令按钮，预期弹出面板")

    time.sleep(1.0)
    t.esc()

    # ---- T18: WSL 端口映射面板 ----
    def test_wsl_panel():
        # WSL 按钮在全局标题栏
        click(hwnd, 30, 20)
    t.test("wsl_panel", test_wsl_panel, "点击WSL端口映射按钮，预期切换到WSL面板")

    time.sleep(1.0)

    # ---- T19: WSL 面板返回 ----
    def test_wsl_back():
        # 返回监视器按钮
        click(hwnd, 30, 20)
    t.test("wsl_back", test_wsl_back, "点击返回监视器按钮")

    time.sleep(0.5)

    # ---- T20: 主题切换（深浅色）----
    def test_theme_toggle():
        click(hwnd, 1190, 15)
    t.test("theme_toggle", test_theme_toggle, "点击主题切换开关，预期深浅色切换")

    time.sleep(0.5)

    # ---- T21: 主题风格下拉 ----
    def test_theme_style():
        click(hwnd, 1130, 15)
    t.test("theme_style_dropdown", test_theme_style, "点击主题风格下拉，预期显示6种风格")

    time.sleep(0.5)
    t.esc()

    # ---- T22: 打开额外监视器 ----
    def test_add_monitor():
        click(hwnd, 260, 20)
    t.test("add_monitor", test_add_monitor, "点击打开额外监视器，预期分栏显示")

    time.sleep(1.0)

    # ---- T23: 关闭额外监视器 ----
    def test_close_monitor():
        # 额外监视器的关闭按钮
        click(hwnd, 900, 55)
    t.test("close_monitor", test_close_monitor, "关闭额外监视器")

    time.sleep(0.5)

    # ---- T24: 输入框输入文本 ----
    def test_input_text():
        # 点击输入框
        click(hwnd, 400, 1005)
        time.sleep(0.3)
        type_text("AT+VERSION?")
    t.test("input_text", test_input_text, "在输入框输入AT+VERSION?")

    # ---- T25: 发送模式切换 ----
    def test_send_mode():
        click(hwnd, 1150, 1005)
    t.test("send_mode_toggle", test_send_mode, "切换发送模式（文本/HEX）")

    time.sleep(0.3)
    # 切换回去
    click(hwnd, 1150, 1005)
    time.sleep(0.3)

    # ---- T26: 发送按钮（无连接）----
    def test_send_button():
        click(hwnd, 1290, 1005)
    t.test("send_no_connection", test_send_button, "未连接时点击发送按钮")

    time.sleep(0.5)
    t.esc()

    # ---- T27: 提交Issue ----
    def test_submit_issue():
        click(hwnd, 1080, 15)
    t.test("submit_issue", test_submit_issue, "点击提交issue按钮")

    time.sleep(1.0)

    # ---- T28: 主题风格切换 - 浮世绘彩 ----
    def test_theme_ukiyo():
        click(hwnd, 1130, 15)
        time.sleep(0.5)
        # 选择浮世绘彩（第2项）
        click(hwnd, 1130, 55)
    t.test("theme_ukiyo", test_theme_ukiyo, "切换到浮世绘彩主题风格")

    time.sleep(0.5)

    # ---- T29: 主题风格切换 - 诗意东方 ----
    def test_theme_poetic():
        click(hwnd, 1130, 15)
        time.sleep(0.5)
        click(hwnd, 1130, 75)
    t.test("theme_poetic", test_theme_poetic, "切换到诗意东方主题风格")

    time.sleep(0.5)

    # ---- T30: 恢复默认主题 ----
    def test_theme_default():
        click(hwnd, 1130, 15)
        time.sleep(0.5)
        click(hwnd, 1130, 35)
    t.test("theme_default", test_theme_default, "恢复默认主题风格")

    # ---- 保存结果 ----
    results_path = os.path.join(shots_dir, "usability_test_results.json")
    with open(results_path, "w", encoding="utf-8") as f:
        json.dump({
            "window": {"hwnd": hwnd, "title": title, "rect": [rect.left, rect.top, rect.right, rect.bottom]},
            "total_steps": t.step,
            "results": t.results
        }, f, ensure_ascii=False, indent=2)
    print(f"\n\nResults saved to {results_path}")
    print(f"Total screenshots: {t.step}")

if __name__ == "__main__":
    run_tests()
