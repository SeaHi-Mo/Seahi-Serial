"""GUI 截图/点击工具（本次 BLE 图标验证专用）

用法：
    python gui_tool.py capture <out.png>
    python gui_tool.py click <relx> <rely> <out.png> [wait_sec]
    python gui_tool.py crop <src.png> <x> <y> <w> <h> <scale> <out.png>

坐标均为相对窗口左上角的像素值。
"""
import ctypes
import ctypes.wintypes as wt
import sys
import time

u = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

SW_RESTORE = 9
HWND_TOPMOST = -1
HWND_NOTOPMOST = -2
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_SHOWWINDOW = 0x0040

MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_MOVE = 0x0001
INPUT_MOUSE = 0


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wt.LONG), ("dy", wt.LONG), ("mouseData", wt.DWORD),
                ("dwFlags", wt.DWORD), ("time", wt.ULONG),
                ("dwExtraInfo", ctypes.POINTER(wt.ULONG))]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wt.WORD), ("wScan", wt.WORD), ("dwFlags", wt.DWORD),
                ("time", wt.ULONG), ("dwExtraInfo", ctypes.POINTER(wt.ULONG))]


class INPUT_UNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wt.DWORD), ("u", INPUT_UNION)]


def find_app():
    """定位真正的 Tauri 窗口：class='Tauri Window' 且标题为 'Seahi Serial'
    （注意 Clash Verge 等其它 Tauri 应用 class 相同，必须按标题区分）"""
    P = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    found = []

    def cb(h, l):
        if u.IsWindowVisible(h):
            c = ctypes.create_unicode_buffer(256)
            u.GetClassNameW(h, c, 256)
            if c.value == "Tauri Window":
                t = ctypes.create_unicode_buffer(256)
                u.GetWindowTextW(h, t, 256)
                if "Seahi" in t.value:
                    found.append((h, t.value))
        return True

    u.EnumWindows(P(cb), 0)
    return found


def activate(h):
    u.ShowWindow(h, SW_RESTORE)
    u.SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE)
    u.SetWindowPos(h, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW)
    u.SetForegroundWindow(h)
    time.sleep(0.4)


def rect_of(h):
    r = wt.RECT()
    u.GetWindowRect(h, ctypes.byref(r))
    return r


def capture(h, path):
    r = rect_of(h)
    x, y = r.left, r.top
    cx, cy = r.right - r.left, r.bottom - r.top
    sdc = u.GetDC(0)
    mdc = gdi32.CreateCompatibleDC(sdc)
    bmp = gdi32.CreateCompatibleBitmap(sdc, cx, cy)
    gdi32.SelectObject(mdc, bmp)
    gdi32.BitBlt(mdc, 0, 0, cx, cy, sdc, x, y, 0x00CC0020)

    class BIH(ctypes.Structure):
        _fields_ = [("biSize", wt.UINT), ("biWidth", wt.LONG), ("biHeight", wt.LONG),
                    ("biPlanes", wt.WORD), ("biBitCount", wt.WORD),
                    ("biCompression", wt.DWORD), ("biSizeImage", wt.DWORD),
                    ("biXPelsPerMeter", wt.LONG), ("biYPelsPerMeter", wt.LONG),
                    ("biClrUsed", wt.DWORD), ("biClrImportant", wt.DWORD)]

    bih = BIH()
    bih.biSize = ctypes.sizeof(BIH)
    bih.biWidth = cx
    bih.biHeight = -cy
    bih.biPlanes = 1
    bih.biBitCount = 32
    buf = (ctypes.c_ubyte * (cx * cy * 4))()
    gdi32.GetDIBits(mdc, bmp, 0, cy, buf, ctypes.byref(bih), 0)

    from PIL import Image
    Image.frombuffer("RGBA", (cx, cy), buf, "raw", "BGRA", 0, 1).convert("RGB").save(path)
    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mdc)
    u.ReleaseDC(0, sdc)
    return path


def pin(h, x=0, y=0):
    """把窗口移到 (x,y) 并置为 topmost。
    背景进程调用 SetForegroundWindow 会被 Windows 拒绝，因此不靠抢焦点，
    改用 topmost 保证目标窗口在 BitBlt 与点击时都位于最上层。"""
    # 必须声明 argtypes：否则 HWND 被按 32 位传递，SetWindowPos 会静默失败
    u.SetWindowPos.argtypes = [wt.HWND, wt.HWND, ctypes.c_int, ctypes.c_int,
                               ctypes.c_int, ctypes.c_int, ctypes.c_uint]
    u.SetWindowPos.restype = wt.BOOL
    u.GetWindowLongW.argtypes = [wt.HWND, ctypes.c_int]
    u.GetWindowLongW.restype = wt.LONG

    r = rect_of(h)
    u.MoveWindow(h, x, y, r.right - r.left, r.bottom - r.top, True)
    u.SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0,
                   SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW)
    time.sleep(0.6)
    r2 = rect_of(h)
    topmost = bool(u.GetWindowLongW(h, -20) & 0x00000008)   # GWL_EXSTYLE & WS_EX_TOPMOST
    print(f"pin -> rect=({r2.left},{r2.top}) topmost={topmost}")


