# BLE 从机（外设 / GATT Server）模式 —— **已归档（该方向已删除）**

> ## ⛔ 归档：做不出来，整条方向已删除（2026-09 / v0.5.10）
>
> **结论**：本机适配器（Intel 集成蓝牙）自报 `present=true / low_energy=true / peripheral_role=true`，
> GATT 服务与特征**建得出来**（`ble_periph_builds` 通过），但 `StartAdvertisingWithParameters` 的
> 落定状态是 **Aborted** —— **广播起不来**，中心设备永远发现不了本机，整条从机链路因此没有意义。
> 用户据此拍板："从机方向的代码删除，确认是实现不了了。"
>
> **删了什么**：`main.rs` 的从机模块与 `ble_periph_tests`（含上面那三条 `#[ignore]` 真机/诊断用例）、
> 9 个 `ble_periph_*` 命令与托管状态、MCP 的 3 个工具（含 `DANGER_TOOLS` 条目）、前端的从机模式 UI
> 与配置键。详细清单见 `doc/MCP_DESIGN.md` §17 的 2026-09-17 一条。
>
> **本文因此不再是功能文档**，而是"为什么不行"的**证据记录**（下面各节保留了三条诊断用例打印过的
> 环境 / 权限 / 能力位 / 真实广播结果，以及平台限制清单）。**要重开这个方向，先解决广播**；
> 在那之前不要往这里加功能。本应用现在的 BLE 能力只有**主机方向**（见 `BLE_VERIFICATION.md`）。

> 对应需求：「评估 BLE 主机功能，并让本应用自己也能作为 BLE 从机被搜索到、连接调试」。
> 主机（Central）方向的现状与验证见 `BLE_VERIFICATION.md`；本文只讲**从机**方向。
> 最近更新：2026-09（**已归档**）

## 1. 为什么不用 btleplug

`btleplug` 是 **central-only** 的库：它只有 Central（扫描 / 连接 / 做 GATT 客户端）这一半，
没有任何外设角色 API。做从机只能直接用 WinRT：

| 能力 | WinRT 类型 |
|---|---|
| 注册本地 GATT 服务 | `GattServiceProvider` / `GattLocalService` |
| 建本地特征 | `GattLocalCharacteristicParameters` + `GattLocalService::CreateCharacteristicAsync` |
| 被主机读 | `GattLocalCharacteristic::ReadRequested` → `GattReadRequest::RespondWithValue` |
| 收主机写入 | `GattLocalCharacteristic::WriteRequested` → `GattWriteRequest::Respond` |
| 主机订阅 / 退订 | `GattLocalCharacteristic::SubscribedClientsChanged` |
| 主动下发 | `GattLocalCharacteristic::NotifyValueAsync` |
| 开始 / 停止广播 | `GattServiceProviderAdvertisingParameters` + `StartAdvertisingWithParameters` / `StopAdvertising` |
| 适配器能力探测 | `BluetoothAdapter::GetDefaultAsync` + `IsLowEnergySupported` / `IsPeripheralRoleSupported` / `GetRadioAsync` |

对应 `src-tauri/Cargo.toml` 里 `windows` crate 新增的 feature：
`Devices_Bluetooth_GenericAttributeProfile`、`Storage_Streams`（特征值的 `IBuffer` 与 `DataReader`/`DataWriter` 互转）、
`Devices_Radios`（探测蓝牙开关状态）。

## 2. 代码位置

| 位置 | 内容 |
|---|---|
| `src-tauri/src/main.rs` → `/* ===== BLE 从机（Peripheral / GATT Server，WinRT） ===== */` | 整个从机后端（状态、命令、纯函数） |
| `src-tauri/src/main.rs` → `mod ble_periph_tests` | 从机单测与两条真机冒烟 |
| `src-tauri/src/main.rs` → `fn ble_hex` | 由原来的 `fn main()` 内提到模块级（从机模块与主机模块共用） |
| `src/index.html` → `/* ===== BLE 从机（外设）模式 ===== */` | 前端从机面板全部逻辑 |
| `src/index.html` → `.ble-mode-bar` / `.ble-periph` 等样式 | 模式切换栏与从机面板样式 |

> ⚠ 结构说明：原 BLE（主机）代码整体嵌在 `fn main()` 里（`AGENTS.md` 旧描述提到过）。
> 从机模块**没有**沿用这个结构 —— 它放在模块级，因为 `#[cfg(test)] mod` 在被嵌进函数体时
> 无法用 `super::*` 访问同级项（函数体不是模块），会直接编译失败。新增 BLE 代码请放模块级。

## 3. 后端接口

