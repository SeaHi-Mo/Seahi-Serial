# 代码签名与安装说明

> 面向用户：下载安装前请先读这一页。
> 面向维护者：这是「为什么没有签名 / 怎么安全分发 / 后续怎么补」的记录，别删除，也别改成「已签名」这类无法兑现的说法。

## 1. 现状：安装包没有 Authenticode 签名

SeaHi Serial 由个人独立开发维护，**目前没有购买代码签名证书**（OV/EV 证书对个人开发者成本高，国内渠道多要求企业主体）。
免费路线已关闭：**SignPath Foundation 的开源签名申请在 2026-11 被官方拒绝**，之后只剩付费证书一条路（尚未购买，见 §4）。
因此 Windows 在首次运行安装包时可能弹出 SmartScreen 提示：

> Windows 已保护你的电脑 —— 无法识别此应用 / 发布者

或显示「未知发布者」。**这是「程序没有数字签名」的正常提示，不等于检测到病毒**；但也不该无脑放行 —— 请按下面三步确认来源。

## 2. 安全安装（三步）

1. **只从官方 Release 下载，并选对架构**
   <https://github.com/SeaHi-Mo/Seahi-Serial/releases>
   发布页同时提供 x64 / x86 两种架构的安装包，文件名以 `-x64` / `-x86`（Inno）或
   `_x64_` / `_x86_`（MSI）结尾 —— 64 位系统选 x64，32 位系统选 x86。程序内「检查更新」
   也按当前程序架构自动匹配，不会把 64 位用户更新成 32 位安装器。
   不要安装网盘、聊天记录里转发的安装包 —— 未签名文件没法靠证书判断有没有被改过。
2. **核对文件 SHA-256 与签名**
   下载 Release 里的 `SHA256SUMS.txt` 与 `SHA256SUMS.txt.sigstore.json`；
   先用 cosign 验签（步骤见 §4.1），再核对安装包哈希：
   ```powershell
   Get-FileHash .\Seahi-Serial-Setup-x.y.z-x64.exe -Algorithm SHA256
   ```
   与 `SHA256SUMS.txt` 里对应行比对；不一致就不要运行。
3. **确认后放行**
   SmartScreen 里点「更多信息」→「仍要运行」；安装后若仍有拦截，回到第 2 步核对哈希。
   最稳的方式永远是**读源码 / 自己构建**（见 README「快速开始」）。

## 3. 我们做了什么 / 没做什么

| | 状态 |
|---|---|
| Release 通过 GitHub HTTPS 分发，构建由 GitHub Actions 从本仓库源码完成 | ✅ |
| 安装器升级前会停掉常驻的 adb 服务、不静默覆盖被占用的文件 | ✅ |
| 发布产物附带 `SHA256SUMS.txt` + cosign keyless 签名（`.sigstore.json` bundle） | ✅ v0.5.20 起 |
| **代码签名证书**（向 Windows 证明发布者身份） | ❌ 没有 |
| **更新包的证书信任链**：更新包会校验后端缓存的 SHA-256 / 大小，但证书层面的信任仍需 Authenticode 签名 | ❌ 没有 |

## 4. 后续计划：只剩付费证书

| 方案 | 成本（2026-11 查到的公开报价） | 状态 |
|---|---|---|
| **SignPath Foundation**（开源项目免费签名，证书由基金会持有） | 0 | ❌ 2026-11 申请被官方拒绝 |
| **Certum Open Source Code Signing**（个人可买；仅限非商业开源项目；发布者显示 `Open Source Developer, <姓名>`） | 云签名 €49/年起；证书 + 加密卡 + 读卡器 €69/年起；国内代理约 ¥600/年 | 当前最便宜的可行路线（未购买） |
| **Certum 标准 OV**（组织验证，允许商业软件；国内代理要求营业执照） | 国内代理 ¥880/年；海外渠道 $99/年 | 备选：以后要收费或接商业项目就上这档（先确认有可用的主体） |
| **Azure Artifact Signing**（原 Trusted Signing） | $9.99/月 | ❌ 个人不可用：只对美国 / 加拿大、有 3 年以上可核实经营历史的组织开放 |
| **Microsoft Store（MSIX）** | 个人账号 $19 | 备选：商店代签能绕开 SmartScreen，但要把 Inno Setup 换成 MSIX 并过商店审核 |
| **sigstore / cosign keyless 签名**（GitHub OIDC，无需证书） | 0 | ✅ 已接入 CI（v0.5.20 起）：随 Release 发布 `SHA256SUMS.txt` + `.sigstore.json` |
| 自签名证书 | 0 | ❌ 不做：对 SmartScreen 无帮助，还得用户手动装证书 |

