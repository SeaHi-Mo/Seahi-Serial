"""
精确交互测试 v2
- 准确定位 WSL 按钮、端口下拉、开始监控、主题切换
- 每步操作后截图对比
- 验证 SendInput 注入是否稳定
"""

import ctypes
import ctypes.wintypes as w
import time
import os
import sys

# Win32 setup
user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
gdi32 = ctypes.windll.gdi32

SW_RESTORE = 9

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

VK_ESCAPE = 0x1B
VK_F12 = 0x7B
VK_RETURN = 0x0D
VK_TAB = 0x09

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
    # Use SetWindowPos with HWND_TOPMOST then back to normal to force focus
    user32.SetWindowPos(hwnd, -1, 0, 0, 0, 0, 0x0001 | 0x0002)  # SWP_NOSIZE | SWP_NOMOVE
    user32.SetWindowPos(hwnd, -2, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040)  # HWND_NOTOPMOST
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.5)

def get_window_rect(hwnd):
    rect = w.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    return rect

def capture_window(hwnd, filepath):
    """使用 GDI 捕获窗口截图（参考之前的版本）"""
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

def send_mouse_click_abs(abs_x, abs_y):
    """使用 SendInput 注入绝对坐标的鼠标点击"""
    screen_w = user32.GetSystemMetrics(0)
    screen_h = user32.GetSystemMetrics(1)
    norm_x = int(abs_x * 65535 / screen_w)
    norm_y = int(abs_y * 65535 / screen_h)

    # 使用三次事件：move -> down -> up，更稳定
    inputs = (INPUT * 3)()

    # 1. Move to position
    inputs[0].type = INPUT_MOUSE
    inputs[0].mi.dx = norm_x
    inputs[0].mi.dy = norm_y
    inputs[0].mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE

    # 2. Mouse down
    inputs[1].type = INPUT_MOUSE
    inputs[1].mi.dx = norm_x
    inputs[1].mi.dy = norm_y
    inputs[1].mi.dwFlags = MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_ABSOLUTE

    # 3. Mouse up
    inputs[2].type = INPUT_MOUSE
    inputs[2].mi.dx = norm_x
    inputs[2].mi.dy = norm_y
    inputs[2].mi.dwFlags = MOUSEEVENTF_LEFTUP | MOUSEEVENTF_ABSOLUTE

    sent = user32.SendInput(3, ctypes.byref(inputs), ctypes.sizeof(INPUT))
    time.sleep(0.3)
    return sent

def send_key_press(vk_code):
    """使用 SendInput 注入键盘按键（按下+释放）"""
    inputs = (INPUT * 2)()
    inputs[0].type = INPUT_KEYBOARD
    inputs[0].ki.wVk = vk_code
    inputs[1].type = INPUT_KEYBOARD
    inputs[1].ki.wVk = vk_code
    inputs[1].ki.dwFlags = 0x0002  # KEYEVENTF_KEYUP
    sent = user32.SendInput(2, ctypes.byref(inputs), ctypes.sizeof(INPUT))
    time.sleep(0.3)
    return sent

def send_text(text):
    """使用 SendInput 注入文本（逐字符）"""
    for ch in text:
        if ch.isupper():
            # 需要先按下 Shift
            user32.keybd_event(0x10, 0, 0, 0)  # VK_SHIFT down
            time.sleep(0.02)
            user32.keybd_event(ord(ch), 0, 0, 0)
            time.sleep(0.02)
            user32.keybd_event(ord(ch), 0, 0x0002, 0)  # up
            user32.keybd_event(0x10, 0, 0x0002, 0)  # VK_SHIFT up
        else:
            user32.keybd_event(ord(ch), 0, 0, 0)
            time.sleep(0.02)
            user32.keybd_event(ord(ch), 0, 0x0002, 0)
        time.sleep(0.05)

