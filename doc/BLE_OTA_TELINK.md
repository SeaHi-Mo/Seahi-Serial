# 泰凌微（Telink）TLSR825x BLE OTA 协议（真机核对用）

> ## ⛔ 当前状态：整个 OTA 入口**已隐藏**（2026-09 用户要求）
> `src/js/84-ble-ota.js` 顶部的 `var BLE_OTA_UI_ENABLED = false;` 是唯一总开关 ——
> 设备详情页不再渲染「固件升级」按钮，`openBleOtaModal()` 自己也直接 `return`。
> **代码、引擎、协议档、二次确认、危险登记、断言、本文档全都在**，只是用户看不到入口。
> 本文档要解决的正是"隐藏的唯一原因"：**`crc16()` 的参数**（见 §6）。
> 核对完把那一行改成 `true`，整条就回来；恢复后 §7 的引擎改造项仍然要做。
>
> **这份文档解决的是「阶段 2 的协议依据」**：目标设备（广播名 `ai-thinker`，固件
> `(3684) TB_ComboAT_常规固件_v3.0.8.bin`）是**安信可 TB 系列 = 泰凌微 TLSR8250**，
> 它的 GATT 里有 `00010203-0405-0607-0809-0A0B0C0D1912` —— **泰凌微 OTA 服务**。
> 所以 OTA 不是"自研私有协议"，而是 **Telink OTA**：协议在厂商 SDK 里是明文的。
>
> 依据（**逐条可核对**，不是记忆、不是猜）：
> - `github.com/Ai-Thinker-Open/Telink_825X_SDK`（安信可的 825X SDK 镜像）
>   - `components/stack/ble/attr/gatt_uuid.h:88-103` —— UUID
>   - `components/stack/ble/service/ble_ll_ota.h:37-47` —— 命令字与固件大小上限
>   - `example/8258_master_kma_dongle/blm_ota.c:359-426` —— **上位机侧完整收发流程**
>   - `example/ota/app_att.c:88-93,182-189,239-245` —— 从机侧属性表（权限/回调）
>   - `example/ota/app.c:411-475,937-941` —— 从机侧结果回调与 OTA 超时
>
> ⚠️ **本机 clone 的坑**（记下来免得再踩）：默认 schannel 后端会报
> `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`，
> 必须 `git -c http.sslBackend=openssl clone …`（或先在仓库里 `git config http.sslBackend openssl`）。
> 另外 `web_fetch` 抓不到 github/csdn/telink wiki（一律 `resolves to a non-public IP`），
> **想读源码就 clone**。

---

## 1. UUID（与真机服务树已对上）

| 用途 | UUID | 属性 | 依据 |
|---|---|---|---|
| OTA 服务 | `00010203-0405-0607-0809-0a0b0c0d1912` | — | `gatt_uuid.h:93`（`TELINK_OTA_UUID_SERVICE`）**真机服务树里已看到** |
| **OTA 数据特征** | `00010203-0405-0607-0809-0a0b0c0d2b12` | `READ \| WRITE_WITHOUT_RSP` | `gatt_uuid.h:100`（`TELINK_SPP_DATA_OTA_BYTES`）+ `app_att.c:184-188` |
| SPP（透传）服务 | `55535343-fe7d-4ae5-8fa9-9fafd205e455` | — | 真机服务树里已看到；同族默认值是 `...1910`，TB 固件用 `AT+SERUUID` 覆盖成这样 |
| SPP 通知特征（模块→手机） | `49535343-8841-43f4-a8d4-ecbe34729bb3` | `READ \| NOTIFY` | `example/ota/app_att.c:78-80`（字节序反转后） |
| SPP 写入特征（手机→模块） | `49535343-1e4d-4bd9-ba61-23c647249616` | `WRITE_WITHOUT_RSP` | 同上 |

> 同族还有 `...1911` 音频、`...1920/1921` Mesh、`...2B10/2B11` SPP 数据、`...2B13` 配对、`...2B14` 自定义
> （`gatt_uuid.h:91-108`）—— 认 UUID 时按"尾号 0x19xx / 0x2Bxx + `00010203-0405-0607-0809-0a0b0c0d` 前缀"看。

