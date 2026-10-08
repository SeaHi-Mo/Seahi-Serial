---
name: win-build-access-denied
description: 排查 Windows 上构建期「拒绝访问 / OS Error 5」导致的启动失败。当用户说「npm run dev 没有窗口」「npm run tauri dev 没反应」「cargo build 失败且看不懂报错」「build script 读不到 tauri.conf.json」「上次还能编现在编不了」时使用。覆盖 Tauri v2 / Rust cargo build script / Electron / 任何在构建目录生成 exe 的项目，重点定位 NTFS 低完整性标签（Mandatory Label Low）与目录级权限污染，而非代码本身。
---

# Windows 构建期「拒绝访问」排查

## 核心立场

**先确认是不是编译就失败了，再去怀疑应用逻辑。**

大多数「我跑了命令但没窗口 / 没反应」的情况，程序根本没启动 —— 是构建阶段挂了，而 CLI 的错误输出混在一屏编译日志里，容易被当成「还在编译」。

第一步永远是看完整输出，而不是看它有没有窗口。

## 决策流程

```
命令跑完没有任何窗口
        │
        ▼
跑到构建命令为止的输出里，有没有 error / OS Error / 失败？
        │
   ┌────┴────┐
   │ 有 error │ → 读下面「典型错误」，按类型处理
   └────┬────┘
        │ 无 error，且出现 "Finished" / "Running xxx.exe"
        ▼
进程真的活着吗？窗口是不是在屏幕外 / 最小化？
  PowerShell:
  Get-Process -Name <进程名> | Select-Object Id, MainWindowTitle, MainWindowHandle, Responding
```

典型的「确实编译或者 build script 挂了」：

- `error: failed to run custom build command for ...`
- `unable to read Tauri config file at ... because OS Error 5 (os error 5)`
- `拒绝访问。 (os error 5)`
- `Access is denied. (os error 5)`

**OS Error 5 = 拒绝访问**，和代码、依赖、语法统统无关。

## 根因：NTFS 低完整性标签

Windows 上最容易被忽略的一种污染源 —— 项目根目录被某个工具（沙箱类工具、AI 编码 agent、个别下载/同步工具）打上：

```
Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)
```

三个要点，看懂就够：

1. **`(OI)(CI)` 没有 `(I)`** —— 说明它不是继承来的，是被人直接加在这一层上的。
2. **向下传播** —— 它会自动扩散到目录下所有文件，包括 `target/`、`node_modules/` 和生成的所有 exe。
3. **exe 继承标签 → 进程被降完整性** —— 产物在这个树里运行时令牌被压低，回头读同在一棵树里的配置文件就被拒。

于是出现这个特别反直觉的现象：

> 文件权限完全正常（ACL 里你是 FullControl、没有 deny、没有进程占用锁），
> Python / PowerShell / 你自己写的程序都能读，
> 但**在项目自己的构建目录里**生成的那个 exe 就是读不了。

看到这种「同一份文件，换个位置运行就好」的矛盾，**基本可以直接判定是完整性标签问题**，不用再去查杀软、查文件锁。

## 判别实验（一步定论）

不必猜，做一个对照实验就见分晓。准备一个最小读取程序，把同一份二进制放到两个地方执行：

```rust
// readtest.rs
use std::fs;
fn main() {
    let p = r"<项目绝对路径>\<读不到的那个文件>";
    match fs::read_to_string(p) {
        Ok(s)  => println!("READ OK len={}", s.len()),
        Err(e) => println!("READ FAIL raw={:?} msg={}", e.raw_os_error(), e),
    }
}
```

```bash
rustc -O readtest.rs -o readtest.exe
rm readtest.rs readtest.pdb   # 用完就删，别留在项目里

# A：放普通目录执行 → 大概率 READ OK
./readtest.exe

# B：放进构建目录执行 → 大概率同样的 os error 5
cp readtest.exe "src-tauri/target/debug/build/<pkg>-<hash>/readtest.exe"
./src-tauri/target/debug/build/<pkg>-<hash>/readtest.exe
```

同一二进制、同一当前目录、同一用户，唯一变量是它所在的位置：

| 结果 | 结论 |
|------|------|
| A 正常、B 失败 | **进程/位置被做了手脚**，去查完整性标签 |
| A、B 都正常 | 不是完整性问题，看「其它成因」 |
| A、B 都失败 | 是文件本身权限/锁定/加密的问题，查 ACL 与句柄占用 |

## 修复

**必须在 PowerShell 里执行** —— Git Bash 会把 `/setintegritylevel` 当路径做 MSYS 转换，直接报 `exit 87`。

```powershell
# 1) 先确认是不是这个病
icacls "<项目根目录>"
#    输出里找 Mandatory Label 那一行，看到 Low 就确诊

# 2) 递归清掉低完整性标签，恢复为 Medium（普通进程该有的级别）
icacls "<项目根目录>" /setintegritylevel M /T /Q

# 3) 验证
cd <项目根目录>
npm run dev
#    或直接 cargo build 看是否 Finished
```

修复后再验一次进程状态才算真通过：

```powershell
Get-Process -Name <进程名> | Format-List Id, MainWindowTitle, MainWindowHandle, Responding
# MainWindowHandle 非 0、Responding = True → 窗口真的出来了
```

文件数多时 `/T` 要跑一会儿；个别并发占用中的文件报错可以忽略，不影响主体。

## 复发处理

标签被某个工具重新打回来是常态，看症状就知道：`icacls` 看 `Mandatory Label` 那一行有没有回到 Low。

要根除，得先揪出是谁 —— 留意这两个并存的痕迹：

