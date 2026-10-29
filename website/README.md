# 文档站（VitePress）

对应线上地址：`https://www.seahi-serial.c-hi.cn`（Cloudflare Pages 项目 `seahi-serial-docs`）。

## 本地

::: tip 两条路，别混
在**仓库根目录**：`npm run docs:dev` / `npm run docs:build`（根 `package.json` 里已配好）。
在 **website/ 目录内**：`npm run dev` / `npm run build`。
`npm --prefix website ...` 这种写法只在仓库根目录成立——在 website/ 里再写一遍会变成 `website/website`（npm ENOENT）。
:::

```bash
npm install          # 只在 website/ 里装，别在仓库根目录装
npm run dev          # http://localhost:5173
npm run build        # 产物 → docs/.vitepress/dist
npm run preview      # 预览构建产物
```

`npm run dev` / `npm run build` 会先跑 `sync:tools`，把 `../doc/MCP_TOOLS.md` 同步成 `docs/mcp/tools.md`（生成物，已 gitignore，别手改）。

## 目录结构

```
website/
├── package.json                 # vitepress 只装在这里（独立 lockfile）
├── tsconfig.json                # 只为编辑器类型提示，不参与构建
├── scripts/
│   └── sync-mcp-tools.mjs       # doc/MCP_TOOLS.md → docs/mcp/tools.md
└── docs/
    ├── .vitepress/
    │   ├── config.mts           # 站点骨架：base / head / 全站 themeConfig / locales
    │   ├── locales/             # 语言包：只放与语言有关的文案与导航
    │   │   ├── types.ts         #   LocaleContent 接口
    │   │   ├── index.ts         #   toLocaleConfig() + locales 表（新增语言在这里登记）
    │   │   ├── zh-CN.ts         #   简体中文 → 根路径 /
    │   │   └── en-US.ts         #   英文 → /en/
    │   ├── theme/
    │   │   ├── index.ts         # 继承默认主题 + 注册全局组件 + 引入样式
    │   │   ├── components/      # 自有 Vue 组件
    │   │   │   ├── VersionBadge.vue
    │   │   │   └── landing/     # 首页（落地页）组件
    │   │   │       ├── LandingHome.vue   # 顶栏 + 首屏 + 收尾 + 页脚
    │   │   │       ├── AppWindow.vue     # 首屏里的产品窗口模拟
    │   │   │       ├── FeatureCards.vue  # 四张能力卡与示意图
    │   │   │       └── copy.ts           # 中英文案（改字只改这里）
    │   │   └── styles/
    │   │       ├── vars.css          # 设计变量（品牌色 / 圆角 / 阴影）
    │   │       ├── base.css          # 全站微调
    │   │       ├── home.css          # 旧首页遗留（截图墙 / 版本徽标）
    │   │       ├── landing.css       # 落地页布局、按钮、动效、响应式
    │   │       └── landing-window.css # 产品窗口与卡片示意图
    ├── index.md                 # 中文首页（layout: false + <LandingHome />）
    ├── guide/                   # 中文指南：quick-start / serial / terminal / quick-cmds / ble / adb-wsl / faq
    ├── mcp/                     # 中文 MCP：index.md + tools.md（生成物）
    ├── en/                      # 英文，目录与中文镜像
    │   ├── index.md
    │   ├── guide/quick-start.md
    │   └── mcp/index.md
    └── public/                  # _redirects、logo、favicon、截图
```

## 页面放哪

| 想加的东西 | 放哪 | 访问路径 |
|---|---|---|
| 中文指南页 | `docs/guide/<name>.md` | `/guide/<name>` |
| 中文 MCP 页 | `docs/mcp/<name>.md` | `/mcp/<name>` |
| 中文首页 | `docs/index.md` | `/` |
| 英文指南页 | `docs/en/guide/<name>.md` | `/en/guide/<name>` |
| 英文首页 | `docs/en/index.md` | `/en/` |

