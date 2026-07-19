import ctypes
from ctypes import wintypes
import sys
import io
import os
import struct
import time
try:
    from PIL import Image
except ImportError:
    Image = None

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

# --- Windows constants ---
SW_RESTORE = 9
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
SRCCOPY = 0x00CC0020
DIB_RGB_COLORS = 0

# --- Function prototypes ---
EnumWindows = user32.EnumWindows
EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
GetWindowTextW = user32.GetWindowTextW
GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
GetWindowTextLengthW = user32.GetWindowTextLengthW
GetWindowTextLengthW.argtypes = [wintypes.HWND]
IsWindowVisible = user32.IsWindowVisible
IsWindowVisible.argtypes = [wintypes.HWND]
SetForegroundWindow = user32.SetForegroundWindow
SetForegroundWindow.argtypes = [wintypes.HWND]
ShowWindow = user32.ShowWindow
ShowWindow.argtypes = [wintypes.HWND, wintypes.INT]
GetWindowRect = user32.GetWindowRect
GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
SetCursorPos = user32.SetCursorPos
SetCursorPos.argtypes = [wintypes.INT, wintypes.INT]
mouse_event = user32.mouse_event
GetWindowDC = user32.GetWindowDC
GetWindowDC.argtypes = [wintypes.HWND]
ReleaseDC = user32.ReleaseDC
ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
CreateCompatibleDC = gdi32.CreateCompatibleDC
CreateCompatibleDC.argtypes = [wintypes.HDC]
DeleteDC = gdi32.DeleteDC
DeleteDC.argtypes = [wintypes.HDC]
CreateCompatibleBitmap = gdi32.CreateCompatibleBitmap
CreateCompatibleBitmap.argtypes = [wintypes.HDC, wintypes.INT, wintypes.INT]
SelectObject = gdi32.SelectObject
SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
DeleteObject = gdi32.DeleteObject
DeleteObject.argtypes = [wintypes.HGDIOBJ]
BitBlt = gdi32.BitBlt
BitBlt.argtypes = [wintypes.HDC, wintypes.INT, wintypes.INT, wintypes.INT, wintypes.INT, wintypes.HDC, wintypes.INT, wintypes.INT, wintypes.DWORD]

class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", wintypes.LONG),
        ("biHeight", wintypes.LONG),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", wintypes.LONG),
        ("biYPelsPerMeter", wintypes.LONG),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]

GetDIBits = gdi32.GetDIBits
GetDIBits.argtypes = [wintypes.HDC, wintypes.HBITMAP, wintypes.UINT, wintypes.UINT, wintypes.LPVOID, ctypes.POINTER(BITMAPINFOHEADER), wintypes.UINT]

# --- Helpers ---

def find_windows():
    handles = []
    def callback(hwnd, extra):
        if IsWindowVisible(hwnd):
            length = GetWindowTextLengthW(hwnd)
            if length > 0:
                buf = ctypes.create_unicode_buffer(length + 1)
                GetWindowTextW(hwnd, buf, length + 1)
                title = buf.value
                if "Seahi" in title or "Serial" in title:
                    handles.append((hwnd, title))
        return True
    EnumWindows(EnumWindowsProc(callback), 0)
    return handles

def activate(hwnd):
    ShowWindow(hwnd, SW_RESTORE)
    time.sleep(0.2)
    SetForegroundWindow(hwnd)
    time.sleep(0.3)

def build_bmp_bytes(width, height, data_bgr_bottomup):
    row_size = (width * 3 + 3) & ~3
    image_size = row_size * height
    file_size = 14 + 40 + image_size
    parts = [b'BM']
    parts.append(struct.pack('<I', file_size))
    parts.append(struct.pack('<HH', 0, 0))
    parts.append(struct.pack('<I', 14 + 40))
    parts.append(struct.pack('<I', 40))
    parts.append(struct.pack('<i', width))
    parts.append(struct.pack('<i', height))
    parts.append(struct.pack('<HH', 1, 24))
    parts.append(struct.pack('<I', 0))
    parts.append(struct.pack('<I', image_size))
    parts.append(struct.pack('<i', 0))
    parts.append(struct.pack('<i', 0))
    parts.append(struct.pack('<I', 0))
    parts.append(struct.pack('<I', 0))
    parts.append(data_bgr_bottomup)
    return b''.join(parts)

