import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LanguageModel, Tool } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { Engine } from './engine.js'
import { AgentCenter } from './agent-center.js'
import { DEFAULT_COMPACTION_CONFIG, type CompactionConfig } from './compaction.js'
import { VercelAIProvider } from '../ai-providers/vercel-ai-sdk/vercel-provider.js'
import { createModelFromConfig } from './model-factory.js'
import type { SessionStore, SessionEntry } from './session.js'
import { getSessionSkillIdFromEntries } from './skills/session-skill.js'
import { toChatHistory, toModelMessages, toTextHistory } from './session.js'

// ==================== Helpers ====================

/** Minimal LanguageModelV3GenerateResult for the mock. */
function makeDoGenerate(text = 'mock response') {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, text: 5, reasoning: undefined },
    },
    warnings: [],
  }
}

function makeMockModel(text = 'mock response') {
  return new MockLanguageModelV3({ doGenerate: makeDoGenerate(text) })
}

interface MakeEngineOpts {
  model?: LanguageModel
  tools?: Record<string, Tool>
  instructions?: string
  maxSteps?: number
  compaction?: CompactionConfig
}

function makeEngine(overrides: MakeEngineOpts = {}): Engine {
  const model = overrides.model ?? makeMockModel()
  const tools = overrides.tools ?? {}
  const instructions = overrides.instructions ?? 'You are a test agent.'
  const maxSteps = overrides.maxSteps ?? 1
  const compaction = overrides.compaction ?? DEFAULT_COMPACTION_CONFIG

  vi.mocked(createModelFromConfig).mockResolvedValue({ model, key: 'test:mock-model' })
  const provider = new VercelAIProvider(() => tools, instructions, maxSteps, compaction)
  const agentCenter = new AgentCenter(provider)

  return new Engine({ agentCenter })
}

/** In-memory SessionStore mock (no filesystem). */
function makeSessionMock(entries: SessionEntry[] = []): SessionStore {
  const store: SessionEntry[] = [...entries]
  return {
    id: 'test-session',
    appendUser: vi.fn(async (content: string, _provider?: string, metadata?: Record<string, unknown>) => {
      const e: SessionEntry = {
        type: 'user',
        message: { role: 'user', content },
        uuid: `u-${store.length}`,
        parentUuid: null,
        sessionId: 'test-session',
        timestamp: new Date().toISOString(),
        ...(metadata ? { metadata } : {}),
      }
      store.push(e)
      return e
    }),
    appendAssistant: vi.fn(async (content: string, _provider?: string, metadata?: Record<string, unknown>) => {
      const e: SessionEntry = {
        type: 'assistant',
        message: { role: 'assistant', content },
        uuid: `a-${store.length}`,
        parentUuid: null,
        sessionId: 'test-session',
        timestamp: new Date().toISOString(),
        ...(metadata ? { metadata } : {}),
      }
      store.push(e)
      return e
    }),
    appendSystem: vi.fn(async (content: string, _provider?: string, metadata?: Record<string, unknown>) => {
      const e: SessionEntry = {
        type: 'system',
        message: { role: 'system', content },
        uuid: `s-${store.length}`,
        parentUuid: null,
        sessionId: 'test-session',
        timestamp: new Date().toISOString(),
        ...(metadata ? { metadata } : {}),
      }
      store.push(e)
      return e
    }),
    appendRaw: vi.fn(async (entry: SessionEntry) => { store.push(entry) }),
    readAll: vi.fn(async () => [...store]),
    readActive: vi.fn(async () => [...store]),
    restore: vi.fn(async () => {}),
    exists: vi.fn(async () => store.length > 0),
  } as unknown as SessionStore
}

// ==================== Mock model-factory ====================

vi.mock('./model-factory.js', () => ({
  createModelFromConfig: vi.fn(),
}))

vi.mock('./skills/registry.js', () => ({
  listSkillPacks: vi.fn(async () => [
    { id: 'ta-brooks', label: 'Brooks Price Action' },
    { id: 'ta-ict-smc', label: 'ICT / SMC' },
  ]),
  getSkillPack: vi.fn(async (id: string) => {
    if (id === 'ta-brooks') return { id: 'ta-brooks', label: 'Brooks Price Action' }
    if (id === 'ta-ict-smc') return { id: 'ta-ict-smc', label: 'ICT / SMC' }
    return null
  }),
}))

