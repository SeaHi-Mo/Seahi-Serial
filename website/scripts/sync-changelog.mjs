/**
 * 生成「更新日志」的**版本页**：每个版本一个独立页，最新在最上面。
 *
 * 产物（生成物不入库，见 .gitignore；`predev` / `prebuild` 自动跑）：
 *  - `docs/changelog/<vX.Y.Z>.md` → /changelog/vX.Y.Z
 *  - `docs/en/changelog/<vX.Y.Z>.md` → /en/changelog/vX.Y.Z
 *
 * ⚠️ **没有「全部版本」索引页**：顶部「更新日志」标签由 `config.mts`（读生成目录的最新版本）
 * + `DocsTabs.vue` 直接指向最新版本页；历史版本从侧栏进（`locales/index.ts` 同一个目录读列表）。
 * 以前生成过 `docs/changelog.md` / `docs/en/changelog.md`，这里会顺手删掉，避免残留孤儿页。
 *
 * 数据来源：
 *  - 当前版本：仓库根的 RELEASE_NOTES.md（发布说明只保留当前版本）；
 *  - 旧版本：`git show <tag>:RELEASE_NOTES.md` 里对应版本的那一段。
 *  - 有些 tag 提交时发布说明没更新（文件里还是上一版），这些版本用一页占位 + GitHub 链接，
 *    保证版本序列不断档。
 *  - 拿不到 git / tag（浅克隆、源码包构建）时只输出当前版本。
 */
import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const docsRoot = resolve(here, '../docs')
const docsEnRoot = resolve(docsRoot, 'en')
const REPO = 'https://github.com/SeaHi-Mo/Seahi-Serial'

/** 最多保留多少个版本（更老的版本既没留存说明、也没人翻） */
const MAX_VERSIONS = 100

