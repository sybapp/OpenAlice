import { describe, it, expect } from 'vitest'
import { filterToolsBySkillPolicy, isSkillToolAllowed, mapSkillDenyToClaudeTools } from './policy.js'

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
})
