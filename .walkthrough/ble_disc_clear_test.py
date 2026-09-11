"""验证「断开连接 → 日志清空」（用能连上的设备）

序列：选中已连接设备 → 断开 → 连接（日志有内容）→ 断开（日志应清空）
"""
import ctypes
import sys
import time

sys.path.insert(0, '.walkthrough')
import gui_tool as g

wt = g.wt
g.u.SetWindowPos.argtypes = [wt.HWND, wt.HWND, ctypes.c_int, ctypes.c_int,
                             ctypes.c_int, ctypes.c_int, ctypes.c_uint]
g.u.SetWindowPos.restype = wt.BOOL

SHOTS = '.walkthrough/shots'
BTN = (1188, 60)


def top(h, on):
    g.u.SetWindowPos(h, -1 if on else -2, 0, 0, 0, 0, 0x1 | 0x2 | 0x40)
    time.sleep(0.4)


def is_ble_panel(path):
    from PIL import Image
    im = Image.open(path).convert('RGB')
    hits = 0
    for pt in ((250, 57), (252, 65), (304, 65)):
        r, gg, b = im.getpixel(pt)
        if b > r + 60 and b > 150:
            hits += 1
    return hits >= 2


def main():
    h, title = g.find_app()[0]
    o = g.rect_of(h)
    ox, oy = o.left, o.top
    g.u.MoveWindow(h, 0, 0, 1263, 897, True)
    top(h, True)
    time.sleep(0.8)
    import atexit
    atexit.register(lambda: (top(h, False), g.u.MoveWindow(h, ox, oy, 1263, 897, True)))
    r = g.rect_of(h)

    def click(pt, wait):
        g.click(r.left + pt[0], r.top + pt[1])
        time.sleep(wait)

    def snap(tag):
        g.u.SetCursorPos(r.left + 700, r.top + 600)
        time.sleep(0.5)
        p = f'{SHOTS}/x_{tag}.png'
        g.capture(h, p)
        print('   saved', tag)
        return p

    if not is_ble_panel(snap('state0')):
        print('不在蓝牙面板，终止')
        return 1

    # 选中第 1 台（截图里它是已连接的 HEPPYd）
    click((160, 143), 1.5)
    snap('switched')

    click(BTN, 3.0)      # 此时若已连接 → 断开
    snap('after_btn1')
    click(BTN, 7.0)      # 连接（日志开始有内容）
    snap('connected')
    click(BTN, 3.0)      # 断开 → 日志应清空
    snap('disconnected')
    return 0


if __name__ == '__main__':
    sys.exit(main())
