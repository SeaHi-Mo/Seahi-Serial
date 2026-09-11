"""列出指定进程的所有窗口（含隐藏），用于定位 Tauri 主窗口。"""
import ctypes
import ctypes.wintypes as wt
import sys

u = ctypes.windll.user32
target_pid = int(sys.argv[1])
P = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
out = []


def cb(h, l):
    pid = wt.DWORD()
    u.GetWindowThreadProcessId(h, ctypes.byref(pid))
    if pid.value == target_pid:
        t = ctypes.create_unicode_buffer(512)
        u.GetWindowTextW(h, t, 512)
        c = ctypes.create_unicode_buffer(256)
        u.GetClassNameW(h, c, 256)
        r = wt.RECT()
        u.GetWindowRect(h, ctypes.byref(r))
        out.append((h, t.value, c.value, u.IsWindowVisible(h), r.left, r.top,
                    r.right - r.left, r.bottom - r.top))
    return True


u.EnumWindows(P(cb), 0)
print(f"pid={target_pid} windows={len(out)}")
for h, t, c, vis, x, y, w, hh in out:
    print(f"hwnd={h:<10} vis={int(bool(vis))} {w:>5}x{hh:<5} @({x},{y}) class={c!r} title={t!r}")
