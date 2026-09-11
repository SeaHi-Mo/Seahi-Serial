"""连接设备 → 展开服务找带「写入」属性的特征 → 截图

只做"连接 + 展开第 4/5 个服务"，供后续人工看图定位写入图标坐标。
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


def btn_connected(path):
    from PIL import Image
    im = Image.open(path).convert('RGB')
    hits = 0
    for pt in ((1190, 49), (1210, 49), (1190, 67), (1210, 67)):
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
        p = f'{SHOTS}/s_{tag}.png'
        g.capture(h, p)
        return p

    for i in range(3):
        if is_ble_panel(snap('open')):
            break
        click((207, 15), 2.2)
    click((278, 61), 11.0)

    for _ in range(3):                 # 先确保未连接
        p = snap('pre')
        if not btn_connected(p):
            break
        click(BTN, 2.5)

    for i in range(8):                 # 连一台
        click((160, 143 + i * 57), 1.0)
        click(BTN, 6.0)
        p = snap(f'conn{i}')
        if btn_connected(p):
            print(f'已连接第 {i + 1} 台')
            break
    else:
        print('FAIL 没连上')
        return 1

    # 展开第 4、第 5 个服务（自定义服务更可能有写入特征）
    click((400, 312), 1.5)
    snap('svc4')
    click((400, 420), 1.5)             # 展开后位置下移，试探第 5 个服务
    snap('svc5')
    print('已截图 s_svc4 / s_svc5')
    return 0


if __name__ == '__main__':
    sys.exit(main())