两条硬约束：

1. **加完页面要登记进侧边栏**（`locales/zh-CN.ts` 或 `en-US.ts` 的 `sidebar`），否则页面能访问但在导航里消失。
2. **侧边栏里不能写不存在的页面**——VitePress 的失效链接检查会让构建直接失败（这是好事，别绕）。

## 语言

- 根路径是简体中文（`root`），英文在 `/en/`；语言切换器由 VitePress 按 `locales` 自动生成。
- 语言包只放**与语言相关**的东西：`nav` / `sidebar` / 界面文案 / 搜索弹窗文案。
- 全站共用的（`logo`、GitHub 链接、`editLink.pattern`、`appVersion`）在 `config.mts` 的根 `themeConfig` 里，语言包会继承（VitePress 按属性合并）。

**新增一种语言**（比如日语）：

1. 复制 `locales/en-US.ts` → `locales/ja-JP.ts`，改 `label` / `lang` / 文案 / nav / sidebar。
2. 在 `locales/index.ts` 的 `locales` 表里加一行：`ja: toLocaleConfig(jaJP)`（键就是 URL 前缀）。
3. 建 `docs/ja/` 目录，放 `index.md` 与要翻译的页面；侧边栏用 `/ja/...` 路径。

## 组件

- 放 `docs/.vitepress/theme/components/`。
- 需要全局可用（Markdown 里直接写 `<VersionBadge />`）就在 `theme/index.ts` 的 `enhanceApp` 里注册；只在单页用的可以在 md 里局部引入。
- 现有 `VersionBadge.vue`：读 `themeConfig.appVersion`（CI 注入的 tag）。**不要用 Vite 的 `define` 传版本号**——它在 SSR 阶段不生效，构建会报 `__APP_VERSION__ is not defined`。

## 样式与换风格

- 色值、圆角、阴影一律走 `styles/vars.css` 的 CSS 变量；`base.css` / `home.css` 只放结构与个别修正。
- 换整体风格时按这个顺序动手：`vars.css`（配色/圆角）→ `home.css`（首屏与卡片布局）→ 实在不够再写 `theme/Layout.vue`。
- 中英文共用同一套主题，改样式两边一起变（预期行为）。

## 首页（落地页）

首页不是 VitePress 的 `layout: home`，而是 **`layout: false` + 一个 Vue 组件** —— 版式照搬
`https://www.deepseek.com/harness/`（原站快照与复刻稿在本地 `WorkBuddy/2026-10-27-22-49-53/`，
不入库），配色换成本软件默认主题。

| 文件 | 负责什么 |
|---|---|
| `index.md` / `en/index.md` | 只写 frontmatter（`layout: false`）+ `<LandingHome />` |
| `components/landing/LandingHome.vue` | 顶栏、首屏文案与按钮、收尾 CTA、页脚；滚动毛玻璃、进场、复制命令 |
| `components/landing/AppWindow.vue` | 首屏那个「产品窗口」：**1:1 照 `src/index.html` + `js/10-monitor.js` 的真实结构**（全局操作栏 36px / 工具栏 40px + 9 个 ibtn / **高级设置行 32px** / 输出区 / 快速指令侧栏 300px / 发送栏 36px），配色取 `src/css/01-theme.css` 的 `:root`。图标**不手画**：由 `scripts/sync-ui-icons.mjs` 从 `js/00-bootstrap.js` 的 `ICONS` 与 `index.html` 的全局栏 SVG 抽成 `icons.generated.ts`（生成物，`predev`/`prebuild` 自动跑），尺寸沿用源码里的 `width/height`。2026-10-28 按运行时截图逐项校准过（高级行默认展开、「超时(ms)」不是延时、端口显示友好名、组名「循环 1」）。改这里之前先读那两个源文件，别凭印象加控件 |
| `components/landing/FeatureCards.vue` | 四张能力卡与各自的示意图 |
| `components/landing/copy.ts` | **中英两份文案**：改字只改这里，结构不动 |
| `styles/landing.css` | 布局、按钮、光晕、网格、动效、响应式 |
| `styles/landing-window.css` | 产品窗口与卡片示意图 |