## 2. 命令字（`ble_ll_ota.h:39-41`）

```
CMD_OTA_FW_VERSION  0xFF00     // 查询版本（老固件保留）
CMD_OTA_START       0xFF01     // 开始升级
CMD_OTA_END         0xFF02     // 结束（附"最后一包的序号"）
```
老 SDK 里另有 0xFF03~0xFF07（`blm_ota.c:58-62`）：`START_REQ / START_RSP / TEST / TEST_RSP / ERROR`，
注释写着 "reserved for BLE Fullstack" —— **当前 825x 固件用不到**，但 `0xFF07` 是"从机报错给主机"的通道，
将来可用来做更准的失败判定。

`FW_MAX_SIZE = 0x40000`（256 K，`ble_ll_ota.h:37`）；KMA demo 自己限制 128 K。
**从机侧 OTA 会话超时 = `bls_ota_setTimeout(10*60*1000*1000)`**（`example/ota/app.c:417`，注意单位是 µs → 10 分钟）。

## 3. 帧格式（上位机 → 设备，全部走 **Write Without Response**）

### 3.1 开始
```
01 FF            ← CMD_OTA_START，u16 小端
```
发出后 demo 等 **50 ms** 再发数据（`blm_ota.c:344-357`）。

### 3.2 数据包（**固定 20 字节**，`blm_ota.c:69-73, 359-388`）

```c
typedef struct {
    u16 adr_index;   // = 字节偏移 >> 4，小端
    u8  data[16];    // 固件内容，固定 16 字节
    u16 crc_16;      // crc16(前 18 字节)，小端
} rf_packet_att_ota_data_t;
```

| 偏移 | 长度 | 内容 |
|---|---|---|
| 0 | 2 | `adr_index = ota_adr >> 4`（**以 16 字节为单位**，小端） |
| 2 | 16 | 固件字节 |
| 18 | 2 | `crc16(packet[0..17])`，小端 |

- 每包写完 `ota_adr += 16`（`blm_ota.c:379`）。
- **没有逐包 ACK**：靠 `blc_ll_getTxFifoNumber() < 5` 做流控，尽量连发（`blm_ota.c:361`）。
- 从机侧判定规则（泰凌手册 B80 片段原文）：**"前两个 byte 的范围在 firmware_size_k 之内时，表示一个 OTA 数据"**
  —— 否则就是命令。

### 3.3 结束（**6 字节**，`blm_ota.c:395-418`）

```
adr_index = 0xFF02                  ← CMD_OTA_END（小端 = 02 FF）
data[0..1] = (ota_adr - 16) >> 4    ← 最后一包的 index，小端
data[2..3] = ~data[0..1]            ← 取反校验
data[4..11]= 0
```
（只发 6 字节；设备据此判断有没有丢包。发完等 TX FIFO 清空。）

## 4. 时序与稳定性做法（demo 里的选择，值得照抄）

1. OTA 一开始就把连接参数改成 **interval 8 (×1.25ms = 10ms)、latency 0、timeout 200 (2s)**
   （`blm_ota.c:186-189`）—— 这是"快"的关键。
2. 整个 demo 有 **20 s 总超时**（`OTA_TIMEOUT_S`）→ 128 K 固件也就这个量级；
   我们自己的引擎**不设整体超时**（那是给分钟级/异常场景留的），但真机上如果 20s 都发不完，
   说明参数不对，该在界面上一眼看得出来（速率已经显示着）。
3. 设备侧结果通过 `bls_ota_registerResultIndicateCb` 回调暴露，`example/ota/app.c:423-475`
   会**从串口打印**：`OTA_SUCCESS` / `OTA_PACKET_LOSS` / `OTA_DATA_CRC_ERR` / `OTA_WRITE_FLASH_ERR` /
   `OTA_DATA_UNCOMPLETE` / `OTA_TIMEOUT` / `OTA_FW_CHECK_ERR`。
   👉 **我们这个工具正好是串口调试器**：BLE OTA 的同时盯着模块串口，就能拿到设备的判定结果。

## 5. 固件镜像格式（顺带解释了面板上那句"包头未识别"）

