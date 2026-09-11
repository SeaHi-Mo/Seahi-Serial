"""验证 BLE 发送（写入）：

① 沿特征行图标区扫描点击，直到发送栏标签变蓝（= 写入目标已选中）
   —— 用「标签变蓝」作判据，比读文字/猜坐标可靠
② 在发送栏输入内容并回车
③ 截图确认数据日志出现 [目标] / [写入] 记录

前置：设备已连接且服务已展开（ble_find_write_char.py 完成）。
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
LABEL_BOX = (335, 860, 560, 892)      # 发送栏「写入目标」标签区
SEND_INPUT = (800, 876)
ENTER = 0x0D
CAND_Y = [336, 348, 360, 372]         # 特征行可能的 y（逐个试）


def top(h, on):
    g.u.SetWindowPos(h, -1 if on else -2, 0, 0, 0, 0, 0x1 | 0x2 | 0x40)
    time.sleep(0.4)


def label_is_set(path):
    """标签变蓝 = 已选中目标（未选中是灰色 --text-d）"""
    im = Image.open(path).convert('RGB').crop(LABEL_BOX)
    for p in im.getdata():
        r, gg, b = p
        if b > r + 40 and b > 90:
            return True
    return False


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
        g.u.SetCursorPos(r.left + 700, r.top + 620)
        time.sleep(0.4)
        p = f'{SHOTS}/u_{tag}.png'
        g.capture(h, p)
        return p

    # ① 扫描点击图标区，直到目标选中
    hit = None
    for yy in CAND_Y:
        for xx in (1140, 1155, 1170, 1185, 1200, 1215, 1230):
            g.click(r.left + xx, r.top + yy)
            time.sleep(0.7)
            p = snap('scan')
            if label_is_set(p):
                hit = (xx, yy)
                break
        if hit:
            break
    if not hit:
        print('① FAIL 没点到写入图标（标签未变蓝）')
        return 1
    print(f'① 写入目标已选中，图标位置={hit}')

    # ② 输入 + 回车
    g.click(r.left + SEND_INPUT[0], r.top + SEND_INPUT[1])
    time.sleep(0.4)
    g.type_text('aabb')
    time.sleep(0.4)
    p_typed = snap('typed')
    g.press_key(ENTER)
    time.sleep(2.5)
    p_sent = snap('sent')
    print('② 已输入并回车；截图:', p_sent)
    return 0


if __name__ == '__main__':
    sys.exit(main())
