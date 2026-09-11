# .walkthrough — 开发期 GUI/无头测试工具

这些脚本不是应用的一部分，是开发时用来验证 BLE 面板与界面行为的工具集。
**截图等产物不入库**（见 `.gitignore`：`shots/`、`*.bmp`、`*.png`、`__pycache__/`）。

## 最有用的是这两个

| 文件 | 用途 |
|---|---|
| `gen_ble_preview.js` | **前端无头断言集（86 条）**。直接从 `src/index.html` 抽取真实函数/对象丢进 `vm` 沙箱断言，覆盖：设备类型图标表与后端 `ble_device_type` 的跨层一致性、广播内容解析、日志清空时机、写入弹窗、描述符渲染、`pickAdbSerials`/`parseAnsi` 等。**改前端后先跑它**：<br>`node .walkthrough/gen_ble_preview.js` |
| `gui_tool.py` | 窗口自动化基础库：截图（BitBlt）、点击、键盘注入（`press_key`/`type_text`）、滚轮、置顶/还原。被下面的场景脚本共用。 |

> ⚠️ 用 GUI 自动化测本应用前必读：应用会把**窗口尺寸持久化**到
> `%APPDATA%\seahi-serial\config.json`。自动化结束后必须还原（`gui_tool` 里用
> `MoveWindow` 复原），否则用户下次启动的窗口尺寸会被改掉。窗口位置不会被保存。

## 生成器 / 归一化

| 文件 | 用途 |
|---|---|
| `gen_ble_preview.js` | 见上（断言 + 生成 `preview_ble_icons.html` 供肉眼比对图标） |
| `normalize_ble_icons.js` | 把 `src/icons/*.svg` 的 viewBox 收紧到内容包围盒（多路径取并集），避免图标大小不一 |
| `adv_montage.py` | 把多张广播内容截图拼成对照图 |

## 场景脚本（一次性，按需参考）

BLE：`ble_list_shot.py`、`ble_adv_shot.py`、`ble_find_write_char.py`、`ble_reconnect_test.py`、
`ble_fast_reconnect_test.py`、`ble_disc_clear_test.py`、`ble_log_scope_test.py`、`ble_modal_test.py`、
`ble_page_switch_test.py`、`ble_send_test.py`、`ble_sub_reset_test.py`、`ble_ui_check.py`、
`ble_write_cache_test.py`

其它：`win_of_pid.py`（只读枚举某进程的窗口，用于确认应用是否起了窗口）、
`adv_montage.py`、以及若干早期可用性测试脚本。

这些脚本里写死了不少**屏幕坐标**（基于 1263×897 的窗口与当时的界面布局），
界面改版后大概率失效 —— 优先参考 `gen_ble_preview.js` 的无头断言，坐标类脚本按需重写。

## 登录凭据 / 隐私

脚本与截图里可能包含**本机蓝牙设备地址、串口号（如 COM36）、用户名路径**。
截图已排除在版本库外；提交脚本时也请留意别把设备地址等写进源码注释。