- ACL 里出现 `Everyone:(CI)(DENY)(DC)` 与若干 `S-1-4-*` 会话 SID
- 系统里存在诸如 `<机器名>\CodexSandboxUsers` 这类用户组

命中就说明机器上有沙箱/隔离类工具在改写目录安全描述符，要么改它的配置，要么把项目挪出它监控的目录（例如从桌面挪到 `D:\src\`）。

## 其它成因（标签正常时的候选）

按可能性从高到低：

1. **文件被独占锁定** —— 某个进程以 share none 打开着。注意：只要 Python 默认模式能读穿，就可以排除这一条。
2. **受控文件夹访问 / 勒索软件防护** —— 挡的是未信任的新生成 exe。`Get-MpPreference` 若报 `0x800106ba`，说明 Defender 服务不在，接管者是第三方杀软，去它的控制台里看。
3. **Mark-of-the-Web** —— 从网络拿来的文件带了 Zone.Identifier。`Get-Item <文件> -Stream *` 查看。
4. **真的坏了 ACL** —— ACL 里既没有你的 Allow，也没有继承。可以对着同目录一个能正常读的文件跑 `icacls` 对比，一眼看出差异。

## 排错时的两个坑

- **别急着改代码。** 同一份代码在另一台机器正常、本机不行，几乎必然是环境差异。先跑通判别实验再说。
- **Tauri 主窗口 `visible: false` 是常见的正常设计。** 很多项目刻意让窗口先隐藏，由前端页面就绪后调用显示接口，并且 Rust 侧留了数秒兜底强制显示。所以启动后头一两秒看不到窗口不是卡死，别把它当成故障信号 —— 真正的故障是连编译都没过。

---

## 附：本项目（Seahi-Serial）对照

把上面的占位符换成这里的实际值，就不用每次现查：

| 占位 | 本项目的值 |
|---|---|
| 项目根目录 | 仓库根（`…\Seahi-Serial`）—— `icacls` 与 `/setintegritylevel` 打在这一层 |
| 构建目录 | `src-tauri\target\debug\`（`npm run dev`）／`src-tauri\target\release\`（`npm run build`） |
| 进程名 | **`seahi-serial`**（磁盘名带连字符；Cargo 包名与 `[[bin]] name` 也都是 `seahi-serial`） |
| 构建命令 | `npm run dev` = `tauri dev`；`npm run build` = `tauri build` |
| 前端资源 | 无构建步骤（`src/index.html` + `src/css/*` + `src/js/*` 直接加载），**前端改动不需要编译**，但 release 版把它们嵌在 exe 里 → 要重启/重编 |

### 本项目特有的两条判据

1. **主窗口本来就是 `visible: false`**（`src-tauri/tauri.conf.json`）—— 这是刻意设计，不是故障：
   前端 `revealMainWindow()`（`reveal_main_window` 命令）在**成功 / catch / showFatalError 三处**都会显示窗口，
   Rust 侧另有 **4 秒**兜底 `show()`（见 `AGENTS.md`「窗口几何记忆的三条约定」）。
   所以"启动后一两秒没窗口"**不能当故障**；真故障是 **4 秒后仍看不到**，或干脆连编译都没过
   （那时 `Get-Process -Name seahi-serial` 要么没进程，要么 `MainWindowHandle` 为 0）。
2. **`unable to read Tauri config file at … because OS Error 5`** 在本项目直接指向
   `src-tauri\tauri.conf.json` 读不到 —— **那就是本文档说的标签问题，别去改 `tauri.conf.json` 的内容**。

### 一句话流程（本项目版）

`npm run dev` 起不来窗口时：

```powershell
# ① 看完整输出里有没有 error / OS Error 5（十有八九是这里，而不是"还在编译"）
npm run dev

# ② 确诊：Mandatory Label 是不是 Low
icacls "D:\Users\Seahi\Desktop\Seahi-Serial"

# ③ 修（注意：必须在 PowerShell 里，Git Bash 会把 /setintegritylevel 当路径）
icacls "D:\Users\Seahi\Desktop\Seahi-Serial" /setintegritylevel M /T /Q

# ④ 复验：4 秒后仍无窗口才算没修好
cd D:\Users\Seahi\Desktop\Seahi-Serial
npm run dev
Get-Process -Name seahi-serial | Format-List Id, MainWindowTitle, MainWindowHandle, Responding
```

### ⚠️ 反向坑：**低完整性的是"我的进程"，不是"你的项目"**

2026-10 实测过一次容易诊断反的场景：目录标签是**正常的 Medium**，而**AI 沙箱里跑的子进程**令牌是
`Mandatory Label\Low Mandatory Level`（`whoami /groups` 明写）。Windows 的 **no-write-up** 规则下，
低完整性进程**不能写**中完整性对象 —— 于是表现为：

- 在该仓库里**建目录、建文件、写任何东西全被拒**（`Access to the path '…' is denied.`），
  而 `icacls` 上看 ACL 完全正常、你我都有 FullControl；
- 但**用户自己**的 PowerShell / `npm run dev`（Medium 令牌）一切正常。

**判别一句话**：`whoami /groups` 看当前进程的完整性级别，和 `icacls <目录>` 的 `Mandatory Label` 比。
- 进程 Low + 目录 Medium → **是这个进程被沙箱降级了**，该改的是沙箱/提权方式，
  **不是**去 `icacls /setintegritylevel L`（那是把整个项目往下拉，正是本文档要治的病）；
- 进程 Medium + 目录 Low → 才是本文档的标准病例，按「修复」走。
