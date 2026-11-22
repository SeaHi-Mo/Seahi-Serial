<template>
  <div class="step-list">
    <div v-for="(step, index) in steps" :key="index" class="step-item">
      <!-- 顶部：icon + 步骤标题 -->
      <div class="step-header">
        <div class="step-icon">
          <span class="step-icon-inner" v-if="step.icon && !step.icon.startsWith('/')"
            v-html="step.icon || (index + 1)"></span>
          <img v-else-if="step.icon" :src="withBase(step.icon)" alt="icon" class="step-icon-img" />
          <span v-else class="step-icon-inner">{{ index + 1 }}</span>
        </div>
        <div class="step-title">
          <span class="step-title-text">{{ step.title || `第 ${index + 1} 步` }}</span>
        </div>
      </div>
      <!-- 下方：内容卡片 -->
      <div class="step-content">
        <div class="step-body">
          <div class="step-text">
            <div v-html="renderMarkdown(step.text)"></div>
            <div v-if="step.code" class="step-code-container">
              <div class="step-code-wrapper">
                <pre
                  class="code-block"><code :class="`language-${step.code_type || 'plaintext'}`" v-html="highlightCode(step.code, step.code_type || 'plaintext')"></code></pre>
                <button class="step-copy-btn" onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent)">复制</button>
              </div>
            </div>
          </div>
          <div v-if="step.image" :style="step.imageSize ? { width: step.imageSize, maxWidth: '100%' } : {}"
            class="step-image-container">
            <img :src="withBase(step.image)" :alt="step.alt || `步骤 ${index + 1} 截图`" class="step-image" />
          </div>
          <div v-if="step.images && step.images.length" class="step-images-container">
            <img v-for="(img, i) in step.images" :key="i" :src="withBase(img)"
              :alt="`${step.alt || `步骤 ${index + 1} 截图`} ${i + 1}`" class="step-multi-image" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRoute, withBase } from 'vitepress'
import markdownIt from 'markdown-it'
import hljs from 'highlight.js'
import 'highlight.js/styles/github-dark.css'
import { ref } from 'vue'

const props = defineProps({
  steps: {
    type: Array as () => Array<{
      icon?: string
      title?: string
      text: string
      image?: string
      images?: string[]
      imageSize?: string
      alt?: string
      code?: string
      code_type?: string
    }>,
    required: true
  }
})

const route = useRoute()

const md = markdownIt({
  html: true,
  linkify: true,
  typographer: true,
  highlight: function (str, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="code-block"><code class="language-${lang}">${hljs.highlight(str, { language: lang }).value}</code></pre>`
      } catch (__) { }
    }
    return `<pre class="code-block"><code>${md.utils.escapeHtml(str)}</code></pre>`
  }
})

// 将步骤文字中的内部 .md 链接规范化为最终路由（如 ../x.md -> ../x.html）。
// StepList 在运行时渲染 markdown，绕过了 VitePress 对正文链接的构建期转换，
// 否则点击后会被 normalizeHref 追加成 xxx.md.html 导致 404。
const normalizeStepLink = (href: string): string => {
  if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) return href
  if (!href.includes('.md')) return href
  try {
    const base = new URL(route.path || '/', 'http://local')
    const url = new URL(href, base)
    if (url.origin !== base.origin) return href
    url.pathname = url.pathname.replace(/\.md$/, '.html')
    return url.pathname + url.search + url.hash
  } catch {
    return href
  }
}

const renderMarkdown = (text: string) => {
  let html = md.render(text)
  // 后处理 1：规范步骤文字里的内部 .md 链接
  html = html.replace(/<a\s+href="([^"]*)"/gi, (match, href) => {
    const decoded = href.replace(/&amp;/g, '&')
    const normalized = normalizeStepLink(decoded)
    return normalized === decoded
      ? match
      : `<a href="${md.utils.escapeHtml(normalized)}"`
  })
  // 后处理 2：给 <pre class="code-block"> 包裹一个带复制按钮的容器
  html = html.replace(
    /(<pre class="code-block"><code[^>]*>)([\s\S]*?)(<\/code><\/pre>)/g,
    (_match, open, code, close) => {
      const decoded = code
        .replace(/&amp;lt;/g, '<')
        .replace(/&amp;gt;/g, '>')
        .replace(/&amp;#39;/g, "'")
        .replace(/&amp;quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
      const escaped = decoded
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
      return `<div class="step-code-wrapper">${open}${code}${close}<button class="step-copy-btn" onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent)">复制</button></div>`
    }
  )
  return html
}

const highlightCode = (code: string, lang: string) => {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang }).value
    } catch (__) { }
  }
  return md.utils.escapeHtml(code)
}
</script>

<style scoped>
/* 组件自身元素样式 */
.step-list {
  margin: 2rem 0;
  padding: 0;
  list-style: none;
}

.step-item {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
  padding-bottom: 1rem;
  margin-left: 2rem;
}

.step-item::before {
  content: '';
  position: absolute;
  left: calc(-2rem + 1.2rem - 1px);
  top: 3rem;
  bottom: 0.5rem;
  width: 2px;
  background-color: #2db88e;
}

.step-header {
  display: flex;
  align-items: center;
  gap: 3rem;
  position: relative;
  min-height: 2.4rem;
}

