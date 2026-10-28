/**
 * 生成「版本下拉」用的版本列表：读 git tag（v*），按版本倒序写进 releases.generated.ts。
 *
 * 为什么要生成而不是运行时拉 GitHub API：
 *  - 站点在国内访问，api.github.com 慢且可能不通；
 *  - 构建时手里就有 tag，没必要让浏览器再发一次请求。
 * CI 的 checkout 要 `fetch-depth: 0`，否则拿不到 tag（docs.yml 已设置）。
 * 拿不到 git / 拿不到 tag 时写空数组，组件会退回构建时注入的 appVersion。
 */
import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const out = resolve(here, '../docs/.vitepress/theme/components/landing/releases.generated.ts')

let versions = []
try {
  const raw = execSync('git tag -l "v*" --sort=-v:refname', { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  versions = raw
    .split(/\r?\n/)
    .map((t) => t.trim().replace(/^v/, ''))
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
    .slice(0, 12)
} catch {
  // 没有 git（比如从源码包构建）→ 留空，组件会退回 appVersion
}

const banner = `/**
 * 自动生成，别手改 —— 由 website/scripts/sync-releases.mjs 从 git tag 生成。
 * 组件里用来渲染「版本」下拉；空数组表示构建环境拿不到 tag。
 */

export const RELEASES_LIST: string[] = `

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, banner + JSON.stringify(versions, null, 2) + '\n', 'utf8')
console.log(`[releases] ${versions.length} 个版本：${versions.slice(0, 3).join(', ')}${versions.length > 3 ? ' …' : ''}`)
