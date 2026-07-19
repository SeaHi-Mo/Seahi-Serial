"""
Seahi-Serial 交互能力诊断脚本
尝试多种方法与 Tauri WebView 交互：
1. 查找窗口并激活
2. 截图（基线）
3. 尝试 UI Automation (comtypes) 检测 UI 元素
4. 尝试 SendInput 注入鼠标点击
5. 尝试 pyautogui 点击
6. 再次截图对比
"""

import ctypes
import ctypes.wintypes as w
import time
import os
import sys

# Constants
SW_RESTORE = 9
SW_SHOW = 5
INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_LEFTCLICK = MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_LEFTUP
KEYEVENTF_KEYDOWN = 0x0000
KEYEVENTF_KEYUP = 0x0002
VK_F12 = 0x7B
VK_ESCAPE = 0x1B

# Win32 functions
user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

# Structures for SendInput
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

def find_seahi_window():
    """查找 Seahi-Serial 窗口"""
    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    found = []

    def callback(hwnd, lparam):
        if user32.IsWindowVisible(hwnd):
            title = ctypes.create_unicode_buffer(256)
            user32.GetWindowTextW(hwnd, title, 256)
            if 'Seahi' in title.value or 'Serial' in title.value:
                found.append((hwnd, title.value))
        return True

    user32.EnumWindows(WNDENUMPROC(callback), 0)
    return found[0] if found else (None, None)

def activate_window(hwnd):
    """激活窗口到前台"""
    user32.ShowWindow(hwnd, SW_RESTORE)
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.5)

def get_window_rect(hwnd):
    """获取窗口矩形"""
    rect = w.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    return rect

def capture_window(hwnd, filepath):
    """使用 GDI 捕获窗口截图"""
    gdi32 = ctypes.windll.gdi32

    rect = get_window_rect(hwnd)
    width = rect.right - rect.left
    height = rect.bottom - rect.top

    hwnd_dc = user32.GetWindowDC(hwnd)
    mfc_dc = gdi32.CreateCompatibleDC(hwnd_dc)
    bitmap = gdi32.CreateCompatibleBitmap(hwnd_dc, width, height)
    gdi32.SelectObject(mfc_dc, bitmap)

    # PrintWindow with PW_RENDERFULLCONTENT (0x2) for newer apps
    result = user32.PrintWindow(hwnd, mfc_dc, 0x2)

    if result == 0:
        # Fallback to BitBlt
        gdi32.BitBlt(mfc_dc, 0, 0, width, height, hwnd_dc, 0, 0, 0x00CC0020)

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
    gdi32.GetDIBits(mfc_dc, bitmap, 0, height, bitmap_bits, ctypes.byref(bih), 0)

    # Convert to PNG with Pillow
    from PIL import Image
    img = Image.frombuffer('RGBA', (width, height), bitmap_bits, 'raw', 'BGRA', 0, 1)
    img.save(filepath)

    gdi32.DeleteObject(bitmap)
    gdi32.DeleteDC(mfc_dc)
    user32.ReleaseDC(hwnd, hwnd_dc)

    return filepath

def send_mouse_click(x, y):
    """使用 SendInput 注入鼠标点击（绝对坐标）"""
    # Convert to absolute coordinates (0-65535)
    abs_x = int(x * 65535 / ctypes.windll.user32.GetSystemMetrics(0))
    abs_y = int(y * 65535 / ctypes.windll.user32.GetSystemMetrics(1))

    inputs = (INPUT * 2)()

    # Mouse move + down
    inputs[0].type = INPUT_MOUSE
    inputs[0].mi.dx = abs_x
    inputs[0].mi.dy = abs_y
    inputs[0].mi.dwFlags = MOUSEEVENTF_LEFTDOWN | 0x8000  # MOUSEEVENTF_ABSOLUTE

    # Mouse up
    inputs[1].type = INPUT_MOUSE
    inputs[1].mi.dx = abs_x
    inputs[1].mi.dy = abs_y
    inputs[1].mi.dwFlags = MOUSEEVENTF_LEFTUP | 0x8000

    sent = user32.SendInput(2, ctypes.byref(inputs), ctypes.sizeof(INPUT))
    return sent

def send_key(vk_code):
    """使用 SendInput 注入键盘按键"""
    inputs = (INPUT * 2)()

    inputs[0].type = INPUT_KEYBOARD
    inputs[0].ki.wVk = vk_code
    inputs[0].ki.dwFlags = KEYEVENTF_KEYDOWN

    inputs[1].type = INPUT_KEYBOARD
    inputs[1].ki.wVk = vk_code
    inputs[1].ki.dwFlags = KEYEVENTF_KEYUP

    sent = user32.SendInput(2, ctypes.byref(inputs), ctypes.sizeof(INPUT))
    return sent

