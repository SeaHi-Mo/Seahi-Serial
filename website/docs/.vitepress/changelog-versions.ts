import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 更新日志的版本页：由 `website/scripts/sync-changelog.mjs` 生成在 `docs/changelog/<vX.Y.Z>.md`。
 * 这里**从生成的目录里读**，不在配置里再维护一份版本清单（两份必然漂移）。
 *
 * 语义化倒序：最新版本在最前面。目录不存在（还没跑 prebuild）时返回空数组，
 * 调用方退化为“没有版本列表”。
 */
function readVersions(): string[] {
  try {
    return readdirSync(resolve(process.cwd(), 'docs/changelog'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .filter((v) => /^v\d+\.\d+\.\d+$/.test(v))
      .sort((a, b) => {
        const pa = a.slice(1).split('.').map(Number)
        const pb = b.slice(1).split('.').map(Number)
        return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2]
      })
  } catch {
    return []
  }
}

export const CHANGELOG_VERSIONS = readVersions()
