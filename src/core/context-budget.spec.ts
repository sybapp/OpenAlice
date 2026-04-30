import { describe, expect, it } from 'vitest'
import { applyContextBudget } from './context-budget.js'
import type { ContextSection } from './context-assembler.js'

describe('applyContextBudget', () => {
  it('keeps required sections and truncates memory by memory budget', () => {
    const sections: ContextSection[] = [
      { kind: 'persona', title: 'Persona', content: 'persona', priority: 'required' },
      { kind: 'memory', title: 'Memory', content: 'm'.repeat(1000), priority: 'normal' },
      { kind: 'history_context', title: 'History', content: 'history', priority: 'required' },
    ]

    const result = applyContextBudget(sections, { memoryMaxTokens: 20 })

    expect(result.sections.find((s) => s.kind === 'persona')?.included).toBe(true)
    const memory = result.sections.find((s) => s.kind === 'memory')
    expect(memory?.included).toBe(true)
    expect(memory?.truncated).toBe(true)
    expect(memory?.reason).toBe('memoryMaxTokens')
    expect(result.report.memoryTokens).toBeLessThanOrEqual(25)
  })

  it('drops low priority optional sections when system budget is exhausted', () => {
    const sections: ContextSection[] = [
      { kind: 'persona', title: 'Persona', content: 'persona', priority: 'required' },
      { kind: 'channel', title: 'Channel', content: 'c'.repeat(1000), priority: 'low' },
      { kind: 'history_context', title: 'History', content: 'history', priority: 'required' },
    ]

    const result = applyContextBudget(sections, { systemContextMaxTokens: 5 })
    const channel = result.sections.find((s) => s.kind === 'channel')

    expect(result.sections.find((s) => s.kind === 'persona')?.included).toBe(true)
    expect(channel?.included).toBe(false)
    expect(channel?.reason).toBe('systemContextMaxTokens')
  })
})
