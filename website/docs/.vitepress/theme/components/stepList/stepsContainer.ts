import type MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token'
// js-yaml 5.x 是纯 ESM：只有命名导出、没有 default（4.x 那套 default 写法在 Vite 下会报
// "does not provide an export named 'default'"）。命名空间导入在 4/5 上都成立。
import * as yaml from 'js-yaml'

export function stepsContainer(md: MarkdownIt) {
  // === 1. 注册 ```steps 代码围栏 ===
  const defaultFence = md.renderer.rules.fence!.bind(md.renderer.rules)
  md.renderer.rules.fence = (tokens: Token[], idx: number, options: any, env: any, self: any) => {
    if (tokens[idx].info.trim() === 'steps') {
      return renderSteps(tokens[idx].content, env)
    }
    return defaultFence(tokens, idx, options, env, self)
  }

  // === 2. 注册 :::steps::: 容器 ===
  // 不使用 md.use()（会被 withMermaid 覆盖），直接注册 block rule + renderer rules

  function containerSteps(state: any, startLine: number, endLine: number, silent: boolean) {
    const start = state.bMarks[startLine] + state.tShift[startLine]
    const max = state.eMarks[startLine]

    // 检查是否以 ::: 开头
    if (state.src.charCodeAt(start) !== 0x3A) return false // ':'

    // 计算 ::: 数量（至少3个）
    let pos = start
    while (pos <= max && state.src.charCodeAt(pos) === 0x3A) pos++
    const markerCount = pos - start
    if (markerCount < 3) return false

    // 检查后面是否跟 "steps"
    const params = state.src.slice(pos, max).trim()
    if (params !== 'steps') return false

    if (silent) return true

    // 查找闭合 :::
    let closeLine = -1
    for (let i = startLine + 1; i < endLine; i++) {
      const lineStart = state.bMarks[i] + state.tShift[i]
      const lineMax = state.eMarks[i]
      if (lineStart >= lineMax) continue

      // 检查是否是闭合标记（::: + 可选空格）
      let p = lineStart
      while (p < lineMax && state.src.charCodeAt(p) === 0x3A) p++
      const closeCount = p - lineStart
      if (closeCount >= markerCount) {
        state.skipSpaces(p)
        if (p >= lineMax) {
          closeLine = i
          break
        }
      }
    }

    if (closeLine < 0) return false // 未找到闭合

    // 提取内容（排除闭合 ::: 行）
    let content = ''
    for (let i = startLine + 1; i < closeLine; i++) {
      content += state.src.slice(state.bMarks[i], state.eMarks[i]) + '\n'
    }

    // 输出 token
    state.push('container_steps_open', 'div', 1)
    state.push('container_steps_content', '', 0).content = content.trim()
    state.push('container_steps_close', 'div', -1)

    state.line = closeLine + 1 // 跳过闭合 :::
    return true
  }

  // 注册 block rule（在 fence 之前）
  md.block.ruler.before('fence', 'container_steps', containerSteps, {
    alt: ['paragraph', 'reference', 'blockquote', 'list']
  })

  // 注册 renderer rules
  md.renderer.rules['container_steps_open'] = () => ''
  md.renderer.rules['container_steps_close'] = () => ''
  md.renderer.rules['container_steps_content'] = (tokens: Token[], idx: number, _options: any, env: any) => {
    return renderSteps(tokens[idx].content, env)
  }
}

// ─── 渲染入口 ───

function renderSteps(content: string, env: any): string {
  try {
    if (content.trim().startsWith('---')) {
      return renderStepsFromYAML(content, env)
    }
    return renderStepsFromOldFormat(content, env)
  } catch (error) {
    console.error('[StepList] parse error:', error)
    return `<div class="error">解析步骤失败: ${error}</div>`
  }
}

// ─── YAML 格式 ───

