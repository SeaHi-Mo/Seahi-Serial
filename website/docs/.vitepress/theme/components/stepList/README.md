# StepList 组件

VitePress 自定义步骤列表组件，用于在 Markdown 文档中渲染带图标的步骤流程卡片。支持 Markdown 全语法（代码块、列表、表格等）和 highlight.js 代码高亮。

## 文件结构

```
stepList/
├── README.md              # 本文档
├── StepList.vue           # Vue 组件（渲染层）
└── stepsContainer.ts      # Markdown-It 插件（解析层）
```

## 架构

```
Markdown 文档
    ↓ VitePress 编译
stepsContainer.ts (Markdown-It 插件)
    ↓ 拦截 ```steps 代码围栏 或 :::steps::: 容器
    ↓ 解析 YAML / 旧格式配置
    ↓ JSON.stringify 序列化
输出: <StepList :steps="[...]" />
    ↓ Vue 渲染
StepList.vue
    ↓ 接收 steps prop
    ↓ markdown-it 渲染 text 字段
    ↓ highlight.js 高亮 code 字段
    ↓ 插入 DOM
```

## 注册方式

在 `docs/.vitepress/theme/index.ts` 中全局注册：

```ts
import StepList from './components/stepList/StepList.vue'

export default {
  enhanceApp({ app }) {
    app.component('StepList', StepList)
  }
}
```

## Props

| 属性 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `steps` | `StepItem[]` | 是 | 步骤数据数组 |

### StepItem

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `icon` | `string` | 否 | 图标：emoji（如 `"📋"`）、HTML（如 `"①"`）、图片路径（如 `"/img/icon.png"`）。省略则显示序号 |
| `title` | `string` | 否 | 步骤标题。省略则显示"第 N 步" |
| `text` | `string` | 是 | 步骤描述，支持完整 Markdown 语法 |
| `image` | `string` | 否 | 右侧配图路径，支持相对路径自动解析 |
| `imageSize` | `string` | 否 | 图片宽度，如 `"300px"` |
| `alt` | `string` | 否 | 图片 alt 文本 |
| `code` | `string` | 否 | 独立代码块（text 下方），支持 highlight.js 高亮 |
| `code_type` | `string` | 否 | 代码语言，默认 `"plaintext"` |

## 在 Markdown 中使用

### 方式一：YAML 格式（推荐）

用 `:::steps` 容器 + YAML 数据，支持多行 Markdown 内容：

```markdown
:::steps
---
- icon: "📋"
  title: 安装依赖
  text: |
    运行以下命令安装项目依赖：

    ```bash
    npm install
    npm run dev
    ```

    环境要求：
    - **Node.js** >= 18
    - **pnpm** >= 8

    > 注意：需要管理员权限

---

- icon: "⚙️"
  title: 配置项目
  text: |
    修改 `config.yaml` 文件：

    ```yaml
    server:
      port: 3000
      host: localhost
    ```

---

- icon: "🚀"
  title: 启动服务
  image: ./images/start.png
  imageSize: 400px
  text: 访问 `http://localhost:3000` 验证服务是否正常运行。
:::
```

### 方式二：代码围栏格式

用 ` ```steps ` 代码围栏包裹，适合简单场景：

```markdown
```steps
- icon: "📋"
  title: 第一步
  text: 简单的描述文本

- icon: "⚙️"
  title: 第二步
  text: 下一步操作
```
```

> **注意**：代码围栏格式下，`text` 字段不能包含三反引号代码块（会提前闭合外层围栏）。多行内容请用 `:::steps` 格式。

### 方式三：旧格式（单行）

最简单的写法，`text` 为单行文本，用 `<br>` 换行：

```markdown
```steps
- icon: ①
  title: 安装 STM32CubeMX
  text: 下载并安装 STM32CubeIDE <br> > STM32CubeIDE 是 ST 官方一站式开发环境。

- icon: ②
  title: 配置环境
  text: 1. **C/C++** 代码补全 <br>2. **Cortex-Debug** 调试支持 <br> 3. **CMake** 构建集成
  image: /img/setup.png
  imageSize: 300px
```
```

## text 字段支持的 Markdown 语法

| 语法 | 示例 |
|------|------|
| 代码块 | ` ```bash\ncode\n``` ` |
| 行内代码 | `` `variable` `` |
| 无序列表 | `- item` |
| 有序列表 | `1. item` |
| 粗体 | `**text**` |
| 斜体 | `*text*` |
| 链接 | `[text](url)` |
| 引用块 | `> quote` |
| 表格 | `\| a \| b \|` |
| 标题 | `## Heading` |
| 图片 | `![alt](url)` |
| 水平线 | `---` |

> **YAML 块标量写法**：多行 `text` 必须用 `|` 块标量，内容缩进 2 格。空行表示段落分隔。

## 图片路径

- 绝对路径：`/img/example.png`
- 相对路径：`./images/example.png`（相对于当前 `.md` 文件自动解析）

## 样式说明

组件分两个 `<style>` 块：

| 块 | 作用域 | 覆盖范围 |
|---|---|---|
| `<style scoped>` | 组件元素 | `.step-list`, `.step-item`, `.step-content` 等结构样式 |
| `<style>` (非 scoped) | Markdown 内容 | `v-html` 渲染出的 `ul`, `li`, `pre`, `code`, `blockquote`, `table` 等 |

非 scoped 样式是必须的——Vue 的 `scoped` CSS 不会作用于 `v-html` 插入的 DOM 元素。

## 依赖

- `markdown-it` — Markdown 解析
- `highlight.js` — 代码语法高亮
- `js-yaml` — YAML 解析（仅 `stepsContainer.ts`）
- `vitepress` — `withBase` 用于资源路径处理