`BlePeripheralState` 持有 `provider` / `service_uuid` / `chars` / `adapter` / `events` / `running`。
WinRT 的 GATT 对象在本版绑定里都是 `Send + Sync`，可以直接放进 Tauri state。

| 命令 | 说明 |
|---|---|
| `ble_periph_start(serviceUuid, characteristics[], discoverable, connectable, advData, manualReply)` | 建服务 + 特征并开始广播；重复调用会先收掉上一个。`characteristics[]` 每项可带 `descriptors[{uuid,value}]` |
| `ble_periph_stop()` | 停止广播、释放服务注册，并把待应答的写请求全部按协议错误回掉 |
| `ble_periph_status()` | `{running, advertising, advertising_status, warning, adapter{...}, manual_write_reply, pending_writes, service_uuid, characteristics[{uuid,props,value_hex,subscribed,max_notify,descriptors}]}` |
| `ble_periph_set_value(charUuid, data)` | 改主机能读到的值；**特征不可读时直接报错**（主机读不到，设了没意义） |
| `ble_periph_respond_write(pendingId, accept, protocolError)` | 对挂起的写请求作出决定：接受，或按协议错误码（默认 `0x80`）拒绝 |
| `ble_periph_notify(charUuid, data)` | 向已订阅主机下发通知；无订阅者时明确报错；超过单次上限（= 协商 MTU − 3）时本地就挡住并提示"拆成多包" |
| `ble_periph_poll_events()` | 取走事件（写入 / 读取 / 订阅 / 广播状态 / 应答），前端 500ms 轮询 |

### 几个容易踩的细节（都已处理，改代码时别退回去）

| 细节 | 处理方式 |
|---|---|
| **写入应答** | 默认自动接受；打开「写入需手动应答」后，写请求会挂起（`pending_id`）等界面点接受/拒绝，**20 秒无人应答则自动按协议错误 `0x80` 回复** —— 不能让主机一直挂着 |
| **长写 `Offset`** | `ble_periph_apply_write` 按 offset 落值。忽略 offset 会把长写的多段当成互相覆盖的独立写入，值直接写乱 |
| **标准描述符** | `0x2900~0x290F`（用户描述 / CCCD / 表示格式等）**由系统自动发布，不能手工创建**。真机实测 0x2901 会返回"该 uuid 已保留，将由系统自动发布 (0x80070057)"，所以本地就拦掉并说明该改用厂商自定义 UUID |
| **导入描述符** | 界面格式：`UUID=值`，多个用 `;` 或换行分隔；值默认按 HEX，加 `T:` 前缀按 UTF-8 文本（`2901=T:温度计`） |
| **广播服务数据长度** | 传统广播总共 31 字节。超过 24 字节时界面给"偏长"提示；真被截断时后端会返回 `StartedWithoutAllAdvertisementData`，界面按**提示级**（非阻断）告警说明"部分数据没发出去" |
| **只支持一个服务** | 一个 `GattServiceProvider` 只能广播它自己那一个服务 UUID —— 这句话现在写在界面上（就在服务 UUID 输入框旁边），不再只躺在注释里 |
| **多套配置** | 「我的配置」可保存 / 载入 / 删除整表单，随用户配置文件持久化 |

**`running` 与 `advertising` 是两件事**，必须分开看：

- `running` = GATT 服务已经建好（不需要射频也能建出来，实测如此）；
- `advertising` = 真的在对外广播。

`StartAdvertisingWithParameters` 返回 `Ok` **不代表在广播**。判定全靠 `advertising` 与
`advertising_status`；不成立时 `warning` 会给出原因。告警优先级是
**适配器能力 > 广播状态码** —— 否则用户会照着 `Aborted` 去查"是不是被别的程序占了"，方向就错了。

## 4. 平台限制（不是缺陷）

1. **广播里的设备名由 Windows 决定** —— 手机扫到的是本机蓝牙名称（电脑名），
   `GattServiceProvider` 改不了它。界面上已写明这一点，避免用户一直找设置项。
2. **一个服务提供者只广播它自己那一个服务 UUID**。当前实现是 1 个服务 + 最多 16 个特征。
3. **没有主机订阅时 `NotifyValueAsync` 无处可发**。后端在订阅数为 0 时直接报错，不静默成功。
4. **同一个服务 UUID 同一时刻只能被一个进程持有**。重复「开始广播」时先 `StopAdvertising`
   再重建；Windows 偶尔晚一拍才释放，故建服务失败会等 300ms 重试一次。
5. **读 / 写一律用 `Plain` 保护级别**（不做配对 / 加密）：调试场景下要求先配对会让
   "主机只想读一下"这种事直接卡死。

