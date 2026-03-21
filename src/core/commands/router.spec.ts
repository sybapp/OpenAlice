import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SessionEntry, SessionStore } from '../session.js'
import { LocalCommandRouter } from './router.js'
import { compactCommandHandler } from './handlers/compact.js'
import { LOCAL_COMMAND_METADATA, UNHANDLED_LOCAL_COMMAND_RESULT } from './types.js'

function makeSession(entries: SessionEntry[] = []): SessionStore {
  const store = [...entries]
  return {
    id: 'session-1',
    appendUser: vi.fn(async (content: string | unknown, _provider?: string, metadata?: Record<string, unknown>) => {
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
    }),
    appendAssistant: vi.fn(async (content: string | unknown, _provider?: string, metadata?: Record<string, unknown>) => {
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
    }),
    appendSystem: async () => { throw new Error('not used') },
    appendRaw: async (entry: SessionEntry) => { store.push(entry) },
    readAll: async () => [...store],
    readActive: async () => [...store],
    restore: async () => {},
    exists: async () => true,
  } as unknown as SessionStore
}

describe('LocalCommandRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns unhandled for unknown commands', async () => {
    const router = new LocalCommandRouter([compactCommandHandler])
    const session = makeSession()

    const result = await router.handle('/unknown', { session })

    expect(result).toEqual(UNHANDLED_LOCAL_COMMAND_RESULT)
  })


  it('uses the interactive runtime catalog for manual compaction', async () => {
    const router = new LocalCommandRouter([compactCommandHandler])
    const session = makeSession([
      {
        type: 'user',
        message: { role: 'user', content: 'Need summary' },
        uuid: 'u-0',
        parentUuid: null,
        sessionId: 'session-1',
        timestamp: new Date().toISOString(),
      },
    ])
    const ask = vi.fn(async () => ({ text: '<summary>summarized</summary>', media: [] }))

    const result = await router.handle('/compact', {
      session,
      engineContext: {
        runtimeCatalog: { interactive: { ask }, providerOnlyJob: {} as never, trader: {} as never },
        config: { agent: { claudeCode: { disallowedTools: [] }, evolutionMode: false } },
      } as never,
    })

    expect(result.handled).toBe(true)
    expect(result.text).toContain('Compacted. Pre-compaction: ~')
    expect(ask).toHaveBeenCalledOnce()
  })

  it('returns a runtime-context error for /compact when engine context is missing', async () => {
    const router = new LocalCommandRouter([compactCommandHandler])
    const session = makeSession()

    const result = await router.handle('/compact', { session })

    expect(result.handled).toBe(true)
    expect(result.text).toBe('Compact is unavailable because runtime context is missing.')
    expect(session.appendUser).toHaveBeenCalledWith('/compact', 'human', LOCAL_COMMAND_METADATA)
    expect(session.appendAssistant).toHaveBeenCalledWith(
      'Compact is unavailable because runtime context is missing.',
      'engine',
      LOCAL_COMMAND_METADATA,
    )
  })
})
