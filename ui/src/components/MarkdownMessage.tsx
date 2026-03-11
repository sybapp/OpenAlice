import { useMemo, useRef, useEffect, useCallback } from 'react'
import { Marked } from 'marked'
import { markedHighlight } from 'marked-highlight'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import plaintext from 'highlight.js/lib/languages/plaintext'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import DOMPurify from 'dompurify'
import 'highlight.js/styles/github-dark.min.css'

function registerLanguage(name: string, language: Parameters<typeof hljs.registerLanguage>[1], aliases: string[] = []) {
  hljs.registerLanguage(name, language)
  for (const alias of aliases) {
    hljs.registerLanguage(alias, language)
  }
}

registerLanguage('bash', bash, ['sh', 'shell', 'zsh'])
registerLanguage('css', css)
registerLanguage('diff', diff, ['patch'])
registerLanguage('javascript', javascript, ['js', 'jsx'])
registerLanguage('json', json)
registerLanguage('markdown', markdown, ['md'])
registerLanguage('plaintext', plaintext, ['text', 'txt'])
registerLanguage('python', python, ['py'])
registerLanguage('sql', sql)
registerLanguage('typescript', typescript, ['ts', 'tsx'])
registerLanguage('xml', xml, ['html'])
registerLanguage('yaml', yaml, ['yml'])

const AUTO_DETECT_LANGUAGES = [
  'bash',
  'css',
  'diff',
  'javascript',
  'json',
  'markdown',
  'plaintext',
  'python',
  'sql',
  'typescript',
  'xml',
  'yaml',
]

const marked = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value
      }
      return hljs.highlightAuto(code, AUTO_DETECT_LANGUAGES).value
    },
  }),
  { breaks: true },
)

const COPY_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`
const CHECK_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`

function addCodeBlockWrappers(html: string): string {
  return html.replace(
    /<pre><code class="hljs language-(\w+)">([\s\S]*?)<\/code><\/pre>/g,
    (_, lang, code) =>
      `<div class="code-block-wrapper"><div class="code-header"><span>${lang}</span><button class="code-copy-btn" data-code>${COPY_ICON} Copy</button></div><pre><code class="hljs language-${lang}">${code}</code></pre></div>`,
  ).replace(
    /<pre><code class="hljs">([\s\S]*?)<\/code><\/pre>/g,
    (_, code) =>
      `<div class="code-block-wrapper"><div class="code-header"><span>code</span><button class="code-copy-btn" data-code>${COPY_ICON} Copy</button></div><pre><code class="hljs">${code}</code></pre></div>`,
  )
}

export interface MarkdownMessageProps {
  text: string
  media?: Array<{ type: string; url: string }>
  prefixText?: string
}

export function MarkdownMessage({ text, media, prefixText }: MarkdownMessageProps) {
  const contentRef = useRef<HTMLDivElement>(null)

  const html = useMemo(() => {
    const raw = DOMPurify.sanitize(marked.parse(text) as string)
    return `${prefixText ?? ''}${addCodeBlockWrappers(raw)}`
  }, [prefixText, text])

  const handleCopyClick = useCallback((e: MouseEvent) => {
    const btn = (e.target as HTMLElement).closest('.code-copy-btn') as HTMLButtonElement | null
    if (!btn) return
    const wrapper = btn.closest('.code-block-wrapper')
    const code = wrapper?.querySelector('code')?.textContent ?? ''
    navigator.clipboard.writeText(code).then(() => {
      btn.innerHTML = `${CHECK_ICON} Copied!`
      btn.classList.add('copied')
      setTimeout(() => {
        btn.innerHTML = `${COPY_ICON} Copy`
        btn.classList.remove('copied')
      }, 2000)
    })
  }, [])

  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    el.addEventListener('click', handleCopyClick)
    return () => el.removeEventListener('click', handleCopyClick)
  }, [handleCopyClick])

  return (
    <div ref={contentRef}>
      <div className="markdown-content" dangerouslySetInnerHTML={{ __html: html }} />
      {media?.map((m, i) => (
        <img key={i} src={m.url} alt="" className="max-w-full rounded-lg mt-2" />
      ))}
    </div>
  )
}