## 5. 验证状态（**请重点看这一节**）

### ✅ 已证实的部分

**自动化断言**（任何 Windows 机器上都应通过）：

- `cargo test` → `mod ble_periph_tests`：UUID 解析（128 位 / 16 位短写 / 32 位短写 / 大小写归一 /
  非法输入报错）、属性名双向映射与未知属性报错、`DeviceId` 里取对端 MAC、广播状态码命名、
  **适配器能力 → 告警文案**（没适配器 / 不支持 BLE / 蓝牙关 / 被禁用 / 不支持外设角色）、
  告警优先级、事件缓冲上限与时间戳、数据事件载荷形状、未启动时 `status` 的形状。
- `.walkthrough/gen_ble_preview.js`：新增 70+ 条断言（预设表自洽、属性表与后端一致、
  HEX 解析、事件文案、配置往返与坏配置容错、前后端命令契约、图标引用存在性、关键不变量）。

**本机真机实测（开发用的执行环境，有蓝牙适配器）**：

| 事实 | 证据 |
|---|---|
| BLE 射频工作正常 | `btleplug` 扫描 5 秒扫到 **29 台**周边设备 |
| 适配器：Intel，已启用，能力位齐全 | `VID_8087&PID_0033`、`enabled=true`；`le/periph/central/offload/classic` 全 `true` |
| 蓝牙电源状态 | `radio: kind=Bluetooth state=On name="蓝牙"` |
| **无线电访问权被拒** | `RadioAccessStatus = DeniedByUser`（1=Allowed / 2=DeniedByUser / 3=DeniedBySystem） |
| **GATT 服务与特征能真的建出来** | `ble_periph_builds_service_and_characteristics` 通过：NUS 服务 + 2 个特征，UUID 规范化、属性回读、`set_value` 生效、无订阅者时 `notify` 明确报错 |

一条命令打全这些信息（排障用，输出可直接贴）：

```bash
cargo test --manifest-path src-tauri/Cargo.toml ble_periph_diagnose -- --ignored --nocapture
```

### ❌ 尚未证实：**"能被手机搜到"这件事目前没有任何成功证据**

`StartAdvertisingWithParameters` 返回 `Ok`，但广播状态不成立：

| 广播参数 | 落定状态 | 事件里的 `BluetoothError` |
|---|---|---|
| `discoverable=true, connectable=true` | `Aborted` | `Success`（等于没说） |
| `discoverable=true, connectable=false` | `Created`（一直没起来） | — |

**另一条独立通路也失败**：绕开 GATT、用 `BluetoothLEAdvertisementPublisher` 走纯广播
（LocalName + ManufacturerData + ServiceUuids，内容合法、长度远低于 31 字节），
`Start()` 直接返回 `E_INVALIDARG (0x80070057)`。

**而且完全确定性**：`GattServiceProvider` 带参 / 无参 `StartAdvertising` 各重试 3 轮共 6 次，
**每一次都是 `Aborted`**，没有一次瞬时成功。

### 已经排除的原因

| 假设 | 证据 | 结论 |
|---|---|---|
| 本机没有蓝牙硬件 | 扫描 5 秒扫到 29 台 | ❌ 排除 |
| 服务 / 特征建不出来 | `ble_periph_builds_*` 通过 | ❌ 排除 |
| 广播参数（可连接 / 服务数据）不对 | 带参、无参、可连接、不可连接都试过 | ❌ 排除 |
| 瞬时/资源竞争，重试能好 | 6 次重试全 `Aborted` | ❌ 排除 |
| 残留进程占用广播资源 | 清掉残留进程后重试，仍 `Aborted` | ❌ 排除 |
| **射频根本不能广播** | **见下：厂商数据广播实测 `Started`** | ❌ 排除 |
| **隐私设置拒绝无线电权限** | `HKCU/HKLM\...\CapabilityAccessManager\ConsentStore\radios` 与 `bluetooth` **都是 `Allow`**，且无相关组策略 | ❌ 排除 |
| 只在受限/非交互会话里失败 | 用户在自己的交互式桌面会话里点「开始广播」同样是 `Aborted` | ❌ 排除 |

> 关于 `RadioAccessStatus = DeniedByUser`：它一度是最强假设，但 ConsentStore 是 `Allow`，
> 说明这个返回值更可能是"非打包桌面进程没有 AppContainer 身份 / 非交互会话无法弹窗授权"的
> 产物，**不是**真正的用户拒绝。应用仍把它显示出来（信息性的），但文案不再断言"去隐私设置里放开"。

