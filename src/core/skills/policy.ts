import type { ToolPolicy, ToolInventoryItem } from '../tool-center.js'
import type { SkillPack } from './registry.js'
import { ANALYSIS_REPORT_INSTRUCTIONS } from './analysis-report.js'
import { createGlobPolicyMatcher } from '../tool-policy-match.js'

export function isSkillToolAllowed(name: string, allow?: string[], deny?: string[]): boolean {
  const matchesDeny = createGlobPolicyMatcher(deny)
  if (matchesDeny([name])) {
    return false
  }
  if (!allow || allow.length === 0) {
    return true
  }
  return createGlobPolicyMatcher(allow)([name])
}

export function filterToolsBySkillPolicy<T>(tools: Record<string, T>, allow?: string[], deny?: string[]): Record<string, T> {
  const filtered: Record<string, T> = {}
  const matchesAllow = createGlobPolicyMatcher(allow)
  const matchesDeny = createGlobPolicyMatcher(deny)
  const hasAllow = Boolean(allow?.length)
  for (const [name, tool] of Object.entries(tools)) {
    if (matchesDeny([name])) continue
    if (!hasAllow || matchesAllow([name])) {
      filtered[name] = tool
    }
  }
  return filtered
}

export function mapSkillDenyToClaudeTools(deny?: string[]): string[] {
  return (deny ?? []).map((pattern) => `mcp__open-alice__${pattern}`)
}

export function buildPreferredToolsText(preferredTools: string[]): string {
  if (preferredTools.length === 0) return ''
  return `Preferred tools: ${preferredTools.join(', ')}.`
}

function buildDecisionWindowText(skill: SkillPack): string {
  if (skill.analysisMode !== 'tool-first') return ''
  if (!skill.decisionWindowBars) return ''
  return [
    'Decision flow: tool-first, decision-last.',
    'Use deterministic tools to process OHLCV, structure, indicators, liquidity, or retrieval before reasoning.',
    `Never ask the LLM to ingest long raw market series. Only use the most recent decision window of ${skill.decisionWindowBars} bars plus structured tool output.`,
    'For market-structure skills, prefer the skill-specific deterministic aggregate tool first and keep the LLM focused on summary, trade-offs, and narrative.',
    'The LLM must judge, summarize, and decide from structured results rather than replacing low-level structure recognition.',
  ].join(' ')
}

function buildToolPolicyText(skill: SkillPack): string {
  const lines: string[] = []
  if (skill.toolAllow?.length) lines.push(`Allowed tool patterns: ${skill.toolAllow.join(', ')}.`)
  if (skill.toolDeny?.length) lines.push(`Denied tool patterns: ${skill.toolDeny.join(', ')}.`)
  return lines.join(' ')
}

function buildOutputSchemaText(skill: SkillPack): string {
  if (skill.outputSchema === 'AnalysisReport') {
    return `Output schema: ${skill.outputSchema}. ${ANALYSIS_REPORT_INSTRUCTIONS}`
  }
  return `Output schema: ${skill.outputSchema}. Follow the skill-specific output format exactly.`
}

export function buildSkillPromptText(skill: SkillPack | null | undefined): string {
  if (!skill) return ''
  return [
    `Active skill: ${skill.id} (${skill.label})`,
    skill.description ? `Description: ${skill.description}` : '',
    skill.whenToUse ? `When to use:\n${skill.whenToUse}` : '',
    skill.instructions ? `Instructions:\n${skill.instructions}` : '',
    skill.safetyNotes ? `Safety notes:\n${skill.safetyNotes}` : '',
    buildPreferredToolsText(skill.preferredTools),
    buildToolPolicyText(skill),
    buildDecisionWindowText(skill),
    buildOutputSchemaText(skill),
  ].filter(Boolean).join('\n\n')
}

export function getSkillToolPolicy(skill: SkillPack | null | undefined): ToolPolicy | undefined {
  if (!skill) return undefined
  return {
    allow: skill.toolAllow,
    deny: skill.toolDeny,
  }
}

function patternMatchesInventory(pattern: string, inventory: ToolInventoryItem[]): boolean {
  const matcher = createGlobPolicyMatcher([pattern])
  return inventory.some((item) => matcher([item.name, item.group]))
}

export function validateSkillToolReferences(skill: SkillPack, inventory: ToolInventoryItem[]): string[] {
  const warnings: string[] = []
  for (const [field, patterns] of [
    ['preferredTools', skill.preferredTools],
    ['toolAllow', skill.toolAllow ?? []],
    ['toolDeny', skill.toolDeny ?? []],
  ] as const) {
    for (const pattern of patterns) {
      if (!patternMatchesInventory(pattern, inventory)) {
        warnings.push(`[skill:${skill.id}] ${field} pattern did not match any registered tool or group: ${pattern}`)
      }
    }
  }
  return warnings
}
