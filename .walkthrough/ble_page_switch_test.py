"""验证「切到其他页面再切回来，连接是否还在」

- 连接一台设备后切到串口页，停留 40s 再切回；
- 用后端日志判断连接是否被系统回收（ble_get_connection 会记录 is_connected=false）；
- 并检查回来后「断开设备」按钮是否仍为蓝色（= 仍连接）。
"""
import ctypes
import re
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
LOG = r'D:\Users\Seahi\AppData\Local\Temp\seahi-serial-debug.log'
BTN = (1188, 60)
AWAY_SEC = 150


def top(h, on):
    g.u.SetWindowPos(h, -1 if on else -2, 0, 0, 0, 0, 0x1 | 0x2 | 0x40)
    time.sleep(0.4)


def log_text():
    try:
        with open(LOG, 'r', encoding='utf-8', errors='ignore') as f:
            return f.read()
    except OSError:
        return ''


def rssi_lines(txt):
    return len(re.findall('ble_refresh_rssi', txt))


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
        p = f'{SHOTS}/y2_{tag}.png'
        g.capture(h, p)
        return p

    # ① 蓝牙面板 + 扫描
    for i in range(3):
        if is_ble_panel(snap('open')):
            break
        click((207, 15), 2.2)
    click((278, 61), 11.0)

    # ② 先确保处于「未连接」（按钮非蓝底）；连接态一律以按钮颜色为准，不用日志猜
    for _ in range(3):
        p = snap('pre')
        if not btn_connected(p):
            break
        print('   起始是连接态，先断开')
        click(BTN, 2.5)
    else:
        print('① FAIL 无法回到未连接状态')
        return 2

    # ③ 依次尝试设备直到连上（判定依据：按钮变蓝）
    ok = False
    for i in range(8):
        click((160, 143 + i * 57), 1.0)
        click(BTN, 6.0)
        p = snap(f'conn{i}')
        if btn_connected(p):
            ok = True
            print(f'① 第 {i + 1} 台设备连接成功（按钮蓝底）')
            break
    if not ok:
        print('① FAIL 没连上')
        return 2

    # ④ 切到串口页，停留 AWAY_SEC 秒
    t0 = log_text()
    click((207, 15), 2.0)          # → 串口页
    print(f'② 已切到串口页，停留 {AWAY_SEC}s ...')
    time.sleep(AWAY_SEC)
    mid = log_text()
    cleared = 'is_connected=false' in mid[len(t0):]
    print(f'   离开期间 RSSI 轮询新增={rssi_lines(mid) - rssi_lines(t0)} 行；'
          f'后端记录到 is_connected=false: {cleared}')

    # ⑤ 切回蓝牙页
    click((207, 15), 3.0)
    p = snap('back')
    conn = btn_connected(p)
    after = log_text()
    print(f'③ 切回后 按钮蓝底={conn}（True=仍连接）；期间 RSSI 新增='
          f'{rssi_lines(after) - rssi_lines(mid)} 行')
    print('③ 结论:', '连接保持' if conn else '连接已断开')
    return 0 if conn else 1


if __name__ == '__main__':
    sys.exit(main())