.step-icon {
  position: absolute;
  left: -2rem;
  top: 50%;
  transform: translateY(-50%);
  width: 2.4rem;
  height: 2.4rem;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #2198e7;
  font-size: 1.2rem;
  flex-shrink: 0;
}

.step-icon-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  color: #00c853;
}

.step-title {
  color: var(--vp-c-text-1);
  font-size: 1rem;
  font-weight: 500;
  margin-left: 1rem;
}

.step-content {
  background-color: var(--vp-c-bg-alt);
  border: 1px solid #605e61;
  border-radius: 8px;
  padding: 1.5rem;
  margin-left: 1rem;
}

.step-body {
  display: flex;
  align-items: center;
  gap: 3rem;
  flex-wrap: wrap;
}

.step-text {
  flex: 1;
  min-width: 280px;
  color: var(--vp-c-text-2);
  line-height: 1.6;
}

.step-image-container {
  max-width: 400px;
  flex-shrink: 0;
}

.step-image {
  width: 100%;
  height: auto;
  border-radius: 6px;
}

/* 多图分栏：内容区域放得下就并排显示，放不下自动换行 */
.step-images-container {
  flex: 1 1 100%;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}

.step-multi-image {
  width: 100%;
  height: auto;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.dark .step-content {
  background-color: var(--vp-c-bg-alt);
  border-color: #605e61;
}
</style>

<style>
/* v-html 渲染内容的 Markdown 样式（不能 scoped，否则 v-html 内容不会继承） */
.step-text p {
  margin: 0.5rem 0;
}

.step-text p:first-child {
  margin-top: 0;
}

.step-text p:last-child {
  margin-bottom: 0;
}

/* 无序列表 */
.step-text ul {
  margin: 0.5rem 0;
  padding-left: 1.2rem;
  list-style-type: disc;
}

/* 有序列表 */
.step-text ol {
  margin: 0.5rem 0;
  padding-left: 1.2rem;
  list-style-type: decimal;
}

/* 列表项 */
.step-text li {
  margin: 0.25rem 0;
  line-height: 1.6;
}

/* 嵌套列表 */
.step-text li ul,
.step-text li ol {
  margin: 0.2rem 0;
}

/* 代码块包裹容器 */
.step-code-wrapper {
  position: relative;
  margin: 0.8rem 0;
  border-radius: 8px;
  overflow: hidden;
}

/* 代码块（始终深色背景，不随主题切换） */
.step-text pre,
.step-code-wrapper pre {
  background-color: #1e1e2e !important;
  border-radius: 8px;
  padding: 1rem;
  padding-right: 3.5rem;
  overflow-x: auto;
  margin: 0;
  color: #e0e0e0;
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.step-text code {
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 0.9rem;
}

/* 行内代码 */
.step-text :not(pre) > code {
  background-color: var(--vp-c-default-soft);
  padding: 0.15rem 0.4rem;
  border-radius: 4px;
  color: var(--vp-c-brand-1);
}

/* 代码块内的 code 不加行内背景 */
.step-text pre code {
  background-color: transparent;
  padding: 0;
  border-radius: 0;
  color: inherit;
}

/* 复制按钮 */
.step-copy-btn {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  padding: 0.25rem 0.6rem;
  font-size: 0.75rem;
  color: rgba(255, 255, 255, 0.5);
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s;
  opacity: 0;
  z-index: 1;
}

.step-code-wrapper:hover .step-copy-btn {
  opacity: 1;
}

.step-copy-btn:hover {
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
}

.step-copy-btn:active {
  transform: scale(0.95);
}

/* 引用块 */
.step-text blockquote {
  margin: 0.5rem 0;
  padding: 0.5rem 1rem;
  border-left: 3px solid var(--vp-c-brand-1);
  color: var(--vp-c-text-2);
  background-color: var(--vp-c-default-soft);
  border-radius: 0 4px 4px 0;
}

.step-text blockquote p {
  margin: 0.2rem 0;
}

/* 表格 */
.step-text table {
  width: 100%;
  border-collapse: collapse;
  margin: 0.8rem 0;
  font-size: 0.9rem;
}

.step-text th,
.step-text td {
  padding: 0.5rem 0.8rem;
  border: 1px solid var(--vp-c-divider);
  text-align: left;
}

.step-text th {
  background-color: var(--vp-c-bg-alt);
  font-weight: 600;
}

/* 标题 */
.step-text h1,
.step-text h2,
.step-text h3,
.step-text h4,
.step-text h5,
.step-text h6 {
  margin: 0.8rem 0 0.4rem;
  font-weight: 600;
  line-height: 1.3;
  color: var(--vp-c-text-1);
}

.step-text h1 { font-size: 1.25rem; }
.step-text h2 { font-size: 1.15rem; }
.step-text h3 { font-size: 1.05rem; }

/* 链接 */
.step-text a {
  color: var(--vp-c-brand-1);
  text-decoration: none;
}

.step-text a:hover {
  text-decoration: underline;
}

/* 水平分隔线 */
.step-text hr {
  border: none;
  border-top: 1px solid var(--vp-c-divider);
  margin: 0.8rem 0;
}

/* 粗体和斜体 */
.step-text strong {
  color: var(--vp-c-text-1);
}

.step-text em {
  font-style: italic;
}

/* 图片 */
.step-text img {
  max-width: 100%;
  border-radius: 6px;
}
</style>
