import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Brain } from '../domain/brain/index.js'
import type { SessionEntry } from './session.js'
import type { BrainMemoryStore, MemoryEntry } from './brain-memory-store.js'
import { applyContextBudget, type ContextBudget, type ContextBudgetReport, type ContextSectionPriority } from './context-budget.js'
import { rehydratePostCompactContext, type PostCompactRehydration } from './post-compact-rehydrator.js'

export type ContextSectionKind =
  | 'persona'
  | 'frontal_lobe'
  | 'memory'
  | 'runtime'
  | 'channel'
  | 'history_context'

export interface ContextSection {
  kind: ContextSectionKind
  title: string
  content: string
  priority?: ContextSectionPriority
  maxChars?: number
  tokenEstimate?: number
  included?: boolean
  truncated?: boolean
  reason?: string
}

export interface ContextBundle {
  systemPrompt: string
  activeEntries: SessionEntry[]
  sections: ContextSection[]
  recalledMemory: MemoryEntry[]
  report: ContextAssemblyReport
}

export interface ContextAssemblyReport extends ContextBudgetReport {
  memoryIgnored: boolean
  recalledMemoryCount: number
  recalledMemoryIds: string[]
  alreadySurfacedMemoryIds: string[]
  compact: PostCompactRehydration
}

export interface BrainContextConfig {
  frontalLobeStaleHours: number
  frontalLobeCriticalStaleHours: number
  frontalLobeMaxChars: number
  memoryRecallLimit: number
  memoryEntryMaxChars: number
  memoryAlreadySurfacedWindow: number
}

export interface ContextAssemblerOptions {
  brain: Brain
  memoryStore: BrainMemoryStore
  config?: Partial<BrainContextConfig>
  budget?: ContextBudget
  personaFile?: string
  fallbackSystemPrompt?: () => Promise<string>
}

export interface AssembleContextOptions {
  activeEntries: SessionEntry[]
  prompt: string
  channelContext?: string
  systemPromptOverride?: string
  recentToolNames?: string[]
  alreadySurfacedMemoryIds?: string[]
}

export const DEFAULT_BRAIN_CONTEXT_CONFIG: BrainContextConfig = {
  frontalLobeStaleHours: 24,
  frontalLobeCriticalStaleHours: 72,
  frontalLobeMaxChars: 4000,
  memoryRecallLimit: 5,
  memoryEntryMaxChars: 1600,
  memoryAlreadySurfacedWindow: 20,
}

export class ContextAssembler {
  private config: BrainContextConfig
  private personaFile: string

  constructor(private opts: ContextAssemblerOptions) {
    this.config = { ...DEFAULT_BRAIN_CONTEXT_CONFIG, ...opts.config }
    this.personaFile = opts.personaFile ?? resolve('data/brain/persona.md')
  }

  async assemble(options: AssembleContextOptions): Promise<ContextBundle> {
    const sections: ContextSection[] = []
    const compact = rehydratePostCompactContext(options.activeEntries)
    const memoryIgnored = shouldIgnoreMemory(options.prompt)
    const alreadySurfacedMemoryIds = [
      ...(options.alreadySurfacedMemoryIds ?? []),
      ...collectSurfacedMemoryIds(options.activeEntries, this.config.memoryAlreadySurfacedWindow),
    ]

    const persona = options.systemPromptOverride ?? await this.readPersona()
    if (persona.trim()) {
      sections.push({ kind: 'persona', title: 'Persona', content: persona.trim(), priority: 'required' })
    }

    const frontalLobeSection = this.buildFrontalLobeSection()
    if (frontalLobeSection) sections.push(frontalLobeSection)

    const recalledMemory = memoryIgnored ? [] : await this.opts.memoryStore.recall({
      query: this.buildRecallQuery(options, compact),
      recentToolNames: options.recentToolNames,
      excludedIds: alreadySurfacedMemoryIds,
      limit: this.config.memoryRecallLimit,
      entryMaxChars: this.config.memoryEntryMaxChars,
    })
    if (recalledMemory.length > 0) {
      sections.push({
        kind: 'memory',
        title: 'Recalled Long-Term Memory',
        content: renderMemory(recalledMemory),
        priority: 'normal',
      })
    }

    const runtime = this.buildRuntimeSection()
    if (runtime) sections.push(runtime)

    if (options.channelContext?.trim()) {
      sections.push({
        kind: 'channel',
        title: 'Channel Context',
        content: options.channelContext.trim(),
        priority: 'normal',
      })
    }

    sections.push({
      kind: 'history_context',
      title: 'History Context',
      content: 'The active session entries supplied with this request remain the source of truth for the current conversation. Compact summaries are continuation context only. Recalled memory is advisory and should be checked against current tools when facts may have changed.',
      priority: 'required',
    })

    const { sections: budgetedSections, report } = applyContextBudget(sections, this.opts.budget)

    return {
      systemPrompt: renderSections(budgetedSections),
      activeEntries: options.activeEntries,
      sections: budgetedSections,
      recalledMemory,
      report: {
        ...report,
        memoryIgnored,
        recalledMemoryCount: recalledMemory.length,
        recalledMemoryIds: recalledMemory.map((entry) => entry.id),
        alreadySurfacedMemoryIds,
        compact,
      },
    }
  }