### 🔑 关键实测：**射频能广播，被拒的是"广播内容"**

用 `BluetoothLEAdvertisementPublisher`（**非连接**广播）逐个组合实测，结果非常明确：

| 广播内容 | `Start()` | 状态 |
|---|---|---|
| 空 | `E_INVALIDDATA`「发布者只能从非空负载启动」 | — |
| **仅厂商数据** | **`Ok(())`** | **`Started`** ✅ |
| 仅广播名（`SetLocalName` 返回 `Ok`） | `E_INVALIDARG` | `Created` |
| 仅服务 UUID（`Append` 返回 `Ok`） | `E_INVALIDARG` | `Created` |
| 厂商数据 + 广播名 | `E_INVALIDARG` | `Created` |
| 厂商数据 + `SetIsAnonymous(true)` | `E_INVALIDARG`「IsAnonymous 和 IncludeTransmitPowerLevel 需要设置 UseExtendedFormat 属性」 | `Created` |

**结论**：这块射频**确实能发出 BLE 广播**，但本机上**带"广播名"或"服务 UUID"的广播一律被拒**，
只有厂商数据能出去。

这直接解释了 `GattServiceProvider` 为什么恒 `Aborted`：**它必须广播自己的服务 UUID**
（`GattServiceProviderAdvertisingParameters` 里没有任何"不带 UUID"或"扩展格式"的开关，
只有 `SetServiceData` 与两个 PHY 开关 —— 已核对绑定确认）。所以在该限制被解除前，
`GattServiceProvider` 这条路在本机走不通。

### ⛔ 结论（2026-09，本机实测定性）

**在这台机器（Intel 集成蓝牙）+ 未打包的 Win32 应用形态下，BLE 从机广播不可实现。**

原因链完整且可复现：

```
射频能广播（仅厂商数据 → Started ✅）
   ↓
但带「服务 UUID」或「广播名」的广播帧被系统拒绝（E_INVALIDARG）
   ↓
GattServiceProvider 必须广播自己的服务 UUID，且没有任何
"不带 UUID / 改用扩展格式"的开关（已核对全部绑定方法）
   ↓
所以恒 Aborted —— 在本机无解
```

因此 **「BLE 从机」这一半功能在本机是死路**，不建议继续投入。保留代码是因为：
① 它本身已写完并有断言覆盖；② 在"驱动允许承载 service UUID 广播"的机器上可直接用；
③ 从机面板的配置 / 表格导入导出 / 多套配置这些与广播无关的能力仍然可用。

**若将来还想试**（都没证据，按性价比排序）：

| 选项 | 代价 | 说明 |
|---|---|---|
| 换一台电脑验证 | 低 | 只用于确认真是机器相关 |
| 换 USB 蓝牙适配器 | 中（要买） | 部分 CSR/Realtek dongle 支持承载 service UUID 的广播 |
| 把应用打包（MSIX/稀疏包 + `bluetooth` 能力） | **高** | 仅当"非打包应用平台限制"这一假设成立才有用，**无任何证据**；要改造构建、清单、安装流程 |

> 未做的最后一个免费实验：用**已打包**的现成 BLE 外设工具（如商店里的 Bluetooth LE Explorer）
> 在本机广播同一个服务。它能广播 → 说明是"缺应用标识"（那条高价路才值得考虑）；
> 它也不能 → 确认是适配器/驱动，到此为止。

```bash
cargo test --manifest-path src-tauri/Cargo.toml ble_periph_starts_advertising -- --ignored --nocapture
```

用一条**刻意会失败**的冒烟测试把这件事钉住（不是漏写测试，是如实标记未达成）：

```bash
cargo test --manifest-path src-tauri/Cargo.toml ble_periph_starts_advertising -- --ignored --nocapture
# 现状：FAILED —— advertising_status=Aborted
```

**判定方法**：应用把 `radio_access` 与各能力位显示在面板的「本机适配器」一行，并在广播失败时写进红字告警。
换一个 USB 蓝牙适配器（或换台电脑）再跑一次上面那条冒烟命令，即可在"适配器限制"与"环境限制"之间定性。

> 排查提示：早期曾用 `Get-PnpDevice -Class Bluetooth` 为空来判断"本机没有蓝牙"，
> **那是错的** —— 该执行环境里 PnP 枚举被拒绝访问，与蓝牙硬件无关。判定蓝牙必须用
> WinRT（`BluetoothAdapter::GetDefaultAsync`）或 btleplug 扫描。

### 待你在自己的桌面会话里验证（12 步）