function renderStepsFromYAML(content: string, env: any): string {
  // 顶格的 `---` 一律当**步骤分隔符**去掉。
  // 原实现只去首尾各一个，可 README 里多步骤的写法是每一段之间都有一条 `---` ——
  // YAML 会把它读成“多文档”，load() 直接报 `expected a single document in the stream`。
  // 只删顶格的：块标量（`text: |`）正文里的 `---` 有缩进，是正文的一部分，不能动。
  const yamlContent = content
    .split('\n')
    .filter((line) => !/^---\s*$/.test(line))
    .join('\n')
    .trim()

  const parsed = yaml.load(yamlContent) as any

  let steps: StepItem[] = []
  if (Array.isArray(parsed)) {
    steps = parsed
  } else if (parsed && Array.isArray(parsed.steps)) {
    steps = parsed.steps
  } else {
    throw new Error('YAML 结构错误：需要数组或 { steps: [...] }')
  }

  steps = steps.map(s => resolvePaths(s, getMdPath(env)))
  return buildComponent(steps)
}

// ─── 旧格式（单行 text:） ───

function renderStepsFromOldFormat(content: string, env: any): string {
  const lines = content.split('\n')
  const steps: StepItem[] = []
  let cur: any = {}

  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith('- icon:')) {
      if (Object.keys(cur).length) steps.push(cur)
      cur = { icon: t.replace(/^- icon:\s*/, '').replace(/^['"]|['"]$/g, '') }
    } else if (t.startsWith('title:')) {
      cur.title = t.replace(/^title:\s*/, '').replace(/^['"]|['"]$/g, '')
    } else if (t.startsWith('text:')) {
      cur.text = t.replace(/^text:\s*/, '').replace(/^['"]|['"]$/g, '')
    } else if (t.startsWith('image:')) {
      cur.image = t.replace(/^image:\s*/, '').replace(/^['"]|['"]$/g, '')
    } else if (t.startsWith('imageSize:')) {
      cur.imageSize = t.replace(/^imageSize:\s*/, '').replace(/^['"]|['"]$/g, '')
    } else if (t.startsWith('icon:')) {
      cur.icon = t.replace(/^icon:\s*/, '').replace(/^['"]|['"]$/g, '')
    } else if (t.startsWith('alt:')) {
      cur.alt = t.replace(/^alt:\s*/, '').replace(/^['"]|['"]$/g, '')
    } else if (t.startsWith('code:')) {
      cur.code = t.replace(/^code:\s*/, '').replace(/^['"]|['"]$/g, '')
    }
  }
  if (Object.keys(cur).length) steps.push(cur)

  steps.forEach(s => resolvePaths(s, getMdPath(env)))
  return buildComponent(steps)
}

// ─── 工具函数 ───

type StepItem = {
  icon?: string
  title?: string
  text: string
  image?: string
  images?: string[]
  imageSize?: string
  alt?: string
  code?: string
  code_type?: string
}

function getMdPath(env: any): string {
  return env?.relativePath || env?.filePath || env?.page?.relativePath || ''
}

function resolveRelative(base: string, rel: string): string {
  if (!base || (!rel.startsWith('./') && !rel.startsWith('../'))) return rel
  const dir = base.substring(0, base.lastIndexOf('/'))
  let result = dir
  for (const part of rel.split('/')) {
    if (part === '.') continue
    result = part === '..'
      ? result.substring(0, result.lastIndexOf('/'))
      : result + '/' + part
  }
  return result.startsWith('/') ? result : '/' + result
}

function resolvePaths(step: StepItem, mdPath: string): StepItem {
  if (step.image) step.image = resolveRelative(mdPath, step.image)
  if (step.images) step.images = step.images.map(p => resolveRelative(mdPath, p))
  if (step.icon) step.icon = resolveRelative(mdPath, step.icon)
  return step
}

function buildComponent(steps: StepItem[]): string {
  const json = JSON.stringify(steps).replace(/"/g, '&quot;')
  return `<StepList :steps="${json}" />`
}
