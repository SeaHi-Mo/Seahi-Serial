"""
Seahi-Serial 精准可用性测试 v3
- 使用 BitBlt 从屏幕 DC 捕获（能捕获所有覆盖层/弹窗）
- 使用源码导出的精确坐标
- 每个测试前后捕获配对截图便于对比
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

# VK codes
VK_ESCAPE = 0x1B
VK_RETURN = 0x0D
VK_TAB = 0x09
VK_SHIFT = 0x10
VK_BACK = 0x08
VK_F12 = 0x7B

# ============================================================
# Coordinates derived from HTML source
# Window: 1367x1035, Global bar y=0-40, Toolbar y=45-90
# ============================================================
COORDS = {
    # Global bar (y ≈ 13)
    "logo": (20, 13),
    "addMonitor": (170, 13),  # ＋ 打开额外监视器
    "wslBtn": (300, 13),       # WSL 端口映射
    "themeStyle": (1010, 13),  # 主题风格下拉
    "issueBtn": (1085, 13),    # 提交issue
    "themeSwitch": (1180, 13), # 主题开关
    "winMin": (1230, 13),
    "winMax": (1290, 13),
    "winClose": (1350, 13),

    # Toolbar (y ≈ 70)
    "viewMode": (40, 70),      # 查看-文本
    "portDrop": (190, 70),     # 端口下拉
    "portRefresh": (280, 70),  # 刷新按钮
    "baudRate": (370, 70),     # 波特率输入
    "baudArrow": (415, 70),    # 波特率下拉箭头
    "lineEnding": (495, 70),   # 行尾下拉
    "startMonitor": (585, 70), # 开始监控
    "btnClear": (650, 70),     # 清除
    "btnAutoScroll": (685, 70),
    "btnAutoReconnect": (720, 70),
    "btnTerminal": (755, 70),
    "btnLineNum": (790, 70),
    "btnTimestamp": (825, 70),
    "btnEcho": (860, 70),
    "btnAdv": (895, 70),

    # Advanced settings row (y ≈ 130) - if expanded
    "dataBits": (80, 130),
    "stopBits": (160, 130),
    "parity": (240, 130),
    "dtr": (340, 130),
    "rts": (380, 130),
    "logDir": (480, 130),
    "saveLog": (650, 130),
    "copyAll": (700, 130),
    "collapseToolbar": (780, 130),
    "addRule": (830, 130),

    # Send bar (y ≈ 1010)
    "inputBox": (400, 1010),
    "sendMode": (1140, 1010),
    "sendBtn": (1200, 1010),
    "quickCmd": (1290, 1010),

    # WSL panel (when open)
    "wslBack": (170, 13),  # 返回监视器
}

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
    time.sleep(0.4)

def get_window_rect(hwnd):
    rect = w.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    return rect

def capture_window_bitblt(hwnd, filepath):
    """使用 BitBlt 从屏幕 DC 捕获窗口区域（能捕获所有覆盖层）"""
    rect = get_window_rect(hwnd)
    width = rect.right - rect.left
    height = rect.bottom - rect.top

    # Get screen DC
    screen_dc = user32.GetDC(0)
    mem_dc = gdi32.CreateCompatibleDC(screen_dc)
    bitmap = gdi32.CreateCompatibleBitmap(screen_dc, width, height)
    gdi32.SelectObject(mem_dc, bitmap)

    # BitBlt from screen at window position
    gdi32.BitBlt(mem_dc, 0, 0, width, height, screen_dc, rect.left, rect.top, 0x00CC0020)  # SRCCOPY

    # Get bitmap bits
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
    bih.biHeight = -height  # top-down
    bih.biPlanes = 1
    bih.biBitCount = 32
    bih.biCompression = 0

    bitmap_bits = (ctypes.c_ubyte * (width * height * 4))()
    gdi32.GetDIBits(mem_dc, bitmap, 0, height, bitmap_bits, ctypes.byref(bih), 0)

    from PIL import Image
    img = Image.frombuffer('RGBA', (width, height), bitmap_bits, 'raw', 'BGRA', 0, 1)
    img.save(filepath)

    gdi32.DeleteObject(bitmap)
    gdi32.DeleteDC(mem_dc)
    user32.ReleaseDC(0, screen_dc)
    return filepath

def click(hwnd, rx, ry):
    """点击窗口内相对坐标"""
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
    time.sleep(0.4)
    return sent

def press_key(vk_code):
    inputs = (INPUT * 2)()
    inputs[0].type = INPUT_KEYBOARD
    inputs[0].ki.wVk = vk_code
    inputs[1].type = INPUT_KEYBOARD
    inputs[1].ki.wVk = vk_code
    inputs[1].ki.dwFlags = KEYEVENTF_KEYUP
    user32.SendInput(2, ctypes.byref(inputs), ctypes.sizeof(INPUT))
    time.sleep(0.3)

def type_text(text):
    """使用 VK_ codes 注入文本"""
    # Map special characters
    special = {
        '+': 0xBB,  # VK_OEM_PLUS
        '?': 0xBF,  # VK_OEM_QUESTION (on US layout)
        '=': 0xBB,
        '_': 0xBD,  # need shift + -
    }
    for ch in text:
        if ch.isupper():
            user32.keybd_event(VK_SHIFT, 0, 0, 0)
            time.sleep(0.02)
            user32.keybd_event(ord(ch), 0, 0, 0)
            time.sleep(0.02)
            user32.keybd_event(ord(ch), 0, KEYEVENTF_KEYUP, 0)
            user32.keybd_event(VK_SHIFT, 0, KEYEVENTF_KEYUP, 0)
        elif ch in special:
            vk = special[ch]
            if ch in '+=':
                user32.keybd_event(VK_SHIFT, 0, 0, 0)
                time.sleep(0.02)
                user32.keybd_event(vk, 0, 0, 0)
                time.sleep(0.02)
                user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)
                user32.keybd_event(VK_SHIFT, 0, KEYEVENTF_KEYUP, 0)
            else:
                user32.keybd_event(vk, 0, 0, 0)
                time.sleep(0.02)
                user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)
        else:
            uc = ord(ch.upper())
            if 'A' <= ch.upper() <= 'Z':
                user32.keybd_event(ord(ch.upper()), 0, 0, 0)
            else:
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
        fname = f"v3_{self.step:02d}_{name}.png"
        fpath = os.path.join(self.shots_dir, fname)
        capture_window_bitblt(self.hwnd, fpath)
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
        print(f"\n>>> {name}")
        try:
            action_fn()
            time.sleep(0.8)
            self.shot(name, description)
        except Exception as e:
            print(f"  ERROR: {e}")

    def esc(self):
        activate_window(self.hwnd)
        press_key(VK_ESCAPE)
        time.sleep(0.3)

# ============================================================
# Main Test
# ============================================================

def run_tests():
    shots_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots")
    os.makedirs(shots_dir, exist_ok=True)

    hwnd, title = find_seahi_window()
    if not hwnd:
        print("ERROR: Seahi-Serial not running!")
        return

    print(f"Window: HWND={hwnd}")
    activate_window(hwnd)
    rect = get_window_rect(hwnd)
    print(f"Rect: ({rect.left},{rect.top})-({rect.right},{rect.bottom})")
    print(f"Size: {rect.right-rect.left} x {rect.bottom-rect.top}")

    t = UsabilityTest(hwnd, shots_dir)

    # ============ 基线 + 工具栏交互 ============
    t.test("00_baseline", lambda: None, "初始基线")

    t.test("01_port_dropdown",
           lambda: click(hwnd, *COORDS["portDrop"]),
           "点击端口下拉，预期显示COM口列表")

    t.esc()
    t.test("02_baud_dropdown",
           lambda: click(hwnd, *COORDS["baudArrow"]),
           "点击波特率下拉箭头")

    t.esc()
    t.test("03_view_mode_toggle",
           lambda: click(hwnd, *COORDS["viewMode"]),
           "点击查看模式(文本/HEX)")

    time.sleep(0.5)
    click(hwnd, *COORDS["viewMode"])  # 切回
    time.sleep(0.3)

    t.test("04_line_ending",
           lambda: click(hwnd, *COORDS["lineEnding"]),
           "点击行尾下拉")

    t.esc()
    t.test("05_start_no_port",
           lambda: click(hwnd, *COORDS["startMonitor"]),
           "未选端口点开始监控，预期toast错误")

    time.sleep(1.0)
    t.esc()

    # ============ 图标按钮切换 ============
    for btn in ["btnClear", "btnAutoScroll", "btnAutoReconnect", "btnTerminal",
                "btnLineNum", "btnTimestamp", "btnEcho"]:
        t.test(f"icon_{btn}",
               lambda b=btn: click(hwnd, *COORDS[b]),
               f"点击{btn}按钮")

    t.esc()

    # ============ 高级设置 ============
    t.test("10_advanced_settings",
           lambda: click(hwnd, *COORDS["btnAdv"]),
           "点击更多设置，预期展开高级设置行")

    time.sleep(0.5)

    t.test("11_dtr_check",
           lambda: click(hwnd, *COORDS["dtr"]),
           "勾选DTR")

    t.test("12_rts_check",
           lambda: click(hwnd, *COORDS["rts"]),
           "勾选RTS")

    t.test("13_log_dir",
           lambda: click(hwnd, *COORDS["logDir"]),
           "点击选择日志目录")

    time.sleep(1.0)
    t.esc()

    t.test("14_collapse_toolbar",
           lambda: click(hwnd, *COORDS["collapseToolbar"]),
           "点击折叠工具栏")

    time.sleep(0.5)
    click(hwnd, *COORDS["collapseToolbar"])  # 展开
    time.sleep(0.5)

    t.test("15_add_rule",
           lambda: click(hwnd, *COORDS["addRule"]),
           "点击添加规则")

    time.sleep(0.5)
    t.esc()

    # ============ 快捷指令面板 ============
    t.test("20_quick_cmd_panel",
           lambda: click(hwnd, *COORDS["quickCmd"]),
           "点击快捷指令按钮，预期弹出面板")

    t.test("21_quick_cmd_add",
           lambda: click(hwnd, 1330, 683),  # + 添加 button
           "点击+添加按钮")

    t.esc()
    t.esc()

    # ============ WSL 面板 ============
    t.test("30_wsl_panel",
           lambda: click(hwnd, *COORDS["wslBtn"]),
           "点击WSL端口映射，预期切换面板")

    time.sleep(1.0)

    t.test("31_wsl_distro_start",
           lambda: click(hwnd, 950, 50),  # 启动按钮
           "点击Ubuntu-24.04启动")

    time.sleep(1.0)
    t.esc()

    t.test("32_wsl_back",
           lambda: click(hwnd, *COORDS["wslBack"]),
           "点击返回监视器")

    time.sleep(0.5)

    # ============ 主题 ============
    t.test("40_theme_toggle",
           lambda: click(hwnd, *COORDS["themeSwitch"]),
           "点击主题切换开关")

    time.sleep(0.5)
    click(hwnd, *COORDS["themeSwitch"])  # 切回

    t.test("41_theme_style_drop",
           lambda: click(hwnd, *COORDS["themeStyle"]),
           "点击主题风格下拉，预期6种风格")

    time.sleep(0.5)
    t.esc()

    # ============ 多监视器 ============
    t.test("50_add_monitor",
           lambda: click(hwnd, *COORDS["addMonitor"]),
           "点击打开额外监视器，预期分栏")

    time.sleep(1.0)
    t.test("51_close_monitor",
           lambda: click(hwnd, 950, 60),  # 额外监视器关闭按钮
           "关闭额外监视器")

    time.sleep(0.5)

    # ============ 输入和发送 ============
    click(hwnd, *COORDS["inputBox"])
    time.sleep(0.3)
    type_text("AT+VERSION?")
    t.test("60_input_text", lambda: None, "在输入框输入AT+VERSION?")

    t.test("61_send_no_conn",
           lambda: click(hwnd, *COORDS["sendBtn"]),
           "未连接时点击发送按钮")

    time.sleep(0.5)
    t.esc()

    t.test("62_send_mode_toggle",
           lambda: click(hwnd, *COORDS["sendMode"]),
           "切换发送模式")

    time.sleep(0.3)
    click(hwnd, *COORDS["sendMode"])
    time.sleep(0.3)

    # ============ 提交Issue ============
    t.test("70_submit_issue",
           lambda: click(hwnd, *COORDS["issueBtn"]),
           "点击提交issue")

    time.sleep(1.0)

    # ============ 保存结果 ============
    results_path = os.path.join(shots_dir, "v3_results.json")
    with open(results_path, "w", encoding="utf-8") as f:
        json.dump({
            "window": {"hwnd": hwnd, "title": title,
                      "rect": [rect.left, rect.top, rect.right, rect.bottom]},
            "total_steps": t.step,
            "results": t.results
        }, f, ensure_ascii=False, indent=2)
    print(f"\n\n=== Done: {t.step} screenshots ===")
    print(f"Results: {results_path}")

if __name__ == "__main__":
    run_tests()
