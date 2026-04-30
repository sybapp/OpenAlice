import { estimateTokens } from './compaction.js'
import type { ContextSection } from './context-assembler.js'

export type ContextSectionPriority = 'required' | 'high' | 'normal' | 'low'

export interface ContextBudget {
  systemContextMaxTokens?: number
  memoryMaxTokens?: number
}

export interface ContextSectionReport {
  kind: ContextSection['kind']
  title: string
  tokenEstimate: number
  included: boolean
  truncated: boolean
  reason?: string
}

export interface ContextBudgetReport {
  systemContextMaxTokens?: number
  memoryMaxTokens?: number
  totalTokens: number
  memoryTokens: number
  sections: ContextSectionReport[]
}

const CHARS_PER_TOKEN = 3.5

export function applyContextBudget(
  sections: ContextSection[],
  budget: ContextBudget = {},
): { sections: ContextSection[]; report: ContextBudgetReport } {
  let prepared = sections.map((section) => applySectionMaxChars(section))

  if (budget.memoryMaxTokens !== undefined) {
    prepared = prepared.map((section) => {
      if (section.kind !== 'memory') return section
      return truncateSectionToTokens(section, budget.memoryMaxTokens!, 'memoryMaxTokens')
    })
  }

  if (budget.systemContextMaxTokens === undefined) {
    const included = prepared.map((section) => markIncluded(section))
    return { sections: included, report: buildReport(included, budget) }
  }

  const maxTokens = Math.max(0, budget.systemContextMaxTokens)
  const required = prepared.filter((section) => section.priority === 'required')
  const optional = prepared.filter((section) => section.priority !== 'required')
    .sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority))

  const included: ContextSection[] = required.map((section) => markIncluded(section))
  let usedTokens = included.reduce((sum, section) => sum + estimateTokens(section.content), 0)

  for (const section of optional) {
    const sectionTokens = estimateTokens(section.content)
    if (usedTokens + sectionTokens <= maxTokens) {
      included.push(markIncluded(section))
      usedTokens += sectionTokens
      continue
    }

    const remainingTokens = maxTokens - usedTokens
    if (remainingTokens >= 20) {
      const truncated = truncateSectionToTokens(section, remainingTokens, 'systemContextMaxTokens')
      included.push(markIncluded(truncated))
      usedTokens += estimateTokens(truncated.content)
    } else {
      included.push(markExcluded(section, 'systemContextMaxTokens'))
    }
  }

  const ordered = restoreOriginalOrder(prepared, included)
  return { sections: ordered, report: buildReport(ordered, budget) }
}

function applySectionMaxChars(section: ContextSection): ContextSection {
  if (!section.maxChars || section.content.length <= section.maxChars) {
    return { ...section, tokenEstimate: estimateTokens(section.content) }
  }
  return {
    ...section,
    content: `${section.content.slice(0, section.maxChars).trimEnd()}\n[truncated]`,
    tokenEstimate: estimateTokens(section.content.slice(0, section.maxChars)),
    truncated: true,
    reason: section.reason ?? 'maxChars',
  }
}

function truncateSectionToTokens(section: ContextSection, maxTokens: number, reason: string): ContextSection {
  const maxChars = Math.max(0, Math.floor(maxTokens * CHARS_PER_TOKEN))
  if (estimateTokens(section.content) <= maxTokens) {
    return { ...section, tokenEstimate: estimateTokens(section.content) }
  }
  return {
    ...section,
    content: `${section.content.slice(0, maxChars).trimEnd()}\n[truncated]`,
    tokenEstimate: estimateTokens(section.content.slice(0, maxChars)),
    truncated: true,
    reason,
  }
}

function markIncluded(section: ContextSection): ContextSection {
  return {
    ...section,
    included: true,
    tokenEstimate: estimateTokens(section.content),
  }
}

function markExcluded(section: ContextSection, reason: string): ContextSection {
  return {
    ...section,
    included: false,
    reason,
    tokenEstimate: estimateTokens(section.content),
  }
}

function buildReport(sections: ContextSection[], budget: ContextBudget): ContextBudgetReport {
  const included = sections.filter((section) => section.included !== false)
  const memorySections = included.filter((section) => section.kind === 'memory')
  return {
    systemContextMaxTokens: budget.systemContextMaxTokens,
    memoryMaxTokens: budget.memoryMaxTokens,
    totalTokens: included.reduce((sum, section) => sum + estimateTokens(section.content), 0),
    memoryTokens: memorySections.reduce((sum, section) => sum + estimateTokens(section.content), 0),
    sections: sections.map((section) => ({
      kind: section.kind,
      title: section.title,
      tokenEstimate: estimateTokens(section.content),
      included: section.included !== false,
      truncated: section.truncated === true,
      reason: section.reason,
    })),
  }
}

function priorityRank(priority: ContextSection['priority']): number {
  if (priority === 'required') return 100
  if (priority === 'high') return 75
  if (priority === 'normal') return 50
  return 25
}

function restoreOriginalOrder(original: ContextSection[], changed: ContextSection[]): ContextSection[] {
  const byKindTitle = new Map(changed.map((section) => [`${section.kind}:${section.title}`, section]))
  return original.map((section) => byKindTitle.get(`${section.kind}:${section.title}`) ?? section)
}