def capture_window(hwnd, path):
    rect = wintypes.RECT()
    if not GetWindowRect(hwnd, ctypes.byref(rect)):
        raise RuntimeError("GetWindowRect failed")
    w = rect.right - rect.left
    h = rect.bottom - rect.top
    if w <= 0 or h <= 0:
        raise RuntimeError(f"Invalid window size: {w}x{h}")
    
    hwndDC = GetWindowDC(hwnd)
    if not hwndDC:
        raise RuntimeError("GetWindowDC failed")
    memDC = CreateCompatibleDC(hwndDC)
    bitmap = CreateCompatibleBitmap(hwndDC, w, h)
    old = SelectObject(memDC, bitmap)
    
    BitBlt(memDC, 0, 0, w, h, hwndDC, 0, 0, SRCCOPY)
    
    bih = BITMAPINFOHEADER()
    bih.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bih.biWidth = w
    bih.biHeight = -h  # top-down
    bih.biPlanes = 1
    bih.biBitCount = 24
    bih.biCompression = 0
    bih.biSizeImage = 0
    
    row_size = (w * 3 + 3) & ~3
    buf_size = row_size * h
    buf = ctypes.create_string_buffer(buf_size)
    
    gdi32.GetDIBits(memDC, bitmap, 0, h, buf, ctypes.byref(bih), DIB_RGB_COLORS)
    
    rows = [buf[i*row_size:(i+1)*row_size] for i in range(h)]
    bottom_up = b''.join(reversed(rows))
    bmp_bytes = build_bmp_bytes(w, h, bottom_up)
    
    if Image is None:
        with open(path, 'wb') as f:
            f.write(bmp_bytes)
    else:
        img = Image.open(io.BytesIO(bmp_bytes))
        img.save(path, 'PNG')
    
    SelectObject(memDC, old)
    DeleteObject(bitmap)
    DeleteDC(memDC)
    ReleaseDC(hwnd, hwndDC)
    print(f"SAVED {path} {w}x{h}")

def click_at(hwnd, rx, ry):
    """Click at rx,ry pixels relative to window top-left."""
    import pyautogui
    rect = wintypes.RECT()
    GetWindowRect(hwnd, ctypes.byref(rect))
    x = rect.left + rx
    y = rect.top + ry
    pyautogui.click(x, y)
    # Fallback: send WM_LBUTTONDOWN/UP messages using client-area coordinates
    cx = max(0, rx - 8)
    cy = max(0, ry - 40)
    lparam = (cx & 0xFFFF) | ((cy & 0xFFFF) << 16)
    user32.SendMessageW(hwnd, 0x0201, 0, lparam)
    time.sleep(0.05)
    user32.SendMessageW(hwnd, 0x0202, 0, lparam)
    print(f"CLICKED {x},{y} / MSG {cx},{cy}")

def main():
    handles = find_windows()
    if not handles:
        print("No window found")
        sys.exit(1)
    hwnd = handles[0][0]
    print(f"HWND={hwnd} {handles[0][1]}")
    activate(hwnd)
    
    action = sys.argv[1] if len(sys.argv) > 1 else 'capture'
    out_path = sys.argv[2] if len(sys.argv) > 2 else r'D:\Users\Seahi\Desktop\serial-debugger-tauri\.walkthrough\shots\window.png'
    
    if action == 'capture':
        capture_window(hwnd, out_path)
    elif action == 'click':
        x = int(sys.argv[3]) if len(sys.argv) > 3 else 100
        y = int(sys.argv[4]) if len(sys.argv) > 4 else 50
        click_at(hwnd, x, y)
        time.sleep(0.5)
        capture_window(hwnd, out_path)
    elif action == 'type':
        import pyautogui
        x = int(sys.argv[3]) if len(sys.argv) > 3 else 100
        y = int(sys.argv[4]) if len(sys.argv) > 4 else 50
        text = sys.argv[5] if len(sys.argv) > 5 else 'hello'
        click_at(hwnd, x, y)
        time.sleep(0.3)
        pyautogui.typewrite(text, interval=0.01)
        time.sleep(0.3)
        capture_window(hwnd, out_path)
    elif action == 'key':
        import pyautogui
        key = sys.argv[2] if len(sys.argv) > 2 else 'f12'
        out_path = sys.argv[3] if len(sys.argv) > 3 else out_path
        activate(hwnd)
        time.sleep(0.3)
        pyautogui.keyDown(key)
        pyautogui.keyUp(key)
        time.sleep(0.5)
        capture_window(hwnd, out_path)
    else:
        print("unknown action")
        sys.exit(1)

if __name__ == '__main__':
    main()
