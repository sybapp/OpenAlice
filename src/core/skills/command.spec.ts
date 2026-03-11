import { describe, expect, it } from 'vitest'
import { handleSkillCommand } from './command.js'
import { getSessionSkillIdFromEntries } from './session-skill.js'
import type { SessionEntry, SessionStore } from '../session.js'

function makeSession(entries: SessionEntry[] = []): SessionStore {
  const store = [...entries]
  return {
    id: 'session-1',
    appendUser: async (content: string | unknown, _provider?: string, metadata?: Record<string, unknown>) => {
      const entry: SessionEntry = {
        type: 'user',
        message: { role: 'user', content: content as string },
        uuid: `u-${store.length}`,
        parentUuid: null,
        sessionId: 'session-1',
        timestamp: new Date().toISOString(),
        ...(metadata ? { metadata } : {}),
      }
      store.push(entry)
      return entry
    },
    appendAssistant: async (content: string | unknown, _provider?: string, metadata?: Record<string, unknown>) => {
      const entry: SessionEntry = {
        type: 'assistant',
        message: { role: 'assistant', content: content as string },
        uuid: `a-${store.length}`,
        parentUuid: null,
        sessionId: 'session-1',
        timestamp: new Date().toISOString(),
        ...(metadata ? { metadata } : {}),
      }
      store.push(entry)
      return entry
    },
    appendSystem: async () => { throw new Error('not used') },
    appendRaw: async (entry: SessionEntry) => { store.push(entry) },
    readAll: async () => [...store],
    readActive: async () => [...store],
    restore: async () => {},
    exists: async () => true,
  } as unknown as SessionStore
}

describe('skill command', () => {
  it('lists bundled skills', async () => {
    const session = makeSession()
    const result = await handleSkillCommand('/skill list', session)

    expect(result.handled).toBe(true)
    expect(result.text).toContain('Available skills:')
  })

  it('persists and clears the active skill through session markers', async () => {
    const session = makeSession()

    await handleSkillCommand('/skill ta-brooks', session)
    await handleSkillCommand('/skill off', session)
    await handleSkillCommand('/skill ta-ict-smc', session)

    expect(getSessionSkillIdFromEntries(await session.readAll())).toBe('ta-ict-smc')
  })
})