// ==================== Mock compaction ====================

vi.mock('./compaction.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./compaction.js')>()
  return {
    ...actual,
    compactIfNeeded: vi.fn().mockResolvedValue({ compacted: false, method: 'none' }),
  }
})

// ==================== Tests ====================

describe('Engine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -------------------- Construction --------------------

  describe('constructor', () => {
    it('creates an engine with agentCenter', () => {
      const engine = makeEngine({ instructions: 'custom instructions' })
      expect(engine).toBeInstanceOf(Engine)
    })
  })

  // -------------------- ask() --------------------

  describe('ask()', () => {
    it('returns text from the model', async () => {
      const model = makeMockModel('hello world')
      const engine = makeEngine({ model })

      const result = await engine.ask('say hello')
      expect(result.text).toBe('hello world')
      expect(result.media).toEqual([])
    })

    it('returns empty string when model returns null text', async () => {
      const model = new MockLanguageModelV3({
        doGenerate: {
          content: [],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 0, text: 0, reasoning: undefined },
          },
          warnings: [],
        },
      })
      const engine = makeEngine({ model })

      const result = await engine.ask('empty response')
      expect(result.text).toBe('')
    })

    it('collects media from tool results via onStepFinish', async () => {
      // Use a model that produces tool calls to test media extraction.
      // Since MockLanguageModelV3 doesn't easily simulate multi-step tool calls,
      // we'll test media extraction at the unit level separately.
      // Here we verify the basic flow returns empty media when no tools produce media.
      const model = makeMockModel('no media')
      const engine = makeEngine({ model })

      const result = await engine.ask('test')
      expect(result.media).toEqual([])
    })
  })

  // -------------------- askWithSession() --------------------

  describe('askWithSession()', () => {
    it('short-circuits /skill commands without calling provider', async () => {
      const model = makeMockModel('session response')
      const engine = makeEngine({ model })
      const session = makeSessionMock()
      const askSpy = vi.spyOn(AgentCenter.prototype, 'askWithSession')

      const result = await engine.askWithSession('/skill list', session)

      expect(result.text).toContain('Available skills:')
      expect(result.media).toEqual([])
      expect(askSpy).not.toHaveBeenCalled()
      expect(session.appendUser).toHaveBeenCalledWith('/skill list', 'human', { kind: 'local_command' })
      expect(session.appendAssistant).toHaveBeenCalledWith(expect.stringContaining('Available skills:'), 'engine', { kind: 'local_command' })
    })

    it('appends user message to session before generating', async () => {
      const model = makeMockModel('session response')
      const engine = makeEngine({ model })
      const session = makeSessionMock()

      await engine.askWithSession('user prompt', session)

      expect(session.appendUser).toHaveBeenCalledWith('user prompt', 'human')
    })

    it('appends assistant response to session after generating', async () => {
      const model = makeMockModel('assistant reply')
      const engine = makeEngine({ model })
      const session = makeSessionMock()

      await engine.askWithSession('hello', session)

      expect(session.appendAssistant).toHaveBeenCalledWith('assistant reply', 'engine')
    })

    it('returns the generated text and empty media', async () => {
      const model = makeMockModel('generated text')
      const engine = makeEngine({ model })
      const session = makeSessionMock()

      const result = await engine.askWithSession('prompt', session)
      expect(result.text).toBe('generated text')
      expect(result.media).toEqual([])
    })

    it('calls compactIfNeeded with session and compaction config', async () => {
      const { compactIfNeeded } = await import('./compaction.js')
      const model = makeMockModel('ok')
      const compaction: CompactionConfig = {
        maxContextTokens: 100_000,
        maxOutputTokens: 10_000,
        autoCompactBuffer: 5_000,
        microcompactKeepRecent: 2,
      }
      const engine = makeEngine({ model, compaction })
      const session = makeSessionMock()

      await engine.askWithSession('test', session)

      expect(compactIfNeeded).toHaveBeenCalledWith(
        session,
        compaction,
        expect.any(Function),
      )
    })

    it('uses activeEntries from compaction result when available', async () => {
      const { compactIfNeeded } = await import('./compaction.js')
      const activeEntries: SessionEntry[] = [{
        type: 'user',
        message: { role: 'user', content: 'compacted entry' },
        uuid: 'c1',
        parentUuid: null,
        sessionId: 'test-session',
        timestamp: new Date().toISOString(),
      }]
      vi.mocked(compactIfNeeded).mockResolvedValueOnce({
        compacted: true,
        method: 'microcompact',
        activeEntries,
      })

      const model = makeMockModel('from compacted')
      const engine = makeEngine({ model })
      const session = makeSessionMock()

      const result = await engine.askWithSession('test', session)
      expect(result.text).toBe('from compacted')
      // readActive should NOT be called when activeEntries is provided
      expect(session.readActive).not.toHaveBeenCalled()
    })

    it('falls back to session.readActive when no activeEntries', async () => {
      const { compactIfNeeded } = await import('./compaction.js')
      vi.mocked(compactIfNeeded).mockResolvedValueOnce({
        compacted: false,
        method: 'none',
      })

      const model = makeMockModel('from readActive')
      const engine = makeEngine({ model })
      const session = makeSessionMock()

      await engine.askWithSession('test', session)
      expect(session.readActive).toHaveBeenCalled()
    })
  })

  // -------------------- session skill state --------------------

  describe('session skill markers', () => {
    it('uses the last skill marker when set/off happens multiple times', () => {
      const entries: SessionEntry[] = [
        {
          type: 'system',
          message: { role: 'system', content: 'skill:ta-brooks' },
          uuid: '1',
          parentUuid: null,
          sessionId: 'test-session',
          timestamp: new Date().toISOString(),
          metadata: { kind: 'skill', profileId: 'ta-brooks' },
        },
        {
          type: 'system',
          message: { role: 'system', content: 'skill:off' },
          uuid: '2',
          parentUuid: '1',
          sessionId: 'test-session',
          timestamp: new Date().toISOString(),
          metadata: { kind: 'skill', profileId: null },
        },
        {
          type: 'system',
          message: { role: 'system', content: 'skill:ta-ict-smc' },
          uuid: '3',
          parentUuid: '2',
          sessionId: 'test-session',
          timestamp: new Date().toISOString(),
          metadata: { kind: 'skill', profileId: 'ta-ict-smc' },
        },
      ]

      expect(getSessionSkillIdFromEntries(entries)).toBe('ta-ict-smc')
    })
  })

  // -------------------- local command visibility --------------------

  describe('local command filtering', () => {
    it('keeps local commands out of model/text history but visible in chat history', () => {
      const entries: SessionEntry[] = [
        {
          type: 'user',
          message: { role: 'user', content: '/skill ta-brooks' },
          uuid: 'u1',
          parentUuid: null,
          sessionId: 'test-session',
          timestamp: new Date().toISOString(),
          metadata: { kind: 'local_command' },
        },
        {
          type: 'assistant',
          message: { role: 'assistant', content: 'Active skill set to ta-brooks.' },
          uuid: 'a1',
          parentUuid: 'u1',
          sessionId: 'test-session',
          timestamp: new Date().toISOString(),
          metadata: { kind: 'local_command' },
        },
        {
          type: 'user',
          message: { role: 'user', content: 'Analyze BTCUSD' },
          uuid: 'u2',
          parentUuid: 'a1',
          sessionId: 'test-session',
          timestamp: new Date().toISOString(),
        },
      ]

      expect(toModelMessages(entries)).toEqual([
        { role: 'user', content: 'Analyze BTCUSD' },
      ])
      expect(toTextHistory(entries)).toEqual([
        { role: 'user', text: 'Analyze BTCUSD' },
      ])
      expect(toChatHistory(entries)).toEqual([
        expect.objectContaining({ kind: 'text', text: '/skill ta-brooks', metadata: { kind: 'local_command' } }),
        expect.objectContaining({ kind: 'text', text: 'Active skill set to ta-brooks.', metadata: { kind: 'local_command' } }),
        expect.objectContaining({ kind: 'text', text: 'Analyze BTCUSD' }),
      ])
    })
  })

  // -------------------- error handling --------------------

  describe('error handling', () => {
    it('propagates errors from ask()', async () => {
      const model = new MockLanguageModelV3({
        doGenerate: async () => { throw new Error('boom') },
      })
      const engine = makeEngine({ model })

      await expect(engine.ask('fail')).rejects.toThrow('boom')
    })
  })
})
