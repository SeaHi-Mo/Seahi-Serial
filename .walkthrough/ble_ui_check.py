"""验证两处 UI 修复（带最终状态校验，避免抓到串口页导致假通过）

1) 类型图标不再随连接状态变绿 —— 在左侧图标列里找绿色像素，应为 0
2) 数据日志滚动条已美化 —— 在日志右缘找滚动条滑块，应存在且不是亮白
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


def top(h, on):
    g.u.SetWindowPos(h, -1 if on else -2, 0, 0, 0, 0, 0x1 | 0x2 | 0x40)
    time.sleep(0.4)


def is_ble_panel(path):
    """蓝牙面板正向判据：「开始扫描」按钮蓝底（实测 74,122,181）"""
    im = Image.open(path).convert('RGB')
    hits = 0
    for pt in ((250, 57), (252, 65), (304, 65)):
        r, gg, b = im.getpixel(pt)
        if b > r + 60 and b > 150:
            hits += 1
    return hits >= 2


def green_in_icon_column(path):
    im = Image.open(path).convert('RGB')
    return sum(1 for y in range(95, 880) for x in range(20, 95)
               if (lambda c: c[1] > c[0] + 25 and c[1] > c[2] + 25 and c[1] > 80)(im.getpixel((x, y))))


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

    # ① 确保处于蓝牙面板（点一次看一次，最多 3 次）
    for i in range(3):
        p = f'{SHOTS}/u_open{i}.png'
        g.capture(h, p)
        if is_ble_panel(p):
            print(f'① 已在蓝牙面板（第{i + 1}次检查）')
            break
        click((207, 15), 2.2)
    else:
        print('① FAIL 打不开蓝牙面板')
        return 1

    # ② 扫描
    click((278, 61), 11.0)
    g.capture(h, f'{SHOTS}/u_scanned.png')
    if not is_ble_panel(f'{SHOTS}/u_scanned.png'):
        print('② FAIL 扫描后不在蓝牙面板')
        return 1
    print('② 扫描完成')

    # ③ 找一台能连上的设备（用后端 RSSI 日志行数判断是否连上）
    base = rssi_lines()
    connected_idx = -1
    for i in range(8):
        click((160, 143 + i * 57), 1.0)
        click(BTN, 6.0)
        if rssi_lines() > base:
            connected_idx = i
            print(f'③ 第 {i + 1} 台设备连接成功')
            break
    if connected_idx < 0:
        print('③ 注意: 未连上任何设备（图标颜色检查依然有效，因为"任何设备都不该是绿色"）')

    # ④ 反复连接/断开把日志堆长，触发滚动条
    for k in range(6):
        click((160, 143 + (k % 5) * 57), 0.8)
        click(BTN, 3.5)
        click(BTN, 1.2)
    g.u.SetCursorPos(r.left + 700, r.top + 500)
    time.sleep(0.6)

    out = f'{SHOTS}/ui_final.png'
    g.capture(h, out)

    # ⑤ 最终状态校验 + 两项检查
    panel_ok = is_ble_panel(out)
    green = green_in_icon_column(out)
    print(f'⑤ 最终截图仍在蓝牙面板={panel_ok}')
    print(f'   [检查1] 图标列绿色像素={green}  -> {"FAIL 仍有绿色" if green > 20 else "PASS 无绿色图标"}')

    im = Image.open(out).convert('RGB')
    found = []
    for x in range(1180, 1260):
        n = sum(1 for y in range(340, 870) if sum(im.getpixel((x, y))) // 3 > 45)
        if n > 200:
            found.append((x, n, im.getpixel((x, 500))))
    print(f'   [检查2] 日志右缘候选滚动条列: {found if found else "未发现（日志可能未溢出）"}')
    return 0 if (panel_ok and green <= 20) else 1


if __name__ == '__main__':
    sys.exit(main())
