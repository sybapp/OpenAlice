import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ClaudeCodeProvider } from './claude-code-provider.js'
import { readAgentConfig } from '../../core/config.js'
import { streamFromResult } from '../../core/ai-provider.js'
import { askClaudeCodeWithSession } from './session.js'

vi.mock('../../core/config.js', () => ({
  readAgentConfig: vi.fn(),
}))

vi.mock('./session.js', () => ({
  askClaudeCodeWithSession: vi.fn(() => streamFromResult({ text: 'ok', media: [] })),
}))

vi.mock('../../core/skills/session-skill.js', () => ({
  getSessionSkillId: vi.fn(async () => 'ta-brooks'),
}))

vi.mock('../../core/skills/registry.js', () => ({
  getSkillPack: vi.fn(async () => ({
    id: 'ta-brooks',
    label: 'Brooks',
    description: 'Brooks mode',
    preferredTools: ['brooksPaAnalyze', 'calculateIndicator'],
    toolAllow: undefined,
    toolDeny: ['trading*', 'cronAdd'],
    outputSchema: 'AnalysisReport',
    decisionWindowBars: 10,
    analysisMode: 'tool-first',
    whenToUse: 'Use for Brooks analysis',
    instructions: '# Brooks\n\n## Instructions\nUse Brooks terminology',
    safetyNotes: 'No trades',
    examples: '- example',
    body: '# Brooks\n\n## Instructions\nUse Brooks terminology',
    sourcePath: '/tmp/ta-brooks/SKILL.md',
  })),
}))

describe('ClaudeCodeProvider skill integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(readAgentConfig).mockResolvedValue({
      evolutionMode: false,
      claudeCode: {
        disallowedTools: ['Task'],
        maxTurns: 20,
      },
    } as never)
  })

  it('merges skill deny patterns into disallowed MCP tools and appends skill prompt', async () => {
    const provider = new ClaudeCodeProvider({
      maxContextTokens: 1000,
      maxOutputTokens: 100,
      autoCompactBuffer: 50,
      microcompactKeepRecent: 2,
    }, 'base system prompt')

    await provider.askWithSession('analyze btc', { id: 's1' } as never, {
      appendSystemPrompt: 'caller prompt',
    })

    expect(askClaudeCodeWithSession).toHaveBeenCalledWith(
      'analyze btc',
      expect.anything(),
      expect.objectContaining({
        claudeCode: expect.objectContaining({
          disallowedTools: expect.arrayContaining([
            'Task',
            'mcp__open-alice__trading*',
            'mcp__open-alice__cronAdd',
          ]),
          appendSystemPrompt: expect.stringContaining('Active skill: ta-brooks (Brooks)'),
        }),
        systemPrompt: 'base system prompt',
      }),
    )

    const config = vi.mocked(askClaudeCodeWithSession).mock.calls[0][2]
    expect(config.claudeCode.appendSystemPrompt).toContain('caller prompt')
    expect(config.claudeCode.appendSystemPrompt).toContain('Use Brooks terminology')
    expect(config.claudeCode.appendSystemPrompt).toContain('most recent decision window of 10 bars')
  })
})
