"""依次选中多台设备，把各自的「广播内容」区域裁剪后纵向拼成一张图，便于一次查看。

前置：BLE 面板已打开、已扫描、广播内容已处于展开状态（_bleAdvOpen=true 会被后续设备沿用）。
"""
import ctypes
import sys
import time

sys.path.insert(0, '.walkthrough')
import gui_tool as g
from PIL import Image, ImageDraw

wt = g.wt
g.u.SetWindowPos.argtypes = [wt.HWND, wt.HWND, ctypes.c_int, ctypes.c_int,
                             ctypes.c_int, ctypes.c_int, ctypes.c_uint]
g.u.SetWindowPos.restype = wt.BOOL

SHOTS = '.walkthrough/shots'
DEVICE_Y = [143, 200, 257, 314, 371, 428]
CROP = (325, 108, 965, 300)      # 广播内容所在区域（左, 上, 右, 下）


def main():
    wins = g.find_app()
    if not wins:
        print('NO_APP_WINDOW')
        return 1
    h, title = wins[0]
    o = g.rect_of(h)
    ox, oy = o.left, o.top

    g.u.MoveWindow(h, 0, 0, 1263, 897, True)
    g.u.SetWindowPos(h, -1, 0, 0, 0, 0, 0x1 | 0x2 | 0x40)
    time.sleep(0.8)
    r = g.rect_of(h)

    tiles = []
    for i, dy in enumerate(DEVICE_Y):
        g.click(r.left + 160, r.top + dy)
        time.sleep(1.3)
        p = f'{SHOTS}/v11_dev{i}.png'
        g.capture(h, p)
        tiles.append(p)
        print(f'device #{i + 1} y={dy} -> {p}')

    g.u.SetWindowPos(h, -2, 0, 0, 0, 0, 0x1 | 0x2 | 0x40)
    g.u.MoveWindow(h, ox, oy, 1263, 897, True)

    imgs = [Image.open(p).crop(CROP) for p in tiles]
    w = CROP[2] - CROP[0]
    hh = (CROP[3] - CROP[1]) + 26                      # 每条留出标题空隙
    out = Image.new('RGB', (w, hh * len(imgs)), (12, 14, 18))
    dr = ImageDraw.Draw(out)
    for i, im in enumerate(imgs):
        y = i * hh
        dr.text((6, y + 6), f'--- device #{i + 1} ---', fill=(150, 160, 175))
        out.paste(im, (0, y + 24))
    out = out.resize((int(w * 1.55), int(out.height * 1.55)), Image.LANCZOS)
    dst = f'{SHOTS}/v11_montage.png'
    out.save(dst)
    print('montage ->', dst, out.size)
    return 0


if __name__ == '__main__':
    sys.exit(main())
