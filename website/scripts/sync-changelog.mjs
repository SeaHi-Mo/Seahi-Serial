/**
 * 生成「更新日志」：**索引页 + 每个版本一个独立页**，版本倒序（最新在最上面）。
 *
 * 产物（生成物不入库，见 .gitignore；`predev` / `prebuild` 自动跑）：
 *  - `docs/changelog.md`（/changelog）—— 索引，列出全部版本 + 一句摘要；
 *  - `docs/changelog/<vX.Y.Z>.md`（/changelog/vX.Y.Z）—— 单个版本的完整说明；
 *  - 英文在 `docs/en/changelog.md` 与 `docs/en/changelog/<vX.Y.Z>.md`（内容与中文同源）。
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

/** 索引页的一句摘要：正文第一个「普通段落」行，去掉链接/强调标记后截断 */
function summary(md) {
  const line = md
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s && !/^(#|>|\||```|[-*+]\s|\d+\.\s|<)/.test(s))
  if (!line) return ''
  const plain = line.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '')
  return plain.length > 90 ? `${plain.slice(0, 88)}…` : plain
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

/** 版本倒序：当前版本在最前（它可能还没打 tag），随后是已有的 tag */
function collectVersions() {
  let tags = []
  try {
    tags = execSync('git tag -l "v*" --sort=-v:refname', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)
      .map((t) => t.trim())
      .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
      .slice(0, MAX_VERSIONS)
  } catch {
    tags = []
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

function writeVersionPages(baseDir, urlPrefix, isEn) {
  const dir = resolve(baseDir, 'changelog')
  // 目录整体重建：版本列表变了以后不留旧版本的孤儿页
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  for (const { version, notes, ref } of versions) {
    const body = (notes && sectionBody(notes)) || placeholder(version, isEn)
    const back = isEn
      ? `[← Back to changelog](${urlPrefix}/changelog)`
      : `[← 返回更新日志](${urlPrefix}/changelog)`
    const md = `---\ntitle: ${version}\npageClass: changelog\n---\n\n# ${version}\n\n${sanitizeLinks(body, ref)}\n\n---\n\n${back}\n`
    writeFileSync(resolve(dir, `${version}.md`), md, 'utf8')
  }
}

function writeIndex(file, title, urlPrefix, isEn) {
  const items = versions.map(({ version, notes }) => {
    const excerpt = (notes && summary(sectionBody(notes))) || placeholder(version, isEn)
    return `## [${version}](${urlPrefix}/changelog/${version})\n\n${excerpt}`
  })
  const intro = isEn
    ? 'Release notes for every version. The newest release is at the top — click a version for the full notes.'
    : '每个版本的发布说明。最新版本在最上面，点版本号看该版本的完整说明。'
  const md = `---\ntitle: ${title}\npageClass: changelog\n---\n\n# ${title}\n\n${intro}\n\n${items.join('\n\n')}\n`
  writeFileSync(file, md, 'utf8')
}

const versions = collectVersions()

writeIndex(resolve(docsRoot, 'changelog.md'), '更新日志', '', false)
writeVersionPages(docsRoot, '', false)

mkdirSync(docsEnRoot, { recursive: true })
writeIndex(resolve(docsEnRoot, 'changelog.md'), 'Changelog', '/en', true)
writeVersionPages(docsEnRoot, '/en', true)

console.log(
  `[changelog] ${versions.length} 个版本：索引 2 页 + 每版一页（${versions
    .slice(0, 3)
    .map((v) => v.version)
    .join(', ')}${versions.length > 3 ? ' …' : ''}）`,
)
