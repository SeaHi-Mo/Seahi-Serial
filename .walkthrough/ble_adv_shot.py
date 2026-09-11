"""驱动应用完成「打开 BLE 面板 → 扫描 → 找一台有广播数据的设备 → 展开广播内容 → 截图」

沙箱里 SetForegroundWindow 会被拒绝，窗口不一定处于激活态，首次点击可能被系统吞掉，
因此每一步都用截图像素判定状态并自动重试。

展开判定：折叠时「GATT 服务 / 特征」标题紧贴开关下方（约 y=147）；
展开后该标题被广播内容顶下去，开关下方（约 y=121 起）先出现广播内容的文字。
故取区域 (325,112)-(955,210) 内「第一行文字」的 y：小于 142 视为已展开。
"""
import ctypes
import shutil
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
ADV_BOX = (325, 112, 955, 210)      # 开关下方区域（左, 上, 右, 下）
EXPANDED_IF_FIRST_ROW_ABOVE = 142   # 首行文字 y 小于此值 → 已展开
DEVICE_Y = [143, 200, 257, 314, 371, 428, 485, 542, 599]


def top(h, on):
    g.u.SetWindowPos(h, -1 if on else -2, 0, 0, 0, 0, 0x1 | 0x2 | 0x40)
    time.sleep(0.4)


def mean_diff(p1, p2):
    a = Image.open(p1).convert('RGB')
    b = Image.open(p2).convert('RGB')
    return sum(ImageStat.Stat(ImageChops.difference(a, b)).mean) / 3


def first_text_row(path, box, thresh=70):
    """区域内第一行「亮像素 >= 8 个」的 y；没有文字返回 None"""
    im = Image.open(path).convert('L').crop(box)
    w, h = im.size
    data = list(im.getdata())
    for y in range(h):
        row = data[y * w:(y + 1) * w]
        if sum(1 for v in row if v > thresh) >= 8:
            return box[1] + y
    return None


def is_expanded(path):
    y = first_text_row(path, ADV_BOX)
    return y is not None and y < EXPANDED_IF_FIRST_ROW_ABOVE


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

    for _ in range(2):                       # 让窗口稳定拿到输入
        g.click(r.left + 700, r.top + 500)
        time.sleep(0.8)
    base = f'{SHOTS}/v10_base.png'
    g.capture(h, base)

    # ① 打开 BLE 面板
    opened = False
    for i in range(4):
        g.click(r.left + 207, r.top + 15)
        time.sleep(2.0)
        cur = f'{SHOTS}/v10_try{i}.png'
        g.capture(h, cur)
        d = mean_diff(base, cur)
        print(f'  BLE 面板尝试 {i + 1}: 与串口视图差异={d:.2f}')
        if d > 2.0:
            opened = True
            break
    if not opened:
        print('FAIL: BLE 面板未打开')
        top(h, False)
        g.u.MoveWindow(h, ox, oy, 1263, 897, True)
        return 1

    # ② 扫描
    g.click(r.left + 278, r.top + 61)
    time.sleep(10.0)

    # ③ 逐台设备尝试展开广播内容，直到找到有内容的
    got = False
    for idx, dy in enumerate(DEVICE_Y):
        g.click(r.left + 160, r.top + dy)
        time.sleep(1.2)
        for k in range(3):
            cur = f'{SHOTS}/v10_dev{idx}_{k}.png'
            g.capture(h, cur)
            y = first_text_row(cur, ADV_BOX)
            print(f'  设备#{idx + 1}(y={dy}) 尝试{k + 1}: 开关下方首行文字 y={y} -> '
                  f'{"已展开" if is_expanded(cur) else "折叠/无内容"}')
            if is_expanded(cur):
                shutil.copy(cur, f'{SHOTS}/v10_adv.png')
                got = True
                break
            g.click(r.left + 350, r.top + 104)
            time.sleep(1.0)
        if got:
            break
    print('RESULT:', 'OK' if got else 'FAIL 未找到可展开的广播内容')

    top(h, False)
    g.u.MoveWindow(h, ox, oy, 1263, 897, True)
    print('restored', ox, oy)
    return 0 if got else 1


if __name__ == '__main__':
    sys.exit(main())