> 签名只解决「发布者身份 / 是否被篡改」；**SmartScreen 信誉还需要下载量积累** —— 即使拿到证书，新程序也可能先被提示
> （2026 年起 EV 也不再自动跳过 SmartScreen）。
> sigstore 只证明「产物由本仓库的 GitHub Actions 构建」，**不改变 Windows 的“未签名”判定**，SmartScreen 仍会提示。
> 2026-03 起代码签名证书最长有效期统一为 460 天，按年续、每年重新签发。

> **SignPath 为什么拒**：它的条款写得很直白 —— 证书是 SignPath Foundation 自己的名字，所以只签「有可验证知名度」的可执行程序（原话：*we cannot sign binaries based on source code that nobody knows*），并且明确「没有独立仲裁机制、不受理政策争论」。对小众工具来说被拒是预期结果，不是材料填错；补签名策略页 / 维护者 MFA / 发布页说明只是加分项，知名度只能靠时间和下载量。想再申就等版本和用户量起来。

### 4.1 如何校验发布产物（sigstore keyless）

1. 安装 `cosign`（<https://docs.sigstore.dev/cosign/installation/>，建议 v3+）
2. 下载 Release 里的两个文件并放在同一目录：`SHA256SUMS.txt`、`SHA256SUMS.txt.sigstore.json`
3. 验签（cosign v3 的签名材料是 bundle，签名/证书/透明日志证明都在里面）：
   ```powershell
   cosign verify-blob SHA256SUMS.txt `
     --bundle SHA256SUMS.txt.sigstore.json `
     --certificate-identity-regexp "https://github\.com/SeaHi-Mo/Seahi-Serial/\.github/workflows/build\.yml@refs/tags/v.*" `
     --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
   ```
   输出 `Verified OK` 说明这份校验和确实由本仓库的 tag 构建产生。
4. 再按 `SHA256SUMS.txt` 核对安装包：
   ```powershell
   Get-Content SHA256SUMS.txt
   Get-FileHash .\Seahi-Serial-Setup-x.y.z-x64.exe -Algorithm SHA256
   ```

### 4.2 买之前确认这四件事（Certum 这一类）

1. **档位**：¥600 的「个人版」是不是 Open Source 档 —— 证书主体带 `Open Source Developer` 前缀，**不得给商业分发的软件签名，否则会被吊销**。以后要收费、接商业项目，就得换标准 OV（¥880 那档，**多数渠道要营业执照**，个体户也算主体）。
2. **交付方式**：云签名（SimplySign，私钥在 CA 的 HSM 里，不需要 USB Key）还是加密卡 + 读卡器（寄实物，多几天物流）。
3. **身份材料**：身份证件 + 本人名下的水电费账单 + 公开项目地址（GitHub 仓库要能看出你是维护者）；代理代办也是这套材料。
4. **签名配额**：Certum 云签名上限 5,000 次/月，正常发版用不到，但要知道有这条。

### 4.3 买到之后：落地顺序别搞反

- **签名必须在算 SHA-256 之前**。签名会改文件字节，先算哈希再签名，`SHA256SUMS.txt` 必然对不上。CI 里插在「Build Tauri app / Build 32-bit MSI / Build Inno Setup installers」之后、「Generate SHA256SUMS」之前。
- 要签的是三处：`seahi-serial.exe` 与 MSI（走 Tauri 的 `bundle.windows.signCommand`）、Inno Setup 安装包（`installer.iss` 的 `SignTool`）。
- **时间戳必加**（`signtool /tr <RFC 3161 地址> /td sha256`），否则证书过期后签名一起失效。
- **SimplySign 默认要手机 TOTP**，headless CI 直接跑不通。两条路：用现成 action（如 `windows-app-signing-setup-action` / `super-simply-sign` / `ssign`，把 TOTP secret 存进 GitHub Secrets），或者本地签好再上传安装包。
- 签完用 `Get-AuthenticodeSignature` 核对，再把本页 §1/§3 的状态改成「已签名」。

## 5. 维护者清单（每次发布时）

- [ ] 确认 Release 资产里有安装包 + `SHA256SUMS.txt` + `SHA256SUMS.txt.sigstore.json`（CI 自动生成并上传）
- [ ] 接入 Authenticode 后：**先签名、再生成 `SHA256SUMS.txt`**（顺序反了哈希对不上），并保留 sigstore 那两步
- [ ] 不要写「已签名 / 绝对安全」这类无法兑现的话
- [ ] 拿到 Authenticode 证书后：更新本页状态、在 CI 里加签名步骤（sigstore 校验已接入，别删）
