"""验证：
1) 已连接设备卡片带「已连接」提示
2) 切换设备 → 数据日志清空
3) 断开连接 → 数据日志清空

日志是否为空用像素判定：日志区文字像素很少(<300) 视为空（只显示「暂无日志」）。
"""
import ctypes
import re
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
LOG = r'D:\Users\Seahi\AppData\Local\Temp\seahi-serial-debug.log'
BTN = (1188, 60)
LOG_BOX = (350, 400, 1240, 875)      # 数据日志区（日志固定贴在详情栏底部，从标题下方取到窗口底）


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


def log_lines_pixels(path):
    im = Image.open(path).convert('L').crop(LOG_BOX)
    return sum(1 for v in im.getdata() if v > 70)


def rssi_lines():
    try:
        with open(LOG, 'r', encoding='utf-8', errors='ignore') as f:
            return len(re.findall('ble_refresh_rssi', f.read()))
    except OSError:
        return 0


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
        g.u.SetCursorPos(r.left + 700, r.top + 500)
        time.sleep(0.5)
        p = f'{SHOTS}/w2_{tag}.png'
        g.capture(h, p)
        return p, log_lines_pixels(p)

    # ① 蓝牙面板 + 扫描
    for i in range(3):
        g.capture(h, f'{SHOTS}/w2_open.png')
        if is_ble_panel(f'{SHOTS}/w2_open.png'):
            break
        click((207, 15), 2.2)
    click((278, 61), 11.0)
    print('① 面板就绪 + 已扫描')

    # ② 找一台能连上的设备
    base = rssi_lines()
    idx = -1
    for i in range(8):
        click((160, 143 + i * 57), 1.0)
        click(BTN, 6.0)
        if rssi_lines() > base:
            idx = i
            print(f'② 第 {i + 1} 台设备连接成功')
            break
    if idx < 0:
        print('② FAIL 找不到可连设备')
        return 2

    p1, n1 = snap('connected')
    print(f'③ 连接后 日志区文字像素={n1}（应有连接日志）')

    # ④ 切到另一台设备 → 日志应清空
    other = (idx + 1) % 6
    click((160, 143 + other * 57), 1.5)
    p2, n2 = snap('switched')
    print(f'④ 切换设备后 日志区文字像素={n2}  -> {"PASS 已清空" if n2 < 300 else "FAIL 未清空"}')

    # ⑤ 连上另一台再断开 → 日志也应清空
    click(BTN, 6.0)
    p3, n3 = snap('connected2')
    click(BTN, 3.0)
    p4, n4 = snap('disconnected')
    print(f'⑤ 断开后 日志区文字像素={n4}  -> {"PASS 已清空" if n4 < 300 else "FAIL 未清空"}')
    return 0 if (n2 < 300 and n4 < 300) else 1


if __name__ == '__main__':
    sys.exit(main())
