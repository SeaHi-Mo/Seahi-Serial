# 代码签名与安装说明

> 面向用户：下载安装前请先读这一页。
> 面向维护者：这是「为什么没有签名 / 怎么安全分发 / 后续怎么补」的记录，别删除，也别改成「已签名」这类无法兑现的说法。

## 1. 现状：安装包没有 Authenticode 签名

SeaHi Serial 由个人独立开发维护，**目前没有购买代码签名证书**（OV/EV 证书对个人开发者成本高，国内渠道多要求企业主体）。
因此 Windows 在首次运行安装包时可能弹出 SmartScreen 提示：

> Windows 已保护你的电脑 —— 无法识别此应用 / 发布者

或显示「未知发布者」。**这是「程序没有数字签名」的正常提示，不等于检测到病毒**；但也不该无脑放行 —— 请按下面三步确认来源。

## 2. 安全安装（三步）

1. **只从官方 Release 下载**
   <https://github.com/SeaHi-Mo/Seahi-Serial/releases>
   不要安装网盘、聊天记录里转发的安装包 —— 未签名文件没法靠证书判断有没有被改过。
2. **核对文件 SHA-256 与签名**
   下载 Release 里的 `SHA256SUMS.txt` 与 `SHA256SUMS.txt.sigstore.json`；
   先用 cosign 验签（步骤见 §4.1），再核对安装包哈希：
   ```powershell
   Get-FileHash .\Seahi-Serial_x.y.z_x64-setup.exe -Algorithm SHA256
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

## 4. 后续计划（个人开发者可行的路线）

| 方案 | 成本 | 状态 |
|---|---|---|
| **SignPath Foundation**（给开源项目免费签名，OV 证书由他们持有） | 0 | 计划申请：本项目 MIT、构建在 GitHub Actions 完成 |
| **Certum Open Source Code Signing**（个人可购买的开源码签名证书） | 约几十欧/年 | 备选 |
| **sigstore / cosign keyless 签名**（GitHub OIDC，无需证书） | 0 | ✅ 已接入 CI（v0.5.20 起）：随 Release 发布 `SHA256SUMS.txt` + `.sigstore.json` |
| 自签名证书 | 0 | ❌ 不做：对 SmartScreen 无帮助，还得用户手动装证书 |
| Microsoft Store（MSIX） | 个人账号 $19 | 可选：商店签名能绕开 SmartScreen，但需额外打包与审核 |

> 签名只解决「发布者身份 / 是否被篡改」；**SmartScreen 信誉还需要下载量积累** —— 即使拿到证书，新程序也可能先被提示。
> sigstore 只证明「产物由本仓库的 GitHub Actions 构建」，**不改变 Windows 的“未签名”判定**，SmartScreen 仍会提示。

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
   Get-FileHash .\Seahi-Serial-Setup-x.y.z.exe -Algorithm SHA256
   ```

## 5. 维护者清单（每次发布时）

- [ ] 确认 Release 资产里有安装包 + `SHA256SUMS.txt` + `SHA256SUMS.txt.sigstore.json`（CI 自动生成并上传）
- [ ] 不要写「已签名 / 绝对安全」这类无法兑现的话
- [ ] 拿到 Authenticode 证书后：更新本页状态、在 CI 里加签名步骤（sigstore 校验已接入，别删）
