"""验证 GATT 缓存修复：正常发送 + 断开重连后再发送都要成功

判定：右上角 toast 颜色（成功=绿 / 失败=红）
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
TOAST_BOX = (980, 28, 1263, 105)
VALUE_INPUT = (600, 441)


def top(h, on):
    g.u.SetWindowPos(h, -1 if on else -2, 0, 0, 0, 0, 0x1 | 0x2 | 0x40)
    time.sleep(0.4)


def is_panel(p):
    im = Image.open(p).convert('RGB')
    return sum(1 for pt in ((250, 57), (252, 65), (304, 65))
               if im.getpixel(pt)[2] > im.getpixel(pt)[0] + 60 and im.getpixel(pt)[2] > 150) >= 2


def is_conn(p):
    im = Image.open(p).convert('RGB')
    return sum(1 for pt in ((1190, 49), (1210, 49), (1190, 67), (1210, 67))
               if im.getpixel(pt)[2] > im.getpixel(pt)[0] + 60 and im.getpixel(pt)[2] > 150) >= 2


def modal_open(p):
    """弹窗打开时底部有蓝底「发送」按钮（比用亮度判断可靠）"""
    im = Image.open(p).convert('RGB')
    n = 0
    for x in range(600, 900, 4):
        for y in range(430, 560, 4):
            r, gg, b = im.getpixel((x, y))
            if b > r + 60 and b > 150:
                n += 1
    return n > 50


def toast(p):
    im = Image.open(p).convert('RGB').crop(TOAST_BOX)
    green = red = 0
    for r, gg, b in im.getdata():
        if gg > r + 25 and gg > b + 25 and gg > 90:
            green += 1
        elif r > gg + 25 and r > b + 25 and r > 90:
            red += 1
    return 'success' if green > 300 else ('error' if red > 300 else 'none')


def find_write_icon(p):
    """在 GATT 区找「缩进的」特征行，返回 (写入图标x, 行y)

    服务行与特征行都可能出现亮像素（服务行右侧有 "Service" 文字），
    用卡片左边缘的缩进量区分：服务行贴着左边，特征行缩进约 12px。
    """
    im = Image.open(p).convert('RGB')
    best = None
    for a in range(150, 700, 2):
        cy = a + 8
        cols = {}
        for y in range(a, a + 18):
            for x in range(1100, 1250):
                r, gg, b = im.getpixel((x, y))
                if (r + gg + b) > 330:
                    cols[x] = cols.get(x, 0) + 1
        xs = sorted(cols)
        runs = []
        if xs:
            s = xs[0]; pr = xs[0]
            for x in xs[1:]:
                if x - pr > 5:
                    runs.append((s, pr)); s = x
                pr = x
            runs.append((s, pr))
        # 丢掉 1~3px 的窄条（卡片右边框之类），只留图标大小的簇
        runs = [r for r in runs if r[1] - r[0] >= 4]
        # 服务行右侧只有 "Service" 文字（2 簇），特征行有 3 个动作图标
        if len(runs) >= 3 and (best is None or len(runs) > best[0]):
            best = (len(runs), [(a2 + b2) // 2 for a2, b2 in runs], cy)
    if not best:
        return None
    return best[1][1], best[2]      # 第 2 个图标 = 写入


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

    def click(pt, w):
        g.click(r.left + pt[0], r.top + pt[1]); time.sleep(w)

    def snap(tag):
        g.u.SetCursorPos(r.left + 700, r.top + 700)
        time.sleep(0.5)
        p = f'{SHOTS}/n_{tag}.png'
        g.capture(h, p)
        return p

    def send_once(tag):
        """展开服务 → 点写入图标 → 输入 0102 → 回车 → 返回 toast 判定"""
        p = snap(tag + '_before')
        info = find_write_icon(p)
        if not info:
            click((400, 306), 1.5)          # 展开第 4 个服务
            p = snap(tag + '_expanded')
            info = find_write_icon(p)
        if not info:
            print(f'   [{tag}] 找不到写入图标')
            return 'none'
        wx, wy = info
        # 首次点击可能被「窗口激活」吃掉；另外图标可点区域比视觉中心略高，y 微调重试
        opened = False
        for dy in (0, -4, -8, 4):
            for attempt in range(2):
                click((wx, wy + dy), 1.4)
                if modal_open(snap(f'{tag}_m{dy}_{attempt}')):
                    opened = True
                    break
            if opened:
                break
        if not opened:
            print(f'   [{tag}] 弹窗未打开（尝试坐标 {wx},{wy}）')
            return 'none'
        # 弹窗打开时输入框会自动聚焦 —— 直接输入，别点它（点偏会把焦点弄丢/关掉弹窗）
        for ch in '0102':
            g.press_key(ord(ch)); time.sleep(0.12)
        g.press_key(0x0D)
        time.sleep(2.5)
        res = toast(snap(tag + '_sent'))
        g.press_key(0x1B)                    # 关掉弹窗
        time.sleep(0.8)
        return res

    # ① 面板 + 扫描 + 连接
    for i in range(3):
        if is_panel(snap('open')):
            break
        click((207, 15), 2.2)
    click((278, 61), 11.0)
    for _ in range(3):
        if not is_conn(snap('pre')):
            break
        click(BTN, 2.5)
    for i in range(8):
        click((160, 143 + i * 57), 1.0)
        click(BTN, 6.0)
        if is_conn(snap(f'c{i}')):
            print(f'① 已连接第 {i + 1} 台')
            break
    else:
        print('① FAIL 没连上')
        return 2

    # ② 正常发送
    r1 = send_once('send1')
    print(f'② 首次连接后发送: {r1}')

    # ③ 断开 → 立刻重连（走「复用保留外设对象」路径）→ 再发送
    click(BTN, 3.0)
    click(BTN, 7.0)
    r2 = send_once('send2')
    print(f'③ 重连后发送: {r2}')
    return 0 if (r1 == 'success' and r2 == 'success') else 1


if __name__ == '__main__':
    sys.exit(main())
