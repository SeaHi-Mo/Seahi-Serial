"""实机验证「断开后重连」与订阅状态复位。

每步都用截图校验并自动重试：
- 面板是否打开      → 与串口视图的整体差异
- 扫描是否有设备    → 左侧列表里卡片底色像素数
- 是否已连接        → 详情头部「连接设备/断开设备」按钮的背景色（已连接为蓝底）
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
BTN = (1188, 60)          # 详情头部「连接设备/断开设备」按钮中心（窗口坐标）
LIST_BOX = (14, 100, 318, 700)
CARD_RGB = (46, 49, 56)


def top(h, on):
    g.u.SetWindowPos(h, -1 if on else -2, 0, 0, 0, 0, 0x1 | 0x2 | 0x40)
    time.sleep(0.4)


def mean_diff(p1, p2):
    a = Image.open(p1).convert('RGB')
    b = Image.open(p2).convert('RGB')
    return sum(ImageStat.Stat(ImageChops.difference(a, b)).mean) / 3


def card_pixels(path):
    im = Image.open(path).convert('RGB').crop(LIST_BOX)
    return sum(1 for p in im.getdata() if p == CARD_RGB)


def btn_is_connected(path):
    """按钮蓝底 = 已连接。实测按钮范围 x1178..1237 / y47..69，
    文字占了中间大部分，故取上下边缘取样（避开白色文字）。
    注意：截图前必须把鼠标移开，否则 hover 高亮会被误判为已连接。"""
    im = Image.open(path).convert('RGB')
    hits = 0
    for pt in ((1190, 49), (1210, 49), (1190, 67), (1210, 67)):
        r, gg, b = im.getpixel(pt)
        if b > r + 60 and b > 150:
            hits += 1
    return hits >= 2


def is_ble_panel(path):
    """蓝牙面板的正向判据：「开始扫描」按钮的蓝底 (74,122,181)；
    串口页同位置是 (46,49,56)。取样点实测标定过，避开按钮上的白色文字。"""
    im = Image.open(path).convert('RGB')
    hits = 0
    for pt in ((250, 57), (252, 65), (304, 65)):
        r, gg, b = im.getpixel(pt)
        if b > r + 60 and b > 150:
            hits += 1
    return hits >= 2


def main():
    wins = g.find_app()
    if not wins:
        print('NO_APP_WINDOW')
        return 1
    h, title = wins[0]
    o = g.rect_of(h)
    ox, oy = o.left, o.top
    g.u.MoveWindow(h, 0, 0, 1263, 897, True)
    top(h, True)
    time.sleep(0.8)
    # 无论从哪条路径退出，都把窗口恢复原状（避免异常时留在置顶/挪位状态）
    import atexit
    atexit.register(lambda: (top(h, False), g.u.MoveWindow(h, ox, oy, 1263, 897, True)))
    r = g.rect_of(h)

    for _ in range(2):
        g.click(r.left + 700, r.top + 500)
        time.sleep(0.7)
    base = f'{SHOTS}/y_base.png'
    g.capture(h, base)

    # ① 打开 BLE 面板（正向判据：看到「开始扫描」蓝底即认为已打开）
    for i in range(3):
        g.click(r.left + 207, r.top + 15)
        time.sleep(2.2)
        cur = f'{SHOTS}/y_open.png'
        g.capture(h, cur)
        if is_ble_panel(cur):
            print(f'① BLE 面板已打开 (第{i + 1}次)')
            break
    else:
        print('① FAIL 面板未打开')
        top(h, False)
        g.u.MoveWindow(h, ox, oy, 1263, 897, True)
        return 1

    # ② 扫描，校验列表出现卡片
    ok = False
    for i in range(3):
        r = g.rect_of(h)
        g.click(r.left + 278, r.top + 61)
        time.sleep(11.0)
        g.capture(h, f'{SHOTS}/y_scan{i}.png')
        n = card_pixels(f'{SHOTS}/y_scan{i}.png')
        print(f'② 扫描第{i + 1}次：卡片像素={n}')
        if n > 3000:
            ok = True
            break
    if not ok:
        print('② FAIL 列表仍为空')
        return 1

    def click_btn(tag, wait):
        r = g.rect_of(h)
        g.click(r.left + BTN[0], r.top + BTN[1])
        time.sleep(wait)
        g.u.SetCursorPos(r.left + 700, r.top + 500)   # 移开鼠标，避免 hover 干扰按钮判定
        time.sleep(0.4)
        p = f'{SHOTS}/y_{tag}.png'
        g.capture(h, p)
        print(f'   {tag}: 按钮蓝底={btn_is_connected(p)}')
        return p

    # ③ + ④ 依次尝试前几台设备，直到有一台能连上
    # （列表里混有随机地址的「幽灵」设备，连它会报 Device not found，属设备层面）
    ok = False
    for idx in range(5):
        r = g.rect_of(h)
        g.click(r.left + 160, r.top + 143 + idx * 57)
        time.sleep(1.2)
        p = click_btn(f'connect{idx}', 6.0)
        if btn_is_connected(p):
            print(f'③④ 第 {idx + 1} 台设备连接成功')
            ok = True
            break
    if not ok:
        print('④ FAIL 前 5 台设备都连不上')
        return 1

    # ⑤ 断开
    p = click_btn('disconnect', 3.0)
    if btn_is_connected(p):
        print('   注意: 断开后按钮仍为蓝底，再点一次')
        p = click_btn('disconnectb', 3.0)
    if btn_is_connected(p):
        print('⑤ FAIL 断开无效')
        return 1
    print('⑤ 已断开（按钮恢复「连接设备」）')

    # ⑥ 再次连接 —— 原 bug 点（曾报「未找到该设备」）
    p = click_btn('reconnect', 9.0)
    if not btn_is_connected(p):
        print('   注意: 重连未成功，再试一次')
        p = click_btn('reconnectb', 9.0)
    print('⑥ 重连结果:', '成功' if btn_is_connected(p) else '失败')
    if not btn_is_connected(p):
        return 1

    # ⑦ 快节奏再走一轮：断开后 0.8s 立刻重连（模拟用户实际操作，原来这里必失败）
    p = click_btn('fast_disconnect', 0.8)
    if btn_is_connected(p):
        print('   注意: 快节奏断开未生效，再点一次')
        p = click_btn('fast_disconnectb', 0.8)
    p = click_btn('fast_reconnect', 8.0)
    if not btn_is_connected(p):
        p = click_btn('fast_reconnectb', 8.0)
    fast_ok = btn_is_connected(p)
    print('⑦ 断开后 0.8s 立刻重连:', '成功' if fast_ok else '失败')

    # 滚到数据日志截图
    g.wheel(r.left + 1100, r.top + 500, -6)
    time.sleep(0.8)
    g.capture(h, f'{SHOTS}/y_log.png')

    top(h, False)
    g.u.MoveWindow(h, ox, oy, 1263, 897, True)
    return 0 if fast_ok else 1


if __name__ == '__main__':
    sys.exit(main())
