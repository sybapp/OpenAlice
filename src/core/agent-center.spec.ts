import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LanguageModel, Tool } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { AgentCenter } from './agent-center.js'
import { GenerateRouter } from './ai-provider-manager.js'
import { DEFAULT_COMPACTION_CONFIG, type CompactionConfig } from './compaction.js'
import { VercelAIProvider } from '../ai-providers/vercel-ai-sdk/vercel-provider.js'
import { createModelFromProfile } from '../ai-providers/vercel-ai-sdk/model-factory.js'
import { MemorySessionStore, type SessionEntry } from './session.js'
import { ContextAssembler } from './context-assembler.js'
import { BrainMemoryStore } from './brain-memory-store.js'
import { Brain } from '../domain/brain/index.js'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MockAIProvider, doneEvent } from '../ai-providers/mock/index.js'
import { HookEngine } from './hook-engine.js'

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

interface MakeAgentCenterOpts {
  model?: LanguageModel
  tools?: Record<string, Tool>
  instructions?: string
  maxSteps?: number
  compaction?: CompactionConfig
}

function makeAgentCenter(overrides: MakeAgentCenterOpts = {}): AgentCenter {
  const model = overrides.model ?? makeMockModel()
  const tools = overrides.tools ?? {}
  const instructions = overrides.instructions ?? 'You are a test agent.'
  const maxSteps = overrides.maxSteps ?? 1
  const compaction = overrides.compaction ?? DEFAULT_COMPACTION_CONFIG

  vi.mocked(createModelFromProfile).mockResolvedValue({ model, key: 'test:mock-model' })
  const provider = new VercelAIProvider(async () => tools, async () => instructions, maxSteps)
  const router = new GenerateRouter(provider, null)

  return new AgentCenter({ router, compaction })
}

// ==================== Mock model-factory ====================

vi.mock('../ai-providers/vercel-ai-sdk/model-factory.js', () => ({
  createModelFromProfile: vi.fn(),
}))

