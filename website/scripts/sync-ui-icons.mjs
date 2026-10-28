/**
 * 从应用源码里抽出真实图标 SVG，生成 landing/icons.generated.ts。
 *
 * 为什么要有这一步：首页那个「产品窗口」要和真实界面一致，图标就不能手画线稿
 * （手画的大小/重心/线宽必然对不上）。这里直接读：
 *   - src/js/00-bootstrap.js 的 ICONS  —— 工具栏那 9 个按钮
 *   - src/index.html                    —— 全局操作栏（加监视器/WSL/ADB/BLE/MCP/调色板/日月/窗口按钮）
 * 应用改了图标，跑一次 `node website/scripts/sync-ui-icons.mjs` 或直接 `npm run docs:build`（prebuild 会跑）。
 *
 * 生成物不入库（见 .gitignore），和 docs/mcp/tools.md 同一套约定。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const out = resolve(here, '../docs/.vitepress/theme/components/landing/icons.generated.ts')

const js = readFileSync(resolve(repoRoot, 'src/js/00-bootstrap.js'), 'utf8')
const html = readFileSync(resolve(repoRoot, 'src/index.html'), 'utf8')

/** ICONS 里每条都是单行 `key: '<svg …></svg>',` */
const toolbar = {}
for (const m of js.matchAll(/^\s*(\w+)\s*:\s*'(<svg[\s\S]*?<\/svg>)',?\s*$/gm)) {
  toolbar[m[1]] = m[2]
}

const pick = (re) => {
  const m = html.match(re)
  return m ? m[1] : ''
}
const global = {
  add: pick(/id="addMonitorBtn"[\s\S]*?(<svg[\s\S]*?<\/svg>)/),
  wsl: pick(/id="wslToggleBtn"[\s\S]*?(<svg[\s\S]*?<\/svg>)/),
  adb: pick(/id="adbToggleBtn"[\s\S]*?(<svg[\s\S]*?<\/svg>)/),
  ble: pick(/id="bleToggleBtn"[\s\S]*?(<svg[\s\S]*?<\/svg>)/),
  mcp: pick(/id="mcpBtn"[\s\S]*?(<svg[\s\S]*?<\/svg>)/),
  palette: pick(/id="themeStyleWrap"[\s\S]*?(<svg[\s\S]*?<\/svg>)/),
  sun: pick(/class="theme-switch-icon sun">\s*(<svg[\s\S]*?<\/svg>)/),
  moon: pick(/class="theme-switch-icon moon">\s*(<svg[\s\S]*?<\/svg>)/),
}

const winCtrl = [...html.matchAll(/class="win-ctrl-btn[^"]*"[^>]*>\s*(<svg[\s\S]*?<\/svg>)/g)].map((m) => m[1])

const needToolbar = [
  'clear',
  'rollback',
  'reconnect',
  'terminal',
  'lineBuf',
  'lineNum',
  'timestamp',
  'copy',
  'settings',
  'saveLog',
  'copyAll',
  'chevronUp',
]
const missing = [
  ...needToolbar.filter((k) => !toolbar[k]),
  ...Object.entries(global)
    .filter(([, v]) => !v)
    .map(([k]) => 'global.' + k),
]
if (missing.length || winCtrl.length !== 3) {
  throw new Error(`图标抽取失败：缺 ${missing.join(', ')}；窗口按钮 ${winCtrl.length} 个（应为 3）`)
}

const banner = `/**
 * 自动生成，别手改 —— 由 website/scripts/sync-ui-icons.mjs 从
 * src/js/00-bootstrap.js（ICONS）与 src/index.html（全局操作栏）抽取。
 * 应用侧改了图标就重跑：node website/scripts/sync-ui-icons.mjs
 */

export interface UiIcons {
  /** 工具栏 ibtn 用的图标（键名与 ICONS 一致） */
  toolbar: Record<string, string>
  /** 全局操作栏 */
  global: Record<string, string>
  /** 最小化 / 最大化 / 关闭（顺序固定） */
  winCtrl: string[]
}

export const UI_ICONS: UiIcons = `

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, banner + JSON.stringify({ toolbar, global, winCtrl }, null, 2) + '\n', 'utf8')
console.log(
  `[icons] 抽取完成：工具栏 ${Object.keys(toolbar).length} 个、全局栏 ${Object.keys(global).length} 个、窗口按钮 ${winCtrl.length} 个`,
)
