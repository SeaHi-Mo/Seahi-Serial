import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 下载地址的唯一来源：导航栏、页脚、首页按钮、旧版下拉都从这里取，避免各处写不同链接。
 *
 * - `APP_VERSION` 优先取 CI 注入的 tag 名（v0.5.22）；没有时从仓库根 package.json 读，
 *   Cloudflare Pages 这类只跑 `npm run build` 的环境不用额外配环境变量。
 * - 下载统一走 ghfast.top 镜像；版本号认不出来（本地 dev）时退回发布页。
 */
export const REPO = 'https://github.com/SeaHi-Mo/Seahi-Serial'
export const MIRROR = 'https://ghfast.top/'

function fallbackVersion(): string {
  let dir = process.cwd()
  for (let i = 0; i < 4; i++) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'))
      if (pkg.name === 'serial-debugger' && /^\d+\.\d+\.\d+$/.test(pkg.version)) {
        return `v${pkg.version}`
      }
    } catch {
      // 继续向上一级找
    }
    dir = resolve(dir, '..')
  }
  return 'dev'
}

export const APP_VERSION = process.env.APP_VERSION || fallbackVersion()
export const APP_VERSION_NUM = APP_VERSION.replace(/^v/, '')
export const HAS_VERSION = /^\d+\.\d+\.\d+$/.test(APP_VERSION_NUM)

/** 发布页（列出所有版本与资产） */
export const RELEASE_PAGE = `${MIRROR}${REPO}/releases/latest`

/** 当前版本的安装包直链（Inno Setup 产物，命名见 installer.iss） */
export const DOWNLOAD_ASSET = HAS_VERSION
  ? `${MIRROR}${REPO}/releases/download/v${APP_VERSION_NUM}/Seahi-Serial-Setup-${APP_VERSION_NUM}.exe`
  : RELEASE_PAGE