def main():
    shots_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots")
    os.makedirs(shots_dir, exist_ok=True)

    print("=" * 60)
    print("Seahi-Serial 精确交互测试 v2")
    print("=" * 60)

    hwnd, title = find_seahi_window()
    if not hwnd:
        print("❌ 未找到窗口")
        return

    print(f"✅ 窗口: HWND={hwnd}")
    activate_window(hwnd)
    rect = get_window_rect(hwnd)
    print(f"✅ 窗口位置: ({rect.left}, {rect.top}) - ({rect.right}, {rect.bottom})")

    win_x, win_y = rect.left, rect.top
    win_w, win_h = rect.right - rect.left, rect.bottom - rect.top

    # 基线截图
    print("\n[0] 基线截图...")
    capture_window(hwnd, os.path.join(shots_dir, "v2_00_baseline.png"))

    # 测试 1: 点击 WSL 端口映射按钮
    # 从基线截图看，WSL 按钮在标题栏中（x≈180-250, y≈10-30）
    print("\n[1] 点击 WSL 端口映射按钮...")
    wsl_x = win_x + 210
    wsl_y = win_y + 20
    print(f"    坐标: ({wsl_x}, {wsl_y})")
    sent = send_mouse_click_abs(wsl_x, wsl_y)
    print(f"    SendInput 返回: {sent}")
    time.sleep(1.5)
    capture_window(hwnd, os.path.join(shots_dir, "v2_01_after_wsl.png"))

    # 测试 2: 再次激活窗口，按 ESC 关闭可能的弹窗
    activate_window(hwnd)
    send_key_press(VK_ESCAPE)

    # 测试 3: 点击端口下拉（更精确的位置）
    # 从基线截图，端口下拉框在工具栏（x≈15-180, y≈60-80）
    print("\n[2] 点击端口下拉...")
    port_x = win_x + 165
    port_y = win_y + 70
    print(f"    坐标: ({port_x}, {port_y})")
    sent = send_mouse_click_abs(port_x, port_y)
    print(f"    SendInput 返回: {sent}")
    time.sleep(1)
    capture_window(hwnd, os.path.join(shots_dir, "v2_02_port_dropdown.png"))

    # 再次 ESC 关闭
    activate_window(hwnd)
    send_key_press(VK_ESCAPE)
    time.sleep(0.5)

    # 测试 4: 点击主题切换开关（标题栏右侧）
    # 从基线截图：开关在 (1190, 15) 附近
    print("\n[3] 点击主题切换开关...")
    theme_x = win_x + 1190
    theme_y = win_y + 15
    print(f"    坐标: ({theme_x}, {theme_y})")
    sent = send_mouse_click_abs(theme_x, theme_y)
    print(f"    SendInput 返回: {sent}")
    time.sleep(1)
    capture_window(hwnd, os.path.join(shots_dir, "v2_03_theme_toggle.png"))

    # 测试 5: 点击发送按钮（右下角）
    print("\n[4] 点击发送按钮（先输入文本）...")
    activate_window(hwnd)
    # 先点击输入框
    input_x = win_x + 400
    input_y = win_y + 1010
    send_mouse_click_abs(input_x, input_y)
    time.sleep(0.5)
    # 输入测试文本
    send_text("AT")
    time.sleep(0.5)
    capture_window(hwnd, os.path.join(shots_dir, "v2_04_input_text.png"))

    # 点击发送按钮
    send_x = win_x + 1290
    send_y = win_y + 1010
    print(f"    发送按钮坐标: ({send_x}, {send_y})")
    sent = send_mouse_click_abs(send_x, send_y)
    print(f"    SendInput 返回: {sent}")
    time.sleep(1)
    capture_window(hwnd, os.path.join(shots_dir, "v2_05_after_send.png"))

    print("\n" + "=" * 60)
    print("测试完成。请对比以下截图：")
    for f in sorted(os.listdir(shots_dir)):
        if f.startswith("v2_"):
            print(f"  shots/{f}")
    print("=" * 60)

if __name__ == "__main__":
    main()
