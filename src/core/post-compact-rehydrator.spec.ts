import { describe, expect, it } from 'vitest'
import { rehydratePostCompactContext } from './post-compact-rehydrator.js'
import type { SessionEntry } from './session.js'

function entry(overrides: Partial<SessionEntry>): SessionEntry {
  return {
    type: 'user',
    message: { role: 'user', content: 'hello' },
    uuid: 'u1',
    parentUuid: null,
    sessionId: 's1',
    timestamp: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('rehydratePostCompactContext', () => {
  it('returns empty rehydration when no compact boundary exists', () => {
    const result = rehydratePostCompactContext([entry({ uuid: 'u1' })])
    expect(result.isCompactContinuation).toBe(false)
    expect(result.recallHint).toBe('')
  })

  it('extracts summary and preserved ids from compact boundary', () => {
    const result = rehydratePostCompactContext([
      entry({ uuid: 'old', message: { role: 'user', content: 'old context' } }),
      entry({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'boundary',
        message: { role: 'system', content: 'Conversation compacted' },
        compactMetadata: {
          trigger: 'auto',
          preTokens: 100,
          summaryUuid: 'summary-1',
          preservedEntryUuids: ['old'],
          preservedToolUseIds: ['tool-1'],
        },
      }),
      entry({ uuid: 'summary-1', isCompactSummary: true, message: { role: 'user', content: 'summary' } }),
    ])

    expect(result.isCompactContinuation).toBe(true)
    expect(result.summaryUuid).toBe('summary-1')
    expect(result.preservedEntryUuids).toEqual(['old'])
    expect(result.preservedToolUseIds).toEqual(['tool-1'])
    expect(result.recallHint).toContain('summary-1')
    expect(result.recallHint).toContain('tool-1')
  })
})
