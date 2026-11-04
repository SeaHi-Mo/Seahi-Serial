# 部署文档站到 Cloudflare Pages

站点地址：`https://www.seahi-serial.c-hi.cn`。

**当前流程：Cloudflare Pages 的 Git 集成构建。** 推 `main` → Cloudflare 自己 `npm ci && npm run build` → 部署。
GitHub Actions 的 `.github/workflows/docs.yml` **只做构建校验**（PR / tag / 手动触发），不再上传产物。

## 一、Pages 项目配置（Git 集成）

Cloudflare Dashboard → **Workers & Pages** → 选中文档站项目 → **Settings → Build**：

| 配置项 | 值 |
|---|---|
| Production branch | `main` |
| Root directory | `website` |
| Build command | `npm run build` |
| Build output directory | `docs/.vitepress/dist` |
| 环境变量 | `NODE_VERSION=22` |

`APP_VERSION` **不用配**：没有这个变量时，`website/docs/.vitepress/download.ts` 会从仓库根的 `package.json` 读版本号。
预览部署（PR 分支）也会构建，但只有 `main` 的部署会更新正式域名。

## 二、版本号从哪里来（别改回去）

首页和下载按钮的**当前版本**取自构建时仓库根 `package.json` 的 `version`，历史版本列表才来自 git tag
（`website/scripts/sync-releases.mjs` 生成 `releases.generated.ts`）。

原因：Cloudflare 的构建是浅克隆、而且**在打 tag 之前**就构建了（tag 推送不会触发新的 Pages 构建）。
如果拿 tag 列表的第一项当“当前版本”，首页会永远停在上一个版本 —— v0.5.23 发完 tag 后首页仍显示 0.5.22
就是这个坑。所以 `LandingHome.vue` 的 `versions` 是「`appVersion` 在前 + tag 历史去重后接上」。

> 发版顺序因此是：**先 bump 版本号提交并推 `main`（Cloudflare 会重新构建，首页显示新版本号）→ 再打 tag 出安装包**。
> 中间会有几分钟「首页写着新版本、Release 还没上」的窗口，属正常。

## 三、GitHub Actions 的 `Docs` 只做校验

- `pull_request`（改 `website/**` 或 `doc/MCP_TOOLS.md`）：只构建，不部署；
- `push tags v*`：构建校验，不部署（部署由 Cloudflare 的 `main` 构建完成）；
- 构建失败说明文档站编不过（死链、侧边栏指向不存在的页面等），先修再推。

## 四、不要混用 Direct Upload

Direct Upload 项目（用 `wrangler pages deploy` 上传产物）和 Git 集成项目是**两种项目，不能互相转换**。
Git 集成项目上跑 `wrangler pages deploy` 会直接报 *project is a git project*；两套同时部署还会互相覆盖
（谁后跑谁生效，站点版本会来回跳）。

如果现在还是 Direct Upload 项目，切换步骤：建一个新的 **Connect to Git** 项目（配置同上）→ 绑自定义域
`www.seahi-serial.c-hi.cn`（先把旧项目/旧 DNS 记录解开）→ 删除旧的 Direct Upload 项目与 `CLOUDFLARE_API_TOKEN` secret。

## 五、发布与检查

文档改动直接推 `main` 就会部署（不需要打 tag）。发版时 tag 只影响安装包与 Release。

发完看这四项：

1. `https://www.seahi-serial.c-hi.cn/` 首页样式正常（样式 404 通常是 `base` 写错）；
2. `/guide/quick-start` 能直接访问（`cleanUrls: true`，无 `.html` 后缀）；
3. `/download` 返回 **302** 跳到 GitHub Releases 最新版（`_redirects` 生效）；
4. 首页版本下拉第一项 = 当前 `package.json` 的版本，下载按钮指向
   `.../releases/download/v<版本>/Seahi-Serial-Setup-<版本>.exe`。

## 常见问题

| 现象 | 原因 |
|---|---|
| 构建成功但首页版本没变 | ① 构建发生在版本号 bump 之前（Cloudflare 构建的是那次推送的 commit）；② 浏览器/CDN 缓存，`Ctrl + F5`；③ 部署的是 Preview 而不是 Production（看 Production branch 是否 `main`） |
| 首页版本比 release 新、下载 404 | 正常窗口：版本号已 push、tag 还没发完。等 Release 出来即可 |
| `wrangler` 报 *project is a git project* | 项目是 Git 集成，不要再用 `wrangler pages deploy`（见第四节） |
| 401 / 403 | 只有 Direct Upload 才需要 token；Git 集成不需要 |
| 首页样式全丢 | `config.mts` 的 `base` 不是 `/`；子域根必须是 `/` |
| 访问返回 522 | 该子域还有旧的 DNS 记录 / Worker 路由占着 |
| `/download` 404 | `_redirects` 没进产物：应在 `website/docs/public/_redirects`，构建后位于 `dist/_redirects` |

## 与发版流程的关系

`docs.yml` 与 `build.yml` **完全独立**：站点构建失败不会挡住发版，发版失败也不会让站点停在半新半旧的状态。
