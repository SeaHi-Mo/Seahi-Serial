/**
 * 把仓库里的「工具手册」同步成站点页面。
 *
 * 为什么要脚本而不是手抄一份：
 * doc/MCP_TOOLS.md 由 .walkthrough/gen_mcp_tools_doc.js 从 protocol.rs 生成，
 * 工具一改它就变。站点若是手抄的副本，必然在某次改动后开始撒谎。
 *
 * 由 package.json 的 predev / prebuild 自动调用，不需要手动跑。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const src = resolve(repoRoot, 'doc/MCP_TOOLS.md')
const out = resolve(repoRoot, 'website/docs/mcp/tools.md')

const frontMatter = [
  '---',
  'title: 工具参考',
  'description: 内置工具的入参与返回结构（由 doc/MCP_TOOLS.md 自动同步，请勿手改本页）',
  '---',
  '',
  '',
].join('\n')

mkdirSync(dirname(out), { recursive: true })

if (!existsSync(src)) {
  // 构建时源文件缺失不要静默产出空页面：写一个能看懂的占位，并让日志有一行痕迹
  console.warn(`[sync] 找不到 ${src}，写出占位页`)
  writeFileSync(
    out,
    `${frontMatter}# 工具参考\n\n> 源文件 \`doc/MCP_TOOLS.md\` 不存在。\n>\n> 它由 \`node .walkthrough/gen_mcp_tools_doc.js\` 生成，请先在仓库根目录跑一次。\n`,
    'utf8',
  )
  process.exit(0)
}

const repoUrl = 'https://github.com/SeaHi-Mo/Seahi-Serial'

// 源文件里的相对链接（如 [MCP.md](./MCP.md)）指向 doc/ 下的文件，站点不发布 doc/，
// 保留原样会让 VitePress 的失效链接检查直接让构建失败。统一改指 GitHub 上的原文。
const body = readFileSync(src, 'utf8').replace(
  /\]\(\.?\/?([A-Za-z0-9_-]+\.md)(#[^)]*)?\)/g,
  (_, file, anchor = '') => `](${repoUrl}/blob/main/doc/${file}${anchor})`,
)

writeFileSync(out, frontMatter + body, 'utf8')
console.log(`[sync] doc/MCP_TOOLS.md → website/docs/mcp/tools.md（${body.length} 字符）`)