def try_ui_automation(hwnd):
    """尝试使用 comtypes UI Automation 检测 UI 元素"""
    try:
        import comtypes
        import comtypes.client

        # Try to load UI Automation
        try:
            uia_client = comtypes.client.CreateObject(
                "{ff48dba4-60ef-4201-aa87-54103eef594e}",
                interface=comtypes.gen.UIAutomationClient.IUIAutomation
            )
        except Exception:
            # Need to generate the wrapper
            comtypes.client.GetModule("UIAutomationClient.dll")
            from comtypes.gen.UIAutomationClient import IUIAutomation
            uia_client = comtypes.client.CreateObject(
                "{ff48dba4-60ef-4201-aa87-54103eef594e}",
                interface=IUIAutomation
            )

        # Get element from window handle
        elem = uia_client.ElementFromHandle(hwnd)
        if elem:
            name = elem.CurrentName
            ctrl_type = elem.CurrentControlType
            print(f"  UIA root element: name={name}, type={ctrl_type}")

            # Try to find some child elements
            walker = uia_client.RawViewWalker
            child = walker.GetFirstChildElement(elem)
            count = 0
            while child and count < 10:
                try:
                    cname = child.CurrentName
                    ctype = child.CurrentControlType
                    cauto = child.CurrentAutomationId
                    print(f"  UIA child[{count}]: name={cname}, type={ctype}, automationId={cauto}")
                except:
                    pass
                child = walker.GetNextSiblingElement(child)
                count += 1
            return True
        return False
    except Exception as e:
        print(f"  UI Automation 失败: {e}")
        return False

def try_pyautogui_click(x, y):
    """尝试用 pyautogui 点击"""
    try:
        import pyautogui
        pyautogui.click(x, y)
        return True
    except Exception as e:
        print(f"  pyautogui 失败: {e}")
        return False

def main():
    shots_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots")
    os.makedirs(shots_dir, exist_ok=True)

    print("=" * 60)
    print("Seahi-Serial 交互能力诊断")
    print("=" * 60)

    # Step 1: Find window
    print("\n[1] 查找窗口...")
    hwnd, title = find_seahi_window()
    if not hwnd:
        print("  ❌ 未找到 Seahi-Serial 窗口")
        return
    print(f"  ✅ 找到窗口: HWND={hwnd}, Title={title}")

    # Step 2: Activate window
    print("\n[2] 激活窗口到前台...")
    activate_window(hwnd)
    print(f"  ✅ 已激活 (前台窗口: {user32.GetForegroundWindow()})")

    rect = get_window_rect(hwnd)
    print(f"  窗口位置: ({rect.left}, {rect.top}) - ({rect.right}, {rect.bottom})")
    print(f"  窗口大小: {rect.right - rect.left} x {rect.bottom - rect.top}")

    # Step 3: Baseline screenshot
    print("\n[3] 捕获基线截图...")
    baseline = os.path.join(shots_dir, "test_baseline.png")
    capture_window(hwnd, baseline)
    print(f"  ✅ 基线截图: {baseline}")

    # Step 4: Try UI Automation
    print("\n[4] 尝试 UI Automation 检测元素...")
    uia_ok = try_ui_automation(hwnd)
    if uia_ok:
        print("  ✅ UI Automation 可用")
    else:
        print("  ⚠️ UI Automation 不可用")

    # Step 5: Try SendInput keyboard (F12 to open devtools)
    print("\n[5] 尝试 SendInput 键盘 (F12 打开 devtools)...")
    sent = send_key(VK_F12)
    print(f"  SendInput 返回: {sent} (预期 2)")
    time.sleep(2)

    after_f12 = os.path.join(shots_dir, "test_after_f12.png")
    capture_window(hwnd, after_f12)
    print(f"  截图: {after_f12}")

    # Step 6: Try SendInput mouse click on port dropdown area
    # Based on previous screenshots, port dropdown is around (200, 70) relative to window
    print("\n[6] 尝试 SendInput 鼠标点击 (端口下拉区域)...")
    click_x = rect.left + 200
    click_y = rect.top + 70
    print(f"  点击坐标: ({click_x}, {click_y}) [屏幕绝对坐标]")
    sent = send_mouse_click(click_x, click_y)
    print(f"  SendInput 返回: {sent} (预期 2)")
    time.sleep(1)

    after_click1 = os.path.join(shots_dir, "test_after_click_port.png")
    capture_window(hwnd, after_click1)
    print(f"  截图: {after_click1}")

    # Step 7: Try pyautogui click on another area (WSL button)
    print("\n[7] 尝试 pyautogui 点击 (WSL 端口映射按钮)...")
    # WSL button is around (80, 40) relative to window (top-left area of title bar)
    wsl_x = rect.left + 80
    wsl_y = rect.top + 40
    print(f"  点击坐标: ({wsl_x}, {wsl_y})")
    pa_ok = try_pyautogui_click(wsl_x, wsl_y)
    time.sleep(1)

    after_click2 = os.path.join(shots_dir, "test_after_click_wsl.png")
    capture_window(hwnd, after_click2)
    print(f"  截图: {after_click2}")

    # Step 8: Try pressing Escape to close any opened dropdown
    print("\n[8] 按 Escape 关闭可能的弹出...")
    send_key(VK_ESCAPE)
    time.sleep(0.5)

    # Step 9: Try clicking on "开始监控" button area
    print("\n[9] 尝试 SendInput 点击 (开始监控按钮区域)...")
    # Start monitor button is around (650, 70) relative to window
    start_x = rect.left + 650
    start_y = rect.top + 70
    print(f"  点击坐标: ({start_x}, {start_y})")
    send_mouse_click(start_x, start_y)
    time.sleep(1)

    after_click3 = os.path.join(shots_dir, "test_after_click_start.png")
    capture_window(hwnd, after_click3)
    print(f"  截图: {after_click3}")

    # Summary
    print("\n" + "=" * 60)
    print("诊断完成。请对比以下截图判断交互是否生效：")
    print(f"  1. {baseline} (基线)")
    print(f"  2. {after_f12} (F12后)")
    print(f"  3. {after_click1} (点击端口后)")
    print(f"  4. {after_click2} (点击WSL后)")
    print(f"  5. {after_click3} (点击开始后)")
    print("=" * 60)

if __name__ == "__main__":
    main()
