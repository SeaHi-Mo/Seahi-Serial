# 部署文档站到 Cloudflare Pages

站点地址：`https://www.seahi-serial.c-hi.cn`。默认流程是 GitHub Actions 构建、Cloudflare 只托管产物 ——
所以 Direct Upload 项目**没有** build command / output directory 要填，也没有 watch paths。
如果改用 Cloudflare 自己的 Git 构建，配置见最后一节。

## 一、建项目（Direct Upload）

Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Direct Upload**：

- 项目名填 `seahi-serial-docs`（必须和 `.github/workflows/docs.yml` 里的 `--project-name` 一致）
- 按本文的 Direct Upload 流程时不要选「Connect to Git」——那会变成 Git 集成项目，`wrangler pages deploy` 会直接报错，且**不能改回来**。

## 二、建 API Token

右上头像 → **My Profile** → **API Tokens** → **Create Token** → *Create Custom Token*：

| 项 | 值 |
|---|---|
| Permissions | Account → **Cloudflare Pages** → **Edit** |
| Account Resources | Include → 你的账号 |

拿到 token 后记下 **Account ID**（Dashboard → Workers & Pages 右侧栏，或任意域名概览页右下角）。

## 三、写进 GitHub Secrets

仓库 → Settings → Secrets and variables → Actions → New repository secret：

| Name | 值 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 上一步的 token |
| `CLOUDFLARE_ACCOUNT_ID` | 账号 ID |

## 四、绑自定义域

Pages 项目 → **Custom domains** → **Set up a domain** → `www.seahi-serial.c-hi.cn`。

- 域名在同一个 Cloudflare 账号下：一键完成，DNS 记录自动加。
- 若该域名**之前被别的 Worker 路由或 A 记录占着**：先删掉那条记录/路由，否则会看到 522 或错误站点。
- SSL/TLS 模式用 **Full (strict)**。

## 五、发布

```bash
git tag v0.5.22
git push origin v0.5.22
```

只有 tag 会触发 `.github/workflows/docs.yml`。首次可以先在 Actions 里手动跑一次 **Docs → Run workflow** 验证链路。
PR 只做构建校验（`npm ci && npm run build`），不部署。

## 六、发完检查这四项

1. `https://www.seahi-serial.c-hi.cn/` 打开是首页，**样式正常**（样式 404 通常是 `base` 写错了）。
2. `/guide/quick-start` 能直接访问（`cleanUrls: true`，没有 `.html` 后缀）。
3. `/download` 返回 **302** 且跳到 GitHub Releases 最新版（验证 `_redirects` 生效）。
4. 首页版本号是刚打的 tag（不是 `dev`）—— 说明 `APP_VERSION` 注入成功。

## 常见问题

| 现象 | 原因 |
|---|---|
| `wrangler` 报 *project is a git project* | 项目建成了 Git 集成。删掉重建，选 Direct Upload |
| 构建成功但站点没更新 | 看 Actions 里 Deploy 步骤是否被跳过（PR 触发本来就不部署） |
| 401 / 403 | token 权限不是 `Cloudflare Pages: Edit`，或 `CLOUDFLARE_ACCOUNT_ID` 填错 |
| 首页样式全丢 | `config.mts` 的 `base` 不是 `/`；子域根必须是 `/` |
| 访问返回 522 | 该子域还有旧的 DNS 记录 / Worker 路由占着 |
| `/download` 404 | `_redirects` 没进产物：应在 `website/docs/public/_redirects`，构建后位于 `dist/_redirects` |

## 与发版流程的关系

`docs.yml` 与 `build.yml` **完全独立**：站点构建失败不会挡住发版，发版失败也不会让站点停在半新半旧的状态。
代价是「文档改了要等下一次 tag」——着急就手动 Run workflow。

## 七、改用 Cloudflare 自己的 Git 构建（可选）

如果不想用 GitHub Actions，也可以让 Cloudflare Pages 直接连 Git 构建：

| 配置项 | 值 |
|---|---|
| Root directory | `website` |
| Build command | `npm run build` |
| Build output directory | `docs/.vitepress/dist` |
| 环境变量 | `NODE_VERSION=22` |

`APP_VERSION` 可以不填：没有这个环境变量时，`config.mts` 会读取仓库根目录 `package.json` 的 `version`。
GitHub Actions 的 tag 构建仍然会用 tag 名覆盖它。

注意 Git 集成项目和 Direct Upload 是两种项目，不能互相转换；用 Git 集成就不要再用 `wrangler pages deploy` 部署同一个项目。

版本下拉依赖 git tag。Cloudflare 的浅克隆通常没有 tag，`sync-releases.mjs` 在本地 tag 为空时会用
`git ls-remote --tags` 从远端仓库取一次，版本列表仍然完整。

