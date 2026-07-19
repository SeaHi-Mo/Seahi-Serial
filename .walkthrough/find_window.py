import ctypes
from ctypes import wintypes

user32 = ctypes.windll.user32

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

if not handles:
    print("No Seahi-Serial window found")
else:
    for h, t in handles:
        print(f"Found HWND={h} Title={t}")
    hwnd = handles[0][0]
    ShowWindow(hwnd, 9)  # SW_RESTORE
    SetForegroundWindow(hwnd)
    print(f"Activated HWND={hwnd}")
