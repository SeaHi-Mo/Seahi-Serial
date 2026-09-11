"""打开 BLE 面板 → 扫描 → 截图设备列表（每步重新取窗口位置并校验，带重试）

注意：BLE 面板打开后顶部蓝牙按钮的 onclick 会被改成 closeBle()，
再点即关闭面板，所以不能盲目重复点它。
"""
import ctypes
import sys
import time

sys.path.insert(0, '.walkthrough')
import gui_tool as g
from PIL import Image, ImageChops, ImageStat

wt = g.wt
g.u.SetWindowPos.argtypes = [wt.HWND, wt.HWND, ctypes.c_int, ctypes.c_int,
                             ctypes.c_int, ctypes.c_int, ctypes.c_uint]
g.u.SetWindowPos.restype = wt.BOOL

SHOTS = '.walkthrough/shots'
LIST_BOX = (14, 100, 318, 700)      # 左侧设备列表区域


def top(h, on):
    g.u.SetWindowPos(h, -1 if on else -2, 0, 0, 0, 0, 0x1 | 0x2 | 0x40)
    time.sleep(0.4)


def mean_diff(p1, p2):
    a = Image.open(p1).convert('RGB')
    b = Image.open(p2).convert('RGB')
    return sum(ImageStat.Stat(ImageChops.difference(a, b)).mean) / 3


def card_pixels(path):
    """统计列表区域里「卡片底色 (46,49,56)」的像素数，用来判断列表是否有设备卡片"""
    im = Image.open(path).convert('RGB').crop(LIST_BOX)
    return sum(1 for p in im.getdata() if p == (46, 49, 56))


def main():
    wins = g.find_app()
    if not wins:
        print('NO_APP_WINDOW')
        return 1
    h, title = wins[0]
    o = g.rect_of(h)
    ox, oy = o.left, o.top
    print(f'window {title!r} orig=({ox},{oy})')

    g.u.MoveWindow(h, 0, 0, 1263, 897, True)
    top(h, True)
    time.sleep(0.8)

    r = g.rect_of(h)
    for _ in range(2):                      # 让窗口稳定拿到输入
        g.click(r.left + 700, r.top + 500)
        time.sleep(0.7)

    base = f'{SHOTS}/v13_base.png'
    g.capture(h, base)

    # ① 打开 BLE 面板（点一次就够；千万不要重复点，那会关掉它）
    r = g.rect_of(h)
    g.click(r.left + 207, r.top + 15)
    time.sleep(2.5)
    cur = f'{SHOTS}/v13_opened.png'
    g.capture(h, cur)
    if mean_diff(base, cur) <= 2.0:
        print('WARN: 首次点击未见变化，再点一次')
        g.click(r.left + 207, r.top + 15)
        time.sleep(2.5)
        g.capture(h, cur)
        print(f'  差异={mean_diff(base, cur):.2f}')
    else:
        print(f'  BLE 面板已打开 (差异={mean_diff(base, cur):.2f})')

    # ② 开始扫描（点击前重新取位置）
    r = g.rect_of(h)
    g.click(r.left + 278, r.top + 61)
    time.sleep(11.0)

    # ③ 校验列表确实出现了设备卡片，没有则重试一次点击
    out = f'{SHOTS}/v13_list.png'
    for i in range(2):
        g.capture(h, out)
        n = card_pixels(out)
        print(f'  列表卡片像素={n}')
        if n > 3000:
            break
        r = g.rect_of(h)
        g.click(r.left + 278, r.top + 61)
        time.sleep(11.0)

    top(h, False)
    g.u.MoveWindow(h, ox, oy, 1263, 897, True)
    print('saved', out, '| restored', ox, oy)
    return 0


if __name__ == '__main__':
    sys.exit(main())
