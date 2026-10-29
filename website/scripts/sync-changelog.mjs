/**
 * 生成「更新日志」页（中英各一份）：当前版本在最上面，旧版本按 tag 倒序往下排。
 *
 * 数据来源：
 *  - 当前版本：仓库根的 RELEASE_NOTES.md（发布说明只保留当前版本）；
 *  - 旧版本：`git show <tag>:RELEASE_NOTES.md` 里对应版本的那一段。
 *  - 有些 tag 提交时发布说明没更新（文件里还是上一版），这些版本用一行占位 + GitHub 链接，
 *    保证版本序列不断档。
 *
 * 拿不到 git / tag（浅克隆、源码包构建）时只输出当前版本，不会报错。
 * 生成物不入库（.gitignore），predev / prebuild 自动跑。
 */
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const docsRoot = resolve(here, '../docs')
const REPO = 'https://github.com/SeaHi-Mo/Seahi-Serial'

/** 最多保留多少个版本（太多了页面会很长） */
const MAX_VERSIONS = 12

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
function placeholder(tag, isEn) {
  const url = `${REPO}/releases/tag/${tag}`
  return isEn
    ? `## ${tag}\n\nNo release notes were saved for this build. See the [GitHub release](${url}).`
    : `## ${tag}\n\n这一版没有留存发布说明，见 [GitHub Release](${url})。`
}

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

const zh = []
const en = []

if (tags.length === 0) {
  zh.push(current)
  en.push(current)
} else {
  for (const tag of tags) {
    const raw = tag === currentVersion ? current : notesFromTag(tag)
    const notes = raw ? stripInternalSections(raw).trim() : raw
    zh.push(notes || placeholder(tag, false))
    en.push(notes || placeholder(tag, true))
  }
  // 本地还没打当前版本的 tag 时，把它补在最前面
  if (currentVersion && !tags.includes(currentVersion)) {
    zh.unshift(current)
    en.unshift(current)
  }
}

const page = (title, body) => `---
title: ${title}
pageClass: changelog
---

${body}
`

writeFileSync(resolve(docsRoot, 'changelog.md'), page('更新日志', zh.join('\n\n---\n\n')), 'utf8')
mkdirSync(resolve(docsRoot, 'en'), { recursive: true })
writeFileSync(resolve(docsRoot, 'en/changelog.md'), page('Changelog', en.join('\n\n---\n\n')), 'utf8')

console.log(`[changelog] ${zh.length} 个版本`)
