import { describe, expect, it, vi } from 'vitest'
import type { SessionEntry, SessionStore } from '../core/session.js'
import { executeStructuredAgentSkill, invokeAgentSkill, parseAgentSkillOutput } from './service.js'

function makeSession(entries: SessionEntry[] = []): SessionStore {
  const store = [...entries]
  return {
    id: 'skill-session',
    appendUser: vi.fn(async () => undefined),
    appendAssistant: vi.fn(async () => undefined),
    appendSystem: vi.fn(async () => undefined),
    appendRaw: vi.fn(async (entry: SessionEntry) => { store.push(entry) }),
    readAll: vi.fn(async () => [...store]),
    readActive: vi.fn(async () => [...store]),
    restore: vi.fn(async () => undefined),
    exists: vi.fn(async () => true),
  } as unknown as SessionStore
}

describe('AgentSkill service', () => {
  it('invokes an agent skill through the runtime and returns loop trace metadata', async () => {
    const session = makeSession([
      {
        type: 'system',
        message: { role: 'system', content: 'skill-loop trace' },
        metadata: {
          kind: 'skill_loop_trace',
          skillId: 'ta-brooks',
          loadedResources: ['references/checklist'],
          scriptCalls: [{ id: 'analysis-brooks', input: { symbol: 'BTC/USDT:USDT' } }],
          iterations: 2,
        },
        uuid: 't-1',
        parentUuid: null,
        sessionId: 'skill-session',
        timestamp: new Date().toISOString(),
      } as SessionEntry,
    ])
    const runtime = {
      askWithSession: vi.fn(async () => ({ text: 'done', media: [] })),
    }

    const result = await invokeAgentSkill({
      runtime,
      session,
      skillId: 'ta-brooks',
      task: 'analyze btc',
      requiredScriptCalls: [{ id: 'analysis-brooks' }],
    })

    expect(runtime.askWithSession).toHaveBeenCalledWith(
      'analyze btc',
      session,
      expect.objectContaining({
        skillContext: expect.objectContaining({ requiredScriptCalls: [{ id: 'analysis-brooks' }] }),
      }),
    )
    expect(result.trace).toEqual(expect.objectContaining({
      skillId: 'ta-brooks',
      requiredScriptCalls: [{ id: 'analysis-brooks' }],
      resources: ['references/checklist'],
      scriptCalls: [{ id: 'analysis-brooks', input: { symbol: 'BTC/USDT:USDT' } }],
      iterations: 2,
    }))
  })

  it('forwards extra ask options while preserving skill context assembly', async () => {
    const session = makeSession()
    const runtime = {
      askWithSession: vi.fn(async () => ({ text: 'done', media: [] })),
    }

    await invokeAgentSkill({
      runtime,
      session,
      skillId: 'trader-market-scan',
      task: 'scan',
      askOptions: { systemPrompt: 'Use structured trader policy.' },
      historyPreamble: 'history',
      maxHistoryEntries: 7,
      skillContext: { snapshot: { exposure: 12 } },
      requiredScriptCalls: [{ id: 'analysis-brooks' }],
    })

    expect(runtime.askWithSession).toHaveBeenCalledWith('scan', session, {
      systemPrompt: 'Use structured trader policy.',
      historyPreamble: 'history',
      maxHistoryEntries: 7,
      skillContext: {
        snapshot: { exposure: 12 },
        requiredScriptCalls: [{ id: 'analysis-brooks' }],
      },
    })
  })

  it('parses structured completion payloads for typed agent-skill calls', async () => {
    const session = makeSession()
    const runtime = {
      askWithSession: vi.fn(async () => ({
        text: JSON.stringify({ type: 'complete', output: { summary: 'ok', confidence: 0.7 } }),
        media: [],
      })),
    }
    const schema = {
      parse: (value: unknown) => value as { summary: string; confidence: number },
    }

    const result = await executeStructuredAgentSkill({
      runtime,
      session,
      skillId: 'custom-skill',
      task: 'summarize',
      schema,
    })

    expect(result.output).toEqual({ summary: 'ok', confidence: 0.7 })
    expect(result.rawText).toContain('complete')
    expect(result.trace.skillId).toBe('custom-skill')
  })

  it('parses wrapped completion payloads used by higher-level product flows', () => {
    const schema = {
      parse: (value: unknown) => value as { status: string; rationale: string },
    }

    expect(parseAgentSkillOutput(
      JSON.stringify({ text: { type: 'complete', output: { status: 'skip', rationale: 'No setup' } } }),
      schema,
    )).toEqual({ status: 'skip', rationale: 'No setup' })
  })
})
