"""写入弹窗完整流程验证（动态定位，不写死坐标）

① 连接设备
② 自动展开 GATT 区里的服务行（「卡片行但没有动作图标」的就是服务行）
③ 找到带动作图标的特征行，点其「写入」图标 → 弹窗应出现
④ 输入 aabb 回车 → 日志应有 [发送]/[发送成功]（截图核对）
⑤ Esc 关闭弹窗 → 应关掉
"""
import ctypes
import sys
import time

sys.path.insert(0, '.walkthrough')
import gui_tool as g
from PIL import Image

wt = g.wt
g.u.SetWindowPos.argtypes = [wt.HWND, wt.HWND, ctypes.c_int, ctypes.c_int,
                             ctypes.c_int, ctypes.c_int, ctypes.c_uint]
g.u.SetWindowPos.restype = wt.BOOL

SHOTS = '.walkthrough/shots'
BTN = (1188, 60)
SEND_BTN_BOX = (700, 400, 900, 620)      # 弹窗底部区域（宽一点，避免位置估计误差）
VALUE_INPUT = (620, 465)


def top(h, on):
    g.u.SetWindowPos(h, -1 if on else -2, 0, 0, 0, 0, 0x1 | 0x2 | 0x40)
    time.sleep(0.4)


def is_ble_panel(path):
    im = Image.open(path).convert('RGB')
    hits = 0
    for pt in ((250, 57), (252, 65), (304, 65)):
        r, gg, b = im.getpixel(pt)
        if b > r + 60 and b > 150:
            hits += 1
    return hits >= 2


def btn_connected(path):
    im = Image.open(path).convert('RGB')
    hits = 0
    for pt in ((1190, 49), (1210, 49), (1190, 67), (1210, 67)):
        r, gg, b = im.getpixel(pt)
        if b > r + 60 and b > 150:
            hits += 1
    return hits >= 2


def modal_open(path):
    im = Image.open(path).convert('RGB').crop(SEND_BTN_BOX)
    n = sum(1 for r, gg, b in im.getdata() if b > r + 60 and b > 150)
    return n > 150


def gatt_rows(path):
    """返回 GATT 区的卡片行：[(y_center, 图标x中心列表)]，按 y 排序"""
    im = Image.open(path).convert('RGB')
    rows = []
    y = 130
    while y < 700:
        if im.getpixel((700, y)) == (46, 49, 56):
            a = y
            while y < 700 and im.getpixel((700, y)) == (46, 49, 56):
                y += 1
            b = y - 1
            if b - a >= 10:
                cy = (a + b) // 2
                cols = {}
                for yy in range(a, b + 1):
                    for x in range(1100, 1245):
                        r, gg, bb = im.getpixel((x, yy))
                        if (r + gg + bb) > 330:
                            cols[x] = cols.get(x, 0) + 1
                xs = sorted(cols)
                runs = []
                if xs:
                    s = xs[0]; p = xs[0]
                    for x in xs[1:]:
                        if x - p > 5:
                            runs.append((s, p)); s = x
                        p = x
                    runs.append((s, p))
                rows.append((cy, [(p1 + p2) // 2 for p1, p2 in runs]))
        y += 1
    return rows


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
        g.u.SetCursorPos(r.left + 700, r.top + 700)
        time.sleep(0.5)
        p = f'{SHOTS}/d_{tag}.png'
        g.capture(h, p)
        return p

    # ① 面板 + 扫描 + 连接
    for i in range(3):
        if is_ble_panel(snap('open')):
            break
        click((207, 15), 2.2)
    click((278, 61), 11.0)
    for _ in range(3):
        if not btn_connected(snap('pre')):
            break
        click(BTN, 2.5)
    for i in range(8):
        click((160, 143 + i * 57), 1.0)
        click(BTN, 6.0)
        if btn_connected(snap(f'conn{i}')):
            print(f'① 已连接第 {i + 1} 台')
            break
    else:
        print('① FAIL 没连上')
        return 1

    # ② 逐行检查：没图标的卡片行 = 服务行 → 点开；带图标的 = 特征行 → 记下来
    char_row = None
    for _ in range(3):                     # 最多三轮（展开会改变布局）
        p = snap('rows')
        rows = gatt_rows(p)
        print('   卡片行:', [(cy, len(xs)) for cy, xs in rows])
        svc_rows = [cy for cy, xs in rows if not xs]
        icon_rows = [(cy, xs) for cy, xs in rows if len(xs) >= 2]
        if icon_rows:
            char_row = icon_rows[0]
            break
        if not svc_rows:
            break
        click((400, svc_rows[0]), 1.2)     # 展开第一个还没展开的服务行
    if not char_row:
        print('② FAIL 没找到带图标的特征行')
        p = snap('norow')
        return 1
    cy, xs = char_row
    print(f'② 特征行 y={cy}，图标 x={xs}')

    # ③ 点写入图标（第 2 个）→ 弹窗
    opened = False
    for xx in ([xs[1]] if len(xs) > 1 else []) + xs[:3]:
        click((xx, cy), 1.3)
        p = snap('modal')
        if modal_open(p):
            opened = True
            break
    if not opened:
        print('③ FAIL 弹窗未打开')
        return 1
    print('③ 弹窗已打开')

    # ④ 输入 + 回车
    click(VALUE_INPUT, 0.5)
    g.type_text('aabb')
    time.sleep(0.4)
    g.press_key(0x0D)
    time.sleep(2.5)
    snap('sent')
    print('④ 已发送（截图 d_sent.png）')

    # ⑤ Esc 关闭
    g.press_key(0x1B)
    time.sleep(1.2)
    p = snap('closed')
    print('⑤ Esc 后弹窗仍开着:', modal_open(p), '（应为 False）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