  private async readPersona(): Promise<string> {
    try {
      return await readFile(this.personaFile, 'utf-8')
    } catch {
      return this.opts.fallbackSystemPrompt?.() ?? ''
    }
  }

  private buildFrontalLobeSection(): ContextSection | null {
    const { content, updatedAt } = this.opts.brain.getFrontalLobeMeta()
    if (!content.trim()) {
      return {
        kind: 'frontal_lobe',
        title: 'Frontal Lobe',
        content: 'No active frontal-lobe note is set. If this round creates a short-term working stance, write it with updateFrontalLobe.',
        priority: 'high',
      }
    }

    const warning = buildStaleWarning(updatedAt, this.config)
    const parts = [
      updatedAt ? `Updated: ${updatedAt} (${formatRelativeAge(updatedAt)})` : 'Updated: unknown',
      warning,
      truncate(content.trim(), this.config.frontalLobeMaxChars),
    ].filter(Boolean)

    return {
      kind: 'frontal_lobe',
      title: 'Frontal Lobe',
      content: parts.join('\n\n'),
      priority: 'high',
      maxChars: this.config.frontalLobeMaxChars + 500,
    }
  }

  private buildRuntimeSection(): ContextSection {
    return {
      kind: 'runtime',
      title: 'Runtime Context',
      content: [
        `Current time: ${new Date().toISOString()}`,
        `Working directory: ${process.cwd()}`,
        'Context policy: data/sessions/*.jsonl is the conversation source of truth. data/brain/frontal-lobe.md is short-term working state. data/brain/memory/*.md is long-term memory recalled as needed.',
      ].join('\n'),
      priority: 'required',
    }
  }

  private buildRecallQuery(options: AssembleContextOptions, compact: PostCompactRehydration): string {
    const recentText = options.activeEntries
      .slice(-8)
      .map((entry) => entryText(entry))
      .join('\n')
    return [options.prompt, compact.recallHint, recentText].filter(Boolean).join('\n')
  }
}

export function buildStaleWarning(
  updatedAt: string | null,
  config: BrainContextConfig = DEFAULT_BRAIN_CONTEXT_CONFIG,
): string {
  if (!updatedAt) return ''

  const ageHours = (Date.now() - new Date(updatedAt).getTime()) / 3_600_000
  if (!Number.isFinite(ageHours) || ageHours < config.frontalLobeStaleHours) return ''

  if (ageHours >= config.frontalLobeCriticalStaleHours) {
    return `STALE WARNING: this frontal-lobe note is older than ${config.frontalLobeCriticalStaleHours}h. Before ending this round, update it, clear it, or explicitly confirm it is still applicable.`
  }

  return `STALE NOTICE: this frontal-lobe note is older than ${config.frontalLobeStaleHours}h. Review whether it still applies before relying on it.`
}

function renderSections(sections: ContextSection[]): string {
  return sections
    .filter((section) => section.included !== false && section.content.trim())
    .map((section) => `## ${section.title}\n\n${section.content.trim()}`)
    .join('\n\n---\n\n')
}

function renderMemory(entries: MemoryEntry[]): string {
  return entries.map((entry) => {
    const meta = [
      `id=${entry.id}`,
      `type=${entry.type}`,
      `file=${dirname(entry.path).endsWith('/memory') ? entry.path.split('/').slice(-2).join('/') : entry.path}`,
      entry.description ? `description=${entry.description}` : '',
      entry.keywords.length ? `keywords=${entry.keywords.join(', ')}` : '',
    ].filter(Boolean).join('; ')

    return `### ${entry.title}\n${meta}\n\nUse this as long-term preference/constraint context only. Verify current files, prices, positions, configs, and tool state before relying on factual claims.\n\n${entry.content}`
  }).join('\n\n')
}

function shouldIgnoreMemory(prompt: string): boolean {
  const normalized = prompt.toLowerCase()
  return [
    'ignore memory',
    'ignore memories',
    'do not use memory',
    "don't use memory",
    'without memory',
    '不要使用记忆',
    '忽略记忆',
    '别用记忆',
  ].some((needle) => normalized.includes(needle))
}

function collectSurfacedMemoryIds(entries: SessionEntry[], window: number): string[] {
  const ids = new Set<string>()
  const recent = entries.slice(-Math.max(0, window))
  for (const entry of recent) {
    const text = entryText(entry)
    for (const match of text.matchAll(/id=([A-Za-z0-9_.-]+)/g)) {
      ids.add(match[1])
    }
  }
  return [...ids]
}

function entryText(entry: SessionEntry): string {
  const content = entry.message.content
  if (typeof content === 'string') return content
  return content
    .map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'tool_use') return `${block.name} ${JSON.stringify(block.input)}`
      if (block.type === 'tool_result') return block.content
      return ''
    })
    .join('\n')
}

function formatRelativeAge(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(diffMs) || diffMs < 0) return 'in the future'
  if (diffMs < 60_000) return 'just now'
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text
  return `${text.slice(0, maxChars).trimEnd()}\n[truncated]`
}
