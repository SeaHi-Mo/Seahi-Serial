"""验证「订阅状态随连接复位」：订阅 notify → 断开 → 重连 → 图标应回到未启用（灰）。

notify 图标实测位于窗口坐标 x1208..1225 / y383..398，中心约 (1216,390)。
判据：该区域出现明显蓝色 = 已启用。
"""
import ctypes
import sys
import time

sys.path.insert(0, '.walkthrough')
import gui_tool as g
from PIL import Image, ImageStat

wt = g.wt
g.u.SetWindowPos.argtypes = [wt.HWND, wt.HWND, ctypes.c_int, ctypes.c_int,
                             ctypes.c_int, ctypes.c_int, ctypes.c_uint]
g.u.SetWindowPos.restype = wt.BOOL

SHOTS = '.walkthrough/shots'
NOTIFY_ICON = (1216, 390)
ICON_BOX = (1206, 381, 1227, 400)
CONNECT_BTN = (1188, 60)


def top(h, on):
    g.u.SetWindowPos(h, -1 if on else -2, 0, 0, 0, 0, 0x1 | 0x2 | 0x40)
    time.sleep(0.4)


def icon_state(path):
    im = Image.open(path).convert('RGB').crop(ICON_BOX)
    r, gg, b = [round(v) for v in ImageStat.Stat(im).mean]
    return ('on' if b > r + 40 else 'off'), (r, gg, b)


def btn_connected(path):
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

    def snap(tag):
        p = f'{SHOTS}/w_{tag}.png'
        g.capture(h, p)
        st, mean = icon_state(p)
        return p, st, mean

    if not btn_connected(f'{SHOTS}/z3_after_reconnect.png'):
        print('前置状态不是已连接，终止')
        return 1

    # ① 点击 notify 图标订阅
    g.click(r.left + NOTIFY_ICON[0], r.top + NOTIFY_ICON[1])
    time.sleep(2.5)
    p, st, mean = snap('subscribed')
    print(f'① 订阅后 notify 图标={st} mean={mean}')
    if st != 'on':
        print('① 订阅未生效（图标未变蓝），终止')
        return 1

    # ② 断开
    g.click(r.left + CONNECT_BTN[0], r.top + CONNECT_BTN[1])
    time.sleep(3.0)
    p, st, mean = snap('disconnected')
    print(f'② 断开后 按钮蓝底={btn_connected(p)} notify图标={st}')

    # ③ 重连 —— 关键断言：图标必须回到 off
    g.click(r.left + CONNECT_BTN[0], r.top + CONNECT_BTN[1])
    time.sleep(8.0)
    p, st, mean = snap('reconnected')
    conn = btn_connected(p)
    print(f'③ 重连后 按钮蓝底={conn} notify图标={st} mean={mean}')
    if not conn:
        print('③ FAIL 重连失败')
        return 1
    if st != 'off':
        print('③ FAIL 重连后 notify 图标仍显示启用（bug 未修复）')
        return 1
    print('③ PASS 重连后 notify 图标已复位为未启用')
    return 0


if __name__ == '__main__':
    sys.exit(main())
