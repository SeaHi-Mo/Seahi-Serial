# vendored btleplug — 本地补丁说明（VENDOR.md）

> 本目录是 **btleplug 0.13.0 的 vendored fork**，用于给本应用暴露"原始广播字节"等能力。
> 通过 `src-tauri/Cargo.toml` 的 `[patch.crates-io]` 指向本目录生效：
>
> ```toml
> [patch.crates-io]
> btleplug = { path = "vendor/btleplug" }
> ```
>
> **升级 btleplug 时，下面 4 处补丁必须在新版上重新打**，否则会重现对应缺陷
> （历史事故：丢补丁 → "切页后连接被系统回收"、"重连后写入报『对象已关闭』"）。

---

## 上游基线

| 项 | 值 |
|---|---|
| crate | `btleplug` |
| 版本 | `0.13.0` |
| 上游仓库 | https://github.com/deviceplug/btleplug |
| 基线获取方式 | `cargo vendor` 后取 `btleplug` 目录（本目录内 `Cargo.toml` 仍保留上游版本号与 repository 字段） |
| 补丁数量 | **4 处**（2 个文件） |

> 注意：由于没有记录上游 commit，本目录与上游的精确 diff 无法自动复核。
> 下次升级时，建议先 `git diff` 本目录与新版上游，再据此重打下表补丁。

---

## 补丁清单

### 1. 暴露原始广播字节 — `src/api/mod.rs`

给 `PeripheralProperties` 增加字段，使上层能拿到未经解析的 ADV 原始数据：

```rust
pub advertisement_data: Option<Vec<u8>>,   // 原始广播字节（含 Adv + Scan Response）
```

**用途**：前端"广播内容"面板展示原始字节与按 SIG AD type 切分的结果。

### 2. 累积广播与扫描响应 — `src/winrtble/peripheral.rs`

`update_properties()` 中把 **ADV 与 Scan Response 合并累积（按段去重）**：

```rust
// ~L209 保存原始广告字节：累积合并 Advertising Data 与 Scan Response 的段（按段去重）
let mut seg = Vec::new();
seg.extend_from_slice(&payload);              // ~L218
let mut guard = self.shared.advertisement_data.write().unwrap();
acc.extend_from_slice(&seg);                  // ~L229
```

并在 `derive_properties()`（~L169）把累积结果填进补丁 1 新增的字段；`PeripheralShared`
需要相应的 `advertisement_data: RwLock<Option<Vec<u8>>>` 字段（~L99 声明 / ~L142 初始化）。

**缺陷背景**：Windows 的 `BluetoothLEAdvertisementReceivedEventArgs` 会把
Advertising Data 与 Scan Response 分两次回调；不合并时 Scan Response 里的名称/服务会丢失，
表现为设备名显示为空、广播内容不全。

### 3. WinRT 连接保活 — `src/winrtble/ble/device.rs`

创建 `GattSession` 后设置：

```rust
let _ = gatt_session.SetMaintainConnection(true);
```

**缺陷背景**：WinRT 的 `GattSession.MaintainConnection` **默认 `false`** ——
只要没有进行中的 GATT 操作，系统就会回收空闲链路。
表现为「连上设备后切到别的页面待一会儿，切回来发现已断开」（实测离开 150s 必断）。
置 `true` 后由系统保持连接，直到显式 `disconnect`。

### 4. 重连时清空 GATT 缓存 — `src/winrtble/peripheral.rs`

`connect()` 中在替换底层设备对象前清空服务缓存（本仓库中位于 ~L564；
同文件 ~L575 的 `clear()` 是上游 `disconnect()` 自带的，勿混淆）：

```rust
self.shared.ble_services.clear();
let mut d = self.shared.device.lock().await;
*d = Some(device);
```

**缺陷背景**：`connect()` 会用新的 `BLEDevice` 替换旧的（旧对象随之关闭），
但 `ble_services` 里缓存的服务/特征对象仍指向旧设备；而 `discover_services()`
对**已缓存的 UUID 会跳过**，于是重连后 `write`/`subscribe` 拿到的是已关闭的对象，
报 `RO_E_CLOSED` —— 「该对象已经关闭」。

---

## 升级步骤（建议）

1. 取新版上游源码，替换本目录（保留 `VENDOR.md`）。
2. 逐一重打上表 4 处补丁（每处都可在本文件中找到原始意图与缺陷背景）。
3. `cargo check` + `cargo test`；确保 `src-tauri/src/main.rs` 里读取
   `advertisement_data` / `MaintainConnection` 相关行为无编译错误。
4. **实机回归三条**（缺一即说明补丁没打全）：
   - 广播内容面板能看到原始字节，且 Apple 设备的 Scan Response 名称不丢失
   - 连上设备 → 切到串口页停留 ≥150s → 切回蓝牙页仍是「已连接」
   - 连接 → 断开 → 立即重连 → **发送一条数据成功**（不出现「该对象已经关闭」）
5. 更新本文件顶部的"版本"与"基线获取方式"。

---

_最后更新：2026-09（BLE 调试会话）_