const current = readFileSync(resolve(repoRoot, 'RELEASE_NOTES.md'), 'utf8').trim()
const currentVersion = (current.match(/^## (v\d+\.\d+\.\d+)/m) || [])[1] || ''

/** 从某个 tag 的 RELEASE_NOTES.md 里切出该版本（`## vX.Y.Z` 到下一个版本标题） */
function notesFromTag(tag) {
  try {
    const raw = execSync(`git show ${tag}:RELEASE_NOTES.md`, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const head = raw.match(new RegExp(`^## ${tag}\\s*$`, 'm'))
    if (!head) return ''
    const start = head.index
    const rest = raw.slice(start + head[0].length)
    const next = rest.search(/^## v\d+\.\d+\.\d+\s*$/m)
    const body = next >= 0 ? rest.slice(0, next) : rest
    return (head[0] + body).trim()
  } catch {
    return ''
  }
}

/**
 * 发布说明里的「验证」「安装说明」两节只对发布流程有意义（构建命令、签名提示），
 * 站点上不展示：按 `###` 切块，命中关键词的整块删掉。
 */
function stripInternalSections(md) {
  return md
    .split(/\n(?=###[ \t])/)
    .filter((chunk) => !/^###[^\n]*(验证|安装说明)/.test(chunk))
    .join('\n')
}

/** 去掉开头的 `## vX.Y.Z` 标题（页面标题由 frontmatter 的 title + 正文 H1 提供） */
function sectionBody(md) {
  return md.replace(/^##\s+v\d+\.\d+\.\d+[^\n]*\r?\n?/, '').trim()
}

function placeholder(version, isEn) {
  const url = `${REPO}/releases/tag/${version}`
  return isEn
    ? `No release notes were saved for this build. See the [GitHub release](${url}).`
    : `这一版没有留存发布说明，见 [GitHub Release](${url})。`
}

/**
 * 旧版发布说明里写的是仓库相对链接（`./doc/MCP_TOOLS`，有的还没带 `.md`），原样贴到站点上就是死链。
 * 统一改成指向该版本在 GitHub 上的文件；当前版本还没打 tag 时用 `main`。
 */
function sanitizeLinks(md, ref) {
  return md.replace(/\]\(([^)\s]+)\)/g, (whole, href) => {
    if (/^(https?:|mailto:|\/|#)/.test(href)) return whole
    const hit = href.match(/^(?:\.{1,2}\/)*(doc\/[^#\s]+)(#[^)\s]*)?$/)
    if (!hit) return whole
    return `](${REPO}/blob/${ref}/${hit[1]}${hit[2] || ''})`
  })
}

/** 读本地 tag（本地仓库 / CI 全量克隆时能拿到） */
function readLocalTags() {
  try {
    return execSync('git tag -l "v*" --sort=-v:refname', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)
      .map((t) => t.trim())
      .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
      .slice(0, MAX_VERSIONS)
  } catch {
    return []
  }
}

/**
 * 浅克隆（Cloudflare Pages 的 Git 构建等）通常**没有 tag**：不补的话更新日志只剩当前版本。
 * 这里在构建时从远端补一次 tag；`git show <tag>:RELEASE_NOTES.md` 需要 tag 指向的提交对象，
 * 所以依次尝试三种 fetch（普通 / 深度 1 / 解除浅克隆），哪种成功用哪种。
 */
function ensureTags() {
  let tags = readLocalTags()
  if (tags.length) return tags

  const attempts = [
    'git fetch --tags --force --quiet',
    'git fetch --tags --force --depth=1 --quiet',
    'git fetch --tags --force --unshallow --quiet',
  ]
  for (const cmd of attempts) {
    try {
      execSync(cmd, { cwd: repoRoot, stdio: ['ignore', 'ignore', 'ignore'] })
    } catch {
      continue
    }
    tags = readLocalTags()
    if (tags.length) {
      console.log(`[changelog] 本地没有 tag，已通过「${cmd}」补齐 ${tags.length} 个`)
      return tags
    }
  }
  return tags
}

/** 版本倒序：当前版本在最前（它可能还没打 tag），随后是已有的 tag */
function collectVersions() {
  const tags = ensureTags()
  if (!tags.length) {
    console.warn('[changelog] 没有可用 tag：只生成当前版本页（浅克隆且 fetch 失败时会这样）')
  }

  const versions = []
  if (currentVersion) {
    // 当前版本可能还没打 tag（本地开发时常见）→ 相对链接退回 main 分支
    versions.push({
      version: currentVersion,
      notes: stripInternalSections(current).trim(),
      ref: tags.includes(currentVersion) ? currentVersion : 'main',
    })
  }
  for (const tag of tags) {
    if (versions.some((v) => v.version === tag)) continue
    const raw = notesFromTag(tag)
    versions.push({ version: tag, notes: raw ? stripInternalSections(raw).trim() : '', ref: tag })
  }
  return versions
}

function writeVersionPages(baseDir, isEn) {
  const dir = resolve(baseDir, 'changelog')
  // 目录整体重建：版本列表变了以后不留旧版本的孤儿页
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  for (const { version, notes, ref } of versions) {
    const body = (notes && sectionBody(notes)) || placeholder(version, isEn)
    const md = `---\ntitle: ${version}\npageClass: changelog\n---\n\n# ${version}\n\n${sanitizeLinks(body, ref)}\n`
    writeFileSync(resolve(dir, `${version}.md`), md, 'utf8')
  }
}

const versions = collectVersions()

// 旧版生成过「全部版本」索引页，现在不再生成：顺手删掉，避免残留孤儿页
for (const file of [resolve(docsRoot, 'changelog.md'), resolve(docsEnRoot, 'changelog.md')]) {
  rmSync(file, { force: true })
}

writeVersionPages(docsRoot, false)

mkdirSync(docsEnRoot, { recursive: true })
writeVersionPages(docsEnRoot, true)

console.log(
  `[changelog] ${versions.length} 个版本页（每版一页，最新在最上）：${versions
    .slice(0, 3)
    .map((v) => v.version)
    .join(', ')}${versions.length > 3 ? ' …' : ''}`,
)