def unpin(h):
    u.SetWindowPos(h, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE)
    time.sleep(0.3)


MOUSEEVENTF_WHEEL = 0x0800


def wheel(ax, ay, clicks):
    """把光标移到 (ax,ay) 后滚动滚轮：clicks>0 向上，<0 向下"""
    u.SetCursorPos(int(ax), int(ay))
    time.sleep(0.25)
    arr = (INPUT * 1)()
    arr[0].type = INPUT_MOUSE
    arr[0].mi.dx = 0
    arr[0].mi.dy = 0
    arr[0].mi.mouseData = (clicks * 120) & 0xFFFFFFFF
    arr[0].mi.dwFlags = MOUSEEVENTF_WHEEL
    n = u.SendInput(1, ctypes.byref(arr), ctypes.sizeof(INPUT))
    time.sleep(0.4)
    return n


KEYEVENTF_KEYUP = 0x0002


def press_key(vk):
    u.keybd_event(vk, 0, 0, 0)
    u.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)
    time.sleep(0.08)


def type_text(text):
    """逐字符注入文本。字母/数字直接用 VK（小写无需 Shift），
    其余字符才走 VkKeyScanW 处理修饰键。"""
    for ch in text:
        shift = False
        if ('a' <= ch <= 'z') or ('0' <= ch <= '9'):
            vk = ord(ch.upper())
        else:
            res = u.VkKeyScanW(ord(ch))
            vk = res & 0xFF
            shift = bool((res >> 8) & 0x01)
        if shift:
            u.keybd_event(0x10, 0, 0, 0)          # VK_SHIFT down
        u.keybd_event(vk, 0, 0, 0)
        u.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)
        if shift:
            u.keybd_event(0x10, 0, KEYEVENTF_KEYUP, 0)
        time.sleep(0.06)


def click(ax, ay):
    sw, sh = u.GetSystemMetrics(0), u.GetSystemMetrics(1)
    nx, ny = int(ax * 65535 / sw), int(ay * 65535 / sh)
    arr = (INPUT * 3)()
    for i, flag in enumerate((MOUSEEVENTF_MOVE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)):
        arr[i].type = INPUT_MOUSE
        arr[i].mi.dx, arr[i].mi.dy = nx, ny
        arr[i].mi.dwFlags = flag | MOUSEEVENTF_ABSOLUTE
    n = u.SendInput(3, ctypes.byref(arr), ctypes.sizeof(INPUT))
    time.sleep(0.4)
    return n


def main():
    cmd = sys.argv[1]
    wins = find_app()
    if not wins:
        print("NO_APP_WINDOW")
        return 1
    h, title = wins[0]
    print(f"window hwnd={h} title={title!r}")

    if cmd == "teardown":
        unpin(h)
    elif cmd in ("capture", "click"):
        pin(h, 0, 0)          # 每次操作前重新固定，避免窗口被移动导致坐标漂移
    r = rect_of(h)
    print(f"rect=({r.left},{r.top}) size={r.right-r.left}x{r.bottom-r.top}")

    if cmd == "setup":
        print("pinned at (0,0) topmost")
    elif cmd == "teardown":
        print("unpinned")
    elif cmd == "capture":
        print("saved", capture(h, sys.argv[2]))
    elif cmd == "click":
        rx, ry = int(sys.argv[2]), int(sys.argv[3])
        wait = float(sys.argv[5]) if len(sys.argv) > 5 else 1.2
        print("click abs=", r.left + rx, r.top + ry, "sent=", click(r.left + rx, r.top + ry))
        time.sleep(wait)
        print("saved", capture(h, sys.argv[4]))
    elif cmd == "crop":
        from PIL import Image
        src, x, y, cw, ch, scale, out = sys.argv[2:9]
        img = Image.open(src).crop((int(x), int(y), int(x) + int(cw), int(y) + int(ch)))
        s = float(scale)
        img = img.resize((int(img.width * s), int(img.height * s)), Image.LANCZOS)
        img.save(out)
        print("saved", out, img.size)
    return 0


if __name__ == "__main__":
    sys.exit(main())
