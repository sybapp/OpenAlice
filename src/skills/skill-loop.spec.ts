import { describe, expect, it, vi } from 'vitest'
import { SkillLoopRunner } from './skill-loop.js'
import type { SkillPack } from './registry.js'
import type { SessionEntry, SessionStore } from '../core/session.js'

vi.mock('./script-registry.js', () => ({
  listSkillScripts: vi.fn(() => [{
    id: 'analysis-brooks',
    description: 'Brooks analysis',
    inputGuide: 'Use an object like {"asset":"crypto","symbol":"BTC/USDT:USDT","timeframes":{"context":"1h","structure":"15m","execution":"5m"}}. timeframes must be a named object, never an array.',
  }]),
  getSkillScript: vi.fn(() => ({
    id: 'analysis-brooks',
    description: 'Brooks analysis',
    inputSchema: {
      parse: (value: unknown) => value,
    },
    run: vi.fn(async (_ctx: unknown, input: unknown) => ({
      ok: true,
      input,
    })),
  })),
}))

function makeSession(entries: SessionEntry[] = []): SessionStore {
  const store = [...entries]
  return {
    id: 'session-1',
    appendUser: vi.fn(async (content: string | unknown) => {
      const entry: SessionEntry = {
        type: 'user',
        message: { role: 'user', content: content as string },
        uuid: `u-${store.length}`,
        parentUuid: null,
        sessionId: 'session-1',
        timestamp: new Date().toISOString(),
      }
      store.push(entry)
      return entry
    }),
    appendAssistant: vi.fn(async (content: string | unknown) => {
      const entry: SessionEntry = {
        type: 'assistant',
        message: { role: 'assistant', content: content as string },
        uuid: `a-${store.length}`,
        parentUuid: null,
        sessionId: 'session-1',
        timestamp: new Date().toISOString(),
      }
      store.push(entry)
      return entry
    }),
    appendSystem: vi.fn(async () => {
      throw new Error('not used')
    }),
    appendRaw: vi.fn(async (entry: SessionEntry) => {
      store.push(entry)
    }),
    readAll: vi.fn(async () => [...store]),
    readActive: vi.fn(async () => [...store]),
    restore: vi.fn(async () => {}),
    exists: vi.fn(async () => true),
  } as unknown as SessionStore
}

describe('SkillLoopRunner', () => {
  it('accepts wrapped requestScripts envelopes and continues the loop', async () => {
    const askWithSession = vi
      .fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          requestScripts: {
            type: 'request_scripts',
            calls: [
              { id: 'analysis-brooks', input: { symbol: 'BTC-USD', timeframe: '5m' } },
              { id: 'analysis-brooks', input: { symbol: 'BTC-USD', timeframe: '15m' } },
            ],
          },
        }),
        media: [],
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          complete: {
            type: 'complete',
            output: { text: 'done' },
          },
        }),
        media: [],
      })

    const runner = new SkillLoopRunner(
      { askWithSession } as never,
      {
        config: {} as never,
        eventLog: {} as never,
        brain: {} as never,
        accountManager: {} as never,
        marketData: {} as never,
        ohlcvStore: {} as never,
        newsStore: {} as never,
        getAccountGit: vi.fn(),
      },
    )

    const skill: SkillPack = {
      id: 'ta-brooks',
      label: 'Brooks',
      description: 'Brooks analysis',
      runtime: 'script-loop',
      userInvocable: true,
      preferredTools: [],
      toolAllow: undefined,
      toolDeny: undefined,
      allowedScripts: ['analysis-brooks'],
      outputSchema: 'ChatResponse',
      decisionWindowBars: 10,
      analysisMode: 'tool-first',
      whenToUse: '',
      instructions: '',
      safetyNotes: '',
      examples: '',
      resources: [],
      body: '',
      sourcePath: '/tmp/SKILL.md',
    }
    vi.spyOn(runner, 'getActiveScriptSkill').mockResolvedValue(skill)

    const session = makeSession()
    const result = await runner.run('analyze BTC', session)

    expect(result).toEqual({ text: 'done', media: [] })
    expect(askWithSession).toHaveBeenCalledTimes(2)
    expect(String(askWithSession.mock.calls[0][0])).toContain('Never use positional arrays as a shortcut for named objects.')
    expect(String(askWithSession.mock.calls[0][0])).toContain('timeframes must be a named object, never an array.')
    expect(String(askWithSession.mock.calls[0][0])).toContain('{"context":"1h","structure":"15m","execution":"5m"}')
    expect(session.appendUser).toHaveBeenCalledWith('analyze BTC', 'human')
    expect(session.appendAssistant).toHaveBeenCalledWith('done', 'engine', {
      kind: 'skill_loop',
      skillId: 'ta-brooks',
    })
  })
})
