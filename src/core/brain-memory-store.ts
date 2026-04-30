import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

export type MemoryEntryType =
  | 'user'
  | 'feedback'
  | 'project'
  | 'trading'
  | 'reference'
  | 'general'

export interface MemoryEntry {
  id: string
  type: MemoryEntryType
  title: string
  description?: string
  keywords: string[]
  path: string
  updatedAt?: string
  content: string
}

export interface MemoryRecallOptions {
  query?: string
  recentToolNames?: string[]
  limit?: number
  entryMaxChars?: number
}

export interface BrainMemoryStoreConfig {
  memoryDir?: string
  recallLimit?: number
  entryMaxChars?: number
}

const DEFAULT_RECALL_LIMIT = 5
const DEFAULT_ENTRY_MAX_CHARS = 1600
const MEMORY_FILENAME_RE = /^(user|feedback|project|trading|reference)_[\w.-]+\.md$/i

interface ParsedMarkdown {
  frontmatter: Record<string, unknown>
  body: string
}

export class BrainMemoryStore {
  private memoryDir: string
  private recallLimit: number
  private entryMaxChars: number

  constructor(config: BrainMemoryStoreConfig = {}) {
    this.memoryDir = config.memoryDir ?? resolve('data/brain/memory')
    this.recallLimit = config.recallLimit ?? DEFAULT_RECALL_LIMIT
    this.entryMaxChars = config.entryMaxChars ?? DEFAULT_ENTRY_MAX_CHARS
  }

  async list(): Promise<MemoryEntry[]> {
    if (!await this.exists()) return []

    const manifestFiles = await this.readManifestFilenames()
    const filenames = manifestFiles.length > 0
      ? manifestFiles
      : await this.scanMemoryFilenames()

    const entries = await Promise.all(
      filenames.map((filename) => this.readEntry(filename).catch(() => null)),
    )
    return entries.filter((entry): entry is MemoryEntry => entry !== null)
  }

  async recall(options: MemoryRecallOptions = {}): Promise<MemoryEntry[]> {
    const entries = await this.list()
    if (entries.length === 0) return []

    const limit = options.limit ?? this.recallLimit
    const entryMaxChars = options.entryMaxChars ?? this.entryMaxChars
    const queryTerms = tokenize([
      options.query ?? '',
      ...(options.recentToolNames ?? []),
    ].join(' '))

    const scored = entries
      .map((entry) => ({
        entry: {
          ...entry,
          content: truncate(entry.content.trim(), entryMaxChars),
        },
        score: scoreEntry(entry, queryTerms, options.recentToolNames ?? []),
      }))
      .filter(({ score }) => score > 0 || queryTerms.length === 0)
      .sort((a, b) => b.score - a.score || compareUpdatedAt(b.entry, a.entry))

    return scored.slice(0, Math.max(0, limit)).map(({ entry }) => entry)
  }

  private async exists(): Promise<boolean> {
    try {
      return (await stat(this.memoryDir)).isDirectory()
    } catch {
      return false
    }
  }

  private async readManifestFilenames(): Promise<string[]> {
    const manifestPath = join(this.memoryDir, 'MEMORY.md')
    let raw = ''
    try {
      raw = await readFile(manifestPath, 'utf-8')
    } catch {
      return []
    }

    const filenames = new Set<string>()
    for (const match of raw.matchAll(/(?:\(|^|\s)(?:\.\/|memory\/)?([\w.-]+\.md)(?:\)|\s|$)/g)) {
      const filename = basename(match[1])
      if (filename !== 'MEMORY.md' && MEMORY_FILENAME_RE.test(filename)) {
        filenames.add(filename)
      }
    }
    return [...filenames]
  }

  private async scanMemoryFilenames(): Promise<string[]> {
    try {
      const filenames = await readdir(this.memoryDir)
      return filenames
        .filter((filename) => filename !== 'MEMORY.md' && MEMORY_FILENAME_RE.test(filename))
        .sort()
    } catch {
      return []
    }
  }

  private async readEntry(filename: string): Promise<MemoryEntry | null> {
    const path = join(this.memoryDir, basename(filename))
    const raw = await readFile(path, 'utf-8')
    const { frontmatter, body } = parseMarkdown(raw)
    const inferred = inferType(filename)

    return {
      id: String(frontmatter.id ?? filename.replace(/\.md$/i, '')),
      type: parseType(frontmatter.type, inferred),
      title: String(frontmatter.title ?? firstHeading(body) ?? filename.replace(/\.md$/i, '')),
      description: optionalString(frontmatter.description),
      keywords: parseKeywords(frontmatter.keywords),
      updatedAt: optionalString(frontmatter.updatedAt ?? frontmatter.updated_at),
      path,
      content: body.trim(),
    }
  }
}

function parseMarkdown(raw: string): ParsedMarkdown {
  if (!raw.startsWith('---\n')) return { frontmatter: {}, body: raw }

  const end = raw.indexOf('\n---', 4)
  if (end === -1) return { frontmatter: {}, body: raw }

  const frontmatterRaw = raw.slice(4, end).trim()
  const body = raw.slice(end + 4).replace(/^\n/, '')
  return { frontmatter: parseFrontmatter(frontmatterRaw), body }
}

function parseFrontmatter(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const line of raw.split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!match) continue
    const [, key, valueRaw] = match
    const value = valueRaw.trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      out[key] = value.slice(1, -1).split(',').map((v) => stripQuotes(v.trim())).filter(Boolean)
    } else {
      out[key] = stripQuotes(value)
    }
  }
  return out
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, '')
}

function inferType(filename: string): MemoryEntryType {
  const match = filename.match(/^([a-z]+)_/i)
  return parseType(match?.[1], 'general')
}

function parseType(value: unknown, fallback: MemoryEntryType): MemoryEntryType {
  const type = typeof value === 'string' ? value.toLowerCase() : ''
  if (type === 'user' || type === 'feedback' || type === 'project' || type === 'trading' || type === 'reference') {
    return type
  }
  return fallback
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function parseKeywords(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((v) => v.trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean)
  return []
}

function firstHeading(body: string): string | undefined {
  const match = body.match(/^#\s+(.+)$/m)
  return match?.[1]?.trim()
}

function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])]
}

function scoreEntry(entry: MemoryEntry, queryTerms: string[], recentToolNames: string[]): number {
  const haystack = [
    entry.type,
    entry.title,
    entry.description ?? '',
    entry.keywords.join(' '),
    entry.content.slice(0, 1000),
  ].join(' ').toLowerCase()

  let score = 0
  for (const term of queryTerms) {
    if (entry.keywords.some((keyword) => keyword.toLowerCase() === term)) score += 5
    else if (haystack.includes(term)) score += 2
  }

  for (const tool of recentToolNames) {
    const lower = tool.toLowerCase()
    if (lower.includes('trading') || lower.includes('market') || lower.includes('equity')) {
      if (entry.type === 'trading') score += 3
    }
    if (lower.includes('browser') && entry.type === 'reference') score += 2
  }

  if (entry.type === 'user' || entry.type === 'feedback') score += 1
  return score
}

function compareUpdatedAt(a: MemoryEntry, b: MemoryEntry): number {
  const aMs = a.updatedAt ? new Date(a.updatedAt).getTime() : 0
  const bMs = b.updatedAt ? new Date(b.updatedAt).getTime() : 0
  return aMs - bMs
}

function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text
  return `${text.slice(0, maxChars).trimEnd()}\n[truncated]`
}
