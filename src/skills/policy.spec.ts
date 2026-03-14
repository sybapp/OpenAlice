import { describe, it, expect } from 'vitest'
import {
  buildSkillPromptText,
  filterToolsBySkillPolicy,
  isSkillToolAllowed,
  mapSkillDenyToClaudeTools,
  validateSkillToolReferences,
} from './policy.js'
import type { SkillPack } from './registry.js'

const baseSkill: SkillPack = {
  id: 'ta-brooks',
  label: 'Brooks',
  description: 'Brooks price action mode',
  preferredTools: ['brooksPaAnalyze', 'analysis*'],
  toolAllow: ['brooksPaAnalyze', 'analysis*', 'market-search*'],
  toolDeny: ['trading*', 'cronAdd'],
  outputSchema: 'AnalysisReport',
  decisionWindowBars: 10,
  analysisMode: 'tool-first',
  whenToUse: 'Use for price action',
  instructions: 'Use Brooks terminology',
  safetyNotes: 'No trades',
  examples: '- example',
  body: '# Brooks\n\n## Instructions\nUse Brooks terminology',
  sourcePath: '/tmp/ta-brooks/SKILL.md',
}

describe('skill tool policy', () => {
  it('allows all when allow list is empty and deny does not match', () => {
    expect(isSkillToolAllowed('newsGetWorld', undefined, ['trading*'])).toBe(true)
  })

  it('applies allow globs and lets deny override allow', () => {
    expect(isSkillToolAllowed('newsGetWorld', ['news*', 'trading*'], ['trading*'])).toBe(true)
    expect(isSkillToolAllowed('tradingCommit', ['news*', 'trading*'], ['trading*'])).toBe(false)
  })

  it('filters tool maps by policy', () => {
    const tools = {
      newsGetWorld: { description: 'news' },
      tradingCommit: { description: 'trade' },
      cronAdd: { description: 'cron' },
    }

    const filtered = filterToolsBySkillPolicy(tools, ['news*', 'trading*'], ['trading*', 'cron*'])

    expect(Object.keys(filtered)).toEqual(['newsGetWorld'])
  })

  it('maps deny rules to Claude MCP tool patterns', () => {
    expect(mapSkillDenyToClaudeTools(['trading*', 'cronAdd'])).toEqual([
      'mcp__open-alice__trading*',
      'mcp__open-alice__cronAdd',
    ])
  })

  it('builds skill prompts from normalized plugin-style content', () => {
    const prompt = buildSkillPromptText(baseSkill)
    expect(prompt).toContain('Active skill: ta-brooks (Brooks)')
    expect(prompt).toContain('Preferred tools: brooksPaAnalyze, analysis*.')
    expect(prompt).toContain('Instructions:\nUse Brooks terminology')
    expect(prompt).toContain('Safety notes:\nNo trades')
    expect(prompt).toContain('Examples:\n- example')
    expect(prompt).toContain('most recent decision window of 10 bars')
    expect(prompt).toContain('prefer the skill-specific deterministic aggregate tool first')
    expect(prompt).toContain('Output schema: AnalysisReport.')
  })

  it('validates tool references against inventory by tool name or group', () => {
    const warnings = validateSkillToolReferences(baseSkill, [
      { name: 'brooksPaAnalyze', group: 'analysis', description: '' },
      { name: 'marketSearchForResearch', group: 'market-search', description: '' },
      { name: 'tradingCommit', group: 'trading', description: '' },
      { name: 'cronAdd', group: 'cron', description: '' },
    ])

    expect(warnings).toEqual([])
  })

  it('warns when declared tool references do not match inventory', () => {
    const warnings = validateSkillToolReferences({
      ...baseSkill,
      preferredTools: ['brooksPaAnalyze', 'missingTool'],
    }, [
      { name: 'brooksPaAnalyze', group: 'analysis', description: '' },
    ])

    expect(warnings).toEqual([
      '[skill:ta-brooks] preferredTools pattern did not match any registered tool or group: missingTool',
      '[skill:ta-brooks] toolAllow pattern did not match any registered tool or group: market-search*',
      '[skill:ta-brooks] toolDeny pattern did not match any registered tool or group: trading*',
      '[skill:ta-brooks] toolDeny pattern did not match any registered tool or group: cronAdd',
    ])
  })
})