正常启动应用（`npm run dev`）→ 蓝牙页 → 「从机 · 对外广播」→ 选 Nordic UART → 开始广播，
然后用手机 nRF Connect 扫：

| # | 步骤 | 预期 | 关键线索 |
|---|---|---|---|
| 1 | 开始广播 | 徽标变绿「广播中」 | `advertising_status = Started` |
| 2 | 手机扫描 | 能看到**本机电脑名** | 名字不是服务名，属正常 |
| 3 | 连接 → 展开服务 | 看到 `6E400001-…` 与两个特征 | RX(写) / TX(通知) |
| 4 | 读 RX | 返回界面里设的「初值」 | 事件日志 `[主机读取]` |
| 5 | 点 RX 的「设值」改内容 → 手机再读 | 读回新值 | 事件 `[设值]` |
| 6 | 手机写 RX | 日志出现 `[收到写入]` + 数据 | 本地值同步被更新 |
| 7 | 手机打开 TX 通知 | 特征行徽标变「已订阅 1」 | 事件 `[订阅]` |
| 8 | 点 TX 的「下发」 | 手机收到通知 | 事件 `[下发] · 已下发 1 个订阅者` |
| 9 | 手机取消订阅 → 再点下发 | 明确报错「还没有主机订阅」 | 不是静默成功 |
| 10 | 停止广播 → 手机再扫 | 设备消失 | 状态回落 `Stopped` |
| 11 | 关掉系统蓝牙 → 开始广播 | 红字：蓝牙已关闭… | 能力探测生效 |
| 12 | 重新打开蓝牙 → 开始广播 | 恢复正常广播 | — |

**若第 1/2 步就失败**：把 `adapter` 那行 JSON、`advertising_status` 与事件日志里的
`[广播状态] …` 一起回填到本文件，就能判定是"适配器限制"还是"环境限制"。

## 6. 复验命令

```bash
# 常规单测（不需要蓝牙硬件）
cargo test --manifest-path src-tauri/Cargo.toml

# 环境诊断：一次性打全"广播为什么起不来"的证据（权限 / 适配器 / 能力位 / 真实广播结果）
cargo test --manifest-path src-tauri/Cargo.toml ble_periph_diagnose -- --ignored --nocapture

# 已证实：服务树建得对不对（任何机器都应通过）
cargo test --manifest-path src-tauri/Cargo.toml ble_periph_builds -- --ignored --nocapture

# 未达成：真的在广播吗（失败即为当前真实状态）
cargo test --manifest-path src-tauri/Cargo.toml ble_periph_starts_advertising -- --ignored --nocapture

# 前端无头断言
node .walkthrough/gen_ble_preview.js
```

排查从机问题时看 `%TEMP%\seahi-serial-debug.log`（`dbg_log`）与界面右列的**事件日志**：
广播状态变化会以 `[广播状态] …` 落进日志，`Aborted` / `StartedWithoutAllAdvertisementData`
是"主机搜不到"的直接线索。

## 7. 维护提醒

1. 从机模块**必须留在模块级**（不要挪进 `fn main()`），否则它的 `#[cfg(test)] mod` 编译不过。
2. 前端 `BLE_PERIPH_PROP_ORDER` 只能出现后端 `ble_periph_props_from_names` 认得的属性名；
   `gen_ble_preview.js` 有一条断言在守这个契约（少了 ⇒ 勾了被后端拒绝）。
   `broadcast` 目前**只在后端支持**：WinRT 本地特征不支持无连接广播，界面不提供以免勾了不生效。
3. `BLE_PERIPH_CHAR_MAX`（前端）与后端的同名常量必须一致（都是 16），有断言守着。
4. 界面上的从机特征行操作按钮走的是 `data-act` + 事件委托，**不要**改成把 UUID 拼进内联
   `onclick`（同类隐患，见代码评估里的 M13/L13）。
5. 判断"本机有没有蓝牙 / 蓝牙开没开"请用 WinRT 或 btleplug，**不要**用 `Get-PnpDevice`
   （受限环境会拒绝访问，导致误判成"没有蓝牙硬件"）。
6. 单次通知上限来自 `GattSubscribedClient::MaxNotificationSize()`（= 协商 MTU − 3），
   在**订阅事件**里上报并缓存在特征上；下发超长会被 `ble_periph_notify_size_check` 挡住。
   改下发逻辑时别绕过它 —— 绕过只会把"清晰的分包提示"换成一个底层错误。
7. 界面上「设值」只在特征**可读**时才显示：只写特征的值只反映"主机刚写进来什么"，
   给它一个设值入口纯属误导（`gen_ble_preview.js` 有行为断言守着这条）。