vi.mock('./config.js', () => ({
  resolveProfile: vi.fn().mockResolvedValue({ backend: 'vercel-ai-sdk', label: 'Test', model: 'mock-model', provider: 'anthropic' }),
  readAgentConfig: vi.fn().mockResolvedValue({ maxSteps: 20, evolutionMode: false, claudeCode: { disallowedTools: [], maxTurns: 20 } }),
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

describe('AgentCenter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -------------------- Construction --------------------

  describe('constructor', () => {
    it('creates an AgentCenter with router and compaction', () => {
      const agentCenter = makeAgentCenter({ instructions: 'custom instructions' })
      expect(agentCenter).toBeInstanceOf(AgentCenter)
    })
  })

  // -------------------- ask() --------------------

  describe('ask()', () => {
    it('returns text from the model', async () => {
      const model = makeMockModel('hello world')
      const agentCenter = makeAgentCenter({ model })

      const result = await agentCenter.ask('say hello')
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
      const agentCenter = makeAgentCenter({ model })

      const result = await agentCenter.ask('empty response')
      expect(result.text).toBe('')
    })

    it('returns empty media when no tools produce media', async () => {
      const model = makeMockModel('no media')
      const agentCenter = makeAgentCenter({ model })

      const result = await agentCenter.ask('test')
      expect(result.media).toEqual([])
    })
  })

  // -------------------- askWithSession() --------------------

  describe('askWithSession()', () => {
    it('appends user message to session before generating', async () => {
      const model = makeMockModel('session response')
      const agentCenter = makeAgentCenter({ model })
      const session = new MemorySessionStore()
      const spy = vi.spyOn(session, 'appendUser')

      await agentCenter.askWithSession('user prompt', session)

      expect(spy).toHaveBeenCalledWith('user prompt', 'human')
    })

    it('appends assistant response to session after generating', async () => {
      const model = makeMockModel('assistant reply')
      const agentCenter = makeAgentCenter({ model })
      const session = new MemorySessionStore()
      const spy = vi.spyOn(session, 'appendAssistant')

      await agentCenter.askWithSession('hello', session)

      expect(spy).toHaveBeenCalledWith(
        [{ type: 'text', text: 'assistant reply' }],
        'vercel-ai',
      )
    })

    it('returns the generated text and empty media', async () => {
      const model = makeMockModel('generated text')
      const agentCenter = makeAgentCenter({ model })
      const session = new MemorySessionStore()

      const result = await agentCenter.askWithSession('prompt', session)
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
      const agentCenter = makeAgentCenter({ model, compaction })
      const session = new MemorySessionStore()

      await agentCenter.askWithSession('test', session)

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
      const agentCenter = makeAgentCenter({ model })
      const session = new MemorySessionStore()
      const spy = vi.spyOn(session, 'readActive')

      const result = await agentCenter.askWithSession('test', session)
      expect(result.text).toBe('from compacted')
      // readActive should NOT be called when activeEntries is provided
      expect(spy).not.toHaveBeenCalled()
    })

    it('falls back to session.readActive when no activeEntries', async () => {
      const { compactIfNeeded } = await import('./compaction.js')
      vi.mocked(compactIfNeeded).mockResolvedValueOnce({
        compacted: false,
        method: 'none',
      })

      const model = makeMockModel('from readActive')
      const agentCenter = makeAgentCenter({ model })
      const session = new MemorySessionStore()
      const spy = vi.spyOn(session, 'readActive')

      await agentCenter.askWithSession('test', session)
      expect(spy).toHaveBeenCalled()
    })

    it('does not surface the same memory twice for one live session', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'openalice-agent-memory-'))
      const memoryDir = join(dir, 'memory')
      const personaFile = join(dir, 'persona.md')
      await mkdir(memoryDir, { recursive: true })
      await writeFile(personaFile, 'You are a test agent.')
      await writeFile(join(memoryDir, 'project_context.md'), [
        '---',
        'title: Project Context',
        'keywords: repeat',
        '---',
        'Remember this only once.',
      ].join('\n'))

      const provider = new MockAIProvider([doneEvent('ok')])
      const router = new GenerateRouter(provider, null)
      const agentCenter = new AgentCenter({
        router,
        compaction: DEFAULT_COMPACTION_CONFIG,
        contextAssembler: new ContextAssembler({
          brain: new Brain({}),
          memoryStore: new BrainMemoryStore({ memoryDir }),
          personaFile,
        }),
      })
      const session = new MemorySessionStore('memory-session')

      await agentCenter.askWithSession('repeat', session)
      await agentCenter.askWithSession('repeat', session)

      const firstSystem = provider.generateCalls[0]?.opts?.systemPrompt
      const secondSystem = provider.generateCalls[1]?.opts?.systemPrompt
      expect(String(firstSystem)).toContain('Remember this only once.')
      expect(String(secondSystem)).not.toContain('Remember this only once.')
    })

    it('injects UserPromptSubmit hook context into assembled system prompt without mutating stored prompt', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'openalice-agent-hooks-'))
      const personaFile = join(dir, 'persona.md')
      await writeFile(personaFile, 'You are a test agent.')
      const hookEngine = new HookEngine({ config: { audit: false } })
      hookEngine.register({
        id: 'prompt-context',
        event: 'UserPromptSubmit',
        handler: () => ({ additionalContext: 'Injected hook context.' }),
      })
      const provider = new MockAIProvider([doneEvent('ok')])
      const router = new GenerateRouter(provider, null)
      const agentCenter = new AgentCenter({
        router,
        compaction: DEFAULT_COMPACTION_CONFIG,
        hookEngine,
        contextAssembler: new ContextAssembler({
          brain: new Brain({}),
          memoryStore: new BrainMemoryStore({ memoryDir: join(dir, 'memory') }),
          personaFile,
        }),
      })
      const session = new MemorySessionStore('hook-session')

      await agentCenter.askWithSession('original prompt', session)

      expect(provider.generateCalls[0]?.opts?.systemPrompt).toContain('Injected hook context.')
      const entries = await session.readAll()
      expect(entries[0]?.message.content).toBe('original prompt')
    })

    it('runs SessionStart once per live session and compaction hooks every turn', async () => {
      const hookEngine = new HookEngine({ config: { audit: false } })
      const events: string[] = []
      for (const event of ['SessionStart', 'PreCompact', 'PostCompact'] as const) {
        hookEngine.register({
          id: event,
          event,
          handler: () => { events.push(event) },
        })
      }
      const provider = new MockAIProvider([doneEvent('ok')])
      const router = new GenerateRouter(provider, null)
      const agentCenter = new AgentCenter({
        router,
        compaction: DEFAULT_COMPACTION_CONFIG,
        hookEngine,
      })
      const session = new MemorySessionStore('hook-lifecycle')

      await agentCenter.askWithSession('one', session)
      await agentCenter.askWithSession('two', session)

      expect(events.filter((event) => event === 'SessionStart')).toHaveLength(1)
      expect(events.filter((event) => event === 'PreCompact')).toHaveLength(2)
      expect(events.filter((event) => event === 'PostCompact')).toHaveLength(2)
    })

    it('blocks prompt persistence when UserPromptSubmit blocks', async () => {
      const hookEngine = new HookEngine({ config: { audit: false } })
      hookEngine.register({
        id: 'block',
        event: 'UserPromptSubmit',
        handler: () => ({ block: true, reason: 'no prompt' }),
      })
      const provider = new MockAIProvider([doneEvent('ok')])
      const router = new GenerateRouter(provider, null)
      const agentCenter = new AgentCenter({
        router,
        compaction: DEFAULT_COMPACTION_CONFIG,
        hookEngine,
      })
      const session = new MemorySessionStore('blocked-session')

      await expect(agentCenter.askWithSession('blocked', session)).rejects.toThrow('no prompt')
      expect(await session.readAll()).toEqual([])
      expect(provider.generateCalls).toHaveLength(0)
    })
  })

  // -------------------- error handling --------------------

  describe('error handling', () => {
    it('propagates errors from ask()', async () => {
      const model = new MockLanguageModelV3({
        doGenerate: async () => { throw new Error('boom') },
      })
      const agentCenter = makeAgentCenter({ model })

      await expect(agentCenter.ask('fail')).rejects.toThrow('boom')
    })
  })
})
