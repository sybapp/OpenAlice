import { describe, expect, it, vi } from 'vitest'
import { handleSkillCommand } from './command.js'
import { getSessionSkillIdFromEntries } from './session-skill.js'
import type { SessionEntry, SessionStore } from '../core/session.js'

vi.mock('./catalog.js', () => ({
  buildSkillCatalog: vi.fn(async () => ({
    userInvocableSkills: [
      { id: 'ta-brooks', label: 'Brooks Price Action', description: 'Brooks', runtime: 'agent-skill', userInvocable: true, resources: [], allowedScripts: [] },
      { id: 'ta-ict-smc', label: 'ICT / SMC', description: 'ICT', runtime: 'agent-skill', userInvocable: true, resources: [], allowedScripts: [] },
    ],
  })),
  getUserInvocableSkill: vi.fn(async (id: string) => {
    if (id === 'ta-brooks') return { id: 'ta-brooks', label: 'Brooks Price Action', description: 'Brooks', runtime: 'agent-skill', userInvocable: true, resources: [], allowedScripts: [] }
    if (id === 'ta-ict-smc') return { id: 'ta-ict-smc', label: 'ICT / SMC', description: 'ICT', runtime: 'agent-skill', userInvocable: true, resources: [], allowedScripts: [] }
    return null
  }),
}))

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
  it('lists only user-invocable skills', async () => {
    const session = makeSession()
    const result = await handleSkillCommand('/skill list', session)

    expect(result.handled).toBe(true)
    expect(result.text).toContain('Available skills:')
    expect(result.text).toContain('ta-brooks')
    expect(result.text).not.toContain('trader-risk-check')
  })

  it('persists and clears the active skill through session markers', async () => {
    const session = makeSession()

    await handleSkillCommand('/skill ta-brooks', session)
    await handleSkillCommand('/skill off', session)
    await handleSkillCommand('/skill ta-ict-smc', session)

    expect(getSessionSkillIdFromEntries(await session.readAll())).toBe('ta-ict-smc')
  })

  it('rejects unknown skills from manual activation', async () => {
    const session = makeSession()

    const result = await handleSkillCommand('/skill trader-risk-check', session)

    expect(result.handled).toBe(true)
    expect(result.text).toContain('Unknown skill: trader-risk-check')
    expect(getSessionSkillIdFromEntries(await session.readAll())).toBeNull()
  })
})
