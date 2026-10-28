/**
 * 生成「版本下拉」用的版本列表：读 git tag（v*），按版本倒序写进 releases.generated.ts。
 *
 * 为什么要生成而不是运行时拉 GitHub API：
 *  - 站点在国内访问，api.github.com 慢且可能不通；
 *  - 构建时手里就有 tag，没必要让浏览器再发一次请求。
 * CI 的 checkout 要 `fetch-depth: 0`，否则拿不到 tag（docs.yml 已设置）。
 *
 * Cloudflare Pages 的 Git 构建是浅克隆，通常没有 tag；本地 tag 为空时再用
 * `git ls-remote --tags` 从远端取一次，避免版本下拉只剩当前版本。
 * 两条路都拿不到时写空数组，组件会退回构建时注入的 appVersion。
 */
import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const out = resolve(here, '../docs/.vitepress/theme/components/landing/releases.generated.ts')

const parseVersion = (v) => v.split('.').map(Number)

function sortVersions(list) {
  return Array.from(new Set(list))
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
    .sort((a, b) => {
      const A = parseVersion(a)
      const B = parseVersion(b)
      return B[0] - A[0] || B[1] - A[1] || B[2] - A[2]
    })
    .slice(0, 12)
}

function localTags() {
  try {
    const raw = execSync('git tag -l "v*" --sort=-v:refname', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return raw
      .split(/\r?\n/)
      .map((t) => t.trim().replace(/^v/, ''))
      .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
  } catch {
    return []
  }
}

function remoteTags() {
  // Cloudflare 构建机上的 origin 是 GitHub 仓库；没有 origin 时退回公开地址。
  const remotes = ['origin', 'https://github.com/SeaHi-Mo/Seahi-Serial.git']
  for (const remote of remotes) {
    try {
      const raw = execSync(`git ls-remote --tags --refs ${remote}`, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const list = raw
        .split(/\r?\n/)
        .map((line) => line.match(/refs\/tags\/v(\d+\.\d+\.\d+)$/)?.[1])
        .filter(Boolean)
      if (list.length) return list
    } catch {
      // 换下一个来源
    }
  }
  return []
}

const local = localTags()
const versions = local.length ? sortVersions(local) : sortVersions(remoteTags())
const source = local.length ? 'local tags' : versions.length ? 'remote tags' : 'none'

const banner = `/**
 * 自动生成，别手改 —— 由 website/scripts/sync-releases.mjs 从 git tag 生成。
 * 组件里用来渲染「版本」下拉；空数组表示构建环境拿不到 tag。
 */

export const RELEASES_LIST: string[] = `

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, banner + JSON.stringify(versions, null, 2) + '\n', 'utf8')
console.log(
  `[releases] ${versions.length} 个版本（${source}）：${versions.slice(0, 3).join(', ')}${versions.length > 3 ? ' …' : ''}`,
)