上位机取长度的方式是 **`n_firmware = *(u32 *)(镜像 + 0x18)`**（`blm_ota.c:311`），
然后**从镜像偏移 0 开始**发（含头部）。

拿真机固件核对（`(3684) TB_ComboAT_常规固件_v3.0.8.bin`）：

```
0x00: 56 80 00 00 00 00 5d 02 4b 4e 4c 54 16 05 88 00     magic u16 = 0x8056
0x10: b6 80 00 00 00 00 00 00 14 8b 01 00 00 00 00 00
0x18: u32 = 101140 = 0x18B14   ← **正好等于文件长度 101140 字节** ✓
```

也就是说：**这是泰凌微的镜像头，不是安信可的 `ai_pack_head`** —— 阶段 0 的解析器说
「包头 未识别」是对的（它只认 `V1.0\0` 那一种）。阶段 2 要给解析器补上泰凌微镜像头。

⚠️ **一个还没定死的点**：`101140 % 16 = 4`，而老 demo 只发完整 16 字节包
（`nlen = ota_adr < n_firmware ? 16 : 0`）。末包 4 字节怎么处理（补零 vs 只发 4 字节 vs 固件长度本就该 16 对齐）
**代码里没写**，需要真机核对。

## 6. 唯一还缺的一块：`crc16()` 的参数

`crc16()` 的**实现在预编译库 `components/proj_lib/liblt_8258.a` 里**（源码只有声明，
`ble_ll_ota.h:111`），所以参数（多项式/初值/是否反转/是否异或输出）**看不到**。

- 硬件侧只暴露 `crc16_ccitt_cal(input, len, init_val)`（`components/drivers/8258/rf_drv.h:831`）
  —— 说明泰凌的 CRC16 是 **CCITT（poly 0x1021）**，初值由调用方给。
- 公开资料里泰凌 OTA 常用的写法是 **CRC-16/CCITT-FALSE（poly 0x1021、init 0xFFFF、MSB-first、不反转、不异或）**。
  **这是高置信度的候选，不是结论** —— 按本项目的纪律（不猜协议），它必须在真机上核对后才写进内置协议档。
- 核对办法（不用改固件）：
  1. 抓一包真机 OTA 流量（手机用官方 App/小程序升级，同时用本工具监听）→ 直接读出设备的 CRC 期望值；
  2. 或者本工具发**一个**数据包，再看设备串口打印的是 `OTA_DATA_CRC_ERR` 还是继续（配合 §6 的候选参数）。
     ⚠️ 这一步会真的往 OTA 暂存区写数据 —— 属于"危险动作"，要走二次确认。

## 7. 对我们现有引擎的要求（阶段 2 要改的东西）

现在的引擎只有 `frame_mode: raw`（把固件按 `chunk_size` 原样切片）。Telink OTA 需要：

| 需要 | 现状 | 要做什么 |
|---|---|---|
| 每包 20 字节 = 2B 索引 + 16B 数据 + 2B CRC16 | 只有裸分片 | 新增帧模式 `telink_ota`（**分包固定 16，不受 MTU 影响**） |
| 起始帧 `01 FF` | 已有 `start_hex` ✔ | 协议档预设填 `01FF` |
| 结束帧（带最后一包 index + 取反） | 已有 `finish_hex`，但**内容是动态的** | 结束帧要能引用运行时变量（最后一包序号）→ 引擎里加一个"结束帧生成器" |
| 不等 ACK | `ack_mode: none` ✔ | 预设 `none` + 片间延时（真机按速率调） |
| CRC16 | 没有 | 实现 CRC-16/CCITT-FALSE（参数待真机核对） |
| 镜像头解析（长度在 +0x18） | 只认 `ai_pack_head` | 加"泰凌微镜像"识别，把长度显示出来 |
| 结果判定 | 只看传输 | 加"OTA 后读版本/串口打印"这条验收（评估文档 §4.3 已有） |

> 顺带一条真机事实：**OTA 特征的属性是 `READ | WRITE_WITHOUT_RSP`，没有 NOTIFY** ——
> 所以 `ack_mode` 只能是 `none`（或 `write_response` 但设备未声明该属性，很可能被拒）；
> 现有引擎的"三种 ACK 方式"在这里用得上，选 `none` 即可。
