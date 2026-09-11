"""日志驱动的重连验证。

附近设备多是随机地址的「幽灵」（connect 报 Device not found），
所以不靠肉眼/像素判断谁连得上，而是：
- 用后端调试日志里的 ble_refresh_rssi 行数判断「是否处于已连接」（连接期间每 3s 一行）
- 依次尝试前若干台设备，找到第一台能连上的
- 然后断开 → 立刻重连，检查日志里是否走了「复用上次断开保留的外设对象」这条路
"""
import ctypes
import re
import sys
import time

sys.path.insert(0, '.walkthrough')
import gui_tool as g

wt = g.wt
g.u.SetWindowPos.argtypes = [wt.HWND, wt.HWND, ctypes.c_int, ctypes.c_int,
                             ctypes.c_int, ctypes.c_int, ctypes.c_uint]
g.u.SetWindowPos.restype = wt.BOOL

LOG = r'D:\Users\Seahi\AppData\Local\Temp\seahi-serial-debug.log'
BTN = (1188, 60)
SHOTS = '.walkthrough/shots'


def log_text():
    try:
        with open(LOG, 'r', encoding='utf-8', errors='ignore') as f:
            return f.read()
    except OSError:
        return ''


def rssi_lines(txt):
    return len(re.findall(r'ble_refresh_rssi', txt))


def top(h, on):
    g.u.SetWindowPos(h, -1 if on else -2, 0, 0, 0, 0, 0x1 | 0x2 | 0x40)
    time.sleep(0.4)


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

    # ① 打开面板 + 扫描
    click((207, 15), 2.5)
    click((278, 61), 11.0)

    base = rssi_lines(log_text())
    print(f'① 起始 RSSI 日志行数={base}')

    # ② 依次尝试设备，找到能连上的
    found = -1
    for idx in range(12):
        click((160, 143 + idx * 57), 1.2)      # 选中第 idx+1 台
        click(BTN, 7.0)                        # 连接
        if rssi_lines(log_text()) > base:      # 出现 RSSI 轮询 = 已连接
            found = idx
            print(f'② 第 {idx + 1} 台设备连接成功')
            break
    if found < 0:
        print('② FAIL 前 12 台设备都连不上（环境里没有可连设备）')
        g.capture(h, f'{SHOTS}/q_no_device.png')
        return 2

    # ③ 断开 → 立刻重连（模拟用户操作；旧实现这里会报「未找到该设备」）
    before = log_text()
    click(BTN, 1.2)                            # 断开
    m = re.search(r'ble_connect: (\S+) 不在适配器表内', log_text()[len(before):])
    click(BTN, 8.0)                            # 立刻重连
    after = log_text()
    new = after[len(before):]

    reused = '复用上次断开保留的外设对象' in new
    rescan = '不在适配器表内' in new
    connected_again = rssi_lines(after) > rssi_lines(before)
    print(f'③ 重连后新增 RSSI 行数={rssi_lines(after) - rssi_lines(before)}  '
          f'走「复用保留外设」={reused}  走「短扫描重试」={rescan}')
    g.u.SetCursorPos(r.left + 700, r.top + 500)
    time.sleep(0.4)
    g.capture(h, f'{SHOTS}/q_reconnected.png')

    ok = connected_again
    print('③ 结果:', '成功' if ok else '失败')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