配色映射（原站 → 本软件默认主题）：

| 用途 | 原站 | 这里 |
|---|---|---|
| 页面底 | `#0a0a0a` | `#1c1e22`（`--bg`） |
| 工具栏 / 表面 | 白 4–6% | `#22252a` / 白 4–6%（`--toolbar-bg`） |
| 边框 | 白 6–24% | `#2e3138`（`--border`）+ 白 6% |
| 正文 / 亮正文 | `#fff` / 80% | `#dce0e8`（`--text-b`）/ `#b8bcc4`（`--text`） |
| 主色 / 强调 | `#4176e6` / `#7aaaff` | `#4a7ab5`（`--btn-p`）/ `#6a9fd8`（`--link`） |

注意：`.lp-root` 里用了 `:where(.lp-root) a` 这种低权重写法 —— 别再改回 `.lp-root a`，
否则会盖掉按钮自己的文字颜色（白底白字）。

**窗口 chrome 一律按 Windows 画**（2026-10-28 用户纠正）：标题栏是「左侧图标/标题 + 右侧 `— □ ✕`」，
按钮 46px 宽、关闭悬停变 `#e81123` 红；**不要用 macOS 的三色红绿灯圆点**（那是早先版本犯过的错，
卡片里那个终端示意也按 Windows 标题栏画）。圆角 8px（Win11 窗口圆角），别放大成 macOS 那种大圆角。

## 待办

- [x] 首页风格对齐 `deepseek.com/harness`（2026-10-27 提出，2026-10-28 落地）
- [ ] 字体：原站用 Montserrat / DM Sans / JetBrains Mono（Google Fonts）。国内访问不稳，
      目前只写在 `--lp-font-*` 的栈首，加载不到就回落到系统字体。真要还原，需自托管 woff2 到 `public/fonts/`。
- [ ] 深色/浅色：落地页固定深色（跟软件默认主题一致）；文档页仍可切浅色。

## 发布

**只有打 tag 才会部署**（`.github/workflows/docs.yml`）：

```bash
git tag v0.5.22 && git push origin v0.5.22
```

版本号来自 tag（`APP_VERSION`），不需要改任何文件。文档改急了、又不想发版：Actions → **Docs** → Run workflow。

首次部署前要先建 Cloudflare 项目、配两个 secret，见 [`doc/DEPLOY_CLOUDFLARE.md`](../doc/DEPLOY_CLOUDFLARE.md)。

## 升级 VitePress

当前锁在 **`2.0.0-alpha.21`**（Vite 8.3 / Vue 3.5，构建实测 ~1s）。它还是预发布版，
但本站已完整跑通构建，且站点坏了不连累应用发版（`docs.yml` 与 `build.yml` 完全独立）。

```bash
npm outdated vitepress        # 看有没有新版
npm install -D vitepress@next # 跟随 2.0 alpha（当前这一档）
npm run build                 # 唯一的验收标准
```

想回到 1.x 稳定线（Vite 5）：

```bash
npm install -D vitepress@1    # 会把 package.json 与 lock 一起改回 ^1.6.x
```

`package.json` 与 `package-lock.json` **必须一起提交**：CI 用 `npm ci`，两者不一致会直接失败。

> ⚠️ alpha 的破坏性改动没有迁移指南。升级后除了 `npm run build` 通过，还要 `npm run dev` 亲眼过一遍首页、
> 侧边栏、搜索与暗色切换——构建成功不等于样式没坏。

## 内容边界

`doc/` 是开发者内部文档（设计记录、评审、用户研究），**不整目录发布**。站点内容只放面向用户的部分，单独维护；唯一自动同步的是 MCP 工具手册。
