import type { SkillPack } from './registry.js'
import { ANALYSIS_REPORT_INSTRUCTIONS } from './analysis-report.js'
import { compileGlobPatterns, matchesAnyGlobPattern } from '../../openclaw/agents/glob-pattern.js'

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

export function isSkillToolAllowed(name: string, allow?: string[], deny?: string[]): boolean {
  const normalized = normalize(name)
  const denyPatterns = compileGlobPatterns({ raw: deny, normalize })
  if (matchesAnyGlobPattern(normalized, denyPatterns)) {
    return false
  }
  const allowPatterns = compileGlobPatterns({ raw: allow, normalize })
  if (allowPatterns.length === 0) {
    return true
  }
  return matchesAnyGlobPattern(normalized, allowPatterns)
}

export function filterToolsBySkillPolicy<T>(tools: Record<string, T>, allow?: string[], deny?: string[]): Record<string, T> {
  const filtered: Record<string, T> = {}
  for (const [name, tool] of Object.entries(tools)) {
    if (isSkillToolAllowed(name, allow, deny)) {
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
  return `Preferred tool order: ${preferredTools.join(', ')}.`
}

export function buildSkillPromptText(skill: SkillPack | null | undefined): string {
  if (!skill) return ''
  return [
    `Active skill: ${skill.id} (${skill.label})`,
    skill.whenToUse ? `When to use:\n${skill.whenToUse}` : '',
    skill.instructions ? `Instructions:\n${skill.instructions}` : '',
    skill.safetyNotes ? `Safety notes:\n${skill.safetyNotes}` : '',
    buildPreferredToolsText(skill.preferredTools),
    `Output schema: ${skill.outputSchema}.`,
    ANALYSIS_REPORT_INSTRUCTIONS,
  ].filter(Boolean).join('\n\n')
}
