import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Tool } from 'ai'
import { VercelAIProvider } from './vercel-provider.js'
import { createModelFromConfig } from '../../core/model-factory.js'
import { createAgent } from './agent.js'

vi.mock('../../core/model-factory.js', () => ({
  createModelFromConfig: vi.fn(),
}))

vi.mock('./agent.js', () => ({
  createAgent: vi.fn(() => ({ generate: vi.fn(async () => ({ text: 'ok' })) })),
}))

vi.mock('../../core/skills/session-skill.js', () => ({
  getSessionSkillId: vi.fn(async (session: { __skillId?: string }) => session.__skillId ?? null),
}))

vi.mock('../../core/skills/registry.js', () => ({
  getSkillPack: vi.fn(async (id: string | null) => {
    if (id === 'ta-brooks') {
      return {
        id: 'ta-brooks',
        label: 'Brooks',
        description: 'Brooks mode',
        preferredTools: ['newsGetWorld'],
        toolAllow: undefined,
        toolDeny: ['trading*'],
        outputSchema: 'AnalysisReport',
        decisionWindowBars: 10,
        analysisMode: 'tool-first',
        whenToUse: 'Brooks mode',
        instructions: '# Brooks\n\n## Instructions\nUse Brooks terms',
        safetyNotes: 'No trading',
        examples: '- example',
        body: '# Brooks\n\n## Instructions\nUse Brooks terms',
        sourcePath: '/tmp/ta-brooks/SKILL.md',
      }
    }
    if (id === 'research-news-fundamental') {
      return {
        id: 'research-news-fundamental',
        label: 'Research',
        description: 'Research mode',
        preferredTools: ['newsGetWorld'],
        toolAllow: ['news*'],
        toolDeny: ['trading*'],
        outputSchema: 'AnalysisReport',
        decisionWindowBars: 10,
        analysisMode: 'tool-first',
        whenToUse: 'Research mode',
        instructions: '# Research\n\n## Instructions\nUse news and fundamentals',
        safetyNotes: 'No trading',
        examples: '- example',
        body: '# Research\n\n## Instructions\nUse news and fundamentals',
        sourcePath: '/tmp/research-news-fundamental/SKILL.md',
      }
    }
    return null
  }),
}))

describe('VercelAIProvider skill cache isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(createModelFromConfig).mockResolvedValue({ model: {} as never, key: 'anthropic:test' })
  })

  it('does not reuse the same agent when skill id changes', async () => {
    const tools: Record<string, Tool> = {
      newsGetWorld: {} as Tool,
      tradingCommit: {} as Tool,
    }
    const provider = new VercelAIProvider(async (policy) => {
      if (policy?.deny?.includes('trading*')) {
        return { newsGetWorld: tools.newsGetWorld }
      }
      return tools
    }, 'base instructions', 3, {
      maxContextTokens: 1000,
      maxOutputTokens: 100,
      autoCompactBuffer: 50,
      microcompactKeepRecent: 2,
    })

    await provider.askWithSession('hello', {
      __skillId: 'ta-brooks',
      appendUser: vi.fn(),
      appendAssistant: vi.fn(),
      readActive: vi.fn(async () => []),
      readAll: vi.fn(async () => []),
    } as never)

    await provider.askWithSession('hello', {
      __skillId: 'research-news-fundamental',
      appendUser: vi.fn(),
      appendAssistant: vi.fn(),
      readActive: vi.fn(async () => []),
      readAll: vi.fn(async () => []),
    } as never)

    expect(createAgent).toHaveBeenCalledTimes(2)
  })

  it('does not reuse the same agent when filtered tools change', async () => {
    const tools: Record<string, Tool> = {
      newsGetWorld: {} as Tool,
      tradingCommit: {} as Tool,
    }
    const provider = new VercelAIProvider(async (policy) => {
      if (policy?.allow?.includes('news*')) {
        return { newsGetWorld: tools.newsGetWorld }
      }
      return tools
    }, 'base instructions', 3, {
      maxContextTokens: 1000,
      maxOutputTokens: 100,
      autoCompactBuffer: 50,
      microcompactKeepRecent: 2,
    })

    await provider.askWithSession('hello', {
      __skillId: null,
      appendUser: vi.fn(),
      appendAssistant: vi.fn(),
      readActive: vi.fn(async () => []),
      readAll: vi.fn(async () => []),
    } as never)

    await provider.askWithSession('hello', {
      __skillId: 'research-news-fundamental',
      appendUser: vi.fn(),
      appendAssistant: vi.fn(),
      readActive: vi.fn(async () => []),
      readAll: vi.fn(async () => []),
    } as never)

    expect(createAgent).toHaveBeenCalledTimes(2)
  })
})
